'use strict';

/**
 * Repeating tasks on the web, rendered for real (esbuild + renderToString):
 * the ↻ chip on a task row, the Repeat control on the open card with the rule's
 * words, its absence on a Microsoft task, and the "Done — next due" notice.
 * A vite build proves the panel compiles, not that any of this was drawn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiUrl = p => p;\nexport const apiFetch = async () => ({ ok: false, json: async () => ({}) });\nexport default { apiUrl };',
          loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let panel;
let control;
test.before(async () => {
  panel = await load('TodoPanel.jsx');
  control = await load('RepeatControl.jsx');
  assert.ok(panel.TodoItem, 'positive control: TodoItem exported');
  assert.ok(panel.RepeatNotice, 'positive control: RepeatNotice exported');
  assert.ok(control.default, 'positive control: RepeatControl exported');
});

const REPEATING = {
  id: 1, task_id: 448, text: 'Review the auto heating schedule', priority: 'normal', moscow: 'should',
  due_date: '2026-10-31', source: 'NEURO', done: 0,
  repeat: { kind: 'interval', every: 2, unit: 'week', anchor: '2026-10-31' },
  recurrenceLabel: 'Every 2 weeks', recurrence: null,
};

const itemProps = (todo, expanded) => ({
  todo, toggling: {}, onToggle: () => {}, expanded: expanded ? `task:${todo.task_id}` : null,
  onExpand: () => {}, onPatch: async () => {}, onRefresh: () => {},
});

test('a repeating task row shows the ↻ chip with its label', () => {
  const html = renderToString(React.createElement(panel.TodoItem, itemProps(REPEATING, false)));
  assert.match(html, /todo-recurring/);
  assert.match(html, /Every 2 weeks/);
});

test('a one-off task row shows no chip', () => {
  const html = renderToString(React.createElement(panel.TodoItem, itemProps({ ...REPEATING, repeat: null, recurrenceLabel: null }, false)));
  assert.doesNotMatch(html, /todo-recurring/);
});

test('the open card carries the Repeat control, opened on the task\'s own rule', () => {
  const html = renderToString(React.createElement(panel.TodoItem, itemProps(REPEATING, true)));
  assert.match(html, /Repeat<\/span>/);
  assert.match(html, /<option value="interval" selected="">/);
  assert.match(html, /Every 2 weeks(<!-- -->)? — fixed dates/);
});

test('the Repeat control renders each pattern in words, and "Doesn\'t repeat" when off', () => {
  const C = control.default;
  const r = (value) => renderToString(React.createElement(C, { value, onChange: () => {}, disabled: false }));
  assert.match(r(null), /<option value="" selected="">Doesn/);
  assert.match(r(JSON.stringify({ kind: 'weekdays', every: 1, days: ['mon', 'fri'] })), /Every Mon, Fri/);
  assert.match(r(JSON.stringify({ kind: 'nth-weekday', every: 1, nth: 1, weekday: 'mon' })), /First Monday of the month/);
  assert.match(r(JSON.stringify({ kind: 'last-working-day', every: 1 })), /Last working day of the month/);
});

test('value helpers: anchor is dropped going in, null stops repeating going out', () => {
  assert.equal(control.valueFromRule({ kind: 'interval', every: 2, unit: 'week', anchor: '2026-10-31' }),
    JSON.stringify({ kind: 'interval', every: 2, unit: 'week' }));
  assert.equal(control.valueFromRule(null), null);
  assert.equal(control.ruleFromValue(null), null);
  assert.deepEqual(control.ruleFromValue('{"kind":"last-working-day","every":1}'), { kind: 'last-working-day', every: 1 });
});

test('a Microsoft-linked task is not offered Repeat (Microsoft owns its schedule)', () => {
  const ms = { ...REPEATING, ms_id: 'AAMk-1', repeat: null, recurrenceLabel: null };
  const html = renderToString(React.createElement(panel.TodoItem, itemProps(ms, true)));
  assert.doesNotMatch(html, /aria-label="Repeat pattern"/);
});

test('after ticking, the notice says where it went and offers Undo', () => {
  const html = renderToString(React.createElement(panel.RepeatNotice, {
    notice: { notice: 'Done — next due Sat 14 Nov', nextDue: '2026-11-14', label: 'Every 2 weeks', text: 'Review the auto heating schedule', taskId: 448 },
    onUndo: () => {}, onDismiss: () => {},
  }));
  assert.match(html, /Done — next due Sat 14 Nov/);
  assert.match(html, />Undo</);
});
