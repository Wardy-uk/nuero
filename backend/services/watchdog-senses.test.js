'use strict';

// A sense going quiet is told, not just rated (2 Oct 2026: the router trackers
// had been frozen for sixteen days and nothing said so).

const test = require('node:test');
const assert = require('node:assert/strict');

const signals = require('./signals');
const roomPresence = require('./room-presence');
const watchdog = require('./watchdog');

const NOW = new Date('2026-10-02T15:00:00Z');
const stub = (rows) => {
  roomPresence.sensors = async () => ({ ok: true, sensors: [] });
  signals.snapshot = () => ({ signals: rows });
};

test('a sense that has just died is a WARNING, with what SAiM loses', async () => {
  stub([{ id: 'phone', label: 'Phone', state: 'stale', why: 'no report for 3h', what: 'where you are' }]);
  const [i] = await watchdog.checkSenses({}, NOW);
  assert.equal(i.key, 'sense:phone');
  assert.equal(i.level, 'warn');
  assert.match(i.title, /Phone has gone quiet/);
  assert.match(i.detail, /SAiM loses: where you are/);
});

test('a core sense dead past the threshold is CRITICAL — the push is owed', async () => {
  stub([{ id: 'room-bedroom', label: 'Bedroom sensor', state: 'error', why: 'radio deaf' }]);
  const previous = { 'sense:room-bedroom': { level: 'warn', since: '2026-10-02T01:00:00Z' } };
  const [i] = await watchdog.checkSenses(previous, NOW);
  assert.equal(i.level, 'critical');
  assert.match(i.title, /stopped working/);
  assert.equal(i.since, '2026-10-02T01:00:00Z', 'the first-seen time is kept, not reset');
});

test('a non-core sense never escalates past a warning', async () => {
  stub([{ id: 'rescuetime', label: 'RescueTime', state: 'stale', why: 'missed days' }]);
  const [i] = await watchdog.checkSenses({ 'sense:rescuetime': { since: '2026-09-01T00:00:00Z' } }, NOW);
  assert.equal(i.level, 'warn');
});

test('"off" and "never" are decisions, not faults, and are never raised', async () => {
  stub([
    { id: 'diet', label: 'Diet', state: 'off' },
    { id: 'apple', label: 'Apple', state: 'never' },
    { id: 'watch', label: 'Watch', state: 'live' },
  ]);
  assert.deepEqual(await watchdog.checkSenses({}, NOW), []);
});
