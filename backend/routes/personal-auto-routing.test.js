'use strict';

// /api/personal-auto (1 Nov 2026): real HTTP through the real authority guard
// and real SQLite. The two writes are Nick's — a machine is refused before the
// route runs, and the route refuses it again on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-personal-auto-'));
process.env.NEURO_DB_PATH = path.join(root, 'pa.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const db = require('../db/database');
const matrix = require('../services/authority-matrix');

let server, base;
async function req(method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/personal-auto', require('./personal-auto'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

test('the matrix refuses machines on both writes, and lets them read', () => {
  for (const p of ['/api/personal-auto/tea-shopping', '/api/personal-auto/hike-suggestion/dismiss']) {
    assert.equal(matrix.machineDecision('POST', p).allow, false, p);
  }
  assert.equal(matrix.machineDecision('GET', '/api/personal-auto').allow, true);
});

test('one read carries all four, and the tea switch flips', async () => {
  const r = await req('GET', '/api/personal-auto');
  assert.equal(r.status, 200);
  assert.ok('renewals' in r.json && 'teaShopping' in r.json && 'hike' in r.json && 'gpPacks' in r.json);
  assert.equal(r.json.teaShopping.enabled, true, 'default on');
  const off = await req('POST', '/api/personal-auto/tea-shopping', { on: false });
  assert.equal(off.status, 200);
  assert.equal((await req('GET', '/api/personal-auto/tea-shopping')).json.enabled, false);
  assert.equal((await req('POST', '/api/personal-auto/tea-shopping', { on: 'no' })).status, 400, 'refused, not guessed');
});

test('a machine is refused on the writes', async () => {
  const m = await req('POST', '/api/personal-auto/tea-shopping', { on: true }, { 'X-Neuro-Machine-Client': 'mcp-local' });
  assert.equal(m.status, 403);
  const d = await req('POST', '/api/personal-auto/hike-suggestion/dismiss', { weekend: '2026-11-07' }, { 'X-Neuro-Machine-Client': 'mcp-local' });
  assert.equal(d.status, 403);
  assert.equal((await req('POST', '/api/personal-auto/hike-suggestion/dismiss', { weekend: '2026-11-07' })).status, 200);
});
