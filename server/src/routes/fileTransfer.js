import express, { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { requireActiveConnector } from '../services/erpClient.js';
import { getActiveConnector, updateConnector } from '../services/connectors.js';
import { syncNow } from '../services/erpSync.js';
import {
  transferStatus, exportProducts, importInbox, uploadProductFile, requireFileMode, transferFilePath,
} from '../services/fileTransfer.js';
import { MAX_FILE_BYTES } from '../services/productFile.js';
import { httpError } from '../util.js';

const router = Router();
router.use(requireAdmin);

router.get('/', (_req, res) => {
  res.json(transferStatus(getActiveConnector()));
});

router.post('/mode', async (req, res) => {
  const conn = requireActiveConnector();
  const updated = updateConnector(conn.id, { integration: req.body.integration });
  let sync;
  try { sync = { ok: true, ...(await syncNow(updated)) }; } catch (e) { sync = { ok: false, error: e.message }; }
  res.json({ connector: { id: updated.id, name: updated.name, integration: updated.integration }, sync });
});

router.post('/export', async (_req, res) => {
  res.json(await exportProducts(requireActiveConnector(), { force: true }));
});

router.post('/import', async (_req, res) => {
  res.json(await importInbox(requireFileMode(requireActiveConnector())));
});

router.post('/upload', express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  res.json(await uploadProductFile(requireFileMode(requireActiveConnector()), body, req.query.name));
});

router.get('/download/:folder/:name', (req, res) => {
  const path = transferFilePath(req.params.folder, req.params.name);
  res.download(path, req.params.name, err => { if (err && !res.headersSent) res.status(404).json({ error: 'File not found.' }); });
});

router.use(() => { throw httpError(404, 'Not found.'); });

export default router;
