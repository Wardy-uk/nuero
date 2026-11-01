'use strict';

/**
 * The People board's "Booked automatically · Undo" rows (1 Nov 2026), REALLY
 * rendered (esbuild + renderToString) from the exported view, not the fetching
 * container — renderToString never runs effects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const BOARD = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'PeopleBoard.jsx');
let View;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [BOARD], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p;\nexport const apiFetch = async () => ({});\nexport default { apiUrl };', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.AutoBookedView;
  assert.equal(typeof View, 'function', 'positive control: the view is exported');
});

const html = (props) => renderToString(React.createElement(View, props));
const item = { actionId: 'pa_1', person: 'Luke Scaife', when: 'Tue 3 Nov 14:00', eventId: 'EV-1', undone: false };

test('a booking made by the switch says so and offers Undo', () => {
  const h = html({ data: { ok: true, items: [item] } });
  assert.match(h, /Luke Scaife/);
  assert.match(h, /Tue 3 Nov 14:00/);
  assert.match(h, /Booked automatically/);
  assert.match(h, />Undo</);
});

test('an undone one says so and has no button', () => {
  const h = html({ data: { ok: true, items: [{ ...item, undone: true }] } });
  assert.match(h, /Booked automatically · undone/);
  assert.doesNotMatch(h, />Undo</);
});

test('nothing booked renders nothing; an unreadable list says so (never empty)', () => {
  assert.equal(html({ data: { ok: true, items: [] } }), '');
  assert.match(html({ data: { ok: false, error: 'db locked' } }), /Could not read/);
});
