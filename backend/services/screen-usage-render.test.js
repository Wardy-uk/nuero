'use strict';

/**
 * Does the screen-usage heatmap obey its own rules when it actually renders?
 *
 * A vite build proves the panel COMPILES, not that a cell was drawn — and the
 * whole honesty of this panel lives in which mark a cell gets. The one thing it
 * must never do is draw an UNMEASURED week the same way it draws an EMPTY one,
 * and that distinction is a CSS class on a span: invisible to every other test
 * in this repo, and invisible to a build. So the component is mounted with the
 * payload the route actually returns and the output is read.
 *
 * ⚠ The sparse-series lesson from `health-chart-render.test.js` applies here
 * one form along: every number on this grid can be correct while the grid says
 * something false, and only rendering it shows that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'ScreenUsagePanel.jsx');

// The payload shape `GET /api/screen-usage` returns, with the three cell states
// present in one row: unknown (masked), zero, and real counts.
const WEEKS = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14'];
const hrs = (o) => Object.assign(new Array(24).fill(0), o);

const PAYLOAD = {
  generatedAt: '2026-09-18T09:00:00.000Z',
  window: { weeks: 4, from: WEEKS[0], to: '2026-09-20' },
  weeks: WEEKS,
  kinds: ['opened', 'interacted'],
  measures: {
    opened: 'times a screen was opened — not time spent on it',
    interacted: 'times a control on it was used — a screen you read and never click is not a screen that failed',
  },
  surfaces: [
    { id: 'neuro', label: 'NEURO', known: true, since: { opened: '2026-06-22', interacted: '2026-09-14' }, screens: 3, opens: 40, interactions: 90 },
    { id: 'saim', label: 'SAiM', known: true, since: { opened: '2026-09-14', interacted: '2026-09-14' }, screens: 1, opens: 6, interactions: 2 },
    { id: 'vantage', label: 'VANTAGE', known: false, reason: 'VANTAGE database not found at /mnt/data/vantage-data/vantage.db', screens: 0, opens: 0, interactions: 0, since: { opened: null, interacted: null } },
  ],
  rows: [
    // Worked in: opens AND interactions.
    { surface: 'neuro', screen: 'todos', opened: { total: 28, weeks: [8, 9, 10, 1], hours: hrs({ 9: 12, 14: 22 }), last: '2026-09-17' },
      interacted: { total: 90, weeks: [null, null, null, 90], hours: hrs({ 14: 90 }), last: '2026-09-17' } },
    // ⚠ READ, never clicked — the case the whole panel must not present as failure.
    { surface: 'neuro', screen: 'briefing', opened: { total: 12, weeks: [3, 3, 3, 3], hours: hrs({ 8: 12 }), last: '2026-09-17' },
      interacted: { total: 0, weeks: [null, null, null, 0], hours: hrs({}), last: null } },
    // Quiet on both.
    { surface: 'neuro', screen: 'strava', opened: { total: 0, weeks: [0, 0, 0, 0], hours: hrs({}), last: '2026-06-30' },
      interacted: { total: 0, weeks: [null, null, null, 0], hours: hrs({}), last: null } },
    { surface: 'saim', screen: 'surface', opened: { total: 6, weeks: [null, null, null, 6], hours: hrs({ 20: 6 }), last: '2026-09-17' },
      interacted: { total: 2, weeks: [null, null, null, 2], hours: hrs({ 20: 2 }), last: '2026-09-17' } },
  ],
  hourTotals: { opened: hrs({ 8: 12, 9: 12, 14: 22, 20: 6 }), interacted: hrs({ 14: 90, 20: 2 }) },
  excluded: { checkins: 4, outsideWindow: 0 },
  findings: [
    { severity: 'gap', surface: 'vantage', title: 'VANTAGE could not be read', detail: 'database not found' },
    { severity: 'note', surface: 'neuro', kind: 'interacted', title: 'NEURO interactions only recorded since 2026-09-14', detail: 'Earlier weeks are blank because nothing was watching, not because nothing happened.' },
    { severity: 'note', surface: 'neuro', kind: 'interacted', title: '1 NEURO screen was opened but never clicked', detail: 'Read, not worked — which for a dashboard or a briefing is the screen doing its job, not failing at it: briefing' },
  ],
  gaps: ['VANTAGE database not found at /mnt/data/vantage-data/vantage.db'],
};

const STUBS = {
  api: 'export const apiUrl = p => p;\nexport default { apiUrl };',
};

let Panel;
let html;

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
        build.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Panel = mod.exports.default;

  // `renderToString` runs no effects, so the fetch never happens — the panel is
  // driven by seeding the same state the fetch would set.
  global.fetch = async () => ({ ok: true, json: async () => PAYLOAD });
  const React2 = require('react');
  const originalUseState = React2.useState;
  let call = 0;
  React2.useState = (init) => {
    // The panel's first useState is `data`; seed it and let the rest behave.
    if (call++ === 0) return [PAYLOAD, () => {}];
    return originalUseState(init);
  };
  html = renderToString(React.createElement(Panel));
  React2.useState = originalUseState;
});

test('positive control — the grid actually rendered', () => {
  assert.match(html, /Screen usage/);
  assert.match(html, /su-cell/, 'no cells drawn at all — the harness is broken, not the panel');
  assert.match(html, /todos/);
  assert.match(html, /briefing/);
});

test('⚠⚠ an UNMEASURED week is drawn differently from an EMPTY one', () => {
  // The whole feature. SAiM has three null weeks and `strava` has four zeros;
  // if both render as the same mark, the grid says Nick never opened SAiM —
  // which is false, and is the most-used app in the estate.
  //
  // ⚠ THIS ASSERTION USED TO PASS ON THE LEGEND. The first cut was
  // `assert.match(html, /su-unknown/)`, which matched the KEY's own swatch —
  // so drawing every masked CELL as an empty one still passed, and the one
  // test written for the one rule that matters proved nothing. Caught by
  // mutation, not by reading. Assert on the pairing of class and title, which
  // only a real cell has.
  const cells = [...html.matchAll(/<span class="(su-cell [^"]+)" title="([^"]+)"/g)]
    .map(m => ({ cls: m[1], title: m[2] }));
  assert.ok(cells.length > 20, 'positive control — grid cells were found at all');

  const masked = cells.filter(c => /not measured/.test(c.title));
  const empty = cells.filter(c => /— 0 opens/.test(c.title));
  assert.ok(masked.length >= 3, 'positive control — the fixture really has masked cells');
  assert.ok(empty.length >= 4, 'positive control — and measured-but-empty ones');

  for (const c of masked) {
    assert.match(c.cls, /su-unknown/, `a cell that says "not measured" must not be drawn as one that was: ${c.title}`);
  }
  for (const c of empty) {
    assert.ok(!/su-unknown/.test(c.cls), `a measured zero must not be drawn as unmeasured: ${c.title}`);
    assert.match(c.cls, /su-none/);
  }
});

test('⚠ an unmeasured cell SAYS it was not measured, in words, on hover', () => {
  assert.match(
    html,
    /not measured; nothing was recording this yet/,
    'colour alone cannot carry this — the low end of the ramp is under 3:1 against the card'
  );
});

test('⚠ every cell carries its exact count — the contrast warning obliges visible values', () => {
  assert.match(html, /10 opens/);
  assert.match(html, /90 interactions/);
  assert.match(html, /1 open[^s]/, 'singular, so a single open does not read as "1 opens"');
});

test('⚠ an unreadable surface renders as a GAP naming why, never as an empty surface', () => {
  assert.match(html, /Couldn’t read it/);
  assert.match(html, /VANTAGE database not found/);
  assert.ok(!/VANTAGE<\/span><span class="su-surface-stat">0 screens/.test(html),
    'an unreadable surface must not be reported as one with zero screens');
});

test('⚠ a freshly instrumented surface says so on the panel, not just in the payload', () => {
  assert.match(html, /only recorded since/);
  assert.match(html, /nothing was watching, not because nothing happened/);
});

test('⚠⚠ a screen READ and never clicked is named as such, not left to look like failure', () => {
  // The single most misreadable thing on this page: Briefing has 4 controls and
  // TodoPanel has 99, so the interacted half will ALWAYS show the reading
  // screens near-empty. Beside a full accessed half that reads as an
  // indictment of the screens that work best.
  assert.match(html, /opened but never clicked/);
  assert.match(html, /doing its job, not failing at it/);
});

test('⚠ ACCESSED is on the left and INTERACTED WITH on the right, sharing one row label', () => {
  const accessed = html.indexOf('>Accessed<');
  const interacted = html.indexOf('>Interacted with<');
  assert.ok(accessed > -1 && interacted > -1, 'both column groups are present');
  assert.ok(accessed < interacted, 'accessed is kept on the LEFT, as asked');

  // One row label per screen, not one per grid — the comparison this answers
  // is about a single row, and repeating the name would split that sentence.
  const labels = html.match(/<span class="su-screen">todos<\/span>/g) || [];
  assert.equal(labels.length, 2, 'once in the week grid, once in the hour grid — never twice within one');
});

test('⚠⚠ each half states its OWN scale, because brightness must not be compared across', () => {
  // `TodoPanel` has 99 controls, so interaction counts dwarf every open count.
  // One shared scale would wash the accessed half out to nothing.
  const scales = [...html.matchAll(/busiest cell <!-- -->(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(scales.length >= 4, 'both grids declare a scale for both halves');
  assert.notDeepEqual(scales[0], scales[1], 'the two halves really are on different scales here');
  assert.match(html, /scaled to its own busiest\s+cell/);
  assert.match(html, /never across the divider/);
});

test('⚠ the divider is a real rule, not a gap — a two-scale grid must not read as one', () => {
  assert.match(html, /su-kind-split/);
});

test('⚠⚠ per-KIND masking survives to the screen: one row, full left, blank right', () => {
  // NEURO has opens since June and interactions since September. `todos` must
  // show real counts on the left and HATCHED cells on the right for the same
  // weeks — if the right half showed zeros it would read as "opened it
  // constantly, never touched a thing".
  const row = html.slice(html.indexOf('>todos<'), html.indexOf('>briefing<'));
  assert.ok(row.length > 200, 'positive control — the todos row was isolated');
  assert.match(row, /accessed · week of 24 Aug — 8 opens/, 'the accessed half has a real count');
  assert.match(row, /interacted with · week of 24 Aug — not measured/, 'the interacted half is unmeasured');
  assert.ok(
    !/interacted with · week of 24 Aug — 0 interactions/.test(row),
    'it must NOT read as a measured zero'
  );
});

test('⚠ it states what BOTH halves measure, and defends the reading screens', () => {
  assert.match(html, /not time spent on it/);
  assert.match(html, /not a screen that failed/,
    'the caveat that stops the interacted grid reading as a report card');
});

test('excluded check-ins are named rather than silently filtered', () => {
  assert.match(html, /4 location check-ins excluded/);
});

test('both grids render — by week AND by hour of day', () => {
  assert.match(html, /By week/);
  assert.match(html, /By hour of day/);
});

test('the legend is present, and only offers the unknown key when the grid has one', () => {
  assert.match(html, /Fewer/);
  assert.match(html, /More/);
  assert.match(html, /not measured/, 'this payload HAS masked cells, so the key is earned');
});

test('dates are SLICED, never parsed — a UTC-midnight Date renders the day before', () => {
  // `new Date('2026-09-14')` is midnight UTC and prints as the 13th WEST of
  // UTC. The BST bug, third repo.
  //
  // ⚠ ASSERTING THE RENDERED OUTPUT CANNOT CATCH THIS, and the first cut did
  // exactly that: it checked the header said "14 Sep", which is true in BST
  // whether the date is sliced or parsed, so replacing the slice with
  // `new Date(key)` passed. A test that only fails in a timezone nobody runs it
  // in is a test that never fails. The rule is zone-independent, so it is
  // asserted against the SOURCE — the same call `widget-source.test.js` makes.
  const src = fs.readFileSync(PANEL, 'utf8');
  const fn = src.slice(src.indexOf('function shortDate'), src.indexOf('function Legend'));
  assert.ok(fn.length > 40, 'positive control — shortDate was found in the source');
  assert.ok(fn.includes('.slice('), 'positive control — it really is built by slicing');
  assert.ok(
    !/new Date\s*\(/.test(fn),
    'shortDate must never construct a Date: a YYYY-MM-DD key is already a wall-clock fact, and parsing it re-applies an offset'
  );

  assert.match(html, /14 Sep/, 'and the column heading is the day the key names');
});
