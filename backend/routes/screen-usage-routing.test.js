'use strict';

/**
 * `/api/screen-usage` and `/api/activity/tab` over real HTTP, through real SQLite.
 *
 * A green service suite says NOTHING about routing, and the pure suite cannot
 * see the chain that actually matters here: a client POSTs a screen open, it
 * lands in `activity_log` as JSON, and the heatmap reads it back out with
 * `json_extract`. Three layers, two of them SQL, and the whole feature is worth
 * nothing if any of them disagrees about where `surface` lives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-screen-usage-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
// No VANTAGE on a dev box. Pointing it at a file that cannot exist is the
// honest default AND exercises the refusal, which is half the contract.
process.env.VANTAGE_DB_PATH = path.join(tmp, 'no-vantage.db');

const db = require('../db/database');

let server;
let base;

const post = (body) => fetch(`${base}/api/activity/tab`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/activity', require('./activity'));
  app.use('/api/screen-usage', require('./screen-usage'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

test('a screen open POSTed by a client comes back out of the heatmap', async () => {
  assert.equal((await post({ tab: 'todos', surface: 'neuro' })).status, 200);
  assert.equal((await post({ tab: 'surface', surface: 'saim' })).status, 200);

  const body = await (await fetch(`${base}/api/screen-usage`)).json();
  const seen = body.rows.map((r) => `${r.surface}/${r.screen}`);
  assert.ok(seen.includes('neuro/todos'), 'the desktop open survived the round trip');
  assert.ok(seen.includes('saim/surface'), 'and SAiM\'s is kept APART from it, which is the whole point');
});

test('⚠ an untagged open reads as NEURO\'s — every row before 17 Sep 2026 is one', async () => {
  assert.equal((await post({ tab: 'briefing' })).status, 200);
  const body = await (await fetch(`${base}/api/screen-usage`)).json();
  const row = body.rows.find((r) => r.screen === 'briefing');
  assert.equal(row.surface, 'neuro');
});

test('⚠ an unrecognised surface is REFUSED, never quietly filed under NEURO', async () => {
  const res = await post({ tab: 'radar', surface: 'nova' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown surface/);
  assert.deepEqual(body.known, ['neuro', 'saim', 'vantage']);

  const usage = await (await fetch(`${base}/api/screen-usage`)).json();
  assert.ok(
    !usage.rows.some((r) => r.screen === 'radar'),
    'a refused open must not have been recorded under some other surface'
  );
});

test('a POST with no tab is a 400 and records nothing', async () => {
  assert.equal((await post({ surface: 'saim' })).status, 400);
});

test('⚠ a checkin: is written by routes/location.js and is NOT a screen', async () => {
  const activity = require('../services/activity');
  activity.trackTabOpen('checkin:Little Eaton');

  const body = await (await fetch(`${base}/api/screen-usage`)).json();
  assert.ok(
    !body.rows.some((r) => r.screen.startsWith('checkin:')),
    'a place name is not a view'
  );
  assert.ok(body.excluded.checkins >= 1, 'and what was excluded is COUNTED, not silently dropped');
});

test('⚠ getTabOpenFirstSeen reads surface out of the JSON — the SQL and the JS must agree', async () => {
  // The pure suite stubs this. If `json_extract` ever disagreed with what
  // `logActivity` writes, every surface would read as never-instrumented and
  // the whole grid would blank out while still answering 200.
  const seen = db.getTabOpenFirstSeen();
  const bySurface = Object.fromEntries(seen.map((r) => [r.surface, r.first_seen]));
  assert.ok(bySurface.neuro, 'NEURO rows were found by the aggregate');
  assert.ok(bySurface.saim, 'and SAiM\'s were told apart from them IN SQL');
  assert.equal(bySurface.nova, undefined, 'the refused surface never reached the store');
});

test('⚠ an unreadable VANTAGE is a named gap, never an unused surface', async () => {
  const body = await (await fetch(`${base}/api/screen-usage`)).json();
  const v = body.surfaces.find((s) => s.id === 'vantage');
  assert.equal(v.known, false);
  assert.ok(v.reason, 'it says WHY, or the panel can only render a blank row');
  assert.equal(v.opens, 0);
  assert.ok(body.gaps.some((g) => /VANTAGE/i.test(g)));
  assert.ok(body.findings.some((f) => f.severity === 'gap' && f.surface === 'vantage'));
});

test('the window is reported and a nonsense one falls back rather than clamping', async () => {
  const four = await (await fetch(`${base}/api/screen-usage?weeks=4`)).json();
  assert.equal(four.window.weeks, 4);
  assert.equal(four.weeks.length, 4);

  // `weeks=-5` clamping to 1 would return one column and look like the truth.
  const silly = await (await fetch(`${base}/api/screen-usage?weeks=-5`)).json();
  assert.equal(silly.window.weeks, 12);
  const alsoSilly = await (await fetch(`${base}/api/screen-usage?weeks=banana`)).json();
  assert.equal(alsoSilly.window.weeks, 12);
});

test('it is READ-ONLY — this panel must never be why something changed', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const res = await fetch(`${base}/api/screen-usage`, { method });
    assert.notEqual(res.status, 200, `${method} must not be handled`);
  }
});
