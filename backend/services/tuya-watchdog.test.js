'use strict';

// Tuya push watchdog — the 1 Nov 2026 failure, replayed without a network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assess, tick, STALE_MS, RELOAD_COOLDOWN_MS, STILL_DEAD_AFTER_MS, DEFAULT_CANARIES } = require('./tuya-watchdog');

const NOW = Date.parse('2026-11-01T18:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const st = (id, heardMs) => ({ entity_id: id, state: '20', last_reported: iso(heardMs), last_changed: iso(heardMs) });

function fakeDb() {
  const m = new Map();
  return { getState: (k) => m.get(k) ?? null, setState: (k, v) => m.set(k, v) };
}

test('fresh canary = ok; every canary silent past STALE_MS = stale', () => {
  const ok = assess([st(DEFAULT_CANARIES[0], NOW - STALE_MS - 1), st(DEFAULT_CANARIES[3], NOW - 60000)], NOW);
  assert.equal(ok.state, 'ok', 'one canary still reporting means the integration is alive');
  const stale = assess(DEFAULT_CANARIES.map((e) => st(e, NOW - STALE_MS - 60000)), NOW);
  assert.equal(stale.state, 'stale');
  assert.match(stale.why, /no Tuya device has reported/);
});

test('not knowing never counts as dead', () => {
  assert.equal(assess(null, NOW).state, 'unknown');
  assert.equal(assess([], NOW).state, 'unknown');
  assert.equal(assess([st('sensor.other', NOW - 10 * STALE_MS)], NOW).state, 'unknown', 'no canary present');
});

test('the 1 Nov episode: reload once, alert once if it stays dead, log recovery', async () => {
  const db = fakeDb();
  const log = []; const reloads = []; const pushes = [];
  let heard = NOW - STALE_MS - 60000;
  const deps = (now) => ({
    now, db, env: {},
    fetchStates: async () => DEFAULT_CANARIES.map((e) => st(e, heard)),
    reload: async (e) => { reloads.push(e); },
    push: async (t, b, d) => { pushes.push(d); },
    log: (k) => log.push(k),
  });

  assert.equal((await tick(deps(NOW))).acted, 'reloaded');
  assert.equal((await tick(deps(NOW + 10 * 60000))).acted, null, 'cooldown: no second reload ten minutes later');
  assert.equal((await tick(deps(NOW + STILL_DEAD_AFTER_MS))).acted, 'alerted');
  assert.equal((await tick(deps(NOW + STILL_DEAD_AFTER_MS + 60000))).acted, null, 'alert once per episode');
  assert.equal((await tick(deps(NOW + RELOAD_COOLDOWN_MS))).acted, 'reloaded', 'tries again after the cooldown');
  assert.deepEqual(pushes.map((p) => p.type), ['sense_alert']);

  heard = NOW + RELOAD_COOLDOWN_MS + 60000;
  assert.equal((await tick(deps(NOW + RELOAD_COOLDOWN_MS + 2 * 60000))).acted, 'recovered');
  assert.deepEqual(log, ['tuya-push-reloaded', 'tuya-push-still-dead', 'tuya-push-reloaded', 'tuya-push-recovered']);
  assert.equal(reloads.length, 2);
  assert.equal(reloads[0], DEFAULT_CANARIES[0], 'reloads the config entry that owns a canary');
});

test('Home Assistant unreachable: nothing reloaded, nothing logged', async () => {
  const db = fakeDb(); const log = [];
  const r = await tick({ now: NOW, db, env: {}, fetchStates: async () => { throw new Error('ECONNREFUSED'); },
    reload: async () => assert.fail('must not reload'), push: async () => assert.fail('must not push'), log: (k) => log.push(k) });
  assert.equal(r.state, 'unknown');
  assert.deepEqual(log, []);
});
