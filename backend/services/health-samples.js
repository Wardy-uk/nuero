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
const SERIES = {
  bpSystolic: { metric: 'blood_pressure_systolic', how: 'avg' },
  bpDiastolic: { metric: 'blood_pressure_diastolic', how: 'avg' },
  heartRateMedian: { metric: 'heartRate', how: 'avg' },
  hrvMedian: { metric: 'hrv', how: 'avg' },
  rhrMedian: { metric: 'rhr', how: 'avg' },
  spo2: { metric: 'blood_oxygen_saturation', how: 'avg' },
  steps: { metric: 'steps', how: 'sum' },
  exerciseMinutes: { metric: 'apple_exercise_time', how: 'sum' },
  daylightMinutes: { metric: 'time_in_daylight', how: 'sum' },
};

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

/** The newest reading of each series, for the "Now" view. */
function latest({ keys = null } = {}) {
  const wanted = (keys && keys.length ? keys : Object.keys(SERIES)).filter(hasSeries);
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
    out[key] = {
      value: Math.round(row.value * scaleFor(spec.metric) * 100) / 100,
      at: String(row.at).replace(' ', 'T') + 'Z',
    };
  }
  return { ok: gaps.length === 0, latest: out, gaps };
}

module.exports = {
  read,
  latest,
  hasSeries,
  // exported for tests
  SERIES,
  bucketPlan,
  shapeSeries,
  scaleFor,
};
