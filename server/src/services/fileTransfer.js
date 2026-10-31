// =====================================================================================================
// fileTransfer.js - Lab 2: transfers the product master data from the Mini-ERP to the web shop with FILES.
//
// Role in the architecture:
//  - Alternative to the API integration (productSync.js). It is switched on per SAP connector
//    (erp_connectors.integration = 'file', Admin > File transfer or the connector's Edit dialog).
//  - Simulates a classic file interface between two systems that only share a folder (in real landscapes an
//    SFTP server or a network share). The shop never calls the ERP to read products in this mode; the only
//    link is the transfer folder:
//
//      ERP side (export job)                    transfer/                     shop side (import)
//      GET /rest/api/getProducts()  ──CSV──▶   inbox/      ──poll every 10 s──▶  validate + update products
//      (the ERP's own CSV export)              processed/  ◀── imported files are archived here
//                                              error/      ◀── rejected files + <name>.error.txt report
//
//  - The export job belongs to the ERP side. To keep the lab simple it runs inside this server process
//    (every ERP_SYNC_INTERVAL_S seconds and on "Export now"), but it only uses the ERP's existing CSV export and
//    writes a file - exactly what a scheduled job on the ERP server would do.
//  - Files can also be added by hand: Upload in Admin > File transfer (e.g. the .xlsx file of the Fiori app's
//    "Export to Spreadsheet" button), or simply copied into the inbox folder.
//
// Conventions (Lab 2 requirement "file naming conventions, location, how often"):
//  - File name:  products_<source>_<YYYYMMDDTHHMMSSZ>[-n].<csv|xlsx>
//                source = connector id of the ERP (e.g. local, btp) or "upload"; time in UTC; -n only if two
//                files were created in the same second. Example: products_local_20261026T154200Z.csv
//  - Location:   FILE_TRANSFER_DIR (default server/transfer) with the sub folders inbox, processed, error.
//  - Frequency:  export every ERP_SYNC_INTERVAL_S seconds (default 60), but only if the ERP data changed
//                (change-based export); inbox polled every FILE_POLL_INTERVAL_S seconds (default 10);
//                on demand with the buttons in Admin > File transfer.
//
// Error handling (Lab 2 requirement):
//  - Producer side: files are written as ".<name>.part" and renamed when complete, so the importer never
//    reads a half-written file (rename is atomic on the same file system).
//  - Consumer side: the poller only takes files that have not been modified for FILE_SETTLE_MS (a file that is
//    still being copied into the inbox by hand is left for the next poll).
//  - Each file is checked completely (productFile.js): name convention, source, duplicate, outdated, format,
//    header, every line. A file with errors is NOT imported at all ("all or nothing") and moved to error/
//    with a report. A valid file is applied in ONE database transaction.
//  - Every export and import is written to the table file_transfer_log (shown in the admin UI).
// =====================================================================================================

// File system functions (synchronous: the files are small and the code stays easy to follow).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
// Path helpers: join builds paths, resolve makes them absolute, extname returns ".csv" etc.
import { join, resolve, extname } from 'node:path';
// SHA-256 checksums: detect whether the ERP data changed since the last export.
import { createHash } from 'node:crypto';
// Shared SQLite connection and the key/value settings table.
import { db, getSetting, setSetting } from '../db.js';
// HTTP client of an ERP connector (for the ERP's CSV export) and the error class with an HTTP status.
import { clientFor, ErpError } from './erpClient.js';
// The currently active SAP connector (to make sure a slow import does not write into another connector).
import { getActiveConnector } from './connectors.js';
// Reads and validates a product file (CSV or XLSX); MAX_FILE_BYTES is the size limit.
import { parseProductFile, MAX_FILE_BYTES } from './productFile.js';
// Stores the result of a successful import as the connector's "last sync" (shown in the admin UI).
import { recordSyncResult } from './productSync.js';
// Creates the demo catalog in the ERP (only for connectors with "auto catalog", i.e. the in-memory local ERP).
import { loadCatalogIntoErp } from './erpMasterData.js';
// Euro amount -> integer cents; error with HTTP status.
import { toCents, httpError } from '../util.js';
// Shop category of a productID (shop-only data, used when a new product is inserted).
import { categoryFor } from '../catalog.js';

// ---------------------------------------------------------------------------------------------------------
// Configuration (from server/.env or the environment)
// ---------------------------------------------------------------------------------------------------------

// Root of the transfer folders, relative to the working directory (the server folder when started with npm).
export const TRANSFER_DIR = resolve(process.env.FILE_TRANSFER_DIR || './transfer');
// The three sub folders and their purpose.
const DIRS = {
  inbox: join(TRANSFER_DIR, 'inbox'),         // new files, waiting to be imported
  processed: join(TRANSFER_DIR, 'processed'), // archive of imported files
  error: join(TRANSFER_DIR, 'error'),         // rejected files and their error reports
};
// How often the inbox is checked for new files (seconds; 0 switches the poller off).
export const POLL_INTERVAL_S = Number(process.env.FILE_POLL_INTERVAL_S ?? 10);
// The export job runs with the background sync of erpSync.js, i.e. every ERP_SYNC_INTERVAL_S seconds.
export const EXPORT_INTERVAL_S = Number(process.env.ERP_SYNC_INTERVAL_S ?? 60);
// A file must be unchanged for this long before the poller takes it (protects against half-copied files).
const SETTLE_MS = Number(process.env.FILE_SETTLE_MS ?? 2000);
// How many files are kept in processed/ and error/ (older ones are deleted; the log keeps the history).
const KEEP_FILES = Number(process.env.FILE_KEEP ?? 200);
// The naming convention, as shown to the admin and written into error reports.
export const NAMING = 'products_<source>_<YYYYMMDDTHHMMSSZ>.<csv|xlsx>';
// Regular expression for the convention. Groups: 1 = source (connector id or "upload"), 2 = UTC time stamp
// (8 digits date, "T", 6 digits time, "Z"), 3 = optional sequence number after "-", 4 = extension. The i flag
// accepts upper case letters too (e.g. ".CSV" written by Windows tools).
const NAME_PATTERN = /^products_([a-z0-9-]+)_(\d{8}T\d{6}Z)(?:-(\d+))?\.(csv|xlsx)$/i;

// Creates the transfer folders if they do not exist yet (recursive: also TRANSFER_DIR itself).
function ensureDirs() {
  // mkdirSync with recursive: true does nothing (and throws no error) if the folder already exists.
  for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true });
}

// A point in time (ms) in the compact ISO 8601 form used in file names: 2026-10-26T15:42:00.123Z -> 20261026T154200Z.
// toISOString() always returns UTC; "-" and ":" are removed, then the milliseconds ".123".
const stampOf = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// The current UTC time in that form.
const stamp = () => stampOf(Date.now());

// Splits a file name according to the convention; null if it does not follow it.
// `order` is a sortable key (time stamp + 4-digit sequence) used to process files in the order they were created.
function parseName(name) {
  // exec() returns the match with its groups, or null if the name does not match the pattern.
  const m = NAME_PATTERN.exec(name);
  // Not a conventional name.
  if (!m) return null;
  // The parts of the name. seq defaults to 1 (no "-n" suffix); padStart(4, '0') turns 2 into "0002", so the order
  // key can be compared as text ("...Z-0002" > "...Z-0001").
  return { source: m[1].toLowerCase(), stamp: m[2], seq: Number(m[3] || 1), ext: m[4].toLowerCase(),
           order: `${m[2]}-${String(m[3] || 1).padStart(4, '0')}` };
}

// A new file name that does not exist in any transfer folder yet (adds -2, -3, ... within the same second).
function newFileName(source, ext) {
  // Name without extension, e.g. products_local_20261026T154200Z.
  const base = `products_${source}_${stamp()}`;
  // Endless loop that stops with `return` as soon as a free name is found.
  for (let n = 1; ; n++) {
    // First try without suffix, then with -2, -3, ...
    const name = n === 1 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
    // Free = in none of the three folders (inbox, processed, error), so a name is never used twice.
    if (!Object.values(DIRS).some(dir => existsSync(join(dir, name)))) return name;
  }
}

// Writes a file atomically: first under a hidden temporary name, then renamed. A reader of the folder
// therefore sees either nothing or the complete file - never a half-written one.
function writeAtomically(dir, name, content) {
  // Hidden temporary name (leading dot + .part); listFolder() ignores such files.
  const tmp = join(dir, `.${name}.part`);
  // Write the whole content.
  writeFileSync(tmp, content);
  // Rename = one atomic step of the file system: the final name appears only when the content is complete.
  renameSync(tmp, join(dir, name));
}

// Moves a file from the inbox into processed/ or error/; if a file with that name exists there, a suffix is
// added instead of overwriting it. Returns the final name.
function moveTo(folder, name) {
  // Target name: the same name if it is free there.
  let target = name;
  // Otherwise insert ".dup2", ".dup3", ... before the extension (x.csv -> x.dup2.csv) until the name is free.
  for (let n = 2; existsSync(join(DIRS[folder], target)); n++) target = name.replace(/(\.\w+)$/, `.dup${n}$1`);
  // Move (rename within the same file system: fast and atomic).
  renameSync(join(DIRS.inbox, name), join(DIRS[folder], target));
  // The caller needs the final name for the log and the error report.
  return target;
}

// Lists the regular files of a transfer folder (hidden and temporary *.part files are skipped), oldest first.
function listFolder(folder) {
  // A missing folder is simply empty.
  if (!existsSync(DIRS[folder])) return [];
  // withFileTypes: true returns entries that know whether they are files or folders.
  return readdirSync(DIRS[folder], { withFileTypes: true })
    // Only regular files; no hidden files (".x") and no temporary files of an export that is still being written.
    .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
    // Size and modification time of each file (statSync reads the file's metadata).
    .map(d => {
      // Metadata of the file.
      const st = statSync(join(DIRS[folder], d.name));
      // modified as ISO text for the UI, mtimeMs as number for the "settle" check and the sorting.
      return { name: d.name, size: st.size, modified: st.mtime.toISOString(), mtimeMs: st.mtimeMs };
    })
    // Oldest first.
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// Keeps only the newest KEEP_FILES files in processed/ and error/ (simple retention rule).
function cleanupArchive() {
  // The two archive folders (the inbox is never cleaned up automatically).
  for (const folder of ['processed', 'error']) {
    // Files of the folder, oldest first.
    const files = listFolder(folder);
    // The oldest ones beyond the limit (slice(0, n) = the first n entries; Math.max avoids a negative n).
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      // Delete it; if it is already gone (e.g. removed by hand), ignore the error.
      try { unlinkSync(join(DIRS[folder], f.name)); } catch { /* already gone */ }
    }
  }
}

// SHA-256 checksum of a text/buffer as hex string (64 characters). Same content = same checksum.
const sha256 = data => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------------------------------------
// Transfer log (table file_transfer_log, created in db.js)
// ---------------------------------------------------------------------------------------------------------

// Writes one log entry. summary and errors are stored as JSON text. Destructuring with defaults: fields the caller
// does not pass become null.
function log({ direction, connector, file = null, status, rows = null, summary = null, errors = null, checksum = null }) {
  // Prepared INSERT with 8 placeholders (bound values, safe against SQL injection); id and at get their defaults.
  db.prepare(`INSERT INTO file_transfer_log (direction, connector, file_name, status, rows, summary, errors, checksum)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    // `summary && JSON.stringify(summary)`: null stays null, an object becomes JSON text.
    .run(direction, connector, file, status, rows, summary && JSON.stringify(summary), errors && JSON.stringify(errors), checksum);
  // Keep the log small: only the newest 500 entries.
  db.prepare('DELETE FROM file_transfer_log WHERE id NOT IN (SELECT id FROM file_transfer_log ORDER BY id DESC LIMIT 500)').run();
}

// A log row in the format of the admin UI (JSON columns parsed). `r && (...)` returns undefined for a missing row.
const logToApi = r => r && ({
  // Columns taken over 1:1 (file_name is renamed to file).
  id: r.id, at: r.at, direction: r.direction, connector: r.connector, file: r.file_name, status: r.status,
  // JSON text -> objects again; errors is always an array (empty if there were none).
  rows: r.rows, summary: r.summary ? JSON.parse(r.summary) : null, errors: r.errors ? JSON.parse(r.errors) : [],
});

// The newest log entries (for the history table), newest first.
export const transferHistory = (limit = 30) =>
  // ORDER BY id DESC = newest first; LIMIT ? = at most `limit` rows.
  db.prepare('SELECT * FROM file_transfer_log ORDER BY id DESC LIMIT ?').all(limit).map(logToApi);

// The newest export / import entry of a connector (or undefined if there is none).
const lastLog = (connector, direction) =>
  // One row (LIMIT 1) of this connector and direction, converted for the UI.
  logToApi(db.prepare('SELECT * FROM file_transfer_log WHERE connector = ? AND direction = ? ORDER BY id DESC LIMIT 1')
    .get(connector, direction));

// ---------------------------------------------------------------------------------------------------------
// Mode check
// ---------------------------------------------------------------------------------------------------------

// true if the connector exchanges product data by files (`?.` because there may be no connector at all).
export const isFileMode = conn => conn?.integration === 'file';

// Throws 409 if the connector is not in file transfer mode (e.g. upload while the API integration is active).
export function requireFileMode(conn) {
  // 409 Conflict: the request is valid, but not possible in the current mode.
  if (!isFileMode(conn))
    throw httpError(409, `${conn?.name || 'No connector'} uses the API integration. Switch it to file transfer first (Admin > File transfer).`);
  // Returning the connector allows calls like importInbox(requireFileMode(conn)).
  return conn;
}

// ---------------------------------------------------------------------------------------------------------
// ERP side: the export job
// ---------------------------------------------------------------------------------------------------------

/**
 * Export job (ERP side): reads the ERP's CSV export (REST GET /rest/api/getProducts()) and writes it into the
 * inbox as products_<connector>_<time>.csv. With force = false (scheduled run) a file is only written if the
 * content differs from the last export, so an unchanged ERP does not produce a new file every minute.
 * Returns { ok, written, file?, rows?, bytes?, reason? }. ERP errors are logged and thrown.
 */
export async function exportProducts(conn, { force = false } = {}) {
  // The inbox must exist before a file can be written into it.
  ensureDirs();
  // The CSV text of the ERP (declared outside the try block, it is used after it).
  let csv;
  try {
    // The ERP's own file export (text/csv): "productID,name,description,price,stock" + one line per product.
    csv = await clientFor(conn).productsCsv();
    // call() returns parsed JSON for JSON answers - then this is not the CSV export (wrong URL / old ERP).
    if (typeof csv !== 'string') throw new ErpError('the ERP did not return a CSV file (is /rest/api/getProducts() available?)', 502);
  } catch (e) {
    // Log the failure - but not again and again: if the previous export of this connector failed with the same
    // message, only its time stamp is refreshed (the scheduled job retries every minute while the ERP is down).
    const prev = lastLog(conn.id, 'export');
    // Same error as last time: move its time stamp to now.
    if (prev?.status === 'failed' && prev.errors[0] === e.message)
      db.prepare("UPDATE file_transfer_log SET at = datetime('now') WHERE id = ?").run(prev.id);
    // New error: new log entry.
    else log({ direction: 'export', connector: conn.id, status: 'failed', errors: [e.message] });
    // The caller decides what to do (route: error message for the admin; transfer run: continue with the import).
    throw e;
  }
  // Change detection: same content as the last export -> nothing to transfer (unless forced).
  const checksum = sha256(csv);
  // The checksum of the last export of this connector is kept in the settings table (survives restarts).
  const settingKey = `file_last_export:${conn.id}`;
  // Scheduled run and nothing changed: no new file.
  if (!force && getSetting(settingKey) === checksum) return { ok: true, written: false, reason: 'ERP data unchanged since the last export' };
  // A new, conventional file name for this connector.
  const file = newFileName(conn.id, 'csv');
  // Write the file atomically into the inbox.
  writeAtomically(DIRS.inbox, file, csv);
  // Remember what was exported last.
  setSetting(settingKey, checksum);
  // Number of data lines (non-empty lines minus the header).
  const rows = Math.max(0, csv.split(/\r?\n/).filter(l => l.trim()).length - 1);
  // Log entry for the history: file, number of products, size and whether it was a manual or scheduled run.
  log({ direction: 'export', connector: conn.id, file, status: 'written', rows, checksum,
        summary: { bytes: Buffer.byteLength(csv), trigger: force ? 'manual' : 'scheduled' } });
  // Result for the route / the transfer run.
  return { ok: true, written: true, file, rows, bytes: Buffer.byteLength(csv) };
}

// ---------------------------------------------------------------------------------------------------------
// Shop side: the import
// ---------------------------------------------------------------------------------------------------------

/**
 * Applies the products of a valid file to the shop database in ONE transaction (all or nothing).
 * The file is a full snapshot of the ERP: products in the file are inserted/updated (matched by productID),
 * products of this connector that are missing in the file are unlinked (hidden), like in the API sync.
 * File products have no ERP UUID (erp_id NULL) - they are linked to the connector only.
 */
function applyProducts(conn, products) {
  // Prepared statements, compiled once and executed for every product.
  // Find the shop product with the same business key (product_id is UNIQUE).
  const find = db.prepare('SELECT * FROM products WHERE product_id = ?');
  // Insert a new product: erp_id and erp_created_by NULL (a file has no ERP UUID), active = 1 (listed at once).
  const insert = db.prepare(`INSERT INTO products (product_id, name, description, price_cents, currency, stock, erp_id,
                             erp_connector, erp_created_by, category, active) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 1)`);
  // Update the ERP-mastered columns; category and active (shop-only decisions of the admin) stay untouched.
  const update = db.prepare(`UPDATE products SET name = ?, description = ?, price_cents = ?, currency = ?, stock = ?,
                             erp_id = NULL, erp_connector = ?, erp_created_by = NULL, updated_at = datetime('now') WHERE id = ?`);
  // Remove the link to the ERP (the row stays because old orders reference it).
  const unlink = db.prepare('UPDATE products SET erp_id = NULL, erp_connector = NULL WHERE id = ?');
  // Counters for the log and the admin UI.
  const counts = { created: 0, updated: 0, unchanged: 0, unlinked: 0 };
  // db.transaction(fn)() runs fn inside BEGIN ... COMMIT; any exception rolls everything back.
  db.transaction(() => {
    // The import runs after async steps: make sure the connector is still active and still in file mode.
    const active = getActiveConnector();
    // Otherwise 409: nothing is written (the transaction is rolled back) and the file stays in the inbox.
    if (active?.id !== conn.id || !isFileMode(active)) throw new ErpError(`${conn.name} is no longer the active file transfer connector.`, 409);
    // Business keys contained in the file.
    const seen = new Set();
    // One iteration per product of the file.
    for (const p of products) {
      // Remember: this product is still in the ERP.
      seen.add(p.productID);
      // The shop row with the same business key (undefined if the product is new).
      const existing = find.get(p.productID);
      // Stock: from the file; if the file has no stock column, keep the shop's value (0 for new products).
      const stock = p.stock ?? existing?.stock ?? 0;
      // Values of the ERP-mastered columns, in the order of the placeholders (price as integer cents).
      const row = [p.name, p.description, toCents(p.price), p.currency, stock];
      // New product: insert it with the category from the demo catalog ("Other" for unknown products).
      if (!existing) {
        // productID, the five values, the connector and the category.
        insert.run(p.productID, ...row, conn.id, categoryFor(p.productID));
        // Count it and continue with the next product.
        counts.created++;
        // Next product of the file.
        continue;
      }
      // Only real changes are written (and counted), so updated_at stays meaningful.
      const same = existing.name === row[0] && (existing.description ?? null) === row[1] && existing.price_cents === row[2]
        && existing.currency === row[3] && existing.stock === row[4] && existing.erp_connector === conn.id && existing.erp_id === null;
      // Nothing changed: just count it.
      if (same) counts.unchanged++;
      // Changed (or linked to the API / another connector before): overwrite and link it to this connector.
      else { update.run(...row, conn.id, existing.id); counts.updated++; }
    }
    // Products of this connector that are not in the file any more were deleted in the ERP -> hide them.
    for (const p of db.prepare('SELECT id, product_id FROM products WHERE erp_connector = ?').all(conn.id)) {
      // Not in the file: unlink (the shop shows only products of the active connector).
      if (!seen.has(p.product_id)) { unlink.run(p.id); counts.unlinked++; }
    }
  })();
  // created / updated / unchanged / unlinked.
  return counts;
}

// Writes the error report next to a rejected file: what was wrong and what to do.
function writeErrorReport(file, conn, errors, warnings) {
  // The lines of the report (plain text, readable in any editor).
  const lines = [
    // Which file, when and for which connector.
    `File:      ${file}`,
    `Rejected:  ${new Date().toISOString()}`,
    `Connector: ${conn.name} (${conn.id})`,
    '',
    // All problems, one per line.
    'The file was NOT imported (all or nothing). Problems:',
    ...errors.map(e => `  - ${e}`),
    // Remarks only if there are any (spread of an empty array adds nothing).
    ...(warnings.length ? ['', 'Remarks:', ...warnings.map(w => `  - ${w}`)] : []),
    '',
    // What a correct file looks like and what to do next.
    `Expected file name: ${NAMING}`,
    'Expected columns:   productID, name, description, price, stock  (price e.g. "1200.00 EUR")',
    'Fix the file (or the export), then copy it into the inbox folder again or upload it in Admin > File transfer.',
  ];
  // <file>.error.txt in the error folder, next to the rejected file.
  writeFileSync(join(DIRS.error, `${file}.error.txt`), lines.join('\n') + '\n');
}

// Original names of uploaded files (file name in the inbox -> name on the user's computer), for the log.
const uploadNames = new Map();

/** Checks and imports ONE file from the inbox. Returns the result for the log / admin UI. */
function importFile(conn, name) {
  // Parts of the file name (null if it does not follow the convention).
  const meta = parseName(name);
  // Problems that prevent the import, and remarks that do not.
  const errors = [];
  // Remarks (the file is still imported).
  const warnings = [];
  // 1. File name convention and transfer rules.
  if (!meta) {
    // Without a conventional name, source and time of the file are unknown.
    errors.push(`the file name does not follow the convention ${NAMING}`);
  } else {
    // A file of another ERP must not overwrite the products of the active one.
    if (meta.source !== conn.id && meta.source !== 'upload')
      errors.push(`the file comes from ERP "${meta.source}", but the active connector is "${conn.id}"`);
    // The same file must not be imported twice (e.g. copied into the inbox again by mistake).
    const done = db.prepare("SELECT 1 FROM file_transfer_log WHERE direction = 'import' AND file_name = ? AND status <> 'rejected'").get(name);
    // A previously REJECTED file may be tried again (e.g. after it was fixed).
    if (done) errors.push('a file with this name was already imported (duplicate transfer)');
    // An older file must not overwrite newer data (files can arrive late or in the wrong order).
    const newest = getSetting(`file_last_import:${conn.id}`);
    // Text comparison works because the order key has a fixed format (time stamp + 4-digit sequence).
    if (newest && meta.order < newest)
      errors.push(`outdated file: newer data (${newest.slice(0, 16)}) was already imported`);
    // A time stamp in the future (more than 5 minutes ahead of this server's clock) is refused: once imported it
    // would make every later, correct file look "outdated".
    if (meta.stamp > stampOf(Date.now() + 5 * 60 * 1000))
      errors.push(`the time stamp ${meta.stamp} in the file name lies in the future`);
  }
  // 2. Content: format, header and every line (only if the name is OK).
  const buffer = readFileSync(join(DIRS.inbox, name));
  // Checksum of the content for the log (shows whether two files had the same content).
  const checksum = sha256(buffer);
  // Result of productFile.js (stays null if the name was already wrong).
  let parsed = null;
  // Read the content only when the transfer rules are fulfilled.
  if (!errors.length) {
    // Format from the extension of the name.
    const ext = meta.ext || extname(name).slice(1).toLowerCase();
    // Parse and validate the whole file.
    parsed = parseProductFile(buffer, ext);
    // Collect its errors and remarks.
    errors.push(...parsed.errors);
    // Remarks of the parser.
    warnings.push(...parsed.warnings);
  }
  // Summary information shared by both outcomes.
  const original = uploadNames.get(name);
  // The original name is only needed once.
  uploadNames.delete(name);
  // rows = number of product lines in the file; originalName only for uploads (conditional spread).
  const base = { file: name, rows: parsed?.lines ?? null, warnings, ...(original ? { originalName: original } : {}) };

  // 3a. Rejected: move to error/ with a report, log it. The shop data stays unchanged.
  if (errors.length) {
    // Move the file out of the inbox, so it is not checked again on every poll.
    const moved = moveTo('error', name);
    // <file>.error.txt with all problems.
    writeErrorReport(moved, conn, errors, warnings);
    // History entry with the problems.
    log({ direction: 'import', connector: conn.id, file: name, status: 'rejected', rows: base.rows, errors, checksum,
          summary: { warnings, movedTo: `error/${moved}`, ...(original ? { originalName: original } : {}) } });
    // Result for the caller.
    return { ...base, status: 'rejected', errors, movedTo: `error/${moved}` };
  }
  // 3b. Valid: apply in one transaction (throws 409 if the connector was switched meanwhile - the file then
  // stays in the inbox, it is not its fault).
  const counts = applyProducts(conn, parsed.products);
  // Archive the imported file.
  const moved = moveTo('processed', name);
  // Remember the newest imported file (for the "outdated" check).
  setSetting(`file_last_import:${conn.id}`, meta.order);
  // A file that did not come from this ERP's export job (an upload) replaced the shop's product list: forget the
  // checksum of the last export, so the next scheduled export sends the ERP's full list again even if the ERP data
  // did not change (otherwise the shop would keep the uploaded list until the next change in the ERP).
  if (meta.source !== conn.id) db.prepare('DELETE FROM settings WHERE key = ?').run(`file_last_export:${conn.id}`);
  // "imported" if anything changed in the shop, otherwise "unchanged".
  const status = counts.created + counts.updated + counts.unlinked ? 'imported' : 'unchanged';
  // History entry with the counters and the remarks.
  log({ direction: 'import', connector: conn.id, file: name, status, rows: base.rows, checksum,
        summary: { ...counts, warnings, movedTo: `processed/${moved}`, ...(original ? { originalName: original } : {}) } });
  // Result for the caller.
  return { ...base, status, ...counts, errors: [], movedTo: `processed/${moved}` };
}

// Processes all files in the inbox, oldest first. `settle`: skip files modified less than SETTLE_MS ago.
function processInbox(conn, { settle }) {
  // The folders must exist (they may have been deleted by hand).
  ensureDirs();
  // One "now" for all files of this run.
  const now = Date.now();
  // The files to process in this run.
  const files = listFolder('inbox')
    // With settle: only files that have not changed for SETTLE_MS (a copy that is still running is left alone).
    .filter(f => !settle || now - f.mtimeMs >= SETTLE_MS)
    // Order of creation: by the time stamp in the name; files with an invalid name first (they are rejected).
    .sort((a, b) => (parseName(a.name)?.order || '').localeCompare(parseName(b.name)?.order || ''));
  // One result per file.
  const results = [];
  // Import one file after the other (each one is all or nothing).
  for (const f of files) results.push(importFile(conn, f.name));
  // Delete old archive files after a run that processed something.
  if (results.length) cleanupArchive();
  // Remember the result of the last valid file as the connector's "last sync" (Admin > SAP connectors).
  const ok = results.filter(r => r.status !== 'rejected');
  // Only if at least one file was imported.
  if (ok.length) {
    // The newest imported file describes the current state of the shop.
    const last = ok.at(-1);
    // Same fields as the API sync result (received, created, ...), plus the file name.
    recordSyncResult(conn.id, { received: last.rows, created: sum(ok, 'created'), updated: sum(ok, 'updated'),
                                unchanged: last.unchanged, skipped: 0, unlinked: sum(ok, 'unlinked'), file: last.file });
  }
  // All results (also the rejected files).
  return results;
}
// Sum of one counter over several import results (missing counters count as 0).
const sum = (list, key) => list.reduce((s, r) => s + (r[key] || 0), 0);

// Imports run one after the other (the poller, "Import now", an upload and the sync may overlap): each call
// waits for the previous one, then processes the inbox as it is at that moment.
let queue = Promise.resolve();

/** Imports all files waiting in the inbox into the given connector. Returns one result per file. */
export function importInbox(conn, { settle = false } = {}) {
  // Only in file transfer mode (409 otherwise).
  requireFileMode(conn);
  // Chain this run behind the previous one.
  const run = queue.then(() => processInbox(conn, { settle }));
  // The queue must continue even if this run fails.
  queue = run.catch(() => {});
  // The caller gets the result (or the error) of its own run.
  return run;
}

/**
 * Upload (Admin > File transfer): stores a file from the admin's computer in the inbox under a name that follows
 * the convention (source "upload") and imports it right away. Returns the import result of that file.
 */
export async function uploadProductFile(conn, buffer, originalName) {
  // Only in file transfer mode (409 otherwise).
  requireFileMode(conn);
  // Only the two supported formats; the name from the browser is used for nothing else (no path from outside).
  const ext = /\.(csv|xlsx)$/i.exec(String(originalName || ''))?.[1]?.toLowerCase();
  // 400 Bad Request for other file types.
  if (!ext) throw httpError(400, 'Only .csv or .xlsx files can be uploaded.');
  // An empty upload is useless.
  if (!buffer?.length) throw httpError(400, 'The file is empty.');
  // 413 Payload Too Large above the size limit.
  if (buffer.length > MAX_FILE_BYTES) throw httpError(413, `The file is too large (max. ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  // The inbox must exist.
  ensureDirs();
  // Conventional name with source "upload".
  const file = newFileName('upload', ext);
  // Remember the original name for the log (at most 200 characters).
  uploadNames.set(file, String(originalName).slice(0, 200));
  // Store the file atomically in the inbox.
  writeAtomically(DIRS.inbox, file, buffer);
  // Import the inbox now (the result contains this file - and any other file that was waiting).
  const results = await importInbox(conn);
  // The result of the uploaded file ("pending" if it was not processed, which should not happen).
  return results.find(r => r.file === file) || { file, status: 'pending' };
}

/**
 * One complete transfer run for a connector in file mode (used by erpSync.js: start-up, background interval,
 * "Sync now", activation): [demo catalog in the ERP] -> export job -> import of the inbox.
 * An unreachable ERP does not stop the import: files that are already in the inbox are still imported, and the
 * shop keeps working with the data of the last file (one advantage of a file interface).
 */
export async function runFileCycle(conn, { forceExport = true } = {}) {
  // Result skeleton; `orders` has the shape of the API sync result (no order statuses in file mode).
  const result = { mode: 'file', export: null, imports: [], orders: { checked: 0, updated: 0 } };
  // ERP side, demo only: the local in-memory ERP loses its data on restart; recreate the demo catalog there.
  if (conn.auto_catalog) {
    // syncShop: false - the products reach the shop through the export file, not through the API.
    try { result.catalog = await loadCatalogIntoErp(conn, { syncShop: false }); } catch { /* the export reports the problem */ }
  }
  // Export job (forceExport: always write a file; false: only if the ERP data changed).
  try {
    // Write the export file (or skip it when the ERP data is unchanged).
    result.export = await exportProducts(conn, { force: forceExport });
  } catch (e) {
    // ERP not reachable: remember the error and still import the files that are already waiting.
    result.export = { ok: false, written: false, error: e.message };
  }
  // Import everything that is in the inbox now (incl. the file just exported).
  result.imports = await importInbox(conn);
  // Counters in the same shape as the API sync, so callers (logs, toasts) can treat both modes alike.
  const ok = result.imports.filter(r => r.status !== 'rejected');
  // received = products in the newest imported file (0 if no file was imported in this run).
  result.products = { received: ok.at(-1)?.rows ?? 0, created: sum(ok, 'created'), updated: sum(ok, 'updated'),
                      unchanged: ok.at(-1)?.unchanged ?? 0, skipped: 0, unlinked: sum(ok, 'unlinked') };
  // { mode, export, imports, products, orders, catalog? }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// Status for the admin UI, file download, background poller
// ---------------------------------------------------------------------------------------------------------

/** Everything Admin > File transfer shows: folders, convention, schedule, inbox, last runs and history. */
export function transferStatus(conn) {
  // The folders are created on the first visit of the page at the latest.
  ensureDirs();
  return {
    // Absolute path of the transfer folder on the server.
    dir: TRANSFER_DIR,
    // inbox, processed, error.
    folders: Object.keys(DIRS),
    // The naming convention and the schedule.
    naming: NAMING,
    exportIntervalS: EXPORT_INTERVAL_S,
    pollIntervalS: POLL_INTERVAL_S,
    // The active connector and its integration style (null in standalone mode).
    connector: conn ? { id: conn.id, name: conn.name, integration: conn.integration } : null,
    // Files waiting in the inbox (without the internal mtimeMs) and whether their name follows the convention.
    inbox: listFolder('inbox').map(({ mtimeMs, ...f }) => ({ ...f, valid: !!parseName(f.name) })),
    // Number of files in the two archive folders (error/ includes the .error.txt reports).
    counts: { processed: listFolder('processed').length, error: listFolder('error').length },
    // Newest export and import of the active connector.
    lastExport: conn ? lastLog(conn.id, 'export') : null,
    lastImport: conn ? lastLog(conn.id, 'import') : null,
    // The newest 30 log entries of all connectors.
    history: transferHistory(),
  };
}

/** Absolute path of a file in a transfer folder for the download route (404 if it does not exist). */
export function transferFilePath(folder, name) {
  // Only the three known folders and plain file names: no "..", no slashes (no path traversal).
  if (!DIRS[folder] || !/^[\w][\w.-]*$/.test(name)) throw httpError(404, 'File not found.');
  // Path inside the folder.
  const path = join(DIRS[folder], name);
  // 404 if the file does not exist (any more).
  if (!existsSync(path)) throw httpError(404, 'File not found.');
  // The route sends this file.
  return path;
}

/** Starts the inbox poller (index.js): imports new files of the active connector if it is in file mode. */
export function startInboxPoller() {
  // FILE_POLL_INTERVAL_S=0 switches the poller off (then only the buttons and the sync import files).
  if (POLL_INTERVAL_S <= 0) return;
  // Create the folders at start-up, so they can be opened in the file explorer right away.
  ensureDirs();
  // Check the inbox every POLL_INTERVAL_S seconds.
  setInterval(async () => {
    // Read the connector on every tick: the admin can switch connectors and modes at runtime.
    const conn = getActiveConnector();
    // API integration or standalone: nothing to do.
    if (!isFileMode(conn)) return;
    try {
      // settle: true - only files that are complete (not modified for SETTLE_MS).
      for (const r of await importInbox(conn, { settle: true })) {
        // One console line per processed file.
        console.log(`[file] ${r.file}: ${r.status}` + (r.status === 'rejected' ? ` - ${r.errors[0]}` :
          ` (${r.rows} products: ${r.created} new, ${r.updated} updated, ${r.unlinked} removed)`));
      }
    } catch (e) {
      // e.g. the connector was switched during the import (409) - the next tick tries again.
      console.warn(`[file] import failed: ${e.message}`);
    }
  // .unref(): this timer alone does not keep the Node.js process alive.
  }, POLL_INTERVAL_S * 1000).unref();
}
