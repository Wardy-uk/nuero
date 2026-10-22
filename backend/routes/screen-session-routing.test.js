'use strict';

/**
 * A household session for the shared room screens (22 Oct 2026), over real HTTP
 * through the REAL auth middleware — the whole rule is WHO may ask, and only the
 * middleware decides that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-screen-session-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = 'api-token-for-test';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-token-for-test';
process.env.NEURO_PIN = '424242';
delete process.env.VESTA_SCREEN_ACCOUNTS;

const express = require('express');
const db = require('../db/database');
const capture = require('../services/capture-links');

let server, base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api/capture-links', require('./capture-links'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  capture.create({ label: 'Family', username: 'family', pin: '135790', scopes: ['tasks', 'calendar', 'house'] });
  capture.create({ label: 'Her', username: 'her', pin: '246802', scopes: ['tasks'] });
});

test.after(() => new Promise((r) => server.close(r)));

const ask = (headers, body = { username: 'family' }) => fetch(`${base}/api/capture-links/screen-session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

test('the kiosk credential gets a live household session for the screen account', async () => {
  const r = await ask({ 'X-NEURO-KIOSK-TOKEN': 'kiosk-token-for-test' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const account = capture.resolveSession(r.json.token);
  assert.ok(account, 'the token resolves');
  assert.equal(account.username, 'family');
});

test('the PIN, the API token and no credential are all refused', async () => {
  assert.equal((await ask({ 'X-NEURO-PIN': '424242' })).status, 403);
  assert.equal((await ask({ 'X-NEURO-API-TOKEN': 'api-token-for-test' })).status, 403);
  assert.equal((await ask({})).status, 401);
});

test('only an account named for the screens is issued', async () => {
  const r = await ask({ 'X-NEURO-KIOSK-TOKEN': 'kiosk-token-for-test' }, { username: 'her' });
  assert.equal(r.status, 403);
  assert.ok(!r.json.token);
});

test('a revoked screen account gets nothing', async () => {
  capture.revoke('family');
  const r = await ask({ 'X-NEURO-KIOSK-TOKEN': 'kiosk-token-for-test' });
  assert.equal(r.status, 404);
  assert.ok(!r.json.token);
});
