'use strict';

/**
 * Durable scheduled runs (Build 3A, 3 Oct 2026).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * node-cron 3.0.3 runs a one-second setTimeout per task and fires the task only
 * if that timer lands INSIDE the matching second (`recoverMissedExecutions` is
 * off by default). Dozens of NEURO jobs share the :00 / :20 / :40 minutes and
 * several do seconds of synchronous SQLite or vault work, so on a busy minute
 * the later timers wake a second late and the tick is simply gone — no error,
 * no log line. Measured on pi5 the night after Build 2 shipped: 9 of 50
 * calendar syncs never ran (18%), the misses clustered on exactly those
 * minutes, and one gap reached the 60-minute stale threshold.
 *
 * ── The model ───────────────────────────────────────────────────────────────
 *
 * A job's due slots are COMPUTED FROM THE CLOCK, never from "a timer fired":
 *
 *   tick()  1. materialise — every slot between the job's newest row and now
 *              becomes a `runtime_job_runs` row (INSERT OR IGNORE on a
 *              deterministic run id, so two ticks cannot make two rows)
 *           2. recover — a `running` row claimed by a process that no longer
 *              exists, or past its timeout, is a failed attempt
 *           3. policy — older pending slots superseded (`catchUp: 'latest'`),
 *              slots past `maxLagMs` skipped as stale
 *           4. claim — one conditional UPDATE, pending → running, with a fresh
 *              claim token; overlap is refused while the job has a live run
 *           5. run, then record succeeded / failed / retry — guarded on the
 *              claim token, so a late finish from a timed-out attempt changes
 *              nothing
 *
 * The tick is a plain setInterval. If the loop is blocked it fires LATE, never
 * not at all, and because slots come from the clock a late tick still finds
 * every slot that fell due. node-cron is not involved.
 *
 * ── What it deliberately is not ─────────────────────────────────────────────
 *
 * Not a second process and not event sourcing. `runtime_job_runs` is mutable
 * operational state, like `event_consumers`. Only the two outcomes worth an
 * immutable record go into the event log — a run that FAILED for good and a run
 * that was SKIPPED without running (stale, or a gap too long to materialise).
 * Routine successes do not: ~400 a day of "the timer worked" in an undeletable
 * log is noise, and this table already answers it.
 *
 * Only jobs that have been audited onto it run here (see scheduler.js). Every
 * other job keeps node-cron, with in-process recovery switched on.
 */

const crypto = require('crypto');
const db = require('../db/database');

// node-cron's own matcher: the SAME expression semantics as every other job in
// scheduler.js, rather than a second cron parser that could disagree with it.
const TimeMatcher = require('node-cron/src/time-matcher');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DEFAULT_TICK_MS = 15 * 1000;
const DEFAULT_LOOKBACK_MS = 24 * HOUR;
const DEFAULT_TIMEOUT_MS = 10 * MINUTE;
const RETAIN_MS = 14 * 24 * HOUR;
const PRUNE_EVERY_MS = HOUR;
const MAX_RESULT_CHARS = 2000;
const CLASSES = ['correctness-critical', 'freshness-sensitive', 'best-effort', 'expensive'];

let bootId = crypto.randomUUID();
const jobs = new Map();
const inFlight = new Map(); // job → Promise of the run this process is executing

let timer = null;
let started = false;
let lastTickAt = null;
let lastPruneAt = 0;
let tickMs = DEFAULT_TICK_MS;

const iso = (ms) => new Date(ms).toISOString();
const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now());

// ── definitions ─────────────────────────────────────────────────────────────

/**
 * Register a job.
 *
 *   name        stable id — it is the prefix of every run id, so renaming one
 *               is a new job with no history
 *   cron        a 5-field expression, read by node-cron's matcher (local time)
 *   run(ctx)    the work. ctx = { runId, job, scheduledFor, startedAt, attempt,
 *               lagMs }. `scheduledFor` is the SLOT, never the restart time.
 *   class       correctness-critical | freshness-sensitive | best-effort | expensive
 *   catchUp     'latest' — of several due slots run only the newest, the rest
 *                          are superseded (current-state jobs: a sync, a check)
 *               'all'    — run every due slot, oldest first
 *   maxLagMs    a slot older than this when it would start is SKIPPED as
 *               stale, not run late. null = never too late.
 *   maxAttempts attempts per slot (1 = no retry)
 *   backoffMs   delay before attempt n+1, indexed by attempts so far
 *   timeoutMs   a run still going after this is failed and the job released
 *   lookbackMs  how far back a restart materialises missed slots
 *
 * Overlap is always 'forbid': a job never has two live runs.
 */
function defineJob(def) {
  if (!def || typeof def.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.name)) {
    throw new Error('runtime job needs a lower-case kebab name');
  }
  if (typeof def.run !== 'function') throw new Error(`runtime job ${def.name} needs run()`);
  if (!CLASSES.includes(def.class)) throw new Error(`runtime job ${def.name} needs a class (${CLASSES.join('|')})`);
  const catchUp = def.catchUp || 'latest';
  if (!['latest', 'all'].includes(catchUp)) throw new Error(`runtime job ${def.name}: catchUp must be latest|all`);
  const matcher = new TimeMatcher(def.cron); // throws on a bad expression
  const job = Object.freeze({
    name: def.name,
    cron: def.cron,
    class: def.class,
    run: def.run,
    catchUp,
    maxLagMs: Number.isFinite(def.maxLagMs) ? def.maxLagMs : null,
    maxAttempts: Number.isInteger(def.maxAttempts) && def.maxAttempts > 0 ? def.maxAttempts : 1,
    backoffMs: Array.isArray(def.backoffMs) && def.backoffMs.length ? def.backoffMs : [MINUTE],
    timeoutMs: Number.isFinite(def.timeoutMs) ? def.timeoutMs : DEFAULT_TIMEOUT_MS,
    lookbackMs: Number.isFinite(def.lookbackMs) ? def.lookbackMs : DEFAULT_LOOKBACK_MS,
    overlap: 'forbid',
    why: def.why || null,
    matcher,
  });
  jobs.set(job.name, job);
  return job;
}

// ── slots ───────────────────────────────────────────────────────────────────

function _floorMinute(ms) { return Math.floor(ms / MINUTE) * MINUTE; }

/** Every matching minute in (afterMs, uptoMs]. PURE apart from the matcher. */
function slotsBetween(job, afterMs, uptoMs) {
  const out = [];
  for (let t = _floorMinute(afterMs) + MINUTE; t <= uptoMs; t += MINUTE) {
    if (job.matcher.match(new Date(t))) out.push(t);
  }
  return out;
}

/** The newest matching minute at or before `ms`, looking back at most `withinMs`. */
function latestSlot(job, ms, withinMs) {
  for (let t = _floorMinute(ms); t >= ms - withinMs; t -= MINUTE) {
    if (job.matcher.match(new Date(t))) return t;
  }
  return null;
}

/** The next matching minute after `ms` (bounded at 8 days). */
function nextSlot(job, ms) {
  const limit = ms + 8 * 24 * HOUR;
  for (let t = _floorMinute(ms) + MINUTE; t <= limit; t += MINUTE) {
    if (job.matcher.match(new Date(t))) return t;
  }
  return null;
}

const runIdFor = (job, slotMs) => `${job}@${iso(slotMs)}`;

function _insertSlot(job, slotMs, nowMs, extra = {}) {
  return db.run(
    `INSERT OR IGNORE INTO runtime_job_runs (run_id, job, scheduled_for, status, attempts, next_attempt_at,
       skip_reason, error, finished_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [runIdFor(job.name, slotMs), job.name, iso(slotMs), extra.status || 'pending', iso(slotMs),
      extra.skipReason || null, extra.error || null, extra.status === 'skipped' ? iso(nowMs) : null, iso(nowMs)]
  ).changes;
}

/**
 * Make every due slot a row. Returns how many were created.
 *
 * ⚠ A GAP LONGER THAN THE LOOKBACK IS NOT SILENT. Materialising a week of
 * five-minute slots after a long outage would be thousands of rows that the
 * catch-up policy immediately supersedes; instead the first missing slot is
 * written as ONE `skipped` row with reason `gap` and the count, so "it did not
 * run for nine days" is still on record.
 */
function materialise(job, nowMs) {
  const newest = db.get('SELECT MAX(scheduled_for) AS s FROM runtime_job_runs WHERE job = ?', [job.name]).s;
  if (!newest) {
    // First time this job has ever been seen: there is no history to have
    // missed. Only the slot that is due now (if any, within one lookback).
    const t = latestSlot(job, nowMs, job.lookbackMs);
    return t === null ? 0 : _insertSlot(job, t, nowMs);
  }
  const after = Date.parse(newest);
  let created = 0;
  let from = after;
  if (nowMs - after > job.lookbackMs) {
    from = nowMs - job.lookbackMs;
    const lost = slotsBetween(job, after, from);
    if (lost.length) {
      created += _insertSlot(job, lost[0], nowMs, {
        status: 'skipped', skipReason: 'gap',
        error: `${lost.length} slot(s) between ${iso(lost[0])} and ${iso(lost[lost.length - 1])} fell outside the ${Math.round(job.lookbackMs / HOUR)}h lookback`,
      });
      _publish('runtime.job.skipped', job, runIdFor(job.name, lost[0]), lost[0], nowMs,
        { reason: 'gap', missedSlots: lost.length, lastMissedFor: iso(lost[lost.length - 1]) });
    }
  }
  for (const t of slotsBetween(job, from, nowMs)) created += _insertSlot(job, t, nowMs);
  return created;
}

// ── events (the two outcomes worth an immutable record) ─────────────────────

function _publish(type, job, runId, slotMs, nowMs, extra) {
  try {
    require('./event-bus').publishEvent({
      type,
      occurredAt: iso(nowMs),
      source: { system: 'neuro', recordId: runId },
      subject: { entityType: 'runtime-job', entityId: job.name },
      idempotencyKey: `${type}:${runId}`,
      payload: { job: job.name, runId, scheduledFor: iso(slotMs), class: job.class, ...extra },
    }, { now: nowMs });
  } catch (e) {
    console.warn(`[Runtime] could not record ${type} for ${runId}: ${e.message}`);
  }
}

// ── outcomes ────────────────────────────────────────────────────────────────

/**
 * An attempt failed (threw, timed out, or was interrupted by a restart). Retry
 * if attempts remain, otherwise terminal. Guarded on the claim token: an
 * outcome for an attempt that is no longer current changes nothing.
 */
function _attemptFailed(job, row, error, nowMs) {
  const message = String(error && error.message ? error.message : error).slice(0, 500);
  if (row.attempts < job.maxAttempts) {
    const delay = job.backoffMs[Math.min(row.attempts - 1, job.backoffMs.length - 1)];
    const r = db.run(
      `UPDATE runtime_job_runs SET status = 'pending', next_attempt_at = ?, error = ?, claim_token = NULL,
         finished_at = ?, duration_ms = ? WHERE run_id = ? AND status = 'running' AND claim_token = ?`,
      [iso(nowMs + delay), message, iso(nowMs), row.started_at ? nowMs - Date.parse(row.started_at) : null,
        row.run_id, row.claim_token]
    );
    if (r.changes) console.warn(`[Runtime] ${row.run_id} attempt ${row.attempts}/${job.maxAttempts} failed — retry in ${Math.round(delay / 1000)}s: ${message}`);
    return r.changes ? 'retry' : null;
  }
  const r = db.run(
    `UPDATE runtime_job_runs SET status = 'failed', error = ?, finished_at = ?, duration_ms = ?
     WHERE run_id = ? AND status = 'running' AND claim_token = ?`,
    [message, iso(nowMs), row.started_at ? nowMs - Date.parse(row.started_at) : null, row.run_id, row.claim_token]
  );
  if (r.changes) {
    console.error(`[Runtime] ${row.run_id} FAILED after ${row.attempts} attempt(s): ${message}`);
    _publish('runtime.job.failed', job, row.run_id, Date.parse(row.scheduled_for), nowMs,
      { attempts: row.attempts, error: message });
  }
  return r.changes ? 'failed' : null;
}

/** Live runs for a job; ones that can no longer be live are failed first. */
function _recover(job, nowMs) {
  const live = [];
  for (const row of db.all(`SELECT * FROM runtime_job_runs WHERE job = ? AND status = 'running'`, [job.name])) {
    if (row.owner !== bootId) {
      // Claimed by a process that has since gone — a restart mid-run.
      _attemptFailed(job, row, 'interrupted: the process that was running it restarted', nowMs);
    } else if (nowMs - Date.parse(row.started_at) > job.timeoutMs) {
      _attemptFailed(job, row, `timed out after ${Math.round(job.timeoutMs / 1000)}s`, nowMs);
    } else {
      live.push(row);
    }
  }
  return live;
}

function _skip(row, reason, detail, nowMs) {
  return db.run(
    `UPDATE runtime_job_runs SET status = 'skipped', skip_reason = ?, error = ?, finished_at = ?
     WHERE run_id = ? AND status = 'pending'`,
    [reason, detail, iso(nowMs), row.run_id]
  ).changes;
}

/** Apply the catch-up and staleness policy; return the rows still runnable. */
function _applyPolicy(job, nowMs) {
  let due = db.all(
    `SELECT * FROM runtime_job_runs WHERE job = ? AND status = 'pending' AND next_attempt_at <= ?
     ORDER BY scheduled_for`, [job.name, iso(nowMs)]
  );
  if (job.catchUp === 'latest' && due.length > 1) {
    const newest = due[due.length - 1];
    for (const r of due.slice(0, -1)) _skip(r, 'superseded', `covered by ${newest.run_id}`, nowMs);
    due = [newest];
  }
  const runnable = [];
  for (const r of due) {
    const lag = nowMs - Date.parse(r.scheduled_for);
    if (job.maxLagMs !== null && lag > job.maxLagMs) {
      if (_skip(r, 'stale', `would have started ${Math.round(lag / 1000)}s late (limit ${Math.round(job.maxLagMs / 1000)}s)`, nowMs)) {
        _publish('runtime.job.skipped', job, r.run_id, Date.parse(r.scheduled_for), nowMs,
          { reason: 'stale', lagMs: lag, maxLagMs: job.maxLagMs });
      }
      continue;
    }
    runnable.push(r);
  }
  return runnable;
}

function _claim(row, nowMs) {
  const token = crypto.randomUUID();
  const lag = nowMs - Date.parse(row.scheduled_for);
  const r = db.run(
    `UPDATE runtime_job_runs SET status = 'running', attempts = attempts + 1, claim_token = ?, owner = ?,
       started_at = ?, first_started_at = COALESCE(first_started_at, ?), lag_ms = COALESCE(lag_ms, ?),
       finished_at = NULL WHERE run_id = ? AND status = 'pending'`,
    [token, bootId, iso(nowMs), iso(nowMs), lag, row.run_id]
  );
  if (r.changes !== 1) return null;
  return db.get('SELECT * FROM runtime_job_runs WHERE run_id = ?', [row.run_id]);
}

async function _execute(job, row, clock) {
  const startedMs = Date.parse(row.started_at);
  const ctx = Object.freeze({
    runId: row.run_id,
    job: job.name,
    scheduledFor: new Date(Date.parse(row.scheduled_for)),
    startedAt: new Date(startedMs),
    attempt: row.attempts,
    lagMs: startedMs - Date.parse(row.scheduled_for),
  });
  let timeoutHandle = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => job.run(ctx)),
      new Promise((_, reject) => {
        // Deliberately NOT unref'd: a run in flight is real work, and the timer
        // is cleared in `finally` the moment the run ends, so it can never hold
        // the process past one. (Unref'd, a hung run with nothing else on the
        // loop let node exit mid-run — caught by the suite on the Pi.)
        timeoutHandle = setTimeout(() => reject(new Error(`timed out after ${Math.round(job.timeoutMs / 1000)}s`)), job.timeoutMs);
      }),
    ]);
    const endMs = clock();
    let json = null;
    try { json = result === undefined ? null : JSON.stringify(result).slice(0, MAX_RESULT_CHARS); } catch { json = null; }
    db.run(
      `UPDATE runtime_job_runs SET status = 'succeeded', finished_at = ?, duration_ms = ?, result_json = ?, error = NULL
       WHERE run_id = ? AND status = 'running' AND claim_token = ?`,
      [iso(endMs), endMs - startedMs, json, row.run_id, row.claim_token]
    );
    return 'succeeded';
  } catch (e) {
    return _attemptFailed(job, row, e, clock()) || 'superseded-attempt';
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Run everything runnable for ONE job, sequentially. Never throws. */
async function _runJob(job, nowMs, clock) {
  const outcomes = [];
  try {
    materialise(job, nowMs);
    const live = _recover(job, nowMs);
    if (live.length || inFlight.has(job.name)) return outcomes; // overlap: forbidden
    for (const row of _applyPolicy(job, nowMs)) {
      const claimed = _claim(row, clock());
      if (!claimed) continue; // somebody else took it, or it is no longer pending
      outcomes.push({ runId: claimed.run_id, outcome: await _execute(job, claimed, clock) });
    }
  } catch (e) {
    // A bookkeeping failure for one job must not stop any other.
    console.error(`[Runtime] ${job.name}: ${e.message}`);
    outcomes.push({ runId: null, outcome: 'error', error: e.message });
  }
  return outcomes;
}

/**
 * One pass over every job. Jobs run concurrently with each other and never
 * overlap with themselves. Resolves when every run started in this pass ends.
 *
 * `now` is injectable for tests; production passes nothing and reads the clock.
 */
async function tick({ now = null } = {}) {
  const fixed = now === null ? null : msOf(now);
  const clock = () => (fixed === null ? Date.now() : fixed);
  const nowMs = clock();
  lastTickAt = iso(nowMs);
  if (nowMs - lastPruneAt > PRUNE_EVERY_MS) {
    lastPruneAt = nowMs;
    try {
      db.run(`DELETE FROM runtime_job_runs WHERE status IN ('succeeded', 'skipped', 'failed') AND finished_at < ?`,
        [iso(nowMs - RETAIN_MS)]);
    } catch (e) { console.warn('[Runtime] prune failed:', e.message); }
  }
  const results = {};
  await Promise.all([...jobs.values()].map(async (job) => {
    if (inFlight.has(job.name)) { results[job.name] = []; return; }
    const p = _runJob(job, nowMs, clock);
    inFlight.set(job.name, p);
    try { results[job.name] = await p; } finally { inFlight.delete(job.name); }
  }));
  return results;
}

/**
 * Build 15L: run ONE named job's function now, outside its schedule, for a
 * self-heal retry. It shares the in-flight guard, so it can never overlap the
 * scheduled run (and a scheduled tick waits for it), and it writes NO
 * runtime_job_runs row — an off-schedule run must not move MAX(scheduled_for),
 * or the next due slot would never be materialised.
 * @returns {{ ok:boolean, busy?:true, result?, error? }}
 */
async function runNow(name, { timeoutMs = null } = {}) {
  const job = jobs.get(name);
  if (!job) return { ok: false, error: `no such durable job: ${name}` };
  if (inFlight.has(name)) return { ok: false, busy: true, error: `${name} is already running` };
  const limit = timeoutMs || job.timeoutMs;
  let t;
  const p = Promise.race([
    Promise.resolve().then(() => job.run()),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${Math.round(limit / 1000)}s`)), limit); }),
  ]).finally(() => clearTimeout(t));
  inFlight.set(name, p);
  try {
    return { ok: true, result: await p };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, MAX_RESULT_CHARS) };
  } finally {
    inFlight.delete(name);
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function start({ intervalMs = DEFAULT_TICK_MS } = {}) {
  if (started) return;
  started = true;
  tickMs = intervalMs;
  const fire = () => tick().catch(e => console.error('[Runtime] tick failed:', e.message));
  timer = setInterval(fire, intervalMs);
  if (timer.unref) timer.unref();
  setImmediate(fire);
  console.log(`[Runtime] started — ${jobs.size} durable job(s) (${[...jobs.keys()].join(', ')}), tick every ${Math.round(intervalMs / 1000)}s`);
}

function stop() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

// ── status ──────────────────────────────────────────────────────────────────

function _percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Per-job picture: what is due, running, overdue, what ran and how late.
 * `overdue` = pending past its slot by more than two ticks plus a minute —
 * a row the runtime should already have claimed.
 */
function status({ now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const since = iso(nowMs - 24 * HOUR);
  const overdueBefore = iso(nowMs - (2 * tickMs + MINUTE));
  const out = [];
  for (const job of jobs.values()) {
    const counts = {};
    for (const r of db.all(`SELECT status, COUNT(*) AS n FROM runtime_job_runs WHERE job = ? AND scheduled_for >= ? GROUP BY status`, [job.name, since])) counts[r.status] = r.n;
    const skipped = {};
    for (const r of db.all(`SELECT skip_reason, COUNT(*) AS n FROM runtime_job_runs WHERE job = ? AND status = 'skipped' AND scheduled_for >= ? GROUP BY skip_reason`, [job.name, since])) skipped[r.skip_reason] = r.n;
    const lags = db.all(`SELECT lag_ms FROM runtime_job_runs WHERE job = ? AND lag_ms IS NOT NULL AND scheduled_for >= ? ORDER BY lag_ms`, [job.name, since]).map(r => r.lag_ms);
    const lastScheduled = db.get(`SELECT * FROM runtime_job_runs WHERE job = ? ORDER BY scheduled_for DESC LIMIT 1`, [job.name]);
    const lastStarted = db.get(`SELECT * FROM runtime_job_runs WHERE job = ? AND started_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`, [job.name]);
    const lastSuccess = db.get(`SELECT * FROM runtime_job_runs WHERE job = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`, [job.name]);
    const lastFailure = db.get(`SELECT * FROM runtime_job_runs WHERE job = ? AND status = 'failed' ORDER BY finished_at DESC LIMIT 1`, [job.name]);
    const overdue = db.get(`SELECT COUNT(*) AS n FROM runtime_job_runs WHERE job = ? AND status = 'pending' AND next_attempt_at < ?`, [job.name, overdueBefore]).n;
    const next = nextSlot(job, nowMs);
    out.push({
      name: job.name,
      class: job.class,
      cron: job.cron,
      policy: {
        catchUp: job.catchUp, maxLagMs: job.maxLagMs, maxAttempts: job.maxAttempts,
        timeoutMs: job.timeoutMs, overlap: job.overlap,
      },
      last24h: {
        due: Object.values(counts).reduce((a, b) => a + b, 0),
        succeeded: counts.succeeded || 0,
        failed: counts.failed || 0,
        skipped: counts.skipped || 0,
        skippedBy: skipped,
        pending: counts.pending || 0,
        running: counts.running || 0,
        lagMedianMs: _percentile(lags, 0.5),
        lagP95Ms: _percentile(lags, 0.95),
        lagMaxMs: lags.length ? lags[lags.length - 1] : null,
      },
      overdue,
      running: !!inFlight.get(job.name),
      lastScheduledFor: lastScheduled ? lastScheduled.scheduled_for : null,
      lastActualStart: lastStarted ? lastStarted.started_at : null,
      lastLagMs: lastStarted ? lastStarted.lag_ms : null,
      lastSuccessAt: lastSuccess ? lastSuccess.finished_at : null,
      lastDurationMs: lastSuccess ? lastSuccess.duration_ms : null,
      lastFailureAt: lastFailure ? lastFailure.finished_at : null,
      lastError: lastFailure ? lastFailure.error : null,
      nextScheduledFor: next === null ? null : iso(next),
    });
  }
  return { started, bootId, tickMs, lastTickAt, jobs: out };
}

/** Recent runs of one job, newest first — the audit trail. */
function runs(job, { limit = 50 } = {}) {
  return db.all(`SELECT run_id, job, scheduled_for, status, attempts, first_started_at, started_at, finished_at,
      duration_ms, lag_ms, skip_reason, error FROM runtime_job_runs WHERE job = ? ORDER BY scheduled_for DESC LIMIT ?`,
  [job, Math.max(1, Math.min(500, limit))]);
}

module.exports = {
  CLASSES,
  defineJob,
  tick,
  runNow,
  start,
  stop,
  status,
  runs,
  // exported for tests
  slotsBetween,
  latestSlot,
  nextSlot,
  materialise,
  runIdFor,
  _claim: (row, now) => _claim(row, msOf(now)),
  _jobs: jobs,
  _setBootId: (id) => { bootId = id; },
  _bootId: () => bootId,
  _reset: () => { jobs.clear(); inFlight.clear(); lastPruneAt = 0; },
};
