'use strict';

/** Next steps page, a REAL render via esbuild (3 Nov 2026). */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SRC = path.resolve(__dirname, '..', '..', 'frontend', 'src');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, 'components', 'NextStepsPage.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onResolve({ filter: /\/EmailCard$/ }, () => ({ path: 'EmailCard', namespace: 'stub' }));
        build.onResolve({ filter: /\/openVault$/ }, () => ({ path: 'openVault', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents:
          a.path === 'api' ? 'export const apiUrl = (p) => p;'
            : a.path === 'EmailCard' ? 'export function CalendarBar() { return null; }'
              : 'export function openInVault() {}' }));
      },
    }],
  });
  const m = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
  return mod;
}

const data = {
  ok: true, complete: false, gaps: ['1-2-1s: unreadable'],
  items: [
    { id: 'report:2026-11-02', kind: 'report', group: 'now', sphere: 'work', title: 'Send the Monday report to Chris', why: 'Past the midday deadline.', minutes: 5, start: { label: 'Start', view: 'weekly-risk' } },
    { id: 'task:7', kind: 'task', group: 'today', sphere: 'life', title: 'Book the MOT', why: 'Due today', minutes: 30, start: { label: 'Start', view: 'todos' } },
  ],
  snoozed: [{ id: 'email:x', kind: 'email', group: 'today', sphere: 'work', title: 'Reply to Lucy', why: '', snoozedUntil: '2026-11-04T08:00:00Z', snoozeReason: 'too-big', start: { label: 'Open', view: 'inbox' } }],
};

test('grouped rows with the three choices; an unread source is said, never an all-clear', async () => {
  const { NextStepsView } = await load();
  const html = renderToString(React.createElement(NextStepsView, { data, filter: 'all', setFilter() {}, highlight: 'task:7', onStart() {}, onChanged() {} })).replace(/<!-- -->/g, '');
  assert.match(html, /NEEDS YOU NOW · 1/);
  assert.match(html, /TODAY · 1/);
  assert.ok(html.indexOf('Monday report') < html.indexOf('Book the MOT'), 'now before today');
  assert.match(html, /Snooze ▾/);
  assert.match(html, /Not today/);
  assert.match(html, /Couldn’t read: 1-2-1s: unreadable/);
  assert.match(html, /isn’t an all-clear/);
  assert.match(html, /is-highlighted/);
});

test('filters cut, never re-rank; snoozed shows the way back', async () => {
  const { NextStepsView } = await load();
  const life = renderToString(React.createElement(NextStepsView, { data, filter: 'life', setFilter() {}, onStart() {}, onChanged() {} })).replace(/<!-- -->/g, '');
  assert.match(life, /Book the MOT/);
  assert.doesNotMatch(life, /Monday report/);
  const sn = renderToString(React.createElement(NextStepsView, { data, filter: 'snoozed', setFilter() {}, onStart() {}, onChanged() {} })).replace(/<!-- -->/g, '');
  assert.match(sn, /Reply to Lucy/);
  assert.match(sn, /Bring it back/);
  assert.match(sn, /too big/);
});
