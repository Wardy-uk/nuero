'use strict';

/**
 * The station's wire contract and the idempotency rule, pure.
 * Fixture: the first records the live ingestor journalled on pi5 (6 Oct 2026).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('./weather-station');

const NOW = Date.parse('2026-10-06T19:00:00Z');
const rec = (over = {}) => ({
  schema: 'saim.weather.v1', node_id: 'outdoor-1', sequence: 5,
  temperature_c: 23.41, humidity_pct: 54.4, pressure_hpa: 999.95,
  battery_mv: null, rssi: -54, received_at: '2026-10-06T18:55:14.732690+00:00',
  ...over,
});

test('a real journalled record validates, microsecond timestamp and all', () => {
  const v = s.validateObservation(rec(), NOW);
  assert.equal(v.ok, true);
  assert.equal(v.obs.observedAt, Date.parse('2026-10-06T18:55:14.732Z'));
  assert.equal(v.obs.batteryMv, null);
  assert.equal(v.obs.nodeId, 'outdoor-1');
});

test('the documented example (Z suffix) validates', () => {
  assert.equal(s.validateObservation(rec({ sequence: 1, received_at: '2026-10-06T18:51:13Z' }), NOW).ok, true);
});

test('refusals name the field', () => {
  const cases = [
    [rec({ schema: 'saim.weather.v2' }), /schema/],
    [rec({ node_id: '' }), /node_id/],
    [rec({ node_id: 'a b' }), /node_id/],
    [rec({ sequence: -1 }), /sequence/],
    [rec({ sequence: 1.5 }), /sequence/],
    [rec({ temperature_c: '23' }), /temperature_c/],
    [rec({ humidity_pct: 101 }), /humidity_pct/],
    [rec({ pressure_hpa: 700 }), /pressure_hpa/],
    [rec({ battery_mv: 3.3 }), /battery_mv/],
    [rec({ rssi: 10 }), /rssi/],
    [rec({ received_at: '2026-10-06T18:55:14' }), /zone/],
    [rec({ received_at: 'yesterday Z' }), /valid/],
    [rec({ received_at: '2026-10-06T20:00:00Z' }), /future/],
  ];
  for (const [r, re] of cases) {
    const v = s.validateObservation(r, NOW);
    assert.equal(v.ok, false, JSON.stringify(r));
    assert.match(v.reason, re);
  }
});

test('a real battery reading is accepted when it is present', () => {
  assert.equal(s.validateObservation(rec({ battery_mv: 3712 }), NOW).obs.batteryMv, 3712);
});

// ── Boot assignment ─────────────────────────────────────────────────────────

const node = { boot: 1, lastSequence: 9, lastObservedAt: Date.parse('2026-10-06T18:59:15Z') };

test('the next sequence stays in the same boot', () => {
  assert.deepEqual(s.assignBoot(node, { sequence: 10, observedAt: node.lastObservedAt + 60000 }), { boot: 1, advancesCursor: true, restarted: false });
});

test('⚠ a newer reading with a LOWER sequence is a reboot, not a duplicate', () => {
  const b = s.assignBoot(node, { sequence: 1, observedAt: node.lastObservedAt + 120000 });
  assert.equal(b.boot, 2);
  assert.equal(b.restarted, true);
});

test('a newer reading with the SAME sequence is also a reboot (the dedupe check runs first)', () => {
  assert.equal(s.assignBoot(node, { sequence: 9, observedAt: node.lastObservedAt + 3600000 }).boot, 2);
});

test('a first-ever reading opens boot 1', () => {
  assert.deepEqual(s.assignBoot(null, { sequence: 42, observedAt: NOW }), { boot: 1, advancesCursor: true });
});

test('an OLDER reading (spool draining late) joins the boot before it and does not move the cursor', () => {
  const b = s.assignBoot({ ...node, boot: 3 }, { sequence: 4, observedAt: node.lastObservedAt - 600000 }, { boot: 2 });
  assert.deepEqual(b, { boot: 2, advancesCursor: false });
});

// ── Ranges ──────────────────────────────────────────────────────────────────

test('every range plans a sensible number of buckets, aligned to the bucket size', () => {
  for (const id of Object.keys(s.RANGES)) {
    const p = s.bucketPlan(id, NOW);
    assert.ok(p.starts.length >= 24 && p.starts.length <= 450, `${id}: ${p.starts.length}`);
    for (const t of p.starts) assert.equal(t % p.bucketMs, 0);
    assert.ok(p.fromMs <= NOW - s.RANGES[id].spanMs);
    assert.ok(p.toMs >= NOW);
  }
});

test('hourly is raw minutes; the daily view runs 12 hours into the forecast', () => {
  assert.equal(s.bucketPlan('hour', NOW).bucketMs, 60000);
  const d = s.bucketPlan('day', NOW);
  assert.ok(d.toMs >= NOW + 12 * 3600000);
});

test('an unknown range is refused, never defaulted', () => {
  assert.equal(s.bucketPlan('fortnight', NOW), null);
});
