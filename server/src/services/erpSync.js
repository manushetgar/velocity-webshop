import { db } from '../db.js';
import { getActiveConnector, getConnector, setActiveConnector } from './connectors.js';
import { clearToken } from './erpClient.js';
import { syncProductsFromErp, syncOrderStatusesFromErp, getLastSync, recordSyncError } from './productSync.js';
import { loadCatalogIntoErp } from './erpMasterData.js';
import { erpOrdersEnabled } from './erpOrders.js';
import { runFileCycle, importInbox, isFileMode } from './fileTransfer.js';

const running = new Map();

async function runSync(conn, { forceExport = true } = {}) {
  if (isFileMode(conn)) return runFileCycle(conn, { forceExport });
  const result = {};
  try {
    if (conn.auto_catalog) {
      const catalog = await loadCatalogIntoErp(conn);
      result.products = catalog.products;
      result.catalog = { created: catalog.created, completed: catalog.completed };
    } else {
      result.products = await syncProductsFromErp(conn);
    }
    result.orders = erpOrdersEnabled() ? await syncOrderStatusesFromErp(conn) : { checked: 0, updated: 0 };
  } catch (e) {
    recordSyncError(conn.id, e);
    throw e;
  }
  return result;
}

export function syncNow(conn = getActiveConnector(), options = {}) {
  if (!conn) return Promise.resolve(null);
  if (!running.has(conn.id)) {
    running.set(conn.id, runSync(conn, options).finally(() => running.delete(conn.id)));
  }
  return running.get(conn.id);
}

export async function syncAfterErpChange(conn = getActiveConnector()) {
  if (!conn) return null;
  if (running.has(conn.id)) await running.get(conn.id).catch(() => {});
  return syncNow(conn, { forceExport: true });
}

export const linkedProducts = connectorId =>
  db.prepare('SELECT COUNT(*) AS n FROM products WHERE erp_connector = ? AND active = 1').get(connectorId).n;

export async function syncIfShopEmpty() {
  const conn = getActiveConnector();
  if (!conn || linkedProducts(conn.id) > 0) return;
  const last = getLastSync(conn.id);
  if (last && Date.now() - Date.parse(last.at) < 5000) return;
  if (isFileMode(conn)) { await importInbox(conn).catch(() => {}); return; }
  await Promise.race([syncNow(conn).catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
}

export async function activateConnector(id) {
  const conn = id ? getConnector(id) : null;
  setActiveConnector(conn?.id || null);
  if (!conn) return { active: null, sync: null };
  clearToken(conn.id);
  console.log(`[erp] active SAP connector: ${conn.name} (${conn.url})`);
  try {
    return { active: conn.id, sync: { ok: true, ...(await syncNow(conn)) } };
  } catch (e) {
    return { active: conn.id, sync: { ok: false, error: e.message } };
  }
}

const lastExportError = new Map();

function logFileCycle(conn, r) {
  if (r.export?.written) console.log(`[file] ${conn.name}: export ${r.export.file} (${r.export.rows} products)`);
  if (r.export && !r.export.ok && lastExportError.get(conn.id) !== r.export.error)
    console.warn(`[file] ${conn.name}: export failed - ${r.export.error} (the shop keeps the last imported data)`);
  lastExportError.set(conn.id, r.export?.ok ? null : r.export?.error);
  for (const i of r.imports) {
    console.log(`[file] ${i.file}: ${i.status}` + (i.status === 'rejected' ? ` - ${i.errors[0]}`
      : ` (${i.rows} products: ${i.created} new, ${i.updated} updated, ${i.unlinked} removed)`));
  }
}

export function startBackgroundSync() {
  const seconds = Number(process.env.ERP_SYNC_INTERVAL_S ?? 60);
  let lastState = null;
  const tick = async () => {
    const conn = getActiveConnector();
    if (!conn) { lastState = null; return; }
    try {
      const r = await syncNow(conn, { forceExport: false });
      if (r.mode === 'file') { logFileCycle(conn, r); lastState = `ok:${conn.id}`; return; }
      const changed = r.products.created + r.products.updated + r.products.unlinked + r.orders.updated;
      if (lastState !== `ok:${conn.id}` || changed)
        console.log(`[erp] ${conn.name}: ${r.products.received} products in the ERP` +
          (r.catalog?.created ? `, ${r.catalog.created} demo products created` : '') +
          (changed ? `, ${r.products.created} new / ${r.products.updated} updated, ${r.orders.updated} order status changes` : ''));
      lastState = `ok:${conn.id}`;
    } catch (e) {
      if (lastState !== `fail:${conn.id}:${e.message}`) console.warn(`[erp] ${conn.name} not available: ${e.message}`);
      lastState = `fail:${conn.id}:${e.message}`;
    }
  };
  if (process.env.ERP_SYNC_ON_START !== 'false') tick();
  if (seconds > 0) setInterval(tick, seconds * 1000).unref();
}
