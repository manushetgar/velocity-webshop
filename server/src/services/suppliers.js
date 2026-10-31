// =====================================================================================================
// suppliers.js - data access for the supply chain partners (Lab 2 extension): suppliers, their users
// (portal + FTP logins), portal sessions, deliveries and the per-supplier transfer folders.
//
// Role in the architecture:
//  - A supplier delivers product data (new products, prices, stock) as files in its own format. Two channels:
//    the supplier portal (web upload by employees, services/../portal) and FTP (supplier systems, ftpServer.js).
//    Both put the file into the supplier's own inbox folder; supplierImport.js processes it.
//  - Folder per supplier: server/transfer/suppliers/<id>/
//        inbox/      files waiting to be processed (the FTP account writes here)
//        processed/  files that were applied to the ERP
//        error/      rejected files
//        outbox/     acknowledgements for the supplier: <file>.ack.txt or <file>.error.txt (readable via FTP)
//  - The folder identifies the sender, so suppliers may name their files freely.
//  - Target ERPs (Admin > Suppliers, "Write supplier data to"): the active connector of the shop, one chosen connector
//    (e.g. only the local Mini-ERP or only SAP BTP = the cloud) or all connectors (local + cloud at the same time).
// This module only touches the shop database and the file system - no ERP calls.
// =====================================================================================================

// Random tokens for portal sessions.
import { randomBytes } from 'node:crypto';
// Folder helpers.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
// join builds paths from parts (with the right separator for Windows or Linux).
import { join } from 'node:path';
// bcrypt password hashes (same library and cost as the shop's customer passwords).
import bcrypt from 'bcryptjs';
// Shared SQLite connection and the key/value settings table (where supplier data is written).
import { db, getSetting, setSetting } from '../db.js';
// The SAP connectors (= the ERP systems supplier data can be written to).
import { getActiveConnector, listConnectors } from './connectors.js';
// The root of the transfer folders (Lab 2) - the supplier folders are created below it.
import { TRANSFER_DIR } from './fileTransfer.js';
// Allowed formats / updatable fields of a mapping profile.
import { FORMATS, FIELDS, UPDATABLE } from './supplierFormats.js';
// Error with HTTP status.
import { httpError } from '../util.js';

// Lifetime of a portal session in hours.
const SESSION_HOURS = Number(process.env.SESSION_TTL_HOURS || 24);

// ---------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------

/** The folders of one supplier (created if missing). */
export function supplierDirs(id) {
  // Root folder of the supplier (= the FTP root of its accounts).
  const root = join(TRANSFER_DIR, 'suppliers', id);
  // The root and its four sub folders.
  const dirs = { root, inbox: join(root, 'inbox'), processed: join(root, 'processed'), error: join(root, 'error'), outbox: join(root, 'outbox') };
  // mkdirSync(recursive) is a no-op for existing folders.
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // Paths for the callers (FTP root, inbox for uploads, outbox for acknowledgements ...).
  return dirs;
}

/** Regular files of a supplier folder, oldest first (hidden / temporary *.part files are skipped). */
export function listSupplierFiles(dir) {
  // A folder that does not exist (yet) has no files.
  if (!existsSync(dir)) return [];
  // withFileTypes: entries that know whether they are files or folders.
  return readdirSync(dir, { withFileTypes: true })
    // Only regular, visible, complete files.
    .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
    // Size and modification time (mtimeMs for the settle check and the sorting).
    .map(d => { const st = statSync(join(dir, d.name)); return { name: d.name, size: st.size, mtimeMs: st.mtimeMs, modified: st.mtime.toISOString() }; })
    // Oldest first = order of arrival.
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// ---------------------------------------------------------------------------------------------------------
// Suppliers and mapping profiles
// ---------------------------------------------------------------------------------------------------------

// The profile JSON of a row as object (an invalid value counts as empty).
const profileOf = s => { try { return JSON.parse(s.profile || '{}'); } catch { return {}; } };

/** All suppliers (raw rows with parsed profile). */
// ORDER BY name: alphabetical list for the admin UI; the profile JSON is parsed for every row.
export const listSuppliers = () => db.prepare('SELECT * FROM suppliers ORDER BY name').all().map(s => ({ ...s, profile: profileOf(s) }));

/** One supplier (with parsed profile) or a 404 error. */
export function getSupplier(id) {
  // Prepared SELECT with the id bound as parameter.
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  // Unknown id: 404 Not Found.
  if (!s) throw httpError(404, 'Supplier not found.');
  // The row with its profile as object.
  return { ...s, profile: profileOf(s) };
}

/**
 * Validates a mapping profile from the admin UI and returns a clean object:
 * { format, delimiter, decimal, recordPath, defaultCurrency, fields: { canonical: supplierField }, update: [...], createProducts }.
 */
export function cleanProfile(p = {}) {
  // Format: one of FORMATS.
  const format = FORMATS.includes(p.format) ? p.format : 'auto';
  // Separator: empty (= detect), or one character / "\t".
  const delimiter = String(p.delimiter ?? '').slice(0, 2);
  // Anything else as separator is refused with 400 Bad Request.
  if (delimiter && !/^(\\t|[,;|\t])$/.test(delimiter)) throw httpError(400, 'Separator must be , ; | or \\t (or empty = detect).');
  // Decimal sign: auto, "." or ",".
  const decimal = ['auto', '.', ','].includes(p.decimal) ? p.decimal : 'auto';
  // Path of the record list (JSON "data.items") or name of the record element (XML "Article").
  const recordPath = String(p.recordPath ?? '').trim().slice(0, 100);
  // Currency used when the file has none.
  const defaultCurrency = String(p.defaultCurrency || 'EUR').toUpperCase();
  // e.g. EUR, USD - always 3 letters.
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) throw httpError(400, 'Default currency must be a 3-letter code.');
  // Field mapping: only canonical fields, values trimmed; empty = detect automatically.
  const fields = {};
  // Every canonical field: the supplier's field name if one is given (max. 100 characters).
  for (const f of FIELDS) { const v = String(p.fields?.[f] ?? '').trim(); if (v) fields[f] = v.slice(0, 100); }
  // Fields the supplier may change on existing products.
  const update = Array.isArray(p.update) ? UPDATABLE.filter(f => p.update.includes(f)) : [...UPDATABLE];
  // createProducts is true unless it was switched off explicitly.
  return { format, delimiter, decimal, recordPath, defaultCurrency, fields, update, createProducts: p.createProducts !== false };
}

/** Creates a supplier: id derived from the name (like connector ids). */
export function createSupplier(body) {
  // Name: required, without surrounding spaces.
  const name = String(body.name || '').trim();
  // 400 Bad Request without a name.
  if (!name) throw httpError(400, 'Name is required.');
  // "Global Cycle Supply" -> "global-cycle-supply"; unique with -2, -3, ...
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'supplier';
  // Append -2, -3, ... until the id is free (the id is the primary key).
  for (let i = 2; db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
  // Insert the supplier with its cleaned profile as JSON text.
  db.prepare('INSERT INTO suppliers (id, name, location, profile) VALUES (?, ?, ?, ?)')
    // Empty location -> NULL.
    .run(id, name, String(body.location || '').trim() || null, JSON.stringify(cleanProfile(body.profile)));
  // Create the folders right away (the FTP account can then log in immediately).
  supplierDirs(id);
  // Return the stored supplier.
  return getSupplier(id);
}

/** Updates name, location, active flag and/or the mapping profile of a supplier. */
export function updateSupplier(id, body) {
  // The stored supplier (404 if unknown) - fields that are not sent keep their values.
  const s = getSupplier(id);
  // New name, or the old one if none was sent.
  const name = body.name !== undefined ? String(body.name).trim() : s.name;
  // An empty name is not allowed.
  if (!name) throw httpError(400, 'Name is required.');
  // One UPDATE for all editable columns (values bound in the order of the placeholders).
  db.prepare('UPDATE suppliers SET name = ?, location = ?, active = ?, profile = ? WHERE id = ?').run(
    name,
    // Location: sent value (empty -> NULL) or the old one.
    body.location !== undefined ? String(body.location).trim() || null : s.location,
    // Active flag as 0/1 (SQLite has no boolean type).
    body.active !== undefined ? (body.active ? 1 : 0) : s.active,
    // Profile: cleaned new profile or the stored one.
    JSON.stringify(body.profile !== undefined ? cleanProfile(body.profile) : s.profile),
    id);
  // Return the updated supplier.
  return getSupplier(id);
}

// ---------------------------------------------------------------------------------------------------------
// Users (portal + FTP) and portal sessions
// ---------------------------------------------------------------------------------------------------------

/** Users of a supplier (without password hashes). */
// Only these columns - the password hash never leaves this module.
export const listUsers = supplierId =>
  db.prepare('SELECT id, supplier_id, username, name, created_at FROM supplier_users WHERE supplier_id = ? ORDER BY username').all(supplierId);

// Username rule: 3-30 characters, letters, digits, dot, dash, underscore (also used as FTP login).
const USERNAME = /^[A-Za-z0-9._-]{3,30}$/;

/** Creates a user for a supplier. */
export function createUser(supplierId, { username, name, password }) {
  // 404 if the supplier does not exist.
  getSupplier(supplierId);
  // The username is also the FTP login, so only safe characters.
  if (!USERNAME.test(String(username || ''))) throw httpError(400, 'Username: 3-30 letters, digits, . _ or -.');
  // The employee's name is shown in the portal and in the delivery log.
  if (!String(name || '').trim()) throw httpError(400, 'Name is required.');
  // Minimum password length.
  if (String(password || '').length < 8) throw httpError(400, 'Password must have at least 8 characters.');
  // 409 Conflict: usernames are unique across all suppliers (UNIQUE COLLATE NOCASE).
  if (db.prepare('SELECT 1 FROM supplier_users WHERE username = ?').get(username)) throw httpError(409, `Username ${username} is already taken.`);
  // Insert the user with the bcrypt hash of the password (cost 10, like the shop's customer passwords).
  const info = db.prepare('INSERT INTO supplier_users (supplier_id, username, name, password_hash) VALUES (?, ?, ?, ?)')
    .run(supplierId, username, String(name).trim(), bcrypt.hashSync(password, 10));
  // Return the new user without hash.
  return db.prepare('SELECT id, supplier_id, username, name, created_at FROM supplier_users WHERE id = ?').get(info.lastInsertRowid);
}

/** Sets a new password (admin reset); existing portal sessions of the user end. */
export function setUserPassword(userId, password) {
  // Same minimum length as for new users.
  if (String(password || '').length < 8) throw httpError(400, 'Password must have at least 8 characters.');
  // Store the new hash.
  const info = db.prepare('UPDATE supplier_users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId);
  // No row changed = unknown user.
  if (!info.changes) throw httpError(404, 'User not found.');
  // Log out the user everywhere (existing portal sessions are deleted).
  db.prepare('DELETE FROM supplier_sessions WHERE user_id = ?').run(userId);
}

/** Deletes a user (its sessions are deleted by ON DELETE CASCADE). */
export function deleteUser(userId) {
  // DELETE ... changes = 0 means the user did not exist.
  if (!db.prepare('DELETE FROM supplier_users WHERE id = ?').run(userId).changes) throw httpError(404, 'User not found.');
}

/** Checks username + password; returns { user, supplier } of an ACTIVE supplier or null. Used by the portal and FTP. */
export function verifySupplierLogin(username, password) {
  // Look up the user (case-insensitive because of COLLATE NOCASE).
  const u = db.prepare('SELECT * FROM supplier_users WHERE username = ?').get(String(username || ''));
  // Same answer for "unknown user" and "wrong password" (no hint which one was wrong).
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return null;
  // The supplier of the user - an inactive supplier cannot log in.
  const s = getSupplier(u.supplier_id);
  // Deactivated supplier: no access to the portal and no FTP.
  if (!s.active) return null;
  // Logged in: the user (without hash) and the supplier with its profile.
  return { user: { id: u.id, username: u.username, name: u.name }, supplier: s };
}

/** Creates a portal session and returns its token. */
export function createPortalSession(userId) {
  // Expired sessions are cleaned up on every login.
  db.prepare("DELETE FROM supplier_sessions WHERE expires_at < ?").run(new Date().toISOString());
  // 32 random bytes as hex text (64 characters) - not guessable.
  const token = randomBytes(32).toString('hex');
  // Store the session with its expiry time.
  db.prepare('INSERT INTO supplier_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString());
  // The portal sends the token as "Authorization: Bearer <token>".
  return token;
}

/** The user + supplier of a valid portal session token, or null. */
export function portalSession(token) {
  // No token: not logged in.
  if (!token) return null;
  // Session + user in one query; only sessions that have not expired yet.
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.supplier_id FROM supplier_sessions s JOIN supplier_users u ON u.id = s.user_id
                          WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
  // Unknown or expired token.
  if (!row) return null;
  // Load the supplier (also to check that it is still active).
  const supplier = getSupplier(row.supplier_id);
  // Logged in only while the supplier is active.
  return supplier.active ? { user: { id: row.id, username: row.username, name: row.name }, supplier } : null;
}

/** Ends a portal session. */
// Logout: the token becomes invalid immediately.
export const deletePortalSession = token => db.prepare('DELETE FROM supplier_sessions WHERE token = ?').run(token);

// ---------------------------------------------------------------------------------------------------------
// Deliveries (supplier_deliveries)
// ---------------------------------------------------------------------------------------------------------

/** Records a new delivery (a file arrived in a supplier's inbox). Returns its id. */
export function createDelivery({ supplierId, channel, username = null, originalName = null, fileName, status = 'received' }) {
  // Insert the delivery row; id and received_at are set by SQLite.
  // lastInsertRowid = the id of the new delivery.
  return db.prepare(`INSERT INTO supplier_deliveries (supplier_id, channel, username, original_name, file_name, status)
                     VALUES (?, ?, ?, ?, ?, ?)`).run(supplierId, channel, username, originalName, fileName, status).lastInsertRowid;
}

/** The open delivery of a file in the inbox (received or waiting), if one was recorded when it arrived. */
export const openDelivery = (supplierId, fileName) =>
  // Only deliveries whose file has not been processed finally (received or waiting).
  db.prepare(`SELECT * FROM supplier_deliveries WHERE supplier_id = ? AND file_name = ? AND status IN ('received', 'waiting')
              ORDER BY id DESC LIMIT 1`).get(supplierId, fileName);

/** Updates a delivery (status, counters, errors...). JSON fields are serialized here. */
export function updateDelivery(id, { status, format, rows, summary, errors, warnings, checksum, processed = true }) {
  // COALESCE(?, column) keeps the stored value when NULL is passed (e.g. no format known yet).
  // processed_at is set only when the processing is final (not while waiting).
  db.prepare(`UPDATE supplier_deliveries SET status = ?, format = COALESCE(?, format), rows = COALESCE(?, rows), summary = ?, errors = ?,
              warnings = ?, checksum = COALESCE(?, checksum), processed_at = CASE WHEN ? THEN datetime('now') ELSE processed_at END
              WHERE id = ?`)
    // Objects/arrays are stored as JSON text; empty lists as NULL.
    .run(status, format ?? null, rows ?? null, summary ? JSON.stringify(summary) : null, errors?.length ? JSON.stringify(errors) : null,
         warnings?.length ? JSON.stringify(warnings) : null, checksum ?? null, processed ? 1 : 0, id);
}

/** A delivery row in the format of the UIs. */
export const deliveryToApi = d => d && ({
  // Column names of the database -> camelCase for the UIs.
  id: d.id, receivedAt: d.received_at, processedAt: d.processed_at, supplierId: d.supplier_id, channel: d.channel,
  username: d.username, originalName: d.original_name || d.file_name, file: d.file_name, format: d.format, status: d.status,
  // JSON text -> objects again.
  rows: d.rows, summary: d.summary ? JSON.parse(d.summary) : null, errors: d.errors ? JSON.parse(d.errors) : [],
  warnings: d.warnings ? JSON.parse(d.warnings) : [],
});

/** Newest deliveries, of one supplier or of all. */
export function listDeliveries({ supplierId = null, limit = 50 } = {}) {
  // One supplier (portal, filter in the admin UI) or all suppliers (admin), newest first.
  const rows = supplierId
    ? db.prepare('SELECT * FROM supplier_deliveries WHERE supplier_id = ? ORDER BY id DESC LIMIT ?').all(supplierId, limit)
    : db.prepare('SELECT * FROM supplier_deliveries ORDER BY id DESC LIMIT ?').all(limit);
  // In the format of the UIs.
  return rows.map(deliveryToApi);
}

/** One delivery (raw row) or 404. */
export function getDelivery(id) {
  // The raw row (callers need file_name and supplier_id).
  const d = db.prepare('SELECT * FROM supplier_deliveries WHERE id = ?').get(id);
  // 404 for unknown ids.
  if (!d) throw httpError(404, 'Delivery not found.');
  // The delivery row.
  return d;
}

/** Changes only the summary of a delivery (e.g. how the shop received a change - known later, in the background). */
export function updateDeliverySummary(id, change) {
  // The current summary of the delivery (a row that was deleted meanwhile is ignored).
  const row = db.prepare('SELECT summary FROM supplier_deliveries WHERE id = ?').get(id);
  // Unknown delivery: nothing to change.
  if (!row) return;
  // JSON text -> object (no summary yet = empty object).
  const summary = row.summary ? JSON.parse(row.summary) : {};
  // The caller changes the object (e.g. sets the shop note of one target).
  change(summary);
  // Only the summary column is written: status, counters and errors stay as they are.
  db.prepare('UPDATE supplier_deliveries SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id);
}

// ---------------------------------------------------------------------------------------------------------
// Target ERPs: where supplier data is written (Admin > Suppliers, "Write supplier data to")
// ---------------------------------------------------------------------------------------------------------

// The three modes of the setting:
//   active - the shop's active SAP connector (default; what the shop itself shows)
//   list   - the chosen connectors only, e.g. ['local'] = only the local Mini-ERP, ['btp'] = only SAP BTP (cloud)
//   all    - every connector, e.g. local + cloud at the same time
export const TARGET_MODES = ['active', 'list', 'all'];

// Key of the setting in the settings table (value = JSON { mode, ids }).
const TARGET_KEY = 'supplier_targets';

// "local" for an ERP on this computer (localhost / 127.0.0.1), otherwise "cloud" (e.g. SAP BTP).
export const connectorKind = c => (/localhost|127\.0\.0\.1/.test(c.url) ? 'local' : 'cloud');

/** The stored setting { mode, ids } (default: the active connector). */
export function getTargetSetting() {
  // The stored JSON text (null = never set).
  const raw = getSetting(TARGET_KEY);
  try {
    // JSON text -> object.
    const v = raw ? JSON.parse(raw) : null;
    // Only a known mode is used; ids must be a list of text.
    if (v && TARGET_MODES.includes(v.mode)) return { mode: v.mode, ids: Array.isArray(v.ids) ? v.ids.map(String) : [] };
  } catch { /* broken value: the default below */ }
  // Default: write to the shop's active connector.
  return { mode: 'active', ids: [] };
}

/** Stores the setting. mode 'list' needs at least one existing connector id (400 otherwise). */
export function setTargetSetting({ mode, ids } = {}) {
  // Unknown mode: 400 Bad Request.
  if (!TARGET_MODES.includes(mode)) throw httpError(400, `mode must be one of: ${TARGET_MODES.join(', ')}`);
  // Ids of all existing connectors.
  const known = new Set(listConnectors().map(c => c.id));
  // Only existing connectors, each once (only used in mode 'list').
  const chosen = mode === 'list' ? [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(id => known.has(id)) : [];
  // 'list' without a valid connector would write nowhere.
  if (mode === 'list' && !chosen.length) throw httpError(400, 'Choose at least one existing SAP connector.');
  // Store as JSON text.
  setSetting(TARGET_KEY, JSON.stringify({ mode, ids: chosen }));
  // The stored setting.
  return getTargetSetting();
}

/** The connectors supplier data is written to right now (rows of erp_connectors; may be empty). */
export function resolveTargets() {
  // The stored setting.
  const { mode, ids } = getTargetSetting();
  // Every connector.
  if (mode === 'all') return listConnectors();
  // The chosen connectors (a connector deleted meanwhile is skipped).
  if (mode === 'list') return listConnectors().filter(c => ids.includes(c.id));
  // The shop's active connector, or none (standalone shop).
  const active = getActiveConnector();
  // As a list (empty = no target: the files wait).
  return active ? [active] : [];
}
