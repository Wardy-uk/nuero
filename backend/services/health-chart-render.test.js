'use strict';

/**
 * Do the health charts actually DRAW?
 *
 * A vite build proves HealthPanel compiles. It does not prove a line was
 * plotted, and every failure worth catching here compiles perfectly: a series
 * key that does not match the payload draws an empty chart, a date axis with a
 * bad format string draws blank labels, and a paired chart that forgets its
 * second lane draws one line under a legend naming two.
 *
 * `desktop-render.test.js` mounts whole panels and, because HealthPanel fetches
 * in a `useEffect`, would only ever reach its loading state. TrendChart takes
 * its rows as a PROP, so mounting it directly reaches the real branch — the same
 * reason that harness asserts TodoPanel's content through its pin.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, 'HealthPanel.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'idb'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: [
            'export const apiUrl = (p) => p;',
            'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });',
            'export default { apiUrl, apiFetch };',
          ].join('\n'),
          loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
  return mod;
}

// Newest first, exactly as /api/health/history returns it — if the component
// stopped reversing, the axis would run backwards and nothing else would change.
function bpDays(n = 10, from = '2026-09-15') {
  const end = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    day: new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10),
    bpSystolic: 145 + (i % 5),
    bpDiastolic: 86 + (i % 4),
    heartRateMedian: 76 + (i % 6),
    spo2: 94 + (i % 3) * 0.4,
    complete: true,
  }));
}

test.before(() => {
  // TrendChart guards on `typeof ResizeObserver === "undefined"` and falls back
  // to its default width, which is the path a server render takes.
  global.window = global.window || { addEventListener() {}, removeEventListener() {} };
});

// ── The time axis ───────────────────────────────────────────────────────────

test('axisLabel slices the day key and never parses it into a Date', async () => {
  const { axisLabel } = await load();
  assert.equal(axisLabel('2026-09-16'), '16 Sep');
  assert.equal(axisLabel('2026-09-16', true), '16 Sep 2026');
  // ⚠ The whole reason it slices: `new Date('2026-01-01')` is midnight UTC and
  // renders as 31 Dec anywhere west of here. A New Year's Day that reads as the
  // previous year is the calendar bug this codebase has already paid for once.
  assert.equal(axisLabel('2026-01-01'), '1 Jan');
  assert.equal(axisLabel('2026-01-01', true), '1 Jan 2026');
  // Unreadable input is empty, never a guess and never "Invalid Date".
  assert.equal(axisLabel(null), '');
  assert.equal(axisLabel('nonsense'), '');
  assert.equal(axisLabel('2026-99-01'), '');
});

test('the axis ticks span the window, both ends included', async () => {
  const { tickIndices } = await load();
  const t = tickIndices(90);
  assert.equal(t[0], 0, 'the oldest day must be labelled');
  assert.equal(t[t.length - 1], 89, 'the newest day must be labelled');
  assert.ok(t.length >= 2 && t.length <= 5);
  // Degenerate windows must not throw or produce a NaN tick.
  assert.deepEqual(tickIndices(0), []);
  assert.deepEqual(tickIndices(1), [0]);
  assert.ok(tickIndices(2).every(Number.isInteger));
});

test('every chart carries dates, not just a shape', async () => {
  const { TrendChart } = await load();
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Heart rate', unit: 'bpm', dp: 0, days: bpDays(30), valueKey: 'heartRateMedian',
  }));
  // The complaint this answers: an x axis made entirely of position, so a dip
  // could be seen and never dated.
  assert.match(html, /hp-xtick/, 'no date axis was drawn');
  assert.match(html, /Sep/, 'the ticks carry no month');
  assert.match(html, /hp-axis/, 'no axis rule was drawn');
});

// ── Blood pressure is a pair ────────────────────────────────────────────────

test('blood pressure draws TWO lanes on one axis', async () => {
  const { TrendChart, TRENDS } = await load();
  const bp = TRENDS.find(t => t.key === 'bp');
  assert.ok(bp && bp.series && bp.series.length === 2, 'BP must be defined as a pair');

  const html = renderToString(React.createElement(TrendChart, {
    ...bp, days: bpDays(20), valueKey: bp.key,
  }));
  // Two paths, told apart by class — a chart that silently drew one line under a
  // legend naming two would look finished.
  assert.match(html, /hp-line hp-line--0/, 'systolic lane missing');
  assert.match(html, /hp-line hp-line--1/, 'diastolic lane missing');
  assert.match(html, /Systolic/);
  assert.match(html, /Diastolic/);
  // Spoken the way a blood pressure is spoken. React SSR puts comment markers
  // between adjacent text nodes, so the figure is read out of the stripped text
  // rather than matched against the raw markup.
  const text = html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ');
  assert.match(text, /median 14\d\/8\d/, 'the pair must read as sys/dia');
});

test('the two lanes share ONE scale', async () => {
  const { TrendChart } = await load();
  // Systolic ~150, diastolic ~88, each varying by only 1mmHg. On a SHARED axis
  // the two lanes sit in separate bands ~60mmHg apart. Normalised independently
  // each lane is stretched to fill the whole plot, so a 1mmHg wobble becomes the
  // full height and the two interleave — the gap between them, which is most of
  // what a blood pressure chart is read for, would be an artefact of the drawing.
  const days = Array.from({ length: 6 }, (_, i) => ({
    day: `2026-09-${String(10 + i).padStart(2, '0')}`,
    bpSystolic: 150 + (i % 2), bpDiastolic: 88 + (i % 2), complete: true,
  }));
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Blood pressure', unit: '', dp: 0, days,
    series: [{ key: 'bpSystolic', label: 'Systolic' }, { key: 'bpDiastolic', label: 'Diastolic' }],
  }));

  // Read each lane's own path, in render order: lane 0 systolic, lane 1 diastolic.
  const ysOf = (cls) => {
    const m = html.match(new RegExp('d="([^"]+)" class="hp-line hp-line--' + cls + '"'));
    assert.ok(m, `lane ${cls} was not drawn`);
    return [...m[1].matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(x => Number(x[1]));
  };
  const sys = ysOf(0);
  const dia = ysOf(1);
  assert.ok(sys.length >= 6 && dia.length >= 6, 'both lanes should have plotted points');

  // Higher pressure means a SMALLER y. On one scale every systolic point sits
  // above every diastolic point, with clear air between them.
  assert.ok(Math.max(...sys) < Math.min(...dia),
    'the lanes overlap — they have been scaled separately, not against one axis');
  assert.ok(Math.min(...dia) - Math.max(...sys) > 40,
    'the gap between systolic and diastolic has collapsed');
});

// ── Gaps stay gaps ──────────────────────────────────────────────────────────

test('a day with no reading breaks the line rather than being drawn through', async () => {
  const { TrendChart } = await load();
  // Live shape: blood pressure is missing 6-11 Sep and present either side,
  // because he was not taking readings. A line straight across that gap is the
  // chart telling a story nobody measured.
  const days = [
    { day: '2026-09-15', bpSystolic: 145, complete: true },
    { day: '2026-09-14', bpSystolic: 145, complete: true },
    { day: '2026-09-13', bpSystolic: null, complete: true },
    { day: '2026-09-12', bpSystolic: null, complete: true },
    { day: '2026-09-11', bpSystolic: 150, complete: true },
    { day: '2026-09-10', bpSystolic: 152, complete: true },
  ];
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Blood pressure', unit: '', dp: 0, days, valueKey: 'bpSystolic',
  }));
  const moves = (html.match(/d="M/g) || []).length;
  assert.equal(moves, 2, 'the gap must split the path into two runs');
  // And it must SAY the window is not fully covered.
  assert.match(html, /covered/, 'partial coverage went unreported');
});

test('a chart with nothing in it says so instead of drawing a flat line', async () => {
  const { TrendChart } = await load();
  const days = [{ day: '2026-09-15', complete: true }, { day: '2026-09-14', complete: true }];
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Blood pressure', unit: '', dp: 0, days, valueKey: 'bpSystolic',
  }));
  assert.match(html, /no readings/);
  assert.ok(!/hp-line/.test(html), 'a line was drawn over nothing');
});

// ── The trends list ─────────────────────────────────────────────────────────

test('the page charts everything Nick asked for', async () => {
  const { TRENDS } = await load();
  const keys = TRENDS.flatMap(t => (t.series ? t.series.map(s => s.key) : [t.key]));
  for (const want of ['bpSystolic', 'bpDiastolic', 'heartRateMedian', 'spo2']) {
    assert.ok(keys.includes(want), `${want} has no chart`);
  }
});

test('every charted key is one /api/health/history actually returns', async () => {
  // A series key that does not match the payload draws an empty chart and raises
  // nothing — the same shape as a reader outliving its writer, one layer up.
  const healthDaily = require('./health-daily');
  const shipped = new Set(Object.keys(healthDaily.fromRow({
    day: '2026-09-15', complete: 1,
  })));
  const { TRENDS } = await load();
  for (const t of TRENDS) {
    for (const s of (t.series ? t.series.map(x => x.key) : [t.key])) {
      assert.ok(shipped.has(s), `chart series "${s}" is not a field the API sends`);
    }
  }
});

// ── The short windows ───────────────────────────────────────────────────────
//
// Added 16 Sep 2026 with the Now / 24 hrs / 7 days control. These read
// `health_samples` bucketed rather than `health_daily`, so the charts are drawing
// a different statistic from a different table behind the same axis — which is
// exactly the kind of swap that has to be visible rather than inferred.

test('the page opens on 7 days', async () => {
  const { RANGES, DEFAULT_RANGE } = await load();
  assert.equal(DEFAULT_RANGE, '7d');
  const d = RANGES.find(r => r.id === DEFAULT_RANGE);
  assert.ok(d, 'the default names a range that does not exist');
  assert.equal(d.hours, 168, 'the default must be the sample-backed week, not 7 daily rows');
});

test('the control offers a snapshot, two sample windows and the rollups', async () => {
  const { RANGES } = await load();
  const ids = RANGES.map(r => r.id);
  assert.deepEqual(ids, ['now', '24h', '7d', '30d', '90d', '1y']);
  // ⚠ Each range must name exactly ONE source. A range carrying both `hours` and
  // `days` would make the fetch pick arbitrarily.
  for (const r of RANGES) {
    const hasHours = r.hours !== undefined;
    const hasDays = r.days !== undefined;
    assert.ok(hasHours !== hasDays, `${r.id} must be hours-backed or days-backed, not both`);
  }
  assert.equal(RANGES.find(r => r.id === 'now').hours, 0, 'Now must be the zero-hour snapshot');
});

test('an intraday axis carries TIMES, and a daily one carries dates', async () => {
  const { timeLabel } = await load();
  // ⚠ Local getters on purpose: a bucket is a true instant, and the browser is
  // in the reader's zone. This is the opposite case from a 'YYYY-MM-DD' key,
  // which is already wall-clock and must be sliced.
  const noon = new Date(2026, 8, 16, 14, 30, 0).getTime();
  assert.equal(timeLabel(noon), '14:30');
  assert.match(timeLabel(noon, { withDay: true }), /^\w{3} 14:30$/);
  assert.match(timeLabel(noon, { withDate: true }), /^16 Sep 14:30$/);
  assert.equal(timeLabel(NaN), '');
  assert.equal(timeLabel(null), '');
});

test('bucketed samples become rows NEWEST FIRST', async () => {
  // ⚠ TrendChart reverses its input, so oldest-first here would draw every short
  // window backwards in time and nothing else would look wrong.
  const { sampleRows } = await load();
  const t0 = Date.UTC(2026, 8, 16, 9, 0, 0);
  const rows = sampleRows({
    series: {
      heartRateMedian: [
        { t: t0, v: 70 }, { t: t0 + 3600000, v: 74 }, { t: t0 + 7200000, v: 78 },
      ],
    },
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].heartRateMedian, 78, 'the newest bucket must come first');
  assert.equal(rows[2].heartRateMedian, 70);
  assert.ok(rows[0].t > rows[2].t);
});

test('a missing bucket stays null through the adapter', async () => {
  const { sampleRows, TrendChart } = await load();
  const t0 = Date.UTC(2026, 8, 16, 9, 0, 0);
  const rows = sampleRows({
    series: {
      heartRateMedian: [
        { t: t0, v: 70 }, { t: t0 + 3600000, v: null }, { t: t0 + 7200000, v: 78 },
      ],
    },
  });
  assert.strictEqual(rows[1].heartRateMedian, null, 'an empty bucket must not become 0');
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Heart rate', unit: 'bpm', dp: 0, days: rows, valueKey: 'heartRateMedian',
    xLabel: (r) => String(r?.t || ''),
  }));
  assert.equal((html.match(/d="M/g) || []).length, 2, 'the gap must split the path');
});

test('an intraday chart SAYS it is not the daily median', async () => {
  const { TrendChart } = await load();
  const t0 = Date.UTC(2026, 8, 16, 9, 0, 0);
  const days = [2, 1, 0].map(i => ({ t: t0 + i * 3600000, heartRateMedian: 70 + i }));
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Heart rate', unit: 'bpm', dp: 0, days, valueKey: 'heartRateMedian',
    note: 'Every reading, as a 1-hour average',
    xLabel: (r) => String(r?.t || ''),
  }));
  // ⚠ The control swaps this chart between a daily median and a bucket average.
  // Unlabelled, the axis changes meaning in silence.
  assert.match(html, /hp-chart-note/, 'no statistic was named');
  assert.match(html, /1-hour average/);
});

test('every trend either has an intraday form or says why not', async () => {
  // A chart with no sample series renders a note; one with a series must be
  // backed by the service, or the short window draws blank and raises nothing.
  const healthSamples = require('./health-samples');
  const { TRENDS } = await load();
  for (const t of TRENDS) {
    assert.equal(typeof t.sample, 'boolean', `${t.key} does not declare an intraday form`);
    const keys = t.series ? t.series.map(s => s.key) : [t.key];
    for (const k of keys) {
      assert.equal(healthSamples.hasSeries(k), t.sample,
        `${k}: TRENDS says sample=${t.sample}, the service disagrees`);
    }
  }
});

// ── Now ─────────────────────────────────────────────────────────────────────

test('the snapshot shows a value with its age, never a bare number', async () => {
  const { LatestReadings } = await load();
  const now = Date.now();
  const html = renderToString(React.createElement(LatestReadings, {
    latest: {
      bpSystolic: { value: 151, at: new Date(now - 4 * 60000).toISOString() },
      bpDiastolic: { value: 90, at: new Date(now - 4 * 60000).toISOString() },
      heartRateMedian: { value: 74, at: new Date(now - 4 * 60000).toISOString() },
    },
  }));
  assert.match(html, /151\/90/, 'a blood pressure is read as a pair');
  assert.match(html, /4 min ago/, 'the age is the point — 74bpm now and last Tuesday differ');
  assert.match(html, /not recorded/, 'a metric with no reading must say so, not show a dash');
});

test('a stale reading is MARKED, never hidden and never shown as current', async () => {
  const { LatestReadings } = await load();
  const old = new Date(Date.now() - 6 * 3600000).toISOString();
  const html = renderToString(React.createElement(LatestReadings, {
    latest: { heartRateMedian: { value: 74, at: old } },
  }));
  assert.match(html, /hp-now-card--stale/, 'six hours old is not "now" for a heart rate');
  assert.match(html, /74/, 'and it must still be shown — hiding it makes a dead feed invisible');
});

test('staleness is judged PER METRIC, against each metric own cadence', async () => {
  // ⚠⚠ Caught on the live output, not by a test. A single 90-minute threshold
  // is wrong on three of the five cards, always towards a warning that is
  // permanently on — and an always-on warning is one nobody reads, which costs
  // the real catch. Resting heart rate is measured once or twice a DAY (median
  // gap 479 min on the live table), so eleven hours old is it working.
  const { LatestReadings } = await load();
  const elevenHours = new Date(Date.now() - 11 * 3600000).toISOString();
  const html = renderToString(React.createElement(LatestReadings, {
    latest: { rhrMedian: { value: 75, at: elevenHours } },
  }));
  assert.ok(!/hp-now-card--stale/.test(html),
    'a once-daily metric must not read as stale for behaving exactly as designed');

  // But a resting heart rate that has not arrived in three days HAS stopped.
  const threeDays = new Date(Date.now() - 72 * 3600000).toISOString();
  const stale = renderToString(React.createElement(LatestReadings, {
    latest: { rhrMedian: { value: 75, at: threeDays } },
  }));
  assert.match(stale, /hp-now-card--stale/, 'three days is a feed that has stopped');
});

test('every card declares its own staleness window', async () => {
  // A card falling through to the default is a card nobody measured a cadence
  // for — and the default is deliberately generous, so the miss is silent.
  const { NOW_CARDS } = await load();
  for (const c of NOW_CARDS) {
    assert.ok(Number.isFinite(c.staleAfterMin) && c.staleAfterMin > 0,
      `${c.id} has no measured staleness window`);
  }
});

test('a pair is dated by its OLDER half', async () => {
  // ⚠ Taking the newer would present a systolic from two minutes ago and a
  // diastolic from yesterday as one coherent reading.
  const { LatestReadings } = await load();
  const now = Date.now();
  const html = renderToString(React.createElement(LatestReadings, {
    latest: {
      bpSystolic: { value: 151, at: new Date(now - 2 * 60000).toISOString() },
      bpDiastolic: { value: 90, at: new Date(now - 30 * 3600000).toISOString() },
    },
  }));
  // The AGE is the direct pin — it must describe the older half, whatever the
  // staleness threshold happens to be.
  assert.match(html, /30h ago/, 'the pair was dated by its newer half');
  assert.ok(!/2 min ago/.test(html), 'the newer half must not date the pair');
  assert.match(html, /hp-now-card--stale/, 'and past its own window it is marked');
});

test('an empty snapshot says so rather than rendering an empty grid', async () => {
  const { LatestReadings } = await load();
  const html = renderToString(React.createElement(LatestReadings, { latest: {} }));
  assert.match(html, /No readings have arrived yet/);
});
