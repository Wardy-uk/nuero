'use strict';

/**
 * energy-glowmarkt — the Bright / Glowmarkt adapter. Talks to the API and
 * nothing else: no storage of readings, no judgement. services/energy.js owns
 * the history.
 *
 * API (individual Bright user, docs v1.8, 9 Apr 2026, + resourcesys swagger):
 *   POST /api/v0-1/auth                       { username, password } → { valid, token, exp }
 *   GET  /api/v0-1/virtualentity              → [ { veId, resources:[{resourceId,resourceTypeId}] } ]
 *   GET  /api/v0-1/virtualentity/:ve/resources → { resources:[{ resourceId, classifier, baseUnit, ... }] }
 *   GET  /api/v0-1/resource/:id/readings?from&to&period&function=sum&offset=0&nulls=1
 *   GET  /api/v0-1/resource/:id/first-time | last-time  → { data:{ firstTs | lastTs } }
 *   GET  /api/v0-1/resource/:id/tariff-list → { data:[ { plan:[{planDetail:[...]}], effectiveDate|from, ... } ] }
 *   GET  /api/v0-1/resource/:id/catchup      → asks Bright to fetch the latest DCC half-hours (async)
 *
 * ⚠ THERE IS NO REFRESH TOKEN. The JWT expires after 7 days (`exp`, epoch s);
 * the only way to a new one is the username + password. Nick chose (17 Oct
 * 2026) to keep them on the Pi, so this re-authenticates itself a day before
 * expiry — and on a 401 mid-session, once.
 *
 * ⚠ A REJECTED LOGIN STOPS ALL FURTHER LOGINS until the credentials change.
 * Retrying a wrong password on a timer is how an account gets locked; the
 * state is recorded (`bright_auth_state`) and every caller is told `blocked`.
 *
 * ⚠ The password and the token never leave this module: no route returns them,
 * nothing logs them. `credentialSource()` says WHERE they come from, never what
 * they are.
 */

const BASE = 'https://api.glowmarkt.com/api/v0-1';
// Bright's own application id — the docs name it for individual users.
const APPLICATION_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';

const K_CREDS = 'bright_credentials';
const K_TOKEN = 'bright_token';
const K_AUTH = 'bright_auth_state';

const RENEW_BEFORE_S = 24 * 3600;        // renew a day before expiry
const TIMEOUT_MS = 30 * 1000;

// Per-period window limits (docs, "limit in days"). PT30M: 10 days.
const PERIOD_LIMIT_DAYS = Object.freeze({ PT30M: 10, PT1H: 31, P1D: 31 });

class GlowError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || null; }
}

function _db() { return require('../db/database'); }
function _getJson(k) { try { const v = _db().getState(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function _setJson(k, v) { _db().setState(k, v == null ? '' : JSON.stringify(v)); }

// ── Credentials ──────────────────────────────────────────────────────────────

function credentials(env = process.env) {
  if (env.BRIGHT_USERNAME && env.BRIGHT_PASSWORD) return { username: env.BRIGHT_USERNAME, password: env.BRIGHT_PASSWORD, source: 'env' };
  const c = _getJson(K_CREDS);
  return c && c.username && c.password ? { username: c.username, password: c.password, source: 'stored' } : null;
}

function credentialSource(env = process.env) { const c = credentials(env); return c ? c.source : null; }

/** PURE shape check. An email-shaped username and a non-empty password. */
function validateCredentials(username, password) {
  const u = typeof username === 'string' ? username.trim() : '';
  if (!u || u.length > 254) return { ok: false, reason: 'Enter your Bright username (the email you signed up with).' };
  if (typeof password !== 'string' || !password.length || password.length > 512) return { ok: false, reason: 'Enter your Bright password.' };
  return { ok: true, username: u, password };
}

function _storeCredentials(username, password) {
  _setJson(K_CREDS, { username, password, setAt: Date.now() });
  _setJson(K_TOKEN, null);
  _setJson(K_AUTH, null); // new credentials lift a previous rejection
}

function clearCredentials(env = process.env) {
  _setJson(K_CREDS, null);
  _setJson(K_TOKEN, null);
  _setJson(K_AUTH, null);
  return { ok: true, stillInEnv: !!(env.BRIGHT_USERNAME && env.BRIGHT_PASSWORD) };
}

/** What the screen may know about the connection. Never a secret. */
function authState(env = process.env) {
  const tok = _getJson(K_TOKEN);
  const st = _getJson(K_AUTH) || {};
  return {
    configured: !!credentials(env),
    credentialSource: credentialSource(env),
    state: st.state || (tok && tok.exp ? 'ok' : 'unknown'),
    reason: st.reason || null,
    lastAuthAt: st.at || null,
    tokenExpiresAt: tok && tok.exp ? tok.exp * 1000 : null,
  };
}

/** Why a sync cannot run, or null. Jobs record this as `blocked`, not failed. */
function blockedReason(env = process.env) {
  if (!credentials(env)) return 'not-connected';
  const st = _getJson(K_AUTH);
  if (st && st.state === 'rejected') return 'login-rejected';
  return null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function _fetch(url, init, opts) {
  const f = opts.fetchImpl || fetch;
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new GlowError(timeout ? 'timeout' : 'network', timeout ? 'Bright did not answer in time' : `could not reach Bright (${e.message})`);
  }
}

/**
 * Log in. A 401/403, or a 200 with `valid:false`, is a REJECTION and is
 * recorded so nothing retries it. Anything else is a transient failure.
 */
async function login(opts = {}) {
  const env = opts.env || process.env;
  const c = opts.credentials || credentials(env);
  if (!c) throw new GlowError('not-connected', 'Bright is not connected');
  const res = await _fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', applicationId: APPLICATION_ID },
    body: JSON.stringify({ username: c.username, password: c.password }),
  }, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const nowMs = opts.nowMs || Date.now();
  if (res.status === 401 || res.status === 403 || (res.ok && body && body.valid === false)) {
    if (!opts.dryRun) _setJson(K_AUTH, { state: 'rejected', reason: 'Bright refused the username or password', at: nowMs });
    throw new GlowError('auth', 'Bright refused the username or password', res.status);
  }
  if (!res.ok || !body || typeof body.token !== 'string' || !body.token) {
    throw new GlowError(res.status === 429 ? 'rate-limited' : 'http', `Bright login answered HTTP ${res.status}`, res.status);
  }
  const exp = Number.isFinite(body.exp) ? body.exp : Math.floor(nowMs / 1000) + 7 * 86400;
  if (!opts.dryRun) {
    _setJson(K_TOKEN, { token: body.token, exp });
    _setJson(K_AUTH, { state: 'ok', at: nowMs });
  }
  return { token: body.token, exp };
}

/** A usable token: the cached one unless it expires within a day. */
async function token(opts = {}) {
  const nowS = Math.floor((opts.nowMs || Date.now()) / 1000);
  const t = _getJson(K_TOKEN);
  if (!opts.force && t && t.token && Number.isFinite(t.exp) && t.exp - nowS > RENEW_BEFORE_S) return t.token;
  const blocked = blockedReason(opts.env || process.env);
  if (blocked && !opts.credentials) throw new GlowError(blocked === 'login-rejected' ? 'auth' : 'not-connected', blocked);
  return (await login(opts)).token;
}

/**
 * Authenticated GET. One re-login on a 401 (a token revoked early), bounded
 * retry on 429/5xx/network, never on another 4xx.
 */
async function get(path, opts = {}) {
  const attempts = opts.attempts || 3;
  const delays = opts.delays || [2000, 8000];
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let reauthed = false;
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const tok = await token({ ...opts, force: false });
      const res = await _fetch(`${BASE}${path}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', applicationId: APPLICATION_ID, token: tok },
      }, opts);
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        _setJson(K_TOKEN, null);
        i--; // the re-login is not a retry
        continue;
      }
      if (res.status === 401) throw new GlowError('auth', 'Bright refused the session after a fresh login', 401);
      if (res.status === 404) throw new GlowError('not-found', `Bright has no ${path}`, 404);
      if (res.status === 429) { last = new GlowError('rate-limited', 'Bright asked us to slow down', 429); }
      else if (res.status >= 500) { last = new GlowError('http', `Bright answered HTTP ${res.status}`, res.status); }
      else if (!res.ok) throw new GlowError('http', `Bright answered HTTP ${res.status}`, res.status);
      else return await res.json();
    } catch (e) {
      if (e instanceof GlowError && ['auth', 'not-connected', 'not-found'].includes(e.code)) throw e;
      if (e instanceof GlowError && e.code === 'http' && e.status && e.status < 500) throw e;
      last = e;
    }
    if (i < attempts - 1) await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  throw last;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** PURE. Which fuel/kind a classifier is, or null for anything we do not use. */
function classify(classifier) {
  const c = String(classifier || '').toLowerCase();
  const m = /^(electricity|gas)\.consumption(\.cost)?$/.exec(c);
  if (!m) return null;
  return { fuel: m[1], kind: m[2] ? 'cost' : 'consumption' };
}

/** Every electricity/gas consumption + cost resource the account can see. */
async function discover(opts = {}) {
  const ves = await get('/virtualentity', opts);
  if (!Array.isArray(ves)) throw new GlowError('shape', 'Bright answered the entity list in a shape NEURO does not understand');
  const out = [];
  const ignored = [];
  for (const ve of ves) {
    if (!ve || !ve.veId) continue;
    const full = await get(`/virtualentity/${encodeURIComponent(ve.veId)}/resources`, opts);
    for (const r of (full && Array.isArray(full.resources) ? full.resources : [])) {
      const k = classify(r.classifier);
      if (!k || !r.resourceId) { ignored.push(r.classifier || '(no classifier)'); continue; }
      out.push({ resourceId: r.resourceId, veId: ve.veId, ...k, classifier: r.classifier, name: r.name || null, baseUnit: r.baseUnit || null, active: r.active !== false });
    }
  }
  return { resources: out, ignored };
}

// ── Readings ─────────────────────────────────────────────────────────────────

/** PURE. A UTC instant as Glowmarkt's `yyyy-mm-ddThh:mm:ss` (offset=0 → UTC). */
function apiTime(ms) {
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * Readings for [fromMs, toMs). Asked in UTC (offset=0) with nulls=1, so a slot
 * Bright has no data for comes back null rather than as a zero.
 * Returns { units, rows:[{ startTs (epoch s), value|null }] }.
 */
async function readings(resourceId, fromMs, toMs, opts = {}) {
  const period = opts.period || 'PT30M';
  const limit = PERIOD_LIMIT_DAYS[period];
  if (limit && toMs - fromMs > limit * 86400 * 1000) throw new GlowError('window', `a ${period} request may span at most ${limit} days`);
  const q = `from=${apiTime(fromMs)}&to=${apiTime(toMs - 1000)}&period=${period}&function=sum&offset=0&nulls=1`;
  const body = await get(`/resource/${encodeURIComponent(resourceId)}/readings?${q}`, opts);
  if (!body || !Array.isArray(body.data)) throw new GlowError('shape', 'Bright answered readings in a shape NEURO does not understand');
  const rows = [];
  for (const pair of body.data) {
    if (!Array.isArray(pair) || pair.length < 2 || !Number.isFinite(Number(pair[0]))) continue;
    const v = pair[1];
    rows.push({ startTs: Number(pair[0]), value: v == null || !Number.isFinite(Number(v)) ? null : Number(v) });
  }
  return { units: body.units || null, rows };
}

async function firstTime(resourceId, opts = {}) {
  const b = await get(`/resource/${encodeURIComponent(resourceId)}/first-time`, opts);
  const t = b && b.data && Number(b.data.firstTs);
  return Number.isFinite(t) && t > 0 ? t : null;
}

async function lastTime(resourceId, opts = {}) {
  const b = await get(`/resource/${encodeURIComponent(resourceId)}/last-time`, opts);
  const t = b && b.data && Number(b.data.lastTs);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Ask Bright to pull the latest half-hours from the DCC (async on their side). */
async function catchup(resourceId, opts = {}) {
  const b = await get(`/resource/${encodeURIComponent(resourceId)}/catchup`, opts);
  return !!(b && b.data && b.data.valid);
}

async function tariffList(resourceId, opts = {}) {
  const b = await get(`/resource/${encodeURIComponent(resourceId)}/tariff-list`, opts);
  return b && Array.isArray(b.data) ? b.data : [];
}

/**
 * The one-time connection: log in with the GIVEN credentials, discover, and
 * only then store them. A wrong password is refused here and nothing is kept.
 */
async function connect(username, password, opts = {}) {
  const v = validateCredentials(username, password);
  if (!v.ok) return { ok: false, error: v.reason };
  const creds = { username: v.username, password: v.password, source: 'stored' };
  let tok;
  try {
    tok = await login({ ...opts, credentials: creds, dryRun: true });
  } catch (e) {
    return { ok: false, error: e.code === 'auth' ? 'Bright refused that username or password.' : `Could not reach Bright: ${e.message}` };
  }
  _storeCredentials(v.username, v.password);
  _setJson(K_TOKEN, { token: tok.token, exp: tok.exp });
  _setJson(K_AUTH, { state: 'ok', at: opts.nowMs || Date.now() });
  const found = await discover(opts);
  return { ok: true, resources: found.resources.map(({ resourceId, fuel, kind, baseUnit }) => ({ resourceId, fuel, kind, baseUnit })), ignored: found.ignored };
}

module.exports = {
  BASE, APPLICATION_ID, PERIOD_LIMIT_DAYS, GlowError,
  credentials, credentialSource, validateCredentials, clearCredentials, authState, blockedReason,
  login, token, get, classify, discover, apiTime, readings, firstTime, lastTime, catchup, tariffList, connect,
  _keys: { K_CREDS, K_TOKEN, K_AUTH },
};
