'use strict';

// "Who's in the house" judges the FEED (31 Oct 2026: the sensor read fine while
// the router reported every device away, and Isaac upstairs showed "Out").

const test = require('node:test');
const assert = require('node:assert/strict');
const { assess } = require('./household-sense');

const NOW = new Date('2026-10-31T18:50:00Z');
const AT = NOW.getTime() - 60_000;
const tracker = (id, state) => ({ entity_id: `device_tracker.${id}`, state, attributes: { source_type: 'router' } });
const sensor = (state, attrs = {}) => ({ entity_id: 'binary_sensor.household_others_home', state,
  attributes: { who_is_home: [], unreadable: [], mac_rotated: [], ...attrs } });
const houseOf = (trackerState, sensorRow) => [
  tracker('redmi_note_15', trackerState), tracker('helen_s_s24_ultra', trackerState),
  tracker('galaxy_tab_a_2016', trackerState), tracker('huawei_p30_lite_63c2e37ee', trackerState),
  { entity_id: 'device_tracker.life360_helen', state: 'home', attributes: { source_type: 'gps' } },
  sensorRow,
];

test('healthy house: live, says who is in', () => {
  const r = assess(houseOf('home', sensor('on', { who_is_home: ['Helen', 'Isaac'] })), { cachedAt: AT, now: NOW });
  assert.equal(r.state, 'live');
  assert.equal(r.detail, 'Helen, Isaac in');
});

test('31 Oct 18:43: every router device "not home" is a broken feed, though the sensor says on', () => {
  const r = assess(houseOf('not_home', sensor('on', { who_is_home: ['Helen'] })), { cachedAt: AT, now: NOW });
  assert.equal(r.state, 'error');
  assert.match(r.why, /none of its 4 devices are home/);
});

test('31 Oct 14:40: router integration not running — every tracker unavailable', () => {
  const r = assess(houseOf('unavailable', sensor('on', { who_is_home: ['Helen'], unreadable: ['Isaac'] })), { cachedAt: AT, now: NOW });
  assert.equal(r.state, 'error');
  assert.match(r.why, /router integration/);
});

test('one device off the Wi-Fi is NOT a broken feed', () => {
  const states = houseOf('home', sensor('on', { who_is_home: ['Helen'] }));
  states[0] = tracker('redmi_note_15', 'not_home');
  assert.equal(assess(states, { cachedAt: AT, now: NOW }).state, 'live');
});

test('a resident who cannot be read is an error, named', () => {
  const r = assess(houseOf('home', sensor('on', { who_is_home: ['Helen'], unreadable: ['Isaac'] })), { cachedAt: AT, now: NOW });
  assert.equal(r.state, 'error');
  assert.match(r.why, /whether Isaac is in/);
});

test('a rotated phone address is said, not healed silently', () => {
  const r = assess(houseOf('home', sensor('on', { mac_rotated: ['device_tracker.redmi_note_15_2 not attached to person.isaac'] })), { cachedAt: AT, now: NOW });
  assert.equal(r.state, 'error');
  assert.match(r.why, /new Wi-Fi address/);
});

test('never read, or an old read, is stale — never live', () => {
  assert.equal(assess(null, { now: NOW }).state, 'stale');
  const r = assess(houseOf('home', sensor('on')), { cachedAt: NOW.getTime() - 40 * 60_000, now: NOW });
  assert.equal(r.state, 'stale');
  assert.equal(r.ageMinutes, 40);
});

test('the watchdog makes this sense critical after 30 minutes, not 12 hours', async () => {
  const signals = require('./signals');
  const roomPresence = require('./room-presence');
  const watchdog = require('./watchdog');
  roomPresence.sensors = async () => ({ ok: true, sensors: [] });
  signals.snapshot = () => ({ signals: [{ id: 'household', label: "Who's in the house", state: 'error', why: 'x' }] });
  const at = (min) => ({ 'sense:household': { level: 'warn', since: new Date(NOW.getTime() - min * 60_000).toISOString() } });
  assert.equal((await watchdog.checkSenses(at(10), NOW))[0].level, 'warn');
  assert.equal((await watchdog.checkSenses(at(31), NOW))[0].level, 'critical');
});
