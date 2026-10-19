'use strict';

/**
 * ORDERING, at the component the phone actually mounts (19 Oct 2026). With a
 * genuine Needs-you item on the feed, it is the first thing on the Surface and
 * the prepared move comes after it — a prepared move never outranks P0. This
 * renders the real shared `AttentionSurface` (and through it `Situation`), with
 * the real composer's presentation for a payload that carries an approval.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const SURFACE = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui', 'AttentionSurface.jsx');
let Surface;

test.before(async () => {
  global.window = global.window || { addEventListener() {}, removeEventListener() {}, location: { search: '' }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  const out = await esbuild.build({
    entryPoints: [SURFACE], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function Field() { return null; }\nexport const isPressing = () => false;\n', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Surface = mod.exports.default;
});

const PREPARED = React.createElement('section', { className: 'pm', 'aria-label': 'Something SAiM has prepared' }, 'PREPARED-MOVE-PROBE');
function render(id, prepared = PREPARED) {
  const f = FIXTURES.find((x) => x.id === id);
  const data = { ...f.payload, presentation: composePresentation(f.payload, { now: f.at }) };
  return { html: renderToString(React.createElement(Surface, { layout: 'situation', data, prepared })), data };
}
/** Positions of the visible items, in document order, after the situation line. */
function firstItems(html) {
  const marks = [];
  for (const [label, re] of [['needs-you', /aria-label="Needs you"/g], ['prepared', /PREPARED-MOVE-PROBE/g], ['primary', /sit__object--p1/g], ['next', /class="sit__next/g]]) {
    let m; while ((m = re.exec(html))) marks.push({ label, at: m.index });
  }
  return marks.sort((a, b) => a.at - b.at).map((x) => x.label);
}

test('with a genuine Needs-you item, it is the FIRST visible Surface item and the prepared move follows it', () => {
  const { html, data } = render('approval');
  assert.ok((data.presentation.needsYou || []).length >= 1, 'the fixture really carries a Needs-you item');
  const order = firstItems(html);
  assert.equal(order[0], 'needs-you', `first visible item must be Needs you, got: ${order.join(' > ')}`);
  assert.ok(order.indexOf('prepared') > order.indexOf('needs-you'), 'the prepared move comes after Needs you');
  assert.equal(order.filter((x) => x === 'prepared').length, 1, 'drawn once');
});

test('without a Needs-you item, the prepared move sits straight after the situation line, outside its live region', () => {
  const { html } = render('working-busy');
  const order = firstItems(html);
  assert.equal(order[0], 'prepared');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(!header.includes('PREPARED-MOVE-PROBE'), 'not inside the aria-live header');
});

test('a shell that passes no prepared move renders exactly as before', () => {
  const { html } = render('approval', null);
  assert.ok(!html.includes('sit__prepared'));
});
