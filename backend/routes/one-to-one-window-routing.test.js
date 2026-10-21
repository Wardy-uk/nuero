'use strict';

// The mass schedule routes over real HTTP: a bad window is a 400, a machine
// client can never apply a plan, and the plan route actually reaches the planner.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'o21wr-')), 'test.db');

const express = require('express');
const db = require('../db/database');
const booking = require('../services/one-to-one-booking');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-machine']) req.apiClient = { name: 'n8n' }; next(); });
  app.use('/api/1to1', require('./one-to-one'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/1to1`;
});
test.after(() => server && server.close());

const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('plan-window: a window that ends before it starts is a 400 naming why', async () => {
  const r = await post('/plan-window', { people: ['Anyone'], from: '2099-02-10', to: '2099-02-01' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /ends before it starts/);
});

test('plan-window: people is required', async () => {
  const r = await post('/plan-window', { from: '2099-02-01', to: '2099-02-10' });
  assert.strictEqual(r.status, 400);
});

test('plan-window reaches the planner with the body it was given', async (t) => {
  let seen = null;
  t.mock.method(booking, 'planWindow', async (people, opts) => { seen = { people, opts }; return { ok: true, planned: [] }; });
  const r = await post('/plan-window', { people: ['A B'], from: '2099-02-02', to: '2099-02-12', durationMinutes: 45 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(seen, { people: ['A B'], opts: { from: '2099-02-02', to: '2099-02-12', durationMinutes: 45 } });
});

test('apply-window refuses a machine client before doing anything', async (t) => {
  let called = false;
  t.mock.method(booking, 'applyWindow', async () => { called = true; return { ok: true, results: [] }; });
  const r = await post('/apply-window', { items: [{ person: 'A B', mode: 'book' }] }, { 'x-test-machine': '1' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(called, false);
});

test('apply-window: items is required', async () => {
  const r = await post('/apply-window', {});
  assert.strictEqual(r.status, 400);
});
