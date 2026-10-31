'use strict';

/**
 * keep-my-word-v1 — the four states, the readout, the verified receipt's
 * wording, and the REAL render through the shared Situation renderer (phone,
 * desktop, kiosk) and Alt's placement rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const k = require('./keep-my-word');

const NOW = Date.parse('2026-10-21T14:00:00Z'); // Wed 15:00 BST
const ROOT = path.resolve(__dirname, '..', '..');

const RECEIPT_EVENT = {
  at: '2026-10-21T13:04:27.000Z', title: 'SIP T1 — triage and escalation acceptance criteria', target: 'live', complete: true,
  steps: [
    { step: 'calendar', status: 'done', target: '2026-10-21 15:30–16:00 “Support Improvement Plan review”' },
    { step: 'note', status: 'done', target: 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md' },
  ],
};

const SCORE = {
  ratio: { kept: 7, of: 9 }, counts: { due: 10, keptOnTime: 7, late: 1, unverified: 1, pending: 1, dropped: 0, reDated: 2, undated: 0 },
  previous: { ratio: { kept: 6, of: 8 } },
  entries: [{ key: 'promise:9', outcome: 'unverified' }],
  mondayReport: { state: 'sent-verified-on-time', dueLabel: 'Monday 19 October 2026, 12:00 (London)' },
};

const THREAD_ITEM = {
  key: 'promise:31', taskIds: [31], leadTaskId: 31, title: 'Build the onboarding checklist for Hope', owedTo: 'Hope Goodall',
  due: { date: '2026-10-22', basis: 'set', endsAt: '2026-10-22T23:00:00.000Z', tier: 'soon', say: 'due within two days' },
  booked: [], preparation: { state: 'needs-a-block', why: 'Nothing is booked for it before it is due.' },
  because: [], evidence: [{ kind: 'due', fact: 'Due Thursday 22 October — the date set on the task.' }],
};
const BENCH = { state: 'ok', items: [THREAD_ITEM], withheld: { sensitive: 1, ambiguous: 0, unreadable: 0, undated: 0 } };
const DRAFT_ITEM = { ...THREAD_ITEM, title: 'Send Hope the onboarding checklist', preparation: { state: 'needs-a-draft', why: 'It is a message to one person; nothing is drafted yet.' } };
const DRAFT_BENCH = { ...BENCH, items: [DRAFT_ITEM] };
const kmwButtons = (out) => [...out.matchAll(/<button type="button" class="kmw__open[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const START = async () => ({ ok: true });
const READY = (over = {}) => ({ sending: true, items: { 'promise:31': { addressable: true, why: null, live: null, ...over } } });
const CALM = { mode: 'calm', needsYou: [], primary: null };
const URGENT = { mode: 'needs-attention', needsYou: [{ id: 'risk', title: 'Weekly Risk report waits for you' }], primary: null };
const OPEN = { canAct: true, boundary: null };
const LOCKED = { canAct: false, boundary: { gate: 'device', say: 'This device is locked for SAiM, so I can prepare this but not do it. The lock is set on the Pi.' } };

// ── The receipt ──────────────────────────────────────────────────────────────

test('a verified receipt states the exact London date and time, both read-backs, and where the note lives', () => {
  const r = k.receiptView(RECEIPT_EVENT);
  assert.equal(r.label, 'Receipt · verified');
  assert.equal(r.headline, 'Preparation is now real.');
  assert.equal(r.checkedLabel, 'Checked Wednesday 21 October 2026, 14:04 (London)');
  const cal = r.rows.find((x) => x.label === 'Calendar');
  assert.deepEqual(cal.lines, ['Wednesday, 21 October 2026 · 15:30–16:00', 'Calendar read-back verified.']);
  assert.equal(r.rows.find((x) => x.label === 'Vault note').lines[0], 'Vault read-back verified.');
  assert.equal(r.rows.find((x) => x.label === 'Find it').path, 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md');
  assert.match(r.lead, /two internal changes, then read both back/);
});

test('a practice run, a partial run, or an unverified step is NOT a verified receipt', () => {
  assert.equal(k.receiptView({ ...RECEIPT_EVENT, target: 'sandbox' }), null);
  assert.equal(k.receiptView({ ...RECEIPT_EVENT, complete: false }), null);
  assert.equal(k.receiptView({ ...RECEIPT_EVENT, steps: [RECEIPT_EVENT.steps[0], { ...RECEIPT_EVENT.steps[1], status: 'unverified' }] }), null);
  assert.equal(k.receiptView({ ...RECEIPT_EVENT, steps: [{ ...RECEIPT_EVENT.steps[0], target: 'garbled' }, RECEIPT_EVENT.steps[1]] }), null);
});

test('latestVerifiedReceipt reads TODAY’s live verified receipt only (London day)', () => {
  const rows = [
    { at: '2026-10-20T13:00:00Z', detail: JSON.stringify({ ...RECEIPT_EVENT, at: '2026-10-20T13:00:00Z' }) },
  ];
  const db = { all: () => rows };
  assert.equal(k.latestVerifiedReceipt({ now: NOW, db }), null);
  rows.unshift({ at: RECEIPT_EVENT.at, detail: JSON.stringify({ ...RECEIPT_EVENT, target: 'sandbox' }) });
  assert.equal(k.latestVerifiedReceipt({ now: NOW, db }), null, 'a practice run never shows as verified');
  rows.unshift({ at: RECEIPT_EVENT.at, detail: JSON.stringify(RECEIPT_EVENT) });
  assert.equal(k.latestVerifiedReceipt({ now: NOW, db }).checkedAt, RECEIPT_EVENT.at);
  assert.equal(k.latestVerifiedReceipt({ now: NOW, db: { all: () => { throw new Error('no table'); } } }), null);
});

// ── The four states ──────────────────────────────────────────────────────────

test('calm: no lead, the thread leads', () => {
  const v = k.compose({ score: SCORE, workbench: BENCH, authority: OPEN, presentation: CALM, now: NOW });
  assert.equal(v.state, 'calm');
  assert.equal(v.leads, true);
  assert.equal(v.thread.title, THREAD_ITEM.title);
  assert.equal(v.thread.held, null);
});

test('urgent lead: the lead stays first and the thread FOLDS, recognisable by its title', () => {
  const v = k.compose({ score: SCORE, workbench: BENCH, authority: OPEN, presentation: URGENT, now: NOW });
  assert.equal(v.state, 'folded');
  assert.equal(v.leads, false);
  assert.equal(v.leadWhy, 'needs-you');
  assert.equal(v.entry, 'Keeping your word — Build the onboarding checklist for Hope · due within two days');
  const p0 = k.compose({ score: SCORE, workbench: BENCH, presentation: { mode: 'calm', needsYou: [], primary: { priority: 'P0' } }, now: NOW });
  assert.equal(p0.state, 'folded');
  const meeting = k.compose({ score: SCORE, workbench: BENCH, presentation: { mode: 'in-meeting', needsYou: [] }, now: NOW });
  assert.equal(meeting.state, 'folded');
});

test('held: the missing authority is NAMED, and there is no confirmation path', () => {
  const v = k.compose({ score: SCORE, workbench: BENCH, authority: LOCKED, presentation: CALM, now: NOW });
  assert.equal(v.state, 'held');
  assert.equal(v.thread.held.say, LOCKED.boundary.say);
  // A message promise NEURO cannot address is held, and says exactly why.
  const noAddr = k.compose({ score: SCORE, workbench: DRAFT_BENCH, authority: OPEN, delivery: { sending: true, items: { 'promise:31': { addressable: false, why: 'x', live: null } } }, presentation: CALM, now: NOW });
  assert.equal(noAddr.state, 'held');
  assert.match(noAddr.thread.held.say, /no single email address for Hope Goodall/);
  assert.equal(noAddr.thread.draft, null, 'no control when it cannot be addressed');
  // Readiness unknown → held, nothing offered (fail closed).
  const unknown = k.compose({ score: SCORE, workbench: DRAFT_BENCH, authority: OPEN, delivery: null, presentation: CALM, now: NOW });
  assert.equal(unknown.state, 'held');
  assert.match(unknown.thread.held.say, /couldn’t check whether this can be drafted/);
});

test('verified receipt: leads on a calm screen, folds under an urgent lead', () => {
  const r = k.receiptView(RECEIPT_EVENT);
  const v = k.compose({ score: SCORE, workbench: BENCH, receipt: r, authority: OPEN, presentation: CALM, now: NOW });
  assert.equal(v.state, 'receipt');
  assert.equal(v.leads, true);
  const f = k.compose({ score: SCORE, workbench: BENCH, receipt: r, authority: OPEN, presentation: URGENT, now: NOW });
  assert.equal(f.state, 'folded');
  assert.match(f.entry, /^Receipt · verified/);
});

// ── The readout ──────────────────────────────────────────────────────────────

test('the readout: kept on time, the trend, the Monday report, the next protected time, what needs judgement', () => {
  const v = k.compose({ score: SCORE, workbench: BENCH, receipt: k.receiptView(RECEIPT_EVENT), presentation: CALM, now: NOW });
  const r = v.readout;
  assert.equal(r.figure, '7 / 9');
  assert.equal(r.trend, 'One more than last week.');
  assert.equal(r.monday.line, 'Sent, and read back in Sent Items by the deadline.');
  assert.equal(r.next.strong, 'Wednesday · 15:30');
  assert.equal(r.next.line, 'Support Improvement Plan review. Protected time.');
  assert.equal(r.judgement.strong, 'One promise');
  assert.equal(r.reDated, 'Two re-dated this week.');
});

test('an unmeasured week shows NO figure and says why (never a number from ticks)', () => {
  const v = k.compose({ score: { ratio: null, why: 'Nothing yet records a delivery against your promises — ticks are not delivery, so none is counted as kept.', counts: { reDated: 0 }, entries: [] }, presentation: CALM, now: NOW });
  assert.equal(v.readout.figure, null);
  assert.match(v.readout.line, /ticks are not delivery/);
  const none = k.compose({ score: null, presentation: CALM, now: NOW });
  assert.equal(none.readout.figure, null);
  assert.match(none.readout.line, /couldn’t read your promises/);
});

test('the lead rule is Situation.jsx’s own: the same modes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.jsx'), 'utf-8');
  const m = /const LEAD_MODES = new Set\(\[([^\]]+)\]\)/.exec(src);
  assert.ok(m, 'Situation.jsx declares LEAD_MODES');
  const theirs = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  assert.deepEqual(theirs, [...k.LEAD_MODES].sort());
});

// ── Real render through the shared renderer ──────────────────────────────────

function cssStub() {
  return { name: 'css-stub', setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
    b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  } };
}
async function load(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], plugins: [cssStub()], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let Situation;
let Workflow;
test.before(async () => {
  Situation = (await load(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.jsx'))).default;
  Workflow = (await load(path.join(ROOT, 'saim', 'shared-ui', 'TaskWorkflow.jsx'))).TaskWorkflowView;
});
// The Task workflow screen (31 Oct 2026) — where the delivery note and the move now live.
const screen = (kmw, extra = {}) => renderToString(React.createElement(Workflow, { data: { ok: true, task: null, thread: kmw.thread }, ...extra }));

function presentationWith(kmw, base) {
  return {
    contract: 'presentation-v1', mode: base.mode,
    situation: { headline: base.headline || 'Nothing needs you right now.', summary: null, tone: 'calm', attentionLevel: 'none', about: null, honesty: { complete: true, cannotSee: [] } },
    primary: base.primary || null, needsYou: base.needsYou || [], next: [], offers: [], context: [], observations: [], tracked: null, details: [],
    keepMyWord: kmw,
  };
}
const html = (p, profile = 'phone', extra = {}) => renderToString(React.createElement(Situation, { presentation: p, profile, onOpen: () => {}, ...extra }));

test('render: urgent lead FIRST, the prepared promise folded beneath it as a recognisable thread', () => {
  const kmw = k.compose({ score: SCORE, workbench: BENCH, authority: OPEN, presentation: URGENT, now: NOW });
  const out = html(presentationWith(kmw, { ...URGENT, headline: 'One thing needs you.' }), 'desktop');
  const leadAt = out.indexOf('Weekly Risk report waits for you');
  const foldAt = out.indexOf('Keeping your word — Build the onboarding checklist for Hope');
  assert.ok(leadAt > 0, 'the lead renders');
  assert.ok(foldAt > leadAt, 'the thread follows the lead');
  assert.match(out, /<details class="kmw__fold kmw__fold--entry"><summary>/, 'folded, not open');
  assert.ok(out.includes('One thing needs you.'), 'the situation headline is kept');
  assert.ok(out.includes('kmw__week'), 'the readout still shows');
});

test('render: a calm screen gives the thread the main surface, with the readout beside it', () => {
  const kmw = k.compose({ score: SCORE, workbench: BENCH, authority: OPEN, presentation: CALM, now: NOW });
  const out = html(presentationWith(kmw, CALM), 'desktop');
  assert.ok(!out.includes('Nothing needs you right now.'), 'never under a quiet “nothing needs you” heading');
  assert.ok(out.includes('sit--kmw'));
  assert.ok(out.indexOf('kmw__week') < out.indexOf('kmw__thread'), 'readout first (left), main surface after');
  assert.ok(out.includes('7 / 9'));
  assert.ok(!out.includes('Open the task'), 'the card no longer opens the task (31 Oct 2026)');
  assert.deepEqual(kmwButtons(out), [], 'no shell handler → no button');
  const started = html(presentationWith(kmw, CALM), 'desktop', { onStartTask: START });
  assert.deepEqual(kmwButtons(started), ['Start this task'], 'the ONE control is Start this task');
  assert.ok(!started.includes('kmw__tools') && !started.includes('>Evidence<'), 'no tools, no evidence rows on the card');
});

test('render: the verified receipt with exact date/time and the note’s location', () => {
  const kmw = k.compose({ score: SCORE, workbench: BENCH, receipt: k.receiptView(RECEIPT_EVENT), presentation: CALM, now: NOW });
  const out = html(presentationWith(kmw, CALM), 'desktop');
  assert.ok(out.includes('Receipt · verified'));
  assert.ok(out.includes('Preparation is now real.'));
  assert.ok(out.includes('Wednesday, 21 October 2026 · 15:30–16:00'));
  assert.ok(out.includes('Calendar read-back verified.'));
  assert.ok(out.includes('Vault read-back verified.'));
  assert.ok(out.includes('Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md'));
  assert.ok(out.includes('Checked Wednesday 21 October 2026, 14:04 (London)'));
});

test('render: held names the missing authority and offers NO confirm, approve or send', () => {
  const kmw = k.compose({ score: SCORE, workbench: BENCH, authority: LOCKED, presentation: CALM, now: NOW });
  const out = html(presentationWith(kmw, CALM), 'phone');
  assert.ok(out.includes('This device is locked for SAiM'));
  assert.ok(!/>(Confirm|Approve|Send|Do it|Reserve)[^<]*</i.test(out), 'no confirmation path');
});

test('render: the kiosk draws it, with a control only when its shell hands one over; the watch not at all', () => {
  const kmw = k.compose({ score: SCORE, workbench: BENCH, authority: OPEN, presentation: CALM, now: NOW });
  const kiosk = html(presentationWith(kmw, CALM), 'kiosk', { onOpen: null });
  assert.ok(kiosk.includes('kmw__thread'));
  assert.ok(kiosk.includes('kmw__week'));
  assert.ok(!kiosk.includes('Open the task'), 'no onOpen from the shell → no button');
  const kioskStart = html(presentationWith(kmw, CALM), 'kiosk', { onOpen: null, onStartTask: START });
  assert.ok(!kioskStart.includes('Start this task'), 'never a Start button on the kiosk, even if a handler is passed');
  const watch = html(presentationWith(kmw, CALM), 'watch');
  assert.ok(!watch.includes('kmw__'));
});

test('render: no keepMyWord → the screen is exactly what it was before', () => {
  const p = presentationWith(null, CALM);
  const out = html(p, 'desktop');
  assert.ok(!out.includes('kmw__'));
  assert.ok(!out.includes('sit--kmw'));
  assert.ok(out.includes('Nothing needs you right now.'));
});

// ── Alt ──────────────────────────────────────────────────────────────────────

test('Alt places the same scene by the server’s decision plus its own calm rule', async () => {
  const { keepWordPlacement } = await import(pathToFileURL(path.join(ROOT, 'saim', 'app', 'alt-v2-manifest', 'prepared.mjs')).href);
  const calmKmw = k.compose({ score: SCORE, workbench: BENCH, presentation: CALM, now: NOW });
  const vmCalm = { tone: 'calm', rule: 'S11 nothing' };
  assert.deepEqual(keepWordPlacement(vmCalm, calmKmw), { show: true, leads: true, folded: false });
  assert.deepEqual(keepWordPlacement({ tone: 'calm', rule: 'S4 block' }, calmKmw), { show: true, leads: false, folded: true }, 'Alt’s own lead keeps first');
  assert.deepEqual(keepWordPlacement(vmCalm, calmKmw, true), { show: true, leads: false, folded: true }, 'a leading prepared move keeps the lead');
  assert.deepEqual(keepWordPlacement({ tone: 'blind', rule: 'S0' }, calmKmw), { show: false, leads: false, folded: false }, 'blind shows nothing');
  const urgentKmw = k.compose({ score: SCORE, workbench: BENCH, presentation: URGENT, now: NOW });
  assert.equal(keepWordPlacement(vmCalm, urgentKmw).leads, false, 'the server’s fold is never overridden into a lead');
});

// ── Wiring: the presentation carries it, decided against its OWN lead ────────

test('composePresentation attaches keepMyWord from the Now payload, and a fault never costs the presentation', () => {
  const { composePresentation } = require('./presentation-intent');
  const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');
  const fx = FIXTURES[0];
  const payload = JSON.parse(JSON.stringify(fx.payload));
  const bare = composePresentation(payload, { now: fx.at });
  assert.equal(bare.keepMyWord.contract, 'keep-my-word-v1', 'the scene is always composed — honest when unread');
  assert.equal(bare.keepMyWord.readout.figure, null);
  assert.equal(bare.keepMyWord.readout.figureNote, 'Can’t read yet');
  assert.match(bare.keepMyWord.readout.line, /couldn’t read your promises/);
  payload.keepMyWord = { score: SCORE, workbench: BENCH, receipt: null, authority: OPEN };
  const p = composePresentation(payload, { now: fx.at });
  assert.equal(p.keepMyWord.contract, 'keep-my-word-v1');
  assert.equal(p.keepMyWord.state, k.compose({ ...payload.keepMyWord, presentation: p, now: fx.at }).state);
  payload.keepMyWord = { score: { ratio: 'not an object', counts: null }, workbench: { items: [{}] } };
  const broken = composePresentation(payload, { now: fx.at });
  assert.equal(broken.keepMyWord, null);
  assert.ok(broken.situation && broken.situation.headline, 'the presentation survives');
});

// ── The bounded delivery action (needs-a-draft) ──────────────────────────────

test('needs-a-draft: the truthful offer — one control, nothing sent, NOT held, nothing about a missing loop', () => {
  const v = k.compose({ score: SCORE, workbench: DRAFT_BENCH, authority: OPEN, delivery: READY(), presentation: CALM, now: NOW });
  assert.equal(v.state, 'calm', 'not a permanently held state');
  assert.equal(v.thread.held, null);
  assert.equal(v.thread.draft.say, 'SAiM can prepare a delivery note for your approval. Nothing will be sent.');
  assert.equal(v.thread.draft.control, 'Draft the delivery note');
  assert.equal(v.thread.draft.sendingOff, null);
  assert.ok(!/isn’t connected|not connected|unavailable/i.test(JSON.stringify(v.thread)), 'no stale “loop unavailable” wording');
});

test('needs-a-draft with “Send approved emails” off: drafting still offered, and it says it cannot be approved to send yet', () => {
  const v = k.compose({ score: SCORE, workbench: DRAFT_BENCH, authority: OPEN, delivery: { ...READY(), sending: false }, presentation: CALM, now: NOW });
  assert.equal(v.thread.draft.control, 'Draft the delivery note');
  assert.equal(v.thread.draft.sendingOff, '“Send approved emails” is off, so the note can be reviewed but can’t be approved to send until that setting is on.');
  const out = screen(v, { onPrepareDelivery: async () => ({ ok: true }) });
  assert.ok(out.includes('can’t be approved to send until that setting is on'));
  assert.ok(!html(presentationWith(v, CALM), 'desktop', { onStartTask: START }).includes('delivery note'), 'the card says nothing of the delivery note');
});

test('a draft that EXISTS is never offered as a new draft: prepared → “Show the delivery note”; further on → status only', () => {
  const waiting = k.compose({ score: SCORE, workbench: DRAFT_BENCH, delivery: READY({ live: { actionId: 'pa_1', status: 'prepared' } }), presentation: CALM, now: NOW });
  assert.equal(waiting.thread.draft.control, 'Show the delivery note');
  assert.equal(waiting.thread.draft.say, 'A delivery note is already drafted and waiting for your approval.');
  assert.ok(!JSON.stringify(waiting.thread).includes('Draft the delivery note'), 'no stale offer');
  assert.ok(!JSON.stringify(waiting.thread).includes('SAiM can prepare a delivery note'), 'no stale offer sentence');
  const out = screen(waiting, { onPrepareDelivery: async () => ({ ok: true }) });
  assert.deepEqual(kmwButtons(out), ['Show the delivery note'], 'the delivery control, on the workflow screen');
  for (const status of ['approved', 'executing', 'executed', 'execution_uncertain']) {
    const v = k.compose({ score: SCORE, workbench: DRAFT_BENCH, delivery: READY({ live: { actionId: 'pa_1', status } }), presentation: CALM, now: NOW });
    assert.equal(v.thread.draft.control, null, status);
    assert.ok(/delivery note/.test(v.thread.draft.say) && !/SAiM can prepare/.test(v.thread.draft.say), status);
  }
});

test('under an urgent lead the thread (and its control) folds beneath the lead', () => {
  const v = k.compose({ score: SCORE, workbench: DRAFT_BENCH, delivery: READY(), presentation: URGENT, now: NOW });
  assert.equal(v.state, 'folded');
  assert.equal(v.thread.draft.control, 'Draft the delivery note');
});


test('render: the offer and ONE control on the workflow screen — no approve, send or confirm; the card only offers Start', () => {
  const kmw = k.compose({ score: SCORE, workbench: DRAFT_BENCH, authority: OPEN, delivery: READY(), presentation: CALM, now: NOW });
  const out = screen(kmw, { onPrepareDelivery: async () => ({ ok: true }), onOpenActions: () => {} });
  assert.ok(out.includes('SAiM can prepare a delivery note for your approval. Nothing will be sent.'));
  assert.deepEqual(kmwButtons(out), ['Draft the delivery note']);
  assert.ok(!/>[^<]*(Approve|Send|Confirm)[^<]*<\/button>/.test(out), 'no approve, send or confirm');
  for (const profile of ['phone', 'desktop']) {
    const card = html(presentationWith(kmw, CALM), profile, { onStartTask: START });
    assert.deepEqual(kmwButtons(card), ['Start this task'], profile);
  }
});

test('render: no prepare handler (a read-only screen) → the offer is shown, the control is not; never on the watch', () => {
  const kmw = k.compose({ score: SCORE, workbench: DRAFT_BENCH, authority: OPEN, delivery: READY(), presentation: CALM, now: NOW });
  const ro = screen(kmw, { readOnly: true });
  assert.ok(ro.includes('SAiM can prepare a delivery note'));
  assert.ok(!ro.includes('Draft the delivery note'));
  const watch = html(presentationWith(kmw, CALM), 'watch', { onStartTask: START });
  assert.ok(!watch.includes('delivery note') && !watch.includes('Start this task'));
});

test('render: urgent lead first; Start this task lives in the folded thread beneath it', () => {
  const kmw = k.compose({ score: SCORE, workbench: DRAFT_BENCH, delivery: READY(), presentation: URGENT, now: NOW });
  const out = html(presentationWith(kmw, { ...URGENT, headline: 'One thing needs you.' }), 'phone', { onStartTask: START });
  const lead = out.indexOf('Weekly Risk report waits for you');
  const fold = out.indexOf('<details class="kmw__fold kmw__fold--entry">');
  const ctl = out.indexOf('Start this task');
  assert.ok(lead > 0 && fold > lead && ctl > fold, 'lead → fold → control');
});

test('the click calls ONLY the prepare handler with the promise key, reveals the route’s draft, repeats idempotently, and shows a refusal whole', async () => {
  const { KmwDelivery: KmwThread } = await load(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx')); // the delivery row (on the workflow screen), called directly
  const kmw = k.compose({ score: SCORE, workbench: DRAFT_BENCH, delivery: READY(), presentation: CALM, now: NOW });
  const R = require('react');
  const realUseState = R.useState;
  let slots = []; let i = 0;
  R.useState = (init) => { const at = i++; if (!(at in slots)) slots[at] = init; return [slots[at], (v) => { slots[at] = typeof v === 'function' ? v(slots[at]) : v; }]; };
  const find = (node, pred) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const n of node) { const r = find(n, pred); if (r) return r; } return null; }
    if (pred(node)) return node;
    return find(node.props && node.props.children, pred);
  };
  const buttonOf = (tree, label) => find(tree, (n) => n.type === 'button' && [].concat(n.props.children).join('') === label);
  const text = (tree) => renderToString(R.createElement(() => tree)).replace(/<!-- -->/g, '');
  try {
    const calls = [];
    const handler = async (key) => {
      calls.push(key);
      const action = { actionId: 'pa_9', draft: { to: [{ name: 'Hope Goodall', email: 'hope@nurtur.tech' }], subject: 'Following up: Send Hope the onboarding checklist', body: 'Hi Hope,\n\n[details]\n\nNick' } };
      return calls.length === 1 ? { ok: true, action } : { ok: true, already: true, action };
    };
    let opened = null;
    const props = { thread: kmw.thread, actions: true, onPrepareDelivery: handler, onOpenActions: (id) => { opened = id; } };
    const render = (p = props) => { i = 0; return KmwThread(p); };
    let tree = render();
    await buttonOf(tree, 'Draft the delivery note').props.onClick();
    tree = render();
    assert.deepEqual(calls, ['promise:31'], 'exactly one call, with the promise key');
    const shown = text(tree);
    assert.ok(shown.includes('Drafted for your approval — nothing has been sent.'));
    assert.ok(shown.includes('Following up: Send Hope the onboarding checklist'));
    assert.ok(shown.includes('Review it in Actions'), 'the hand-off to the existing governed draft');
    assert.equal(buttonOf(tree, 'Draft the delivery note'), null, 'the control gives way to the result');
    // Repeat (a reload, a second press): the route returns the SAME draft and the thread says so.
    slots = []; tree = render();
    await buttonOf(tree, 'Draft the delivery note').props.onClick();
    tree = render();
    assert.ok(text(tree).includes('already drafted — nothing new was created'));
    assert.deepEqual(calls, ['promise:31', 'promise:31']);
    // Refusal: the server's reason, whole.
    slots = [];
    const refuse = { ...props, onPrepareDelivery: async () => ({ ok: false, routing: true, error: 'This involves someone’s employment. I won’t draft a decision or write to them.' }) };
    tree = render(refuse);
    await buttonOf(tree, 'Draft the delivery note').props.onClick();
    tree = render(refuse);
    assert.ok(text(tree).includes('Not drafted — This involves someone’s employment. I won’t draft a decision or write to them.'));
    assert.equal(opened, null, 'nothing opened without Nick pressing it');
  } finally {
    R.useState = realUseState;
  }
});

test('the shared component holds no URL and no send/approve call — the shells supply the one route', () => {
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx'), 'utf-8');
  assert.ok(!/['"`]\/api\//.test(src), 'no API path in shared UI');
  assert.ok(!/approve|execute|intent-grant|challenge/i.test(src.replace(/\/\/.*$/gm, '')), 'no approval or execution in code');
  // 31 Oct 2026: the desktop's delivery-note call lives on the Task workflow screen.
  for (const f of ['saim/app/src/promiseDelivery.mjs', 'frontend/src/components/TaskWorkflowPage.jsx']) {
    const body = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    assert.ok(/\/api\/promises\/\$\{encodeURIComponent\(\w+\)\}\/prepare/.test(body), `${f} calls only the prepare route`);
  }
});

test('phone/Alt helper: POSTs ONLY to the prepare route with nothing in the body, and returns a refusal whole', async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'saim', 'app', 'src', 'promiseDelivery.mjs')], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
    plugins: [{ name: 'api-stub', setup(b) {
      b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => "https://neuro.test" + p; export const authHeaders = (p, x = {}) => ({ ...x, "X-Neuro-Pin": "pin" });', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const calls = [];
  const fake = (body, status = 200) => async (url, opts) => { calls.push({ url, method: opts.method, body: opts.body }); return { ok: status < 300, status, json: async () => body }; };
  const ok = await mod.exports.prepareDelivery('promise:31', { fetchImpl: fake({ ok: true, action: { actionId: 'pa_9' } }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], { url: 'https://neuro.test/api/promises/promise%3A31/prepare', method: 'POST', body: '{}' });
  const long = 'This involves someone’s employment. I won’t draft a decision or write to them. It needs a decision from you with your HR reviewer — I can list what the notes say, for that conversation.';
  const refused = await mod.exports.prepareDelivery('promise:7', { fetchImpl: fake({ ok: false, routing: true, error: long }, 409) });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, long, 'never truncated');
  const down = await mod.exports.prepareDelivery('promise:7', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(down, { ok: false, error: 'NEURO didn’t answer, so nothing was drafted.' });
  assert.equal(calls.length, 2, 'one call per press, no retries');
});


// ── The scene is the SAiM home (21 Oct 2026) ─────────────────────────────────
test('the scene renders only where a SAiM shell opts in — NEURO’s own Now keeps its look; never the watch', () => {
  const kmw = k.compose({ score: SCORE, workbench: BENCH, presentation: CALM, now: NOW });
  const p = presentationWith(kmw, CALM);
  assert.ok(html(p, 'desktop', { scene: true }).includes('sit--scene'));
  assert.ok(html(p, 'phone', { scene: true }).includes('sit--scene'));
  assert.ok(!html(p, 'desktop').includes('sit--scene'), 'no opt-in → not the scene');
  assert.ok(!html(p, 'watch', { scene: true }).includes('sit--scene'), 'never the watch');
});

test('an unmeasured week is a deliberate statement, not an empty readout', () => {
  const v = k.compose({ score: { ratio: null, why: 'x', counts: { reDated: 0 }, entries: [] }, presentation: CALM, now: NOW });
  assert.equal(v.readout.figureNote, 'Not measured yet');
  const out = html(presentationWith(v, CALM), 'phone', { scene: true });
  assert.ok(out.includes('kmw__figure kmw__figure--note'));
  assert.ok(out.includes('Not measured yet'));
  const none = k.compose({ score: { ratio: { kept: 0, of: 0 }, counts: { pending: 2, reDated: 0 }, entries: [] }, presentation: CALM, now: NOW });
  assert.equal(none.readout.figureNote, 'Nothing due yet');
});

test('a calm scene with nothing at risk still says so, under the headline', () => {
  const v = k.compose({ score: SCORE, workbench: { state: 'ok', items: [], withheld: {}, why: 'No promise is at risk this week.' }, presentation: CALM, now: NOW });
  const out = html(presentationWith(v, CALM), 'desktop', { scene: true });
  assert.ok(out.includes('No promise is at risk this week.'));
  assert.ok(out.includes('7 / 9'), 'the readout stands beside it');
});

test('AttentionSurface makes the scene the default situation home and gives her the amber presence', () => {
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'AttentionSurface.jsx'), 'utf-8');
  assert.match(src, /const scene = Boolean\(presentation && presentation\.keepMyWord\) && prof !== 'watch';/);
  assert.match(src, /palette=\{scene \? 'amber' : null\}/);
  assert.match(src, /scene=\{scene\}/);
  const tabs = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'tabs.jsx'), 'utf-8');
  assert.match(tabs, /export const DEFAULT_TAB = 'surface';/, 'the app opens on the Surface — no flag, no navigation');
});

test('two promises at risk: the second is named as a tappable link, and the thread carries it whole (31 Oct 2026)', () => {
  const second = { ...DRAFT_ITEM, key: 'promise:other', title: 'Evaluate a business WhatsApp account' };
  const kmw = k.compose({ score: SCORE, workbench: { ...BENCH, items: [THREAD_ITEM, second] }, authority: OPEN, presentation: CALM, now: NOW });
  assert.equal(kmw.thread.others.length, 1, 'the other promise travels with the thread');
  assert.equal(kmw.thread.others[0].title, 'Evaluate a business WhatsApp account');
  assert.deepEqual(kmw.thread.others[0].more.titles, [THREAD_ITEM.title], 'switched, the first one becomes the "more"');
  const out = html(presentationWith(kmw, CALM), 'desktop');
  assert.match(out, /class="kmw__morelink"[^>]*>Evaluate a business WhatsApp account<\/button>/, 'the title is a button');
});
