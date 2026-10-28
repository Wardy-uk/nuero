'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { plan, validate } = require('./task-autoschedule');

const items = (...mins) => mins.map((m, i) => ({ key: `t${i + 1}`, estimateMinutes: m }));

test('packs in list order up to the daily cap, skipping the weekend', () => {
  // Fri 30 Oct 2026, 2h a day: 60+60 fill Friday, the next goes to Monday.
  const r = plan({ startDate: '2026-10-30', maxHours: 2, items: items(60, 60, 90) });
  assert.deepStrictEqual(r.assignments.map(a => a.date), ['2026-10-30', '2026-10-30', '2026-11-02']);
  assert.strictEqual(r.capMinutes, 120);
});

test('never backfills: a small task after a big one stays after it', () => {
  const r = plan({ startDate: '2026-11-02', maxHours: 2, items: items(90, 60, 15) });
  // 90 on Mon; 60 does not fit (150>120) -> Tue; 15 joins Tue, not Mon.
  assert.deepStrictEqual(r.assignments.map(a => a.date), ['2026-11-02', '2026-11-03', '2026-11-03']);
});

test('a task bigger than the cap gets a day of its own and is flagged', () => {
  const r = plan({ startDate: '2026-11-02', maxHours: 1, items: items(30, 180, 30) });
  assert.deepStrictEqual(r.assignments.map(a => a.date), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.strictEqual(r.assignments[1].overCap, true);
  assert.strictEqual(r.days[1].overCap, true);
});

test('an unestimated task is assumed 30 minutes and says so', () => {
  const r = plan({ startDate: '2026-11-02', maxHours: 1, items: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] });
  assert.deepStrictEqual(r.assignments.map(a => a.date), ['2026-11-02', '2026-11-02', '2026-11-03']);
  assert.ok(r.assignments.every(a => a.assumed));
  assert.strictEqual(r.assumedCount, 3);
});

test('holidays and leave are skipped and reported; weekends are skipped silently', () => {
  const nonWorking = new Set(['2026-12-25', '2026-12-28', '2026-12-29']);
  const reasons = new Map([['2026-12-25', 'holiday'], ['2026-12-28', 'holiday'], ['2026-12-29', 'leave']]);
  const r = plan({ startDate: '2026-12-25', maxHours: 1, items: items(60), nonWorking, reasons });
  assert.strictEqual(r.assignments[0].date, '2026-12-30');
  assert.deepStrictEqual(r.skipped, [
    { date: '2026-12-25', reason: 'holiday' },
    { date: '2026-12-28', reason: 'holiday' },
    { date: '2026-12-29', reason: 'leave' },
  ]);
});

test('bad input is refused, never clamped', () => {
  assert.match(validate({ startDate: '2026-02-31', maxHours: 4, items: items(30) }), /real date/);
  assert.match(validate({ startDate: '2026-11-02', maxHours: 0, items: items(30) }), /maxHours/);
  assert.match(validate({ startDate: '2026-11-02', maxHours: 13, items: items(30) }), /maxHours/);
  assert.match(validate({ startDate: '2026-11-02', maxHours: 4, items: [] }), /at least one/);
  assert.match(validate({ startDate: '2026-11-01', maxHours: 4, items: items(30), today: '2026-11-02' }), /past/);
  assert.match(validate({ startDate: '2026-11-02', maxHours: 4, items: [{ key: 'a' }, { key: 'a' }] }), /twice/);
  assert.strictEqual(validate({ startDate: '2026-11-02', maxHours: 4, items: items(30), today: '2026-11-02' }), null);
});
