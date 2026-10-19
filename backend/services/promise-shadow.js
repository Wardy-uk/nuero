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
 *   • A five-minute tick first reads only the clock, the shadow log and the two
 *     calendar tables (dueCheck). The promise ledger is read only when a bundle
 *     or an uninspected pre-meeting window is due, and canonical Now (which
 *     reads room presence on localhost:3005) only when an unlogged moment
 *     remains — counted in stats() and on every heartbeat row.
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
function evaluate({ payload, promises, now, proposal = null, prompted = [] }) {
  const ctx = payload ? observe.promiseFeedContext(payload, { now }) : null;
  const feed = observe.feedFor({ ctx, promises, now, prompted, proposal, goalAccepted: true });
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

// ── The cheap pre-check: clock + one calendar read, nothing else ─────────────
//
// Every five-minute tick runs this. Only when it says something is due does
// the pass read the promise ledger (tasks, world model, vault notes), and only
// when that leaves an unlogged moment does it call canonical Now — which is
// what reads room presence on localhost:3005.

const _localMinute = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T').slice(0, 16);
const _hash = (parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

/**
 * Meetings starting in (now, now + BEFORE_MEETING_MINUTES], from the same two
 * sources the ledger's next-meeting lookup uses, with NO person matching (so
 * it can only ever be wider than that lookup, never narrower). Each meeting is
 * identified by its SOURCE EVENT ID plus its start, and carries a change
 * marker (world model: fingerprint + updated_at + participant hash; calendar
 * cache: hash of every field that can change, incl. the other-attendees flag).
 * A meeting with no event id has no identity (`key: null`) and is never
 * remembered — it is inspected every time it is due.
 */
function dueMeetings(nowMs) {
  const from = _localMinute(nowMs);
  const until = _localMinute(nowMs + policy.BEFORE_MEETING_MINUTES * 60000);
  const out = []; const errors = [];
  try {
    const rows = db.all(`SELECT meeting_id, provider, provider_event_id, start_local, fingerprint, updated_at FROM wm_meetings
      WHERE status = 'scheduled' AND start_local > ? AND start_local <= ?`, [from, until]);
    const parts = new Map();
    if (rows.length) {
      for (const p of db.all(`SELECT meeting_id, email, person_id, response FROM wm_meeting_participants WHERE meeting_id IN (${rows.map(() => '?').join(',')})
        ORDER BY meeting_id, email, person_id`, rows.map((r) => r.meeting_id))) {
        if (!parts.has(p.meeting_id)) parts.set(p.meeting_id, []);
        parts.get(p.meeting_id).push([p.email, p.person_id, p.response]);
      }
    }
    for (const r of rows) {
      const ev = r.provider_event_id || r.meeting_id;
      out.push({ source: 'world-model', start: r.start_local,
        key: ev ? `wm:${r.provider || '?'}:${ev}@${r.start_local}` : null,
        marker: `fp=${r.fingerprint || ''};u=${r.updated_at || ''};att=${_hash(parts.get(r.meeting_id) || [])}` });
    }
  } catch (e) { errors.push(`world model: ${e.message}`); }
  try {
    const rows = db.all(`SELECT event_id, source, subject, start_time, end_time, show_as, attendees_other, is_organizer, location FROM calendar_cache
      WHERE attendees_other = 1 AND COALESCE(is_all_day, 0) = 0 AND substr(start_time, 1, 16) > ? AND substr(start_time, 1, 16) <= ?`, [from, until]);
    for (const r of rows) {
      const start = String(r.start_time).slice(0, 16);
      out.push({ source: 'calendar', start,
        key: r.event_id ? `cc:${r.source || 'graph'}:${r.event_id}@${start}` : null,
        marker: _hash([r.subject, r.end_time, r.show_as, r.attendees_other, r.is_organizer, r.location]) });
    }
  } catch (e) { errors.push(`calendar: ${e.message}`); }
  return { meetings: out, errors };
}

// Meetings already inspected by this process, keyed by identity + change
// marker: an unchanged meeting is read once; a changed one (moved attendees,
// new fingerprint, edited fields) is read again. Lost on restart, which costs
// at most one extra ledger read per meeting.
const _inspected = new Map(); // `${key}#${marker}` -> start (local minute)
const _counters = () => ({ ticks: 0, calendarChecks: 0, calendarErrors: 0, skipped: 0, snapshots: 0,
  nowReads: 0, nowReadsBundle: 0, nowReadsMeeting: 0, meetingReinspections: 0, meetingsWithoutIdentity: 0, alreadyOffered: 0, since: null });
let _stats = _counters();

/** The run counters since this process started (or the last test reset). */
function stats() { return { ..._stats }; }

/**
 * Is anything due? Clock first: an unlogged 07:30 / 12:30 / 17:30 bundle (or
 * Monday's discovery). Then the calendar: a meeting in the next 30 minutes
 * this process has not inspected in its current form. Reads the clock, the
 * shadow log and the two calendar tables — nothing else.
 */
function dueCheck(nowMs) {
  const t = local(nowMs);
  const w = policy.windowIndex(nowMs);
  const bundleKeys = [];
  if (w !== null) bundleKeys.push(`window:${t.date}:${w}`);
  if (w === 0 && t.weekday === 1) bundleKeys.push(`discovery:${policy.isoWeek(t.date)}`);
  const bundle = bundleKeys.some((k) => !_seen(k));
  _stats.calendarChecks += 1;
  const cal = dueMeetings(nowMs);
  if (cal.errors.length) _stats.calendarErrors += 1;
  const fresh = cal.meetings.filter((m) => !m.key || !_inspected.has(`${m.key}#${m.marker}`));
  const changed = fresh.filter((m) => m.key && [..._inspected.keys()].some((k) => k.startsWith(`${m.key}#`)));
  return { due: bundle || fresh.length > 0, bundle, fresh, changed, errors: cal.errors };
}

function _remember(meetings, nowMs) {
  const now = _localMinute(nowMs);
  for (const [k, start] of _inspected) if (start <= now) _inspected.delete(k); // started: never due again
  for (const m of meetings) if (m.key) _inspected.set(`${m.key}#${m.marker}`, m.start);
  while (_inspected.size > 500) _inspected.delete(_inspected.keys().next().value);
}

/**
 * What the shadow has OFFERED, read back from its own append-only log — never
 * held in memory, so a restart loses nothing. Each would-prompt row becomes
 * `{ key, at, meetingKey }` in the policy's history shape, `at` as the London
 * wall clock (the policy dates history by the London calendar day). Only the
 * last two days are read: the policy looks at today and nothing older.
 */
function offeredHistory(nowMs) {
  return db.all(`SELECT at, moment, promise_key FROM ${TABLE} WHERE kind = 'prompt' AND decision = 'would-prompt' AND at >= ? ORDER BY id`, [iso(nowMs - 2 * 86400000)])
    .map((r) => ({ key: r.promise_key, at: _localMinute(Date.parse(r.at)), meetingKey: r.moment.startsWith('meeting:') ? r.moment.slice('meeting:'.length) : null }));
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
  _stats.ticks += 1;
  if (!_stats.since) _stats.since = at;

  const t = local(nowMs);
  const hb = `heartbeat:${t.date}T${t.hour}`;
  if (!_seen(hb)) log({ moment: hb, kind: 'heartbeat', decision: 'alive', reason: build.stale ? 'checkout has moved since boot — rows attributed to the running commit' : 'alive', payload: { counters: stats() } });

  const due = dueCheck(nowMs);
  if (!due.due) { _stats.skipped += 1; return { idle: true, skipped: true, logged }; }
  _stats.meetingReinspections += due.changed.length;
  _stats.meetingsWithoutIdentity += due.fresh.filter((m) => !m.key).length;

  const snap = observe.snapshot({ now: nowMs }); // reads only
  _stats.snapshots += 1;
  _remember(due.fresh, nowMs);
  const moments = momentsAt(nowMs, snap.promises).filter((m) => !_seen(m.key));
  if (!moments.length) return { idle: true, logged };

  let payload = null; let readError = null;
  _stats.nowReads += 1;
  if (moments.some((m) => m.type !== 'meeting')) _stats.nowReadsBundle += 1; else _stats.nowReadsMeeting += 1;
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

  // The day's offers so far, from the log (survives a restart), extended as this pass offers more.
  const offered = offeredHistory(nowMs);
  const offeredToday = (key) => offered.find((x) => x.key === key && policy.localDateOf(x.at) === t.date) || null;

  for (const m of moments) {
    if (m.type === 'discovery') {
      const ev0 = evaluate({ payload, promises: snap.promises, now: nowMs, prompted: offered });
      if (!ev0.ctx) { log({ moment: m.key, kind: 'suppression', decision: 'suppressed', reason: `discovery: context unknown — staying quiet (${ev0.gate.reason})`, payload: common(ev0) }); continue; }
      const history = db.all(`SELECT at FROM ${TABLE} WHERE kind = 'proposal' AND decision = 'would-raise' ORDER BY id`)
        .map((r) => ({ status: 'open', raisedAt: r.at, fingerprint: policy.PROPOSAL_FINGERPRINT }));
      const r = discoverShadow({ now: nowMs, ctx: ev0.ctx, ledger: snap.ledger, history });
      const ev = evaluate({ payload, promises: snap.promises, now: nowMs, prompted: offered,
        proposal: r.would ? { id: 'shadow', status: 'open', title: r.proposal.title, whyNow: r.proposal.whyNow } : null });
      log({ moment: m.key, kind: 'proposal', decision: r.would ? 'would-raise' : 'suppressed', reason: r.why,
        payload: { ...common(ev), verdicts: r.verdicts, occurrences: r.occurrences,
          proposal: r.proposal ? { title: r.proposal.title, whyNow: r.proposal.whyNow, confidence: r.proposal.confidence, evidence: r.proposal.evidence,
            examples: r.proposal.examples, evidenceHash: r.proposal.evidenceHash } : null } });
      continue;
    }
    const ev = evaluate({ payload, promises: snap.promises, now: nowMs, prompted: offered });
    // A meeting moment (incl. one that moved or was renamed) whose promise was
    // offered earlier today is evaluated and logged — and suppressed, saying so.
    const before = m.type === 'meeting' ? offeredToday(m.promiseKey) : null;
    if (before) {
      _stats.alreadyOffered += 1;
      log({ moment: m.key, kind: 'suppression', decision: 'suppressed', promiseKey: m.promiseKey, reason: policy.ALREADY_OFFERED,
        payload: { ...common(ev), offeredAt: before.at, offeredAtMoment: before.meetingKey ? `meeting:${before.meetingKey}` : 'bundle' } });
      continue;
    }
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
    offered.push({ key: sp.key, at: _localMinute(nowMs), meetingKey: ev.feed.meetingKey || null });
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
    counters: (() => { const h = of('heartbeat').filter((r) => r.payload && r.payload.counters); return h.length ? { at: h[h.length - 1].at, ...h[h.length - 1].payload.counters } : null; })(),
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
/** Test seam: forget inspected meetings and zero the counters (a fresh process would). */
function _resetRuntime() { _inspected.clear(); _stats = _counters(); }

module.exports = {
  TABLE, CRON, SHADOW_DAYS, LABELS, CODE_FILES,
  registerPromiseShadow, logExists, ensureLog, captureIdentity,
  momentsAt, evaluate, discoverShadow, dueCheck, dueMeetings, offeredHistory, stats, tick, label, missed, report, _resetIdentity, _resetRuntime,
};
