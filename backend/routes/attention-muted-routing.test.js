'use strict';

/**
 * Muted prompts can be SEEN and turned back on from a screen, not only by asking
 * SARA in the standup. Real HTTP, scratch DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-muted-')), 'a.db');

const db = require('../db/database');
const learning = require('../services/attention-learning');

let server;
let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', require('./attention'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const call = (m, u) => fetch(base + u, { method: m }).then(async (r) => ({ status: r.status, json: await r.json() }));

test('a muted kind is listed, and deleting it turns it back on', async () => {
  learning.mute('low-water', 'ignored 9 of 10', 'sara');
  let res = await call('GET', '/api/attention/muted');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.muted.map((m) => m.kind), ['low-water']);
  assert.equal(res.json.muted[0].why, 'ignored 9 of 10');

  res = await call('DELETE', '/api/attention/muted/low-water');
  assert.equal(res.status, 200);
  assert.equal(learning.isMuted('low-water'), false);

  res = await call('GET', '/api/attention/muted');
  assert.deepEqual(res.json.muted, []);
});

test('turning on something that was not muted is a 404 with the reason, not a success', async () => {
  const res = await call('DELETE', '/api/attention/muted/sedentary');
  assert.equal(res.status, 404);
  assert.match(res.json.error, /was not muted/);
});

test('⚠ an UNREADABLE store is a named failure, never "nothing muted", and is not overwritten', async () => {
  // The service keeps its key private, so read it from the source rather than guess it.
  const src = require('fs').readFileSync(require.resolve('../services/attention-learning'), 'utf8');
  const stateKey = (src.match(/STATE_KEY = '([^']+)'/) || [])[1];
  assert.ok(stateKey, 'could not find the store key');
  db.setState(stateKey, '{not json');

  const res = await call('GET', '/api/attention/muted');
  assert.equal(res.status, 500);
  assert.equal(res.json.ok, false);

  learning.mute('sedentary', 'test', 'nick');
  assert.equal(db.getState(stateKey), '{not json', 'a write over an unreadable store erased it');
});
