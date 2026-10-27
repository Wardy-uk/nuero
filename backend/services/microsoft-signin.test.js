'use strict';

const test = require('node:test');
const assert = require('node:assert');
const s = require('./microsoft-signin');

const H = 3600 * 1000;
const T0 = Date.parse('2026-10-27T09:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const REFUSED = 'invalid_grant: AADSTS70043: The refresh token has expired or is invalid due to sign-in frequency checks by conditional access.';

test('the exact refusal from 26 Oct reads as a sign-in error; a network blip does not', () => {
  assert.equal(s.isSignInError(REFUSED), true);
  assert.equal(s.isSignInError('getaddrinfo ENOTFOUND login.microsoftonline.com'), false);
  assert.equal(s.isSignInError(null), false);
});

test('nothing recorded and nothing refused: unknown, no menu button', () => {
  const a = s.assess({ history: {}, now: T0 });
  assert.equal(a.state, 'unknown');
  assert.equal(a.showInMenu, false);
});

test('a refusal is expired and shows the button, even with no sign-in recorded', () => {
  const a = s.assess({ history: {}, lastTokenError: REFUSED, now: T0 });
  assert.equal(a.state, 'expired');
  assert.equal(a.showInMenu, true);
});

test('assumed 24h window: ok until 3h before, then due', () => {
  const history = { signIns: [iso(T0)] };
  assert.equal(s.assess({ history, now: T0 + 20 * H }).state, 'ok');
  const due = s.assess({ history, now: T0 + 21.5 * H });
  assert.equal(due.state, 'due');
  assert.equal(due.showInMenu, true);
  assert.equal(due.windowBasis, 'assumed');
  assert.equal(due.expectedExpiryAt, iso(T0 + 24 * H));
});

test('past the expected expiry with no refusal yet is still due, not expired', () => {
  const a = s.assess({ history: { signIns: [iso(T0)] }, now: T0 + 30 * H });
  assert.equal(a.state, 'due');
  assert.match(a.say, /expected to expire by now/);
});

test('two measured windows replace the assumption (median)', () => {
  const history = {
    signIns: [iso(T0 - 48 * H), iso(T0 - 30 * H), iso(T0)],
    expiries: [
      { at: iso(T0 - 48 * H + 18 * H), signedInAt: iso(T0 - 48 * H) },
      { at: iso(T0 - 30 * H + 20 * H), signedInAt: iso(T0 - 30 * H) },
    ],
  };
  const a = s.assess({ history, now: T0 + H });
  assert.equal(a.windowBasis, 'measured');
  assert.equal(a.windowHours, 19);
  assert.equal(a.expectedExpiryAt, iso(T0 + 19 * H));
  // Due from 16h, not 21h as the assumed window would say.
  assert.equal(s.assess({ history, now: T0 + 16.5 * H }).state, 'due');
});

test('a refusal is recorded once per sign-in, with the sign-in it ended', () => {
  let h = s.withSignIn({}, T0);
  h = s.withExpiry(h, T0 + 23 * H);
  assert.deepEqual(h.expiries, [{ at: iso(T0 + 23 * H), signedInAt: iso(T0) }]);
  assert.equal(s.withExpiry(h, T0 + 23.1 * H), null, 'every later failing sync says nothing new');
  h = s.withSignIn(h, T0 + 24 * H);
  const next = s.withExpiry(h, T0 + 47 * H);
  assert.equal(next.expiries.length, 2);
  assert.equal(next.expiries[1].signedInAt, iso(T0 + 24 * H));
});

test('implausible windows are ignored', () => {
  const history = { expiries: [
    { at: iso(T0 + 10 * 60 * 1000), signedInAt: iso(T0) },        // 10 minutes
    { at: iso(T0 + 60 * 24 * H), signedInAt: iso(T0) },             // 60 days
  ] };
  assert.deepEqual(s.measuredWindows(history), []);
});

test('Now card only when the button shows, keyed per sign-in so yesterday’s dismissal cannot hide today’s', () => {
  assert.deepEqual(s.cardFor({ showInMenu: false }), []);
  const a = s.assess({ history: { signIns: [iso(T0)] }, lastTokenError: REFUSED, now: T0 + 25 * H });
  const [card] = s.cardFor(a);
  assert.equal(card.type, 'microsoft_signin');
  assert.equal(card.urgency, 'high');
  assert.match(card.dedupeKey, new RegExp(iso(T0)));
  const b = s.assess({ history: { signIns: [iso(T0 + 26 * H)] }, lastTokenError: REFUSED, now: T0 + 50 * H });
  assert.notEqual(s.cardFor(b)[0].dedupeKey, card.dedupeKey);
});

test('the card routes to the sign-in page on desktop', () => {
  const { resolveNueroNavigation } = require('../../shared/action-surfaces.cjs');
  assert.equal(resolveNueroNavigation({ type: 'microsoft_signin' }).view, 'microsoft-signin');
});

test('the watchdog alert uses the same definition and points at the menu', () => {
  const w = require('./watchdog');
  const issue = w.microsoftSignInIssue({ lastTokenError: REFUSED });
  assert.ok(issue);
  assert.match(issue.detail, /top of the NEURO menu/);
  assert.equal(w.microsoftSignInIssue({ lastTokenError: 'ETIMEDOUT' }), null);
});
