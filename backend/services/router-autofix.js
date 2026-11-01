'use strict';

/**
 * Restart the home router when it starts to wedge (Nick, 1 Nov 2026).
 *
 * The RT-AC68U's flash hangs every few days and processes pile up behind it
 * (see router-health.js). The fix is a restart, and it has to come EARLY: once
 * the box is fully wedged it cannot fork a shell, so nothing can log in to
 * restart it, and its own scheduled reboot does not fire either (20 Sep, 1 Nov).
 *
 * Nick's rule:
 *   - inside the safe hours (Settings; default 02:00–08:00 London) NEURO
 *     restarts it on its own;
 *   - outside them it ASKS — on every surface that can answer, the family wall
 *     included — and restarts only on a yes. "Not now" waits for the safe hours.
 *
 * ⚠ THE RESTART IS A KERNEL REBOOT (sysrq b), NOT `reboot`. On this firmware
 *   /sbin/reboot is ASUS's rc, which stops services cleanly first — and the
 *   services are the processes stuck on the flash, so it hangs with them. sysrq
 *   uses only shell builtins (no fork past the shell itself) and skips the sync
 *   that is hung: the same thing as pulling the plug, which is what fixes it.
 *
 * ⚠ VERIFIED BY THE WATCHER, NEVER ASSUMED. The ssh session dies with the box,
 *   so its exit status proves nothing either way. "The shell ran our marker"
 *   means the reboot was issued; a later sample with a reset uptime means it
 *   happened. No reset within VERIFY_MINUTES → not verified, stop, tell Nick.
 *
 * ⚠ LIMITS: one restart per episode, never within COOLDOWN_HOURS of the last,
 *   never in the first 30 minutes after a boot, and at most MAX_ATTEMPTS shell
 *   attempts per episode (a wedged box starts a shell only some of the time;
 *   an attempt whose shell never ran provably did nothing, so it may retry).
 *
 * Every attempt is on the external-write ledger (writer `router.restart`) and
 * in Activity (personal_ops_events). Machine clients can never approve.
 *
 * PURE where it decides (`decide`, `inWindow`); the rest reads/writes agent_state.
 */

const db = require('../db/database');

const SETTINGS_KEY = 'router_autofix';
const STATE_KEY = 'router_autofix_state';
const DEFAULTS = Object.freeze({ enabled: true, from: '02:00', to: '08:00' });
const COOLDOWN_HOURS = 6;
const MIN_UPTIME_SEC = 30 * 60;
const MAX_ATTEMPTS = 6;
const VERIFY_MINUTES = 15;
const TRIGGER_STATES = new Set(['degrading', 'wedged']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MARKER = 'neuro-restart-issued';
const REMOTE_CMD = `echo ${MARKER}; echo 1 > /proc/sys/kernel/sysrq; echo b > /proc/sysrq-trigger`;

function _json(key, fallback) {
  try {
    const raw = db.getState(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

function settings() {
  const s = _json(SETTINGS_KEY, {}) || {};
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULTS.enabled,
    from: HHMM.test(s.from) ? s.from : DEFAULTS.from,
    to: HHMM.test(s.to) ? s.to : DEFAULTS.to,
  };
}

/** Refused, never repaired: a bad time is a 400, an omitted field is unchanged. */
function saveSettings(patch = {}) {
  const next = settings();
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    next.enabled = patch.enabled;
  }
  for (const k of ['from', 'to']) {
    if (k in patch) {
      if (!HHMM.test(String(patch[k]))) return { ok: false, error: `${k} must be HH:MM` };
      next[k] = patch[k];
    }
  }
  if (next.from === next.to) return { ok: false, error: 'the safe hours need a start and an end that differ' };
  db.setState(SETTINGS_KEY, JSON.stringify(next));
  return { ok: true, settings: next };
}

// ── Pure judgements ──────────────────────────────────────────────────────────

/** Minutes past midnight on the Europe/London wall clock. */
function londonMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function _mins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Inside [from, to) London time; a window may cross midnight (22:00–06:00). */
function inWindow(now, { from, to }) {
  const t = londonMinutes(now);
  const a = _mins(from);
  const b = _mins(to);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/**
 * What to do with this sample. PURE.
 * @returns {{ action: 'none'|'restart'|'ask', why: string, by?: string }}
 */
function decide({ assessment, episodeStartedAt, settings: s, state, now = new Date(), approved = false }) {
  if (!s || !s.enabled) return { action: 'none', why: 'switched off' };
  if (!assessment || !TRIGGER_STATES.has(assessment.state)) return { action: 'none', why: 'router is not wedging' };
  if (!episodeStartedAt) return { action: 'none', why: 'no episode' };
  const uptime = assessment.latest && Number.isFinite(Number(assessment.latest.uptimeSec)) ? Number(assessment.latest.uptimeSec) : null;
  if (uptime != null && uptime < MIN_UPTIME_SEC) return { action: 'none', why: 'it booted less than 30 minutes ago' };
  const st = state || {};
  const restarts = Array.isArray(st.restarts) ? st.restarts : [];
  const mine = restarts.filter((r) => r.episode === episodeStartedAt);
  if (mine.some((r) => r.outcome === 'pending' || r.outcome === 'verified' || r.outcome === 'not-verified')) {
    return { action: 'none', why: 'already restarted for this episode' };
  }
  if (mine.length >= MAX_ATTEMPTS) return { action: 'none', why: `${MAX_ATTEMPTS} attempts could not start a shell` };
  const lastIssued = restarts.filter((r) => r.outcome !== 'failed').map((r) => Date.parse(r.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (lastIssued && now.getTime() - lastIssued < COOLDOWN_HOURS * 3600e3) {
    return { action: 'none', why: `restarted within the last ${COOLDOWN_HOURS} hours` };
  }
  if (approved) return { action: 'restart', why: 'a person said yes' };
  if (inWindow(now, s)) return { action: 'restart', why: 'inside the safe hours', by: 'auto' };
  const req = st.request && st.request.episode === episodeStartedAt ? st.request : null;
  if (req && req.decision === 'declined') return { action: 'none', why: 'not now — waiting for the safe hours' };
  return { action: 'ask', why: 'outside the safe hours' };
}

// ── State ────────────────────────────────────────────────────────────────────

function _state() {
  const s = _json(STATE_KEY, {}) || {};
  return { request: s.request || null, restarts: Array.isArray(s.restarts) ? s.restarts.slice(-30) : [] };
}
function _save(s) { db.setState(STATE_KEY, JSON.stringify({ request: s.request || null, restarts: (s.restarts || []).slice(-30) })); }

function _log(kind, detail = {}) {
  try {
    const actor = detail.by && detail.by !== 'auto' ? String(detail.by) : 'neuro';
    require('./personal-obligations').logEvent(kind, { subjectId: 'router', actor, detail });
  } catch (e) {
    console.warn('[RouterAutofix] activity log failed:', e.message);
  }
}

function _push(title, body, data) {
  try {
    require('./webpush').sendToAll(title, body, data).catch((e) => console.warn('[RouterAutofix] push failed:', e.message));
  } catch (e) {
    console.warn('[RouterAutofix] push failed:', e.message);
  }
}

function _issue(assessment) {
  const top = (assessment.issues || []).find((i) => i.level === 'critical') || (assessment.issues || [])[0];
  return top ? top.title : 'it is wedging';
}

// ── The restart itself ───────────────────────────────────────────────────────

/** Default runner: ssh to the router with the pi5 key. Injectable for tests. */
function _sshRunner() {
  // ⚠ NEVER from a test process: tests run on pi5, which holds the real router
  // key, and the router suites post wedging samples. A test that wants a
  // restart injects a runner (_setRunnerForTests).
  if (process.env.NODE_TEST_CONTEXT || process.env.ROUTER_AUTOFIX_NO_SSH === '1') {
    return async () => ({ stdout: '', stderr: 'refused: no real ssh from a test process', code: 'test' });
  }
  const { execFile } = require('child_process');
  const os = require('os');
  const path = require('path');
  const key = process.env.ROUTER_SSH_KEY || path.join(os.homedir(), '.ssh', 'asus_router');
  const target = process.env.ROUTER_SSH_TARGET || 'wardnickj@192.168.1.1';
  return () => new Promise((resolve) => {
    execFile('ssh', ['-i', key, '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=2', target, REMOTE_CMD],
      { timeout: 25000 }, (err, stdout, stderr) => resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (err.code ?? 'error') : 0 }));
  });
}

let _runner = null;
function _setRunnerForTests(fn) { _runner = fn; }

let _inFlight = false;

/**
 * Issue the restart. Synchronous claim (in-process flag + ledger), then ssh.
 * @returns {{ ok, issued?, why?, entry? }}
 */
async function restart({ episodeStartedAt, by, assessment, now = new Date() }) {
  if (_inFlight) return { ok: false, why: 'a restart is already being sent' };
  const writes = require('./external-writes');
  const st = _state();
  const attempt = st.restarts.filter((r) => r.episode === episodeStartedAt).length + 1;
  const key = `router-restart:${episodeStartedAt}:${attempt}`;
  const claim = writes.begin({ writer: 'router.restart', key, target: 'router', request: { by, episode: episodeStartedAt, attempt }, initiatedBy: by === 'auto' ? 'neuro' : by, now: now.getTime() });
  if (!claim.ok) return { ok: false, why: claim.why || 'already attempted' };
  _inFlight = true;
  const prevUptime = assessment && assessment.latest ? Number(assessment.latest.uptimeSec) || null : null;
  let r;
  try {
    r = await (_runner || _sshRunner())();
  } catch (e) {
    r = { stdout: '', stderr: e.message, code: 'error' };
  } finally {
    _inFlight = false;
  }
  const issued = r.stdout.includes(MARKER);
  const row = { at: now.toISOString(), episode: episodeStartedAt, by, attempt, prevUptime, outcome: issued ? 'pending' : 'failed', why: issued ? null : (r.stderr.trim().split('\n').pop() || `ssh exit ${r.code}`).slice(0, 160) };
  const fresh = _state();
  fresh.restarts.push(row);
  if (issued && fresh.request && fresh.request.episode === episodeStartedAt) fresh.request = { ...fresh.request, closed: 'restarted' };
  _save(fresh);
  writes.settle(claim.entry.id, { status: issued ? 'applied-unverified' : 'failed', result: { issued, code: r.code } });
  _log(issued ? 'router-restart-issued' : 'router-restart-failed', { by, attempt, why: row.why });
  if (issued) {
    _push('SAiM — Router', by === 'auto'
      ? `Restarting the router — ${_issue(assessment || {})}. Wi-Fi will drop for about 2 minutes.`
      : 'Restarting the router now. Wi-Fi will drop for about 2 minutes.', { type: 'router_restart', key: `router-restart-issued:${episodeStartedAt}` });
  }
  return { ok: issued, issued, why: row.why, attempt };
}

/** A later sample says whether the box actually came back fresh. */
function verify(sample, now = new Date()) {
  const st = _state();
  const pending = st.restarts.filter((r) => r.outcome === 'pending');
  if (!pending.length) return null;
  let changed = null;
  for (const r of pending) {
    const at = Date.parse(r.at);
    const up = sample && Number.isFinite(Number(sample.uptimeSec)) ? Number(sample.uptimeSec) : null;
    const sampleAt = sample && Date.parse(sample.at);
    const rebooted = up != null && Number.isFinite(sampleAt) && sampleAt > at
      && (up * 1000 <= sampleAt - at + 120e3 || (r.prevUptime != null && up < r.prevUptime));
    if (rebooted) { r.outcome = 'verified'; r.verifiedAt = now.toISOString(); changed = r; }
    else if (now.getTime() - at > VERIFY_MINUTES * 60e3) { r.outcome = 'not-verified'; r.verifiedAt = now.toISOString(); changed = r; }
  }
  if (!changed) return null;
  _save(st);
  try {
    const writes = require('./external-writes');
    const entry = writes.byKey(`router-restart:${changed.episode}:${changed.attempt}`);
    if (entry) writes.settle(entry.id, { status: changed.outcome === 'verified' ? 'confirmed' : 'uncertain', readback: { outcome: changed.outcome } });
  } catch (e) {
    console.warn('[RouterAutofix] ledger settle failed:', e.message);
  }
  _log(changed.outcome === 'verified' ? 'router-restart-verified' : 'router-restart-not-verified', { by: changed.by });
  if (changed.outcome === 'not-verified') {
    _push('SAiM — Router', `I restarted the router but it hasn’t come back fresh after ${VERIFY_MINUTES} minutes. Switch it off at the wall.`, { type: 'router_restart', key: `router-restart-unverified:${changed.episode}` });
  }
  return changed;
}

// ── The sample hook ──────────────────────────────────────────────────────────

/** Called by POST /api/router/sample. Never throws. */
async function onSample({ sample, assessment, episode, now = new Date() }) {
  try {
    verify(sample, now);
    const st = _state();
    if (episode && 'ended' in episode) {
      if (st.request && !st.request.closed) { st.request = { ...st.request, closed: 'recovered' }; _save(st); }
      return { action: 'none', why: 'recovered' };
    }
    const episodeStartedAt = episode && episode.startedAt;
    const d = decide({ assessment, episodeStartedAt, settings: settings(), state: st, now });
    if (d.action === 'restart') {
      const r = await restart({ episodeStartedAt, by: 'auto', assessment, now });
      return { ...d, result: r };
    }
    if (d.action === 'ask') {
      if (!st.request || st.request.episode !== episodeStartedAt || st.request.closed) {
        st.request = { id: `rr_${Date.parse(episodeStartedAt).toString(36)}`, episode: episodeStartedAt, raisedAt: now.toISOString(), issue: _issue(assessment), decision: null };
        _save(st);
        _log('router-restart-asked', { issue: st.request.issue });
      }
      const s = settings();
      _push('SAiM — Router', `The router is wedging (${st.request.issue}). Restart it now? Wi-Fi drops for about 2 minutes. Otherwise I’ll do it in the safe hours (${s.from}–${s.to}).`,
        { type: 'router_restart', key: `router-restart-ask:${episodeStartedAt}` });
    }
    return d;
  } catch (e) {
    console.warn('[RouterAutofix] sample hook failed:', e.message);
    return { action: 'none', why: e.message };
  }
}

// ── Answers from a person ────────────────────────────────────────────────────

function _openRequest(st, id) {
  const r = st.request;
  if (!r || r.closed || (id && r.id !== id)) return null;
  return r;
}

/**
 * Approve or decline the open request. `by` names who pressed it (nick, or a
 * VESTA account). Approve re-checks the router is still wedging first.
 */
async function answer({ id, decision, by = 'nick', now = new Date() }) {
  if (decision !== 'approve' && decision !== 'decline') return { ok: false, status: 400, error: 'decision must be approve or decline' };
  const st = _state();
  const req = _openRequest(st, id);
  if (!req) return { ok: false, status: 409, error: 'nothing is waiting for an answer — the router may have recovered or already been restarted' };
  if (decision === 'decline') {
    st.request = { ...req, decision: 'declined', decidedBy: by, decidedAt: now.toISOString() };
    _save(st);
    _log('router-restart-declined', { by });
    const s = settings();
    return { ok: true, say: `Okay — I’ll restart it in the safe hours (${s.from}–${s.to}) if it’s still wrong.` };
  }
  const routerHealth = require('./router-health');
  const assessment = routerHealth.current(now);
  if (!TRIGGER_STATES.has(assessment.state)) {
    st.request = { ...req, closed: 'recovered' };
    _save(st);
    return { ok: false, status: 409, error: 'the router looks healthy again, so I didn’t restart it' };
  }
  const d = decide({ assessment, episodeStartedAt: req.episode, settings: { ...settings(), enabled: true }, state: { ...st, request: null }, now, approved: true });
  if (d.action !== 'restart') return { ok: false, status: 409, error: d.why };
  st.request = { ...req, decision: 'approved', decidedBy: by, decidedAt: now.toISOString() };
  _save(st);
  _log('router-restart-approved', { by });
  const r = await restart({ episodeStartedAt: req.episode, by, assessment, now });
  if (!r.ok) return { ok: false, status: 502, error: `couldn’t get into the router to restart it — ${r.why || 'no shell'}. Switch it off at the wall.` };
  return { ok: true, say: 'Restarting the router now. Wi-Fi drops for about 2 minutes.' };
}

// ── Read model ───────────────────────────────────────────────────────────────

/** For surfaces: the open question, and the latest restart within 3 hours. Null when there is nothing. */
function surface(now = new Date()) {
  try {
    const st = _state();
    const s = settings();
    const req = _openRequest(st, null);
    const ask = req && req.decision !== 'declined'
      ? { id: req.id, issue: req.issue, raisedAt: req.raisedAt,
          say: `The router is wedging (${req.issue}). Restart it now? Wi-Fi and the internet drop for about 2 minutes.`,
          acceptLabel: 'Restart now', declineLabel: `Not now — wait for ${s.from}` }
      : null;
    const last = st.restarts.filter((r) => r.outcome !== 'failed').slice(-1)[0];
    let note = null;
    if (last && now.getTime() - Date.parse(last.at) < 3 * 3600e3) {
      const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(last.at));
      note = last.outcome === 'verified' ? `Router restarted at ${t} and came back.`
        : last.outcome === 'pending' ? `Router restarting (sent at ${t}).`
        : `Router restart at ${t} didn’t come back cleanly — switch it off at the wall.`;
    }
    if (!ask && !note) return null;
    return { ask, note, settings: s };
  } catch {
    return null;
  }
}

function status(now = new Date()) {
  const st = _state();
  return { settings: settings(), request: st.request, restarts: st.restarts.slice(-10).reverse(), surface: surface(now) };
}

module.exports = {
  settings, saveSettings, inWindow, londonMinutes, decide, onSample, restart, verify, answer, surface, status,
  _setRunnerForTests, REMOTE_CMD, MARKER, DEFAULTS, COOLDOWN_HOURS, MAX_ATTEMPTS, MIN_UPTIME_SEC, VERIFY_MINUTES,
  SETTINGS_KEY, STATE_KEY,
};
