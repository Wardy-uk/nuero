'use strict';

/**
 * Build 18 over real HTTP: api-auth → authority guard → the native-build
 * middleware (same order as server.js) → real routers → real SQLite + a temp
 * vault. Proves the build header is recorded only for an authenticated caller,
 * the version view answers, the coverage audit answers, and a machine cannot
 * write a birthday into Nick's notes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b18r-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b.db');
process.env.NEURO_PIN = 'pin-1818';
process.env.NEURO_API_TOKEN = 'machine-token';
process.env.NEURO_TIMEZONE = 'Europe/London';
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Companions'), { recursive: true });
fs.writeFileSync(path.join(vault, 'People', 'Isaac Ward.md'), '---\ntype: person\n---\n\n# Isaac\n');
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');

let server;
let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api', require('../services/native-build').middleware);
  app.use('/api/apple', require('./apple'));
  app.use('/api/loops', require('./loops'));
  app.use('/api/setup', require('./setup'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const AS = { machine: { 'X-Neuro-Api-Token': 'machine-token' }, nick: { 'X-Neuro-Pin': 'pin-1818' }, nobody: {} };
async function call(method, url, who, body, extra = {}) {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...AS[who], ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const BUILD = { 'X-Neuro-Client': 'saim-ios', 'X-Neuro-Build': 'v=1.18;b=7;c=dbf53da;p=18;cap=device-status,workout-route-summary,calendar-window-60d,build-report' };

test('an unauthenticated caller cannot plant a build; an authenticated phone request records one', async () => {
  const anon = await call('GET', '/api/setup/native', 'nobody', undefined, BUILD);
  assert.equal(anon.status, 401);
  assert.equal(db.all('SELECT * FROM native_builds').length, 0);

  const ok = await call('GET', '/api/apple/status', 'nick', undefined, BUILD);
  assert.equal(ok.status, 200);
  const v = await call('GET', '/api/setup/native', 'nick');
  assert.equal(v.status, 200);
  const saim = v.body.apps.find((a) => a.client === 'saim-ios');
  assert.equal(saim.reported, true);
  assert.equal(saim.buildLabel, '1.18 (7) · dbf53da');
  assert.equal(saim.sources.find((s) => s.sourceId === 'healthkit.saim-ios').state, 'current');
  const neuro = v.body.apps.find((a) => a.client === 'neuro-ios');
  assert.equal(neuro.reported, false, 'positive control: an app that never sent a build is not reported');
  assert.ok(v.body.places && v.body.places.parent === 'location.neuro-ios');
});

test('the coverage audit answers, and says so when nothing has been measured', async () => {
  const r = await call('GET', '/api/apple/calendar/coverage', 'nick');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.clients, []);
  assert.match(r.body.note, /fills from the next phone push/);
});

test('Nick can write a birthday; a machine cannot; omitting date is a 400, not a removal', async () => {
  const machine = await call('POST', '/api/loops/personal-dates/declared', 'machine', { entity: 'People/Isaac Ward', kind: 'birthday', date: '2010-03-14' });
  assert.equal(machine.status, 403);
  assert.doesNotMatch(fs.readFileSync(path.join(vault, 'People', 'Isaac Ward.md'), 'utf8'), /birthday:/);

  const missing = await call('POST', '/api/loops/personal-dates/declared', 'nick', { entity: 'People/Isaac Ward', kind: 'birthday' });
  assert.equal(missing.status, 400);

  const set = await call('POST', '/api/loops/personal-dates/declared', 'nick', { entity: 'People/Isaac Ward', kind: 'birthday', date: '2010-03-14' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.match(fs.readFileSync(path.join(vault, 'People', 'Isaac Ward.md'), 'utf8'), /^birthday: "2010-03-14"$/m);

  const ents = await call('GET', '/api/loops/personal-dates/entities', 'nick');
  assert.equal(ents.body.entities.find((e) => e.entity === 'People/Isaac Ward').birthday, '2010-03-14');

  const bad = await call('POST', '/api/loops/personal-dates/declared', 'nick', { entity: 'People/Isaac Ward', kind: 'birthday', date: '14/03/2010' });
  assert.equal(bad.status, 400);

  const pdr = await call('GET', '/api/loops/personal-dates', 'nick');
  assert.equal(pdr.status, 200);
  assert.ok(pdr.body.heading, 'the list always says what it is');
  assert.notEqual(pdr.body.coverage.state, 'complete', 'no phone coverage measured → never "complete"');
});
