'use strict';

// Tea → shopping (1 Nov 2026). Real DB, real household tea store, real shopping
// catalogue in a scratch vault, a real recipe note; the model is faked.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'test.db');
const VAULT = path.join(tmp, 'vault');
fs.mkdirSync(path.join(VAULT, 'Recipes'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'Recipes', 'Lasagne.md'), '# Lasagne\n\n## Ingredients\n- 500g beef mince\n- 2 onions\n- Lasagne sheets\n- Olive oil\n- Salt\n\n## Method\n- cook it\n');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');
const ts = require('./tea-shopping');
const board = require('./household-board');
const catalogue = require('./catalogue');

test.before(async () => { await db.init(); });

const NOW = Date.now();
const today = board.localKey(NOW);
const plus = (n) => board.addDays(today, n);
const modelCalls = [];
const fakeModel = (answers) => async (meal) => { modelCalls.push(meal); return Object.prototype.hasOwnProperty.call(answers, meal) ? answers[meal] : null; };

function toBuy() { const r = catalogue.read('shopping'); return r.ok ? r.cat.items['to buy'].map((i) => i.name) : []; }
function reset() {
  db.setState(board.TEA_KEY, '{}'); db.setState(ts.LEDGER_KEY, 'null'); db.setState(ts.SETTING_KEY, 'true');
  try { fs.rmSync(path.join(VAULT, 'Catalogues'), { recursive: true, force: true }); } catch { /* none */ }
  modelCalls.length = 0; ts._resetForTests();
}

test('pure: base names fold quantities, the "for" note and plurals; staples are staples', () => {
  assert.strictEqual(ts.baseName('500g beef mince'), 'beef mince');
  assert.strictEqual(ts.baseName('2 onions'), 'onion');
  assert.strictEqual(ts.baseName('Onion — for Lasagne (Thu)'), 'onion');
  assert.strictEqual(ts.baseName('Tomatoes'), 'tomato');
  assert.ok(ts.isStaple('Olive oil'));
  assert.ok(ts.isStaple('Salt'));
  assert.ok(!ts.isStaple('Beef mince'));
  assert.deepStrictEqual(ts.recipeIngredients('## Ingredients\n- a\n- [ ] b\n## Method\n- c'), ['a', 'b']);
  assert.strictEqual(ts.parseIngredients('not json'), null);
  assert.strictEqual(ts.parseIngredients('[1,2]'), null);
});

test('a recipe in the vault supplies the list; staples are skipped; items say which tea they are for', async () => {
  reset();
  board.setTea({ date: plus(1), text: 'Lasagne' }, { now: NOW });
  const r = await ts.run({ now: NOW, deps: { suggest: fakeModel({}) } });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(modelCalls.length, 0, 'a recipe means no model call');
  const names = toBuy();
  assert.strictEqual(names.length, 3, names.join(' | '));
  assert.ok(names.every((n) => / — for Lasagne \(\w{3}\)$/.test(n)), names.join(' | '));
  assert.ok(!names.some((n) => /oil|salt/i.test(n)));
});

test('no recipe: one model call, cached; something already To buy is folded, not added twice', async () => {
  reset();
  board.shoppingAdd({ name: 'Onions' }, { now: NOW });
  board.setTea({ date: plus(2), text: 'Chilli con carne' }, { now: NOW });
  const model = fakeModel({ 'Chilli con carne': ['beef mince', 'onion', 'kidney beans', 'salt'] });
  await ts.run({ now: NOW, deps: { suggest: model } });
  assert.deepStrictEqual(modelCalls, ['Chilli con carne']);
  const names = toBuy();
  assert.strictEqual(names.filter((n) => ts.baseName(n) === 'onion').length, 1, names.join(' | '));
  assert.ok(names.includes('Onions'), 'Nick’s own item is untouched');
  assert.ok(names.some((n) => n.startsWith('kidney beans — for Chilli con carne')));
  // Re-run: nothing new, no second model call.
  await ts.run({ now: NOW, deps: { suggest: model } });
  assert.strictEqual(modelCalls.length, 1);
  assert.deepStrictEqual(toBuy(), names);
  const ledger = JSON.parse(db.getState(ts.LEDGER_KEY));
  assert.strictEqual(Object.values(ledger.entries)[0].source, 'suggested');
});

test('removing the tea takes back only what it added and is still unbought', async () => {
  reset();
  board.shoppingAdd({ name: 'Bread' }, { now: NOW });
  board.setTea({ date: plus(1), text: 'Lasagne' }, { now: NOW });
  await ts.run({ now: NOW, deps: { suggest: fakeModel({}) } });
  const mince = toBuy().find((n) => n.startsWith('500g beef mince'));
  board.shoppingBought({ name: mince }, { now: NOW });
  board.setTea({ date: plus(1), text: null }, { now: NOW });
  await ts.run({ now: NOW, deps: { suggest: fakeModel({}) } });
  assert.deepStrictEqual(toBuy(), ['Bread']);
  const cat = catalogue.read('shopping').cat;
  assert.ok(cat.items.bought.some((i) => i.name === mince), 'bought stays bought');
});

test('a folded item another tea needs is re-added when the first tea goes', async () => {
  reset();
  board.setTea({ date: plus(1), text: 'Lasagne' }, { now: NOW });
  board.setTea({ date: plus(3), text: 'Cottage pie' }, { now: NOW });
  const model = fakeModel({ 'Cottage pie': ['beef mince', 'potatoes'] });
  await ts.run({ now: NOW, deps: { suggest: model } });
  assert.strictEqual(toBuy().filter((n) => ts.baseName(n) === 'beef mince').length, 1);
  board.setTea({ date: plus(1), text: null }, { now: NOW });
  await ts.run({ now: NOW, deps: { suggest: model } });
  const names = toBuy();
  assert.ok(names.some((n) => n.startsWith('beef mince — for Cottage pie')), names.join(' | '));
  assert.ok(!names.some((n) => /Lasagne/.test(n)));
});

test('a model that cannot answer adds nothing and is retried; switched off adds nothing', async () => {
  reset();
  board.setTea({ date: plus(1), text: 'Mystery bake' }, { now: NOW });
  const r = await ts.run({ now: NOW, deps: { suggest: fakeModel({}) } });
  assert.strictEqual(r.added, 0);
  assert.ok(r.gaps.some((g) => g.input === 'model'));
  await ts.run({ now: NOW, deps: { suggest: fakeModel({ 'Mystery bake': ['pastry'] }) } });
  assert.ok(toBuy().some((n) => n.startsWith('pastry')));

  reset();
  ts.setEnabled(false);
  board.setTea({ date: plus(1), text: 'Lasagne' }, { now: NOW });
  const off = await ts.run({ now: NOW, deps: { suggest: fakeModel({}) } });
  assert.ok(off.skipped);
  assert.deepStrictEqual(toBuy(), []);
});

test('a tea change kicks the listener', () => {
  let got = null;
  const off = board.onTeaChange((e) => { got = e; });
  board.setTea({ date: plus(1), text: 'Soup' }, { now: NOW });
  off();
  assert.deepStrictEqual(got, { date: plus(1), text: 'Soup' });
});
