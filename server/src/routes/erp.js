import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { clientFor, clearToken, testConnector, requireActiveConnector } from '../services/erpClient.js';
import {
  getActiveConnector, listConnectors, getConnector, connectorToApi, connectorFromBody,
  createConnector, updateConnector, deleteConnector,
} from '../services/connectors.js';
import { syncProductsFromErp, getLastSync } from '../services/productSync.js';
import { erpOrdersEnabled } from '../services/erpOrders.js';
import { loadCatalogIntoErp } from '../services/erpMasterData.js';
import { syncNow, activateConnector, linkedProducts } from '../services/erpSync.js';
import { isFileMode, runFileCycle } from '../services/fileTransfer.js';
import { httpError } from '../util.js';

const router = Router();

router.get('/status', (_req, res) => {
  const c = getActiveConnector();
  res.json({
    configured: !!c,
    connector: c ? { id: c.id, name: c.name, url: c.url, auth: c.auth, integration: c.integration } : null,
    integration: c?.integration ?? null,
    url: c?.url ?? null,
    auth: c?.auth ?? null,
    ordersToErp: erpOrdersEnabled(),
    lastSync: c ? getLastSync(c.id) : null,
    products: c ? linkedProducts(c.id) : null,
  });
});

router.get('/ping', requireAdmin, async (_req, res) => {
  const t0 = Date.now();
  const products = await clientFor(requireActiveConnector()).products();
  res.json({ reachable: true, ms: Date.now() - t0, erpProducts: products.length });
});

router.post('/sync-products', requireAdmin, async (_req, res) => {
  if (isFileMode(requireActiveConnector())) throw httpError(409, 'The active connector uses file transfer - use Sync now or Admin > File transfer.');
  res.json(await syncProductsFromErp());
});

router.post('/sync', requireAdmin, async (_req, res) => {
  requireActiveConnector();
  res.json(await syncNow());
});

router.post('/load-catalog', requireAdmin, async (_req, res) => {
  const conn = requireActiveConnector();
  if (isFileMode(conn)) {
    const catalog = await loadCatalogIntoErp(conn, { syncShop: false });
    return res.json({ ...catalog, products: (await runFileCycle(conn, { forceExport: true })).products });
  }
  res.json(await loadCatalogIntoErp(conn));
});

const orderCount = id => db.prepare('SELECT COUNT(*) AS n FROM orders WHERE erp_connector = ?').get(id).n;
const withInfo = c => connectorToApi(c, { lastSync: getLastSync(c.id), products: linkedProducts(c.id), orders: orderCount(c.id) });

router.get('/connectors', requireAdmin, (_req, res) => {
  res.json(listConnectors().map(withInfo));
});

router.post('/connectors', requireAdmin, (req, res) => {
  res.status(201).json(withInfo(createConnector(req.body)));
});

router.post('/connectors/test', requireAdmin, async (req, res) => {
  res.json(await testConnector(connectorFromBody(req.body)));
});

router.put('/connectors/:id', requireAdmin, async (req, res) => {
  const c = updateConnector(req.params.id, req.body);
  clearToken(c.id);
  if (getActiveConnector()?.id === c.id) await syncNow(c).catch(() => {});
  res.json(withInfo(c));
});

router.delete('/connectors/:id', requireAdmin, (req, res) => {
  deleteConnector(req.params.id);
  res.status(204).end();
});

router.post('/connectors/:id/test', requireAdmin, async (req, res) => {
  res.json(await testConnector(getConnector(req.params.id)));
});

router.post('/connectors/:id/activate', requireAdmin, async (req, res) => {
  res.json(await activateConnector(req.params.id));
});

router.post('/disconnect', requireAdmin, async (_req, res) => {
  res.json(await activateConnector(null));
});

export default router;
