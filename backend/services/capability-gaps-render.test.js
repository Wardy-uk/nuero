'use strict';

/**
 * Does the "What I could do for you" card show the three answers that let a
 * suggestion exist — and keep "couldn't read" apart from "nothing to suggest"?
 *
 * A REAL render via esbuild of `CapabilityView` (the container fetches in
 * useEffect, which renderToString never runs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const CARD = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'CapabilityGaps.jsx');
let View;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [CARD], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({});', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.CapabilityView;
});

const noop = () => {};
const html = (props) => renderToString(React.createElement(View, { busy: false, onRefresh: noop, onDecide: noop, ...props })).replace(/<!-- -->/g, '');

const item = {
  id: 'cap:1', status: 'open', title: 'Fit a temperature sensor in the bedroom',
  unlocks: 'Whether a warmer bedroom costs you sleep.',
  changes: 'You would set the heating overnight on evidence.',
  need: { kind: 'sensor', what: 'A Zigbee temperature sensor', how: 'Pair it in HA', effort: 'small' },
  anchorText: [{ id: 'miss:1', kind: 'miss', text: 'he asked "what temperature was the bedroom last night?"' }],
};

test('a card renders the anchor, what it unlocks, what changes and what is needed', () => {
  assert.ok(View, 'CapabilityView must be exported');
  const h = html({ data: { ok: true, known: true, open: [item], decided: [], lastRun: { at: '2026-10-13T08:20:00Z', ok: true, proposed: 3, kept: 1, refused: ['x'] } } });
  assert.match(h, /I could:.*warmer bedroom/);
  assert.match(h, /So you could:.*heating overnight/);
  assert.match(h, /I need:.*Zigbee/);
  assert.match(h, /I couldn’t answer/);
  assert.match(h, /1 refused for lack of evidence/);
});

test('an unreadable store is never rendered as "nothing to suggest"', () => {
  const h = html({ data: { ok: false, known: false, why: 'the capability store is unreadable', open: [], decided: [] } });
  assert.match(h, /Couldn’t read/);
  assert.doesNotMatch(h, /Nothing open/);
  const h2 = html({ data: null, error: '502 Bad Gateway' });
  assert.match(h2, /not “nothing to suggest”/);
});

test('never thought yet says so, and a failed run is named', () => {
  assert.match(html({ data: { ok: true, known: true, open: [], decided: [], lastRun: null } }), /haven’t thought about this yet/);
  assert.match(html({ data: { ok: true, known: true, open: [], decided: [], lastRun: { at: '2026-10-13T08:20:00Z', ok: false, why: 'could not ask: budget' } } }), /didn’t finish: could not ask: budget/);
});
