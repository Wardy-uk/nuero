'use strict';

/**
 * Pins the management-log arithmetic: logged within two working days, and
 * nothing overdue by more than five working days.
 */

const test = require('node:test');
const assert = require('node:assert');

const log = require('./management-log');

/** A holiday inside the window, to prove the count is working days not calendar. */
const HOLIDAY = new Set(['2026-08-31']);   // Summer bank holiday, a Monday

function row(over = {}) {
  return {
    id: 1,
    entry_date: '2026-08-12',
    logged_at: '2026-08-12T09:00:00.000Z',
    type: 'action',
    person: null,
    summary: 'An item',
    owner: 'Nick',
    due_date: '2026-08-14',
    status: 'open',
    resolved_date: null,
    hr_logged: 1,
    ...over,
  };
}

// ── Working-day arithmetic ───────────────────────────────────────────────────

test('working days skip weekends', () => {
  // Fri 14 Aug → Mon 17 Aug is one working day, not three calendar days.
  assert.equal(log.workingDaysBetween('2026-08-14', '2026-08-17'), 1);
  assert.equal(log.workingDaysBetween('2026-08-17', '2026-08-21'), 4);
  assert.equal(log.workingDaysBetween('2026-08-17', '2026-08-17'), 0);
});

test('a bank holiday inside the window does not count — a naive count reports a breach that is not one', () => {
  // Fri 28 Aug → Tue 1 Sep. Mon 31 Aug is the Summer bank holiday.
  assert.equal(log.workingDaysBetween('2026-08-28', '2026-09-01', HOLIDAY), 1);
  assert.equal(log.workingDaysBetween('2026-08-28', '2026-09-01'), 2, 'without the holiday set it is plain Mon-Fri');
});

// ── Overdue ──────────────────────────────────────────────────────────────────

test('overdue-now is counted in working days', () => {
  const rows = [row({ id: 4, due_date: '2026-08-14', status: 'open' })];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.overdueCount, 1);
  assert.equal(a.overdue[0].workingDaysOverdue, 1, 'Fri 14th to Mon 17th');
});

test('no plan baseline is carried any more', () => {
  const a = log.assess([row()], { today: '2026-08-17' });
  assert.equal(a.baseline, undefined);
  assert.equal(log.BASELINE_DATE, undefined);
  assert.equal(log.REVIEW_DATE, undefined);
});

test('the five-working-day standard is measured in working days', () => {
  const rows = [
    row({ id: 1, due_date: '2026-08-07', status: 'open' }),   // 6 working days by the 17th
    row({ id: 2, due_date: '2026-08-11', status: 'open' }),   // 4 working days
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.overdueCount, 2);
  assert.deepEqual(a.breachesFiveDay.map(b => b.id), [1]);
});

test('overdue is ranked worst-first', () => {
  const rows = [
    row({ id: 1, due_date: '2026-08-13' }),
    row({ id: 2, due_date: '2026-07-01' }),
    row({ id: 3, due_date: '2026-08-10' }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.overdue.map(o => o.id), [2, 3, 1]);
});

// ── Logged within two working days ───────────────────────────────────────────

test('an item logged more than two working days after it happened is a finding', () => {
  const rows = [
    // Happened Mon 10th, logged Wed 12th — two working days, compliant.
    row({ id: 1, entry_date: '2026-08-10', logged_at: '2026-08-12T09:00:00Z' }),
    // Happened Mon 10th, logged Fri 14th — four working days.
    row({ id: 2, entry_date: '2026-08-10', logged_at: '2026-08-14T09:00:00Z' }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.lateLogged.map(l => l.id), [2]);
  assert.equal(a.lateLogged[0].workingDays, 4);
});

test('a conversation over a weekend is not late — the rule is working days', () => {
  // Happened Fri 14th, logged Tue 18th: Mon + Tue = 2 working days.
  const rows = [row({ id: 1, type: 'conversation', entry_date: '2026-08-14', logged_at: '2026-08-18T09:00:00Z' })];
  const a = log.assess(rows, { today: '2026-08-18' });
  assert.deepEqual(a.lateLogged, []);
});

test('an open item without an owner or a due date is a gap in the log itself', () => {
  const rows = [row({ id: 1, owner: null, due_date: null, status: 'open' })];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.equal(a.missingOwner.length, 1);
  assert.equal(a.missingDue.length, 1);
  assert.equal(a.overdueCount, 0, 'no due date means not yet overdue — it means unfollowable');
});

test('a closed item is not chased for a missing owner', () => {
  const rows = [row({ id: 1, owner: null, due_date: null, status: 'done', resolved_date: '2026-08-15' })];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.missingOwner, []);
  assert.equal(a.totals.closed, 1);
});

// ── People HR ────────────────────────────────────────────────────────────────

test('a conversation or concern not in People HR is a finding; a plain action is not', () => {
  const rows = [
    row({ id: 1, type: 'conversation', hr_logged: 0 }),
    row({ id: 2, type: 'concern', hr_logged: 0 }),
    row({ id: 3, type: 'action', hr_logged: 0 }),
    row({ id: 4, type: 'conversation', hr_logged: 1 }),
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.hrGap.map(h => h.id), [1, 2]);
});

test('assess needs no database, no vault and no network', () => {
  assert.doesNotThrow(() => log.assess([], { today: '2026-08-17' }));
  const a = log.assess([], { today: '2026-08-17' });
  assert.deepEqual(a.totals, { rows: 0, open: 0, closed: 0 });
});

// ── Mirroring into the task store ────────────────────────────────────────────

test('only Nick-owned items mirror — an action owned by Chris is tracked, not done', () => {
  assert.equal(log.ownedByNick({ owner: 'Nick' }), true);
  assert.equal(log.ownedByNick({ owner: 'nick' }), true);
  assert.equal(log.ownedByNick({ owner: 'Chris' }), false,
    "putting Chris's commitments on Nick's task list makes his own list lie about what is his");
  assert.equal(log.ownedByNick({ owner: null }), false);
  assert.equal(log.ownedByNick({}), false);
});

test('closure travels both ways — said in whichever place Nick is looking', () => {
  const src = log.reconcileTasks.toString();
  assert.match(src, /taskClosed && !isClosed\(row\)/, 'a ticked task closes the log row');
  assert.match(src, /isClosed\(row\) && !taskClosed/, 'a closed log row closes the task');
});

test('a deleted task is forgotten rather than pointed at', () => {
  assert.match(log.reconcileTasks.toString(), /SET task_id = NULL/);
});

test('a task-store failure never loses the log entry', () => {
  // The log is the compliance record. If only one half can survive, it is this one.
  assert.match(log.ensureTask.toString(), /catch/);
  assert.match(log.ensureTask.toString(), /return row/);
});

// ── People HR is three states, not two ───────────────────────────────────────

test('unknown is not a gap — nothing measured it', () => {
  const rows = [
    row({ id: 1, type: 'concern', hr_logged: null }),        // never asked
    row({ id: 2, type: 'conversation', hr_logged: 0 }),      // confirmed absent
    row({ id: 3, type: 'conversation', hr_logged: 1 }),      // confirmed present
  ];
  const a = log.assess(rows, { today: '2026-08-17' });
  assert.deepEqual(a.hrGap.map(h => h.id), [2], 'only a confirmed 0 is a finding');
  assert.deepEqual(a.hrUnknown.map(h => h.id), [1], 'unknown is a question for Nick');
});

test('an undefined flag is unknown, not absent', () => {
  const a = log.assess([row({ id: 1, type: 'concern', hr_logged: undefined })], { today: '2026-08-17' });
  assert.deepEqual(a.hrGap, []);
  assert.equal(a.hrUnknown.length, 1);
});

test('a plain action is neither — People HR is about people', () => {
  const a = log.assess([row({ id: 1, type: 'action', hr_logged: null })], { today: '2026-08-17' });
  assert.deepEqual(a.hrGap, []);
  assert.deepEqual(a.hrUnknown, []);
});
