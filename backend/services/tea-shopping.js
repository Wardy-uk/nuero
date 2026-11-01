'use strict';

/**
 * Tea plan → shopping list (1 Nov 2026).
 *
 * A tea planned on the household board for today..+6 puts its ingredients on the
 * shared `shopping` catalogue (To buy). Ingredients come from:
 *   1. a RECIPE in the vault — a note in any folder named `Recipes`, or a note
 *      whose frontmatter says `recipe:` / `type: recipe` — whose title is the
 *      meal (or a whole-word part of it); its `## Ingredients` bullets are used.
 *   2. otherwise ONE model call (gate class `tea_ingredients`, cloud) for a
 *      typical UK ingredient list, cached per meal for good and marked SUGGESTED.
 *
 * Rules (Nick's, 1 Nov 2026):
 *   • never add something already To buy — folded by normalised name;
 *   • an item NEURO adds reads "<ingredient> — for <meal> (<Day>)";
 *   • removing or changing a tea removes ONLY the items that tea added that are
 *     still To buy (bought ones stay bought; Nick's own items are never touched);
 *   • staples (salt, pepper, oil, water, sugar, flour) are skipped;
 *   • a household switch turns it off (default ON). Off adds and removes nothing.
 *
 * The ledger (agent_state.tea_shopping_ledger) is the memory of what a tea added,
 * so a re-run is a reconcile, never a second copy. A model that cannot answer
 * adds nothing for that tea and is retried on the next pass.
 */

const path = require('path');
const fs = require('fs');

const LEDGER_KEY = 'tea_shopping_ledger';
const SETTING_KEY = 'tea_shopping_enabled';
const STATUS_KEY = 'tea_shopping_status';
const STAPLES = Object.freeze(['salt', 'pepper', 'black pepper', 'sea salt', 'oil', 'olive oil', 'vegetable oil', 'sunflower oil', 'cooking oil', 'rapeseed oil', 'water', 'sugar', 'flour', 'plain flour']);
const MAX_INGREDIENTS = 25;
const MAX_INGREDIENT_CHARS = 60;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RECIPE_INDEX_TTL_MS = 60 * 60 * 1000;

function _db() { return require('../db/database'); }
function _json(key, d) { try { const v = JSON.parse(_db().getState(key) || 'null'); return v == null ? d : v; } catch { return d; } }
function _set(key, v) { _db().setState(key, JSON.stringify(v)); }
const _k = (s) => String(s || '').trim().toLowerCase();

// ── pure ─────────────────────────────────────────────────────────────────────

function mealKey(meal) { return String(meal || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/** The ingredient itself, for folding: quantities, the "— for …" note and plurals gone. PURE. */
function baseName(name) {
  let s = String(name || '').split(' — for ')[0].toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*[\d½¼¾./]+\s*(x\s*)?(kg|g|grams?|ml|l|litres?|tbsp|tsp|tablespoons?|teaspoons?|cups?|oz|lb|cans?|tins?|packs?|packets?|jars?|bunch(es)?|cloves?|pinch(es)?|handfuls?|slices?)?\b\.?/i, ' ')
    .replace(/\b(fresh|large|small|medium|chopped|sliced|diced|minced|of)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ');
  const last = words[words.length - 1] || '';
  if (last.length > 3 && /oes$/.test(last)) words[words.length - 1] = last.slice(0, -2);
  else if (last.length > 3 && /[^s]s$/.test(last)) words[words.length - 1] = last.slice(0, -1);
  return words.join(' ').trim();
}

function isStaple(name) { const b = baseName(name); return STAPLES.some((s) => b === s || b === baseName(s)); }

function dayWord(dateKey) { return WEEKDAY[new Date(`${dateKey}T12:00:00Z`).getUTCDay()]; }

function itemName(ingredient, meal, dateKey, max = 120) {
  const tag = ` — for ${meal} (${dayWord(dateKey)})`;
  const ing = String(ingredient).trim().slice(0, Math.max(10, max - tag.length));
  return `${ing}${tag}`.slice(0, max);
}

/** The model's answer → a clean list, or null when it is not one. PURE. */
function parseIngredients(text) {
  const m = /\[[\s\S]*\]/.exec(String(text || ''));
  if (!m) return null;
  let arr; try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length || arr.length > MAX_INGREDIENTS) return null;
  if (!arr.every((x) => typeof x === 'string' && x.trim() && x.length <= MAX_INGREDIENT_CHARS)) return null;
  return arr.map((x) => x.trim());
}

/** A recipe note's ingredient bullets. PURE. Null when it has no Ingredients section. */
function recipeIngredients(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^#{1,4}\s*ingredients\b/i.test(l.trim()));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (/^#{1,4}\s/.test(l)) break;
    const b = /^[-*+]\s+(\[[ xX]\]\s+)?(.+)$/.exec(l) || /^\d+[.)]\s+(.+)$/.exec(l);
    if (b) out.push(String(b[b.length - 1]).replace(/\[\[([^|\]]*\|)?([^\]]*)\]\]/g, '$2').trim());
  }
  return out.length ? out.slice(0, MAX_INGREDIENTS) : null;
}

/** The recipe a meal names: exact title, else the longest title that is a whole-word part of the meal. PURE. */
function matchRecipe(meal, index) {
  const m = mealKey(meal);
  if (!m) return null;
  const exact = index.find((r) => r.key === m);
  if (exact) return exact;
  const padded = ` ${m} `;
  const parts = index.filter((r) => r.key && padded.includes(` ${r.key} `)).sort((a, b) => b.key.length - a.key.length);
  return parts[0] || null;
}

/**
 * The plan. PURE. Given the teas, the ledger, the To buy names and how to get
 * each meal's ingredients, say what to add and what to remove.
 *   teas         [{date, text}] — today..+6
 *   ledger       { entries: { "<date>|<mealKey>": { date, meal, ingredients, source, added:[name], folded:[base] } } }
 *   toBuy        [name] currently To buy
 *   ingredients  mealKey → { list, source } | null (not known yet)
 */
function reconcile({ teas, ledger, toBuy, ingredients, today }) {
  const entries = { ...((ledger && ledger.entries) || {}) };
  const live = new Set(teas.map((t) => `${t.date}|${mealKey(t.text)}`));
  const toBuySet = new Set(toBuy.map((n) => _k(n)));
  const remove = [];
  const removedBases = new Set();
  // 1. Teas that are gone (cleared or changed): take back what they added and is still To buy.
  for (const [key, e] of Object.entries(entries)) {
    if (live.has(key)) continue;
    if (e.date >= today) {
      for (const n of e.added || []) if (toBuySet.has(_k(n))) { remove.push(n); removedBases.add(baseName(n)); toBuySet.delete(_k(n)); }
    }
    delete entries[key];
  }
  const presentBases = new Set([...toBuySet].map((n) => baseName(n)));
  const add = [];
  const waiting = [];
  for (const t of teas) {
    const key = `${t.date}|${mealKey(t.text)}`;
    let e = entries[key];
    if (!e) {
      const got = ingredients(mealKey(t.text));
      if (!got) { waiting.push(t); continue; }
      e = { date: t.date, meal: t.text, ingredients: got.list, source: got.source, recipePath: got.path || null, added: [], folded: [] };
      entries[key] = e;
    }
    for (const ing of e.ingredients) {
      if (isStaple(ing)) continue;
      const b = baseName(ing);
      if (!b) continue;
      const mine = (e.added || []).some((n) => baseName(n) === b);
      if (mine) continue;                                          // added before: bought or still there — never twice
      if (presentBases.has(b)) { if (!e.folded.includes(b)) e.folded.push(b); continue; }
      // Folded onto something earlier that has since been bought: leave it. Folded
      // onto something THIS pass took back: this tea still needs it, so add it.
      if (e.folded.includes(b) && !removedBases.has(b)) continue;
      const name = itemName(ing, t.text, t.date);
      add.push(name);
      e.added = [...(e.added || []), name];
      e.folded = e.folded.filter((x) => x !== b);
      presentBases.add(b);
    }
  }
  return { add, remove, waiting, ledger: { ...(ledger || {}), entries } };
}

// ── impure: setting, recipes, model ─────────────────────────────────────────

function enabled() { return String(_db().getState(SETTING_KEY) || 'true') !== 'false'; }
function setEnabled(on, { by = null, now = Date.now() } = {}) {
  if (typeof on !== 'boolean') return { ok: false, status: 400, error: 'on must be true or false' };
  _db().setState(SETTING_KEY, on ? 'true' : 'false');
  try { require('./personal-obligations').logEvent('tea-shopping-setting', { actor: 'nick', detail: { on, by }, now }); } catch { /* record only */ }
  return { ok: true, enabled: on };
}

let _recipeIndex = { at: 0, root: null, list: null };
function recipeIndex({ root = process.env.OBSIDIAN_VAULT_PATH, nowMs = Date.now() } = {}) {
  if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) throw new Error('the vault is not reachable');
  if (_recipeIndex.list && _recipeIndex.root === root && nowMs - _recipeIndex.at < RECIPE_INDEX_TTL_MS) return _recipeIndex.list;
  const list = [];
  const { RETIRED_DIRS } = require('./vault-exclusions');
  require('./vault-walk').walk(root, {
    skipDir: (name) => name.startsWith('.') || (RETIRED_DIRS || []).includes(name),
    visit: (rel, full) => {
      if (!rel.endsWith('.md')) return;
      const inRecipes = rel.split(/[\\/]/).slice(0, -1).some((seg) => seg.toLowerCase() === 'recipes');
      let head = '';
      try { const fd = fs.openSync(full, 'r'); const buf = Buffer.alloc(600); const n = fs.readSync(fd, buf, 0, 600, 0); fs.closeSync(fd); head = buf.slice(0, n).toString('utf8'); } catch { return; }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
      const flagged = fm && (/^recipe\s*:/m.test(fm[1]) || /^type\s*:\s*["']?recipe/m.test(fm[1]));
      if (!inRecipes && !flagged) return;
      const title = path.basename(rel, '.md');
      list.push({ key: mealKey(title), title, path: rel.replace(/\\/g, '/'), full });
    },
  });
  _recipeIndex = { at: nowMs, root, list };
  return list;
}

async function suggestIngredients(meal) {
  const prompt = `List the ingredients someone in the UK would typically buy to cook "${meal}" for a family tea.\n`
    + 'Answer ONLY with a JSON array of short shopping-list names (e.g. ["beef mince","onion","chopped tomatoes"]), at most 15 items, no quantities, no staples like salt, pepper, oil or water.';
  const r = await require('./ai-routing').runTask('tea_ingredients', { prompt, maxTokens: 400 }, { forceCloud: true, timeout: 30000 });
  return parseIngredients(r && r.text);
}

/**
 * One pass: read the teas, work out each meal's ingredients, apply the plan to
 * the shopping list, write the ledger. `deps` lets tests replace the model and
 * the recipe index.
 */
async function run({ now = Date.now(), deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const board = require('./household-board');
  if (!enabled()) return { ok: true, skipped: true, why: 'switched off for the household' };
  const today = board.localKey(nowMs);
  const teas = board.readTea({ now: nowMs }).days;
  const ledger = _json(LEDGER_KEY, { entries: {}, cache: {} });
  ledger.cache = ledger.cache || {};
  const gaps = [];
  let index = [];
  try { index = (deps.recipeIndex || recipeIndex)({ nowMs }); } catch (e) { gaps.push({ input: 'recipes', why: e.message }); index = null; }
  const suggest = deps.suggest || suggestIngredients;
  const known = new Map();
  for (const t of teas) {
    const mk = mealKey(t.text);
    if (known.has(mk) || (ledger.entries || {})[`${t.date}|${mk}`]) continue;
    const recipe = index ? matchRecipe(t.text, index) : null;
    if (recipe) {
      let list = null;
      try { list = recipeIngredients(fs.readFileSync(recipe.full, 'utf8')); } catch { list = null; }
      if (list) { known.set(mk, { list, source: 'recipe', path: recipe.path }); continue; }
    }
    if (ledger.cache[mk]) { known.set(mk, ledger.cache[mk]); continue; }
    // No recipe index at all (vault unreachable): a model guess for a meal Nick may
    // have a recipe for is not what he asked for — wait for the vault instead.
    if (!index) continue;
    let list = null;
    try { list = await suggest(t.text); } catch (e) { gaps.push({ input: 'model', why: e.message }); }
    if (list) { const v = { list, source: 'suggested' }; ledger.cache[mk] = v; known.set(mk, v); } else gaps.push({ input: 'model', why: `no usable ingredient list for "${t.text}"` });
  }
  const open = board.openShoppingForWrite();
  if (!open.ok) { _set(STATUS_KEY, { at: new Date(nowMs).toISOString(), gaps: [...gaps, { input: 'shopping', why: open.error }] }); return { ok: false, error: open.error, gaps }; }
  const cat = open.cat;
  const toBuyKey = _k(board.TO_BUY);
  const toBuy = cat.items[toBuyKey].map((i) => i.name);
  const plan = reconcile({ teas, ledger, toBuy, ingredients: (mk) => known.get(mk) || null, today });
  if (plan.add.length || plan.remove.length) {
    const rm = new Set(plan.remove.map(_k));
    cat.items[toBuyKey] = cat.items[toBuyKey].filter((i) => !rm.has(_k(i.name)));
    for (const n of plan.add) cat.items[toBuyKey].push({ name: n, added: today });
    const w = require('./catalogue').write(board.SHOPPING_SLUG, cat);
    if (!w.ok) return { ok: false, error: 'could not save the shopping list', gaps };
  }
  _set(LEDGER_KEY, plan.ledger);
  const status = { at: new Date(nowMs).toISOString(), added: plan.add.length, removed: plan.remove.length, waiting: plan.waiting.map((t) => t.text), gaps };
  _set(STATUS_KEY, status);
  if (plan.add.length || plan.remove.length) {
    try { require('./personal-obligations').logEvent('tea-shopping-changed', { detail: { added: plan.add, removed: plan.remove }, now: nowMs }); } catch { /* record only */ }
  }
  return { ok: true, ...status, addedNames: plan.add, removedNames: plan.remove };
}

let _running = null;
/** Background kick after a tea change; one at a time. */
function kick() {
  if (_running) return _running;
  _running = run().catch((e) => ({ ok: false, error: e.message })).finally(() => { _running = null; });
  return _running;
}

function status() {
  return { enabled: enabled(), last: _json(STATUS_KEY, null),
    rule: 'A tea planned for the next 7 days puts its ingredients on the shared shopping list — from your recipe if the vault has one, otherwise a suggested list. Anything already on the list is not added twice; staples are skipped; changing the tea takes back only what it added and you have not bought.' };
}

function _resetForTests() { _recipeIndex = { at: 0, root: null, list: null }; }

module.exports = { run, kick, status, enabled, setEnabled, reconcile, baseName, isStaple, itemName, parseIngredients, recipeIngredients, matchRecipe, mealKey, recipeIndex, STAPLES, LEDGER_KEY, SETTING_KEY, _resetForTests };
