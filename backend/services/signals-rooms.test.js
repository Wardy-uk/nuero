'use strict';

// A row per room sensor on the NEURO Health page — the Pis, the study tablet and the
// bedroom phone (Nick, 12 Sep 2026). They are senses like any other and fail quietly:
// a sensor that stops takes its room's screen verdict and its greeting with it.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sensorRows, roomLabel } = require('./signals');

const NOW = new Date('2026-09-12T12:00:00Z');
const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
const sensor = (over = {}) => ({ room: 'study', at: at(3), healthy: true, status: 'present', rssiMedian: -40, ...over });
const payload = (sensors) => ({ ok: true, at: NOW.toISOString(), sensors });

test('a reporting sensor is live, and says what it hears and its battery', () => {
  const [row] = sensorRows(payload([sensor({ batteryPct: 63, charging: true })]), NOW);
  assert.equal(row.state, 'live');
  assert.equal(row.label, 'Study sensor');
  assert.match(row.detail, /watch -40 dBm/);
  assert.match(row.detail, /battery 63%/);
});

test('a battery that is not charging says so', () => {
  const [row] = sensorRows(payload([sensor({ batteryPct: 41, charging: false })]), NOW);
  assert.match(row.detail, /battery 41% \(not charging\)/);
});

test('a sensor that has stopped is stale, and says what is lost with it', () => {
  const [row] = sensorRows(payload([sensor({ at: at(120) })]), NOW);
  assert.equal(row.state, 'stale');
  assert.match(row.why, /screen verdict|greeting/);
  assert.equal(row.ageMinutes, 2);
});

// ⚠ The rule the Pi sensors are built on: zero background traffic means the radio is
// deaf, not that the room is empty.
test('a deaf radio is an error, not a quiet room', () => {
  const [row] = sensorRows(payload([sensor({ healthy: false, why: 'no BLE traffic at all' })]), NOW);
  assert.equal(row.state, 'error');
  assert.match(row.why, /no BLE traffic/);
});

test('an unreachable SARA is one honest error row, never an empty house', () => {
  const rows = sensorRows({ ok: false, why: 'could not reach SARA: ECONNREFUSED', sensors: [] }, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'error');
  assert.match(rows[0].why, /ECONNREFUSED/);
});

test('reachable but nothing reporting is "never", which is a different fact', () => {
  const rows = sensorRows({ ok: true, sensors: [] }, NOW);
  assert.equal(rows[0].state, 'never');
});

test('a reading with no timestamp is an error rather than assumed fresh', () => {
  const [row] = sensorRows(payload([sensor({ at: null })]), NOW);
  assert.equal(row.state, 'error');
});

test('one row per sensor, each named for its room', () => {
  const rows = sensorRows(payload([
    sensor({ room: 'study' }), sensor({ room: 'bedroom' }), sensor({ room: 'living-room' }), sensor({ room: 'kitchen' }),
  ]), NOW);
  assert.deepEqual(rows.map((r) => r.label), ['Study sensor', 'Bedroom sensor', 'Living Room sensor', 'Kitchen sensor']);
  assert.deepEqual(rows.map((r) => r.id), ['room-study', 'room-bedroom', 'room-living-room', 'room-kitchen']);
});

test('room ids read as places', () => {
  assert.equal(roomLabel('living-room'), 'Living Room');
  assert.equal(roomLabel(''), '');
});
