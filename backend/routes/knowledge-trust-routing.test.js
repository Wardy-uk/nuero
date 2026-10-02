'use strict';

/**
 * Marking a note as knowledge, over real HTTP and through a real database.
 *
 * ⚠ A green service suite says nothing about routing, and it says nothing about
 * the JOIN either. The pure suites prove each half separately: that a flag gets
 * written, and that a path set filters a search. Only this sees the whole chain
 * — press the button, the frontmatter changes, the set is rebuilt, and
 * `retrieval` with `scope: 'trusted'` returns that note and no other. That is
 * the thing the feature actually promises, and it is exactly the shape of
 * failure this codebase keeps paying for: every part correct, nothing wired.
 *
 * ⚠ It also reaches the one rule the service suite cannot — a PARTIAL WALK MUST
 * NOT OVERWRITE A GOOD SET. That needs a real KV store to have something to
 * overwrite, and getting it wrong silently un-trusts whatever the walk missed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ktrust-'));
const vault = path.join(tmp, 'vault');
fs.mkdirSync(vault, { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const knowledgeTrust = require('../services/knowledge-trust');
const knowledgeCandidates = require('../services/knowledge-candidates');
const retrieval = require('../services/retrieval');

function write(rel, content) {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

const longBody = (word) => Array.from({ length: 700 }, (_, i) => `${word}${i}`).join(' ');

let server;
let base;

async function call(method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test.before(async () => {
  await db.init();

  write('Projects/Support Hub/SOP.md', `---\ntitle: SOP\ntags: [support]\n---\n\n## One\n\n## Two\n\n## Three\n\n[[A]] [[B]] [[C]]\n\nzebra ${longBody('sop')}\n`);
  write('Projects/Support Hub/Other.md', `---\ntitle: Other\n---\n\nzebra ${longBody('other')}\n`);
  write('Knowledge/Nurtur/Promoted.md', '---\ntitle: Promoted\nknowledge_state: distilled\n---\n\nzebra promoted note.\n');
  write('Daily/2026-09-26.md', '---\n---\n\nzebra daily.\n');

  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-memory', require('./knowledge-memory'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/knowledge-memory`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

// ── The whole chain ──────────────────────────────────────────────────────────

test('⚠ press the button and the SEARCH changes — the join, not the halves', async () => {
  // Before: nothing is marked, so a trusted-scope search answers with the
  // promoted note only (trusted by location).
  await call('POST', '/trust/refresh');
  let scoped = await retrieval.search('zebra', { maxResults: 10, scope: 'trusted' });
  assert.deepEqual(scoped.map((r) => r.path).sort(), ['Knowledge/Nurtur/Promoted.md']);

  const marked = await call('POST', '/trust', { path: 'Projects/Support Hub/SOP.md', domain: 'Nurtur' });
  assert.equal(marked.status, 200);
  assert.equal(marked.json.ok, true);

  // The frontmatter is what changed — the note did not move and nothing was
  // copied.
  const onDisk = fs.readFileSync(path.join(vault, 'Projects/Support Hub/SOP.md'), 'utf-8');
  assert.match(onDisk, /knowledge_state: "trusted"/);
  assert.ok(fs.existsSync(path.join(vault, 'Projects/Support Hub/SOP.md')));

  scoped = await retrieval.search('zebra', { maxResults: 10, scope: 'trusted' });
  const paths = scoped.map((r) => r.path).sort();
  assert.ok(paths.includes('Projects/Support Hub/SOP.md'));
  assert.ok(paths.includes('Knowledge/Nurtur/Promoted.md'));
  // ⚠ And nothing else. A scope that admits an unmarked note is not a scope.
  assert.equal(paths.includes('Projects/Support Hub/Other.md'), false);
});

test('an unscoped search still sees everything — trusting adds rank, not a filter', async () => {
  const all = await retrieval.search('zebra', { maxResults: 10 });
  assert.ok(all.map((r) => r.path).includes('Projects/Support Hub/Other.md'));
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('a note the index could never return answers 400 with the reason', async () => {
  const res = await call('POST', '/trust', { path: 'Daily/2026-09-26.md' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /no effect/);
});

test('⚠ un-trusting a Knowledge/ note answers 400 and says it is by location', async () => {
  const res = await call('POST', '/untrust', { path: 'Knowledge/Nurtur/Promoted.md' });
  assert.equal(res.status, 400);
  assert.equal(res.json.trustedBy, 'location');
  // The file is untouched — a refusal writes nothing.
  assert.match(fs.readFileSync(path.join(vault, 'Knowledge/Nurtur/Promoted.md'), 'utf-8'), /knowledge_state/);
});

test('junk on /candidates is REFUSED, never clamped', async () => {
  // temporal-range's rule: clamping answers a question nobody asked while
  // looking like it answered the one they did.
  for (const q of ['?limit=0', '?limit=-5', '?limit=abc', '?minScore=-1', '?minScore=500']) {
    const res = await fetch(`${base}/candidates${q}`);
    assert.equal(res.status, 400, q);
  }
});

// ── The set, and the rule the service suite cannot reach ─────────────────────

test('the set is stored and reports what it holds', async () => {
  const res = await call('POST', '/trust/refresh');
  assert.equal(res.status, 200);
  assert.equal(res.json.refreshed.known, true);
  assert.equal(res.json.refreshed.stored, true);

  const stored = knowledgeTrust.trustedPaths();
  assert.equal(stored.known, true);
  assert.ok(stored.paths.has('Projects/Support Hub/SOP.md'));
});

test('⚠⚠ a PARTIAL WALK never overwrites a good set', async () => {
  const good = knowledgeTrust.trustedPaths();
  assert.equal(good.known, true);
  assert.ok(good.count > 0);

  // An unreadable vault is the cheapest way to force a truncated walk. A
  // half-read vault written over a good set silently un-trusts whatever it
  // failed to reach, and an un-trusted note is indistinguishable from one Nick
  // never marked.
  const real = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'does-not-exist');
  const result = knowledgeTrust.refreshTrust();
  process.env.OBSIDIAN_VAULT_PATH = real;

  assert.equal(result.stored, false);
  assert.equal(result.known, false);

  const after = knowledgeTrust.trustedPaths();
  assert.equal(after.count, good.count);
  assert.ok(after.paths.has('Projects/Support Hub/SOP.md'));
});

test('the index is written, and lists the marked note', async () => {
  await call('POST', '/trust/refresh');
  const index = fs.readFileSync(path.join(vault, knowledgeTrust.INDEX_PATH), 'utf-8');
  assert.match(index, /Support Hub\/SOP\|SOP/);
  assert.ok(index.includes(knowledgeTrust.INDEX_OPEN));
});

test('⚠ the generated index is never itself offered as knowledge', async () => {
  const res = await call('GET', '/trusted');
  assert.equal(res.status, 200);
  assert.equal(res.json.notes.some((n) => n.path === knowledgeTrust.INDEX_PATH), false);

  // And it cannot reach a trusted-scope search either, which is what would
  // hand back a page of titles matching every query about any of them.
  const scoped = await retrieval.search('Knowledge Index', { maxResults: 10, scope: 'trusted' });
  assert.equal(scoped.some((r) => r.path === knowledgeTrust.INDEX_PATH), false);
});

// ── Candidates over HTTP ─────────────────────────────────────────────────────

test('candidates account for what they withhold, and drop a note once marked', async () => {
  knowledgeCandidates.invalidate();
  const res = await call('GET', '/candidates?minScore=0');
  assert.equal(res.status, 200);
  assert.equal(res.json.known, true);

  const paths = res.json.candidates.map((c) => c.path);
  // Already marked, so it is out of the queue and counted as such.
  assert.equal(paths.includes('Projects/Support Hub/SOP.md'), false);
  assert.ok(res.json.withheld.trusted >= 1);
  assert.ok(paths.includes('Projects/Support Hub/Other.md'));
});

test('untrusting puts a note back in the queue', async () => {
  const res = await call('POST', '/untrust', { path: 'Projects/Support Hub/SOP.md' });
  assert.equal(res.status, 200);

  await call('POST', '/trust/refresh');
  knowledgeCandidates.invalidate();

  const after = await call('GET', '/candidates?minScore=0');
  assert.ok(after.json.candidates.map((c) => c.path).includes('Projects/Support Hub/SOP.md'));

  // And it leaves the trusted-scope search again.
  const scoped = await retrieval.search('zebra', { maxResults: 10, scope: 'trusted' });
  assert.equal(scoped.some((r) => r.path === 'Projects/Support Hub/SOP.md'), false);
});
