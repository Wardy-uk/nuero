'use strict';

/**
 * Build 2B — the source-blindness evaluator, its route through the EXISTING
 * attention policy, and the watchdog's reading of the canonical projection.
 *
 *   run: node --test backend/services/source-blindness.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-blind-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b.db');
delete process.env.SOURCE_BLIND_MODE;

const db = require('../db/database');
const bus = require('./event-bus');
const sh = require('./source-health');
const sb = require('./source-blindness');
const ambient = require('./ambient-push');

test.before(async () => { await db.init(); });

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let k = 0;

function deliver(sourceId, observedMs, receivedMs = observedMs + 60000) {
  return bus.publishEvent({
    type: 'source.observation.received', occurredAt: iso(observedMs), source: { system: 'test' },
    idempotencyKey: `sb-${++k}`,
    payload: { sourceId, deliveryId: `d${k}`, newestObservedAt: iso(observedMs), expectedIntervalMs: H, staleAfterMs: 12 * H },
  }, { now: receivedMs }).event;
}
function fail(sourceId, atMs, reason = 'malformed') {
  return bus.publishEvent({
    type: 'source.sync.failed', occurredAt: iso(atMs), source: { system: 'test' }, idempotencyKey: `sb-${++k}`,
    payload: { sourceId, runId: `r${k}`, error: 'bad payload', reason },
  }, { now: atMs }).event;
}
const pump = (now) => bus.pumpAll({ now });
const active = (sourceId) => sb.getFindings({ status: 'active' }).filter((f) => f.source === sourceId);
const count = () => db.get('SELECT COUNT(*) AS n FROM event_log').n;

// A moment in which an interruption WOULD be allowed — so the only thing
// standing between a finding and Nick's phone is shadow mode itself.
const OPEN_MOMENT = {
  now: new Date(), known: true, inMeeting: false, quiet: false, onDuty: true, focusMode: false,
  moving: false, driving: false, atLaptop: true, atDesk: true, inFocusSession: false, muted: [],
};

// ── transitions and episodes ─────────────────────────────────────────────────

test('fresh → stale opens ONE finding; stale → stale on later checks does not', async () => {
  deliver('healthkit.neuro-ios', T0);
  deliver('healthkit.saim-ios', T0);
  await pump(T0 + 2 * 60000);
  assert.equal(active('healthkit.neuro-ios').length, 0, 'fresh: nothing to say');

  await sh.checkStaleness({ now: T0 + 13 * H });
  await pump(T0 + 13 * H);
  const f = active('healthkit.neuro-ios');
  assert.equal(f.length, 1);
  assert.equal(f[0].condition, 'stale');
  assert.equal(f[0].change, 'new');
  assert.equal(f[0].confidence, sb.CONFIDENCE['stale-push'], 'a phone app going quiet is a weaker read');
  assert.ok(f[0].evidence.length >= 1);
  assert.equal(f[0].lastObservedOrSuccessAt, iso(T0));

  const n = count();
  for (const h of [14, 15, 16]) await sh.checkStaleness({ now: T0 + h * H });
  await pump(T0 + 16 * H);
  assert.equal(count(), n, 'the five-minute check writes nothing during the same outage');
  assert.equal(active('healthkit.neuro-ios').length, 1, 'still ONE episode');
});

test('an older delivery (a draining queue) does not resolve staleness; newer data does', async () => {
  deliver('healthkit.neuro-ios', T0 - H, T0 + 17 * H);
  await pump(T0 + 17 * H);
  assert.equal(active('healthkit.neuro-ios').length, 1);

  deliver('healthkit.neuro-ios', T0 + 17 * H, T0 + 17 * H + 60000);
  await pump(T0 + 17 * H + 60000);
  assert.equal(active('healthkit.neuro-ios').length, 0, 'recovery resolves it');
  const resolved = sb.getFindings({ status: 'resolved' }).find((f) => f.source === 'healthkit.neuro-ios');
  assert.equal(resolved.change, 'resolved');
  assert.ok(resolved.resolvedAt);
});

test('failing needs THREE in a row; a fourth is a repeat, not a new finding', async () => {
  const s = 'device.neuro-ios';
  deliver(s, T0, T0 + 1000);
  fail(s, T0 + H); fail(s, T0 + 2 * H);
  await pump(T0 + 2 * H);
  assert.equal(active(s).length, 0, 'two failures are a hiccup');
  fail(s, T0 + 3 * H);
  await pump(T0 + 3 * H);
  assert.equal(active(s).length, 1);
  assert.equal(active(s)[0].condition, 'failing');
  assert.equal(active(s)[0].failureCount, 3);
  fail(s, T0 + 4 * H);
  await pump(T0 + 4 * H);
  assert.equal(active(s).length, 1);
  assert.equal(active(s)[0].change, 'repeat');
  assert.equal(active(s)[0].failureCount, 4);
});

test('stale that then starts FAILING is a change, not a second finding', async () => {
  const s = 'eventkit.neuro-ios';
  deliver(s, T0, T0 + 1000);
  await pump(T0 + 1000);
  await sh.checkStaleness({ now: T0 + 13 * H });
  await pump(T0 + 13 * H);
  assert.equal(active(s)[0].condition, 'stale');
  for (let i = 1; i <= 3; i++) fail(s, T0 + 13 * H + i * 60000, 'no-calendar-access');
  await pump(T0 + 14 * H);
  const f = active(s);
  assert.equal(f.length, 1);
  assert.equal(f[0].condition, 'failing');
  assert.equal(f[0].change, 'change');
});

test('a success that is NEWER than the failures resolves a failing finding; an older one does not', async () => {
  const s = 'device.neuro-ios';
  deliver(s, T0 + 2 * H, T0 + 2 * H + 1000); // received before the 3rd/4th failures
  await pump(T0 + 5 * H);
  assert.equal(active(s).length, 1, 'an older outcome does not roll the failures back');
  deliver(s, T0 + 5 * H, T0 + 5 * H + 1000);
  await pump(T0 + 5 * H + 1000);
  assert.equal(active(s).length, 0);
});

// ── never seen ───────────────────────────────────────────────────────────────

test('an expected source never heard from is flagged ONCE, only after its own window, at low confidence', async () => {
  const since = iso(T0);
  // Each source on ITS OWN window: the 12h phone sources are too early to say
  // at one hour; HA presence (polled every 2 min, stale after 30) is not.
  assert.deepEqual(await sb.checkExpected({ now: T0 + H, since }), ['homeassistant.presence'], 'too early to say for the 12h sources');
  const marked = await sb.checkExpected({ now: T0 + 13 * H, since });
  assert.ok(marked.includes('location.neuro-ios'));
  assert.ok(!marked.includes('healthkit.neuro-ios'), 'heard from — not never-seen');
  assert.ok(!marked.includes('healthkit.freereps-ios'), 'not an expected source');
  const f = active('location.neuro-ios');
  assert.equal(f[0].condition, 'never-seen');
  assert.equal(f[0].confidence, sb.CONFIDENCE['never-seen']);
  assert.equal(sh.getSource('location.neuro-ios').known, false, 'SourceHealth still says never heard from — no row invented');

  assert.deepEqual(await sb.checkExpected({ now: T0 + 20 * H, since }), [], 'once, ever');
  deliver('location.neuro-ios', T0 + 20 * H, T0 + 20 * H + 1000);
  await pump(T0 + 20 * H + 1000);
  assert.equal(active('location.neuro-ios').length, 0, 'the first delivery resolves it');
});

// ── redundancy ───────────────────────────────────────────────────────────────

test('redundant sensing: one app gone quiet while its peer reports drops a level', async () => {
  deliver('healthkit.saim-ios', T0 + 30 * H, T0 + 30 * H + 1000);
  await pump(T0 + 30 * H + 1000);
  await sh.checkStaleness({ now: T0 + 32 * H }); // neuro-ios last observed T0+17h
  await pump(T0 + 32 * H);
  const f = active('healthkit.neuro-ios')[0];
  assert.equal(f.importance, 'medium');
  assert.deepEqual(f.coveredBy, ['healthkit.saim-ios']);
  assert.equal(f.severity, 'low', 'health still flows, so this is a screen fact, not an interruption');
});

// ── the attention boundary ───────────────────────────────────────────────────

test('SHADOW: the policy verdict is recorded, nothing can win, and the pool is untouched', async () => {
  assert.equal(sb.mode(), 'shadow', 'shadow is the default');
  const verdicts = ambient.sourceBlindVerdicts(OPEN_MOMENT, { now: new Date(T0 + 33 * H) });
  assert.ok(verdicts.length >= 2);
  for (const v of verdicts) assert.equal(v.result.shadow, true);
  const eventkit = verdicts.find((v) => v.observation.source === 'eventkit.neuro-ios');
  assert.equal(eventkit.result.push, true, 'in this moment the policy WOULD push it…');
  const lowOne = verdicts.find((v) => v.observation.source === 'healthkit.neuro-ios');
  assert.equal(lowOne.result.push, false, '…and would NOT push a low-severity one');

  const rec = sb.getFindings({ status: 'active' }).find((f) => f.source === 'eventkit.neuro-ios').attention;
  assert.equal(rec.mode, 'shadow');
  assert.equal(rec.wouldPush, true);
  assert.equal(rec.pushedAt, null, 'never sent');
  ambient.sourceBlindVerdicts(OPEN_MOMENT, { now: new Date(T0 + 34 * H) });
  assert.equal(sb.getFindings({ status: 'active' }).find((f) => f.source === 'eventkit.neuro-ios').attention.decisions, 2);

  assert.deepEqual(require('./decision-engine').collectSourceBlindness(), [], 'shadow adds nothing to the screen pool');
});

test('the existing vetoes hold for a source-blind finding: meeting, focus, quiet, off duty, unknown', () => {
  const o = { kind: 'source-blind', severity: 'medium', text: 'x', detail: 'y' };
  assert.equal(ambient.worthInterrupting(o, OPEN_MOMENT).push, true);
  for (const [patch, why] of [
    [{ inMeeting: true }, 'in a meeting'],
    [{ focusMode: true }, 'Focus mode is on'],
    [{ quiet: true }, 'the brain has called this a quiet moment'],
    [{ inFocusSession: true }, 'in a focus session'],
    [{ known: false }, 'the situational read is not confident enough to interrupt'],
  ]) {
    const v = ambient.worthInterrupting(o, { ...OPEN_MOMENT, ...patch });
    assert.equal(v.push, false);
    assert.equal(v.why, why);
  }
  assert.equal(ambient.worthInterrupting(o, { ...OPEN_MOMENT, onDuty: false }).push, false, 'never in the evening');
  assert.equal(ambient.worthInterrupting(o, { ...OPEN_MOMENT, muted: ['source-blind'] }).push, false, 'learned muting applies');
  assert.equal(ambient.worthInterrupting({ ...o, severity: 'low' }, OPEN_MOMENT).push, false);
});

test('LIVE: a delivered episode is not offered again unless its condition changes', () => {
  process.env.SOURCE_BLIND_MODE = 'live';
  try {
    const pool = require('./decision-engine').collectSourceBlindness();
    assert.ok(pool.some((i) => i.type === 'source-blind' && i.dedupeKey === i.id), 'live: an ordinary, per-episode candidate');
    assert.ok(!pool.some((i) => i.meta.source === 'healthkit.neuro-ios'), 'low severity never enters the pool');

    const f = sb.getFindings({ status: 'active' }).find((x) => x.change !== 'change');
    assert.ok(f, 'positive control: an unchanged active finding exists to test against');
    assert.ok(sb.observations().some((o) => o.findingId === f.findingId), 'offered before it is delivered');
    sb.recordAttention(f.findingId, { push: true }, { now: T0 + 35 * H, pushed: true });
    const offered = sb.observations().map((o) => o.findingId);
    assert.ok(!offered.includes(f.findingId), 'pushed once: not again');
    const v = ambient.sourceBlindVerdicts(OPEN_MOMENT);
    assert.ok(v.some((x) => x.observation.liveEligible), 'positive control: something clears the threshold');
    for (const x of v) {
      assert.equal(x.result.shadow === true, !x.observation.liveEligible,
        'live: eligible verdicts can win, ineligible ones stay shadow');
    }
  } finally {
    delete process.env.SOURCE_BLIND_MODE;
  }
});

// ── Build 13O: the live threshold and its kill switch ────────────────────────

test('13O live threshold: expected source, and failing or silent ≥ 30h — nothing else', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const base = { status: 'active', source: 'eventkit.neuro-ios', condition: 'stale' };
  const at = (h) => new Date(now - h * H).toISOString();
  assert.equal(sb.liveEligible({ ...base, lastObservedOrSuccessAt: at(23.9) }, now).eligible, false,
    'the longest gap that healed by itself on the live Pi stays shadow');
  assert.equal(sb.liveEligible({ ...base, lastObservedOrSuccessAt: at(30) }, now).eligible, true);
  assert.equal(sb.liveEligible({ ...base, condition: 'failing', lastObservedOrSuccessAt: at(1) }, now).eligible, true,
    'repeated delivery failure is real breakage whatever the age');
  for (const condition of ['never-seen', 'moving-without-fix']) {
    assert.equal(sb.liveEligible({ ...base, condition, lastObservedOrSuccessAt: at(48) }, now).eligible, false, condition);
  }
  assert.equal(sb.liveEligible({ ...base, source: 'reminders.unknown', lastObservedOrSuccessAt: at(48) }, now).eligible, false,
    'a retired source is never surfaced');
  assert.equal(sb.liveEligible({ ...base, source: 'desktop.agent', lastObservedOrSuccessAt: at(48) }, now).eligible, false,
    'an optional source is never surfaced');
  assert.equal(sb.liveEligible({ ...base, lastObservedOrSuccessAt: null }, now).eligible, false, 'undatable silence is not evidence');
  assert.equal(sb.liveEligible({ ...base, status: 'resolved', lastObservedOrSuccessAt: at(48) }, now).eligible, false);
});

test('13O kill switch: the Settings flag moves shadow ↔ live, and an env value still wins', () => {
  const flags = require('./feature-flags');
  delete process.env.SOURCE_BLIND_MODE;
  delete process.env.SOURCE_BLIND_LIVE;
  try {
    flags.setEnabled('source_blind_live', false);
    assert.equal(sb.mode(), 'shadow');
    assert.deepEqual(require('./decision-engine').collectSourceBlindness(), [], 'switched off: nothing reaches the pool');
    flags.setEnabled('source_blind_live', true);
    assert.equal(sb.mode(), 'live', 'one switch promotes it');
    process.env.SOURCE_BLIND_MODE = 'off';
    assert.equal(sb.mode(), 'off', 'an explicit env value wins over the switch');
  } finally {
    delete process.env.SOURCE_BLIND_MODE;
    flags.setEnabled('source_blind_live', false);
  }
  assert.equal(sb.mode(), 'shadow', 'kill switch returns it to shadow');
});

// ── replay ───────────────────────────────────────────────────────────────────

test('replay rebuilds the findings IDENTICALLY, and the attention record reattaches', async () => {
  await pump();
  const snap = () => ({
    f: db.all('SELECT * FROM source_blind_findings ORDER BY finding_id'),
    s: db.all('SELECT * FROM source_blind_state ORDER BY source_id'),
  });
  const before = snap();
  const attention = db.all('SELECT * FROM source_blind_attention ORDER BY finding_id');
  assert.ok(before.f.length >= 4);
  await bus.replayConsumer(sb.CONSUMER);
  assert.deepEqual(snap(), before);
  assert.deepEqual(db.all('SELECT * FROM source_blind_attention ORDER BY finding_id'), attention,
    'not derivable from the log, so never reset — and the deterministic ids still match');
  const withAttention = sb.getFindings().filter((f) => f.attention);
  assert.ok(withAttention.length >= 1);
});

// ── watchdog ─────────────────────────────────────────────────────────────────

test('watchdog: a clean spine raises nothing; a dead letter is a WARNING, never a push', async () => {
  const wd = require('./watchdog');
  assert.deepEqual(wd.checkEventSpine(), []);
  bus.registerConsumer({ name: 'test-poison', types: ['source.sync.failed'], transactional: true, maxAttempts: 1,
    handle: () => { throw new Error('boom'); } });
  fail('poison.source', T0 + 40 * H);
  await bus.pumpConsumer('test-poison', { now: T0 + 40 * H });
  const issues = wd.checkEventSpine();
  const dead = issues.find((i) => i.key === 'event-spine:dead:test-poison');
  assert.ok(dead);
  assert.equal(dead.level, 'warn');
});

test('watchdog calendar sense reads the canonical projection — a dead Graph sync is no longer hidden by phone pushes', () => {
  const signals = require('./signals');
  const graphOk = Date.parse('2026-10-02T09:00:00Z');
  const run = sh.beginSourceRun('microsoft.calendar', { system: 'microsoft-graph', expectedIntervalMs: 20 * 60000, staleAfterMs: 60 * 60000 });
  run.succeed({ synced: 3 });
  return bus.pumpConsumer(sh.CONSUMER).then(async () => {
    // The phone's EventKit rows keep the cache's fetched_at current…
    db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, fetched_at, source)
            VALUES ('apple:x', 'Dentist', '2026-10-03 10:00', '2026-10-03 11:00', CURRENT_TIMESTAMP, 'apple')`);
    const live = signals.snapshot(new Date()).signals.find((s) => s.id === 'calendar');
    assert.equal(live.state, 'live');
    assert.match(live.detail, /source health/);
    // …while Graph itself has been silent for two hours.
    const later = Date.now() + 2 * H;
    await sh.checkStaleness({ now: later });
    const stale = signals.snapshot(new Date(later)).signals.find((s) => s.id === 'calendar');
    assert.equal(stale.state, 'stale', 'the cache alone would have said live');
    void graphOk;
  });
});

test('observability: the status says mode, last run, errors and finding counts', () => {
  const st = sb.status();
  assert.equal(st.mode, 'shadow');
  assert.equal(st.evaluator, 'source-blindness');
  assert.ok(st.findings.active >= 1);
  assert.ok(st.findings.resolved >= 1);
  assert.equal(st.deadLettered, 0);
});
