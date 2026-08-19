// A minimal .xlsx writer, because a .csv cannot carry colour and "highlight the
// winners green" is the whole point of this export.
//
// An .xlsx is a ZIP of XML parts. We write the ZIP with STORED (uncompressed)
// entries, which needs no deflate implementation and is perfectly valid — a
// ledger is a few kilobytes, so nothing is gained by compressing it. Runs
// unchanged in Node and in the browser: the only inputs are strings, and the
// only output is a Uint8Array.
//
// Shared by the server (the saved copy, from persisted rows) and the browser
// (the live download), so both produce the same workbook.

const enc = new TextEncoder();

// ---- CRC-32, the one thing a ZIP entry cannot be written without ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- ZIP ----

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    // A fixed timestamp (1980-01-01) keeps the file byte-identical for the same
    // ledger, so a re-download is not gratuitously "different".
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(33),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push({ name: nameBytes, crc, size: data.length, offset });
    offset += local.length + nameBytes.length + data.length;
  }

  const dirStart = offset;
  for (const e of central) {
    const head = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(33),
      ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(e.offset),
    ];
    chunks.push(new Uint8Array(head), e.name);
    offset += head.length + e.name.length;
  }
  chunks.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(offset - dirStart), ...u32(dirStart), ...u16(0),
  ]));

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---- the workbook ----

const xmlEscape = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const COL = (n) => {
  let s = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) s = String.fromCharCode(65 + (i % 26)) + s;
  return s;
};

// Style ids, in the order they are written into styles.xml below.
export const STYLE = { PLAIN: 0, HEAD: 1, WIN: 2, LOSS: 3, TITLE: 4 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FF106B33"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FF9C1B22"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC8E6C9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFCDD2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

// rows: [[{ v, style?, num? }, ...], ...]. A cell may also be a bare string or
// number, which is written plain.
function sheetXml(rows, widths) {
  const cols = widths?.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, r) => {
    const cells = row.map((raw, c) => {
      const cell = raw && typeof raw === 'object' ? raw : { v: raw };
      if (cell.v === null || cell.v === undefined || cell.v === '') {
        return cell.style ? `<c r="${COL(c)}${r + 1}" s="${cell.style}"/>` : '';
      }
      const s = cell.style ? ` s="${cell.style}"` : '';
      const numeric = cell.num ?? (typeof cell.v === 'number');
      return numeric
        ? `<c r="${COL(c)}${r + 1}"${s}><v>${Number(cell.v)}</v></c>`
        : `<c r="${COL(c)}${r + 1}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

// Build the whole workbook. Returns a Uint8Array of .xlsx bytes.
export function buildXlsx(rows, { sheetName = 'Ledger', widths = [] } = {}) {
  const files = [
    {
      name: '[Content_Types].xml',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      name: '_rels/.rels',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    { name: 'xl/styles.xml', data: enc.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(rows, widths)) },
  ];
  return zip(files);
}

// The ledger as workbook rows. `rows` are ledger rows
// ({ nickname, realName?, buyIns, cashOuts, stack, net, handsPlayed? }); a
// winning row is filled green, a losing one red, so who owes what is legible
// at a glance rather than after reading a column of signed numbers.
export function ledgerSheet(rows, { title = 'Reg-Poker Online ledger', meta = [], settle = [] } = {}) {
  const out = [[{ v: title, style: STYLE.TITLE }]];
  for (const [k, v] of meta) out.push([{ v: k, style: STYLE.TITLE }, v]);
  out.push([]);
  out.push(['Name', 'Username', 'Buy-ins', 'Cash-outs', 'Stack', 'Hands', 'Net']
    .map((v) => ({ v, style: STYLE.HEAD })));
  for (const r of rows) {
    const style = r.net > 0 ? STYLE.WIN : r.net < 0 ? STYLE.LOSS : STYLE.PLAIN;
    out.push([
      { v: r.realName || r.nickname, style },
      { v: r.nickname, style },
      { v: r.buyIns, style, num: true },
      { v: r.cashOuts, style, num: true },
      { v: r.stack, style, num: true },
      { v: r.handsPlayed || 0, style, num: true },
      { v: r.net, style, num: true },
    ]);
  }
  if (settle.length) {
    out.push([]);
    out.push(['Settle up: from', 'to', 'amount'].map((v) => ({ v, style: STYLE.HEAD })));
    for (const p of settle) {
      out.push([
        { v: p.from, style: STYLE.LOSS },
        { v: p.to, style: STYLE.WIN },
        { v: p.amount, style: STYLE.PLAIN, num: true },
      ]);
    }
  }
  return out;
}

export const LEDGER_WIDTHS = [22, 16, 10, 11, 10, 8, 10];
