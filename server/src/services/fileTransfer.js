import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { db, getSetting, setSetting } from '../db.js';
import { clientFor, ErpError } from './erpClient.js';
import { getActiveConnector } from './connectors.js';
import { parseProductFile, MAX_FILE_BYTES } from './productFile.js';
import { recordSyncResult } from './productSync.js';
import { loadCatalogIntoErp } from './erpMasterData.js';
import { toCents, httpError } from '../util.js';
import { categoryFor } from '../catalog.js';

export const TRANSFER_DIR = resolve(process.env.FILE_TRANSFER_DIR || './transfer');
const DIRS = {
  inbox: join(TRANSFER_DIR, 'inbox'),
  processed: join(TRANSFER_DIR, 'processed'),
  error: join(TRANSFER_DIR, 'error'),
};
export const POLL_INTERVAL_S = Number(process.env.FILE_POLL_INTERVAL_S ?? 10);
export const EXPORT_INTERVAL_S = Number(process.env.ERP_SYNC_INTERVAL_S ?? 60);
const SETTLE_MS = Number(process.env.FILE_SETTLE_MS ?? 2000);
const KEEP_FILES = Number(process.env.FILE_KEEP ?? 200);
export const NAMING = 'products_<source>_<YYYYMMDDTHHMMSSZ>.<csv|xlsx>';
const NAME_PATTERN = /^products_([a-z0-9-]+)_(\d{8}T\d{6}Z)(?:-(\d+))?\.(csv|xlsx)$/i;

function ensureDirs() {
  for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true });
}

const stampOf = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const stamp = () => stampOf(Date.now());

function parseName(name) {
  const m = NAME_PATTERN.exec(name);
  if (!m) return null;
  return { source: m[1].toLowerCase(), stamp: m[2], seq: Number(m[3] || 1), ext: m[4].toLowerCase(),
           order: `${m[2]}-${String(m[3] || 1).padStart(4, '0')}` };
}

function newFileName(source, ext) {
  const base = `products_${source}_${stamp()}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
    if (!Object.values(DIRS).some(dir => existsSync(join(dir, name)))) return name;
  }
}

function writeAtomically(dir, name, content) {
  const tmp = join(dir, `.${name}.part`);
  writeFileSync(tmp, content);
  renameSync(tmp, join(dir, name));
}

function moveTo(folder, name) {
  let target = name;
  for (let n = 2; existsSync(join(DIRS[folder], target)); n++) target = name.replace(/(\.\w+)$/, `.dup${n}$1`);
  renameSync(join(DIRS.inbox, name), join(DIRS[folder], target));
  return target;
}

function listFolder(folder) {
  if (!existsSync(DIRS[folder])) return [];
  return readdirSync(DIRS[folder], { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
    .map(d => {
      const st = statSync(join(DIRS[folder], d.name));
      return { name: d.name, size: st.size, modified: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function cleanupArchive() {
  for (const folder of ['processed', 'error']) {
    const files = listFolder(folder);
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      try { unlinkSync(join(DIRS[folder], f.name)); } catch {}
    }
  }
}

const sha256 = data => createHash('sha256').update(data).digest('hex');

function log({ direction, connector, file = null, status, rows = null, summary = null, errors = null, checksum = null }) {
  db.prepare(`INSERT INTO file_transfer_log (direction, connector, file_name, status, rows, summary, errors, checksum)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(direction, connector, file, status, rows, summary && JSON.stringify(summary), errors && JSON.stringify(errors), checksum);
  db.prepare('DELETE FROM file_transfer_log WHERE id NOT IN (SELECT id FROM file_transfer_log ORDER BY id DESC LIMIT 500)').run();
}

const logToApi = r => r && ({
  id: r.id, at: r.at, direction: r.direction, connector: r.connector, file: r.file_name, status: r.status,
  rows: r.rows, summary: r.summary ? JSON.parse(r.summary) : null, errors: r.errors ? JSON.parse(r.errors) : [],
});

export const transferHistory = (limit = 30) =>
  db.prepare('SELECT * FROM file_transfer_log ORDER BY id DESC LIMIT ?').all(limit).map(logToApi);

const lastLog = (connector, direction) =>
  logToApi(db.prepare('SELECT * FROM file_transfer_log WHERE connector = ? AND direction = ? ORDER BY id DESC LIMIT 1')
    .get(connector, direction));

export const isFileMode = conn => conn?.integration === 'file';

export function requireFileMode(conn) {
  if (!isFileMode(conn))
    throw httpError(409, `${conn?.name || 'No connector'} uses the API integration. Switch it to file transfer first (Admin > File transfer).`);
  return conn;
}

export async function exportProducts(conn, { force = false } = {}) {
  ensureDirs();
  let csv;
  try {
    csv = await clientFor(conn).productsCsv();
    if (typeof csv !== 'string') throw new ErpError('the ERP did not return a CSV file (is /rest/api/getProducts() available?)', 502);
  } catch (e) {
    const prev = lastLog(conn.id, 'export');
    if (prev?.status === 'failed' && prev.errors[0] === e.message)
      db.prepare("UPDATE file_transfer_log SET at = datetime('now') WHERE id = ?").run(prev.id);
    else log({ direction: 'export', connector: conn.id, status: 'failed', errors: [e.message] });
    throw e;
  }
  const checksum = sha256(csv);
  const settingKey = `file_last_export:${conn.id}`;
  if (!force && getSetting(settingKey) === checksum) return { ok: true, written: false, reason: 'ERP data unchanged since the last export' };
  const file = newFileName(conn.id, 'csv');
  writeAtomically(DIRS.inbox, file, csv);
  setSetting(settingKey, checksum);
  const rows = Math.max(0, csv.split(/\r?\n/).filter(l => l.trim()).length - 1);
  log({ direction: 'export', connector: conn.id, file, status: 'written', rows, checksum,
        summary: { bytes: Buffer.byteLength(csv), trigger: force ? 'manual' : 'scheduled' } });
  return { ok: true, written: true, file, rows, bytes: Buffer.byteLength(csv) };
}

function applyProducts(conn, products) {
  const find = db.prepare('SELECT * FROM products WHERE product_id = ?');
  const insert = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, erp_id,
                             erp_connector, erp_created_by, category, active) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 1)`);
  const update = db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, currency = ?, stock = ?,
                             erp_id = NULL, erp_connector = ?, erp_created_by = NULL, updated_at = datetime('now') WHERE id = ?`);
  const unlink = db.prepare('UPDATE products SET erp_id = NULL, erp_connector = NULL WHERE id = ?');
  const counts = { created: 0, updated: 0, unchanged: 0, unlinked: 0 };
  db.transaction(() => {
    const active = getActiveConnector();
    if (active?.id !== conn.id || !isFileMode(active)) throw new ErpError(`${conn.name} is no longer the active file transfer connector.`, 409);
    const seen = new Set();
    for (const p of products) {
      seen.add(p.productID);
      const existing = find.get(p.productID);
      const stock = p.stock ?? existing?.stock ?? 0;
      const row = [p.name, p.description, toCents(p.price), p.currency, stock];
      if (!existing) {
        insert.run(p.productID, ...row, conn.id, categoryFor(p.productID));
        counts.created++;
        continue;
      }
      const same = existing.name === row[0] && (existing.description ?? null) === row[1] && existing.price_cents === row[2]
        && existing.currency === row[3] && existing.stock === row[4] && existing.erp_connector === conn.id && existing.erp_id === null;
      if (same) counts.unchanged++;
      else { update.run(...row, conn.id, existing.id); counts.updated++; }
    }
    for (const p of db.prepare('SELECT id, product_id FROM products WHERE erp_connector = ?').all(conn.id)) {
      if (!seen.has(p.product_id)) { unlink.run(p.id); counts.unlinked++; }
    }
  })();
  return counts;
}

function writeErrorReport(file, conn, errors, warnings) {
  const lines = [
    `File:      ${file}`,
    `Rejected:  ${new Date().toISOString()}`,
    `Connector: ${conn.name} (${conn.id})`,
    '',
    'The file was NOT imported (all or nothing). Problems:',
    ...errors.map(e => `  - ${e}`),
    ...(warnings.length ? ['', 'Remarks:', ...warnings.map(w => `  - ${w}`)] : []),
    '',
    `Expected file name: ${NAMING}`,
    'Expected columns:   productID, name, description, price, stock  (price e.g. "1200.00 EUR")',
    'Fix the file (or the export), then copy it into the inbox folder again or upload it in Admin > File transfer.',
  ];
  writeFileSync(join(DIRS.error, `${file}.error.txt`), lines.join('\n') + '\n');
}

const uploadNames = new Map();

function importFile(conn, name) {
  const meta = parseName(name);
  const errors = [];
  const warnings = [];
  if (!meta) {
    errors.push(`the file name does not follow the convention ${NAMING}`);
  } else {
    if (meta.source !== conn.id && meta.source !== 'upload')
      errors.push(`the file comes from ERP "${meta.source}", but the active connector is "${conn.id}"`);
    const done = db.prepare("SELECT 1 FROM file_transfer_log WHERE direction = 'import' AND file_name = ? AND status <> 'rejected'").get(name);
    if (done) errors.push('a file with this name was already imported (duplicate transfer)');
    const newest = getSetting(`file_last_import:${conn.id}`);
    if (newest && meta.order < newest)
      errors.push(`outdated file: newer data (${newest.slice(0, 16)}) was already imported`);
    if (meta.stamp > stampOf(Date.now() + 5 * 60 * 1000))
      errors.push(`the time stamp ${meta.stamp} in the file name lies in the future`);
  }
  const buffer = readFileSync(join(DIRS.inbox, name));
  const checksum = sha256(buffer);
  let parsed = null;
  if (!errors.length) {
    const ext = meta.ext || extname(name).slice(1).toLowerCase();
    parsed = parseProductFile(buffer, ext);
    errors.push(...parsed.errors);
    warnings.push(...parsed.warnings);
  }
  const original = uploadNames.get(name);
  uploadNames.delete(name);
  const base = { file: name, rows: parsed?.lines ?? null, warnings, ...(original ? { originalName: original } : {}) };

  if (errors.length) {
    const moved = moveTo('error', name);
    writeErrorReport(moved, conn, errors, warnings);
    log({ direction: 'import', connector: conn.id, file: name, status: 'rejected', rows: base.rows, errors, checksum,
          summary: { warnings, movedTo: `error/${moved}`, ...(original ? { originalName: original } : {}) } });
    return { ...base, status: 'rejected', errors, movedTo: `error/${moved}` };
  }
  const counts = applyProducts(conn, parsed.products);
  const moved = moveTo('processed', name);
  setSetting(`file_last_import:${conn.id}`, meta.order);
  if (meta.source !== conn.id) db.prepare('DELETE FROM settings WHERE key = ?').run(`file_last_export:${conn.id}`);
  const status = counts.created + counts.updated + counts.unlinked ? 'imported' : 'unchanged';
  log({ direction: 'import', connector: conn.id, file: name, status, rows: base.rows, checksum,
        summary: { ...counts, warnings, movedTo: `processed/${moved}`, ...(original ? { originalName: original } : {}) } });
  return { ...base, status, ...counts, errors: [], movedTo: `processed/${moved}` };
}

function processInbox(conn, { settle }) {
  ensureDirs();
  const now = Date.now();
  const files = listFolder('inbox')
    .filter(f => !settle || now - f.mtimeMs >= SETTLE_MS)
    .sort((a, b) => (parseName(a.name)?.order || '').localeCompare(parseName(b.name)?.order || ''));
  const results = [];
  for (const f of files) results.push(importFile(conn, f.name));
  if (results.length) cleanupArchive();
  const ok = results.filter(r => r.status !== 'rejected');
  if (ok.length) {
    const last = ok.at(-1);
    recordSyncResult(conn.id, { received: last.rows, created: sum(ok, 'created'), updated: sum(ok, 'updated'),
                                unchanged: last.unchanged, skipped: 0, unlinked: sum(ok, 'unlinked'), file: last.file });
  }
  return results;
}
const sum = (list, key) => list.reduce((s, r) => s + (r[key] || 0), 0);

let queue = Promise.resolve();

export function importInbox(conn, { settle = false } = {}) {
  requireFileMode(conn);
  const run = queue.then(() => processInbox(conn, { settle }));
  queue = run.catch(() => {});
  return run;
}

export async function uploadProductFile(conn, buffer, originalName) {
  requireFileMode(conn);
  const ext = /\.(csv|xlsx)$/i.exec(String(originalName || ''))?.[1]?.toLowerCase();
  if (!ext) throw httpError(400, 'Only .csv or .xlsx files can be uploaded.');
  if (!buffer?.length) throw httpError(400, 'The file is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw httpError(413, `The file is too large (max. ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  ensureDirs();
  const file = newFileName('upload', ext);
  uploadNames.set(file, String(originalName).slice(0, 200));
  writeAtomically(DIRS.inbox, file, buffer);
  const results = await importInbox(conn);
  return results.find(r => r.file === file) || { file, status: 'pending' };
}

export async function runFileCycle(conn, { forceExport = true } = {}) {
  const result = { mode: 'file', export: null, imports: [], orders: { checked: 0, updated: 0 } };
  if (conn.auto_catalog) {
    try { result.catalog = await loadCatalogIntoErp(conn, { syncShop: false }); } catch {}
  }
  try {
    result.export = await exportProducts(conn, { force: forceExport });
  } catch (e) {
    result.export = { ok: false, written: false, error: e.message };
  }
  result.imports = await importInbox(conn);
  const ok = result.imports.filter(r => r.status !== 'rejected');
  result.products = { received: ok.at(-1)?.rows ?? 0, created: sum(ok, 'created'), updated: sum(ok, 'updated'),
                      unchanged: ok.at(-1)?.unchanged ?? 0, skipped: 0, unlinked: sum(ok, 'unlinked') };
  return result;
}

export function transferStatus(conn) {
  ensureDirs();
  return {
    dir: TRANSFER_DIR,
    folders: Object.keys(DIRS),
    naming: NAMING,
    exportIntervalS: EXPORT_INTERVAL_S,
    pollIntervalS: POLL_INTERVAL_S,
    connector: conn ? { id: conn.id, name: conn.name, integration: conn.integration } : null,
    inbox: listFolder('inbox').map(({ mtimeMs, ...f }) => ({ ...f, valid: !!parseName(f.name) })),
    counts: { processed: listFolder('processed').length, error: listFolder('error').length },
    lastExport: conn ? lastLog(conn.id, 'export') : null,
    lastImport: conn ? lastLog(conn.id, 'import') : null,
    history: transferHistory(),
  };
}

export function transferFilePath(folder, name) {
  if (!DIRS[folder] || !/^[\w][\w.-]*$/.test(name)) throw httpError(404, 'File not found.');
  const path = join(DIRS[folder], name);
  if (!existsSync(path)) throw httpError(404, 'File not found.');
  return path;
}

export function startInboxPoller() {
  if (POLL_INTERVAL_S <= 0) return;
  ensureDirs();
  setInterval(async () => {
    const conn = getActiveConnector();
    if (!isFileMode(conn)) return;
    try {
      for (const r of await importInbox(conn, { settle: true })) {
        console.log(`[file] ${r.file}: ${r.status}` + (r.status === 'rejected' ? ` - ${r.errors[0]}` :
          ` (${r.rows} products: ${r.created} new, ${r.updated} updated, ${r.unlinked} removed)`));
      }
    } catch (e) {
      console.warn(`[file] import failed: ${e.message}`);
    }
  }, POLL_INTERVAL_S * 1000).unref();
}
