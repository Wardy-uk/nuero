'use strict';

/**
 * Pins the INTRADAY read.
 *
 * Everything here exercises the PURE half — no database, no clock — which is the
 * point of the split. Volumes in the fixtures are the live ones: heart rate
 * arrives ~393 times a day, blood pressure ~22, SpO2 ~19, so a bucket that holds
 * a plausible number of readings for one of them holds a very different number
 * for another, and a size that only looks sensible against invented data is a
 * size nobody has checked.
 */

const test = require('node:test');
const assert = require('node:assert');

const hs = require('./health-samples');
const hd = require('./health-daily');

const MIN = 60000;

function bucketRow(metric, epochMs, { avg = null, sum = null, n = 1 } = {}) {
  return { metric, bucket_epoch: Math.floor(epochMs / 1000), n, avg, sum, min: avg, max: avg };
}

// ── Bucket sizing ───────────────────────────────────────────────────────────

test('the bucket is sized to the window, not guessed per call', () => {
  // ~100-200 points is the target: fewer smooths an intraday shape away, more is
  // sub-pixel detail on a 560px chart.
  for (const hours of [1, 6, 24, 48, 168]) {
    const plan = hs.bucketPlan(hours);
    assert.ok(plan, `no plan for ${hours}h`);
    assert.ok(plan.buckets >= 60 && plan.buckets <= 400,
      `${hours}h gives ${plan.buckets} buckets at ${plan.bucketMinutes} min`);
  }
});

test('the live windows land on round, labellable bucket sizes', () => {
  // A computed size drifts to things like 37 minutes, which no axis tick can sit
  // on sensibly. 24h and 7d are the two windows the page actually offers.
  assert.equal(hs.bucketPlan(24).bucketMinutes, 10);
  assert.equal(hs.bucketPlan(168).bucketMinutes, 60);
  assert.equal(hs.bucketPlan(168).buckets, 168);
});

test('a window that is not a positive number of hours is refused, not guessed', () => {
  for (const bad of [0, -1, NaN, null, undefined, 'soon']) {
    assert.equal(hs.bucketPlan(bad), null, `${bad} should not produce a plan`);
  }
});

// ── Shaping ─────────────────────────────────────────────────────────────────

test('every bucket in the window is emitted, so a gap occupies space', () => {
  // ⚠ The failure this prevents: emitting only the buckets that HAVE data draws
  // two readings an hour apart as though they were consecutive, which is the
  // chart inventing a timeline. The x axis has to be real time.
  const t0 = Date.UTC(2026, 8, 16, 0, 0, 0);
  const { series } = hs.shapeSeries({
    rows: [
      bucketRow('heartRate', t0, { avg: 70 }),
      bucketRow('heartRate', t0 + 180 * MIN, { avg: 74 }),
    ],
    keys: ['heartRateMedian'],
    sinceMs: t0,
    untilMs: t0 + 240 * MIN,
    bucketMinutes: 60,
  });
  const pts = series.heartRateMedian;
  assert.equal(pts.length, 5, 'one point per hour across the window');
  assert.equal(pts[0].v, 70);
  assert.equal(pts[3].v, 74);
  // ⚠ null, NEVER 0 — the chart breaks its path at null, and a zero would render
  // as a heart rate of nothing.
  assert.strictEqual(pts[1].v, null);
  assert.strictEqual(pts[2].v, null);
});

test('a counter SUMS inside a bucket and a rate AVERAGES', () => {
  // Steps per hour is a real quantity; an average of step samples is not. This
  // mirrors SCALAR_METRICS rather than deciding again.
  const t0 = Date.UTC(2026, 8, 16, 9, 0, 0);
  const { series } = hs.shapeSeries({
    rows: [
      bucketRow('steps', t0, { avg: 100, sum: 900 }),
      bucketRow('heartRate', t0, { avg: 72, sum: 5040 }),
    ],
    keys: ['steps', 'heartRateMedian'],
    sinceMs: t0,
    untilMs: t0,
    bucketMinutes: 60,
  });
  assert.equal(series.steps[0].v, 900);
  assert.equal(series.heartRateMedian[0].v, 72);
});

test('SpO2 and daylight are scaled here exactly as the daily rollup scales them', () => {
  // ⚠ ONE source of truth for units. SpO2 arrives as a fraction and daylight in
  // seconds; a second copy of those facts here is how the 24-hour chart comes to
  // say 0.97% while the 90-day chart says 97%.
  assert.equal(hs.scaleFor('blood_oxygen_saturation'), hd.SCALAR_METRICS.blood_oxygen_saturation.scale);
  assert.equal(hs.scaleFor('time_in_daylight'), hd.SCALAR_METRICS.time_in_daylight.scale);

  const t0 = Date.UTC(2026, 8, 16, 9, 0, 0);
  const { series } = hs.shapeSeries({
    rows: [bucketRow('blood_oxygen_saturation', t0, { avg: 0.9714 })],
    keys: ['spo2'], sinceMs: t0, untilMs: t0, bucketMinutes: 60,
  });
  assert.equal(series.spo2[0].v, 97.14);
  assert.ok(series.spo2[0].v > 1, 'the raw fraction must not survive to a chart');
});

test('a metric that folds as a median is not scaled at all', () => {
  // Heart rate, HRV and both halves of blood pressure live in MEDIAN_METRICS and
  // are absent from SCALAR_METRICS — 1 is the right answer for them, not a
  // missing one that reads as undefined and turns a value into NaN.
  for (const m of ['heartRate', 'hrv', 'rhr', 'blood_pressure_systolic', 'blood_pressure_diastolic']) {
    assert.equal(hs.scaleFor(m), 1, `${m} should not be scaled`);
  }
});

test('blood pressure keeps its two halves apart', () => {
  const t0 = Date.UTC(2026, 8, 16, 8, 0, 0);
  const { series } = hs.shapeSeries({
    rows: [
      bucketRow('blood_pressure_systolic', t0, { avg: 151 }),
      bucketRow('blood_pressure_diastolic', t0, { avg: 90 }),
    ],
    keys: ['bpSystolic', 'bpDiastolic'], sinceMs: t0, untilMs: t0, bucketMinutes: 60,
  });
  assert.equal(series.bpSystolic[0].v, 151);
  assert.equal(series.bpDiastolic[0].v, 90);
  assert.notEqual(series.bpSystolic[0].v, series.bpDiastolic[0].v);
});

// ── What has an intraday form at all ────────────────────────────────────────

test('sleep has NO intraday form, and that is reported rather than faked', () => {
  // ⚠ It is a nightly figure rolled up from staged segments. "Sleep at 14:00" is
  // not a question, and an empty chart in its place reads as a broken feed.
  assert.equal(hs.hasSeries('asleepHours'), false);
  // Everything the page charts in a short window must be here, or it renders
  // blank and raises nothing — the reader-with-no-writer shape.
  for (const key of ['bpSystolic', 'bpDiastolic', 'heartRateMedian', 'spo2', 'hrvMedian', 'rhrMedian']) {
    assert.equal(hs.hasSeries(key), true, `${key} has no intraday series`);
  }
});

test('every intraday series names a metric the samples table actually uses', () => {
  // The metric names are Apple's, and a guessed one returns zero rows rather
  // than an error — the `sleep_core_hours` / `meeting_alert` species, which this
  // codebase has now paid for three times.
  const known = new Set([
    ...Object.keys(hd.SCALAR_METRICS),
    ...Object.keys(hd.MEDIAN_METRICS),
  ]);
  for (const [key, spec] of Object.entries(hs.SERIES)) {
    assert.ok(known.has(spec.metric),
      `series ${key} reads "${spec.metric}", which neither rollup table knows`);
  }
});

test('the bucket fold matches how the daily rollup treats the same metric', () => {
  // A counter that summed daily and averaged hourly would make the two windows
  // disagree about what the number means.
  for (const [key, spec] of Object.entries(hs.SERIES)) {
    const daily = hd.SCALAR_METRICS[spec.metric];
    if (!daily) continue; // median metrics have no `how` to agree with
    assert.equal(spec.how, daily.how,
      `${key} folds as ${spec.how} hourly but ${daily.how} daily`);
  }
});

// ── Freshness, and the paired blood pressure ────────────────────────────────
//
// Both moved into this service on 16 Sep 2026. The staleness windows used to
// live in the desktop panel, so no other surface could apply them — the MCP tool
// had no idea a reading was eleven hours old. They are decided once here and
// travel ON the reading.

test('every series declares a measured staleness window', () => {
  // A series falling through to the default is one nobody measured a cadence
  // for — and the default is deliberately generous, so the miss would be silent.
  for (const [key, spec] of Object.entries(hs.SERIES)) {
    assert.ok(Number.isFinite(spec.staleAfterMin) && spec.staleAfterMin > 0,
      `${key} has no measured staleness window`);
    assert.ok(typeof spec.unit === 'string' && spec.unit.length,
      `${key} has no unit, so a consumer has to guess one`);
  }
});

test('the windows differ per metric, because the cadences do', () => {
  // ⚠ One threshold is wrong on most of these, always towards a warning that is
  // permanently on. Measured p90 gaps: heart rate 7 min, resting heart rate
  // 1030 min. A rule that suits one cannot suit the other.
  assert.ok(hs.SERIES.rhrMedian.staleAfterMin > hs.SERIES.heartRateMedian.staleAfterMin * 10,
    'a once-daily metric cannot share a window with a continuous one');
  assert.ok(hs.SERIES.spo2.staleAfterMin > hs.SERIES.heartRateMedian.staleAfterMin);
});

test('a reading carries its age and whether that makes it stale', () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);
  const spec = { unit: 'bpm', staleAfterMin: 30 };
  const fresh = hs.stampAge(74, '2026-09-16 11:50:00', spec, now);
  assert.equal(fresh.ageMinutes, 10);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.unit, 'bpm');
  assert.equal(fresh.staleAfterMin, 30);

  const old = hs.stampAge(74, '2026-09-16 06:00:00', spec, now);
  assert.equal(old.ageMinutes, 360);
  assert.equal(old.stale, true);
});

test('an unreadable timestamp is stale:null, NEVER false', () => {
  // ⚠ "We cannot tell how old this is" is not "this is current", and false is
  // precisely the answer that lets a stale value present as a current one.
  const r = hs.stampAge(74, 'not-a-date', { unit: 'bpm', staleAfterMin: 30 }, Date.now());
  assert.strictEqual(r.stale, null);
  assert.strictEqual(r.ageMinutes, null);
  assert.match(r.note, /age unknown/);
});

test('blood pressure is never exposed as two independent latest values', () => {
  // ⚠⚠ The rule that makes the wrong thing impossible rather than discouraged:
  // a consumer cannot pair a newest systolic with a newest diastolic if the
  // halves are not there to pair.
  assert.deepEqual(hs.BP_KEYS, ['bpSystolic', 'bpDiastolic']);
  // They remain chartable — two lanes on one axis is right for a plot.
  assert.ok(hs.hasSeries('bpSystolic') && hs.hasSeries('bpDiastolic'));
});
