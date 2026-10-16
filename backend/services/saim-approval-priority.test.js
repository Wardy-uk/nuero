'use strict';

/**
 * Approvals are a STATUS, not a priority class (16 Oct 2026).
 *
 * Live regression: an agenda approval that expired at 15:05 on MONDAY 19 Oct led the desktop on
 * Friday 16 Oct while a same-day capacity breach and overdue / due-today work were waiting. S6
 * ("judgement waiting") fired for ANY approval and sat above S7 (the gate's top item).
 *
 * Now: an approval leads only when its effective deadline is genuinely current — already due, or due
 * today (which includes one that expires before Nick next starts work, mapped to today's end by
 * effectiveDeadline). Inside a running block S4 still applies. Otherwise it stays in Needs your
 * judgement with its deadline and its exact NEURO Actions link, and the gate's top item — e.g. the
 * capacity breach — leads. Ordering among non-approval items is NEURO's gate order (S7 = its primary),
 * unchanged here: when the gate's primary is an overdue commitment rather than the capacity card, that
 * commitment leads instead.
 *
 *   run: node --test backend/services/saim-approval-priority.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const C = require('../../shared/attention-contracts.cjs');

// Fri 16 Oct 2026, local time; working hours 08:00–18:00, next start Mon 19 Oct 08:00.
const at = (h, m, d = 16) => new Date(2026, 9, d, h, m).getTime();
const iso = (h, m, d = 16) => new Date(at(h, m, d)).toISOString();
const wall = (h, m, d = 16) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.0000000`;
const card = (type, urgency, title, extra = {}) => ({ kind: 'item', type, urgency, title, recordId: extra.recordId || `r-${type}`, reason: extra.reason || null, meta: extra.meta || null });
const commit = (id, description, date) => ({
  id: `commitment:task:${id}`, direction: 'i-owe', state: 'open', description, taskId: `task:neuro:${id}`,
  due: { date, kind: 'set' }, domains: { known: true, domains: [{ domain: 'work', basis: 'set' }], sphere: 'work', basis: 'set' },
});
const CAPACITY = card('capacity', 'high', 'More work due by the end of today than you have time for', { recordId: 'att_capacity', reason: '5.2h due, 35 min free in your diary — 4.6h short.' });
const MONDAY_AGENDA = { id: 'pa_0123456789abcdef', expiresAt: iso(15, 5, 19), title: 'chase agenda: Delivery call' };

function build({ now, primary = null, secondary = [], approvals = [], commitments = [], calendar = [], block = null }) {
  const rows = block ? [{ blockId: block.id, dateKey: '2026-10-16', startTime: block.start, endTime: block.end, status: 'scheduled', passed: false, tasks: [{ taskId: block.taskId, text: block.task }] }] : [];
  const live = { rows, session: null, block: block ? { blockId: block.id, startTime: block.start, endTime: block.end, running: true, tasks: [{ taskId: block.taskId, text: block.task, running: false }], allTicked: false } : null };
  const payload = {
    poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, work: { atDesk: true, deskKnown: true },
    primary, secondary, dropped: [], utterances: [],
    approvals: { known: true, needsApproval: approvals.length, needsReview: 0, where: 'Actions, in NEURO on the desktop' },
    situation: { sections: { commitments } }, home: { needsYou: [], exceptions: [] },
  };
  const facts = {
    calendar, calendarKnown: true,
    approvals: approvals.map((a) => ({ actionId: a.id, type: 'chase_agenda', status: 'prepared', expiresAt: a.expiresAt, mailbox: 'work', title: a.title })),
    taskDomains: new Map(block ? [[block.taskId, { domain: 'work', basis: 'set' }]] : []),
    workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: iso(8, 0), todayEnd: iso(18, 0), nextStart: iso(8, 0, 19) },
    gaps: [],
  };
  const candidates = NC.compose(payload, live, facts, { now });
  const decision = POL.decide(candidates, { surface: 'work-desktop', now });
  const device = { contract: 'saim-device-v1', known: true, observedAt: new Date(now - 60000).toISOString(), apps: [] };
  return { candidates, decision, handoff: H.resolveHandoff({ decision, candidates, device, now }) };
}
const inJudgement = (d, id) => d.judgement.some((j) => j.ref === `approval:${id}`);

test('1. a future-dated approval with due-today work: the approval stays in Needs your judgement', () => {
  const { decision: d } = build({ now: at(11, 0), approvals: [MONDAY_AGENDA], commitments: [commit(350, 'Build call/productivity metrics in Nova', '2026-10-16')] });
  assert.notEqual(d.lead.rule, 'S6 judgement waiting');
  assert.notEqual(d.lead.kind, 'approval');
  assert.ok(inJudgement(d, MONDAY_AGENDA.id));
  assert.match(d.trace.find((t) => t.rule === 'S6 judgement waiting').why, /none due today/);
  assert.match(d.display.judgement[0].by, /Mon 19 Oct/, 'the deadline stays human-readable');
});

test('2. a future-dated approval with a same-day capacity breach: the breach leads, the approval waits in judgement', () => {
  const { decision: d, handoff } = build({ now: at(15, 26), primary: CAPACITY, approvals: [MONDAY_AGENDA] });
  assert.equal(d.lead.rule, 'S7 top item');
  assert.equal(d.lead.ref, 'item:att_capacity');
  assert.ok(inJudgement(d, MONDAY_AGENDA.id));
  assert.deepEqual(handoff.judgementLinks, [{ ref: `approval:${MONDAY_AGENDA.id}`, href: handoff.judgementLinks[0].href, label: 'Open in NEURO Actions' }]);
  assert.match(handoff.judgementLinks[0].href, /^neuro:.*pa_0123456789abcdef/, 'the exact action, in NEURO');
  assert.equal(C.checkHandoff(handoff).ok, true);
  assert.ok(!JSON.stringify(handoff).toLowerCase().includes('approve'), 'no approve control anywhere in the hand-off');
});

test('3. an approval due TODAY still leads (S6); one expiring before Monday’s start counts as today; inside a block S4 still applies', () => {
  const today = build({ now: at(11, 0), primary: CAPACITY, approvals: [{ id: 'pa_today', expiresAt: iso(16, 0), title: 'chase agenda: Ops review' }] }).decision;
  assert.equal(today.lead.rule, 'S6 judgement waiting');
  assert.equal(today.lead.ref, 'approval:pa_today');
  const overdue = build({ now: at(11, 0), primary: CAPACITY, approvals: [{ id: 'pa_late', expiresAt: iso(9, 0), title: 'chase agenda: Late one' }] }).decision;
  assert.equal(overdue.lead.ref, 'approval:pa_late', 'already due leads');
  const weekend = build({ now: at(11, 0), primary: CAPACITY, approvals: [{ id: 'pa_sun', expiresAt: iso(12, 0, 18), title: 'chase agenda: Sunday expiry' }] }).decision;
  assert.equal(weekend.lead.ref, 'approval:pa_sun', 'expires before Monday’s start → effectively today, so it leads');
  const blk = { id: 140, start: '10:30', end: '12:00', taskId: 600, task: 'Customer Care training plan' };
  const inBlock = build({ now: at(11, 0), block: blk, approvals: [{ id: 'pa_blk', expiresAt: iso(11, 45), title: 'chase agenda: Before the block ends' }] }).decision;
  assert.equal(inBlock.lead.rule, 'S4 deadline inside the block');
  const blockFuture = build({ now: at(11, 0), block: blk, approvals: [MONDAY_AGENDA] }).decision;
  assert.equal(blockFuture.lead.rule, 'S5 protected block', 'a Monday approval never interrupts a block');
  assert.ok(inJudgement(blockFuture, MONDAY_AGENDA.id));
});

test('4. the words “waiting for your decision” cannot change rank — only the deadline does', () => {
  const plain = build({ now: at(15, 26), primary: CAPACITY, approvals: [MONDAY_AGENDA] }).decision;
  const worded = build({ now: at(15, 26), primary: card('capacity', 'high', 'Waiting for your decision: more work due today than you have time for', { recordId: 'att_capacity' }),
    approvals: [{ ...MONDAY_AGENDA, title: 'Waiting for your decision — waiting for you in NEURO — urgent' }] }).decision;
  assert.equal(worded.lead.rule, plain.lead.rule);
  assert.equal(worded.lead.ref, plain.lead.ref);
  assert.deepEqual(worded.judgement.map((j) => j.ref), plain.judgement.map((j) => j.ref));
  // And the reverse: a plainly worded approval due today still leads.
  const dueToday = build({ now: at(11, 0), primary: CAPACITY, approvals: [{ id: 'pa_q', expiresAt: iso(15, 0), title: 'chase agenda: Quiet title' }] }).decision;
  assert.equal(dueToday.lead.rule, 'S6 judgement waiting');
});

test('5. the live shape of 16 Oct 15:26 (sanitised): capacity breach leads, Monday’s agenda approval waits in judgement with its NEURO link', () => {
  const { decision: d, handoff, candidates } = build({
    now: at(15, 26),
    primary: card('capacity', 'high', '"Define achievable targets for the incentive plan" can\'t be finished by the end of today on free time', { recordId: 'att_cap_task', reason: '7.4h short even starting now — re-date it, shrink it or hand some of it on.' }),
    secondary: [CAPACITY, card('todo', 'high', '3 overdue tasks', { recordId: 'att_overdue' }), card('email', 'normal', '2 urgent emails', { recordId: 'att_email' })],
    approvals: [MONDAY_AGENDA],
    commitments: [commit(322, 'Send the incentive plan to the director', '2026-10-16'), commit(344, 'Confirm the leaver’s end date', '2026-10-16'), commit(350, 'Build call/productivity metrics in Nova', '2026-10-16'), commit(412, 'Look at QA checklists', '2026-10-16')],
    calendar: [{ id: 'evt-sl', subject: 'Support leadership', start: wall(16, 0), end: wall(16, 25), isAllDay: false, showAs: 'busy', attendeesOther: true }],
  });
  assert.equal(C.checkCandidates(candidates).ok, true);
  assert.equal(d.lead.rule, 'S7 top item');
  assert.equal(d.lead.ref, 'item:att_cap_task', 'the gate’s primary (today’s capacity shortfall) leads');
  assert.notEqual(d.lead.kind, 'approval');
  assert.ok(inJudgement(d, MONDAY_AGENDA.id));
  assert.equal(d.display.judgement.length, 1);
  assert.match(d.display.judgement[0].by, /15:05 Mon 19 Oct/);
  assert.ok(handoff.judgementLinks && handoff.judgementLinks[0].href.startsWith('neuro:'));
  assert.equal(C.checkAttention(d).ok, true);
});

test('the Alt desktop rail shows the waiting approval with its exact NEURO Actions link, and no approve button', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { manifest } = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'alt-v2-manifest', 'manifest.mjs')).href);
  const { candidates, decision, handoff } = build({ now: at(15, 26), primary: CAPACITY, approvals: [MONDAY_AGENDA] });
  const vm = manifest({ candidates, saim: decision, handoff });
  assert.ok(!vm.refused, JSON.stringify(vm.refused));
  const items = vm.rail.judgement.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].neuroHref, 'neuro:?item=action%3Apa_0123456789abcdef');
  assert.ok(!JSON.stringify(vm).includes('"Approve'), 'nothing offers to approve');
});

// ── A capacity warning about a task and the task itself are ONE thing (Nick, 16 Oct 2026) ──
const INCENTIVE = commit(360, 'Define achievable targets for hybrid/WFH incentive; agree plan', '2026-10-16');
const capAbout = (taskId, extra = {}) => card('capacity', 'high', '"Define achievable targets for hybrid/WFH incentive" can\'t be finished by the end of today on free time',
  { recordId: 'att_cap_task', reason: '7.6h short even starting now — re-date it, shrink it or hand some of it on.', meta: { taskId, status: 'cannot-finish', due: '2026-10-16' }, ...extra });
const heldRefs = (d) => d.held.map((h) => h.ref);

test('fold: a capacity warning leading names its task as the basis, and the task is not also held', () => {
  const { decision: d, candidates } = build({ now: at(15, 26), primary: capAbout(360), commitments: [INCENTIVE, commit(412, 'Look at QA checklists', '2026-10-16')] });
  assert.equal(candidates.candidates.find((c) => c.id === 'item:att_cap_task').facts.aboutTaskId, 360);
  assert.equal(d.lead.ref, 'item:att_cap_task');
  assert.equal(d.lead.basis.ref, 'commitment:task:360');
  assert.ok(!heldRefs(d).includes('commitment:task:360'), 'the task is not a second "Also waiting" row');
  assert.ok(heldRefs(d).includes('commitment:task:412'), 'other tasks still wait');
  assert.equal(d.display.lead.basis.why, 'due today');
  assert.deepEqual(d.lead.basis.actions.map((a) => a.intent.taskId), [360], 'the task’s own move rides on the warning');
  assert.equal(C.checkAttention(d).ok, true);
});

test('fold: a held capacity warning carries its task too — one row, with the task’s moves', () => {
  const { decision: d } = build({ now: at(11, 0), primary: card('todo', 'high', '3 overdue tasks', { recordId: 'att_overdue' }), secondary: [capAbout(360)], commitments: [INCENTIVE] });
  assert.equal(d.lead.ref, 'item:att_overdue');
  assert.ok(!heldRefs(d).includes('commitment:task:360'));
  const row = d.held.find((h) => h.ref === 'item:att_cap_task');
  assert.equal(row.basis, 'commitment:task:360');
  assert.ok(row.actions.some((a) => a.intent.taskId === 360));
});

test('fold: only a warning ABOUT a task folds — the overload card (no task) and other tasks are untouched', () => {
  const { decision: d, candidates } = build({ now: at(15, 26), primary: CAPACITY, commitments: [INCENTIVE] });
  assert.equal(candidates.candidates.find((c) => c.id === 'item:att_capacity').facts.aboutTaskId, undefined);
  assert.equal(d.lead.basis, undefined);
  assert.ok(heldRefs(d).includes('commitment:task:360'));
  // A warning about a task NEURO holds no commitment for has nothing to fold.
  const lone = build({ now: at(15, 26), primary: capAbout(999), commitments: [INCENTIVE] }).decision;
  assert.equal(lone.lead.basis, undefined);
  assert.ok(heldRefs(lone).includes('commitment:task:360'));
});

test('fold: the Alt desktop shows the task once, under the warning, with its own Do now', async () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { manifest } = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'saim', 'app', 'alt-v2-manifest', 'manifest.mjs')).href);
  const { candidates, decision, handoff } = build({ now: at(15, 26), primary: capAbout(360), commitments: [INCENTIVE] });
  const vm = manifest({ candidates, saim: decision, handoff });
  assert.ok(!vm.refused, JSON.stringify(vm.refused));
  assert.match(vm.basis.title, /incentive/i);
  assert.equal(vm.basis.why, 'due today');
  assert.deepEqual(vm.basis.actions.map((a) => a.say), ['Do now']);
  const rail = JSON.stringify(vm.rail.held);
  assert.ok(!/incentive/i.test(rail), 'not repeated under Also waiting');
});
