// =====================================================================================================
// routes/orders.js - checkout, purchase history and order status changes
// -----------------------------------------------------------------------------------------------------
// Role in the architecture:
//  - This Express router is mounted in index.js under the prefix /api/orders (e.g. POST /api/orders is the
//    checkout, GET /api/orders the purchase history).
//  - All routes require a login (requireAuth). Customers see and cancel only their own orders; admins see
//    all orders and may change the status (requireAdmin).
//  - Integration with the Mini-ERP ("ERP first"): when an SAP connector is active, the checkout first
//    creates the order in the ERP (OData POST /odata/v4/simple-erp/Orders). The ERP is the source of truth
//    for stock: it checks and reduces its stock and may reject the order. Only if the ERP accepted the order
//    is it stored in the shop's SQLite database (with the ERP order key), so shop and ERP stay consistent.
//    Status changes of ERP orders are likewise sent to the ERP first (bound OData actions pickOrder,
//    shipOrder, completeOrder, cancelOrder); the shop only follows if the ERP accepted the change.
//  - Without a connector (standalone mode, Lab 1) the shop checks and reduces its own local stock.
//  - Order status codes are the same as in the ERP: NEW, PICKED, SHIPPED, COMPLETED, CANCELED.
//  - Errors are thrown as httpError(status, message) (or ErpError from the ERP services) and turned into
//    JSON responses by the central error handler in index.js (Express 5 also catches async errors).
// =====================================================================================================

// Router: Express factory function that creates a router (a group of related routes).
import { Router } from 'express';
// db: shared better-sqlite3 connection; ORDER_STATUSES: the allowed status codes (same as in the ERP).
import { db, ORDER_STATUSES } from '../db.js';
// requireAuth: only logged-in users may pass (401 otherwise); requireAdmin: only admins (401/403 otherwise).
import { requireAuth, requireAdmin } from '../auth.js';
// Inventory service: reserve() checks and reduces the local stock (standalone mode), release() puts stock
// back on cancellation, mirrorErpReservation() copies a stock reduction that the ERP already made.
import { reserve, release, mirrorErpReservation } from '../services/inventory.js';
// ERP order services: erpOrdersEnabled() = is an SAP connector active (and ERP_ORDERS not 'false')?,
// createErpOrder() = create the order in the ERP, setErpOrderStatus() = call the ERP status action.
import { erpOrdersEnabled, createErpOrder, setErpOrderStatus } from '../services/erpOrders.js';
// syncProductsFromErp: pulls all products (incl. current stock) from the ERP into the shop database.
import { syncProductsFromErp } from '../services/productSync.js';
// getActiveConnector: the currently active SAP connector (row of erp_connectors) or null.
import { getActiveConnector } from '../services/connectors.js';
// httpError: creates an Error object carrying an HTTP status code for the central error handler.
import { httpError } from '../util.js';

// Create the router object; all routes of this file are registered on it.
const router = Router();

// Converts an order row (result of ORDER_SELECT below, snake_case columns, money in cents) into the JSON
// object the frontend expects (camelCase, money in euros), including its order lines.
function orderToApi(o) {
  // Load the order lines of this order. SQL: all columns of order_items that belong to the order
  // (WHERE order_id = ?), in insertion order (ORDER BY id). One extra query per order is fine for the small
  // data volumes of this shop.
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  // Build and return the API object.
  return {
    // Shop order number (technical primary key in SQLite).
    id: o.id,
    // Order date and time (set by SQLite with datetime('now') on insert).
    orderDate: o.order_date,
    // Current status code: NEW, PICKED, SHIPPED, COMPLETED or CANCELED.
    status: o.status,
    // Order total: stored as integer cents (no floating point rounding), returned in euros.
    total: o.total_cents / 100,
    // Currency code, e.g. 'EUR'.
    currency: o.currency,
    // Technical key (UUID) of the corresponding order in the ERP, or null for shop-only orders.
    erpOrderId: o.erp_order_id,
    // Readable ERP order number (the ERP's orderID), shown to the user.
    erpOrderNumber: o.erp_order_number,
    // The SAP connector (ERP system) the order was created in, as { id, name }; null if the order has no
    // connector (the name comes from the LEFT JOIN in ORDER_SELECT).
    erpConnector: o.erp_connector_name ? { id: o.erp_connector, name: o.erp_connector_name } : null,
    // Customer data from the JOIN with the customers table (needed in the admin's order list).
    customer: { id: o.customer_id, name: o.customer_name, email: o.customer_email },
    // Shipping address: a snapshot copied into the order at checkout time, so later profile changes do not
    // change the address of orders that were already placed.
    shippingAddress: {
      // Recipient name, street and house number.
      name: o.ship_name, street: o.ship_street, houseNumber: o.ship_house_number,
      // Postal code, city and country code.
      postalCode: o.ship_postal_code, city: o.ship_city, countryCode: o.ship_country_code,
    },
    // Convert every order line into API format.
    items: items.map(i => ({
      // Shop database id of the product (order_items.product_id references products.id).
      productId: i.product_id,
      // Product name as it was at the time of purchase (snapshot).
      productName: i.product_name,
      // Unit price at the time of purchase (snapshot), converted from cents to euros.
      unitPrice: i.unit_price_cents / 100,
      // Ordered quantity.
      quantity: i.quantity,
      // Line total (unit price x quantity) in euros.
      itemTotal: i.item_total_cents / 100,
    })),
  };
}

// Base SQL query for orders, reused by the single-order and the list queries (they append WHERE / ORDER BY).
//  - SELECT o.* : all columns of the order, plus the customer's name and e-mail and the connector name
//    (AS gives the joined columns unique names).
//  - JOIN customers : inner join, every order belongs to exactly one existing customer.
//  - LEFT JOIN erp_connectors : a LEFT JOIN keeps orders that have no connector (erp_connector is NULL for
//    shop-only orders); erp_connector_name is NULL for them.
const ORDER_SELECT = `SELECT o.*, c.name AS customer_name, c.email AS customer_email, ec.name AS erp_connector_name
                      FROM orders o JOIN customers c ON c.id = o.customer_id
                      LEFT JOIN erp_connectors ec ON ec.id = o.erp_connector`;

// Loads one order and enforces access control: admins may load every order, customers only their own.
function loadOrder(id, user) {
  // Base query + WHERE o.id = ? (the order id is bound as a parameter); .get() returns one row or undefined.
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
  // Not found, or the order belongs to another customer and the caller is no admin -> 404 Not Found.
  // 404 instead of 403 Forbidden on purpose: it does not reveal that an order with this id exists.
  if (!o || (user.role !== 'admin' && o.customer_id !== user.id)) throw httpError(404, 'Order not found.');
  // Return the database row (converted to API format by the caller with orderToApi).
  return o;
}

// refresh local stock from the ERP (source of truth) without blocking the response
// "Fire and forget": the sync is started but not awaited, so the customer gets the answer immediately.
const refreshStockFromErp = () => {
  // Only possible when an SAP connector is active.
  const conn = getActiveConnector();
  // Start the product sync in the background. `.catch(() => {})` swallows a failure: without it a rejected
  // promise would be an "unhandled rejection", which crashes the Node.js process. The sync records its own
  // errors (shown in Admin > SAP connectors), and the background sync will try again later.
  if (conn) syncProductsFromErp(conn).catch(() => {});
};

// Checkout: create an order from cart lines [{ productId (db id), quantity }]
// HTTP POST /api/orders - only logged-in customers (requireAuth). Body: { items: [{ productId, quantity }] }.
// Returns 201 Created with the new order as JSON. Typical errors: 400 (empty cart, invalid quantity, product
// unavailable, missing address), 409 (not enough stock), 503 (ERP not reachable).
router.post('/', requireAuth, async (req, res) => {
  // Take the cart lines from the request body; anything that is not an array is treated as an empty cart.
  const lines = Array.isArray(req.body.items) ? req.body.items : [];
  // 400 Bad Request: an order needs at least one line.
  if (lines.length === 0) throw httpError(400, 'Your cart is empty.');

  // merge duplicate lines and load products
  // Map from product id -> total quantity, so the same product sent in two lines becomes one order line.
  const merged = new Map();
  // Go through all cart lines sent by the browser.
  for (const l of lines) {
    // Convert the quantity to a number (JSON may contain strings like "2").
    const qty = Number(l.quantity);
    // Only whole numbers >= 1 are allowed (no 0, negative or fractional quantities) -> otherwise 400.
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, 'Quantities must be whole numbers >= 1.');
    // Add the quantity to what is already stored for this product id (0 if the product is new in the map).
    merged.set(Number(l.productId), (merged.get(Number(l.productId)) || 0) + qty);
  }
  // Turn the map into an array of { product, quantity } with the full product row from the database.
  // `let` because the lines are replaced with the ERP's version further below. [...merged] gives [id, qty] pairs.
  // Important: the price comes from the database, never from the browser, so a client cannot fake prices.
  let resolved = [...merged].map(([id, quantity]) => {
    // Load the product; only active (listed) products can be ordered.
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
    // Unknown or removed product -> 400 Bad Request.
    if (!product) throw httpError(400, `Product ${id} is not available.`);
    // One resolved order line.
    return { product, quantity };
  });

  // Load the full customer row of the logged-in user (req.user only holds id, name, e-mail and role).
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.user.id);
  // A shipping address is required: street, city and postal code must be filled in the profile.
  if (!customer.street || !customer.city || !customer.postal_code)
    // 400 Bad Request with a message that tells the customer what to do.
    throw httpError(400, 'Please add your address in your profile before checking out.');

  // The order currency is taken from the first product (all products of the catalog use EUR).
  const currency = resolved[0].product.currency;
  // Order total in cents: sum of unit price x quantity over all lines (reduce starts with 0). `let` because
  // it is replaced with the ERP's total if the order goes to the ERP.
  let total = resolved.reduce((sum, l) => sum + l.product.price_cents * l.quantity, 0);

  // With an active SAP connector the order is created in that ERP first. The ERP checks and reduces its stock;
  // if it rejects the order (e.g. not enough stock) or is unreachable, no order is created in the shop.
  // createErpOrder() (services/erpOrders.js) does the following:
  //  1. syncs the products from the ERP, so the ERP product keys and prices are current,
  //  2. finds or creates the customer in the ERP (ensureErpCustomer),
  //  3. sends OData POST /Orders with the customer, the items and the amounts (this POST is never retried
  //     automatically, so a timeout cannot create the order twice).
  // If any step fails, the thrown error ends this request: Express 5 passes it to the error handler, which
  // answers with the error's status (e.g. 409 "exceeds stock" from the ERP, 503 ERP not reachable).
  // In standalone mode (no connector) erpOrder is null and the shop handles the stock itself below.
  const erpOrder = erpOrdersEnabled() ? await createErpOrder(customer, resolved, currency) : null;
  // Take over the lines and the total exactly as the ERP order contains them (with the current ERP prices).
  // Destructuring assignment into the existing variables `resolved` and `total`; the round brackets are
  // required, because a statement starting with `{` would otherwise be parsed as a code block.
  if (erpOrder) ({ lines: resolved, totalCents: total } = erpOrder); // with the current ERP prices

  // local part in one transaction: stock + order + items
  // db.transaction(fn) wraps fn in BEGIN ... COMMIT: either all statements succeed together, or - if one
  // throws - everything is rolled back (ROLLBACK), so there is never an order without items or a stock
  // reduction without an order. It returns a function that runs the transaction when called (see below).
  const create = db.transaction(() => {
    // ERP mode: the ERP has already checked and reduced its stock, so the shop only mirrors the reduction
    // locally (never below 0) to show the new stock immediately; the next ERP sync overwrites it anyway.
    if (erpOrder) mirrorErpReservation(resolved);
    // Standalone mode: check and reduce the local stock; throws 409 Conflict if a product does not have
    // enough stock, which rolls back the whole transaction (no order is stored).
    else reserve(resolved);
    // SQL INSERT of the order header. The status is always 'NEW' for a new order. The shipping address is
    // copied from the customer profile (snapshot). The erp_* columns link the shop order to the ERP order
    // (NULL in standalone mode).
    const info = db.prepare(`INSERT INTO orders (customer_id, status, total_cents, currency, ship_name, ship_street,
                             ship_house_number, ship_postal_code, ship_city, ship_country_code, erp_order_id, erp_order_number,
                             erp_connector) VALUES (?, 'NEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      // Values in placeholder order: customer id, total in cents, currency, recipient name, street, house no. ...
      .run(customer.id, total, currency, customer.name, customer.street, customer.house_number,
           // ... postal code, city, country code, ERP order key (UUID) and ERP order number. `erpOrder?.id ?? null`
           // means: the value from the ERP order, or null if there is no ERP order ...
           customer.postal_code, customer.city, customer.country_code, erpOrder?.id ?? null, erpOrder?.number ?? null,
           // ... and the ID of the SAP connector the order was created in.
           erpOrder?.connector ?? null);
    // Prepare the INSERT for the order lines once and run it for every line (faster than preparing it per line).
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, quantity, item_total_cents)
                                VALUES (?, ?, ?, ?, ?, ?)`);
    // One order_items row per resolved line.
    for (const { product, quantity } of resolved)
      // info.lastInsertRowid = id of the order just inserted (foreign key). Name and unit price are stored as
      // a snapshot, so later price or name changes do not alter past orders; the line total is calculated here.
      insItem.run(info.lastInsertRowid, product.id, product.name, product.price_cents, quantity, product.price_cents * quantity);
    // The new order id is the return value of the transaction function.
    return info.lastInsertRowid;
  });

  // Run the transaction now and get the id of the new order.
  // Note: if this local part failed after the ERP order was created, the ERP order would remain; this code
  // does not undo it (in ERP mode the local stock step cannot fail, because it never goes below 0).
  const orderId = create();
  // ERP mode: fetch the real stock values from the ERP in the background (the mirrored values are only an
  // estimate until then).
  if (erpOrder) refreshStockFromErp();
  // 201 Created with the complete new order (loaded again through loadOrder, incl. joins and items).
  res.status(201).json(orderToApi(loadOrder(orderId, req.user)));
});

// Purchase history (own orders) - admins get all orders with ?all=true
// HTTP GET /api/orders - logged-in users. Returns a JSON array of orders, newest first.
router.get('/', requireAuth, (req, res) => {
  // All orders only if ?all=true is requested AND the caller is an admin; customers always get their own.
  const all = req.query.all === 'true' && req.user.role === 'admin';
  // Choose the query with the conditional operator:
  const rows = all
    // admin: every order, ORDER BY o.id DESC = highest (newest) order id first;
    ? db.prepare(`${ORDER_SELECT} ORDER BY o.id DESC`).all()
    // customer: only orders of the logged-in customer (WHERE o.customer_id = ?), newest first.
    : db.prepare(`${ORDER_SELECT} WHERE o.customer_id = ? ORDER BY o.id DESC`).all(req.user.id);
  // Convert each row (incl. its items) to API format and send the array (200 OK).
  res.json(rows.map(orderToApi));
});

// HTTP GET /api/orders/:id - logged-in users. Returns one order as JSON; loadOrder answers 404 if the order
// does not exist or belongs to another customer (admins may open every order).
router.get('/:id', requireAuth, (req, res) => {
  res.json(orderToApi(loadOrder(req.params.id, req.user)));
});

// Changes the status of an order (used by the admin status change and the customer cancellation below).
// `async` because the ERP may have to be called first.
async function setStatus(order, status) {
  // Only the known status codes are accepted (400 Bad Request otherwise, the message lists them).
  if (!ORDER_STATUSES.includes(status)) throw httpError(400, `Status must be one of ${ORDER_STATUSES.join(', ')}.`);
  // CANCELED is a final state: a canceled order cannot be reopened -> 409 Conflict.
  if (order.status === 'CANCELED') throw httpError(409, 'Canceled orders cannot be changed.');
  // Nothing to do if the order already has this status (no ERP call, no database write).
  if (status === order.status) return;

  // ERP orders: the ERP decides first; the shop only follows if the ERP accepted the change
  // setErpOrderStatus() calls the bound OData action for the new status (PICKED -> pickOrder, SHIPPED ->
  // shipOrder, COMPLETED -> completeOrder, CANCELED -> cancelOrder) in the ERP the order was created in.
  // If the ERP rejects the change, the error is thrown and the local status below is NOT changed, so shop
  // and ERP never disagree. (The shop itself does not enforce the order of the steps; for ERP orders the
  // ERP action decides. There is no ERP action for NEW, so setting an ERP order back to NEW is rejected with
  // 422. Known ERP bug: cancelOrder always answers 422, so canceling an ERP order currently fails with this
  // error and the order stays unchanged.)
  if (order.erp_order_id) await setErpOrderStatus(order, status);

  // Local update in a transaction (stock and status change together or not at all). The trailing `()`
  // immediately runs the transaction function returned by db.transaction.
  db.transaction(() => {
    // Shop-only order canceled: put the reserved stock back locally. For ERP orders the ERP is the source of
    // truth for stock (returning it is the ERP's job), so nothing is released locally.
    if (status === 'CANCELED' && !order.erp_order_id) {
      // SQL: read the product ids and quantities of the order's lines and pass them to release().
      release(db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(order.id));
    }
    // SQL UPDATE: store the new status of this order.
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  })();
  // ERP order canceled in the ERP of the currently active connector: fetch the stock from the ERP in the
  // background, because the cancellation may have changed it there. (Orders of a connector that is no longer active
  // are skipped; the shop does not show that ERP's products at the moment.)
  if (order.erp_order_id && status === 'CANCELED' && order.erp_connector === getActiveConnector()?.id) refreshStockFromErp();
}

// Change order status (admin): NEW -> PICKED -> SHIPPED -> COMPLETED, or CANCELED
// HTTP PATCH /api/orders/:id/status - only admins. Body: { status }. PATCH = partial update of a resource
// (only the status changes). Returns the updated order as JSON.
router.patch('/:id/status', requireAdmin, async (req, res) => {
  // Load the order (admins may access every order; 404 if it does not exist).
  const order = loadOrder(req.params.id, req.user);
  // Validate and apply the new status (ERP first for ERP orders).
  await setStatus(order, req.body.status);
  // Load the order again and return its new state (200 OK).
  res.json(orderToApi(loadOrder(order.id, req.user)));
});

// Customers can cancel their own order while it is still NEW
// HTTP POST /api/orders/:id/cancel - logged-in users (customers for their own orders, admins for any order).
// A separate action endpoint so customers do not need the admin-only status route. Returns the updated order.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  // loadOrder enforces ownership: another customer's order gives 404.
  const order = loadOrder(req.params.id, req.user);
  // Business rule: once an order is being processed (picked, shipped, ...) it can no longer be canceled
  // by the customer -> 409 Conflict.
  if (order.status !== 'NEW') throw httpError(409, 'Only new orders can be canceled.');
  // Cancel through the same logic as the admin (ERP first, local stock release for shop-only orders).
  await setStatus(order, 'CANCELED');
  // Return the updated order (200 OK).
  res.json(orderToApi(loadOrder(order.id, req.user)));
});

// Export the router; index.js mounts it with app.use('/api/orders', orderRoutes).
export default router;
