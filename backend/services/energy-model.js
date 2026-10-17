'use strict';

/**
 * energy-model — the PURE half of home energy. No DB, no network, no clock
 * (`now` is passed). Everything here is a judgement over plain data, so it pins
 * without a database (the pi-health.assess() split).
 *
 * Time: storage is UTC (half-hour slot STARTS, epoch seconds). Reporting is the
 * Europe/London day — which is 46 half-hours on the spring clock change, 50 on
 * the autumn one, 48 otherwise. A day is COMPLETE only when every one of its
 * slots holds a reading; a slot Bright has no data for is missing, never zero.
 */

const TZ = 'Europe/London';
const SLOT_S = 1800;
const HDD_BASE_C = 15.5;          // the UK convention for heating degree days
const GAS_M3_CORRECTION = 1.02264; // volume correction factor used on UK gas bills

const _fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function _parts(ms) {
  const o = {};
  for (const p of _fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** The Europe/London date of an instant, 'YYYY-MM-DD'. */
function londonDay(ms) {
  const p = _parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Local hour (0-23) of an instant in Europe/London. */
function londonHour(ms) { return Number(_parts(ms).hour); }

/** Offset of London from UTC at an instant, in ms (0 or 3,600,000). */
function _offsetMs(ms) {
  const p = _parts(ms);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return wall - Math.floor(ms / 60000) * 60000;
}

/** UTC ms of 00:00 Europe/London on `day`. */
function londonMidnightMs(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - _offsetMs(guess);
  t = guess - _offsetMs(t);
  return t;
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Half-hour slot starts (epoch s) belonging to a London day. 46/48/50. */
function slotsOfDay(day) {
  const a = londonMidnightMs(day) / 1000;
  const b = londonMidnightMs(addDays(day, 1)) / 1000;
  const out = [];
  for (let t = a; t < b; t += SLOT_S) out.push(t);
  return out;
}

function dayRange(fromDay, toDay) {
  const out = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── Units ────────────────────────────────────────────────────────────────────

/**
 * A reading's energy in kWh, with how it was arrived at. NEVER a fixed guess:
 * gas in cubic metres needs a calorific value, and without one this is null
 * with the reason, not a plausible number.
 */
function toKwh(value, unit, opts = {}) {
  if (value == null || !Number.isFinite(value)) return { kwh: null, basis: 'no-reading' };
  const u = String(unit || '').trim().toLowerCase().replace('³', '3');
  if (u === 'kwh') return { kwh: value, basis: 'kWh as reported' };
  if (u === 'wh') return { kwh: value / 1000, basis: 'Wh ÷ 1000' };
  if (u === 'm3' || u === 'm^3' || u === 'cubic metres') {
    const cv = Number(opts.gasCalorificValue);
    if (!Number.isFinite(cv) || cv < 30 || cv > 45) return { kwh: null, basis: 'cubic metres — needs a calorific value from your gas bill' };
    return { kwh: (value * GAS_M3_CORRECTION * cv) / 3.6, basis: `m³ × ${GAS_M3_CORRECTION} × CV ${cv} ÷ 3.6` };
  }
  return { kwh: null, basis: `unit "${unit}" not understood` };
}

// ── Tariffs ──────────────────────────────────────────────────────────────────

const _num = (v) => { const n = typeof v === 'string' ? Number(v.trim()) : v; return Number.isFinite(n) ? n : null; };

/**
 * One entry of Bright's tariff-list → a tariff row. A plan with tiers, a
 * time-of-use rate or a dynamic code is NOT flat and is kept but never used for
 * costing (one rate per kWh would misstate it).
 */
function parseBrightTariff(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const when = String(entry.effectiveDate || entry.from || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return null;
  let rate = null; let standing = null; let flat = true;
  for (const plan of Array.isArray(entry.plan) ? entry.plan : []) {
    for (const d of Array.isArray(plan && plan.planDetail) ? plan.planDetail : []) {
      if (!d || typeof d !== 'object') continue;
      if ('dynamic' in d || 'tourate' in d || (d.tier != null && Number(d.tier) > 1)) flat = false;
      if (d.rate != null && rate == null) rate = _num(d.rate);
      if (d.standing != null && standing == null) standing = _num(d.standing);
    }
  }
  return {
    providerId: String(entry.id || `${when}:${entry.name || entry.displayName || ''}`),
    effectiveFrom: when,
    unitRateP: rate,
    standingPDay: standing,
    flat,
    label: entry.displayName || entry.name || null,
  };
}

/** Validate a tariff Nick types. Refused, never clamped. */
function validateManualTariff(t) {
  if (!t || typeof t !== 'object') return { ok: false, reason: 'tariff must be an object' };
  if (!['electricity', 'gas'].includes(t.fuel)) return { ok: false, reason: 'fuel must be electricity or gas' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.effectiveFrom || '')) || Number.isNaN(Date.parse(`${t.effectiveFrom}T00:00:00Z`))) {
    return { ok: false, reason: 'effectiveFrom must be YYYY-MM-DD' };
  }
  const rate = _num(t.unitRateP);
  const standing = _num(t.standingPDay);
  if (rate == null || rate < 0 || rate > 200) return { ok: false, reason: 'unit rate must be pence per kWh, 0–200' };
  if (standing == null || standing < 0 || standing > 500) return { ok: false, reason: 'standing charge must be pence per day, 0–500' };
  return { ok: true, tariff: { fuel: t.fuel, effectiveFrom: t.effectiveFrom, unitRateP: rate, standingPDay: standing, label: t.label ? String(t.label).slice(0, 80) : null } };
}

/**
 * The tariff in force on a London day: the latest effective_from on or before
 * it. On the same date a MANUAL tariff beats the meter's (Nick correcting it).
 */
function tariffOn(tariffs, fuel, day) {
  let best = null;
  for (const t of tariffs || []) {
    if (t.fuel !== fuel || t.removedAt || t.effectiveFrom > day) continue;
    if (!best || t.effectiveFrom > best.effectiveFrom
      || (t.effectiveFrom === best.effectiveFrom && t.source === 'manual' && best.source !== 'manual')) best = t;
  }
  return best;
}

/** Estimated cost of one day's energy. Pence. Null WITH a reason, never 0. */
function costOfDay(kwh, tariff) {
  if (!tariff) return { pence: null, unitsP: null, standingP: null, why: 'no tariff for this date' };
  if (!tariff.flat) return { pence: null, unitsP: null, standingP: null, why: 'time-of-use or dynamic tariff — not costed yet' };
  const unitsP = kwh == null || tariff.unitRateP == null ? null : kwh * tariff.unitRateP;
  const standingP = tariff.standingPDay;
  const pence = unitsP == null || standingP == null ? null : unitsP + standingP;
  const why = unitsP == null ? (kwh == null ? 'no usage for this date' : 'tariff has no unit rate')
    : standingP == null ? 'tariff has no standing charge' : null;
  return { pence, unitsP, standingP, why, tariffSource: tariff.source, tariffFrom: tariff.effectiveFrom };
}

// ── Rollups ──────────────────────────────────────────────────────────────────

/**
 * Half-hour rows → one row per London day.
 *   slots: Map<startTs, kwh|null>  (summed across resources by the caller)
 * `complete` means every slot of that day held a reading.
 */
function rollupDays(slots, fromDay, toDay) {
  const out = [];
  for (const day of dayRange(fromDay, toDay)) {
    const ts = slotsOfDay(day);
    let kwh = 0; let present = 0;
    for (const t of ts) {
      const v = slots.get(t);
      if (v != null && Number.isFinite(v)) { kwh += v; present += 1; }
    }
    out.push({ day, kwh: present ? round(kwh, 3) : null, present, expected: ts.length, complete: present === ts.length });
  }
  return out;
}

function round(v, dp = 2) { if (v == null || !Number.isFinite(v)) return null; const f = 10 ** dp; return Math.round(v * f) / f; }

function sum(rows, key) {
  let s = 0; let n = 0;
  for (const r of rows) if (r[key] != null && Number.isFinite(r[key])) { s += r[key]; n += 1; }
  return n ? s : null;
}

function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mad(xs) {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.filter(Number.isFinite).map((x) => Math.abs(x - m)));
}

// ── Weather ──────────────────────────────────────────────────────────────────

function hdd(tMean, base = HDD_BASE_C) {
  return tMean == null || !Number.isFinite(tMean) ? null : Math.max(0, base - tMean);
}

/**
 * Least squares fit of daily gas kWh on heating degree days, over COMPLETE days
 * that have a temperature. Returns null below `minDays`. A fit is a description
 * of the relationship in this house's history, not a cause.
 */
function fitGasWeather(days, { minDays = 28 } = {}) {
  const pts = days.filter((d) => d.complete && d.kwh != null && d.hdd != null);
  if (pts.length < minDays) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.hdd, 0) / n;
  const my = pts.reduce((s, p) => s + p.kwh, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const p of pts) { sxy += (p.hdd - mx) * (p.kwh - my); sxx += (p.hdd - mx) ** 2; syy += (p.kwh - my) ** 2; }
  if (sxx <= 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (const p of pts) sse += (p.kwh - (a + b * p.hdd)) ** 2;
  const r2 = syy > 0 ? 1 - sse / syy : 0;
  const residualSd = Math.sqrt(sse / Math.max(1, n - 2));
  return { baseKwhPerDay: round(a, 2), kwhPerDegreeDay: round(b, 3), r2: round(r2, 3), residualSd: round(residualSd, 2), n, from: pts[0].day, to: pts[n - 1].day };
}

function expectedGas(fit, hddValue) {
  if (!fit || hddValue == null) return null;
  return Math.max(0, fit.baseKwhPerDay + fit.kwhPerDegreeDay * hddValue);
}

// ── Unusual days (the push rule) ─────────────────────────────────────────────

/**
 * Is a COMPLETE gas day clearly above what its weather explains?
 * Needs a fit on ≥28 days with r² ≥ 0.5 — a weak relationship explains nothing,
 * so it judges nothing. "Clearly" = above expected by the larger of 3 residual
 * SDs, 25 % of expected, and 5 kWh.
 */
function judgeGasDay(day, fit) {
  if (!day || !day.complete || day.kwh == null) return { unusual: false, why: 'day not complete' };
  if (!fit || fit.n < 28) return { unusual: false, why: 'not enough history for a weather baseline yet' };
  if (fit.r2 < 0.5) return { unusual: false, why: 'gas does not follow the weather closely enough here to judge' };
  if (day.hdd == null) return { unusual: false, why: 'no outdoor temperature for that day' };
  const expected = expectedGas(fit, day.hdd);
  const threshold = Math.max(3 * fit.residualSd, 0.25 * expected, 5);
  const excess = day.kwh - expected;
  return {
    unusual: excess > threshold,
    expected: round(expected, 1), actual: round(day.kwh, 1), excess: round(excess, 1), threshold: round(threshold, 1),
    pctAbove: expected > 0 ? Math.round((excess / expected) * 100) : null,
  };
}

/**
 * Is a COMPLETE electricity day clearly above its own recent normal? Compared
 * with the median of the previous 28 complete days (robust to one odd day):
 * above by the larger of 4 robust SDs and half the median.
 */
function judgeElectricityDay(day, priorDays) {
  if (!day || !day.complete || day.kwh == null) return { unusual: false, why: 'day not complete' };
  const hist = priorDays.filter((d) => d.complete && d.kwh != null && d.day < day.day).slice(-28).map((d) => d.kwh);
  if (hist.length < 28) return { unusual: false, why: 'not enough history yet' };
  const med = median(hist);
  const sd = 1.4826 * mad(hist);
  const threshold = Math.max(4 * sd, 0.5 * med);
  const excess = day.kwh - med;
  return {
    unusual: excess > threshold,
    expected: round(med, 1), actual: round(day.kwh, 1), excess: round(excess, 1), threshold: round(threshold, 1),
    pctAbove: med > 0 ? Math.round((excess / med) * 100) : null,
  };
}

/**
 * The always-on electricity load for one day: the median of the four lowest
 * half-hours between 00:00 and 05:00 London, as kW. Null when fewer than four
 * of those slots have readings.
 */
function overnightBaseKw(slots, day) {
  const vals = [];
  for (const t of slotsOfDay(day)) {
    if (londonHour(t * 1000) >= 5) continue;
    const v = slots.get(t);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 4) return null;
  vals.sort((a, b) => a - b);
  return round(median(vals.slice(0, 4)) * 2, 3);
}

/** Sentence for a push — a fact and a comparison, never a diagnosis. */
function unusualSentence(fuel, day, j) {
  const what = fuel === 'gas' ? 'Gas' : 'Electricity';
  const vs = fuel === 'gas' ? 'what the weather explains' : 'your usual day';
  return `${what} on ${day}: ${j.actual} kWh — about ${j.pctAbove}% above ${vs} (~${j.expected} kWh).`;
}

module.exports = {
  TZ, SLOT_S, HDD_BASE_C, GAS_M3_CORRECTION,
  londonDay, londonHour, londonMidnightMs, addDays, slotsOfDay, dayRange,
  toKwh, parseBrightTariff, validateManualTariff, tariffOn, costOfDay,
  rollupDays, round, sum, median, mad,
  hdd, fitGasWeather, expectedGas, judgeGasDay, judgeElectricityDay, overnightBaseKw, unusualSentence,
};
