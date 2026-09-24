'use strict';

/**
 * Reaching the back catalogue, over real HTTP.
 *
 * The queue has always defaulted to 21 days. That is right for "what landed this
 * week" — and it meant the other 775 of the vault's 814 candidates were not ranked
 * badly, they were NOT IN THE QUEUE AT ALL, with nothing on screen saying so. The
 * enrichment pass beside it uses 3650, so the two halves of one feature disagreed
 * about how much vault exists by a factor of 170.
 *
 * A green service suite says nothing about routing, and this route takes a number
 * off a query string — which is exactly where a clamp gets added by someone being
 * helpful. Pinned here because the difference between refusing and clamping is the
 * difference between "that isn't a window" and silently answering about this week
 * when the caller asked about four years.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-kwin-'));
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '09'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const note = (name, date, body) => fs.writeFileSync(
  path.join(vault, 'Meetings', '2026', '09', `${name}.md`),
  `---\nnote_type: meeting-summary\nsource: PLAUD\ndate: ${date}\nduration_ms: "3600000"\n---\n\n${body}\n`,
  'utf-8'
);

const BIG = `## Meeting Notes
${Array.from({ length: 12 }, (_, i) => `- Topic Title: Topic ${i + 1}\n- Conclusion: Settled ${i + 1}.`).join('\n')}

## Next Arrangements
${Array.from({ length: 18 }, () => '- [ ] chase').join('\n')}
`;

// Dated relative to the wall clock, never hard-coded: a fixture pinned to a literal
// date is a bomb that goes off the week it falls out of the window.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

let server;
let base;

test.before(async () => {
  note('recent', daysAgo(3), BIG);
  note('old', daysAgo(400), BIG);

  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-memory', require('./knowledge-memory'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (qs) => {
  const res = await fetch(`${base}/api/knowledge-memory/overview${qs}`);
  return { status: res.status, body: await res.json() };
};

test('the default window still stops at 21 days', async () => {
  const { status, body } = await get('');
  assert.equal(status, 200);
  assert.equal(body.counts.promotionCandidates, 1, 'only the recent note is in range');
  assert.equal(body.counts.promotionWindowDays, 21);
});

test('daysBack reaches the back catalogue', async () => {
  const { status, body } = await get('?daysBack=3650');
  assert.equal(status, 200);
  assert.equal(body.counts.promotionCandidates, 2, 'the 400-day-old note is now reachable');
  assert.equal(body.counts.promotionWindowDays, 3650);
});

test('⚠ the window is REPORTED, so a count cannot lie about what it counted', async () => {
  // 814 and 26 are the same field and mean completely different things. A screen that
  // guessed the window would eventually guess wrong.
  const narrow = await get('?daysBack=21');
  const wide = await get('?daysBack=3650');
  assert.notEqual(narrow.body.counts.promotionCandidates, wide.body.counts.promotionCandidates);
  assert.notEqual(narrow.body.counts.promotionWindowDays, wide.body.counts.promotionWindowDays);
});

test('⚠ junk is REFUSED, never clamped', async () => {
  for (const bad of ['0', '-5', 'lastweek', '9999', '1.5']) {
    const { status, body } = await get(`?daysBack=${bad}`);
    assert.equal(status, 400, `daysBack=${bad} must be refused`);
    assert.equal(body.ok, false);
    assert.match(body.error, /daysBack/, 'the refusal names the offending field');
  }
});

test('the signal ranks the back catalogue, not the clock', async () => {
  // The old note is BIG and the recent one is identical, so with the window open they
  // tie on score — which is the honest outcome and proves the rank is not reading the
  // date. What must not happen is the older, richer note being unreachable.
  const { body } = await get('?daysBack=3650');
  const names = body.promotionCandidates.map((c) => c.name);
  assert.ok(names.includes('old'), 'the back catalogue is offered, not just listed');
  for (const c of body.promotionCandidates) {
    assert.ok(c.signal, 'each card carries the signal its rank was built from');
  }
});
