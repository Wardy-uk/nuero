'use strict';

/**
 * The UAT volunteers card, rendered for real (esbuild + renderToString) from
 * the GET /api/uat shape. It renders UatVolunteersView — the container fetches
 * in useEffect, which renderToString never runs — and a source scan pins that
 * PeopleBoard actually mounts the container.
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
    entryPoints: [path.join(SRC, 'UatVolunteers.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)(api|directAction)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiFetch = () => {}; export const executeDirect = () => {}; export const directOutcome = () => ({});',
          loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.UatVolunteersView;
});

const noop = () => {};
const draw = (props) => renderToString(React.createElement(View, {
  onInvite: noop, onSendReply: noop, onSwap: noop, onDismiss: noop, onRetry: noop, ...props,
})).replace(/<!-- -->/g, '');

const SESSION = { date: '2026-10-28', start: '09:00', end: '10:00', feature: 'Anniversary in the AFE', location: 'Scrum room', dayWords: 'Wednesday 28 October' };
const ROTA = [
  { id: 'tier2dd', label: 'Tier 2 / Digital Design', members: [{ name: 'Isabel Busk', last: null, times: 0, hasEmail: true }, { name: 'Luke Scaife', last: null, times: 0, hasEmail: true }] },
  { id: 'cc', label: 'Customer Care', members: [{ name: 'Heidi Power', last: null, times: 0, hasEmail: true }] },
];
const round = (over) => ({
  id: 1, status: 'proposed', unclearWhy: null, session: SESSION, from: { name: 'Dan Short', email: 'dan.short@nurtur.tech' }, subject: 'UAT Request',
  pools: [
    { id: 'tier2dd', label: 'Tier 2 / Digital Design', current: { id: 1, person: 'Isabel Busk', status: 'proposed', why: 'never put forward' }, earlier: [] },
    { id: 'cc', label: 'Customer Care', current: { id: 2, person: 'Heidi Power', status: 'proposed', why: 'never put forward' }, earlier: [] },
  ],
  toInvite: 2, unfilled: [], reply: null, ...over,
});

test('picks show who, why, a Swap control and one Send button', () => {
  const html = draw({ data: { rounds: [round()], rota: ROTA } });
  assert.match(html, /UAT Wednesday 28 October, 09:00–10:00/);
  assert.match(html, /Isabel Busk/);
  assert.match(html, /never put forward/);
  assert.match(html, /Send 2 invites/);
  assert.match(html, /Swap…/);
});

test('waiting on answers: no send button; the reply-by time shows', () => {
  const r = round({ status: 'inviting', toInvite: 0 });
  r.pools[0].current = { id: 1, person: 'Isabel Busk', status: 'sent', deadlineAt: '2026-10-26T17:30:00Z' };
  r.pools[1].current = { id: 3, person: 'Zoe Rees', status: 'confirmed' };
  r.pools[1].earlier = [{ person: 'Heidi Power', status: 'declined' }];
  const html = draw({ data: { rounds: [r], rota: ROTA } });
  assert.doesNotMatch(html, /Send \d|Send the invite/);
  assert.match(html, /reply by/);
  assert.match(html, /Heidi Power \(declined\)/);
  assert.doesNotMatch(html, /Swap…/); // nobody swappable once asked
});

test('ready: the reply to Dan is shown in full with one Send button', () => {
  const r = round({ status: 'ready', toInvite: 0, reply: { status: 'prepared', action: { actionId: 'pa_1', draft: { body: 'Hi Dan,\n\nI\'m putting forward Isabel Busk and Zoe Rees.' } } } });
  const html = draw({ data: { rounds: [r], rota: ROTA } });
  assert.match(html, /Reply to Dan Short/);
  assert.match(html, /Isabel Busk and Zoe Rees/);
  assert.match(html, /Send reply/);
});

test('an unread request says so and offers Try again; a read failure is never an empty list', () => {
  const html = draw({ data: { rounds: [round({ status: 'unclear', session: null, unclearWhy: 'no readable start time' })], rota: ROTA } });
  assert.match(html, /could not read it: no readable start time/);
  assert.match(html, /Try again/);
  const err = draw({ data: null, error: 'HTTP 500' });
  assert.match(err, /Couldn&#x27;t read UAT rounds|Couldn't read UAT rounds/);
});

test('PeopleBoard mounts the card', () => {
  const src = fs.readFileSync(path.join(SRC, 'PeopleBoard.jsx'), 'utf8');
  assert.match(src, /import UatVolunteers from '\.\/UatVolunteers'/);
  assert.match(src, /<UatVolunteers \/>/);
});
