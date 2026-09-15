// An office sensor must never be evidence about the HOUSE.
//
// ⚠ Measured 14 Sep 2026, Nick at his desk at work: his office sensor heard the watch,
// and `displayState` asks "is the watch audible to ANY sensor" before it will let the
// home geofence lock a screen. A desk twenty miles away answered yes, so the study
// screen showed SAiM to an empty room, with the contradiction line explaining that it
// was trusting the watch over Home Assistant.
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const presence = require('../src/routes/presence');
const { resolveRoom, displayState } = require('../src/presence/rooms');

const reading = (room, over = {}) => ({
  room, status: 'absent', inRoom: false, healthy: true, rate: 0, rssiMedian: null,
  at: new Date().toISOString(), ...over,
});

function withOffsite(rooms, fn) {
  const before = process.env.SAIM_OFFSITE_ROOMS;
  process.env.SAIM_OFFSITE_ROOMS = rooms;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.SAIM_OFFSITE_ROOMS; else process.env.SAIM_OFFSITE_ROOMS = before;
  }
}

test('an offsite reading is stripped out of the house readings', () => {
  withOffsite('office', () => {
    const all = {
      study: reading('study'),
      office: reading('office', { status: 'present', inRoom: true, rssiMedian: -48, rate: 2 }),
    };
    assert.deepEqual(Object.keys(presence.houseOnly(all)), ['study']);
  });
});

// ⚠ The one that was actually wrong on the wall.
test('a desk at work cannot stop the home geofence locking a house screen', () => {
  withOffsite('office', () => {
    const all = {
      study: reading('study'),
      living_room: reading('living_room'),
      office: reading('office', { status: 'present', inRoom: true, rssiMedian: -48, rate: 2 }),
    };
    const away = { away: true, zone: 'office' };

    // The bug: with every sensor counted, the watch is "audible", so the geofence is
    // overruled and the house screen stays awake — as `full` or as the clock, but
    // never locked, which is the one thing it should have been.
    const wrong = displayState('study', resolveRoom(all, new Date()), away);
    assert.notEqual(wrong.state, 'locked', 'the desk at work overruled the geofence');
    assert.equal(wrong.reason, 'home-contradicted');

    const right = displayState('study', resolveRoom(presence.houseOnly(all), new Date()), away);
    assert.equal(right.state, 'locked');
    assert.equal(right.reason, 'not-home');
  });
});

test('with nothing named offsite, nothing changes', () => {
  withOffsite('', () => {
    const all = { study: reading('study'), office: reading('office') };
    assert.deepEqual(Object.keys(presence.houseOnly(all)).sort(), ['office', 'study']);
  });
});

test('only the exact room name is offsite — a prefix is not', () => {
  withOffsite('office', () => {
    assert.equal(presence.isOffsite('office'), true);
    assert.equal(presence.isOffsite('office-2'), false);
    assert.equal(presence.isOffsite('home-office'), false);
  });
});
