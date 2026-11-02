import { extname } from 'node:path';
import { parseCsv, detectDelimiter, MAX_FILE_BYTES } from './productFile.js';
import { readXlsxRows } from './xlsxReader.js';

export const FORMATS = ['auto', 'csv', 'xlsx', 'json', 'xml'];
export const FIELDS = ['productID', 'name', 'description', 'price', 'currency', 'stock'];
export const UPDATABLE = ['name', 'description', 'price', 'stock'];
const LIMITS = { productID: 50, name: 100, description: 500, price: 99999999.99, stock: 1000 };
const MAX_ERRORS = 50;

export function detectFormat(fileName, buffer, preferred = 'auto') {
  if (preferred && preferred !== 'auto') return preferred;
  const ext = extname(String(fileName)).slice(1).toLowerCase();
  if (['csv', 'txt', 'tsv', 'tab', 'dat'].includes(ext)) return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (['json', 'ndjson', 'jsonl'].includes(ext)) return 'json';
  if (ext === 'xml') return 'xml';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';
  const head = buffer.subarray(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) return 'xml';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'csv';
}

function decodeText(buffer) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'Windows-1252' };
  }
}

function rowsToRecords(rows, { strictColumns }) {
  const nonEmpty = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (!nonEmpty.length) throw new Error('the file contains no data');
  const header = nonEmpty[0].map(h => String(h).trim());
  const records = [];
  const problems = [];
  for (const cells of nonEmpty.slice(1)) {
    if (strictColumns && cells.length !== header.length) {
      problems.push(`line ${cells.line}: expected ${header.length} values, found ${cells.length}` +
        (cells.length > header.length ? ' (a value contains the separator without quotes?)' : ''));
      continue;
    }
    const values = {};
    header.forEach((h, i) => { if (h) values[h] = cells[i] ?? ''; });
    records.push({ line: cells.line, values });
  }
  return { records, problems, fields: header.filter(Boolean) };
}

function flattenJson(value, prefix = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(value)) {
    if (value.every(v => v === null || typeof v !== 'object')) out[prefix] = value.join(', ');
    else value.forEach((v, i) => flattenJson(v, `${prefix}.${i}`, out));
  } else if (prefix) {
    out[prefix] = value ?? '';
  }
  return out;
}

const followPath = (doc, path) => path.split('.').filter(Boolean).reduce((v, k) => (v == null ? v : v[k]), doc);

function findRecordArray(doc) {
  const queue = [[doc, '']];
  while (queue.length) {
    const [v, path] = queue.shift();
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && !Array.isArray(x))) return { list: v, path };
    if (v && typeof v === 'object' && !Array.isArray(v))
      for (const [k, x] of Object.entries(v)) queue.push([x, path ? `${path}.${k}` : k]);
  }
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? { list: [doc], path: '' } : null;
}

function parseJson(text, recordPath) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const lines = text.split(/\r?\n/).map((l, i) => [l.trim(), i + 1]).filter(([l]) => l);
    try {
      return { records: lines.map(([l, line]) => ({ line, values: flattenJson(JSON.parse(l)) })), problems: [], path: '(JSON lines)' };
    } catch {
      throw new Error(`invalid JSON - ${e.message}`);
    }
  }
  const found = recordPath ? { list: followPath(doc, recordPath), path: recordPath } : findRecordArray(doc);
  if (!found || !Array.isArray(found.list)) throw new Error(recordPath ? `no list found at "${recordPath}"` : 'no list of products found in the JSON document');
  return { records: found.list.map((r, i) => ({ line: `record ${i + 1}`, values: flattenJson(r) })), problems: [], path: found.path };
}

const decodeXml = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const localName = n => n.includes(':') ? n.split(':').pop() : n;

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
    if (chunk.trim()) stack.at(-1).text += decodeXml(chunk);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) { i = text.indexOf('-->', lt); if (i < 0) throw new Error('comment not closed'); i += 3; continue; }
    if (text.startsWith('<?', lt)) { i = text.indexOf('?>', lt); if (i < 0) throw new Error('processing instruction not closed'); i += 2; continue; }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end < 0) throw new Error('CDATA section not closed');
      stack.at(-1).text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const bracket = text.indexOf('[', lt), close = text.indexOf('>', lt);
      const end = bracket >= 0 && bracket < close ? text.indexOf(']>', bracket) : close;
      if (end < 0) throw new Error('DOCTYPE not closed');
      i = end + (bracket >= 0 && bracket < close ? 2 : 1);
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (!m) throw new Error(`invalid tag at position ${lt}`);
    i = lt + m[0].length;
    const [, closing, name, attrText, selfClosing] = m;
    if (closing) {
      if (stack.length < 2 || stack.at(-1).name !== name) throw new Error(`unexpected </${name}>`);
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[localName(a[1])] = decodeXml(a[2] ?? a[3]);
    const el = { name, attrs, children: [], text: '' };
    stack.at(-1).children.push(el);
    if (!selfClosing) stack.push(el);
  }
  if (stack.length !== 1) throw new Error(`<${stack.at(-1).name}> is not closed (file cut off?)`);
  if (root.children.length !== 1) throw new Error('the XML document must have exactly one root element');
  return root.children[0];
}

function flattenXml(el, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(el.attrs)) out[`${prefix}@${k}`] = v;
  for (const c of el.children) {
    const key = prefix ? `${prefix}.${localName(c.name)}` : localName(c.name);
    if (c.children.length) flattenXml(c, key, out);
    else { out[key] = c.text.trim(); for (const [k, v] of Object.entries(c.attrs)) out[`${key}@${k}`] = v; }
  }
  return out;
}

const allElements = (el, out = []) => { out.push(el); el.children.forEach(c => allElements(c, out)); return out; };

function parseXmlRecords(text, recordPath) {
  const rootEl = parseXml(text);
  const elements = allElements(rootEl);
  let recordName = recordPath ? localName(recordPath.split(/[/.]/).pop()) : null;
  if (!recordName) {
    const counts = new Map();
    for (const e of elements.slice(1)) if (e.children.length) counts.set(localName(e.name), (counts.get(localName(e.name)) || 0) + 1);
    recordName = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  const list = elements.filter(e => localName(e.name) === recordName);
  if (!recordName || !list.length) throw new Error(recordPath ? `no <${recordName}> elements found` : 'no repeated product elements found in the XML document');
  return { records: list.map((e, i) => ({ line: `<${recordName}> ${i + 1}`, values: flattenXml(e) })), problems: [], path: recordName };
}

export function parseRecords(buffer, fileName, profile = {}) {
  if (!buffer.length) throw new Error('the file is empty (0 bytes)');
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`the file is too large (${buffer.length} bytes, max. ${MAX_FILE_BYTES})`);
  if (buffer.readUInt32BE(0) === 0xd0cf11e0) throw new Error('old Excel format (.xls) - please save the file as .xlsx or CSV');
  const format = detectFormat(fileName, buffer, profile.format);
  let result;
  if (format === 'xlsx') {
    const rows = readXlsxRows(buffer).map((cells, i) => Object.assign(cells, { line: i + 1 }));
    result = { ...rowsToRecords(rows, { strictColumns: false }), info: { sheet: 'first worksheet' } };
  } else {
    const { text, encoding } = decodeText(buffer);
    if (format === 'json') {
      const r = parseJson(text, profile.recordPath);
      result = { records: r.records, problems: r.problems, info: { encoding, recordPath: r.path || '(top level)' } };
    } else if (format === 'xml') {
      const r = parseXmlRecords(text, profile.recordPath);
      result = { records: r.records, problems: r.problems, info: { encoding, recordElement: r.path } };
    } else {
      const delimiter = profile.delimiter ? profile.delimiter.replace('\\t', '\t') : detectDelimiter(text);
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('the file contains an HTML page instead of data');
      const rows = parseCsv(text, delimiter);
      result = { ...rowsToRecords(rows, { strictColumns: true }), info: { encoding, delimiter: delimiter === '\t' ? 'TAB' : delimiter } };
    }
  }
  const fields = result.fields || [...new Set(result.records.flatMap(r => Object.keys(r.values)))];
  return { format, records: result.records, fields, problems: result.problems, info: result.info };
}

export const normalizeKey = k => String(k).toLowerCase()
  .replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9.@]/g, '');

const SYNONYMS = {
  productID: ['productid', 'sku', 'articleno', 'articlenumber', 'artikelnummer', 'artikelnr', 'artnr', 'itemno', 'itemnumber',
              'itemcode', 'itemid', 'partno', 'partnumber', 'productcode', 'productno', 'materialnumber', 'materialnr',
              'code', '@id', 'id'],
  name: ['name', 'productname', 'title', 'bezeichnung', 'artikelbezeichnung', 'artikelname', 'produktname', 'itemname'],
  description: ['description', 'productdescription', 'beschreibung', 'artikelbeschreibung', 'longdescription', 'langtext',
                'details', 'text'],
  price: ['price', 'unitprice', 'netprice', 'listprice', 'salesprice', 'unitprice.amount', 'price.amount', 'price.value',
          'preis', 'verkaufspreis', 'vkpreis', 'einzelpreis', 'nettopreis', 'amount'],
  currency: ['currency', 'currencycode', 'curr', 'unitprice.currency', 'price.currency', 'price@currency', 'unitprice@currency',
             'wahrung', 'waehrung'],
  stock: ['stock', 'qty', 'quantity', 'available', 'availableqty', 'qtyavailable', 'onhand', 'instock', 'inventory.available',
          'stock.available', 'inventory', 'bestand', 'lagerbestand', 'verfugbar', 'menge'],
};

export function resolveMapping(fileFields, profileFields = {}) {
  const mapping = {};
  const errors = [];
  const byNorm = new Map();
  for (const f of fileFields) if (!byNorm.has(normalizeKey(f))) byNorm.set(normalizeKey(f), f);
  const used = new Set();
  for (const field of FIELDS) {
    const wanted = profileFields?.[field];
    if (!wanted) continue;
    const found = byNorm.get(normalizeKey(wanted));
    if (found) { mapping[field] = found; used.add(found); }
    else errors.push(`the mapping profile expects the field "${wanted}" for ${field}, but the file has no such field`);
  }
  for (const field of FIELDS) {
    if (mapping[field] || profileFields?.[field]) continue;
    let best = null;
    for (const f of fileFields) {
      if (used.has(f)) continue;
      const norm = normalizeKey(f);
      const last = norm.split(/[.@]/).pop();
      const full = SYNONYMS[field].indexOf(norm);
      const part = SYNONYMS[field].indexOf(last);
      const score = full >= 0 ? full : part >= 0 ? 100 + part : null;
      if (score !== null && (!best || score < best.score)) best = { f, score };
    }
    if (best) { mapping[field] = best.f; used.add(best.f); }
  }
  if (!mapping.productID && !errors.length)
    errors.push(`no field for the product ID found (fields in the file: ${fileFields.slice(0, 15).join(', ') || 'none'}) - set it in the supplier's mapping profile`);
  return { mapping, errors };
}

const SYMBOLS = { '€': 'EUR', '$': 'USD', '£': 'GBP' };

export function parseAmount(value, decimal = 'auto') {
  if (typeof value === 'number') return Number.isFinite(value) ? { amount: value, currency: null } : null;
  let s = String(value ?? '').trim();
  if (!s) return null;
  let currency = null;
  const code = /\b([A-Za-z]{3})\b/.exec(s);
  if (code) { currency = code[1].toUpperCase(); s = s.replace(code[0], ''); }
  for (const [sym, iso] of Object.entries(SYMBOLS)) if (s.includes(sym)) { currency ??= iso; s = s.replace(sym, ''); }
  s = s.replace(/[\s ']/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  let dec = decimal;
  if (dec === 'auto') {
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) dec = lastComma > lastDot ? ',' : '.';
    else if (lastComma >= 0) dec = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? ',' : '.';
    else dec = '.';
  }
  const normalized = dec === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if ((normalized.match(/\./g) || []).length > 1) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? { amount, currency } : null;
}

function parseStock(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const s = String(value ?? '').trim().replace(/[.\s'](?=\d{3}\b)/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function toCanonical(records, mapping, profile = {}) {
  const products = [];
  const errors = [];
  const error = msg => { if (errors.length < MAX_ERRORS) errors.push(msg); else errors.overflow = (errors.overflow || 0) + 1; };
  const seen = new Map();
  for (const r of records) {
    const raw = f => (mapping[f] ? r.values[mapping[f]] : undefined);
    const text = f => String(raw(f) ?? '').trim();
    const at = `${typeof r.line === 'number' ? `line ${r.line}` : r.line}`;
    const productID = text('productID').toUpperCase();
    if (!productID) { error(`${at}: product ID is empty`); continue; }
    if (!/^[A-Z0-9_-]+$/.test(productID) || productID.length > LIMITS.productID)
      error(`${at}: invalid product ID "${productID}" (letters, digits, - or _, max. ${LIMITS.productID})`);
    if (seen.has(productID)) error(`${at}: product ${productID} appears twice (also in ${seen.get(productID)})`);
    seen.set(productID, at);
    const p = { line: at, productID };
    if (mapping.name && text('name')) {
      if (text('name').length > LIMITS.name) error(`${at} (${productID}): name is longer than ${LIMITS.name} characters`);
      p.name = text('name');
    }
    if (mapping.description && text('description')) {
      if (text('description').length > LIMITS.description) error(`${at} (${productID}): description is longer than ${LIMITS.description} characters`);
      p.description = text('description');
    }
    if (mapping.price && text('price') !== '') {
      const a = parseAmount(raw('price'), profile.decimal || 'auto');
      if (!a || a.amount < 0 || a.amount > LIMITS.price) error(`${at} (${productID}): price "${text('price')}" is not a valid amount`);
      else {
        const field = text('currency').toUpperCase();
        if (field && !/^[A-Z]{3}$/.test(field)) error(`${at} (${productID}): currency "${field}" is not a 3-letter code`);
        if (a.currency && field && a.currency !== field) error(`${at} (${productID}): price currency ${a.currency} differs from currency ${field}`);
        p.price = Math.round(a.amount * 100) / 100;
        p.currency = a.currency || field || profile.defaultCurrency || 'EUR';
      }
    }
    if (mapping.stock && text('stock') !== '') {
      const s = parseStock(raw('stock'));
      if (s === null) error(`${at} (${productID}): stock "${text('stock')}" is not a whole number`);
      else if (s > LIMITS.stock) error(`${at} (${productID}): stock ${s} is above the ERP limit of ${LIMITS.stock}`);
      else p.stock = s;
    }
    products.push(p);
  }
  if (errors.overflow) errors.push(`... and ${errors.overflow} more error(s)`);
  return { products, errors };
}
