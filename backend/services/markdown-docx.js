'use strict';

/**
 * Markdown → .docx, with no dependency and no pandoc (31 Oct 2026).
 *
 * NEURO's only converter was routes/vault.js export-docx, which shells out to
 * pandoc — and pandoc is NOT installed on pi5, so that route saves markdown and
 * reports converted:false. A covering email that must carry a Word file cannot
 * depend on that, so this writes a small, valid Office Open XML package itself:
 * headings (#–######), paragraphs, bullet and numbered lists (as text prefixes),
 * **bold**, *italic*, `code`, fenced code blocks (monospace) and tables (one
 * line per row, cells separated). Anything else is kept as its text. The zip is
 * deflated with node's own zlib.
 *
 * PURE: markdown in, Buffer out. Nothing is written to disk here.
 */

const zlib = require('zlib');

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters — drop them rather than write a file Word refuses.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Inline markdown → runs. [{ text, b, i, code }] */
function inlineRuns(text) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('**') || t.startsWith('__')) runs.push({ text: t.slice(2, -2), b: true });
    else if (t.startsWith('`')) runs.push({ text: t.slice(1, -1), code: true });
    else if (t.startsWith('[')) { const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t); runs.push({ text: lm ? `${lm[1]} (${lm[2]})` : t }); }
    else runs.push({ text: t.slice(1, -1), i: true });
    last = m.index + t.length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

function runXml(r, extra = {}) {
  const props = [];
  if (r.b || extra.b) props.push('<w:b/>');
  if (r.i) props.push('<w:i/>');
  if (r.code || extra.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  return `<w:r>${props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
}

function para(runs, { style = null, indent = 0, extra = {} } = {}) {
  const ppr = [];
  if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
  if (indent) ppr.push(`<w:ind w:left="${indent * 360}" w:hanging="240"/>`);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}${runs.map((r) => runXml(r, extra)).join('')}</w:p>`;
}

/** Markdown → word/document.xml body paragraphs. */
function bodyXml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let paraBuf = [];
  const flush = () => { if (paraBuf.length) { out.push(para(inlineRuns(paraBuf.join(' ')))); paraBuf = []; } };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) { flush(); inCode = !inCode; continue; }
    if (inCode) { out.push(para([{ text: raw }], { extra: { code: true } })); continue; }
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push(para(inlineRuns(m[2]), { style: `Heading${Math.min(m[1].length, 3)}` })); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; } // horizontal rule
    if ((m = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) {
      flush();
      const box = m[2] === undefined ? '• ' : (m[2].trim() ? '☑ ' : '☐ ');
      out.push(para([{ text: box }, ...inlineRuns(m[3])], { indent: 1 + Math.floor(m[1].length / 2) }));
      continue;
    }
    if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line))) { flush(); out.push(para([{ text: `${m[2]}. ` }, ...inlineRuns(m[3])], { indent: 1 + Math.floor(m[1].length / 2) })); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^[\s|:-]+$/.test(line) && line.includes('-')) continue; // the |---|---| separator row
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      out.push(para(cells.flatMap((c, i) => (i ? [{ text: '  |  ' }, ...inlineRuns(c)] : inlineRuns(c)))));
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flush(); out.push(para(inlineRuns(m[1]), { indent: 1 })); continue; }
    paraBuf.push(line.trim());
  }
  flush();
  return out.join('');
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '</Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';
const DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';
const heading = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`
  + `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + heading(1, 32) + heading(2, 28) + heading(3, 24)
  + '</w:styles>';

function documentXml(markdown) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + bodyXml(markdown)
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';
}

// ── a minimal zip writer (deflate, CRC-32) ───────────────────────────────────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  // A fixed DOS timestamp (1 Jan 2026 00:00) so the same markdown is the same bytes — the attachment hash binds the approval.
  const dosTime = 0; const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Markdown → a .docx Buffer. */
function markdownToDocx(markdown) {
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(markdown) },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
  ]);
}

/** A safe .docx filename from the markdown's first `# heading`, else the fallback. */
function docxName(markdown, fallback = 'Document') {
  const h = /^#\s+(.+)$/m.exec(String(markdown || ''));
  const base = String((h && h[1]) || fallback || 'Document').replace(/[*_`#[\]]/g, '').replace(/[^a-z0-9 \-_.,'&()]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');
  return `${base || 'Document'}.docx`;
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

module.exports = { markdownToDocx, docxName, bodyXml, inlineRuns, crc32, DOCX_TYPE };
