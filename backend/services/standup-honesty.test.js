'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('./standup-honesty');

const TODAY = '2026-11-06';

test('nothing slipped is rung 0', () => {
  assert.strictEqual(h.rungFor({ due: '2026-11-10' }, TODAY).rung, 0);
  assert.strictEqual(h.rungFor({ due: null }, TODAY).rung, 0);
});

test('a first slip is rung 1, a pattern rung 2, three or more rung 3', () => {
  assert.strictEqual(h.rungFor({ due: '2026-11-05' }, TODAY).rung, 1);
  assert.strictEqual(h.rungFor({ due: '2026-11-05', dueMoves: 1 }, TODAY).rung, 2);
  const r = h.rungFor({ due: '2026-11-05', dueMoves: 2, lapsedBlocks: 1, daysCarried: 3 }, TODAY);
  assert.strictEqual(r.rung, 3);
  assert.ok(r.facts.some(f => /moved 2 times/.test(f)));
  assert.ok(r.facts.some(f => /carried on 3 standups/.test(f)));
});

test('appearing on ONE standup is a commitment, not a carry', () => {
  assert.strictEqual(h.rungFor({ daysCarried: 1 }, TODAY).rung, 0);
  assert.strictEqual(h.rungFor({ daysCarried: 2 }, TODAY).rung, 1);
});

test('long overdue is a pattern even with one slip', () => {
  assert.strictEqual(h.rungFor({ due: '2026-09-30' }, TODAY).rung, 2);
});

test('blocked by someone else pauses the ladder, then asks again after a week', () => {
  const fresh = h.rungFor({ due: '2026-09-30', status: { kind: 'blocked', note: 'HR', at: '2026-11-04T09:00:00Z' } }, TODAY);
  assert.strictEqual(fresh.rung, 'paused');
  const old = h.rungFor({ due: '2026-09-30', status: { kind: 'blocked', note: 'HR', at: '2026-10-20T09:00:00Z' } }, TODAY);
  assert.strictEqual(old.rung, 2);
  assert.ok(old.facts.some(f => /still true/.test(f)));
});

test('a linked task closed in NEURO counts as landed even if the note box is unticked', () => {
  const r = h.landed([
    { text: 'Share PDF', done: false, taskId: 531 },
    { text: 'Podcast', done: false, taskId: 358 },
    { text: 'Ticked', done: true },
  ], { taskStatus: (id) => (id === 531 ? 'done' : 'open') });
  assert.strictEqual(r.planned, 3);
  assert.deepStrictEqual(r.landed.map(x => x.text), ['Share PDF', 'Ticked']);
  assert.deepStrictEqual(r.missed.map(x => x.text), ['Podcast']);
});

test('capacity: free time between meetings in the working window, sliced not parsed', () => {
  const cal = [
    { start: '2026-11-06T10:00:00', end: '2026-11-06T10:30:00' },
    { start: '2026-11-06T12:00:00', end: '2026-11-06T13:00:00' },
  ];
  const c = h.capacity(cal, 9 * 60);
  assert.strictEqual(c.known, true);
  assert.deepStrictEqual(c.gaps, ['09:00-10:00', '10:30-12:00', '13:00-17:30']);
  assert.strictEqual(c.freeMinutes, 60 + 90 + 270);
  // Later in the day only what is left counts.
  assert.deepStrictEqual(h.capacity(cal, 14 * 60).gaps, ['14:00-17:30']);
});

test('an unreadable diary is unknown, never a free day', () => {
  assert.deepStrictEqual(h.capacity(null, 540), { known: false });
  assert.match(h.render({ yesterday: null, urgent: [], slipping: [], capacity: { known: false }, gaps: [] }), /could not be read/);
});

test('render names rungs and pauses', () => {
  const out = h.render({
    yesterday: { date: '2026-11-05', planned: 2, landed: [{ text: 'A' }], missed: [{ text: 'B', taskId: 9 }] },
    urgent: [{ title: 'NT-1: update the customer by 10:00', why: 'you wrote…' }],
    slipping: [
      { id: 1, text: 'Thing', rung: 3, facts: ['date moved 3 times'] },
      { id: 344, text: 'Heidi', rung: 'paused', blockedBy: 'HR', blockedDays: 0 },
    ],
    capacity: { known: true, freeMinutes: 150, meetingMinutes: 120, gaps: ['13:00-15:30'] },
    gaps: [],
  });
  assert.match(out, /planned 2, landed 1/);
  assert.match(out, /missed: B \[task #9\]/);
  assert.match(out, /RUNG 3/);
  assert.match(out, /PAUSED/);
  assert.match(out, /2h30/);
});
