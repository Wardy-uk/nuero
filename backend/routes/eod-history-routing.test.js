'use strict';

/**
 * `GET /api/standup/eod-history`, over real HTTP against a real vault.
 *
 * The service suite pins the parser; this pins that the ROUTE asks it. The bug
 * being fixed was precisely a route carrying its own private copy of a parser
 * that had fallen a generation behind, so a test that only exercises the shared
 * function would have passed throughout the period the view was blank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-eodhist-'));
fs.mkdirSync(path.join(VAULT, 'Daily'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-eodhist-db-')), 'a.db');

const db = require('../db/database');

let server;
let base;

// The route walks back from TODAY, so fixtures are dated off the real clock.
// A fixed date here would pass only while that date happened to be inside the
// window and start failing silently afterwards — the date bomb this repo has
// been bitten by twice.
const dayKey = (back) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const write = (back, body) =>
  fs.writeFileSync(path.join(VAULT, 'Daily', `${dayKey(back)}.md`), body, 'utf-8');

test.before(async () => {
  await db.init();

  // Current generation, several items — the shape that returned all nulls.
  write(1, `# Day\n\n## Focus Today\n- [x] a #focus\n\n## EOD\n\n**Done:**\n- Ticket type analysis for Mel\n- Prep for Risk meeting\n**Didn't go to plan:** Catch-up with Chris\n**Mood:** Rough\n`);
  // Legacy generation.
  write(2, `# Day\n\n## EOD — ${dayKey(2)}\n\n**Win:** Made some progress on nova data\n\n**Didn't go to plan:** The whole day\n\n**Feeling:** Some stress\n`);
  // Current generation, single item.
  write(3, `# Day\n\n## EOD\n\n**Done:**\n- Got Sara properly working\n**Mood:** Tired but content\n`);
  // A day with a note but NO EOD — must not appear at all.
  write(4, `# Day\n\n## Focus Today\n- [ ] something #focus\n`);

  const app = express();
  app.use(express.json());
  app.use('/api/standup', require('./standup'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = (url) => fetch(`${base}${url}`).then(async r => ({ status: r.status, json: await r.json() }));

test('THE REPORTED BUG: a current-format entry comes back populated', async () => {
  const res = await get('/api/standup/eod-history?days=7');
  assert.equal(res.status, 200);
  const e = res.json.entries.find(x => x.date === dayKey(1));
  assert.ok(e, 'the day must be in the history');
  assert.equal(e.feeling, 'Rough', 'Mood must fill the feeling slot');
  assert.deepEqual(e.done, ['Ticket type analysis for Mel', 'Prep for Risk meeting']);
  assert.equal(e.didntGo, 'Catch-up with Chris');
  // Honest: two items, so no single win is claimed.
  assert.equal(e.win, null);
});

test('the legacy format is untouched', async () => {
  const { json } = await get('/api/standup/eod-history?days=7');
  const e = json.entries.find(x => x.date === dayKey(2));
  assert.equal(e.win, 'Made some progress on nova data');
  assert.equal(e.feeling, 'Some stress');
  assert.equal(e.didntGo, 'The whole day');
  assert.deepEqual(e.done, ['Made some progress on nova data']);
});

test('a lone done item fills the win slot over HTTP too', async () => {
  const { json } = await get('/api/standup/eod-history?days=7');
  const e = json.entries.find(x => x.date === dayKey(3));
  assert.equal(e.win, 'Got Sara properly working');
  assert.equal(e.feeling, 'Tired but content');
  assert.equal(e.didntGo, null, 'absent stays absent');
});

test('every entry has the same keys whichever generation wrote it', async () => {
  const { json } = await get('/api/standup/eod-history?days=7');
  const shapes = json.entries.map(e => Object.keys(e).sort().join(','));
  assert.equal(new Set(shapes).size, 1, `consumers must not branch on format: ${shapes}`);
  assert.deepEqual(shapes[0].split(','), ['date', 'didntGo', 'done', 'feeling', 'win']);
});

test('a note with no EOD section is absent, not an empty entry', async () => {
  const { json } = await get('/api/standup/eod-history?days=7');
  assert.equal(json.entries.find(x => x.date === dayKey(4)), undefined);
  assert.equal(json.entries.length, 3);
});

test('days= bounds the window', async () => {
  const { json } = await get('/api/standup/eod-history?days=2');
  assert.deepEqual(json.entries.map(e => e.date), [dayKey(1)]);
});
