'use strict';

/**
 * A REAL render of SAiM's Exertion card (saim/shared-ui/Exertion.jsx) — the one
 * the phone PWA, the kiosk and the Electron window all mount on Now.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SHARED = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(SHARED, 'Exertion.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{ name: 'css', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    } }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports.default;
}

test('she says the backend’s sentence verbatim, with the scale disclaimer', async () => {
  const E = await load();
  const html = renderToString(React.createElement(E, { data: {
    line: "Yesterday's exertion was 5.5 of 10, 3.5 so far today.",
    today: { zoneMinutes: [89, 9, 0, 0, 0], coveredMinutes: 1114, restHr: 74, maxHr: 158 },
  } }));
  assert.match(html, /Yesterday&#x27;s exertion was 5\.5 of 10, 3\.5 so far today\./);
  assert.match(html, /not Athlytic/);
  assert.match(html, /91 plus/);
});

test('no reading, no card — never a zero bar', async () => {
  const E = await load();
  assert.equal(renderToString(React.createElement(E, { data: null })), '');
  assert.equal(renderToString(React.createElement(E, { data: { line: null, today: null } })), '');
});
