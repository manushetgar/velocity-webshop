// =====================================================================================================
// xlsxReader.js - a minimal reader for Excel files (.xlsx), without any npm dependency.
//
// Role in the architecture (Lab 2, file transfer):
//  - The Fiori app "Manage Products" of the Mini-ERP has the standard "Export to Spreadsheet" button. It
//    downloads the product list as an .xlsx file. This module lets the shop import exactly that file.
//  - It only READS the first worksheet and returns its cells as a 2D array (rows x columns). Formatting,
//    formulas, several sheets etc. are not needed for a product list and are ignored.
//
// How an .xlsx file is built (Office Open XML):
//  - It is a ZIP archive. Inside are XML files: xl/workbook.xml (list of sheets),
//    xl/_rels/workbook.xml.rels (which file belongs to which sheet), xl/worksheets/sheet1.xml (the cells)
//    and usually xl/sharedStrings.xml (all texts, stored once and referenced by number from the cells).
//  - Node.js has no ZIP reader, but it has zlib: ZIP entries are "raw deflate" streams, so this file reads
//    the ZIP directory itself and lets zlib.inflateRawSync() decompress the entries.
// =====================================================================================================

// inflateRawSync: decompresses "raw deflate" data (ZIP compression method 8) synchronously.
import { inflateRawSync } from 'node:zlib';

// ZIP signatures (magic numbers, little endian) that mark the start of the structures inside the archive.
// End of central directory record: found at the very end of every ZIP file.
const EOCD_SIGNATURE = 0x06054b50;
// Central directory file header: one per file in the archive (name, sizes, offset of the data).
const CENTRAL_SIGNATURE = 0x02014b50;
// Local file header: written directly in front of the (compressed) data of each file.
const LOCAL_SIGNATURE = 0x04034b50;

/** Reads all entries of a ZIP archive into a Map: file name -> Buffer with the uncompressed content. */
// `buf` is the whole .xlsx file as Buffer.
function unzip(buf) {
  // The EOCD record is at least 22 bytes long and can be followed by a comment of up to 65535 bytes, so it is
  // searched backwards from the end of the file within that range.
  let eocd = -1;
  // Start at the last possible position (length - 22) and go back until the signature is found.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    // readUInt32LE reads 4 bytes as an unsigned little-endian number.
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  // No EOCD record: the file is not a ZIP archive (e.g. a CSV file renamed to .xlsx).
  if (eocd < 0) throw new Error('not a valid .xlsx file (no ZIP archive)');
  // Number of entries in the central directory (2 bytes at offset 10 of the EOCD record).
  const count = buf.readUInt16LE(eocd + 10);
  // Position of the central directory in the file (4 bytes at offset 16).
  let pos = buf.readUInt32LE(eocd + 16);
  // Result: file name inside the archive -> uncompressed content.
  const files = new Map();
  // Walk through all central directory headers.
  for (let n = 0; n < count; n++) {
    // Every header must start with the central directory signature; otherwise the archive is damaged.
    if (buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new Error('damaged .xlsx file (ZIP directory)');
    // Compression method: 0 = stored (not compressed), 8 = deflate.
    const method = buf.readUInt16LE(pos + 10);
    // Size of the compressed data in bytes.
    const compressedSize = buf.readUInt32LE(pos + 20);
    // Lengths of the variable parts of this header: file name, extra field, comment.
    const nameLength = buf.readUInt16LE(pos + 28);
    // (lengths of the extra field and of the comment; both are skipped)
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    // Where the local header of this file starts.
    const localOffset = buf.readUInt32LE(pos + 42);
    // The file name follows the fixed 46-byte part of the header.
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
    // Jump to the next central directory header.
    pos += 46 + nameLength + extraLength + commentLength;
    // The local header has its own (possibly different) name and extra field lengths at offsets 26 and 28.
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('damaged .xlsx file (ZIP entry)');
    // The data starts after the 30-byte local header plus its file name and extra field.
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    // The compressed bytes of this entry.
    const data = buf.subarray(start, start + compressedSize);
    // Decompress (method 8) or take the bytes as they are (method 0); other methods do not occur in .xlsx files.
    if (method === 8) files.set(name, inflateRawSync(data));
    // Method 0: the data is stored uncompressed.
    else if (method === 0) files.set(name, Buffer.from(data));
    // Other methods (e.g. bzip2) are not used by Excel / UI5.
    else throw new Error(`unsupported ZIP compression method ${method}`);
  }
  // All entries of the archive.
  return files;
}

// Replaces the five predefined XML entities and numeric character references (&#228; or &#xE4;) by their
// characters, e.g. "R&amp;D" -> "R&D".
const decodeXml = s => s
  // Hexadecimal character reference, e.g. &#xE4; -> a-umlaut.
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  // Decimal character reference, e.g. &#228; -> a-umlaut.
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  // The named entities.
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  // &amp; last, so "&amp;lt;" correctly becomes "&lt;" and not "<".
  .replace(/&amp;/g, '&');

// Text of an element that may consist of several formatted "runs": <si><r><t>Bike</t></r><r><t>s</t></r></si>.
// All <t> elements are concatenated; <rPh> (phonetic hints for Asian scripts) are removed first.
const textOf = xml => decodeXml([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
  // m[1] = text between <t> and </t>; all runs joined.
  .map(m => m[1]).join(''));

// Converts the column letters of a cell reference into a 0-based index: "A" -> 0, "B" -> 1, "AA" -> 26.
function columnIndex(ref) {
  // Only the letters at the start of the reference ("AB12" -> "AB").
  const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  // Base-26 number system with digits A..Z (1..26).
  let index = 0;
  // Each letter is one digit: A = 1 ... Z = 26.
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  // -1 because the result is 0-based.
  return index - 1;
}

/**
 * Reads the first worksheet of an .xlsx file. Returns an array of rows, each row an array of cell values:
 * texts as strings, numbers as numbers, booleans as 'TRUE'/'FALSE', empty cells as ''.
 */
export function readXlsxRows(buf) {
  // Unpack the ZIP archive.
  const files = unzip(buf);
  // Helper: content of an archive entry as text, or '' if the entry does not exist.
  const text = name => files.get(name)?.toString('utf8') || '';

  // 1. Find the file of the first worksheet: workbook.xml lists the sheets in display order, each with a
  //    relationship id (r:id), and workbook.xml.rels maps that id to the file name.
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(text('xl/workbook.xml'))?.[1];
  // The <Relationship> element whose Id is the sheet's r:id; its Target is the path of the sheet file.
  const rel = firstSheet && [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)]
    // The <Relationship> element whose Id is the r:id of the first sheet.
    .map(m => m[0]).find(r => r.includes(`Id="${firstSheet}"`));
  // Target is relative to the xl/ folder ("worksheets/sheet1.xml") or absolute ("/xl/worksheets/sheet1.xml").
  const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
  // Normalize to the path inside the archive; fall back to the usual name if the workbook is unusual.
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
  // Without the worksheet there is nothing to read.
  if (!files.has(sheetPath)) throw new Error('the .xlsx file contains no worksheet');

  // 2. Shared strings: each <si> element is one text; cells of type "s" reference them by their position.
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));

  // 3. Read the cells row by row.
  const rows = [];
  // Rows are numbered from 1 in the r attribute; empty rows may be missing completely in the file.
  let nextRow = 0;
  // Each <row ...>...</row> (or an empty, self-closing <row .../>).
  for (const r of text(sheetPath).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    // Row index from r="12" (1-based), or the next row if the attribute is missing.
    const rowNumber = /\br="(\d+)"/.exec(r[1]);
    // 0-based row index.
    const rowIndex = rowNumber ? Number(rowNumber[1]) - 1 : nextRow;
    // The next row without r attribute follows this one.
    nextRow = rowIndex + 1;
    // The cells of this row, indexed by column.
    const cells = [];
    // Each <c ...>...</c> (or an empty, self-closing <c .../>) inside the row.
    for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      // Attributes: r = cell reference ("B3"), t = data type of the value.
      const attrs = c[1];
      // Cell reference (e.g. B3) and data type (s, inlineStr, str, b, e; missing = number).
      const ref = /\br="([A-Z]+\d*)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1] || 'n';
      // Inner XML of the cell: <v> holds the value, <is> an inline string.
      const inner = c[2] || '';
      // The raw value inside <v>...</v> (undefined if there is none).
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      // Column: from the reference, or the next free column if the reference is missing.
      const col = ref ? columnIndex(ref) : cells.length;
      // Convert the value according to its type.
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';          // index into the shared strings
      else if (type === 'inlineStr') value = textOf(inner);       // text stored directly in the cell
      else if (type === 'str') value = decodeXml(v ?? '');        // result of a text formula
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'; // boolean
      else if (type === 'e') value = decodeXml(v ?? '');          // error value such as #N/A
      else if (v !== undefined && v !== '') value = Number(v);    // number (also dates, stored as numbers)
      // Store the value in its column.
      cells[col] = value;
    }
    // Fill gaps (cells that were not written because they are empty) with '' and store the row.
    rows[rowIndex] = Array.from(cells, x => x ?? '');
  }
  // Rows that were missing in the file become empty arrays, so the row index still matches the line number.
  return Array.from(rows, x => x ?? []);
}
