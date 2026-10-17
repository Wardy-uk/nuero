'use strict';

// Repeating tasks — the PURE schedule (shared/task-recurrence.cjs). No DB, no
// clock: `today` is always passed in, so nothing here is a date bomb.

const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../../shared/task-recurrence.cjs');

function rule(input, anchor) {
  const v = r.validateRule(input, { defaultAnchor: anchor || null });
  assert.equal(v.ok, true, v.error);
  return v.rule;
}

// ── #448, Nick's first repeating task ───────────────────────────────────────

test('every 2 weeks from Sat 31 Oct 2026 runs on Saturdays a fortnight apart', () => {
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  assert.equal(fortnight.anchor, '2026-10-31');
  assert.deepEqual(r.upcoming(fortnight, { from: '2026-10-01', count: 4 }),
    ['2026-10-31', '2026-11-14', '2026-11-28', '2026-12-12']);
  assert.equal(r.describe(fortnight), 'Every 2 weeks');
});

// ── Fixed calendar slot ─────────────────────────────────────────────────────

test('FIXED SLOT: ticked early, the next due is the slot after the one that was due — never tick date + 2 weeks', () => {
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  // Ticked on Thursday the 29th: a tick-date schedule would say 12 Nov.
  assert.equal(r.nextDueAfterCompletion(fortnight, { completedDue: '2026-10-31', today: '2026-10-29' }), '2026-11-14');
});

test('FIXED SLOT: ticked a few days late, the series stays on its Saturdays', () => {
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  // Ticked Tue 3 Nov: tick-date + 14 would be 17 Nov, a Tuesday.
  assert.equal(r.nextDueAfterCompletion(fortnight, { completedDue: '2026-10-31', today: '2026-11-03' }), '2026-11-14');
});

// ── Missed slots are skipped, never stacked ─────────────────────────────────

test('SKIP MISSED: an occurrence ticked after the next slot has passed jumps to the next FUTURE slot', () => {
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  // 14 Nov went by unticked; ticked on the 20th → 28 Nov, not 14 Nov.
  assert.equal(r.nextDueAfterCompletion(fortnight, { completedDue: '2026-10-31', today: '2026-11-20' }), '2026-11-28');
  // Months behind: still one step to the future, never a backlog.
  assert.equal(r.nextDueAfterCompletion(fortnight, { completedDue: '2026-10-31', today: '2027-02-01' }), '2027-02-06');
});

test('a slot falling TODAY is covered by today\'s tick (no doing it twice in one sitting)', () => {
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  assert.equal(r.nextDueAfterCompletion(fortnight, { completedDue: '2026-10-31', today: '2026-11-14' }), '2026-11-28');
});

test('no recorded due date: today alone decides', () => {
  const weekly = rule({ kind: 'interval', every: 1, unit: 'week' }, '2026-10-05');
  assert.equal(r.nextDueAfterCompletion(weekly, { completedDue: null, today: '2026-10-14' }), '2026-10-19');
});

// ── Days / weeks / months ───────────────────────────────────────────────────

test('every N days', () => {
  const r3 = rule({ kind: 'interval', every: 3, unit: 'day' }, '2026-10-30');
  assert.deepEqual(r.upcoming(r3, { from: '2026-10-30', count: 3 }), ['2026-10-30', '2026-11-02', '2026-11-05']);
  assert.equal(r.describe(r3), 'Every 3 days');
  assert.equal(r.describe(rule({ kind: 'interval', unit: 'day' }, '2026-10-30')), 'Every day');
});

test('BST: a daily series runs straight through the clocks going back (25 Oct 2026)', () => {
  const daily = rule({ kind: 'interval', unit: 'day' }, '2026-10-24');
  assert.deepEqual(r.upcoming(daily, { from: '2026-10-24', count: 4 }),
    ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  // And across the clocks going forward (29 Mar 2026).
  const weekly = rule({ kind: 'interval', unit: 'week' }, '2026-03-22');
  assert.deepEqual(r.upcoming(weekly, { from: '2026-03-22', count: 3 }), ['2026-03-22', '2026-03-29', '2026-04-05']);
});

test('MONTH END: anchored on the 31st, each month is counted from the anchor and clamped, never chained', () => {
  const monthly = rule({ kind: 'interval', unit: 'month' }, '2026-01-31');
  assert.deepEqual(r.upcoming(monthly, { from: '2026-01-01', count: 5 }),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
});

test('LEAP YEAR: 31 Jan 2028 → 29 Feb 2028; a 29 Feb anchor lands on 28 Feb in 2029', () => {
  const monthly = rule({ kind: 'interval', unit: 'month' }, '2028-01-31');
  assert.equal(r.upcoming(monthly, { from: '2028-02-01', count: 1 })[0], '2028-02-29');
  const yearly = rule({ kind: 'interval', every: 12, unit: 'month' }, '2028-02-29');
  assert.deepEqual(r.upcoming(yearly, { from: '2028-02-29', count: 3 }), ['2028-02-29', '2029-02-28', '2030-02-28']);
});

test('every 3 months', () => {
  const quarterly = rule({ kind: 'interval', every: 3, unit: 'month' }, '2026-11-15');
  assert.deepEqual(r.upcoming(quarterly, { from: '2026-11-16', count: 2 }), ['2027-02-15', '2027-05-15']);
  assert.equal(r.describe(quarterly), 'Every 3 months');
});

// ── Specific weekdays ───────────────────────────────────────────────────────

test('Mon/Wed/Fri every week', () => {
  const mwf = rule({ kind: 'weekdays', days: ['fri', 'mon', 'wed'] }, '2026-10-19');
  assert.deepEqual(mwf.days, ['mon', 'wed', 'fri']);
  assert.deepEqual(r.upcoming(mwf, { from: '2026-10-21', count: 4 }), ['2026-10-21', '2026-10-23', '2026-10-26', '2026-10-28']);
  assert.equal(r.describe(mwf), 'Every Mon, Wed, Fri');
  // Ticked Wed → Fri, not next Wed.
  assert.equal(r.nextDueAfterCompletion(mwf, { completedDue: '2026-10-21', today: '2026-10-21' }), '2026-10-23');
});

test('every 2 weeks on Mon and Fri, counted from the anchor\'s week', () => {
  const alt = rule({ kind: 'weekdays', every: 2, days: ['mon', 'fri'] }, '2026-10-19');
  assert.deepEqual(r.upcoming(alt, { from: '2026-10-19', count: 4 }), ['2026-10-19', '2026-10-23', '2026-11-02', '2026-11-06']);
  assert.equal(r.describe(alt), 'Every 2 weeks on Mon, Fri');
});

test('weekday labels', () => {
  assert.equal(r.describe(rule({ kind: 'weekdays', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, '2026-10-19')), 'Every weekday');
  assert.equal(r.describe(rule({ kind: 'weekdays', days: ['thu'] }, '2026-10-19')), 'Every Thursday');
});

// ── Monthly patterns ────────────────────────────────────────────────────────

test('first Monday of the month', () => {
  const first = rule({ kind: 'nth-weekday', nth: 1, weekday: 'mon' }, '2026-10-01');
  assert.deepEqual(r.upcoming(first, { from: '2026-10-01', count: 3 }), ['2026-10-05', '2026-11-02', '2026-12-07']);
  assert.equal(r.describe(first), 'First Monday of the month');
});

test('last Friday of the month, and every 2 months', () => {
  const last = rule({ kind: 'nth-weekday', nth: -1, weekday: 'fri' }, '2026-10-01');
  assert.deepEqual(r.upcoming(last, { from: '2026-10-01', count: 3 }), ['2026-10-30', '2026-11-27', '2026-12-25']);
  assert.equal(r.describe(last), 'Last Friday of the month');
  const bi = rule({ kind: 'nth-weekday', every: 2, nth: 2, weekday: 'tue' }, '2026-10-01');
  assert.deepEqual(r.upcoming(bi, { from: '2026-10-01', count: 2 }), ['2026-10-13', '2026-12-08']);
  assert.equal(r.describe(bi), 'Second Tuesday, every 2 months');
});

test('LAST WORKING DAY: weekends are skipped back to Friday', () => {
  const lwd = rule({ kind: 'last-working-day' }, '2026-01-01');
  // Jan 2026 ends Sat 31 → Fri 30; May 2026 ends Sun 31 → Fri 29.
  assert.deepEqual(r.upcoming(lwd, { from: '2026-01-01', count: 5 }),
    ['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30', '2026-05-29']);
  assert.equal(r.describe(lwd), 'Last working day of the month');
});

test('LAST WORKING DAY: a bank holiday on the last weekday steps back to the previous working day', () => {
  const lwd = rule({ kind: 'last-working-day' }, '2026-08-01');
  // 31 Aug 2026 is the Summer bank holiday (a Monday) → Fri 28 Aug.
  assert.equal(r.upcoming(lwd, { from: '2026-08-01', count: 1, nonWorking: new Set(['2026-08-31']) })[0], '2026-08-28');
  // Without the holiday set it is the 31st — the set is what moves it.
  assert.equal(r.upcoming(lwd, { from: '2026-08-01', count: 1 })[0], '2026-08-31');
  // Christmas 2026: Thu 31 Dec is a working day; in a year where the last days are holidays it walks further back.
  assert.equal(r.upcoming(lwd, { from: '2027-12-01', count: 1, nonWorking: new Set(['2027-12-27', '2027-12-28', '2027-12-31']) })[0], '2027-12-30');
});

// ── Refused, never clamped ──────────────────────────────────────────────────

test('bad rules are REFUSED with a reason, never clamped or guessed', () => {
  const bad = [
    null,
    'every 2 weeks',
    { kind: 'fortnightly' },
    { kind: 'interval', unit: 'year' },
    { kind: 'interval', unit: 'week', every: 0 },
    { kind: 'interval', unit: 'week', every: 1.5 },
    { kind: 'interval', unit: 'week', every: 53 },
    { kind: 'interval', unit: 'month', every: 25 },
    { kind: 'interval', unit: 'week', anchor: '2026-02-31' },
    { kind: 'interval', unit: 'week', anchor: 'tomorrow' },
    { kind: 'interval', unit: 'week', days: ['mon'] },
    { kind: 'weekdays', days: [] },
    { kind: 'weekdays', days: ['mon', 'funday'] },
    { kind: 'weekdays', days: ['mon', 'mon'] },
    { kind: 'nth-weekday', nth: 5, weekday: 'mon' },
    { kind: 'nth-weekday', nth: 0, weekday: 'mon' },
    { kind: 'nth-weekday', nth: 1, weekday: 'someday' },
  ];
  for (const input of bad) {
    const v = r.validateRule(input, { defaultAnchor: '2026-10-31' });
    assert.equal(v.ok, false, `should refuse ${JSON.stringify(input)}`);
    assert.ok(v.error, 'a refusal names its reason');
  }
  // No anchor and no default is refused, not invented.
  assert.equal(r.validateRule({ kind: 'interval', unit: 'week' }).ok, false);
});

test('a stored rule round-trips; an unreadable one reads as no rule', () => {
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  assert.deepEqual(r.parseStored(JSON.stringify(fortnight)), fortnight);
  assert.equal(r.parseStored('{not json'), null);
  assert.equal(r.parseStored(null), null);
  assert.equal(r.describe(null), null);
});

test('firstDue gives a dateless task its first slot on or after today', () => {
  const weekly = rule({ kind: 'interval', unit: 'week' }, '2026-10-05');
  assert.equal(r.firstDue(weekly, { today: '2026-10-17' }), '2026-10-19');
  assert.equal(r.firstDue(weekly, { today: '2026-10-19' }), '2026-10-19');
  // A future anchor is the first slot.
  const fortnight = rule({ kind: 'interval', every: 2, unit: 'week' }, '2026-10-31');
  assert.equal(r.firstDue(fortnight, { today: '2026-10-17' }), '2026-10-31');
});

test('shortDate is sliced, not parsed in the reader\'s zone', () => {
  assert.equal(r.shortDate('2026-11-14'), 'Sat 14 Nov');
  assert.equal(r.shortDate('nonsense'), null);
});
