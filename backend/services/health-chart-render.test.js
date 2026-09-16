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
//
// ⚠ These pin RENDERING, not the freshness rule. The per-metric windows moved
// into `health-samples.js` on 16 Sep 2026 so every surface applies the same
// ones — see health-samples.test.js for the decision itself. What matters here
// is that the panel renders what the server decided and invents nothing.

const vital = (value, unit, ageMinutes, stale, extra = {}) => ({
  value, unit, ageMinutes, stale,
  at: new Date(Date.now() - ageMinutes * 60000).toISOString(),
  staleAfterMin: 30, ...extra,
});

test('the snapshot shows a value with its unit and age, never a bare number', async () => {
  const { LatestReadings } = await load();
  const html = renderToString(React.createElement(LatestReadings, {
    latest: { heartRateMedian: vital(74, 'bpm', 4, false) },
    bloodPressure: {
      known: true, systolic: 151, diastolic: 90, unit: 'mmHg',
      ageMinutes: 4, stale: false, at: new Date().toISOString(),
    },
  }));
  // React SSR puts comment markers between adjacent text nodes, so the pair is
  // read out of the stripped text rather than matched against raw markup.
  const text = html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(text.includes('151/90'), `a blood pressure is read as a pair — got: ${text}`);
  assert.match(html, /mmHg/, 'and carries its unit');
  assert.match(html, /74/);
  assert.match(html, /bpm/);
  assert.match(html, /4 min ago/, 'the age is the point — 74bpm now and last Tuesday differ');
  assert.match(html, /not recorded/, 'a metric with no reading says so, rather than showing a dash');
});

test('the panel renders the SERVER stale flag and does not second-guess it', async () => {
  // ⚠ The window is the server's. A panel applying its own would be a second
  // opinion about the same reading, which is how two surfaces come to disagree.
  const { LatestReadings } = await load();
  const stale = renderToString(React.createElement(LatestReadings, {
    latest: { heartRateMedian: vital(74, 'bpm', 360, true) },
  }));
  assert.match(stale, /hp-now-card--stale/, 'the server said stale and the panel hid it');
  assert.match(stale, /74/, 'and it must still be shown — hiding it makes a dead feed invisible');

  // The same age, but the server judged it fresh (a once-daily metric). The
  // panel must not override that with a threshold of its own.
  const fresh = renderToString(React.createElement(LatestReadings, {
    latest: { rhrMedian: vital(75, 'bpm', 360, false, { staleAfterMin: 36 * 60 }) },
  }));
  assert.ok(!/hp-now-card--stale/.test(fresh),
    'the panel applied its own threshold instead of the one on the reading');
});

test('an unknown age is never rendered as a clean timestamp', async () => {
  // ⚠ `stale: null` means "we cannot tell how old this is". Rendering that as a
  // tidy age is a stale value presenting as current with the evidence removed.
  const { LatestReadings } = await load();
  const html = renderToString(React.createElement(LatestReadings, {
    latest: { heartRateMedian: { value: 74, unit: 'bpm', ageMinutes: null, stale: null, at: null, note: 'no usable timestamp — age unknown' } },
  }));
  assert.match(html, /age unknown/);
  assert.ok(!/min ago|h ago|just now/.test(html), 'an unknown age was dressed up as a real one');
});

test('blood pressure is rendered from the PAIR, never reassembled from halves', async () => {
  // ⚠⚠ The panel has no access to individual halves — `latest` does not carry
  // them — so the wrong thing is impossible rather than merely discouraged.
  const { LatestReadings, NOW_CARDS } = await load();
  for (const c of NOW_CARDS) {
    assert.ok(!['bpSystolic', 'bpDiastolic'].includes(c.id),
      'a BP half is a card, so the panel can pair two unrelated measurements');
  }
  const html = renderToString(React.createElement(LatestReadings, {
    latest: { bpSystolic: vital(151, 'mmHg', 2, false), bpDiastolic: vital(90, 'mmHg', 900, true) },
    bloodPressure: { known: false, hasReadings: true, reason: 'readings exist, but no systolic and diastolic from the same measurement — no complete blood pressure is available' },
  }));
  // Even handed halves in `latest`, nothing may render as a blood pressure.
  const text = html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.ok(!text.includes('151/90'), 'the panel paired two unrelated measurements');
  assert.match(html, /no complete blood pressure is available/, 'and it must say why');
});

test('an empty snapshot says so rather than rendering an empty grid', async () => {
  const { LatestReadings } = await load();
  const html = renderToString(React.createElement(LatestReadings, { latest: {}, bloodPressure: { known: false, reason: 'no blood pressure has been recorded' } }));
  assert.match(html, /No readings have arrived yet/);
});


// ── An isolated reading is still a reading ──────────────────────────────────

test('a lone reading draws a DOT, not an invisible moveto', async () => {
  // ⚠⚠ The bug this pins blanked whole charts in silence. A run of one point is
  // `M x y` and nothing else, which SVG renders as NOTHING — and an isolated
  // reading is the NORMAL case for anything not sampled continuously. Measured
  // on the live 24-hour window when it was found: blood oxygen was 16 of 16
  // points isolated and drew COMPLETELY EMPTY, blood pressure showed one segment
  // out of 27, resting heart rate nothing at all — each under a heading stating
  // a median and a coverage percentage, so the numbers claimed data the plot
  // denied. Blood pressure on the 90-day view had it too: 4 scattered days, none
  // of them drawn.
  const { TrendChart } = await load();
  const days = [
    { day: '2026-09-16', spo2: 96 },
    { day: '2026-09-15', spo2: null },
    { day: '2026-09-14', spo2: 94 },
    { day: '2026-09-13', spo2: null },
    { day: '2026-09-12', spo2: 97 },
  ];
  const html = renderToString(React.createElement(TrendChart, {
    title: 'Blood oxygen', unit: '%', dp: 1, days, valueKey: 'spo2',
  }));
  const ds = [...html.matchAll(/ d="([^"]+)"/g)].map(m => m[1]).filter(d => d.startsWith('M'));
  assert.equal(ds.length, 3, 'three isolated readings should be three marks');
  for (const d of ds) {
    assert.match(d, /L/, `"${d}" has no drawable command — it renders as nothing`);
  }
});

test('every path a chart emits is drawable, on a real sparse payload', async () => {
  // The general form, over every trend at once: no chart may emit a path that
  // draws nothing. A per-series assertion would miss whichever series nobody
  // thought to check.
  const { TrendChart, TRENDS, sampleRows } = await load();
  // Shaped like the live 24-hour window: heart rate nearly continuous, blood
  // pressure and SpO2 scattered, resting heart rate a couple of readings.
  const t0 = Date.UTC(2026, 8, 16, 0, 0, 0);
  const series = {};
  const put = (key, every) => {
    series[key] = Array.from({ length: 144 }, (_, i) => ({
      t: t0 + i * 10 * 60000,
      v: i % every === 0 ? 70 + (i % 9) : null,
    }));
  };
  put('heartRateMedian', 1);
  put('bpSystolic', 5);
  put('bpDiastolic', 5);
  put('spo2', 9);
  put('rhrMedian', 70);
  put('hrvMedian', 3);
  put('steps', 4);
  put('exerciseMinutes', 17);
  put('daylightMinutes', 31);
  const rows = sampleRows({ series });

  let paths = 0;
  for (const t of TRENDS) {
    if (t.sample === false) continue;
    const html = renderToString(React.createElement(TrendChart, {
      ...t, days: rows, valueKey: t.key, xLabel: (r) => String(r?.t || ''),
    }));
    for (const d of [...html.matchAll(/ d="([^"]+)"/g)].map(m => m[1])) {
      if (!d.startsWith('M')) continue;
      paths++;
      assert.match(d, /L/, `${t.title} emitted an invisible path: ${d}`);
    }
  }
  assert.ok(paths > 50, `expected a sparse payload to produce many marks, got ${paths}`);
});
