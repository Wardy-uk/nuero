'use strict';

/**
 * What each logged food name IS, as a drink — a database built from what comes
 * through on the sync (18 Oct 2026).
 *
 * Nick: "don't convert based on calories — look up the alcohol content based on
 * what comes through on the sync and build a database to use in future." The
 * old way took the calories no macro explained as alcohol; Foodnoms' Southern
 * Comfort carries ALL its energy as carbohydrate, so that arithmetic said ~0
 * units for a large measure of a 35% spirit, and for the whisky it was a guess.
 *
 * So every NEW food name seen in `nutrition_entries` is looked up ONCE and the
 * answer kept in `drink_profiles`, keyed on the normalised name:
 *   is_drink         is this an alcoholic drink at all (tea is not; a stew with
 *                    wine in it is not)
 *   abv              alcohol by volume, %
 *   kcal_per_100ml   the product's own energy density — used ONLY to work out
 *                    how much was poured when the app sent no volume (a spirit
 *                    in Foodnoms arrives as calories and nothing else)
 * A row Nick sets (`source: 'nick'`) is never overwritten by a lookup. A
 * lookup that could not answer leaves NO row, so the name is asked again next
 * pass; a lookup that answered "drink, strength unknown" is kept with abv null
 * and reads as unknown until he sets it — never guessed.
 *
 * `nameKey`, `validate`, `buildPrompt`, `parseAnswer` are PURE.
 */

const MAX_NAMES_PER_CALL = 40;
const ABV_MAX = 80;
const KCAL_MAX = 600;

function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().slice(0, 200);
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** A profile's fields, validated. Refuses, never clamps. PURE. */
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('profile must be an object');
  if (typeof raw.isDrink !== 'boolean') throw new Error('isDrink must be true or false');
  const abv = num(raw.abv);
  const kcal = num(raw.kcalPer100ml);
  if (abv !== null && !(Number.isFinite(abv) && abv >= 0 && abv <= ABV_MAX)) throw new Error(`abv must be 0–${ABV_MAX}`);
  if (kcal !== null && !(Number.isFinite(kcal) && kcal >= 0 && kcal <= KCAL_MAX)) throw new Error(`kcalPer100ml must be 0–${KCAL_MAX}`);
  const kind = raw.kind == null ? null : String(raw.kind).trim().slice(0, 40) || null;
  if (!raw.isDrink) return { isDrink: false, kind: null, abv: null, kcalPer100ml: null };
  return { isDrink: true, kind, abv, kcalPer100ml: kcal };
}

function buildPrompt(names) {
  return [
    'You are building a reference table of foods and drinks logged in a UK food diary app.',
    'For EACH name below, say whether it is an ALCOHOLIC drink as served (a glass, bottle, can, measure or cocktail).',
    'Food cooked with alcohol (gravy, casserole, cake, trifle, sauce) is NOT a drink.',
    'Tea, coffee, hot chocolate, soft drinks, squash, juice, milk and water are NOT alcoholic drinks: isDrink false.',
    'Only an alcohol-free VERSION of an alcoholic product (alcohol-free beer, wine, gin) is isDrink true with abv 0.',
    'For a drink give: kind (short, e.g. "whisky", "white wine", "lager", "liqueur"), abv as a percentage for the typical UK product of that name,',
    'and kcalPer100ml — the typical energy of the product per 100 ml as served. If the name states a strength (e.g. "12%"), use it.',
    'If you do not know a value, give null — never guess wildly. Non-drinks: isDrink false, other fields null.',
    'Answer with ONLY a JSON array, one object per name, in the same order:',
    '[{"name": "...", "isDrink": true, "kind": "...", "abv": 40, "kcalPer100ml": 222}]',
    '',
    'Names:',
    ...names.map((n, i) => `${i + 1}. ${n}`),
  ].join('\n');
}

/**
 * The model's answer → [{ name, profile }] in the order asked. PURE. Throws when
 * the answer cannot be read or does not cover every name — a partial table is
 * refused rather than kept, so nothing is stored on a guess about which row is
 * which. A single row that fails validation is dropped (asked again next time).
 */
function parseAnswer(text, names) {
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in the answer');
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch (e) { throw new Error(`answer is not JSON: ${e.message}`); }
  if (!Array.isArray(arr) || arr.length !== names.length) throw new Error(`answered ${Array.isArray(arr) ? arr.length : 0} of ${names.length} names`);
  const out = [];
  arr.forEach((row, i) => {
    if (row && row.name && nameKey(row.name) !== nameKey(names[i])) throw new Error(`row ${i + 1} names "${row.name}", expected "${names[i]}"`);
    try { out.push({ name: names[i], profile: validate(row) }); } catch { /* asked again next pass */ }
  });
  return out;
}

// ── store ────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function _row(r) {
  return {
    key: r.name_key, name: r.name, isDrink: r.is_drink === 1, kind: r.kind,
    abv: r.abv, kcalPer100ml: r.kcal_per_100ml, source: r.source, model: r.model,
    updatedAt: r.updated_at,
  };
}

/** Every profile, keyed on nameKey. */
function map() {
  const m = new Map();
  for (const r of _db().all('SELECT * FROM drink_profiles')) m.set(r.name_key, _row(r));
  return m;
}

function list({ drinksOnly = false } = {}) {
  return _db().all(`SELECT * FROM drink_profiles ${drinksOnly ? 'WHERE is_drink = 1' : ''} ORDER BY name COLLATE NOCASE`).map(_row);
}

/** Distinct logged names with no profile yet, newest first. */
function pendingNames(limit = MAX_NAMES_PER_CALL) {
  const known = new Set(_db().all('SELECT name_key FROM drink_profiles').map((r) => r.name_key));
  const out = [];
  const seen = new Set();
  for (const r of _db().all(`SELECT food_type, MAX(recorded_at) AS last FROM nutrition_entries
                             WHERE food_type IS NOT NULL GROUP BY food_type ORDER BY last DESC`)) {
    const k = nameKey(r.food_type);
    if (!k || known.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(r.food_type);
    if (out.length >= limit) break;
  }
  return out;
}

function _store(name, profile, source, model) {
  const now = new Date().toISOString();
  const params = [nameKey(name), String(name).slice(0, 200), profile.isDrink ? 1 : 0, profile.kind, profile.abv, profile.kcalPer100ml, source, model || null, now];
  if (source === 'nick') {
    _db().run(`INSERT INTO drink_profiles (name_key, name, is_drink, kind, abv, kcal_per_100ml, source, model, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, is_drink = excluded.is_drink, kind = excluded.kind,
                 abv = excluded.abv, kcal_per_100ml = excluded.kcal_per_100ml, source = 'nick', model = NULL, updated_at = excluded.updated_at`, params);
  } else {
    // A lookup never replaces anything — least of all Nick's word.
    _db().run(`INSERT OR IGNORE INTO drink_profiles (name_key, name, is_drink, kind, abv, kcal_per_100ml, source, model, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params);
  }
}

/** Nick's correction. Refuses a bad value; never clamps. */
function setByNick(name, fields) {
  if (!nameKey(name)) throw new Error('name is required');
  const profile = validate(fields);
  _store(name, profile, 'nick');
  return _row(_db().get('SELECT * FROM drink_profiles WHERE name_key = ?', [nameKey(name)]));
}

async function _askModel(names) {
  const r = await require('./ai-routing').runTask('drink_lookup', { prompt: buildPrompt(names), maxTokens: 4000 }, { forceCloud: true, timeout: 90000 });
  if (!r || !r.text) throw new Error((r && r.reason) || 'no AI provider answered');
  return { text: r.text, model: r.model || r.provider || null };
}

let _running = false;

/**
 * Look up names nothing has answered yet. `ask(names) → { text, model }` is
 * injectable for tests. Never throws; a failed pass stores nothing and says why.
 */
async function lookupPending({ ask = _askModel, limit = MAX_NAMES_PER_CALL } = {}) {
  if (_running) return { ok: true, skipped: 'already running' };
  _running = true;
  try {
    const names = pendingNames(limit);
    if (!names.length) return { ok: true, asked: 0, stored: 0 };
    let parsed; let model;
    try {
      const a = await ask(names);
      model = a.model;
      parsed = parseAnswer(a.text, names);
    } catch (e) {
      console.warn(`[DrinkProfiles] lookup of ${names.length} name(s) failed: ${e.message}`);
      return { ok: false, asked: names.length, stored: 0, why: e.message };
    }
    for (const p of parsed) _store(p.name, p.profile, 'lookup', model);
    const drinks = parsed.filter((p) => p.profile.isDrink).map((p) => `${p.name} (${p.profile.abv ?? '?'}%)`);
    console.log(`[DrinkProfiles] looked up ${parsed.length}/${names.length}${drinks.length ? ` — drinks: ${drinks.join(', ')}` : ''}`);
    return { ok: true, asked: names.length, stored: parsed.length, drinks: drinks.length };
  } finally {
    _running = false;
  }
}

/** Fire-and-forget after an ingest that brought new food. Never throws. */
function kick() {
  setImmediate(() => { lookupPending().catch((e) => console.warn('[DrinkProfiles] kick failed:', e.message)); });
}

module.exports = { nameKey, validate, buildPrompt, parseAnswer, map, list, pendingNames, setByNick, lookupPending, kick, MAX_NAMES_PER_CALL };
