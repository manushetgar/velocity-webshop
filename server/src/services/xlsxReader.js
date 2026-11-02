import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid .xlsx file (no ZIP archive)');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new Error('damaged .xlsx file (ZIP directory)');
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error('damaged .xlsx file (ZIP entry)');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(start, start + compressedSize);
    if (method === 8) files.set(name, inflateRawSync(data));
    else if (method === 0) files.set(name, Buffer.from(data));
    else throw new Error(`unsupported ZIP compression method ${method}`);
  }
  return files;
}

const decodeXml = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const textOf = xml => decodeXml([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
  .map(m => m[1]).join(''));

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] || 'A';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

export function readXlsxRows(buf) {
  const files = unzip(buf);
  const text = name => files.get(name)?.toString('utf8') || '';

  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(text('xl/workbook.xml'))?.[1];
  const rel = firstSheet && [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)]
    .map(m => m[0]).find(r => r.includes(`Id="${firstSheet}"`));
  const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
  const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
  if (!files.has(sheetPath)) throw new Error('the .xlsx file contains no worksheet');

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));

  const rows = [];
  let nextRow = 0;
  for (const r of text(sheetPath).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = /\br="(\d+)"/.exec(r[1]);
    const rowIndex = rowNumber ? Number(rowNumber[1]) - 1 : nextRow;
    nextRow = rowIndex + 1;
    const cells = [];
    for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+\d*)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1] || 'n';
      const inner = c[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str') value = decodeXml(v ?? '');
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') value = decodeXml(v ?? '');
      else if (v !== undefined && v !== '') value = Number(v);
      cells[col] = value;
    }
    rows[rowIndex] = Array.from(cells, x => x ?? '');
  }
  return Array.from(rows, x => x ?? []);
}
