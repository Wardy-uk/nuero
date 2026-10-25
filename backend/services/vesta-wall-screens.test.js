'use strict';
/**
 * The family wall on several screens (25 Oct 2026).
 *  • The kiosk mounts ONE wall, whatever the room verdict — two mounts meant a
 *    full rebuild (a read + every face refetched) on each clock↔full flip.
 *  • Faces are kept in memory where Cache Storage does not exist (the room
 *    screens are plain http, not a secure context).
 *  • Check-ins are kept per DEVICE: three screens share the `family` login.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
// ⚠ Before ANY require that could open the database.
const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-screens-'));
process.env.NEURO_DB_PATH = path.join(ROOT_TMP, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(ROOT_TMP, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const ROOT = path.join(__dirname, '..', '..');

test('the kiosk mounts the family wall in exactly one place', () => {
  const app = fs.readFileSync(path.join(ROOT, 'saim', 'frontend', 'src', 'App.jsx'), 'utf8');
  assert.equal((app.match(/<ScreenWall\b/g) || []).length, 1, 'one <ScreenWall> element');
  assert.match(app, /nickHere=\{homeView\}/, 'the room verdict is a prop, not a second mount');
  assert.match(fs.readFileSync(path.join(ROOT, 'saim', 'frontend', 'src', 'components', 'ScreenWall.jsx'), 'utf8'),
    /place=\{area\}/, 'the room screen says which room it is');
});

test('with no Cache Storage a face is fetched once, then served from memory', async () => {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'vesta', 'src', 'api.js')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  const savedFetch = global.fetch; const savedCaches = global.caches;
  delete global.caches;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, blob: async () => new Blob(['img'], { type: 'image/jpeg' }) }; };
  try {
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
    const api = mod.exports;
    assert.equal(typeof caches, 'undefined', 'positive control: no Cache Storage, as on http');
    for (let i = 0; i < 5; i++) assert.ok(await api.photoUrl(null, 'helen', 'v1'), 'a url every time');
    assert.equal(calls, 1, 'fetched once');
    assert.equal(api.photoStats.miss, 1);
    assert.equal(api.photoStats.hit, 4);
    await api.photoUrl(null, 'helen', 'v2');
    assert.equal(calls, 2, 'a new version is fetched');
    await api.clearPhotoCache();
    await api.photoUrl(null, 'helen', 'v2');
    assert.equal(calls, 3, 'sign-out forgets the faces');
  } finally {
    global.fetch = savedFetch;
    if (savedCaches) global.caches = savedCaches;
  }
});

test('each device keeps its own check-in under one household login', async () => {
  const db = require('../db/database');
  await db.init();
  const capture = require('./capture-links');
  capture.create({ label: 'Family', username: 'fam-test', pin: '246813', scopes: ['tasks'] });
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('../routes/vesta'));
  const server = app.listen(0); const port = server.address().port;
  const call = async (p, { token, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  try {
    const token = (await call('/login', { body: { username: 'fam-test', pin: '246813' } })).json.token;
    assert.ok(token, 'positive control: signed in');
    const held = (s) => encodeURIComponent(s);
    await call(`/wall?held=${held('dev=ipad01;video;home-screen')}&perf=${held('first=net@10')}`, { token });
    await call(`/wall?held=${held('dev=galaxy1;room=living-room;room screen;browser')}&perf=${held('first=cache@20')}`, { token });
    await call(`/wall?held=${held('no device id here')}`, { token });
    const seen = JSON.parse(db.getState('vesta_wall_seen') || '{}')['fam-test'];
    assert.deepEqual(Object.keys(seen.devices).sort(), ['galaxy1', 'ipad01'], 'two devices, neither overwritten');
    assert.match(seen.devices.galaxy1.held, /room=living-room/);
    assert.equal(seen.devices.ipad01.perfLog.length, 1);
    assert.equal(seen.held, 'no device id here', 'the account-level entry is still the latest, as before');
  } finally { server.closeAllConnections(); server.close(); }
});
