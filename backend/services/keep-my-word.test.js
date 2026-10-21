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
  const draft = k.compose({ score: SCORE, workbench: { ...BENCH, items: [{ ...THREAD_ITEM, preparation: { state: 'needs-a-draft', why: 'x' } }] }, authority: OPEN, presentation: CALM, now: NOW });
  assert.equal(draft.state, 'held');
  assert.match(draft.thread.held.say, /promise-linked delivery loop, which isn’t connected yet/);
  assert.ok(!/no authority/i.test(draft.thread.held.say), 'the blocker is the missing loop, not authority');
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
test.before(async () => { Situation = (await load(path.join(ROOT, 'saim', 'shared-ui', 'presentation', 'Situation.jsx'))).default; });

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
  assert.ok(out.includes('Open the task'), 'the one control is the existing open hand-off');
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
  assert.equal(bare.keepMyWord, null, 'no promises block → null, so every renderer draws what it drew before');
  payload.keepMyWord = { score: SCORE, workbench: BENCH, receipt: null, authority: OPEN };
  const p = composePresentation(payload, { now: fx.at });
  assert.equal(p.keepMyWord.contract, 'keep-my-word-v1');
  assert.equal(p.keepMyWord.state, k.compose({ ...payload.keepMyWord, presentation: p, now: fx.at }).state);
  payload.keepMyWord = { score: { ratio: 'not an object', counts: null }, workbench: { items: [{}] } };
  const broken = composePresentation(payload, { now: fx.at });
  assert.equal(broken.keepMyWord, null);
  assert.ok(broken.situation && broken.situation.headline, 'the presentation survives');
});
