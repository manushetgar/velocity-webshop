// =====================================================================================================
// routes/suppliers.js - admin API for the supply chain partners (Lab 2 extension), mounted under /api/suppliers.
//
// Admin > Suppliers uses it to manage the suppliers, their mapping profiles and users (portal + FTP logins),
// to watch the deliveries and to test a mapping profile with a file ("Preview") without importing anything.
// All routes require an admin. Errors are thrown and answered as { error } by the handler in index.js.
// =====================================================================================================

// express (raw body parser for the preview upload) and the Router factory.
import express, { Router } from 'express';
// Admin check.
import { requireAdmin } from '../auth.js';
// Data access for suppliers, users, folders and deliveries.
import {
  // suppliers and their profiles, users (portal + FTP logins),
  listSuppliers, getSupplier, createSupplier, updateSupplier, listUsers, createUser, setUserPassword, deleteUser,
  // folders, deliveries and the profile check of the preview
  supplierDirs, listSupplierFiles, listDeliveries, getDelivery, cleanProfile,
  // where supplier data is written (Local / Cloud / both)
  getTargetSetting, setTargetSetting, resolveTargets, connectorKind,
} from '../services/suppliers.js';
// All SAP connectors and the active one (choices of "Write supplier data to").
import { listConnectors, getActiveConnector } from '../services/connectors.js';
// Processing of the inboxes ("Process now").
import { processSupplierInboxes } from '../services/supplierImport.js';
// Parsing and mapping (for the preview).
import { parseRecords, resolveMapping, toCanonical } from '../services/supplierFormats.js';
// FTP address and portal port for the info box.
import { FTP_HOST, FTP_PORT } from '../services/ftpServer.js';
// File size limit.
import { MAX_FILE_BYTES } from '../services/productFile.js';
// Error with HTTP status.
import { httpError } from '../util.js';
// Report files in the outbox.
import { existsSync, readFileSync } from 'node:fs';
// join builds file paths.
import { join } from 'node:path';

// The router; every route below requires an admin (401 / 403 otherwise).
const router = Router();
router.use(requireAdmin);

// A supplier as JSON for the admin UI: profile, users, waiting files, last delivery.
function supplierToApi(s) {
  // The supplier's folders (created if missing).
  const dirs = supplierDirs(s.id);
  // The newest delivery of this supplier (or null).
  const last = listDeliveries({ supplierId: s.id, limit: 1 })[0] || null;
  return {
    // Master data and mapping profile.
    id: s.id, name: s.name, location: s.location, active: !!s.active, profile: s.profile,
    // Logins without password hashes.
    users: listUsers(s.id).map(u => ({ id: u.id, username: u.username, name: u.name, createdAt: u.created_at })),
    // Files waiting in the inbox.
    inbox: listSupplierFiles(dirs.inbox).map(f => ({ name: f.name, size: f.size, modified: f.modified })),
    // Folder on the server and the last delivery.
    folder: dirs.root, lastDelivery: last,
  };
}

// GET /api/suppliers - all suppliers + channel info (portal URL, FTP address) + where supplier data is written.
router.get('/', (_req, res) => {
  // Port of the portal's own site (0 = only under /portal/ of the shop).
  const portalPort = Number(process.env.PORTAL_PORT ?? 3200);
  // Everything Admin > Suppliers needs in one request.
  res.json({
    // All suppliers with their info.
    suppliers: listSuppliers().map(supplierToApi),
    // Where the portal can be opened.
    portal: { port: portalPort || null, path: '/portal/' },
    // FTP address, or null if the FTP server is switched off.
    ftp: FTP_PORT ? { host: FTP_HOST, port: FTP_PORT } : null,
    // Where supplier data is written: the setting, the choices and the ERPs it means right now.
    targets: targetsToApi(),
  });
});

// The target setting for the admin UI: { mode, ids, options: [{ id, name, kind, active }], resolved: [ids] }.
function targetsToApi() {
  // The shop's active connector (marked in the choices).
  const active = getActiveConnector();
  return {
    // The stored setting (mode active / list / all, chosen ids).
    ...getTargetSetting(),
    // Every connector as a choice: local = ERP on this computer, cloud = e.g. SAP BTP.
    options: listConnectors().map(c => ({ id: c.id, name: c.name, kind: connectorKind(c), active: c.id === active?.id })),
    // The connectors new files are written to now (empty = files wait).
    resolved: resolveTargets().map(c => c.id),
  };
}

// PUT /api/suppliers/targets - { mode: 'active' | 'list' | 'all', ids: [connector ids] }: where new supplier files are
// written. Registered before PUT /:id, otherwise "targets" would be taken as a supplier id.
router.put('/targets', (req, res) => { setTargetSetting(req.body); res.json(targetsToApi()); });

// POST /api/suppliers - new supplier { name, location, profile }.
router.post('/', (req, res) => res.status(201).json(supplierToApi(createSupplier(req.body))));

// PUT /api/suppliers/:id - change name, location, active, profile.
router.put('/:id', (req, res) => res.json(supplierToApi(updateSupplier(req.params.id, req.body))));

// POST /api/suppliers/:id/users - new user { username, name, password } (portal + FTP login).
router.post('/:id/users', (req, res) => res.status(201).json(createUser(req.params.id, req.body)));

// PUT /api/suppliers/users/:userId/password - new password { password }.
router.put('/users/:userId/password', (req, res) => { setUserPassword(req.params.userId, req.body.password); res.status(204).end(); });

// DELETE /api/suppliers/users/:userId
router.delete('/users/:userId', (req, res) => { deleteUser(req.params.userId); res.status(204).end(); });

// GET /api/suppliers/deliveries?supplier=<id> - newest deliveries (all suppliers or one).
router.get('/deliveries', (req, res) => res.json(listDeliveries({ supplierId: req.query.supplier || null, limit: 100 })));

// GET /api/suppliers/deliveries/:id/report - the acknowledgement / error report sent to the supplier.
router.get('/deliveries/:id/report', (req, res) => {
  // The delivery (404 if unknown).
  const d = getDelivery(req.params.id);
  // Folders of its supplier.
  const dirs = supplierDirs(d.supplier_id);
  // The acknowledgement (.ack.txt) or the error report (.error.txt) in the outbox.
  const file = ['ack', 'error'].map(k => join(dirs.outbox, `${d.file_name}.${k}.txt`)).find(existsSync);
  // Not written yet (e.g. the file is still waiting).
  if (!file) throw httpError(404, 'There is no report yet.');
  // Plain text, UTF-8.
  res.type('text/plain; charset=utf-8').send(readFileSync(file, 'utf8'));
});

// POST /api/suppliers/process - process all inboxes now (also retries waiting files immediately).
router.post('/process', async (_req, res) => res.json(await processSupplierInboxes({ force: true })));

// POST /api/suppliers/:id/preview?name=<file name> - body = a file. Shows how the file would be read with the
// profile from the request header X-Profile (JSON, the unsaved form) or the stored one - nothing is imported.
router.post('/:id/preview', express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), (req, res) => {
  // The supplier (404 if unknown).
  const s = getSupplier(req.params.id);
  // The unsaved profile from the form (X-Profile header, URI encoded JSON) or the stored profile.
  const profile = req.headers['x-profile'] ? cleanProfile(JSON.parse(decodeURIComponent(req.headers['x-profile']))) : s.profile;
  // The file (an empty upload becomes an empty buffer).
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    // Step 1: read the file into records.
    const parsed = parseRecords(body, String(req.query.name || 'file'), profile);
    // Step 2: mapping (profile or synonyms).
    const { mapping, errors: mappingErrors } = resolveMapping(parsed.fields, profile.fields);
    // Step 3: values (only if the mapping is complete).
    const canonical = mappingErrors.length ? { products: [], errors: [] } : toCanonical(parsed.records, mapping, profile);
    // How the file was read, the mapping, the first 10 products and all problems - nothing is imported.
    res.json({ format: parsed.format, info: parsed.info, fields: parsed.fields, mapping, records: parsed.records.length,
               products: canonical.products.slice(0, 10), errors: [...mappingErrors, ...parsed.problems, ...canonical.errors] });
  } catch (e) {
    // Unreadable file: only the reason.
    res.json({ errors: [`the file cannot be read: ${e.message}`] });
  }
});

// index.js mounts the router with app.use('/api/suppliers', supplierRoutes).
export default router;
