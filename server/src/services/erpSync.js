// =====================================================================================================
// erpSync.js - orchestrates WHEN the web shop synchronizes with the active SAP connector (Mini-ERP).
//
// Role in the architecture:
//  - productSync.js knows HOW to copy products / order statuses from the ERP into SQLite;
//    erpMasterData.js knows how to load the demo catalog into the ERP. This module decides WHEN that
//    happens (server start, background interval, "Sync now" button, connector activation, empty shop)
//    and makes sure that only one sync per connector runs at a time.
//  - It is the "scheduler" of the pull-based integration: the ERP does not push changes to the shop,
//    so the shop polls the ERP regularly (every ERP_SYNC_INTERVAL_S seconds, default 60).
// =====================================================================================================

// Shared SQLite connection (used here only to count the products linked to a connector).
import { db } from '../db.js';
// Connector management: read the active connector, load a connector by id (404 if unknown), and store which
// connector is active (settings table, key 'active_connector').
import { getActiveConnector, getConnector, setActiveConnector } from './connectors.js';
// Removes the cached OAuth token of a connector, so the next ERP call requests a fresh token from XSUAA.
import { clearToken } from './erpClient.js';
// The actual pull logic (ERP -> shop) and the in-memory "last sync" status used for display and throttling.
import { syncProductsFromErp, syncOrderStatusesFromErp, getLastSync, recordSyncError } from './productSync.js';
// Creates missing demo products in the ERP (for connectors with "auto catalog") and then syncs the products.
import { loadCatalogIntoErp } from './erpMasterData.js';
// true when orders are handed over to the ERP (active connector and ERP_ORDERS is not 'false').
import { erpOrdersEnabled } from './erpOrders.js';
// Lab 2: the file based integration (export job -> transfer folder -> import) used instead of the API sync when
// the connector's integration is 'file'.
import { runFileCycle, importInbox, isFileMode } from './fileTransfer.js';

/**
 * Synchronisation with the active SAP connector:
 *  - on server start, when a connector is activated, on "Sync now" and every ERP_SYNC_INTERVAL_S seconds
 *  - products (+ demo catalog if the connector has "auto catalog") and order status changes made in the ERP
 */

// Registry of syncs that are currently running. Value = the Promise of the running sync.
// Purpose ("single flight"): if a second sync for the same connector is requested while one is still running
// (e.g. the interval fires while the admin clicks "Sync now"), the caller joins the running sync instead of
// starting a parallel one. Two parallel syncs would do double work and could race against each other.
const running = new Map(); // connector id -> promise (one sync per connector at a time)

// One complete sync run for a connector: products first, then order statuses. Returns
// { products, catalog?, orders } with the counters of each step.
// File transfer mode (Lab 2): export job + import of the transfer inbox instead (fileTransfer.js). forceExport =
// false for the scheduled run (a file is only written if the ERP data changed), true for admin actions.
async function runSync(conn, { forceExport = true } = {}) {
  // Lab 2: the connector exchanges product data by files. The result has the same `products` / `orders` shape.
  if (isFileMode(conn)) return runFileCycle(conn, { forceExport });
  // Collects the results of the individual steps.
  const result = {};
  // try/catch so that an error of ANY step is recorded for the admin UI before it is passed on.
  try {
    // auto_catalog (column of erp_connectors, 0/1): the local ERP keeps its data in memory and loses it on every
    // restart, so for such connectors the demo catalog is (re)created in the ERP automatically.
    if (conn.auto_catalog) {
      // Creates missing demo products in the ERP and fills empty descriptions; then syncs the products into
      // the shop (loadCatalogIntoErp calls syncProductsFromErp itself).
      const catalog = await loadCatalogIntoErp(conn);
      // Product sync counters (received, created, updated, ...) of that inner sync.
      result.products = catalog.products;
      // How many demo products were created in the ERP / had their description completed.
      result.catalog = { created: catalog.created, completed: catalog.completed };
    } else {
      // Normal case: just pull the ERP products into the shop, nothing is written to the ERP.
      result.products = await syncProductsFromErp(conn);
    }
    // Order statuses are only relevant when shop orders are created in the ERP; otherwise return empty counters
    // with the same shape, so callers can read result.orders.updated without extra checks.
    result.orders = erpOrdersEnabled() ? await syncOrderStatusesFromErp(conn) : { checked: 0, updated: 0 };
  } catch (e) {
    // syncProductsFromErp records its own errors, but the catalog and order status steps do not - recording here
    // covers every step of the run.
    recordSyncError(conn.id, e); // shown in Admin > SAP connectors and in the shop's empty state
    // Pass the error on to the caller (route -> HTTP error response, background tick -> log message).
    throw e;
  }
  // All steps succeeded.
  return result;
}

/** Syncs the active connector now (joins a sync that is already running). */
// Returns a Promise of the runSync() result (or of null when no connector is active).
// `options` are passed to runSync() (forceExport for the file transfer mode).
export function syncNow(conn = getActiveConnector(), options = {}) {
  // Standalone mode (no SAP connector active): nothing to sync. Promise.resolve keeps the return type a Promise,
  // so callers can always use `await` / `.catch()`.
  if (!conn) return Promise.resolve(null);
  // No sync of this connector is running yet: start one and register its Promise.
  if (!running.has(conn.id)) {
    // .finally() removes the entry when the sync is done - on success AND on failure - so the next request
    // starts a fresh sync. Note: the Promise stored in the map is the one returned by .finally(), it still
    // resolves/rejects with the result/error of runSync().
    running.set(conn.id, runSync(conn, options).finally(() => running.delete(conn.id)));
  }
  // Return the running sync's Promise (either the one just started or the one another caller started).
  return running.get(conn.id);
}

/**
 * Runs a NEW sync after data was changed in the ERP (e.g. a supplier file was applied): a sync that is already
 * running may have read the ERP before the change, so it is awaited first and then a fresh one is started.
 * File transfer mode: the change travels as an ERP export file (export + import), API mode: API pull.
 */
export async function syncAfterErpChange(conn = getActiveConnector()) {
  // No connector: nothing to sync.
  if (!conn) return null;
  // Wait for a running sync of this connector (its errors do not matter here).
  if (running.has(conn.id)) await running.get(conn.id).catch(() => {});
  // Start (or join a sync that was started after the change) - forceExport: the ERP data has changed.
  return syncNow(conn, { forceExport: true });
}

/** Number of shop products linked to a connector (what the shop shows while it is active). */
// SQL: COUNT(*) of products that belong to this ERP (erp_connector) and are listed in the shop (active = 1,
// i.e. not soft-deleted). `.get()` returns one row { n: <count> }, `.n` extracts the number.
export const linkedProducts = connectorId =>
  db.prepare('SELECT COUNT(*) AS n FROM products WHERE erp_connector = ? AND active = 1').get(connectorId).n;

/**
 * The shop has no products of the active connector yet (e.g. it was just started, or the ERP was down):
 * try again when a customer opens the shop, at most every 5 seconds.
 */
// Called by GET /api/products before the product list is read (e.g. the local ERP was started after the shop),
// so the customer does not have to wait for the next background interval to see products.
export async function syncIfShopEmpty() {
  // The currently active SAP connector (null in standalone mode).
  const conn = getActiveConnector();
  // Nothing to do in standalone mode, or when the shop already shows products of this connector.
  if (!conn || linkedProducts(conn.id) > 0) return;
  // Status of the last sync attempt (success or failure) of this connector.
  const last = getLastSync(conn.id);
  // Throttle: if the last attempt was less than 5000 ms ago, do not try again. This protects the ERP (and the
  // shop's response time) when many customers open the shop while the ERP is down.
  if (last && Date.now() - Date.parse(last.at) < 5000) return;
  // File transfer mode (Lab 2): the shop does not call the ERP; it can only import files that are already waiting in
  // the inbox (errors are shown in Admin > File transfer, the product list is still answered).
  if (isFileMode(conn)) { await importInbox(conn).catch(() => {}); return; }
  // don't keep the customer waiting for a slow ERP: answer after 3 s at the latest, the sync goes on
  // Promise.race settles with whichever finishes first: the sync or a 3000 ms timer. If the timer wins, the
  // product request is answered (possibly still empty) while the sync continues in the background.
  // .catch(() => {}) swallows sync errors here: they are already recorded in lastSyncs, and the product list
  // must still be answered instead of failing with an ERP error.
  await Promise.race([syncNow(conn).catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
}

/** Switches the shop to another SAP connector (or none) and syncs it right away. */
// Called by the admin routes (activate a connector / deactivate = id null). Returns { active, sync } for the UI.
export async function activateConnector(id) {
  // Load the connector (getConnector throws 404 if the id is unknown); a falsy id means "no connector".
  const conn = id ? getConnector(id) : null;
  // Persist the choice in the settings table ('' = none active -> the shop runs standalone with local products).
  setActiveConnector(conn?.id || null);
  // Deactivated: nothing to sync.
  if (!conn) return { active: null, sync: null };
  // Drop a cached OAuth token so the (possibly changed) credentials of the connector are used for a new token.
  clearToken(conn.id);
  // Server log entry so the switch is visible in the console.
  console.log(`[erp] active SAP connector: ${conn.name} (${conn.url})`);
  // Sync immediately, so the shop shows the products of the newly activated ERP right away.
  try {
    // Success: spread the sync result (products, orders, ...) into the response next to ok: true.
    return { active: conn.id, sync: { ok: true, ...(await syncNow(conn)) } };
  } catch (e) {
    // The connector stays active even if the ERP is unreachable now (the background sync retries later);
    // the admin UI gets the error message instead of a failed request.
    return { active: conn.id, sync: { ok: false, error: e.message } };
  }
}

// Last export error per connector, so the background log does not repeat the same message every minute.
const lastExportError = new Map();

// Console output of a scheduled file transfer run: one line per written / imported file, export errors once.
function logFileCycle(conn, r) {
  // A new export file was written by the (simulated) ERP export job.
  if (r.export?.written) console.log(`[file] ${conn.name}: export ${r.export.file} (${r.export.rows} products)`);
  // The ERP could not be read: warn once per distinct message (the shop keeps the data of the last file).
  if (r.export && !r.export.ok && lastExportError.get(conn.id) !== r.export.error)
    // Warn with the message of the export error.
    console.warn(`[file] ${conn.name}: export failed - ${r.export.error} (the shop keeps the last imported data)`);
  // Remember the current export error (or clear it after a successful export).
  lastExportError.set(conn.id, r.export?.ok ? null : r.export?.error);
  // Every imported or rejected file.
  for (const i of r.imports) {
    // e.g. [file] products_local_...csv: imported (14 products: 0 new, 1 updated, 0 removed)
    console.log(`[file] ${i.file}: ${i.status}` + (i.status === 'rejected' ? ` - ${i.errors[0]}`
      : ` (${i.rows} products: ${i.created} new, ${i.updated} updated, ${i.unlinked} removed)`));
  }
}

/** Background sync; logs only when the connection state changes, not every interval. */
// Called once from index.js after the HTTP server has started listening.
export function startBackgroundSync() {
  // Interval in seconds from the environment (server/.env or the Cloud Foundry manifest); default 60.
  // ?? keeps an explicit 0 (which disables the interval, see below).
  const seconds = Number(process.env.ERP_SYNC_INTERVAL_S ?? 60);
  // Last logged connection state, e.g. 'ok:local' or 'fail:btp:<message>'. Used to avoid printing the same
  // message every minute (the log would otherwise be flooded while the ERP is down).
  let lastState = null;
  // One background sync step; async, and it never throws (errors are caught and logged below).
  const tick = async () => {
    // Read the active connector on every tick, because the admin can switch connectors at runtime.
    const conn = getActiveConnector();
    // No connector active: reset the state so the next activation is logged again, and skip this tick.
    if (!conn) { lastState = null; return; }
    try {
      // Run (or join) a sync of the active connector. forceExport: false - in file transfer mode the scheduled
      // export job only writes a file when the ERP data has changed.
      const r = await syncNow(conn, { forceExport: false });
      // File transfer mode (Lab 2): log the files that were written / imported and export failures.
      if (r.mode === 'file') { logFileCycle(conn, r); lastState = `ok:${conn.id}`; return; }
      // Total number of changes in this run (new / updated / unlinked products + order status changes).
      const changed = r.products.created + r.products.updated + r.products.unlinked + r.orders.updated;
      // Log only if the state changed (first success, or recovered after a failure, or another connector)
      // or if this run actually changed data.
      if (lastState !== `ok:${conn.id}` || changed)
        // Message is built from parts: always the number of ERP products, optionally the number of demo products
        // created in the ERP, and optionally the change counters.
        console.log(`[erp] ${conn.name}: ${r.products.received} products in the ERP` +
          (r.catalog?.created ? `, ${r.catalog.created} demo products created` : '') +
          (changed ? `, ${r.products.created} new / ${r.products.updated} updated, ${r.orders.updated} order status changes` : ''));
      // Remember: this connector is reachable.
      lastState = `ok:${conn.id}`;
    } catch (e) {
      // Warn only once per distinct error (same connector + same message is not repeated every interval).
      if (lastState !== `fail:${conn.id}:${e.message}`) console.warn(`[erp] ${conn.name} not available: ${e.message}`);
      // Remember the failure state.
      lastState = `fail:${conn.id}:${e.message}`;
    }
  };
  // First sync right at start-up (unless ERP_SYNC_ON_START=false), so the shop has current ERP data immediately.
  // The returned Promise is not awaited: start-up continues while the sync runs.
  if (process.env.ERP_SYNC_ON_START !== 'false') tick();
  // Periodic polling (seconds -> milliseconds). .unref() tells Node.js that this timer alone must not keep the
  // process alive, so the server can still shut down cleanly. seconds <= 0 disables the interval.
  if (seconds > 0) setInterval(tick, seconds * 1000).unref();
}
