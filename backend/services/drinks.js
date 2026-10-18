'use strict';

/**
 * Drinks and alcohol units, by NAME (13 Oct 2026; rewritten 18 Oct 2026).
 *
 * Nick logs drinks in Foodnoms, which writes each item to Apple Health with its
 * name (HKMetadataKeyFoodType, "Wine (White)") and one id shared by all of that
 * item's nutrient samples. MyFitnessPal sends only meal totals with no names, so
 * an MFP drink can never be counted here — and nothing pretends otherwise.
 *
 * Nick, 18 Oct: "don't convert based on calories — look up the alcohol content
 * based on what comes through on the sync and build a database". So:
 *   what it is   from `drink_profiles` (services/drink-profiles.js): each name
 *                looked up ONCE — is it a drink, its ABV, its kcal per 100 ml;
 *                Nick's correction wins. A "12%" in the name beats the table.
 *   volume       the item's own water ÷ (1 − strength) when the app sent water;
 *                otherwise its calories ÷ that PRODUCT's kcal/100 ml — how much
 *                of it was poured. Never "alcohol = the calories the macros
 *                don't explain": Foodnoms' Southern Comfort books ALL its energy
 *                as carbohydrate, so that arithmetic said nothing at all.
 *   units        volume × ABV ÷ 1000 (UK units)
 *   check        when both volumes exist they are compared; a disagreement is
 *                SAID, never averaged.
 * A name not looked up yet, or a drink whose strength is unknown, is UNKNOWN —
 * never guessed, never 0. Nothing here notifies.
 *
 * `matchDrink`, `drinkFromItem`, `fromEntries`, `dailyUnits` are PURE. `read` gathers.
 */

const { nameKey } = require('./drink-profiles');

// Used ONLY to decide whether a name NOT YET LOOKED UP might be a drink — so its
// day reads unknown for the minutes until the lookup answers, rather than dry.
// It never supplies a strength.
const NOT_A_DRINK = /\b(ginger beer|root beer|gums?|vinegar|batter(ed)?|raisin|sauce|gravy|cake|chocolate|ice ?cream|jelly|marinade|cheese|salut|truffles?|poached|casserole|stew|risotto|glaze|reduction|fudge|sorbet)\b/;
const LIKELY_DRINK = /\b(wine|merlot|malbec|shiraz|rioja|prosecco|champagne|cava|port|sherry|whisky|whiskey|scotch|bourbon|gin|vodka|rum|tequila|brandy|cognac|liqueur|cider|stout|guinness|ale|bitter|beer|lager|pilsner|ipa|spritz|cocktail|baileys|comfort|pimms|aperol|martini)\b/;

const AGREE_REL = 0.25;

const round = (n, dp = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);

/**
 * A name → what it is, from the profile table. PURE.
 * null = not a drink; else { kind, abv, abvBasis, kcalPer100ml, pending }.
 */
function matchDrink(name, profiles = new Map()) {
  const raw = String(name || '');
  const n = raw.toLowerCase();
  if (!n) return null;
  const p = profiles.get(nameKey(raw));
  if (!p) {
    if (NOT_A_DRINK.test(n) || !LIKELY_DRINK.test(n.replace(/'/g, ''))) return null;
    return { kind: 'drink', abv: null, abvBasis: 'not looked up yet', kcalPer100ml: null, pending: true };
  }
  if (!p.isDrink) return null;
  const by = p.source === 'nick' ? 'set by you' : 'looked up';
  const stated = n.match(/(\d{1,2}(?:\.\d+)?)\s?%/);
  if (stated && p.abv !== 0) {
    const abv = Number(stated[1]);
    if (abv > 0 && abv <= 80) return { kind: p.kind || 'drink', abv, abvBasis: 'stated in the name', kcalPer100ml: p.kcalPer100ml, pending: false };
  }
  return { kind: p.kind || 'drink', abv: p.abv, abvBasis: p.abv == null ? 'strength not known' : by, kcalPer100ml: p.kcalPer100ml, pending: false };
}

/** One logged item → drink figures, or null when it is not a drink. PURE. */
function drinkFromItem(item, profiles) {
  const drink = matchDrink(item.name, profiles);
  if (!drink) return null;
  const n = item.nutrients;
  const waterMl = Number.isFinite(n.dietary_water) && n.dietary_water > 0 ? n.dietary_water * 1000 : null; // stored in litres
  const kcal = Number.isFinite(n.dietary_energy_consumed) && n.dietary_energy_consumed > 0 ? n.dietary_energy_consumed : null;
  const fromWater = drink.abv != null && waterMl != null ? waterMl / (1 - drink.abv / 100) : null;
  const fromEnergy = kcal != null && drink.kcalPer100ml > 0 ? (kcal / drink.kcalPer100ml) * 100 : null;

  let units = null; let volumeMl = null; let basis; let why;
  if (drink.pending) {
    basis = 'unknown'; why = 'not looked up yet — NEURO checks new names every 15 minutes';
  } else if (drink.abv === 0) {
    units = 0; basis = 'name'; why = `${drink.kind}, alcohol-free`;
  } else if (drink.abv == null) {
    basis = 'unknown'; why = `${drink.kind}, but its strength is not known — set it`;
  } else if (fromWater != null || fromEnergy != null) {
    volumeMl = round(fromWater != null ? fromWater : fromEnergy, 0);
    units = round((volumeMl * drink.abv) / 1000, 1);
    basis = fromWater != null ? 'water' : 'energy';
    why = `${drink.kind} at ${drink.abv}% (${drink.abvBasis}), about ${volumeMl} ml `
      + (basis === 'water' ? 'from its water' : `from its ${Math.round(kcal)} kcal at ${drink.kcalPer100ml} kcal/100 ml`);
  } else {
    basis = 'unknown';
    why = `${drink.kind} at ${drink.abv}% (${drink.abvBasis}), but no volume was sent${kcal != null ? ' and its kcal per 100 ml is not known — set it' : ''}`;
  }

  let check = { volumeMl: null, agree: null, line: null };
  if (fromWater != null && fromEnergy != null) {
    const other = round(fromEnergy, 0);
    const agree = Math.abs(fromWater - fromEnergy) <= AGREE_REL * Math.max(fromWater, fromEnergy);
    check = { volumeMl: other, agree, line: agree ? null : `its calories say about ${other} ml, not ${volumeMl} — check the entry` };
  }
  return {
    item: item.item, name: item.name, at: item.at, day: item.day, kind: drink.kind,
    abv: drink.abv, abvBasis: drink.abvBasis, kcalPer100ml: drink.kcalPer100ml, pending: drink.pending,
    volumeMl, units, basis, why, check,
  };
}

/**
 * Entries → items → drinks. PURE. entries: [{ metric, value, recorded_at,
 * food_type, food_item }]; localDay maps a stored UTC stamp to a local day;
 * profiles is drink-profiles.map(). Entries with no name cannot be a drink here.
 */
function fromEntries(entries, localDay, profiles = new Map()) {
  const items = new Map();
  for (const e of entries || []) {
    if (!e.food_type) continue;
    const key = e.food_item || `${e.recorded_at}|${e.food_type}`;
    const it = items.get(key) || { item: key, name: e.food_type, at: e.recorded_at, day: localDay(e.recorded_at), nutrients: {} };
    it.nutrients[e.metric] = (it.nutrients[e.metric] || 0) + Number(e.value || 0);
    items.set(key, it);
  }
  const drinks = [];
  for (const it of items.values()) { const d = drinkFromItem(it, profiles); if (d) drinks.push(d); }
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
  const profiles = require('./drink-profiles');
  const since = new Date(now.getTime() - (days + 2) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const entries = require('../db/database').getNutritionEntriesSince(since);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London' }).format(now);
  const drinks = fromEntries(entries, (s) => nutrition.localDay(s), profiles.map());
  const week = drinks.filter((d) => d.day && d.day > shift(today, -7));
  let pendingNames = null;
  try { pendingNames = profiles.pendingNames(1000).length; } catch { /* unknown, said as null */ }
  return {
    ok: true, contract: 'drinks-v2', today, drinks, pendingNames,
    last7: { units: round(week.reduce((a, d) => a + (d.units || 0), 0), 1), drinks: week.length, unknown: week.filter((d) => d.units == null).length },
    days: dailyUnits(entries, drinks, today, (s) => nutrition.localDay(s)),
    note: 'Drinks are read by NAME from a food app that names its items (Foodnoms). Each new name is looked up once — is it a drink, its strength, its calories per 100 ml — and kept; your correction wins. The amount comes from the drink’s own water, or from its calories at that product’s calories per 100 ml. MyFitnessPal sends no names, so drinks logged only there are not counted.',
  };
}

function shift(day, n) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

module.exports = { matchDrink, drinkFromItem, fromEntries, dailyUnits, read };
