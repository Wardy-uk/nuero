// Keeping a wall-powered device between charge levels through an HA socket.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parse, decide, createKeeper } = require('../src/power/chargeKeeper');
const store = require('../src/presence/store');

const NOW = Date.parse('2026-09-12T10:00:00Z');
const reading = (over = {}) => ({ room: 'bedroom', at: new Date(NOW - 5000).toISOString(), batteryPct: 60, charging: true, ...over });
const cfg = { low: 40, high: 80 };

test('below the low mark it charges, above the high mark it stops', () => {
  assert.equal(decide(reading({ batteryPct: 39 }), cfg, NOW).desired, 'on');
  assert.equal(decide(reading({ batteryPct: 40 }), cfg, NOW).desired, 'on');
  assert.equal(decide(reading({ batteryPct: 80 }), cfg, NOW).desired, 'off');
  assert.equal(decide(reading({ batteryPct: 95 }), cfg, NOW).desired, 'off');
});

test('in between, it leaves the socket alone', () => {
  const d = decide(reading({ batteryPct: 60 }), cfg, NOW);
  assert.equal(d.desired, null);
  assert.match(d.why, /leaving it/);
});

// ⚠ The load-bearing rule. A flat phone is a dead sensor and a dark screen, so every
// way of not knowing resolves to charging.
test('not knowing always means charge', () => {
  for (const [label, r] of [
    ['no reading at all', null],
    ['sensor gone quiet', reading({ at: new Date(NOW - 6 * 60000).toISOString() })],
    ['battery not reported', reading({ batteryPct: null })],
    ['battery unreadable', reading({ batteryPct: 'x' })],
    ['no timestamp', reading({ at: null })],
  ]) {
    assert.equal(decide(r, cfg, NOW).desired, 'on', label);
  }
});

test('config parses, and anything malformed is dropped rather than guessed', () => {
  const k = parse('bedroom=switch.bedroom_socket_1:40:80,study=switch.office_multi_switch_socket_1,x=light.lamp,bad room=switch.a,kitchen=switch.k:90:20');
  assert.deepEqual([...k.keys()], ['bedroom', 'study']);
  assert.deepEqual(k.get('bedroom'), { entity: 'switch.bedroom_socket_1', low: 40, high: 80 });
  assert.deepEqual(k.get('study'), { entity: 'switch.office_multi_switch_socket_1', low: 40, high: 80 }, 'defaults when thresholds are omitted');
  assert.equal(parse('').size, 0);
});

const ENV = {
  SARA_CHARGE_KEEPERS: 'bedroom=switch.bedroom_socket_1:40:80',
  SARA_HA_BASE_URL: 'http://ha.test:8123', SARA_HA_TOKEN: 'tok',
};
const quiet = { log() {}, warn() {} };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('it switches the socket on when the device is low, and says so to HA', async () => {
  store.reset();
  store.record({ room: 'bedroom', status: 'present', healthy: true, batteryPct: 22 }, new Date(NOW));
  const calls = [];
  const k = createKeeper({ env: ENV, log: quiet, fetchImpl: async (url, init) => {
    calls.push({ url, method: init?.method || 'GET', body: init?.body });
    return ok(url.includes('/states/') ? { state: 'off' } : []);
  } });
  const r = await k.apply('bedroom', { entity: 'switch.bedroom_socket_1', low: 40, high: 80 }, NOW);
  assert.equal(r.changed, true);
  assert.equal(calls[1].url, 'http://ha.test:8123/api/services/switch/turn_on');
  assert.deepEqual(JSON.parse(calls[1].body), { entity_id: 'switch.bedroom_socket_1' });
});

test('a socket already where it should be is not switched again', async () => {
  store.reset();
  store.record({ room: 'bedroom', status: 'present', healthy: true, batteryPct: 22 }, new Date(NOW));
  const calls = [];
  const k = createKeeper({ env: ENV, log: quiet, fetchImpl: async (url) => { calls.push(url); return ok({ state: 'on' }); } });
  const r = await k.apply('bedroom', { entity: 'switch.bedroom_socket_1', low: 40, high: 80 }, NOW);
  assert.equal(r.changed, false);
  assert.equal(calls.length, 1, 'it read the state and stopped there');
});

test('an unreachable Home Assistant leaves the socket alone and reports why', async () => {
  store.reset();
  store.record({ room: 'bedroom', status: 'present', healthy: true, batteryPct: 90 }, new Date(NOW));
  const k = createKeeper({ env: ENV, log: quiet, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await k.apply('bedroom', { entity: 'switch.bedroom_socket_1', low: 40, high: 80 }, NOW);
  assert.equal(r.changed, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('it never starts without configured sockets', () => {
  assert.equal(createKeeper({ env: {}, log: quiet }).start(), false);
});
