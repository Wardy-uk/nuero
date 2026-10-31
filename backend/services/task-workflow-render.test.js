'use strict';

/**
 * The Task workflow screen (31 Oct 2026) — REAL renders of the shared
 * TaskWorkflowView (esbuild + react-dom/server). Everything that left the Keep
 * my word card lives here, in order: header (+ the focus clock for THIS task),
 * Next (the delivery note and the prepared move with the shell's save slot),
 * the task's tools (the shell's slot — TaskAgent + TaskContext), evidence.
 * A task that is not a promise has a header and its tools only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const plugins = [{ name: 'css', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
} }];
async function bundle(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins, logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const text = (h) => h.replace(/<!-- -->/g, '');
let W;
test.before(async () => { W = await bundle(path.join(ROOT, 'saim', 'shared-ui', 'TaskWorkflow.jsx')); });

const THREAD = {
  key: 'promise:31', taskId: 31, label: 'Keeping your word', title: 'Send Hope the onboarding checklist', owedTo: 'Hope Goodall',
  due: { label: 'Due Tuesday 3 November', say: 'due within two days' },
  preparation: { state: 'needs-a-draft', label: 'Needs a draft', why: 'It is a message to one person; nothing is drafted yet.' },
  evidence: [{ kind: 'due', fact: 'Due Tuesday 3 November — the date set on the task.' }, { kind: 'source', fact: 'From “Leadership”: Nick will send Hope the onboarding checklist.' }],
  because: ['due within two days (Tuesday 3 November)', 'no time is booked for it'],
  held: null,
  draft: { key: 'promise:31', say: 'SAiM can prepare a delivery note for your approval. Nothing will be sent.', control: 'Draft the delivery note', sendingOff: null, review: 'Review it…' },
  move: { state: 'needs-decision', ref: 'promise:promise:31', recordId: 'pm_9', version: 2, say: 'Prepared — it needs your decision.' },
};

test('a promise task: header, Next (delivery + move with the save slot), tools slot with its id, evidence — in that order', () => {
  const tools = []; const saves = [];
  const h = text(renderToString(React.createElement(W.TaskWorkflowView, {
    data: { ok: true, task: { id: 31, text: 'Send Hope the onboarding checklist' }, thread: THREAD },
    onBack: () => {}, onOpenTask: () => {}, onStart: () => {}, onPrepareDelivery: async () => ({ ok: true }), onPromiseMove: async () => ({}),
    renderPromiseSave: ({ recordId }) => { saves.push(recordId); return React.createElement('div', { className: 'stub-save' }, `SAVE ${recordId}`); },
    renderTools: ({ taskId }) => { tools.push(taskId); return React.createElement('div', { className: 'stub-tools' }, `TOOLS ${taskId}`); },
  })));
  assert.match(h, /<h1 class="twf__title">Send Hope the onboarding checklist<\/h1>/);
  assert.match(h, /Due Tuesday 3 November/);
  assert.match(h, /owed to Hope Goodall/);
  assert.match(h, />Back</);
  assert.match(h, />Open in Tasks</);
  assert.match(h, />Draft the delivery note<\/button>/, 'the delivery offer moved here');
  assert.match(h, /SAVE pm_9/, 'the prepared move’s save slot');
  assert.match(h, /TOOLS 31/, 'TaskAgent/TaskContext mount point');
  assert.deepEqual(tools, [31]); assert.deepEqual(saves, ['pm_9']);
  assert.match(h, /Nick will send Hope the onboarding checklist/, 'evidence');
  const at = (s) => h.indexOf(s);
  assert.ok(at('twf__title') < at('Draft the delivery note') && at('Draft the delivery note') < at('TOOLS 31') && at('TOOLS 31') < at('Evidence'), 'header → Next → tools → evidence');
  assert.match(h, />Start a focus session</, 'no session yet: a way to start one here too');
});

test('a task that is NOT a promise: header from the task row and tools — no Next, no evidence', () => {
  const h = text(renderToString(React.createElement(W.TaskWorkflowView, {
    data: { ok: true, task: { id: 77, text: 'Tidy the support macros', dueDate: '2026-11-05', moscow: 'should', status: 'open' }, thread: null },
    renderTools: ({ taskId }) => React.createElement('div', null, `TOOLS ${taskId}`),
    onPrepareDelivery: async () => ({ ok: true }), onPromiseMove: async () => ({}),
  })));
  assert.match(h, /Tidy the support macros/);
  assert.match(h, /Due 2026-11-05/);
  assert.match(h, /TOOLS 77/);
  assert.doesNotMatch(h, /Next for this promise|Evidence|delivery note|Keeping your word/);
});

test('the focus clock for THIS task: elapsed, Pause, That’s done; another task’s session is not this one’s clock', () => {
  const data = { ok: true, task: { id: 31, text: 'x' }, thread: null };
  const on = text(renderToString(React.createElement(W.TaskWorkflowView, { data, session: { taskId: 31, status: 'active', elapsedMinutes: 12, plannedMinutes: 30, plannedAssumed: true } })));
  assert.match(on, /12 min in/);
  assert.match(on, />Pause</); assert.match(on, />That’s done</); assert.match(on, />Stop for now</);
  const paused = text(renderToString(React.createElement(W.TaskWorkflowView, { data, session: { taskId: 31, status: 'paused', elapsedMinutes: 65 } })));
  assert.match(paused, /1 h 05 in/); assert.match(paused, />Resume</);
  const other = text(renderToString(React.createElement(W.TaskWorkflowView, { data, session: { taskId: 9, status: 'active', elapsedMinutes: 3 } })));
  assert.doesNotMatch(other, /3 min in/);
});

test('a start NEURO refused is said on the screen; a conflict asks to switch; read-only draws no control', () => {
  const data = { ok: true, task: { id: 31, text: 'x' }, thread: THREAD };
  const err = text(renderToString(React.createElement(W.TaskWorkflowView, { data, sessionNote: { message: 'NEURO answered 500, so no focus session was started.', error: true } })));
  assert.match(err, /no focus session was started/);
  const sw = text(renderToString(React.createElement(W.TaskWorkflowView, { data, conflict: { text: 'Weekly risk' }, onSwitch: () => {} })));
  assert.match(sw, /You’re on Weekly risk\. Switch to this\?/);
  assert.match(sw, />Switch to this</);
  const ro = text(renderToString(React.createElement(W.TaskWorkflowView, { data, readOnly: true, onStart: () => {}, onPrepareDelivery: async () => ({}), renderPromiseSave: () => 'SAVE' })));
  assert.doesNotMatch(ro, /<button[^>]*>(Draft the delivery note|Start a focus session|Pause)</);
  assert.doesNotMatch(ro, /SAVE/);
});

test('startTaskSession: 409 → the running task named; same task → already on it; error → said; force is passed', async () => {
  const { startTaskSession } = await import(require('url').pathToFileURL(path.join(ROOT, 'saim', 'shared-ui', 'startTask.mjs')).href);
  const calls = [];
  const call = (r) => async (p, o) => { calls.push({ p, o }); return r; };
  assert.deepEqual(await startTaskSession(call({ status: 409, body: { ok: false, session: { taskId: 5, text: 'Weekly risk' } } }), { taskId: 31 }), { ok: false, conflict: { text: 'Weekly risk' } });
  assert.equal((await startTaskSession(call({ status: 409, body: { ok: false, session: { taskId: 31, text: 'x' } } }), { taskId: 31 })).already, true);
  const e = await startTaskSession(call({ status: 400, body: { error: 'bad' } }), { taskId: 31 });
  assert.equal(e.ok, false); assert.equal(e.error, 'bad');
  await startTaskSession(call({ status: 200, body: { ok: true, session: {} } }), { taskId: 31, force: true });
  const last = calls[calls.length - 1];
  assert.equal(last.p, '/api/session/start'); assert.equal(last.o.method, 'POST'); assert.equal(last.o.body.force, true); assert.equal(last.o.body.taskId, 31);
});

test('the screen reads ONE route and the focus-session routes, and holds no send/approve call', () => {
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'TaskWorkflow.jsx'), 'utf-8');
  const paths = [...src.matchAll(/['`](\/api\/[^'`?$]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(paths)], ['/api/promises/workflow', '/api/session', '/api/session/finish', '/api/session/pause', '/api/session/resume']);
  assert.ok(!/approve|intent-grant|execute-direct/i.test(src.replace(/\/\/.*$/gm, '')));
});
