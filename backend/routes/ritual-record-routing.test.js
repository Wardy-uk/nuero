'use strict';

/**
 * The ritual-record routes, over real HTTP.
 *
 * A green service suite says nothing about routing, and this pair has two
 * specific ways to be published and still be uncallable:
 *
 *   1. `POST /eod/record` sits on a router that also declares `POST /eod`. This
 *      codebase has shipped a literal path swallowed by a sibling before
 *      (`/triage/feedback` read as an email id), so the order is pinned here
 *      rather than assumed.
 *
 *   2. ⚠ THE ONE THAT ACTUALLY BIT. Written first as a shared
 *      `recordRitual(kind)` factory, the handlers were a call expression —
 *      `inspect-api.js` reads the function passed to `router.post` and found
 *      nothing, so the MCP inventory came back `body: []`, `bodyOpen: false`.
 *      The gateway's strict schema would then have REJECTED `focus`: an
 *      operation published, discoverable, documented, and impossible to call
 *      with a payload. Caught by regenerating the catalogue and reading it, not
 *      by any test — so the shape is pinned at the end of this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ritual-route-'));
fs.mkdirSync(path.join(VAULT, 'Daily'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ritual-db-')), 'a.db');

const db = require('../db/database');
const { standupDoneIn, parseDailyNote } = require('../services/standup-accountability');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/standup', require('./standup'));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (url, body) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

const read = (d) => {
  const p = path.join(VAULT, 'Daily', `${d}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
};

test('POST /record writes the canonical note and REPORTS that the detector agrees', async () => {
  const day = '2026-09-17';
  fs.writeFileSync(path.join(VAULT, 'Daily', `${day}.md`),
    '\n\n## SAiM Actions\n- 09:00 — Meeting prep\n', 'utf-8');

  const res = await post('/api/standup/record', {
    focus: ['Protect the green', 'Record the podcast'],
    blockers: 'Nothing pressing',
    date: day,
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // ⚠ The route answers the question the caller actually has. A 200 that leaves
  // an assistant to guess whether NEURO now considers the ritual done is how the
  // original bug survived a morning: the write landed and nothing said it had
  // not counted.
  assert.equal(res.json.standupDone, true);
  assert.equal(res.json.committed, 2);

  // The POSITIVE half — a route that answered politely while writing nothing
  // passes any check made on its own output.
  const note = read(day);
  assert.equal(standupDoneIn(note), true);
  assert.match(note, /## SAiM Actions/, 'and it preserved what was already there');
});

test('POST /eod/record is NOT swallowed by POST /eod', async () => {
  const day = '2026-09-16';
  fs.writeFileSync(path.join(VAULT, 'Daily', `${day}.md`),
    '## Focus Today\n- [x] Get Sara working #focus\n', 'utf-8');

  const res = await post('/api/standup/eod/record', {
    done: ['Got Sara properly working'],
    didntGo: 'Nothing',
    tomorrowFirst: 'The podcast',
    date: day,
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.eodDone, true);
  const note = read(day);
  assert.equal(parseDailyNote(note).eodDone, true);
  assert.match(note, /Got Sara properly working/);
  // `/eod` writes a whole separate ritual note; if it had matched, the daily
  // note would not carry an `## EOD` section at all.
  assert.match(note, /^## EOD$/m);
});

test('recording the same standup twice is one standup', async () => {
  const day = '2026-09-19';
  const body = { focus: ['Ship the thing'], date: day };
  await post('/api/standup/record', body);
  const first = read(day);
  const res = await post('/api/standup/record', body);
  assert.equal(res.status, 200);
  assert.equal(read(day), first, 'byte-identical');
  assert.equal(read(day).match(/^## Focus Today$/gm).length, 1);
});

test('a refusal is a 400 that SAYS why, not a 500', async () => {
  // The gateway never returns upstream error text, so a 500 reaches ChatGPT as
  // a bare `backend_http_500` and the model cannot correct itself. A 400 with
  // the reason is the difference between a retry that works and one that does
  // not.
  const empty = await post('/api/standup/record', { focus: [], date: '2026-09-20' });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /focus must contain/);
  assert.equal(read('2026-09-20'), null, 'and nothing was written');

  const badDate = await post('/api/standup/record', { focus: ['a'], date: '20/09/2026' });
  assert.equal(badDate.status, 400);
  assert.match(badDate.json.error, /YYYY-MM-DD/);

  const thinEod = await post('/api/standup/eod/record', { date: '2026-09-20' });
  assert.equal(thinEod.status, 400);
  assert.match(thinEod.json.error, /at least one of/);
});

test('⚠ the MCP inventory carries the body schema these routes need', () => {
  // The factory form published `body: []` with `bodyOpen: false`, which is a
  // STRICT EMPTY object on the gateway — every field below would have been
  // rejected before the request left ChatGPT. There is no runtime symptom to
  // catch: the route works perfectly when called directly.
  const inv = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-inventory.json'), 'utf8'));
  const byId = Object.fromEntries(inv.map(op => [op.id, op]));

  const standup = byId.post_standup_record;
  assert.ok(standup, 'post_standup_record must be in the inventory');
  for (const field of ['focus', 'blockers', 'mood', 'date']) {
    assert.ok(standup.body.includes(field), `standup body must expose ${field}`);
  }

  const eod = byId.post_standup_eod_record;
  assert.ok(eod, 'post_standup_eod_record must be in the inventory');
  for (const field of ['done', 'didntGo', 'tomorrowFirst', 'mood', 'date']) {
    assert.ok(eod.body.includes(field), `eod body must expose ${field}`);
  }

  // The positive control: a field neither route takes must NOT be there, or an
  // inventory that simply listed everything would satisfy the loop above.
  assert.ok(!standup.body.includes('done'));
  assert.ok(!eod.body.includes('focus'));
});

test('⚠ the ritual ops are findable by the words someone would search for', async () => {
  // `neuro_capabilities` is a LITERAL substring match over
  // `id + domain + description`, where description is the inventory's plus the
  // policy note. The obvious query "standup record" found NOTHING when this
  // shipped: the id spells it `standup_record`, and nothing else in the entry
  // carried the two words with a space between them. An operation nobody can
  // find is the state this whole change exists to fix, so the phrasings are
  // pinned rather than left to a description edit to quietly drop.
  //
  // ⚠ The haystack is REBUILT the way api-catalogue.js builds it, not matched
  // against the source text: the notes are template literals, so the source
  // carries an unexpanded `${RECORD_NOTE}` and a regex over it would test a
  // string the gateway never sees. `api-policy.js` imports nothing, so this
  // needs no mcp-server/node_modules and runs on the Pi.
  const { pathToFileURL } = require('url');
  const policyPath = path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js');
  const { notes } = await import(pathToFileURL(policyPath).href);
  const inv = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-inventory.json'), 'utf8'));
  const byId = Object.fromEntries(inv.map(op => [op.id, op]));

  const haystack = (id) => {
    const op = byId[id];
    assert.ok(op, `${id} must be in the inventory`);
    assert.ok(notes[id], `${id} must carry a policy note`);
    return `${op.id} ${op.domain} ${op.description} ${notes[id]}`.toLowerCase();
  };

  const standup = haystack('post_standup_record');
  for (const q of ['standup record', 'standup.record', 'record standup', 'complete standup']) {
    assert.ok(standup.includes(q), `post_standup_record must be findable by "${q}"`);
  }

  const eod = haystack('post_standup_eod_record');
  for (const q of ['eod record', 'eod.record', 'record eod', 'complete eod']) {
    assert.ok(eod.includes(q), `post_standup_eod_record must be findable by "${q}"`);
  }

  // Positive control: a phrase neither carries must NOT match, or a haystack
  // that had accidentally swept in the whole policy file would satisfy every
  // loop above and prove nothing.
  assert.ok(!standup.includes('weekly review'));
  assert.ok(!eod.includes('weekly review'));
});
