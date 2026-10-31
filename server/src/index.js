// ---------------------------------------------------------------------------------------------------------------
// index.js - entry point of the web shop backend (Node.js 22 + Express 5).
//
// Started with `npm start` / `npm run dev` in the server folder. The first import (env.js) loads the optional file
// server/.env into process.env. This file wires the application together:
//  1. opens/initializes the SQLite database (import of db.js),
//  2. registers the global middleware (JSON body parser, optional authentication),
//  3. mounts the REST API route modules under /api (products, customers/auth, orders, ERP integration, admin),
//  4. serves the built React frontend from the same server in production (e.g. on SAP BTP Cloud Foundry),
//  5. installs the central error handler that turns all errors into JSON responses,
//  6. starts the HTTP server and the background synchronization with the active SAP connector (Mini-ERP).
// The ERP is the master (source of truth) for products, prices, stock and orders; the background sync keeps the
// shop's SQLite copy of that data up to date.
// ---------------------------------------------------------------------------------------------------------------

// Must be the FIRST import: loads server/.env (if present) before db.js and the other modules read process.env.
import './env.js';
// Express: the web framework (version 5) that handles HTTP requests, routing and middleware.
import express from 'express';
// existsSync: synchronous check whether a file or folder exists (used to find the built React app).
import { existsSync } from 'node:fs';
// fileURLToPath: converts the file:// URL of this module (import.meta.url) into a normal file system path.
// Needed because ES modules have no __dirname variable like CommonJS modules.
import { fileURLToPath } from 'node:url';
// dirname: folder part of a path; join: combines path segments with the correct separator for the operating system.
import { dirname, join } from 'node:path';
// Side-effect import (nothing is imported by name): loading db.js opens the SQLite file, creates the tables, runs the
// schema upgrades and creates the SAP connectors, sample products and demo accounts on the first start. Importing it
// here makes clear that the database is initialized when the server starts. ES modules are executed only once, so the
// other modules that import db.js get the same, already initialized connection.
import './db.js';
// optionalAuth: middleware that reads the Bearer token and sets req.user for logged-in users (see auth.js).
import { optionalAuth } from './auth.js';
// Product catalog API: public product list/details, admin create/edit/remove (synchronized with the ERP).
import productRoutes from './routes/products.js';
// Customer API: demo accounts, registration, login/logout and the own profile (/api/auth/..., /api/me).
import customerRoutes from './routes/customers.js';
// Order API: checkout ("ERP first": the order is created in the ERP before it is stored in the shop),
// purchase history, status changes and cancellation.
import orderRoutes from './routes/orders.js';
// ERP integration API for the admin: ERP status, connection test, manual sync, load demo catalog, and the
// management of the SAP connectors (create, edit, test, activate, delete, disconnect).
import erpRoutes from './routes/erp.js';
// Admin reporting API: dashboard key figures and customer list (routes/admin.js).
import adminRoutes from './routes/admin.js';
// getActiveConnector: returns the SAP connector that is currently active (or null) - used for the start-up log.
import { getActiveConnector } from './services/connectors.js';
// startBackgroundSync: starts the periodic synchronization of products and order statuses from the active ERP.
import { startBackgroundSync } from './services/erpSync.js';
// Lab 2 file transfer API for the admin: status, export now, import now, upload, download, switch API <-> file.
import fileTransferRoutes from './routes/fileTransfer.js';
// startInboxPoller: checks the transfer inbox every FILE_POLL_INTERVAL_S seconds (file transfer mode only).
import { startInboxPoller } from './services/fileTransfer.js';
// Lab 2 extension - suppliers: admin API (Admin > Suppliers), the supplier portal (separate site), the FTP server
// for supplier systems and the poller that processes the supplier inboxes (supplier file -> ERP -> shop).
import supplierRoutes from './routes/suppliers.js';
// The supplier portal as its own Express app (own users, own pages).
import { createPortalApp } from './portal/portal.js';
// The FTP server for supplier systems.
import { startFtpServer } from './services/ftpServer.js';
// The poller of the supplier inboxes.
import { startSupplierPoller } from './services/supplierImport.js';

// Creates the Express application object; middleware and routes are registered on it below.
const app = express();
// TCP port of the HTTP server. On Cloud Foundry the platform sets the PORT environment variable and routes the app's
// public URL to it, so it must be used there; locally the default is 3001 (the Vite dev server of the React client
// forwards /api requests to http://localhost:3001). Number() converts the environment string into a number.
const PORT = Number(process.env.PORT || 3001);

// Global middleware, executed in this order for every request:
// express.json() parses request bodies with Content-Type application/json and puts the result into req.body
// (e.g. the cart lines of the checkout). Invalid JSON produces an error that the error handler below answers with 400.
app.use(express.json());
// Identifies the user for every request (sets req.user if a valid session token is sent; never rejects a request).
// Individual routes then decide with requireAuth / requireAdmin whether a login is needed.
app.use(optionalAuth);

// Health check: a simple endpoint that shows that the backend is running (useful for monitoring and quick tests).
// It returns { status: 'ok', time: <current server time as ISO string> } with HTTP 200 and needs no database or ERP.
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
// Mounts the route modules. app.use(prefix, router) passes every request whose path starts with the prefix to the
// router; the router's own paths are relative to the prefix (e.g. router.get('/:id') -> GET /api/products/:id).
// /api/products: product catalog.
app.use('/api/products', productRoutes);
// Directly under /api because the customer router defines several path groups itself: /api/demo-accounts,
// /api/auth/register, /api/auth/login, /api/auth/logout and /api/me.
app.use('/api', customerRoutes);
// /api/orders: checkout and order handling.
app.use('/api/orders', orderRoutes);
// /api/erp: ERP integration and SAP connector management (admin).
app.use('/api/erp', erpRoutes);
// /api/erp/files: Lab 2 file transfer (admin). Requests not matched by erpRoutes above continue to this router.
app.use('/api/erp/files', fileTransferRoutes);
// /api/suppliers: suppliers, mapping profiles, supplier users and deliveries (admin).
app.use('/api/suppliers', supplierRoutes);
// /api/admin: dashboard figures and customer list (all routes are admin-only).
app.use('/api/admin', adminRoutes);
// The supplier portal (a separate site for the suppliers' employees) - also reachable under /portal/ of the shop (needed
// on SAP BTP, where an app has only one port; locally it has its own port, see below). "/portal" without the slash is
// redirected, because the portal page uses relative URLs ("api/login") that need the trailing slash.
const portalApp = createPortalApp();
// (Express treats "/portal" and "/portal/" as the same route, so only the path without slash is redirected.)
app.get('/portal', (req, res, next) => (req.originalUrl.split('?')[0] === '/portal' ? res.redirect('/portal/') : next()));
// Mount the portal app under /portal (its pages and its API under /portal/api/...).
app.use('/portal', portalApp);

// Catch-all for unknown API paths: answer 404 Not Found as JSON. It must come AFTER all API routers (Express checks
// middleware in the order of registration) and BEFORE the frontend fallback below, which would otherwise return the
// HTML page with status 200 for a mistyped API URL - confusing for API clients that expect JSON.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Serve the built React app (npm run build) from the same server in production
// Path of the Vite build output: from server/src/ two folders up to the project root, then client/dist.
// One server for frontend and API means one URL and no CORS configuration (same origin), e.g. on Cloud Foundry.
const clientDist = join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
// Only if the frontend has been built. During development the folder may be missing; then the Vite dev server
// (port 5173) delivers the frontend and this block is skipped.
if (existsSync(clientDist)) {
  // Delivers the static files of the build (index.html, JavaScript and CSS bundles, images) by their path.
  app.use(express.static(clientDist));
  // Single-page-application fallback: every GET path that does NOT start with /api (regular expression with the
  // negative lookahead (?!\/api)) gets index.html. React then shows the right page on the client side, so a reload or a
  // bookmark of e.g. /admin/orders works. A regular expression is used because Express 5 (path-to-regexp v8) no longer
  // accepts a bare '*' wildcard in path strings.
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// Central error handler: thrown httpErrors become JSON responses
// Express recognizes an error-handling middleware by its FOUR parameters (err, req, res, next), so `_next` must be
// declared even though it is not used. Express 5 also forwards errors of async route handlers (rejected promises)
// here, e.g. an httpError thrown by a validation or an ErpError (status 502/503/409...) from the ERP client.
app.use((err, _req, res, _next) => {
  // HTTP status of the response: the status attached to the error (httpError, ErpError, body parser);
  // 'entity.parse.failed' is the error type of express.json() for invalid JSON -> 400 Bad Request;
  // everything else is an unexpected error -> 500 Internal Server Error.
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  // Only unexpected errors are logged with the full stack trace on the server console; expected client errors
  // (4xx, e.g. "Your cart is empty.") are normal behavior and would only fill the log.
  if (status === 500) console.error(err);
  // JSON body { error: <text> } that the frontend shows. For 500 a generic text is sent instead of err.message, so
  // internal details (SQL errors, file paths, stack traces) are not revealed to the client (security).
  res.status(status).json({ error: status === 500 ? 'Internal server error.' : err.message });
});

// Starts the HTTP server on PORT. In Express 5 the callback also receives an error if the server cannot start.
app.listen(PORT, err => {
  // The server could not be started.
  if (err) {
    // EADDRINUSE = the port is already used by another process (e.g. the shop is already running in another
    // terminal) -> print a readable hint; any other error is printed completely.
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other process or set PORT.` : err);
    // End the process with exit code 1 (= failure); a backend without an HTTP server is useless.
    process.exit(1);
  }
  // Successful start: show the URL of the API in the console.
  console.log(`Web shop API running on http://localhost:${PORT}`);
  // Reads the active SAP connector from the database (settings.active_connector), or null if none is active.
  const conn = getActiveConnector();
  // Logs which ERP the shop is connected to (name, base URL and authentication type: basic or oauth), or that the
  // shop runs standalone with its local sample products. Helps to see the integration state right after the start.
  console.log(conn
    ? `[erp] active SAP connector: ${conn.name} (${conn.url}, ${conn.auth} auth) - change it in Admin > SAP connectors`
    : '[erp] no SAP connector active - the shop runs standalone with its local products');
  // Starts the synchronization with the ERP (master of the data): pulls products, prices and stock and the order
  // status changes made in the ERP into the shop's database. It runs in the background, the server answers requests
  // meanwhile; without an active connector each run does nothing.
  startBackgroundSync(); // products + order statuses on start and every ERP_SYNC_INTERVAL_S seconds
  // Lab 2: watch the transfer inbox for new product files (does nothing while the active connector uses the API).
  startInboxPoller();
  // Lab 2 extension: the supplier portal on its own port (PORTAL_PORT, default 3200; 0 = only under /portal/).
  const portalPort = Number(process.env.PORTAL_PORT ?? 3200);
  // 0 switches the own port off (Cloud Foundry gives an app only one port).
  if (portalPort) {
    // Start the portal on its port; a port in use is only logged (the portal still works under /portal/).
    portalApp.listen(portalPort, e => console.log(e
      ? `[portal] port ${portalPort} is not available (${e.code || e.message}) - the portal is still reachable under /portal/`
      : `[portal] supplier portal running on http://localhost:${portalPort}`));
  }
  // The FTP server for supplier systems (FTP_PORT, default 2121; 0 = off) and the processing of the supplier inboxes.
  startFtpServer();
  // Process the supplier inboxes every FILE_POLL_INTERVAL_S seconds (portal uploads are processed at once anyway).
  startSupplierPoller();
});
