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
 *  - both shells mount it; SAiM is read-only ONLY on the kiosk (the Electron
 *    desktop is Nick's own SAiM and shows it);
 *  - Save to vault / Copy / save status, the Claude handoff preview, the
 *    blocked state and the honest budget line.
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

test('both shells mount it: desktop on an open NEURO task; SAiM everywhere but the kiosk; both with the real save confirmation', () => {
  const desk = fs.readFileSync(path.join(ROOT, 'frontend/src/components/TodoPanel.jsx'), 'utf8');
  assert.match(desk, /<TaskAgent\s+taskId=\{todo\.task_id\}\s+call=\{desktopCall\}/);
  assert.match(desk, /\{!todo\.done && \(/);
  assert.match(desk, /renderSave=\{\(recordId, done\) => <PreparedMove call=\{desktopCall\} recordId=\{recordId\} embedded onChanged=\{done\} \/>\}/);
  const phone = fs.readFileSync(path.join(ROOT, 'saim/app/src/views/Tasks.jsx'), 'utf8');
  assert.match(phone, /readOnly=\{platformNow\(\) === 'kiosk'\}/, 'read-only on the kiosk ONLY');
  assert.doesNotMatch(phone, /platformNow\(\) !== 'phone-app'/, 'the Electron desktop is Nick’s own SAiM — never excluded');
  assert.match(phone, /renderSave=\{\(recordId, done\) => <PreparedMove call=\{agentCall\} recordId=\{recordId\} embedded onChanged=\{done\} \/>\}/);
  // Positive control: the shared component is what both import.
  assert.match(desk, /saim\/shared-ui\/TaskAgent\.jsx/);
  assert.match(phone, /shared-ui\/TaskAgent\.jsx/);
});

test('a finished output offers Save to vault and Copy; a waiting save says nothing is saved yet', () => {
  const run = base({ outputs: [{ id: 'o1', kind: 'plan', title: 'Q4 plan', markdown: '- x', next: { canSave: true }, save: null }] });
  const h = view(run, { onSave: noop, onCopy: noop });
  assert.match(h, /Save to vault…/);
  assert.match(h, />Copy</);
  assert.match(h, /The task stays open until you tick it/);
  const w = view(base({ outputs: [{ id: 'o1', kind: 'plan', title: 'Q4 plan', markdown: '- x', next: { canSave: true }, save: { recordId: 'pm_1', status: 'waiting' } }] }), { onSave: noop, onCopy: noop });
  assert.match(w, /Open the save confirmation/);
  assert.match(w, /waiting for your confirmation\. Nothing is saved yet/);
  const p = view(base({ outputs: [{ id: 'o1', kind: 'brief', title: 'B', markdown: '- x', next: { canSave: false, why: 'People / employment matter — NEURO never saves those as notes on its own.' } }] }), { onSave: noop });
  assert.doesNotMatch(p, /Save to vault/);
  assert.match(p, /never saves those as notes/);
});

test('the Claude handoff preview shows why, what is included, the statement and the editable prompt', () => {
  const preview = { why: 'Needs a code change.', destination: { project: 'NEURO', folder: 'Projects/NEURO' }, included: ['the task'], excluded: ['restricted notes'], statement: 'Nothing is sent to Claude until you press the button.', includeDrafts: false, sensitive: false, prompt: '# Task #7: Fix it' };
  const h = view(base({ claude: { recommended: true, why: 'Needs a code change.' } }), { onClaudeOpen: noop, claude: { preview, busy: false, error: null, result: null, onIncludeDrafts: noop, onSend: noop } });
  assert.match(h, /Better with Claude on desktop/);
  assert.match(h, /Why Claude:/);
  assert.match(h, /Project: (<!-- -->)?NEURO/);
  assert.match(h, /Nothing is sent to Claude until you press the button/);
  assert.match(h, /# Task #7: Fix it/);
  assert.match(h, /Continue this with Claude on desktop/);
  assert.match(h, /Include my drafts in full/);
  assert.match(h, /Also open Claude on my laptop/);
});

test('blocked says it could not take this further; the budget line is the server’s words', () => {
  const h = view(base({ status: 'blocked', summary: { completed: [], remaining: ['Nothing says what "the thing" is.'] } }), { budget: { say: 'Recorded by the AI gate in shadow mode. No Do this limit is set, so it is not budget-blocked by the gate.' } });
  assert.match(h, /Could not take this further/);
  assert.match(h, /the reason is the evidence/);
  assert.match(h, /not budget-blocked by the gate/);
});
