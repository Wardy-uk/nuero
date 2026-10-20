'use strict';

/**
 * The triage run draws only the fields a task is missing, offers "none" where
 * it should, and turns answers into the right writes for each owner.
 *
 * A real render via esbuild (a vite build proves it compiles, not that a
 * control was drawn), plus the pure `buildWrites`, which is where a NEURO task
 * and a Microsoft task part ways.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// The last test requires task-order, which loads the DB module — never the
// live one. Set BEFORE any require (database.js fixes its path on first load).
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-triagerender-')), 'a.db');

const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const FILE = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'TaskTriage.jsx');

let TaskTriage;
let buildWrites;
let NONE;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [FILE],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport default { apiUrl };', loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  TaskTriage = mod.exports.default;
  buildWrites = mod.exports.buildWrites;
  NONE = mod.exports.NONE;
  assert.ok(TaskTriage && buildWrites, 'positive control: exports exist');
});

const render = (todos) => renderToString(React.createElement(TaskTriage, { todos, onClose: () => {} })).replace(/<!-- -->/g, '');

test('only the missing fields are drawn', () => {
  const html = render([{ task_id: 7, text: 'Write the SOP', triage: { missing: ['estimate', 'due'] } }]);
  assert.match(html, /Estimate/);
  assert.match(html, /Due date/);
  assert.match(html, /No date/);
  assert.match(html, /No estimate/);
  assert.doesNotMatch(html, /MoSCoW/);
  assert.doesNotMatch(html, /Neither/);
  assert.match(html, /1 of 1/);
});

test('MoSCoW is drawn with its hotkeys and no "none" option', () => {
  const html = render([{ task_id: 8, text: 'Rate me', triage: { missing: ['moscow'] } }]);
  assert.match(html, /Must/);
  assert.match(html, /Won/);
  assert.doesNotMatch(html, /No priority|No estimate|No date|Neither/);
});

test('a Microsoft task says where each answer goes', () => {
  const html = render([{ ms_id: 'AAk', source: 'MS Planner', text: 'Board card', triage: { missing: ['due'] } }]);
  assert.match(html, /due date goes to Planner/);
});

test('rows with nothing missing are not queued', () => {
  const html = render([{ task_id: 9, text: 'Done already', triage: { missing: [] } }, { task_id: 10, text: 'x', triage: null }]);
  assert.match(html, /Nothing needs triage/);
});

test('NEURO writes: values on the row, nones appended to what was there', () => {
  const w = buildWrites(
    { task_id: 5, triageNone: ['origin'] },
    { moscow: 'must', priority: 3, estimate: 60, due: NONE, origin: undefined },
  );
  assert.equal(w.kind, 'neuro');
  assert.deepEqual(w.body, { moscow: 'must', priority: 3, estimateMinutes: 60, triageNone: ['origin', 'due'] });
});

test('Microsoft writes: private fields local, the date to Graph', () => {
  const w = buildWrites({ ms_id: 'AAk' }, { estimate: 30, origin: 'commitment', due: '2026-11-03', priority: NONE });
  assert.equal(w.kind, 'ms');
  assert.deepEqual(w.local, { estimateMinutes: 30, origin: 'commitment', none: ['priority'] });
  assert.equal(w.due, '2026-11-03');
  // "No date" on a Microsoft task is a private answer, never a Graph write.
  const n = buildWrites({ ms_id: 'AAk' }, { due: NONE });
  assert.equal(n.due, null);
  assert.deepEqual(n.local, { none: ['due'] });
});

test('the task list keys and bands match the server', async () => {
  const taskOrder = require('./task-order');
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'TodoPanel.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'leaflet'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport const apiFetch = () => Promise.resolve({});\nexport default { apiUrl };', loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const rows = [
    { task_id: 3, moscow: 'must' }, { ms_id: 'AAk=', moscow: 'could' },
    { filePath: 'Daily/x.md', moscow: null }, { task_id: 4, meta: { moscow: 'wont' } },
  ];
  for (const r of rows) {
    assert.equal(mod.exports.orderKeyOf(r), taskOrder.keyFor(r));
    assert.equal(mod.exports.bandOfRow(r), taskOrder.bandOf(r));
  }
});
