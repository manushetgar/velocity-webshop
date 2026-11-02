import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import {
  verifySupplierLogin, createPortalSession, portalSession, deletePortalSession, supplierDirs, createDelivery,
  listDeliveries, getDelivery, deliveryToApi, listUsers,
} from '../services/suppliers.js';
import { processSupplierInboxes } from '../services/supplierImport.js';
import { FTP_HOST, FTP_PORT } from '../services/ftpServer.js';
import { MAX_FILE_BYTES } from '../services/productFile.js';
import { httpError } from '../util.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function formatInfo(profile) {
  const f = profile.fields || {};
  return {
    format: profile.format || 'auto',
    delimiter: profile.delimiter || null,
    decimal: profile.decimal || 'auto',
    recordPath: profile.recordPath || null,
    fields: Object.keys(f).length ? f : null,
    update: profile.update || [],
    createProducts: profile.createProducts !== false,
  };
}

export function createPortalApp() {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
    req.portal = m ? portalSession(m[1]) : null;
    next();
  });
  const requireLogin = (req, _res, next) => next(req.portal ? undefined : httpError(401, 'Please log in.'));

  app.get('/api/demo-accounts', (_req, res) => {
    if (process.env.DEMO_MODE === 'false') return res.json([]);
    const password = process.env.SUPPLIER_DEMO_PASSWORD || 'supplier123';
    const rows = ['bikeparts', 'globalcycle', 'nordicgear', 'celticparts'].flatMap(id => {
      try { return listUsers(id).filter(u => u.username === id).map(u => ({ username: u.username, name: u.name, supplier: id })); } catch { return []; }
    });
    res.json(rows.map(r => ({ ...r, password })));
  });

  app.post('/api/login', (req, res) => {
    const login = verifySupplierLogin(req.body?.username, req.body?.password);
    if (!login) throw httpError(401, 'Wrong username or password.');
    res.json({ token: createPortalSession(login.user.id), user: login.user, supplier: { id: login.supplier.id, name: login.supplier.name } });
  });

  app.post('/api/logout', requireLogin, (req, res) => {
    deletePortalSession(/^Bearer (\w+)$/.exec(req.headers.authorization)[1]);
    res.status(204).end();
  });

  app.get('/api/me', requireLogin, (req, res) => {
    const { user, supplier } = req.portal;
    res.json({
      user, supplier: { id: supplier.id, name: supplier.name, location: supplier.location },
      format: formatInfo(supplier.profile),
      ftp: FTP_PORT ? { host: FTP_HOST, port: FTP_PORT, username: user.username, folder: '/inbox', acks: '/outbox' } : null,
      sample: !!sampleFile(supplier.id),
    });
  });

  app.post('/api/upload', requireLogin, express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), async (req, res) => {
    const { user, supplier } = req.portal;
    const original = String(req.query.name || 'upload').slice(0, 150);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) throw httpError(400, 'The file is empty.');
    const safe = original.replace(/^.*[\\/]/, '').replace(/[^\p{L}\p{N}._\- ()]/gu, '_').replace(/^\.+/, '') || 'upload';
    const fileName = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}_${safe}`;
    const dirs = supplierDirs(supplier.id);
    const tmp = join(dirs.inbox, `.${fileName}.part`);
    writeFileSync(tmp, body);
    renameSync(tmp, join(dirs.inbox, fileName));
    const id = createDelivery({ supplierId: supplier.id, channel: 'portal', username: user.username, originalName: safe, fileName });
    await Promise.race([processSupplierInboxes({ supplierId: supplier.id, force: true }).catch(() => {}), new Promise(r => setTimeout(r, 20000))]);
    res.status(201).json(deliveryToApi(getDelivery(id)));
  });

  app.get('/api/deliveries', requireLogin, (req, res) => {
    res.json(listDeliveries({ supplierId: req.portal.supplier.id, limit: 50 }));
  });

  app.get('/api/deliveries/:id/report', requireLogin, (req, res) => {
    const d = getDelivery(req.params.id);
    if (d.supplier_id !== req.portal.supplier.id) throw httpError(404, 'Delivery not found.');
    const dirs = supplierDirs(d.supplier_id);
    const file = ['ack', 'error'].map(k => join(dirs.outbox, `${d.file_name}.${k}.txt`)).find(existsSync);
    if (!file) throw httpError(404, 'There is no report yet.');
    res.type('text/plain; charset=utf-8').send(readFileSync(file, 'utf8'));
  });

  app.get('/api/sample', requireLogin, (req, res) => {
    const file = sampleFile(req.portal.supplier.id);
    if (!file) throw httpError(404, 'No sample file for this supplier.');
    res.download(file);
  });

  app.use('/api', () => { throw httpError(404, 'Not found.'); });
  app.use(express.static(join(HERE, 'public')));

  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal server error.' : err.message });
  });
  return app;
}

function sampleFile(id) {
  const dir = join(HERE, 'samples');
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find(f => f.slice(0, -extname(f).length) === id);
  return name ? join(dir, name) : null;
}
