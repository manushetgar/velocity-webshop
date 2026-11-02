import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { clientFor } from './erpClient.js';
import { getActiveConnector, listConnectors } from './connectors.js';
import { syncAfterErpChange } from './erpSync.js';
import { parseRecords, resolveMapping, toCanonical } from './supplierFormats.js';
import { listSuppliers, getSupplier, supplierDirs, listSupplierFiles, createDelivery, openDelivery, updateDelivery } from './suppliers.js';
import { resolveTargets, getTargetSetting, connectorKind, updateDeliverySummary } from './suppliers.js';

const SETTLE_MS = Number(process.env.FILE_SETTLE_MS ?? 2000);
const RETRY_S = Number(process.env.SUPPLIER_RETRY_S ?? 30);
const lastAttempt = new Map();
const SHOP_CURRENCIES = (process.env.SHOP_CURRENCIES || 'EUR').split(',').map(c => c.trim().toUpperCase());

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const sha256 = data => createHash('sha256').update(data).digest('hex');

function archive(dirs, folder, name) {
  const target = /^\d{8}T\d{6}Z_/.test(name) ? name : `${stamp()}_${name}`;
  let final = target;
  for (let n = 2; existsSync(join(dirs[folder], final)); n++) final = `${n}_${target}`;
  renameSync(join(dirs.inbox, name), join(dirs[folder], final));
  return final;
}

const OPEN = new Set(['pending', 'waiting']);
const isDone = t => t.status === 'applied' || t.status === 'unchanged';

function totals(targets) {
  if (!targets) return {};
  const list = Object.entries(targets);
  const sum = k => list.reduce((n, [, t]) => n + (t[k] || 0), 0);
  return {
    created: sum('created'), updated: sum('updated'), unchanged: sum('unchanged'),
    connector: list.map(([id]) => id).join(', '),
    changes: list.flatMap(([, t]) => (t.changes || []).map(c => (list.length > 1 ? `${t.name}: ${c}` : c))).slice(0, 50),
  };
}

const targetLine = t => (isDone(t) ? `${t.status}: ${t.created || 0} new, ${t.updated || 0} updated, ${t.unchanged || 0} unchanged`
  : `${t.status}${t.error ? ` - ${t.error}` : ''}`);

const RESULT = { applied: 'APPLIED', unchanged: 'NO CHANGES', partial: 'PARTLY APPLIED - see "Systems" below', rejected: 'REJECTED - nothing was changed' };

function acknowledge(dirs, delivery, supplier, outcome) {
  const ok = isDone(outcome);
  const targets = Object.values(outcome.summary?.targets || {});
  const lines = [
    `VeloCity Bike Shop - acknowledgement of your delivery`,
    `Supplier:  ${supplier.name} (${supplier.id})`,
    `File:      ${delivery.original_name || delivery.file_name}`,
    `Received:  ${delivery.received_at} UTC (${delivery.channel}${delivery.username ? `, ${delivery.username}` : ''})`,
    `Result:    ${RESULT[outcome.status] || outcome.status}`,
    '',
    ...(outcome.info ? [`Format:    ${outcome.format} ${Object.entries(outcome.info).map(([k, v]) => `${k}=${v}`).join(', ')}`] : []),
    ...(outcome.mapping ? ['Mapping:', ...Object.entries(outcome.mapping).map(([k, v]) => `  ${k.padEnd(12)} <- ${v}`)] : []),
    ...(targets.length === 1 && ok ? ['', `Products:  ${outcome.rows} (${targets[0].created || 0} new, ${targets[0].updated || 0} updated, ${targets[0].unchanged || 0} unchanged)`] : []),
    ...(targets.length > 1 ? ['', `Products:  ${outcome.rows}`, 'Systems:', ...targets.map(t => `  ${t.name}: ${targetLine(t)}`)] : []),
    ...(outcome.errors?.length ? ['', 'Problems:', ...outcome.errors.map(e => `  - ${e}`)] : []),
    ...(outcome.warnings?.length ? ['', 'Remarks:', ...outcome.warnings.map(w => `  - ${w}`)] : []),
    ...(ok ? [] : ['', 'Please correct the file and deliver it again (portal upload or FTP /inbox).']),
  ];
  writeFileSync(join(dirs.outbox, `${delivery.file_name}.${ok ? 'ack' : 'error'}.txt`), lines.join('\n') + '\n');
}

const erpValues = e => ({ name: e.name ?? '', description: e.description ?? '', price: Number(e.price), currency: e.currency || 'EUR', stock: Number(e.stock) });

function plan(products, erpProducts, profile) {
  const byId = new Map(erpProducts.map(e => [String(e.productID).toUpperCase(), e]));
  const creates = [], updates = [], unchanged = [], errors = [];
  const allowed = new Set(profile.update || ['name', 'description', 'price', 'stock']);
  for (const p of products) {
    if (p.currency && !SHOP_CURRENCIES.includes(p.currency)) {
      errors.push(`${p.line}: ${p.productID} has the currency ${p.currency} - VeloCity only accepts ${SHOP_CURRENCIES.join(', ')}`);
      continue;
    }
    const e = byId.get(p.productID);
    if (!e) {
      if (profile.createProducts === false) { errors.push(`${p.line}: ${p.productID} does not exist in the ERP (this supplier may not create new products)`); continue; }
      if (!p.name) errors.push(`${p.line}: ${p.productID} is a new product - a name is required`);
      if (p.price === undefined) errors.push(`${p.line}: ${p.productID} is a new product - a price is required`);
      creates.push({ productID: p.productID, name: p.name, description: p.description ?? null, price: p.price,
                     currency_code: p.currency || profile.defaultCurrency || 'EUR', stock: p.stock ?? 0 });
      continue;
    }
    const cur = erpValues(e);
    const body = {};
    if (allowed.has('name') && p.name !== undefined && p.name !== cur.name) body.name = p.name;
    if (allowed.has('description') && p.description !== undefined && p.description !== cur.description) body.description = p.description;
    if (allowed.has('price') && p.price !== undefined && (p.price !== cur.price || p.currency !== cur.currency)) {
      body.price = p.price;
      body.currency_code = p.currency;
    }
    if (allowed.has('stock') && p.stock !== undefined && p.stock !== cur.stock) body.stock = p.stock;
    if (Object.keys(body).length) updates.push({ id: e.ID, productID: p.productID, body, before: cur });
    else unchanged.push(p.productID);
  }
  return { creates, updates, unchanged, errors };
}

async function processFile(supplier, file, { force }) {
  const dirs = supplierDirs(supplier.id);
  const key = `${supplier.id}/${file}`;
  let delivery = openDelivery(supplier.id, file);
  if (!delivery) {
    const id = createDelivery({ supplierId: supplier.id, channel: 'folder', fileName: file, originalName: file });
    delivery = openDelivery(supplier.id, file) || { id, file_name: file, original_name: file, channel: 'folder', received_at: new Date().toISOString() };
  }
  if (!force && delivery.status === 'waiting' && Date.now() - (lastAttempt.get(key) || 0) < RETRY_S * 1000) return null;
  lastAttempt.set(key, Date.now());

  const buffer = readFileSync(join(dirs.inbox, file));
  const checksum = sha256(buffer);
  const profile = supplier.profile;
  const out = { file, originalName: delivery.original_name || file, errors: [], warnings: [] };
  let targets = null;
  try { targets = JSON.parse(delivery.summary || '{}').targets || null; } catch { targets = null; }

  const summarize = extra => ({ ...totals(targets), ...extra, mapping: out.mapping, info: out.info, ...(targets ? { targets } : {}) });
  const finish = folder => {
    const moved = archive(dirs, folder, file);
    out.summary = summarize({ movedTo: `${folder}/${moved}` });
    updateDelivery(delivery.id, { status: out.status, format: out.format, rows: out.rows, checksum, errors: out.errors, warnings: out.warnings, summary: out.summary });
    acknowledge(dirs, delivery, supplier, out);
    lastAttempt.delete(key);
    return out;
  };
  const reject = () => {
    for (const t of Object.values(targets || {})) if (OPEN.has(t.status)) Object.assign(t, { status: 'rejected', error: 'not written - the file was rejected' });
    out.status = Object.values(targets || {}).some(isDone) ? 'partial' : 'rejected';
    return finish('error');
  };
  const wait = reasons => {
    out.status = 'waiting';
    out.errors = reasons;
    out.repeated = delivery.status === 'waiting' && delivery.errors === JSON.stringify(reasons);
    out.summary = summarize({});
    updateDelivery(delivery.id, { status: 'waiting', format: out.format, rows: out.rows, checksum, errors: out.errors, warnings: out.warnings,
                                  summary: out.summary, processed: false });
    return out;
  };

  let parsed;
  try {
    parsed = parseRecords(buffer, delivery.original_name || file, profile);
  } catch (e) {
    out.errors.push(`the file cannot be read: ${e.message}`);
    return reject();
  }
  out.format = parsed.format;
  out.info = parsed.info;
  out.rows = parsed.records.length;
  const { mapping, errors: mappingErrors } = resolveMapping(parsed.fields, profile.fields);
  out.mapping = mapping;
  if (mappingErrors.length) { out.errors.push(...mappingErrors); return reject(); }
  const unused = parsed.fields.filter(f => !Object.values(mapping).includes(f));
  if (unused.length) out.warnings.push(`not used: ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ', ...' : ''}`);
  const { products, errors } = toCanonical(parsed.records, mapping, profile);
  out.errors.push(...parsed.problems, ...errors);
  if (!products.length && !out.errors.length) out.errors.push('the file contains no products');
  if (out.errors.length) return reject();

  if (!targets) {
    const conns = resolveTargets();
    if (!conns.length) return wait([getTargetSetting().mode === 'active'
      ? 'no SAP connector is active in the shop - the file will be processed when one is active'
      : 'none of the chosen target ERPs exists - the file will be processed when one is available']);
    targets = Object.fromEntries(conns.map(c => [c.id, { name: c.name, kind: connectorKind(c), status: 'pending' }]));
  }

  const plans = [];
  for (const [id, t] of Object.entries(targets)) {
    if (!OPEN.has(t.status)) continue;
    const conn = listConnectors().find(c => c.id === id);
    if (!conn) { Object.assign(t, { status: 'rejected', error: 'the SAP connector no longer exists' }); continue; }
    t.name = conn.name;
    try {
      plans.push({ id, t, conn, p: plan(products, await clientFor(conn).products(), profile) });
    } catch (e) {
      Object.assign(t, { status: 'waiting', error: `${e.message} - will be retried automatically` });
    }
  }
  const problems = new Map();
  for (const { t, p } of plans) for (const e of p.errors) problems.set(e, [...(problems.get(e) || []), t.name]);
  for (const [e, names] of problems) out.errors.push(names.length < Object.keys(targets).length ? `${names.join(', ')}: ${e}` : e);
  for (const { t, p } of plans) if (p.errors.length) Object.assign(t, { status: 'rejected', error: `${p.errors.length} problem(s) with this ERP's data - see the problems` });
  if (out.errors.length) return reject();

  const written = [];
  for (const { t, conn, p } of plans) {
    const api = clientFor(conn);
    const before = (t.created || 0) + (t.updated || 0);
    t.created ||= 0; t.updated ||= 0; t.changes ||= [];
    t.unchanged = Math.max(0, p.unchanged.length - before);
    try {
      for (const body of p.creates) {
        await api.createProduct(body);
        t.created++;
        if (t.changes.length < 50) t.changes.push(`${body.productID}: new (${body.name}, ${body.price} ${body.currency_code}, stock ${body.stock})`);
      }
      for (const u of p.updates) {
        await api.updateProduct(u.id, u.body);
        t.updated++;
        if (t.changes.length < 50) t.changes.push(`${u.productID}: ` + Object.entries(u.body).filter(([k]) => k !== 'currency_code')
          .map(([k, v]) => `${k} ${u.before[k] ?? '-'} -> ${v}`).join(', '));
      }
      t.status = t.created + t.updated ? 'applied' : 'unchanged';
      delete t.error;
    } catch (e) {
      if (e.retryable || e.status === 503) Object.assign(t, { status: 'waiting', error: `${e.message} after ${t.created + t.updated - before} change(s) - will be retried` });
      else Object.assign(t, { status: 'rejected', error: `the ERP refused a change: ${e.message}` });
    }
    if (t.created + t.updated > before) written.push({ conn, t });
  }

  const active = getActiveConnector();
  for (const { conn, t } of written) if (conn.id !== active?.id) t.shop = `next ERP sync of the shop connected to ${conn.name}`;

  const list = Object.values(targets);
  if (list.some(t => t.status === 'rejected')) {
    out.errors.push(...list.filter(t => t.status === 'rejected' && t.error).map(t => `${t.name}: ${t.error}`));
    reject();
  } else if (list.some(t => OPEN.has(t.status))) {
    wait(list.filter(t => OPEN.has(t.status)).map(t => `${t.name}: ${t.error || 'waiting'}`));
  } else {
    out.status = list.some(t => t.status === 'applied') ? 'applied' : 'unchanged';
    finish('processed');
  }

  for (const { conn } of written) {
    if (conn.id !== active?.id) continue;
    syncAfterErpChange(conn).then(r => {
      const via = r?.mode === 'file' ? `ERP export file ${r.export?.file || ''} -> shop import` : 'API sync (REST)';
      updateDeliverySummary(delivery.id, s => { s.shop = via; if (s.targets?.[conn.id]) s.targets[conn.id].shop = via; });
    }).catch(e => console.warn(`[supplier] shop sync after ${file} failed: ${e.message}`));
  }
  return out;
}

let queue = Promise.resolve();

export function processSupplierInboxes({ supplierId = null, settle = false, force = false } = {}) {
  const run = queue.then(async () => {
    const results = [];
    for (const s of supplierId ? [getSupplier(supplierId)] : listSuppliers()) {
      if (!s.active) continue;
      const dirs = supplierDirs(s.id);
      const now = Date.now();
      for (const f of listSupplierFiles(dirs.inbox)) {
        if (settle && now - f.mtimeMs < SETTLE_MS) continue;
        try {
          const r = await processFile(s, f.name, { force });
          if (r) results.push({ supplier: s.id, ...r });
        } catch (e) {
          console.warn(`[supplier] ${s.id}/${f.name}: ${e.message}`);
        }
      }
    }
    return results;
  });
  queue = run.catch(() => {});
  return run;
}

function describe(r) {
  const targets = Object.values(r.summary?.targets || {});
  if (!targets.length) return r.errors[0] || '';
  const each = targets.map(t => `${t.name}: ${isDone(t) ? `${t.created || 0} new, ${t.updated || 0} updated` : t.status}`).join('; ');
  return r.status === 'applied' || r.status === 'unchanged' ? each : `${each} (${r.errors[0] || ''})`;
}

export function startSupplierPoller() {
  const seconds = Number(process.env.FILE_POLL_INTERVAL_S ?? 10);
  for (const s of listSuppliers()) supplierDirs(s.id);
  if (seconds <= 0) return;
  setInterval(async () => {
    try {
      for (const r of await processSupplierInboxes({ settle: true })) {
        if (r.repeated) continue;
        console.log(`[supplier] ${r.supplier}/${r.originalName}: ${r.status} - ${describe(r)}`);
      }
    } catch (e) {
      console.warn(`[supplier] processing failed: ${e.message}`);
    }
  }, seconds * 1000).unref();
}
