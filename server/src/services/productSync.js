// =====================================================================================================
// productSync.js - pulls master data FROM the Mini-ERP INTO the web shop's SQLite database.
//
// Role in the architecture:
//  - The Mini-ERP (SAP CAP app, local `cds watch` or SAP BTP) is the master ("source of truth") for
//    products, prices and stock. The shop only keeps a synchronized COPY in its `products` table so that
//    it can show the catalog quickly and keep working read-only when the ERP is slow.
//  - This module implements the "pull" direction of the integration: it reads the ERP product list
//    (REST: /rest/api/products()) and upserts it into SQLite, matched by the business key `productID`.
//  - It also takes over order status changes that were made directly in the ERP (OData /Orders),
//    e.g. when a clerk ships an order in the ERP's Fiori app.
//  - It is called by erpSync.js (start-up, interval, "Sync now"), by erpOrders.js (right before each
//    checkout), by erpMasterData.js (after writing to the ERP) and by the orders route (stock refresh).
// =====================================================================================================

// Shared better-sqlite3 database connection (synchronous API, one file: data/webshop.db).
import { db } from '../db.js';
// clientFor(conn): builds the HTTP client (REST + OData) for one SAP connector, incl. auth (basic/OAuth).
// requireActiveConnector(): returns the active connector or throws a 503 ErpError if none is active.
// ErpError: Error subclass carrying the HTTP status the shop API should answer with.
import { clientFor, requireActiveConnector, ErpError } from './erpClient.js';
// Reads the currently active SAP connector from the settings table (or null in standalone mode).
import { getActiveConnector } from './connectors.js';
// Converts a decimal price (e.g. 89.9) into integer cents (8990) - money is stored as integers to avoid
// floating point rounding errors.
import { toCents } from '../util.js';
// Maps a productID to a shop category (Bikes, E-Bikes, ...). The category is shop-only merchandising data
// that the ERP does not know, so it is derived locally when a product is created in the shop.
import { categoryFor } from '../catalog.js';

// In-memory status of the last sync per connector. It is only needed for display (Admin > SAP connectors,
// shop empty state) and for throttling in erpSync.js, so it does not need to survive a server restart and is
// therefore not stored in SQLite. Key: connector id, value: { at: ISO timestamp, ok, result | error }.
const lastSyncs = new Map(); // connector id -> { at, ok, result | error }

// Returns the last sync status of a connector, or null if it has never been synced since the server started.
// Used by the /api/erp/status route and by syncIfShopEmpty() in erpSync.js (5 second throttle).
export const getLastSync = connectorId => lastSyncs.get(connectorId) || null;
// Stores a failed sync (timestamp + error message) for a connector. Exported because erpSync.js also records
// errors of the other sync steps (demo catalog, order statuses) in the same place.
export const recordSyncError = (connectorId, error) =>
  // Only the message is kept (not the Error object), so the status can be sent to the browser as JSON.
  lastSyncs.set(connectorId, { at: new Date().toISOString(), ok: false, error: error.message });
// Stores a successful sync that did not go through syncProductsFromErp: the file transfer (Lab 2) records the
// counters of its last imported file here, so Admin > SAP connectors shows "last sync" for both integration styles.
export const recordSyncResult = (connectorId, result) =>
  lastSyncs.set(connectorId, { at: new Date().toISOString(), ok: true, result });

/**
 * Pulls all products from the ERP of a connector and upserts them by business key (productID).
 * The ERP is master for name, description, price, currency and stock; the product is linked to
 * this connector (erp_id = the product's key in that ERP). Shop-only data is kept: the category
 * and whether the product is listed in the shop (active).
 * Products of this connector that no longer exist in the ERP are unlinked (e.g. after the local
 * ERP was restarted - its data lives in memory).
 * `items` can be passed in when the caller has just read the ERP products.
 */
// Default parameter: if no connector is passed, the active one is used (throws 503 if there is none).
// Returns counters { received, created, updated, unchanged, skipped, unlinked } for the admin UI and logs.
export async function syncProductsFromErp(conn = requireActiveConnector(), items = null) {
  // Everything is wrapped in try/catch so that ANY failure (network, ERP error, DB error) is recorded in
  // lastSyncs before it is re-thrown to the caller.
  try {
    // Nullish assignment (??=): only call the ERP if the caller did not already pass the product list.
    // clientFor(conn).products() = GET <erp-url>/rest/api/products() (REST API of the Mini-ERP).
    // erpMasterData.loadCatalogIntoErp() passes its list in to save one HTTP round trip.
    items ??= await clientFor(conn).products();
    // Defensive check of the external system's answer: a wrong URL could return e.g. an HTML page.
    // Failing here prevents the "unlink" step below from unlinking every product because of a bad response.
    if (!Array.isArray(items)) throw new Error('Unexpected ERP response (expected a product list).');
    // optional extra: who created the products in the ERP (shown in Admin > Products)
    // Map of ERP product UUID -> createdBy (CAP "managed" field). Empty means the ERP's initial data.
    const createdBy = new Map();
    // Separate try block: this information is only "nice to have", so its failure must not stop the sync.
    try {
      // OData GET /Products?$select=ID,createdBy - one request for all products; fill the map.
      // `|| ''` turns null/undefined into an empty string (= initial data of the ERP).
      for (const o of await clientFor(conn).productOrigins()) createdBy.set(o.ID, o.createdBy || '');
    } catch { /* not important enough to fail the sync */ }

    // Prepared statements: SQL is compiled once and then executed many times inside the loop (fast, and the
    // `?` placeholders protect against SQL injection because values are bound, not concatenated).
    // `find` looks up the shop product by its business key product_id (UNIQUE column in SQLite).
    const find = db.prepare('SELECT * FROM products WHERE product_id = ?');
    // `insert` creates a new shop product from ERP data. The 10 placeholders are: business key, name,
    // description, price in cents, currency, stock, ERP UUID (erp_id), connector id, ERP creator and the
    // shop-only category. `active` is fixed to 1, so a new ERP product is listed in the shop immediately.
    const insert = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, erp_id,
                               erp_connector, erp_created_by, category, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    // `update` overwrites only the ERP-mastered columns (+ the link to the ERP and updated_at).
    // It deliberately does NOT touch `category` and `active`: these are shop-only decisions of the admin.
    // datetime('now') is SQLite's current UTC timestamp, recording when the row was last changed.
    const update = db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, currency = ?, stock = ?,
                               erp_id = ?, erp_connector = ?, erp_created_by = ?, updated_at = datetime('now') WHERE id = ?`);
    // `unlink` removes the link to the ERP but keeps the row: order_items reference products(id), so the product
    // must stay for the order history (no hard delete). Unlinked products are no longer shown while this
    // connector is active, because the shop only lists products whose erp_connector is the active connector.
    const unlink = db.prepare('UPDATE products SET erp_id = NULL, erp_connector = NULL WHERE id = ?');

    // Counters that are returned to the caller (shown in the admin UI and in the background sync log).
    const result = { received: items.length, created: 0, updated: 0, unchanged: 0, skipped: 0, unlinked: 0 };
    // db.transaction(fn) returns a wrapped function; the trailing () calls it immediately. All writes run
    // inside ONE SQLite transaction (BEGIN ... COMMIT): either the whole sync is applied or - if anything
    // throws - everything is rolled back. Readers never see a half-synced catalog, and many writes in one
    // transaction are also much faster than one implicit transaction per statement.
    db.transaction(() => {
      // a slow sync must not link products to a connector the admin has switched away from in the meantime
      // The ERP call above was async (await), so the admin may have activated another connector meanwhile.
      // This check runs inside the transaction (synchronous, nothing can interleave) and aborts with 409
      // Conflict; the throw also rolls the transaction back, so nothing is written.
      if (getActiveConnector()?.id !== conn.id) throw new ErpError(`${conn.name} is no longer the active connector.`, 409);
      // In file transfer mode (Lab 2) the products come only from files (fileTransfer.js); an API sync started
      // before the admin switched the mode must not write either.
      if (getActiveConnector().integration === 'file') throw new ErpError(`${conn.name} uses file transfer - products come from files.`, 409);
      // Business keys contained in the ERP response; used afterwards to find products that disappeared.
      const seen = new Set();
      // Upsert loop: one iteration per ERP product.
      for (const p of items) {
        // Normalize the business key: string, no surrounding spaces, upper case (e.g. " dxtr1000" -> "DXTR1000"),
        // so the same product always maps to the same shop row, no matter how it was typed in the ERP.
        const key = String(p.productID || '').trim().toUpperCase();
        // Data quality check: skip incomplete ERP records (no key, no name, or a price that is not a number)
        // instead of failing the whole sync. `continue` jumps to the next ERP product.
        if (!key || !p.name || isNaN(Number(p.price))) { result.skipped++; continue; }
        // Remember the key as "still exists in the ERP" (important for the unlink step below).
        seen.add(key);
        // Values for the ERP-mastered columns, in the order of the placeholders of `update` (and of `insert`
        // after the key). The array is reused for insert, update and the "unchanged?" comparison.
        const row = [p.name, p.description ?? null, toCents(p.price), p.currency || p.currency_code || 'EUR',
                     // stock: number, never negative (the SQLite column has CHECK (stock >= 0)); missing -> 0.
                     // p.ID is the product's UUID in the ERP (technical key), stored as erp_id; conn.id links
                     // the product to the ERP this UUID belongs to (local and BTP ERP have different UUIDs).
                     Math.max(0, Number(p.stock) || 0), p.ID ?? null, conn.id,
                     // creator in the ERP, or null if the optional createdBy request above failed.
                     createdBy.has(p.ID) ? createdBy.get(p.ID) : null];
        // Look up the shop product with the same business key (across all connectors and also shop-only ones).
        const existing = find.get(key);
        // Not in the shop yet: INSERT it (key + ERP values + category derived from the demo catalog),
        // count it and continue with the next ERP product.
        if (!existing) { insert.run(key, ...row, categoryFor(key)); result.created++; continue; }
        // Change detection: compare every ERP-mastered column with the stored value. `?? null` makes
        // undefined and null compare equal. Only real changes cause a write, so updated_at stays meaningful
        // and the periodic sync (every 60 s) does not rewrite the whole table each time.
        const same = existing.name === row[0] && (existing.description ?? null) === row[1] && existing.price_cents === row[2]
          && existing.currency === row[3] && existing.stock === row[4] && (existing.erp_id ?? null) === row[5]
          && existing.erp_connector === conn.id && (existing.erp_created_by ?? null) === row[7];
        // Nothing changed in the ERP: just count it.
        if (same) result.unchanged++;
        // Something changed (or the product was linked to another/no connector before): overwrite the
        // ERP-mastered columns and (re)link the product to this connector. existing.id is the WHERE id = ?.
        else { update.run(...row, existing.id); result.updated++; }
      }
      // Second pass: all shop products currently linked to THIS connector. If the ERP no longer returned their
      // business key (e.g. the local in-memory ERP was restarted, or a product was deleted in the ERP),
      // the stale link is removed so the shop does not sell a product the ERP does not know.
      for (const p of db.prepare('SELECT id, product_id FROM products WHERE erp_connector = ?').all(conn.id)) {
        // Not in the ERP response -> unlink (the row itself stays for the order history).
        if (!seen.has(p.product_id)) { unlink.run(p.id); result.unlinked++; }
      }
    })();

    // Success: remember time and counters for the admin UI (Admin > SAP connectors) and the throttle logic.
    lastSyncs.set(conn.id, { at: new Date().toISOString(), ok: true, result });
    // Give the counters back to the caller (route, background sync, checkout).
    return result;
  } catch (e) {
    // Remember the failure (e.g. "ERP not reachable") so the admin and the shop's empty state can show it ...
    recordSyncError(conn.id, e);
    // ... and still re-throw it: the caller decides what to do (e.g. the checkout must fail, the API route
    // answers with the ErpError's HTTP status via the central error handler).
    throw e;
  }
}

/** Takes over status changes made in the ERP (e.g. an order shipped in the ERP's Fiori app). */
// The ERP is master for orders too: the shop's `orders.status` is only a copy that is refreshed here.
// Returns { checked, updated } for the admin UI and the background sync log.
export async function syncOrderStatusesFromErp(conn = requireActiveConnector()) {
  // OData GET /Orders?$select=ID,orderID,orderStatus_code - only the columns needed (smaller response).
  const erpOrders = await clientFor(conn).orderStatuses();
  // Lookup table ERP order UUID -> status code. The shop uses the same status codes as the ERP
  // (NEW, PICKED, SHIPPED, COMPLETED, CANCELED), so no mapping between the two systems is needed.
  const byId = new Map(erpOrders.map(o => [o.ID, o.orderStatus_code]));
  // All shop orders that were created in THIS ERP (orders of other connectors are not touched, because their
  // erp_order_id is a key of a different ERP). Orders without an ERP id are local-only and are skipped.
  const local = db.prepare('SELECT id, status, erp_order_id FROM orders WHERE erp_order_id IS NOT NULL AND erp_connector = ?')
    .all(conn.id);
  // Prepared statement to overwrite the local status with the ERP status.
  const upd = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
  // Number of orders whose status actually changed.
  let updated = 0;
  // All updates in one transaction (atomic and fast). The ERP call is already finished at this point;
  // a better-sqlite3 transaction must be synchronous, so no `await` may happen inside it.
  db.transaction(() => {
    // Compare every local ERP order with the ERP's current status.
    for (const o of local) {
      // Status of this order in the ERP (undefined if the ERP does not know the order, e.g. after a restart
      // of the in-memory local ERP).
      const s = byId.get(o.erp_order_id);
      // Only write when the ERP knows the order AND its status differs from the shop's copy.
      if (s && s !== o.status) { upd.run(s, o.id); updated++; }
    }
  })();
  // checked = number of shop orders compared, updated = number of status changes taken over from the ERP.
  return { checked: local.length, updated };
}
