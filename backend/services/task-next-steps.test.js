'use strict';

// Pure parts of the next-steps plan and the dependency-free .docx writer (31 Oct 2026).

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tns-pure-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'd.db');

const docx = require('./markdown-docx');
const ns = require('./task-next-steps');

function entries(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let off = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < buf.readUInt16LE(end + 10); i += 1) {
    const len = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 46, off + 46 + len).toString('utf8');
    const local = buf.readUInt32LE(off + 42); const size = buf.readUInt32LE(off + 20); const crc = buf.readUInt32LE(off + 16);
    const ln = buf.readUInt16LE(local + 26); const le = buf.readUInt16LE(local + 28);
    const raw = zlib.inflateRawSync(buf.slice(local + 30 + ln + le, local + 30 + ln + le + size));
    assert.equal(docx.crc32(raw), crc, `${name} CRC`);
    out[name] = raw.toString('utf8');
    off += 46 + len + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return out;
}

test('markdown → a valid .docx package: parts, headings, lists, bold, escaping; same input, same bytes', () => {
  const md = '# Plan & <notes>\n\nIntro **bold** and *it* and `code`.\n\n- one\n- [x] done\n1. first\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nraw <x>\n```';
  const buf = docx.markdownToDocx(md);
  assert.equal(buf.slice(0, 4).toString('hex'), '504b0304');
  const e = entries(buf);
  assert.deepEqual(Object.keys(e).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
  const d = e['word/document.xml'];
  assert.match(d, /<w:pStyle w:val="Heading1"\/>.*Plan &amp; &lt;notes&gt;/);
  assert.match(d, /<w:b\/><\/w:rPr><w:t xml:space="preserve">bold/);
  assert.match(d, /• <\/w:t>.*one/);
  assert.match(d, /☑ /);
  assert.match(d, /1\. /);
  assert.match(d, /A<\/w:t>.*\|.*B/);
  assert.doesNotMatch(d, /---/);
  assert.match(d, /Consolas.*raw &lt;x&gt;/);
  assert.equal(docx.markdownToDocx(md).equals(buf), true, 'deterministic — the attachment hash binds the approval');
});

test('docx filename from the first heading, else the fallback, with unsafe characters removed', () => {
  assert.equal(docx.docxName('# Q4 / Rota: *Plan*\n\nx', 'Task'), 'Q4 Rota Plan.docx');
  assert.equal(docx.docxName('no heading', 'Write the guide.'), 'Write the guide.docx');
  assert.equal(docx.docxName('', ''), 'Document.docx');
});

test('validateSteps: closed kinds, unknown → manual, model drop-time ignored, complete last, five at most', () => {
  const s = ns.validateSteps({ steps: [
    { kind: 'complete', title: 'Done', params: {} },
    { kind: 'teleport', title: 'Beam it over', params: { x: 1 } },
    { kind: 'drop-time', title: 'Drop', params: {} },
    { kind: 'follow-up-task', title: 'No text', params: {} },
    { kind: 'follow-up-task', title: 'Old date', params: { text: 'Do X', due: '2020-01-01', domain: 'space' } },
    { kind: 'send', title: 'Send', params: { to: 'Alex Reed' } },
    { kind: 'manual', title: 'One', params: {} },
    { kind: 'manual', title: 'Two', params: {} },
    { kind: 'send', title: '', params: {} },
  ] }, { today: '2026-10-31' });
  assert.deepEqual(s.map((x) => x.kind), ['manual', 'manual', 'follow-up-task', 'send', 'complete']);
  assert.equal(s[0].title, 'Beam it over');
  assert.deepEqual(s[0].params, {});
  assert.deepEqual(s[2].params, { text: 'Do X', due: null, domain: null });
  assert.throws(() => ns.validateSteps({ nope: [] }, { today: '2026-10-31' }));
  assert.throws(() => ns.validateSteps({ steps: [{ kind: 'drop-time', title: 'x' }] }, { today: '2026-10-31' }));
});

test('fallback: send to the owed person (if any), then done; parseJson survives fences and prose', () => {
  assert.deepEqual(ns.fallbackSteps({ promise: { owedTo: { resolved: 'Alex Reed' } } }).map((s) => s.kind), ['send', 'complete']);
  assert.deepEqual(ns.fallbackSteps({ promise: null }).map((s) => s.kind), ['complete']);
  assert.deepEqual(ns.parseJson('```json\n{"steps":[]}\n```'), { steps: [] });
  assert.deepEqual(ns.parseJson('Here you go: {"steps":[1]} thanks'), { steps: [1] });
});

test('covering email: two lines, first name, acronyms kept', () => {
  const m = ns.coveringEmail({ text: 'NOVA call metrics summary' }, 'Chris Middleton');
  assert.equal(m.body, 'Hi Chris,\n\nAttached is the NOVA call metrics summary you asked for.\n\nNick');
  assert.equal(m.subject, 'NOVA call metrics summary');
  assert.equal(ns.coveringEmail({ text: 'x'.repeat(200) }, null).subject.length, 118);
});
