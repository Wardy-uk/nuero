'use strict';

/**
 * The "Could go to Naomi — …" card (1 Nov 2026), REALLY rendered (esbuild +
 * renderToString) from the exported Suggestion view, plus a scan that the three
 * surfaces mount it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SRC = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');
let Suggestion;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, 'HandOver.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)(api|directAction)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p;\nexport const apiFetch = async () => ({ json: async () => ({}) });\nexport const executeDirect = async () => ({});\nexport const directOutcome = () => ({});', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Suggestion = mod.exports.Suggestion;
  assert.equal(typeof Suggestion, 'function', 'positive control: the view is exported');
});

const s = { id: 4, kind: 'task', itemId: '12', status: 'open', title: 'Reset the portal password', person: 'Naomi Wentworth', first: 'Naomi', email: 'naomi@nurtur.tech', why: 'she handles portal resets', line: 'Could go to Naomi — she handles portal resets', draft: { subject: 'x', body: 'What done looks like: [details]' }, blocker: null };

test('an open suggestion says who and why, with Hand over and Not this one', () => {
  const h = renderToString(React.createElement(Suggestion, { s, showTitle: true }));
  assert.match(h, /Could go to Naomi — she handles portal resets/);
  assert.match(h, /Reset the portal password/);
  assert.match(h, />Hand over</);
  assert.match(h, />Not this one</);
});

test('a person with no address cannot be handed to, and says why', () => {
  const h = renderToString(React.createElement(Suggestion, { s: { ...s, email: null, blocker: 'Naomi Wentworth has no email address in their People note' } }));
  assert.match(h, /has no email address/);
  assert.match(h, /disabled=""[^>]*>Hand over/);
});

test('a prepared hand-over waits for Sent Items instead of offering the buttons again', () => {
  const h = renderToString(React.createElement(Suggestion, { s: { ...s, status: 'prepared' } }));
  assert.match(h, /waiting for Sent Items/);
  assert.doesNotMatch(h, />Hand over</);
});

test('Now, the task card and the work email card mount it', () => {
  assert.match(fs.readFileSync(path.join(SRC, 'AdhdPanel.jsx'), 'utf8'), /<HandOverSection \/>/);
  assert.match(fs.readFileSync(path.join(SRC, 'TodoPanel.jsx'), 'utf8'), /<HandOverHint kind="task"/);
  assert.match(fs.readFileSync(path.join(SRC, 'EmailCard.jsx'), 'utf8'), /<HandOverHint kind="email"/);
});
