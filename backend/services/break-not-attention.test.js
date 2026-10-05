'use strict';
// A break is not something that needs Nick (5 Oct 2026): SAiM led with
// "Needs you — Take a break, in 8 minutes". Free time and solo breaks are out;
// a lunch with someone is still a meeting.
const { test } = require('node:test');
const assert = require('node:assert');
const { isNotForAttention } = require('./decision-engine');

test('free diary time and solo breaks never need Nick', () => {
  assert.equal(isNotForAttention({ subject: 'Take a break', show_as: 'free', attendees_other: 0 }), true);
  assert.equal(isNotForAttention({ subject: 'Lunch', show_as: 'busy', attendees_other: 0 }), true);
  assert.equal(isNotForAttention({ subject: 'Coffee', show_as: 'busy', attendees_other: null }), true);
  assert.equal(isNotForAttention({ subject: 'Anything at all', show_as: 'free', attendees_other: 1 }), true);
});

test('real meetings and work blocks still count', () => {
  assert.equal(isNotForAttention({ subject: 'Lunch with Chris', show_as: 'busy', attendees_other: 1 }), false);
  assert.equal(isNotForAttention({ subject: 'Risk Meeting Prep', show_as: 'busy', attendees_other: 0 }), false);
  assert.equal(isNotForAttention({ subject: 'Breakdown review', show_as: 'busy', attendees_other: 0 }), false, 'whole words only');
});

test('a solo block never becomes critical; a real meeting does at 10 minutes', () => {
  const { collectMeetings } = require('./decision-engine');
  const soon = new Date(Date.now() + 8 * 60000).toISOString();
  const later = new Date(Date.now() + 70 * 60000).toISOString();
  const items = collectMeetings({ calendar: [
    { event_id: 'solo', subject: 'Risk Meeting Prep', start_time: soon, end_time: later, show_as: 'busy', attendees_other: 0 },
    { event_id: 'real', subject: 'Support leadership', start_time: soon, end_time: later, show_as: 'busy', attendees_other: 1 },
    { event_id: 'brk', subject: 'Take a break', start_time: soon, end_time: later, show_as: 'free', attendees_other: 0 },
  ] });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.ok(by['cal-solo'], 'a solo block is still listed');
  assert.notEqual(by['cal-solo'].urgency, 'critical');
  assert.equal(by['cal-solo'].actionHint, 'Starts soon');
  assert.equal(by['cal-real'].urgency, 'critical');
  assert.equal(by['cal-brk'], undefined, 'a free break is not listed at all');
});

test('the weekly report to Chris surfaces when late and unsent, never once sent', () => {
  const pd = require('./pip-deliverables');
  const { collectWeeklyReport } = require('./decision-engine');
  const real = pd.build;
  try {
    pd.build = () => ({ window: { daysToEnd: 6 }, weekly: { notBuilt: ['2026-09-28', '2026-10-05'], current: { week: '2026-10-05', built: false, sendRecorded: false, state: 'late' } } });
    const [item] = collectWeeklyReport();
    assert.equal(item.urgency, 'critical');
    assert.match(item.reason, /Not built yet\. PIP ends in 6 days\. 1 earlier week not built\./);
    pd.build = () => ({ weekly: { current: { week: '2026-10-05', built: true, sendRecorded: true, state: 'late' } } });
    assert.deepEqual(collectWeeklyReport(), []);
    pd.build = () => { throw new Error('unreadable'); };
    assert.deepEqual(collectWeeklyReport(), [], 'an unreadable tracker adds nothing rather than failing the pool');
  } finally { pd.build = real; }
});

test('capacity: a big task that must start now and an overload each become one card; unreadable adds nothing', () => {
  const tc = require('./task-capacity');
  const { collectCapacity } = require('./decision-engine');
  const real = tc.read;
  try {
    tc.read = () => ({ known: true, overload: { by: '2026-10-09', dueMinutes: 1800, freeMinutes: 480, shortMinutes: 1320 },
      startBy: [{ id: 350, text: 'Build call metrics in Nova', due: '2026-10-09', minutes: 480, status: 'start-today', latestStart: { date: '2026-10-05', time: '14:00' } }] });
    const items = collectCapacity();
    assert.equal(items.length, 2);
    assert.match(items[0].title, /^Start "Build call metrics in Nova" by 14:00 to finish by Friday/);
    assert.match(items[1].reason, /30h due, 8h free in your diary — 22h short/);
    tc.read = () => ({ known: false, why: 'diary unreadable' });
    assert.deepEqual(collectCapacity(), []);
  } finally { tc.read = real; }
});
