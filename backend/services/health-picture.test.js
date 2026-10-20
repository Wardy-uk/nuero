'use strict';

/**
 * My Health's rules. PURE: compose() over plain day rows, the shape
 * health-daily.recentDays() returns. Fixtures follow the live payload of
 * 12 Oct 2026 (a HiLo average of 144/86, VO2 max 34 → 29.7, about 9kg gained since
 * February), because the point of the page is that those three facts only say
 * something side by side.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const hp = require('./health-picture');

const TODAY = '2026-10-12';
const NOW = Date.parse('2026-10-12T10:00:00Z');

function day(n) {
  const d = new Date(Date.UTC(2026, 9, 12 - n));
  return d.toISOString().slice(0, 10);
}

/** n days back from TODAY, newest first, complete except today. */
function days(count, fill = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({ day: day(i), complete: i > 0, ...fill(i) }));
}

const base = (over = {}) => ({ today: TODAY, nowMs: NOW, days: [], medical: { total: 0, diagnoses: [], prescriptions: [] }, ...over });
const find = (pic, id) => pic.insights.find((i) => i.id === id);

test('a home BP average at or above 135/85 is something to ACT on, with NICE named', () => {
  const pic = hp.compose(base({ days: days(15, () => ({ bpSystolic: 144, bpDiastolic: 86 })) }));
  const bp = find(pic, 'bp-high');
  assert.equal(bp.level, 'act');
  assert.match(bp.title, /144\/86/);
  assert.match(bp.basis, /NICE NG136/);
  assert.match(bp.action, /Book a blood-pressure review/);
  assert.match(bp.caveat, /not a diagnosis/);
  assert.equal(pic.systems.find((s) => s.id === 'bp').status, 'act');
});

test('below the threshold is good, and says so rather than staying silent', () => {
  const pic = hp.compose(base({ days: days(15, () => ({ bpSystolic: 124, bpDiastolic: 78 })) }));
  assert.equal(find(pic, 'bp-ok').level, 'good');
  assert.equal(find(pic, 'bp-high'), undefined);
});

test('the diastolic alone crossing 85 is enough', () => {
  const pic = hp.compose(base({ days: days(15, () => ({ bpSystolic: 128, bpDiastolic: 88 })) }));
  assert.equal(find(pic, 'bp-high').level, 'act');
});

test('too few readings is a GAP, never an average from three days', () => {
  const pic = hp.compose(base({ days: days(15, (i) => (i < 4 ? { bpSystolic: 160, bpDiastolic: 99 } : {})) }));
  assert.equal(find(pic, 'bp-high'), undefined);
  assert.equal(find(pic, 'bp-sparse').level, 'gap');
});

test('an existing diagnosis changes the action from "book" to "take it to the review"', () => {
  const pic = hp.compose(base({
    days: days(15, () => ({ bpSystolic: 144, bpDiastolic: 86 })),
    medical: { total: 1, diagnoses: ['Essential hypertension'], prescriptions: [] },
  }));
  assert.match(find(pic, 'bp-high').action, /next blood-pressure review/);
  assert.doesNotMatch(find(pic, 'bp-high').action, /Book/);
});

test('VO2 max is per kilogram: the share the scales explain is stated', () => {
  const rows = days(400, (i) => (i === 371 ? { weightKg: 92 } : i === 7 ? { weightKg: 101 } : {}));
  const pic = hp.compose(base({
    days: rows,
    fitnessData: { vo2max: { series: [{ week: day(371), value: 34 }, { week: day(7), value: 29.7 }],
      latest: { week: day(7), value: 29.7 }, change1y: -4.3 } },
  }));
  const f = find(pic, 'vo2-down');
  assert.equal(f.level, 'watch');
  // 34 × 92/101 = 30.97, so weight alone accounts for about 3.0 of the 4.3.
  assert.match(f.finding, /accounts for about 3 of that/);
});

test('a small VO2 change raises nothing', () => {
  const pic = hp.compose(base({ fitnessData: { vo2max: { series: [], latest: { week: day(7), value: 33 }, change1y: -0.8 } } }));
  assert.equal(find(pic, 'vo2-down'), undefined);
});

test('weight gained over the year is watched; a stale weigh-in is said', () => {
  const rows = days(300, (i) => (i === 240 ? { weightKg: 92 } : i === 40 ? { weightKg: 101.2 } : {}));
  const w = find(hp.compose(base({ days: rows })), 'weight-up');
  assert.equal(w.level, 'watch');
  assert.match(w.title, /up 9\.2kg since/);
  assert.match(w.finding, /40 days ago/);
  assert.match(w.action, /Weigh in this week/);
});

test('steady weight but a stale weigh-in is a GAP, not good news', () => {
  const rows = days(300, (i) => (i === 240 || i === 40 ? { weightKg: 95 } : {}));
  const pic = hp.compose(base({ days: rows }));
  assert.equal(find(pic, 'weight-stale').level, 'gap');
  assert.equal(pic.systems.find((s) => s.id === 'weight').status, 'unknown');
});

test('low recovery after a spike is today\'s act item, with the target range', () => {
  const pic = hp.compose(base({ perf: {
    recovery: { known: true, state: 'low', score: 33, contributors: [{ flag: 'adverse', note: 'resting heart rate 6.7bpm above normal' }] },
    trainingLoad: { known: true, state: 'spike', ratio: 1.64 }, target: { known: true, low: 44, high: 88 }, yesterday: { load: 463.1 },
  } }));
  const r = find(pic, 'recovery-today');
  assert.equal(r.level, 'act');
  assert.match(r.action, /between 44 and 88/);
  assert.match(r.finding, /1\.64× your usual/);
});

test('an unreadable input is NAMED, its rules do not run, and nothing claims an all-clear', () => {
  const pic = hp.compose(base({ unread: [{ input: 'days', why: 'disk' }, { input: 'days', why: 'disk' }] }));
  assert.equal(pic.complete, false);
  assert.equal(pic.systems.find((s) => s.id === 'bp').status, 'unknown');
  assert.match(pic.systems.find((s) => s.id === 'bp').sub, /Could not read days/);
  assert.equal(pic.insights.filter((i) => i.id === 'unread-days').length, 1);
  assert.doesNotMatch(pic.headline, /holding up/);
});

test('ranked act → watch → gap → good', () => {
  const pic = hp.compose(base({ days: days(30, () => ({ bpSystolic: 144, bpDiastolic: 86, daylightMinutes: 10 })) }));
  const order = ['act', 'watch', 'gap', 'good'];
  const ranks = pic.insights.map((i) => order.indexOf(i.level));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(pic.insights[0].id, 'bp-high');
});

test('no medical records is a gap that says what to add', () => {
  const m = find(hp.compose(base()), 'medical-none');
  assert.equal(m.view, 'medical');
  assert.match(m.action, /HbA1c/);
});

test('a source that stopped reporting is a gap naming what depends on it', () => {
  const pic = hp.compose(base({ sources: { watchMs: NOW - 60000, hiloMs: NOW - 5 * 86400000 } }));
  const hilo = pic.sources.find((s) => s.name === 'HiLo bracelet');
  assert.equal(hilo.state, 'stale');
  assert.match(find(pic, 'source-HiLo bracelet').title, /5 days/);
  // The JC Ring was removed on 20 Oct 2026: it must not come back as a source row.
  assert.ok(!pic.sources.some((s) => /ring/i.test(s.name)));
  assert.equal(pic.sources.find((s) => s.name === 'Apple Watch').state, 'live');
});

test('nothing says a condition is present — it reports measurements and thresholds', () => {
  const pic = hp.compose(base({ days: days(400, () => ({ bpSystolic: 160, bpDiastolic: 100, spo2: 90, daylightMinutes: 5 })) }));
  const text = pic.insights.map((i) => `${i.title} ${i.finding} ${i.action || ''}`).join(' ');
  assert.doesNotMatch(text, /you have (hypertension|sleep apnoea|apnea)|diagnosed with/i);
});

test('months are words, sliced from the key', () => {
  assert.equal(hp._internals.monthLabel('2026-02-12'), 'February 2026');
});
