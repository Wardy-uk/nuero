'use strict';

/**
 * The durable runtime (Build 3A) — a due run cannot silently disappear.
 *
 * Every test drives tick() with an injected clock, so "the cron timer missed"
 * is modelled the way it happens in production: simply no tick at the slot.
 *
 *   run: node --test backend/services/runtime-jobs.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-runtime-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'rt.db');

const db = require('../db/database');
const runtime = require('./runtime-jobs');

test.before(async () => { await db.init(); });

const MIN = 60 * 1000;
// A fixed local instant; slots are matched in local time like node-cron's.
const at = (h, m, s = 0) => new Date(2026, 9, 3, h, m, s).getTime();
const rows = (job) => db.all('SELECT * FROM runtime_job_runs WHERE job = ? ORDER BY scheduled_for', [job]);
const failedEvents = (job) => db.all(`SELECT * FROM event_log WHERE type = 'runtime.job.failed' AND subject_id = ?`, [job]);
const skippedEvents = (job) => db.all(`SELECT * FROM event_log WHERE type = 'runtime.job.skipped' AND subject_id = ?`, [job]);

let n = 0;
function fresh(def) {
  runtime._reset();
  const name = `${def.name || 'job'}-${++n}`;
  const calls = [];
  const job = runtime.defineJob({
    class: 'correctness-critical', cron: '*/5 * * * *',
    ...def,
    name,
    run: async (ctx) => { calls.push(ctx); return def.run ? def.run(ctx, calls) : { ok: true }; },
  });
  return { job, name, calls };
}

test('the slot vocabulary is node-cron\'s own matcher, in local time', () => {
  const { job } = fresh({ cron: '*/20 * * * *' });
  const slots = runtime.slotsBetween(job, at(8, 0), at(9, 0));
  assert.deepEqual(slots, [at(8, 20), at(8, 40), at(9, 0)]);
  assert.equal(runtime.latestSlot(job, at(8, 59, 30), 60 * MIN), at(8, 40));
  assert.equal(runtime.nextSlot(job, at(8, 40)), at(9, 0));
});

test('first ever registration materialises only the slot due now — no invented history', async () => {
  const { name, calls } = fresh({});
  await runtime.tick({ now: at(8, 7) });
  assert.deepEqual(rows(name).map((r) => r.scheduled_for), [new Date(at(8, 5)).toISOString()]);
  assert.equal(calls.length, 1);
  assert.equal(rows(name)[0].status, 'succeeded');
});

test('1. a missed cron tick still results in execution — slots come from the clock, not a timer', async () => {
  const { name, calls } = fresh({ catchUp: 'all' });
  await runtime.tick({ now: at(8, 0, 5) });
  // No tick at 08:05 or 08:10 at all — the production failure. The next tick
  // still finds both slots.
  await runtime.tick({ now: at(8, 11) });
  const r = rows(name);
  assert.deepEqual(r.map((x) => x.status), ['succeeded', 'succeeded', 'succeeded']);
  assert.equal(calls.length, 3);
});

test('catchUp latest: of several missed slots only the newest runs; the rest are SUPERSEDED, not lost', async () => {
  const { name, calls } = fresh({ catchUp: 'latest' });
  await runtime.tick({ now: at(8, 0, 5) });
  await runtime.tick({ now: at(8, 21) });
  const r = rows(name);
  assert.equal(r.length, 5); // 08:00 + 05,10,15,20
  assert.deepEqual(r.map((x) => x.status), ['succeeded', 'skipped', 'skipped', 'skipped', 'succeeded']);
  assert.ok(r.slice(1, 4).every((x) => x.skip_reason === 'superseded'));
  assert.equal(calls.length, 2);
  // Superseding is not news — nothing in the immutable log for it.
  assert.equal(skippedEvents(name).length, 0);
});

test('2. a backend restart after the due time catches the run, and an interrupted run is retried', async () => {
  let release;
  const { name } = fresh({ maxAttempts: 2, backoffMs: [MIN], run: () => new Promise((r) => { release = r; }) });
  const oldBoot = runtime._bootId();
  const running = runtime.tick({ now: at(10, 0, 3) }); // claims 10:00 and hangs
  await new Promise((r) => setImmediate(r));
  assert.equal(rows(name)[0].status, 'running');

  // "Restart": a new process (new boot id, jobs redefined) comes up at 10:12.
  // The in-flight promise of the old process is simply abandoned.
  runtime._reset();
  runtime._setBootId('boot-after-restart');
  const ran = [];
  runtime.defineJob({ name, class: 'correctness-critical', cron: '*/5 * * * *', catchUp: 'all', maxAttempts: 2, backoffMs: [MIN],
    run: async (ctx) => { ran.push(ctx.scheduledFor.getTime()); } });
  await runtime.tick({ now: at(10, 12) });
  const r = rows(name);
  const interrupted = r.find((x) => x.scheduled_for === new Date(at(10, 0)).toISOString());
  assert.equal(interrupted.status, 'pending', 'interrupted attempt goes back for a retry');
  assert.match(interrupted.error, /interrupted/);
  assert.deepEqual(ran, [at(10, 5), at(10, 10)], 'the slots that fell due while down were caught up');

  await runtime.tick({ now: at(10, 13, 30) }); // past the 1-minute back-off
  assert.equal(rows(name).find((x) => x.scheduled_for === new Date(at(10, 0)).toISOString()).status, 'succeeded');
  assert.equal(rows(name).find((x) => x.scheduled_for === new Date(at(10, 0)).toISOString()).attempts, 2);
  release(); await running; // tidy the abandoned promise; its late finish changes nothing
  assert.equal(rows(name).find((x) => x.scheduled_for === new Date(at(10, 0)).toISOString()).owner, 'boot-after-restart');
  runtime._setBootId(oldBoot);
});

test('3. a duplicate wake-up does not execute the same run twice', async () => {
  const { name, calls } = fresh({});
  await Promise.all([runtime.tick({ now: at(11, 0, 1) }), runtime.tick({ now: at(11, 0, 1) }), runtime.tick({ now: at(11, 0, 2) })]);
  assert.equal(calls.length, 1);
  assert.equal(rows(name).length, 1);
  // Materialising again is a no-op on the deterministic id.
  assert.equal(runtime.materialise(runtime._jobs.get(name), at(11, 0, 3)), 0);
});

test('4. a long-running job does not overlap with itself', async () => {
  let release;
  const { name, calls } = fresh({ run: (ctx, c) => (c.length === 1 ? new Promise((r) => { release = r; }) : 'quick') });
  const first = runtime.tick({ now: at(12, 0, 1) });
  await new Promise((r) => setImmediate(r));
  await runtime.tick({ now: at(12, 6) }); // 12:05 is due — but 12:00 is still running
  assert.equal(calls.length, 1, 'no second run while the first is live');
  assert.equal(rows(name).filter((r) => r.status === 'running').length, 1);
  release(); await first;
  await runtime.tick({ now: at(12, 7) });
  assert.equal(calls.length, 2, 'the held slot runs once the job is free');
  assert.deepEqual(rows(name).map((r) => r.status), ['succeeded', 'succeeded']);
});

test('5. catch-up hands the job its SCHEDULED time, and lag is measured from it', async () => {
  const { name, calls } = fresh({ catchUp: 'all' });
  await runtime.tick({ now: at(13, 0, 1) });
  await runtime.tick({ now: at(13, 7, 30) }); // 13:05 runs 2.5 minutes late
  const late = calls[1];
  assert.equal(late.scheduledFor.getTime(), at(13, 5));
  assert.equal(late.startedAt.getTime(), at(13, 7, 30));
  assert.equal(late.lagMs, 150 * 1000);
  assert.equal(late.runId, `${name}@${new Date(at(13, 5)).toISOString()}`);
  assert.equal(rows(name)[1].lag_ms, 150 * 1000);
});

test('6. a failed run is visible and retryable, then recorded as it ends', async () => {
  const { name, calls } = fresh({ maxAttempts: 2, backoffMs: [MIN],
    run: (ctx, c) => { if (c.length === 1) throw new Error('graph said 503'); return { ok: true }; } });
  await runtime.tick({ now: at(14, 0, 1) });
  let r = rows(name)[0];
  assert.equal(r.status, 'pending');
  assert.equal(r.attempts, 1);
  assert.match(r.error, /503/);
  assert.equal(r.next_attempt_at, new Date(at(14, 1, 1)).toISOString());
  await runtime.tick({ now: at(14, 0, 30) }); // back-off not passed
  assert.equal(calls.length, 1);
  await runtime.tick({ now: at(14, 1, 5) });
  r = rows(name)[0];
  assert.equal(r.status, 'succeeded');
  assert.equal(r.attempts, 2);
  assert.equal(failedEvents(name).length, 0, 'a recovered run is not a failure in the log');
});

test('7. a permanently failing job does not block an unrelated one', async () => {
  runtime._reset();
  const okCalls = [];
  runtime.defineJob({ name: 'always-broken', class: 'best-effort', cron: '*/5 * * * *', maxAttempts: 1,
    run: () => { throw new Error('broken for good'); } });
  runtime.defineJob({ name: 'healthy-neighbour', class: 'correctness-critical', cron: '*/5 * * * *',
    run: async () => { okCalls.push(1); } });
  await runtime.tick({ now: at(15, 0, 1) });
  await runtime.tick({ now: at(15, 5, 1) });
  assert.deepEqual(rows('always-broken').map((r) => r.status), ['failed', 'failed']);
  assert.deepEqual(rows('healthy-neighbour').map((r) => r.status), ['succeeded', 'succeeded']);
  assert.equal(okCalls.length, 2);
  const ev = failedEvents('always-broken');
  assert.equal(ev.length, 2, 'each terminal failure is one immutable event');
  assert.equal(JSON.parse(ev[0].payload).error, 'broken for good');
});

test('8. a best-effort job past its max lag is SKIPPED as stale, recorded, and not run', async () => {
  const { name, calls } = fresh({ cron: '*/40 * * * *', class: 'freshness-sensitive', maxLagMs: 15 * MIN });
  await runtime.tick({ now: at(16, 0, 1) });
  // The 16:40 tick never fires; the next tick is at 16:58 — 18 min late.
  await runtime.tick({ now: at(16, 58) });
  const r = rows(name);
  assert.deepEqual(r.map((x) => x.status), ['succeeded', 'skipped']);
  assert.equal(r[1].skip_reason, 'stale');
  assert.equal(calls.length, 1, 'a stale moment is never run late');
  const ev = skippedEvents(name);
  assert.equal(ev.length, 1);
  assert.equal(JSON.parse(ev[0].payload).reason, 'stale');
  // Within the limit it runs late rather than being skipped.
  await runtime.tick({ now: at(17, 10) }); // 17:00 is 10 min late
  assert.equal(calls.length, 2);
  assert.equal(rows(name).at(-1).status, 'succeeded');
});

test('a run past its timeout is failed and the job is released', async () => {
  const { name } = fresh({ timeoutMs: 50, maxAttempts: 1, run: () => new Promise(() => {}) });
  await runtime.tick({ now: at(17, 0, 1) });
  const r = rows(name)[0];
  assert.equal(r.status, 'failed');
  assert.match(r.error, /timed out/);
});

test('an outage longer than the lookback is ONE recorded gap, not silence and not thousands of rows', async () => {
  const { name, calls } = fresh({ lookbackMs: 60 * MIN });
  await runtime.tick({ now: at(1, 0, 1) });
  await runtime.tick({ now: at(5, 0, 1) }); // four hours down
  const r = rows(name);
  const gap = r.find((x) => x.skip_reason === 'gap');
  assert.ok(gap, 'the lost slots are on record');
  assert.match(gap.error, /36 slot\(s\)/);
  assert.equal(skippedEvents(name).filter((e) => JSON.parse(e.payload).reason === 'gap').length, 1);
  assert.equal(calls.at(-1).scheduledFor.getTime(), at(5, 0), 'and the current slot still runs');
  assert.ok(r.length < 20);
});

test('9. status makes lag, outcomes and overdue runs observable', async () => {
  const { name } = fresh({ catchUp: 'all' });
  await runtime.tick({ now: at(18, 0, 2) });
  await runtime.tick({ now: at(18, 6) });
  const st = runtime.status({ now: at(18, 6, 30) });
  const j = st.jobs.find((x) => x.name === name);
  assert.equal(j.last24h.succeeded, 2);
  assert.equal(j.last24h.failed, 0);
  assert.equal(j.lastScheduledFor, new Date(at(18, 5)).toISOString());
  assert.equal(j.lastActualStart, new Date(at(18, 6)).toISOString());
  assert.equal(j.lastLagMs, 60 * 1000);
  assert.equal(j.last24h.lagMaxMs, 60 * 1000);
  assert.equal(j.overdue, 0);
  assert.equal(j.nextScheduledFor, new Date(at(18, 10)).toISOString());
  assert.equal(j.policy.overlap, 'forbid');
  // A slot left pending past its time is OVERDUE — the "silently missed" case
  // made loud.
  runtime.materialise(runtime._jobs.get(name), at(18, 30));
  const later = runtime.status({ now: at(18, 31, 30) }).jobs.find((x) => x.name === name);
  assert.ok(later.overdue > 0);
});

test('the claim is one conditional UPDATE — a second claimant (another process) gets nothing', () => {
  const { name } = fresh({});
  const job = runtime._jobs.get(name);
  runtime.materialise(job, at(19, 0, 1));
  const row = rows(name)[0];
  const first = runtime._claim(row, at(19, 0, 2));
  const second = runtime._claim(row, at(19, 0, 2));
  assert.ok(first, 'the first claimant takes the run');
  assert.equal(second, null, 'the same pending row cannot be claimed twice');
  assert.equal(rows(name)[0].attempts, 1);
});

test('overlap is refused from the DATABASE too, not only by the in-process flag', async () => {
  const { name, calls } = fresh({});
  const job = runtime._jobs.get(name);
  runtime.materialise(job, at(20, 0, 1));
  runtime._claim(rows(name)[0], at(20, 0, 2)); // a live run of this boot, not in this tick's memory
  await runtime.tick({ now: at(20, 6) });
  assert.equal(calls.length, 0, 'a live run in the table blocks a second one');
});

test('10. the three production jobs register with their audited policies', () => {
  runtime._reset();
  require('./scheduler').registerDurableJobs();
  const j = runtime._jobs;
  // Build 5A: meeting-context's job was superseded by meeting-intelligence.
  assert.deepEqual([...j.keys()].sort(), ['action-executor', 'ambient-pass', 'calendar-sync', 'capture-drain', 'commitment-risk', 'meeting-intelligence',
    'ms-tasks-sync', 'personal-deadline', 'source-blind-investigation', 'source-staleness', 'world-obligations-sync', 'world-people-sync']);
  // Build 14H: best-effort, one attempt — a missed pass is the next slot.
  assert.equal(j.get('source-blind-investigation').class, 'best-effort');
  assert.equal(j.get('source-blind-investigation').maxAttempts, 1);
  // Build 6: the governed executor's reconciler. Correctness-critical, one
  // attempt per slot (a failed pass is simply the next slot — reconcile is
  // idempotent and never resends), and NOT also on node-cron.
  assert.equal(j.get('action-executor').cron, '*/2 * * * *');
  assert.equal(j.get('action-executor').class, 'correctness-critical');
  assert.equal(j.get('action-executor').maxAttempts, 1);
  assert.ok(!fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8').includes('action-executor\').reconcile();\n  })'),
    'the reconciler must not also be on node-cron');
  assert.equal(j.get('calendar-sync').cron, '*/20 * * * *');
  assert.equal(j.get('calendar-sync').maxLagMs, null, 'a late calendar sync is as good as an on-time one');
  assert.equal(j.get('calendar-sync').maxAttempts, 2);
  assert.equal(j.get('source-staleness').cron, '*/5 * * * *');
  assert.equal(j.get('ambient-pass').cron, '*/40 * * * *');
  assert.equal(j.get('ambient-pass').maxLagMs, 15 * MIN, 'a moment that has gone is not replayed');
  assert.equal(j.get('ambient-pass').maxAttempts, 1);
  for (const job of j.values()) assert.equal(job.catchUp, 'latest');
});

test('the scheduler wraps every node-cron job with in-process recovery', () => {
  const src = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8');
  assert.match(src, /recoverMissedExecutions: true, \.\.\.opts/);
  // The three durable jobs must not ALSO be on node-cron — that would run them twice.
  assert.doesNotMatch(src, /cron\.schedule\('\*\/20 \* \* \* \*'/);
  assert.doesNotMatch(src, /cron\.schedule\('\*\/40 \* \* \* \*'/);
  assert.doesNotMatch(src, /checkStaleness\(\)\s*\n\s*\/\/ Build 2B/);
  // Build 4: the Microsoft Tasks sync and the capture drain moved too.
  assert.doesNotMatch(src, /cron\.schedule\('15,45 8-18 \* \* 1-5'/);
  assert.ok(!src.includes("cron.schedule('*/10 * * * *', () => {\n    try {\n      const result = require('./task-capture-drain')"),
    'the capture drain must not also be on node-cron');
  // Positive control: the same scan does see the durable definitions.
  assert.ok(src.includes("name: 'capture-drain'") && src.includes("name: 'ms-tasks-sync'"));
});
