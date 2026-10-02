'use strict';

/**
 * The nervous system's spine: durable, typed, idempotent, ordered, recoverable.
 *
 * Real SQLite throughout — the guarantees here are SQL guarantees (a UNIQUE key,
 * a trigger, an offset committed in the handler's transaction) and a stub of the
 * database could only assert the contract I intended, not the one the code has.
 * The restart tests spawn a SECOND Node process against the same file, because
 * "survives a restart" proved inside one process proves only that a variable
 * survived.
 *
 *   run: node --test backend/services/event-bus.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-eventbus-'));
const DB_FILE = path.join(tmp, 'events.db');
process.env.NEURO_DB_PATH = DB_FILE;

const db = require('../db/database');
const bus = require('./event-bus');

test.before(async () => { await db.init(); });

let n = 0;
const ev = (over = {}) => ({
  type: 'source.sync.started',
  occurredAt: '2026-10-02T09:00:00.000Z',
  source: { system: 'test', recordId: 'r' },
  idempotencyKey: `k-${++n}`,
  payload: { sourceId: 'test.source', runId: `run-${n}` },
  ...over,
});

const count = () => db.get('SELECT COUNT(*) AS n FROM event_log').n;

// ── 1. persistence ───────────────────────────────────────────────────────────

test('an event persists with the whole envelope', () => {
  const { event, duplicate } = bus.publishEvent(ev({
    idempotencyKey: 'persist-1',
    subject: { entityType: 'person', entityId: 'nick' },
    source: { system: 'healthkit', deviceId: 'watch', recordId: 'abc' },
    provenance: { kind: 'fact', confidence: 0.9 },
  }), { now: Date.parse('2026-10-02T09:00:05Z') });
  assert.equal(duplicate, false);
  const back = bus.getEventById(event.eventId);
  assert.equal(back.schemaVersion, 1);
  assert.equal(back.type, 'source.sync.started');
  assert.equal(back.occurredAt, '2026-10-02T09:00:00.000Z');
  assert.equal(back.receivedAt, '2026-10-02T09:00:05.000Z', 'received is NEURO’s clock, not the source’s');
  assert.deepEqual(back.source, { system: 'healthkit', deviceId: 'watch', recordId: 'abc' });
  assert.deepEqual(back.subject, { entityType: 'person', entityId: 'nick' });
  assert.deepEqual(back.provenance, { kind: 'fact', confidence: 0.9 });
  assert.deepEqual(back.payload, { sourceId: 'test.source', runId: event.payload.runId });
  assert.match(back.eventId, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isInteger(back.seq));
});

test('provenance defaults to the type’s declared kind, never to "fact"', () => {
  const { event } = bus.publishEvent(ev({
    type: 'source.sync.stale',
    payload: { sourceId: 'x', lastSuccessAt: '2026-10-01T00:00:00.000Z', staleAfterMs: 1 },
  }));
  assert.equal(event.provenance.kind, 'inference');
});

// ── 2. idempotency ───────────────────────────────────────────────────────────

test('the same idempotency key twice is ONE event, and the second call returns the first', () => {
  const before = count();
  const a = bus.publishEvent(ev({ idempotencyKey: 'dup-1', payload: { sourceId: 's', runId: '1' } }));
  const b = bus.publishEvent(ev({ idempotencyKey: 'dup-1', payload: { runId: '1', sourceId: 's' } }));
  assert.equal(count(), before + 1);
  assert.equal(b.duplicate, true);
  assert.equal(b.conflict, false, 'key order is not a different payload');
  assert.equal(b.event.eventId, a.event.eventId);
  assert.equal(b.event.seq, a.event.seq);
});

test('⚠ a re-delivery with a DIFFERENT payload is folded but REPORTED as a conflict', () => {
  bus.publishEvent(ev({ idempotencyKey: 'conflict-1', payload: { sourceId: 's', runId: 'a' } }));
  const before = count();
  const b = bus.publishEvent(ev({ idempotencyKey: 'conflict-1', payload: { sourceId: 's', runId: 'b' } }));
  assert.equal(count(), before);
  assert.equal(b.duplicate, true);
  assert.equal(b.conflict, true);
  assert.equal(b.event.payload.runId, 'a', 'the log is immutable: the first delivery stands');
});

test('property: N publishes over K distinct keys leave exactly K events, in first-seen order', () => {
  // Seeded, so a failure is reproducible.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 5; round++) {
    const keys = Array.from({ length: 6 }, (_, i) => `prop-${round}-${i}`);
    const firstSeen = [];
    const before = count();
    for (let i = 0; i < 60; i++) {
      const k = keys[Math.floor(rnd() * keys.length)];
      const res = bus.publishEvent(ev({ idempotencyKey: k, payload: { sourceId: 's', runId: k } }));
      if (!firstSeen.includes(k)) { firstSeen.push(k); assert.equal(res.duplicate, false); }
      else assert.equal(res.duplicate, true);
    }
    assert.equal(count(), before + firstSeen.length);
    const stored = db.all(`SELECT idempotency_key FROM event_log WHERE idempotency_key LIKE ? ORDER BY seq`, [`prop-${round}-%`])
      .map(r => r.idempotency_key);
    assert.deepEqual(stored, firstSeen);
  }
});

// ── 3. correlation / causation ───────────────────────────────────────────────

test('correlation and causation survive the round trip, and a root correlates to itself', () => {
  const root = bus.publishEvent(ev({ idempotencyKey: 'chain-root' })).event;
  assert.equal(root.correlationId, root.eventId, 'a story with no parent starts at its own id');
  assert.equal(root.causationId, null);
  const child = bus.publishEvent(ev({
    idempotencyKey: 'chain-child', correlationId: root.correlationId, causationId: root.eventId,
  })).event;
  const back = bus.getEventById(child.eventId);
  assert.equal(back.correlationId, root.eventId);
  assert.equal(back.causationId, root.eventId);
  const story = bus.getEvents({ correlationId: root.eventId });
  assert.deepEqual(story.map(e => e.idempotencyKey), ['chain-root', 'chain-child']);
});

// ── immutability and validation ──────────────────────────────────────────────

test('⚠ the log is append-only: UPDATE and DELETE are refused by the database itself', () => {
  const { event } = bus.publishEvent(ev({ idempotencyKey: 'immutable-1' }));
  assert.throws(() => db.run('UPDATE event_log SET payload = ? WHERE seq = ?', ['{}', event.seq]), /append-only/);
  assert.throws(() => db.run('DELETE FROM event_log WHERE seq = ?', [event.seq]), /append-only/);
  assert.ok(Object.isFrozen(event.payload), 'consumers are handed a frozen payload');
});

test('malformed events are refused, and nothing is written', () => {
  const before = count();
  const bad = [
    { type: 'made.up.type' },
    { idempotencyKey: '' },
    { source: {} },
    { occurredAt: '2026-10-02' },            // a bare date is not an instant
    { occurredAt: 'yesterday' },
    { occurredAt: undefined },
    { payload: [] },
    { payload: { runId: 'x' } },             // sourceId required by the type
    { provenance: { kind: 'rumour' } },
    { provenance: { kind: 'fact', confidence: 1.5 } },
    { subject: { entityType: 'person' } },
    { payload: { sourceId: 's', runId: 'r', blob: 'x'.repeat(70 * 1024) } },
  ];
  for (const over of bad) {
    assert.throws(() => bus.publishEvent(ev(over)), bus.EventValidationError, JSON.stringify(over).slice(0, 80));
  }
  assert.equal(count(), before);
});

// ── consumers ────────────────────────────────────────────────────────────────

test('a consumer sees each event once, in order, and only its types', async () => {
  const seen = [];
  bus.registerConsumer({
    name: 'test-order', types: ['source.sync.failed'], transactional: true,
    handle: (e) => { seen.push(e.idempotencyKey); },
  });
  for (const k of ['o1', 'o2', 'o3']) {
    bus.publishEvent(ev({ type: 'source.sync.failed', idempotencyKey: `order-${k}`, payload: { sourceId: 's', runId: k, error: 'x' } }));
  }
  bus.publishEvent(ev({ idempotencyKey: 'order-not-mine' }));
  await bus.pumpConsumer('test-order');
  await bus.pumpConsumer('test-order');
  const mine = seen.filter(k => k.startsWith('order-'));
  assert.deepEqual(mine, ['order-o1', 'order-o2', 'order-o3']);
  assert.equal(bus.getStatus().consumers.find(c => c.name === 'test-order').lag, 0);
});

test('⚠ a transactional handler’s effects roll back with it — no half-applied event', async () => {
  db.run('CREATE TABLE IF NOT EXISTS tx_probe (k TEXT PRIMARY KEY)');
  let fail = true;
  bus.registerConsumer({
    name: 'test-tx', types: ['source.sync.succeeded'], transactional: true, backoffMs: [0],
    handle: (e) => {
      db.run('INSERT INTO tx_probe (k) VALUES (?)', [e.idempotencyKey]);
      if (fail) throw new Error('boom after writing');
    },
  });
  bus.publishEvent(ev({ type: 'source.sync.succeeded', idempotencyKey: 'tx-1', payload: { sourceId: 's', runId: 'tx' } }));
  await bus.pumpConsumer('test-tx');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tx_probe').n, 0, 'the write inside the failed handler was rolled back');
  fail = false;
  await bus.pumpConsumer('test-tx');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tx_probe').n, 1, 'applied exactly once on the retry');
  const f = db.get(`SELECT * FROM event_failures WHERE consumer = 'test-tx'`);
  assert.equal(f.status, 'resolved');
  assert.equal(f.resolution, 'processed');
});

test('⚠ effect and offset are ONE commit: if the offset cannot be advanced, the effect is undone too', async () => {
  // Simulates the replay CLI (another process) moving the offset while this
  // pump holds the event: the guarded advance fails and NOTHING may persist,
  // or the next pump applies the same event a second time.
  db.run('CREATE TABLE IF NOT EXISTS tx_probe2 (k TEXT PRIMARY KEY)');
  let interfere = true;
  bus.registerConsumer({
    name: 'test-atomic', types: ['source.sync.succeeded'], transactional: true,
    handle: (e) => {
      db.run('INSERT OR IGNORE INTO tx_probe2 (k) VALUES (?)', [e.idempotencyKey]);
      if (interfere) db.run(`UPDATE event_consumers SET position = position + 1000000 WHERE name = 'test-atomic'`);
    },
  });
  const r = await bus.pumpConsumer('test-atomic');
  assert.equal(r.skipped, 'position moved');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tx_probe2').n, 0, 'the effect was rolled back with the failed advance');
  interfere = false;
  await bus.pumpConsumer('test-atomic');
  const expected = db.get(`SELECT COUNT(*) AS n FROM event_log WHERE type = 'source.sync.succeeded'`).n;
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tx_probe2').n, expected, 'each event applied exactly once');
});

test('a transactional handler that returns a promise is refused, not half-run', async () => {
  bus.registerConsumer({
    name: 'test-async-in-tx', types: ['source.sync.succeeded'], transactional: true, maxAttempts: 1,
    handle: async () => {},
  });
  await bus.pumpConsumer('test-async-in-tx');
  const dead = db.all(`SELECT * FROM event_failures WHERE consumer = 'test-async-in-tx' AND status = 'dead'`);
  assert.ok(dead.length >= 1);
  assert.match(dead[0].last_error, /must be synchronous/);
});

// ── 5/6. retry, back-off and dead-lettering ──────────────────────────────────

test('a failed event is HELD (ordering), retried after back-off, and its attempts counted', async () => {
  let t = Date.parse('2026-10-02T10:00:00Z');
  const handled = [];
  let poison = null;
  bus.registerConsumer({
    name: 'test-retry', types: ['source.sync.failed'], transactional: true,
    maxAttempts: 3, backoffMs: [60000, 120000],
    handle: (e) => {
      if (e.idempotencyKey === poison) throw new Error('not yet');
      handled.push(e.idempotencyKey);
    },
  });
  // Drain what earlier tests left, then add three of our own.
  await bus.pumpConsumer('test-retry', { now: t });
  handled.length = 0;
  for (const k of ['r1', 'r2', 'r3']) {
    bus.publishEvent(ev({ type: 'source.sync.failed', idempotencyKey: `retry-${k}`, payload: { sourceId: 's', runId: k, error: 'e' } }));
  }
  poison = 'retry-r2';

  let r = await bus.pumpConsumer('test-retry', { now: t });
  assert.deepEqual(handled, ['retry-r1']);
  assert.equal(r.blocked, true, 'held at the failure — r3 must not be applied before r2');
  const seq2 = bus.getEvents({ afterSeq: 0, limit: 1000 }).find(e => e.idempotencyKey === 'retry-r2').seq;
  let f = db.get(`SELECT * FROM event_failures WHERE consumer = 'test-retry' AND seq = ?`, [seq2]);
  assert.equal(f.status, 'retrying');
  assert.equal(f.attempts, 1);
  assert.equal(f.next_attempt_at, new Date(t + 60000).toISOString());

  // Before the back-off: nothing happens, attempts unchanged.
  r = await bus.pumpConsumer('test-retry', { now: t + 30000 });
  assert.equal(r.blocked, true);
  assert.equal(db.get(`SELECT attempts FROM event_failures WHERE consumer = 'test-retry' AND seq = ?`, [seq2]).attempts, 1);

  // After it: retried, fails again, second back-off applies.
  t += 61000;
  await bus.pumpConsumer('test-retry', { now: t });
  f = db.get(`SELECT * FROM event_failures WHERE consumer = 'test-retry' AND seq = ?`, [seq2]);
  assert.equal(f.attempts, 2);
  assert.equal(f.next_attempt_at, new Date(t + 120000).toISOString());
  const c = bus.getStatus().consumers.find(x => x.name === 'test-retry');
  assert.equal(c.retrying, 1);
  assert.match(c.lastError, /not yet/);
});

test('⚠ exhausting retries DEAD-LETTERS the event: retained, visible, and the consumer moves on', async () => {
  // Continues the previous test: attempt 3 of 3.
  const t = Date.parse('2026-10-02T10:10:00Z');
  const seq2 = bus.getEvents({ afterSeq: 0, limit: 1000 }).find(e => e.idempotencyKey === 'retry-r2').seq;
  const r = await bus.pumpConsumer('test-retry', { now: t });
  assert.equal(r.deadLettered, 1);
  const f = db.get(`SELECT * FROM event_failures WHERE consumer = 'test-retry' AND seq = ?`, [seq2]);
  assert.equal(f.status, 'dead');
  assert.equal(f.attempts, 3);
  assert.match(f.last_error, /not yet/);
  const c = bus.getStatus().consumers.find(x => x.name === 'test-retry');
  assert.equal(c.deadLettered, 1);
  assert.equal(c.lag, 0, 'r3 was processed after the poison event was set aside');
  assert.ok(bus.getEvent(seq2), 'the event itself is still in the log');
  assert.equal(bus.getStatus().failures.dead >= 1, true);
});

test('an ASYNC consumer is at-least-once and records its offset after the handler', async () => {
  let calls = 0;
  bus.registerConsumer({
    name: 'test-async', types: ['source.sync.stale'], transactional: false,
    handle: async () => { calls++; await new Promise(r => setImmediate(r)); },
  });
  const res = await bus.pumpConsumer('test-async');
  assert.ok(res.processed >= 1);
  assert.equal(calls, res.processed);
  assert.equal(bus.getStatus().consumers.find(x => x.name === 'test-async').lag, 0);
});

test('a consumer already running is not entered twice', async () => {
  let release;
  bus.registerConsumer({
    name: 'test-mutex', types: ['source.sync.started'], transactional: false,
    handle: () => new Promise(r => { release = r; }),
  });
  const first = bus.pumpConsumer('test-mutex', { batch: 1 });
  const second = await bus.pumpConsumer('test-mutex');
  assert.equal(second.skipped, 'already running');
  release();
  // let the first finish its batch-of-one loop: release every later wait too
  const timer = setInterval(() => release && release(), 1);
  await first;
  clearInterval(timer);
});

// ── 4. restart recovery (a second process) ───────────────────────────────────

function childScript(body) {
  const file = path.join(tmp, `child-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, [
    `process.env.NEURO_DB_PATH = ${JSON.stringify(DB_FILE)};`,
    `const db = require(${JSON.stringify(path.join(__dirname, '..', 'db', 'database'))});`,
    `const bus = require(${JSON.stringify(path.join(__dirname, 'event-bus'))});`,
    'const seen = [];',
    'bus.registerConsumer({ name: "test-restart", types: ["source.sync.succeeded"], transactional: true,',
    '  handle: (e) => { if (e.idempotencyKey.startsWith("restart-")) seen.push(e.idempotencyKey); } });',
    '(async () => { await db.init(); console.log = () => {};',
    body,
    '})().catch(e => { process.stderr.write(e.stack); process.exit(1); });',
  ].join('\n'));
  return execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim().split('\n').pop();
}

test('⚠ events and offsets survive a restart: a NEW process resumes exactly where the last stopped', () => {
  // Process A publishes two events and consumes them.
  const a = JSON.parse(childScript([
    'bus.publishEvent({ type: "source.sync.succeeded", occurredAt: "2026-10-02T11:00:00Z", source: { system: "t" },',
    '  idempotencyKey: "restart-1", payload: { sourceId: "s", runId: "1" } });',
    'bus.publishEvent({ type: "source.sync.succeeded", occurredAt: "2026-10-02T11:01:00Z", source: { system: "t" },',
    '  idempotencyKey: "restart-2", payload: { sourceId: "s", runId: "2" } });',
    'await bus.pumpConsumer("test-restart");',
    'process.stdout.write(JSON.stringify(seen) + String.fromCharCode(10));',
  ].join('\n')));
  assert.deepEqual(a, ['restart-1', 'restart-2']);

  // Between processes: one more event arrives (published from this process).
  bus.publishEvent(ev({ type: 'source.sync.succeeded', idempotencyKey: 'restart-3', payload: { sourceId: 's', runId: '3' } }));

  // Process B: a cold start. It must see ONLY restart-3 — nothing replayed,
  // nothing skipped — and a re-publish of restart-1 must fold.
  const b = JSON.parse(childScript([
    'const dup = bus.publishEvent({ type: "source.sync.succeeded", occurredAt: "2026-10-02T11:00:00Z", source: { system: "t" },',
    '  idempotencyKey: "restart-1", payload: { sourceId: "s", runId: "1" } });',
    'await bus.pumpConsumer("test-restart");',
    'process.stdout.write(JSON.stringify({ seen, dup: dup.duplicate }) + String.fromCharCode(10));',
  ].join('\n')));
  assert.deepEqual(b.seen, ['restart-3']);
  assert.equal(b.dup, true);
  assert.equal(db.all(`SELECT * FROM event_log WHERE idempotency_key LIKE 'restart-%'`).length, 3);
});

// ── observability ────────────────────────────────────────────────────────────

test('status reports counts, newest event, lag and failures — and no payloads', () => {
  const s = bus.getStatus();
  assert.equal(s.events.count, count());
  assert.equal(s.events.newestSeq, db.get('SELECT MAX(seq) AS m FROM event_log').m);
  assert.ok(s.events.newestAt);
  assert.ok(s.events.byType['source.sync.started'] > 0);
  assert.ok(s.consumers.some(c => c.name === 'source-health' && c.registered), 'the built-in projector is listed');
  assert.ok(s.failures.dead >= 1);
  assert.doesNotMatch(JSON.stringify(s), /runId/, 'status is counts only');
});

test('replay refuses a consumer that is not declared replayable', async () => {
  await assert.rejects(() => bus.replayConsumer('test-order'), /not declared replayable/);
});
