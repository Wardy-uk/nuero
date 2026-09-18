'use strict';

/**
 * The "due over the next 7 days" chart on State of Play, actually rendered.
 *
 * A vite build proves the panel compiles, not that a bar was drawn — and the
 * honesty of this chart is entirely in what it shows BESIDE the bars. A week of
 * seven columns over a backlog of 46 open tasks, 3 of them undated and some
 * already late, is a picture that can be completely accurate and still leave
 * the reader with the wrong idea.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'StateOfPlay.jsx');

// Shaped exactly as `snapshot().tasks.dueAhead` returns it. Friday 18 Sep, so
// the weekend falls at index 1–2 — matching the live store on the day it built.
const DUE = {
  from: '2026-09-18',
  to: '2026-09-24',
  total: 16,
  busiest: 6,
  days: [
    { key: '2026-09-18', dow: 5, weekend: false, isToday: true, count: 6 },
    { key: '2026-09-19', dow: 6, weekend: true, isToday: false, count: 0 },
    { key: '2026-09-20', dow: 0, weekend: true, isToday: false, count: 0 },
    { key: '2026-09-21', dow: 1, weekend: false, isToday: false, count: 3 },
    { key: '2026-09-22', dow: 2, weekend: false, isToday: false, count: 1 },
    { key: '2026-09-23', dow: 3, weekend: false, isToday: false, count: 2 },
    { key: '2026-09-24', dow: 4, weekend: false, isToday: false, count: 4 },
  ],
};

let DueAhead;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [PANEL],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport default { apiUrl };', loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  DueAhead = mod.exports.DueAhead;
  assert.ok(DueAhead, 'DueAhead must be exported for this test to reach it');
});

const render = (props) => renderToString(React.createElement(DueAhead, {
  data: DUE, overdue: 0, noDueDate: 3, onNavigate: () => {}, ...props,
}));

test('positive control — seven columns with their counts', () => {
  const html = render();
  assert.match(html, /Due over the next 7 days/);
  const bars = html.match(/sop-due-col/g) || [];
  assert.equal(bars.length, 7, 'one column per day, weekends included');
  assert.match(html, /Fri/);
  assert.match(html, /Sat/);
});

test('⚠⚠ what the bars CANNOT show is rendered beside them, not omitted', () => {
  // A chart of 16 bars over a backlog of 46 open tasks is not a picture of the
  // week's work. Both blind spots must be on screen.
  const html = render({ overdue: 4, noDueDate: 3 });
  assert.match(html, /already overdue/);
  assert.match(html, /no due date/);
  assert.match(html, /not on this chart/, 'and it says plainly that they are absent from it');
});

test('⚠ the overdue chip renders at ZERO too — "nothing late" is the fact worth seeing', () => {
  const html = render({ overdue: 0 });
  assert.match(html, /already overdue/);
  assert.ok(!/sop-due-chip-bad/.test(html), 'but it is not coloured when nothing is late');
});

test('⚠ amber appears ONLY when something really is overdue', () => {
  assert.match(render({ overdue: 3 }), /sop-due-chip-bad/);
});

test('⚠ a zero day draws NO bar — a sliver would read as "one task"', () => {
  const html = render();
  const bars = html.match(/sop-due-bar/g) || [];
  // Five of the seven days have work; Sat and Sun have none.
  assert.equal(bars.length, 5);
});

test('⚠ a weekend is SHOWN, never dropped', () => {
  // Dropping it would compress the week and make the run to Friday look
  // shorter than it is.
  const html = render();
  assert.match(html, /sop-due-weekend/);
  assert.match(html, /Sun/);
});

test('today is marked', () => {
  assert.match(render(), /sop-due-today/);
});

test('⚠ it STATES and never grades the day', () => {
  const html = render({ overdue: 9, noDueDate: 30 }).toLowerCase();
  for (const word of ['overloaded', 'too many', 'busy day', 'heavy', 'light week', 'you should', 'warning:']) {
    assert.ok(!html.includes(word), `the chart must not editorialise about workload ("${word}")`);
  }
});

test('⚠ it names WHOSE tasks it counts — Microsoft ones are not in this table', () => {
  // Measured 18 Sep 2026: Microsoft held 3 overdue tasks this panel cannot see.
  // The chart must not imply it is showing everything Nick owes.
  assert.match(render(), /NEURO/);
});

test('⚠ dates are SLICED, never parsed — a UTC-midnight Date renders the day before', () => {
  const fs = require('fs');
  const src = fs.readFileSync(PANEL, 'utf8');
  const fn = src.slice(src.indexOf('function DueAhead'), src.indexOf('export default function StateOfPlay'));
  assert.ok(fn.includes('.slice('), 'positive control — the label really is built by slicing');
  assert.ok(
    !/new Date\s*\(/.test(fn),
    'a YYYY-MM-DD key is already a wall-clock fact; parsing it re-applies an offset'
  );
  assert.match(render(), /18 Sep/);
});

test('a missing or empty payload renders nothing rather than an empty frame', () => {
  assert.equal(render({ data: null }), '');
  assert.equal(render({ data: { days: [] } }), '');
});

test('the accessible label carries the numbers, so the chart is not colour-and-height alone', () => {
  const html = render();
  assert.match(html, /aria-label="Tasks due per day: Fri 6, Sat 0/);
});
