'use strict';

/**
 * /api/energy over real HTTP, and the VESTA `energy` scope.
 *
 * The credential half is the one a real HTTP test exists for: the repo is
 * PUBLIC, and a route that echoes a password answers 200 and looks perfect.
 * Bright itself is faked by replacing global fetch for its host only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-energyroute-')), 'a.db');
delete process.env.BRIGHT_USERNAME;
delete process.env.BRIGHT_PASSWORD;
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-session-secret';

const db = require('../db/database');
const capture = require('../services/capture-links');

const PASSWORD = 'hunter2-but-longer-and-unique-9182';
const realFetch = global.fetch;
const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://api.glowmarkt.com/')) return realFetch(url, init);
  const p = new URL(u).pathname.replace('/api/v0-1', '');
  if (p === '/auth') {
    return JSON.parse(init.body).password === PASSWORD
      ? reply(200, { valid: true, token: 'bright-jwt-SECRET', exp: Math.floor(Date.now() / 1000) + 7 * 86400 })
      : reply(401, { valid: false });
  }
  if (p === '/virtualentity') return reply(200, [{ veId: 'v', resources: [] }]);
  if (p === '/virtualentity/v/resources') {
    return reply(200, { resources: [{ resourceId: 'e', classifier: 'electricity.consumption', baseUnit: 'kWh' }, { resourceId: 'g', classifier: 'gas.consumption', baseUnit: 'kWh' }] });
  }
  return reply(404, null);
};

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/energy', require('./energy'));
  app.use('/api/v', require('./vesta'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server && server.close(); global.fetch = realFetch; });

const req = async (method, url, body, headers = {}) => {
  const r = await realFetch(`${base}${url}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
};

test('GET /api/energy before connecting: not connected, no meters, never an invented zero', async () => {
  const r = await req('GET', '/api/energy');
  assert.equal(r.status, 200);
  assert.equal(r.body.contract, 'energy-v1');
  assert.equal(r.body.connection.configured, false);
  assert.equal(r.body.fuels.electricity.present, false);
});

test('POST /credentials: a wrong password is refused and nothing is stored', async () => {
  const r = await req('POST', '/api/energy/credentials', { username: 'nick@example.com', password: 'nope' });
  assert.equal(r.status, 400);
  assert.equal((await req('GET', '/api/energy/connection')).body.connection.configured, false);
});

test('POST /credentials: accepted, discovered, and NEITHER the password NOR the token ever comes back', async () => {
  const r = await req('POST', '/api/energy/credentials', { username: 'nick@example.com', password: PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.body.resources.length, 2);
  for (const url of ['/api/energy', '/api/energy/connection', '/api/energy/tariffs', '/api/energy/insights']) {
    const g = await req('GET', url);
    assert.ok(!g.text.includes(PASSWORD), `${url} leaks the password`);
    assert.ok(!g.text.includes('bright-jwt-SECRET'), `${url} leaks the token`);
    assert.ok(!g.text.includes(PASSWORD.slice(0, 10)));
  }
  assert.ok(!r.text.includes(PASSWORD) && !r.text.includes('bright-jwt-SECRET'));
  assert.equal((await req('GET', '/api/energy/connection')).body.connection.credentialSource, 'stored');
});

test('validation: junk is refused, never clamped', async () => {
  assert.equal((await req('GET', '/api/energy?days=9999')).status, 400);
  assert.equal((await req('GET', '/api/energy/daily?fuel=oil&from=2026-01-01&to=2026-01-02')).status, 400);
  assert.equal((await req('GET', '/api/energy/daily?fuel=gas&from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await req('POST', '/api/energy/tariffs', { fuel: 'gas', effectiveFrom: '2026-01-01', unitRateP: 999, standingPDay: 30 })).status, 400);
  const ok = await req('POST', '/api/energy/tariffs', { fuel: 'gas', effectiveFrom: '2026-01-01', unitRateP: 6.5, standingPDay: 31.4 });
  assert.equal(ok.status, 200);
  const day = await req('GET', '/api/energy/daily?fuel=gas&from=2026-01-01&to=2026-01-01');
  assert.equal(day.body.days[0].kwh, null, 'no readings → null');
  assert.equal(day.body.days[0].costP, null, 'and therefore no cost, not just the standing charge');
  assert.equal((await req('POST', '/api/energy/gas-calorific-value', { cv: 99 })).status, 400);
});

test('DELETE /credentials forgets the login; readings stay', async () => {
  const r = await req('DELETE', '/api/energy/credentials');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.connection.configured, false);
});

test('VESTA: the energy block is ABSENT without the scope, present with it, and carries no tariff or login detail', async () => {
  const pin = '482913';
  capture.create({ label: 'Helen', username: 'helen-e', pin, scopes: ['tasks'] });
  const token = capture.issueSession('helen-e');
  const auth = { authorization: `Bearer ${token}` };
  let home = await req('GET', '/api/v/home', null, auth);
  assert.equal(home.status, 200);
  assert.ok(!('energy' in home.body), 'absent, not empty');
  capture.setScopes('helen-e', ['tasks', 'energy']);
  home = await req('GET', '/api/v/home', null, auth);
  assert.ok(home.body.energy, 'present with the scope');
  assert.ok(Array.isArray(home.body.scopes) && home.body.scopes.includes('energy'));
  assert.ok(!/tariff|unitRate|standing|credential|password/i.test(JSON.stringify(home.body.energy)));
  const wall = await req('GET', '/api/v/wall', null, auth);
  assert.ok(wall.body.energy);
});
