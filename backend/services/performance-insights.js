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

// ── Blood pressure against sleep and meeting load (7 Nov 2026) ───────────────
//
// The card answered "what is my BP" and never "what goes with a high day". Two
// drivers, each tested against BOTH halves of the reading, so four tests and a
// Bonferroni threshold (the sleep-environment lesson: one of four clears 0.05 by
// chance about one run in five).
//
//   • sleep — the night ending that morning (health_daily keys sleep by WAKE
//     date, so the same row holds the night before and that day's BP);
//   • meetings — hours in meetings with other people that day, WORKING DAYS
//     ONLY: a weekend has no meetings and may have lower BP for a dozen other
//     reasons, which would manufacture a "meetings raise your BP" finding.

const BP_MIN_DAYS = 20;
const BP_DRIVERS = [
  { key: 'sleep', label: 'sleep the night before', unit: 'h', dp: 1 },
  { key: 'meetings', label: 'time in meetings that day', unit: 'h', dp: 1 },
];
const BP_OUTCOMES = [
  { key: 'bpSystolic', label: 'systolic' },
  { key: 'bpDiastolic', label: 'diastolic' },
];

/**
 * Hours in meetings with other people per LOCAL day, from calendar_history rows.
 * PURE. A moved meeting keeps every slot it was ever at in history, so each
 * event counts once, at its NEWEST slot (latest first_seen). Solo blocks,
 * all-day entries, cancelled ones and anything whose attendees are unknown are
 * not meetings. Times are London wall clock as Graph gave them, sliced, never
 * re-zoned.
 */
function meetingHoursByDay(rows) {
  const newest = new Map();
  for (const r of rows || []) {
    if (!r || !r.event_id) continue;
    const held = newest.get(r.event_id);
    if (!held || String(r.first_seen) > String(held.first_seen)) newest.set(r.event_id, r);
  }
  const out = new Map();
  for (const r of newest.values()) {
    if (r.attendees_other !== 1 || r.is_all_day === 1) continue;
    if (/^\s*cancell?ed\s*:/i.test(r.subject || '')) continue;
    const s = Date.parse(`${String(r.start_time).slice(0, 19)}Z`);
    const e = Date.parse(`${String(r.end_time || '').slice(0, 19)}Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const day = String(r.start_time).slice(0, 10);
    out.set(day, (out.get(day) || 0) + Math.min(12, (e - s) / 3600000));
  }
  return out;
}

/**
 * PURE. `days` are health_daily rows (finished days); `meetings` maps a WORKING
 * day the calendar covered to its meeting hours (0 included — a day with none is
 * a measurement, not a gap).
 */
function bpContext(days, meetings = new Map()) {
  const results = [];
  for (const drv of BP_DRIVERS) {
    for (const o of BP_OUTCOMES) {
      const pairs = (days || [])
        .filter((d) => Number.isFinite(d[o.key]))
        .map((d) => ({ day: d.day, x: drv.key === 'sleep' ? d.asleepHours : meetings.get(d.day), y: d[o.key] }))
        .filter((p) => Number.isFinite(p.x) && !(drv.key === 'sleep' && p.x <= 0));
      const base = { driver: drv.key, driverLabel: drv.label, outcome: o.key, outcomeLabel: o.label, days: pairs.length };
      if (pairs.length < BP_MIN_DAYS) {
        results.push({ ...base, known: false, why: `only ${pairs.length} day(s) with both — need ${BP_MIN_DAYS}` });
        continue;
      }
      const { r, p } = permutationTest(pairs.map((q) => q.x), pairs.map((q) => q.y));
      const sorted = [...pairs].sort((a, b) => a.x - b.x);
      const third = Math.floor(sorted.length / 3);
      const lo = sorted.slice(0, third); const hi = sorted.slice(-third);
      results.push({
        ...base,
        known: true,
        r, p,
        lowDriver: round(median(lo.map((q) => q.x)), drv.dp),
        highDriver: round(median(hi.map((q) => q.x)), drv.dp),
        lowBp: round(median(lo.map((q) => q.y)), 0),
        highBp: round(median(hi.map((q) => q.y)), 0),
        unit: drv.unit,
      });
    }
  }
  const tested = results.filter((x) => x.known).length;
  const threshold = tested ? 0.05 / tested : 0.05;
  for (const x of results) if (x.known) x.significant = x.p != null && x.p < threshold;
  const found = results.filter((x) => x.significant);
  const sentence = found.length
    ? found.map(describeBpFinding).join(' ')
    : tested
      ? `No clear link between your blood pressure and ${results.filter((x) => x.known).map((x) => x.driverLabel).filter((v, i, a) => a.indexOf(v) === i).join(' or ')} across ${Math.max(...results.filter((x) => x.known).map((x) => x.days))} days.`
      : 'Not enough days with both a blood-pressure reading and sleep or meeting data yet.';
  return {
    results,
    threshold: round(threshold, 4),
    findings: found,
    sentence,
    caveat: 'Daily medians of the HiLo bracelet’s readings. Meetings are counted on working days only, from the diary NEURO has kept since late August; a working day with no meetings at all (usually leave) is left out. A correlation is not a cause — a busy day can also mean less walking, more caffeine or a worse night.',
  };
}

function describeBpFinding(f) {
  const diff = f.highBp - f.lowBp;
  const drv = f.driver === 'sleep'
    ? `after longer nights (around ${f.highDriver}h against ${f.lowDriver}h)`
    : `on days with more meetings (around ${f.highDriver}h against ${f.lowDriver}h)`;
  return `${f.outcomeLabel[0].toUpperCase()}${f.outcomeLabel.slice(1)} ran ${Math.abs(diff)} mmHg ${diff < 0 ? 'lower' : 'higher'} ${drv} (${f.days} days, p = ${f.p}).`;
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
 * The room overnight against sleep, from one of two sources.
 *
 *   • `radiator` (the default) — the bedroom radiator valve's hourly statistics,
 *     copied from Home Assistant. In the room he sleeps in, for months. It sits
 *     ON the radiator, so with the heating on it reads warm, and it has no
 *     humidity — both said in the caveat.
 *   • `logger` — the Blue Maestro, which measures the air (and humidity) but only
 *     counts from the date Nick says it went into a room: its first three months
 *     ran from a freezer to a warm room.
 *
 * ⚠ The logger path REFUSES WITHOUT A LOCATION rather than guessing.
 */
function loadSleepEnvironment({ days = 200, source = null } = {}) {
  const hd = require('./health-daily');
  const bedroom = require('./bedroom-climate');
  const cover = bedroom.coverage();
  const location = loggerLocation();
  const use = source || (cover.hours > 0 ? 'radiator' : 'logger');
  const sources = { radiator: { available: cover.hours > 0, ...cover }, logger: { available: Boolean(location), location } };

  if (use === 'radiator') {
    if (!cover.hours) return { known: false, source: use, sources, why: 'no bedroom temperature copied from Home Assistant yet' };
    const rows = hd.recentDays(days, { completeOnly: true });
    const since = Math.floor(Date.parse(cover.from) / 1000);
    const result = sleepEnvironment(rows, overnightRoom(bedroom.asReadings(bedroom.hoursSince(since))));
    return {
      known: true,
      source: use,
      sources,
      ...result,
      sentence: result.sentence.replace(/the logger's room/g, `the ${bedroom.LABEL}`),
      caveat: `From the ${bedroom.LABEL} radiator valve's hourly readings since ${cover.from.slice(0, 10)}. It sits on the radiator, so it reads warm while the heating is on, and it measures no humidity. A correlation is not a cause.`,
    };
  }

  if (!location) {
    return { known: false, source: use, sources, needsLocation: true, why: 'NEURO does not know where the logger lives — its readings so far range from a freezer to a warm room, so they cannot describe where you slept' };
  }
  const env = require('./environment');
  const rows = hd.recentDays(days, { completeOnly: true }).filter((d) => d.day > location.since);
  if (!rows.length) return { known: false, source: use, sources, location, why: `no finished nights since the logger went in the ${location.label}` };
  const since = Math.floor(Date.parse(`${location.since}T12:00:00Z`) / 1000);
  const readings = env.readingsBetween(since, Math.floor(Date.now() / 1000), 200000);
  const result = sleepEnvironment(rows, overnightRoom(readings));
  return {
    known: true,
    source: use,
    sources,
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

/**
 * BP against sleep and meetings over the last `days` finished days.
 * ⚠ A working day with NO meetings is left out of the meetings test: with a
 * daily standup, that is almost always leave, and leave is not "a light day".
 */
function loadBpContext({ days = 180 } = {}) {
  const db = require('../db/database');
  const wd = require('./working-days');
  const rows = require('./health-daily').recentDays(days, { completeOnly: true });
  const from = rows.length ? rows[rows.length - 1].day : null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
  const hist = from
    ? db.all(`SELECT event_id, start_time, end_time, subject, is_all_day, attendees_other, first_seen
                FROM calendar_history WHERE substr(start_time, 1, 10) >= ? AND substr(start_time, 1, 10) < ?`, [from, today])
    : [];
  const hours = meetingHoursByDay(hist);
  const meetings = new Map();
  for (const [day, h] of hours) if (h > 0 && wd.isWorkingDay(day)) meetings.set(day, h);
  return { known: true, ...bpContext(rows, meetings), meetingDays: meetings.size };
}

module.exports = {
  MIN_NIGHTS,
  BP_MIN_DAYS,
  meetingHoursByDay,
  bpContext,
  loadBpContext,
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
