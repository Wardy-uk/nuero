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

const touch = (body) => fetch(`${base}/api/activity/interact`, {
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

test('⚠ the first-seen aggregate reads surface AND kind out of the JSON in SQL', async () => {
  // The pure suite stubs this. If `json_extract` ever disagreed with what
  // `logActivity` writes, every surface would read as never-instrumented and
  // the whole grid would blank out while still answering 200.
  //
  // It records its OWN interaction rather than relying on a test below having
  // run: a test that only passes in file order is one that breaks the first
  // time somebody reorders the file, for a reason that looks like a real bug.
  await touch({ tab: 'todos', surface: 'neuro', count: 3 });

  const seen = db.getScreenEventFirstSeen();
  const map = Object.fromEntries(seen.map((r) => [`${r.event_type}::${r.surface}`, r.first_seen]));
  assert.ok(map['tab_open::neuro'], 'NEURO opens were found by the aggregate');
  assert.ok(map['tab_open::saim'], 'and SAiM was told apart from it IN SQL');
  assert.ok(map['screen_interact::neuro'], 'and an interaction is a SEPARATE row from an open');
  assert.equal(map['tab_open::nova'], undefined, 'the refused surface never reached the store');
});

test('⚠ an interaction is recorded, carries its batch COUNT, and lands on the same row', async () => {
  // Asserted as a DELTA, not an absolute: another test in this file records
  // interactions too, and an absolute would break the moment the file is
  // reordered — for a reason that looks exactly like a real bug.
  const read = async () => {
    const body = await (await fetch(`${base}/api/screen-usage`)).json();
    return body.rows.find((r) => r.screen === 'todos' && r.surface === 'neuro');
  };
  const before = (await read())?.interacted.total ?? 0;
  assert.equal((await touch({ tab: 'todos', surface: 'neuro', count: 14 })).status, 200);
  const row = await read();

  assert.ok(row.opened.total >= 1, 'the open is still there on the same row');
  assert.equal(row.interacted.total - before, 14, 'the batch of 14 clicks arrived as 14, not as 1');
});

test('⚠ the route reports what it STORED, so a clamped flush is visible to the client', async () => {
  const res = await touch({ tab: 'chat', surface: 'saim', count: 99999 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.recorded, 500, 'a runaway count is clamped, and the client is told the real figure');
});

test('an interaction with an unrecognised surface is REFUSED like an open is', async () => {
  const res = await touch({ tab: 'radar', surface: 'nova', count: 3 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown surface/);
});

test('⚠⚠ interactions do NOT land in tab_open — the nudge picker must not see them', async () => {
  // `nudges.js` filters strictly on `event_type === 'tab_open'` to choose what
  // to nudge about, and `outcomes.js` counts them into the Friday reflection.
  // If interactions folded into that type, both would silently change meaning
  // at roughly ten times the volume.
  const all = db.getScreenEventsSince('2000-01-01');
  const opens = all.filter((r) => r.event_type === 'tab_open');
  const touches = all.filter((r) => r.event_type === 'screen_interact');
  assert.ok(opens.length > 0 && touches.length > 0, 'positive control — both kinds really were stored');
  for (const r of opens) {
    assert.equal(JSON.parse(r.event_data).count, undefined, 'a tab_open row must never carry an interaction batch');
  }
});

test('⚠ an unreadable VANTAGE is a named gap, never an unused surface', async () => {
  const body = await (await fetch(`${base}/api/screen-usage`)).json();
  const v = body.surfaces.find((s) => s.id === 'vantage');
  assert.equal(v.known, false);
  assert.ok(v.reason, 'it says WHY, or the panel can only render a blank row');
  assert.equal(v.opens, 0);
  assert.deepEqual(v.since, { opened: null, interacted: null });
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

// ── The REAL VANTAGE reader ─────────────────────────────────────────────────

test('⚠⚠ the real readVantage returns the shape build() consumes', async () => {
  // THIS TEST EXISTS BECAUSE ITS ABSENCE SHIPPED A 500. The pure suite stubs
  // `readVantage`, so it asserted the contract I INTENDED and never ran the
  // function — and when the fold's field was renamed `opens` → `events` the
  // reader was not, so every live call died on "vantage.events is not
  // iterable" with a fully green suite behind it. A stub cannot test the thing
  // it replaces.
  const Database = require('better-sqlite3');
  const file = path.join(tmp, 'vantage-real.db');
  const vdb = new Database(file);
  vdb.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, json TEXT NOT NULL)');
  const ins = vdb.prepare('INSERT INTO docs (collection, json) VALUES (?, ?)');
  const su = require('../services/screen-usage');
  ins.run(su.VANTAGE_COLLECTION, JSON.stringify({ screen: 'radar', kind: 'opened', count: 1, date_key: '2026-09-15', hour: 9 }));
  ins.run(su.VANTAGE_COLLECTION, JSON.stringify({ screen: 'radar', kind: 'interacted', count: 5, date_key: '2026-09-15', hour: 9 }));
  // A row from before interactions existed — no `kind` at all.
  ins.run(su.VANTAGE_COLLECTION, JSON.stringify({ screen: 'plan', count: 1, date_key: '2026-09-15', hour: 9 }));
  vdb.close();

  const prev = process.env.VANTAGE_DB_PATH;
  process.env.VANTAGE_DB_PATH = file;
  try {
    const out = su.readVantage();
    assert.equal(out.known, true, out.reason || 'the real reader could not open a real file');
    assert.ok(Array.isArray(out.events), 'it must return `events` — the field build() spreads');
    assert.equal(out.events.length, 3);

    // And end to end, through the real fold, which is what actually broke.
    const built = su.build({ weeks: 52, db: { getScreenEventsSince: () => [], getScreenEventFirstSeen: () => [] } });
    const radar = built.rows.find((r) => r.screen === 'radar');
    assert.ok(radar, 'the VANTAGE rows reached the grid');
    assert.equal(radar.opened.total, 1);
    assert.equal(radar.interacted.total, 5);
    const plan = built.rows.find((r) => r.screen === 'plan');
    assert.equal(plan.opened.total, 1, 'a kindless legacy row is an OPEN, not reclassified');
    assert.equal(plan.interacted.total, 0);
  } finally {
    process.env.VANTAGE_DB_PATH = prev;
  }
});
