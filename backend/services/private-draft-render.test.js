'use strict';

/**
 * The private-draft repair, as REAL renders (esbuild + react-dom/server):
 *   - the promise card offers "Prepare a private working draft" with the plain
 *     statement of what SAiM will and won't do, and the two sentences
 *     ("can't carry out an employment action" / "can prepare a private draft")
 *     stay distinct; no "who is it owed to?" and no "Open the task";
 *   - an earlier owed-to answer shows with a way to remove it;
 *   - SAiM Home's prepared move carries the private label above everything;
 *   - the shared surface draws NO open button the shell says would do nothing
 *     ("Open State of Play" on the phone), and draws the linked one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const plugins = [{ name: 'stubs', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  b.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'fstub' }));
  b.onLoad({ filter: /.*/, namespace: 'fstub' }, () => ({ contents: 'export default function Field() { return null; }\nexport const isPressing = () => false;\n', loader: 'js' }));
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
const text = (h) => h.split('<!-- -->').join('');
const buttons = (h) => [...h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

let K; let PM; let AS;
test.before(async () => {
  global.window = global.window || { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), location: { search: '' } };
  K = await bundle(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx'));
  PM = await bundle(path.join(ROOT, 'saim', 'app', 'src', 'components', 'PreparedMove.jsx'));
  AS = (await bundle(path.join(ROOT, 'saim', 'shared-ui', 'AttentionSurface.jsx'))).default;
});

const PRIV = { label: 'Private draft for Nick — no decision made, nothing sent.', cannot: 'SAiM can’t carry out an employment action for this.', can: 'SAiM can prepare a private draft for you.', promise: 'SAiM will prepare a private draft for you. It will not make an employment decision, contact anyone, or send anything.' };
const THREAD = {
  key: 'promise:322', taskId: 322, title: 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02', label: 'Keeping your word', owedTo: null,
  due: { label: 'Due Friday 16 October', say: 'overdue' },
  preparation: { state: 'private-draft', label: 'Private draft', why: `${PRIV.cannot} ${PRIV.can}` },
  held: null, draft: null, evidence: [{ fact: 'From the weekly meeting, 1 Sep.' }],
  move: { state: 'offer', ref: 'promise:promise:322', control: 'Prepare a private working draft', say: PRIV.promise, question: null, privateDraft: PRIV,
    owedAnswer: { text: 'Me', ignored: true, say: 'Your earlier answer to “who is it owed to?” (“Me”) isn’t needed for a private draft, so SAiM doesn’t use it.', control: 'Remove that answer' } },
};

test('the promise card: one control, the plain statement, the two sentences kept distinct — no owed question, no "Open the task"', () => {
  const h = text(renderToString(React.createElement(K.KmwThread, { thread: THREAD, actions: true, onOpen: () => {}, onPromiseMove: async () => ({}) })));
  const b = buttons(h);
  assert.ok(b.includes('Prepare a private working draft'), JSON.stringify(b));
  assert.ok(!b.includes('Open the task'));
  assert.ok(!b.includes('Tell SAiM who it is owed to'));
  assert.doesNotMatch(h, /Who is this owed to\?/);
  assert.ok(h.includes(PRIV.label));
  assert.ok(h.includes(PRIV.promise), 'what pressing does, before the press');
  assert.ok(h.includes('SAiM can’t carry out an employment action for this. SAiM can prepare a private draft for you.'), 'can’t vs can, side by side');
  assert.ok(b.includes('Remove that answer'), 'the earlier "Me" can be removed');
  assert.match(h, /isn’t needed for a private draft/);
  assert.doesNotMatch(h, /owed to Me/);
});

test('read-only (kiosk): the statement shows, no button presses anything', () => {
  const h = text(renderToString(React.createElement(K.KmwThread, { thread: THREAD, actions: false })));
  assert.ok(h.includes(PRIV.label));
  assert.ok(!buttons(h).includes('Prepare a private working draft'));
  assert.ok(!buttons(h).includes('Remove that answer'));
});

test('SAiM Home: the prepared private draft carries its label first, and the can’t/can line', () => {
  const view = { move: {
    version: 2, recordId: 'pm_1', recordVersion: 1, kind: 'project-note', plan: 'draft', title: THREAD.title,
    prepared: { headline: 'I prepared a private draft for you — no decision made, nothing sent.', detail: null },
    privateDraft: PRIV, outcome: { goal: 'Think it through yourself.' }, why: { because: [], willNot: ['Make an employment decision, or present anything as one'] },
    evidence: [], freshness: [], deliverable: { title: 'x — private draft', sourceFacts: [], suggested: { label: PRIV.label, text: `# x\n> **${PRIV.label}**` }, gaps: ['What “achievable” means here'], path: 'Meetings/2026/09/x – Private draft.md' },
    options: [{ id: 'approve', label: 'Thursday 22 Oct 09:00–09:30', question: 'Save it and reserve 30 minutes?', writes: ['Save the draft', 'Add a block — just you'] }], notOffered: [], respond: { defer: { days: [{ days: 1, label: 'Until tomorrow' }], reasons: [{ id: 'not-now', label: 'Not now' }] }, decline: { reasons: [{ id: 'not-useful', label: 'Not useful' }], say: 'x' } }, moment: { headline: 'x' },
  } };
  const h = text(renderToString(React.createElement(PM.PreparedMoveView, { state: { kind: 'ready', view }, onChoose() {}, onAsk() {}, onConfirm() {}, onCancel() {}, onAgain() {} })));
  const at = h.indexOf('pmo2__private');
  assert.ok(at > 0, 'the label renders');
  assert.ok(at < h.indexOf('I prepared a private draft for you'), 'before the headline');
  assert.ok(h.includes(`${PRIV.cannot} ${PRIV.can}`));
});

function dataWithPrimary(card) {
  const f = FIXTURES.find((x) => x.id === 'many-next');
  const payload = { ...f.payload, primary: card, poolAvailable: true };
  const p = composePresentation(payload, { now: f.at });
  return { ...payload, presentation: p };
}
const CAP = { kind: 'item', id: 'capacity-start-322', type: 'capacity', title: '“Define achievable targets…” is overdue — 8h of work', say: 'Sized at 8h.', actionHint: 'Open State of Play', recordId: 'att_1', actions: ['acknowledge', 'defer', 'open', 'complete', 'dismiss'], meta: { taskId: 322 } };

test('the shared surface draws no open button the shell says would do nothing — and draws the linked one', () => {
  const r = (card, canOpen) => text(renderToString(React.createElement(AS, { data: dataWithPrimary(card), layout: 'situation', profile: 'phone', onAct: () => {}, onOpen: () => {}, canOpen, onNavigate: () => {} })));
  const dead = r(CAP, () => false);
  assert.doesNotMatch(dead, /Open State of Play/, 'a no-op is not drawn');
  const linked = r({ ...CAP, actionHint: 'Open the private draft', open: { kind: 'promise', ref: 'promise:promise:322', recordId: 'pm_1', state: 'ready', show: 'draft', privateDraft: true } }, (c) => Boolean(c.open));
  assert.ok(buttons(linked).includes('Open the private draft'), JSON.stringify(buttons(linked)));
  // Positive control: a shell that passes no canOpen keeps the old behaviour.
  assert.match(r(CAP, null), /Open State of Play/);
});
