'use strict';

/**
 * Build 4 runtime migrations — the capture drain and the Microsoft Tasks sync
 * no longer depend on a node-cron timer landing inside the right second.
 *
 *   run: node --test backend/services/build4-runtime.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b4rt-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'rt.db');

// The jobs' bodies are stubbed: this is about WHEN they run, not what they do.
const calls = { drain: 0, ms: 0 };
const stub = (mod, exports) => {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('./task-capture-drain', { drainCaptureFile: () => { calls.drain += 1; return { created: 0, folded: 0 }; } });
let msResult = { ok: true };
stub('./obsidian', { syncMicrosoftTasks: async () => { calls.ms += 1; return msResult; } });

const db = require('../db/database');
const runtime = require('./runtime-jobs');

test.before(async () => { await db.init(); runtime._reset(); require('./scheduler').registerDurableJobs(); });

const at = (d, h, m, s = 0) => new Date(2026, 9, d, h, m, s).getTime(); // October 2026, local
const rows = (job) => db.all('SELECT * FROM runtime_job_runs WHERE job = ? ORDER BY scheduled_for', [job]);

test('22. capture drain: slots missed while the process was down are caught up ONCE on restart (newest only)', async () => {
  await runtime.tick({ now: at(5, 10, 0, 5) }); // 10:00 runs
  assert.equal(calls.drain, 1);
  // Down from 10:01 to 10:35 — the 10:10, 10:20 and 10:30 timers never fire.
  await runtime.tick({ now: at(5, 10, 35) });
  assert.equal(calls.drain, 2, 'the restart runs the missed work once, not three times');
  const r = rows('capture-drain');
  assert.deepEqual(r.map((x) => x.status), ['succeeded', 'skipped', 'skipped', 'succeeded']);
  assert.ok(r.filter((x) => x.status === 'skipped').every((x) => x.skip_reason === 'superseded'));
  assert.equal(r[r.length - 1].scheduled_for.slice(11, 16), new Date(at(5, 10, 30)).toISOString().slice(11, 16), 'it ran the 10:30 SLOT, not "now"');
});

test('22b. Microsoft Tasks sync: a Graph outage is a recorded failure, retried once — never silent', async () => {
  msResult = { ok: false, skipped: true, reason: 'graph-unavailable' };
  const before = calls.ms;
  await runtime.tick({ now: at(5, 11, 15, 5) }); // a Monday-to-Friday 8-18 slot
  await runtime.tick({ now: at(5, 11, 17, 30) }); // after the 2-minute back-off
  assert.equal(calls.ms - before, 2, 'one attempt plus one retry');
  const last = rows('ms-tasks-sync').pop();
  assert.equal(last.status, 'failed');
  assert.ok(db.all(`SELECT * FROM event_log WHERE type = 'runtime.job.failed' AND subject_id = 'ms-tasks-sync'`).length >= 1,
    'a run that failed for good is in the immutable log');
  // "refusing to empty the mirror" is a correct decision, not a failure.
  msResult = { ok: false, skipped: true, reason: 'refusing-to-empty' };
  await runtime.tick({ now: at(5, 11, 45, 5) });
  assert.equal(rows('ms-tasks-sync').pop().status, 'succeeded');
});

test('22c. the Microsoft Tasks sync keeps its working-hours schedule (no weekend runs)', async () => {
  msResult = { ok: true };
  // The first Saturday tick catches up Friday's 18:45 slot (inside the 24h
  // lookback) — late, never lost. After that, a Saturday has no slots.
  await runtime.tick({ now: at(10, 11, 15, 5) }); // Saturday 10 Oct
  assert.equal(rows('ms-tasks-sync').pop().scheduled_for, new Date(at(9, 18, 45)).toISOString());
  const before = calls.ms;
  await runtime.tick({ now: at(10, 11, 45, 5) });
  await runtime.tick({ now: at(10, 15, 15, 5) });
  assert.equal(calls.ms, before, 'no weekend slot exists to run');
});
