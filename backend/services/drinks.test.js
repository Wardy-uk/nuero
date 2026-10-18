'use strict';

/**
 * Drinks by NAME, strength from the looked-up drink database (18 Oct 2026).
 * Fixtures are real Foodnoms items: "Wine (White)" and "Tea (Hot, with Milk)" on
 * 13 Oct, and "Southern Comfort" on 17 Oct — which arrived with 1,364 kcal booked
 * entirely as carbohydrate and no water, so the old "calories the macros don't
 * explain" arithmetic said it held no alcohol at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-drinks-')), 'd.db');
const db = require('../db/database');
const D = require('./drinks');
const P = require('./drink-profiles');

test.before(async () => { await db.init(); });

const ld = (s) => String(s).slice(0, 10);
const item = (name, nutrients, at = '2026-10-13 10:20:27', id = name) =>
  Object.entries(nutrients).map(([metric, value]) => ({ metric, value, recorded_at: at, food_type: name, food_item: id }));
const prof = (rows) => new Map(rows.map(([name, isDrink, abv, kcalPer100ml, kind = 'drink', source = 'lookup']) => [P.nameKey(name), { name, isDrink, abv, kcalPer100ml, kind, source }]));

const WINE = item('Wine (White)', { dietary_energy_consumed: 147.6, dietary_carbohydrates: 4.68, dietary_protein: 0.126, dietary_water: 0.1563, dietary_sugar: 1.728 });
const TEA = item('Tea (Hot, with Milk)', { dietary_energy_consumed: 122.4, dietary_carbohydrates: 21.48, dietary_water: 0.21132 }, '2026-10-13 10:17:30');
const SOCO = item('Southern Comfort', { dietary_carbohydrates: 340.909090909091, dietary_sugar: 150, dietary_energy_consumed: 1363.63636363636 }, '2026-10-17 17:45:37', 'D161366C');

const TABLE = prof([
  ['Wine (White)', true, 12.5, 82, 'white wine'],
  ['Tea (Hot, with Milk)', false, null, null],
  ['Southern Comfort', true, 35, 283, 'liqueur'],
]);

test('the real glass of wine: strength from the database, volume from its own water, the energy agreeing', () => {
  const [d] = D.fromEntries([...WINE, ...TEA], ld, TABLE);
  assert.equal(d.name, 'Wine (White)');
  assert.equal(d.basis, 'water');
  assert.equal(d.abvBasis, 'looked up');
  assert.equal(d.volumeMl, 179, '156 ml of water at 12.5% is about a 175 ml glass');
  assert.equal(d.units, 2.2);
  assert.equal(d.check.agree, true, '147.6 kcal at 82 kcal/100 ml is ~180 ml too');
  assert.equal(D.fromEntries(TEA, ld, TABLE).length, 0, 'the database says tea is not a drink');
});

test('Southern Comfort: units from its looked-up strength — never from residual calories', () => {
  const [d] = D.fromEntries(SOCO, ld, TABLE);
  assert.equal(d.basis, 'energy');
  assert.equal(d.volumeMl, 482, '1,364 kcal at 283 kcal/100 ml');
  assert.equal(d.units, 16.9, '482 ml at 35%');
  assert.match(d.why, /liqueur at 35% \(looked up\), about 482 ml from its 1364 kcal at 283 kcal\/100 ml/);
});

test('Nick’s word beats the lookup; a % in the name beats both; abv 0 is 0', () => {
  const t = prof([['Lager 4%', true, 5, 42, 'lager'], ['Southern Comfort', true, 40, 283, 'liqueur', 'nick'], ['Alcohol-free beer', true, 0, 20, 'beer']]);
  assert.equal(D.matchDrink('Lager 4%', t).abv, 4);
  assert.equal(D.matchDrink('Lager 4%', t).abvBasis, 'stated in the name');
  assert.equal(D.matchDrink('Southern Comfort', t).abvBasis, 'set by you');
  const [af] = D.fromEntries(item('Alcohol-free beer', { dietary_energy_consumed: 66 }), ld, t);
  assert.equal(af.units, 0);
});

test('unknown is said, never guessed: not looked up yet, strength unknown, no volume', () => {
  const [pending] = D.fromEntries(item('Pinot Grigio', { dietary_energy_consumed: 120 }), ld, new Map());
  // "Pinot Grigio" has no drink word; a name not looked up that has one is held as pending.
  assert.equal(pending, undefined, 'without a drink word an unlooked name is not assumed a drink');
  const [held] = D.fromEntries(item('Red wine', { dietary_energy_consumed: 120 }), ld, new Map());
  assert.equal(held.units, null);
  assert.equal(held.pending, true);
  assert.equal(D.fromEntries(item('Beef stew with ale', { dietary_energy_consumed: 400 }), ld, new Map()).length, 0, 'food with a drink word is not held');
  const t = prof([['Mystery Spirit', true, null, null], ['Gin', true, 37.5, null, 'gin']]);
  assert.equal(D.fromEntries(item('Mystery Spirit', { dietary_energy_consumed: 200 }), ld, t)[0].units, null);
  const [gin] = D.fromEntries(item('Gin', { dietary_energy_consumed: 200 }), ld, t);
  assert.equal(gin.units, null);
  assert.match(gin.why, /kcal per 100 ml is not known/);
});

test('a disagreement between water and energy is SAID, never averaged', () => {
  const t = prof([['Beer', true, 4.5, 43, 'beer']]);
  const [d] = D.fromEntries(item('Beer', { dietary_energy_consumed: 600, dietary_water: 0.3 }), ld, t);
  assert.equal(d.basis, 'water');
  assert.equal(d.check.agree, false);
  assert.match(d.check.line, /check the entry/);
});

test('no name, no drink — and a day with food but no drink is 0, an unlogged day absent', () => {
  const mfp = [{ metric: 'dietary_energy_consumed', value: 2486, recorded_at: '2026-10-12 18:04:00', food_type: null, food_item: null }];
  const drinks = D.fromEntries([...mfp, ...WINE], ld, TABLE);
  assert.equal(drinks.length, 1);
  const days = D.dailyUnits([...mfp, ...WINE], drinks, '2026-10-14', ld);
  assert.deepEqual(days.map((x) => [x.day, x.alcoholUnits]), [['2026-10-13', 2.2], ['2026-10-12', 0]]);
});

test('the database: answers are parsed strictly, stored once, and never overwrite Nick', async () => {
  for (const [i, n] of ['Wine (White)', 'Tea (Hot, with Milk)', 'Southern Comfort'].entries()) {
    db.insertNutritionEntry('dietary_energy_consumed', 100, `2026-10-17 1${i}:00:00`, `P-${i}`, n, `I-${i}`);
  }
  assert.deepEqual(P.pendingNames().sort(), ['Southern Comfort', 'Tea (Hot, with Milk)', 'Wine (White)']);
  P.setByNick('Southern Comfort', { isDrink: true, abv: 35, kcalPer100ml: 283, kind: 'liqueur' });
  assert.throws(() => P.setByNick('Southern Comfort', { isDrink: true, abv: 120 }), /abv/, 'refused, not clamped');

  // An answer missing a row is refused whole — nothing stored on a guess.
  const short = await P.lookupPending({ ask: async () => ({ text: '[{"name":"Tea (Hot, with Milk)","isDrink":false}]', model: 't' }) });
  assert.equal(short.ok, false);
  assert.equal(P.list({ drinksOnly: false }).length, 1);

  let asked;
  const r = await P.lookupPending({ ask: async (names) => {
    asked = names;
    return { model: 't', text: 'Here: ' + JSON.stringify(names.map((n) => (n.startsWith('Wine')
      ? { name: n, isDrink: true, kind: 'white wine', abv: 12.5, kcalPer100ml: 82 }
      : { name: n, isDrink: false }))) };
  } });
  assert.equal(r.stored, 2);
  assert.ok(!asked.includes('Southern Comfort'), 'a name Nick set is not asked again');
  const m = P.map();
  assert.equal(m.get(P.nameKey('wine (white)')).abv, 12.5);
  assert.equal(m.get(P.nameKey('Tea (Hot, with Milk)')).isDrink, false);
  assert.equal(m.get(P.nameKey('Southern Comfort')).source, 'nick');
  assert.deepEqual(P.pendingNames(), [], 'every name answered once');
});

test('alcohol as a goal measure: units per week from the drinks', () => {
  const G = require('./goal-measures');
  const alcoholDays = [['2026-10-12', 2.2], ['2026-10-11', 0], ['2026-10-10', 4.4], ['2026-10-09', 0]].map(([day, u]) => ({ day, complete: true, alcoholUnits: u }));
  const p = G.evaluate({ measure: { kind: 'alcohol', target: 14 }, startDate: '2026-10-13' }, { today: '2026-10-13', alcoholDays });
  assert.equal(p.currentText, '11.6 units/week', '6.6 over 4 logged days, scaled to a week');
  assert.equal(p.state, 'met');
});
