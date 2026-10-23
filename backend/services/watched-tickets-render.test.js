'use strict';

/**
 * The Watched tickets section on the Escalations page (23 Oct 2026), rendered
 * for real (esbuild → renderToString), plus a scan that the page MOUNTS it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'frontend', 'src', 'components', 'EscalationPanel.jsx');
let mod;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [FILE],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p;', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
});

const noop = async () => true;
const render = (props) => renderToString(React.createElement(mod.WatchedTickets, {
  onWatch: noop, onRead: noop, onUnwatch: noop, onCheck: noop, ...props,
})).split("<!-- -->").join("");
const ticket = (over) => ({
  key: 'NT-1', summary: 'Portal down', status: 'In Progress', url: 'https://x/browse/NT-1', phase: 'active',
  baselineTaken: true, unread: 0, replies: [], lastError: null, ...over,
});

test('positive control: exported', () => { assert.equal(typeof mod.WatchedTickets, 'function'); });

test('an unread customer reply leads, with its words', () => {
  const html = render({ data: { active: [ticket({ unread: 2, replies: [{ author: 'Sam', created: '2026-10-22T09:00:00Z', excerpt: 'Still down for us', flagged: true }] })], listening: [] } });
  assert.match(html, /2 new replies/);
  assert.match(html, /Still down for us/);
  assert.match(html, /Mark read/);
});

test('a reply judged a thank-you says so; resolved tickets sit in the listening group', () => {
  const html = render({ data: { active: [], listening: [ticket({ phase: 'background', listeningUntil: '2026-11-05T23:59:59Z', replies: [{ author: 'Sam', created: '2026-10-22T09:00:00Z', excerpt: 'Thanks!', flagged: false }] })] } });
  assert.match(html, /Resolved — still listening/);
  assert.match(html, /judged a thank-you/);
  assert.match(html, /listening until/);
});

test('empty, a failed check and a failed load are three different things', () => {
  assert.match(render({ data: { active: [], listening: [] } }), /not watching any tickets/);
  assert.match(render({ data: { active: [], listening: [], lastRun: { ok: false, why: 'Jira timed out' } } }), /last check didn’t complete — Jira timed out/);
  const failed = render({ data: null, error: 'Could not load watched tickets' });
  assert.match(failed, /Could not load watched tickets/);
  assert.doesNotMatch(failed, /not watching any tickets/);
});

test('the Escalations page mounts it', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.match(src, /<WatchedTickets\b/);
});
