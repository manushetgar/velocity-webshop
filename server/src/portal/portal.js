// =====================================================================================================
// portal/portal.js - the SUPPLIER PORTAL (Lab 2 extension): a separate web site for the employees of our
// suppliers. They log in, upload their product file in their own format, and see what happened with it.
//
// Role in the architecture:
//  - A second, independent web application next to the shop: own URL (http://localhost:3200, PORTAL_PORT), own
//    users (supplier_users), own sessions, own look. It shares the server process and database with the shop only
//    to keep the lab easy to start; it could run on its own server.
//  - The portal does NOT talk to the ERP. It only stores the uploaded file in the supplier's inbox folder - the
//    same place the FTP server writes to - and records the delivery. supplierImport.js does the rest
//    (translate -> ERP -> shop) and writes the acknowledgement that the portal shows.
//  - Also mounted under /portal of the shop (needed on SAP BTP, where an app has only one port).
// =====================================================================================================

// Express (app, static files, JSON and raw body parsers).
import express from 'express';
// Paths of the static files and samples (this file's folder).
import { fileURLToPath } from 'node:url';
// dirname / join / extname: paths of the public and samples folders.
import { dirname, join, extname } from 'node:path';
// File access for uploads, reports and samples.
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
// Supplier accounts, sessions, folders and deliveries.
import {
  // logins + sessions, folders, the delivery log
  verifySupplierLogin, createPortalSession, portalSession, deletePortalSession, supplierDirs, createDelivery,
  listDeliveries, getDelivery, deliveryToApi, listUsers,
} from '../services/suppliers.js';
// Processing of the inbox right after an upload.
import { processSupplierInboxes } from '../services/supplierImport.js';
// FTP address for the "your FTP access" box.
import { FTP_HOST, FTP_PORT } from '../services/ftpServer.js';
// Size limit of a file.
import { MAX_FILE_BYTES } from '../services/productFile.js';
// Error with HTTP status.
import { httpError } from '../util.js';

// Folder of this file: public/ (HTML, CSS, JS of the portal) and samples/ (example file per supplier).
const HERE = dirname(fileURLToPath(import.meta.url));

// Short description of a supplier's mapping profile for the portal ("what format do you expect from us?").
function formatInfo(profile) {
  // Agreed field names of the profile.
  const f = profile.fields || {};
  return {
    // File format (auto = detected).
    format: profile.format || 'auto',
    // Separator of delimited text (null = detected).
    delimiter: profile.delimiter || null,
    // Decimal sign.
    decimal: profile.decimal || 'auto',
    // JSON path / XML element of the product list.
    recordPath: profile.recordPath || null,
    // Agreed field names (empty = the portal accepts the usual names, see the hint in the UI).
    fields: Object.keys(f).length ? f : null,
    // Fields the supplier may change on existing products.
    update: profile.update || [],
    // Whether the supplier may create new products.
    createProducts: profile.createProducts !== false,
  };
}

/** The portal as an Express app (used on its own port and mounted under /portal of the shop). */
export function createPortalApp() {
  // A separate Express app (own middleware, routes, static files and error handler).
  const app = express();
  // JSON bodies for login.
  app.use(express.json());

  // Who is logged in: "Authorization: Bearer <token>" -> req.portal = { user, supplier } or undefined.
  app.use((req, _res, next) => {
    // The session token from the header (only word characters).
    const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
    // The session's user + supplier, or null.
    req.portal = m ? portalSession(m[1]) : null;
    // Continue with the route.
    next();
  });
  // Routes that need a login.
  const requireLogin = (req, _res, next) => next(req.portal ? undefined : httpError(401, 'Please log in.'));

  // Demo logins shown on the login page (DEMO_MODE=false hides them).
  app.get('/api/demo-accounts', (_req, res) => {
    // Demo mode switched off: no demo logins on the page.
    if (process.env.DEMO_MODE === 'false') return res.json([]);
    // The demo password (set on the first start).
    const password = process.env.SUPPLIER_DEMO_PASSWORD || 'supplier123';
    // The seeded demo users (username = supplier id) with their supplier names.
    const rows = ['bikeparts', 'globalcycle', 'nordicgear', 'celticparts'].flatMap(id => {
      // The user whose name equals the supplier id (the seeded demo login).
      try { return listUsers(id).filter(u => u.username === id).map(u => ({ username: u.username, name: u.name, supplier: id })); } catch { return []; }
    });
    // Shown on the login page with one-click login.
    res.json(rows.map(r => ({ ...r, password })));
  });

  // Login: { username, password } -> { token, user, supplier }.
  app.post('/api/login', (req, res) => {
    // Check username + password (bcrypt) and that the supplier is active.
    const login = verifySupplierLogin(req.body?.username, req.body?.password);
    // Same message for wrong user and wrong password.
    if (!login) throw httpError(401, 'Wrong username or password.');
    // New session token, the user and the supplier.
    res.json({ token: createPortalSession(login.user.id), user: login.user, supplier: { id: login.supplier.id, name: login.supplier.name } });
  });

  // Logout: ends the session.
  app.post('/api/logout', requireLogin, (req, res) => {
    // Delete the session of the token that was sent.
    deletePortalSession(/^Bearer (\w+)$/.exec(req.headers.authorization)[1]);
    // 204 No Content.
    res.status(204).end();
  });

  // The logged-in user, the supplier, its agreed format and its FTP access.
  app.get('/api/me', requireLogin, (req, res) => {
    // The logged-in user and supplier.
    const { user, supplier } = req.portal;
    // Everything the dashboard shows.
    res.json({
      // Who is logged in.
      user, supplier: { id: supplier.id, name: supplier.name, location: supplier.location },
      // The agreed format (from the mapping profile).
      format: formatInfo(supplier.profile),
      // FTP access (same login), or null if FTP is switched off.
      ftp: FTP_PORT ? { host: FTP_HOST, port: FTP_PORT, username: user.username, folder: '/inbox', acks: '/outbox' } : null,
      // Whether a sample file exists.
      sample: !!sampleFile(supplier.id),
    });
  });

  // Upload: the body is the file itself (binary), ?name= its original name. Stored in the supplier's inbox and
  // processed right away; the answer is the delivery (applied / rejected / waiting) - or "received" if processing
  // takes longer than 20 seconds (the list in the portal updates itself).
  app.post('/api/upload', requireLogin, express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), async (req, res) => {
    // The logged-in user and supplier.
    const { user, supplier } = req.portal;
    // The original file name (only used for the log and the stored name).
    const original = String(req.query.name || 'upload').slice(0, 150);
    // The uploaded bytes (express.raw puts them into req.body).
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // An empty upload is refused.
    if (!body.length) throw httpError(400, 'The file is empty.');
    // Safe file name: time stamp + the original name without path parts and special characters.
    // \p{L} = any letter (also ä, é, ø ...), \p{N} = any digit; everything else becomes "_".
    const safe = original.replace(/^.*[\\/]/, '').replace(/[^\p{L}\p{N}._\- ()]/gu, '_').replace(/^\.+/, '') || 'upload';
    // e.g. 20261026T154200Z_Lagerbestand Oktober.csv - the time stamp keeps names unique and sortable.
    const fileName = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}_${safe}`;
    // The supplier's folders.
    const dirs = supplierDirs(supplier.id);
    // Written as hidden .part file and renamed: the poller never sees a half-written file.
    const tmp = join(dirs.inbox, `.${fileName}.part`);
    // Write the whole file under the temporary name.
    writeFileSync(tmp, body);
    // Make it visible for the import in one step.
    renameSync(tmp, join(dirs.inbox, fileName));
    // Record the delivery (channel portal, the user, the original name).
    const id = createDelivery({ supplierId: supplier.id, channel: 'portal', username: user.username, originalName: safe, fileName });
    // Process now, but answer after 20 s at the latest.
    await Promise.race([processSupplierInboxes({ supplierId: supplier.id, force: true }).catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
    // 201 Created with the delivery (status applied / unchanged / rejected / waiting, or received).
    res.status(201).json(deliveryToApi(getDelivery(id)));
  });

  // The supplier's deliveries (newest first).
  app.get('/api/deliveries', requireLogin, (req, res) => {
    // Only the deliveries of the logged-in user's supplier.
    res.json(listDeliveries({ supplierId: req.portal.supplier.id, limit: 50 }));
  });

  // Acknowledgement / error report of a delivery (text file from the supplier's outbox).
  app.get('/api/deliveries/:id/report', requireLogin, (req, res) => {
    // The delivery (404 if unknown).
    const d = getDelivery(req.params.id);
    // Deliveries of other suppliers are not visible (404 instead of 403: nothing is revealed).
    if (d.supplier_id !== req.portal.supplier.id) throw httpError(404, 'Delivery not found.');
    // Folders of the supplier.
    const dirs = supplierDirs(d.supplier_id);
    // Acknowledgement or error report in the outbox.
    const file = ['ack', 'error'].map(k => join(dirs.outbox, `${d.file_name}.${k}.txt`)).find(existsSync);
    // Not written yet.
    if (!file) throw httpError(404, 'There is no report yet.');
    // Plain text, UTF-8.
    res.type('text/plain; charset=utf-8').send(readFileSync(file, 'utf8'));
  });

  // Example file in the supplier's agreed format (download).
  app.get('/api/sample', requireLogin, (req, res) => {
    // The sample file of this supplier.
    const file = sampleFile(req.portal.supplier.id);
    // No sample for this supplier.
    if (!file) throw httpError(404, 'No sample file for this supplier.');
    // Sent as a download (Content-Disposition: attachment).
    res.download(file);
  });

  // Unknown API paths: 404 as JSON.
  app.use('/api', () => { throw httpError(404, 'Not found.'); });
  // The portal's web page (index.html, portal.css, portal.js).
  app.use(express.static(join(HERE, 'public')));

  // Errors -> JSON { error } (same convention as the shop API).
  app.use((err, _req, res, _next) => {
    // Status of the error (httpError, body parser) or 500.
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    // Only unexpected errors are logged with their stack trace.
    if (status === 500) console.error(err);
    // No internal details for 500 errors.
    res.status(status).json({ error: status === 500 ? 'Internal server error.' : err.message });
  });
  // index.js mounts the app under /portal and starts it on PORTAL_PORT.
  return app;
}

// The sample file of a supplier: samples/<supplier id>.<any extension>, or null.
function sampleFile(id) {
  // The samples folder next to this file.
  const dir = join(HERE, 'samples');
  // No samples folder: no sample.
  if (!existsSync(dir)) return null;
  // The file whose name without extension is the supplier id (e.g. bikeparts.csv).
  const name = readdirSync(dir).find(f => f.slice(0, -extname(f).length) === id);
  // Its full path, or null.
  return name ? join(dir, name) : null;
}
