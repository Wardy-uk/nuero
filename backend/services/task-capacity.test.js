'use strict';
// Can the work due be done in the free time there is? (5 Oct 2026)
const { test } = require('node:test');
const assert = require('node:assert');
const { computeCapacity, freeIntervals } = require('./task-capacity');

const MON_9 = new Date(2026, 9, 5, 9, 0); // Mon 5 Oct 2026, 09:00 local
const weekdays = (d) => d.getDay() !== 0 && d.getDay() !== 6;

test('free time is the working window minus blocking diary entries', () => {
  assert.deepEqual(freeIntervals({ busy: [[600, 660], [720, 780]] }), [[540, 600], [660, 720], [780, 1050]]);
  assert.deepEqual(freeIntervals({ busy: [], fromMin: 1000 }), [[1000, 1050]]);
});

test('over capacity is cumulative: work due Friday can use Tuesday', () => {
  // Tue fully booked; 2 x L (8h) due Wed. Mon has 8.5h free, Wed 8.5h — 17h free by Wed, 16h due: fits.
  const events = [{ date: '2026-10-06', start: '2026-10-06T09:00', end: '2026-10-06T17:30', showAs: 'busy' }];
  const ok = computeCapacity({ now: MON_9, isWorking: weekdays, events,
    tasks: [{ id: 1, text: 'A', due: '2026-10-07', minutes: 480 }, { id: 2, text: 'B', due: '2026-10-07', minutes: 480 }] });
  assert.equal(ok.overload, null);
  // A third L due Wednesday: 24h due against 17h free.
  const over = computeCapacity({ now: MON_9, isWorking: weekdays, events,
    tasks: [1, 2, 3].map((id) => ({ id, text: String(id), due: '2026-10-07', minutes: 480 })) });
  assert.equal(over.overload.by, '2026-10-07');
  assert.equal(over.overload.shortMinutes, 24 * 60 - (510 + 0 + 510));
});

test('a big task is flagged "start today" when the free time before its due date only just covers it', () => {
  // XL (16h) due Tuesday: Mon 8.5h + Tue 8.5h = 17h, an hour spare — latest start today 10:00.
  const r = computeCapacity({ now: MON_9, isWorking: weekdays, tasks: [{ id: 9, text: 'Build the KPI pack', due: '2026-10-06', minutes: 960 }] });
  assert.equal(r.startBy[0].status, 'start-today');
  assert.deepEqual(r.startBy[0].latestStart, { date: '2026-10-05', time: '10:00' });
  // Due tomorrow lunchtime-booked: cannot finish.
  const busy = [{ date: '2026-10-06', start: '2026-10-06T09:00', end: '2026-10-06T17:30', showAs: 'busy' }];
  const c = computeCapacity({ now: MON_9, isWorking: weekdays, events: busy, tasks: [{ id: 9, text: 'X', due: '2026-10-06', minutes: 960 }] });
  assert.equal(c.startBy[0].status, 'cannot-finish');
  assert.equal(c.startBy[0].shortMinutes, 960 - 510);
});

test('small tasks never get a start-by; unestimated ones are counted as assumed', () => {
  const r = computeCapacity({ now: MON_9, isWorking: weekdays, tasks: [{ id: 1, text: 'quick', due: '2026-10-05', minutes: 30 }, { id: 2, text: 'unknown', due: '2026-10-06', minutes: null }] });
  assert.equal(r.startBy.length, 0);
  assert.equal(r.assumedCount, 1);
  assert.equal(r.days[1].dueMinutes, 30);
});

test('weekends and free/cancelled entries are handled; a big overdue task is "overdue"', () => {
  const sat = new Date(2026, 9, 10, 10, 0);
  const r = computeCapacity({ now: sat, isWorking: weekdays, tasks: [{ id: 5, text: 'late', due: '2026-10-09', minutes: 240 }],
    events: [{ date: '2026-10-12', start: '2026-10-12T09:00', end: '2026-10-12T17:30', showAs: 'free' }] });
  assert.equal(r.days[0].freeMinutes, 0, 'Saturday has no working time');
  assert.equal(r.days[2].freeMinutes, 510, 'a free-marked entry blocks nothing');
  assert.equal(r.startBy[0].status, 'overdue');
});
