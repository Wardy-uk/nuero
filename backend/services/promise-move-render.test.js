'use strict';

/**
 * The held promise's answer interaction and the outstanding status line, as
 * REAL renders (esbuild + react-dom/server), plus the pure result mapper.
 *
 *   - the card offers ONE control ("Tell SAiM who it is owed to") and no
 *     "Open the task" when SAiM can take it forward;
 *   - the question is asked IN PLACE: one line of question, why, choice
 *     buttons, one text box and "Tell SAiM" — no select, fieldset or
 *     settings vocabulary;
 *   - read-only surfaces (kiosk) show the question and say where to answer;
 *   - "Needs your decision before I can schedule it" and "Scheduled for …"
 *     render differently, and a scheduled row offers no Show button.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const plugins = [{ name: 'stubs', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  b.onResolve({ filter: /^\.\.?\/api(\.js)?$/ }, () => ({ path: 'api', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({}); export const apiFetch = async () => ({});', loader: 'js' }));
} }];
async function bundle(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins, logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const text = (h) => h.replace(/<!-- -->/g, '');

let K; let PM;
test.before(async () => {
  K = await bundle(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx'));
  PM = await bundle(path.join(ROOT, 'saim', 'app', 'src', 'components', 'PreparedMove.jsx'));
});

const OWED_Q = { id: 'owed', question: 'Who is this owed to?', why: 'Your notes don’t name who it is owed to, so only you can say. SAiM won’t guess — name a person (their full name) or a group.', choices: [] };
const thread = (move) => ({
  key: 'promise:322', taskId: 322, title: 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02',
  label: 'Keeping your word', owedTo: null,
  due: { label: 'Due today', say: 'it is late' },
  preparation: { state: 'waiting-for-Nick', label: 'Waiting for you', why: 'Your notes don’t name who this is owed to.' },
  held: { say: 'No one is named as who this is owed to.' },
  evidence: [{ fact: 'From the Leadership meeting, 26 Aug.' }],
  move,
});
const render = (el) => text(renderToString(el));

test('the offer: ONE control, and no "Open the task" when SAiM can take it forward', () => {
  const h = render(React.createElement(K.KmwThread, { thread: thread({ state: 'offer', ref: 'promise:promise:322', control: 'Tell SAiM who it is owed to', question: OWED_Q }), actions: true, onOpen: () => {}, onPromiseMove: async () => ({}) }));
  assert.match(h, />Tell SAiM who it is owed to<\/button>/);
  assert.doesNotMatch(h, /Open the task/);
  // Before the press, the question is not yet shown.
  assert.doesNotMatch(h, /<input/);
  // A promise that needs time (not held) offers "Make this ready" — and still no "Open the task".
  const t = thread({ state: 'offer', ref: 'promise:promise:322', control: 'Make this ready', question: null });
  delete t.held; t.preparation = { state: 'needs-a-block', label: 'Needs time', why: 'It needs your time to finish.' };
  const h2 = render(React.createElement(K.KmwThread, { thread: t, actions: true, onOpen: () => {}, onPromiseMove: async () => ({}) }));
  assert.match(h2, />Make this ready<\/button>/);
  assert.doesNotMatch(h2, /Open the task/);
});

test('without a move, the old "Open the task" stays (nothing else can move it)', () => {
  const t = thread(null); delete t.held;
  const h = render(React.createElement(K.KmwThread, { thread: t, actions: true, onOpen: () => {} }));
  assert.match(h, /Open the task/);
});

test('the question, asked in place: question, why, one text box, "Tell SAiM" — not a settings page', () => {
  const h = render(React.createElement(K.KmwThread, { thread: thread({ state: 'ask', ref: 'promise:promise:322', recordId: 'pm_x', version: 2, question: OWED_Q }), actions: true, onOpen: () => {}, onPromiseMove: async () => ({}) }));
  assert.match(h, /<form class="kmw__ask"/);
  assert.match(h, /<label[^>]*>Who is this owed to\?<\/label>/);
  assert.match(h, /SAiM won’t guess/);
  assert.equal((h.match(/<input/g) || []).length, 1, 'one text box');
  assert.match(h, /maxLength="120"/);
  assert.match(h, /placeholder="A full name, or a group"/);
  assert.match(h, />Tell SAiM<\/button>/);
  assert.doesNotMatch(h, /<select|<fieldset|[Ss]ettings|[Pp]reference|Save changes/);
  assert.doesNotMatch(h, /Open the task/);
});

test('an ambiguous answer comes back as choices — buttons to pick, never a dropdown', () => {
  const q = { id: 'owed', question: 'Which Chris do you mean?', why: '“Chris” could be 2 people…', choices: ['Chris Middleton', 'Chris Smith'] };
  const h = render(React.createElement(K.KmwMove, { move: { state: 'ask', ref: 'promise:promise:322', recordId: 'pm_x', version: 3, question: q }, onPromiseMove: async () => ({}) }));
  assert.match(h, /Which Chris do you mean\?/);
  assert.match(h, /class="kmw__choice"[^>]*>Chris Middleton<\/button>/);
  assert.match(h, /class="kmw__choice"[^>]*>Chris Smith<\/button>/);
  assert.doesNotMatch(h, /<select/);
});

test('read-only (kiosk): the question shows, the box does not, and it says where to answer', () => {
  const h = render(React.createElement(K.KmwThread, { thread: thread({ state: 'ask', ref: 'promise:promise:322', recordId: 'pm_x', version: 2, question: OWED_Q }), actions: false }));
  assert.match(h, /Who is this owed to\?/);
  assert.doesNotMatch(h, /<input|>Tell SAiM</);
  assert.match(h, /Answer this in SAiM on your phone or desktop\./);
});

test('needs-decision on the card says nothing is booked; scheduled says when', () => {
  const nd = render(React.createElement(K.KmwMove, { move: { state: 'needs-decision', say: 'Prepared — it needs your decision before I can schedule it (I’d suggest Thursday 22 Oct, 09:00–09:30; nothing is booked yet). It’s on your SAiM home.' }, onPromiseMove: async () => ({}) }));
  assert.match(nd, /needs your decision before I can schedule it/); assert.match(nd, /nothing is booked yet/);
  assert.doesNotMatch(nd, /<button/);
  const sc = render(React.createElement(K.KmwMove, { move: { state: 'scheduled', say: 'Scheduled for Thursday 22 Oct, 09:00–09:30 — your time to finish it is booked.' } }));
  assert.match(sc, /Scheduled for Thursday 22 Oct, 09:00–09:30/);
});

test('KmwMove sends only prepare(ref) and answer(recordId, version, questionId, text) — nothing else', () => {
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx'), 'utf-8');
  const body = src.slice(src.indexOf('export function KmwMove'), src.indexOf('export function KmwThread'));
  assert.match(body, /\{ action: 'prepare', ref: move\.ref \}/);
  assert.match(body, /\{ action: 'answer', recordId: asking\.recordId, version: asking\.version, questionId: asking\.question\.id, text: t \}/);
  assert.doesNotMatch(body, /fetch\(|confirm|approve|send/i);
});

test('promiseMoveResult: ask / prepared / handoff / refused — a refused answer keeps the words', async () => {
  const { promiseMoveResult } = await import(pathToFileURL(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'promiseMove.mjs')).href);
  const ask = promiseMoveResult({ ok: true, move: { plan: 'ask', recordId: 'pm_a', recordVersion: 2, ask: { questions: [OWED_Q] }, prepared: { headline: 'I can take this forward — I need to know who it is owed to.' } } });
  assert.equal(ask.kind, 'ask'); assert.equal(ask.question.id, 'owed'); assert.equal(ask.version, 2);
  const prep = promiseMoveResult({ ok: true, move: { plan: 'draft', prepared: { headline: 'I drafted “Targets”.' } } });
  assert.equal(prep.kind, 'prepared'); assert.match(prep.say, /nothing is saved, booked or sent until you confirm/);
  const ho = promiseMoveResult({ ok: true, outcome: 'handoff', say: 'It is a message to Chris Middleton — SAiM can draft the delivery note for your approval instead. Nothing is sent.' });
  assert.equal(ho.kind, 'handoff'); assert.match(ho.say, /Nothing is sent/);
  const bad = promiseMoveResult({ ok: false, error: 'This move has changed.' }, { answering: true });
  assert.equal(bad.kind, 'refused'); assert.equal(bad.keep, true); assert.match(bad.message, /still in the box/);
  const savedThenRefused = promiseMoveResult({ ok: false, answered: true, error: 'Could not re-plan.' }, { answering: true });
  assert.equal(savedThenRefused.keep, false); assert.match(savedThenRefused.message, /Your answer was saved/);
});

test('"Also open": needs-decision and scheduled read differently; a scheduled row has no Show button', () => {
  const view = { outstanding: [
    { recordId: 'pm_1', title: 'Rota notes', state: 'needs-decision', say: 'Needs your decision before I can schedule it.' },
    { recordId: 'pm_2', title: 'Escalation notes', state: 'scheduled', say: 'Scheduled for Thursday 22 Oct 09:00–09:30; I can now make the next item ready.' },
    { recordId: 'pm_3', title: 'Renewal question', state: 'ready', say: 'Ready for you to confirm — nothing needs booking.' },
  ] };
  const h = render(React.createElement(PM.Outstanding, { view, onShow: () => {} }));
  assert.match(h, /Also open/);
  assert.match(h, /pmo2__alsoitem--needs-decision/); assert.match(h, /pmo2__alsoitem--scheduled/);
  assert.match(h, /Needs your decision before I can schedule it\./);
  assert.match(h, /Scheduled for Thursday 22 Oct 09:00–09:30; I can now make the next item ready\./);
  assert.equal((h.match(/>Show<\/button>/g) || []).length, 2, 'Show on the two that need Nick, not on the booked one');
  // Nothing open → nothing rendered: never a standing empty queue.
  assert.equal(render(React.createElement(PM.Outstanding, { view: { outstanding: [] } })), '');
});
