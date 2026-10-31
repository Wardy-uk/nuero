'use strict';

/**
 * Text out of documents (31 Oct 2026). Office files are built here as real zips
 * (stored and deflated), so the reader is tested on the format, not a stub.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { extract } = require('./doc-text');

/** A minimal zip: entries [{name, text, deflate}]. */
function zip(entries) {
  const locals = []; const dirs = []; let off = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.text, 'utf8');
    const data = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    locals.push(lh, name, data); dirs.push(cd, name);
    off += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(dirs);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('docx: paragraphs, entities, tables and tabs', async () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>Support Standards &amp; Routing</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">Owner: </w:t></w:r><w:r><w:tab/><w:t>Tier 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
  const r = await extract('Guide.docx', zip([{ name: 'word/document.xml', text: xml, deflate: true }]));
  assert.deepEqual(r, { ok: true, text: 'Support Standards & Routing\nOwner: Tier 2' });
});

test('pptx: slides in order; xlsx: sheet names and cell strings', async () => {
  const slide = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  const p = await extract('Deck.pptx', zip([
    { name: 'ppt/slides/slide10.xml', text: slide('Ten') },
    { name: 'ppt/slides/slide2.xml', text: slide('Two'), deflate: true },
  ]));
  assert.equal(p.text, 'Slide 1: Two\nSlide 2: Ten');
  const x = await extract('KPIs.xlsx', zip([
    { name: 'xl/workbook.xml', text: '<workbook><sheets><sheet name="Options" sheetId="1"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', text: '<sst><si><t>FRT</t></si><si><r><t>Resolution</t></r></si></sst>' },
  ]));
  assert.equal(x.text, 'Sheets: Options\nFRT\nResolution');
});

test('unreadable files say why, never throw', async () => {
  assert.equal((await extract('old.doc', Buffer.from('x'))).ok, false);
  const bad = await extract('broken.docx', Buffer.from('not a zip'));
  assert.equal(bad.ok, false);
  assert.match(bad.why, /zip/);
  assert.deepEqual(await extract('notes.md', Buffer.from('  # Hi  \n\n there ')), { ok: true, text: '# Hi\nthere' });
});
