// =====================================================================================================
// erpMasterData.js - the "push" direction of the master data integration (shop -> Mini-ERP).
//
// Role in the architecture:
//  - When the shop admin creates or edits a product, or a customer edits the profile, the change is written
//    to the ERP FIRST (OData POST/PATCH). The shop's SQLite copy is then refreshed from the ERP by a product
//    sync, so the shop never has data that the ERP (the master) does not have.
//  - It also loads the demo catalog (catalog.js) into the ERP, e.g. into the local in-memory ERP after a
//    restart ("Load demo catalog" button or connectors with "auto catalog").
// =====================================================================================================

// Shared SQLite connection (used to read back the product created in the ERP after the sync).
import { db } from '../db.js';
// clientFor(conn): REST/OData client of one ERP; requireActiveConnector(): active connector or 503 error.
import { clientFor, requireActiveConnector } from './erpClient.js';
// The currently active SAP connector (null = standalone mode).
import { getActiveConnector } from './connectors.js';
// The demo product list of the VeloCity bike shop (productID, name, description, price, stock, category).
import { CATALOG } from '../catalog.js';
// Pull of the ERP products into the shop; called after every write to the ERP so the shop follows the ERP.
import { syncProductsFromErp } from './productSync.js';

/**
 * Writes master data changes made in the web shop back to the Mini-ERP of the active connector,
 * so the ERP stays the single source of truth for products and customers.
 */

// Mapping function shop input -> body of an ERP Products entity (field names of the ERP's OData service).
// `p` is the validated admin form input (camelCase, price in currency units, not cents).
const toErpProduct = p => ({
  // Business key, normalized to upper case (the product sync matches products by the upper-case productID).
  productID: p.productId.toUpperCase(),
  // Display name, taken over unchanged.
  name: p.name,
  // Empty description -> null, so the ERP stores "no description" instead of an empty string.
  description: p.description || null,
  // The ERP expects a number (decimal price), the form may deliver a string.
  price: Number(p.price),
  // Foreign key of the ERP's Currency association (CAP naming <association>_code); default EUR.
  currency_code: p.currency || 'EUR',
  // Initial stock as a number; missing or empty -> 0.
  stock: Number(p.stock || 0),
});

/** Admin adds a product: create it in the ERP, then pull it into the shop. */
// Returns the shop's products row of the new product (with the shop id that the UI needs).
export async function createProductInErp(input, conn = requireActiveConnector()) {
  // OData POST /Products (not retried automatically: POST is not idempotent). The ERP generates the product's
  // technical key (UUID) and returns the created entity; if the ERP rejects the product, this throws and the
  // shop does not create anything.
  const created = await clientFor(conn).createProduct(toErpProduct(input));
  // Pull the ERP products into the shop: the sync INSERTs the new product into SQLite (with erp_id = its UUID).
  await syncProductsFromErp(conn);
  // Read the new shop row by the ERP key + connector (the shop id is assigned by SQLite during the sync).
  return db.prepare('SELECT * FROM products WHERE erp_id = ? AND erp_connector = ?').get(created.ID, conn.id);
}

/** Admin edits a product: patch the ERP first, the shop follows. */
// `erpId` = UUID of the product in the ERP; `changes` = validated form input (only the fields that were sent).
export async function updateProductInErp(erpId, changes, conn = requireActiveConnector()) {
  // PATCH body: contains only the fields that should change (partial update), so the ERP keeps all other values.
  const body = {};
  // `!== undefined`: the field was sent by the form (even if it is empty) -> take it over.
  if (changes.name !== undefined) body.name = changes.name;
  // An empty description is stored as null in the ERP.
  if (changes.description !== undefined) body.description = changes.description || null;
  // Price as a number (decimal currency units, as the ERP expects).
  if (changes.price !== undefined) body.price = Number(changes.price);
  // Stock only if a value was entered: an empty input field ('') means "do not change the stock".
  if (changes.stock !== undefined && changes.stock !== '') body.stock = Number(changes.stock);
  // OData PATCH /Products(<uuid>) - only if there is something to change in the ERP (e.g. if only the shop-only
  // category was edited, no ERP call is needed). If the ERP rejects the change, this throws and the shop keeps
  // its old values.
  if (Object.keys(body).length) await clientFor(conn).updateProduct(erpId, body);
  // The shop follows the ERP: pull the products so the SQLite copy contains the values the ERP now has.
  await syncProductsFromErp(conn);
}

/** Customer changes profile data: keep the ERP customer up to date (only in the ERP it is linked to). */
// `customer` = the updated row of the shop's customers table.
export async function updateCustomerInErp(customer) {
  // The connector the shop currently works with.
  const conn = getActiveConnector();
  // Nothing to do if no connector is active, the customer has no ERP customer yet, or the stored ERP customer id
  // belongs to another ERP (its UUID would not exist in the active ERP).
  if (!conn || !customer.erp_customer_id || customer.erp_connector !== conn.id) return;
  // File transfer mode (Lab 2): the shop only receives product files and does not call the ERP's API.
  if (conn.integration === 'file') return;
  // OData PATCH /Customers(<uuid>) with the current profile data (shop snake_case columns -> ERP camelCase fields).
  await clientFor(conn).updateCustomer(customer.erp_customer_id, {
    // name, e-mail and address; house_number -> houseNumber.
    name: customer.name, email: customer.email, street: customer.street, houseNumber: customer.house_number,
    // postal_code -> postalCode; country_code is the ERP's Country association key; fallback 'DE'.
    city: customer.city, postalCode: customer.postal_code, country_code: customer.country_code || 'DE',
  });
}

/**
 * Loads the demo catalog into the ERP: creates missing products and fills in empty descriptions.
 * Existing ERP data (prices, stock) is not overwritten. Then syncs the products into the shop.
 */
// Idempotent: running it twice does not create duplicates, because it first checks which products already exist
// in the ERP. Returns { created, completed, existing, products } (products = counters of the final sync).
// syncShop = false (file transfer mode, Lab 2): only the ERP is changed; the shop gets the products later through the
// next export file instead of the API sync. `products` is then missing in the result.
export async function loadCatalogIntoErp(conn = requireActiveConnector(), { syncShop = true } = {}) {
  // HTTP client for this connector's ERP (reused for all calls below).
  const api = clientFor(conn);
  // Current ERP product list (REST GET /rest/api/products()).
  const items = await api.products();
  // Lookup table business key (upper case) -> ERP product, to check quickly whether a catalog product exists.
  const existing = new Map(items.map(p => [String(p.productID).toUpperCase(), p]));
  // Counters: created in the ERP / description completed / already complete.
  const result = { created: 0, completed: 0, existing: 0 };
  // Go through the demo catalog one product at a time (sequential awaits: one ERP request after the other).
  for (const item of CATALOG) {
    // The ERP product with the same business key, or undefined if the ERP does not have it.
    const current = existing.get(item.productID);
    // Case 1: missing in the ERP -> create it there.
    if (!current) {
      // OData POST /Products. toErpProduct expects `productId` (camelCase, like the admin form), so the catalog's
      // `productID` is copied into that property; price, stock and description come from the catalog.
      await api.createProduct(toErpProduct({ ...item, productId: item.productID }));
      // Count the new product.
      result.created++;
    // Case 2: exists in the ERP but without description (e.g. the ERP's own sample data) -> only fill that in.
    } else if (!current.description) {
      // OData PATCH /Products(<uuid>) with just the description; price and stock of the ERP stay untouched.
      await api.updateProduct(current.ID, { description: item.description });
      // Count the completed product.
      result.completed++;
    // Case 3: exists and is complete -> nothing is written to the ERP.
    } else {
      // Count the product that was already complete.
      result.existing++;
    }
  }
  // File transfer mode: stop here, the shop is not synced through the API.
  if (!syncShop) return result;
  // nothing changed in the ERP: the list we already have is up to date
  // Operator precedence: (created || completed) ? null : items. If something was created or completed, pass null
  // so the sync reads the ERP list again (new UUIDs / descriptions); otherwise reuse `items` and save one request.
  result.products = await syncProductsFromErp(conn, result.created || result.completed ? null : items);
  // Counters for the admin UI / background sync log.
  return result;
}
