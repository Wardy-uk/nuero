'use strict';

/**
 * performance-insights — three reads over data NEURO already holds, each of which
 * earns a claim only by MEASUREMENT.
 *
 *   • sleepEnvironment — the logger's room overnight against the night's sleep.
 *   • cardioFitness    — VO2 max and walking heart rate, as a trend.
 *   • heatCost         — heart rate per unit of walking speed, against the heat,
 *                        across hikes the logger was carried on.
 *
 * ⚠ THE RULE THIS FILE IS BUILT ON: a relationship is reported as a finding only
 * when a permutation test says it is unlikely to be chance (p < 0.05) on at least
 * MIN_NIGHTS / MIN_HIKES observations. Otherwise the answer is "no clear link",
 * with the numbers — which is a result, not a failure. NEURO has shipped this
 * lesson once already: "low readiness means less gets done" measured p = 0.97.
 *
 * ⚠ THE LOGGER'S ROOM IS NOT KNOWN TO BE THE BEDROOM. It is "in the house". Every
 * sleep sentence says "the logger's room" until Nick says where it lives.
 *
 * Everything that decides is PURE; the loaders at the bottom read the database.
 */

const MIN_NIGHTS = 20;
const MIN_HIKES = 6;
const PERMUTATIONS = 2000;
const TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';

const round = (n, dp = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A seeded generator, so the same data always gives the same p-value. */
function rng(seed = 42) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** Pearson r. PURE. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * Two-sided permutation test on Pearson r. PURE and deterministic (seeded).
 * Chosen over a t-table because the sample is small and nothing here is
 * guaranteed normal — a night's sleep is bounded and skewed.
 */
function permutationTest(xs, ys, { permutations = PERMUTATIONS, seed = 42 } = {}) {
  const r = pearson(xs, ys);
  if (r == null) return { r: null, p: null };
  const rand = rng(seed);
  const shuffled = [...ys];
  let extreme = 0;
  for (let k = 0; k < permutations; k++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const rp = pearson(xs, shuffled);
    if (rp != null && Math.abs(rp) >= Math.abs(r)) extreme++;
  }
  return { r: round(r, 2), p: round((extreme + 1) / (permutations + 1), 3) };
}

/** Local hour and date of a unix-seconds instant. */
function localParts(unixSeconds, timeZone = TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unixSeconds * 1000));
  const g = (t) => p.find((x) => x.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The room overnight for each wake date: readings from 23:00 the evening before
 * to 07:00 that morning, LOCAL. PURE. A night with fewer than 4 readings (an hour
 * at the factory 15-minute interval) is left out rather than guessed.
 */
function overnightRoom(readings) {
  const nights = new Map();
  for (const r of readings || []) {
    const { day, hour } = localParts(r.t);
    const wake = hour >= 23 ? addDays(day, 1) : hour < 7 ? day : null;
    if (!wake) continue;
    if (!nights.has(wake)) nights.set(wake, []);
    nights.get(wake).push(r);
  }
  const out = new Map();
  for (const [wake, rs] of nights) {
    if (rs.length < 4) continue;
    out.set(wake, {
      tempC: round(mean(rs.map((r) => r.temperature_c ?? r.tempC)), 2),
      humidityPct: round(mean(rs.map((r) => r.humidity_pct ?? r.humidityPct).filter(Number.isFinite)), 1),
      readings: rs.length,
    });
  }
  return out;
}

const SLEEP_OUTCOMES = [
  { key: 'asleepHours', label: 'time asleep', unit: 'h', dp: 2 },
  { key: 'awakeHours', label: 'time awake in the night', unit: 'h', dp: 2 },
  { key: 'deepHours', label: 'deep sleep', unit: 'h', dp: 2 },
  { key: 'hrvMedian', label: 'HRV', unit: 'ms', dp: 1 },
];

/**
 * Does the logger's room overnight relate to how he slept? PURE.
 *
 * `days` are health_daily rows (keyed by WAKE date, which is the rule
 * apple-health owns), `room` is overnightRoom's map. For each outcome with
 * MIN_NIGHTS paired nights: r, p, and the difference between the warmest and
 * coolest thirds, in the outcome's own units — so a finding reads as "20 minutes
 * less sleep", not as a correlation coefficient.
 */
function sleepEnvironment(days, room) {
  const results = [];
  for (const o of SLEEP_OUTCOMES) {
    const pairs = (days || [])
      .filter((d) => d.complete !== false && Number.isFinite(d[o.key]) && room.has(d.day))
      .map((d) => ({ x: room.get(d.day).tempC, y: d[o.key] }))
      .filter((p) => Number.isFinite(p.x));
    if (pairs.length < MIN_NIGHTS) {
      results.push({ outcome: o.key, label: o.label, known: false, nights: pairs.length, why: `only ${pairs.length} night(s) with both — need ${MIN_NIGHTS}` });
      continue;
    }
    const { r, p } = permutationTest(pairs.map((q) => q.x), pairs.map((q) => q.y));
    const sorted = [...pairs].sort((a, b) => a.x - b.x);
    const third = Math.floor(sorted.length / 3);
    const cool = sorted.slice(0, third); const warm = sorted.slice(-third);
    results.push({
      outcome: o.key,
      label: o.label,
      known: true,
      nights: pairs.length,
      r, p,
      significant: p != null && p < 0.05,
      coolRoomC: round(median(cool.map((q) => q.x)), 1),
      warmRoomC: round(median(warm.map((q) => q.x)), 1),
      coolValue: round(median(cool.map((q) => q.y)), o.dp),
      warmValue: round(median(warm.map((q) => q.y)), o.dp),
      unit: o.unit,
    });
  }
  // ⚠ SEVERAL OUTCOMES ARE TESTED, SO ONE WILL CLEAR p < 0.05 BY CHANCE about one
  // run in five. Bonferroni over the outcomes actually tested: the first real run
  // "found" +8 min of sleep at p = 0.025 across four tests, which is noise.
  const tested = results.filter((x) => x.known).length;
  const threshold = tested ? 0.05 / tested : 0.05;
  for (const x of results) if (x.known) x.significant = x.p != null && x.p < threshold;
  const found = results.filter((x) => x.significant);
  return {
    results,
    threshold: round(threshold, 4),
    findings: found,
    sentence: found.length
      ? found.map(describeSleepFinding).join(' ')
      : results.some((x) => x.known)
        ? `No clear link between the logger's room overnight and your sleep across ${Math.max(...results.map((x) => x.nights))} nights.`
        : 'Not enough nights with both sleep and room readings yet.',
    caveat: 'The logger is somewhere in the house — not known to be the bedroom — and a correlation is not a cause.',
  };
}

function describeSleepFinding(f) {
  const diff = f.warmValue - f.coolValue;
  const amount = f.unit === 'h' ? `${Math.round(Math.abs(diff) * 60)} min` : `${round(Math.abs(diff), 1)} ${f.unit}`;
  return `On nights the logger's room was warmer (around ${f.warmRoomC}°C against ${f.coolRoomC}°C) your ${f.label} ran ${amount} ${diff < 0 ? 'lower' : 'higher'} (${f.nights} nights, p = ${f.p}).`;
}

/**
 * VO2 max and walking heart rate as weekly medians, with the change over 90 days
 * and a year. PURE. A change is reported, never judged — a falling walking heart
 * rate is fitter, a falling VO2 max is not, and the sentence says which way each
 * moved in plain words rather than with a colour.
 */
function cardioFitness(vo2, walkingHr) {
  const weekly = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      const d = new Date(String(r.recorded_at).replace(' ', 'T') + 'Z');
      if (Number.isNaN(d.getTime())) continue;
      const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const k = monday.toISOString().slice(0, 10);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(Number(r.value));
    }
    return [...m.entries()].sort().map(([week, vs]) => ({ week, value: round(median(vs), 1) }));
  };
  const change = (series, weeks) => {
    if (series.length < 2) return null;
    const last = series[series.length - 1];
    const cutoff = new Date(`${last.week}T00:00:00Z`); cutoff.setUTCDate(cutoff.getUTCDate() - weeks * 7);
    const then = [...series].reverse().find((s) => new Date(`${s.week}T00:00:00Z`) <= cutoff);
    return then ? round(last.value - then.value, 1) : null;
  };
  const v = weekly(vo2); const w = weekly(walkingHr);
  return {
    vo2max: { series: v, latest: v.length ? v[v.length - 1] : null, change90d: change(v, 13), change1y: change(v, 52), unit: 'ml/kg/min' },
    walkingHr: { series: w, latest: w.length ? w[w.length - 1] : null, change90d: change(w, 13), change1y: change(w, 52), unit: 'bpm' },
    note: 'Apple’s VO2 max is an estimate from outdoor walks with GPS; a lower walking heart rate at the same effort is the fitter direction.',
  };
}

/**
 * Heat cost across hikes. PURE.
 *
 * For each carried hike: (median heart rate − resting) / median walking speed —
 * heart beats above rest spent per km/h. Across hikes, that against the walk's
 * mean temperature and dew point. Reported as a finding only at p < 0.05 on
 * MIN_HIKES or more; until then, the per-hike figures and "not enough hikes".
 */
function heatCost(hikes) {
  const usable = (hikes || []).filter((h) => Number.isFinite(h.effort) && Number.isFinite(h.tempC));
  const out = {
    hikes: usable.map((h) => ({ startedAt: h.startedAt, effort: round(h.effort, 2), tempC: h.tempC, dewPointC: h.dewPointC })),
    known: usable.length >= MIN_HIKES,
  };
  if (!out.known) return { ...out, why: `only ${usable.length} carried hike(s) with heart rate and walking speed — need ${MIN_HIKES}` };
  const t = permutationTest(usable.map((h) => h.tempC), usable.map((h) => h.effort));
  const dp = usable.every((h) => Number.isFinite(h.dewPointC))
    ? permutationTest(usable.map((h) => h.dewPointC), usable.map((h) => h.effort)) : { r: null, p: null };
  return { ...out, temperature: t, dewPoint: dp, significant: (t.p != null && t.p < 0.05) || (dp.p != null && dp.p < 0.05) };
}

// ── Loaders ──────────────────────────────────────────────────────────────────

const LOCATION_KEY = 'logger_location';

/** Where the logger lives, as Nick said, and since when. */
function loggerLocation() {
  const db = require('../db/database');
  try { return JSON.parse(db.getState(LOCATION_KEY) || 'null'); } catch { return null; }
}

/**
 * Record where the logger is. `since` is a YYYY-MM-DD; only nights from then
 * count, because readings from before it describe somewhere else.
 */
function setLoggerLocation({ label, since }) {
  const db = require('../db/database');
  if (typeof label !== 'string' || !label.trim() || label.length > 60) return { ok: false, reason: 'label is required' };
  if (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
    return { ok: false, reason: 'since must be YYYY-MM-DD' };
  }
  const value = { label: label.trim(), since };
  db.setState(LOCATION_KEY, JSON.stringify(value));
  return { ok: true, location: value };
}

/**
 * ⚠ REFUSES WITHOUT A LOCATION. The first three months of readings run from
 * −4.8 °C to 25.8 °C — a freezer, a cool room, brief trips somewhere at 5 °C —
 * so correlating them with sleep measures where the logger happened to be, not
 * the room he slept in. Until Nick says where it lives and since when, the
 * honest answer is "tell me", not a finding.
 */
function loadSleepEnvironment({ days = 200 } = {}) {
  const hd = require('./health-daily');
  const env = require('./environment');
  const location = loggerLocation();
  if (!location) {
    return { known: false, needsLocation: true, why: 'NEURO does not know where the logger lives — its readings so far range from a freezer to a warm room, so they cannot describe where you slept' };
  }
  const rows = hd.recentDays(days, { completeOnly: true }).filter((d) => d.day > location.since);
  if (!rows.length) return { known: false, location, why: `no finished nights since the logger went in the ${location.label}` };
  const since = Math.floor(Date.parse(`${addDays(location.since, 0)}T12:00:00Z`) / 1000);
  const readings = env.readingsBetween(since, Math.floor(Date.now() / 1000), 200000);
  const result = sleepEnvironment(rows, overnightRoom(readings));
  return {
    known: true,
    location,
    ...result,
    sentence: result.sentence.replace(/the logger's room/g, `the ${location.label}`),
    caveat: `Nights since ${location.since}, with the logger in the ${location.label}. A correlation is not a cause.`,
  };
}

/**
 * The sleep read for polled surfaces (SAiM's ambient pass runs every few minutes)
 * — recomputed at most hourly. A finding is about months of nights; it does not
 * change between two polls.
 */
let sleepCache = { at: 0, value: null };
function cachedSleepEnvironment(now = Date.now()) {
  if (sleepCache.value && now - sleepCache.at < 3600000) return sleepCache.value;
  sleepCache = { at: now, value: loadSleepEnvironment() };
  return sleepCache.value;
}

function loadCardioFitness() {
  const db = require('../db/database');
  const since = new Date(Date.now() - 2 * 365 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  return cardioFitness(
    db.getHealthSamplesBetween('vo2_max', since, null, 5000),
    db.getHealthSamplesBetween('walking_heart_rate_average', since, null, 5000)
  );
}

function loadHeatCost() {
  const db = require('../db/database');
  const env = require('./environment');
  const { hikes } = env.hikes({ days: 365 });
  const rest = require('./exertion').recent(1)[0]?.restHr ?? null;
  const rows = [];
  for (const h of hikes) {
    if (h.carried !== 'likely' || !h.window || !h.conditions) continue;
    const toSql = (s) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const hr = median(db.getHealthSamplesBetween('heartRate', toSql(h.window.start), toSql(h.window.end), 20000).map((r) => r.value));
    const speed = median(db.getHealthSamplesBetween('walking_speed', toSql(h.window.start), toSql(h.window.end), 20000).map((r) => r.value));
    if (!Number.isFinite(hr) || !Number.isFinite(speed) || !(speed > 0) || !Number.isFinite(rest)) continue;
    rows.push({ startedAt: h.startedAt, effort: (hr - rest) / speed, tempC: h.conditions.tempMeanC, dewPointC: h.conditions.dewPointMeanC });
  }
  return heatCost(rows);
}

module.exports = {
  MIN_NIGHTS,
  MIN_HIKES,
  pearson,
  permutationTest,
  overnightRoom,
  sleepEnvironment,
  cardioFitness,
  heatCost,
  loggerLocation,
  setLoggerLocation,
  loadSleepEnvironment,
  cachedSleepEnvironment,
  loadCardioFitness,
  loadHeatCost,
};
