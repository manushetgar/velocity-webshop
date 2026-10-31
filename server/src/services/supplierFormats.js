// =====================================================================================================
// supplierFormats.js - reads supplier files of (almost) any format and translates them into the shop's
// canonical product record (Lab 2 extension: supplier portal + FTP).
//
// Role in the architecture:
//  - Every supplier sends product data in ITS OWN format: other column names (Artikelnummer, SKU, Part Number),
//    other separators (; or TAB), decimal commas ("12,90 €"), Excel, JSON from a web service, XML from a legacy
//    system. This module is the "message translator" of the integration: it turns all of them into ONE
//    canonical record { productID, name, description, price, currency, stock } (canonical data model).
//  - Three steps, each one independent of the database and the ERP (so they are easy to test):
//      1. parseRecords(): file -> list of flat records with the SUPPLIER's field names
//         (delimited text, .xlsx, JSON / NDJSON, XML; nested JSON/XML is flattened to "a.b" / "a@attr").
//      2. resolveMapping(): which supplier field is which canonical field - from the supplier's mapping profile
//         (Admin > Suppliers) or detected automatically with a list of synonyms (English and German).
//      3. toCanonical(): converts and validates every value (decimal comma, currency symbols, ERP limits).
//  - supplierImport.js then decides per record whether the product is created or updated in the ERP.
//  - Security: the XML reader never expands custom entities or DTDs (no XXE / "billion laughs"), files are size
//    limited, and nothing in a file is ever executed.
// =====================================================================================================

// extname(): extension of a file name (".csv").
import { extname } from 'node:path';
// CSV reader (RFC 4180, quotes, line numbers), separator detection and the size limit, shared with Lab 2's ERP files.
import { parseCsv, detectDelimiter, MAX_FILE_BYTES } from './productFile.js';
// Minimal .xlsx reader (no dependency).
import { readXlsxRows } from './xlsxReader.js';

// Formats a supplier profile can choose ('auto' = by file extension / content).
export const FORMATS = ['auto', 'csv', 'xlsx', 'json', 'xml'];
// The canonical product fields of the shop / ERP.
export const FIELDS = ['productID', 'name', 'description', 'price', 'currency', 'stock'];
// Fields a supplier may be allowed to change on EXISTING products (currency travels with the price).
export const UPDATABLE = ['name', 'description', 'price', 'stock'];
// Limits of the ERP's data model (db/simpleerp-schema.cds): productID String(50), name String(100),
// description String(500), price Decimal(10,2), stock Integer @assert.range [0, 1000].
const LIMITS = { productID: 50, name: 100, description: 500, price: 99999999.99, stock: 1000 };
// At most this many error messages per file.
const MAX_ERRORS = 50;

// ---------------------------------------------------------------------------------------------------------
// 1. Format detection and parsing into flat records
// ---------------------------------------------------------------------------------------------------------

/** Format of a file: the profile's choice, else the extension, else a look at the first bytes. */
export function detectFormat(fileName, buffer, preferred = 'auto') {
  // A fixed format in the supplier's profile wins.
  if (preferred && preferred !== 'auto') return preferred;
  // Extension without dot, lower case.
  const ext = extname(String(fileName)).slice(1).toLowerCase();
  // Delimited text in its usual disguises.
  if (['csv', 'txt', 'tsv', 'tab', 'dat'].includes(ext)) return 'csv';
  // Excel, JSON (incl. JSON lines) and XML.
  if (ext === 'xlsx') return 'xlsx';
  if (['json', 'ndjson', 'jsonl'].includes(ext)) return 'json';
  if (ext === 'xml') return 'xml';
  // Unknown extension: look at the content. "PK" = ZIP archive = .xlsx.
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';
  // First characters as text (byte order mark and leading spaces removed).
  const head = buffer.subarray(0, 200).toString('utf8').replace(/^﻿/, '').trimStart();
  // '<' = XML, '{' or '[' = JSON, anything else is treated as delimited text.
  if (head.startsWith('<')) return 'xml';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'csv';
}

// Decodes text: UTF-8 if valid, otherwise Windows-1252 (what Western European Excel versions write for "CSV").
function decodeText(buffer) {
  try {
    // fatal: true throws on invalid UTF-8 byte sequences instead of inserting replacement characters.
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''), encoding: 'UTF-8' };
  } catch {
    // Not UTF-8: Windows-1252 decodes every byte (ä, ö, ü, € ...).
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'Windows-1252' };
  }
}

// Turns rows of cells (first non-empty row = header) into records { line, values: { header: cell } }.
function rowsToRecords(rows, { strictColumns }) {
  // Skip empty lines (e.g. at the end of the file).
  const nonEmpty = rows.filter(r => r.some(c => String(c).trim() !== ''));
  // No header at all.
  if (!nonEmpty.length) throw new Error('the file contains no data');
  // The header row (cell texts without surrounding spaces).
  const header = nonEmpty[0].map(h => String(h).trim());
  // Records and problems with single lines.
  const records = [];
  // Lines that cannot be used (wrong number of values).
  const problems = [];
  // Every row after the header is one record.
  for (const cells of nonEmpty.slice(1)) {
    // Delimited text: a line with a different number of values cannot be assigned to the columns reliably.
    if (strictColumns && cells.length !== header.length) {
      // Problem with the line number of the file.
      problems.push(`line ${cells.line}: expected ${header.length} values, found ${cells.length}` +
        (cells.length > header.length ? ' (a value contains the separator without quotes?)' : ''));
      // Skip this line.
      continue;
    }
    // Header name -> cell value (empty header cells are ignored).
    const values = {};
    // Header name -> value (missing cells of short Excel rows become '').
    header.forEach((h, i) => { if (h) values[h] = cells[i] ?? ''; });
    // The record with its line number.
    records.push({ line: cells.line, values });
  }
  // Records, line problems and the field names of the header.
  return { records, problems, fields: header.filter(Boolean) };
}

// Flattens a nested JSON value into "a.b.c" keys: { unitPrice: { amount: 10 } } -> { 'unitPrice.amount': 10 }.
function flattenJson(value, prefix = '', out = {}) {
  // Objects: recurse into every property.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Nested keys are joined with ".".
    for (const [k, v] of Object.entries(value)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  // Arrays: lists of simple values become one text ("red, blue"); lists of objects are indexed (a.0.b).
  } else if (Array.isArray(value)) {
    // Simple list -> one text.
    if (value.every(v => v === null || typeof v !== 'object')) out[prefix] = value.join(', ');
    // List of objects -> indexed keys.
    else value.forEach((v, i) => flattenJson(v, `${prefix}.${i}`, out));
  // Simple values are stored under their full key.
  } else if (prefix) {
    // null/undefined become ''.
    out[prefix] = value ?? '';
  }
  // The flat object.
  return out;
}

// Follows a dotted path ("data.items") in a parsed JSON document.
const followPath = (doc, path) => path.split('.').filter(Boolean).reduce((v, k) => (v == null ? v : v[k]), doc);

// Finds the first array of objects in a JSON document (breadth first), e.g. the "items" of { data: { items: [...] } }.
function findRecordArray(doc) {
  // Queue of [value, path] pairs still to look at.
  const queue = [[doc, '']];
  // Breadth first: the shallowest list wins (the main product list, not a list inside a product).
  while (queue.length) {
    // Next value to look at.
    const [v, path] = queue.shift();
    // An array whose entries are objects: these are the records.
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object' && !Array.isArray(x))) return { list: v, path };
    // Look into the properties of objects.
    if (v && typeof v === 'object' && !Array.isArray(v))
      // Queue the properties with their path.
      for (const [k, x] of Object.entries(v)) queue.push([x, path ? `${path}.${k}` : k]);
  }
  // A single object is one record.
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? { list: [doc], path: '' } : null;
}

// JSON or JSON lines (one JSON object per line) -> records.
function parseJson(text, recordPath) {
  // The parsed document.
  let doc;
  try {
    // Normal JSON (one document).
    doc = JSON.parse(text);
  } catch (e) {
    // JSON lines: every non-empty line is a JSON object of its own.
    const lines = text.split(/\r?\n/).map((l, i) => [l.trim(), i + 1]).filter(([l]) => l);
    try {
      // Every line one record; its line number for error messages.
      return { records: lines.map(([l, line]) => ({ line, values: flattenJson(JSON.parse(l)) })), problems: [], path: '(JSON lines)' };
    } catch {
      // Neither JSON nor JSON lines: report the parser's message (it contains the position of the error).
      throw new Error(`invalid JSON - ${e.message}`);
    }
  }
  // Where the records are: the profile's path, or the first array of objects in the document.
  const found = recordPath ? { list: followPath(doc, recordPath), path: recordPath } : findRecordArray(doc);
  // Wrong path in the profile / no list in the file.
  if (!found || !Array.isArray(found.list)) throw new Error(recordPath ? `no list found at "${recordPath}"` : 'no list of products found in the JSON document');
  // Record number (1-based) as "line" for error messages; every record flattened.
  return { records: found.list.map((r, i) => ({ line: `record ${i + 1}`, values: flattenJson(r) })), problems: [], path: found.path };
}

// XML entities: only the five predefined ones and numeric references are decoded; custom entities from a DTD are
// NOT expanded (protection against XXE and entity expansion attacks).
const decodeXml = s => s
  // Hexadecimal reference, e.g. &#xE4;
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  // Decimal reference, e.g. &#228;
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  // The five predefined entities (&amp; last).
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Element name without namespace prefix ("ns:Article" -> "Article").
const localName = n => n.includes(':') ? n.split(':').pop() : n;

// One start or end tag: optional "/", name, attributes (quoted values may contain ">"), optional "/" before ">".
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

/** A small, safe XML parser: returns the root element { name, attrs, children, text }. */
export function parseXml(text) {
  // Stack of open elements; a virtual document node at the bottom.
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  // Open elements; the top is the current element.
  const stack = [root];
  // Position in the text.
  let i = 0;
  // Until the whole text has been read.
  while (i < text.length) {
    // Next tag.
    const lt = text.indexOf('<', i);
    // Text between tags belongs to the current element.
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt);
    // Text content of the current element (entities decoded).
    if (chunk.trim()) stack.at(-1).text += decodeXml(chunk);
    // No more tags.
    if (lt < 0) break;
    // Comments, processing instructions (<?xml ...?>) and DOCTYPE are skipped.
    if (text.startsWith('<!--', lt)) { i = text.indexOf('-->', lt); if (i < 0) throw new Error('comment not closed'); i += 3; continue; }
    // <?xml version="1.0"?> and other processing instructions.
    if (text.startsWith('<?', lt)) { i = text.indexOf('?>', lt); if (i < 0) throw new Error('processing instruction not closed'); i += 2; continue; }
    // CDATA: literal text.
    if (text.startsWith('<![CDATA[', lt)) {
      // End of the CDATA section.
      const end = text.indexOf(']]>', lt);
      // Not closed: the file is cut off.
      if (end < 0) throw new Error('CDATA section not closed');
      // CDATA content is taken literally (no entity decoding).
      stack.at(-1).text += text.slice(lt + 9, end);
      // Continue after "]]>".
      i = end + 3;
      // Next part.
      continue;
    }
    // DOCTYPE (possibly with an internal subset in [...]) is skipped without interpreting it.
    if (text.startsWith('<!', lt)) {
      // Position of an internal subset "[" and of the first ">".
      const bracket = text.indexOf('[', lt), close = text.indexOf('>', lt);
      // With an internal subset the DOCTYPE ends at "]>", otherwise at the first ">".
      const end = bracket >= 0 && bracket < close ? text.indexOf(']>', bracket) : close;
      // Not closed: the file is cut off.
      if (end < 0) throw new Error('DOCTYPE not closed');
      // Continue after the DOCTYPE.
      i = end + (bracket >= 0 && bracket < close ? 2 : 1);
      // Next part.
      continue;
    }
    // The tag itself: TAG is a "sticky" regex (flag y), it only matches exactly at lastIndex - no copies of the text.
    TAG.lastIndex = lt;
    // Match the tag at position lt.
    const m = TAG.exec(text);
    // Not a valid tag (e.g. "< b" or an unquoted attribute value).
    if (!m) throw new Error(`invalid tag at position ${lt}`);
    // Continue after the tag.
    i = lt + m[0].length;
    // Parts of the tag: "/" of a closing tag, name, attribute text, "/" of a self-closing tag.
    const [, closing, name, attrText, selfClosing] = m;
    // Closing tag:
    if (closing) {
      // Closing tag must match the open element.
      if (stack.length < 2 || stack.at(-1).name !== name) throw new Error(`unexpected </${name}>`);
      // Back to the parent element.
      stack.pop();
      // Next part.
      continue;
    }
    // Attributes: name="value" or name='value'.
    const attrs = {};
    // Attribute names without namespace prefix; values decoded.
    for (const a of attrText.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[localName(a[1])] = decodeXml(a[2] ?? a[3]);
    // New element as child of the current one.
    const el = { name, attrs, children: [], text: '' };
    // Child of the current element.
    stack.at(-1).children.push(el);
    // Not self-closing: the following text and tags belong to it.
    if (!selfClosing) stack.push(el);
  }
  // Every opened element must be closed again.
  if (stack.length !== 1) throw new Error(`<${stack.at(-1).name}> is not closed (file cut off?)`);
  // The document must have exactly one root element.
  if (root.children.length !== 1) throw new Error('the XML document must have exactly one root element');
  // The root element of the document.
  return root.children[0];
}

// Flattens an XML record: child texts by element name ("Price"), attributes as "Price@currency" / "@id",
// nested elements as "Supplier.Name".
function flattenXml(el, prefix = '', out = {}) {
  // Attributes of the element itself.
  for (const [k, v] of Object.entries(el.attrs)) out[`${prefix}@${k}`] = v;
  // Child elements.
  for (const c of el.children) {
    // Key of the child: "Name" or "Supplier.Name" for nested elements.
    const key = prefix ? `${prefix}.${localName(c.name)}` : localName(c.name);
    // Element with children: recurse; element with text only: store the text (and its attributes).
    if (c.children.length) flattenXml(c, key, out);
    // Leaf element: its text, plus its attributes as "Price@currency".
    else { out[key] = c.text.trim(); for (const [k, v] of Object.entries(c.attrs)) out[`${key}@${k}`] = v; }
  }
  // The flat record.
  return out;
}

// All elements of a tree (depth first).
const allElements = (el, out = []) => { out.push(el); el.children.forEach(c => allElements(c, out)); return out; };

// XML -> records: the elements named like the profile's record element, or (auto) the most frequent repeated element
// that has child elements (e.g. <Article> in <Catalog><Article>...</Article><Article>...</Article></Catalog>).
function parseXmlRecords(text, recordPath) {
  // Parse the whole document.
  const rootEl = parseXml(text);
  // All elements in document order.
  const elements = allElements(rootEl);
  // Record element name: from the profile (the last part of a path like "Catalog/Article"), else detected.
  let recordName = recordPath ? localName(recordPath.split(/[/.]/).pop()) : null;
  // No record element configured: detect it.
  if (!recordName) {
    // Count elements with children per name (the root itself is not a record).
    const counts = new Map();
    // Count elements with children per name.
    for (const e of elements.slice(1)) if (e.children.length) counts.set(localName(e.name), (counts.get(localName(e.name)) || 0) + 1);
    // The most frequent name; a single element with children is also accepted (a file with one product).
    recordName = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  // All record elements.
  const list = elements.filter(e => localName(e.name) === recordName);
  // None found.
  if (!recordName || !list.length) throw new Error(recordPath ? `no <${recordName}> elements found` : 'no repeated product elements found in the XML document');
  // One record per element; "<Article> 2" as position in error messages.
  return { records: list.map((e, i) => ({ line: `<${recordName}> ${i + 1}`, values: flattenXml(e) })), problems: [], path: recordName };
}

/**
 * Step 1: reads a supplier file into flat records. Returns { format, records, fields, problems, info } where
 * records are { line, values: { <supplier field name>: value } } and problems are line-level errors.
 * Throws an Error with a readable message if the file cannot be read at all.
 */
export function parseRecords(buffer, fileName, profile = {}) {
  // Size limits (also checked by the upload routes, but files can arrive by FTP or be copied into the inbox).
  if (!buffer.length) throw new Error('the file is empty (0 bytes)');
  // Same size limit as everywhere.
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`the file is too large (${buffer.length} bytes, max. ${MAX_FILE_BYTES})`);
  // Old binary Excel format (OLE2 signature D0 CF 11 E0) cannot be read.
  if (buffer.readUInt32BE(0) === 0xd0cf11e0) throw new Error('old Excel format (.xls) - please save the file as .xlsx or CSV');
  // Which reader to use.
  const format = detectFormat(fileName, buffer, profile.format);
  // Result of the reader.
  let result;
  // Excel:
  if (format === 'xlsx') {
    // Excel: rows of cells with their row number.
    const rows = readXlsxRows(buffer).map((cells, i) => Object.assign(cells, { line: i + 1 }));
    // Excel rows may be shorter than the header (empty cells at the end are not stored).
    result = { ...rowsToRecords(rows, { strictColumns: false }), info: { sheet: 'first worksheet' } };
  } else {
    // Text formats: decode first (UTF-8 or Windows-1252).
    const { text, encoding } = decodeText(buffer);
    // JSON:
    if (format === 'json') {
      // Records from the list at the profile's path (or detected).
      const r = parseJson(text, profile.recordPath);
      // Where the list was found.
      result = { records: r.records, problems: r.problems, info: { encoding, recordPath: r.path || '(top level)' } };
    // XML:
    } else if (format === 'xml') {
      // Records from the record elements.
      const r = parseXmlRecords(text, profile.recordPath);
      // Which element was used.
      result = { records: r.records, problems: r.problems, info: { encoding, recordElement: r.path } };
    } else {
      // Delimited text: separator from the profile ("\t" written as \t) or detected from the header line.
      const delimiter = profile.delimiter ? profile.delimiter.replace('\\t', '\t') : detectDelimiter(text);
      // HTML instead of data (e.g. an error page saved as .csv) is a typical failed export.
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('the file contains an HTML page instead of data');
      // Rows of fields (quotes, line breaks inside quotes).
      const rows = parseCsv(text, delimiter);
      // Every line must have as many values as the header.
      result = { ...rowsToRecords(rows, { strictColumns: true }), info: { encoding, delimiter: delimiter === '\t' ? 'TAB' : delimiter } };
    }
  }
  // Field names found in the file (union over all records for JSON/XML, where records may differ).
  const fields = result.fields || [...new Set(result.records.flatMap(r => Object.keys(r.values)))];
  // Format, records, field names, line problems and how the file was read.
  return { format, records: result.records, fields, problems: result.problems, info: result.info };
}

// ---------------------------------------------------------------------------------------------------------
// 2. Mapping: supplier field -> canonical field
// ---------------------------------------------------------------------------------------------------------

// Normalizes a field name for comparison: lower case, accents removed, only letters, digits, "." and "@" kept.
// "Part Number" -> "partnumber", "Währung" -> "wahrung", "unitPrice.amount" -> "unitprice.amount".
export const normalizeKey = k => String(k).toLowerCase()
  // German sharp s (it has no accent to remove).
  .replace(/ß/g, 'ss')
  // NFD splits a letter and its accent (ä -> a + ¨, é -> e + ´); the accents (U+0300-U+036F) are then removed.
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  // Only letters, digits, "." and "@" remain.
  .replace(/[^a-z0-9.@]/g, '');

// Synonyms per canonical field (normalized), best match first. English and German names that
// suppliers typically use. Earlier entries win when several columns could match.
const SYNONYMS = {
  // Product number in English and German (SKU, Part Number, Artikelnummer); "id" only as last resort.
  productID: ['productid', 'sku', 'articleno', 'articlenumber', 'artikelnummer', 'artikelnr', 'artnr', 'itemno', 'itemnumber',
              'itemcode', 'itemid', 'partno', 'partnumber', 'productcode', 'productno', 'materialnumber', 'materialnr',
              'code', '@id', 'id'],
  // Product name.
  name: ['name', 'productname', 'title', 'bezeichnung', 'artikelbezeichnung', 'artikelname', 'produktname', 'itemname'],
  // Description text.
  description: ['description', 'productdescription', 'beschreibung', 'artikelbeschreibung', 'longdescription', 'langtext',
                'details', 'text'],
  // Price (also nested JSON amounts).
  price: ['price', 'unitprice', 'netprice', 'listprice', 'salesprice', 'unitprice.amount', 'price.amount', 'price.value',
          'preis', 'verkaufspreis', 'vkpreis', 'einzelpreis', 'nettopreis', 'amount'],
  // Currency (also the XML attribute Price@currency).
  currency: ['currency', 'currencycode', 'curr', 'unitprice.currency', 'price.currency', 'price@currency', 'unitprice@currency',
             'wahrung', 'waehrung'],
  // Stock quantity.
  stock: ['stock', 'qty', 'quantity', 'available', 'availableqty', 'qtyavailable', 'onhand', 'instock', 'inventory.available',
          'stock.available', 'inventory', 'bestand', 'lagerbestand', 'verfugbar', 'menge'],
};

/**
 * Step 2: decides which supplier field feeds which canonical field. `profileFields` (Admin > Suppliers) has
 * priority; missing fields are detected with the synonyms (full name first, then the last part of a nested name,
 * e.g. "inventory.available" -> "available"). Returns { mapping, errors } with mapping = { canonical: supplierField }.
 */
export function resolveMapping(fileFields, profileFields = {}) {
  // canonical field -> supplier field.
  const mapping = {};
  // Mapping problems.
  const errors = [];
  // Supplier fields by normalized name (first occurrence wins).
  const byNorm = new Map();
  // Lookup table by normalized name.
  for (const f of fileFields) if (!byNorm.has(normalizeKey(f))) byNorm.set(normalizeKey(f), f);
  // Fields already taken (one supplier field feeds at most one canonical field).
  const used = new Set();
  // 1. Explicit mapping from the profile.
  for (const field of FIELDS) {
    // The name agreed in the profile.
    const wanted = profileFields?.[field];
    // Not set: detected below.
    if (!wanted) continue;
    // Case-insensitive, umlauts folded.
    const found = byNorm.get(normalizeKey(wanted));
    // Found: use it.
    if (found) { mapping[field] = found; used.add(found); }
    // The agreed field is missing: the file does not follow the agreement.
    else errors.push(`the mapping profile expects the field "${wanted}" for ${field}, but the file has no such field`);
  }
  // 2. Automatic detection for the remaining fields: candidates scored by synonym position (full name match
  //    scores better than a match of the last part only).
  for (const field of FIELDS) {
    // Already mapped (or the profile's name was missing - then no guessing).
    if (mapping[field] || profileFields?.[field]) continue;
    // Best candidate so far.
    let best = null;
    // Every field of the file.
    for (const f of fileFields) {
      // Already used for another field.
      if (used.has(f)) continue;
      // Normalized name ...
      const norm = normalizeKey(f);
      // ... and its last part ("inventory.available" -> "available").
      const last = norm.split(/[.@]/).pop();
      // Position in the synonym list (-1 = no synonym).
      const full = SYNONYMS[field].indexOf(norm);
      // Same for the last part.
      const part = SYNONYMS[field].indexOf(last);
      // Lower score = better; full name before last part.
      const score = full >= 0 ? full : part >= 0 ? 100 + part : null;
      // Keep the best candidate.
      if (score !== null && (!best || score < best.score)) best = { f, score };
    }
    // Use the best candidate.
    if (best) { mapping[field] = best.f; used.add(best.f); }
  }
  // Without a product ID nothing can be matched to the ERP.
  if (!mapping.productID && !errors.length)
    // Without a product ID the file cannot be processed.
    errors.push(`no field for the product ID found (fields in the file: ${fileFields.slice(0, 15).join(', ') || 'none'}) - set it in the supplier's mapping profile`);
  // The mapping and its problems.
  return { mapping, errors };
}

// ---------------------------------------------------------------------------------------------------------
// 3. Values: conversion and validation
// ---------------------------------------------------------------------------------------------------------

// Currency symbols that suppliers write instead of ISO codes.
const SYMBOLS = { '€': 'EUR', '$': 'USD', '£': 'GBP' };

/**
 * Parses an amount: numbers (xlsx/JSON) or texts like "12,90 €", "EUR 1.299,00", "1,299.00 USD", "1'299.50".
 * decimal: '.', ',' or 'auto' (if both appear, the last one is the decimal separator; a single "," followed by
 * 1-2 digits is a decimal comma). Returns { amount, currency } or null.
 */
export function parseAmount(value, decimal = 'auto') {
  // Numbers need no parsing.
  if (typeof value === 'number') return Number.isFinite(value) ? { amount: value, currency: null } : null;
  // The text without surrounding spaces.
  let s = String(value ?? '').trim();
  // Empty: no price.
  if (!s) return null;
  // Currency: ISO code (3 letters) or symbol anywhere in the text.
  let currency = null;
  // A 3-letter code like EUR / USD.
  const code = /\b([A-Za-z]{3})\b/.exec(s);
  // Remember it and remove it from the text.
  if (code) { currency = code[1].toUpperCase(); s = s.replace(code[0], ''); }
  // Symbols like € or $.
  for (const [sym, iso] of Object.entries(SYMBOLS)) if (s.includes(sym)) { currency ??= iso; s = s.replace(sym, ''); }
  // Remove spaces (also non-breaking) and apostrophes (Swiss thousands separator).
  s = s.replace(/[\s ']/g, '');
  // Only digits with . and , (and an optional leading minus, rejected later) may remain.
  if (!/^-?[\d.,]+$/.test(s)) return null;
  // Decide the decimal separator.
  let dec = decimal;
  // Detect the decimal sign.
  if (dec === 'auto') {
    // Positions of the last "." and ",".
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    // Both: the last one is the decimal sign (1.299,00 / 1,299.00).
    if (lastDot >= 0 && lastComma >= 0) dec = lastComma > lastDot ? ',' : '.';
    // Only a comma: decimal comma if 1-2 digits follow (12,90), else a thousands separator (1,200).
    else if (lastComma >= 0) dec = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? ',' : '.';
    // Only points (or none): decimal point.
    else dec = '.';
  }
  // Remove thousands separators, then use "." as decimal point.
  const normalized = dec === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  // More than one decimal point left = not a number (e.g. "1.2.3").
  if ((normalized.match(/\./g) || []).length > 1) return null;
  // The amount as number.
  const amount = Number(normalized);
  // NaN / Infinity are not amounts.
  return Number.isFinite(amount) ? { amount, currency } : null;
}

// Parses a stock quantity: a whole number (also "1.000" with thousands separator or 25.0 from Excel).
function parseStock(value) {
  // Excel/JSON numbers: whole numbers only.
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  // Remove thousands separators before groups of 3 digits.
  const s = String(value ?? '').trim().replace(/[.\s'](?=\d{3}\b)/g, '');
  // Only digits are a valid stock.
  return /^\d+$/.test(s) ? Number(s) : null;
}

/**
 * Step 3: converts the records into canonical products and validates them against the ERP's rules.
 * Returns { products, errors } - products: { line, productID, name?, description?, price?, currency?, stock? }
 * (undefined = the file does not provide the field). The file may only be applied if errors is empty.
 */
export function toCanonical(records, mapping, profile = {}) {
  // Canonical products.
  const products = [];
  // Value problems with their line.
  const errors = [];
  // Adds an error, keeping at most MAX_ERRORS.
  const error = msg => { if (errors.length < MAX_ERRORS) errors.push(msg); else errors.overflow = (errors.overflow || 0) + 1; };
  // productID -> line where it was seen first (duplicates in one file are ambiguous).
  const seen = new Map();
  // Every record of the file.
  for (const r of records) {
    // Raw supplier value of a canonical field (undefined if the field is not mapped).
    const raw = f => (mapping[f] ? r.values[mapping[f]] : undefined);
    // Trimmed text; '' for empty.
    const text = f => String(raw(f) ?? '').trim();
    // "line 3" (text formats) or "record 2" / "<Article> 2" (JSON / XML).
    const at = `${typeof r.line === 'number' ? `line ${r.line}` : r.line}`;
    // Product ID: required, unique in the file, same rules as everywhere in the shop.
    const productID = text('productID').toUpperCase();
    // Without a product ID the record cannot be matched: skip the other checks.
    if (!productID) { error(`${at}: product ID is empty`); continue; }
    // Format and length of the ID.
    if (!/^[A-Z0-9_-]+$/.test(productID) || productID.length > LIMITS.productID)
      error(`${at}: invalid product ID "${productID}" (letters, digits, - or _, max. ${LIMITS.productID})`);
    // The same product twice in one file is ambiguous.
    if (seen.has(productID)) error(`${at}: product ${productID} appears twice (also in ${seen.get(productID)})`);
    // Remember where it was seen first.
    seen.set(productID, at);
    // The canonical product (fields are added below when the file provides them).
    const p = { line: at, productID };
    // Name and description: optional here (required for NEW products - checked by the import), ERP lengths.
    // An empty cell means "no value sent" (a supplier file is a delta, it never clears data in the ERP).
    if (mapping.name && text('name')) {
      // ERP limit for the name.
      if (text('name').length > LIMITS.name) error(`${at} (${productID}): name is longer than ${LIMITS.name} characters`);
      // Take it over.
      p.name = text('name');
    }
    // Description only if the cell is not empty.
    if (mapping.description && text('description')) {
      // ERP limit for the description.
      if (text('description').length > LIMITS.description) error(`${at} (${productID}): description is longer than ${LIMITS.description} characters`);
      // Take it over.
      p.description = text('description');
    }
    // Price with currency (from the price text, a currency field or the profile's default currency).
    if (mapping.price && text('price') !== '') {
      // Parse the amount with the profile's decimal sign.
      const a = parseAmount(raw('price'), profile.decimal || 'auto');
      // Not a number, negative or too large for Decimal(10,2).
      if (!a || a.amount < 0 || a.amount > LIMITS.price) error(`${at} (${productID}): price "${text('price')}" is not a valid amount`);
      // Valid amount:
      else {
        // Currency of the price text and of the currency field must agree.
        const field = text('currency').toUpperCase();
        // The currency field must be an ISO code.
        if (field && !/^[A-Z]{3}$/.test(field)) error(`${at} (${productID}): currency "${field}" is not a 3-letter code`);
        // Price text and currency field must agree.
        if (a.currency && field && a.currency !== field) error(`${at} (${productID}): price currency ${a.currency} differs from currency ${field}`);
        // Rounded to cents (the ERP stores Decimal(10,2)).
        p.price = Math.round(a.amount * 100) / 100;
        // Currency: from the price text, the currency field, the profile, or EUR.
        p.currency = a.currency || field || profile.defaultCurrency || 'EUR';
      }
    }
    // Stock: whole number from 0 to 1000 (the ERP's @assert.range).
    if (mapping.stock && text('stock') !== '') {
      // Parse the quantity.
      const s = parseStock(raw('stock'));
      // Not a whole number.
      if (s === null) error(`${at} (${productID}): stock "${text('stock')}" is not a whole number`);
      // Above the ERP's range.
      else if (s > LIMITS.stock) error(`${at} (${productID}): stock ${s} is above the ERP limit of ${LIMITS.stock}`);
      // Valid.
      else p.stock = s;
    }
    // Collect the product (only used if there are no errors at all).
    products.push(p);
  }
  // Summary of the errors beyond the limit.
  if (errors.overflow) errors.push(`... and ${errors.overflow} more error(s)`);
  // Products and problems.
  return { products, errors };
}
