'use strict';

/**
 * Build 2A — native sensing onto the event spine, over REAL HTTP and real
 * SQLite. A green service suite says nothing about routing, and the whole
 * point here is what the four ingestion routes do with messy, duplicate,
 * out-of-order phone traffic.
 *
 *   run: node --test backend/routes/native-sensing-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-native-'));
const DB_FILE = path.join(tmp, 'n.db');
process.env.NEURO_DB_PATH = DB_FILE;

const db = require('../db/database');
const bus = require('../services/event-bus');
const sh = require('../services/source-health');
const obs = require('../services/observation-state');
const nativeSources = require('../services/native-sources');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/v1', require('./apple-health'));
  app.use('/api/device', require('./device'));
  app.use('/api/location', require('./location'));
  app.use('/api/apple', require('./apple'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

// ── helpers ──────────────────────────────────────────────────────────────────

const NOW = Date.now();
const H = 60 * 60 * 1000;
const T = NOW - 6 * H; // every observation is in the past, as the routes require
const hd = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' +0000';

const UA = { neuro: 'Neuro/1 CFNetwork/3826 Darwin/25.0', saim: 'Saim/1 CFNetwork/3826 Darwin/25.0', freereps: 'FreeReps/3 CFNetwork/3826 Darwin/25.0' };

function healthBody(points) {
  return {
    data: {
      metrics: [{
        name: 'heart_rate', units: 'bpm',
        data: points.map((p) => ({ date: hd(p.at), qty: p.qty, source_uuid: p.uuid })),
      }],
    },
  };
}

async function post(p, body, headers = {}) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'tailscale-user-login': 'nick@test', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const pumpAll = () => bus.pumpAll();
const events = (type) => db.all('SELECT * FROM event_log WHERE type = ? ORDER BY seq', [type]);
const payloads = (type) => events(type).map((r) => JSON.parse(r.payload));
const count = () => db.get('SELECT COUNT(*) AS n FROM event_log').n;

// ── 1-4: idempotency and provenance ──────────────────────────────────────────

test('1. the same HealthKit sample sent twice is ONE event (and one row)', async () => {
  const body = healthBody([{ at: T, qty: 61, uuid: 'U-1' }]);
  const a = await post('/api/v1/ingest', body, { 'user-agent': UA.neuro });
  const b = await post('/api/v1/ingest', body, { 'user-agent': UA.neuro });
  assert.equal(a.status, 200);
  assert.equal(a.json.metrics_inserted, 1);
  assert.equal(b.json.metrics_inserted, 0, 'the store folds it, as before');
  const recorded = events('observation.health.recorded').filter((r) => r.idempotency_key === 'healthkit-sample:U-1');
  assert.equal(recorded.length, 1);
});

test('2. the same VALUE as two different samples is TWO events', async () => {
  await post('/api/v1/ingest', healthBody([{ at: T + 60000, qty: 61, uuid: 'U-2' }]), { 'user-agent': UA.neuro });
  await post('/api/v1/ingest', healthBody([{ at: T + 120000, qty: 61, uuid: 'U-3' }]), { 'user-agent': UA.neuro });
  const keys = events('observation.health.recorded').map((r) => r.idempotency_key);
  assert.ok(keys.includes('healthkit-sample:U-2'));
  assert.ok(keys.includes('healthkit-sample:U-3'));
});

test('3. two apps sending the SAME record: one observation, two live sources, state not corrupted', async () => {
  const body = healthBody([{ at: T + 180000, qty: 64, uuid: 'U-SHARED' }]);
  await post('/api/v1/ingest', body, { 'user-agent': UA.saim });
  await post('/api/v1/ingest', body, { 'user-agent': UA.neuro });
  await pumpAll();

  const shared = events('observation.health.recorded').filter((r) => r.idempotency_key === 'healthkit-sample:U-SHARED');
  assert.equal(shared.length, 1, 'duplicate truth folds');
  assert.equal(JSON.parse(shared[0].payload).sourceId, 'healthkit.saim-ios', 'provenance: the first app to report it');

  // Redundant sensing is kept: BOTH apps are alive as far as SourceHealth knows.
  assert.equal(sh.getSource('healthkit.saim-ios').state, 'healthy');
  assert.equal(sh.getSource('healthkit.neuro-ios').state, 'healthy');

  const hr = obs.get('health:heartRate');
  assert.equal(hr.value.value, 64);
  assert.equal(hr.value.recordId, 'U-SHARED');
  assert.equal(hr.olderIgnoredCount >= 0, true);
});

test('4. client identity: header beats body beats User-Agent, and the route says which answered', async () => {
  const r = nativeSources.resolveClient;
  assert.deepEqual(r({ 'x-neuro-client': 'saim-ios', 'user-agent': UA.neuro }), { client: 'saim-ios', via: 'header' });
  assert.deepEqual(r({ 'user-agent': UA.neuro }, 'saim'), { client: 'saim-ios', via: 'body' });
  assert.deepEqual(r({ 'user-agent': UA.freereps }), { client: 'freereps-ios', via: 'user-agent' });
  assert.deepEqual(r({ 'user-agent': 'curl/8.4' }), { client: 'unknown', via: null }, 'never a guess at a known client');

  const ack = await post('/api/device/status',
    { deviceId: 'ios-aaaa1111', reportedAt: new Date(T).toISOString(), batteryLevel: 0.5, ssid: 'HOME-NET', geocodedLocation: '1 Secret Street' },
    { 'x-neuro-client': 'neuro-ios' });
  assert.equal(ack.status, 200);
  const ev = events('observation.device.updated').pop();
  assert.equal(JSON.parse(ev.source_json).deviceId, 'ios-aaaa1111');
  const hb = payloads('source.observation.received').find((p) => p.sourceId === 'device.neuro-ios');
  assert.equal(hb.clientVia, 'header');
});

test('⚠ no SSID, place name or coordinate ever enters the log', async () => {
  await post('/api/location/points',
    { deviceId: 'ios-aaaa1111', points: [{ lat: 52.9225, lon: -1.4746, tst: Math.floor(T / 1000), acc: 12 }] },
    { 'user-agent': UA.neuro });
  const all = db.all('SELECT payload, source_json FROM event_log').map((r) => r.payload + r.source_json).join('\n');
  assert.ok(!all.includes('HOME-NET'));
  assert.ok(!all.includes('Secret Street'));
  assert.ok(!all.includes('52.92'));
  assert.ok(!all.includes('-1.47'));
  // …while the operational tables still hold what they always held.
  assert.equal(db.get(`SELECT ssid FROM device_status WHERE device_id = 'ios-aaaa1111'`).ssid, 'HOME-NET');
  // Positive control: the location observation IS there, with its accuracy.
  const loc = payloads('observation.location.recorded').pop();
  assert.equal(loc.accuracyM, 12);
});

// ── 5-6: order and retries ───────────────────────────────────────────────────

test('5. out-of-order arrival: the newest OBSERVATION wins, not the latest arrival', async () => {
  const dev = 'ios-order01';
  // B: observed 12:03, arrives first.  A: observed 12:00, arrives second.
  const b = await post('/api/device/status', { deviceId: dev, reportedAt: new Date(T + 3 * 60000).toISOString(), batteryLevel: 0.8 }, { 'user-agent': UA.neuro });
  const a = await post('/api/device/status', { deviceId: dev, reportedAt: new Date(T).toISOString(), batteryLevel: 0.3 }, { 'user-agent': UA.neuro });
  assert.equal(b.json.stored, true);
  assert.equal(a.json.stored, false, 'the existing table already refused the older report');
  await pumpAll();
  const st = obs.get(`device:${dev}`);
  assert.equal(st.value.batteryLevel, 80);
  assert.equal(st.observedAt, new Date(T + 3 * 60000).toISOString());
  assert.equal(st.olderIgnoredCount, 1, 'the late, older report is counted and kept out');
  assert.equal(events('observation.device.updated').filter((r) => r.subject_id === dev).length, 2,
    'both are real observations and both are in the log');
});

test('5b. health out of order across two apps: an older sample arriving later does not roll back', async () => {
  await post('/api/v1/ingest', healthBody([{ at: T + 10 * 60000, qty: 90, uuid: 'U-NEW' }]), { 'user-agent': UA.saim });
  await post('/api/v1/ingest', healthBody([{ at: T + 9 * 60000, qty: 55, uuid: 'U-OLD' }]), { 'user-agent': UA.neuro });
  await pumpAll();
  assert.equal(obs.get('health:heartRate').value.recordId, 'U-NEW');
});

test('6. an offline queue re-delivering the SAME batch is idempotent end to end', async () => {
  const body = healthBody([
    { at: T + 20 * 60000, qty: 70, uuid: 'Q-1' },
    { at: T + 21 * 60000, qty: 71, uuid: 'Q-2' },
  ]);
  await post('/api/v1/ingest', body, { 'user-agent': UA.neuro });
  const before = count();
  // ⚠ A retry must be a plain DUPLICATE, never a "conflict": a payload under a
  // content-derived key that varied with whether this copy was stored would
  // make every resend look like a source bug.
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try {
    for (let i = 0; i < 3; i++) await post('/api/v1/ingest', body, { 'user-agent': UA.neuro });
  } finally { console.warn = warn; }
  assert.deepEqual(warnings.filter((w) => /DIFFERENT/.test(w)), []);
  assert.equal(count(), before, 'three retries add nothing to the log');
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM health_samples WHERE source_uuid IN ('Q-1','Q-2')`).n, 2);
});

test('a resend storm with nothing new is not recorded as a heartbeat each time', async () => {
  await pumpAll();
  const before = events('source.observation.received').length;
  // Different content each time (so the delivery id differs) but nothing newer
  // than what FreeReps-style backfill already delivered.
  await post('/api/v1/ingest', healthBody([{ at: T + 21 * 60000, qty: 71, uuid: 'Q-2' }]), { 'user-agent': UA.neuro });
  await post('/api/v1/ingest', healthBody([{ at: T + 20 * 60000, qty: 70, uuid: 'Q-1' }]), { 'user-agent': UA.neuro });
  assert.equal(events('source.observation.received').length, before, 'the log records change, not polling');
});

// ── 7-10: SourceHealth ───────────────────────────────────────────────────────

test('7. a successful delivery makes the source healthy and fresh, judged on OBSERVATION time', async () => {
  await pumpAll();
  const s = sh.getSource('healthkit.neuro-ios');
  assert.equal(s.state, 'healthy');
  assert.equal(s.freshness, 'fresh');
  assert.equal(s.freshnessBasis, 'observation');
  assert.ok(s.lastObservedAt < s.lastSuccessAt, 'observed before it was delivered — two clocks, kept apart');
  assert.equal(s.staleAfterMs, 12 * H);
});

test('8. a failed delivery makes the source failing, by name', async () => {
  const bad = await post('/api/v1/ingest', { nope: true }, { 'user-agent': UA.freereps });
  assert.equal(bad.status, 400);
  const refused = await post('/api/apple/calendar',
    { from: new Date(T).toISOString(), to: new Date(T + 14 * 24 * H).toISOString(), events: [], calendars: [], client: 'saim' },
    { 'user-agent': UA.saim });
  assert.equal(refused.status, 400);
  await pumpAll();
  const f = sh.getSource('healthkit.freereps-ios');
  assert.equal(f.state, 'failing');
  assert.equal(f.freshness, 'unknown', 'never delivered: nothing to be fresh about');
  const e = sh.getSource('eventkit.saim-ios');
  assert.equal(e.state, 'failing');
  assert.equal(e.failure.reason, 'no-calendar-access');
});

test('a later successful delivery clears the failure', async () => {
  const ok = await post('/api/apple/calendar',
    { from: new Date(T).toISOString(), to: new Date(T + 14 * 24 * H).toISOString(),
      events: [{ id: 'e1', title: 'Dentist', start: new Date(T + 30 * H).toISOString(), end: new Date(T + 31 * H).toISOString(), isAllDay: false, calendar: 'Home' }],
      calendars: ['Home'], client: 'saim' },
    { 'user-agent': UA.saim });
  assert.equal(ok.status, 200);
  await pumpAll();
  const e = sh.getSource('eventkit.saim-ios');
  assert.equal(e.state, 'healthy');
  assert.equal(e.consecutiveFailures, 0);
});

test('9. no observation for longer than the threshold makes a push source STALE, and only newer data clears it', async () => {
  const s0 = sh.getSource('healthkit.neuro-ios');
  const later = Date.parse(s0.lastObservedAt) + 12 * H + 60000;
  const marked = await sh.checkStaleness({ now: later });
  assert.ok(marked.includes('healthkit.neuro-ios'));
  assert.equal(sh.getSource('healthkit.neuro-ios').freshness, 'stale');
  const stale = payloads('source.sync.stale').find((p) => p.sourceId === 'healthkit.neuro-ios');
  assert.equal(stale.basis, 'observation');

  // A second check during the same outage writes nothing.
  const n = count();
  await sh.checkStaleness({ now: later + H });
  assert.equal(count(), n, 'one stale event per observation, not one per check');

  // A draining queue of OLDER samples is a successful delivery that tells
  // NEURO nothing current: still stale.
  await post('/api/v1/ingest', healthBody([{ at: T - H, qty: 50, uuid: 'OLD-DRAIN' }]), { 'user-agent': UA.neuro });
  await pumpAll();
  assert.equal(sh.getSource('healthkit.neuro-ios').freshness, 'stale');
  assert.equal(sh.getSource('healthkit.neuro-ios').state, 'healthy', 'delivered fine — state and freshness are separate');

  // The route's heartbeat throttle usually stops that delivery before the
  // projector sees it — so pin the PROJECTOR rule directly, because a heartbeat
  // can still arrive while the projection is behind the log.
  const held = sh.getSource('healthkit.neuro-ios').lastObservedAt;
  bus.publishEvent({
    type: 'source.observation.received', occurredAt: new Date(T - 2 * H).toISOString(),
    source: { system: 'healthkit' }, idempotencyKey: 'test-late-heartbeat',
    payload: { sourceId: 'healthkit.neuro-ios', deliveryId: 'late', newestObservedAt: new Date(T - 2 * H).toISOString() },
  });
  await pumpAll();
  assert.equal(sh.getSource('healthkit.neuro-ios').freshness, 'stale', 'an older observation clears nothing');
  assert.equal(sh.getSource('healthkit.neuro-ios').lastObservedAt, held, 'and does not roll the basis back');

  // Newer data clears it.
  await post('/api/v1/ingest', healthBody([{ at: NOW - 60000, qty: 66, uuid: 'FRESH-1' }]), { 'user-agent': UA.neuro });
  await pumpAll();
  assert.equal(sh.getSource('healthkit.neuro-ios').freshness, 'fresh');
});

test('10. a source never seen is freshness UNKNOWN — not absent, not healthy', () => {
  const s = sh.getSource('location.saim-ios');
  assert.equal(s.known, false);
  assert.equal(s.freshness, 'unknown');
  assert.equal(obs.get('device:never-reported').known, false);
});

// ── 11-13: robustness ────────────────────────────────────────────────────────

test('11. ⚠ ingestion still succeeds when the event spine is BROKEN', async () => {
  db.run(`CREATE TRIGGER sabotage BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'spine down'); END;`);
  try {
    const before = count();
    const h = await post('/api/v1/ingest', healthBody([{ at: NOW - 30000, qty: 77, uuid: 'SURVIVES' }]), { 'user-agent': UA.neuro });
    assert.equal(h.status, 200);
    assert.equal(h.json.metrics_inserted, 1);
    const d = await post('/api/device/status', { deviceId: 'ios-survive', reportedAt: new Date(NOW - 30000).toISOString(), batteryLevel: 0.4 }, { 'user-agent': UA.neuro });
    assert.equal(d.status, 200);
    assert.equal(d.json.stored, true);
    const l = await post('/api/location/points', { deviceId: 'ios-survive', points: [{ lat: 51, lon: 0.1, tst: Math.floor((NOW - 30000) / 1000) }] }, { 'user-agent': UA.neuro });
    assert.equal(l.json.stored, 1);
    assert.equal(count(), before, 'nothing could be published, and that cost the phone nothing');
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM health_samples WHERE source_uuid = 'SURVIVES'`).n, 1);
  } finally {
    db.run('DROP TRIGGER sabotage');
  }
});

test('12. replay rebuilds both native projections IDENTICALLY', async () => {
  await pumpAll();
  const snap = () => ({
    obs: db.all('SELECT * FROM observation_latest ORDER BY assertion_key'),
    sh: db.all('SELECT * FROM source_health ORDER BY source_id'),
  });
  const before = snap();
  assert.ok(before.obs.length >= 3);
  await bus.replayConsumer(obs.CONSUMER);
  await bus.replayConsumer(sh.CONSUMER);
  assert.deepEqual(snap(), before);
  // …and a second replay is idempotent.
  await bus.replayConsumer(obs.CONSUMER);
  assert.deepEqual(snap().obs, before.obs);
});

test('13. a consumer restart resumes exactly where it stopped (a second process)', () => {
  // Events this process publishes but never pumps…
  bus.publishEvent({
    type: 'observation.health.recorded', occurredAt: new Date(NOW - 1000).toISOString(),
    source: { system: 'healthkit' }, idempotencyKey: 'healthkit-sample:RESTART-1',
    payload: { metric: 'restartMetric', value: 1, observedAt: new Date(NOW - 1000).toISOString(), sourceId: 'healthkit.neuro-ios' },
  });
  const file = path.join(tmp, 'child.js');
  fs.writeFileSync(file, [
    `process.env.NEURO_DB_PATH = ${JSON.stringify(DB_FILE)};`,
    `const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))});`,
    `const bus = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'event-bus'))});`,
    '(async () => { await db.init(); console.log = () => {};',
    'const r = await bus.pumpConsumer("observation-state");',
    'const row = db.get("SELECT value_json FROM observation_latest WHERE assertion_key = ?", ["health:restartMetric"]);',
    'process.stdout.write(JSON.stringify({ processed: r.processed, row: !!row }) + String.fromCharCode(10));',
    '})().catch(e => { process.stderr.write(e.stack); process.exit(1); });',
  ].join('\n'));
  const out = JSON.parse(execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(out.processed, 1, 'only the one unseen event — nothing replayed, nothing skipped');
  assert.equal(out.row, true);
  assert.equal(bus.getStatus().consumers.find((c) => c.name === 'observation-state').lag, 0);
});

test('a records-only post reports what it stored AND what it already had (the 5 Oct stand-hour false alarm)', async () => {
  // The exact shape of the 16:01 sync: no quantity readings, one closed stand hour.
  const body = {
    data: {
      category_samples: [{
        id: 'STAND-1', type: 'HKCategoryTypeIdentifierAppleStandHour', value: 1,
        start_date: hd(T), end_date: hd(T + H),
      }],
    },
  };
  const first = await post('/api/v1/ingest', body, { 'user-agent': UA.saim });
  assert.equal(first.status, 200);
  assert.equal(first.json.metrics_inserted, 0, 'no readings — the phone cannot judge on metrics alone');
  assert.equal(first.json.neuro.recordsInserted, 1);
  assert.equal(first.json.neuro.recordsSkipped, 0);

  // ⚠ The resend after a "failed" sync: nothing new, but it DID land — skipped, not lost.
  const again = await post('/api/v1/ingest', body, { 'user-agent': UA.saim });
  assert.equal(again.json.neuro.recordsInserted, 0);
  assert.equal(again.json.neuro.recordsSkipped, 1, 'a duplicate record must be said out loud, or 0-and-0 reads as nothing landed');
});

test('no dead letters were produced by any of the above', () => {
  assert.equal(bus.getStatus().failures.dead, 0);
});
