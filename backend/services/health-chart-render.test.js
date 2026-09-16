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
