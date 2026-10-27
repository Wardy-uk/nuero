'use strict';

/**
 * Microsoft sign-in expiry reaches Nick (19 Oct 2026): a sign-in that expired at
 * 12:00 produced one vague push at 13:00 and nothing about the calendar. This
 * slice alerts on that ONE case; generic job failures stay non-notifying.
 * Pure rules, with the real 19 Oct shapes as fixtures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.NEURO_DB_PATH = process.env.NEURO_DB_PATH || path.join(require('os').tmpdir(), `wd-int-${process.pid}.db`);
const wd = require('./watchdog');

const NOW = new Date('2026-10-19T14:40:00Z');
const LATER = new Date('2026-10-19T15:20:00Z');
// The real error shape, with a fake token-like string and ids that must never surface.
const AADSTS70043 = 'invalid_grant: Error(s): 70043 - Timestamp: 2026-10-19 14:32:17Z - Description: AADSTS70043: The refresh token has expired or is invalid due to sign-in frequency checks by conditional access. Trace ID: 0b1c-trace Correlation ID: 9f2e-corr account nickw@nurtur.tech eyJhbGciOiJSUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123456789';
const KEY = wd.MICROSOFT_SIGNIN_KEY;
const signIn = () => wd.microsoftSignInIssue({ lastTokenError: AADSTS70043 });
const deliver = (state, now = NOW) => wd.integrationNotifications({ [KEY]: signIn() }, state, { quiet: false, now });

test('the real expired-sign-in error becomes ONE alert with the fixed words — a network blip does not', () => {
  const i = signIn();
  assert.equal(i.key, 'integration:microsoft-signin:neuro');
  assert.equal(i.level, 'critical');
  assert.equal(i.title, 'Microsoft sign-in has expired');
  assert.equal(i.detail, 'Calendar, Tasks and work email are paused. Press "Sign in to Microsoft" at the top of the NEURO menu.');
  for (const e of ['invalid_grant: AADSTS700082 expired', 'interaction_required', 'AADSTS50076: MFA required', 'AADSTS65001: not consented']) {
    assert.ok(wd.microsoftSignInIssue({ lastTokenError: e }), e);
  }
  assert.equal(wd.microsoftSignInIssue({ lastTokenError: 'network_error: Network request failed' }), null);
  assert.equal(wd.microsoftSignInIssue({ lastTokenError: null }), null);
  assert.equal(wd.microsoftSignInIssue(null), null);
});

test('redaction: no token, account, trace id or raw provider error reaches the alert or the stored state', () => {
  const r = deliver({});
  const text = JSON.stringify([r.send, r.next]);
  for (const bad of ['AADSTS', '70043', 'invalid_grant', 'Trace', '0b1c', 'Correlation', '9f2e', 'nickw@', 'eyJhbGci', 'conditional access']) {
    assert.ok(!text.includes(bad), `leaked: ${bad}`);
  }
});

test('generic integration failures produce NO push — only the sign-in case is an integration alert', () => {
  const jobs = [
    { name: 'energy-sync', lastSuccessAt: '2026-10-19T10:00:00Z', lastFailureAt: '2026-10-19T14:35:00Z', lastError: 'Bright 500' },
    { name: 'google-calendar-sync', lastSuccessAt: null, lastFailureAt: '2026-10-19T14:30:00Z', lastError: 'invalid_grant' },
    { name: 'calendar-sync', lastSuccessAt: '2026-10-19T12:00:16Z', lastFailureAt: '2026-10-19T14:37:30Z', lastError: 'no events returned' },
  ];
  // Microsoft's token is fine; three jobs are failing (one even with a Google invalid_grant).
  const { issues } = wd.integrationIssues({ status: { lastTokenError: null }, jobs });
  assert.deepEqual(issues, []);
  const r = wd.integrationNotifications(Object.fromEntries(issues.map((i) => [i.key, i])), {}, { now: NOW });
  assert.deepEqual(r.send, []);
  assert.equal(wd.foldedBy(issues).size, 0, 'nothing is folded either — the existing warnings stay as health evidence');
  const src = fs.readFileSync(path.join(__dirname, 'watchdog.js'), 'utf8');
  assert.ok(!/failingJobIssues/.test(src), 'the generic job-failure alert is not in this slice');
});

test('downstream errors are deduplicated: one alert, the calendar/Tasks/job checks fold into it — including after sign-in, before a sync', () => {
  const expected = ['ms-sync:stale', 'runtime:failed:calendar-sync', 'runtime:failed:ms-tasks-sync', 'sense:calendar'];
  assert.deepEqual([...wd.foldedBy([signIn()])].sort(), expected);
  // Same tick, all three downstream symptoms present: still exactly one send.
  const r = deliver({});
  assert.equal(r.send.length, 1);
  // Delivered, then the token clears but no sync has happened yet: the alert is
  // carried (awaiting sync), still folds, and nothing is sent either way.
  const waiting = wd.integrationNotifications({}, r.next, { quiet: false, now: LATER, syncedAt: '2026-10-19T14:30:00Z' });
  assert.deepEqual(waiting.send, []);
  assert.deepEqual(waiting.recovered, []);
  assert.equal(waiting.next[KEY].awaitingSync, true);
  assert.deepEqual([...wd.foldedBy(Object.values(waiting.next))].sort(), expected);
  // A second expiry tick while delivered does not resend.
  assert.deepEqual(deliver(r.next, LATER).send, []);
});

test('quiet hours: held, and DISCARDED if the sign-in recovers before it was delivered', () => {
  const held = wd.integrationNotifications({ [KEY]: signIn() }, {}, { quiet: true, now: NOW });
  assert.deepEqual(held.send, []);
  assert.equal(held.next[KEY].notifiedAt, null);
  // Still expired when quiet hours end: sent then.
  assert.deepEqual(deliver(held.next).send.map((i) => i.key), [KEY]);
  // Recovered (even with a real sync) before quiet hours ended: no alert, no "working again", no state.
  for (const quiet of [true, false]) {
    const r = wd.integrationNotifications({}, held.next, { quiet, now: LATER, syncedAt: '2026-10-19T15:15:00Z' });
    assert.deepEqual(r.send, []);
    assert.deepEqual(r.recovered, []);
    assert.equal(r.next[KEY], undefined);
  }
});

test('"working again" only after a DELIVERED alert and a Microsoft sync that succeeded after it', () => {
  const sent = deliver({}).next;
  // Token clear, sync success is OLDER than the alert: not proof.
  assert.deepEqual(wd.integrationNotifications({}, sent, { now: LATER, syncedAt: '2026-10-19T12:00:16Z' }).recovered, []);
  // No sync recorded at all: not proof.
  assert.deepEqual(wd.integrationNotifications({}, sent, { now: LATER, syncedAt: null }).recovered, []);
  // A real sync after delivery: one recovery.
  const ok = wd.integrationNotifications({}, sent, { now: LATER, syncedAt: '2026-10-19T15:15:00Z' });
  assert.deepEqual(ok.recovered.map((i) => i.key), [KEY]);
  assert.equal(ok.next[KEY], undefined);
  // Recovery with no prior DELIVERED alert says nothing.
  assert.deepEqual(wd.integrationNotifications({}, {}, { now: LATER, syncedAt: '2026-10-19T15:15:00Z' }).recovered, []);
});

test('sync evidence: only the Microsoft jobs count, and ALL of them must have synced (the oldest success)', () => {
  assert.equal(wd.microsoftSyncedAt([
    { name: 'calendar-sync', lastSuccessAt: '2026-10-19T15:15:00Z' },
    { name: 'ms-tasks-sync', lastSuccessAt: '2026-10-19T15:10:00Z' },
    { name: 'energy-sync', lastSuccessAt: '2026-10-19T15:30:00Z' },
  ]), '2026-10-19T15:10:00.000Z');
  // Calendar back, Tasks never synced: not yet.
  assert.equal(wd.microsoftSyncedAt([
    { name: 'calendar-sync', lastSuccessAt: '2026-10-19T15:15:00Z' },
    { name: 'ms-tasks-sync', lastSuccessAt: null },
  ]), null);
  assert.equal(wd.microsoftSyncedAt([{ name: 'energy-sync', lastSuccessAt: '2026-10-19T15:30:00Z' }]), null);
  assert.equal(wd.microsoftSyncedAt(null), null);
  // Calendar synced after the alert, Tasks only before it: still waiting, nothing sent.
  const sent = deliver({}).next;
  const syncedAt = wd.microsoftSyncedAt([
    { name: 'calendar-sync', lastSuccessAt: '2026-10-19T15:15:00Z' },
    { name: 'ms-tasks-sync', lastSuccessAt: '2026-10-19T12:00:00Z' },
  ]);
  assert.deepEqual(wd.integrationNotifications({}, sent, { now: LATER, syncedAt }).recovered, []);
});

test('non-integration issues pass through integrationNotifications untouched', () => {
  const other = { key: 'backup:stale', level: 'critical', title: 'x' };
  assert.deepEqual(wd.integrationNotifications({ [other.key]: other }, {}, { now: NOW }).next[other.key], other);
  assert.deepEqual(wd.integrationNotifications({}, { [other.key]: other }, { now: NOW }).recovered, []);
});

test('source: run() decides the sign-in alert first, folds from its live state, and sends with fixed words as system_alert', () => {
  const src = fs.readFileSync(path.join(__dirname, 'watchdog.js'), 'utf8');
  const run = src.slice(src.indexOf('async function run('));
  assert.match(run, /const integration = checkIntegrations\(\);/);
  assert.match(run, /syncedAt: integration\.syncedAt/);
  assert.match(run, /const folded = foldedBy\(Object\.values\(ints\.next\)\);/, 'folds while held/delivered/awaiting sync, not just while erroring');
  assert.match(run, /for \(const k of folded\) if \(previous\[k\] && !current\[k\]\) current\[k\] = previous\[k\];/, 'a folded issue does not read as resolved');
  assert.match(run, /for \(const i of ints\.send\) \{\s*await webpush\.sendToAll\(`⚠ \$\{i\.title\}`, i\.detail \|\| '', \{ type: 'system_alert'/);
  assert.match(run, /'✅ Microsoft is working again', 'Calendar, Tasks and work email are syncing again\.'/);
  assert.match(run, /!isInt\(i\) && \(!previous\[i\.key\]/, 'not ALSO pushed by the generic path');
  assert.ok(!/NOVA/.test(run), 'NOVA is never reported from here');
});
