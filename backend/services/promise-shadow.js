'use strict';

/**
 * Meeting promises — the LOG-ONLY shadow (18 Oct 2026).
 *
 * Runs inside the production backend, on production's real canonical decision,
 * and writes down what the promise gate WOULD have done. It shows nothing and
 * sends nothing.
 *
 *   • OFF unless PROMISE_SHADOW_ENABLED is exactly 'true'. Off means: no table,
 *     no schema change, no timer, no read (registerPromiseShadow returns at once).
 *   • Enabling creates promise_shadow_log (ensureLog) — the ONLY thing it ever
 *     writes — and schedules a plain cron (cron-once; no runtime-jobs, which
 *     would write runtime_job_runs and event_log).
 *   • Each pass reads canonical Now with { readOnly: true }: attention.build
 *     filters deferrals by time without releasing them, reads lifecycle records
 *     with peek, and rooms does not save the visit — no production write.
 *   • Every row carries the build it ran under: the resolved commit, dirty
 *     state, a hash of the loaded decision-path code, and whether the checkout
 *     has moved since the process started.
 *   • An employment matter is logged as task ids and a rule category only.
 *   • Context unknown → silent, with the reason logged.
 * Pinned by promise-shadow.test.js (empty diffs, source scans) and
 * promise-shadow-parity.test.js (two processes, two identical frozen copies).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db = require('../db/database');
const policy = require('../../saim/policy/promises.cjs');
const observe = require('./promise-observe');

const TABLE = 'promise_shadow_log';
const SHADOW_DAYS = 14;
const LABELS = Object.freeze(['tp', 'fp', 'unsure']);
const CRON = '*/5 7-18 * * 1-5';
const TZ = 'Europe/London';
const REPO_DIR = path.join(__dirname, '..', '..');
const HOUR = 3600000;

// The decision path whose loaded code identifies a build (codeHash).
const CODE_FILES = Object.freeze([
  './canonical-read', './attention', './attention-lifecycle', './rooms', './neuro-candidates',
  '../../saim/policy/attention-policy.cjs', '../../saim/policy/promises.cjs',
  './promise-observe', './promise-ledger', './promise-shadow',
]);

const LOG_DDL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  moment        TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('proposal', 'prompt', 'routing', 'suppression', 'snapshot', 'heartbeat', 'missed')),
  decision      TEXT NOT NULL,
  promise_key   TEXT,
  reason        TEXT,
  payload_json  TEXT,
  build_json    TEXT,
  label         TEXT CHECK (label IS NULL OR label IN ('tp', 'fp', 'unsure')),
  label_note    TEXT,
  labelled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_promise_shadow_at ON ${TABLE}(at);
CREATE INDEX IF NOT EXISTS idx_promise_shadow_moment ON ${TABLE}(moment, kind);
CREATE TRIGGER IF NOT EXISTS promise_shadow_log_append_only BEFORE UPDATE ON ${TABLE}
  WHEN NEW.at IS NOT OLD.at OR NEW.moment IS NOT OLD.moment OR NEW.kind IS NOT OLD.kind OR NEW.decision IS NOT OLD.decision
    OR NEW.promise_key IS NOT OLD.promise_key OR NEW.reason IS NOT OLD.reason OR NEW.payload_json IS NOT OLD.payload_json
    OR NEW.build_json IS NOT OLD.build_json
BEGIN SELECT RAISE(ABORT, 'a shadow log row is a record of what happened; only its review label may change'); END;
`;

const iso = (ms) => new Date(ms).toISOString();
const msOf = (now) => (typeof now === 'number' ? now : Date.parse(now));
const local = (ms) => {
  const s = new Date(ms).toLocaleString('sv-SE', { timeZone: TZ });
  return { date: s.slice(0, 10), hour: s.slice(11, 13), weekday: new Date(`${s.slice(0, 10)}T12:00:00Z`).getUTCDay() };
};

// ── The log table: created ONLY by explicit enablement ──────────────────────

/** Does the shadow log exist? Reads sqlite_master; never creates anything. */
function logExists() {
  return Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [TABLE]));
}
/** Create the log. Called only by registerPromiseShadow when enabled (and by tests). */
function ensureLog() { db.getDb().exec(LOG_DDL); }

// ── Build identity ───────────────────────────────────────────────────────────

function _git(args, repoDir) {
  // GIT_OPTIONAL_LOCKS=0: `git status` must never refresh or lock the index.
  return execFileSync('git', args, { cwd: repoDir, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Read once at boot: the commit this process loaded, its dirty state, and a hash of the decision-path code. */
function captureIdentity({ repoDir = REPO_DIR, now = Date.now() } = {}) {
  const id = { runningSha: null, dirty: null, dirtyPaths: [], untrackedCount: null, codeHash: null,
    nodeVersion: process.version, bootedAt: iso(msOf(now)), policyVersion: policy.POLICY_VERSION, errors: [] };
  try { id.runningSha = _git(['rev-parse', 'HEAD'], repoDir); } catch (e) { id.errors.push(`rev-parse: ${e.message.split('\n')[0]}`); }
  try {
    const lines = _git(['status', '--porcelain', '--untracked-files=no'], repoDir).split('\n').filter(Boolean);
    id.dirty = lines.length > 0;
    id.dirtyPaths = lines.slice(0, 20).map((l) => l.slice(3));
  } catch (e) { id.errors.push(`status: ${e.message.split('\n')[0]}`); }
  try { id.untrackedCount = _git(['ls-files', '--others', '--exclude-standard'], repoDir).split('\n').filter(Boolean).length; } catch { id.untrackedCount = null; }
  try {
    const h = crypto.createHash('sha256');
    for (const rel of CODE_FILES) { const f = require.resolve(rel); h.update(`${path.basename(f)}\n`); h.update(fs.readFileSync(f)); }
    id.codeHash = h.digest('hex').slice(0, 16);
  } catch (e) { id.errors.push(`codeHash: ${e.message}`); }
  return id;
}

let _identity = null;
let _checkout = { sha: null, at: 0 };

/** The build stamped on every row: the boot identity plus whether the checkout has moved since. */
function _build(nowMs, repoDir = REPO_DIR) {
  if (!_identity) _identity = captureIdentity({ repoDir, now: nowMs });
  if (!_checkout.at || nowMs - _checkout.at >= HOUR) {
    let sha = null; try { sha = _git(['rev-parse', 'HEAD'], repoDir); } catch { sha = null; }
    _checkout = { sha, at: nowMs };
  }
  return { ..._identity, checkoutSha: _checkout.sha, stale: Boolean(_identity.runningSha && _checkout.sha && _checkout.sha !== _identity.runningSha) };
}

// ── Logging ──────────────────────────────────────────────────────────────────

function _log(row, build) {
  db.run(`INSERT INTO ${TABLE} (at, moment, kind, decision, promise_key, reason, payload_json, build_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.at, row.moment, row.kind, row.decision, row.promiseKey || null, row.reason || null, row.payload ? JSON.stringify(row.payload) : null, JSON.stringify(build)]);
}
const _seen = (moment) => Boolean(db.get(`SELECT id FROM ${TABLE} WHERE moment = ? LIMIT 1`, [moment]));

// ── Judgement ────────────────────────────────────────────────────────────────

/** PURE. The moments `now` falls in. Employment matters never make a moment (their people are not named). */
function momentsAt(nowMs, promises) {
  const t = local(nowMs);
  const w = policy.windowIndex(nowMs);
  const out = [];
  if (t.weekday === 1 && w === 0) out.push({ type: 'discovery', key: `discovery:${policy.isoWeek(t.date)}` });
  if (w !== null) out.push({ type: 'window', key: `window:${t.date}:${w}` });
  for (const p of promises) {
    const m = p.nextMeeting;
    if (p.sensitive || !m || !m.start || p.closed) continue;
    const startMs = Date.parse(`${m.start}:00Z`) - _offsetMs(m.start);
    const mins = (startMs - nowMs) / 60000;
    if (mins > 0 && mins <= policy.BEFORE_MEETING_MINUTES) out.push({ type: 'meeting', key: `meeting:${p.owedTo.resolved || p.key}@${m.start}`, promiseKey: p.key });
  }
  return [...new Map(out.map((m) => [m.key, m])).values()];
}
function _offsetMs(localYmdHm) {
  const guess = Date.parse(`${localYmdHm}:00Z`);
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T').slice(0, 16);
  return Date.parse(`${shown}:00Z`) - guess;
}

/**
 * The gate, evaluated over production's canonical decision. The shadow assumes
 * the goal is accepted (that is what it shadows) and has prompted nothing before.
 */
function evaluate({ payload, promises, now, proposal = null }) {
  const ctx = payload ? observe.promiseFeedContext(payload, { now }) : null;
  const feed = observe.feedFor({ ctx, promises, now, prompted: [], proposal, goalAccepted: true });
  const gate = policy.sponsorshipGate({ ...policy.gateInputs(payload && payload.saim, payload && payload.candidates), feed });
  return { ctx, feed, gate: { shown: gate.shown, reason: gate.reason, rule: gate.rule }, sponsorship: gate.sponsorship };
}

/**
 * Discovery as the scheduler WOULD run it, over the shadow's own history (a
 * would-be proposal is treated as still waiting for Nick). Writes nothing.
 */
function discoverShadow({ now, ctx, ledger, history }) {
  const v = policy.discover(ledger, { now });
  const base = { verdicts: v.verdicts, occurrences: v.occurrences, proposal: v.proposal };
  if (!v.qualifies) return { ...base, would: false, why: 'the evidence does not clear the bar' };
  if (history.some((h) => h.status === 'open')) return { ...base, would: false, why: 'already raised and waiting for you' };
  const gate = policy.mayRaiseProposal({ now, ctx, history });
  if (!gate.ok) return { ...base, would: false, why: gate.why };
  return { ...base, would: true, why: 'would be raised' };
}

// ── The pass ─────────────────────────────────────────────────────────────────

async function _readNow(nowMs) { return require('./canonical-read').now({ now: nowMs, readOnly: true }); }

/** One shadow pass. Writes only promise_shadow_log; does nothing if the log was never created. */
async function tick({ now = Date.now(), readNow = _readNow, repoDir = REPO_DIR } = {}) {
  const nowMs = msOf(now);
  if (!logExists()) return { disabled: true, logged: 0 };
  const build = _build(nowMs, repoDir);
  const at = iso(nowMs);
  let logged = 0;
  const log = (row) => { _log({ at, ...row }, build); logged += 1; };

  const t = local(nowMs);
  const hb = `heartbeat:${t.date}T${t.hour}`;
  if (!_seen(hb)) log({ moment: hb, kind: 'heartbeat', decision: 'alive', reason: build.stale ? 'checkout has moved since boot — rows attributed to the running commit' : 'alive' });

  const snap = observe.snapshot({ now: nowMs }); // reads only
  const moments = momentsAt(nowMs, snap.promises).filter((m) => !_seen(m.key));
  if (!moments.length) return { idle: true, logged };

  let payload = null; let readError = null;
  try { payload = await readNow(nowMs); } catch (e) { readError = String(e && e.message || e).slice(0, 200); }
  const common = (ev) => ({
    gate: ev.gate, ctx: ev.ctx, contextUnknown: !ev.ctx, feedWhy: ev.feed.why,
    read: readError ? { ok: false, error: readError } : { ok: Boolean(payload), rule: payload && payload.saim && payload.saim.lead ? payload.saim.lead.rule : null },
    assumedAccepted: true,
  });

  // Once a day: the routing-only list (task ids + rule category ONLY) and the evidence judged on.
  const dayKey = `day:${t.date}`;
  if (!_seen(dayKey)) {
    for (const p of snap.promises.filter((x) => x.sensitive)) {
      log({ moment: dayKey, kind: 'routing', decision: 'routed', promiseKey: p.key, reason: 'employment matter — routing note only',
        payload: { taskIds: p.taskIds, rule: p.sensitiveRule } });
    }
    log({ moment: dayKey, kind: 'snapshot', decision: 'observed', reason: `${snap.promises.length} promises read`,
      payload: {
        readAt: snap.readAt, gaps: snap.gaps,
        counts: snap.promises.reduce((o, p) => { o[p.judgement.state] = (o[p.judgement.state] || 0) + 1; return o; }, {}),
        routingOnly: snap.promises.filter((p) => p.sensitive).length,
        candidates: snap.promises.filter((p) => !p.sensitive && ['late', 'slipped', 'ticked-no-evidence'].includes(p.judgement.state))
          .map((p) => ({ key: p.key, state: p.judgement.state, date: p.judgement.date || null, dueMoves: p.slips.dueMoves, lapsedBlocks: p.slips.lapsedBlocks })),
      } });
  }

  for (const m of moments) {
    if (m.type === 'discovery') {
      const ev0 = evaluate({ payload, promises: snap.promises, now: nowMs });
      if (!ev0.ctx) { log({ moment: m.key, kind: 'suppression', decision: 'suppressed', reason: `discovery: context unknown — staying quiet (${ev0.gate.reason})`, payload: common(ev0) }); continue; }
      const history = db.all(`SELECT at FROM ${TABLE} WHERE kind = 'proposal' AND decision = 'would-raise' ORDER BY id`)
        .map((r) => ({ status: 'open', raisedAt: r.at, fingerprint: policy.PROPOSAL_FINGERPRINT }));
      const r = discoverShadow({ now: nowMs, ctx: ev0.ctx, ledger: snap.ledger, history });
      const ev = evaluate({ payload, promises: snap.promises, now: nowMs,
        proposal: r.would ? { id: 'shadow', status: 'open', title: r.proposal.title, whyNow: r.proposal.whyNow } : null });
      log({ moment: m.key, kind: 'proposal', decision: r.would ? 'would-raise' : 'suppressed', reason: r.why,
        payload: { ...common(ev), verdicts: r.verdicts, occurrences: r.occurrences,
          proposal: r.proposal ? { title: r.proposal.title, whyNow: r.proposal.whyNow, confidence: r.proposal.confidence, evidence: r.proposal.evidence,
            examples: r.proposal.examples, evidenceHash: r.proposal.evidenceHash } : null } });
      continue;
    }
    const ev = evaluate({ payload, promises: snap.promises, now: nowMs });
    const sp = ev.sponsorship && ev.sponsorship.promise;
    const fits = sp && (m.type !== 'meeting' || ev.feed.meetingKey);
    if (!ev.gate.shown || !fits) {
      const reason = !ev.gate.shown ? ev.gate.reason : 'the prompt at this moment belongs to the bundled window, not this meeting';
      log({ moment: m.key, kind: 'suppression', decision: 'suppressed', promiseKey: m.promiseKey || null, reason, payload: common(ev) });
      continue;
    }
    log({ moment: m.key, kind: 'prompt', decision: 'would-prompt', promiseKey: sp.key, reason: ev.gate.reason,
      payload: { ...common(ev), say: sp.say, state: ev.feed.promise.state, date: ev.feed.promise.date, owedTo: ev.feed.promise.owedTo,
        text: ev.feed.promise.text, moves: ev.feed.promise.moves, moment: m.type } });
  }
  return { idle: false, logged, moments: moments.map((m) => m.key), read: readError ? 'failed' : 'ok' };
}

// ── Enablement: the ONLY way the table or the timer comes into being ────────

/**
 * Off unless env.PROMISE_SHADOW_ENABLED is exactly 'true'. When off: returns at
 * once — no DDL, no read, no timer. When on: creates the log, captures the build
 * identity, and schedules the pass on a plain cron.
 */
function registerPromiseShadow(env = process.env, { schedule = null, repoDir = REPO_DIR, now = Date.now() } = {}) {
  if (!env || env.PROMISE_SHADOW_ENABLED !== 'true') return { enabled: false };
  ensureLog();
  _identity = captureIdentity({ repoDir, now });
  const sched = schedule || require('./cron-once').createCron(require('node-cron')).schedule;
  const task = sched(CRON, () => tick().catch((e) => console.warn('[PromiseShadow] pass failed:', e.message)), { timezone: TZ });
  console.log(`[PromiseShadow] enabled — logging to ${TABLE} (${CRON}, ${TZ}); build ${_identity.runningSha ? _identity.runningSha.slice(0, 8) : 'unknown'}${_identity.dirty ? ' (dirty)' : ''}`);
  return { enabled: true, task, identity: _identity, cron: CRON };
}

// ── Review (CLI only) ────────────────────────────────────────────────────────

const NEVER = { ok: false, code: 409, error: 'the shadow has never been enabled on this database' };

/** Nick's review label on one shadow row: tp (right call) / fp (wrong call) / unsure. */
function label(id, { label: l, note = null, now = Date.now() } = {}) {
  if (!logExists()) return NEVER;
  if (!LABELS.includes(l)) return { ok: false, code: 400, error: `label must be one of ${LABELS.join(', ')}` };
  const row = db.get(`SELECT id, kind FROM ${TABLE} WHERE id = ?`, [Number(id)]);
  if (!row) return { ok: false, code: 404, error: 'no such shadow entry' };
  if (!['proposal', 'prompt', 'routing', 'suppression'].includes(row.kind)) return { ok: false, code: 409, error: `a ${row.kind} entry is not a decision to label` };
  db.run(`UPDATE ${TABLE} SET label = ?, label_note = ?, labelled_at = ? WHERE id = ?`, [l, note ? String(note).slice(0, 300) : null, iso(msOf(now)), row.id]);
  return { ok: true, id: row.id, label: l };
}

/** A promise Nick found that the shadow never raised. */
function missed({ taskId = null, text = null, note = null, now = Date.now() } = {}) {
  if (!logExists()) return NEVER;
  const t = text ? String(text).trim().slice(0, 300) : null;
  const id = taskId == null ? null : Number(taskId);
  if (!t && !Number.isInteger(id)) return { ok: false, code: 400, error: 'name the promise (taskId or text)' };
  const n = (db.get(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE kind = 'missed'`) || {}).n || 0;
  _log({ at: iso(msOf(now)), moment: `missed:${n + 1}`, kind: 'missed', decision: 'missed', promiseKey: id ? `task:${id}` : null,
    reason: note ? String(note).slice(0, 300) : null, payload: { taskId: id, text: t } }, _build(msOf(now)));
  return { ok: true };
}

/** The review report for the shadow period (default: the last 14 days). Reads only. */
function report({ days = SHADOW_DAYS, now = Date.now() } = {}) {
  if (!logExists()) return NEVER;
  const nowMs = msOf(now);
  const from = iso(nowMs - days * 86400000);
  const rows = db.all(`SELECT * FROM ${TABLE} WHERE at >= ? ORDER BY id`, [from])
    .map((r) => ({ ...r, payload: r.payload_json ? JSON.parse(r.payload_json) : null, build: r.build_json ? JSON.parse(r.build_json) : null }));
  const of = (k) => rows.filter((r) => r.kind === k);
  const labelled = (list) => ({ total: list.length, tp: list.filter((r) => r.label === 'tp').length, fp: list.filter((r) => r.label === 'fp').length,
    unsure: list.filter((r) => r.label === 'unsure').length, unlabelled: list.filter((r) => !r.label).length });
  const prompts = of('prompt');
  const routedByKey = new Map();
  for (const r of of('routing')) {
    const cur = routedByKey.get(r.promise_key) || { key: r.promise_key, days: 0, label: null, taskIds: r.payload && r.payload.taskIds, rule: r.payload && r.payload.rule };
    cur.days += 1; if (r.label) cur.label = r.label; routedByKey.set(r.promise_key, cur);
  }
  const reasons = {};
  for (const r of of('suppression')) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const builds = {};
  for (const r of rows) {
    const b = r.build || {}; const k = `${b.runningSha || 'unknown'}|${b.codeHash || '?'}`;
    builds[k] = builds[k] || { runningSha: b.runningSha || null, codeHash: b.codeHash || null, rows: 0, dirty: false, stale: false, first: r.at, last: r.at };
    builds[k].rows += 1; builds[k].dirty = builds[k].dirty || Boolean(b.dirty); builds[k].stale = builds[k].stale || Boolean(b.stale); builds[k].last = r.at;
  }
  return {
    ok: true,
    window: { from, to: iso(nowMs), days },
    heartbeats: of('heartbeat').length,
    builds: Object.values(builds),
    proposals: { ...labelled(of('proposal').filter((r) => r.decision === 'would-raise')), suppressed: of('proposal').filter((r) => r.decision !== 'would-raise').map((r) => ({ id: r.id, at: r.at, why: r.reason })) },
    prompts: { ...labelled(prompts), byMoment: prompts.reduce((o, r) => { const m = r.payload && r.payload.moment; o[m] = (o[m] || 0) + 1; return o; }, {}) },
    truePositives: prompts.filter((r) => r.label === 'tp').map((r) => ({ id: r.id, at: r.at, key: r.promise_key })),
    falsePositives: prompts.filter((r) => r.label === 'fp').map((r) => ({ id: r.id, at: r.at, key: r.promise_key, note: r.label_note })),
    routingOnly: { promises: [...routedByKey.values()], ...labelled(of('routing')) },
    wouldHaveInterrupted: prompts.map((r) => ({ id: r.id, at: r.at, moment: r.moment, key: r.promise_key, why: r.reason, say: r.payload && r.payload.say, label: r.label })),
    suppressions: { total: of('suppression').length, byReason: reasons },
    missed: of('missed').map((r) => ({ id: r.id, at: r.at, taskId: r.payload && r.payload.taskId, text: r.payload && r.payload.text, note: r.reason })),
  };
}

/** Test seam: forget the boot identity (a fresh process would). */
function _resetIdentity() { _identity = null; _checkout = { sha: null, at: 0 }; }

module.exports = {
  TABLE, CRON, SHADOW_DAYS, LABELS, CODE_FILES,
  registerPromiseShadow, logExists, ensureLog, captureIdentity,
  momentsAt, evaluate, discoverShadow, tick, label, missed, report, _resetIdentity,
};
