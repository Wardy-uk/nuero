'use strict';

/** Exertion from heart rate, decided without a database. */

const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('./exertion');

const at = (min) => new Date(Date.UTC(2026, 8, 20, 8, 0) + min * 60000).toISOString();

test('display bands sit where HIS effort is: fractions of reserve from 20%', () => {
  // rest 75, max 158 (his measured scale) → reserve 83; 20% is ~92 bpm.
  assert.equal(ex.zoneOf(91, 75, 158), 0);
  assert.equal(ex.zoneOf(92, 75, 158), 1);
  assert.equal(ex.zoneOf(126, 75, 158), 5);
});

test('sitting is not effort: nothing under resting + 10 counts', () => {
  const sitting = Array.from({ length: 120 }, (_, i) => ({ v: 84, t: at(i) }));
  assert.equal(ex.dayLoad(sitting, { rest: 75, max: 158 }).load, 0);
  const walking = Array.from({ length: 120 }, (_, i) => ({ v: 100, t: at(i) }));
  assert.ok(ex.dayLoad(walking, { rest: 75, max: 158 }).load > 20);
});

test('load is time-weighted: dense workout sampling does not inflate it', () => {
  // 30 minutes at 150 bpm (zone 3 at rest 60 / max 180), sampled every 5 s…
  const dense = Array.from({ length: 360 }, (_, i) => ({ v: 150, t: at(i / 12) }));
  // …and the same 30 minutes sampled every 5 minutes.
  const sparse = Array.from({ length: 6 }, (_, i) => ({ v: 150, t: at(i * 5) }));
  const a = ex.dayLoad(dense, { rest: 60, max: 180 });
  const b = ex.dayLoad(sparse, { rest: 60, max: 180 });
  assert.ok(Math.abs(a.load - b.load) < 5, `${a.load} vs ${b.load}`);
  assert.ok(a.zoneMinutes[4] >= 29 && a.zoneMinutes[4] <= 31, `got ${a.zoneMinutes[4]}`);
});

test('a watch off the wrist counts for the cap, not for hours', () => {
  const d = ex.dayLoad([{ v: 150, t: at(0) }, { v: 150, t: at(180) }], { rest: 60, max: 180 });
  // Each of the two readings stands for at most the 15-minute cap — 30, not 180.
  assert.ok(d.zoneMinutes[4] <= 30, `got ${d.zoneMinutes[4]}`);
  assert.equal(d.partial, true);
});

test('no scale, no load — never a zero', () => {
  const d = ex.dayLoad([{ v: 150, t: at(0) }], { rest: null, max: 180 });
  assert.equal(d.known, false);
  assert.equal(d.load, null);
});

test('max HR: an override wins, and the source is said', () => {
  assert.deepEqual(ex.estimateMax([150, 171, 160], '185'), { value: 185, source: 'override' });
  assert.deepEqual(ex.estimateMax([150, 171.4, 160], undefined), { value: 171, source: 'observed' });
});

const days = (loads) => loads.map((load, i) => ({ day: `2026-09-${String(28 - i).padStart(2, '0')}`, load }));

test('two near-zero loads are not a spike', () => {
  const t = ex.trainingLoad(days([...Array(7).fill(5), ...Array(21).fill(0)]));
  assert.equal(t.known, false);
});

test('training load needs three weeks before it says anything', () => {
  assert.equal(ex.trainingLoad(days(Array(20).fill(100))).known, false);
});

test('a hard week against a steady month is a spike, and says it is a heuristic', () => {
  const t = ex.trainingLoad(days([...Array(7).fill(300), ...Array(21).fill(100)]));
  assert.equal(t.state, 'spike');
  assert.match(t.basis, /heuristic/);
  assert.equal(ex.trainingLoad(days(Array(28).fill(100))).state, 'steady');
});

test('target follows recovery, against HIS usual, and refuses when recovery is unknown', () => {
  const load = { known: true, chronic: 100 };
  assert.deepEqual([ex.target({ known: true, state: 'low' }, load).low, ex.target({ known: true, state: 'low' }, load).high], [40, 80]);
  assert.equal(ex.target({ known: true, state: 'high' }, load).high, 140);
  assert.equal(ex.target({ known: false, reason: 'calibrating' }, load).known, false);
});

test('a day is LOCAL — 23:30 UTC in summer is tomorrow in London', () => {
  assert.equal(ex.localDayKey(Date.parse('2026-06-20T23:30:00Z'), 'Europe/London'), '2026-06-21');
});
