// =====================================================================================================
// erpOrders.js - hands web shop orders (and the customers who place them) over to the Mini-ERP.
//
// Role in the architecture:
//  - Implements the "ERP first" checkout: the order is created in the ERP (OData POST /Orders) BEFORE it is
//    stored in the shop. The ERP checks and reduces its stock; if it rejects the order (e.g. 409 "exceeds
//    stock") or is unreachable, the checkout fails and no order is created in the shop (routes/orders.js).
//  - Maps shop customers to ERP customers (found by e-mail or created) and shop products to ERP product UUIDs.
//  - Forwards order status changes made by the shop admin to the ERP's bound OData actions
//    (pickOrder, shipOrder, completeOrder, cancelOrder).
//  - The communication style is synchronous RPC: the shop waits for the ERP's answer before it continues.
// =====================================================================================================

// Shared SQLite connection (to store the ERP customer id and to reload products / connectors).
import { db } from '../db.js';
// clientFor(conn): REST/OData client of one ERP; ErpError: error with the HTTP status for the shop API.
import { clientFor, ErpError } from './erpClient.js';
// The currently active SAP connector (null = standalone mode).
import { getActiveConnector } from './connectors.js';
// Pull of the ERP products into the shop - used right before each order to get current ERP keys and prices.
import { syncProductsFromErp } from './productSync.js';

/**
 * Hands web shop orders over to the Mini-ERP of the active SAP connector (synchronous RPC over its OData API).
 * The ERP is the source of truth for stock: creating the order in the ERP checks and reduces the stock there.
 * Enabled whenever a connector is active (set ERP_ORDERS=false to keep orders local only).
 */
// `!!` converts the connector object (or null) into a boolean. All conditions must hold: a connector is active,
// it uses the API integration (in file transfer mode - Lab 2 - only product files are exchanged, orders stay in the
// shop and the shop manages its local stock like in Lab 1) AND the feature switch ERP_ORDERS is not explicitly
// 'false' (environment variables are always strings).
export const erpOrdersEnabled = () => {
  // The active connector (null in standalone mode).
  const conn = getActiveConnector();
  return !!conn && conn.integration !== 'file' && process.env.ERP_ORDERS !== 'false';
};

// ERP actions for the web shop order status codes
// Status code (same codes in shop and ERP) -> name of the bound OData action of the ERP's Orders entity.
// The ERP executes the action and decides whether the change is accepted (the shop only follows if it is).
// There is no entry for 'NEW': an order cannot be set back to NEW in the ERP.
const ACTIONS = { PICKED: 'pickOrder', SHIPPED: 'shipOrder', COMPLETED: 'completeOrder', CANCELED: 'cancelOrder' };

/**
 * Returns the ERP customer ID of a shop customer in the connector's ERP;
 * finds the customer there by e-mail or creates it. Local and BTP ERP have different keys.
 */
// `customer` is a row of the shop's customers table. Called at checkout and (best effort) at registration.
export async function ensureErpCustomer(customer, conn = getActiveConnector()) {
  // Without an active connector there is no ERP to create the customer in -> 503 Service Unavailable.
  if (!conn) throw new ErpError('No SAP connector is active.', 503);
  // Fast path (cached key mapping): the customer was already mapped to a customer of THIS ERP. The stored id is
  // only valid for the connector it was created in, so erp_connector must match the given connector.
  if (customer.erp_customer_id && customer.erp_connector === conn.id) return customer.erp_customer_id;
  // HTTP client for this connector's ERP.
  const api = clientFor(conn);
  // OData GET /Customers?$filter=email eq '<email>'&$top=1 - the e-mail is used as the matching key between the
  // two systems. This also avoids duplicates in the ERP when the shop's link was lost (e.g. connector switched).
  let c = await api.findCustomerByEmail(customer.email);
  // Not found in the ERP: create the customer there.
  if (!c) {
    // OData POST /Customers (never retried automatically, so a timeout cannot create the customer twice).
    // The object maps the shop's snake_case columns to the ERP's camelCase entity fields.
    c = await api.createCustomer({
      // name and e-mail are taken over 1:1; house_number (shop column) -> houseNumber (ERP field).
      name: customer.name, email: customer.email, street: customer.street, houseNumber: customer.house_number,
      // postal_code -> postalCode; country_code is the foreign key of the ERP's Country association
      // (CAP naming <association>_code); 'DE' is the fallback if the shop customer has no country.
      city: customer.city, postalCode: customer.postal_code, country_code: customer.country_code || 'DE',
    });
  }
  // Store the mapping shop customer -> ERP customer UUID (+ which ERP it belongs to), so the next order uses the
  // fast path above and does not need another lookup in the ERP.
  db.prepare('UPDATE customers SET erp_customer_id = ?, erp_connector = ? WHERE id = ?').run(c.ID, conn.id, customer.id);
  // c.ID is the technical key (UUID) generated by the ERP, needed as customer_ID of the ERP order.
  return c.ID;
}

/**
 * Makes sure the ERP keys of the cart products are current. The products are synced right before
 * every order, so the order also works after the (in-memory) local ERP was restarted.
 */
// `lines` = [{ product: <shop products row>, quantity }]. Returns the same lines with freshly reloaded products.
async function ensureErpProductIds(lines, conn) {
  // Full product sync: updates erp_id (UUIDs change after a restart of the local ERP), prices and stock.
  await syncProductsFromErp(conn);
  // Prepared statement to re-read a product by its shop id (the in-memory `product` objects are now outdated).
  const reload = db.prepare('SELECT * FROM products WHERE id = ?');
  // Build new line objects with the current product data.
  return lines.map(l => {
    // Current row of the cart product (l.product.id = shop database id).
    const product = reload.get(l.product.id);
    // The product must be linked to THIS ERP; otherwise the ERP cannot accept it in an order item.
    if (!product.erp_id || product.erp_connector !== conn.id)
      // 409 Conflict: the cart refers to a product that the ERP does not know (any more).
      throw new ErpError(`${product.name} (${product.product_id}) does not exist in ${conn.name}.`, 409);
    // Copy the line (spread keeps quantity) and replace the product with the fresh row.
    return { ...l, product };
  });
}

/**
 * Creates the order in the ERP. Returns { id, number, connector } of the ERP order plus the lines and
 * the total with the current ERP prices (the shop stores exactly what the ERP order contains).
 */
// Step 1 of the ERP-first checkout (routes/orders.js). Only if this resolves does the shop store its own copy
// of the order in SQLite (inside a local transaction). If the ERP rejects the order, this throws and the shop
// writes nothing - so the two systems cannot end up with an order that exists only in the shop.
export async function createErpOrder(customer, lines, currency) {
  // The order is always created in the ERP of the currently active connector.
  const conn = getActiveConnector();
  // Safety check (the route only calls this when erpOrdersEnabled() is true): 503 if no connector is active.
  if (!conn) throw new ErpError('No SAP connector is active.', 503);
  // Sync products and get the cart lines with current ERP keys and prices (throws 409 if a product is missing).
  const resolved = await ensureErpProductIds(lines, conn);
  // Order total in integer cents, based on the CURRENT ERP prices (price_cents was just refreshed by the sync);
  // reduce() sums price * quantity over all lines, starting at 0.
  const totalCents = resolved.reduce((sum, l) => sum + l.product.price_cents * l.quantity, 0);
  // ERP customer UUID of the buyer (found by e-mail or created in the ERP).
  const customerId = await ensureErpCustomer(customer, conn);
  // OData POST /Orders with a "deep insert": the order header AND its items are sent in one request, so the ERP
  // creates them together and checks / reduces the stock of every item (or rejects the whole order). Not retried
  // automatically (retries: 0 in erpClient.js): POST is not idempotent, a retry after a timeout could
  // create the order twice.
  const order = await clientFor(conn).createOrder({
    // Foreign key to the ERP customer (CAP naming <association>_ID).
    customer_ID: customerId,
    // Today's date as YYYY-MM-DD (first 10 characters of the ISO timestamp, UTC) - a date without time.
    orderDate: new Date().toISOString().slice(0, 10),
    // The ERP works with decimal amounts, the shop with cents: convert back by dividing by 100.
    orderAmount: totalCents / 100,
    // Currency of the order (the route passes the currency of the cart's first product).
    currency_code: currency,
    // Order items: one per cart line, referencing the ERP product by its UUID (erp_id), not by productID.
    items: resolved.map(({ product, quantity }) => ({
      // Foreign key to the ERP product (the UUID that was refreshed by the sync above).
      product_ID: product.erp_id,
      // Ordered quantity (shorthand for quantity: quantity); the ERP checks it against its stock.
      quantity,
      // Line amount in decimal currency units (unit price in cents * quantity / 100).
      itemAmount: (product.price_cents * quantity) / 100,
      // Currency of the product as delivered by the ERP.
      currency_code: product.currency,
    })),
  });
  // Result for the route: ERP order UUID (stored as erp_order_id), readable ERP order number (erp_order_number),
  // the connector the order lives in, and lines + total with ERP prices, so the shop stores exactly the same
  // data as the ERP order.
  return { id: order.ID, number: order.orderID, connector: conn.id, lines: resolved, totalCents };
}

/** Forwards a status change to the ERP the order was created in (even if another connector is active now). */
// Called by the admin's status change BEFORE the shop updates its own status ("the ERP decides first"):
// if the ERP rejects the transition, this throws and the shop's status stays unchanged.
export async function setErpOrderStatus(order, status) {
  // Name of the bound ERP action for the requested status (undefined for 'NEW').
  const action = ACTIONS[status];
  // 422 Unprocessable Entity: this status cannot be set through an ERP action.
  if (!action) throw new ErpError(`Status ${status} cannot be set in the ERP.`, 422);
  // Load the connector stored on the ORDER (not the active one): the order's UUID is only valid in the ERP it was
  // created in. `&&` short-circuits: if the order has no connector, conn becomes that falsy value.
  const conn = order.erp_connector && db.prepare('SELECT * FROM erp_connectors WHERE id = ?').get(order.erp_connector);
  // 409 Conflict: the connector was removed, so the ERP of this order cannot be reached any more.
  if (!conn) throw new ErpError('The SAP connector of this order no longer exists.', 409);
  // OData POST /Orders(<uuid>)/SimpleERPService.<action> - executes the bound action in the ERP (not retried
  // automatically, because an action changes state).
  await clientFor(conn).orderAction(order.erp_order_id, action);
}
