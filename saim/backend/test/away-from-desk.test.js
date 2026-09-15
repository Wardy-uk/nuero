// Two sensors at work: the fixed desk tablet, and the laptop that goes to meetings.
//
// Nick, 14 Sep 2026: "the tablet will never move — so if it senses I'm close, I'm at my
// desk. If just the laptop senses me, I'm away from my desk." And then: "if I'm in a
// meeting, it could say when I'm due back based on when the meeting is due to finish."
//
// Measured the same afternoon: at the desk the tablet hears the watch at -49..-64 and
// away it hears -76..-85, so the two states are genuinely separable.
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { offsiteDisplayState, dueBackLine } = require('../src/presence/rooms');
const presence = require('../src/routes/presence');

const desk = (inRoom) => ({ status: 'present', room: 'office', rooms: [{ room: 'office', readable: true, inRoom }], unreadable: [] });
const laptop = (inRoom) => [{ room: 'laptop', readable: true, inRoom, mobile: true }];
const meeting = (endsAt) => ({ known: true, endsAt });

test('the desk sensor alone decides whether SAiM shows', () => {
  const d = offsiteDisplayState('office', desk(true), { mobile: laptop(false) });
  assert.equal(d.state, 'full');
  assert.equal(d.reason, 'watch-at-this-desk');
});

test('only the laptop hearing him is "away from the desk", not SAiM', () => {
  const d = offsiteDisplayState('office', desk(false), { mobile: laptop(true) });
  assert.equal(d.state, 'clock', 'nearby is not at the desk — his day stays off the screen');
  assert.equal(d.reason, 'away-from-desk');
  assert.equal(d.say, 'Away from the desk.');
});

test('in a meeting it says when he is due back', () => {
  const d = offsiteDisplayState('office', desk(false), { mobile: laptop(true), meeting: meeting('2026-09-14T14:30:00+01:00') });
  assert.equal(d.say, 'Away from the desk — back at 14:30.');
});

// ⚠ The refusal that keeps it honest on a screen colleagues walk past.
test('with no meeting known it does NOT invent a return time', () => {
  for (const m of [null, { known: false }, { known: true, endsAt: null }, { known: true, endsAt: 'nonsense' }]) {
    const d = offsiteDisplayState('office', desk(false), { mobile: laptop(true), meeting: m });
    assert.equal(d.say, 'Away from the desk.', `invented a time from ${JSON.stringify(m)}`);
  }
});

test('neither sensor hearing him says nothing at all', () => {
  const d = offsiteDisplayState('office', desk(false), { mobile: laptop(false) });
  assert.equal(d.reason, 'not-at-this-desk');
  assert.equal(d.say, null);
});

// ⚠ The laptop can only ever SOFTEN the clock. It knows he is near it, not that he is
// at this desk, and this screen is in a room other people walk through.
test('the laptop can never put SAiM on the screen by itself', () => {
  const d = offsiteDisplayState('office', desk(false), { mobile: laptop(true), meeting: meeting('2026-09-14T14:30:00+01:00') });
  assert.notEqual(d.state, 'full');
});

test('the end time is sliced from the string, never re-parsed into a local time', () => {
  // The calendar learned this once: re-parsing an instant shifted every BST event an
  // hour. 14:30+01:00 must read as 14:30 on the screen, not 13:30.
  assert.equal(dueBackLine(meeting('2026-09-14T14:30:00+01:00')), 'Away from the desk — back at 14:30.');
  assert.equal(dueBackLine(meeting('2026-12-14T09:05:00Z')), 'Away from the desk — back at 09:05.');
});

test('a mobile sensor is kept out of the house readings entirely', () => {
  const all = {
    study: { room: 'study', inRoom: false },
    laptop: { room: 'laptop', inRoom: true, mobile: true },
  };
  assert.deepEqual(Object.keys(presence.houseOnly(all)), ['study'], 'a laptop names no room and cannot vouch for one');
  assert.deepEqual(presence.mobileOnly(all).map((r) => r.room), ['laptop']);
});
