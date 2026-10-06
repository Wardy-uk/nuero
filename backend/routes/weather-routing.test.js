'use strict';

/**
 * Real HTTP through real SQLite: the forwarder's batch lands once however many
 * times it is sent, a reboot's repeated sequence numbers are kept as new
 * readings, the history survives a restart (read back by a second process),
 * and the overview charts all five ranges with the forecast overlaid.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-weather-')), 'a.db');
process.env.NEURO_DB_PATH = DB_PATH;
process.env.WEATHER_FORECAST_PROVIDER = 'open-meteo';

const db = require('../db/database');
const router = require('./weather');
const forecast = require('../services/weather-forecast');

let server;
let base;
const H = 3600000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const rec = (seq, ms, over = {}) => ({
  schema: 'saim.weather.v1', node_id: 'outdoor-1', sequence: seq,
  temperature_c: 15 + seq * 0.01, humidity_pct: 80, pressure_hpa: 1005 - seq * 0.01,
  battery_mv: null, rssi: -55, received_at: iso(ms), ...over,
});

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/weather', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (body) => fetch(`${base}/api/weather/observations`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const overview = async (q = '') => (await fetch(`${base}/api/weather/overview${q}`)).json();

// Three hours of minutes, sequence 1..180, ending a minute ago.
const START = NOW - 181 * 60000;
const batch = Array.from({ length: 180 }, (_, i) => rec(i + 1, START + i * 60000));

test('a batch stores, and the identical resend folds to duplicates', async () => {
  const first = await (await post({ observations: batch, source: 'saim-weather-ingest@pi5' })).json();
  assert.equal(first.ok, true);
  assert.equal(first.stored, 180);
  const again = await (await post({ observations: batch })).json();
  assert.equal(again.stored, 0);
  assert.equal(again.duplicate, 180);
  assert.ok(again.results.every((r) => r.outcome === 'duplicate'));
});

test('a bare record (no wrapper) is accepted, and a resend of it is a duplicate', async () => {
  const one = rec(181, NOW - 30000);
  assert.equal((await (await post(one)).json()).stored, 1);
  assert.equal((await (await post(one)).json()).duplicate, 1);
});

test('⚠ a reboot restarts the sequence at 1 — those are NEW readings in a new boot, not duplicates', async () => {
  // Same sequence numbers as the start of the run, but stamped AFTER it ended.
  const reboot = [rec(1, NOW - 20000), rec(2, NOW - 10000)];
  const r = await (await post({ observations: reboot })).json();
  assert.equal(r.stored, 2);
  assert.ok(r.results.every((x) => x.boot === 2));
  // And the retry of the reboot's readings still folds.
  assert.equal((await (await post({ observations: reboot })).json()).duplicate, 2);
});

test('⚠ the real bring-up pattern: sequence 1 eight times in six minutes is EIGHT readings', async () => {
  const t0 = NOW - 40 * 60000;
  const ones = [0, 8, 116, 137, 158, 169, 323, 339].map((sec) => rec(1, t0 + sec * 1000, { node_id: 'bringup-1' }));
  assert.equal((await (await post({ observations: ones })).json()).stored, 8);
  assert.equal((await (await post({ observations: ones })).json()).duplicate, 8, 'a resend of all eight folds');
});

test('⚠ a backfill of OLDER readings across a reboot, sent after newer ones, stores every reading', async () => {
  const base = NOW - 50 * 60000;
  const run1 = Array.from({ length: 23 }, (_, i) => rec(i + 1, base + i * 60000, { node_id: 'backfill-1' }));
  const run2 = Array.from({ length: 17 }, (_, i) => rec(i + 1, base + 25 * 60000 + i * 60000, { node_id: 'backfill-1' }));
  // Newest first: the forwarder went live mid-run 2, the journal backfill came later.
  assert.equal((await (await post({ observations: run2.slice(14) })).json()).stored, 3);
  const r = await (await post({ observations: [...run1, ...run2.slice(0, 14)] })).json();
  assert.deepEqual([r.stored, r.duplicate, r.rejected], [37, 0, 0]);
});

test('a bad record is rejected with a reason without failing the rest of the batch', async () => {
  const r = await (await post({ observations: [rec(3, NOW - 5000, { humidity_pct: 140 }), rec(4, NOW - 4000)] })).json();
  assert.equal(r.rejected, 1);
  assert.equal(r.stored, 1);
  assert.match(r.results[0].reason, /humidity_pct/);
});

test('a malformed body is a 400, not a 500', async () => {
  const res = await post({ observations: 'nope' });
  assert.equal(res.status, 400);
});

test('⚠ the history survives a restart — a second process reads every stored row back', () => {
  const out = execFileSync(process.execPath, ['-e', `
    process.env.NEURO_DB_PATH = ${JSON.stringify(DB_PATH)};
    const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))});
    db.init().then(() => {
      const r = db.get("SELECT COUNT(*) AS n, (SELECT MAX(boot) FROM weather_observations WHERE node_id = 'outdoor-1') AS b FROM weather_observations", []);
      process.stdout.write('RESULT ' + JSON.stringify(r));
    });
  `], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.split('RESULT ').pop()), { n: 184 + 8 + 40, b: 2 });
});

test('the overview answers every range with all three metrics charted', async () => {
  for (const range of ['hour', 'day', 'week', 'month', 'year']) {
    const o = await overview(`?range=${range}`);
    assert.equal(o.ok, true, range);
    assert.equal(o.node, 'outdoor-1');
    assert.ok(o.series.length > 20, `${range}: ${o.series.length} buckets`);
    const withData = o.series.filter((s) => s.local.temperatureC != null);
    assert.ok(withData.length >= 1, `${range} has local readings`);
    for (const k of ['temperatureC', 'humidityPct', 'pressureHpa']) assert.ok(withData.every((s) => typeof s.local[k] === 'number'), `${range}.${k}`);
    // An empty bucket is null, never zero.
    assert.ok(o.series.filter((s) => s.n === 0).every((s) => s.local.temperatureC === null));
  }
});

test('the hourly range is raw minutes', async () => {
  const o = await overview('?range=hour');
  assert.equal(o.plan.bucketMs, 60000);
  assert.ok(o.series.filter((s) => s.n > 0).length >= 55);
});

test('latest reading is current and not stale', async () => {
  const o = await overview();
  assert.equal(o.latest.stale, false);
  assert.equal(o.latest.boot, 2);
});

test('an unknown range is refused', async () => {
  const res = await fetch(`${base}/api/weather/overview?range=fortnight`);
  assert.equal(res.status, 400);
});

test('with no forecast stored, the overlay is null-valued and the summary says so', async () => {
  const o = await overview('?range=day');
  assert.ok(o.series.every((s) => s.forecast.temperatureC === null));
  assert.equal(o.summary.forecast.available, false);
  assert.equal(o.summary.comparison.verdict, 'sensor-only');
});

test('⚠ a stored snapshot overlays the chart — standing values for the past, the newest for the future', async () => {
  const hourStart = Math.floor(NOW / H) * H;
  const pts = (issued, offset) => Array.from({ length: 30 }, (_, i) => ({
    validAt: hourStart - 4 * H + i * H, temperatureC: 12 + offset, humidityPct: 85, pressureHpa: 1004 + offset, precipMm: 0, precipProb: 10,
  }));
  forecast.storeSnapshot('open-meteo', hourStart - 5 * H, pts(hourStart - 5 * H, 0)); // standing for the past hours
  forecast.storeSnapshot('open-meteo', hourStart + 1, pts(hourStart, 2));               // issued now: future only
  const o = await overview('?range=day');
  const past = o.series.find((s) => s.t <= NOW - 2 * H && s.t >= NOW - 3 * H);
  const future = o.series.find((s) => s.t >= NOW + 3 * H && s.t <= NOW + 4 * H);
  assert.equal(past.forecast.temperatureC, 12, 'past hour shows the forecast that was standing then');
  assert.equal(future.forecast.temperatureC, 14, 'future hour shows the newest forecast');
  assert.equal(future.local.temperatureC, null, 'no local reading in the future');
  assert.equal(o.forecast.provider, 'open-meteo');
  assert.equal(o.summary.forecast.available, true);
  assert.equal(o.summary.forecast.horizons.length, 3);
  assert.ok(o.summary.sensor.verdict.length > 0);
});
