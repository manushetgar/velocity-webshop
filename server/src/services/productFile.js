import { readXlsxRows } from './xlsxReader.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_ERRORS = 50;

const HEADER_ALIASES = {
  productid: 'productID',
  name: 'name', productname: 'name',
  description: 'description', productdescription: 'description',
  price: 'price',
  currency: 'currency', currencycode: 'currency',
  stock: 'stock',
};
const REQUIRED = ['productID', 'name', 'price'];
const LIMITS = { productID: 50, name: 100, description: 500 };

const normalizeHeader = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); row.line = rowLine; rows.push(row); row = []; rowLine = line; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; field += ch; }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) endRow();
  if (quoted) throw new Error(`line ${rowLine}: a quoted value is not closed (file cut off?)`);
  return rows;
}

export function detectDelimiter(text) {
  const header = text.split(/\r?\n/, 1)[0];
  const counts = [',', ';', '\t', '|'].map(d => [d, header.split(d).length - 1]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { amount: value, currency: null } : null;
  const m = /^(?:([A-Za-z]{3})\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:([A-Za-z]{3}))?$/.exec(String(value).trim());
  if (!m || (m[1] && m[3])) return null;
  return { amount: Number(m[2].replace(',', '.')), currency: (m[1] || m[3] || '').toUpperCase() || null };
}

export function parseProductFile(buffer, ext) {
  const errors = [];
  const warnings = [];
  const error = msg => { if (errors.length < MAX_ERRORS) errors.push(msg); else errors.overflow = (errors.overflow || 0) + 1; };
  const result = { products: [], errors, warnings, columns: [], lines: 0 };

  if (buffer.length === 0) { error('the file is empty (0 bytes) - transfer failed or export produced nothing'); return result; }
  if (buffer.length > MAX_FILE_BYTES) { error(`the file is too large (${buffer.length} bytes, max. ${MAX_FILE_BYTES})`); return result; }

  let rows;
  let delimiter = ',';
  try {
    if (ext === 'xlsx') {
      rows = readXlsxRows(buffer).map((cells, i) => Object.assign(cells, { line: i + 1 }));
    } else {
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      if (text.includes('\u0000') || text.startsWith('PK')) throw new Error('this is not a text (CSV) file');
      if (/^\s*</.test(text)) throw new Error('the file contains HTML/XML instead of CSV (error page of the ERP?)');
      delimiter = detectDelimiter(text);
      rows = parseCsv(text, delimiter);
    }
  } catch (e) {
    error(`invalid file format: ${e.message}`);
    return result;
  }
  rows = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (rows.length === 0) { error('the file contains no data'); return result; }

  const header = rows[0].map(h => String(h).trim());
  const fields = header.map(h => HEADER_ALIASES[normalizeHeader(h)]);
  result.columns = header;
  const unknown = header.filter((h, i) => h && !fields[i]);
  if (unknown.length) warnings.push(`ignored column(s): ${unknown.join(', ')}`);
  const duplicates = fields.filter((f, i) => f && fields.indexOf(f) !== i);
  if (duplicates.length) error(`column(s) appear twice: ${[...new Set(duplicates)].join(', ')}`);
  const missing = REQUIRED.filter(f => !fields.includes(f));
  if (missing.length) error(`missing required column(s): ${missing.join(', ')} (header: ${header.join(', ') || 'empty'})`);
  if (missing.length || duplicates.length) return result;
  const hasStock = fields.includes('stock');
  if (!hasStock) warnings.push('no stock column - the stock in the shop is not changed');

  const data = rows.slice(1);
  result.lines = data.length;
  if (data.length === 0) error('the file contains only the header and no products (empty export?)');
  if (data.length > MAX_ROWS) { error(`too many lines (${data.length}, max. ${MAX_ROWS})`); return result; }
  const seen = new Map();
  const descIndex = fields.indexOf('description');
  const repaired = [];

  for (let cells of data) {
    const at = `line ${cells.line}`;
    if (ext !== 'xlsx' && cells.length > header.length && descIndex >= 0) {
      const extra = cells.length - header.length;
      cells = Object.assign([...cells.slice(0, descIndex), cells.slice(descIndex, descIndex + extra + 1).join(delimiter),
                             ...cells.slice(descIndex + extra + 1)], { line: cells.line });
      repaired.push(cells.line);
    }
    if (ext !== 'xlsx' && cells.length !== header.length) {
      error(`${at}: expected ${header.length} values, found ${cells.length}` +
        (cells.length > header.length ? ' (a text contains the separator without quotes?)' : ''));
      continue;
    }
    const raw = {};
    fields.forEach((f, i) => { if (f) raw[f] = cells[i] ?? ''; });
    const str = f => String(raw[f] ?? '').trim();

    const productID = str('productID').toUpperCase();
    if (!productID) { error(`${at}: product ID is empty`); continue; }
    if (!/^[A-Z0-9_-]+$/.test(productID) || productID.length > LIMITS.productID)
      error(`${at}: invalid product ID "${productID}" (letters, digits, - or _, max. ${LIMITS.productID})`);
    if (seen.has(productID)) error(`${at}: product ID ${productID} appears twice (also in line ${seen.get(productID)})`);
    seen.set(productID, cells.line);

    const name = str('name');
    if (!name) error(`${at} (${productID}): name is empty`);
    else if (name.length > LIMITS.name) error(`${at} (${productID}): name is longer than ${LIMITS.name} characters`);

    const description = str('description');
    if (description.length > LIMITS.description) error(`${at} (${productID}): description is longer than ${LIMITS.description} characters`);

    const price = parsePrice(raw.price);
    if (str('price') === '') error(`${at} (${productID}): price is empty`);
    else if (!price) error(`${at} (${productID}): price "${str('price')}" is not a valid amount (e.g. 1200.00 EUR)`);

    const column = str('currency').toUpperCase();
    if (column && !/^[A-Z]{3}$/.test(column)) error(`${at} (${productID}): currency "${column}" is not a 3-letter code`);
    if (price?.currency && column && price.currency !== column)
      error(`${at} (${productID}): price currency ${price.currency} differs from currency column ${column}`);
    const currency = price?.currency || column || 'EUR';

    let stock;
    if (hasStock) {
      const s = typeof raw.stock === 'number' ? raw.stock : str('stock');
      if (s === '') error(`${at} (${productID}): stock is empty`);
      else if (!/^\d+$/.test(String(s))) error(`${at} (${productID}): stock "${s}" is not a whole number >= 0`);
      else stock = Number(s);
    }

    result.products.push({ productID, name, description: description || null, price: price?.amount, currency, stock });
  }
  if (repaired.length)
    warnings.push(`${repaired.length} line(s) had unquoted "${delimiter}" in the description (line ${repaired.slice(0, 10).join(', ')}` +
      `${repaired.length > 10 ? ', ...' : ''}) - repaired: the extra separators were taken as part of the description`);
  if (errors.overflow) errors.push(`... and ${errors.overflow} more error(s)`);
  return result;
}
