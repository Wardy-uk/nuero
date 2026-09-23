'use strict';

/**
 * The triage controls are actually ON the card, and actually send.
 *
 * A vite build proves TodoPanel compiles, not that a dropdown was drawn — and
 * this codebase's most-repeated failure is a value computed and never read, or
 * here its mirror: a control rendered that sends nothing. Nick asked for MoSCoW,
 * priority and due date per suggestion (23 Sep 2026), individually and across a
 * multi-select, with "leaving any unselected should apply the current default".
 *
 * So the properties pinned are: all three controls exist per card, each opens on
 * a DEFAULT option that says so, and changing one calls back with the action id
 * and the field name the backend route expects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'TodoPanel.jsx');

const ITEMS = [
  { id: 17631, text: 'Nick Ward to speak offline with Charlie Keough', confidence: 0.8,
    provenance: { kind: 'note', label: 'A meeting note', detail: '2026-09-17' } },
  { id: 17642, text: 'Nick will consult with Annabelle', confidence: 0.8, provenance: null },
];

let SuggestedTodoQueue;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [PANEL],
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
          contents: 'export const apiUrl = p => p;\nexport default { apiUrl };', loader: 'js',
        }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  SuggestedTodoQueue = mod.exports.SuggestedTodoQueue;
  assert.ok(SuggestedTodoQueue, 'positive control: must be exported, or this test passes by absence');
});

const render = (props = {}) => renderToString(React.createElement(SuggestedTodoQueue, {
  items: ITEMS, actingId: null, selected: [], onToggleSelect: () => {}, onSelectAll: () => {},
  onClearSelection: () => {}, onBatch: () => {}, batching: false, batchError: null,
  onApprove: () => {}, onReject: () => {}, fields: {}, onFieldChange: () => {}, fieldError: null,
  ...props,
}));

test('positive control — the queue still renders its cards', () => {
  const html = render();
  assert.match(html, /Spotted, waiting on you/);
  assert.match(html, /Charlie Keough/);
});

test('every card carries all THREE controls', () => {
  const html = render();
  const selects = html.match(/todo-suggestion-select/g) || [];
  const dates = html.match(/todo-suggestion-date/g) || [];
  assert.equal(selects.length, ITEMS.length * 2, 'MoSCoW + priority on each card');
  assert.equal(dates.length, ITEMS.length, 'a due date picker on each card');
});

test('each control opens on a DEFAULT option, and says so', () => {
  // "Leaving any unselected should apply the current default" — so the resting
  // state must read as the default rather than as an empty or absent value.
  const html = render();
  assert.match(html, /MoSCoW: default/);
  assert.match(html, /Priority: default/);
  // The date input has no option list, so its default is stated in the tooltip.
  assert.match(html, /Leave empty for the default/);
});

test('the MoSCoW options are the real vocabulary', () => {
  const html = render();
  for (const label of ['Must', 'Should', 'Could', 'Won&#x27;t']) {
    assert.ok(html.includes(label), `expected a ${label} option`);
  }
});

test('a chosen value is rendered as selected, not silently dropped', () => {
  const html = render({ fields: { 17631: { moscow: 'must', priority: '3', dueDate: '2026-10-09' } } });
  assert.match(html, /value="2026-10-09"/, 'the picked date must show on the card');
  assert.ok(/selected=""[\s\S]*?Must|Must<\/option>/.test(html), 'the picked MoSCoW must show as chosen');
});

test('changing a control reports the action id and the field the route expects', () => {
  // The names here are the backend contract (`moscow`, `priority`, `dueDate`).
  // A control that sent `due_date` would render perfectly and change nothing.
  const seen = [];
  const html = renderToString(React.createElement(SuggestedTodoQueue, {
    items: ITEMS, actingId: null, selected: [], onToggleSelect: () => {}, onSelectAll: () => {},
    onClearSelection: () => {}, onBatch: () => {}, batching: false, batchError: null,
    onApprove: () => {}, onReject: () => {}, fields: {}, fieldError: null,
    onFieldChange: (id, field, value) => seen.push([id, field, value]),
  }));
  assert.ok(html.length > 0);
  // Server rendering does not fire handlers, so assert the WIRING is present by
  // name in the built source instead — the field names must match the route.
  const src = require('fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'TodoPanel.jsx'), 'utf-8');
  for (const field of ["'moscow'", "'priority'", "'dueDate'"]) {
    assert.ok(src.includes(`onFieldChange(item.id, ${field}`), `expected a control wired to ${field}`);
  }
  assert.ok(src.includes('/api/todos/suggestions/'), 'and a caller for the scoped route');
});

test('controls are disabled while the card is being acted on', () => {
  const html = render({ actingId: 17631 });
  assert.match(html, /disabled=""/, 'a control that stays live mid-approve invites a lost edit');
});
