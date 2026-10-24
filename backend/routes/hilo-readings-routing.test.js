'use strict';

/**
 * GET /api/health/hilo/readings over real HTTP + real SQLite: only the window
 * asked for, newest first, UTC instants, the store's staleness reported, and
 * junk `minutes` refused rather than clamped.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hilo-recent-')), 'a.db');

const db = require('../db/database');
const hilo = require('../services/hilo-import');

let server;
let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/health', require('./health'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api/health/hilo/readings`;
});
test.after(() => server && server.close());

const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 16).replace('T', ' ') + ':00';

test('returns only the last N minutes, newest first, as UTC instants', async () => {
  const rows = [[5, 128, 82], [25, 131, 84], [45, 140, 90]];
  for (const [min, s, d] of rows) {
    db.run(`INSERT INTO hilo_readings (recorded_at, systolic, diastolic, heart_rate, health_state, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, 70, 'pending', ?, ?)`, [stamp(min * 60000), s, d, '2026-10-24T11:03:35Z', '2026-10-24T11:03:35Z']);
  }
  const r = await (await fetch(`${base}?minutes=30`)).json();
  assert.equal(r.windowMinutes, 30);
  assert.deepEqual(r.readings.map((x) => x.systolic), [128, 131]);
  assert.match(r.readings[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  assert.equal(r.readings[0].heartRate, 70);
  assert.equal(r.newestReading, r.readings[0].at);
  assert.equal(r.lastImportAt, '2026-10-24T11:03:35Z');
  assert.equal(r.source, hilo.SOURCE);
});

test('an empty window still says how stale the store is', async () => {
  const r = await (await fetch(`${base}?minutes=1`)).json();
  assert.deepEqual(r.readings, []);
  assert.ok(r.newestReading, 'newest reading is reported even when outside the window');
});

test('junk minutes is a 400, never clamped', async () => {
  for (const q of ['', '?minutes=0', '?minutes=1441', '?minutes=abc', '?minutes=2.5']) {
    assert.equal((await fetch(base + q)).status, 400, q);
  }
});
