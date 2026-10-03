'use strict';

/**
 * Source semantics (Build 3B) — source health should mean SENSOR AVAILABILITY,
 * not a timer expiring.
 *
 *   • a retired source keeps its history and stops being expected
 *   • a phone sitting still at home is QUIET, not blind
 *   • a phone that has genuinely gone silent is still blind
 *   • travelling with no fix is suspicious however recently the app spoke
 *
 *   run: node --test backend/services/source-semantics.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-semantics-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'sem.db');

const db = require('../db/database');
const bus = require('./event-bus');
const sh = require('./source-health');
const sb = require('./source-blindness');
const native = require('./native-sources');

test.before(async () => { await db.init(); });

const H = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
let k = 0;

function deliver(sourceId, observedMs, receivedMs, extra = {}) {
  const d = native.describe(sourceId);
  return bus.publishEvent({
    type: 'source.observation.received',
    occurredAt: iso(observedMs),
    source: { system: 'test' },
    idempotencyKey: `sem-deliver-${++k}`,
    payload: { sourceId, deliveryId: `d${k}`, newestObservedAt: iso(observedMs),
      expectedIntervalMs: d.expectedIntervalMs, staleAfterMs: d.staleAfterMs, ...extra },
  }, { now: receivedMs }).event;
}

function motion(activity, observedMs) {
  return bus.publishEvent({
    type: 'observation.device.updated',
    occurredAt: iso(observedMs),
    source: { system: 'device', deviceId: 'ios-test' },
    idempotencyKey: `sem-motion-${++k}`,
    payload: { deviceId: 'ios-test', observedAt: iso(observedMs), fields: { activity }, sourceId: 'device.neuro-ios' },
  }, { now: observedMs }).event;
}

const pumpAll = async (now) => { await bus.pumpConsumer(sh.CONSUMER, { now }); await bus.pumpConsumer(sb.CONSUMER, { now }); };
const events = (type, sourceId) => db.all('SELECT * FROM event_log WHERE type = ? AND subject_id = ? ORDER BY seq', [type, sourceId]);
const finding = (sourceId) => db.all('SELECT * FROM source_blind_findings WHERE source_id = ? ORDER BY first_detected_at', [sourceId]);

// ── the pure judgement ──────────────────────────────────────────────────────

test('judge: an old fix from a live app is QUIET; from a silent app it is STALE', () => {
  const now = Date.parse('2026-10-03T08:00:00Z');
  const row = { last_observed_at: '2026-10-02T19:27:00Z', last_success_at: '2026-10-02T19:28:00Z', stale_after_ms: 12 * H };
  const live = native.judgeObservationFreshness({ sourceId: 'location.neuro-ios', row, now,
    peerDeliveries: { 'device.neuro-ios': '2026-10-03T07:43:00Z' } });
  assert.equal(live.verdict, 'quiet');
  assert.equal(live.transportSourceId, 'device.neuro-ios');
  const dead = native.judgeObservationFreshness({ sourceId: 'location.neuro-ios', row, now,
    peerDeliveries: { 'device.neuro-ios': '2026-10-02T15:00:00Z' } });
  assert.equal(dead.verdict, 'stale');
  assert.equal(dead.reason, 'transport-silent');
});

test('judge: unknown stays unknown — no peers at all is not "alive"', () => {
  const now = Date.parse('2026-10-03T08:00:00Z');
  const row = { last_observed_at: '2026-10-02T19:27:00Z', last_success_at: '2026-10-02T19:28:00Z', stale_after_ms: 12 * H };
  assert.equal(native.judgeObservationFreshness({ sourceId: 'location.neuro-ios', row, now }).verdict, 'stale');
});

test('judge: a recent fix is fresh whatever the peers say', () => {
  const now = Date.parse('2026-10-03T08:00:00Z');
  const row = { last_observed_at: '2026-10-03T06:00:00Z', last_success_at: '2026-10-03T06:00:00Z', stale_after_ms: 12 * H };
  assert.equal(native.judgeObservationFreshness({ sourceId: 'location.neuro-ios', row, now }).verdict, 'fresh');
});

test('lifecycle: FreeReps is retired, never expected; the rest are unchanged', () => {
  assert.equal(native.describe('healthkit.freereps-ios').lifecycle, 'retired');
  assert.equal(native.expectedSources().includes('healthkit.freereps-ios'), false);
  assert.equal(native.describe('location.neuro-ios').lifecycle, 'expected');
  assert.equal(native.describe('healthkit.saim-ios').lifecycle, 'expected');
  assert.equal(native.describe('something.new').lifecycle, 'optional', 'an undeclared source is not expected');
});

// ── FreeReps ────────────────────────────────────────────────────────────────

test('FreeReps is retired WITHOUT deleting history, and stops producing findings', async () => {
  const t0 = Date.parse('2026-10-02T20:13:00Z');
  deliver('healthkit.freereps-ios', t0, t0 + 20 * 60 * 1000);
  await pumpAll(t0 + H);
  // Before retirement — the live state on 3 Oct: Build 2's check had already
  // recorded it stale and opened a finding. (checkStaleness now records the
  // retirement BEFORE judging, so it would never get this far itself.)
  bus.publishEvent({
    type: 'source.sync.stale', occurredAt: iso(t0 + 13 * H), source: { system: 'neuro' },
    subject: { entityType: 'source', entityId: 'healthkit.freereps-ios' },
    idempotencyKey: 'sem-freereps-build2-stale',
    payload: { sourceId: 'healthkit.freereps-ios', lastSuccessAt: iso(t0 + 20 * 60 * 1000), staleAfterMs: 12 * H,
      basis: 'observation', lastObservedAt: iso(t0) },
  }, { now: t0 + 13 * H });
  await pumpAll(t0 + 13 * H);
  assert.equal(finding('healthkit.freereps-ios').at(-1).status, 'active');
  const deliveriesBefore = events('source.observation.received', 'healthkit.freereps-ios').length;

  // Retire it (the scheduler's staleness job does this every pass).
  await sh.syncLifecycle({ now: t0 + 14 * H });
  await pumpAll(t0 + 14 * H);
  const f = finding('healthkit.freereps-ios').at(-1);
  assert.equal(f.status, 'resolved');
  assert.equal(f.resolution, 'retired');
  assert.equal(sh.getSource('healthkit.freereps-ios').lifecycle, 'retired');

  // History intact and still queryable.
  assert.equal(events('source.observation.received', 'healthkit.freereps-ios').length, deliveriesBefore);
  assert.equal(sh.getSource('healthkit.freereps-ios').lastObservedAt, iso(t0));
  assert.ok(sb.getFindings({ status: 'resolved' }).some((x) => x.source === 'healthkit.freereps-ios'));

  // A week later: no new stale verdict, no finding, nothing offered to attention.
  const staleBefore = events('source.sync.stale', 'healthkit.freereps-ios').length;
  await sh.checkStaleness({ now: t0 + 7 * 24 * H });
  await pumpAll(t0 + 7 * 24 * H);
  assert.equal(events('source.sync.stale', 'healthkit.freereps-ios').length, staleBefore);
  assert.equal(finding('healthkit.freereps-ios').filter((x) => x.status === 'active').length, 0);
  assert.ok(!sb.observations({ now: t0 + 7 * 24 * H }).some((o) => o.source === 'healthkit.freereps-ios'));

  // Re-running the lifecycle sync is a no-op — one event, ever.
  await sh.syncLifecycle({ now: t0 + 8 * 24 * H });
  assert.equal(events('source.lifecycle.changed', 'healthkit.freereps-ios').length, 1);
});

// ── Location ────────────────────────────────────────────────────────────────
// Each scenario uses its own day so the shared log does not bleed between them.

test('stationary at home overnight with the phone alive: QUIET, never a blindness finding', async () => {
  const fix = Date.parse('2026-10-10T19:27:00Z');
  deliver('location.neuro-ios', fix, fix + 60 * 1000);
  deliver('device.neuro-ios', Date.parse('2026-10-11T07:43:00Z'), Date.parse('2026-10-11T07:43:01Z'));
  motion('Still', Date.parse('2026-10-11T07:43:00Z'));
  await pumpAll(Date.parse('2026-10-11T07:45:00Z'));

  for (const t of ['2026-10-11T07:35:00Z', '2026-10-11T08:00:00Z', '2026-10-11T08:05:00Z', '2026-10-11T08:10:00Z']) {
    await sh.checkStaleness({ now: Date.parse(t) });
  }
  await pumpAll(Date.parse('2026-10-11T08:11:00Z'));
  const s = sh.getSource('location.neuro-ios');
  assert.equal(s.freshness, 'quiet');
  assert.equal(s.transportSourceId, 'device.neuro-ios');
  assert.equal(s.lastObservedAt, iso(fix), 'the fix age stays truthful — quiet does not pretend the fix is new');
  assert.equal(events('source.observation.quiet', 'location.neuro-ios').length, 1, 'one event per transition, not one per check');
  assert.equal(finding('location.neuro-ios').filter((x) => x.status === 'active').length, 0);
});

test('a genuinely dead phone still produces blindness', async () => {
  const fix = Date.parse('2026-10-12T19:00:00Z');
  deliver('location.neuro-ios', fix, fix + 60 * 1000);
  deliver('device.neuro-ios', Date.parse('2026-10-12T19:05:00Z'), Date.parse('2026-10-12T19:05:01Z'));
  await pumpAll(Date.parse('2026-10-12T19:10:00Z'));
  // Nothing from ANY channel of the app for 13 hours.
  await sh.checkStaleness({ now: Date.parse('2026-10-13T08:10:00Z') });
  await pumpAll(Date.parse('2026-10-13T08:11:00Z'));
  assert.equal(sh.getSource('location.neuro-ios').freshness, 'stale');
  const f = finding('location.neuro-ios').at(-1);
  assert.equal(f.status, 'active');
  assert.equal(f.condition, 'stale');
  const stale = events('source.sync.stale', 'location.neuro-ios').at(-1);
  assert.equal(JSON.parse(stale.payload).reason, 'transport-silent');

  // Recovery path 1: the app speaks again (still not moved) → quiet, finding resolved.
  deliver('device.neuro-ios', Date.parse('2026-10-13T09:00:00Z'), Date.parse('2026-10-13T09:00:01Z'));
  await pumpAll(Date.parse('2026-10-13T09:01:00Z'));
  await sh.checkStaleness({ now: Date.parse('2026-10-13T09:05:00Z') });
  await pumpAll(Date.parse('2026-10-13T09:06:00Z'));
  assert.equal(sh.getSource('location.neuro-ios').freshness, 'quiet');
  const resolved = finding('location.neuro-ios').at(-1);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution, 'transport-alive');
});

test('travelling with no fix is suspicious even while the app is alive; walking round the house is not', async () => {
  const fix = Date.parse('2026-10-14T07:00:00Z');
  deliver('location.neuro-ios', fix, fix + 60 * 1000);
  deliver('device.neuro-ios', Date.parse('2026-10-14T07:30:00Z'), Date.parse('2026-10-14T07:30:01Z'));
  motion('Walking', Date.parse('2026-10-14T07:30:00Z'));
  await pumpAll(Date.parse('2026-10-14T07:31:00Z'));
  await sh.checkStaleness({ now: Date.parse('2026-10-14T09:00:00Z') });
  await pumpAll(Date.parse('2026-10-14T09:00:30Z'));
  assert.notEqual(sh.getSource('location.neuro-ios').freshness, 'stale', 'walking indoors owes no fix');

  motion('Automotive', Date.parse('2026-10-14T09:10:00Z'));
  deliver('device.neuro-ios', Date.parse('2026-10-14T09:10:00Z'), Date.parse('2026-10-14T09:10:01Z'));
  await pumpAll(Date.parse('2026-10-14T09:11:00Z'));
  await sh.checkStaleness({ now: Date.parse('2026-10-14T09:30:00Z') }); // inside the 45-minute grace
  await pumpAll(Date.parse('2026-10-14T09:30:30Z'));
  assert.notEqual(sh.getSource('location.neuro-ios').freshness, 'stale', 'a fix may still be on its way');

  await sh.checkStaleness({ now: Date.parse('2026-10-14T10:00:00Z') }); // 50 min after driving
  await pumpAll(Date.parse('2026-10-14T10:00:30Z'));
  assert.equal(sh.getSource('location.neuro-ios').freshness, 'stale');
  const f = finding('location.neuro-ios').at(-1);
  assert.equal(f.status, 'active');
  assert.equal(f.condition, 'moving-without-fix');
  assert.equal(f.confidence, sb.CONFIDENCE['moving-without-fix']);

  // Liveness does NOT cure a movement suspicion…
  deliver('device.neuro-ios', Date.parse('2026-10-14T10:20:00Z'), Date.parse('2026-10-14T10:20:01Z'));
  await pumpAll(Date.parse('2026-10-14T10:21:00Z'));
  await sh.checkStaleness({ now: Date.parse('2026-10-14T10:25:00Z') });
  await pumpAll(Date.parse('2026-10-14T10:25:30Z'));
  assert.equal(finding('location.neuro-ios').at(-1).status, 'active');

  // …a new fix does.
  deliver('location.neuro-ios', Date.parse('2026-10-14T10:40:00Z'), Date.parse('2026-10-14T10:40:05Z'));
  await pumpAll(Date.parse('2026-10-14T10:41:00Z'));
  assert.equal(sh.getSource('location.neuro-ios').freshness, 'fresh');
  const r = finding('location.neuro-ios').at(-1);
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolution, 'recovered');
});

test('a staleness check over a non-liveness push source is exactly Build 2', async () => {
  const t = Date.parse('2026-10-16T06:00:00Z');
  deliver('eventkit.neuro-ios', t, t + 1000);
  await pumpAll(t + 2000);
  const marked = await sh.checkStaleness({ now: t + 13 * H });
  assert.ok(marked.includes('eventkit.neuro-ios'));
  const ev = events('source.sync.stale', 'eventkit.neuro-ios').at(-1);
  assert.equal(ev.idempotency_key, `source-stale:eventkit.neuro-ios:obs:${iso(t)}`, 'same key as Build 2');
});

test('replay rebuilds source health and blindness identically, lifecycle and quiet included', async () => {
  const snapH = () => JSON.stringify(db.all('SELECT * FROM source_health ORDER BY source_id'));
  const snapB = () => JSON.stringify([
    db.all('SELECT * FROM source_blind_findings ORDER BY finding_id'),
    db.all('SELECT source_id, basis_at, last_success_at, last_outcome_at, consecutive_failures, last_failure, active_finding_id, lifecycle FROM source_blind_state ORDER BY source_id'),
  ]);
  await pumpAll(Date.now());
  const h1 = snapH();
  const b1 = snapB();
  await bus.replayConsumer(sh.CONSUMER);
  await bus.replayConsumer(sb.CONSUMER);
  assert.equal(snapH(), h1);
  assert.equal(snapB(), b1);
});

// ── each defence on its own ─────────────────────────────────────────────────
// Every rule below has a first layer that normally stops the case arising, so
// each is tested by publishing the very event that layer would have withheld.

test('a retired source that reports again and then goes quiet is still not judged', async () => {
  const t = Date.parse('2026-10-20T08:00:00Z');
  deliver('healthkit.freereps-ios', t, t + 1000);
  await pumpAll(t + 2000);
  assert.equal(sh.getSource('healthkit.freereps-ios').freshness, 'fresh', 'the delivery is still recorded');
  const before = events('source.sync.stale', 'healthkit.freereps-ios').length;
  await sh.checkStaleness({ now: t + 13 * H });
  await pumpAll(t + 13 * H);
  assert.equal(events('source.sync.stale', 'healthkit.freereps-ios').length, before);
});

test('a stale verdict about a retired source never opens a finding', async () => {
  const t = Date.parse('2026-10-21T08:00:00Z');
  bus.publishEvent({
    type: 'source.sync.stale', occurredAt: iso(t), source: { system: 'neuro' },
    subject: { entityType: 'source', entityId: 'healthkit.freereps-ios' },
    idempotencyKey: 'sem-retired-forced-stale',
    payload: { sourceId: 'healthkit.freereps-ios', lastSuccessAt: iso(Date.parse('2026-10-20T08:00:01Z')), staleAfterMs: 12 * H,
      basis: 'observation', lastObservedAt: iso(Date.parse('2026-10-20T08:00:00Z')) },
  }, { now: t });
  await pumpAll(t + 1000);
  assert.equal(finding('healthkit.freereps-ios').filter((x) => x.status === 'active').length, 0);
});

test('a quiet verdict about a fix since superseded changes nothing', async () => {
  const fix1 = Date.parse('2026-10-22T07:00:00Z');
  const fix2 = Date.parse('2026-10-22T09:00:00Z');
  deliver('location.neuro-ios', fix1, fix1 + 1000);
  deliver('location.neuro-ios', fix2, fix2 + 1000);
  await pumpAll(fix2 + 2000);
  bus.publishEvent({
    type: 'source.observation.quiet', occurredAt: iso(fix2 + 5000), source: { system: 'neuro' },
    subject: { entityType: 'source', entityId: 'location.neuro-ios' },
    idempotencyKey: 'sem-quiet-outdated',
    payload: { sourceId: 'location.neuro-ios', lastObservedAt: iso(fix1), transportAliveAt: iso(fix2), transportSourceId: 'device.neuro-ios' },
  }, { now: fix2 + 5000 });
  await pumpAll(fix2 + 6000);
  assert.equal(sh.getSource('location.neuro-ios').freshness, 'fresh');
});

test('liveness never cures a movement suspicion, even if a quiet verdict arrives', async () => {
  const fix = Date.parse('2026-10-23T07:00:00Z');
  deliver('location.neuro-ios', fix, fix + 1000);
  deliver('device.neuro-ios', Date.parse('2026-10-23T08:00:00Z'), Date.parse('2026-10-23T08:00:01Z'));
  motion('Automotive', Date.parse('2026-10-23T08:00:00Z'));
  await pumpAll(Date.parse('2026-10-23T08:01:00Z'));
  await sh.checkStaleness({ now: Date.parse('2026-10-23T09:00:00Z') });
  await pumpAll(Date.parse('2026-10-23T09:00:30Z'));
  assert.equal(finding('location.neuro-ios').at(-1).condition, 'moving-without-fix');
  bus.publishEvent({
    type: 'source.observation.quiet', occurredAt: iso(Date.parse('2026-10-23T09:10:00Z')), source: { system: 'neuro' },
    subject: { entityType: 'source', entityId: 'location.neuro-ios' },
    idempotencyKey: 'sem-quiet-vs-moving',
    payload: { sourceId: 'location.neuro-ios', lastObservedAt: iso(fix), transportAliveAt: iso(Date.parse('2026-10-23T09:05:00Z')), transportSourceId: 'device.neuro-ios' },
  }, { now: Date.parse('2026-10-23T09:10:00Z') });
  await pumpAll(Date.parse('2026-10-23T09:10:30Z'));
  assert.equal(finding('location.neuro-ios').at(-1).status, 'active');
});
