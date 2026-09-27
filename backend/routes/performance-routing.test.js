'use strict';

/**
 * Real HTTP through real SQLite: heart rate goes in through the same door ingest
 * uses, exertion comes out the route, and the sleep read refuses without a
 * location.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-perf-')), 'a.db');
delete process.env.NEURO_MAX_HR;

const db = require('../db/database');
const router = require('./performance');

let server;
let base;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

test.before(async () => {
  await db.init();
  const now = Date.now();
  // A fortnight of resting heart rate at 75, so the scale matches his.
  for (let d = 1; d <= 14; d++) {
    const day = new Date(now - d * 86400000).toISOString().slice(0, 10);
    db.upsertHealthDay({ day, rhrMedian: 75, complete: true });
  }
  // Yesterday: a quiet day at 80 bpm with a 60-minute walk at 110 bpm, every 3 min.
  // ⚠ ANCHORED TO YESTERDAY'S MIDNIGHT, never to "now minus N hours": relative to
  // the clock, the walk straddled midnight whenever the suite ran in the early
  // afternoon and split across two days — it failed on the Pi and passed here.
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() - 1);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  for (let m = 0; m < 24 * 60; m += 3) {
    const walking = m >= 600 && m < 660;
    db.insertHealthSample('heartRate', walking ? 110 : 80, sqlTime(start + m * 60000), 'test');
  }
  // One hard minute a month ago sets the observed max.
  db.insertHealthSample('heartRate', 158, sqlTime(now - 20 * 86400000), 'test');
  for (let i = 0; i < 60; i++) db.insertHealthSample('heartRate', 150 + (i % 8), sqlTime(now - 20 * 86400000 + i * 60000), 'test');
  const app = express();
  app.use(express.json());
  app.use('/api/performance', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (p, body) => fetch(`${base}/api/performance${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('rebuild rolls heart rate into exertion, and the walk is what counts', async () => {
  const r = await (await post('/exertion/rebuild', { days: 3 })).json();
  assert.equal(r.ok, true);
  assert.ok(r.written >= 1, `wrote ${r.written}`);
  assert.equal(r.rest, 75);
  const { days } = await (await fetch(`${base}/api/performance/exertion?days=5`)).json();
  const busiest = days.reduce((a, b) => ((b.load || 0) > (a.load || 0) ? b : a));
  assert.ok(busiest.load > 10, `load ${busiest.load}`);
  assert.ok(busiest.elevatedMinutes >= 55 && busiest.elevatedMinutes <= 66, `elevated ${busiest.elevatedMinutes}`);
});

test('today answers, and says its scale is not Athlytic’s', async () => {
  const j = await (await fetch(`${base}/api/performance/today`)).json();
  assert.equal(j.ok, true);
  assert.match(j.scale, /not Athlytic/);
  assert.equal(j.trainingLoad.known, false, 'three days is not three weeks');
});

test('the sleep read refuses until NEURO knows where the logger lives', async () => {
  const before = await (await fetch(`${base}/api/performance/sleep-environment?source=logger`)).json();
  assert.equal(before.needsLocation, true);
  assert.equal((await post('/logger-location', { label: 'bedroom', since: 'soon' })).status, 400);
  const ok = await (await post('/logger-location', { label: 'bedroom', since: '2026-09-27' })).json();
  assert.equal(ok.location.label, 'bedroom');
  const after = await (await fetch(`${base}/api/performance/sleep-environment?source=logger`)).json();
  assert.equal(after.needsLocation, undefined);
});

test('fitness and heat cost answer without data rather than failing', async () => {
  const f = await (await fetch(`${base}/api/performance/fitness`)).json();
  assert.equal(f.vo2max.latest, null);
  const h = await (await fetch(`${base}/api/performance/heat-cost`)).json();
  assert.equal(h.known, false);
});

test('with no bedroom data copied yet, the radiator source says so', async () => {
  const j = await (await fetch(`${base}/api/performance/sleep-environment?source=radiator`)).json();
  assert.equal(j.known, false);
  assert.match(j.why, /no bedroom temperature/);
});
