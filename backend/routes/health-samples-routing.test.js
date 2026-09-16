'use strict';

/**
 * The intraday route resolves, buckets real rows, and refuses what it should.
 *
 * Real HTTP through real SQLite, because a green service suite says nothing
 * about routing — and the bucketing itself is SQL (`strftime` arithmetic and a
 * GROUP BY), which the pure suite cannot see at all. The samples are written
 * through `db.insertHealthSample`, the same door ingest uses, so the timestamp
 * format under test is the one that actually lands in the table.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hsam-')), 'a.db');

const db = require('../db/database');
const router = require('./health');

let server;
let base;

const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600000;

// Shaped like the live feed rather than invented: heart rate ~393 a day (one
// every ~3.5 min), blood pressure ~22 a day, SpO2 as the FRACTION Apple sends.
// A fixture with evenly sparse readings would pass a bucketing test that a real
// day breaks.
function seed(now) {
  for (let m = 0; m < 24 * 60; m += 4) {
    const at = now - m * 60000;
    // A workout an hour ago: the density spike that made the daily median wrong.
    const inWorkout = m > 55 && m < 75;
    db.insertHealthSample('heartRate', inWorkout ? 135 : 72, sqlTime(at), 'test');
  }
  for (let i = 0; i < 20; i++) {
    const at = now - i * 40 * 60000;
    db.insertHealthSample('blood_pressure_systolic', 150 + (i % 5), sqlTime(at), 'test');
    db.insertHealthSample('blood_pressure_diastolic', 88 + (i % 4), sqlTime(at), 'test');
  }
  for (let i = 0; i < 20; i++) {
    db.insertHealthSample('blood_oxygen_saturation', 0.97, sqlTime(now - i * 45 * 60000), 'test');
  }
}

test.before(async () => {
  await db.init();
  seed(Date.now() - 2 * 60000);
  const app = express();
  app.use(express.json());
  app.use('/api/health', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const get = (qs) => fetch(`${base}/api/health/samples${qs}`);

test('the route resolves and buckets a real 24-hour window', async () => {
  const res = await get('?hours=24');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.bucketMinutes, 10);
  assert.equal(json.mode, 'window');
  const hr = json.series.heartRateMedian;
  assert.ok(Array.isArray(hr) && hr.length > 100, `expected a full window, got ${hr && hr.length}`);
  assert.ok(hr.some(p => Number.isFinite(p.v)), 'no bucket carried a value');
});

test('SQL bucketing groups by TIME, not by row', async () => {
  // The whole point of doing it in SQL: ~360 heart-rate rows must come back as
  // ~144 ten-minute buckets, not 360 points.
  const json = await (await get('?hours=24')).json();
  const withValue = json.series.heartRateMedian.filter(p => Number.isFinite(p.v));
  assert.ok(withValue.length <= 145, `${withValue.length} points — not bucketed`);
  assert.ok(withValue.every(p => p.n >= 1), 'every filled bucket says how many readings it holds');
});

test('the workout shows as a SPIKE rather than becoming the window', async () => {
  // ⚠ This is the daily-median bug's shape, checked at the resolution that
  // fixes it. Twenty minutes at 135bpm inside a day at 72 must be visible AND
  // must not drag the rest: a bucket is small enough that the density skew
  // stays where it happened.
  const json = await (await get('?hours=24')).json();
  const vals = json.series.heartRateMedian.filter(p => Number.isFinite(p.v)).map(p => p.v);
  assert.ok(Math.max(...vals) > 120, 'the workout vanished');
  const typical = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  assert.ok(typical < 80, `the workout captured the window (typical bucket ${typical})`);
});

test('SpO2 comes back as a percentage, not the fraction Apple sends', async () => {
  const json = await (await get('?hours=24')).json();
  const vals = json.series.spo2.filter(p => Number.isFinite(p.v)).map(p => p.v);
  assert.ok(vals.length, 'no SpO2 buckets');
  assert.ok(vals.every(v => v > 50), `raw fraction reached the payload: ${vals[0]}`);
});

test('blood pressure arrives as two series that do not collapse', async () => {
  const json = await (await get('?hours=24')).json();
  const sys = json.series.bpSystolic.filter(p => Number.isFinite(p.v)).map(p => p.v);
  const dia = json.series.bpDiastolic.filter(p => Number.isFinite(p.v)).map(p => p.v);
  assert.ok(sys.length && dia.length);
  assert.ok(Math.min(...sys) > Math.max(...dia), 'the two halves have been mixed');
});

test('an empty bucket is NULL, never zero', async () => {
  // Nothing was seeded before 24h ago, so a 7-day window is mostly empty — and
  // that emptiness must read as "not measured", not as a heart rate of nothing.
  const json = await (await get('?hours=168')).json();
  const hr = json.series.heartRateMedian;
  const empties = hr.filter(p => p.v === null);
  assert.ok(empties.length > 100, 'expected a mostly-empty week');
  assert.equal(hr.some(p => p.v === 0), false, 'an empty bucket came back as 0');
});

test('hours=0 is the snapshot, and it carries the age of each reading', async () => {
  const res = await get('?hours=0');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.mode, 'now');
  assert.equal(json.series, undefined, 'a snapshot draws no line');
  assert.ok(json.latest.heartRateMedian, 'no latest heart rate');
  assert.ok(Number.isFinite(Date.parse(json.latest.heartRateMedian.at)),
    'the reading has no usable timestamp, so nothing can say how old it is');
  assert.ok(json.latest.spo2.value > 50, 'the snapshot must scale like the charts');
});

test('a window past a week is REFUSED, not silently clamped', async () => {
  // ⚠ A clamp answers a question nobody asked while looking like it answered the
  // one they did. Past a week the daily rollup is the honest source — 762 days
  // of it — and a bucket average is a different statistic on the same axis.
  const res = await get('?hours=800');
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.maxHours, 24 * 7);
  assert.match(json.error, /history/, 'the refusal must say where to go instead');
});

test('a nonsense window is refused rather than defaulted', async () => {
  for (const bad of ['-5', 'soon']) {
    const res = await get(`?hours=${bad}`);
    assert.equal(res.status, 400, `hours=${bad} was accepted`);
  }
});

test('a series that does not exist is NAMED, not quietly dropped', async () => {
  // A chart asking for a key with no intraday form would otherwise render empty
  // and raise nothing — the reader-with-no-writer shape this area keeps paying
  // for. Sleep is the real case: nightly, so there is nothing to bucket.
  const json = await (await get('?hours=24&keys=heartRateMedian,asleepHours')).json();
  assert.deepEqual(json.unknownKeys, ['asleepHours']);
  assert.ok(json.series.heartRateMedian, 'the valid key still answered');
  assert.equal(json.series.asleepHours, undefined, 'and the invalid one drew nothing');
});

test('the literal /samples path is not swallowed by a sibling', async () => {
  // This router has no bare `/:param` today, and that is worth pinning rather
  // than assuming: Express matches in registration order and this codebase has
  // shipped a literal path eaten by a parameter before.
  const json = await (await get('?hours=24')).json();
  assert.ok(json.series, 'got something that was not the samples payload');
});
