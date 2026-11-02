import express, { Router } from 'express';
import { requireAdmin } from '../auth.js';
import {
  listSuppliers, getSupplier, createSupplier, updateSupplier, listUsers, createUser, setUserPassword, deleteUser,
  supplierDirs, listSupplierFiles, listDeliveries, getDelivery, cleanProfile,
  getTargetSetting, setTargetSetting, resolveTargets, connectorKind,
} from '../services/suppliers.js';
import { listConnectors, getActiveConnector } from '../services/connectors.js';
import { processSupplierInboxes } from '../services/supplierImport.js';
import { parseRecords, resolveMapping, toCanonical } from '../services/supplierFormats.js';
import { FTP_HOST, FTP_PORT } from '../services/ftpServer.js';
import { MAX_FILE_BYTES } from '../services/productFile.js';
import { httpError } from '../util.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const router = Router();
router.use(requireAdmin);

function supplierToApi(s) {
  const dirs = supplierDirs(s.id);
  const last = listDeliveries({ supplierId: s.id, limit: 1 })[0] || null;
  return {
    id: s.id, name: s.name, location: s.location, active: !!s.active, profile: s.profile,
    users: listUsers(s.id).map(u => ({ id: u.id, username: u.username, name: u.name, createdAt: u.created_at })),
    inbox: listSupplierFiles(dirs.inbox).map(f => ({ name: f.name, size: f.size, modified: f.modified })),
    folder: dirs.root, lastDelivery: last,
  };
}

router.get('/', (_req, res) => {
  const portalPort = Number(process.env.PORTAL_PORT ?? 3200);
  res.json({
    suppliers: listSuppliers().map(supplierToApi),
    portal: { port: portalPort || null, path: '/portal/' },
    ftp: FTP_PORT ? { host: FTP_HOST, port: FTP_PORT } : null,
    targets: targetsToApi(),
  });
});

function targetsToApi() {
  const active = getActiveConnector();
  return {
    ...getTargetSetting(),
    options: listConnectors().map(c => ({ id: c.id, name: c.name, kind: connectorKind(c), active: c.id === active?.id })),
    resolved: resolveTargets().map(c => c.id),
  };
}

router.put('/targets', (req, res) => { setTargetSetting(req.body); res.json(targetsToApi()); });

router.post('/', (req, res) => res.status(201).json(supplierToApi(createSupplier(req.body))));

router.put('/:id', (req, res) => res.json(supplierToApi(updateSupplier(req.params.id, req.body))));

router.post('/:id/users', (req, res) => res.status(201).json(createUser(req.params.id, req.body)));

router.put('/users/:userId/password', (req, res) => { setUserPassword(req.params.userId, req.body.password); res.status(204).end(); });

router.delete('/users/:userId', (req, res) => { deleteUser(req.params.userId); res.status(204).end(); });

router.get('/deliveries', (req, res) => res.json(listDeliveries({ supplierId: req.query.supplier || null, limit: 100 })));

router.get('/deliveries/:id/report', (req, res) => {
  const d = getDelivery(req.params.id);
  const dirs = supplierDirs(d.supplier_id);
  const file = ['ack', 'error'].map(k => join(dirs.outbox, `${d.file_name}.${k}.txt`)).find(existsSync);
  if (!file) throw httpError(404, 'There is no report yet.');
  res.type('text/plain; charset=utf-8').send(readFileSync(file, 'utf8'));
});

router.post('/process', async (_req, res) => res.json(await processSupplierInboxes({ force: true })));

router.post('/:id/preview', express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), (req, res) => {
  const s = getSupplier(req.params.id);
  const profile = req.headers['x-profile'] ? cleanProfile(JSON.parse(decodeURIComponent(req.headers['x-profile']))) : s.profile;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const parsed = parseRecords(body, String(req.query.name || 'file'), profile);
    const { mapping, errors: mappingErrors } = resolveMapping(parsed.fields, profile.fields);
    const canonical = mappingErrors.length ? { products: [], errors: [] } : toCanonical(parsed.records, mapping, profile);
    res.json({ format: parsed.format, info: parsed.info, fields: parsed.fields, mapping, records: parsed.records.length,
               products: canonical.products.slice(0, 10), errors: [...mappingErrors, ...parsed.problems, ...canonical.errors] });
  } catch (e) {
    res.json({ errors: [`the file cannot be read: ${e.message}`] });
  }
});

export default router;
