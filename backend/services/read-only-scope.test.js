'use strict';

/**
 * The read-only pass behind SAiM's prepared-move read (19 Oct 2026). Inside a
 * pass: no database write, only the exact local reads on the allow-list, and
 * the location dwell cache answers from what it holds without refreshing.
 * The pass is per async context and closes when it settles: a concurrent
 * request, or anything that runs after the pass, behaves exactly as before.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-scope-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
delete process.env.HA_WEATHER_ENTITY;

const calls = [];
const realFetch = global.fetch;
// Fake network for everything that is not the test's own loopback server.
global.fetch = async (u, init = {}) => {
  const url = typeof u === 'string' ? u : u.url;
  if (url.startsWith('http://127.0.0.1:') && url.includes('/_t/')) return realFetch(u, init);
  calls.push(`${(init.method || 'GET').toUpperCase()} ${url}`);
  return { ok: true, status: 200, json: async () => ({}) };
};

const db = require('../db/database');
const scope = require('./read-only-scope');

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('inside a pass a database write is refused and counted; outside, writes work as before', async () => {
  db.setState('ro_probe', 'before');
  const p = await scope.run(async () => {
    assert.throws(() => db.setState('ro_probe', 'inside'), /write refused in a read-only pass \(INSERT\)/);
    assert.throws(() => db.run('DELETE FROM agent_state WHERE key = ?', ['ro_probe']), /write refused in a read-only pass \(DELETE\)/);
    assert.equal(db.getState('ro_probe'), 'before', 'reads still work');
    // A timer that fires while the pass is still open is inside it.
    await new Promise((res) => setTimeout(() => { assert.throws(() => db.setState('ro_probe', 'timer')); res(); }, 5));
    return 'done';
  });
  assert.equal(p.result, 'done'); assert.equal(p.writesRefused, 3);
  assert.equal(db.getState('ro_probe'), 'before');
  db.setState('ro_probe', 'after');
  assert.equal(db.getState('ro_probe'), 'after', 'outside the pass writes are unchanged');
});

test('network is an EXACT allow-list: only the five local reads leave; everything else is refused before it is sent', async () => {
  calls.length = 0;
  const refused = [
    ['https://nominatim.openstreetmap.org/reverse?lat=1&lon=2', {}, 'destination'],
    ['https://graph.microsoft.com/v1.0/me/events', {}, 'destination'],
    ['https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST' }, 'destination'],
    ['https://example.org/', {}, 'destination'],
    ['http://192.168.1.10:8123/api/states', {}, 'destination'],
    ['http://100.100.28.58:3001/api/attention', {}, 'destination'],
    ['http://127.0.0.1:8123/api/states', {}, 'destination'],
    ['http://localhost:3001/api/tasks', {}, 'destination'],
    ['http://localhost:8123/api/services/weather/get_forecasts', { method: 'POST' }, 'ha-service-or-event'],
    ['http://localhost:8123/api/events/x', { method: 'POST' }, 'ha-service-or-event'],
    ['http://localhost:8123/api/config', {}, 'ha-path'],
    ['http://localhost:8123/api/states/light.study', {}, 'ha-state-entity'],
    ['http://localhost:8123/api/states', { method: 'POST', body: '{}' }, 'ha-method'],
    ['http://localhost:8123/api/template', { method: 'POST', body: '{"template":"x","extra":1}' }, 'ha-template-body'],
    ['http://localhost:3005/api/presence/room', { method: 'POST' }, 'presence-method'],
    ['http://localhost:3005/api/presence/display', {}, 'presence-path'],
    ['http://user:pw@localhost:8123/api/states', {}, 'credentials-in-url'],
  ];
  const p = await scope.run(async () => {
    for (const [u, init, cat] of refused) {
      await assert.rejects(fetch(u, init), new RegExp(`network refused in a read-only pass \\(${cat}\\)`), u);
    }
    await fetch('http://localhost:8123/api/states');
    await fetch('http://localhost:8123/api/states/weather.forecast_home');
    await fetch('http://localhost:8123/api/history/period/2026-10-19T00:00:00.000Z?filter_entity_id=sun.sun&minimal_response=1');
    await fetch('http://localhost:8123/api/template', { method: 'POST', body: '{"template":"{{ 1 }}"}' });
    await fetch('http://localhost:3005/api/presence/room');
    // http/https modules and WebSocket are refused outright.
    assert.throws(() => http.get('http://localhost:8123/api/states'), /http-module/);
    assert.throws(() => require('https').request('https://nominatim.openstreetmap.org/'), /https-module/);
  });
  assert.equal(Object.values(p.refused).reduce((a, b) => a + b, 0), refused.length + 2, 'every refusal counted');
  assert.equal(p.refused.destination, 8);
  assert.deepEqual(calls, [
    'GET http://localhost:8123/api/states',
    'GET http://localhost:8123/api/states/weather.forecast_home',
    'GET http://localhost:8123/api/history/period/2026-10-19T00:00:00.000Z?filter_entity_id=sun.sun&minimal_response=1',
    'POST http://localhost:8123/api/template',
    'GET http://localhost:3005/api/presence/room',
  ], 'only the five allowed reads reached the network layer; nothing refused was sent');
  calls.length = 0;
  await fetch('https://example.org/'); // outside a pass: unchanged
  assert.deepEqual(calls, ['GET https://example.org/']);
});

test('the location dwell cache answers from what it holds inside a pass — no refresh, no geocode, no write', async () => {
  const location = require('./location');
  const today = new Date().toISOString().split('T')[0];
  db.setState(`location_dwells_${today}`, JSON.stringify([{ name: 'Office' }]));
  db.setState(`location_dwells_time_${today}`, '0'); // stale
  calls.length = 0;
  const p = await scope.run(() => location.getCachedDwells());
  assert.deepEqual(p.result, [{ name: 'Office' }]);
  assert.equal(p.writesRefused, 0); assert.deepEqual(p.refused, {}); assert.deepEqual(calls, []);
  assert.equal(db.getState(`location_dwells_time_${today}`), '0', 'the cache was not refreshed');
});

// ── Concurrency and lifetime ────────────────────────────────────────────────

/** A real HTTP server: one route runs a slow read-only pass, one does an ordinary write. */
function server() {
  const srv = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/_t/prepared')) {
        const p = await scope.run(async () => {
          await tick(60); // the ordinary write lands while this is still open
          let ownWrite = 'allowed';
          try { db.setState('ro_conc_read', 'x'); } catch { ownWrite = 'refused'; }
          let net = 'allowed';
          try { await fetch('https://nominatim.openstreetmap.org/reverse'); } catch { net = 'refused'; }
          await tick(20);
          return { ownWrite, net, sawActive: Boolean(scope.active()) };
        });
        res.end(JSON.stringify({ ...p.result, writesRefused: p.writesRefused }));
      } else if (req.url.startsWith('/_t/write')) {
        await tick(10);
        db.setState('ro_conc_write', req.url);
        res.end(JSON.stringify({ wrote: db.getState('ro_conc_write'), active: Boolean(scope.active()) }));
      } else { res.statusCode = 404; res.end('{}'); }
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('a prepared read and an ordinary authorised write at the same time: the write succeeds, the read still refuses its own', async () => {
  const srv = await server();
  const base = `http://127.0.0.1:${srv.address().port}/_t`;
  try {
    const [r1, w, r2] = await Promise.all([
      fetch(`${base}/prepared/1`).then((r) => r.json()),
      fetch(`${base}/write/ordinary`).then((r) => r.json()),
      fetch(`${base}/prepared/2`).then((r) => r.json()),
    ]);
    assert.deepEqual(w, { wrote: '/_t/write/ordinary', active: false }, 'the unrelated write ran outside any pass and landed');
    for (const r of [r1, r2]) {
      assert.equal(r.ownWrite, 'refused'); assert.equal(r.net, 'refused');
      assert.equal(r.sawActive, true); assert.equal(r.writesRefused, 1);
    }
    assert.equal(db.getState('ro_conc_read'), null, 'neither read wrote');
    // A later ordinary request inherits nothing.
    const after = await fetch(`${base}/write/later`).then((r) => r.json());
    assert.deepEqual(after, { wrote: '/_t/write/later', active: false });
  } finally { srv.close(); }
});

test('the pass always closes — on an exception, a timeout, a rejected network call — and nothing created inside it stays read-only afterwards', async () => {
  // Exception
  await assert.rejects(scope.run(async () => { await tick(1); throw new Error('boom'); }), /boom/);
  assert.equal(scope.active(), null);
  // Rejected network call, unhandled inside the pass
  await assert.rejects(scope.run(() => fetch('https://graph.microsoft.com/v1.0/me')), /network refused/);
  assert.equal(scope.active(), null);
  // Timeout: a pass abandoned by a deadline race still closes when its work settles
  const work = scope.run(() => tick(40));
  const raced = await Promise.race([work.then(() => 'done'), tick(5).then(() => 'timeout')]);
  assert.equal(raced, 'timeout');
  await work;
  // Work scheduled INSIDE a pass that runs AFTER it ends is not read-only.
  let late;
  const lateDone = new Promise((r) => { late = r; });
  await scope.run(async () => {
    setTimeout(() => {
      try { db.setState('ro_late', 'written'); late({ ok: true, active: scope.active() }); } catch (e) { late({ ok: false, e: e.message }); }
    }, 30);
    Promise.resolve().then(() => tick(50)).then(() => fetch('https://example.org/late'));
  });
  calls.length = 0;
  const r = await lateDone;
  assert.deepEqual(r, { ok: true, active: null }, 'a timer from a closed pass writes normally');
  assert.equal(db.getState('ro_late'), 'written');
  await tick(40);
  assert.deepEqual(calls, ['GET https://example.org/late'], 'a promise chain from a closed pass is not refused');
});

test('two simultaneous passes stay separate and both read-only; their counts do not mix', async () => {
  const [a, b] = await Promise.all([
    scope.run(async () => { await tick(20); try { db.setState('a', '1'); } catch { /* refused */ } return 'a'; }),
    scope.run(async () => { await tick(5); for (const k of ['b1', 'b2']) { try { db.setState(k, '1'); } catch { /* refused */ } } await assert.rejects(fetch('https://example.org/')); return 'b'; }),
  ]);
  assert.equal(a.writesRefused, 1); assert.deepEqual(a.refused, {});
  assert.equal(b.writesRefused, 2); assert.deepEqual(b.refused, { destination: 1 });
  assert.equal(db.getState('a'), null); assert.equal(db.getState('b1'), null);
});
