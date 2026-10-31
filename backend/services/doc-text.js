'use strict';

/**
 * Text out of a document (31 Oct 2026) — PDF, Word, Excel, PowerPoint, plain
 * text — for performance evidence (perf-mail.js). No model, no network.
 *
 * The Office formats are zip files of XML; a small reader here inflates the
 * one or two parts needed rather than adding a dependency. The old binary
 * formats (.doc/.xls/.ppt) are not read and say so.
 *
 * `extract(name, buffer)` → { ok, text, pages? } (pages for a PDF) or { ok:false, why }. Never throws.
 */

const zlib = require('zlib');

/** Entries of a zip, by name → () => Buffer. Throws on a file that is not a zip. */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    out[name] = () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.slice(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip method ${method}`);
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/** Text runs of an Office XML part, a line per paragraph. Pure. */
function xmlText(xml, { para, run }) {
  return decode(xml
    .replace(new RegExp(`</${para}>`, 'g'), '\n')
    .replace(/<w:tab\/>|<a:tab\/>/g, ' ')
    .replace(new RegExp(`<(?!/?${run}[ >])[^>]+>`, 'g'), '')
    .replace(new RegExp(`</?${run}[^>]*>`, 'g'), ''));
}

function tidy(text) {
  return String(text || '')
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean)
    .join('\n');
}

function docx(buf) {
  const z = unzip(buf);
  if (!z['word/document.xml']) throw new Error('no word/document.xml');
  return xmlText(z['word/document.xml']().toString('utf8'), { para: 'w:p', run: 'w:t' });
}

function pptx(buf) {
  const z = unzip(buf);
  const slides = Object.keys(z).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  return slides.map((k, i) => `Slide ${i + 1}: ${xmlText(z[k]().toString('utf8'), { para: 'a:p', run: 'a:t' })}`).join('\n');
}

function xlsx(buf) {
  const z = unzip(buf);
  const sheets = z['xl/workbook.xml']
    ? [...z['xl/workbook.xml']().toString('utf8').matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decode(m[1]))
    : [];
  const strings = z['xl/sharedStrings.xml']
    ? [...z['xl/sharedStrings.xml']().toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map((m) => decode(m[1].replace(/<[^>]+>/g, '')).trim()).filter(Boolean)
    : [];
  return [sheets.length ? `Sheets: ${sheets.join(', ')}` : null, strings.join('\n')].filter(Boolean).join('\n');
}

async function pdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
  const lines = [];
  for (let n = 1; n <= Math.min(doc.numPages, 30); n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    let y = null; let line = '';
    for (const it of tc.items) {
      const iy = it.transform ? Math.round(it.transform[5]) : y;
      if (y !== null && iy !== y) { lines.push(line); line = ''; }
      line += it.str + (it.hasEOL ? '\n' : '');
      y = iy;
    }
    lines.push(line);
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { text: lines.join('\n'), pages };
}

const READERS = [
  [/\.docx$/i, docx], [/\.pptx$/i, pptx], [/\.(xlsx|xlsm)$/i, xlsx], [/\.pdf$/i, pdf],
  [/\.(txt|md|csv)$/i, (b) => b.toString('utf8')],
];

async function extract(name, buffer) {
  const reader = READERS.find(([re]) => re.test(String(name || '')));
  if (!reader) return { ok: false, why: 'a format NEURO does not read' };
  try {
    const got = await reader[1](buffer);
    return typeof got === 'string' ? { ok: true, text: tidy(got) } : { ok: true, text: tidy(got.text), pages: got.pages };
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { extract, _internals: { unzip, xmlText, tidy } };
