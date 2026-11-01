'use strict';

/**
 * "What NEURO did" — the page and the briefing section, rendered for real
 * (esbuild → renderToString). The container fetches in useEffect, which
 * renderToString never runs, so the exported VIEWS are rendered, with a
 * positive control that they exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const rep = require('./neuro-weekly-report');

const ROOT = path.join(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) }); export const apiUrl = (p) => p;', loader: 'js' }));
      },
    }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}

let page; let brief;
test.before(async () => { page = await load('NeuroDidPanel.jsx'); brief = await load('BriefingsPanel.jsx'); });

const misfires = rep.rankMisfires([
  { kind: 'suppression-spike', at: 'z', text: '30 “router_health” notifications held back (usual ~0 a week)', view: 'pi-health' },
  { kind: 'write-uncertain', at: 'a', text: 'microsoft.task.complete on task 9: NEURO does not know if it happened', view: 'activity' },
]);
const payload = {
  ok: true, known: true, week: { monday: '2026-10-26', sunday: '2026-11-01', partial: false, label: '26 Oct – 1 Nov' },
  headline: rep.headlineOf({ acted: 143, toCheck: 2 }), acted: 143, toCheck: 2, misfires, misfiresMore: 0,
  areas: [
    { id: 'outlook-archive', label: 'Outlook messages archived (muted senders)', view: 'inbox', acted: 140, stats: ['140 moved to Archive'],
      items: [{ text: '120 from admin@postmastery.net', view: 'inbox' }], more: 4 },
    { id: 'self-heal', label: 'Self-heal retries', view: 'activity', acted: 0, stats: ['0 tried'], items: [], more: 0 },
    { id: 'pushes', label: 'Notifications, by type', view: 'pi-health', informational: true, acted: 0, stats: ['63 sent'], items: [], more: 0 },
  ],
  gaps: [{ area: 'waiting-on', label: 'Waiting-on items set aside as lapsed', why: 'database disk image is malformed' }],
  notUsedYet: [{ area: 'focus-blocks', label: 'Focus blocks', why: 'not used yet' }],
  options: rep.weekOptions(Date.parse('2026-11-04T12:00:00Z')),
};

test('positive control: the views exist', () => {
  assert.equal(typeof page.NeuroDidView, 'function');
  assert.equal(typeof page.default, 'function');
  assert.equal(typeof brief.NeuroDidWeek, 'function');
});

test('the page: headline, misfires FIRST in the server order, gaps named, not-used-yet said, "and N more"', () => {
  const html = renderToString(React.createElement(page.NeuroDidView, { data: payload, week: '2026-10-26', setWeek: () => {}, onNavigate: () => {} }));
  assert.match(html, /NEURO acted 143 times last week — 2 to check/);
  const mis = html.indexOf('Misfires &amp; things to check');
  const area = html.indexOf('Outlook messages archived');
  assert.ok(mis > -1 && area > mis, 'misfires come before the areas');
  assert.ok(html.indexOf('does not know if it happened') < html.indexOf('router_health'), 'the server rank is kept');
  assert.match(html, /Couldn’t read:/);
  assert.match(html, /malformed/);
  assert.match(html, /Not used yet: Focus blocks/);
  assert.match(html, /and 4 more/);
  assert.match(html, /This week \(so far\)/);   // the week picker
  assert.match(html, /title="Open inbox"/);      // every line opens where to act
  assert.match(html, /Nothing this week: Self-heal retries/);  // a zero area is one line, not a card
  assert.ok(!/nd-area-self-heal/.test(html));
});

test('the page says "nothing to check" rather than an empty box', () => {
  const html = renderToString(React.createElement(page.NeuroDidView, { data: { ...payload, misfires: [], gaps: [] }, week: '', setWeek: () => {} }));
  assert.match(html, /Nothing to check\./);
});

test('the briefing section: headline, misfires, link to the page with the week; a failed read is not "nothing"', () => {
  const html = renderToString(React.createElement(brief.NeuroDidWeek, { r: payload }));
  assert.match(html, /What NEURO did for you/);
  assert.match(html, /NEURO acted 143 times/);
  assert.match(html, /does not know if it happened/);
  assert.match(html, /view=neuro-did&amp;week=2026-10-26/);
  assert.ok(!/Notifications, by type/.test(html), 'informational areas are not counted as acts');
  const bad = renderToString(React.createElement(brief.NeuroDidWeek, { r: { known: false, why: 'boom' } }));
  assert.match(bad, /not the same as “nothing”/);
});
