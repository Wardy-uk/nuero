'use strict';

/**
 * The Team cover card, rendered for real (esbuild + renderToString) from the
 * `teamCover` block of GET /api/nudges/availability. Renders TeamCoverView —
 * the container fetches in useEffect, which renderToString never runs — and a
 * source scan pins that Now and the People board both mount the container.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SRC = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');
let View;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, 'TeamCover.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = () => {};', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.TeamCoverView;
});

const render = (props) => renderToString(React.createElement(View, props));
const CLASH = {
  key: 'customercare:2026-11-03', pool: 'customercare', team: 'Customer Care', from: '2026-11-03', to: '2026-11-06', range: '3–6 Nov',
  people: ['Naomi Wentworth', 'Zoe Rees'], startsInDays: 2, severity: 'medium', includesYou: false,
  say: '2 of 6 off (33%) on Tue 3 Nov', action: 'Check cover for Customer Care on 3–6 Nov',
};
const GAP = "Adele Norman-Swift is not in NOVA's roster — their leave cannot be counted.";

test('a clash renders its team, dates, both numbers, the action and a link per person', () => {
  const html = render({ data: { known: true, rule: { minOff: 2, minShare: 0.4 }, clashes: [CLASH], gaps: [GAP] }, mode: 'now', onPerson: () => {} });
  assert.match(html, /Cover is thin/);
  assert.match(html, /Customer Care/);
  assert.match(html, /3–6 Nov/);
  assert.match(html, /2 of 6 off \(33%\)/);
  assert.match(html, /Check cover for Customer Care on 3–6 Nov/);
  assert.equal((html.match(/team-cover__person/g) || []).length, 2);
  assert.match(html, /approved leave only/);
  assert.match(html, /Adele Norman-Swift/);
});

test('Now renders nothing when there is no clash; the People board says what it could see', () => {
  const data = { known: true, rule: {}, clashes: [], gaps: [GAP] };
  assert.equal(render({ data, mode: 'now' }), '');
  const html = render({ data, mode: 'people' });
  assert.match(html, /No clashes among the people NEURO can see/);
  assert.match(html, /Adele Norman-Swift/);
});

test('unread leave is never rendered as an all-clear', () => {
  const html = render({ data: { known: false, clashes: [], gaps: ['Leave could not be read from NOVA (never fetched) — this is not "no clashes".'] }, mode: 'people' });
  assert.match(html, /not an all-clear/);
  assert.doesNotMatch(html, /No clashes/);
});

test('Now and the People board both mount the container', () => {
  const now = fs.readFileSync(path.join(SRC, 'AdhdPanel.jsx'), 'utf8');
  const people = fs.readFileSync(path.join(SRC, 'PeopleBoard.jsx'), 'utf8');
  assert.match(now, /<TeamCover mode="now"/);
  assert.match(people, /<TeamCover mode="people"/);
  assert.match('<TeamCover mode="now" />', /<TeamCover mode="now"/, 'positive control');
});
