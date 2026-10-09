'use strict';

/**
 * A navigation shortcut is a shortcut to somewhere useful RIGHT NOW, and nothing
 * retired them — so the approval screen held a "prep for the 09:45" card at
 * 11:40 and "do your standup" cards from days nobody can do a standup for any
 * more. Neither can be acted on; both can only be rejected, which is work the
 * screen invented for itself.
 *
 * `navigationExpiry` is pure, so the rule pins without a database and without
 * caring what time the suite runs at. The guard that matters most is the last
 * test: writes and outbound must never expire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { navigationExpiry } = require('./suggestion-engine');

// Small deliberate gaps: a stamp and a "now" minutes apart are the same local
// day in every timezone, so nothing here depends on the host clock's offset.
const NOW = new Date('2026-08-17T12:00:00Z');

const action = (over = {}) => ({
  id: 1,
  type: 'open_meeting_prep',
  payload: { navigate: 'meeting-prep' },
  created_at: '2026-08-17 11:55:00',
  ...over,
});

test('a prep card for a meeting that has started is spent', () => {
  const reason = navigationExpiry(action({ payload: { start: '2026-08-17 09:45:00' } }), NOW);
  assert.ok(reason, 'expected an expiry reason');
  assert.match(reason, /already started/);
});

test('a prep card for a meeting still to come stands', () => {
  assert.equal(navigationExpiry(action({ payload: { start: '2026-08-17 12:10:00' } }), NOW), null);
});

// Live 9 Oct 2026: Graph's start "2026-10-09T09:00:00.0000000" is LONDON wall-clock
// (BST, = 08:00Z). Read as UTC it stayed "not started" until 10:00 local.
test('a Graph wall-clock start is London time, not UTC', () => {
  const { parseWallClock } = require('./suggestion-engine');
  assert.equal(parseWallClock('2026-10-09T09:00:00.0000000').toISOString(), '2026-10-09T08:00:00.000Z', 'BST');
  assert.equal(parseWallClock('2026-12-09T09:00:00').toISOString(), '2026-12-09T09:00:00.000Z', 'GMT');
  assert.equal(parseWallClock('2026-10-09T09:00:00Z').toISOString(), '2026-10-09T09:00:00.000Z', 'an explicit zone is kept');
  const at0915bst = new Date('2026-10-09T08:15:00Z');
  const live = action({ payload: { navigate: 'meeting-prep', start: '2026-10-09T09:00:00.0000000' }, created_at: '2026-10-09 07:50:00' });
  assert.match(navigationExpiry(live, at0915bst), /already started/);
});

test('"do your standup" is spent once the standup is done; the EOD one once the EOD is', () => {
  const s = action({ type: 'open_standup', payload: { navigate: 'standup', ritual: 'standup' } });
  const e = action({ type: 'open_standup', payload: { navigate: 'standup' }, reason: 'Wrap up — do your EOD' });
  assert.equal(navigationExpiry(s, NOW, { rituals: { standup: false, eod: false } }), null);
  assert.match(navigationExpiry(s, NOW, { rituals: { standup: true, eod: false } }), /standup is already done/);
  assert.equal(navigationExpiry(e, NOW, { rituals: { standup: true, eod: false } }), null, 'an older row with no ritual reads its reason');
  assert.match(navigationExpiry(e, NOW, { rituals: { standup: true, eod: true } }), /EOD is already done/);
  assert.equal(navigationExpiry(s, NOW, { rituals: null }), null, 'unknown retires nothing');
});

test('no prep card for a solo block — only a meeting with other people in it', () => {
  const rules = require('./suggestion-engine').SUGGESTION_RULES;
  assert.ok(Array.isArray(rules) && rules.length, 'positive control: the rule table is readable');
  const prep = rules.find((r) => r.match({ type: 'meeting', meta: { minutesAway: 10, withOthers: true } }));
  assert.ok(prep, 'positive control: a real meeting gets prep');
  assert.ok(!rules.some((r) => r.match({ type: 'meeting', title: 'Task block: NT-24162', meta: { minutesAway: 10, withOthers: false } })));
});

test('a shortcut raised on an earlier day is spent even with no moment in its payload', () => {
  const reason = navigationExpiry(
    action({ type: 'open_standup', payload: { navigate: 'standup' }, created_at: '2026-08-16 09:00:00' }),
    NOW
  );
  assert.ok(reason, 'expected an expiry reason');
  assert.match(reason, /earlier day/);
});

test('a shortcut raised today stands', () => {
  assert.equal(
    navigationExpiry(action({ type: 'open_standup', payload: { navigate: 'standup' } }), NOW),
    null
  );
});

test('an unparseable or missing timestamp is not treated as old', () => {
  for (const created_at of [null, '', 'yesterday-ish']) {
    assert.equal(
      navigationExpiry(action({ type: 'open_email', payload: {}, created_at }), NOW),
      null,
      'not knowing when it was raised is not evidence that it is stale'
    );
  }
});

test('only navigation expires — a week-old draft or chase is still worth approving', () => {
  const old = { created_at: '2026-08-01 09:00:00' };
  for (const [type, payload] of [
    ['capture_todo', { text: 'Chase the SLA report' }],
    ['draft_reply', { emailId: 'AAA', from: 'Chris' }],
    ['chase_commitment', { waitingKey: 'lucy::x', person: 'Lucy', body: 'Where did that get to?' }],
    ['reply_email', { emailId: 'AAA', body: 'Sending this' }],
  ]) {
    assert.equal(
      navigationExpiry({ id: 2, type, payload, ...old }, NOW),
      null,
      `${type} must never be expired by a sweep — it is a decision, not a shortcut`
    );
  }
});

test('an unknown type is left alone rather than swept', () => {
  assert.equal(navigationExpiry({ id: 3, type: 'teleport_nick', payload: {}, created_at: '2026-08-01 09:00:00' }, NOW), null);
});
