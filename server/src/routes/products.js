import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { getStock } from '../services/inventory.js';
import { getActiveConnector } from '../services/connectors.js';
import { createProductInErp, updateProductInErp } from '../services/erpMasterData.js';
import { syncIfShopEmpty } from '../services/erpSync.js';
import { CATEGORIES } from '../catalog.js';
import { toCents, httpError } from '../util.js';

const router = Router();

const INITIAL_DATA_USERS = ['', 'system', 'anonymous'];

export function productToApi(p) {
  return {
    id: p.id,
    productId: p.product_id,
    name: p.name,
    description: p.description || '',
    price: p.price_cents / 100,
    currency: p.currency,
    stock: getStock(p.id),
    category: p.category || 'Other',
    active: !!p.active,
    erpManaged: !!p.erp_id || !!p.erp_connector,
    erpSource: p.erp_id ? 'api' : p.erp_connector ? 'file' : null,
    erpConnector: p.erp_connector || null,
    erpCreatedBy: !p.erp_id || p.erp_created_by === null ? null
      : INITIAL_DATA_USERS.includes(p.erp_created_by) ? '' : p.erp_created_by,
  };
}

export function visibleProductsFilter() {
  const conn = getActiveConnector();
  return conn ? { sql: 'erp_connector = ?', params: [conn.id] } : { sql: '1 = 1', params: [] };
}

const load = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id);

router.get('/', async (req, res) => {
  await syncIfShopEmpty();
  const includeInactive = req.query.all === 'true' && req.user?.role === 'admin';
  const f = visibleProductsFilter();
  const rows = db.prepare(`SELECT * FROM products WHERE ${f.sql} ${includeInactive ? '' : 'AND active = 1'}
                           ORDER BY category, name`).all(...f.params);
  res.json(rows.map(productToApi));
});

router.get('/categories', (_req, res) => res.json(CATEGORIES));

router.get('/:id', (req, res) => {
  const p = load(req.params.id);
  const conn = getActiveConnector();
  const visible = p && (p.active || req.user?.role === 'admin') && (!conn || p.erp_connector === conn.id);
  if (!visible) throw httpError(404, 'Product not found.');
  res.json(productToApi(p));
});

function validateProduct(body, partial = false) {
  const { productId, name, description, price, stock, category } = body;
  if (!partial || productId !== undefined) {
    if (!productId || !/^[A-Za-z0-9_-]{2,40}$/.test(productId))
      throw httpError(400, 'Product ID is required (letters, digits, - or _).');
  }
  if (!partial || name !== undefined) {
    if (!name || !String(name).trim()) throw httpError(400, 'Name is required.');
  }
  if (!partial || price !== undefined) {
    if (price === undefined || price === '' || isNaN(price) || Number(price) < 0)
      throw httpError(400, 'Price must be a number >= 0.');
  }
  if (stock !== undefined && stock !== '' && (!Number.isInteger(Number(stock)) || Number(stock) < 0 || Number(stock) > 1000))
    throw httpError(400, 'Stock must be a whole number between 0 and 1000.');
  if (category !== undefined && category !== '' && ![...CATEGORIES, 'Other'].includes(category))
    throw httpError(400, `Category must be one of ${CATEGORIES.join(', ')}.`);
  return { productId, name: name?.trim(), description: description?.trim(), price, stock, category: category || undefined };
}

router.post('/', requireAdmin, async (req, res) => {
  const p = validateProduct(req.body);
  const key = p.productId.toUpperCase();
  const conn = getActiveConnector();
  if (conn?.integration === 'file')
    throw httpError(409, `${conn.name} sends its products as files. Create the product in the ERP - it arrives with the next export file.`);
  const existing = db.prepare('SELECT * FROM products WHERE product_id = ?').get(key);
  if (existing && (!conn || existing.erp_connector === conn.id)) {
    throw httpError(409, existing.active
      ? `Product ID ${key} already exists.`
      : `Product ${key} exists but was removed from the shop. Restore it in the product list.`);
  }

  let created;
  if (conn) {
    created = await createProductInErp(p, conn);
  } else {
    const info = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, category)
                             VALUES (?, ?, ?, ?, 'EUR', ?, ?)`)
      .run(key, p.name, p.description ?? null, toCents(p.price), Number(p.stock || 0), p.category || 'Other');
    created = load(info.lastInsertRowid);
  }
  if (p.category) db.prepare('UPDATE products SET category = ? WHERE id = ?').run(p.category, created.id);
  res.status(201).json(productToApi(load(created.id)));
});

router.put('/:id', requireAdmin, async (req, res) => {
  const current = load(req.params.id);
  if (!current) throw httpError(404, 'Product not found.');
  const p = validateProduct(req.body, true);

  const conn = getActiveConnector();
  if (conn && current.erp_connector !== conn.id)
    throw httpError(409, `${current.name} is not in the ERP of the active connector (${conn.name}).`);
  if (conn?.integration === 'file') {
    const changed = [
      p.name !== undefined && p.name !== current.name && 'name',
      p.description !== undefined && (p.description || null) !== (current.description || null) && 'description',
      p.price !== undefined && toCents(p.price) !== current.price_cents && 'price',
      p.stock !== undefined && p.stock !== '' && Number(p.stock) !== current.stock && 'stock',
    ].filter(Boolean);
    if (changed.length)
      throw httpError(409, `${changed.join(', ')} come${changed.length === 1 ? 's' : ''} from the ERP export file and cannot be changed in the shop. Change ${changed.length === 1 ? 'it' : 'them'} in the ERP; the next file brings the new values.`);
  } else if (conn && current.erp_id) {
    await updateProductInErp(current.erp_id, p, conn);
  } else {
    db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, stock = ?, updated_at = datetime('now')
                WHERE id = ?`)
      .run(p.name ?? current.name, p.description ?? current.description,
           p.price !== undefined ? toCents(p.price) : current.price_cents,
           p.stock !== undefined && p.stock !== '' ? Number(p.stock) : current.stock, current.id);
  }
  if (p.category) db.prepare('UPDATE products SET category = ? WHERE id = ?').run(p.category, current.id);
  if (req.body.active !== undefined) db.prepare('UPDATE products SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, current.id);
  res.json(productToApi(load(current.id)));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const info = db.prepare(`UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  if (info.changes === 0) throw httpError(404, 'Product not found.');
  res.status(204).end();
});

export default router;
