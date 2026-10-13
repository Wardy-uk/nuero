'use strict';

/**
 * Drinks and alcohol units, by NAME (13 Oct 2026).
 *
 * Nick logs drinks in Foodnoms, which writes each item to Apple Health with its
 * name (HKMetadataKeyFoodType, "Wine (White)") and one id shared by all of that
 * item's nutrient samples. MyFitnessPal sends only meal totals with no names, so
 * an MFP drink can never be counted here — and nothing pretends otherwise.
 *
 *   strength  from the NAME: a "12%" in the name wins; else the drinks table
 *   volume    from the item's own water: water ÷ (1 − strength)
 *   units     volume × strength ÷ 1000 (UK units)
 *   check     the calories no macro explains (7 kcal/g, 8 g a unit) give a
 *             second, independent answer — shown beside the first, and a
 *             disagreement is SAID, never averaged away.
 *
 * Nick's call: "cross reference the alcohol content based on the name of the
 * drink, rather than just relying on calculation". A name NEURO does not know is
 * "unrecognised", never guessed. Nothing here notifies.
 *
 * `fromEntries`, `matchDrink`, `dailyUnits` are PURE. `read` gathers.
 */

// Names that contain a drink word but are not drinks. Checked FIRST.
const NOT_A_DRINK = /\b(ginger beer|root beer|gums?|vinegar|batter(ed)?|raisin|sauce|gravy|cake|chocolate|ice ?cream|jelly|marinade|cheese|salut|truffles?|poached|casserole|stew|risotto|glaze|reduction|fudge|sorbet)\b/;

// Order matters: specific before generic.
const DRINKS = Object.freeze([
  { kind: 'alcohol-free', abv: 0, re: /alcohol[- ]?free|non[- ]?alcoholic|\b0\.0\b|\balc[- ]?free\b|\bzero alcohol\b/ },
  { kind: 'southern comfort', abv: 35, re: /southern comfort/ },
  { kind: 'irish cream', abv: 17, re: /bailey'?s|irish cream/ },
  { kind: 'red wine', abv: 13.5, re: /red wine|wine,? \(?red\)?|\b(merlot|malbec|shiraz|syrah|cabernet|rioja|pinot noir|tempranillo|zinfandel|beaujolais|chianti)\b/ },
  { kind: 'rosé', abv: 12, re: /\bros[eé]\b|blush/ },
  { kind: 'sparkling wine', abv: 11.5, re: /\b(prosecco|champagne|cava|sparkling wine|cr[eé]mant)\b/ },
  { kind: 'white wine', abv: 12.5, re: /white wine|wine,? \(?white\)?|\b(pinot grigio|pinot gris|sauvignon|chardonnay|riesling|chenin|albari[nñ]o|viognier|muscadet)\b/ },
  { kind: 'port', abv: 20, re: /\bport\b(?! salut)/ },
  { kind: 'sherry', abv: 17.5, re: /\bsherry\b/ },
  { kind: 'wine', abv: 12.5, re: /\bwine\b/ },
  { kind: 'whisky', abv: 40, re: /\b(whisky|whiskey|scotch|bourbon|single malt)\b/ },
  { kind: 'gin', abv: 37.5, re: /\bgin\b/ },
  { kind: 'vodka', abv: 37.5, re: /\bvodka\b/ },
  { kind: 'rum', abv: 37.5, re: /\brum\b/ },
  { kind: 'tequila', abv: 38, re: /\b(tequila|mezcal)\b/ },
  { kind: 'brandy', abv: 40, re: /\b(brandy|cognac|armagnac)\b/ },
  { kind: 'liqueur', abv: 25, re: /\bliqueur\b/ },
  { kind: 'cider', abv: 5, re: /\bcider\b/ },
  { kind: 'stout', abv: 4.2, re: /\b(stout|guinness|porter)\b/ },
  { kind: 'ale', abv: 4.2, re: /\b(ale|bitter)\b/ },
  { kind: 'beer', abv: 4.5, re: /\b(beer|lager|pilsner|pils|ipa)\b/ },
]);

const KCAL_PER_G = 7;
const G_PER_UNIT = 8;
const ETHANOL_G_PER_ML = 0.789;
// Two answers that differ by more than this (and by more than AGREE_ABS units)
// are reported as disagreeing.
const AGREE_REL = 0.25;
const AGREE_ABS = 0.4;

const round = (n, dp = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);

/** A drink from its name, or null. PURE. */
function matchDrink(name) {
  const n = String(name || '').toLowerCase();
  if (!n || NOT_A_DRINK.test(n)) return null;
  const hit = DRINKS.find((d) => d.re.test(n));
  if (!hit) return null;
  const stated = n.match(/(\d{1,2}(?:\.\d+)?)\s?%/);
  if (stated && hit.abv > 0) {
    const abv = Number(stated[1]);
    if (abv > 0 && abv <= 70) return { kind: hit.kind, abv, abvBasis: 'stated in the name' };
  }
  return { kind: hit.kind, abv: hit.abv, abvBasis: hit.abv === 0 ? 'alcohol-free' : `typical ${hit.kind}` };
}

/** One logged item → drink figures, or null when it is not a recognised drink. PURE. */
function drinkFromItem(item) {
  const drink = matchDrink(item.name);
  if (!drink) return null;
  const n = item.nutrients;
  const waterMl = Number.isFinite(n.dietary_water) ? n.dietary_water * 1000 : null; // stored in litres
  const kcal = n.dietary_energy_consumed;
  // The independent check: calories no macro explains.
  let calcUnits = null; let calcAbv = null;
  if (Number.isFinite(kcal)) {
    const alcKcal = kcal - 4 * (n.dietary_carbohydrates || 0) - 4 * (n.dietary_protein || 0) - 9 * (n.dietary_fat_total || 0) - 2 * (n.dietary_fiber || 0);
    const grams = Math.max(0, alcKcal) / KCAL_PER_G;
    calcUnits = round(grams / G_PER_UNIT, 1);
    if (waterMl != null && grams > 0) { const ml = grams / ETHANOL_G_PER_ML; calcAbv = round((ml / (waterMl + ml)) * 100, 1); }
  }
  let units = null; let volumeMl = null; let basis; let why;
  if (drink.abv === 0) { units = 0; basis = 'name'; why = 'alcohol-free by its name'; }
  else if (waterMl != null && waterMl > 0) {
    volumeMl = round(waterMl / (1 - drink.abv / 100), 0);
    units = round((volumeMl * drink.abv) / 1000, 1);
    basis = 'name';
    why = `${drink.kind} at ${drink.abv}% (${drink.abvBasis}), about ${volumeMl} ml`;
  } else if (calcUnits != null) {
    units = calcUnits; basis = 'calories';
    why = `${drink.kind} by its name; no volume sent, so units are from its calories`;
  } else {
    basis = 'unknown'; why = `${drink.kind} by its name, but no volume or calories were sent`;
  }
  let agree = null;
  if (basis === 'name' && drink.abv > 0 && calcUnits != null) {
    const diff = Math.abs(units - calcUnits);
    agree = diff <= AGREE_ABS || diff <= AGREE_REL * Math.max(units, calcUnits);
  }
  return {
    item: item.item, name: item.name, at: item.at, day: item.day, kind: drink.kind,
    abv: drink.abv, abvBasis: drink.abvBasis, volumeMl, units, basis, why,
    check: { units: calcUnits, abv: calcAbv, agree,
      line: agree === false ? `the calories say ${calcUnits} units${calcAbv != null ? ` (about ${calcAbv}%)` : ''} — check the entry` : null },
  };
}

/**
 * Entries → items → drinks. PURE. entries: [{ metric, value, recorded_at,
 * food_type, food_item }]; localDay maps a stored UTC stamp to a local day.
 * Entries with no name cannot be a drink here (MyFitnessPal sends none).
 */
function fromEntries(entries, localDay) {
  const items = new Map();
  for (const e of entries || []) {
    if (!e.food_type) continue;
    const key = e.food_item || `${e.recorded_at}|${e.food_type}`;
    const it = items.get(key) || { item: key, name: e.food_type, at: e.recorded_at, day: localDay(e.recorded_at), nutrients: {} };
    it.nutrients[e.metric] = (it.nutrients[e.metric] || 0) + Number(e.value || 0);
    items.set(key, it);
  }
  const drinks = [];
  for (const it of items.values()) { const d = drinkFromItem(it); if (d) drinks.push(d); }
  return drinks.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * Units per finished day, for the goal measure. PURE. A day with food logged
 * (any app) and no drink is 0 — a day with nothing logged is absent, unknown.
 * A drink whose units are unknown makes its day unknown too, never 0.
 */
function dailyUnits(entries, drinks, today, localDay) {
  const logged = new Set((entries || []).map((e) => localDay(e.recorded_at)).filter((d) => d && d < today));
  const byDay = new Map([...logged].map((d) => [d, 0]));
  const unknownDays = new Set();
  for (const d of drinks) {
    if (!d.day || d.day >= today) continue;
    if (d.units == null) { unknownDays.add(d.day); continue; }
    byDay.set(d.day, round((byDay.get(d.day) || 0) + d.units, 1));
  }
  return [...byDay].filter(([day]) => !unknownDays.has(day))
    .map(([day, units]) => ({ day, complete: true, alcoholUnits: units }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

function read({ now = new Date(), days = 30 } = {}) {
  const nutrition = require('./nutrition');
  const since = new Date(now.getTime() - (days + 2) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const entries = require('../db/database').getNutritionEntriesSince(since);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London' }).format(now);
  const drinks = fromEntries(entries, (s) => nutrition.localDay(s));
  const week = drinks.filter((d) => d.day && d.day > shift(today, -7));
  return {
    ok: true, contract: 'drinks-v1', today, drinks,
    last7: { units: round(week.reduce((a, d) => a + (d.units || 0), 0), 1), drinks: week.length, unknown: week.filter((d) => d.units == null).length },
    days: dailyUnits(entries, drinks, today, (s) => nutrition.localDay(s)),
    note: 'Drinks are read by NAME from a food app that names its items (Foodnoms). Strength comes from the name; volume from the drink’s own water; the calories give a second check. MyFitnessPal sends no names, so drinks logged only there are not counted.',
  };
}

function shift(day, n) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

module.exports = { DRINKS, matchDrink, drinkFromItem, fromEntries, dailyUnits, read };
