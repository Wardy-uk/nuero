'use strict';

/**
 * PLAUD transcripts page — month grouping, rendered for real (esbuild → renderToString).
 * The container fetches in useEffect, which renderToString never runs, so the pure
 * grouping and the exported row are what is exercised.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
let mod;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'PlaudTranscriptsPanel.jsx')],
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

const row = (date, extra = {}) => ({
  path: `Plaud/Transcripts/${date} x.md`, plaudId: date, title: `Meeting ${date}`, date,
  speakersNamed: true, segments: 3, speakers: ['Nick Ward'], unnamed: [], stub: false, repeated: false,
  summaries: ['Meetings/x.md'], archivedSummaries: [], summaryStatus: 'present', duplicateTranscripts: [], ...extra,
});

test('groups by month in row order, counting unnamed and summary-less per month', () => {
  const groups = mod.groupByMonth([
    row('2026-10-02'),
    row('2026-09-30', { unnamed: ['Speaker 2'] }),
    row('2026-09-08', { summaryStatus: 'none', summaries: [] }),
    row(null),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ['October 2026', 'September 2026', 'Undated']);
  assert.equal(groups[1].rows.length, 2);
  assert.equal(groups[1].unnamed, 1);
  assert.equal(groups[1].noSummary, 1);
});

test('a month is taken from the string, never shifted by a zone (1st of the month stays in it)', () => {
  assert.equal(mod.groupByMonth([row('2026-09-01')])[0].label, 'September 2026');
});

test('a row renders its speakers and summary state', () => {
  const html = renderToString(React.createElement(mod.TranscriptRow, {
    row: row('2026-09-08', { unnamed: ['Speaker 2'], speakers: ['Nick Ward', 'Speaker 2'] }),
    busy: null, outcome: null, onRefresh() {}, onArchive() {},
  }));
  assert.match(html, /1 of 2 named/);
  assert.match(html, /Repull/);
});

test('summary filters partition the list: present + archived + none = all', () => {
  const rows = [row('2026-10-01'), row('2026-10-02', { summaryStatus: 'archived', summaries: [] }), row('2026-10-03', { summaryStatus: 'none', summaries: [] })];
  const n = (f) => rows.filter((r) => mod.matchesFilter(r, f)).length;
  assert.equal(n('present') + n('archived') + n('none'), n('all'));
});
