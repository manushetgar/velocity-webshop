import { db } from '../db.js';
import { clientFor, requireActiveConnector, ErpError } from './erpClient.js';
import { getActiveConnector } from './connectors.js';
import { toCents } from '../util.js';
import { categoryFor } from '../catalog.js';

const lastSyncs = new Map();

export const getLastSync = connectorId => lastSyncs.get(connectorId) || null;
export const recordSyncError = (connectorId, error) =>
  lastSyncs.set(connectorId, { at: new Date().toISOString(), ok: false, error: error.message });
export const recordSyncResult = (connectorId, result) =>
  lastSyncs.set(connectorId, { at: new Date().toISOString(), ok: true, result });

export async function syncProductsFromErp(conn = requireActiveConnector(), items = null) {
  try {
    items ??= await clientFor(conn).products();
    if (!Array.isArray(items)) throw new Error('Unexpected ERP response (expected a product list).');
    const createdBy = new Map();
    try {
      for (const o of await clientFor(conn).productOrigins()) createdBy.set(o.ID, o.createdBy || '');
    } catch {}

    const find = db.prepare('SELECT * FROM products WHERE product_id = ?');
    const insert = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, erp_id,
                               erp_connector, erp_created_by, category, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const update = db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, currency = ?, stock = ?,
                               erp_id = ?, erp_connector = ?, erp_created_by = ?, updated_at = datetime('now') WHERE id = ?`);
    const unlink = db.prepare('UPDATE products SET erp_id = NULL, erp_connector = NULL WHERE id = ?');

    const result = { received: items.length, created: 0, updated: 0, unchanged: 0, skipped: 0, unlinked: 0 };
    db.transaction(() => {
      if (getActiveConnector()?.id !== conn.id) throw new ErpError(`${conn.name} is no longer the active connector.`, 409);
      if (getActiveConnector().integration === 'file') throw new ErpError(`${conn.name} uses file transfer - products come from files.`, 409);
      const seen = new Set();
      for (const p of items) {
        const key = String(p.productID || '').trim().toUpperCase();
        if (!key || !p.name || isNaN(Number(p.price))) { result.skipped++; continue; }
        seen.add(key);
        const row = [p.name, p.description ?? null, toCents(p.price), p.currency || p.currency_code || 'EUR',
                     Math.max(0, Number(p.stock) || 0), p.ID ?? null, conn.id,
                     createdBy.has(p.ID) ? createdBy.get(p.ID) : null];
        const existing = find.get(key);
        if (!existing) { insert.run(key, ...row, categoryFor(key)); result.created++; continue; }
        const same = existing.name === row[0] && (existing.description ?? null) === row[1] && existing.price_cents === row[2]
          && existing.currency === row[3] && existing.stock === row[4] && (existing.erp_id ?? null) === row[5]
          && existing.erp_connector === conn.id && (existing.erp_created_by ?? null) === row[7];
        if (same) result.unchanged++;
        else { update.run(...row, existing.id); result.updated++; }
      }
      for (const p of db.prepare('SELECT id, product_id FROM products WHERE erp_connector = ?').all(conn.id)) {
        if (!seen.has(p.product_id)) { unlink.run(p.id); result.unlinked++; }
      }
    })();

    lastSyncs.set(conn.id, { at: new Date().toISOString(), ok: true, result });
    return result;
  } catch (e) {
    recordSyncError(conn.id, e);
    throw e;
  }
}

export async function syncOrderStatusesFromErp(conn = requireActiveConnector()) {
  const erpOrders = await clientFor(conn).orderStatuses();
  const byId = new Map(erpOrders.map(o => [o.ID, o.orderStatus_code]));
  const local = db.prepare('SELECT id, status, erp_order_id FROM orders WHERE erp_order_id IS NOT NULL AND erp_connector = ?')
    .all(conn.id);
  const upd = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
  let updated = 0;
  db.transaction(() => {
    for (const o of local) {
      const s = byId.get(o.erp_order_id);
      if (s && s !== o.status) { upd.run(s, o.id); updated++; }
    }
  })();
  return { checked: local.length, updated };
}
