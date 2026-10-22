import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { readJson, ensureDir } from './utils.js';
import { OUTPUT_FILE, DATA_DIR } from './config.js';

// ---------------------------------------------------------------------------
// Zero-dependency XLSX writer (a .xlsx is just a ZIP of OpenXML parts).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive (deflate) from [{ name, data:Buffer }]. */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const store = deflated.length >= data.length; // store when deflate doesn't shrink
    const method = store ? 0 : 8;
    const body = store ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // comment
    cd.writeUInt16LE(0, 32); // disk
    cd.writeUInt16LE(0, 34); // internal attrs
    cd.writeUInt32LE(0, 36); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push({ cd, nameBuf });
    offset += 30 + nameBuf.length + body.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const { cd, nameBuf } of central) {
    parts.push(cd, nameBuf);
    centralSize += 46 + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Build the sheet from flattened rows.
// ---------------------------------------------------------------------------

/** Each item: { name, role, email, evidence, schoolName, city, lat, lon } */
function buildWorksheet(items) {
  const HEADERS = ['Name', 'Role', 'Location', 'Email', 'Evidence'];

  let rowXml = '';
  const hyperlinks = []; // { rid, url, ref }
  let relId = 1;

  const addCell = (rowIdx, colIdx, text, url) => {
    const ref = `${colLetter(colIdx)}${rowIdx + 1}`;
    const xml = `<c r="${ref}" t="inlineStr"><is><t>${esc(text)}</t></is></c>`;
    if (url) {
      const rid = `rId${relId++}`;
      hyperlinks.push({ rid, url, ref });
    }
    return xml;
  };

  // Header row
  rowXml += `<row r="1">${HEADERS.map((h, c) => addCell(0, c, h, null)).join('')}</row>`;

  // Data rows
  items.forEach((it, i) => {
    const r = i + 1; // -> rows 2, 3, ...
    const locText = `${it.schoolName}, ${it.city}`;
    const locUrl = Number.isFinite(Number(it.lat)) && Number.isFinite(Number(it.lon))
      ? `https://www.google.com/maps?q=${it.lat},${it.lon}`
      : null;
    const cells = [
      addCell(r, 0, it.name, null),
      addCell(r, 1, it.role, null),
      addCell(r, 2, locText, locUrl),
      addCell(r, 3, it.email, it.email ? `mailto:${it.email}` : null),
      addCell(r, 4, it.evidence, it.evidence || null),
    ].join('');
    rowXml += `<row r="${r + 1}">${cells}</row>`;
  });

  const nRows = items.length + 1;
  const hyperlinksXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((h) => `<hyperlink ref="${h.ref}" r:id="${h.rid}"/>`).join('')}</hyperlinks>`
    : '';

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:E${nRows}"/>
<sheetData>${rowXml}</sheetData>
${hyperlinksXml}
</worksheet>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${hyperlinks.map((h) => `<Relationship Id="${h.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(h.url)}" TargetMode="External"/>`).join('\n')}
</Relationships>`;

  return { sheet, rels };
}

// ---------------------------------------------------------------------------
// Assemble the full .xlsx package.
// ---------------------------------------------------------------------------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="CS People" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function buildXlsx(items) {
  const { sheet, rels } = buildWorksheet(items);
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: Buffer.from(rels, 'utf8') },
  ];
  return zip(entries);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const data = readJson(OUTPUT_FILE, null);
  if (!Array.isArray(data) || !data.length) {
    console.error('No data found in', OUTPUT_FILE, '— run `node src/index.js` first.');
    process.exitCode = 1;
    return;
  }

  const items = [];
  for (const school of data) {
    for (const p of school.csPeople || []) {
      items.push({
        name: p.name,
        role: p.role,
        email: p.email,
        evidence: p.evidence || '',
        schoolName: school.schoolName,
        city: school.city,
        lat: school.lat,
        lon: school.long,
      });
    }
  }
  items.sort((a, b) => (a.schoolName || '').localeCompare(b.schoolName || '') || (a.name || '').localeCompare(b.name || ''));

  const outFile = path.join(DATA_DIR, 'cs_people.xlsx');
  ensureDir(DATA_DIR);
  fs.writeFileSync(outFile, buildXlsx(items));

  console.log(`Wrote ${items.length} row(s) to ${outFile}`);
  console.log('Columns: Name | Role | Location (Google Maps link) | Email (mailto) | Evidence (link)');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
