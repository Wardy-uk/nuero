'use strict';

/**
 * Needs-you context and the way to it (6 Nov 2026, Nick: "still lacking much
 * context … hidden on load, with a click to show more" and "thanks for telling
 * me SAiM but help a guy out and get me to where I need to be").
 *
 *  - a Needs-you row carries the card's own detail + evidence, folded
 *    ("More about this", closed on load), never repeating the title;
 *  - the approvals row says WHICH email (subject, who), drops the inline
 *    "— Actions — one press sends each." and offers a button to Actions —
 *    on desktop and phone, never on the kiosk or watch;
 *  - a Keep my word card folds every reason and the evidence behind it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { composePresentation } = require('./presentation-intent');
const approvalSummary = require('./approval-summary');

const ROOT = path.resolve(__dirname, '..', '..');
const SITUATION = path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.jsx');
const KMW = path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx');

function cssStub() {
  return {
    name: 'css-stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    },
  };
}
async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], plugins: [cssStub()], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const NOW = Date.parse('2026-11-06T15:00:00Z');
const CAP_TITLE = '"Nick to update QA views with comment snapshots" is overdue — 4h of work';
const base = (extra) => ({
  context: { activity: 'steady', known: true }, life: {}, poolAvailable: true, gaps: [], dropped: [],
  primary: null, secondary: [], approvals: { known: true, needsApproval: 0, needsReview: 0 }, ...extra,
});
const capacityCard = {
  kind: 'item', id: 'capacity-start-12-2026-11-04', recordId: 'att-1', type: 'capacity', urgency: 'high', state: 'active',
  title: CAP_TITLE, say: 'Due Wed 4 Nov · Sized at 4h.', actionHint: 'Open task', actions: ['acknowledge'],
  meta: { taskId: 12, detail: [
    { label: 'The task', text: 'Nick to update QA views with comment snapshots and rationale; assess and tweak harsh AI scoring' },
    { label: 'Where it came from', text: 'Raised in a meeting — Support Leadership. Added Mon 2 Nov.' },
  ] },
};

let Situation; let KmwMoreAbout;
test.before(async () => {
  Situation = (await load(SITUATION)).default;
  KmwMoreAbout = (await load(KMW)).KmwMoreAbout;
});

test('a Needs-you row carries the card’s detail and says why it is here', () => {
  const p = composePresentation(base({ secondary: [capacityCard] }), { now: NOW });
  const row = p.needsYou.find((n) => n.id === 'att-1');
  assert.ok(row, 'the high card is in Needs you');
  assert.deepEqual(row.detail.slice(0, 2).map((d) => d.label), ['The task', 'Where it came from']);
  assert.ok(row.detail.some((d) => d.label === 'Why it’s here' && /high urgency/.test(d.text)));
  assert.ok(!row.detail.some((d) => d.label === 'Suggested move'), '"Open task" is a button, not context');
});

test('a todo’s evidence that only repeats its title is dropped; a pushed card says when', () => {
  const todo = { kind: 'item', id: 'todo-overdue-summary', recordId: 'att-2', type: 'todo', urgency: 'medium', state: 'active',
    title: 'Send the rota', reason: 'Overdue', notifiedAt: '2026-11-06T09:05:00Z', actionHint: 'Start here, then review the rest',
    meta: { dueDate: '2026-11-04', overdueCount: 3 },
    evidence: [{ source: 'NEURO', ref: 'Send the rota', detail: '3 overdue' }] };
  const row = composePresentation(base({ secondary: [todo] }), { now: NOW }).needsYou.find((n) => n.id === 'att-2');
  assert.equal(row.evidence, undefined, 'the title is never said twice');
  const labels = row.detail.map((d) => d.label);
  assert.ok(labels.includes('Due') && labels.includes('Also waiting') && labels.includes('Suggested move'));
  assert.match(row.detail.find((d) => d.label === 'Why it’s here').text, /notification about it at 09:05/);
});

test('the approvals row names WHICH email and where to go — and no button that approves', () => {
  const ap = approvalSummary.summarise([{ action_type: 'compose_email', status: 'prepared', created_at: '2026-11-06T10:00:00Z' }]);
  assert.ok(!/\(an? email\)/.test(ap.say), 'no "(a email)"');
  ap.waiting = [{ actionId: 'pa_1', status: 'prepared', subject: 'Overtime for October', to: ['Chris Middleton'], toMore: 0 }];
  const row = composePresentation(base({ approvals: ap }), { now: NOW }).needsYou[0];
  assert.equal(row.title, '1 drafted email waits for your approval.');
  assert.equal(row.summary, '“Overtime for October” to Chris Middleton');
  assert.deepEqual(row.go, { view: 'actions', label: 'Review and send' });
  assert.equal(row.actionRef, undefined, 'it opens Actions; it approves nothing itself');
});

const render = (p, profile, extra = {}) => renderToString(React.createElement(Situation, { presentation: p, profile, onOpen() {}, ...extra }));

test('render: "More about this" is folded on load and holds the detail', () => {
  const p = composePresentation(base({ secondary: [capacityCard] }), { now: NOW });
  const html = render(p, 'desktop');
  assert.match(html, /<details class="sit__about"><summary>More about this<\/summary>/, 'closed on load');
  assert.ok(text(html).includes('Raised in a meeting — Support Leadership.'));
});

test('render: the approvals row has a button to Actions on desktop and phone, never the kiosk or watch', () => {
  const ap = { known: true, needsApproval: 1, needsReview: 0, where: 'Actions — one press sends each', say: '1 drafted email waits for your approval — Actions — one press sends each.' };
  const p = composePresentation(base({ approvals: ap }), { now: NOW });
  let went = null;
  for (const prof of ['desktop', 'phone']) {
    assert.ok(text(render(p, prof, { onGo: (v) => { went = v; } })).includes('Review and send'), prof);
  }
  assert.ok(!text(render(p, 'desktop')).includes('Review and send'), 'no shell handler → no button');
  assert.ok(!text(render(p, 'kiosk', { onGo: () => {} })).includes('Review and send'), 'never on the wall');
  assert.ok(!text(render(p, 'watch', { onGo: () => {} })).includes('Review and send'));
  assert.equal(went, null, 'rendering presses nothing');
});

test('render: a Keep my word card folds every reason and the evidence', () => {
  const thread = { key: 'promise:7', taskId: 7, owedTo: 'Heidi', title: 'Set and confirm Heidi’s end date',
    because: ['overdue (Mon 2 Nov)', 'nothing NEURO checked says it moved', 'no time is booked for it'],
    evidence: [{ kind: 'source', fact: 'From “1-2-1 Heidi”: Nick to confirm the end date before 30 Sep.' }] };
  const html = renderToString(React.createElement(KmwMoreAbout, { thread, shownWhy: 'nothing NEURO checked says it moved' }));
  assert.match(html, /^<details class="kmw__about"><summary>More about this<\/summary>/);
  const t = text(html);
  assert.ok(t.includes('Overdue (Mon 2 Nov).') && t.includes('No time is booked for it.'));
  assert.ok(!t.includes('Nothing NEURO checked'), 'the why already shown is not repeated');
  assert.ok(t.includes('From “1-2-1 Heidi”'));
  assert.ok(t.includes('Task #7 · owed to Heidi'));
});
