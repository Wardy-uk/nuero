'use strict';

/**
 * SAiM Next steps tab (3 Nov 2026), rendered for real (esbuild + renderToString)
 * from saim/app/src/views/NextSteps.jsx.
 *
 *  - rows grouped NEEDS YOU NOW / TODAY / THIS WEEK in the server's order;
 *  - an unread source is said, never an all-clear;
 *  - filters cut, never re-rank; snoozed rows carry "Bring it back";
 *  - a push's `nextStep` (or ?tab=next-steps&item=) names the row to open;
 *  - Start plans: act / calendar / a SAiM tab / NEURO desktop;
 *  - the tab is registered and in SAIM_LITE_TABS, and the kiosk menu leaves it out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const data = {
  ok: true, contract: 'next-steps-v1', count: 3, complete: false, gaps: ['1-2-1s: unreadable'],
  items: [
    { id: 'report:2026-11-02', kind: 'report', group: 'now', sphere: 'work', title: 'Send the Monday report to Chris', why: 'Past the midday deadline.', minutes: 5, start: { label: 'Start', view: 'weekly-risk', context: null } },
    { id: 'task:7', kind: 'task', group: 'today', sphere: 'life', title: 'Book the MOT', why: 'Due today', minutes: 30, start: { label: 'Start', view: 'todos', context: { taskId: 7 } } },
    { id: 'email:abc', kind: 'email', group: 'week', sphere: 'work', title: 'Reply to Lucy', why: 'Waiting 2 days', minutes: null, start: { label: 'Add to calendar', view: 'inbox', context: null, action: 'add-to-calendar' }, calendar: { source: 'work', emailId: 'abc' } },
  ],
  snoozed: [{ id: 'email:x', kind: 'email', group: 'today', sphere: 'work', title: 'Reply to Suraj', why: '', minutes: null, snoozedUntil: '2026-11-04T08:00:00Z', snoozeReason: 'too-big', start: { label: 'Open', view: 'inbox', context: null } }],
};

let V;
let H;
test.before(async () => {
  V = await load('saim/app/src/views/NextSteps.jsx');
  H = await load('saim/app/src/nextSteps.mjs');
});

const render = (props) => renderToString(React.createElement(V.NextStepsView, { data, ...props })).replace(/<!-- -->/g, '');

test('grouped in the server order, three choices per row; a gap is not an all-clear', () => {
  const html = render({ filter: 'all', highlight: 'task:7' });
  assert.match(html, /NEEDS YOU NOW · 1/);
  assert.match(html, /TODAY · 1/);
  assert.match(html, /THIS WEEK · 1/);
  assert.ok(html.indexOf('Monday report') < html.indexOf('Book the MOT'), 'now before today');
  assert.ok(html.indexOf('Book the MOT') < html.indexOf('Reply to Lucy'), 'today before week');
  assert.match(html, /Snooze ▾/);
  assert.match(html, /Not today/);
  assert.match(html, /Add to calendar/);
  assert.match(html, /Couldn’t read: 1-2-1s: unreadable/);
  assert.match(html, /isn’t an all-clear/);
  assert.match(html, /class="ns-row is-highlighted" id="ns-task:7"/);
});

test('filters cut, never re-rank; snoozed shows Bring it back and the reason', () => {
  const life = render({ filter: 'life' });
  assert.match(life, /Book the MOT/);
  assert.doesNotMatch(life, /Monday report/);
  const quick = render({ filter: 'quick' });
  assert.match(quick, /Monday report/);
  assert.doesNotMatch(quick, /Book the MOT/);
  const sn = render({ filter: 'snoozed' });
  assert.match(sn, /Reply to Suraj/);
  assert.match(sn, /Bring it back/);
  assert.match(sn, /too big/);
  assert.doesNotMatch(sn, /Snooze ▾/);
});

test('Start plans: act, calendar, a SAiM tab, else NEURO desktop', () => {
  assert.deepEqual(H.startPlan({ start: { action: 'caught-up', view: 'inbox' } }), { kind: 'act', action: 'caught-up' });
  assert.deepEqual(H.startPlan({ start: { action: 'done-for-now', view: 'drafts' } }), { kind: 'act', action: 'done-for-now' });
  assert.deepEqual(H.startPlan({ start: { action: 'add-to-calendar', view: 'inbox' } }), { kind: 'calendar' });
  assert.deepEqual(H.startPlan({ start: { view: 'todos', context: { taskId: 7 } } }), { kind: 'tab', tab: 'tasks', context: { taskId: 7 } });
  assert.deepEqual(H.startPlan({ start: { view: 'meeting-prep' } }), { kind: 'tab', tab: 'prep', context: null });
  const url = H.startPlan({ start: { view: 'weekly-risk', context: { week: '2026-11-02', nested: { a: 1 } } } });
  assert.equal(url.kind, 'url');
  assert.equal(url.url, 'https://nuero.nickward.co.uk/?view=weekly-risk&week=2026-11-02');
});

test('a push names its row; a link names its row; nothing else does', () => {
  assert.equal(H.nextStepFromLaunch({ payload: { nextStep: 'task:7', type: 'todo' } }), 'task:7');
  assert.equal(H.nextStepFromLaunch({ tab: 'next-steps', item: 'email:abc' }), 'email:abc');
  assert.equal(H.nextStepFromLaunch({ tab: 'tasks', item: 'email:abc' }), null);
  assert.equal(H.nextStepFromLaunch({ payload: { type: 'todo' } }), null);
});

test('registered, in SAIM_LITE_TABS, wired into launch + push, and not in the kiosk menu', () => {
  const { resolveSaimLiteTab } = require('../../shared/action-surfaces.cjs');
  assert.equal(resolveSaimLiteTab({ tab: 'next-steps' }), 'next-steps');
  const tabs = fs.readFileSync(path.join(ROOT, 'saim/shared-ui/tabs.jsx'), 'utf8');
  assert.match(tabs, /id: 'next-steps'[^}]*Component: NextSteps/);
  const app = fs.readFileSync(path.join(ROOT, 'saim/app/src/App.jsx'), 'utf8');
  assert.match(app, /nextStepFromLaunch\(\{ tab, item, payload: raw \}\)/);
  assert.match(app, /nextStepFromLaunch\(\{ tab: data\.tab, item: data\.item, payload: data\.notificationData \}\)/);
  const sw = fs.readFileSync(path.join(ROOT, 'saim/app/src/sw.js'), 'utf8');
  assert.match(sw, /data\.nextStep \? 'next-steps'/);
  assert.match(sw, /searchParams\.set\('item', String\(data\.nextStep\)\)/);
  const kiosk = fs.readFileSync(path.join(ROOT, 'saim/frontend/src/App.jsx'), 'utf8');
  assert.match(kiosk, /const canShowTab = \(t\) => [^;]*t\.id !== 'next-steps'/);
});
