'use strict';

/**
 * Food through the REAL ingest route into the REAL nutrition read, against a
 * scratch SQLite. The bug this pins was invisible to the service suite:
 * health_samples' UNIQUE(metric, recorded_at) folded every MyFitnessPal entry
 * logged in one sitting into the first (294 of 1,558 kcal, 12 Oct 2026).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

// ⚠ Before any require that loads the DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-nutrition-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'n.db');

const db = require('../db/database');
const nutrition = require('../services/nutrition');

let server;
let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/v1', require('./apple-health'));
  app.use('/api/health', require('./health'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

// One sitting, three meals, all stamped the same minute — as MyFitnessPal does.
const AT = new Date(Date.now() - 60 * 60 * 1000);
AT.setUTCSeconds(0, 0);
const stamp = AT.toISOString().replace('T', ' ').slice(0, 19) + ' +0000';

function body(meals) {
  return {
    data: {
      metrics: [
        { name: 'dietary_energy', units: 'kcal', data: meals.map((m) => ({ date: stamp, qty: m.kcal, source_uuid: `E-${m.id}` })) },
        { name: 'sodium', units: 'mg', data: meals.map((m) => ({ date: stamp, qty: m.sodiumMg, source_uuid: `S-${m.id}` })) },
      ],
    },
  };
}

async function post(b) {
  const res = await fetch(`${base}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'tailscale-user-login': 'nick@test', 'user-agent': 'Saim/298' },
    body: JSON.stringify(b),
  });
  return res.status;
}

const MEALS = [{ id: 1, kcal: 294, sodiumMg: 1 }, { id: 2, kcal: 520, sodiumMg: 1800 }, { id: 3, kcal: 744, sodiumMg: 1828 }];

test('three entries in the same minute all count, and a re-send folds', async () => {
  assert.equal(await post(body(MEALS)), 200);
  assert.equal(await post(body(MEALS)), 200); // the phone re-sends a window
  const out = nutrition.read({ days: 7 });
  const day = out.days.find((d) => d.logged);
  assert.equal(day.kcal, 1558);
  // 3,629 mg sodium, stored in grams, shown as salt (× 2.5).
  assert.equal(day.totals.dietary_sodium, 9.1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM nutrition_entries').n, 6);
});

test('the route serves it', async () => {
  const pin = process.env.NEURO_PIN;
  const res = await fetch(`${base}/api/health/nutrition?days=7`, { headers: pin ? { 'x-neuro-pin': pin } : {} });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.summary.loggedDays, 1);
  assert.equal(json.summary.todayKcal === 1558 || json.days.some((d) => d.kcal === 1558), true);
});
