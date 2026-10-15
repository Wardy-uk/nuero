'use strict';

// NEURO's structured hand-off intent and canonical links (15 Oct 2026):
// additive neuro-candidates-v2 data. NEURO says what kind of thing each
// candidate is and which EXACT places hold it — from structured fields only —
// and says explicitly what it cannot supply. SAiM's resolver then gets a usable
// hand-off only from valid structured inputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../../shared/attention-contracts.cjs');
const NC = require('./neuro-candidates');
const NH = require('./neuro-handoff');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const SC = require('./saim-policy-scenarios');

const JIRA = 'https://nurturtech.atlassian.net';
const clone = (x) => JSON.parse(JSON.stringify(x));
const NOW = SC.at(11, 5);
const fields = (x) => ({ handoffIntent: x.handoffIntent, targets: x.targets, handoffGaps: x.handoffGaps });
const gapFields = (x) => x.handoffGaps.map((g) => g.field).sort();

// A minimal real compose for attention items (scenarios cover the rest).
function composeWith({ primary = null, secondary = [], jiraBase = null, now = NOW, home = { needsYou: [], exceptions: [] } } = {}) {
  const payload = { poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, work: { atDesk: true, deskKnown: true },
    primary, secondary, dropped: [], utterances: [], approvals: { known: true, needsApproval: 0, needsReview: 0, where: 'Actions, in NEURO on the desktop' },
    situation: { sections: { commitments: [] } }, home, personalDates: null };
  const facts = { calendar: [], calendarKnown: true, approvals: [], taskDomains: new Map(),
    workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: SC.iso(8, 0), todayEnd: SC.iso(18, 0), nextStart: SC.iso(8, 0, 16) }, gaps: [], jiraBase };
  return NC.compose(payload, { rows: [], session: null, block: null }, facts, { now });
}
const DESK = [
  { id: 'outlook', label: 'Outlook', capabilities: ['mail'], available: true, running: null, foreground: null },
  { id: 'claude', label: 'Claude', capabilities: ['ai'], available: true, running: null, foreground: null },
];
const device = (now) => ({ contract: 'saim-device-v1', known: true, observedAt: new Date(now - 60000).toISOString(), apps: DESK });
const endToEnd = (candidates, now, surface = 'work-desktop') => {
  const decision = POL.decide(candidates, { surface, now });
  return { decision, out: H.resolveHandoff({ decision, candidates, device: device(now), now }) };
};

// ── Shape and coverage over every real scenario ──────────────────────────────

test('every composed candidate carries intent, targets and explicit gaps — all valid; constraints carry the Sources link', () => {
  for (const s of SC.SCENARIOS) {
    const { candidates } = s.build();
    assert.equal(C.checkCandidates(candidates).ok, true, s.id);
    assert.deepEqual(candidates.constraints.targets, [{ role: 'source', href: 'neuro:?view=sources', label: 'Sources in NEURO' }], s.id);
    for (const c of candidates.candidates) {
      assert.ok('handoffIntent' in c && Array.isArray(c.targets) && Array.isArray(c.handoffGaps), `${s.id} ${c.id}`);
      assert.equal(C.handoffProblem(c), null, `${s.id} ${c.id}: ${C.handoffProblem(c)}`);
      // Absence is explicit: no intent, or a work step with no activity, always says why.
      if (c.handoffIntent === null) assert.ok(gapFields(c).includes('intent'), `${c.id}: null intent has a gap`);
      if (c.handoffIntent && c.handoffIntent.kind === 'work-step' && c.handoffIntent.activity === null) assert.ok(gapFields(c).includes('activity'), c.id);
    }
  }
});

test('by kind: what NEURO can and cannot say today', () => {
  const k = (kind, facts = {}) => NH.handoffFor({ kind, id: `${kind}:1`, facts });
  assert.deepEqual(k('block').handoffIntent, { kind: 'work-step', activity: null });
  assert.deepEqual(gapFields(k('block')), ['activity', 'canonical']);
  assert.deepEqual(k('commitment').handoffIntent, { kind: 'work-step', activity: null });
  assert.deepEqual(k('meeting').handoffIntent, { kind: 'meeting', provider: null });
  assert.deepEqual(gapFields(k('meeting')), ['join', 'prep', 'provider']);
  assert.deepEqual(k('approval').handoffIntent, { kind: 'approval' });
  assert.deepEqual(gapFields(k('approval')), ['canonical']);
  assert.equal(k('ritual').handoffIntent.kind, 'none');
  assert.equal(k('protected-time').handoffIntent, null);
  assert.equal(k('home', { homeKind: 'hazard' }).handoffIntent.kind, 'risk');
  assert.deepEqual(gapFields(k('home', { homeKind: 'hazard' })), ['canonical', 'control']);
  assert.deepEqual(k('home', { homeKind: 'obligation' }).handoffIntent, { kind: 'work-step', activity: null });
  for (const kind of ['held', 'personal-date']) assert.equal(k(kind).handoffIntent, null, kind);
  // Absence is explicit for every kind NEURO can't classify.
  for (const [kind, facts] of [['held', {}], ['personal-date', {}], ['protected-time', {}], ['home', { homeKind: 'heating' }]]) {
    assert.equal(k(kind, facts).handoffIntent, null, kind);
    assert.deepEqual(gapFields(k(kind, facts)), ['intent'], `${kind}: says why there is no intent`);
  }
  for (const kind of ['block', 'meeting', 'approval', 'commitment', 'protected-time']) assert.deepEqual(k(kind).targets, [], `${kind}: no link NEURO can't stand behind`);
});

test('by item TYPE: risk control surfaces, exact NEURO pages, and the one structured activity', () => {
  const item = (type, meta, jiraBase = JIRA) => NH.handoffFor({ kind: 'attention-item', id: 'item:x', facts: { type } }, meta, { jiraBase });
  // One unseen escalation: Jira's own page, from the base + the structured key.
  const one = item('escalation', { ticket_key: 'NT-14855', url: `${JIRA}/browse/NT-14855`, escalations: [{}] });
  assert.deepEqual(one.targets, [{ role: 'control', href: `${JIRA}/browse/NT-14855`, label: 'Jira', provider: 'jira' }]);
  // A URL on another host is not trusted; the key rebuilds it.
  assert.equal(item('escalation', { ticket_key: 'NT-1', url: 'https://evil.example/browse/NT-1' }).targets[0].href, `${JIRA}/browse/NT-1`);
  assert.deepEqual(gapFields(item('escalation', { ticket_key: 'NT-1' }, null)), ['control'], 'no Jira base configured = a gap');
  assert.deepEqual(gapFields(item('escalation', { ticket_key: 'not a key' })), ['control']);
  // Several: NEURO's Escalations page IS the list the card counts.
  assert.deepEqual(item('escalation', { ticket_key: null, escalations: [{}, {}] }).targets, [{ role: 'canonical', href: 'neuro:?view=escalations', label: 'Escalations in NEURO' }]);
  assert.equal(item('nova_flag', { ticketKey: 'NT-9' }).targets[0].href, `${JIRA}/browse/NT-9`);
  assert.equal(item('weekly_risk', {}).targets[0].href, 'neuro:?view=weekly-risk');
  assert.equal(item('source-blind', {}).targets[0].href, 'neuro:?view=sources');
  assert.deepEqual(item('email', { emailId: 'AAMk1' }).handoffIntent, { kind: 'work-step', activity: 'email', basis: 'item-type' });
  assert.deepEqual(gapFields(item('email', {})), ['canonical']);
  assert.deepEqual(item('todo', {}).handoffIntent, { kind: 'work-step', activity: null });
  assert.equal(item('meeting', {}).handoffIntent.kind, 'meeting');
  for (const t of ['nudge', 'capacity', 'imports', 'plan_closure', 'payroll_cutoff', null]) assert.equal(item(t, {}).handoffIntent, null, String(t));
  assert.equal(NH.jiraBrowse('http://insecure.example', 'NT-1'), null, 'only an https Jira base');
});

// ── Never from titles ────────────────────────────────────────────────────────

test('nothing is parsed from wording: a title, reason or subject naming an app or a link changes nothing', () => {
  const plain = composeWith({ primary: { kind: 'item', type: 'todo', urgency: 'high', title: 'Tidy up', recordId: 'r1', reason: 'x', meta: {} } });
  const loud = composeWith({ primary: { kind: 'item', type: 'todo', urgency: 'high', title: 'Write the email in Outlook https://evil.example/approve', recordId: 'r1', reason: 'Open Jira NT-1 spreadsheet code draft', meta: { subject: 'Join Teams https://teams.microsoft.com/x' } } });
  const pick = (p) => fields(p.candidates.find((c) => c.id === 'item:r1'));
  assert.deepEqual(pick(loud), pick(plain));
  const src = fs.readFileSync(require.resolve('./neuro-handoff'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(src.includes('handoffFor'), 'positive control');
  for (const bad of [/\.title\b/, /\.reason\b/, /\.subject\b/, /\.summary\b/, /\.description\b/, /\.text\b/, /\.line\b/]) assert.ok(!bad.test(src), `must not read ${bad}`);
});

test('every link NEURO emits is a valid target; none is an approve link', () => {
  const all = [];
  for (const s of SC.SCENARIOS) { const { candidates } = s.build(); for (const c of candidates.candidates) all.push(...c.targets); all.push(...candidates.constraints.targets); }
  for (const t of ['escalation', 'nova_flag', 'weekly_risk', 'source-blind']) all.push(...NH.handoffFor({ kind: 'attention-item', id: 'i', facts: { type: t } }, { ticket_key: 'NT-1', ticketKey: 'NT-1' }, { jiraBase: JIRA }).targets);
  assert.ok(all.length >= 5, 'positive control');
  for (const t of all) {
    assert.equal(C.targetsProblem([t], 't'), null, JSON.stringify(t));
    assert.ok(!/approve/i.test(t.href), t.href);
  }
});

// ── End to end: compose → policy → resolver ──────────────────────────────────

test('blind: the composer’s Sources link becomes the hand-off — from structured input alone', () => {
  const { candidates, decision } = SC.SCENARIOS.find((s) => s.id === '6a').build();
  assert.equal(decision.lead.rule, 'S1 blind');
  const out = H.resolveHandoff({ decision, candidates, device: device(Date.parse(decision.decidedAt)), now: Date.parse(decision.decidedAt) });
  assert.equal(out.handoff.primary.label, 'Open Sources in NEURO');
  assert.deepEqual(out.handoff.primary.target, { type: 'link', href: 'neuro:?view=sources', role: 'source' });
});

test('one unseen escalation: S2 hands off to that ticket in Jira; without a Jira base, honest no hand-off', () => {
  const card = { kind: 'item', type: 'escalation', urgency: 'critical', title: 'NT-14855 — Portal down', recordId: 'att_esc', reason: 'no reply', meta: { ticket_key: 'NT-14855', url: `${JIRA}/browse/NT-14855`, escalations: [{ key: 'NT-14855' }] } };
  const a = endToEnd(composeWith({ primary: card, jiraBase: JIRA }), NOW);
  assert.equal(a.decision.lead.rule, 'S2 critical risk');
  assert.deepEqual(a.out.handoff.primary, { label: 'Open Jira', target: { type: 'link', href: `${JIRA}/browse/NT-14855`, role: 'control' } });
  assert.deepEqual(a.out.handoff.alternatives, []);
  const b = endToEnd(composeWith({ primary: card, jiraBase: null }), NOW);
  assert.equal(b.out.handoff, null);
  assert.deepEqual(b.out.neuroGaps, ['control'], 'NEURO’s own gap travels with the answer');
});

test('a late weekly risk report: S2 opens the Weekly risk page in NEURO', () => {
  const card = { kind: 'item', type: 'weekly_risk', urgency: 'critical', title: 'Weekly risk report is late', recordId: 'att_wr', meta: {} };
  const { decision, out } = endToEnd(composeWith({ primary: card }), NOW);
  assert.equal(decision.lead.rule, 'S2 critical risk');
  assert.deepEqual(out.handoff.primary, { label: 'Open it in NEURO', target: { type: 'link', href: 'neuro:?view=weekly-risk', role: 'canonical' } });
});

test('a top email: S7 work step "email" → SAiM recommends the declared mail app', () => {
  const card = { kind: 'item', type: 'email', urgency: 'high', title: 'Reply to Sandford', recordId: 'att_mail', meta: { emailId: 'AAMk1' } };
  const { decision, out } = endToEnd(composeWith({ primary: card }), NOW);
  assert.equal(decision.lead.rule, 'S7 top item');
  assert.equal(out.handoff.primary.label, 'Open Outlook');
});

test('a task block, an approval and a meeting: no usable hand-off today, each with NEURO’s stated gaps', () => {
  const block = SC.SCENARIOS.find((s) => s.id === '1').build();
  const b = H.resolveHandoff({ decision: block.decision, candidates: block.candidates, device: device(Date.parse(block.decision.decidedAt)), now: Date.parse(block.decision.decidedAt) });
  assert.equal(b.rule, 'S5 protected block');
  assert.equal(b.handoff, null);
  assert.match(b.reason, /didn’t say what kind of work/);
  assert.deepEqual(b.neuroGaps.sort(), ['activity', 'canonical']);
  const ap = SC.SCENARIOS.find((s) => s.id === '2b').build();
  const a = H.resolveHandoff({ decision: ap.decision, candidates: ap.candidates, device: device(Date.parse(ap.decision.decidedAt)), now: Date.parse(ap.decision.decidedAt) });
  assert.equal(a.rule, 'S4 deadline inside the block');
  assert.equal(a.handoff, null);
  assert.deepEqual(a.neuroGaps, ['canonical']);
  const mt = SC.SCENARIOS.find((s) => s.id === '9a').build();
  const m = H.resolveHandoff({ decision: mt.decision, candidates: mt.candidates, device: device(Date.parse(mt.decision.decidedAt)), now: Date.parse(mt.decision.decidedAt) });
  assert.equal(m.rule, 'S3 meeting');
  assert.equal(m.handoff, null);
  assert.deepEqual(m.neuroGaps.sort(), ['join', 'prep', 'provider']);
});

test('degrade rule preserved on real composed data: a corrupted intent/link on the lead degrades, the decision stands', () => {
  const card = { kind: 'item', type: 'weekly_risk', urgency: 'critical', title: 'Weekly risk report is late', recordId: 'att_wr', meta: {} };
  const p = composeWith({ primary: card });
  const clean = POL.decide(p, { surface: 'work-desktop', now: NOW });
  for (const corrupt of [(c) => { c.targets = [{ role: 'canonical', href: 'javascript:alert(1)' }]; }, (c) => { c.handoffIntent = { kind: 'teleport' }; }, (c) => { c.handoffGaps = [{ field: 'mood', why: 'x' }]; }, (c) => { delete c.handoffIntent; delete c.targets; delete c.handoffGaps; }]) {
    const q = clone(p); corrupt(q.candidates.find((c) => c.id === 'item:att_wr'));
    assert.equal(C.checkCandidates(q).ok, true);
    const d = POL.decide(q, { surface: 'work-desktop', now: NOW });
    assert.deepEqual(d, clean, 'the decision is untouched');
    const out = H.resolveHandoff({ decision: d, candidates: q, device: device(NOW), now: NOW });
    assert.equal(out.handoff, null);
    assert.equal(out.refused, undefined);
    assert.ok(out.reason, 'an honest reason');
  }
});
