'use strict';

// One phrase for where Nick is. Pure, so it pins without a house or an HA.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describe: where, fromPhone, townLabel } = require('./whereabouts');

const inRoom = (r) => ({ known: true, room: r, subject: 'watch' });
const noRoom = (why) => ({ known: false, room: null, why });

test('a known room wins, and reads like a place', () => {
  const w = where(inRoom('living-room'), 'home');
  assert.equal(w.label, 'Living Room');
  assert.equal(w.kind, 'room');
  assert.equal(w.subject, 'watch', 'it measured the watch and says so');
});

test('the office zone becomes "At Work"', () => {
  const w = where(noRoom('not heard'), 'office');
  assert.equal(w.label, 'At Work');
  assert.equal(w.kind, 'zone');
});

test('a zone nobody mapped still renders, title-cased', () => {
  // So adding a zone in HA needs no code change here.
  assert.equal(where(noRoom('x'), 'gym').label, 'At Gym');
});

// ⚠ The load-bearing refusal. zone.home is a 100m circle centred 90m from where
// Nick sits, so he lives on its edge and jitter reports not_home while he is at
// home. Rendering anything from it would tell his family he had gone out.
test('home and not_home are NOT places, and render nothing', () => {
  for (const z of ['home', 'not_home', 'unknown', 'unavailable', '', null, undefined]) {
    const w = where(noRoom('not heard'), z);
    assert.equal(w.known, false, `${z} must not become a label`);
    assert.equal(w.label, null);
  }
});

test('a room beats a zone, because it is the finer answer', () => {
  const w = where(inRoom('kitchen'), 'office');
  assert.equal(w.label, 'Kitchen');
});

test('knowing nothing keeps the room reader\'s own reason', () => {
  const w = where(noRoom('no rooms have been calibrated'), null);
  assert.equal(w.known, false);
  assert.match(w.why, /calibrated/);
});

test('case and padding on a zone name do not matter', () => {
  assert.equal(where(noRoom('x'), '  Office ').label, 'At Work');
});

// ── Out of the house: the phone's town (11 Sep 2026) ────────────────────────

const out = (over = {}) => ({ presence: 'not_home', locality: 'Coalville', ageHours: 0.5, ...over });

test('out of the house, the phone\'s town renders', () => {
  const w = where(noRoom('not heard'), null, out());
  assert.equal(w.known, true);
  assert.equal(w.label, 'Coalville');
  assert.equal(w.kind, 'town');
  assert.equal(w.subject, 'phone');
});

test('a stale geocode is unknown, not a place', () => {
  // HA once served "Office" from a fix 33 days old. Past 6h it says nothing.
  assert.equal(where(noRoom('x'), null, out({ ageHours: 6.1 })).known, false);
  assert.equal(where(noRoom('x'), null, out({ ageHours: null })).known, false, 'an unreadable age is not fresh');
});

test('the town never renders while HA says home, or from an unknown presence', () => {
  for (const presence of ['home', null, undefined, 'unknown']) {
    assert.equal(where(noRoom('x'), null, out({ presence })).known, false, `presence ${presence}`);
  }
});

test('a room still beats the town, and a named zone beats the town', () => {
  assert.equal(where(inRoom('study'), null, out()).label, 'Study');
  assert.equal(where(noRoom('x'), 'office', out()).label, 'At Work');
});

test('only a town is ever rendered, never an address or a placeholder', () => {
  assert.equal(townLabel('12 High Street\nCoalville\nLE67\nEngland'), null, 'a multi-line address is refused');
  assert.equal(townLabel('N/A'), null);
  assert.equal(townLabel('  '), null);
  assert.equal(townLabel('x'.repeat(61)), null);
  assert.equal(townLabel(' Coalville '), 'Coalville');
});

test('without the opt-in argument nothing changes — VESTA calls it this way', () => {
  const w = where(noRoom('not heard'), 'not_home');
  assert.equal(w.known, false);
});

test('fromPhone drops a stale zone as well as a stale town', () => {
  const fresh = fromPhone({ presence: 'office', presenceAgeHours: 1, geocodedLocality: 'Derby', geocodedAgeHours: 1 });
  assert.equal(fresh.zone, 'office');
  const stale = fromPhone({ presence: 'office', presenceAgeHours: 800, geocodedLocality: 'Derby', geocodedAgeHours: 800 });
  assert.equal(stale.zone, null, 'a frozen "At Work" must not render');
  assert.equal(where(noRoom('x'), stale.zone, stale.away).known, false);
  assert.deepEqual(fromPhone(null), { zone: null, away: null });
});
