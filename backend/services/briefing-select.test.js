'use strict';

/**
 * The briefing's selection rules (12 Oct 2026). PURE — no DB, no clock.
 * Nick's brief was "not a fixed agenda": these pin what earns a place, what is
 * held back and counted, and that a blind spot is never a quiet day.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('./briefing-select');

const TODAY = '2026-10-12';
const c = (key, extra = {}) => ({ key, title: key, sphere: 'work', priority: 50, kind: key.split(':')[0], ...extra });

test('a day off drops WORK before ranking, and counts what it dropped', () => {
  const r = s.select({ candidates: [c('a'), c('b', { sphere: 'personal' })], dayType: 'off', today: TODAY });
  assert.deepEqual(r.items.map((i) => i.key), ['b']);
  assert.equal(r.held.work, 1);
});

test('a day off still keeps a CRITICAL work item', () => {
  const r = s.select({ candidates: [c('esc', { critical: true, needsYou: true })], dayType: 'off', today: TODAY });
  assert.deepEqual(r.items.map((i) => i.key), ['esc']);
  assert.equal(r.held.work, 0);
});

test('below the bar is held back and counted, never silently lost', () => {
  const r = s.select({ candidates: [c('low', { priority: s.BAR - 1 }), c('ok', { priority: s.BAR })], today: TODAY });
  assert.deepEqual(r.items.map((i) => i.key), ['ok']);
  assert.equal(r.held.belowBar, 1);
});

test('needs-you clears the bar whatever its priority', () => {
  const r = s.select({ candidates: [c('n', { priority: 1, needsYou: true })], today: TODAY });
  assert.deepEqual(r.items.map((i) => i.key), ['n']);
});

test('the budget never cuts something that needs you', () => {
  const cands = [c('x1', { priority: 99 }), c('x2', { priority: 98 }), c('need1', { priority: 31, needsYou: true }), c('need2', { priority: 32, needsYou: true })];
  const r = s.select({ candidates: cands, today: TODAY, budget: { push: 1, screen: 1 } });
  assert.deepEqual(r.items.map((i) => i.key).sort(), ['need1', 'need2']);
  assert.equal(r.held.overBudget, 2);
});

test('needs-you leads, then priority, then time of day', () => {
  const r = s.select({
    candidates: [c('later', { priority: 80, when: '15:00' }), c('earlier', { priority: 80, when: '09:00' }), c('need', { priority: 40, needsYou: true })],
    today: TODAY,
  });
  assert.deepEqual(r.items.map((i) => i.key), ['need', 'earlier', 'later']);
});

test('sections come from what items ARE, and an empty section does not exist', () => {
  const r = s.select({
    candidates: [c('need', { needsYou: true }), c('meet', { when: '10:00' }), c('soon', { date: '2026-10-15' }), c('fyi')],
    today: TODAY,
  });
  assert.deepEqual(r.sections.map((x) => x.id), ['needs-you', 'today', 'coming-up', 'worth-knowing']);
  const only = s.select({ candidates: [c('fyi')], today: TODAY });
  assert.deepEqual(only.sections.map((x) => x.id), ['worth-knowing']);
});

test('"not useful" lowers a kind, bounded, and never touches something that needs you', () => {
  const fb = { tips: [TODAY, TODAY, TODAY, TODAY, TODAY, TODAY] }; // 6 presses → capped
  assert.equal(s.penaltyFor('tips', fb, TODAY), s.PENALTY_CAP);
  const r = s.select({ candidates: [c('tips:a', { kind: 'tips', priority: 45 }), c('tips:b', { kind: 'tips', priority: 45, needsYou: true })], today: TODAY, feedback: fb });
  assert.deepEqual(r.items.map((i) => i.key), ['tips:b']); // 45-20 = 25, under the bar
  assert.deepEqual(r.adjusted, [{ key: 'tips:a', kind: 'tips', penalty: s.PENALTY_CAP }]);
});

test('old "not useful" presses age out of the window', () => {
  assert.equal(s.penaltyFor('tips', { tips: ['2026-08-01'] }, TODAY), 0);
});

test('the close names what could not be read — a blind spot is never a quiet day', () => {
  const r = s.select({ candidates: [], today: TODAY, gaps: [{ source: 'your diary', why: 'empty cache' }] });
  assert.match(r.close, /Nothing needs you\./);
  assert.match(r.close, /couldn’t read your diary/);
  const clear = s.select({ candidates: [], today: TODAY });
  assert.equal(clear.close, 'Nothing needs you.');
});

test('a malformed candidate costs one line, not the briefing', () => {
  const r = s.select({ candidates: [null, { key: 'x' }, { key: 'y', title: 'y', sphere: 'nonsense' }, c('ok')], today: TODAY });
  assert.deepEqual(r.items.map((i) => i.key), ['ok']);
  assert.equal(r.held.invalid, 3);
});

test('the push carries the top items only', () => {
  const r = s.select({ candidates: [c('a', { priority: 90 }), c('b', { priority: 80 }), c('c', { priority: 70 }), c('d', { priority: 60 })], today: TODAY, budget: { push: 2, screen: 10 } });
  assert.deepEqual(r.push, ['a', 'b']);
  const t = s.pushText(r, { dayLabel: 'Monday' });
  assert.equal(t.body.split('\n').length, 2);
});

test('withinLead: from leadDays before until the day, overdue up to the limit', () => {
  assert.equal(s.withinLead({ due: '2026-10-15', today: TODAY, leadDays: 3 }), true);
  assert.equal(s.withinLead({ due: '2026-10-16', today: TODAY, leadDays: 3 }), false);
  assert.equal(s.withinLead({ due: '2026-10-01', today: TODAY, overdueDays: 14 }), true);
  assert.equal(s.withinLead({ due: '2026-09-01', today: TODAY, overdueDays: 14 }), false);
  assert.equal(s.withinLead({ due: 'garbage', today: TODAY }), false);
});
