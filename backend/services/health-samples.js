'use strict';

/**
 * The INTRADAY read — what a metric did across the last few hours or days.
 *
 * `health-daily` answers "what was this day", which is the right question for a
 * trend across 762 of them and the wrong one for the last 24 hours: a daily
 * rollup over one day is a SINGLE POINT, and a chart of one point is not a
 * chart. So the short windows come from `health_samples` direct, bucketed.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 * A BUCKET IS AN AVERAGE, A DAY IS A MEDIAN, AND THE CHART MUST SAY WHICH. They
 * are different statistics over different spans and they legitimately disagree —
 * the same reason readiness and stress are labelled by window rather than
 * quietly reconciled. `resolution` travels on the payload so no surface has to
 * infer it.
 *
 * ⚠ AVERAGING INSIDE A BUCKET IS NOT THE MISTAKE THE DAILY MEDIAN MADE. That
 * bug was one number standing for a whole day while 72% of the readings came
 * from two workout hours. A bucket is ten minutes or an hour, so the density
 * skew inside one is bounded — and a workout then appears as a visible spike on
 * the chart rather than silently becoming the day.
 *
 * AN EMPTY BUCKET IS NULL, NEVER ZERO. The chart draws a gap at null, which is
 * the truth: the watch was off, or he was not wearing it. A zero would read as a
 * heart rate of nothing.
 *
 * UNITS ARE DECIDED IN ONE PLACE. The scale factors come from `health-daily`'s
 * SCALAR_METRICS rather than being restated here — SpO2 arrives as a fraction
 * and daylight arrives in seconds, and a second copy of those facts is how one
 * chart comes to disagree with another about what a number means.
 */

const db = require('../db/database');
const { SCALAR_METRICS } = require('./health-daily');

// What each chartable series reads from, and how a bucket folds.
//
// `how` mirrors SCALAR_METRICS: a rate averages, a counter sums. Steps per hour
// is a real quantity; an average of step samples is not.
//
// ⚠ A key that is ABSENT from here has no intraday form at all, and that is a
// fact to report rather than a chart to fake. Sleep is the case: it is a nightly
// figure derived from staged segments, and "sleep at 14:00" is not a question.
//
// `unit` and `staleAfterMin` travel WITH the reading, so no consumer has to
// know either. Before this the staleness windows lived in the desktop panel and
// nothing else could apply them — which is how a second surface comes to call
// the same reading current while the first calls it stale.
//
// ⚠⚠ `staleAfterMin` IS PER METRIC, AND IT HAD TO BE. A single threshold is the
// obvious implementation and is wrong on most of these, always in the direction
// of a warning that is permanently on — which is a warning nobody reads, and it
// costs the real one. Measured over 30 days on the live table as the median and
// p90 gap between consecutive readings, each window set at roughly 3x its own
// p90:
//
//     heart rate            3 /    7 min   continuous while worn
//     steps                 7 /   29 min
//     HRV                  15 /   41 min
//     blood oxygen         35 /  134 min   a 90-minute rule flags a NORMAL gap
//     blood pressure       39 /   56 min   within a session, but MONTHS between
//     exercise minutes     22 /  154 min   only logged while exercising
//     resting heart rate  479 / 1030 min   once or twice a DAY
//     daylight             13 /  840 min   cannot accrue overnight, so the p90
//                                          gap IS a night
//
// Blood pressure is the exception to the formula and is judged on MEANING
// instead: a reading from this morning still says something about today, one
// from March does not.
const SERIES = {
  bpSystolic: { metric: 'blood_pressure_systolic', how: 'avg', unit: 'mmHg', staleAfterMin: 24 * 60 },
  bpDiastolic: { metric: 'blood_pressure_diastolic', how: 'avg', unit: 'mmHg', staleAfterMin: 24 * 60 },
  heartRateMedian: { metric: 'heartRate', how: 'avg', unit: 'bpm', staleAfterMin: 30 },
  hrvMedian: { metric: 'hrv', how: 'avg', unit: 'ms', staleAfterMin: 2 * 60 },
  rhrMedian: { metric: 'rhr', how: 'avg', unit: 'bpm', staleAfterMin: 36 * 60 },
  spo2: { metric: 'blood_oxygen_saturation', how: 'avg', unit: '%', staleAfterMin: 6 * 60 },
  steps: { metric: 'steps', how: 'sum', unit: 'steps', staleAfterMin: 90 },
  exerciseMinutes: { metric: 'apple_exercise_time', how: 'sum', unit: 'min', staleAfterMin: 8 * 60 },
  daylightMinutes: { metric: 'time_in_daylight', how: 'sum', unit: 'min', staleAfterMin: 48 * 60 },
};

// ⚠ NOT exposed individually by `latest()`. Both halves of a blood pressure are
// charted as separate lanes, which is right for a plot, and are meaningless as
// separate LATEST values — see `latestBloodPressure`.
const BP_KEYS = ['bpSystolic', 'bpDiastolic'];

// The fallback for a series that forgot to declare a window. Deliberately
// generous: between a missed warning and a permanent one, the permanent one
// does more damage, because it is the thing that teaches the warning to be
// ignored.
const DEFAULT_STALE_AFTER_MIN = 6 * 60;

// Scale is READ from the daily rollup's own table, never restated. SpO2 is a
// fraction (x100) and daylight is seconds (/60); getting either wrong here would
// put "0.97%" on one chart and "97%" on another for the same reading.
function scaleFor(metric) {
  // SCALAR_METRICS is keyed by the RAW metric name, so this is a direct lookup.
  // A metric that folds as a median (heart rate, HRV, both halves of blood
  // pressure) is not in that table at all and needs no scaling — 1 is the right
  // answer for it, not a missing one.
  const spec = SCALAR_METRICS[metric];
  return (spec && spec.scale) || 1;
}

/**
 * Bucket size for a window, PURE.
 *
 * Sized so a chart lands between roughly 100 and 200 points: fewer and an
 * intraday shape is lost to smoothing, more and the SVG path is mostly
 * sub-pixel detail nobody can see. Measured against the live cadence — heart
 * rate arrives ~393 times a day, so a 10-minute bucket over 24h holds ~2.7
 * readings and an hourly bucket over 7 days holds ~16.
 *
 * ⚠ Returns the bucket in MINUTES and the count it implies, so a caller can
 * refuse a window that would produce an unreasonable number of points rather
 * than discovering it after the query.
 */
function bucketPlan(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  // Ladder rather than a formula: these are the three windows the page offers,
  // and a computed size would drift to odd numbers like 37 minutes that no axis
  // label can sit on.
  const minutes = h <= 3 ? 1
    : h <= 12 ? 5
      : h <= 36 ? 10
        : h <= 24 * 3 ? 30
          : 60;
  return { bucketMinutes: minutes, buckets: Math.ceil((h * 60) / minutes) };
}

/**
 * Shape bucket rows into per-key series, PURE.
 *
 * Every bucket in the window is emitted, present or not, so the x axis is a real
 * timeline: a gap where the watch was off must occupy space, or two readings an
 * hour apart draw as though they were consecutive.
 */
function shapeSeries({ rows = [], keys = [], sinceMs, untilMs, bucketMinutes }) {
  const step = Math.max(1, Math.floor(bucketMinutes)) * 60000;
  const first = Math.floor(sinceMs / step) * step;
  const last = Math.floor(untilMs / step) * step;

  const byMetric = new Map();
  for (const r of rows) {
    if (!r || !r.metric) continue;
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, new Map());
    byMetric.get(r.metric).set(Number(r.bucket_epoch) * 1000, r);
  }

  const series = {};
  const counts = {};
  for (const key of keys) {
    const spec = SERIES[key];
    if (!spec) continue;
    const found = byMetric.get(spec.metric) || new Map();
    const scale = scaleFor(spec.metric);
    const points = [];
    let carried = 0;
    for (let t = first; t <= last; t += step) {
      const row = found.get(t);
      const raw = row ? (spec.how === 'sum' ? row.sum : row.avg) : null;
      // ⚠ null, never 0 — an empty bucket is "not measured", and the chart draws
      // it as a gap. A zero would render as a heart rate of nothing.
      const v = Number.isFinite(raw) ? Math.round(raw * scale * 100) / 100 : null;
      if (v !== null) carried++;
      points.push({ t, v, n: row ? row.n : 0 });
    }
    series[key] = points;
    counts[key] = carried;
  }
  return { series, counts };
}

/** Is there an intraday form of this chart at all? */
function hasSeries(key) {
  return Object.prototype.hasOwnProperty.call(SERIES, key);
}

/**
 * The read itself.
 *
 * ⚠ Bounded at BOTH ends like every other window in this area, and `until` is
 * passed explicitly rather than left open: an open end makes the bucket run to
 * whatever the clock says mid-query, so two metrics in one response can end on
 * different buckets.
 */
function read({ hours = 168, keys = null, now = new Date() } = {}) {
  const plan = bucketPlan(hours);
  if (!plan) return { ok: false, reason: 'window must be a positive number of hours' };

  const wanted = (keys && keys.length ? keys : Object.keys(SERIES)).filter(hasSeries);
  if (!wanted.length) return { ok: false, reason: 'no chartable series requested' };

  const untilMs = now.getTime();
  const sinceMs = untilMs - hours * 3600000;
  const toSql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  const metrics = [...new Set(wanted.map(k => SERIES[k].metric))];
  const gaps = [];
  let rows = [];
  try {
    rows = db.getHealthSampleBuckets(metrics, toSql(sinceMs), toSql(untilMs), plan.bucketMinutes * 60);
  } catch (e) {
    // A failed read is a NAMED gap, never an empty series — "nothing was
    // recorded" and "we could not look" license opposite conclusions, and only
    // one of them is an all-clear.
    gaps.push({ input: 'samples', why: e.message });
  }

  const { series, counts } = shapeSeries({
    rows, keys: wanted, sinceMs, untilMs, bucketMinutes: plan.bucketMinutes,
  });

  return {
    ok: gaps.length === 0,
    windowHours: hours,
    bucketMinutes: plan.bucketMinutes,
    // Named so the chart can say what it is showing. A bucket average and a
    // daily median are different statistics and must not share a label.
    resolution: plan.bucketMinutes < 60
      ? `${plan.bucketMinutes}-minute average`
      : `${plan.bucketMinutes / 60}-hour average`,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    series,
    counts,
    gaps,
  };
}

/** Parse a stored timestamp, tolerating both SQLite's format and ISO. */
function toMs(at) {
  if (!at) return NaN;
  const str = String(at);
  return Date.parse(str.includes('T') ? str : `${str.replace(' ', 'T')}Z`);
}

function isoOf(at) {
  const ms = toMs(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Stamp a reading with how old it is and whether that makes it stale, PURE.
 *
 * ⚠ `stale` is decided HERE, once, and travels with the value. It used to be a
 * table in the desktop panel, which meant no other surface could apply it — the
 * MCP tool had no idea a reading was eleven hours old, and a second copy of the
 * windows is how two surfaces come to disagree about the same reading.
 *
 * ⚠ An unreadable timestamp is `stale: null`, NEVER false. "We cannot tell how
 * old this is" is not "this is current", and false is the answer that lets a
 * stale value present as current — the one thing this must not do.
 */
function stampAge(value, at, spec, nowMs) {
  const ms = toMs(at);
  const staleAfterMin = (spec && spec.staleAfterMin) || DEFAULT_STALE_AFTER_MIN;
  if (!Number.isFinite(ms)) {
    return {
      value, unit: spec?.unit || null, at: null,
      ageMinutes: null, stale: null, staleAfterMin,
      note: 'no usable timestamp — age unknown',
    };
  }
  const ageMinutes = Math.round((nowMs - ms) / 60000);
  return {
    value,
    unit: spec?.unit || null,
    at: new Date(ms).toISOString(),
    ageMinutes,
    stale: ageMinutes > staleAfterMin,
    staleAfterMin,
  };
}

/**
 * The newest COMPLETE blood pressure.
 *
 * ⚠⚠ ONE MEASUREMENT, NEVER TWO HALVES GLUED TOGETHER. The newest systolic and
 * the newest diastolic are independent reads and nothing makes them the same
 * event; pairing them manufactures a reading nobody took, on the one metric here
 * where a wrong number is a clinical statement. The pairing is done in SQL on
 * `recorded_at` — measured live, 10,544 of 10,544 systolic samples have a
 * diastolic at the identical instant, so the source genuinely supports it.
 *
 * ⚠ Where it does not pair, this says so rather than falling back to halves.
 * Three diastolic samples in the live table have no systolic partner, so the
 * refusal is a real branch, not a defensive one.
 *
 * ⚠ `laterUnpairedReading` exists so a pair can never silently present as the
 * most recent thing known: if a half arrived after the last complete reading,
 * the consumer is told rather than left to assume.
 */
function latestBloodPressure({ now = new Date() } = {}) {
  const spec = SERIES.bpSystolic;
  let row = null;
  let newestSampleAt = null;
  try {
    row = db.getLatestBloodPressure();
    newestSampleAt = db.getLatestBloodPressureSampleAt();
  } catch (e) {
    return { known: false, reason: `could not read blood pressure — ${e.message}` };
  }

  if (!row || !Number.isFinite(row.systolic) || !Number.isFinite(row.diastolic)) {
    return {
      known: false,
      // ⚠ STRUCTURED, not a phrase for a consumer to match on. "Readings exist
      // but none of them pair" and "nothing has ever been recorded" send a
      // reader to different places, and a surface deciding which by testing the
      // prose would break the moment the wording improved.
      hasReadings: Boolean(newestSampleAt),
      reason: newestSampleAt
        ? 'readings exist, but no systolic and diastolic from the same measurement — no complete blood pressure is available'
        : 'no blood pressure has been recorded',
    };
  }

  const stamped = stampAge(null, row.at, spec, now.getTime());
  const pairMs = toMs(row.at);
  const newestMs = toMs(newestSampleAt);
  return {
    known: true,
    systolic: row.systolic,
    diastolic: row.diastolic,
    unit: spec.unit,
    at: stamped.at,
    ageMinutes: stamped.ageMinutes,
    stale: stamped.stale,
    staleAfterMin: stamped.staleAfterMin,
    // True when a lone systolic or diastolic landed after this pair. The pair is
    // still the latest COMPLETE reading; it is just not the latest datum.
    laterUnpairedReading: Number.isFinite(pairMs) && Number.isFinite(newestMs) && newestMs > pairMs,
  };
}

/**
 * The newest reading of each series, for the "Now" view.
 *
 * ⚠ BLOOD PRESSURE IS ABSENT FROM THIS MAP BY DESIGN. Exposing `bpSystolic` and
 * `bpDiastolic` as separate latest values makes the wrong thing — pairing two
 * unrelated measurements — the easy thing. It is returned by
 * `latestBloodPressure` as one reading, or not at all.
 */
function latest({ keys = null, now = new Date() } = {}) {
  const nowMs = now.getTime();
  const wanted = (keys && keys.length ? keys : Object.keys(SERIES))
    .filter(hasSeries)
    .filter(k => !BP_KEYS.includes(k));
  const metrics = [...new Set(wanted.map(k => SERIES[k].metric))];
  let raw = {};
  const gaps = [];
  try {
    raw = db.getLatestHealthSamples(metrics);
  } catch (e) {
    gaps.push({ input: 'latest', why: e.message });
  }
  const out = {};
  for (const key of wanted) {
    const spec = SERIES[key];
    const row = raw[spec.metric];
    // ⚠ ABSENT, not null-with-a-shape: a series that has never been recorded and
    // one whose last reading is two years old are different facts, and the age
    // is what tells them apart. Nothing is invented for a metric with no rows.
    if (!row || !Number.isFinite(row.value)) continue;
    const value = Math.round(row.value * scaleFor(spec.metric) * 100) / 100;
    out[key] = stampAge(value, row.at, spec, nowMs);
  }
  const bloodPressure = latestBloodPressure({ now });
  if (bloodPressure.known === false && /could not read/.test(bloodPressure.reason || '')) {
    gaps.push({ input: 'bloodPressure', why: bloodPressure.reason });
  }
  return { ok: gaps.length === 0, latest: out, bloodPressure, gaps };
}

module.exports = {
  read,
  latest,
  latestBloodPressure,
  hasSeries,
  // exported for tests
  SERIES,
  bucketPlan,
  shapeSeries,
  scaleFor,
  stampAge,
  BP_KEYS,
  DEFAULT_STALE_AFTER_MIN,
};
