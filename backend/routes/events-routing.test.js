'use strict';

/**
 * /api/events over real HTTP — a green service suite says nothing about routing.
 * Read-only by construction: there is no route that writes, and this pins it.
 *
 *   run: node --test backend/routes/events-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-events-route-')), 'a.db');

const db = require('../db/database');
const bus = require('../services/event-bus');
const sh = require('../services/source-health');
const router = require('./events');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/events', router);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/events`;
});
test.after(() => server && server.close());

test('GET /status: an empty log is reported as empty, with the projector listed', async () => {
  const res = await fetch(`${base}/status`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.events.count, 0);
  assert.equal(j.events.newestAt, null);
  assert.ok(j.consumers.some(c => c.name === 'source-health'));
  assert.equal(j.sourceHealth.consumer, 'source-health');
});

test('GET /source-health: a run shows up once the projector has caught up', async () => {
  const run = sh.beginSourceRun('route.test', { system: 'unit', staleAfterMs: 60000 });
  run.fail('Graph 401', { reason: 'fetch-threw' });

  let j = await (await fetch(`${base}/source-health`)).json();
  assert.equal(j.projection.current, false, 'behind the log, and it says so');

  await bus.pumpConsumer(sh.CONSUMER);
  j = await (await fetch(`${base}/source-health`)).json();
  assert.equal(j.projection.current, true);
  const s = j.sources.find(x => x.sourceId === 'route.test');
  assert.equal(s.state, 'failing');
  assert.equal(s.freshness, 'unknown', 'never succeeded: nothing to be fresh about');
  assert.equal(s.failure.error, 'Graph 401');

  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.events.count, 2);
  assert.ok(status.events.newestAt);
  assert.equal(status.consumers.find(c => c.name === 'source-health').lag, 0);
});

test('there is no write route: replay is a CLI, not a button', async () => {
  for (const p of ['/replay/source-health', '/status', '/source-health']) {
    const res = await fetch(`${base}${p}`, { method: 'POST' });
    assert.equal(res.status, 404, `POST ${p}`);
  }
});
