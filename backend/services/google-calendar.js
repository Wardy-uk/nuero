'use strict';

/**
 * The shared family Google calendar (18 Oct 2026) — the one calendar the
 * family wall may WRITE to.
 *
 * Nick, 18 Oct 2026: events added on the wall go into the shared Google
 * calendar `ward.calander@gmail.com`; any event in THAT calendar can be edited
 * or deleted from the wall; every other calendar stays view-only.
 *
 * Why Google directly, and not through the phone: the family diary otherwise
 * reaches NEURO only as the iPhone's EventKit push, which is read-only and
 * arrives when the phone next wakes. Google's API writes the calendar itself,
 * so everyone subscribed sees the change, and NEURO can READ IT BACK before
 * the wall says it saved.
 *
 * ── The rules ──────────────────────────────────────────────────────────────
 * ⚠ NO CREDENTIAL IN THE REPO (it is public). The OAuth client and the refresh
 *   token live in agent_state; no route ever returns the secret or the token.
 * ⚠ Sign-in is a DESKTOP-type OAuth client with PKCE and a loopback redirect:
 *   Google sends the browser to http://127.0.0.1, which does not load, and Nick
 *   pastes that address back into Settings. That keeps every NEURO route behind
 *   the PIN — an OAuth callback would have to be an unauthenticated route on a
 *   host Tailscale Funnel publishes to the internet.
 * ⚠ The scope is `calendar.events` — events only; NEURO cannot see or change
 *   calendar settings, sharing or other people's calendars beyond events.
 * ⚠ Nothing is changed locally first. Every write goes to Google, is read back
 *   from Google, and only then is the stored copy updated.
 * ⚠ A create carries an event id NEURO made up front, so a retry after an
 *   unknown outcome cannot make a second event (Google answers 409).
 * ⚠ A sync replaces the stored window ONLY after reading every page; a failed
 *   or partial read keeps the last good copy and says why.
 * ⚠ Only events in the target calendar that NEURO has read are editable — the
 *   wall can never reach another calendar through here.
 * ⚠ READ-ONLY extra calendars (31 Oct 2026, Nick: "add my personal calendar
 *   as well" — ward.nickj@gmail.com, fine on the wall). Read on the same
 *   5-minute sync, each with its own result: one calendar failing never blanks
 *   another, and a stale one stops standing in for the phone's copy on its own.
 *   Their rows carry `editable: false`.
 *
 * Storage: `google_calendar_events` (one row per occurrence; recurring events
 * are read as single occurrences and an edit/delete touches ONLY that one).
 *
 * CommonJS — NEURO backend convention.
 */

const crypto = require('crypto');
const db = require('../db/database');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const REDIRECT_URI = 'http://127.0.0.1:8765';
const TZ = process.env.NEURO_TIMEZONE || 'Europe/London';
const DEFAULT_TARGET = 'ward.calander@gmail.com';
const DEFAULT_EXTRA = ['ward.nickj@gmail.com'];
const FRESH_MS = 6 * 3600 * 1000;
const PENDING_MS = 30 * 60 * 1000;
const BACK_DAYS = 7;
const AHEAD_DAYS = 60;
const MAX_PAGES = 20;
const WRITER = 'google.calendar.family';
const NOTE = 'Added on the family wall';

const K = {
  client: 'google_cal_client',
  token: 'google_cal_token',
  pending: 'google_cal_pending',
  target: 'google_cal_target',
  extra: 'google_cal_extra',
  sync: 'google_cal_sync',
};

let _fetch = (...a) => global.fetch(...a);
function _setFetch(f) { _fetch = f || ((...a) => global.fetch(...a)); }

function _json(key) {
  try { const v = db.getState(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function _put(key, value) { db.setState(key, value == null ? '' : JSON.stringify(value)); }

let _tableReady = false;
function _ensureTable() {
  if (_tableReady) return;
  db.run(`CREATE TABLE IF NOT EXISTS google_calendar_events (
    event_id    TEXT PRIMARY KEY,
    google_id   TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    subject     TEXT,
    start_time  TEXT NOT NULL,
    end_time    TEXT,
    is_all_day  INTEGER NOT NULL DEFAULT 0,
    location    TEXT,
    recurring   INTEGER NOT NULL DEFAULT 0,
    etag        TEXT,
    fetched_at  TEXT NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_gcal_start ON google_calendar_events(start_time)');
  _tableReady = true;
}

// ── Configuration ────────────────────────────────────────────────────────────

function client() {
  if (process.env.GOOGLE_CALENDAR_CLIENT_ID && process.env.GOOGLE_CALENDAR_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET, source: 'env' };
  }
  const c = _json(K.client);
  return c && c.clientId && c.clientSecret ? { ...c, source: 'stored' } : null;
}

function target() {
  return process.env.GOOGLE_CALENDAR_TARGET || db.getState(K.target) || DEFAULT_TARGET;
}

/** Save the OAuth client from Google Cloud. Refused, never trimmed into shape. */
function setClient({ clientId, clientSecret } = {}) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) {
    return { ok: false, error: 'That doesn’t look like a Google client ID (it ends .apps.googleusercontent.com).' };
  }
  if (secret.length < 10 || /\s/.test(secret)) return { ok: false, error: 'That doesn’t look like a client secret.' };
  _put(K.client, { clientId: id, clientSecret: secret, savedAt: new Date().toISOString() });
  // A new client invalidates the old sign-in.
  _put(K.token, null); _put(K.pending, null);
  return { ok: true };
}

function setTarget(calendarId) {
  const id = String(calendarId || '').trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(id)) return { ok: false, error: 'A Google calendar ID looks like an email address.' };
  db.setState(K.target, id);
  return { ok: true };
}

function disconnect() {
  _put(K.token, null); _put(K.pending, null);
  return { ok: true };
}

/** Read-only calendars beside the target. GOOGLE_CALENDAR_EXTRA (comma list) wins. */
function extraCalendars() {
  const env = process.env.GOOGLE_CALENDAR_EXTRA;
  const list = env != null ? env.split(',') : (_json(K.extra) || DEFAULT_EXTRA);
  const t = target();
  return [...new Set(list.map((x) => String(x || '').trim()).filter((x) => x && x !== t))];
}

/** Every calendar the sync reads: the writable target first. */
function readCalendars() { return [target(), ...extraCalendars()]; }

/** Set the read-only calendars. Refused (not trimmed) when any id is unusable. */
function setExtraCalendars(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: 'calendarIds must be a list' };
  const clean = ids.map((x) => String(x || '').trim());
  if (clean.some((x) => !x || x.length > 200 || /\s/.test(x))) return { ok: false, error: 'each calendar id must be a single word like name@gmail.com' };
  if (clean.length > 10) return { ok: false, error: 'at most 10 extra calendars' };
  _put(K.extra, [...new Set(clean)]);
  return { ok: true, calendars: extraCalendars() };
}

/** What Settings shows. Never a secret or a token. */
function status() {
  const c = client();
  const t = _json(K.token);
  const s = _json(K.sync);
  return {
    clientConfigured: !!c,
    clientSource: c ? c.source : null,
    connected: !!(t && t.refreshToken && !t.rejected),
    rejected: t && t.rejected ? t.rejected : null,
    connectedAt: t ? t.connectedAt || null : null,
    pending: !!_pendingLive(),
    target: target(),
    extra: extraCalendars(),
    lastSync: s,
  };
}

// ── Sign-in (PKCE, loopback, pasted back) ────────────────────────────────────

const _b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function _pendingLive(now = Date.now()) {
  const p = _json(K.pending);
  return p && now - Date.parse(p.at) < PENDING_MS ? p : null;
}

/** Start a sign-in: returns the Google address to open. */
function authUrl(now = Date.now()) {
  const c = client();
  if (!c) return { ok: false, error: 'Add the Google client ID and secret first.' };
  const verifier = _b64url(crypto.randomBytes(48));
  const challenge = _b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = _b64url(crypto.randomBytes(18));
  _put(K.pending, { verifier, state, at: new Date(now).toISOString() });
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return { ok: true, url: `${AUTH_URL}?${q}` };
}

/** PURE: the code (and state) out of whatever Nick pasted. */
function parsePasted(text) {
  const s = String(text || '').trim();
  if (!s) return { code: null, state: null };
  if (/^https?:\/\//i.test(s) || s.startsWith('127.0.0.1') || s.includes('code=')) {
    try {
      const u = new URL(/^https?:/i.test(s) ? s : `http://${s.replace(/^\/*/, '')}`);
      return { code: u.searchParams.get('code'), state: u.searchParams.get('state'), error: u.searchParams.get('error') };
    } catch { return { code: null, state: null }; }
  }
  return { code: s, state: null };
}

async function _tokenCall(params) {
  const res = await _fetch(TOKEN_URL, {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Finish a sign-in from the pasted address. Checks it can read the target calendar. */
async function finish(pasted, now = Date.now()) {
  const c = client();
  if (!c) return { ok: false, error: 'Add the Google client ID and secret first.' };
  const p = _pendingLive(now);
  if (!p) return { ok: false, error: 'That sign-in has expired — press “Sign in with Google” again.' };
  const { code, state, error } = parsePasted(pasted);
  if (error) return { ok: false, error: `Google said: ${error}` };
  if (!code) return { ok: false, error: 'Paste the whole address from the page Google sent you to (it starts http://127.0.0.1).' };
  if (state && state !== p.state) return { ok: false, error: 'That address is from a different sign-in — press “Sign in with Google” again.' };
  const r = await _tokenCall({
    grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: REDIRECT_URI,
  });
  if (r.status !== 200 || !r.json.access_token) {
    return { ok: false, error: `Google refused the sign-in (${r.json.error_description || r.json.error || r.status}).` };
  }
  if (!r.json.refresh_token) return { ok: false, error: 'Google gave no long-lived sign-in. Remove NEURO’s access in your Google account and try again.' };
  _put(K.token, {
    refreshToken: r.json.refresh_token, accessToken: r.json.access_token,
    expiresAt: new Date(now + (Number(r.json.expires_in) || 3600) * 1000).toISOString(),
    scope: r.json.scope || SCOPE, connectedAt: new Date(now).toISOString(),
  });
  _put(K.pending, null);
  const sync = await syncNow().catch((e) => ({ ok: false, error: e.message }));
  if (!sync.ok) return { ok: true, warning: `Signed in, but the calendar could not be read yet: ${sync.error}`, status: status() };
  return { ok: true, events: sync.count, status: status() };
}

async function _accessToken(now = Date.now()) {
  const c = client();
  const t = _json(K.token);
  if (!c) throw new Error('Google is not set up');
  if (!t || !t.refreshToken) throw new Error('not signed in to Google');
  if (t.rejected) throw new Error(`Google sign-in was refused (${t.rejected}) — sign in again in Settings`);
  if (t.accessToken && Date.parse(t.expiresAt) - now > 60 * 1000) return t.accessToken;
  const r = await _tokenCall({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
  if (r.status !== 200 || !r.json.access_token) {
    if (r.json && r.json.error === 'invalid_grant') {
      _put(K.token, { ...t, accessToken: null, rejected: 'invalid_grant' });
      throw new Error('Google sign-in has expired — sign in again in Settings');
    }
    throw new Error(`Google token refresh failed (${r.json.error || r.status})`);
  }
  _put(K.token, { ...t, accessToken: r.json.access_token, expiresAt: new Date(now + (Number(r.json.expires_in) || 3600) * 1000).toISOString() });
  return r.json.access_token;
}

async function _api(method, path, { query = null, body = null } = {}) {
  const token = await _accessToken();
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await _fetch(url, {
    // Google that never answers must not hold the wall's "Saving…" open.
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

const _calPath = (cal = target()) => `/calendars/${encodeURIComponent(cal)}`;

// ── Shapes (PURE) ────────────────────────────────────────────────────────────

const _p2 = (n) => String(n).padStart(2, '0');

/** A Google dateTime is already in Europe/London (timeZone=…): slice, never parse. */
function _wall(dt) { return String(dt || '').slice(0, 19) || null; }

/** One Google event as a stored row. PURE. Cancelled → null. */
function fromGoogle(ev, calendarId = null) {
  if (!ev || !ev.id || ev.status === 'cancelled') return null;
  const allDay = !!(ev.start && ev.start.date);
  const start = allDay ? `${ev.start.date}T00:00:00` : _wall(ev.start && ev.start.dateTime);
  if (!start) return null;
  const end = allDay ? (ev.end && ev.end.date ? `${ev.end.date}T00:00:00` : null) : _wall(ev.end && ev.end.dateTime);
  return {
    event_id: `google:${ev.id}`,
    google_id: ev.id,
    calendar_id: calendarId,
    subject: ev.summary ? String(ev.summary).slice(0, 400) : '(no title)',
    start_time: start,
    end_time: end,
    is_all_day: allDay ? 1 : 0,
    location: ev.location ? String(ev.location).slice(0, 200) : null,
    recurring: ev.recurringEventId ? 1 : 0,
    etag: ev.etag || null,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
function _validDate(s) {
  if (!DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function _addDay(s, n = 1) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${_p2(t.getUTCMonth() + 1)}-${_p2(t.getUTCDate())}`;
}

/**
 * What the wall sent, checked. PURE. Refused, never repaired.
 * { title, date, allDay, start 'HH:MM', end 'HH:MM', endDate?, location? }
 */
function validateDraft(d = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || 'title' in d) {
    const title = String(d.title || '').trim();
    if (!title) return { ok: false, error: 'Give the event a name.' };
    if (title.length > 200) return { ok: false, error: 'That name is too long.' };
    out.title = title;
  }
  if (!partial || 'date' in d || 'allDay' in d || 'start' in d || 'end' in d) {
    const date = String(d.date || '');
    if (!_validDate(date)) return { ok: false, error: 'Pick a day.' };
    out.date = date;
    out.allDay = d.allDay === true;
    if (out.allDay) {
      const endDate = d.endDate ? String(d.endDate) : date;
      if (!_validDate(endDate) || endDate < date) return { ok: false, error: 'The last day can’t be before the first.' };
      out.endDate = endDate;
    } else {
      if (!HM.test(String(d.start || ''))) return { ok: false, error: 'Pick a start time.' };
      const end = d.end ? String(d.end) : null;
      if (end && !HM.test(end)) return { ok: false, error: 'Pick an end time.' };
      out.start = d.start;
      out.end = end && end > d.start ? end : null;
      if (end && end <= d.start) return { ok: false, error: 'It has to end after it starts.' };
    }
  }
  if ('location' in d) out.location = d.location ? String(d.location).trim().slice(0, 200) : '';
  return { ok: true, draft: out };
}

/** The Google body for a draft. PURE. A timed event with no end lasts an hour. */
function toGoogle(draft) {
  const body = {};
  if ('title' in draft) body.summary = draft.title;
  if ('location' in draft) body.location = draft.location;
  if ('date' in draft) {
    if (draft.allDay) {
      body.start = { date: draft.date };
      body.end = { date: _addDay(draft.endDate || draft.date) }; // Google's end date is EXCLUSIVE
    } else {
      let end = draft.end;
      if (!end) {
        const [h, m] = draft.start.split(':').map(Number);
        const mins = Math.min(h * 60 + m + 60, 23 * 60 + 59);
        end = `${_p2(Math.floor(mins / 60))}:${_p2(mins % 60)}`;
      }
      body.start = { dateTime: `${draft.date}T${draft.start}:00`, timeZone: TZ };
      body.end = { dateTime: `${draft.date}T${end}:00`, timeZone: TZ };
    }
  }
  return body;
}

/** Google event ids: base32hex (a–v, 0–9), 5–1024 chars. PURE. */
function newEventId() {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  const bytes = crypto.randomBytes(26);
  return `neu${Array.from(bytes, (b) => alphabet[b % 32]).join('')}`; // 'neu': every letter is base32hex (a 'w' is not)
}
const ID_RE = /^[a-v0-9]{5,1024}$/;
const GID_RE = /^[A-Za-z0-9_]{5,1024}$/;

function _saveRow(row) {
  _ensureTable();
  db.run(`INSERT OR REPLACE INTO google_calendar_events
    (event_id, google_id, calendar_id, subject, start_time, end_time, is_all_day, location, recurring, etag, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  [row.event_id, row.google_id, row.calendar_id, row.subject, row.start_time, row.end_time, row.is_all_day, row.location, row.recurring, row.etag]);
}

function _localKey(t) { return `${t.getFullYear()}-${_p2(t.getMonth() + 1)}-${_p2(t.getDate())}`; }

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Re-read the window from Google. Replaces the stored window only after every
 * page answered; otherwise the last good copy stays and the failure is recorded.
 */
async function syncNow(now = Date.now()) {
  _ensureTable();
  if (!status().connected) return { ok: false, skipped: true, error: 'not signed in to Google' };
  const base = new Date(now);
  const from = new Date(base.getFullYear(), base.getMonth(), base.getDate() - BACK_DAYS);
  const to = new Date(base.getFullYear(), base.getMonth(), base.getDate() + AHEAD_DAYS);
  const fromKey = `${_localKey(from)}T00:00:00`;
  const toKey = `${_localKey(to)}T23:59:59`;
  const at = new Date(now).toISOString();
  const prev = _json(K.sync) || {};
  const prevCals = prev.calendars || {};
  const calendars = {};
  for (const cal of readCalendars()) {
    const r = await _readCalendar(cal, from, to);
    if (!r.ok) {
      // The target's last good read also lives at the top level (older records).
      const lastGoodAt = (prevCals[cal] || {}).lastGoodAt || (cal === target() ? prev.lastGoodAt || null : null);
      calendars[cal] = { ok: false, error: r.error, lastGoodAt };
      continue;
    }
    db.batchSaves(() => {
      db.run('DELETE FROM google_calendar_events WHERE calendar_id = ? AND start_time >= ? AND start_time <= ?', [cal, fromKey, toKey]);
      for (const row of r.rows) _saveRow(row);
    });
    calendars[cal] = { ok: true, count: r.rows.length, lastGoodAt: at };
  }
  const t = calendars[target()];
  const failed = Object.entries(calendars).filter(([, c]) => !c.ok);
  const error = failed.length ? failed.map(([cal, c]) => `${cal}: ${c.error}`).join('; ') : null;
  const count = Object.values(calendars).reduce((n, c) => n + (c.count || 0), 0);
  _put(K.sync, { at, ok: !failed.length, count, error, lastGoodAt: t.lastGoodAt, calendars });
  return failed.length ? { ok: false, error, count, calendars } : { ok: true, count, calendars };
}

/** Read one calendar's window, every page, or say why not. */
async function _readCalendar(cal, from, to) {
  const rows = [];
  let pageToken = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = {
        timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime',
        timeZone: TZ, maxResults: '250', ...(pageToken ? { pageToken } : {}),
      };
      const r = await _api('GET', `${_calPath(cal)}/events`, { query });
      if (r.status === 404) throw new Error(`Google cannot find the calendar ${cal} for this account`);
      if (r.status === 403) throw new Error(`this Google account may not read ${cal}`);
      if (r.status !== 200 || !r.json) throw new Error(`Google answered ${r.status}`);
      for (const ev of r.json.items || []) { const row = fromGoogle(ev, cal); if (row) rows.push(row); }
      pageToken = r.json.nextPageToken || null;
      if (!pageToken) break;
      if (page === MAX_PAGES - 1) throw new Error('too many pages — not every event was read');
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, rows };
}

/** The calendars whose stored copy is recent enough to stand in for the phone's. */
function freshCalendars(now = Date.now()) {
  const s = _json(K.sync) || {};
  const cals = s.calendars || (s.lastGoodAt ? { [target()]: { lastGoodAt: s.lastGoodAt } } : {});
  return readCalendars().filter((cal) => {
    const c = cals[cal];
    return !!(c && c.lastGoodAt && now - Date.parse(c.lastGoodAt) < FRESH_MS);
  });
}

/** Stored rows in calendar_cache's shape, for the wall. Never a network call. */
function rowsBetween(fromIso, toIso, now = Date.now()) {
  _ensureTable();
  const cals = freshCalendars(now);
  if (!cals.length) return [];
  const t = target();
  return db.all(`SELECT * FROM google_calendar_events WHERE calendar_id IN (${cals.map(() => '?').join(',')}) AND start_time >= ? AND start_time <= ? ORDER BY start_time`,
    [...cals, fromIso, toIso]).map((r) => ({
    event_id: r.event_id, subject: r.subject, start_time: r.start_time, end_time: r.end_time, is_all_day: r.is_all_day,
    location: r.location, show_as: r.is_all_day ? 'free' : 'busy', source: 'google', editable: r.calendar_id === t,
    calendar: r.calendar_id, recurring: !!r.recurring, google_id: r.google_id,
  }));
}

/** Is the stored copy recent enough to stand in for the phone's copy? */
function fresh(now = Date.now()) {
  return freshCalendars(now).length > 0;
}

function _held(googleId) {
  _ensureTable();
  return db.get('SELECT * FROM google_calendar_events WHERE google_id = ? AND calendar_id = ?', [googleId, target()]);
}

// ── Writing ──────────────────────────────────────────────────────────────────

function _ledger() { return require('./external-writes'); }

async function _readBack(googleId) {
  const r = await _api('GET', `${_calPath()}/events/${encodeURIComponent(googleId)}`, { query: { timeZone: TZ } });
  return r;
}

function _matches(row, draft) {
  if ('title' in draft && row.subject !== draft.title) return false;
  if ('date' in draft) {
    if (String(row.start_time).slice(0, 10) !== draft.date) return false;
    if (!draft.allDay && String(row.start_time).slice(11, 16) !== draft.start) return false;
    if (!!row.is_all_day !== !!draft.allDay) return false;
  }
  return true;
}

/** Add an event to the shared calendar. `id` is the wall's own, so a retry cannot duplicate. */
async function createEvent(input = {}, { by = 'wall' } = {}) {
  const v = validateDraft(input);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  if (!status().connected) return { ok: false, status: 503, error: 'The family calendar isn’t connected yet.' };
  // An id the wall sent but Google would refuse is refused here, never swapped
  // for a fresh one — a swapped id would let a retry make a second event.
  if (input.id != null && !ID_RE.test(String(input.id))) return { ok: false, status: 400, error: 'Bad event id.' };
  const id = input.id ? String(input.id) : newEventId();
  const ext = _ledger();
  const claim = ext.begin({ writer: WRITER, key: `gcal:create:${id}`, target: target(), request: { op: 'create', id, ...v.draft }, initiatedBy: by });
  if (!claim.ok && claim.duplicate) {
    const held = _held(id);
    return { ok: true, already: true, event: held ? rowsBetween(held.start_time, held.start_time).find((r) => r.google_id === id) : null };
  }
  if (!claim.ok && !claim.duplicate && claim.refused) return { ok: false, status: 500, error: claim.why };
  const body = { id, ...toGoogle(v.draft), description: NOTE, extendedProperties: { private: { neuroWall: '1' } } };
  let r;
  try {
    r = await _api('POST', `${_calPath()}/events`, { body });
  } catch (e) {
    ext.settle(claim.entry.id, { status: ext.classifyError(e), result: { error: e.message } });
    return { ok: false, status: 502, error: `Google didn’t answer — it may not have saved. ${e.message}` };
  }
  if (r.status !== 200 && r.status !== 409) {
    const status4 = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
    ext.settle(claim.entry.id, { status: status4 ? 'failed' : 'uncertain', result: { status: r.status } });
    return { ok: false, status: 502, error: `Google refused it (${(r.json && r.json.error && r.json.error.message) || r.status}).` };
  }
  return _confirm(claim.entry.id, id, v.draft, 'created');
}

async function _confirm(ledgerId, googleId, draft, verb) {
  const ext = _ledger();
  let back;
  try { back = await _readBack(googleId); } catch (e) {
    ext.settle(ledgerId, { status: 'applied-unverified', readback: `read-back failed: ${e.message}` });
    return { ok: false, status: 502, error: 'Google took it but I couldn’t read it back to check. Refresh in a minute.' };
  }
  const row = back.status === 200 ? fromGoogle(back.json, target()) : null;
  if (!row || !_matches(row, draft)) {
    ext.settle(ledgerId, { status: 'uncertain', readback: `read-back ${back.status} did not match` });
    return { ok: false, status: 502, error: 'Google didn’t hold what was sent. Check the calendar before trying again.' };
  }
  _saveRow(row);
  ext.settle(ledgerId, { status: 'confirmed', readback: `read back ${verb}` });
  return { ok: true, [verb]: true, event: rowsBetween(row.start_time, row.start_time).find((x) => x.google_id === googleId) || null };
}

/** Edit an event in the shared calendar (this occurrence only). */
async function updateEvent(googleId, input = {}, { by = 'wall' } = {}) {
  if (!GID_RE.test(String(googleId || ''))) return { ok: false, status: 400, error: 'Unknown event.' };
  const held = _held(googleId);
  if (!held) return { ok: false, status: 404, error: 'That event isn’t in the family calendar.' };
  const v = validateDraft(input, { partial: true });
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  if (!Object.keys(v.draft).length) return { ok: false, status: 400, error: 'Nothing to change.' };
  const ext = _ledger();
  const req = crypto.createHash('sha1').update(JSON.stringify(v.draft)).digest('hex').slice(0, 12);
  const claim = ext.begin({ writer: WRITER, key: `gcal:edit:${googleId}:${input.requestId || req}:${Date.now()}`, target: target(), request: { op: 'edit', googleId, ...v.draft }, initiatedBy: by });
  if (!claim.ok) return { ok: false, status: 500, error: claim.why };
  let r;
  try {
    r = await _api('PATCH', `${_calPath()}/events/${encodeURIComponent(googleId)}`, { body: toGoogle(v.draft) });
  } catch (e) {
    ext.settle(claim.entry.id, { status: ext.classifyError(e), result: { error: e.message } });
    return { ok: false, status: 502, error: `Google didn’t answer — it may not have changed. ${e.message}` };
  }
  if (r.status !== 200) {
    ext.settle(claim.entry.id, { status: r.status >= 400 && r.status < 500 ? 'failed' : 'uncertain', result: { status: r.status } });
    if (r.status === 404 || r.status === 410) { db.run('DELETE FROM google_calendar_events WHERE google_id = ?', [googleId]); return { ok: false, status: 404, error: 'That event has gone from the calendar.' }; }
    return { ok: false, status: 502, error: `Google refused the change (${(r.json && r.json.error && r.json.error.message) || r.status}).` };
  }
  return _confirm(claim.entry.id, googleId, v.draft, 'updated');
}

/** Delete an event from the shared calendar (this occurrence only). */
async function deleteEvent(googleId, { by = 'wall' } = {}) {
  if (!GID_RE.test(String(googleId || ''))) return { ok: false, status: 400, error: 'Unknown event.' };
  const held = _held(googleId);
  if (!held) return { ok: false, status: 404, error: 'That event isn’t in the family calendar.' };
  const ext = _ledger();
  const claim = ext.begin({ writer: WRITER, key: `gcal:delete:${googleId}`, target: target(), request: { op: 'delete', googleId, title: held.subject }, initiatedBy: by });
  if (!claim.ok && claim.duplicate) { db.run('DELETE FROM google_calendar_events WHERE google_id = ?', [googleId]); return { ok: true, deleted: true, already: true }; }
  if (!claim.ok && claim.refused) return { ok: false, status: 500, error: claim.why };
  let r;
  try { r = await _api('DELETE', `${_calPath()}/events/${encodeURIComponent(googleId)}`); } catch (e) {
    ext.settle(claim.entry.id, { status: ext.classifyError(e), result: { error: e.message } });
    return { ok: false, status: 502, error: `Google didn’t answer — it may not have been deleted. ${e.message}` };
  }
  if (![200, 204, 404, 410].includes(r.status)) {
    ext.settle(claim.entry.id, { status: r.status >= 400 && r.status < 500 ? 'failed' : 'uncertain', result: { status: r.status } });
    return { ok: false, status: 502, error: `Google refused to delete it (${r.status}).` };
  }
  let back;
  try { back = await _readBack(googleId); } catch (e) {
    ext.settle(claim.entry.id, { status: 'applied-unverified', readback: `read-back failed: ${e.message}` });
    return { ok: false, status: 502, error: 'Google took the delete but I couldn’t check it. Refresh in a minute.' };
  }
  const gone = back.status === 404 || back.status === 410 || (back.status === 200 && back.json && back.json.status === 'cancelled');
  if (!gone) {
    ext.settle(claim.entry.id, { status: 'uncertain', readback: `read-back ${back.status}: still there` });
    return { ok: false, status: 502, error: 'Google still has the event. Check the calendar before trying again.' };
  }
  db.run('DELETE FROM google_calendar_events WHERE google_id = ?', [googleId]);
  ext.settle(claim.entry.id, { status: 'confirmed', readback: 'read back gone' });
  return { ok: true, deleted: true };
}

module.exports = {
  SCOPE, REDIRECT_URI, DEFAULT_TARGET, DEFAULT_EXTRA, WRITER,
  client, target, setClient, setTarget, disconnect, status,
  extraCalendars, readCalendars, setExtraCalendars, freshCalendars,
  authUrl, parsePasted, finish,
  fromGoogle, validateDraft, toGoogle, newEventId,
  syncNow, rowsBetween, fresh,
  createEvent, updateEvent, deleteEvent,
  _setFetch, _ensureTable,
};
