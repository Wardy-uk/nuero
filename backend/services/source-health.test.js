'use strict';

/**
 * SourceHealth — the first projection, and the proof that a projection can be
 * rebuilt from the log alone.
 *
 * The rule every test leans on: "unknown is not zero, and is not healthy". A
 * source nobody has heard from, a source that has only failed, and a source
 * that succeeded long ago are three different facts, and the projection must
 * keep them apart.
 *
 *   run: node --test backend/services/source-health.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-srchealth-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'sh.db');

const db = require('../db/database');
const bus = require('./event-bus');
const sh = require('./source-health');

test.before(async () => { await db.init(); });

const T0 = Date.parse('2026-10-02T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let k = 0;

function emit(type, sourceId, at, extra = {}) {
  return bus.publishEvent({
    type,
    occurredAt: iso(at),
    source: { system: 'test' },
    idempotencyKey: `sh-${++k}`,
    payload: { sourceId, runId: `r${k}`, ...extra },
  }, { now: at }).event;
}

const pump = (now) => bus.pumpConsumer(sh.CONSUMER, { now });
const snapshot = () => db.all('SELECT * FROM source_health ORDER BY source_id');

test('a source nobody has heard from is UNKNOWN — explicitly, not absent and not healthy', () => {
  const s = sh.getSource('never.heard');
  assert.equal(s.known, false);
  assert.equal(s.state, 'unknown');
  assert.equal(s.freshness, 'unknown');
});

test('8. a success makes it healthy and fresh, with the detail and the thresholds from its own events', async () => {
  emit('source.sync.started', 'cal', T0, { expectedIntervalMs: 1200000, staleAfterMs: 3600000 });
  emit('source.sync.succeeded', 'cal', T0 + 5000, { detail: { synced: 12 } });
  await pump(T0 + 6000);
  const s = sh.getSource('cal', { now: T0 + 6000 });
  assert.equal(s.state, 'healthy');
  assert.equal(s.freshness, 'fresh');
  assert.equal(s.lastAttemptAt, iso(T0));
  assert.equal(s.lastSuccessAt, iso(T0 + 5000));
  assert.equal(s.expectedIntervalMs, 1200000);
  assert.equal(s.staleAfterMs, 3600000);
  assert.deepEqual(s.lastDetail, { synced: 12 });
  assert.equal(s.successAgeMs, 1000);
  assert.equal(s.inProgress, false);
});

test('a run that started and has not finished reads as in progress', async () => {
  emit('source.sync.started', 'cal', T0 + 60000);
  await pump(T0 + 61000);
  assert.equal(sh.getSource('cal').inProgress, true);
});

test('9. a failure makes it failing, keeps the last success, and counts consecutive failures', async () => {
  emit('source.sync.failed', 'cal', T0 + 70000, { error: 'Graph 401', reason: 'fetch-threw' });
  emit('source.sync.started', 'cal', T0 + 80000);
  emit('source.sync.failed', 'cal', T0 + 90000, { error: 'Graph returned no events', reason: 'empty-response', ambiguous: true });
  await pump(T0 + 91000);
  const s = sh.getSource('cal');
  assert.equal(s.state, 'failing');
  assert.equal(s.freshness, 'fresh', 'one failure does not make the last good data stale');
  assert.equal(s.lastSuccessAt, iso(T0 + 5000), 'the last success is kept, not erased');
  assert.equal(s.consecutiveFailures, 2);
  assert.deepEqual(s.failure, { error: 'Graph returned no events', reason: 'empty-response', ambiguous: true });
  assert.equal(s.inProgress, false);
});

test('a source that has ONLY ever failed has no freshness to speak of — unknown, never fresh', async () => {
  emit('source.sync.started', 'only.fails', T0, { staleAfterMs: 1000 });
  emit('source.sync.failed', 'only.fails', T0 + 1, { error: 'nope' });
  await pump(T0 + 2);
  const marked = await sh.checkStaleness({ now: T0 + 999999 });
  assert.ok(!marked.includes('only.fails'), 'there is no success to have gone stale');
  const s = sh.getSource('only.fails');
  assert.equal(s.state, 'failing');
  assert.equal(s.freshness, 'unknown');
});

test('10. stale: past the threshold it is MARKED stale by an event, once, and a success clears it', async () => {
  // Last success T0+5s, threshold 1h.
  assert.deepEqual(await sh.checkStaleness({ now: T0 + 3600000 }), [], 'exactly at the threshold is not past it');
  const marked = await sh.checkStaleness({ now: T0 + 3700000 });
  assert.deepEqual(marked, ['cal']);
  let s = sh.getSource('cal');
  assert.equal(s.freshness, 'stale');
  assert.equal(s.staleSince, iso(T0 + 3700000));
  assert.equal(s.state, 'failing', 'state and freshness are separate questions');

  // Checking again during the same outage writes nothing new.
  const before = db.get(`SELECT COUNT(*) AS n FROM event_log WHERE type = 'source.sync.stale'`).n;
  assert.deepEqual(await sh.checkStaleness({ now: T0 + 9000000 }), []);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM event_log WHERE type = 'source.sync.stale'`).n, before);

  emit('source.sync.started', 'cal', T0 + 9100000);
  emit('source.sync.succeeded', 'cal', T0 + 9105000, { detail: { synced: 9 } });
  await pump(T0 + 9106000);
  s = sh.getSource('cal');
  assert.equal(s.state, 'healthy');
  assert.equal(s.freshness, 'fresh');
  assert.equal(s.staleSince, null);
  assert.equal(s.consecutiveFailures, 0);
});

test('⚠ a stale verdict about a SUPERSEDED success changes nothing', async () => {
  // A verdict that arrives after a newer success (two processes, or a replay).
  bus.publishEvent({
    type: 'source.sync.stale', occurredAt: iso(T0 + 9200000), source: { system: 'neuro' },
    idempotencyKey: 'late-stale-verdict',
    payload: { sourceId: 'cal', lastSuccessAt: iso(T0 + 5000), staleAfterMs: 3600000 },
  });
  await pump(T0 + 9200001);
  assert.equal(sh.getSource('cal').freshness, 'fresh');
});

test('an older outcome arriving late never rolls the state back', async () => {
  emit('source.sync.failed', 'cal', T0 + 9000000, { error: 'old news' }); // older than the latest success
  await pump(T0 + 9300000);
  const s = sh.getSource('cal');
  assert.equal(s.state, 'healthy');
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastFailureAt, iso(T0 + 9000000), 'but the failure is still recorded as having happened');
});

test('7. replay rebuilds the IDENTICAL projection from the log', async () => {
  await pump(T0 + 9400000);
  const before = snapshot();
  assert.ok(before.length >= 2);
  db.run(`UPDATE source_health SET state = 'healthy', freshness = 'fresh', failure_detail = 'tampered' WHERE source_id = 'only.fails'`);
  const res = await bus.replayConsumer(sh.CONSUMER, { now: T0 + 9500000 });
  assert.ok(res.processed > 0);
  assert.deepEqual(snapshot(), before, 'every column, including updated_at, is a function of the log');
});

test('replaying twice is the same as replaying once (idempotent), and publishes nothing', async () => {
  const events = db.get('SELECT COUNT(*) AS n FROM event_log').n;
  await bus.replayConsumer(sh.CONSUMER);
  const once = snapshot();
  await bus.replayConsumer(sh.CONSUMER);
  assert.deepEqual(snapshot(), once);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM event_log').n, events, 'a replay re-runs handlers; it never re-publishes');
});

test('property: for random histories, incremental projection === full replay', async () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const kinds = ['source.sync.started', 'source.sync.succeeded', 'source.sync.failed'];
  for (let round = 0; round < 8; round++) {
    let t = T0 + 20000000 + round * 1000000;
    for (let i = 0; i < 25; i++) {
      const src = `p${round}.${Math.floor(rnd() * 3)}`;
      const type = kinds[Math.floor(rnd() * kinds.length)];
      // Times mostly move forward, sometimes jump back — the out-of-order case.
      t += Math.floor(rnd() * 60000) - (rnd() < 0.2 ? 90000 : 0);
      const extra = type === 'source.sync.failed' ? { error: `e${i}` } : (type === 'source.sync.started' ? { staleAfterMs: 120000 } : {});
      emit(type, src, t, extra);
      // Interleave pumping and stale checks with publishing, as the live system does.
      if (rnd() < 0.3) await pump(t);
      if (rnd() < 0.2) await sh.checkStaleness({ now: t + Math.floor(rnd() * 400000) });
    }
    await pump(t + 1);
    const incremental = snapshot();
    await bus.replayConsumer(sh.CONSUMER);
    assert.deepEqual(snapshot(), incremental, `round ${round}`);
  }
});

test('beginSourceRun: started then ONE outcome, correlated and caused by the start', async () => {
  const run = sh.beginSourceRun('run.test', { system: 'unit', expectedIntervalMs: 1000, staleAfterMs: 5000 });
  const ok = run.succeed({ synced: 3 });
  const second = run.fail('too late');
  assert.equal(second, null, 'a finished run cannot also fail');
  const started = run.startedEvent;
  assert.equal(started.type, 'source.sync.started');
  assert.equal(ok.correlationId, started.correlationId);
  assert.equal(ok.causationId, started.eventId);
  assert.equal(ok.payload.runId, run.runId);
  assert.ok(Number.isInteger(ok.payload.durationMs));
  // The outcome's key is shared, so even a second handle for the same run folds.
  const dup = bus.publishEvent({
    type: 'source.sync.failed', occurredAt: new Date().toISOString(), source: { system: 'unit' },
    idempotencyKey: `source-run:run.test:${run.runId}:outcome`,
    payload: { sourceId: 'run.test', runId: run.runId, error: 'x' },
  });
  assert.equal(dup.duplicate, true);
  await pump();
  assert.equal(sh.getSource('run.test').state, 'healthy');
});

test('beginSourceRun never throws — a bad id is refused with a warning and every method is a no-op', () => {
  const run = sh.beginSourceRun('Not A Valid Id!');
  assert.equal(run.startedEvent, null);
  assert.equal(run.succeed({}), null);
  assert.equal(run.fail('x'), null);
  assert.equal(run.publish({ type: 'observation.calendar.window_synced' }), null);
});

test('getSourceHealth says whether the projection is caught up with the log', async () => {
  emit('source.sync.started', 'lagging', Date.now());
  let h = sh.getSourceHealth();
  assert.equal(h.projection.current, false);
  assert.ok(h.projection.lag >= 1);
  await pump();
  h = sh.getSourceHealth();
  assert.equal(h.projection.current, true);
  assert.equal(h.projection.lag, 0);
  assert.ok(h.sources.some(s => s.sourceId === 'lagging'));
});
