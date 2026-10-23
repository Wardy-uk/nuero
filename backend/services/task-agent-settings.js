'use strict';

/**
 * Settings for the "Do this" task agent: Settings → AI & SAiM → Anthropic.
 *
 * What it holds:
 *   - enabled (default OFF);
 *   - the Anthropic API key used ONLY by Do this. ⚠ TEMPORARY (Nick's approval,
 *     23 Oct 2026): it lives in agent_state, i.e. the server's SQLite file, which
 *     is owner-readable only on the Pi but NOT encrypted. Encrypted secret storage
 *     is the next upgrade (docs/task-agent.md, "Stage 2"). This exception covers
 *     this one key; nothing else may be stored this way because it exists;
 *   - the model, from a closed list;
 *   - the daily dollar budget and the daily run limit.
 *
 * The two limits are HARD from the first release and are enforced here, in NEURO,
 * independently of the shared AI gate's mode (which stays shadow). They apply to
 * Do this alone: no other caller reads them, and the shared gate is unchanged.
 *
 * ⚠ The key never leaves the server. No function here returns it except `apiKey()`,
 * which only the task agent and the connection test call, to hand to the provider.
 * `read()` reports `configured: true|false` and nothing else about it.
 */

const db = require('../db/database');

const SETTINGS_KEY = 'task_agent_settings';
const SECRET_KEY = 'task_agent_anthropic_key';
const RUNS_KEY = 'task_agent_runs_today';

/** Supported models: in the installed SDK's list AND priced in both the gate's and ai-cost's tables. */
const MODELS = Object.freeze([
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cheaper, less capable)' },
]);
const DEFAULTS = Object.freeze({ enabled: false, model: 'claude-sonnet-4-6', dailyUsd: 1.0, dailyRuns: 10 });
const MAX_USD = 50;
const MAX_RUNS = 200;
const CLASSES = Object.freeze(['task_agent', 'task_agent_test']);

const NOTICE = 'This key is stored on this NEURO server. Encrypted secret storage is the next security upgrade.';
const CAP_SAY = 'These limits are enforced for new Do this runs: a run, or its next step, is refused once either is reached. They apply only to Do this, and are independent of the wider AI gate, which is still in shadow mode and blocks nothing.';
// While Do this is disabled nothing can start, so the limits are only configured.
// (Enforcement in claimRun/budgetOpen/guardRequest is unchanged either way.)
const CAP_SAY_DISABLED = 'These limits are configured. They are enforced for new Do this runs once Do this is enabled. No task attempts can start while Do this is disabled. They apply only to Do this, and are independent of the wider AI gate, which is still in shadow mode and blocks nothing.';
const KEY_SAY = 'Anthropic key saved. This is configuration only: it does not turn Do this on.';
// Stated on screen before save and enforced here (never rounded silently).
// ── per-ATTEMPT work budget (23 Oct 2026) ─────────────────────────────────────
// Separate from the DAILY allowance above: however generous the day is, ONE attempt
// (one "tranche" of work, until it stops or Nick presses Continue working) is bounded,
// and every bound is checked by the server BEFORE a model request is sent.
const ATTEMPT_DEFAULTS = Object.freeze({ maxRounds: 8, maxNotes: 6, maxSearches: 3, maxInputTokens: 80000, maxAttemptUsd: 2.0, maxOutputTokens: 4000 });
const ATTEMPT_BOUNDS = Object.freeze({
  maxRounds: { min: 2, max: 20, int: true, label: 'Model rounds per attempt', say: 'How many model requests one attempt may make (each read, search or draft round is one). From 2 to 20.' },
  maxNotes: { min: 1, max: 20, int: true, label: 'Source notes per attempt', say: 'How many notes NEURO may open in full in one attempt (each is cut to a bounded excerpt before it enters the prompt). From 1 to 20.' },
  maxSearches: { min: 0, max: 10, int: true, label: 'Extra searches per attempt', say: 'Vault searches beyond the task’s linked notes. From 0 to 10.' },
  maxInputTokens: { min: 10000, max: 400000, int: true, label: 'Input tokens per attempt', say: 'The total the model may read across all requests in one attempt (prompt + evidence + its own earlier rounds). A whole number from 10000 to 400000 (no commas).' },
  maxAttemptUsd: { min: 0.1, max: MAX_USD, int: false, label: 'Cost per attempt ($)', say: `The most one attempt may cost, judged on each request’s worst case before it is sent. From $0.10 to $${MAX_USD}, two decimals.` },
  maxOutputTokens: { min: 500, max: 8000, int: true, label: 'Output tokens per round', say: 'The longest single reply the model may write in one round. A whole number from 500 to 8000.' },
});
/** PURE. One attempt limit, refused (never clamped) outside its bounds. */
function parseAttempt(field, v) {
  const b = ATTEMPT_BOUNDS[field];
  if (!b) return { error: 'Unknown limit.' };
  if (typeof v === 'boolean' || v == null || v === '') return { error: `Enter a value. ${b.say}` };
  const t = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim().replace(/_/g, '');
  const re = b.int ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  if (!re.test(t)) return { error: b.say };
  const n = Number(t);
  if (n < b.min || n > b.max) return { error: b.say };
  return { value: b.int ? n : Math.round(n * 100) / 100 };
}
function _attemptFrom(a) {
  const out = { ...ATTEMPT_DEFAULTS };
  for (const k of Object.keys(ATTEMPT_DEFAULTS)) { if (a && a[k] != null) { const r = parseAttempt(k, a[k]); if (r.value != null) out[k] = r.value; } }
  return out;
}
/** The current per-attempt limits (defaults where none saved). */
function attemptLimits() { return { ..._settings().attempt }; }

const LIMIT_RULES = Object.freeze({
  dailyUsd: `A dollar amount from $0.01 to $${MAX_USD}, at most two decimal places (for example 1.5 or 1.50). Use a full stop for decimals.`,
  dailyRuns: `A whole number of runs from 1 to ${MAX_RUNS}.`,
});

class TaskAgentLimitError extends Error {
  constructor(limit, say) { super(say); this.name = 'TaskAgentLimitError'; this.limit = limit; this.say = say; }
}

// ── deps (test seam) ─────────────────────────────────────────────────────────
let _deps = null;
function deps() {
  if (_deps) return _deps;
  return {
    now: () => Date.now(),
    profile: () => { try { return require('./ai-gate').profile({}); } catch { return null; } },
    londonDay: (ms) => require('./ai-gate').londonDay(ms),
    worstCaseUsd: (spec) => require('./ai-gate').worstCaseUsd(spec),
    provider: require('./providers/anthropic-provider'),
    gateMode: () => (String(process.env.AI_GATE_MODE || 'shadow').toLowerCase() === 'enforce' ? 'enforce' : 'shadow'),
  };
}

// ── storage ──────────────────────────────────────────────────────────────────
function _settings() {
  let raw = null;
  try { raw = db.getState(SETTINGS_KEY); } catch { raw = null; }
  if (!raw) return { ...DEFAULTS, attempt: { ...ATTEMPT_DEFAULTS } };
  try {
    const s = JSON.parse(raw);
    return {
      enabled: s.enabled === true,
      model: MODELS.some((m) => m.id === s.model) ? s.model : DEFAULTS.model,
      dailyUsd: Number.isFinite(s.dailyUsd) && s.dailyUsd > 0 ? s.dailyUsd : DEFAULTS.dailyUsd,
      dailyRuns: Number.isInteger(s.dailyRuns) && s.dailyRuns > 0 ? s.dailyRuns : DEFAULTS.dailyRuns,
      attempt: _attemptFrom(s.attempt),
      updatedAt: s.updatedAt || null,
    };
  } catch { return { ...DEFAULTS, attempt: { ...ATTEMPT_DEFAULTS }, unreadable: true }; }
}

/** The key, for the provider call only. Never returned by a route. */
function apiKey() {
  try { const k = db.getState(SECRET_KEY); return typeof k === 'string' && k.trim() ? k.trim() : ''; } catch { return ''; }
}
function configured() { return Boolean(apiKey()); }

// ── the day's count and spend ────────────────────────────────────────────────
function _midnightAfter(ms) {
  // The next Europe/London midnight after ms (handles both clock changes).
  const d = deps();
  const today = d.londonDay(ms);
  let t = ms;
  for (let i = 0; i < 30; i++) { t += 3600000; if (d.londonDay(t) !== today) break; }
  // step back to the first minute of the new day
  let lo = t - 3600000; let hi = t;
  while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 2); if (d.londonDay(mid) === today) lo = mid; else hi = mid; }
  return hi - (hi % 60000);
}

function runsToday(now = deps().now()) {
  const day = deps().londonDay(now);
  try {
    const raw = db.getState(RUNS_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.day === day ? Number(s.count) || 0 : 0;
  } catch { return null; }
}

/** Today's Task Agent spend and request count from the shared ledger, or null when it cannot be read. */
function spendToday() {
  const p = deps().profile();
  if (!p || p.known === false || !Array.isArray(p.byClass)) return null;
  let usd = 0; let requests = 0;
  for (const r of p.byClass) {
    if (r.app === 'neuro' && CLASSES.includes(r.callClass)) { usd += Number(r.usd) || 0; requests += Number(r.calls) || 0; }
  }
  return { usd: Math.round(usd * 1e6) / 1e6, requests };
}

function _resetSay(now) {
  const at = new Date(_midnightAfter(now));
  return { resetsAt: at.toISOString(), resetsSay: 'at midnight (UK time)' };
}

/**
 * A NEW Do this attempt may start. Checks both limits; counts the run only when
 * admitted (synchronous read-modify-write, so two presses cannot both pass).
 */
function claimRun() {
  const d = deps();
  const now = d.now();
  const s = _settings();
  const { resetsAt } = _resetSay(now);
  const room = _room(s, stepUsd(s.model), 'Nothing was created.');
  if (!room.ok) return { ...room, resetsAt };
  const used = runsToday(now);
  if (used == null) return { ok: false, limit: 'runs', resetsAt, say: 'NEURO cannot read today’s Do this run count, so it will not start. Nothing was created.' };
  if (used >= s.dailyRuns) return { ok: false, limit: 'runs', resetsAt, say: `Today’s limit of ${s.dailyRuns} Do this runs is reached. It resets at midnight (UK time). Nothing was created.` };
  db.setState(RUNS_KEY, JSON.stringify({ day: d.londonDay(now), count: used + 1 }));
  return { ok: true, used: used + 1, limit: s.dailyRuns };
}

/**
 * The most one Do this step (one model request) can cost: a generous input bound
 * and the full output bound. A run is not started, and a turn not begun, unless at
 * least this much of today's budget is left — so a run is refused cleanly at the
 * door rather than failing on its first request.
 */
const STEP_INPUT_BOUND = 8000;
const STEP_OUTPUT_BOUND = 4000;
function stepUsd(m) {
  const w = deps().worstCaseUsd({ provider: 'anthropic', model: m, maxInputTokens: STEP_INPUT_BOUND, maxOutputTokens: STEP_OUTPUT_BOUND });
  return w == null ? null : w;
}
function _room(s, step, tail) {
  const spend = spendToday();
  if (!spend) return { ok: false, limit: 'ledger', say: `NEURO cannot read today’s AI spend, so Do this will not run. ${tail}` };
  if (step == null) return { ok: false, limit: 'price', say: `The model “${s.model}” has no price, so Do this will not run. ${tail}` };
  if (spend.usd >= s.dailyUsd) return { ok: false, limit: 'budget', say: `Today’s Do this budget of $${s.dailyUsd.toFixed(2)} is used ($${spend.usd.toFixed(2)} spent). It resets at midnight (UK time). ${tail}` };
  if (spend.usd + step > s.dailyUsd) return { ok: false, limit: 'budget', say: `Not enough of today’s $${s.dailyUsd.toFixed(2)} Do this budget is left for a step (up to $${step.toFixed(2)}; $${spend.usd.toFixed(2)} spent). It resets at midnight (UK time). ${tail}` };
  return { ok: true, spentUsd: spend.usd };
}

/** Whether today's budget still has room for a Do this step (before a turn or a resume). */
function budgetOpen() {
  const s = _settings();
  const r = _room(s, stepUsd(s.model), 'Nothing was sent to a model.');
  return r.ok ? r : { ...r, ..._resetSay(deps().now()) };
}

/**
 * Called by the provider BEFORE every Task Agent model request. Throws when the
 * request's worst case would take today's spend over the budget. `othersInFlight`
 * counts other Do this requests running now; each is assumed to cost the same
 * worst case (conservative: their tickets are not settled yet).
 */
function guardRequest({ model, maxInputTokens, maxOutputTokens }, { othersInFlight = 0 } = {}) {
  const s = _settings();
  const now = deps().now();
  const spend = spendToday();
  if (!spend) throw new TaskAgentLimitError('ledger', 'NEURO cannot read today’s AI spend, so this request was not sent.');
  const worst = deps().worstCaseUsd({ provider: 'anthropic', model, maxInputTokens, maxOutputTokens });
  if (worst == null) throw new TaskAgentLimitError('price', `The model “${model}” has no price, so this request was not sent.`);
  const projected = spend.usd + worst * (1 + Math.max(0, othersInFlight));
  if (projected > s.dailyUsd) {
    throw new TaskAgentLimitError('budget', `This step could cost up to $${worst.toFixed(2)}, which would take today’s Do this spend ($${spend.usd.toFixed(2)}) over the $${s.dailyUsd.toFixed(2)} budget. It resets at midnight (UK time). Nothing from this step was kept.`);
  }
  return { ok: true, worst, spentUsd: spend.usd };
}

// ── limit parsing (the ONE rule; the screen states it, the server enforces it) ──
/**
 * PURE. The daily dollar budget, from a number or a string. Refused, never rounded
 * or clamped: more than two decimal places, a comma, a sign, blank, 0, or over the
 * maximum each come back as an error — a silently changed budget is how a screen
 * and the store come to disagree.
 */
function parseUsd(v) {
  if (typeof v === 'boolean' || v == null) return { error: 'Enter an amount.' };
  const t = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim();
  if (/,/.test(t)) return { error: 'Use a full stop for decimals (for example 1.50), not a comma.' };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: `Enter an amount above $0 and up to $${MAX_USD}, with at most two decimal places.` };
  const n = Number(t);
  if (!(n > 0) || n > MAX_USD) return { error: `Enter an amount above $0 and up to $${MAX_USD}.` };
  return { value: Math.round(n * 100) / 100 };
}
/** PURE. The daily run limit: a whole number (2 and "2.0" are both two runs; 2.5 is refused). */
function parseRuns(v) {
  if (typeof v === 'boolean' || v == null) return { error: 'Enter a number of runs.' };
  const t = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim();
  if (!/^\d+(\.0+)?$/.test(t)) return { error: `Enter a whole number from 1 to ${MAX_RUNS}.` };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RUNS) return { error: `Enter a whole number from 1 to ${MAX_RUNS}.` };
  return { value: n };
}

/**
 * PURE. The one status line at the top of the section. Configuration (a saved key)
 * is never reported as operation: only enabled + a key + room today is "Enabled".
 */
function statusOf({ enabled, configured: hasKey, unreadable, today, stepUsd: step, dailyUsd, dailyRuns }) {
  if (!enabled) return { state: 'disabled', label: 'Task Agent: Disabled', say: 'No task attempts can start while Do this is disabled.' };
  if (!hasKey) return { state: 'needs-key', label: 'Task Agent: Needs a key', say: 'Do this is switched on but no Anthropic key is saved, so nothing can run.' };
  if (unreadable) return { state: 'blocked', label: 'Task Agent: Blocked', say: 'The saved Do this settings could not be read, so nothing will run until they are saved again.' };
  if (!today || today.known === false) return { state: 'blocked', label: 'Task Agent: Blocked', say: 'NEURO cannot read today’s Do this spend, so no run will start until it can.' };
  if (today.runs >= dailyRuns) return { state: 'blocked', label: 'Task Agent: Blocked', say: `Today’s run limit is used (${today.runs} of ${dailyRuns}). Runs resume at midnight (UK time).` };
  if (today.usd >= dailyUsd) return { state: 'blocked', label: 'Task Agent: Blocked', say: `Today’s budget is used ($${today.usd.toFixed(2)} of $${dailyUsd.toFixed(2)}). Runs resume at midnight (UK time).` };
  if (step != null && today.remainingUsd != null && step > today.remainingUsd) return { state: 'blocked', label: 'Task Agent: Blocked', say: `Not enough budget left today for one more step (needs up to $${step.toFixed(3)}, $${today.remainingUsd.toFixed(2)} left). Runs resume at midnight (UK time).` };
  return { state: 'enabled', label: 'Task Agent: Enabled', say: 'Do this can start new runs within today’s limits.' };
}

// ── the public view (never the key) ──────────────────────────────────────────
function read() {
  const s = _settings();
  const now = deps().now();
  const spend = spendToday();
  const runs = runsToday(now);
  const view = {
    ok: true,
    contract: 'task-agent-settings-v1',
    enabled: s.enabled,
    configured: configured(),
    model: s.model,
    models: MODELS.map((m) => ({ ...m })),
    dailyUsd: s.dailyUsd,
    dailyRuns: s.dailyRuns,
    today: {
      known: Boolean(spend) && runs != null,
      usd: spend ? spend.usd : null,
      requests: spend ? spend.requests : null,
      runs,
      remainingUsd: spend ? Math.max(0, Math.round((s.dailyUsd - spend.usd) * 100) / 100) : null,
      remainingRuns: runs == null ? null : Math.max(0, s.dailyRuns - runs),
    },
    ..._resetSay(now),
    stepUsd: stepUsd(s.model),
    gateMode: deps().gateMode(),
    capSay: s.enabled ? CAP_SAY : CAP_SAY_DISABLED,
    credentialSay: configured() ? KEY_SAY : null,
    limitRules: { ...LIMIT_RULES },
    attempt: { ...s.attempt },
    attemptDefaults: { ...ATTEMPT_DEFAULTS },
    attemptRules: Object.fromEntries(Object.entries(ATTEMPT_BOUNDS).map(([k, b]) => [k, { label: b.label, say: b.say, min: b.min, max: b.max }])),
    attemptSay: 'These bound ONE attempt, separately from the daily budget and run limit. NEURO checks them before every model request; when one is reached it stops cleanly, keeps what it prepared, and waits for you to press Continue working (which counts as another run).',
    notice: NOTICE,
    storage: 'server-plaintext-temporary',
    unreadable: Boolean(s.unreadable),
  };
  view.status = statusOf(view);
  return view;
}

const ALLOWED = new Set(['enabled', 'model', 'dailyUsd', 'dailyRuns', 'apiKey', 'clearKey', 'attempt']);

/**
 * Save. Omitted fields are unchanged. Errors name the field and nothing is written
 * when any field is invalid. The key is stored only when `apiKey` is a non-empty
 * string; `clearKey: true` removes it (and turns Do this off).
 */
function save(body = {}) {
  const errors = [];
  for (const k of Object.keys(body || {})) if (!ALLOWED.has(k)) errors.push({ field: k, error: 'Unexpected field.' });
  const s = _settings();
  const next = { enabled: s.enabled, model: s.model, dailyUsd: s.dailyUsd, dailyRuns: s.dailyRuns, attempt: { ...s.attempt } };
  if (body.attempt !== undefined) {
    if (!body.attempt || typeof body.attempt !== 'object' || Array.isArray(body.attempt)) errors.push({ field: 'attempt', error: 'Attempt limits must be an object.' });
    else for (const [k, v] of Object.entries(body.attempt)) {
      if (!ATTEMPT_BOUNDS[k]) { errors.push({ field: `attempt.${k}`, error: 'Unexpected field.' }); continue; }
      const r = parseAttempt(k, v);
      if (r.error) errors.push({ field: `attempt.${k}`, error: r.error }); else next.attempt[k] = r.value;
    }
  }
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') errors.push({ field: 'enabled', error: 'Must be on or off.' }); else next.enabled = body.enabled; }
  if (body.model !== undefined) { if (!MODELS.some((m) => m.id === body.model)) errors.push({ field: 'model', error: 'Choose one of the supported models.' }); else next.model = body.model; }
  if (body.dailyUsd !== undefined) {
    const r = parseUsd(body.dailyUsd);
    if (r.error) errors.push({ field: 'dailyUsd', error: r.error }); else next.dailyUsd = r.value;
  }
  if (body.dailyRuns !== undefined) {
    const r = parseRuns(body.dailyRuns);
    if (r.error) errors.push({ field: 'dailyRuns', error: r.error }); else next.dailyRuns = r.value;
  }
  let newKey = null;
  if (body.apiKey !== undefined) {
    const k = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!k) errors.push({ field: 'apiKey', error: 'Paste a key, or use Clear to remove it.' });
    else if (k.length < 20 || k.length > 400 || /\s/.test(k)) errors.push({ field: 'apiKey', error: 'That does not look like an Anthropic API key.' });
    else newKey = k;
  }
  if (body.clearKey !== undefined && typeof body.clearKey !== 'boolean') errors.push({ field: 'clearKey', error: 'Must be true or false.' });
  if (body.clearKey === true && newKey) errors.push({ field: 'apiKey', error: 'Paste a new key or clear it, not both.' });
  const willHaveKey = body.clearKey === true ? false : (newKey ? true : configured());
  if (body.clearKey === true) next.enabled = false;
  if (next.enabled && !willHaveKey) errors.push({ field: 'enabled', error: 'Add an Anthropic key before turning Do this on.' });
  if (errors.length) return { ok: false, status: 400, errors, settings: read() };

  const changed = [];
  if (next.enabled !== s.enabled) changed.push('enabled');
  if (next.model !== s.model) changed.push('model');
  if (next.dailyUsd !== s.dailyUsd) changed.push('dailyUsd');
  if (next.dailyRuns !== s.dailyRuns) changed.push('dailyRuns');
  for (const k of Object.keys(ATTEMPT_DEFAULTS)) if (next.attempt[k] !== s.attempt[k]) changed.push(`attempt.${k}`);
  if (newKey) { db.setState(SECRET_KEY, newKey); changed.push('apiKey'); }
  if (body.clearKey === true && configured()) { db.setState(SECRET_KEY, ''); changed.push('apiKey-cleared'); }
  db.setState(SETTINGS_KEY, JSON.stringify({ ...next, updatedAt: new Date(deps().now()).toISOString() }));
  return { ok: true, changed, settings: read() };
}

/** Removes the saved key and anything shaped like an API key from a message before it is shown or logged. */
function redact(text) {
  let out = String(text == null ? '' : text);
  const k = apiKey();
  if (k) out = out.split(k).join('[key]');
  return out.replace(/sk-ant-[A-Za-z0-9_\-]{6,}/g, '[key]').replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '[redacted]');
}

// ── the synthetic connection test ────────────────────────────────────────────
const TEST_SYSTEM = 'This is an automated connection check. Reply with the single word OK.';
const TEST_USER = 'Connection check from NEURO Settings. Reply OK.';
const TEST_MAX_TOKENS = 16;
const TEST_INPUT_BOUND = 200;

function testEstimate(m = model()) {
  const w = deps().worstCaseUsd({ provider: 'anthropic', model: m, maxInputTokens: TEST_INPUT_BOUND, maxOutputTokens: TEST_MAX_TOKENS });
  return w == null ? null : Math.max(0.0001, Math.round(w * 10000) / 10000);
}

/**
 * "Test Anthropic connection": ONE bounded request with fixed fixture text, under
 * its own gate class. Needs `confirm: true` (it spends a little money). Creates no
 * task attempt, draft, email, vault write, calendar item, task change, prepared
 * action, confirmation or allowance change. Reports model, tokens, cost, the ledger
 * result and a sanitised failure reason — never the prompt or the key.
 */
async function testConnection({ confirm = false } = {}) {
  const m = model();
  const estimateUsd = testEstimate(m);
  if (!configured()) return { ok: false, status: 409, error: 'Save an Anthropic key first.', estimateUsd };
  if (confirm !== true) return { ok: false, status: 400, needsConfirm: true, estimateUsd, error: `This sends one tiny request to Anthropic (about $${(estimateUsd || 0).toFixed(4)}). Confirm to run it.` };
  const open = _room(_settings(), estimateUsd, 'The test was not sent.');
  if (!open.ok) return { ok: false, status: 429, limit: open.limit, resetsAt: _resetSay(deps().now()).resetsAt, error: open.say, estimateUsd };
  const before = spendToday();
  const d = deps();
  const started = d.now();
  let r;
  try {
    r = await d.provider.chat(TEST_SYSTEM, [{ role: 'user', content: TEST_USER }], {
      model: m, maxTokens: TEST_MAX_TOKENS, callClass: 'task_agent_test', apiKey: apiKey(),
      requestOptions: { timeout: 30000, maxRetries: 0 },
      beforeRequest: (spec) => guardRequest(spec),
    });
  } catch (e) {
    const status = e && (e.status || (e.response && e.response.status));
    let reason = e && e.name === 'TaskAgentLimitError' ? e.say
      : status === 401 ? 'Anthropic rejected the key (401). Check it and save it again.'
        : status === 403 ? 'Anthropic refused this key (403): it may lack permission for this model.'
          : status === 404 ? `Anthropic does not recognise the model “${m}” for this key (404).`
            : /credit balance|insufficient.*credit|billing/i.test(String(e && e.message)) ? 'The Anthropic account has no credit left.'
              : status === 429 || status === 529 ? 'Anthropic is busy or rate-limiting (try again in a minute).'
                : /timed? ?out/i.test(String(e && e.message)) ? 'Anthropic did not answer within 30 seconds.'
                  : status ? `Anthropic refused the request (${status}). Its reason is shown below.`
                    // No HTTP status: a transport failure. Never the raw body — cut at the first brace.
                    : `The request failed: ${redact(String((e && e.message) || e)).replace(/\s*[{[][\s\S]*$/, '').slice(0, 160)}`;
    const said = anthropicSaid(e);
    // A key made outside any workspace is refused until the header names one. NEURO
    // does not guess a workspace id; the fix is a workspace-scoped key.
    if (said && /not scoped to a workspace/i.test(String(said.message))) {
      reason = 'Anthropic refused this key (400): it is not scoped to a workspace. Create the key inside a workspace in the Anthropic Console, then replace it here.';
    }
    const ledger = _ledgerAfter(before);
    _log({ ok: false, model: m, status: status || null, errorType: said ? said.type : null, ledger: ledger.recorded });
    return { ok: false, status: 502, model: m, error: reason, anthropic: said, httpStatus: status || null, ledger, estimateUsd, ms: d.now() - started };
  }
  const usage = r.usage || {};
  let costUsd = null;
  try { costUsd = require('./ai-cost').resolveCost(usage, m, 'anthropic').costUsd; } catch { costUsd = null; }
  const ledger = _ledgerAfter(before);
  const replied = /\bok\b/i.test(String(r.text || ''));
  _log({ ok: true, model: m, promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, costUsd, ledger: ledger.recorded });
  return { ok: true, model: m, promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, costUsd, replied, ledger, estimateUsd, ms: d.now() - started,
    say: replied ? 'Connected: Anthropic answered with this key and model.' : 'Anthropic answered with this key and model (the reply was not the expected word, but the connection works).' };
}

/**
 * Anthropic's own reason for a refusal: the error TYPE and its message, with the
 * key and anything key-shaped removed, at most 200 characters. Never the request,
 * the prompt or the raw response body. null when the failure was not an API answer.
 */
function anthropicSaid(e) {
  const body = e && (e.error || (e.response && e.response.data));
  const inner = body && (body.error || body);
  const type = inner && typeof inner.type === 'string' && inner.type !== 'error' ? inner.type : null;
  const msg = inner && typeof inner.message === 'string' ? inner.message : null;
  if (!type && !msg) return null;
  return { type: type ? type.slice(0, 60) : null, message: msg ? redact(msg).slice(0, 200) : null };
}

function _ledgerAfter(before) {
  const after = spendToday();
  if (!before || !after) return { recorded: null, say: 'The AI ledger could not be read, so NEURO cannot confirm the request was recorded.' };
  const recorded = after.requests > before.requests;
  return { recorded, requestsToday: after.requests, usdToday: after.usd, say: recorded ? 'Recorded on the shared AI ledger (class task_agent_test).' : 'Not found on the shared AI ledger.' };
}
function _log(entry) {
  // Ids, counts and outcome only — never the prompt, the reply or the key.
  try { db.logActivity('task_agent_settings', { event: 'connection-test', ...entry }); } catch { /* never fails the test */ }
}

function enabled() { return _settings().enabled === true; }
function model() { return _settings().model; }

module.exports = {
  read, save, apiKey, testConnection, testEstimate, redact, configured, enabled, model,
  claimRun, budgetOpen, guardRequest, stepUsd, runsToday, spendToday,
  attemptLimits, parseAttempt, ATTEMPT_DEFAULTS, ATTEMPT_BOUNDS,
  TaskAgentLimitError, MODELS, DEFAULTS, NOTICE, CAP_SAY, CAP_SAY_DISABLED, KEY_SAY, LIMIT_RULES, CLASSES,
  parseUsd, parseRuns, statusOf, anthropicSaid,
  _internals: { setDeps: (d) => { _deps = d ? { ...deps(), ...d } : null; }, SETTINGS_KEY, SECRET_KEY, RUNS_KEY, midnightAfter: _midnightAfter },
};
