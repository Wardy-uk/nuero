// A SARA screen that is NOT in the house — Nick's desk at work (12 Sep 2026).
//
// "Amend SARA's rules to accommodate it — lock the home devices, not the office."
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { displayState, offsiteDisplayState } = require('../src/presence/rooms');

const room = (over = {}) => ({ room: 'work-office', readable: true, inRoom: false, status: 'present', rssi: -70, ...over });
const arb = (rooms, over = {}) => ({ status: 'present', room: rooms[0] && rooms[0].room, rooms, unreadable: [], ...over });
const AWAY = { away: true, zone: 'office' };
const HOME = { away: false, zone: 'home' };

test('at the desk, SARA shows — even though the house says he is away', () => {
  // ⚠ The whole point. `away: true` is the NORMAL state for a man at his office,
  // and the home rule would blank this screen all day, every working day.
  const d = displayState('work-office', arb([room({ inRoom: true })]), AWAY, null, null, { offsite: true });
  assert.equal(d.state, 'full');
  assert.equal(d.reason, 'watch-at-this-desk');
});

test('away from the desk, it is the clock — and it never says where he is', () => {
  const d = displayState('work-office', arb([room({ inRoom: false }), { room: 'bedroom', readable: true, inRoom: true }]), AWAY, null, null, { offsite: true });
  assert.equal(d.state, 'clock');
  // ⚠ A home screen says "In the bedroom." to explain itself. On a desk in an
  // office that line tells everyone walking past where he lives his life.
  assert.equal(d.say, null);
});

test('an unreadable desk sensor falls to the clock, not to SARA', () => {
  // The opposite choice to a home screen, and the room is the reason: other
  // people walk past this one, so "I cannot tell" must not leave his day on show.
  const d = displayState('work-office', arb([room({ readable: false })]), AWAY, null, null, { offsite: true });
  assert.equal(d.state, 'clock');
  assert.equal(d.reason, 'desk-sensor-unreadable');
  assert.equal(d.say, null);
});

test('no sensor for this room at all is still the clock', () => {
  const d = offsiteDisplayState('work-office', arb([{ room: 'kitchen', readable: true, inRoom: true }]));
  assert.equal(d.state, 'clock');
  assert.equal(d.say, null);
});

test('the house fingerprint is ignored offsite — it knows nothing about a desk 20 miles away', () => {
  const sureAtHome = { confidence: 'sure', room: 'study' };
  const d = displayState('work-office', arb([room({ inRoom: true })]), AWAY, sureAtHome, null, { offsite: true });
  assert.equal(d.state, 'full', 'his own desk sensor decides, not the house model');
  assert.equal(d.decidedBy, 'offsite');
});

test('the bedtime lock cannot fire on an offsite screen', () => {
  // Sustained-in-the-bedroom outranks everything for a HOME screen. An office
  // screen going dark with "Goodnight." at 22:00 would be a different thing
  // entirely — and it is not even in the house.
  const sustained = { room: 'bedroom', ms: 60 * 60_000 };
  const d = displayState('work-office', arb([room({ inRoom: true })]), HOME, null, sustained, { offsite: true });
  assert.equal(d.state, 'full');
  assert.notEqual(d.reason, 'in-bed');
});

test('home screens are untouched: the flag defaults to off', () => {
  const home = displayState('living-room', arb([{ room: 'living-room', readable: true, inRoom: false }]), AWAY);
  assert.equal(home.state, 'locked', 'away from home still locks the house screens');
  assert.equal(home.reason, 'not-home');
});
