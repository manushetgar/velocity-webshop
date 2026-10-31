// =====================================================================================================
// routes/fileTransfer.js - Express router for Lab 2 (product transfer ERP -> web shop with files).
//
// Role in the architecture: index.js mounts this router under /api/erp/files, so '/export' is reached at
// POST /api/erp/files/export. All routes are for Admin > File transfer and require admin rights. The logic
// lives in services/fileTransfer.js; the routes only check the permission and the mode and send JSON.
// Errors (400, 404, 409, 413, 502, 503) are thrown and turned into { error } by the error handler in index.js.
// =====================================================================================================

// express itself (for express.raw, the body parser of the upload) and the Router factory.
import express, { Router } from 'express';
// Only logged-in admins may use these routes (401 / 403 otherwise).
import { requireAdmin } from '../auth.js';
// The active connector, or 503 if none is active.
import { requireActiveConnector } from '../services/erpClient.js';
// Read the active connector (may be null) and change a connector's settings (here: its integration style).
import { getActiveConnector, updateConnector } from '../services/connectors.js';
// Runs the sync of a connector right away (file mode: export + import).
import { syncNow } from '../services/erpSync.js';
// The file transfer functions (see services/fileTransfer.js).
import {
  // status, export job, import, upload, mode check, download path
  transferStatus, exportProducts, importInbox, uploadProductFile, requireFileMode, transferFilePath,
} from '../services/fileTransfer.js';
// Size limit of a product file.
import { MAX_FILE_BYTES } from '../services/productFile.js';
// Error with HTTP status.
import { httpError } from '../util.js';

// The router; every route below requires an admin.
const router = Router();
// requireAdmin runs before every route of this router (401 not logged in, 403 not an admin).
router.use(requireAdmin);

// GET /api/erp/files - status of the transfer: folders, naming convention, schedule, inbox, history.
router.get('/', (_req, res) => {
  // Status of the active connector (null connector in standalone mode).
  res.json(transferStatus(getActiveConnector()));
});

// POST /api/erp/files/mode - switches the active connector between 'api' and 'file' (body: { integration })
// and runs a sync right away, so the shop shows data from the new channel. Returns { connector, sync }.
router.post('/mode', async (req, res) => {
  // The connector the switch applies to (503 if none is active).
  const conn = requireActiveConnector();
  // Validated and saved by connectors.js (400 if the value is not 'api' or 'file').
  const updated = updateConnector(conn.id, { integration: req.body.integration });
  // Sync with the new channel; a failure is reported, not thrown (the switch itself succeeded).
  let sync;
  // Spread the transfer result (export, imports, products, ...) into the answer next to ok: true.
  try { sync = { ok: true, ...(await syncNow(updated)) }; } catch (e) { sync = { ok: false, error: e.message }; }
  // Answer: the connector with its new integration style and the result of the first run.
  res.json({ connector: { id: updated.id, name: updated.name, integration: updated.integration }, sync });
});

// POST /api/erp/files/export - runs the ERP export job now: the ERP's CSV export is written into the inbox
// (always a new file, also when the data did not change). Returns { ok, written, file, rows, bytes }.
router.post('/export', async (_req, res) => {
  // force: true - always write a new file (the scheduled job writes only when the ERP data changed).
  res.json(await exportProducts(requireActiveConnector(), { force: true }));
});

// POST /api/erp/files/import - imports all files that are waiting in the inbox now (file mode only).
// Returns one result per file: { file, status: imported|unchanged|rejected, rows, created, updated, errors, ... }.
router.post('/import', async (_req, res) => {
  // 409 if the active connector uses the API, 503 if none is active.
  res.json(await importInbox(requireFileMode(requireActiveConnector())));
});

// POST /api/erp/files/upload?name=<original file name> - the request body is the file itself (binary, sent by
// the browser with fetch). express.raw() collects the bytes into req.body as a Buffer (limit slightly above the
// file limit, so a too large file gets the clear 413 message from the service). The file is stored in the inbox
// under a conventional name and imported right away; the result of its import is returned.
router.post('/upload', express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), async (req, res) => {
  // Without a body express.raw leaves req.body as {} - treat that as an empty upload.
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  // Store + import; the original file name comes from the query string (?name=...).
  res.json(await uploadProductFile(requireFileMode(requireActiveConnector()), body, req.query.name));
});

// GET /api/erp/files/download/:folder/:name - downloads a file from inbox, processed or error (e.g. a rejected
// file or its .error.txt report). The name is checked strictly in the service (no path traversal).
router.get('/download/:folder/:name', (req, res) => {
  // 404 for unknown folders, suspicious names or missing files.
  const path = transferFilePath(req.params.folder, req.params.name);
  // res.download sets Content-Disposition: attachment, so the browser saves the file.
  res.download(path, req.params.name, err => { if (err && !res.headersSent) res.status(404).json({ error: 'File not found.' }); });
});

// Any other path below /api/erp/files.
router.use(() => { throw httpError(404, 'Not found.'); });

// index.js mounts the router with app.use('/api/erp/files', fileTransferRoutes).
export default router;
