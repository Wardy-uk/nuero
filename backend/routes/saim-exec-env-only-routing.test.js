'use strict';

/**
 * The SAiM device lock is managed on the Pi alone (20 Oct 2026).
 *
 * SAIM_PREPARED_MOVE_EXECUTION exactly 'true' opens it; nothing in Settings can.
 * Real HTTP through the real auth + authority guard + feature-flags router, on a
 * scratch database: a human PIN write to this one switch is refused with "This
 * lock is managed on the Pi." and changes nothing at all (no stored value, no
 * Activity line, an old stored value left in place), a machine write is refused
 * by the guard, and every other switch still writes exactly as before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-exec-env-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_PIN = 'pin-2222';
process.env.NEURO_API_TOKEN = 'machine-token-2';
for (const k of ['SAIM_PREPARED_MOVE_EXECUTION', 'VESTA_PHOTO_ENABLED']) delete process.env[k];

const db = require('../db/database');
const flags = require('../services/feature-flags');

const KEY = 'saim_prepared_move_execution';
const STORED = `${flags.STATE_PREFIX}${KEY}`;
let server; let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/feature-flags', require('./feature-flags'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); delete process.env.SAIM_PREPARED_MOVE_EXECUTION; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const AS = { nick: { 'X-Neuro-Pin': 'pin-2222' }, machine: { 'X-Neuro-Api-Token': 'machine-token-2' } };
async function call(method, url, who, body) {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...AS[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const snapshot = () => JSON.stringify({
  state: db.all(`SELECT key, value FROM agent_state WHERE key LIKE ? ORDER BY key`, [`${flags.STATE_PREFIX}%`]),
  flagLog: db.get(`SELECT COUNT(*) n FROM activity_log WHERE event_type = 'feature_flag_changed'`).n,
});

test('a human Settings write to the device lock is refused, changes nothing, and leaves an old stored value alone', async () => {
  db.setState(STORED, 'true'); // an old stored switch value from before this change
  const before = snapshot();
  for (const enabled of [true, false]) {
    const r = await call('POST', `/api/feature-flags/${KEY}`, 'nick', { enabled });
    assert.equal(r.status, 403, `enabled=${enabled}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'This lock is managed on the Pi.');
  }
  assert.equal(snapshot(), before, 'no stored value written, no Activity line');
  assert.equal(db.getState(STORED), 'true', 'not deleted automatically');
  // …and that old value has no effect: env unset → locked.
  assert.equal(flags.isEnabled(KEY), false);
});

test('Settings shows the lock and its state, but only as managed on the Pi', async () => {
  delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
  let f = (await call('GET', '/api/feature-flags', 'nick')).json.flags.find((x) => x.key === KEY);
  assert.deepEqual([f.enabled, f.lockedByEnv, f.managedOnPi], [false, true, true]);
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  f = (await call('GET', '/api/feature-flags', 'nick')).json.flags.find((x) => x.key === KEY);
  assert.deepEqual([f.enabled, f.lockedByEnv, f.managedOnPi], [true, true, true]);
  // With the env open, a write is still refused and the env still decides.
  const r = await call('POST', `/api/feature-flags/${KEY}`, 'nick', { enabled: false });
  assert.equal(r.status, 403);
  assert.equal(flags.isEnabled(KEY), true);
  delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
});

test('a machine caller is refused by the guard before the route', async () => {
  const before = snapshot();
  const r = await call('POST', `/api/feature-flags/${KEY}`, 'machine', { enabled: true });
  assert.equal(r.status, 403);
  assert.notEqual(r.json.error, 'This lock is managed on the Pi.', 'refused by the guard, not the route');
  assert.equal(snapshot(), before);
});

test('every other switch writes exactly as before', async () => {
  const other = flags.list().filter((f) => f.key !== KEY);
  assert.ok(other.length >= 10, 'the other switches are still there');
  assert.ok(other.every((f) => f.managedOnPi === false), 'only the device lock is managed on the Pi');
  const r = await call('POST', '/api/feature-flags/vesta_photo', 'nick', { enabled: true });
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.enabled, true);
  assert.equal(db.getState(`${flags.STATE_PREFIX}vesta_photo`), 'true');
  assert.equal(flags.isEnabled('vesta_photo'), true);
  assert.equal((await call('POST', '/api/feature-flags/vesta_photo', 'nick', { enabled: false })).json.enabled, false);
  // An env-pinned ordinary switch keeps its old refusal (400, "set in the environment").
  process.env.VESTA_PHOTO_ENABLED = 'true';
  const pinned = await call('POST', '/api/feature-flags/vesta_photo', 'nick', { enabled: false });
  assert.equal(pinned.status, 400); assert.match(pinned.json.error, /set in the environment/);
  delete process.env.VESTA_PHOTO_ENABLED;
});
