'use strict';

/**
 * exertion — how hard the body worked, per day, from heart rate alone.
 *
 * The half of an Athlytic-style picture NEURO did not have. Readiness (in
 * health-daily) says how recovered he is; this says how much he asked of
 * himself, and training load says whether that is building, steady or easing.
 *
 * ⚠ FROM HEART RATE, NOT FROM WORKOUTS. A walk with the dog that nobody started
 * a workout for is still exertion, and HealthKit workouts have (at the time of
 * writing) never reached NEURO at all. Continuous heart rate has — 495k samples.
 *
 * The measure is BANISTER'S TRIMP: every minute above resting + 10 bpm, weighted
 * by heart-rate reserve × 0.64·e^(1.92 × reserve). Continuous, published, and
 * explainable in a sentence.
 *
 * ⚠ EDWARDS' ZONES WERE TRIED FIRST AND MEASURED USELESS FOR HIM. Zone 1 starts
 * at 50% of reserve — 116 bpm on his scale (rest 75, observed max 158) — and his
 * heart rate almost never leaves the 90–120 band, so 28 of 30 real days scored
 * exactly zero, hikes included. Banister with a rest+10 floor measured (last 30
 * days): quiet days ~30, the two active days 142 and 209, the biggest 351. A
 * scheme built for athletes in training describes a walker as doing nothing.
 *
 * ⚠ It is NOT comparable to Athlytic's or Whoop's numbers and must never be
 * presented as if it were.
 *
 * Split like the rest: everything that decides is PURE (samples in, numbers
 * out); only `sync` and the readers touch the database.
 */

const db = require('../db/database');

/** Borrowed from health-daily, not re-picked: just above the measured p99 gap. */
const MAX_SAMPLE_WEIGHT_MS = 900000;
/**
 * DISPLAY bands only (fraction of reserve) — where his effort actually lives,
 * ~92 / 100 / 108 / 117 / 125 bpm on the measured scale. Load does not use them.
 */
const ZONES = [0.2, 0.3, 0.4, 0.5, 0.6];
/** Heart rate below rest + this is sitting, not effort, and does not count. */
const EFFORT_FLOOR_BPM = 10;
/** Below this chronic load there is too little to compare against. */
const MIN_CHRONIC_LOAD = 10;
/** A day with less heart rate than this is `partial` — its load is a floor. */
const COVERED_MINUTES_FOR_COMPLETE = 16 * 60;
/** Display scale only: 10 × (1 − e^(−load/K)). Monotonic, and says so. */
const SCORE_K = 150;
const TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';
const ACUTE_DAYS = 7;
const CHRONIC_DAYS = 28;
const MIN_CHRONIC_DAYS = 21;

// ── Pure ─────────────────────────────────────────────────────────────────────

const round = (n, dp = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function parseStamp(at) {
  const s = String(at || '');
  return Date.parse(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
}

/** LOCAL day key — the Pi may run UTC and a day is his day, not Greenwich's. */
function localDayKey(ms, timeZone = TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Which zone (0 = below zone 1, 1..5) a heart rate sits in. PURE. */
function zoneOf(hr, rest, max) {
  const reserve = max - rest;
  if (!(reserve > 0)) return 0;
  const f = (hr - rest) / reserve;
  let z = 0;
  for (let i = 0; i < ZONES.length; i++) if (f >= ZONES[i]) z = i + 1;
  return z;
}

/**
 * One day's load from its heart-rate samples. PURE.
 *
 * Each reading stands for the interval until the next one, capped — the same
 * time-weighting health-daily uses, and for the same reason: the watch samples
 * far faster during exercise, so counting READINGS would measure the workout's
 * sampling rate rather than its effort. A gap longer than the cap (watch off the
 * wrist) counts for the cap and no more.
 */
function dayLoad(samples, { rest, max }) {
  const pts = (samples || [])
    .map((s) => ({ v: Number(s.v ?? s.value), t: parseStamp(s.t ?? s.recorded_at) }))
    .filter((p) => Number.isFinite(p.v) && p.v > 0 && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const zoneMinutes = [0, 0, 0, 0, 0];
  let covered = 0;
  let load = 0;
  let elevated = 0;
  if (!Number.isFinite(rest) || !Number.isFinite(max) || max <= rest) {
    return { known: false, why: 'no usable resting or maximum heart rate', load: null, zoneMinutes, coveredMinutes: 0 };
  }
  // The last reading has no successor, so it stands for a TYPICAL interval —
  // health-daily's rule. A flat minute undercounts a sparsely sampled day.
  const gaps = [];
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i].t - pts[i - 1].t);
  const tail = Math.max(1, median(gaps) || 60000);
  for (let i = 0; i < pts.length; i++) {
    const next = pts[i + 1];
    const ms = Math.min(next ? next.t - pts[i].t : tail, MAX_SAMPLE_WEIGHT_MS);
    if (!(ms > 0)) continue;
    const minutes = ms / 60000;
    covered += minutes;
    const z = zoneOf(pts[i].v, rest, max);
    if (z > 0) zoneMinutes[z - 1] += minutes;
    if (pts[i].v >= rest + EFFORT_FLOOR_BPM) {
      const r = Math.min(1, (pts[i].v - rest) / (max - rest));
      load += minutes * r * 0.64 * Math.exp(1.92 * r);
      elevated += minutes;
    }
  }
  return {
    known: pts.length > 0,
    load: round(load, 1),
    score: round(10 * (1 - Math.exp(-load / SCORE_K)), 1),
    zoneMinutes: zoneMinutes.map((m) => round(m, 0)),
    elevatedMinutes: Math.round(elevated),
    coveredMinutes: Math.round(covered),
    partial: covered < COVERED_MINUTES_FOR_COMPLETE,
    samples: pts.length,
  };
}

/**
 * Maximum heart rate, from what the watch has actually seen. PURE.
 *
 * There is no stored age to take 220 − age from (and that formula is ±10 bpm
 * for a population, worse for a person). So: the highest of each day's 99th
 * percentile — a daily percentile, so one spurious spike cannot set it, and the
 * max across days, so it is his hardest effort rather than his typical one.
 * An override (`NEURO_MAX_HR`) wins, and which answered is always reported.
 */
function estimateMax(dailyP99s, override = process.env.NEURO_MAX_HR) {
  const o = Number(override);
  if (Number.isFinite(o) && o > 100 && o < 230) return { value: o, source: 'override' };
  const v = Math.max(...dailyP99s.filter(Number.isFinite));
  if (!Number.isFinite(v)) return { value: null, source: null };
  return { value: Math.round(v), source: 'observed' };
}

/**
 * Acute (7-day) against chronic (28-day) load. PURE.
 *
 * The ratio is the standard coach's heuristic, NOT something validated on Nick —
 * the bands are the textbook ones and the payload says so. A partial day counts
 * (its load is a floor, and dropping it would read a day the watch was on charge
 * as a rest day), but an UNKNOWN day does not.
 */
function trainingLoad(days) {
  const known = (days || []).filter((d) => Number.isFinite(d.load)).sort((a, b) => (a.day < b.day ? 1 : -1));
  if (known.length < MIN_CHRONIC_DAYS) {
    return { known: false, why: `only ${known.length} day(s) of heart rate — need ${MIN_CHRONIC_DAYS}` };
  }
  const mean = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length;
  const acute = mean(known.slice(0, ACUTE_DAYS).map((d) => d.load));
  const chronic = mean(known.slice(0, CHRONIC_DAYS).map((d) => d.load));
  // ⚠ A ratio of two near-zero loads is noise that reads as a 3× "spike".
  if (!(chronic >= MIN_CHRONIC_LOAD)) {
    return { known: false, why: 'too little load over the last four weeks to compare against', acute: round(acute, 0), chronic: round(chronic, 0) };
  }
  const ratio = acute / chronic;
  const state = ratio == null ? 'unknown'
    : ratio > 1.5 ? 'spike'
      : ratio > 1.3 ? 'building'
        : ratio < 0.8 ? 'easing'
          : 'steady';
  return {
    known: ratio != null,
    acute: round(acute, 0),
    chronic: round(chronic, 0),
    ratio: round(ratio, 2),
    state,
    basis: 'acute:chronic ratio, textbook bands (0.8 / 1.3 / 1.5) — a heuristic, not validated on you',
  };
}

/**
 * Today's suggested load, from recovery and his own usual. PURE.
 *
 * ⚠ A SUGGESTION, and labelled as one. NEURO has already measured that low
 * readiness does NOT predict less getting done (p = 0.97), so this is not a
 * prediction about him — it is the familiar "match effort to recovery" rule,
 * expressed against HIS chronic load rather than a population number. Unknown
 * recovery gives no target rather than a normal one.
 */
function target(readiness, load) {
  if (!readiness || !readiness.known) return { known: false, why: readiness?.reason || 'recovery unknown' };
  if (!load || !load.known) return { known: false, why: load?.why || 'training load unknown' };
  const band = readiness.state === 'high' ? [1.0, 1.4] : readiness.state === 'low' ? [0.4, 0.8] : [0.8, 1.1];
  return {
    known: true,
    low: Math.round(load.chronic * band[0]),
    high: Math.round(load.chronic * band[1]),
    recovery: readiness.state,
    basis: 'your 28-day usual load, scaled by today’s recovery — a suggestion, not a prediction',
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

function toSqlUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Resting heart rate: the 14-day median of the rollup's daily values. */
function restingHr() {
  const rows = db.all(
    'SELECT rhr_median FROM health_daily WHERE rhr_median IS NOT NULL AND complete = 1 ORDER BY day DESC LIMIT 14'
  );
  return median(rows.map((r) => r.rhr_median));
}

/**
 * Roll up a window of days, newest `days` ending at `now`. Idempotent.
 *
 * ⚠ Bounded at BOTH ends and read in 7-day chunks — health-daily's lesson: a
 * single wide read hits the row cap, keeps the newest rows, and rolls the oldest
 * days up as having no heart rate at all.
 */
function sync({ days = 10, now = new Date(), chunkDays = 7 } = {}) {
  const gaps = [];
  const rest = restingHr();
  if (!Number.isFinite(rest)) return { ok: false, written: 0, gaps: [{ input: 'rest', why: 'no resting heart rate in health_daily yet' }] };

  // Max first, across a year, so every day in the window is judged on one scale.
  const maxRow = maxHrFromHistory();
  if (!Number.isFinite(maxRow.value)) return { ok: false, written: 0, gaps: [{ input: 'max', why: 'no heart rate history' }] };

  const todayKey = localDayKey(now.getTime());
  const byDay = new Map();
  const endMs = now.getTime();
  for (let off = 0; off < days; off += chunkDays) {
    const hi = endMs - off * 86400000;
    const lo = hi - Math.min(chunkDays, days - off) * 86400000 - 3600000;
    try {
      const rows = db.getHealthSamplesBetween('heartRate', toSqlUtc(lo), toSqlUtc(hi), 60001);
      if (rows.length > 60000) { gaps.push({ input: `chunk ending ${toSqlUtc(hi)}`, why: 'over 60,000 samples — refused rather than truncated' }); continue; }
      for (const r of rows) {
        const k = localDayKey(parseStamp(r.recorded_at));
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(r);
      }
    } catch (e) {
      gaps.push({ input: 'heartRate', why: e.message });
    }
  }

  const firstKey = localDayKey(endMs - (days - 1) * 86400000);
  let written = 0;
  for (const [day, samples] of byDay) {
    if (day < firstKey || day > todayKey) continue;
    const d = dayLoad(samples, { rest, max: maxRow.value });
    try {
      db.run(
        `INSERT INTO health_exertion_daily (day, load, score, z1, z2, z3, z4, z5, covered_minutes, elevated_minutes, partial, rest_hr, max_hr, max_source, complete, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(day) DO UPDATE SET load=excluded.load, score=excluded.score, z1=excluded.z1, z2=excluded.z2,
           z3=excluded.z3, z4=excluded.z4, z5=excluded.z5, covered_minutes=excluded.covered_minutes, elevated_minutes=excluded.elevated_minutes,
           partial=excluded.partial, rest_hr=excluded.rest_hr, max_hr=excluded.max_hr,
           max_source=excluded.max_source, complete=excluded.complete, computed_at=CURRENT_TIMESTAMP`,
        [day, d.load, d.score, ...d.zoneMinutes, d.coveredMinutes, d.elevatedMinutes, d.partial ? 1 : 0,
          round(rest, 1), maxRow.value, maxRow.source, day < todayKey ? 1 : 0]
      );
      written++;
    } catch (e) {
      gaps.push({ input: `day ${day}`, why: e.message });
    }
  }
  return { ok: gaps.length === 0, written, gaps, rest: round(rest, 1), max: maxRow };
}

/** Max HR from a year of per-day 99th percentiles, recomputed at most daily. */
let maxCache = { at: 0, value: null };
function maxHrFromHistory() {
  if (maxCache.value && Date.now() - maxCache.at < 86400000) return maxCache.value;
  maxCache = { at: Date.now(), value: scanMaxHr() };
  return maxCache.value;
}

function scanMaxHr() {
  const since = toSqlUtc(Date.now() - 365 * 86400000);
  const days = db.all(
    `SELECT substr(recorded_at, 1, 10) AS day, COUNT(*) AS n FROM health_samples
      WHERE metric = 'heartRate' AND recorded_at >= ? GROUP BY day HAVING n >= 50`,
    [since]
  );
  const p99s = [];
  for (const { day } of days) {
    const rows = db.all(
      `SELECT value FROM health_samples WHERE metric = 'heartRate' AND recorded_at >= ? AND recorded_at < ?`,
      [`${day} 00:00:00`, `${day} 23:59:60`]
    );
    p99s.push(quantile(rows.map((r) => r.value), 0.99));
  }
  return estimateMax(p99s);
}

function fromRow(r) {
  return {
    day: r.day,
    load: r.load,
    score: r.score,
    zoneMinutes: [r.z1, r.z2, r.z3, r.z4, r.z5],
    coveredMinutes: r.covered_minutes,
    elevatedMinutes: r.elevated_minutes,
    partial: r.partial === 1,
    complete: r.complete === 1,
    restHr: r.rest_hr,
    maxHr: r.max_hr,
    maxSource: r.max_source,
  };
}

function recent(days = 60) {
  return db.all('SELECT * FROM health_exertion_daily ORDER BY day DESC LIMIT ?', [days]).map(fromRow);
}

/**
 * SAiM's one sentence about exertion. PURE, and composed HERE so every surface —
 * iOS SAiM, the SAiM PWA, the kiosk, the Electron window — renders the same words
 * rather than each phrasing it. It STATES and never advises: a spike is a ratio
 * against his own month, not "take it easy". Null when there is nothing to say.
 */
function lineFor({ today, yesterday, trainingLoad } = {}) {
  if (trainingLoad && trainingLoad.known && trainingLoad.state === 'spike' && Number.isFinite(trainingLoad.ratio)) {
    return `This week's exertion is ${trainingLoad.ratio.toFixed(2)}× your usual.`;
  }
  if (yesterday && Number.isFinite(yesterday.score)) {
    const t = today && Number.isFinite(today.score) ? `, ${today.score.toFixed(1)} so far today` : '';
    return `Yesterday's exertion was ${yesterday.score.toFixed(1)} of 10${t}.`;
  }
  return null;
}

/** Today in one read: exertion so far, load, recovery, and the suggestion. */
function summary(now = new Date()) {
  const rows = recent(CHRONIC_DAYS + 14);
  const todayKey = localDayKey(now.getTime());
  const todayRow = rows.find((r) => r.day === todayKey) || null;
  const finished = rows.filter((r) => r.day < todayKey);
  const load = trainingLoad(finished);
  let readiness = null;
  try { readiness = require('./health-daily').today(now).readiness; } catch { readiness = null; }
  return {
    line: lineFor({ today: todayRow, yesterday: finished[0] || null, trainingLoad: load }),
    today: todayRow,
    yesterday: finished[0] || null,
    trainingLoad: load,
    target: target(readiness, load),
    recovery: readiness,
    scale: 'Banister TRIMP above resting + 10 bpm; the 0–10 score is a display scale and is not Athlytic’s',
  };
}

module.exports = {
  // pure
  localDayKey,
  zoneOf,
  dayLoad,
  estimateMax,
  trainingLoad,
  target,
  lineFor,
  SCORE_K,
  // io
  sync,
  recent,
  summary,
};
