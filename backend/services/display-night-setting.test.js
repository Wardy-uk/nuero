'use strict';

/**
 * The screens' overnight window, and one room's reading for a home screen
 * (Nick, 2 Oct 2026: "overnight (times should be a setting) the screens should
 * dim — 9pm to 7am for now", and "the @home screens should display room info").
 *
 * SCRATCH database (`NEURO_DB_PATH`), never the real one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-display-night-'));
process.env.NEURO_DB_PATH = path.join(root, 'display-night.db');

const db = require('../db/database');
const settings = require('./attention-settings');
const rooms = require('./rooms');

test.before(async () => { await db.init(); });

test('the default is 21:00-07:00 and says it is the default', () => {
  db.setState(settings.STATE_KEY, '{}');
  const s = settings.read();
  assert.equal(s.displayNight, '21:00-07:00');
  assert.equal(s.displayNightSource, 'default');
});

test('it is set, reset with null, and junk is ignored rather than stored', () => {
  db.setState(settings.STATE_KEY, '{}');
  assert.equal(settings.update({ displayNight: '22:00-06:30' }).displayNight, '22:00-06:30');
  assert.equal(settings.read().displayNightSource, 'setting');
  assert.equal(settings.update({ displayNight: 'bedtime' }).displayNight, '22:00-06:30', 'junk leaves it alone');
  assert.equal(settings.update({ displayNight: 'off' }).displayNight, 'off');
  const reset = settings.update({ displayNight: null });
  assert.equal(reset.displayNight, '21:00-07:00');
  assert.equal(reset.displayNightSource, 'default');
});

test('⚠ it is NOT quiet hours — changing one leaves the other untouched', () => {
  db.setState(settings.STATE_KEY, '{}');
  settings.update({ quietHours: '23:00-06:00' });
  assert.equal(settings.read().displayNight, '21:00-07:00');
  settings.update({ displayNight: '20:00-07:00' });
  assert.equal(settings.read().quietHours, '23:00-06:00');
});

test('patching something else does not silently drop a chosen window', () => {
  db.setState(settings.STATE_KEY, '{}');
  settings.update({ displayNight: '20:00-07:00' });
  settings.update({ interruptionLevel: 'critical-only' });
  assert.equal(settings.read().displayNight, '20:00-07:00');
});

const HOUSE = {
  known: true,
  rooms: [
    { area: 'Office', lights: [{ state: 'on' }, { state: 'off' }, { state: 'unavailable' }], climate: [{ currentC: 21.4, targetC: 19 }] },
    { area: 'Kitchen', lights: [{ state: 'off' }], climate: [{ currentC: 68, targetC: 12 }] },
  ],
};

test('a room reading names temperature and lights, matched case-insensitively', () => {
  const r = rooms.describeArea(HOUSE, 'office');
  assert.equal(r.known, true);
  assert.equal(r.area, 'Office');
  assert.equal(r.tempC, 21.4);
  assert.deepEqual(r.lights, { total: 3, on: 1, off: 1, unreachable: 1 });
});

test('⚠ a Fahrenheit-looking reading is refused, never shown as the room temperature', () => {
  assert.equal(rooms.describeArea(HOUSE, 'Kitchen').tempC, null);
});

test('an unread house and an unknown room are NOT a room with nothing in it', () => {
  const unread = rooms.describeArea({ known: false }, 'Office');
  assert.equal(unread.known, false);
  assert.match(unread.why, /could not be read/);
  const missing = rooms.describeArea(HOUSE, 'Garage');
  assert.equal(missing.known, false);
  assert.match(missing.why, /no room/);
});
