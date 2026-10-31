// =====================================================================================================
// supplierImport.js - processes supplier files (Lab 2 extension): supplier format -> canonical products ->
// SAP Mini-ERP (master) -> web shop.
//
// Flow of one file (from the supplier portal, FTP or copied into the folder by hand):
//
//   suppliers/<id>/inbox/<file>
//     1. read + translate     supplierFormats.js: parse (CSV/XLSX/JSON/XML), map fields (profile or synonyms),
//                             convert values (decimal comma, currency symbols), validate against the ERP's limits
//     2. plan                 read the ERP's product list; per record: create, update (only the fields this supplier
//                             may change) or unchanged; unknown products only if the supplier may create products
//     3. all or nothing       any error in steps 1-2 -> the file is rejected, NOTHING is written to the ERP
//     4. write to the ERP(s)  OData POST /Products and PATCH /Products(<id>) - the ERP stays the master. Which ERPs is
//                             an admin setting (Admin > Suppliers, "Write supplier data to"): the shop's active
//                             connector, one chosen connector (local Mini-ERP OR SAP BTP = cloud) or all (local AND
//                             cloud). Each target ERP is planned and written on its own (status per target).
//     5. shop update          a new sync of the shop's active connector: API pull, or (file transfer mode) a new ERP
//                             export file that the shop imports - so the supplier's data reaches the shop through the
//                             ERP. A shop on another target (e.g. the cloud shop on SAP BTP) syncs itself from its ERP.
//     6. acknowledge          file -> processed/ or error/, report -> outbox/ (the supplier sees it in the portal
//                             and via FTP), result -> supplier_deliveries (shown in the portal and Admin > Suppliers)
//
// ERP not reachable / no connector active: the file stays in the inbox with status "waiting" and is retried
// automatically (the ERP writes are idempotent: applying the same file twice gives the same result). With several
// target ERPs, a reachable ERP is written at once and the file waits only for the other one; it is completed
// automatically when that ERP is back (a target that is done is never written twice).
// =====================================================================================================

// File system and paths.
import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
// join builds file paths.
import { join } from 'node:path';
// Checksums of delivered files.
import { createHash } from 'node:crypto';
// ERP client of a connector and its error class (status + retryable flag).
import { clientFor } from './erpClient.js';
// The shop's active SAP connector (its shop is updated right away) and all connectors (possible target ERPs).
import { getActiveConnector, listConnectors } from './connectors.js';
// A fresh shop sync after the ERP was changed.
import { syncAfterErpChange } from './erpSync.js';
// Translation of supplier files into canonical products.
import { parseRecords, resolveMapping, toCanonical } from './supplierFormats.js';
// Suppliers, folders and the delivery log.
import { listSuppliers, getSupplier, supplierDirs, listSupplierFiles, createDelivery, openDelivery, updateDelivery } from './suppliers.js';
// Target ERPs of the supplier data (admin setting) and the later update of a delivery's summary.
import { resolveTargets, getTargetSetting, connectorKind, updateDeliverySummary } from './suppliers.js';

// Same settle rule as the Lab 2 inbox: files that changed less than this ago may still be uploading.
const SETTLE_MS = Number(process.env.FILE_SETTLE_MS ?? 2000);
// Waiting files (ERP down) are retried at most this often (seconds).
const RETRY_S = Number(process.env.SUPPLIER_RETRY_S ?? 30);
// Last attempt per waiting file ("<supplier>/<file>" -> ms).
const lastAttempt = new Map();
// Currencies the shop sells in (a cart cannot mix currencies, so other currencies are rejected, not converted).
const SHOP_CURRENCIES = (process.env.SHOP_CURRENCIES || 'EUR').split(',').map(c => c.trim().toUpperCase());

// Time stamp prefix for archived files: 20261026T154200Z.
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// SHA-256 of the file content.
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Moves a file out of the inbox into processed/ or error/ with a time stamp prefix (no overwriting).
function archive(dirs, folder, name) {
  // Portal uploads already start with a time stamp; other files get one (archive sorted by arrival).
  const target = /^\d{8}T\d{6}Z_/.test(name) ? name : `${stamp()}_${name}`;
  // Final name: the target name, or with a counter in front if that name exists already.
  let final = target;
  // Never overwrite an archived file.
  for (let n = 2; existsSync(join(dirs[folder], final)); n++) final = `${n}_${target}`;
  // Move out of the inbox (rename within the same file system).
  renameSync(join(dirs.inbox, name), join(dirs[folder], final));
  // The archived name (stored in the delivery summary).
  return final;
}

// Status of one target ERP of a file (summary.targets[<connector id>].status):
//   pending   - not written yet               waiting  - the ERP was not reachable, retried with the file
//   applied   - the ERP was changed           unchanged - the ERP had these values already
//   rejected  - the ERP refused the data, or the file was rejected (then no open target is written any more)
// Open = still to be written.
const OPEN = new Set(['pending', 'waiting']);
// Done = written (or nothing to write).
const isDone = t => t.status === 'applied' || t.status === 'unchanged';

// Counters over all targets (for the poller log and the lists); per target they are in summary.targets.
function totals(targets) {
  // No target chosen yet (e.g. the file was rejected before the ERP step): no counters.
  if (!targets) return {};
  // [connector id, target] pairs.
  const list = Object.entries(targets);
  // Sum of one counter over all targets.
  const sum = k => list.reduce((n, [, t]) => n + (t[k] || 0), 0);
  return {
    // e.g. 3 new in the local ERP + 3 new in SAP BTP = 6 writes.
    created: sum('created'), updated: sum('updated'), unchanged: sum('unchanged'),
    // Ids of the target ERPs, e.g. "local, btp".
    connector: list.map(([id]) => id).join(', '),
    // The changes; with several targets each one starts with the ERP's name (at most 50).
    changes: list.flatMap(([, t]) => (t.changes || []).map(c => (list.length > 1 ? `${t.name}: ${c}` : c))).slice(0, 50),
  };
}

// One line per target ERP in the acknowledgement, e.g. "applied: 2 new, 1 updated, 5 unchanged".
const targetLine = t => (isDone(t) ? `${t.status}: ${t.created || 0} new, ${t.updated || 0} updated, ${t.unchanged || 0} unchanged`
  // Not written: the reason.
  : `${t.status}${t.error ? ` - ${t.error}` : ''}`);

// Result line of the acknowledgement per final status.
const RESULT = { applied: 'APPLIED', unchanged: 'NO CHANGES', partial: 'PARTLY APPLIED - see "Systems" below', rejected: 'REJECTED - nothing was changed' };

// Writes the acknowledgement for the supplier into its outbox (readable in the portal and via FTP).
function acknowledge(dirs, delivery, supplier, outcome) {
  // Applied / unchanged = OK; rejected / partial = not OK (the supplier should look at the problems).
  const ok = isDone(outcome);
  // The target ERPs of the file (empty if it was rejected before the ERP step).
  const targets = Object.values(outcome.summary?.targets || {});
  // The report as lines of plain text (readable in any editor, in the portal and via FTP).
  const lines = [
    // Header: who, what, when, result.
    `VeloCity Bike Shop - acknowledgement of your delivery`,
    `Supplier:  ${supplier.name} (${supplier.id})`,
    `File:      ${delivery.original_name || delivery.file_name}`,
    `Received:  ${delivery.received_at} UTC (${delivery.channel}${delivery.username ? `, ${delivery.username}` : ''})`,
    `Result:    ${RESULT[outcome.status] || outcome.status}`,
    // Empty line.
    '',
    // How the file was read (format, encoding, separator / record path).
    ...(outcome.info ? [`Format:    ${outcome.format} ${Object.entries(outcome.info).map(([k, v]) => `${k}=${v}`).join(', ')}`] : []),
    // Which supplier field fed which VeloCity field.
    ...(outcome.mapping ? ['Mapping:', ...Object.entries(outcome.mapping).map(([k, v]) => `  ${k.padEnd(12)} <- ${v}`)] : []),
    // Counters: one target ERP -> in the product line, several -> one line per system.
    ...(targets.length === 1 && ok ? ['', `Products:  ${outcome.rows} (${targets[0].created || 0} new, ${targets[0].updated || 0} updated, ${targets[0].unchanged || 0} unchanged)`] : []),
    ...(targets.length > 1 ? ['', `Products:  ${outcome.rows}`, 'Systems:', ...targets.map(t => `  ${t.name}: ${targetLine(t)}`)] : []),
    // All problems (rejected files) ...
    ...(outcome.errors?.length ? ['', 'Problems:', ...outcome.errors.map(e => `  - ${e}`)] : []),
    // ... and remarks (e.g. unused fields).
    ...(outcome.warnings?.length ? ['', 'Remarks:', ...outcome.warnings.map(w => `  - ${w}`)] : []),
    // What to do with a rejected file (delivering it again is safe: values already applied stay unchanged).
    ...(ok ? [] : ['', 'Please correct the file and deliver it again (portal upload or FTP /inbox).']),
  ];
  // <file>.ack.txt for accepted files, <file>.error.txt for rejected ones, in the supplier's outbox.
  writeFileSync(join(dirs.outbox, `${delivery.file_name}.${ok ? 'ack' : 'error'}.txt`), lines.join('\n') + '\n');
}

// ERP product -> comparable values (the REST API returns the price as text, e.g. "1200.00").
const erpValues = e => ({ name: e.name ?? '', description: e.description ?? '', price: Number(e.price), currency: e.currency || 'EUR', stock: Number(e.stock) });

/**
 * Plans the ERP writes for the canonical products (no writes yet). Returns { creates, updates, unchanged, errors }:
 * creates = OData bodies for POST /Products, updates = [{ id, productID, body }] for PATCH /Products(<id>).
 */
function plan(products, erpProducts, profile) {
  // ERP products by business key.
  const byId = new Map(erpProducts.map(e => [String(e.productID).toUpperCase(), e]));
  // The planned writes and the problems found.
  const creates = [], updates = [], unchanged = [], errors = [];
  // Fields this supplier may change on existing products (default: all).
  const allowed = new Set(profile.update || ['name', 'description', 'price', 'stock']);
  // Every product of the file.
  for (const p of products) {
    // A price in a currency the shop does not sell in.
    if (p.currency && !SHOP_CURRENCIES.includes(p.currency)) {
      // Problem message with the line / record of the file.
      errors.push(`${p.line}: ${p.productID} has the currency ${p.currency} - VeloCity only accepts ${SHOP_CURRENCIES.join(', ')}`);
      // Next product.
      continue;
    }
    // The product in the ERP (undefined = new product).
    const e = byId.get(p.productID);
    // Not in the ERP yet:
    if (!e) {
      // New product: only if the supplier may create products, and only with name and price.
      if (profile.createProducts === false) { errors.push(`${p.line}: ${p.productID} does not exist in the ERP (this supplier may not create new products)`); continue; }
      // Name and price are needed to create a product.
      if (!p.name) errors.push(`${p.line}: ${p.productID} is a new product - a name is required`);
      if (p.price === undefined) errors.push(`${p.line}: ${p.productID} is a new product - a price is required`);
      // OData body of the new product (ERP field names; currency_code = key of the Currency association).
      creates.push({ productID: p.productID, name: p.name, description: p.description ?? null, price: p.price,
                     currency_code: p.currency || profile.defaultCurrency || 'EUR', stock: p.stock ?? 0 });
      // Next product.
      continue;
    }
    // Existing product: only allowed fields that the file provides and that differ from the ERP's value.
    const cur = erpValues(e);
    // PATCH body: only the fields that change.
    const body = {};
    // Text fields: only if the supplier may change them and the value differs.
    if (allowed.has('name') && p.name !== undefined && p.name !== cur.name) body.name = p.name;
    if (allowed.has('description') && p.description !== undefined && p.description !== cur.description) body.description = p.description;
    // Price and currency together (the currency belongs to the amount).
    if (allowed.has('price') && p.price !== undefined && (p.price !== cur.price || p.currency !== cur.currency)) {
      // New price.
      body.price = p.price;
      // Currency of the new price (key of the ERP's Currency association).
      body.currency_code = p.currency;
    }
    // Stock.
    if (allowed.has('stock') && p.stock !== undefined && p.stock !== cur.stock) body.stock = p.stock;
    // Something changes: PATCH; the old values are kept for the change log.
    if (Object.keys(body).length) updates.push({ id: e.ID, productID: p.productID, body, before: cur });
    // Nothing changes.
    else unchanged.push(p.productID);
  }
  // The plan; nothing has been written yet.
  return { creates, updates, unchanged, errors };
}

/** Processes ONE file of a supplier's inbox. Returns the delivery outcome (also stored in supplier_deliveries). */
async function processFile(supplier, file, { force }) {
  // The supplier's folders.
  const dirs = supplierDirs(supplier.id);
  // Key for the retry timer of this file.
  const key = `${supplier.id}/${file}`;
  // Delivery row: recorded when the file arrived (portal / FTP), or created now (file copied into the folder).
  let delivery = openDelivery(supplier.id, file);
  // Copied into the folder by hand (or the row is missing): record the delivery now.
  if (!delivery) {
    // Channel 'folder' = neither portal nor FTP.
    const id = createDelivery({ supplierId: supplier.id, channel: 'folder', fileName: file, originalName: file });
    // Reload the row (the fallback object is only used if the reload fails).
    delivery = openDelivery(supplier.id, file) || { id, file_name: file, original_name: file, channel: 'folder', received_at: new Date().toISOString() };
  }
  // A waiting file is retried only every RETRY_S seconds (unless forced by an admin / a new upload).
  if (!force && delivery.status === 'waiting' && Date.now() - (lastAttempt.get(key) || 0) < RETRY_S * 1000) return null;
  // Remember this attempt.
  lastAttempt.set(key, Date.now());

  // The file content.
  const buffer = readFileSync(join(dirs.inbox, file));
  // Checksum for the delivery log.
  const checksum = sha256(buffer);
  // The supplier's mapping profile (format, separator, field names, rights).
  const profile = supplier.profile;
  // Result collected step by step.
  const out = { file, originalName: delivery.original_name || file, errors: [], warnings: [] };
  // Target ERPs of an earlier attempt (a waiting file keeps its targets and what was already written), or null.
  let targets = null;
  // The summary of the waiting delivery is JSON text; a broken value counts as "no earlier attempt".
  try { targets = JSON.parse(delivery.summary || '{}').targets || null; } catch { targets = null; }

  // Summary stored in the delivery log: counters, per-target results, how the file was read.
  const summarize = extra => ({ ...totals(targets), ...extra, mapping: out.mapping, info: out.info, ...(targets ? { targets } : {}) });
  // Ends the processing: file -> processed/ or error/, final delivery row, acknowledgement for the supplier.
  const finish = folder => {
    // Archive the file (it leaves the inbox: no more attempts).
    const moved = archive(dirs, folder, file);
    // Counters and per-target results for the caller.
    out.summary = summarize({ movedTo: `${folder}/${moved}` });
    // Store the final result.
    updateDelivery(delivery.id, { status: out.status, format: out.format, rows: out.rows, checksum, errors: out.errors, warnings: out.warnings, summary: out.summary });
    // Report for the supplier (outbox).
    acknowledge(dirs, delivery, supplier, out);
    // Done: no more retries.
    lastAttempt.delete(key);
    // Result for the caller.
    return out;
  };
  // Rejects the file: nothing (more) is written to any ERP.
  const reject = () => {
    // Targets that are still open are not written any more.
    for (const t of Object.values(targets || {})) if (OPEN.has(t.status)) Object.assign(t, { status: 'rejected', error: 'not written - the file was rejected' });
    // partial = an ERP was already written in an earlier attempt / before the refusal; rejected = no ERP was changed.
    out.status = Object.values(targets || {}).some(isDone) ? 'partial' : 'rejected';
    // Archive in error/ and acknowledge.
    return finish('error');
  };
  // Keeps the file in the inbox for a later attempt (an ERP is down / no target ERP).
  const wait = reasons => {
    // Not final: the file stays in the inbox.
    out.status = 'waiting';
    // The reasons are shown in the portal and in Admin > Suppliers.
    out.errors = reasons;
    // Same reasons as at the last attempt: the poller does not log them again.
    out.repeated = delivery.status === 'waiting' && delivery.errors === JSON.stringify(reasons);
    // Counters and per-target results so far (targets already done are kept for the next attempt).
    out.summary = summarize({});
    // processed: false - processed_at stays empty.
    updateDelivery(delivery.id, { status: 'waiting', format: out.format, rows: out.rows, checksum, errors: out.errors, warnings: out.warnings,
                                  summary: out.summary, processed: false });
    // Result for the caller.
    return out;
  };

  // 1. Read and translate.
  let parsed;
  try {
    // Format detection + parsing (throws for unreadable files).
    parsed = parseRecords(buffer, delivery.original_name || file, profile);
  } catch (e) {
    // Unreadable: reject with the reason.
    out.errors.push(`the file cannot be read: ${e.message}`);
    // Nothing more to check.
    return reject();
  }
  // Remember how the file was read (for the log and the acknowledgement).
  out.format = parsed.format;
  // How the file was read (encoding, separator, record path).
  out.info = parsed.info;
  // Number of records in the file.
  out.rows = parsed.records.length;
  // Supplier field -> canonical field (profile or synonyms).
  const { mapping, errors: mappingErrors } = resolveMapping(parsed.fields, profile.fields);
  // Remember the mapping.
  out.mapping = mapping;
  // e.g. no product ID column: reject.
  if (mappingErrors.length) { out.errors.push(...mappingErrors); return reject(); }
  // Fields of the file that are not used (shown as a remark, e.g. "EAN, color").
  const unused = parsed.fields.filter(f => !Object.values(mapping).includes(f));
  if (unused.length) out.warnings.push(`not used: ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ', ...' : ''}`);
  // Convert and validate all values.
  const { products, errors } = toCanonical(parsed.records, mapping, profile);
  // Line problems of the parser and value problems.
  out.errors.push(...parsed.problems, ...errors);
  // A file without any product is useless (probably a failed export).
  if (!products.length && !out.errors.length) out.errors.push('the file contains no products');
  // All or nothing: any problem rejects the whole file.
  if (out.errors.length) return reject();

  // 2. Target ERPs: chosen at the first attempt (admin setting) and kept while the file waits.
  if (!targets) {
    // The connectors the setting points to now.
    const conns = resolveTargets();
    // No target (standalone shop / chosen connectors deleted): keep the file until there is one.
    if (!conns.length) return wait([getTargetSetting().mode === 'active'
      ? 'no SAP connector is active in the shop - the file will be processed when one is active'
      : 'none of the chosen target ERPs exists - the file will be processed when one is available']);
    // One entry per target ERP: name, local / cloud, status.
    targets = Object.fromEntries(conns.map(c => [c.id, { name: c.name, kind: connectorKind(c), status: 'pending' }]));
  }

  // 3. Plan every open target against its current ERP data (nothing is written yet).
  const plans = [];
  // Only targets that are not done yet (a waiting file continues where it stopped).
  for (const [id, t] of Object.entries(targets)) {
    // Done targets are not touched again.
    if (!OPEN.has(t.status)) continue;
    // The connector row (deleted meanwhile = this target can no longer be written).
    const conn = listConnectors().find(c => c.id === id);
    // The connector is gone: this target is not written.
    if (!conn) { Object.assign(t, { status: 'rejected', error: 'the SAP connector no longer exists' }); continue; }
    // The current name (it may have been renamed meanwhile).
    t.name = conn.name;
    try {
      // REST GET /rest/api/products() of this ERP, then the plan (create / update / unchanged, rights).
      plans.push({ id, t, conn, p: plan(products, await clientFor(conn).products(), profile) });
    } catch (e) {
      // ERP down: only this target waits - the others are written now.
      Object.assign(t, { status: 'waiting', error: `${e.message} - will be retried automatically` });
    }
  }
  // Problems of the plans (rights, missing name/price, currency): message -> names of the ERPs that report it.
  const problems = new Map();
  // Collect every problem of every plan once, with the names of the ERPs that report it.
  for (const { t, p } of plans) for (const e of p.errors) problems.set(e, [...(problems.get(e) || []), t.name]);
  // A problem that not every target ERP reports starts with the ERP's name (e.g. a product that exists only locally).
  for (const [e, names] of problems) out.errors.push(names.length < Object.keys(targets).length ? `${names.join(', ')}: ${e}` : e);
  // The ERPs with problems are marked (the other open targets are closed by reject() below).
  for (const { t, p } of plans) if (p.errors.length) Object.assign(t, { status: 'rejected', error: `${p.errors.length} problem(s) with this ERP's data - see the problems` });
  // All or nothing: any problem rejects the file - still nothing has been written in this attempt.
  if (out.errors.length) return reject();

  // 4. Write to every reachable target ERP: new products first, then the updates.
  // The targets that received changes in this attempt (their shops have to be updated).
  const written = [];
  // One target ERP after the other.
  for (const { t, conn, p } of plans) {
    // ERP client of this target.
    const api = clientFor(conn);
    // Changes written by an earlier attempt of this target (it waited after some writes).
    const before = (t.created || 0) + (t.updated || 0);
    // Counters continue from the earlier attempt.
    t.created ||= 0; t.updated ||= 0; t.changes ||= [];
    // Products written earlier now count as unchanged in the plan: they are not counted twice.
    t.unchanged = Math.max(0, p.unchanged.length - before);
    try {
      // New products first.
      for (const body of p.creates) {
        // OData POST /Products (not retried automatically).
        await api.createProduct(body);
        // Count it.
        t.created++;
        // At most 50 change descriptions are kept (counters are complete).
        if (t.changes.length < 50) t.changes.push(`${body.productID}: new (${body.name}, ${body.price} ${body.currency_code}, stock ${body.stock})`);
      }
      // Then the changed products.
      for (const u of p.updates) {
        // OData PATCH /Products(<uuid>) with the changed fields only.
        await api.updateProduct(u.id, u.body);
        // Count it.
        t.updated++;
        // e.g. "HLMT0100: price 89.9 -> 84.9, stock 40 -> 52".
        if (t.changes.length < 50) t.changes.push(`${u.productID}: ` + Object.entries(u.body).filter(([k]) => k !== 'currency_code')
          .map(([k, v]) => `${k} ${u.before[k] ?? '-'} -> ${v}`).join(', '));
      }
      // applied = this ERP was changed (now or in an earlier attempt); unchanged = it had the values already.
      t.status = t.created + t.updated ? 'applied' : 'unchanged';
      // No open reason any more.
      delete t.error;
    } catch (e) {
      // ERP down in the middle: this target waits; writing it again later is safe (same values).
      if (e.retryable || e.status === 503) Object.assign(t, { status: 'waiting', error: `${e.message} after ${t.created + t.updated - before} change(s) - will be retried` });
      // The ERP refused a value (4xx): this target is rejected.
      else Object.assign(t, { status: 'rejected', error: `the ERP refused a change: ${e.message}` });
    }
    // Something was written in this attempt: the shop connected to this ERP has to be updated.
    if (t.created + t.updated > before) written.push({ conn, t });
  }

  // 5. How the shops receive the change: this shop syncs its active connector right away (below); a shop on another
  //    target ERP (e.g. the cloud shop on SAP BTP) takes the change with its own regular ERP sync.
  const active = getActiveConnector();
  // Note for the targets that are not this shop's active connector.
  for (const { conn, t } of written) if (conn.id !== active?.id) t.shop = `next ERP sync of the shop connected to ${conn.name}`;

  // 6. Result of the file over all targets.
  const list = Object.values(targets);
  // An ERP refused the data: the file is finished (rejected, or partial if another ERP was written).
  if (list.some(t => t.status === 'rejected')) {
    // The reasons, with the ERP's name.
    out.errors.push(...list.filter(t => t.status === 'rejected' && t.error).map(t => `${t.name}: ${t.error}`));
    // Archive in error/ and acknowledge (open targets are closed).
    reject();
  // An ERP is not reachable: the file waits for it (the other targets are done and stay done).
  } else if (list.some(t => OPEN.has(t.status))) {
    // One reason per waiting ERP.
    wait(list.filter(t => OPEN.has(t.status)).map(t => `${t.name}: ${t.error || 'waiting'}`));
  // All targets done.
  } else {
    // applied = at least one ERP was changed; unchanged = every ERP had these values already.
    out.status = list.some(t => t.status === 'applied') ? 'applied' : 'unchanged';
    // Archive in processed/ and acknowledge.
    finish('processed');
  }

  // 7. Shop update through the ERP (in the background - the delivery is complete for the supplier).
  for (const { conn } of written) {
    // Only this shop's active connector; the other targets were noted above.
    if (conn.id !== active?.id) continue;
    // Start a fresh shop sync after the ERP change.
    syncAfterErpChange(conn).then(r => {
      // How the shop received the change.
      const via = r?.mode === 'file' ? `ERP export file ${r.export?.file || ''} -> shop import` : 'API sync (REST)';
      // Stored in the delivery (only the summary; status and counters stay as they are).
      updateDeliverySummary(delivery.id, s => { s.shop = via; if (s.targets?.[conn.id]) s.targets[conn.id].shop = via; });
    // A failed sync is retried by the background sync anyway.
    }).catch(e => console.warn(`[supplier] shop sync after ${file} failed: ${e.message}`));
  }
  // The outcome of this file.
  return out;
}

// All supplier processing runs one after the other (poller, uploads, FTP and the admin button may overlap).
let queue = Promise.resolve();

/**
 * Processes the inboxes of all active suppliers (or of one supplier). settle: skip files that are still being written;
 * force: retry waiting files immediately. Returns the outcomes of the processed files.
 */
export function processSupplierInboxes({ supplierId = null, settle = false, force = false } = {}) {
  // Wait for the previous run, then process the inboxes as they are now.
  const run = queue.then(async () => {
    // Outcomes of all files of this run.
    const results = [];
    // One supplier, or all suppliers.
    for (const s of supplierId ? [getSupplier(supplierId)] : listSuppliers()) {
      // Inactive suppliers are skipped (their files wait).
      if (!s.active) continue;
      // Folders of the supplier.
      const dirs = supplierDirs(s.id);
      // One "now" for the settle check.
      const now = Date.now();
      // Files of the inbox, oldest first.
      for (const f of listSupplierFiles(dirs.inbox)) {
        // Still being written (e.g. a large FTP upload)? Then next time.
        if (settle && now - f.mtimeMs < SETTLE_MS) continue;
        try {
          // Process the file (null = waiting file, retry not due yet).
          const r = await processFile(s, f.name, { force });
          // Collect the outcome with the supplier id.
          if (r) results.push({ supplier: s.id, ...r });
        } catch (e) {
          // Unexpected error (e.g. file locked): log it, continue with the next file.
          console.warn(`[supplier] ${s.id}/${f.name}: ${e.message}`);
        }
      }
    }
    // All outcomes.
    return results;
  });
  // The queue continues even if this run failed.
  queue = run.catch(() => {});
  // The caller gets the outcomes of its run.
  return run;
}

// Short result of a file for the console, e.g. "Local Mini-ERP: 2 new, 1 updated; SAP BTP: waiting".
function describe(r) {
  // The target ERPs of the file (none if it was rejected before the ERP step).
  const targets = Object.values(r.summary?.targets || {});
  // Rejected before the ERP step / no target yet: the first problem.
  if (!targets.length) return r.errors[0] || '';
  // Per target: counters, or the status.
  const each = targets.map(t => `${t.name}: ${isDone(t) ? `${t.created || 0} new, ${t.updated || 0} updated` : t.status}`).join('; ');
  // Waiting / refused: also the first reason.
  return r.status === 'applied' || r.status === 'unchanged' ? each : `${each} (${r.errors[0] || ''})`;
}

/** Starts the poller of the supplier inboxes (index.js), every FILE_POLL_INTERVAL_S seconds. */
export function startSupplierPoller() {
  // Same interval as the Lab 2 inbox (default 10 s; 0 = off).
  const seconds = Number(process.env.FILE_POLL_INTERVAL_S ?? 10);
  // Create the folders of all suppliers right away (they can be opened in the file explorer immediately).
  for (const s of listSuppliers()) supplierDirs(s.id);
  // Switched off.
  if (seconds <= 0) return;
  // Check all supplier inboxes regularly.
  setInterval(async () => {
    try {
      // settle: true - leave files that are still being written.
      for (const r of await processSupplierInboxes({ settle: true })) {
        // A file that is still waiting for the same reason is not logged again.
        if (r.repeated) continue;
        // One console line per processed file.
        console.log(`[supplier] ${r.supplier}/${r.originalName}: ${r.status} - ${describe(r)}`);
      }
    } catch (e) {
      // Unexpected error: log it, the next tick tries again.
      console.warn(`[supplier] processing failed: ${e.message}`);
    }
  // unref: the timer alone does not keep Node.js running.
  }, seconds * 1000).unref();
}
