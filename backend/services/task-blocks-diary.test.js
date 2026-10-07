'use strict';
// check_diary's pure half. 7 Oct 2026: the EOD said "I don't have tomorrow's
// calendar" while the cache held a fortnight of it.
const test = require('node:test');
const assert = require('node:assert');
const { freeGapsOn } = require('./task-blocks');

const ev = (start, end, extra = {}) => ({
  date: start.slice(0, 10), start, end, subject: 'x', isAllDay: false, showAs: 'busy', ...extra,
});
const NOW = new Date(2026, 9, 7, 17, 0); // Wed 7 Oct 17:00 local

test('tomorrow: gaps between meetings, from 09:00 to 17:30', () => {
  const r = freeGapsOn({
    dateKey: '2026-10-08',
    now: NOW,
    events: [ev('2026-10-08T10:00:00', '2026-10-08T11:00:00'), ev('2026-10-08T13:00:00', '2026-10-08T14:30:00')],
  });
  assert.deepStrictEqual(r.gaps.map(g => `${g.start}-${g.end}`), ['09:00-10:00', '11:00-13:00', '14:30-17:30']);
  assert.strictEqual(r.meetings.length, 2);
});

test('free and all-day events are listed but are not walls; other days are ignored', () => {
  const r = freeGapsOn({
    dateKey: '2026-10-08',
    now: NOW,
    events: [
      ev('2026-10-08T10:00:00', '2026-10-08T11:00:00', { showAs: 'free' }),
      ev('2026-10-08T00:00:00', '2026-10-09T00:00:00', { isAllDay: true }),
      ev('2026-10-09T09:00:00', '2026-10-09T17:30:00'),
    ],
  });
  assert.deepStrictEqual(r.gaps.map(g => `${g.start}-${g.end}`), ['09:00-17:30']);
  assert.strictEqual(r.meetings.length, 2);
});

test('today starts from now, not 09:00', () => {
  const r = freeGapsOn({ dateKey: '2026-10-07', now: new Date(2026, 9, 7, 14, 2), events: [] });
  assert.deepStrictEqual(r.gaps.map(g => g.start), ['14:15']);
});

test('times are sliced from the string, never re-zoned', () => {
  const r = freeGapsOn({ dateKey: '2026-10-08', now: NOW, events: [ev('2026-10-08T09:00:00', '2026-10-08T17:30:00')] });
  assert.strictEqual(r.gaps.length, 0);
  assert.strictEqual(r.meetings[0].start, '09:00');
});
