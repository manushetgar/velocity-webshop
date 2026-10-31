// =====================================================================================================
// routes/erp.js - Express router for everything ERP-related: connection status, manual synchronisation
// with the Mini-ERP and the administration of the SAP connectors (Admin > SAP connectors).
//
// Role in the architecture: index.js mounts this router under /api/erp, so a route written here as
// '/status' is reached at GET /api/erp/status. The routes are kept thin: they check the permission,
// call a service function (connectors.js, erpClient.js, erpSync.js, productSync.js, erpMasterData.js)
// and send the result as JSON. All ERP communication itself happens in services/erpClient.js.
//
// Error handling: Express 5 automatically catches errors thrown in route handlers - also rejected promises
// of async handlers - and passes them to the central error handler in index.js. That handler answers with
// err.status (e.g. 400, 404, 409 from connectors.js or 502/503 from an ErpError) and { error: message }.
// That is why the handlers below contain no try/catch.
//
// Permissions: optionalAuth (index.js) sets req.user from the "Authorization: Bearer <session token>"
// header. requireAdmin answers 401 (not logged in) or 403 (logged in, but not an admin) and otherwise lets
// the request continue. Only GET /status is public.
// =====================================================================================================

// Import the Router factory of Express: a router is a "mini application" with its own routes, mounted in index.js.
import { Router } from 'express';
// Import the SQLite connection (better-sqlite3), used here for one small COUNT query.
import { db } from '../db.js';
// Import the middleware that only lets logged-in admins through (401 / 403 otherwise).
import { requireAdmin } from '../auth.js';
// Import from the ERP client:
//  - clientFor: API object for one ERP connector (products(), createOrder(), ...)
//  - clearToken: removes the cached OAuth token of a connector
//  - testConnector: connection test (REST + OData), returns { ok, ms, ... } and never throws
//  - requireActiveConnector: returns the active connector or throws 503 if none is active
import { clientFor, clearToken, testConnector, requireActiveConnector } from '../services/erpClient.js';
// Import the connector functions (database access and validation of the erp_connectors table):
import {
  // read the active connector / all connectors / one connector (404 if unknown) / convert a row to API JSON
  // (without password) / build an unsaved connector from a request body (for the test before saving)
  getActiveConnector, listConnectors, getConnector, connectorToApi, connectorFromBody,
  // write operations: create, update, delete (with 400 / 404 / 409 checks)
  createConnector, updateConnector, deleteConnector,
} from '../services/connectors.js';
// Import the product sync (ERP -> shop: the ERP is master for products, prices, stock) and the in-memory
// record of the last sync per connector (time, ok/error, result counts).
import { syncProductsFromErp, getLastSync } from '../services/productSync.js';
// Import the flag whether shop orders are handed over to the ERP (true when a connector is active, unless
// ERP_ORDERS=false).
import { erpOrdersEnabled } from '../services/erpOrders.js';
// Import the function that creates the shop's demo catalog as products in the ERP ("Load demo catalog").
import { loadCatalogIntoErp } from '../services/erpMasterData.js';
// Import from the sync service:
//  - syncNow: full sync of a connector (products + order statuses); joins a sync that is already running
//  - activateConnector: switches the shop to a connector (or to none) and syncs it immediately
//  - linkedProducts: number of active shop products linked to a connector
import { syncNow, activateConnector, linkedProducts } from '../services/erpSync.js';
// Lab 2 file transfer: mode check and one transfer run (export + import) for the demo catalog button.
import { isFileMode, runFileCycle } from '../services/fileTransfer.js';
// Error with HTTP status (409 for API-only actions in file transfer mode).
import { httpError } from '../util.js';

// Create the router object; the routes below are registered on it and it is exported at the end of the file.
const router = Router();

// Active connector + last sync (public, contains no secrets): used by the shop header and empty states
// GET /api/erp/status - PUBLIC (no login needed). Returns JSON describing the current ERP connection.
// SECURITY: only id, name, URL and auth method of the connector are returned - never user, password or key file.
router.get('/status', (_req, res) => {
  // Read the active connector (null if the shop runs standalone).
  const c = getActiveConnector();
  // Send the status as JSON (HTTP 200):
  res.json({
    // true if a connector is active
    configured: !!c,
    // public data of the active connector, or null; integration = 'api' or 'file' (Lab 2 file transfer)
    connector: c ? { id: c.id, name: c.name, url: c.url, auth: c.auth, integration: c.integration } : null,
    // how product data reaches the shop: 'api' (live REST/OData), 'file' (file transfer) or null (standalone)
    integration: c?.integration ?? null,
    // ERP URL and auth method also as top-level fields (null if no connector is active)
    url: c?.url ?? null,
    auth: c?.auth ?? null,
    // whether new shop orders are created in the ERP
    ordersToErp: erpOrdersEnabled(),
    // result of the last sync of this connector ({ at, ok, result | error }), or null
    lastSync: c ? getLastSync(c.id) : null,
    // how many shop products are linked to this ERP
    products: c ? linkedProducts(c.id) : null,
  });
});

// Live connectivity check of the active connector (admin)
// GET /api/erp/ping - ADMIN only. Makes a real ERP call and returns { reachable, ms, erpProducts }.
// If no connector is active (503) or the ERP fails, the ErpError goes to the central error handler, so the
// admin gets e.g. 503 "ERP not reachable (...)" instead of reachable: true.
router.get('/ping', requireAdmin, async (_req, res) => {
  // Start time, to measure the round trip to the ERP.
  const t0 = Date.now();
  // Read all products of the active connector's ERP via the REST API (with timeout and retries).
  const products = await clientFor(requireActiveConnector()).products();
  // Success: duration in milliseconds and number of products in the ERP.
  res.json({ reachable: true, ms: Date.now() - t0, erpProducts: products.length });
});

// Pull products from the ERP into the shop (admin)
// POST /api/erp/sync-products - ADMIN only. POST because it changes data (the shop's product table).
// Syncs the products of the active connector (503 if none) and returns the counts
// { received, created, updated, unchanged, skipped, unlinked }.
router.post('/sync-products', requireAdmin, async (_req, res) => {
  // In file transfer mode products come only from files (POST /api/erp/sync runs the file transfer instead).
  if (isFileMode(requireActiveConnector())) throw httpError(409, 'The active connector uses file transfer - use Sync now or Admin > File transfer.');
  // Run the product sync and send its result as JSON.
  res.json(await syncProductsFromErp());
});

// Full sync (admin): products (+ demo catalog if enabled) + order status changes made in the ERP
// POST /api/erp/sync - ADMIN only ("Sync now" button). Returns the sync result (products, orders, catalog).
router.post('/sync', requireAdmin, async (_req, res) => {
  // Throw 503 if no connector is active - without this check syncNow() would just return null.
  requireActiveConnector();
  // Run (or join an already running) full sync of the active connector and send the result.
  res.json(await syncNow());
});

// Load the demo catalog into the ERP of the active connector (admin)
// POST /api/erp/load-catalog - ADMIN only. Creates missing demo products in the ERP (OData POST), fills empty
// descriptions, then syncs the products back into the shop. Returns { created, completed, existing, products }.
router.post('/load-catalog', requireAdmin, async (_req, res) => {
  // The active connector (503 if none).
  const conn = requireActiveConnector();
  // File transfer mode (Lab 2): create the products in the ERP only, then let them travel the file way
  // (export file -> inbox -> import), so the shop never receives product data through the API in this mode.
  if (isFileMode(conn)) {
    const catalog = await loadCatalogIntoErp(conn, { syncShop: false });
    return res.json({ ...catalog, products: (await runFileCycle(conn, { forceExport: true })).products });
  }
  // Run the catalog load against the active connector and send the counts.
  res.json(await loadCatalogIntoErp(conn));
});

/* ---------- SAP connectors (admin) ---------- */
// All routes below are for Admin > SAP connectors and require admin rights (requireAdmin).

// Helper: number of shop orders that were created in the ERP of a connector. SQL: COUNT(*) of the orders whose
// erp_connector column equals the parameter (? placeholder, bound safely); .get() returns { n }.
const orderCount = id => db.prepare('SELECT COUNT(*) AS n FROM orders WHERE erp_connector = ?').get(id).n;
// Helper: a connector as API JSON (without password) plus extra info for the admin UI: last sync, number of
// linked products and number of orders in that ERP (the UI uses it e.g. to explain why delete is blocked).
const withInfo = c => connectorToApi(c, { lastSync: getLastSync(c.id), products: linkedProducts(c.id), orders: orderCount(c.id) });

// GET /api/erp/connectors - ADMIN only. Returns an array with all connectors (each with the info above).
router.get('/connectors', requireAdmin, (_req, res) => {
  // Load all rows, convert each one with withInfo and send the array as JSON.
  res.json(listConnectors().map(withInfo));
});

// POST /api/erp/connectors - ADMIN only. Creates a connector from the JSON body (name, url, auth, username,
// password, keyFile, autoCatalog). Invalid input -> 400 from validate() in connectors.js.
router.post('/connectors', requireAdmin, (req, res) => {
  // Create it and answer 201 Created (the standard status for "a new resource was created")
  // with the new connector as JSON.
  res.status(201).json(withInfo(createConnector(req.body)));
});

// Test a configuration before saving it (empty password = keep the stored one of body.id)
// POST /api/erp/connectors/test - ADMIN only. Validates the form data (400 if invalid), runs the connection test
// with it and returns { ok, ms, erpProducts } or { ok: false, ms, error }. Nothing is saved.
router.post('/connectors/test', requireAdmin, async (req, res) => {
  // Build an unsaved connector from the body, test it and send the test result.
  res.json(await testConnector(connectorFromBody(req.body)));
});

// PUT /api/erp/connectors/:id - ADMIN only. Updates the connector with the id from the URL (:id is available as
// req.params.id). PUT = update of an existing resource. 404 if unknown, 400 if invalid. Returns the connector.
router.put('/connectors/:id', requireAdmin, async (req, res) => {
  // Validate and save the changes in SQLite.
  const c = updateConnector(req.params.id, req.body);
  // The URL or credentials may have changed: drop the cached OAuth token so the next call gets a new one.
  clearToken(c.id);
  // If this is the active connector, sync it right away so the shop shows the data of the (possibly changed)
  // ERP. .catch(() => {}) ignores sync errors: the save itself succeeded, and the sync error is recorded by the
  // sync service (shown as last sync in the admin UI).
  if (getActiveConnector()?.id === c.id) await syncNow(c).catch(() => {});
  // Send the updated connector (HTTP 200).
  res.json(withInfo(c));
});

// DELETE /api/erp/connectors/:id - ADMIN only. Deletes the connector. 404 if unknown; 409 Conflict if it is
// the active connector or shop orders exist in its ERP (checked in connectors.js).
router.delete('/connectors/:id', requireAdmin, (req, res) => {
  // Delete it (throws 404 / 409 as described above).
  deleteConnector(req.params.id);
  // 204 No Content: success, and the response intentionally has no body. .end() finishes the response.
  res.status(204).end();
});

// POST /api/erp/connectors/:id/test - ADMIN only. Tests the STORED configuration of a connector (404 if
// unknown). Returns { ok, ms, erpProducts } or { ok: false, ms, error }.
router.post('/connectors/:id/test', requireAdmin, async (req, res) => {
  // Load the connector, run the connection test and send the result.
  res.json(await testConnector(getConnector(req.params.id)));
});

// Switch the shop to this connector; products and order statuses are synced right away
// POST /api/erp/connectors/:id/activate - ADMIN only. Returns { active: id, sync: { ok, ... } }; a failed sync
// does not undo the activation, it is reported as sync: { ok: false, error }. 404 if the id is unknown.
router.post('/connectors/:id/activate', requireAdmin, async (req, res) => {
  // Activate the connector, sync it and send the result.
  res.json(await activateConnector(req.params.id));
});

// No connector: the shop runs standalone with its local products and stock
// POST /api/erp/disconnect - ADMIN only. Deactivates every connector; returns { active: null, sync: null }.
router.post('/disconnect', requireAdmin, async (_req, res) => {
  // activateConnector(null) stores "no active connector" in the settings table.
  res.json(await activateConnector(null));
});

// Export the router; index.js mounts it with app.use('/api/erp', erpRoutes).
export default router;
