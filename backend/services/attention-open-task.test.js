'use strict';

/**
 * "Open" on a card about ONE task opens THAT task (Nick, 2 Oct 2026).
 *
 * It opened the task list on the overdue filter, which made him find the task
 * again by hand. TodoPanel already pins a row from taskId / msId / taskText;
 * the card never passed them. Bundled with esbuild so the REAL component's
 * routing is what is tested, not a copy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');

const CARD = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui', 'AttentionCard.jsx');
let taskDestination;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [CARD],
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
          contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });',
          loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  taskDestination = mod.exports.taskDestination;
  assert.equal(typeof taskDestination, 'function', 'AttentionCard exports taskDestination');
});

test('a NEURO task card opens that task by id', () => {
  const d = taskDestination({ type: 'todo', title: 'Review script and build the podcast', meta: { owner: { kind: 'neuro', taskId: 357 } } });
  assert.equal(d.view, 'todos');
  assert.equal(d.context.taskId, 357);
  assert.equal(d.label, 'Open task');
});

test('a Microsoft task card opens that task by ms id', () => {
  const d = taskDestination({ type: 'todo', title: 'Planner card', meta: { owner: { kind: 'microsoft', msId: 'AAMkX' } } });
  assert.equal(d.context.msId, 'AAMkX');
  assert.equal(d.context.taskId, undefined);
});

test('a SUMMARY card with no owner still opens the list, not a guessed task', () => {
  assert.equal(taskDestination({ type: 'todo', title: '3 high-priority tasks with no date', meta: { undatedHighCount: 3 } }), null);
});

test('a task-block meeting opens its first open task; a real meeting does not', () => {
  const d = taskDestination({ type: 'meeting', title: 'Task block: x', meta: { blockTaskIds: [357, 358] } });
  assert.equal(d.view, 'todos');
  assert.equal(d.context.taskId, 357);
  assert.equal(taskDestination({ type: 'meeting', title: 'Sprint planning', meta: { blockTaskIds: null } }), null);
});

// 6 Nov 2026: "Open context" on a capacity card went to State of Play — another
// list, with nothing more about the task. It opens THAT task's workflow screen.
test('a capacity card about one task opens that task, not State of Play', () => {
  const d = taskDestination({ type: 'capacity', title: '"Work context for NOVA" is overdue — 8h of work', meta: { taskId: 431, status: 'overdue' } });
  assert.equal(d.view, 'task');
  assert.equal(d.context.taskId, 431);
  assert.equal(d.label, 'Open task');
  // The overload card names no task and keeps its own destination.
  assert.equal(taskDestination({ type: 'capacity', title: 'More work due', meta: { by: '2026-11-06' } }), null);
});
