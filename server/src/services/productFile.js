// =====================================================================================================
// productFile.js - reads and validates a product file exported by the Mini-ERP (Lab 2, file transfer).
//
// Role in the architecture:
//  - fileTransfer.js moves files through the transfer folders; THIS module only answers the question
//    "what is in this file, and is it valid?". It does not touch the database or the file system, so it can be
//    tested with plain strings/buffers.
//  - Two formats are accepted:
//      1. CSV, as produced by the ERP's export function GET /rest/api/getProducts():
//           productID,name,description,price,stock
//           DXTR1000,MTB,,1200.00 EUR,25
//         (price and currency in ONE field, values NOT quoted - a description with a comma therefore produces
//         extra columns; see "repair" below). Quoted values ("a, b") and ';' as separator (Excel in German
//         locale) are accepted too.
//      2. XLSX, as produced by the "Export to Spreadsheet" button of the ERP's Fiori app "Manage Products"
//         (column headers: Product ID, Product Name, Product Description, Price, Stock).
//  - Error handling: the file is checked completely and ALL problems are collected with their line numbers.
//    fileTransfer.js imports a file only if there is no error at all ("all or nothing"), because the file is
//    a full snapshot of the ERP's product list - importing half of it would hide the products whose lines
//    were broken.
// =====================================================================================================

// Minimal .xlsx reader (no npm dependency), returns the first worksheet as rows of cells.
import { readXlsxRows } from './xlsxReader.js';

// Upper limits that protect the shop from absurd files (e.g. a wrong file dropped into the inbox).
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
// More products than this is certainly not the bike shop's catalog.
const MAX_ROWS = 10000;
// At most this many error messages are kept per file (the rest is summarized as "... and N more").
const MAX_ERRORS = 50;

// Column header -> field name. Headers are normalized first (lower case, only letters and digits), so
// "Product ID", "productID", "product_id" and "PRODUCT-ID" all become "productid".
const HEADER_ALIASES = {
  // Business key of the product (the ERP's productID; Fiori label "Product ID").
  productid: 'productID',
  // the field name of the ERP entity and the label of the Fiori app
  name: 'name', productname: 'name',
  description: 'description', productdescription: 'description',
  price: 'price',
  // optional separate currency column (e.g. a hand-made file); the ERP CSV puts the currency into price
  currency: 'currency', currencycode: 'currency',
  stock: 'stock',
};
// Without these columns a file cannot be imported (the lab: "at least product ID, name, description and
// price"; description may be empty in the ERP, so its column is optional here).
const REQUIRED = ['productID', 'name', 'price'];
// Same limits as the ERP's data model (db/simpleerp-schema.cds): productID String(50), name String(100),
// description String(500).
const LIMITS = { productID: 50, name: 100, description: 500 };

// Normalizes a header text: "Product Description" -> "productdescription".
const normalizeHeader = h => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Splits CSV text into rows of strings (RFC 4180): fields separated by `delimiter`, lines by CRLF or LF,
 * fields may be enclosed in double quotes, and "" inside quotes is a literal quote.
 * Every row also remembers the line number where it starts (for error messages).
 * Exported for the supplier import (supplierFormats.js).
 */
export function parseCsv(text, delimiter) {
  // Result rows; each row is an array of field strings with an extra property `line`.
  const rows = [];
  // Current row, current field, quote state and current line number.
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  // Ends the current field (adds it to the row).
  const endField = () => { row.push(field); field = ''; };
  // Ends the current row (adds it to the result with its start line).
  const endRow = () => { endField(); row.line = rowLine; rows.push(row); row = []; rowLine = line; };
  // Character by character, so quotes and line breaks inside quotes are handled correctly.
  for (let i = 0; i < text.length; i++) {
    // The current character.
    const ch = text[i];
    // Inside a quoted value only quotes have a special meaning.
    if (quoted) {
      // Inside quotes: "" is an escaped quote, a single " ends the quoted part, everything else is data.
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      // A single quote closes the quoted value.
      else if (ch === '"') quoted = false;
      // Any other character (also a separator or a line break) is part of the value; line breaks are counted.
      else { if (ch === '\n') line++; field += ch; }
    } else if (ch === '"' && field === '') {
      // A quote at the beginning of a field starts a quoted field.
      quoted = true;
    // A separator outside quotes ends the current value.
    } else if (ch === delimiter) {
      // Store the value and start the next one.
      endField();
    // A line break outside quotes ends the current row.
    } else if (ch === '\n' || ch === '\r') {
      // CRLF counts as one line break: skip the \n that follows a \r.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      // Count the line (for the line numbers in error messages).
      line++;
      // Store the row and start the next one.
      endRow();
    } else {
      // A normal character: append it to the current value.
      field += ch;
    }
  }
  // The last line usually has no line break at the end.
  if (field !== '' || row.length) endRow();
  // A quote that was opened but never closed means the file is cut off or broken.
  if (quoted) throw new Error(`line ${rowLine}: a quoted value is not closed (file cut off?)`);
  // All rows of the file (the first one is the header).
  return rows;
}

// Picks the separator from the header line: the one of , ; TAB and | that occurs most often.
// Exported for the supplier import (supplierFormats.js), which reads delimited files of any supplier.
export function detectDelimiter(text) {
  // The first line of the file (the header).
  const header = text.split(/\r?\n/, 1)[0];
  // [separator, number of occurrences in the header] for each candidate.
  const counts = [',', ';', '\t', '|'].map(d => [d, header.split(d).length - 1]);
  // Sort by count, highest first; ',' wins ties because it comes first.
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

// Parses a price like "1200.00 EUR", "EUR 1200.00", "1200,00" or the number 1200 (xlsx).
// Returns { amount, currency } (currency null if the value contains none) or null if it is not a price.
function parsePrice(value) {
  // Numbers from an .xlsx cell need no parsing.
  if (typeof value === 'number') return Number.isFinite(value) ? { amount: value, currency: null } : null;
  // Optional 3-letter currency before or after the amount; decimal point or comma, max. 2 decimals.
  const m = /^(?:([A-Za-z]{3})\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:([A-Za-z]{3}))?$/.exec(String(value).trim());
  // Not a price, or a currency on both sides ("EUR 10 USD").
  if (!m || (m[1] && m[3])) return null;
  // Amount with a decimal point; currency in upper case, or null if the value had none.
  return { amount: Number(m[2].replace(',', '.')), currency: (m[1] || m[3] || '').toUpperCase() || null };
}

/**
 * Reads a product file. `ext` is 'csv' or 'xlsx'.
 * Returns { products, errors, warnings, columns } where products are clean objects
 * { productID, name, description, price, currency, stock } (stock undefined if the file has no stock column).
 * The file may only be imported when `errors` is empty.
 */
export function parseProductFile(buffer, ext) {
  // Problems that prevent the import, and remarks that do not.
  const errors = [];
  // Remarks: shown in the log, but they do not stop the import.
  const warnings = [];
  // Adds an error, but keeps at most MAX_ERRORS of them.
  const error = msg => { if (errors.length < MAX_ERRORS) errors.push(msg); else errors.overflow = (errors.overflow || 0) + 1; };
  // Result object, also returned early when the file cannot be read at all.
  const result = { products: [], errors, warnings, columns: [], lines: 0 };

  // ---- 1. size and format ----
  if (buffer.length === 0) { error('the file is empty (0 bytes) - transfer failed or export produced nothing'); return result; }
  // Larger than the limit: do not even try to read it.
  if (buffer.length > MAX_FILE_BYTES) { error(`the file is too large (${buffer.length} bytes, max. ${MAX_FILE_BYTES})`); return result; }

  // Rows of cells (the first row is the header), each with its line number for error messages.
  let rows;
  // Separator of a CSV file (needed again when a line with unquoted separators is repaired).
  let delimiter = ',';
  try {
    // The extension decides the reader.
    if (ext === 'xlsx') {
      // Excel: line number = row number in the worksheet (1-based).
      rows = readXlsxRows(buffer).map((cells, i) => Object.assign(cells, { line: i + 1 }));
    } else {
      // CSV: decode as UTF-8 and remove a byte order mark (Excel writes one when saving "CSV UTF-8").
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      // A NUL character or the ZIP signature "PK" means this is a binary file, not text.
      if (text.includes('\u0000') || text.startsWith('PK')) throw new Error('this is not a text (CSV) file');
      // An HTML page instead of CSV (e.g. a login or error page of the ERP) is a typical failed transfer.
      if (/^\s*</.test(text)) throw new Error('the file contains HTML/XML instead of CSV (error page of the ERP?)');
      // Separator from the header line, then split the text into rows.
      delimiter = detectDelimiter(text);
      // Split the text into rows of fields (quotes and separators handled).
      rows = parseCsv(text, delimiter);
    }
  } catch (e) {
    // The file cannot be read at all: one clear error message, nothing else to check.
    error(`invalid file format: ${e.message}`);
    // Return the result with this one error.
    return result;
  }
  // Ignore completely empty lines (e.g. the empty line after the last line break).
  rows = rows.filter(r => r.some(c => String(c).trim() !== ''));
  // Only empty lines: nothing to import.
  if (rows.length === 0) { error('the file contains no data'); return result; }

  // ---- 2. header ----
  const header = rows[0].map(h => String(h).trim());
  // Field name for each column (undefined for unknown columns).
  const fields = header.map(h => HEADER_ALIASES[normalizeHeader(h)]);
  // Remember the header (for the admin UI / debugging).
  result.columns = header;
  // Unknown columns are not an error (the export may contain more than the shop needs), just a remark.
  const unknown = header.filter((h, i) => h && !fields[i]);
  // e.g. "ignored column(s): color".
  if (unknown.length) warnings.push(`ignored column(s): ${unknown.join(', ')}`);
  // The same field twice ("Price" and "price") would be ambiguous.
  const duplicates = fields.filter((f, i) => f && fields.indexOf(f) !== i);
  // e.g. "column(s) appear twice: price".
  if (duplicates.length) error(`column(s) appear twice: ${[...new Set(duplicates)].join(', ')}`);
  // All required columns must be present.
  const missing = REQUIRED.filter(f => !fields.includes(f));
  // The message also shows the header that was found, so a wrong separator or file is easy to spot.
  if (missing.length) error(`missing required column(s): ${missing.join(', ')} (header: ${header.join(', ') || 'empty'})`);
  // Without the required columns the lines cannot be checked meaningfully.
  if (missing.length || duplicates.length) return result;
  // Remark: without a stock column the shop keeps its current stock values.
  const hasStock = fields.includes('stock');
  // Warning only: the import keeps the shop's stock values in this case.
  if (!hasStock) warnings.push('no stock column - the stock in the shop is not changed');

  // ---- 3. data lines ----
  const data = rows.slice(1);
  // Number of product lines in the file (shown in the transfer log, also for rejected files).
  result.lines = data.length;
  // A header without lines is most likely a failed or empty export: reject it instead of deleting all products.
  if (data.length === 0) error('the file contains only the header and no products (empty export?)');
  // More lines than allowed: reject without checking every line.
  if (data.length > MAX_ROWS) { error(`too many lines (${data.length}, max. ${MAX_ROWS})`); return result; }
  // Business keys already seen in this file (to find duplicates), key -> line number.
  const seen = new Map();
  // Column of the free-text description (the only column that may absorb unquoted separators, see below).
  const descIndex = fields.indexOf('description');
  // Line numbers that were repaired (reported as ONE warning instead of one per line).
  const repaired = [];

  // One iteration per product line (`let` because a repaired line replaces `cells`).
  for (let cells of data) {
    // Label for error messages, e.g. "line 3".
    const at = `line ${cells.line}`;
    // Repair of a known quirk of the ERP's CSV export: it does not quote values, so a description such as
    // "Hardtail bike with air fork, 12-speed" adds an extra column. The columns before the description
    // (productID, name) are taken from the start of the line, the columns after it (price, stock) from the end,
    // and everything in between is joined back into the description. price and stock are still validated below,
    // so a line that does not fit this pattern is still rejected. Assumption (reported as a warning): the name
    // contains no separator.
    if (ext !== 'xlsx' && cells.length > header.length && descIndex >= 0) {
      // Number of extra values = number of unquoted separators inside the description.
      const extra = cells.length - header.length;
      // Rebuild the line with exactly as many values as the header (keeping the line number).
      cells = Object.assign([...cells.slice(0, descIndex), cells.slice(descIndex, descIndex + extra + 1).join(delimiter),
                             ...cells.slice(descIndex + extra + 1)], { line: cells.line });
      // Remember the line for the summary warning below.
      repaired.push(cells.line);
    }
    // CSV: every line must have exactly as many values as the header. Fewer values = the line is cut off; more
    // values (in a file without a description column) = a text contains the separator without quotes.
    if (ext !== 'xlsx' && cells.length !== header.length) {
      // The line cannot be mapped to the columns: skip all further checks of this line.
      error(`${at}: expected ${header.length} values, found ${cells.length}` +
        (cells.length > header.length ? ' (a text contains the separator without quotes?)' : ''));
      // Next line.
      continue;
    }
    // Map the cells to fields: { productID: ..., name: ..., ... } (unknown columns are skipped).
    const raw = {};
    // f is undefined for unknown columns; `?? ''` fills missing cells (short xlsx rows).
    fields.forEach((f, i) => { if (f) raw[f] = cells[i] ?? ''; });
    // Helper: a cell as trimmed text.
    const str = f => String(raw[f] ?? '').trim();

    // productID: required, unique, only letters/digits/-/_ (same rule as the shop's product form).
    const productID = str('productID').toUpperCase();
    // Without a product ID the line cannot be matched: skip the other checks of this line.
    if (!productID) { error(`${at}: product ID is empty`); continue; }
    // Format and length of the ID (same rule as the shop's product form).
    if (!/^[A-Z0-9_-]+$/.test(productID) || productID.length > LIMITS.productID)
      error(`${at}: invalid product ID "${productID}" (letters, digits, - or _, max. ${LIMITS.productID})`);
    // Duplicate in the same file: two different values for one product would be ambiguous.
    if (seen.has(productID)) error(`${at}: product ID ${productID} appears twice (also in line ${seen.get(productID)})`);
    // Remember where the ID was seen first.
    seen.set(productID, cells.line);

    // name: required, max. 100 characters.
    const name = str('name');
    // Empty name, or longer than the ERP allows.
    if (!name) error(`${at} (${productID}): name is empty`);
    else if (name.length > LIMITS.name) error(`${at} (${productID}): name is longer than ${LIMITS.name} characters`);

    // description: optional (the ERP's own products have none), max. 500 characters.
    const description = str('description');
    // Longer than the ERP allows.
    if (description.length > LIMITS.description) error(`${at} (${productID}): description is longer than ${LIMITS.description} characters`);

    // price: required number >= 0, optionally with currency ("1200.00 EUR").
    const price = parsePrice(raw.price);
    // An empty price cell and an unreadable price get different messages.
    if (str('price') === '') error(`${at} (${productID}): price is empty`);
    else if (!price) error(`${at} (${productID}): price "${str('price')}" is not a valid amount (e.g. 1200.00 EUR)`);

    // currency: from the price field or a currency column; both must agree; default EUR.
    const column = str('currency').toUpperCase();
    // A currency column must contain a 3-letter ISO code (EUR, USD, ...).
    if (column && !/^[A-Z]{3}$/.test(column)) error(`${at} (${productID}): currency "${column}" is not a 3-letter code`);
    // Currency in the price field and in the currency column must not contradict each other.
    if (price?.currency && column && price.currency !== column)
      error(`${at} (${productID}): price currency ${price.currency} differs from currency column ${column}`);
    // The currency of the product: from the price, else from the column, else the shop's default EUR.
    const currency = price?.currency || column || 'EUR';

    // stock: whole number >= 0 (only if the file has a stock column).
    let stock;
    // Without a stock column `stock` stays undefined (the import keeps the shop's value).
    if (hasStock) {
      // xlsx: a number; CSV: text.
      const s = typeof raw.stock === 'number' ? raw.stock : str('stock');
      // Empty, not a whole number >= 0, or valid.
      if (s === '') error(`${at} (${productID}): stock is empty`);
      else if (!/^\d+$/.test(String(s))) error(`${at} (${productID}): stock "${s}" is not a whole number >= 0`);
      else stock = Number(s);
    }

    // Collect the clean product (it is only used if the whole file is free of errors).
    result.products.push({ productID, name, description: description || null, price: price?.amount, currency, stock });
  }
  // One warning for all repaired lines (shown in the transfer log, so the quirk of the export stays visible).
  if (repaired.length)
    // e.g. 8 line(s) had unquoted "," in the description (line 2, 4, ...) - repaired: ...
    warnings.push(`${repaired.length} line(s) had unquoted "${delimiter}" in the description (line ${repaired.slice(0, 10).join(', ')}` +
      `${repaired.length > 10 ? ', ...' : ''}) - repaired: the extra separators were taken as part of the description`);
  // Summarize errors beyond the limit.
  if (errors.overflow) errors.push(`... and ${errors.overflow} more error(s)`);
  // { products, errors, warnings, columns, lines }
  return result;
}
