'use strict';

/**
 * When NEURO's Microsoft sign-in is due again (27 Oct 2026).
 *
 * Nurtur's conditional access now forces a fresh interactive sign-in about once a
 * day, in or out of the office. The refresh token stops working on Microsoft's
 * clock, not ours, so NEURO only finds out when a sync fails — and the only route
 * back was Settings → Microsoft 365 Authentication.
 *
 * This remembers each sign-in and the moment the next one was refused, learns the
 * real window from those pairs, and says — before it breaks — that a sign-in is
 * due. The menu shows a button for it (Nick's call: a menu item, not a banner).
 *
 * `assess` is PURE. The store is two lists in `agent_state.ms_signin_history`;
 * nothing else is kept, and no token or account detail is stored.
 */

const KEY = 'ms_signin_history';
const KEEP = 20;

// Microsoft's "sign in again" family: expired/revoked refresh token (70043,
// 700082), conditional access / MFA (50076, 50079, 50173, 50078), consent
// (65001), interaction needed. A plain network blip is NOT one of these.
// The one definition — the watchdog's alert reads it from here.
const SIGN_IN_ERROR = /invalid_grant|interaction_required|AADSTS(70043|700082|50173|50076|50078|50079|65001)\b|refresh token has expired/i;

// Nick, 27 Oct 2026: "the re-auth is now a daily requirement". Used until two
// measured windows exist; every read says whether the window is measured.
const ASSUMED_WINDOW_HOURS = 24;
// The menu item appears this long before the expected expiry.
const DUE_WITHIN_HOURS = 3;
// A measured window outside these bounds is not a sign-in window (a restart that
// lost the error, a sign-in done weeks ago) and is ignored.
const MIN_WINDOW_H = 1;
const MAX_WINDOW_H = 24 * 30;

const HOUR = 3600 * 1000;

function _iso(ms) { return new Date(ms).toISOString(); }
function _ms(v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }

/** PURE. Is this token error Microsoft asking for a new sign-in (not a blip)? */
function isSignInError(err) {
  return Boolean(err) && SIGN_IN_ERROR.test(String(err));
}

/** PURE. The windows (hours) between each sign-in and the refusal that ended it. */
function measuredWindows(history) {
  const out = [];
  for (const e of (history && history.expiries) || []) {
    const a = _ms(e.signedInAt);
    const b = _ms(e.at);
    if (a == null || b == null) continue;
    const h = (b - a) / HOUR;
    if (h >= MIN_WINDOW_H && h <= MAX_WINDOW_H) out.push(h);
  }
  return out.slice(-5);
}

function _median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * PURE. Where the sign-in stands.
 *  state: 'expired' (Microsoft refused the last refresh) / 'due' (within
 *  DUE_WITHIN_HOURS of the expected expiry, or past it without a refusal yet) /
 *  'ok' / 'unknown' (no sign-in recorded since this started, and nothing refused).
 *  An unknown state shows no button: there is nothing to predict from, and the
 *  refusal itself still raises 'expired' within one sync.
 */
function assess({ history = {}, lastTokenError = null, now = Date.now() } = {}) {
  const signIns = (history.signIns || []).map(_ms).filter((t) => t != null).sort((a, b) => a - b);
  const signedInAt = signIns.length ? signIns[signIns.length - 1] : null;
  const windows = measuredWindows(history);
  const measured = windows.length >= 2;
  const windowHours = measured ? Math.round(_median(windows) * 10) / 10 : ASSUMED_WINDOW_HOURS;
  const expectedExpiryAt = signedInAt != null ? signedInAt + windowHours * HOUR : null;

  let state;
  if (isSignInError(lastTokenError)) state = 'expired';
  else if (expectedExpiryAt == null) state = 'unknown';
  else if (now >= expectedExpiryAt - DUE_WITHIN_HOURS * HOUR) state = 'due';
  else state = 'ok';

  const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  let say;
  if (state === 'expired') say = 'Microsoft sign-in has expired. Calendar, Tasks and work email are paused until you sign in.';
  else if (state === 'due') say = expectedExpiryAt > now
    ? `Microsoft sign-in is due — it is expected to expire about ${hhmm(expectedExpiryAt)}. Signing in now resets it.`
    : 'Microsoft sign-in is due — it was expected to expire by now. Signing in now resets it.';
  else if (state === 'ok') say = `Signed in. Next sign-in expected about ${hhmm(expectedExpiryAt)}.`;
  else say = 'No Microsoft sign-in recorded yet, so NEURO cannot say when the next is due.';

  return {
    state,
    showInMenu: state === 'expired' || state === 'due',
    signedInAt: signedInAt != null ? _iso(signedInAt) : null,
    expectedExpiryAt: expectedExpiryAt != null ? _iso(expectedExpiryAt) : null,
    windowHours,
    windowBasis: measured ? 'measured' : 'assumed',
    say,
  };
}

/** PURE. The history after a sign-in at `at`. */
function withSignIn(history, at) {
  const h = { signIns: [...((history && history.signIns) || [])], expiries: [...((history && history.expiries) || [])] };
  h.signIns.push(_iso(at));
  h.signIns = h.signIns.slice(-KEEP);
  return h;
}

/**
 * PURE. The history after Microsoft refused a refresh at `at` — recorded once per
 * sign-in (every later sync fails the same way and says nothing new). A refusal
 * with no sign-in recorded before it is kept without a window.
 */
function withExpiry(history, at) {
  const h = { signIns: [...((history && history.signIns) || [])], expiries: [...((history && history.expiries) || [])] };
  const signIns = h.signIns.map(_ms).filter((t) => t != null && t <= at).sort((a, b) => a - b);
  const last = signIns.length ? signIns[signIns.length - 1] : null;
  const lastExpiry = h.expiries.length ? _ms(h.expiries[h.expiries.length - 1].at) : null;
  if (lastExpiry != null && (last == null || lastExpiry >= last)) return null; // already recorded for this sign-in
  h.expiries.push({ at: _iso(at), signedInAt: last != null ? _iso(last) : null });
  h.expiries = h.expiries.slice(-KEEP);
  return h;
}

// ── Store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function read() {
  try {
    const raw = _db().getState(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return { signIns: Array.isArray(v.signIns) ? v.signIns : [], expiries: Array.isArray(v.expiries) ? v.expiries : [] };
  } catch { return { signIns: [], expiries: [] }; }
}

function _write(h) {
  try { _db().setState(KEY, JSON.stringify(h)); } catch (e) { console.warn('[MicrosoftSignIn] could not record:', e.message); }
}

function recordSignIn(at = Date.now()) { _write(withSignIn(read(), at)); }

function recordExpiry(at = Date.now()) {
  const next = withExpiry(read(), at);
  if (next) {
    _write(next);
    console.log('[MicrosoftSignIn] Microsoft refused the refresh — sign-in needed');
  }
}

function status(lastTokenError, now = Date.now()) {
  return assess({ history: read(), lastTokenError, now });
}

/** PURE. The Now card for a sign-in that is due or expired; none otherwise. */
function cardFor(s) {
  if (!s || !s.showInMenu) return [];
  const expired = s.state === 'expired';
  return [{
    type: 'microsoft_signin',
    id: 'microsoft-signin',
    // A new key per sign-in, so a card dismissed yesterday cannot hide today's.
    dedupeKey: `microsoft-signin:${s.signedInAt || 'none'}:${s.state}`,
    title: expired ? 'Sign in to Microsoft — calendar, tasks and email are paused' : 'Microsoft sign-in is due',
    reason: s.say,
    score: expired ? 92 : 80,
    urgency: expired ? 'high' : 'medium',
    source: 'microsoft',
    actionHint: 'Sign in to Microsoft',
    meta: { state: s.state, expectedExpiryAt: s.expectedExpiryAt },
  }];
}

/** The Now card from the live state; never throws. */
function nowCards(now = Date.now()) {
  try { return cardFor(require('./microsoft').signInDue(now)); } catch { return []; }
}

module.exports = {
  SIGN_IN_ERROR, ASSUMED_WINDOW_HOURS, DUE_WITHIN_HOURS,
  isSignInError, measuredWindows, assess, withSignIn, withExpiry,
  read, recordSignIn, recordExpiry, status, cardFor, nowCards,
};
