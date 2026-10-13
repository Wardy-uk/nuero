'use strict';

/**
 * Drinks by NAME (13 Oct 2026). Fixtures are the real Foodnoms items Nick logged
 * on 13 Oct: "Wine (White)" at 11:20 and "Tea (Hot, with Milk)" at 11:17.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-drinks-')), 'd.db');
const db = require('../db/database');
const D = require('./drinks');

test.before(async () => { await db.init(); });

const ld = (s) => String(s).slice(0, 10);
const item = (name, nutrients, at = '2026-10-13 10:20:27', id = name) =>
  Object.entries(nutrients).map(([metric, value]) => ({ metric, value, recorded_at: at, food_type: name, food_item: id }));

const WINE = item('Wine (White)', { dietary_energy_consumed: 147.6, dietary_carbohydrates: 4.68, dietary_protein: 0.126, dietary_water: 0.1563, dietary_sugar: 1.728 });
const TEA = item('Tea (Hot, with Milk)', { dietary_energy_consumed: 122.4, dietary_carbohydrates: 21.48, dietary_protein: 3.792, dietary_fat_total: 2.52, dietary_fiber: 0.24, dietary_water: 0.21132, dietary_caffeine: 0.0216 }, '2026-10-13 10:17:30');

test('names: drinks are recognised, lookalikes are not, a stated % wins', () => {
  assert.equal(D.matchDrink('Wine (White)').abv, 12.5);
  assert.equal(D.matchDrink('Pinot Grigio').kind, 'white wine');
  assert.equal(D.matchDrink('Merlot').kind, 'red wine');
  assert.equal(D.matchDrink('Southern Comfort').abv, 35, 'Southern Comfort is not read as whisky');
  assert.equal(D.matchDrink('Jameson Irish Whiskey').abv, 40);
  assert.equal(D.matchDrink('Lager 5%').abv, 5);
  assert.equal(D.matchDrink('Alcohol-free beer').abv, 0);
  for (const n of ['Wine gums', 'Beer battered cod', 'Ginger beer', 'Gingerbread', 'Cider vinegar', 'Rum and raisin ice cream', 'Tea (Hot, with Milk)', 'Port Salut']) {
    assert.equal(D.matchDrink(n), null, `${n} is not a drink`);
  }
});

test('the real glass of wine: units from its name and its own water, the calories agreeing', () => {
  const [d] = D.fromEntries([...WINE, ...TEA], ld);
  assert.equal(d.name, 'Wine (White)');
  assert.equal(d.basis, 'name');
  assert.equal(d.volumeMl, 179, '156 ml of water at 12.5% is about a 175 ml glass');
  assert.equal(d.units, 2.2);
  assert.equal(d.check.units, 2.3, 'the calories say the same thing independently');
  assert.equal(d.check.agree, true);
  assert.equal(D.fromEntries(TEA, ld).length, 0, 'tea is not a drink here');
});

test('a disagreement is SAID, never averaged away', () => {
  // Named a beer, but carrying a spirit's worth of alcohol calories.
  const odd = item('Beer', { dietary_energy_consumed: 400, dietary_carbohydrates: 10, dietary_water: 0.3 });
  const [d] = D.fromEntries(odd, ld);
  assert.equal(d.check.agree, false);
  assert.match(d.check.line, /check the entry/);
});

test('no name, no drink — and a day with food but no drink is 0, an unlogged day absent', () => {
  const mfp = [{ metric: 'dietary_energy_consumed', value: 2486, recorded_at: '2026-10-12 18:04:00', food_type: null, food_item: null }];
  const drinks = D.fromEntries([...mfp, ...WINE], ld);
  assert.equal(drinks.length, 1, 'MyFitnessPal’s unnamed totals are never a drink');
  const days = D.dailyUnits([...mfp, ...WINE], drinks, '2026-10-14', ld);
  assert.deepEqual(days.map((x) => [x.day, x.alcoholUnits]), [['2026-10-13', 2.2], ['2026-10-12', 0]]);
});

test('ingest stores the name, and a re-send fills it in on an entry stored without one', () => {
  assert.equal(db.insertNutritionEntry('dietary_energy_consumed', 147.6, '2026-10-13 10:20:27', 'U-1'), true);
  assert.equal(db.insertNutritionEntry('dietary_energy_consumed', 147.6, '2026-10-13 10:20:27', 'U-1', 'Wine (White)', 'ITEM-1'), false, 'not a new entry');
  const row = db.getNutritionEntriesSince('2026-10-13 00:00:00').find((r) => r.metric === 'dietary_energy_consumed');
  assert.equal(row.food_type, 'Wine (White)');
  assert.equal(row.food_item, 'ITEM-1');
});

test('alcohol as a goal measure: units per week from the drinks', () => {
  const G = require('./goal-measures');
  const alcoholDays = [['2026-10-12', 2.2], ['2026-10-11', 0], ['2026-10-10', 4.4], ['2026-10-09', 0]].map(([day, u]) => ({ day, complete: true, alcoholUnits: u }));
  const p = G.evaluate({ measure: { kind: 'alcohol', target: 14 }, startDate: '2026-10-13' }, { today: '2026-10-13', alcoholDays });
  assert.equal(p.currentText, '11.6 units/week', '6.6 over 4 logged days, scaled to a week');
  assert.equal(p.state, 'met');
});
