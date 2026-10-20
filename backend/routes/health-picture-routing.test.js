'use strict';

/**
 * GET /api/health/picture resolves through the real router and the real read()
 * over real SQLite. HiLo-shaped BP samples are written through the same door
 * ingest uses and rolled up by health-daily.sync, so the join from sample → day
 * row → insight is what is under test, not a stub of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hpic-')), 'a.db');

const db = require('../db/database');
const router = require('./health');

let server;
let base;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

test.before(async () => {
  await db.init();
  const now = Date.now();
  for (let d = 1; d <= 10; d++) {
    const at = sqlTime(now - d * 86400000);
    db.insertHealthSample('blood_pressure_systolic', 146, at, 'test');
    db.insertHealthSample('blood_pressure_diastolic', 87, at, 'test');
  }
  require('../services/health-daily').sync({ days: 14 });
  const app = express();
  app.use(express.json());
  app.use('/api/health', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test('the picture route answers with the contract and the BP act item', async () => {
  const res = await fetch(`${base}/api/health/picture`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.contract, 'health-picture-v1');
  const bp = body.insights.find((i) => i.id === 'bp-high');
  assert.ok(bp, `expected a bp-high insight, got ${body.insights.map((i) => i.id).join(', ')}`);
  assert.match(bp.title, /146\/87/);
  assert.equal(body.insights[0].level, 'act');
  assert.ok(body.sources.some((s) => s.name === 'HiLo bracelet' && s.state !== 'none'));
});

test('an empty medical store reads as a gap, not a zero, and the removed ring is gone', async () => {
  const body = await (await fetch(`${base}/api/health/picture`)).json();
  assert.ok(!body.sources.some((s) => /ring/i.test(s.name)));
  assert.ok(body.insights.some((i) => i.id === 'medical-none'));
});
