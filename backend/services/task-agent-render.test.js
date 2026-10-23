'use strict';

/**
 * "Do this" rendered for real (esbuild + renderToString) from the SAME component
 * the desktop task card and the phone task panel mount (23 Oct 2026).
 *
 *  - no run: the Do this button and what it will and will not do;
 *  - a question: ONE focused question, why it matters, its options, an answer box;
 *  - a manual step: "I've done it — carry on", not a free-text demand;
 *  - a people matter: says it stops at Nick's decision;
 *  - outputs, a handoff to Actions, sources with provenance, usage;
 *  - the kiosk (readOnly) renders NOTHING — no control and no output;
 *  - both shells mount it, the phone only as the phone app.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let TA;
test.before(async () => { TA = await load('saim/shared-ui/TaskAgent.jsx'); });
const noop = () => {};
const view = (run, extra = {}) => renderToString(React.createElement(TA.TaskAgentView, { run, busy: false, error: null, onStart: noop, onAnswer: noop, onStop: noop, onOpenActions: noop, onOpenNote: noop, ...extra }));
const base = (over = {}) => ({ id: 'ta-1', taskId: 7, status: 'ready', understanding: 'Plan Q4 cover.', sensitive: { sensitive: false, why: [] }, sources: [], steps: [], outputs: [], handoffs: [], question: null, answers: [], summary: null, usage: null, ...over });

test('no run: one Do this button, and what it will and will not do', () => {
  const h = view(null);
  assert.match(h, />Do this</);
  assert.match(h, /asks you only when it must/);
  assert.match(h, /sends, books and changes nothing without your confirmation/);
});

test('a question: one focused question, why, options and an answer box', () => {
  const h = view(base({ status: 'needs-answer', question: { id: 'q1', kind: 'ambiguity', question: 'Which report?', why: 'Different audiences.', options: ['Weekly risk', 'SOAP'] } }));
  assert.match(h, /Needs your answer/);
  assert.match(h, /Which report\?/);
  assert.match(h, /Why it matters: (<!-- -->)?Different audiences\./);
  assert.match(h, />Weekly risk</);
  assert.match(h, /Tell NEURO/);
  assert.equal((h.match(/tagent__qtext/g) || []).length, 1, 'exactly one question');
});

test('a manual step offers "I’ve done it — carry on"', () => {
  const h = view(base({ status: 'needs-manual', question: { id: 'q2', kind: 'manual', question: 'Open the wallboard.', why: 'NEURO cannot reach it.' } }));
  assert.match(h, /Only you can do this step/);
  assert.match(h, /I’ve done it — carry on/);
  assert.doesNotMatch(h, /Tell NEURO/);
});

test('a people matter says it stops at Nick’s decision', () => {
  const h = view(base({ status: 'needs-decision', sensitive: { sensitive: true, why: ['hr-wording'] }, question: { id: 'q3', kind: 'authority', question: 'What do you decide?', why: 'The decision is yours.' } }));
  assert.match(h, /Needs your decision/);
  assert.match(h, /stops at your decision/);
  assert.match(h, /will not contact anyone, promise anything or change anything/);
});

test('outputs, an Actions handoff, sources with provenance, and usage', () => {
  const h = view(base({
    outputs: [{ id: 'o1', kind: 'plan', title: 'Q4 plan', markdown: '- Week 47 swap' }],
    handoffs: [{ kind: 'prepared_action', actionId: 'pa_1', actionType: 'compose_email', status: 'prepared', say: 'Email to Jane Doe — prepared, not sent.' }],
    sources: [{ key: 'ctx:1', kind: 'note', title: 'Q4 rota notes', provenance: 'Linked by you.', path: 'P/x.md', used: true }, { key: 'ctx:2', kind: 'note', title: 'Leaver catch up', provenance: 'This task was raised in this note.', path: null, restricted: true, used: false }],
    summary: { completed: ['Drafted the plan'], remaining: ['Publish it'] },
    usage: { model: 'claude-sonnet-5', promptTokens: 3600, completionTokens: 900, costUsd: 0.0162 },
  }));
  assert.match(h, /Q4 plan/);
  assert.match(h, /private drafts — only you see these/);
  assert.match(h, /Ready for your confirmation/);
  assert.match(h, /Review on Actions/);
  assert.match(h, /prepared, not sent/);
  assert.match(h, /Q4 rota notes/);
  assert.match(h, /Linked by you\./);
  assert.match(h, /excerpt only/);
  assert.match(h, /Drafted the plan/);
  assert.match(h, /Publish it/);
  assert.match(h, /claude-sonnet-5 · 3,600 in · 900 out · about \$0\.0162/);
  assert.match(h, /Start a fresh attempt/);
});

test('the kiosk (readOnly) renders nothing at all', () => {
  const h = renderToString(React.createElement(TA.default, { taskId: 7, call: async () => ({ status: 200, body: { ok: true, run: base() } }), readOnly: true }));
  assert.equal(h, '');
});

test('both shells mount it: desktop on an open NEURO task, the phone only as the phone app', () => {
  const desk = fs.readFileSync(path.join(ROOT, 'frontend/src/components/TodoPanel.jsx'), 'utf8');
  assert.match(desk, /<TaskAgent taskId=\{todo\.task_id\} call=\{desktopCall\}/);
  assert.match(desk, /\{!todo\.done && \(/);
  const phone = fs.readFileSync(path.join(ROOT, 'saim/app/src/views/Tasks.jsx'), 'utf8');
  assert.match(phone, /<TaskAgent taskId=\{item\.task_id\} call=\{agentCall\} readOnly=\{platformNow\(\) !== 'phone-app'\} \/>/);
  // Positive control: the shared component is what both import.
  assert.match(desk, /saim\/shared-ui\/TaskAgent\.jsx/);
  assert.match(phone, /shared-ui\/TaskAgent\.jsx/);
});
