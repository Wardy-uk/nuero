'use strict';

/**
 * Real HTTP through real SQLite: ingest folds a replay, and a HealthKit hike
 * comes back with the readings taken during it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-env-')), 'a.db');

const db = require('../db/database');
const router = require('./environment');

let server;
let base;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const start = Math.floor(Date.now() / 1000) - 6 * 3600;

test.before(async () => {
  await db.init();
  db.insertWorkouts([{
    sourceUuid: 'HK-1', activityType: 'Hiking',
    startedAt: sqlTime(start * 1000), endedAt: sqlTime((start + 7200) * 1000), durationSeconds: 7200,
  }]);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/environment', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const post = (body) => fetch(`${base}/api/environment/readings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const batch = {
  sensorId: 'DDCCBBAA', model: 'Disc Maxi 4-in-1', intervalSeconds: 300,
  readings: Array.from({ length: 30 }, (_, i) => ({
    t: start - 1800 + i * 300, tempC: 10 + i * 0.1, humidityPct: 75, pressureHpa: 1005 - i * 0.2, timingErrorSeconds: 150,
  })),
};

test('ingest stores, then folds the same batch as duplicates', async () => {
  const first = await (await post(batch)).json();
  assert.equal(first.stored, 30);
  const again = await (await post(batch)).json();
  assert.equal(again.stored, 0);
  assert.equal(again.duplicate, 30);
});

test('a second downloader timing the same records a second off is folded', async () => {
  const shifted = { ...batch, readings: batch.readings.map((r) => ({ ...r, t: r.t + 2 })) };
  const json = await (await post(shifted)).json();
  assert.equal(json.stored, 0);
  assert.equal(json.duplicate, 30);
});

test('the cursor is shared, and never rewinds', async () => {
  const cursorOf = async () => (await (await fetch(`${base}/api/environment/sensors/DDCCBBAA`)).json()).cursor;
  assert.equal((await (await fetch(`${base}/api/environment/sensors/NOPE`)).json()).cursor, null);
  const first = await (await post({ ...batch, readings: [], cursor: { logCount: 500, intervalSeconds: 300 }, source: 'pi' })).json();
  assert.equal(first.cursorMoved, true);
  assert.equal((await cursorOf()).logCount, 500);
  const bad = await post({ ...batch, readings: [], cursor: { logCount: 'x' } });
  assert.equal(bad.status, 400);
  assert.equal((await cursorOf()).logCount, 500, 'a malformed cursor must not move it');
});

test('a malformed batch is a 400 with a reason', async () => {
  const res = await post({ readings: [] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /sensorId/);
});

test('the hike comes back with the readings inside its window', async () => {
  const json = await (await fetch(`${base}/api/environment/hikes?days=2`)).json();
  assert.equal(json.ok, true);
  const hike = json.hikes.find((h) => h.id === 'HK-1');
  assert.ok(hike, 'hike missing');
  // Window is [start, start+7200]; readings every 300 s from start-1800 to
  // start+6900 → the 24 from start onward are inside.
  assert.equal(hike.conditions.readings, 24);
  assert.ok(json.latestReadingAt);
});

test('any window can be read raw — the door for the website', async () => {
  const json = await (await fetch(`${base}/api/environment/readings?from=${start}&to=${start + 600}`)).json();
  assert.equal(json.readings.length, 3);
  assert.equal(json.summary.readings, 3);
});
