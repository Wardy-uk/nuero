'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nutrition = require('./nutrition');
const picture = require('./health-picture');

const TODAY = '2026-10-12';

// One full day's log, stored the way the ingest stores it: GRAMS, UTC stamps.
function dayOf(day, { kcal = 2200, sodiumG = 1.6, satG = 22, sugarG = 60, fibreG = 32, calciumG = 0 } = {}) {
  const at = `${day} 12:00:00`;
  return [
    { metric: 'dietary_energy_consumed', value: kcal, recorded_at: at },
    { metric: 'dietary_sodium', value: sodiumG, recorded_at: at },
    { metric: 'dietary_fat_saturated', value: satG, recorded_at: at },
    { metric: 'dietary_sugar', value: sugarG, recorded_at: at },
    { metric: 'dietary_fiber', value: fibreG, recorded_at: at },
    { metric: 'dietary_calcium', value: calciumG, recorded_at: at },
  ];
}

const days = (n, opts) => Array.from({ length: n }, (_, i) => dayOf(`2026-10-${String(11 - i).padStart(2, '0')}`, opts)).flat();

test('a day with nothing logged is not a zero day', () => {
  const out = nutrition.compose({ samples: dayOf('2026-10-10'), today: TODAY, windowDays: 7 });
  const unlogged = out.days.find((d) => d.day === '2026-10-09');
  assert.equal(unlogged.logged, false);
  assert.equal(unlogged.kcal, null);
  assert.deepEqual(unlogged.totals, {});
  assert.equal(out.summary.loggedDays, 1);
  // The average is over the one logged day, not diluted across the week.
  assert.equal(out.nutrients.find((x) => x.metric === 'dietary_energy_consumed').avg, 2200);
});

test('a low (fast) day counts like any other; only today is left out of the averages', () => {
  const samples = [...dayOf('2026-10-11'), ...dayOf('2026-10-10', { kcal: 400 }), ...dayOf(TODAY, { kcal: 300 })];
  const out = nutrition.compose({ samples, today: TODAY, windowDays: 7 });
  assert.equal(out.summary.loggedDays, 2);
  assert.equal(out.summary.todayKcal, 300);
  assert.equal(out.nutrients.find((x) => x.metric === 'dietary_energy_consumed').avg, 1300);
});

test('salt is sodium x 2.5 and judged against 6g; minerals are floors, never "under"', () => {
  const out = nutrition.compose({ samples: days(5, { sodiumG: 3.2 }), today: TODAY, windowDays: 14 });
  const salt = out.nutrients.find((x) => x.metric === 'dietary_sodium');
  assert.equal(salt.avg, 8);
  assert.equal(salt.state, 'over');
  const calcium = out.nutrients.find((x) => x.metric === 'dietary_calcium');
  assert.equal(calcium.floor, true);
  assert.equal(calcium.state, 'floor');
});

test('a UTC stamp after 23:00 in BST belongs to the next local day', () => {
  assert.equal(nutrition.localDay('2026-10-10 23:30:00', 'Europe/London'), '2026-10-11');
  assert.equal(nutrition.localDay('2026-12-10 23:30:00', 'Europe/London'), '2026-12-10');
});

test('My Health: salt over the limit is ACT when blood pressure is high, WATCH otherwise', () => {
  const n = nutrition.compose({ samples: days(5, { sodiumG: 3.2 }), today: TODAY, windowDays: 14 });
  const high = picture._internals.nutrition({ nutrition: n, bpHigh: true });
  assert.equal(high.insights.find((i) => i.id === 'nutrition-salt').level, 'act');
  const normal = picture._internals.nutrition({ nutrition: n, bpHigh: false });
  assert.equal(normal.insights.find((i) => i.id === 'nutrition-salt').level, 'watch');
});

test('My Health: too few logged days is a gap only once logging has started; never logging says nothing', () => {
  const few = nutrition.compose({ samples: days(2), today: TODAY, windowDays: 14 });
  const r = picture._internals.nutrition({ nutrition: few, bpHigh: false });
  assert.equal(r.system.status, 'unknown');
  assert.equal(r.insight.level, 'gap');
  const none = nutrition.compose({ samples: [], today: TODAY, windowDays: 14 });
  const r2 = picture._internals.nutrition({ nutrition: none, bpHigh: false });
  assert.equal(r2.insight, null);
});

test('My Health: within guidelines is a positive, and off-guideline items are named with numbers', () => {
  const fine = nutrition.compose({ samples: days(5), today: TODAY, windowDays: 14 });
  const ok = picture._internals.nutrition({ nutrition: fine, bpHigh: false });
  assert.deepEqual(ok.insights.map((i) => i.id), ['nutrition-ok']);
  const off = nutrition.compose({ samples: days(5, { satG: 40, fibreG: 12 }), today: TODAY, windowDays: 14 });
  const r = picture._internals.nutrition({ nutrition: off, bpHigh: false });
  const g = r.insights.find((i) => i.id === 'nutrition-guidelines');
  assert.match(g.finding, /saturated fat 40g/);
  assert.match(g.finding, /fibre 12g/);
});

test('compose wires the nutrition input into the picture, and an unread input is named', () => {
  const n = nutrition.compose({ samples: days(5, { sodiumG: 3.2 }), today: TODAY, windowDays: 14 });
  const pic = picture.compose({ today: TODAY, nowMs: Date.parse('2026-10-12T12:00:00Z'), nutrition: n });
  assert.ok(pic.systems.some((s) => s.id === 'nutrition' && s.value === '2200'));
  assert.ok(pic.insights.some((i) => i.id === 'nutrition-salt'));
  const blind = picture.compose({ today: TODAY, nowMs: 0, unread: [{ input: 'nutrition', why: 'disk' }] });
  assert.equal(blind.systems.find((s) => s.id === 'nutrition').status, 'unknown');
  assert.equal(blind.complete, false);
});
