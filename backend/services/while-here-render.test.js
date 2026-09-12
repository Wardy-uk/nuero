'use strict';

/**
 * Does the "while you're in here" band obey its own rules when it renders?
 *
 * `desktop-render.test.js` proves AdhdPanel MOUNTS (verified by mutation — a
 * temporal-dead-zone reference genuinely fails it). It does not exercise this
 * band with data, because `renderToString` does not run effects and the cohort
 * arrives from a fetch. So this mounts the component directly with the payload
 * the route actually returns.
 *
 * The rule worth pinning is the quiet one: on the live store 56 of 93 tasks
 * have no cohort, so "renders nothing" is the COMMON case. A band that always
 * says something is a band nobody reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'AdhdPanel.jsx');

const STUBS = {
  api: "export const apiFetch = async () => ({ ok: true, json: async () => ({}) });\nexport const apiUrl = p => p;\nexport default { apiFetch, apiUrl };",
  attention: "export default function () { return { loading: false, error: null, primary: null, secondary: [], dropped: [], gaps: [], contextCard: null, poolAvailable: true, act: async () => {}, refresh: () => {} }; }",
  card: 'export default function () { return null; }',
};

let WhileHere;

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
        build.onResolve({ filter: /useAttention$/ }, () => ({ path: 'attention', namespace: 'stub' }));
        build.onResolve({ filter: /(AttentionCard|FrictionSection)$/ }, () => ({ path: 'card', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  WhileHere = mod.exports.WhileHere;
  assert.ok(WhileHere, 'AdhdPanel exports WhileHere');
});

const PAYLOAD = {
  working: { known: true, kind: 'session', task: 'NT-24848: M&C Lead Source filter time out', taskIds: [242], why: 'you started a session on this' },
  best: {
    kind: 'jira', label: 'Jira tickets', count: 3, more: 0,
    tasks: [
      { id: 243, text: 'NT-27530: ESCALATION - no response since 7th' },
      { id: 244, text: 'NF-13740: Removal of Data Files' },
      { id: 267, text: 'NF-14121: CIA Envelope Report' },
    ],
  },
  cohorts: [], gaps: [],
};

// ⚠ React's server renderer puts `<!-- -->` between adjacent text nodes, so
// `{count} more` comes out as `3<!-- --> more` and a naive regex never matches.
// Stripping them is what makes these assertions about the WORDS on screen
// rather than about React's serialisation.
const render = props => renderToString(React.createElement(WhileHere, props)).split('<!-- -->').join('');

test('it names the cohort and lists the work', () => {
  const html = render({ data: PAYLOAD });
  assert.match(html, /Jira tickets/);
  assert.match(html, /3 more/);
  assert.match(html, /NF-13740/);
});

test('⚠ it SAYS what the suggestion is based on', () => {
  // A cohort with no premise is a fact from nowhere.
  assert.match(render({ data: PAYLOAD }), /you started a session on this/);
});

test('every row carries its task id, so he can quote it', () => {
  const html = render({ data: PAYLOAD });
  for (const id of ['#243', '#244', '#267']) assert.match(html, new RegExp(id));
});

test('⚠ NO COHORT RENDERS NOTHING — the common case, 56 of 93 live tasks', () => {
  assert.equal(render({ data: { working: { kind: 'app', why: 'at the laptop' }, best: null, cohorts: [], gaps: [] } }), '');
});

test('⚠ a failed read renders nothing rather than an error box', () => {
  assert.equal(render({ data: null }), '');
});

test('a truncated cohort says how many it did not list', () => {
  const big = { ...PAYLOAD, best: { ...PAYLOAD.best, count: 8, more: 4 } };
  assert.match(render({ data: big }), /and 4 more/);
});
