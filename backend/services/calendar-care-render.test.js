'use strict';

/**
 * Calendar care on Now (1 Nov 2026), rendered for real (esbuild → renderToString),
 * with a source scan that Now MOUNTS it. The exported view is rendered: the
 * container fetches in an effect, which renderToString never runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
let mod;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'CalendarCare.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)(api|directAction)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ json: async () => ({}) }); export const executeDirect = async () => ({}); export const directOutcome = () => ({});', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
});

const render = (data) => renderToString(React.createElement(mod.CalendarCareView, { data, reload: () => {} }));
const WEEK = { ok: true, week: { key: '2026-11-02', from: '2026-11-02', to: '2026-11-06' }, gaps: [],
  offer: { date: '2026-11-06', start: '2026-11-06T13:30', end: '2026-11-06T17:00', kind: 'afternoon', say: 'Your week is 68% meetings — protect Friday afternoon?', title: 'Protected — no meetings' } };
const AGENDA = { key: 'E@2026-11-06T16:00', eventId: 'E', start: '2026-11-06T16:00', subject: 'Support leadership', text: 'Agenda\n1. [first topic]', source: 'template', say: 'Add an agenda to “Support leadership”?' };
const SERIES = { key: 'series:M', title: 'Vendor sync', can: 'decline', next: '2026-11-10T10:00', say: 'You’ve missed the last 3 “Vendor sync”. Leave the series?',
  last: [{ start: '2026-10-27T10:00', evidence: { kind: 'declined', detail: 'you declined it' } }] };

test('positive control: the view and the card are exported', () => {
  assert.equal(typeof mod.CalendarCareView, 'function');
  assert.equal(typeof mod.default, 'function');
});

test('nothing to offer renders nothing', () => {
  assert.equal(render({ week: { ok: true, offer: null }, agendas: { offers: [] }, series: { offers: [] } }), '');
});

test('the three offers render with their presses; a template agenda with [gaps] cannot be added yet', () => {
  const html = render({ week: WEEK, agendas: { offers: [AGENDA] }, series: { offers: [SERIES] } });
  assert.match(html, /Your week is 68% meetings — protect Friday afternoon\?/);
  assert.match(html, />Protect</);
  assert.match(html, />Not this week</);
  assert.match(html, /Add an agenda to “Support leadership”\?/);
  assert.match(html.replace(/<!-- -->/g, ''), /Fill in or delete \[first topic\]/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Add agenda</);
  assert.match(html, />Decline future occurrences</);
  assert.match(html, />Remind me in a month</);
  assert.match(html, /you declined it/);
  const own = render({ week: { ok: true }, agendas: { offers: [] }, series: { offers: [{ ...SERIES, can: 'cancel' }] } });
  assert.match(own, />Cancel the series</);
  assert.doesNotMatch(own, /Decline future occurrences/);
});

test('Now mounts it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'AdhdPanel.jsx'), 'utf8');
  assert.match(src, /import CalendarCare from '\.\/CalendarCare'/);
  assert.match(src, /<CalendarCare \/>/);
});
