'use strict';

/**
 * Nutrition — what MyFitnessPal (or anything else) writes to Apple Health,
 * folded into days, averaged, and set against UK reference values.
 *
 * Split like health-picture: `compose()` is PURE (samples → read model) and
 * `read()` gathers. Storage is `health_samples`, unchanged: masses are GRAMS
 * (apple-health.js normalises on the way in), energy kcal, water litres.
 *
 * ⚠ THREE HONESTY RULES, each measured on the live store before writing this:
 *   • NOT LOGGED IS NOT ZERO. A day with no energy entry is `logged: false` and
 *     carries no totals — it is never averaged in as an empty plate.
 *   • A PART-LOGGED DAY IS NOT A DAY. Averages use only days with at least
 *     FULL_DAY_KCAL logged; the rest are counted and named, because a day where
 *     only breakfast went in would read as a fast.
 *   • MYFITNESSPAL WRITES 0 FOR A NUTRIENT ITS FOOD ENTRY LACKS. Calcium, iron and
 *     vitamin C averaged ~0 per meal across six months of history. So vitamins and
 *     minerals are FLOORS (`floor: true`) and are never judged as "too low".
 *
 * Reference values are named with their source and are adult-male UK figures:
 * food-label Reference Intakes (Regulation 1169/2011, used on UK packs), NHS
 * guidance for salt, saturated fat, fibre and caffeine, and the UK Reference
 * Nutrient Intakes (COMA 1991) for vitamins and minerals. None is a diagnosis.
 * ⚠ Pull-only. Nothing here notifies.
 */

const FULL_DAY_KCAL = 1200;
const SODIUM_TO_SALT = 2.5;

const RI = 'UK food-label Reference Intake';
const NHS = 'NHS guidance';
const RNI = 'UK Reference Nutrient Intake (adult men)';

// unit: how it is DISPLAYED. scale: stored value × scale = displayed value.
// kind: 'max' (more is the concern), 'target' (less is the concern), 'ri'
// (a reference to compare with, not judged), null (no reference).
const NUTRIENTS = [
  { metric: 'dietary_energy_consumed', label: 'Energy', group: 'energy', unit: 'kcal', scale: 1, ref: null },
  { metric: 'dietary_protein', label: 'Protein', group: 'macros', unit: 'g', scale: 1, ref: { value: 50, kind: 'ri', source: RI } },
  { metric: 'dietary_carbohydrates', label: 'Carbohydrate', group: 'macros', unit: 'g', scale: 1, ref: { value: 260, kind: 'ri', source: RI } },
  { metric: 'dietary_sugar', label: 'Sugars', group: 'macros', unit: 'g', scale: 1, ref: { value: 90, kind: 'max', source: RI } },
  { metric: 'dietary_fiber', label: 'Fibre', group: 'macros', unit: 'g', scale: 1, ref: { value: 30, kind: 'target', source: NHS } },
  { metric: 'dietary_fat_total', label: 'Fat', group: 'fats', unit: 'g', scale: 1, ref: { value: 70, kind: 'max', source: RI } },
  { metric: 'dietary_fat_saturated', label: 'Saturated fat', group: 'fats', unit: 'g', scale: 1, ref: { value: 30, kind: 'max', source: NHS } },
  { metric: 'dietary_fat_monounsaturated', label: 'Monounsaturated fat', group: 'fats', unit: 'g', scale: 1, ref: null },
  { metric: 'dietary_fat_polyunsaturated', label: 'Polyunsaturated fat', group: 'fats', unit: 'g', scale: 1, ref: null },
  { metric: 'dietary_cholesterol', label: 'Cholesterol', group: 'fats', unit: 'mg', scale: 1000, ref: null },
  { metric: 'dietary_sodium', label: 'Salt', group: 'salt', unit: 'g', scale: SODIUM_TO_SALT, ref: { value: 6, kind: 'max', source: NHS }, note: 'salt = sodium × 2.5' },
  { metric: 'dietary_potassium', label: 'Potassium', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 3500, kind: 'target', source: RNI } },
  { metric: 'dietary_calcium', label: 'Calcium', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 700, kind: 'target', source: RNI } },
  { metric: 'dietary_iron', label: 'Iron', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 8.7, kind: 'target', source: RNI } },
  { metric: 'dietary_magnesium', label: 'Magnesium', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 300, kind: 'target', source: RNI } },
  { metric: 'dietary_zinc', label: 'Zinc', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 9.5, kind: 'target', source: RNI } },
  { metric: 'dietary_phosphorus', label: 'Phosphorus', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 550, kind: 'target', source: RNI } },
  { metric: 'dietary_iodine', label: 'Iodine', group: 'minerals', unit: 'mcg', scale: 1e6, floor: true, ref: { value: 140, kind: 'target', source: RNI } },
  { metric: 'dietary_selenium', label: 'Selenium', group: 'minerals', unit: 'mcg', scale: 1e6, floor: true, ref: { value: 75, kind: 'target', source: RNI } },
  { metric: 'dietary_copper', label: 'Copper', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: { value: 1.2, kind: 'target', source: RNI } },
  { metric: 'dietary_manganese', label: 'Manganese', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: null },
  { metric: 'dietary_chloride', label: 'Chloride', group: 'minerals', unit: 'mg', scale: 1000, floor: true, ref: null },
  { metric: 'dietary_chromium', label: 'Chromium', group: 'minerals', unit: 'mcg', scale: 1e6, floor: true, ref: null },
  { metric: 'dietary_molybdenum', label: 'Molybdenum', group: 'minerals', unit: 'mcg', scale: 1e6, floor: true, ref: null },
  { metric: 'dietary_vitamin_a', label: 'Vitamin A', group: 'vitamins', unit: 'mcg', scale: 1e6, floor: true, ref: { value: 700, kind: 'target', source: RNI } },
  { metric: 'dietary_vitamin_c', label: 'Vitamin C', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: { value: 40, kind: 'target', source: RNI } },
  { metric: 'dietary_vitamin_d', label: 'Vitamin D', group: 'vitamins', unit: 'mcg', scale: 1e6, floor: true, ref: { value: 10, kind: 'target', source: RNI } },
  { metric: 'dietary_vitamin_e', label: 'Vitamin E', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: null },
  { metric: 'dietary_vitamin_k', label: 'Vitamin K', group: 'vitamins', unit: 'mcg', scale: 1e6, floor: true, ref: null },
  { metric: 'dietary_vitamin_b6', label: 'Vitamin B6', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: { value: 1.4, kind: 'target', source: RNI } },
  { metric: 'dietary_vitamin_b12', label: 'Vitamin B12', group: 'vitamins', unit: 'mcg', scale: 1e6, floor: true, ref: { value: 1.5, kind: 'target', source: RNI } },
  { metric: 'dietary_folate', label: 'Folate', group: 'vitamins', unit: 'mcg', scale: 1e6, floor: true, ref: { value: 200, kind: 'target', source: RNI } },
  { metric: 'dietary_thiamin', label: 'Thiamin (B1)', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: { value: 1.0, kind: 'target', source: RNI } },
  { metric: 'dietary_riboflavin', label: 'Riboflavin (B2)', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: { value: 1.3, kind: 'target', source: RNI } },
  { metric: 'dietary_niacin', label: 'Niacin (B3)', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: { value: 17, kind: 'target', source: RNI } },
  { metric: 'dietary_pantothenic_acid', label: 'Pantothenic acid (B5)', group: 'vitamins', unit: 'mg', scale: 1000, floor: true, ref: null },
  { metric: 'dietary_biotin', label: 'Biotin', group: 'vitamins', unit: 'mcg', scale: 1e6, floor: true, ref: null },
  { metric: 'dietary_caffeine', label: 'Caffeine', group: 'other', unit: 'mg', scale: 1000, ref: { value: 400, kind: 'max', source: NHS } },
  { metric: 'dietary_water', label: 'Water', group: 'other', unit: 'L', scale: 1, ref: null },
];

const GROUPS = ['energy', 'macros', 'fats', 'salt', 'minerals', 'vitamins', 'other'];
const ENERGY = 'dietary_energy_consumed';

function round(n, dp = 1) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function dpFor(unit, v) {
  if (unit === 'kcal') return 0;
  if (unit === 'L') return 2;
  return Math.abs(v) >= 100 ? 0 : 1;
}

function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const TZ = () => process.env.NEURO_TIMEZONE || 'Europe/London';

/** Local wall-clock day of a stored UTC 'YYYY-MM-DD HH:MM:SS'. */
function localDay(recordedAt, tz = TZ()) {
  const ms = Date.parse(`${String(recordedAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
}

/**
 * PURE. samples: [{ metric, value, recorded_at }] (UTC). today: local key.
 * windowDays counts back from YESTERDAY: today is still being eaten, so it is
 * shown but never averaged.
 */
function compose({ samples = [], today, windowDays = 14, tz } = {}) {
  const byDay = new Map();
  for (const s of samples) {
    const def = NUTRIENTS.find((n) => n.metric === s.metric);
    if (!def || !Number.isFinite(Number(s.value))) continue;
    const day = localDay(s.recorded_at, tz);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, {});
    const t = byDay.get(day);
    t[s.metric] = (t[s.metric] || 0) + Number(s.value);
  }

  const firstDay = shiftDay(today, -windowDays);
  const days = [];
  for (let k = today; k >= firstDay; k = shiftDay(k, -1)) {
    const raw = byDay.get(k);
    const kcal = raw && Number.isFinite(raw[ENERGY]) ? raw[ENERGY] : null;
    const logged = kcal != null;
    const totals = {};
    if (raw) {
      for (const n of NUTRIENTS) {
        if (Number.isFinite(raw[n.metric])) totals[n.metric] = round(raw[n.metric] * n.scale, dpFor(n.unit, raw[n.metric] * n.scale));
      }
    }
    days.push({
      day: k,
      today: k === today,
      logged,
      full: logged && kcal >= FULL_DAY_KCAL,
      kcal: logged ? round(kcal, 0) : null,
      totals: logged ? totals : {},
    });
  }

  const counted = days.filter((d) => !d.today && d.full);
  const partial = days.filter((d) => !d.today && d.logged && !d.full);
  const lastLogged = [...byDay.keys()].sort().pop() || null;

  const nutrients = NUTRIENTS.map((n) => {
    const vals = counted.map((d) => d.totals[n.metric]).filter(Number.isFinite);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const pct = avg != null && n.ref ? round((avg / n.ref.value) * 100, 0) : null;
    let state = 'unknown';
    if (avg != null && n.ref) {
      if (n.ref.kind === 'max') state = avg > n.ref.value ? 'over' : 'ok';
      else if (n.ref.kind === 'target') state = n.floor ? 'floor' : avg < n.ref.value ? 'under' : 'ok';
      else state = 'ref';
    } else if (avg != null) state = 'noref';
    return {
      metric: n.metric, label: n.label, group: n.group, unit: n.unit, note: n.note || null,
      floor: !!n.floor, ref: n.ref,
      avg: avg == null ? null : round(avg, dpFor(n.unit, avg)),
      pctOfRef: pct, daysWithData: vals.length, state,
    };
  });

  return {
    contract: 'nutrition-v1',
    today,
    windowDays,
    fullDayKcal: FULL_DAY_KCAL,
    known: true,
    summary: {
      fullDays: counted.length,
      partialDays: partial.length,
      unloggedDays: days.filter((d) => !d.today && !d.logged).length,
      lastLoggedDay: lastLogged,
      todayKcal: days[0]?.kcal ?? null,
    },
    days,
    nutrients,
    groups: GROUPS,
    note: `Averages use only days with at least ${FULL_DAY_KCAL} kcal logged, and never today. MyFitnessPal records 0 for nutrients a food's entry lacks, so vitamin and mineral figures are a floor, not a measurement. Reference values are UK adult-male figures and are not a diagnosis.`,
  };
}

function localDayKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ() }).format(now);
}

/** Gather from health_samples. Throws if the store cannot be read. */
function read({ now = new Date(), days = 14 } = {}) {
  const db = require('../db/database');
  // Read a day wider than the window either side: a stored UTC instant can sit
  // on the neighbouring local day.
  const since = new Date(now.getTime() - (days + 2) * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const samples = [];
  for (const n of NUTRIENTS) {
    for (const r of db.getHealthSamplesBetween(n.metric, since, null, 20000)) {
      samples.push({ metric: n.metric, value: r.value, recorded_at: r.recorded_at });
    }
  }
  return compose({ samples, today: localDayKey(now), windowDays: days });
}

module.exports = { compose, read, localDay, NUTRIENTS, FULL_DAY_KCAL, SODIUM_TO_SALT };
