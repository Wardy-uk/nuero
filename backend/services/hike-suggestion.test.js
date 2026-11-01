'use strict';

// Hike suggestions (1 Nov 2026). The gates are pure; the diary read and
// "not this weekend" go through a real DB.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hikesug-')), 'test.db');

const db = require('../db/database');
const hs = require('./hike-suggestion');

test.before(async () => { await db.init(); });

// A Wednesday morning; the weekend is the 7th/8th.
const WED = '2026-11-04T09:00';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const GOOD = { state: 'favourable', line: 'Looks favourable — 0 mm.' };
const MIXED = { state: 'mixed', line: 'Mixed — 60% chance.' };
const behind = { known: true, behindBy: 1, why: '0 of 1 this week' };
const base = (over = {}) => ({ nowLocal: WED, goal: behind, weather: () => GOOD, plans: [], events: { [SAT]: [], [SUN]: [] }, dismissed: {}, lastTrips: [], ...over });

test('the weekend and its days', () => {
  assert.deepStrictEqual(hs.weekend(WED), { key: SAT, days: [SAT, SUN] });
  assert.deepStrictEqual(hs.weekend(`${SAT}T08:00`), { key: SAT, days: [SAT, SUN] });
  assert.deepStrictEqual(hs.weekend(`${SAT}T13:00`), { key: SAT, days: [SUN] });
  assert.deepStrictEqual(hs.weekend(`${SUN}T13:00`), { key: SAT, days: [] });
});

test('good forecast + behind + free day → one suggestion for Saturday, prefilled from the last walk', () => {
  const r = hs.decide(base({ lastTrips: [{ name: 'Mam Tor', ember: true, party: [{ name: 'Helen' }] }, { name: 'Kinder', ember: true, party: [] }, { name: 'Edale', ember: false, party: [] }] }));
  assert.ok(r.suggestion);
  assert.strictEqual(r.suggestion.day, SAT);
  assert.strictEqual(r.suggestion.line, "Saturday looks good and you're 1 hike behind — plan one?");
  assert.strictEqual(r.suggestion.prefill.plannedStart, `${SAT}T09:30`);
  assert.strictEqual(r.suggestion.prefill.name, 'Mam Tor');
  assert.strictEqual(r.suggestion.prefill.emberPlanned, true);
  assert.deepStrictEqual(r.suggestion.prefill.party, [{ name: 'Helen' }]);
});

test('each gate holds on its own', () => {
  assert.strictEqual(hs.decide(base({ goal: { known: true, behindBy: 0, why: 'done' } })).suggestion, null, 'not behind');
  assert.strictEqual(hs.decide(base({ goal: { known: false, why: 'cannot tell' } })).suggestion, null, 'unknown goal');
  assert.strictEqual(hs.decide(base({ weather: () => MIXED })).suggestion, null, 'mixed weather');
  assert.strictEqual(hs.decide(base({ weather: () => null })).suggestion, null, 'no forecast');
  assert.strictEqual(hs.decide(base({ dismissed: { [SAT]: 'x' } })).suggestion, null, 'not this weekend');
  // Saturday busy → Sunday.
  const busy = hs.decide(base({ events: { [SAT]: [{ subject: 'Wedding', start_time: `${SAT}T00:00`, end_time: `${SUN}T00:00`, is_all_day: 1, show_as: 'free' }], [SUN]: [] } }));
  assert.strictEqual(busy.suggestion.day, SUN);
  // Saturday planned already → Sunday is not offered either? It is: one plan per weekend is not the rule — a plan on Saturday removes Saturday only.
  const planned = hs.decide(base({ plans: [{ day: SAT }] }));
  assert.strictEqual(planned.suggestion.day, SUN);
  // A diary that could not be read is not a free day.
  assert.strictEqual(hs.decide(base({ events: {} })).suggestion, null);
});

test('the diary: free-marked timed events and cancelled ones do not block; a timed busy one does; evening does not', () => {
  assert.ok(hs.dayFree([{ subject: 'Lunch', start_time: `${SAT}T12:00`, end_time: `${SAT}T13:00`, show_as: 'free' }], SAT).free);
  assert.ok(hs.dayFree([{ subject: 'Party', start_time: `${SAT}T19:00`, end_time: `${SAT}T23:00`, show_as: 'busy' }], SAT).free);
  assert.ok(!hs.dayFree([{ subject: 'Football', start_time: `${SAT}T10:00`, end_time: `${SAT}T12:00`, show_as: 'busy' }], SAT).free);
  assert.ok(hs.dayFree([{ subject: 'hiking', start_time: `${SAT}T00:00`, end_time: `${SUN}T00:00`, is_all_day: 1 }], SAT).free);
});

test('not this weekend is remembered for that weekend only, and only a Saturday is a weekend key', () => {
  assert.strictEqual(hs.dismiss('2026-11-06').ok, false);
  assert.ok(hs.dismiss(SAT, { now: Date.parse('2026-11-04T09:00:00Z') }).ok);
  const stored = JSON.parse(db.getState(hs.DISMISS_KEY));
  assert.ok(stored[SAT]);
  assert.ok(db.get("SELECT 1 FROM personal_ops_events WHERE kind = 'hike-suggestion-dismissed'"));
});
