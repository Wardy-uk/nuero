'use strict';

/**
 * The PLAUD transcripts manager (14 Oct 2026): the pure listing + rewrite, and
 * the list / archive routes over real HTTP against a scratch vault.
 *
 * Refresh is not driven end to end here — it needs PLAUD over MCP. What it
 * WRITES is `rewriteTranscriptNote`, pinned below, and its refusals (archived,
 * outside the vault, not a transcript) share `resolveTranscript` with archive,
 * which IS driven over HTTP.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-plaudtx-'));
process.env.OBSIDIAN_VAULT_PATH = tmp;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const pt = require('../services/plaud-transcripts');
const { buildInventory, rewriteTranscriptNote, speakerStats } = pt._internal;

function transcript(id, { named = 'false', warn = true, crlf = false, lines } = {}) {
  const body = lines || ['**Nick Ward** `00:01`  Morning.', '**Speaker 2** `00:04`  Hi.'];
  const text = [
    '---', `plaud_id: "${id}"`, 'date: 2026-09-08', 'title: "1-2-1 Hope"', 'type: transcript',
    'note_type: "transcript"', 'source: PLAUD', `speakers_named: ${named}`, '---', '',
    '# 1-2-1 Hope', '', 'Summary: [[Meetings/2026/09/2026-09-08 – 1-2-1 Hope]]', '', '## Transcript', '',
    ...(warn ? ['> ⚠ Speakers were never named in PLAUD — 1 of 2 still unnamed (Speaker 2). Attribution below is unreliable.', ''] : []),
    body.join('\n\n'), '',
  ].join('\n');
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}
const summary = (id) => `---\nplaud_id: "${id}"\ntitle: "1-2-1 Hope"\nnote_type: "summary"\n---\n\n# 1-2-1 Hope\n`;

function write(rel, body) {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

// ── Pure ────────────────────────────────────────────────────────────────────

test('inventory: summary present / archived / none, unnamed speakers, CRLF read', () => {
  const inv = buildInventory([
    { rel: 'Plaud/Transcripts/a.md', archived: false, content: transcript('f15f43b4a1b2c3d4e5f60718293a4b5c', { crlf: true }) },
    { rel: 'Meetings/2026/09/a.md', archived: false, content: summary('of_f15f43b4a1b2c3d4e5f60718293a4b5c') },
    { rel: 'Plaud/Transcripts/b.md', archived: false, content: transcript('b25f43b4a1b2c3d4e5f60718293a4b5c', { named: 'true', warn: false, lines: ['**Nick Ward** `00:01`  Hi.'] }) },
    { rel: 'Archive/x/b.md', archived: true, content: summary('b25f43b4a1b2c3d4e5f60718293a4b5c') },
    { rel: 'Plaud/Transcripts/c.md', archived: false, content: transcript('c35f43b4a1b2c3d4e5f60718293a4b5c') },
    { rel: 'Meetings/plain.md', archived: false, content: '---\ntitle: no plaud\n---\n' },
  ]);
  const by = Object.fromEntries(inv.transcripts.map((r) => [r.plaudId[0], r]));
  // Canonical id: an `of_` summary still belongs to the bare-id transcript.
  assert.equal(by.f.summaryStatus, 'present');
  assert.deepEqual(by.f.unnamed, ['Speaker 2']);
  assert.equal(by.f.speakersNamed, false);
  assert.equal(by.b.summaryStatus, 'archived');
  assert.equal(by.c.summaryStatus, 'none');
  assert.equal(inv.counts.transcripts, 3);
  assert.equal(inv.counts.unnamedSpeakers, 2);
});

test('rewrite: new segments, speakers_named and the warning follow the NEW naming; head kept', () => {
  const before = transcript('f15f43b4a1b2c3d4e5f60718293a4b5c');
  const body = '**Nick Ward** `00:01`  Morning.\n\n**Hope Goodall** `00:04`  Hi.';
  const next = rewriteTranscriptNote(before, body, { known: true, complete: true, reason: 'all 2 speakers named' });
  assert.match(next, /^speakers_named: true$/m);
  assert.doesNotMatch(next, /never named/);
  assert.match(next, /Summary: \[\[Meetings\/2026\/09\/2026-09-08 – 1-2-1 Hope\]\]/);
  assert.deepEqual(speakerStats(next).unnamed, []);
  assert.equal(speakerStats(next).segments, 2);
  assert.equal((next.match(/## Transcript/g) || []).length, 1);
});

test('rewrite: still unnamed keeps exactly one warning; CRLF stays CRLF', () => {
  const next = rewriteTranscriptNote(transcript('f15f43b4a1b2c3d4e5f60718293a4b5c', { crlf: true }), '**Speaker 2** `00:04`  Hi.',
    { known: true, complete: false, reason: '1 of 1 still unnamed (Speaker 2)' });
  assert.equal((next.match(/never named/g) || []).length, 1);
  assert.match(next, /speakers_named: false\r\n/);
  assert.doesNotMatch(next.replace(/\r\n/g, ''), /\n/);
});

test('rewrite: a layout with no transcript section is REFUSED, never appended to', () => {
  const odd = '---\nplaud_id: "x"\ntype: transcript\n---\n\nSpeaker 1 (00:01): hello\n';
  assert.equal(rewriteTranscriptNote(odd, '**A** `00:01`  hi', { known: true, complete: true }), null);
});

// ── HTTP ────────────────────────────────────────────────────────────────────

let server;
let base;

test.before(async () => {
  await db.init();
  write('Plaud/Transcripts/2026-09-08 1-2-1-Hope.md', transcript('f15f43b4a1b2c3d4e5f60718293a4b5c'));
  write('Meetings/2026/09/2026-09-08 – 1-2-1 Hope.md', summary('f15f43b4a1b2c3d4e5f60718293a4b5c'));
  write('Plaud/Transcripts/2026-09-09 Standup.md', transcript('d45f43b4a1b2c3d4e5f60718293a4b5c'));
  write('Meetings/2026/09/2026-09-09 – Standup.md', summary('d45f43b4a1b2c3d4e5f60718293a4b5c'));
  write('Meetings/2026/09/notes.md', '---\ntitle: not plaud\n---\n');
  const app = express();
  app.use(express.json());
  app.use('/api/plaud', require('./plaud'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  try { db.close && db.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('GET /transcripts lists both, with their summaries', async () => {
  const res = await fetch(`${base}/api/plaud/transcripts`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.counts.transcripts, 2);
  assert.ok(data.transcripts.every((r) => r.summaryStatus === 'present'));
});

test('archive MOVES the transcript (never unlinks) and leaves the summary unless asked', async () => {
  const rel = 'Plaud/Transcripts/2026-09-08 1-2-1-Hope.md';
  const res = await post('/api/plaud/transcripts/archive', { path: rel });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.moved.length, 1);
  assert.ok(!fs.existsSync(path.join(tmp, rel)));
  assert.ok(fs.existsSync(path.join(tmp, out.moved[0].to)));
  assert.ok(out.moved[0].to.startsWith('Archive/'));
  assert.ok(fs.existsSync(path.join(tmp, 'Meetings/2026/09/2026-09-08 – 1-2-1 Hope.md')));
  const list = await (await fetch(`${base}/api/plaud/transcripts`)).json();
  assert.equal(list.counts.transcripts, 1);
  assert.equal(list.counts.archivedTranscripts, 1);
  assert.equal(list.counts.summariesWithoutTranscript, 1);
});

test('archive withSummaries moves the summary too', async () => {
  const res = await post('/api/plaud/transcripts/archive', { path: 'Plaud/Transcripts/2026-09-09 Standup.md', withSummaries: true });
  const out = await res.json();
  assert.equal(out.moved.length, 2);
  assert.ok(!fs.existsSync(path.join(tmp, 'Meetings/2026/09/2026-09-09 – Standup.md')));
});

test('refusals: outside the vault, already archived, not a transcript, missing path', async () => {
  assert.equal((await post('/api/plaud/transcripts/archive', { path: '../escape.md' })).status, 400);
  assert.equal((await post('/api/plaud/transcripts/archive', { path: 'Archive/Plaud transcripts (archived from NEURO)/Plaud/Transcripts/2026-09-08 1-2-1-Hope.md' })).status, 400);
  assert.equal((await post('/api/plaud/transcripts/archive', { path: 'Meetings/2026/09/notes.md' })).status, 400);
  assert.equal((await post('/api/plaud/transcripts/archive', {})).status, 400);
  assert.equal((await post('/api/plaud/transcripts/refresh', { path: 'Meetings/2026/09/notes.md' })).status, 400);
});
