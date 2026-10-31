// =====================================================================================================
// routes/products.js - REST API for the product catalog of the VeloCity Bike Shop
// -----------------------------------------------------------------------------------------------------
// Role in the architecture:
//  - This Express router is mounted in index.js under the path prefix /api/products, so a route written
//    here as '/:id' is reachable as GET /api/products/42 from the React frontend.
//  - Reading products (list, details, categories) is public: every visitor of the shop may browse.
//    Creating, changing and removing products is reserved for admins (middleware requireAdmin).
//  - Integration with the Mini-ERP (SAP CAP application from Lab 0): when an SAP connector is active, the
//    ERP is the master (source of truth) for products, prices and stock. The shop only shows the products
//    of that ERP and writes admin changes to the ERP FIRST (via services/erpMasterData.js); the local
//    SQLite table `products` is a synchronized copy that is then refreshed from the ERP.
//  - Without an active connector (standalone mode) the shop is its own master and edits SQLite directly.
//  - Errors are thrown as httpError(status, message); Express 5 forwards errors thrown in (async) route
//    handlers to the central error handler in index.js, which turns them into JSON { error: message }.
// =====================================================================================================

// Router: Express factory function that creates a "mini application" holding a group of related routes.
import { Router } from 'express';
// db: the shared better-sqlite3 database connection (SQLite file of the shop, created in db.js).
import { db } from '../db.js';
// requireAdmin: middleware that rejects the request with 401 (not logged in) or 403 (not an admin).
import { requireAdmin } from '../auth.js';
// getStock: inventory service - the single place that knows where the stock number of a product lives.
import { getStock } from '../services/inventory.js';
// getActiveConnector: returns the currently active SAP connector (row of erp_connectors) or null.
import { getActiveConnector } from '../services/connectors.js';
// createProductInErp / updateProductInErp: write product master data to the ERP (OData POST / PATCH on
// /odata/v4/simple-erp/Products) and then sync the result back into the shop database.
import { createProductInErp, updateProductInErp } from '../services/erpMasterData.js';
// syncIfShopEmpty: pulls the products from the ERP when the shop has none of the active connector yet.
import { syncIfShopEmpty } from '../services/erpSync.js';
// CATEGORIES: the allowed product categories (shop-only merchandising data that the ERP does not know).
import { CATEGORIES } from '../catalog.js';
// toCents: converts a euro amount (e.g. 89.9) to integer cents (8990); httpError: error with HTTP status.
import { toCents, httpError } from '../util.js';

// Create the router object; the route definitions below are registered on it and it is exported at the end.
const router = Router();

// Values of the ERP's managed field `createdBy` that mean "initial data of the ERP" (loaded from the Lab 0
// CSV files) instead of "created by a technical user via the API". Used by productToApi below.
const INITIAL_DATA_USERS = ['', 'system', 'anonymous'];

// Converts a database row of the `products` table (snake_case column names, price in cents) into the JSON
// object the frontend expects (camelCase names, price in euros). Exported because other modules may reuse it.
// Keeping this mapping in one function means the database schema can change without breaking the API.
export function productToApi(p) {
  // Build and return a new plain object; only the fields listed here are sent to the browser.
  return {
    // Technical primary key of the shop database (INTEGER AUTOINCREMENT); used in URLs and in the cart.
    id: p.id,
    // Business key, identical to the ERP's productID (e.g. DXTR1000); this links shop and ERP products.
    productId: p.product_id,
    // Product name (master data from the ERP when the product is ERP-managed).
    name: p.name,
    // Description; an empty string instead of null so the frontend can render it without null checks.
    description: p.description || '',
    // Money is stored as integer cents to avoid floating point rounding errors; the API returns euros.
    price: p.price_cents / 100,
    // Currency code, e.g. 'EUR'.
    currency: p.currency,
    // Current stock, read through the inventory service (the one place that knows where stock lives).
    stock: getStock(p.id),
    // Shop-only category; products without one are shown under 'Other'.
    category: p.category || 'Other',
    // SQLite has no boolean type (active is stored as 0/1); `!!` converts it to a real true/false.
    active: !!p.active,
    // true when the product comes from an ERP: linked by its UUID key in the ERP (erp_id, API integration) or -
    // in file transfer mode (Lab 2) - taken over from an ERP export file (connector set, but no UUID in the file).
    // The frontend shows a "SAP ERP" tag and where price and stock come from for such products.
    erpManaged: !!p.erp_id || !!p.erp_connector,
    // How the product data arrived: 'api' (REST/OData sync), 'file' (file transfer) or null (shop-only product).
    erpSource: p.erp_id ? 'api' : p.erp_connector ? 'file' : null,
    // ID of the SAP connector (ERP system) the erp_id belongs to, or null for shop-only products.
    erpConnector: p.erp_connector || null,
    // '' = initial data of the ERP (Lab 0 CSV files: createdBy is empty locally, 'system' after the HANA deployment),
    // otherwise the user that created it via the API (e.g. service-user or the XSUAA client of the shop)
    // Nested conditional (ternary) expression, evaluated from left to right:
    //  1. not an ERP product, or the creator is unknown (null) -> null (the admin UI shows no origin note)
    //  2. creator is one of INITIAL_DATA_USERS -> '' (admin UI: "ERP initial data")
    //  3. otherwise -> the technical user name itself (admin UI: "added via API")
    erpCreatedBy: !p.erp_id || p.erp_created_by === null ? null
      : INITIAL_DATA_USERS.includes(p.erp_created_by) ? '' : p.erp_created_by,
  };
}

/**
 * Which products the shop shows: with an active SAP connector only the products of that ERP,
 * without a connector (standalone mode) all products with their local stock.
 *
 * Returns a small SQL fragment plus its parameters so that callers (this file and routes/admin.js)
 * can add the same visibility rule to their own WHERE clauses.
 */
export function visibleProductsFilter() {
  // Look up the active SAP connector (null in standalone mode).
  const conn = getActiveConnector();
  // With a connector: only rows whose erp_connector column equals the connector ID. The ID is passed as a
  // `?` parameter (prepared statement), never concatenated into the SQL, which prevents SQL injection.
  // Without a connector: '1 = 1' is a condition that is always true, i.e. no filtering at all.
  return conn ? { sql: 'erp_connector = ?', params: [conn.id] } : { sql: '1 = 1', params: [] };
}

// Small helper: loads one product row by its technical id (or undefined if there is no such row).
// SQL: SELECT * = all columns, WHERE id = ? = the placeholder is filled safely with the given value.
// .get() returns the first matching row as a JavaScript object.
const load = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

// List products (public). Admins can include removed products with ?all=true
// HTTP GET /api/products - anyone may call it (no login required). Returns a JSON array of products.
// The handler is `async` because it may first wait for a product sync with the ERP.
router.get('/', async (req, res) => {
  // If the shop has no products of the active connector yet, try to load them from the ERP now
  // (waits at most about 3 seconds, so a slow ERP does not block the customer for long).
  await syncIfShopEmpty(); // e.g. the local ERP was started after the shop
  // Removed (soft-deleted) products are only included when ?all=true is sent AND the caller is an admin.
  // req.user is set by the optionalAuth middleware in index.js if a valid login token was sent; the
  // optional chaining `?.` avoids a crash when nobody is logged in (req.user is undefined then).
  const includeInactive = req.query.all === 'true' && req.user?.role === 'admin';
  // Get the visibility rule (only products of the active ERP, or all products in standalone mode).
  const f = visibleProductsFilter();
  // SQL: select all product columns, filtered by the visibility rule and - unless removed products are
  // requested - only active products (active = 1). ORDER BY category, name sorts the list for the catalog.
  // The template literal only inserts fixed SQL text written in this code (f.sql and the AND clause), never
  // user input; the connector ID is bound as a parameter via .all(...f.params) (spread into the `?`s).
  // .all() returns every matching row as an array of objects.
  const rows = db.prepare(`SELECT * FROM products WHERE ${f.sql} ${includeInactive ? '' : 'AND active = 1'}
                           ORDER BY category, name`).all(...f.params);
  // Convert each database row into the API format and send the array as JSON (HTTP 200 OK by default).
  res.json(rows.map(productToApi));
});

// HTTP GET /api/products/categories - public. Returns the list of allowed categories as a JSON array
// (used e.g. for the category filter and the admin product form). It is registered BEFORE '/:id' because
// Express checks routes in registration order; otherwise 'categories' would be treated as a product id.
router.get('/categories', (_req, res) => res.json(CATEGORIES));

// HTTP GET /api/products/:id - public. Returns one product as JSON, or 404 if it is not visible.
// :id is a route parameter; Express puts the value from the URL into req.params.id.
router.get('/:id', (req, res) => {
  // Load the product row by its technical id (undefined if it does not exist).
  const p = load(req.params.id);
  // The active SAP connector decides which products belong to the shop at the moment.
  const conn = getActiveConnector();
  // A product is visible only if all three conditions hold:
  //  1. it exists (p is truthy),
  //  2. it is active, or the caller is an admin (admins may also open removed products),
  //  3. no connector is active (standalone mode), or the product belongs to the ERP of the active connector.
  const visible = p && (p.active || req.user?.role === 'admin') && (!conn || p.erp_connector === conn.id);
  // 404 Not Found for invisible products - the same answer as for non-existing ones, so hidden products
  // are not revealed. The thrown error is turned into a JSON error response by the error handler in index.js.
  if (!visible) throw httpError(404, 'Product not found.');
  // Send the product in API format (200 OK).
  res.json(productToApi(p));
});

// Validates the product data sent by the admin form (request body) and returns a cleaned-up object.
// Server-side validation is required even if the frontend validates too, because any client can send
// arbitrary requests to the API. Invalid input is rejected with 400 Bad Request.
// partial = false (create, POST): the required fields must be present.
// partial = true (update, PUT): only the fields that were sent are checked; missing fields stay unchanged.
function validateProduct(body, partial = false) {
  // Destructuring: take the expected fields out of the request body (each is undefined if not sent).
  const { productId, name, description, price, stock, category } = body;
  // Check the product ID when creating, or when an update explicitly sends one.
  if (!partial || productId !== undefined) {
    // Regular expression: 2 to 40 characters, only letters, digits, '-' or '_' (a safe business key, the
    // same kind of ID the ERP uses as productID, e.g. DXTR1000).
    if (!productId || !/^[A-Za-z0-9_-]{2,40}$/.test(productId))
      // 400 Bad Request: the client sent invalid data.
      throw httpError(400, 'Product ID is required (letters, digits, - or _).');
  }
  // Check the name when creating, or when an update sends one.
  if (!partial || name !== undefined) {
    // String(name).trim() removes spaces at both ends, so a name consisting only of spaces is rejected too.
    if (!name || !String(name).trim()) throw httpError(400, 'Name is required.');
  }
  // Check the price when creating, or when an update sends one.
  if (!partial || price !== undefined) {
    // The price must be present, not an empty form field, numeric (isNaN = "is not a number") and not negative.
    if (price === undefined || price === '' || isNaN(price) || Number(price) < 0)
      throw httpError(400, 'Price must be a number >= 0.');
  }
  // Stock is optional (undefined or '' = not given). If given, it must be a whole number from 0 to 1000.
  if (stock !== undefined && stock !== '' && (!Number.isInteger(Number(stock)) || Number(stock) < 0 || Number(stock) > 1000))
    throw httpError(400, 'Stock must be a whole number between 0 and 1000.');
  // Category is optional; if given it must be one of the known categories or 'Other'.
  // [...CATEGORIES, 'Other'] creates a new array with all categories plus 'Other' (spread syntax).
  if (category !== undefined && category !== '' && ![...CATEGORIES, 'Other'].includes(category))
    // Template literal: the error message lists the allowed categories, e.g. "Bikes, E-Bikes, ...".
    throw httpError(400, `Category must be one of ${CATEGORIES.join(', ')}.`);
  // Return the cleaned-up values: name and description without surrounding spaces (`?.` keeps undefined
  // when the field was not sent), and an empty category turned into undefined ("not given").
  return { productId, name: name?.trim(), description: description?.trim(), price, stock, category: category || undefined };
}

// Add a product (admin). With an active SAP connector the product is created in that ERP (master) first.
// HTTP POST /api/products - only admins (requireAdmin runs before the handler and stops other callers with
// 401/403). Request body: { productId, name, description, price, stock, category }.
// Returns 201 Created with the new product as JSON.
router.post('/', requireAdmin, async (req, res) => {
  // Validate the full product data (partial = false: product ID, name and price are required).
  const p = validateProduct(req.body);
  // Business keys are stored in upper case (like the ERP's productID), so 'dxtr1000' and 'DXTR1000' are the same.
  const key = p.productId.toUpperCase();
  // The active SAP connector decides where the product is created (ERP or local database).
  const conn = getActiveConnector();
  // File transfer mode (Lab 2): the shop does not write to the ERP; new products are created in the ERP (e.g. in
  // its Fiori app) and arrive with the next export file. 409 Conflict: not possible in the current mode.
  if (conn?.integration === 'file')
    throw httpError(409, `${conn.name} sends its products as files. Create the product in the ERP - it arrives with the next export file.`);
  // Is there already a product with this business key in the shop database? (product_id is UNIQUE)
  const existing = db.prepare('SELECT * FROM products WHERE product_id = ?').get(key);
  // a product known from another ERP (or shop-only) can be added to the active ERP; the sync links it
  // So the ID is only a conflict when the existing product belongs to the current "world": standalone mode
  // (no connector), or the product is already linked to the active connector's ERP.
  if (existing && (!conn || existing.erp_connector === conn.id)) {
    // 409 Conflict: the request clashes with the current state of the resource (duplicate business key).
    // The message differs depending on whether the product is listed (active) or was soft-deleted.
    throw httpError(409, existing.active
      ? `Product ID ${key} already exists.`
      : `Product ${key} exists but was removed from the shop. Restore it in the product list.`);
  }

  // Will hold the database row of the newly created (or newly linked) product.
  let created;
  // Integration case: an SAP connector is active, so the ERP is the master for product data.
  if (conn) {
    // Create the product in the ERP first (OData POST /Products), then sync the ERP products into the shop
    // database; the function returns the local row linked to the new ERP product. If the ERP rejects the
    // request or is unreachable, the error is thrown and nothing is created in the shop.
    created = await createProductInErp(p, conn);
  // Standalone case: no ERP, the shop itself is the master and stores the product directly in SQLite.
  } else {
    // SQL INSERT: adds a new row to `products`. The ? placeholders are filled in order by .run(...) below.
    // The currency is fixed to 'EUR' in the SQL text.
    const info = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, category)
                             VALUES (?, ?, ?, ?, 'EUR', ?, ?)`)
      // Values in column order: business key, name, description (null if not given), price converted to
      // integer cents, stock as a number (0 if not given) and category ('Other' if not given).
      .run(key, p.name, p.description ?? null, toCents(p.price), Number(p.stock || 0), p.category || 'Other');
    // info.lastInsertRowid is the id SQLite generated for the new row; load the complete row.
    created = load(info.lastInsertRowid);
  }
  // The category is shop-only data that the ERP does not store, so it is written locally in both cases
  // (the ERP sync never overwrites the category; it only sets a default from the demo catalog when it inserts
  // a new row, so the admin's choice is applied here).
  if (p.category) db.prepare('UPDATE products SET category = ? WHERE id = ?').run(p.category, created.id);
  // 201 Created: a new resource was created. The product is re-loaded so the response contains the final state.
  res.status(201).json(productToApi(load(created.id)));
});

// Update a product (admin). ERP products are changed in the ERP first; the shop follows.
// HTTP PUT /api/products/:id - only admins. The body may contain any subset of the product fields (partial
// update) plus `active` to remove/restore the product in the shop. Returns the updated product as JSON.
router.put('/:id', requireAdmin, async (req, res) => {
  // Load the current state of the product from the shop database.
  const current = load(req.params.id);
  // 404 Not Found if there is no product with this id.
  if (!current) throw httpError(404, 'Product not found.');
  // Validate only the fields that were sent (partial = true).
  const p = validateProduct(req.body, true);

  // The active SAP connector decides who owns the product data.
  const conn = getActiveConnector();
  // With an active connector, only products of that ERP may be edited. A product of another ERP (or a
  // shop-only product) is not in the master system, so changing it locally would create inconsistent data.
  if (conn && current.erp_connector !== conn.id)
    // 409 Conflict: the request is not possible in the current state.
    throw httpError(409, `${current.name} is not in the ERP of the active connector (${conn.name}).`);
  // File transfer mode (Lab 2): name, description, price and stock are master data of the ERP and arrive by file;
  // they cannot be changed in the shop. The admin form always sends all fields, so only real changes are refused;
  // category and active (shop-only fields) are handled further below.
  if (conn?.integration === 'file') {
    // The master data fields whose sent value differs from the stored one.
    const changed = [
      p.name !== undefined && p.name !== current.name && 'name',
      p.description !== undefined && (p.description || null) !== (current.description || null) && 'description',
      p.price !== undefined && toCents(p.price) !== current.price_cents && 'price',
      p.stock !== undefined && p.stock !== '' && Number(p.stock) !== current.stock && 'stock',
    ].filter(Boolean);
    if (changed.length)
      throw httpError(409, `${changed.join(', ')} come${changed.length === 1 ? 's' : ''} from the ERP export file and cannot be changed in the shop. Change ${changed.length === 1 ? 'it' : 'them'} in the ERP; the next file brings the new values.`);
  // ERP-managed product: change it in the ERP (master) first (OData PATCH /Products(<erp_id>)), then the
  // shop syncs the new values from the ERP. If the ERP call fails, the error stops the request here.
  } else if (conn && current.erp_id) {
    await updateProductInErp(current.erp_id, p, conn);
  // Otherwise (standalone mode) the shop is the master: update the row in SQLite directly.
  } else {
    // SQL UPDATE: overwrite name, description, price, stock and the change timestamp of this one row
    // (WHERE id = ?). datetime('now') is an SQLite function that returns the current UTC date and time.
    db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, stock = ?, updated_at = datetime('now')
                WHERE id = ?`)
      // For every field that was not sent, the current value is kept: `a ?? b` means "a, unless a is
      // null/undefined, then b".
      .run(p.name ?? current.name, p.description ?? current.description,
           // The price is converted from euros to cents only if a new price was sent.
           p.price !== undefined ? toCents(p.price) : current.price_cents,
           // A new stock value is used only if it was sent and is not an empty form field; the last value is
           // the id for the WHERE clause.
           p.stock !== undefined && p.stock !== '' ? Number(p.stock) : current.stock, current.id);
  }
  // shop-only fields
  // These fields do not exist in the ERP, so they are always stored locally - also for ERP products.
  // Category: only changed if a (non-empty) category was sent.
  if (p.category) db.prepare('UPDATE products SET category = ? WHERE id = ?').run(p.category, current.id);
  // active: lists (1) or hides (0) the product in the shop; used by the admin to restore a removed product.
  // The truthy/falsy value from the request is converted to 1/0 because SQLite stores booleans as integers.
  if (req.body.active !== undefined) db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, current.id);
  // Re-load the row so the response shows the final state (including the values synced from the ERP); 200 OK.
  res.json(productToApi(load(current.id)));
});

// Remove a product from the shop (admin). Soft delete: past orders keep their reference,
// and the product stays in the ERP (the ERP is not only used by the shop).
// HTTP DELETE /api/products/:id - only admins. Returns 204 No Content on success.
router.delete('/:id', requireAdmin, (req, res) => {
  // SQL UPDATE instead of DELETE: the row is only marked inactive (active = 0). A real DELETE would break
  // the foreign key order_items.product_id -> products.id of past orders.
  const info = db.prepare(`UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  // info.changes = number of rows the UPDATE changed; 0 means no product with this id exists -> 404.
  if (info.changes === 0) throw httpError(404, 'Product not found.');
  // 204 No Content: success, but there is no response body; .end() finishes the response.
  res.status(204).end();
});

// Export the router as the default export; index.js mounts it with app.use('/api/products', productRoutes).
export default router;
