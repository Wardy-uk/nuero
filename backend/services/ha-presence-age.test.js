'use strict';
// The presence clock is the newest AGREEING tracker report, not person.last_updated.
// Fixture is the real 5 Oct 2026 07:25 BST state: phone still since 20:06, Life360
// heartbeating "home" hourly, a router tracker freshly (and wrongly) "not_home".
const test = require('node:test');
const assert = require('node:assert');
const { presenceConfirmedAt } = require('./ha');

const person = (state, upd, trackers) => ({
  entity_id: 'person.nick', state, last_updated: upd, last_changed: upd,
  attributes: { device_trackers: trackers },
});
const tracker = (id, state, upd) => ({ entity_id: id, state, last_updated: upd, last_changed: upd });
const TRACKERS = ['device_tracker.nicks_iphone_2', 'device_tracker.life360_nick', 'device_tracker.nicks_iphone'];

test('an agreeing Life360 heartbeat keeps a still phone fresh overnight', () => {
  const states = [
    person('home', '2026-10-04T19:06:33+00:00', TRACKERS),
    tracker('device_tracker.nicks_iphone_2', 'home', '2026-10-04T20:30:02+00:00'),
    tracker('device_tracker.life360_nick', 'home', '2026-10-05T05:59:28+00:00'),
  ];
  assert.strictEqual(presenceConfirmedAt(states, 'person.nick'), '2026-10-05T05:59:28+00:00');
});

test('a fresh DISAGREEING tracker never refreshes the reading', () => {
  const states = [
    person('home', '2026-10-04T19:06:33+00:00', TRACKERS),
    tracker('device_tracker.nicks_iphone', 'not_home', '2026-10-05T06:55:04+00:00'),
  ];
  assert.strictEqual(presenceConfirmedAt(states, 'person.nick'), '2026-10-04T19:06:33+00:00');
});

test('a tracker the person does not list is not evidence', () => {
  const states = [
    person('home', '2026-10-04T19:06:33+00:00', ['device_tracker.nicks_iphone_2']),
    tracker('device_tracker.life360_nick', 'home', '2026-10-05T05:59:28+00:00'),
  ];
  assert.strictEqual(presenceConfirmedAt(states, 'person.nick'), '2026-10-04T19:06:33+00:00');
});

test('no person entity is null, never a guess', () => {
  assert.strictEqual(presenceConfirmedAt([tracker('device_tracker.life360_nick', 'home', '2026-10-05T05:59:28+00:00')], 'person.nick'), null);
});
