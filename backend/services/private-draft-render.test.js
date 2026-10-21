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

// ── The interview, from the REAL brief (private-brief.compose) ───────────────
const brief = require('./private-brief');
const PROMISE_TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
const RESPOND = { defer: { days: [{ days: 1, label: 'Until tomorrow' }], reasons: [{ id: 'not-now', label: 'Not now' }] }, decline: { reasons: [{ id: 'not-useful', label: 'Not useful' }], say: 'x' } };
function draftView(answers) {
  const out = brief.compose({ title: PROMISE_TEXT, promiseText: PROMISE_TEXT, source: { path: 'Meetings/2026/09/x.md', title: 'x' }, lines: [], answers, todayYmd: '2026-10-26' });
  const open = out.interview.open > 0;
  return { move: {
    version: 2, recordId: 'pm_9', recordVersion: 3, kind: 'project-note', plan: 'draft', title: PROMISE_TEXT,
    prepared: { headline: 'I prepared a private draft for you — no decision made, nothing sent.', detail: null },
    privateDraft: PRIV, interview: out.interview, outcome: { goal: 'Think it through yourself.' }, why: { because: [], willNot: [] },
    evidence: [], freshness: [], deliverable: { title: 'x — private draft', sourceFacts: [], suggested: { label: PRIV.label, text: out.text }, gaps: out.gaps, path: 'Projects/Working/x (private draft).md' },
    options: open
      ? [{ id: 'unfinished', label: 'As drafted', question: 'Save this unfinished draft? No time will be booked.', writes: ['Save your unfinished private draft as a new note — Working drafts: Projects/Working/x (private draft).md', 'No time is booked.'] }]
      : [{ id: 'approve', label: 'Thursday 22 Oct 09:00–09:30', question: 'Save the draft and reserve 30 minutes?', writes: ['Save your private draft as a new note — Working drafts: Projects/Working/x (private draft).md', 'Add “Finish x” to your calendar, Thursday 22 Oct 09:00–09:30. Just you — nobody is invited.'] }],
    notOffered: [], respond: RESPOND, moment: { headline: 'x' },
  } };
}
const pm = (view, extra = {}) => text(renderToString(React.createElement(PM.PreparedMoveView, { state: { kind: 'ready', view }, onChoose() {}, onAsk() {}, onConfirm() {}, onCancel() {}, onAgain() {}, onAnswer() {}, onPark() {}, onAskOption() {}, ...extra })));

test('the draft view asks ONE question in place, with progress — and offers no "Save it and protect the time" while it is open', () => {
  const h = pm(draftView([]));
  assert.match(h, /Decision 1 of 4 to make/);
  assert.match(h, /<label[^>]*>What does ‘achievable’ mean here, and how will you measure it\?<\/label>/);
  assert.equal((h.match(/<textarea/g) || []).length, 1, 'one field');
  const b = buttons(h);
  assert.ok(b.includes('Tell SAiM') && b.includes('Park this for now'), JSON.stringify(b));
  assert.ok(!b.includes('Save it and protect the time') && !b.includes('Save it'), 'nothing that implies the work is complete');
  assert.ok(b.includes('Save this unfinished draft instead'));
  assert.match(h, /no time will be booked/);
  assert.doesNotMatch(h, /Still needed from you/, 'no inert list');
  const iv = h.slice(h.indexOf('<section class="pmo2__iv"'), h.indexOf('</section>', h.indexOf('<section class="pmo2__iv"')));
  assert.doesNotMatch(iv, /<select|[Ss]ettings/, 'the interview is a question and a box — not a settings form');
  assert.ok(h.indexOf('pmo2__iv') < h.indexOf('pmo2__page'), 'the question before the page');
});

test('after an answer and a park: "You said" and "Parked" in the draft, the next question asked', () => {
  const h = pm(draftView([{ questionId: 'achievable', text: 'Measured monthly against FRT', by: 'nick' }, { questionId: 'park', text: 'incentive', by: 'nick' }]));
  assert.match(h, /Decision 3 of 4 to make/);
  assert.match(h, /Who does it apply to/);
  assert.match(h, /## You said/); assert.match(h, /Measured monthly against FRT/);
  assert.match(h, /## Parked — still unresolved/);
});

test('every question answered or parked → the normal save-and-protect confirmation, no interview', () => {
  const all = ['achievable', 'incentive', 'applies', 'agree'].map((id) => ({ questionId: id === 'incentive' ? 'park' : id, text: id === 'incentive' ? 'incentive' : `my words on ${id}` }));
  const h = pm(draftView(all));
  assert.doesNotMatch(h, /pmo2__iv"/);
  const b = buttons(h);
  assert.ok(b.includes('Save it and protect the time'), JSON.stringify(b));
  assert.ok(!b.includes('Save this unfinished draft instead'));
});

test('read-only (kiosk): the question shows, nothing can be answered, parked or saved', () => {
  const h = text(renderToString(React.createElement(PM.PreparedMoveView, { state: { kind: 'ready', view: draftView([]) }, readOnly: true, onChoose() {}, onAsk() {}, onConfirm() {}, onCancel() {}, onAgain() {} })));
  assert.match(h, /What does ‘achievable’ mean here/);
  assert.doesNotMatch(h, /<textarea/);
  assert.ok(!buttons(h).includes('Park this for now'));
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
