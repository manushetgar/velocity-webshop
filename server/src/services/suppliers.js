import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { db, getSetting, setSetting } from '../db.js';
import { getActiveConnector, listConnectors } from './connectors.js';
import { TRANSFER_DIR } from './fileTransfer.js';
import { FORMATS, FIELDS, UPDATABLE } from './supplierFormats.js';
import { httpError } from '../util.js';

const SESSION_HOURS = Number(process.env.SESSION_TTL_HOURS || 24);

export function supplierDirs(id) {
  const root = join(TRANSFER_DIR, 'suppliers', id);
  const dirs = { root, inbox: join(root, 'inbox'), processed: join(root, 'processed'), error: join(root, 'error'), outbox: join(root, 'outbox') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

export function listSupplierFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
    .map(d => { const st = statSync(join(dir, d.name)); return { name: d.name, size: st.size, mtimeMs: st.mtimeMs, modified: st.mtime.toISOString() }; })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

const profileOf = s => { try { return JSON.parse(s.profile || '{}'); } catch { return {}; } };

export const listSuppliers = () => db.prepare('SELECT * FROM suppliers ORDER BY name').all().map(s => ({ ...s, profile: profileOf(s) }));

export function getSupplier(id) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!s) throw httpError(404, 'Supplier not found.');
  return { ...s, profile: profileOf(s) };
}

export function cleanProfile(p = {}) {
  const format = FORMATS.includes(p.format) ? p.format : 'auto';
  const delimiter = String(p.delimiter ?? '').slice(0, 2);
  if (delimiter && !/^(\\t|[,;|\t])$/.test(delimiter)) throw httpError(400, 'Separator must be , ; | or \\t (or empty = detect).');
  const decimal = ['auto', '.', ','].includes(p.decimal) ? p.decimal : 'auto';
  const recordPath = String(p.recordPath ?? '').trim().slice(0, 100);
  const defaultCurrency = String(p.defaultCurrency || 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) throw httpError(400, 'Default currency must be a 3-letter code.');
  const fields = {};
  for (const f of FIELDS) { const v = String(p.fields?.[f] ?? '').trim(); if (v) fields[f] = v.slice(0, 100); }
  const update = Array.isArray(p.update) ? UPDATABLE.filter(f => p.update.includes(f)) : [...UPDATABLE];
  return { format, delimiter, decimal, recordPath, defaultCurrency, fields, update, createProducts: p.createProducts !== false };
}

export function createSupplier(body) {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'Name is required.');
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'supplier';
  for (let i = 2; db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
  db.prepare('INSERT INTO suppliers (id, name, location, profile) VALUES (?, ?, ?, ?)')
    .run(id, name, String(body.location || '').trim() || null, JSON.stringify(cleanProfile(body.profile)));
  supplierDirs(id);
  return getSupplier(id);
}

export function updateSupplier(id, body) {
  const s = getSupplier(id);
  const name = body.name !== undefined ? String(body.name).trim() : s.name;
  if (!name) throw httpError(400, 'Name is required.');
  db.prepare('UPDATE suppliers SET name = ?, location = ?, active = ?, profile = ? WHERE id = ?').run(
    name,
    body.location !== undefined ? String(body.location).trim() || null : s.location,
    body.active !== undefined ? (body.active ? 1 : 0) : s.active,
    JSON.stringify(body.profile !== undefined ? cleanProfile(body.profile) : s.profile),
    id);
  return getSupplier(id);
}

export const listUsers = supplierId =>
  db.prepare('SELECT id, supplier_id, username, name, created_at FROM supplier_users WHERE supplier_id = ? ORDER BY username').all(supplierId);

const USERNAME = /^[A-Za-z0-9._-]{3,30}$/;

export function createUser(supplierId, { username, name, password }) {
  getSupplier(supplierId);
  if (!USERNAME.test(String(username || ''))) throw httpError(400, 'Username: 3-30 letters, digits, . _ or -.');
  if (!String(name || '').trim()) throw httpError(400, 'Name is required.');
  if (String(password || '').length < 8) throw httpError(400, 'Password must have at least 8 characters.');
  if (db.prepare('SELECT 1 FROM supplier_users WHERE username = ?').get(username)) throw httpError(409, `Username ${username} is already taken.`);
  const info = db.prepare('INSERT INTO supplier_users (supplier_id, username, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(supplierId, username, String(name).trim(), bcrypt.hashSync(password, 10));
  return db.prepare('SELECT id, supplier_id, username, name, created_at FROM supplier_users WHERE id = ?').get(info.lastInsertRowid);
}

export function setUserPassword(userId, password) {
  if (String(password || '').length < 8) throw httpError(400, 'Password must have at least 8 characters.');
  const info = db.prepare('UPDATE supplier_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId);
  if (!info.changes) throw httpError(404, 'User not found.');
  db.prepare('DELETE FROM supplier_sessions WHERE user_id = ?').run(userId);
}

export function deleteUser(userId) {
  if (!db.prepare('DELETE FROM supplier_users WHERE id = ?').run(userId).changes) throw httpError(404, 'User not found.');
}

export function verifySupplierLogin(username, password) {
  const u = db.prepare('SELECT * FROM supplier_users WHERE username = ?').get(String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return null;
  const s = getSupplier(u.supplier_id);
  if (!s.active) return null;
  return { user: { id: u.id, username: u.username, name: u.name }, supplier: s };
}

export function createPortalSession(userId) {
  db.prepare("DELETE FROM supplier_sessions WHERE expires_at < ?").run(new Date().toISOString());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO supplier_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString());
  return token;
}

export function portalSession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.supplier_id FROM supplier_sessions s JOIN supplier_users u ON u.id = s.user_id
                          WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
  if (!row) return null;
  const supplier = getSupplier(row.supplier_id);
  return supplier.active ? { user: { id: row.id, username: row.username, name: row.name }, supplier } : null;
}

export const deletePortalSession = token => db.prepare('DELETE FROM supplier_sessions WHERE token = ?').run(token);

export function createDelivery({ supplierId, channel, username = null, originalName = null, fileName, status = 'received' }) {
  return db.prepare(`INSERT INTO supplier_deliveries (supplier_id, channel, username, original_name, file_name, status)
                     VALUES (?, ?, ?, ?, ?, ?)`).run(supplierId, channel, username, originalName, fileName, status).lastInsertRowid;
}

export const openDelivery = (supplierId, fileName) =>
  db.prepare(`SELECT * FROM supplier_deliveries WHERE supplier_id = ? AND file_name = ? AND status IN ('received', 'waiting')
              ORDER BY id DESC LIMIT 1`).get(supplierId, fileName);

export function updateDelivery(id, { status, format, rows, summary, errors, warnings, checksum, processed = true }) {
  db.prepare(`UPDATE supplier_deliveries SET status = ?, format = COALESCE(?, format), rows = COALESCE(?, rows), summary = ?, errors = ?,
              warnings = ?, checksum = COALESCE(?, checksum), processed_at = CASE WHEN ? THEN datetime('now') ELSE processed_at END
              WHERE id = ?`)
    .run(status, format ?? null, rows ?? null, summary ? JSON.stringify(summary) : null, errors?.length ? JSON.stringify(errors) : null,
         warnings?.length ? JSON.stringify(warnings) : null, checksum ?? null, processed ? 1 : 0, id);
}

export const deliveryToApi = d => d && ({
  id: d.id, receivedAt: d.received_at, processedAt: d.processed_at, supplierId: d.supplier_id, channel: d.channel,
  username: d.username, originalName: d.original_name || d.file_name, file: d.file_name, format: d.format, status: d.status,
  rows: d.rows, summary: d.summary ? JSON.parse(d.summary) : null, errors: d.errors ? JSON.parse(d.errors) : [],
  warnings: d.warnings ? JSON.parse(d.warnings) : [],
});

export function listDeliveries({ supplierId = null, limit = 50 } = {}) {
  const rows = supplierId
    ? db.prepare('SELECT * FROM supplier_deliveries WHERE supplier_id = ? ORDER BY id DESC LIMIT ?').all(supplierId, limit)
    : db.prepare('SELECT * FROM supplier_deliveries ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(deliveryToApi);
}

export function getDelivery(id) {
  const d = db.prepare('SELECT * FROM supplier_deliveries WHERE id = ?').get(id);
  if (!d) throw httpError(404, 'Delivery not found.');
  return d;
}

export function updateDeliverySummary(id, change) {
  const row = db.prepare('SELECT summary FROM supplier_deliveries WHERE id = ?').get(id);
  if (!row) return;
  const summary = row.summary ? JSON.parse(row.summary) : {};
  change(summary);
  db.prepare('UPDATE supplier_deliveries SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id);
}

export const TARGET_MODES = ['active', 'list', 'all'];

const TARGET_KEY = 'supplier_targets';

export const connectorKind = c => (/localhost|127\.0\.0\.1/.test(c.url) ? 'local' : 'cloud');

export function getTargetSetting() {
  const raw = getSetting(TARGET_KEY);
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && TARGET_MODES.includes(v.mode)) return { mode: v.mode, ids: Array.isArray(v.ids) ? v.ids.map(String) : [] };
  } catch {}
  return { mode: 'active', ids: [] };
}

export function setTargetSetting({ mode, ids } = {}) {
  if (!TARGET_MODES.includes(mode)) throw httpError(400, `mode must be one of: ${TARGET_MODES.join(', ')}`);
  const known = new Set(listConnectors().map(c => c.id));
  const chosen = mode === 'list' ? [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(id => known.has(id)) : [];
  if (mode === 'list' && !chosen.length) throw httpError(400, 'Choose at least one existing SAP connector.');
  setSetting(TARGET_KEY, JSON.stringify({ mode, ids: chosen }));
  return getTargetSetting();
}

export function resolveTargets() {
  const { mode, ids } = getTargetSetting();
  if (mode === 'all') return listConnectors();
  if (mode === 'list') return listConnectors().filter(c => ids.includes(c.id));
  const active = getActiveConnector();
  return active ? [active] : [];
}
