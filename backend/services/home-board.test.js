'use strict';

// The household board — what a home screen shows when Nick is not in its room.
// Everything on it must be safe for whoever is standing there.

const test = require('node:test');
const assert = require('node:assert/strict');
const board = require('./home-board');

const NOW = new Date(2026, 9, 2, 13, 0);

const ROWS = [
  { event_id: 'a', subject: 'Moreland escalation call', location: 'Moreland Estates, Leeds', start_time: '2026-10-02T14:00:00', end_time: '2026-10-02T15:00:00', source: 'graph', show_as: 'busy' },
  { event_id: 'b', subject: 'Dentist', start_time: '2026-10-02T16:30:00', end_time: '2026-10-02T17:00:00', source: 'apple', show_as: 'busy' },
  { event_id: 'c', subject: 'Morning standup', start_time: '2026-10-02T09:00:00', end_time: '2026-10-02T09:15:00', source: 'graph', show_as: 'busy' },
  { event_id: 'd', subject: 'Optional thing', start_time: '2026-10-02T15:00:00', end_time: '2026-10-02T15:30:00', source: 'graph', show_as: 'free' },
];

test('⚠ a work event is "Busy" and its subject and location are not in the object at all', () => {
  const out = board.restOfDay(ROWS, NOW);
  const work = out.find((e) => e.start === '14:00');
  assert.equal(work.title, 'Busy');
  assert.equal(JSON.stringify(out).includes('Moreland'), false, 'a client name must never reach a wall');
  assert.equal(JSON.stringify(out).includes('Leeds'), false);
});

test('a personal event keeps its title, so the board is actually useful', () => {
  const out = board.restOfDay(ROWS, NOW);
  assert.equal(out.find((e) => e.start === '16:30').title, 'Dentist');
});

test('the rest of the day only: finished and free-marked events are dropped', () => {
  const out = board.restOfDay(ROWS, NOW);
  assert.deepEqual(out.map((e) => e.start), ['14:00', '16:30']);
});

test('the house line names other rooms with lights on, not this one', () => {
  const house = {
    known: true,
    rooms: [
      { area: 'Office', lights: [{ state: 'on' }] },
      { area: 'Kitchen', lights: [{ state: 'on' }, { state: 'off' }] },
      { area: 'Hall', lights: [{ state: 'off' }] },
    ],
    household: { known: true, othersHome: true, who: ['Helen'] },
  };
  const s = board.houseSummary(house, 'Office');
  assert.deepEqual(s.lightsOnElsewhere, ['Kitchen']);
  assert.deepEqual(s.household, { known: true, othersHome: true, who: ['Helen'] });
});

test('an unread house is a named gap, not an empty house', () => {
  assert.equal(board.houseSummary({ known: false }, 'Office').known, false);
});

test('weather in Fahrenheit is converted, never shown as Celsius', () => {
  const w = board.weatherLines({ known: true, tempC: 68, unit: '°F', condition: 'sunny', hours: [] }, () => ({ lines: ['Dry all afternoon.'] }), NOW);
  assert.equal(w.tempC, 20);
  assert.deepEqual(w.lines, ['Dry all afternoon.']);
});

test('weather conditions read as words, not Home Assistant ids', () => {
  assert.equal(board.conditionLabel('partlycloudy'), 'Partly cloudy');
  assert.equal(board.conditionLabel('lightning-rainy'), 'Thunderstorms');
  assert.equal(board.conditionLabel('new-thing'), 'New thing');
  assert.equal(board.conditionLabel(null), null);
});

test('the house line says when the TV is on', () => {
  const s = board.houseSummary({ known: true, rooms: [], household: { known: false } }, 'Office', { tvOn: true });
  assert.equal(s.tvOn, true);
});

// ── the weather station card ────────────────────────────────────────────────

test('station: a live reading becomes temperature, humidity, pressure and the trend', () => {
  const nowMs = NOW.getTime();
  const latest = { observedAt: nowMs - 60000, temperatureC: 11.26, humidityPct: 82.4, pressureHpa: 1008.6, stale: false };
  const summary = { evidence: { pressureTendency: 'falling slowly' }, sensor: { available: true, verdict: 'Pressure falling slowly — possibly turning less settled.', indoorLikely: false } };
  const c = board.stationCard(latest, summary, nowMs);
  assert.equal(c.known, true);
  assert.equal(c.tempC, 11.3);
  assert.equal(c.humidityPct, 82);
  assert.equal(c.pressureHpa, 1009);
  assert.equal(c.tendency, 'falling slowly');
  assert.match(c.verdict, /falling slowly/);
});

test('⚠ station: a stale reading is a named gap with its age, never old numbers as now', () => {
  const nowMs = NOW.getTime();
  const c = board.stationCard({ observedAt: nowMs - 3 * 3600000, temperatureC: 4, stale: true }, null, nowMs);
  assert.equal(c.known, false);
  assert.equal(c.tempC, undefined, 'no temperature leaks through');
  assert.match(c.why, /3 h/);
  assert.equal(board.stationCard(null, null, nowMs).known, false);
});

test('station: no verdict line until the sensor has enough history to have one', () => {
  const nowMs = NOW.getTime();
  const c = board.stationCard({ observedAt: nowMs, temperatureC: 10, stale: false }, { evidence: {}, sensor: { available: false, verdict: 'Too little history…' } }, nowMs);
  assert.equal(c.verdict, null);
});
