'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { arrange, minutesUntilTomorrowMorning } = require('./next-steps');

const it = (id, group) => ({ id, group, _key: `k:${id}` });

test('groups run now → today → week, keeping each owner’s order inside a group', () => {
  const { live } = arrange([it('a', 'week'), it('b', 'now'), it('c', 'today'), it('d', 'now')], new Map());
  assert.deepStrictEqual(live.map((x) => x.id), ['b', 'd', 'c', 'a']);
});

test('a snoozed item leaves the list and says until when', () => {
  const deferred = new Map([['k:b', { until: '2026-11-04T08:00:00Z', reason: 'too-big' }]]);
  const { live, snoozed } = arrange([it('a', 'now'), it('b', 'today')], deferred);
  assert.deepStrictEqual(live.map((x) => x.id), ['a']);
  assert.strictEqual(snoozed[0].snoozedUntil, '2026-11-04T08:00:00Z');
  assert.strictEqual(snoozed[0].snoozeReason, 'too-big');
});

test('"Not today" runs to 08:00 tomorrow, London time', () => {
  // 13:10 BST on 3 Jun 2026 = 12:10 UTC → 18h50m to 08:00 next day
  assert.strictEqual(minutesUntilTomorrowMorning(Date.parse('2026-06-03T12:10:00Z')), 18 * 60 + 50);
  // 23:30 GMT on 3 Nov → 8h30m
  assert.strictEqual(minutesUntilTomorrowMorning(Date.parse('2026-11-03T23:30:00Z')), 8 * 60 + 30);
});
