'use strict';

/**
 * saim/policy/promises.cjs + the ledger's pure halves (18 Oct 2026).
 *
 *   run: node --test backend/services/promises-policy.test.js
 *
 * PURE: no DB, no vault, no clock. Fixtures are pseudonyms.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../saim/policy/promises.cjs');
const { groupDuplicates, namesIn } = require('./promise-ledger');

const at = (s) => Date.parse(s);
// Monday 19 Oct 2026, BST (UTC+1).
const MON_0730 = at('2026-10-19T06:30:00Z');
const MON_1230 = at('2026-10-19T11:30:00Z');
const MON_1500 = at('2026-10-19T14:00:00Z');
const TUE_0730 = at('2026-10-20T06:30:00Z');

function promise(over = {}) {
  return {
    key: 'promise:1', taskIds: [1], leadTaskId: 1, text: 'Send Alex Reed the ticket-type list', open: true, tickedWithoutEvidence: [],
    firstSeen: '2026-09-14', due: '2026-10-10', statedDate: null,
    owedTo: { people: [{ name: 'Alex Reed' }], ambiguous: [], fromNote: null, resolved: 'Alex Reed' },
    source: { title: '2026-09-14 - Ops sync', path: 'Meetings/x.md', line: 'l' }, sources: [],
    slips: { dueMoves: 2, lapsedBlocks: 0, blocks: 0, statedDatePassed: false, lastSlipAt: '2026-10-12' },
    nextMeeting: null, sensitivity: { sensitive: false }, ...over,
  };
}

test('judge: an ordinary late promise offers deliver, re-commit, delivered, drop; an unnamed one needs a recipient', () => {
  const j = policy.judge(promise(), { now: at('2026-10-18T09:00:00Z') });
  assert.equal(j.state, 'late');
  assert.deepEqual(j.moves, ['deliver-email', 're-commit', 'delivered', 'drop']);
  const unnamed = policy.judge(promise({ owedTo: { people: [], ambiguous: ['Chris'], fromNote: null, resolved: null } }), { now: at('2026-10-18T09:00:00Z') });
  assert.equal(unnamed.recipientNeeded, true, 'an ambiguous name is chosen by Nick, never guessed');
  const recommitted = policy.judge(promise(), { now: at('2026-10-18T09:00:00Z'), recommits: [{ at: '2026-10-17T10:00:00Z', to: '2026-10-25' }] });
  assert.equal(recommitted.state, 'slipped'); assert.equal(recommitted.date, '2026-10-25');
});

test('a tick without evidence is reported as such, not as closed', () => {
  const j = policy.judge(promise({ open: false }), { now: at('2026-10-18T09:00:00Z') });
  assert.equal(j.state, 'ticked-no-evidence');
  assert.equal(policy.judge(promise(), { now: at('2026-10-18T09:00:00Z'), closed: { kind: 'sent-email' } }).state, 'closed');
});

// ── discovery threshold ──────────────────────────────────────────────────────
test('discovery: needs ≥3 recent slips over ≥14 days and a named person', () => {
  const now = at('2026-10-18T09:00:00Z');
  const three = [1, 2, 3].map((i) => promise({ key: `promise:${i}`, firstSeen: '2026-09-20' }));
  assert.equal(policy.discover({ promises: three, gaps: [], readAt: 'x' }, { now }).qualifies, true);
  assert.equal(policy.discover({ promises: three.slice(0, 2), gaps: [], readAt: 'x' }, { now }).qualifies, false);
  const recent = three.map((p) => ({ ...p, firstSeen: '2026-10-10' }));
  assert.equal(policy.discover({ promises: recent, gaps: [], readAt: 'x' }, { now }).qualifies, false, 'span < 14 days');
  const nobody = three.map((p) => ({ ...p, owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null } }));
  assert.equal(policy.discover({ promises: nobody, gaps: [], readAt: 'x' }, { now }).qualifies, false, 'no named person');
  const old = three.map((p) => ({ ...p, slips: { ...p.slips, lastSlipAt: '2026-08-01' } }));
  assert.equal(policy.discover({ promises: old, gaps: [], readAt: 'x' }, { now }).qualifies, false, 'stale slips');
  assert.equal(policy.discover({ promises: three, gaps: [{ input: 'tasks' }], readAt: 'x' }, { now }).qualifies, false, 'unreadable tasks');
});

// ── budget: proposals ────────────────────────────────────────────────────────
test('budget: a proposal is raised only Monday 07:30, never in a meeting, focus, quiet hours or a critical day', () => {
  assert.equal(policy.mayRaiseProposal({ now: MON_0730, history: [] }).ok, true);
  assert.equal(policy.mayRaiseProposal({ now: MON_1230, history: [] }).ok, false);
  assert.equal(policy.mayRaiseProposal({ now: TUE_0730, history: [] }).ok, false);
  for (const ctx of [{ inMeeting: true }, { inFocus: true }, { quietHours: true }, { criticalToday: true }]) {
    assert.equal(policy.mayRaiseProposal({ now: MON_0730, ctx, history: [] }).ok, false, JSON.stringify(ctx));
  }
});

test('budget: one open at a time, one a week, two declines pause for two weeks', () => {
  assert.equal(policy.mayRaiseProposal({ now: MON_0730, history: [{ status: 'open', raisedAt: '2026-10-05T06:30:00Z' }] }).ok, false);
  assert.equal(policy.mayRaiseProposal({ now: MON_0730, history: [{ status: 'accepted', raisedAt: '2026-10-19T06:00:00Z' }] }).ok, false);
  const declined = [
    { status: 'deferred', raisedAt: '2026-09-28T06:30:00Z', decidedAt: '2026-09-28T08:00:00Z' },
    { status: 'never', raisedAt: '2026-10-12T06:30:00Z', decidedAt: '2026-10-12T08:00:00Z' },
  ];
  assert.match(policy.mayRaiseProposal({ now: MON_0730, history: declined }).why, /paused/);
  assert.equal(policy.mayRaiseProposal({ now: at('2026-11-02T07:30:00Z'), history: declined }).ok, true);
});

// ── budget: promise prompts ──────────────────────────────────────────────────
test('budget: promise prompts only in the bundled moments, and never in a meeting, focus or quiet hours', () => {
  const p = promise();
  assert.equal(policy.mayPromptPromise({ now: MON_1230, promise: p }).ok, true);
  assert.equal(policy.mayPromptPromise({ now: MON_1500, promise: p }).ok, false);
  for (const ctx of [{ inMeeting: true }, { inFocus: true }, { quietHours: true }]) {
    assert.equal(policy.mayPromptPromise({ now: MON_1230, ctx, promise: p }).ok, false, JSON.stringify(ctx));
  }
});

test('budget: at most three a day, once per promise per day', () => {
  const p = promise();
  const day = '2026-10-19';
  assert.equal(policy.mayPromptPromise({ now: MON_1230, promise: p, prompted: [{ key: 'promise:1', at: `${day}T06:30:00Z` }] }).ok, false);
  const three = [2, 3, 4].map((i) => ({ key: `promise:${i}`, at: `${day}T06:3${i}:00Z` }));
  assert.match(policy.mayPromptPromise({ now: MON_1230, promise: p, prompted: three }).why, /3 promise prompts/);
});

test('budget: 30 minutes before a meeting with the person, once per meeting', () => {
  const p = promise({ nextMeeting: { start: '2026-10-19T15:15', title: 'Alex Reed 1-2-1' } }); // 15:15 BST
  const r = policy.mayPromptPromise({ now: MON_1500, promise: p });
  assert.equal(r.ok, true);
  assert.equal(policy.mayPromptPromise({ now: MON_1500, promise: p, prompted: [{ key: 'promise:1', at: '2026-10-19T14:00:00Z', meetingKey: r.meetingKey }] }).ok, false);
  assert.equal(policy.mayPromptPromise({ now: MON_1500, ctx: { inMeeting: true }, promise: p }).ok, false);
});

// ── duplicate linking ────────────────────────────────────────────────────────
test('duplicates: two wordings owed to the same person link; Nick\'s "not the same" splits them', () => {
  const r = (taskId, text) => ({ taskId, text, owedTo: { people: [{ name: 'Alex Reed' }], ambiguous: [] }, owedToFromNote: null });
  const recs = [r(10, 'Send Alex Reed the list of ticket types blocked by skill gaps'), r(11, 'Send the list of ticket types blocked by skill gaps to Alex Reed'), r(12, 'Review the escalation rota with Alex Reed')];
  const g = groupDuplicates(recs, { notSame: new Set() });
  assert.ok(g.some((x) => x.includes(10) && x.includes(11)));
  assert.ok(g.some((x) => x.length === 1 && x[0] === 12));
  const split = groupDuplicates(recs, { notSame: new Set(['10|11']) });
  assert.ok(!split.some((x) => x.includes(10) && x.includes(11)));
});

test('names: an ambiguous first name is not resolved', () => {
  const roster = { full: ['Alex Reed', 'Chris Middleton', 'Chris Smith'], firstNames: new Map([['alex', 'Alex Reed']]), aliases: new Map() };
  assert.deepEqual(namesIn('raise it with Chris', roster).people, []);
  assert.ok(namesIn('raise it with Chris', roster).ambiguous.length >= 1);
  assert.equal(namesIn('send it to Alex', roster).people[0].name, 'Alex Reed');
});

// ── the prompt gate ──────────────────────────────────────────────────────────
const feed = (over = {}) => ({
  proposal: { id: 'gp_x', status: 'open', title: 'Promises made in meetings close within 7 days', whyNow: '4 promises from your meetings slipped.' },
  promise: { key: 'promise:1', text: 'Send Alex Reed the ticket-type list', sensitive: false, state: 'late', date: '2026-10-10', owedTo: 'Alex Reed', moves: ['deliver-email', 're-commit', 'delivered', 'drop'] },
  ...over,
});
const shown = (o) => policy.sponsorshipGate(o).shown;

test('gate: shown on an ordinary lead, never beside an urgent, blind, meeting or protected one, nor on a day off', () => {
  const g = policy.sponsorshipGate({ rule: 'S7 top item', feed: feed() });
  assert.equal(g.shown, true);
  assert.deepEqual(g.sponsorship.proposal.responses, ['accept', 'change', 'defer', 'never']);
  assert.match(g.sponsorship.promise.say, /^You told Alex Reed you would send Alex Reed the ticket-type list\. It was due Sat 10 Oct\.$/);
  for (const rule of policy.NO_SPONSORSHIP) {
    const r = policy.sponsorshipGate({ rule, feed: feed() });
    assert.equal(r.shown, false, rule); assert.match(r.reason, /nothing else is shared beside it/);
  }
  assert.equal(policy.sponsorshipGate({ rule: 'S7 top item', offDay: true, feed: feed() }).reason, 'not a working day');
});

test('gate inputs: rule and off-day from the canonical decision; quiet is NOT read from it', () => {
  assert.deepEqual(policy.gateInputs({ lead: { rule: 'S7 top item' }, quiet: true }, { constraints: { workingWindow: { todayIsWorking: true } } }),
    { rule: 'S7 top item', offDay: false, decided: true }, 'a decision.quiet field (which main never produces) changes nothing');
  assert.equal(policy.sponsorshipGate({ ...policy.gateInputs({ lead: { rule: 'S7 top item' } }, { constraints: { workingWindow: { todayIsWorking: false } } }), feed: feed() }).reason, 'not a working day');
  assert.equal(policy.sponsorshipGate({ ...policy.gateInputs(null, null), feed: feed() }).reason, 'no SAiM decision — staying quiet');
  assert.equal(policy.sponsorshipGate({ ...policy.gateInputs({ refused: { reason: 'x' } }, null), feed: feed() }).reason, 'no SAiM decision — staying quiet');
  assert.equal(policy.sponsorshipGate({ ...policy.gateInputs({ lead: { rule: 'S7 top item' } }, null), feed: feed() }).shown, true, 'positive control');
});

test('the refused lead rules exist in main’s attention-rule vocabulary', () => {
  const C = require('../../shared/attention-contracts.cjs');
  const rules = new Set((C.ATTENTION_RULES || []).map((r) => (typeof r === 'string' ? r : r.rule || r.id)));
  assert.ok(rules.size > 5, 'positive control: the vocabulary was read');
  assert.deepEqual([...policy.NO_SPONSORSHIP].filter((r) => !rules.has(r)), []);
});

test('windowIndex: the three bundled moments, London time', () => {
  assert.equal(policy.windowIndex(MON_0730), 0);
  assert.equal(policy.windowIndex(MON_1230), 1);
  assert.equal(policy.windowIndex(at('2026-10-19T16:30:00Z')), 2);
  assert.equal(policy.windowIndex(MON_1500), null);
});

test('names: Nick is never the person a promise is owed to, by name or by alias', () => {
  const roster = { full: ['Nick Ward', 'Alex Reed'], firstNames: new Map([['nick', 'Nick Ward'], ['alex', 'Alex Reed']]), aliases: new Map([['nw', 'Nick Ward'], ['nick w', 'Nick Ward']]) };
  assert.deepEqual(namesIn('NW to send it', roster).people, []);
  assert.deepEqual(namesIn('Nick Ward will send the slides', roster).people, []);
  assert.deepEqual(namesIn('Nick W to send Alex the slides', roster).people.map((p) => p.name), ['Alex Reed']);
});


test('sponsorship wording drops "Nick to" — the promise is already his', () => {
  const f = feed({ proposal: null, promise: { ...feed().promise, text: 'Nick Ward will send the slides to Alex Reed' } });
  assert.equal(policy.sponsorshipGate({ rule: 'S7 top item', feed: f }).sponsorship.promise.say, 'You told Alex Reed you would send the slides to Alex Reed. It was due Sat 10 Oct.');
});

