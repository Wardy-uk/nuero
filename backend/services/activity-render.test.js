'use strict';

/**
 * Build 15D — the Activity page, rendered for real (esbuild → renderToString),
 * on a payload built by the REAL normalisers, not a hand-written one. The
 * container fetches in useEffect, which renderToString never runs, so the
 * exported VIEW is what is rendered — with a positive control that it exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const tl = require('./activity-timeline');

const ROOT = path.join(__dirname, '..', '..');
let mod;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'canonical', 'ActivityPanel.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
      },
    }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
});

const T = '2026-10-06T10:';
const entries = [
  ...tl.fromFindings([{ finding_id: 'f', source_id: 'neuro.selftest', status: 'resolved', condition: 'failing', failure_count: 3, first_detected_at: `${T}14:00.000Z`, resolved_at: `${T}16:00.000Z`, resolution: 'recovered' }], { healedOutages: new Set(['f']) }),
  ...tl.fromSelfHeal([{ attempt_id: 'heal:f:retry-sync', source_id: 'neuro.selftest', status: 'recovered', authority: 'A1', op: 'run-selftest-sync', capability: 'source.retry-sync',
    requested_at: `${T}15:00.000Z`, started_at: `${T}15:00.000Z`, executed_at: `${T}15:10.000Z`, verified_at: `${T}16:00.000Z`, op_outcome: 'ok', outage_key: 'f', investigation_id: 'i',
    verification_json: JSON.stringify({ why: 'x', basis: { sourceState: 'healthy', freshness: 'fresh', findingActive: false } }) }]),
].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
const data = { entries, filters: tl.FILTERS, today: tl.summarise(entries), gaps: [], pending: tl.PENDING };
const render = (props) => renderToString(React.createElement(mod.ActivityView, { filter: 'all', setFilter: () => {}, reload: () => {}, ...props }));

test('positive control: the view is exported and renders', () => {
  assert.equal(typeof mod.ActivityView, 'function');
  assert.equal(typeof mod.default, 'function');
});

test('the core experience: noticed → retried (A1) → recovered after the retry, with Today NEURO on top', () => {
  const html = render({ data });
  assert.match(html, /Today NEURO/);
  assert.match(html, /fixed 1 low-risk problem/);
  assert.match(html, /NEURO noticed NEURO self-test was failing/);
  assert.match(html, /NEURO retried the NEURO self-test sync/);
  assert.match(html, />A1</);
  assert.match(html, /NEURO self-test recovered after the retry/);
  assert.ok(html.indexOf('recovered after the retry') < html.indexOf('NEURO noticed NEURO self-test'), 'newest first');
  assert.match(html, /iOS reliability update pending build/, 'deferred work is said, not hidden');
});

test('an empty day says so; a failed read is an ERROR, never "nothing happened"; a partial read names the gap', () => {
  const empty = render({ data: { ...data, entries: [], today: tl.summarise([]) } });
  assert.match(empty, /No autonomous actions today\./);
  assert.match(empty, /Nothing NEURO did in the last seven days/);
  const err = render({ data: null, error: '500', loading: false });
  assert.match(err, /Couldn’t read activity/);
  assert.doesNotMatch(err, /Nothing NEURO did/);
  const gap = render({ data: { ...data, gaps: [{ source: 'prepared_actions', why: 'locked' }] } });
  assert.match(gap, /Partly read: (<!-- -->)?prepared_actions(<!-- -->)? could not be read/);
});
