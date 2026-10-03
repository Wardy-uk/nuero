'use strict';

/**
 * Build 10 — the canonical read contract, PURE half.
 *
 * Everything here runs without a database: the shapers take a row and return
 * what a surface renders. The routing suite (routes/canonical-routing.test.js)
 * proves the same shapes come off real projection rows through real HTTP.
 *
 * Numbering follows the Build 10S list in the build record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('./canonical-read');
const domains = require('../../shared/life-domains.cjs');

const TODAY = '2026-10-03';

function commitment(over = {}) {
  return {
    commitmentId: 'commitment:waiting:abc',
    description: 'Send the figures',
    direction: 'to-nick',
    promisor: { personId: 'person:abdi-mohamed', displayName: 'Abdi Mohamed', raw: 'Abdi', method: 'exact-alias', confidence: 1, unresolvedWhy: null },
    beneficiary: { kind: 'person', personId: null, displayName: null, raw: null, method: null },
    status: 'open',
    due: null,
    source: { kind: 'meeting-waiting-on', ref: 'waiting-on:abdi', path: 'Meetings/2026/09/x.md', line: 3, date: '2026-09-21' },
    meeting: null, meetingId: null, relatedTaskId: null,
    provenance: { kind: 'observation', confidence: 0.8, evidence: ['e1'] },
    createdAt: '2026-09-21', observedAt: '2026-10-03T10:00:00Z',
    ...over,
  };
}

const ABDI = { personId: 'person:abdi-mohamed', displayName: 'Abdi Mohamed', team: 'Support', directReport: true, manager: 'Nick Ward' };
const people = new Map([[ABDI.personId, ABDI]]);

// ── life domains ────────────────────────────────────────────────────────────

test('28. domain unknown stays unknown — no evidence, no domain, no sphere', () => {
  const r = domains.resolveDomains([]);
  assert.deepEqual(r.domains, []);
  assert.equal(r.sphere, null);
  assert.equal(r.known, false);
  // A commitment whose counterpart is unresolved and has no task carries none.
  const shaped = c.shapeCommitment(commitment({ promisor: { personId: null, raw: 'Chris', unresolvedWhy: 'the first name "Chris" belongs to 2 declared people' } }), { today: TODAY, people });
  assert.equal(shaped.domains.known, false);
  assert.deepEqual(shaped.domains.domains, []);
});

test('29. one entity may carry more than one justified domain', () => {
  const r = domains.resolveDomains([
    { domain: 'fitness', basis: 'declared' },
    { domain: 'ember', basis: 'declared' },
  ]);
  assert.deepEqual(r.domains.map((d) => d.domain), ['fitness', 'ember']);
  assert.equal(r.sphere, 'personal');
});

test('a declared domain replaces every inference — Nick speaking about his own life wins', () => {
  const r = domains.resolveDomains([
    { domain: 'work', basis: 'inference' },
    { domain: 'learning', basis: 'declared' },
  ]);
  assert.deepEqual(r.domains.map((d) => d.domain), ['learning']);
});

test('sensitive domains are never inferred from weak evidence', () => {
  for (const d of ['health', 'family', 'finance']) {
    assert.deepEqual(domains.resolveDomains([{ domain: d, basis: 'inference' }]).domains, [], `${d} inferred`);
    assert.deepEqual(domains.resolveDomains([{ domain: d, basis: 'default' }]).domains, [], `${d} by default`);
  }
  // Positive control: declared or intrinsic IS admitted.
  assert.equal(domains.resolveDomains([{ domain: 'health', basis: 'intrinsic' }]).domains.length, 1);
  assert.equal(domains.resolveDomains([{ domain: 'family', basis: 'declared' }]).domains.length, 1);
});

test('30. no source→domain hardcoding: a calendar meeting is NOT work for being on a calendar', () => {
  const graphMeeting = { meetingId: 'graph:x', title: 'Dentist', sources: [{ provider: 'graph' }], people: [] };
  assert.equal(c.meetingDomains(graphMeeting, { people }).known, false, 'an Outlook event with no colleague in it has no domain');
  // Positive control: a colleague in it IS evidence.
  const withAbdi = { ...graphMeeting, people: [{ personId: ABDI.personId, displayName: 'Abdi Mohamed' }] };
  const r = c.meetingDomains(withAbdi, { people });
  assert.deepEqual(r.domains.map((d) => d.domain), ['work']);
  assert.equal(r.domains[0].basis, 'inference');
});

test('a People note saying "Unknown" proves nothing', () => {
  assert.equal(c.personWorkEvidence({ displayName: 'Liam', team: 'Unknown', directReport: 0 }), null);
  assert.equal(c.personWorkEvidence({ displayName: 'Riannah', team: '(to confirm)' }), null);
});

test('a task stored as work is reported as the DEFAULT, never as evidence', () => {
  const r = c.taskDomains({ domain: 'work', household: false });
  assert.equal(r.domains[0].domain, 'work');
  assert.equal(r.domains[0].basis, 'default');
  const p = c.taskDomains({ domain: 'personal', household: false });
  assert.equal(p.sphere, 'personal');
  assert.deepEqual(p.domains, [], 'personal says the sphere, not which personal domain');
  const h = c.taskDomains({ domain: 'personal', household: true });
  assert.deepEqual(h.domains.map((d) => d.domain), ['home']);
});

// ── commitments ─────────────────────────────────────────────────────────────

test('3. unresolved identity stays VISIBLE with its raw name and reason', () => {
  const shaped = c.shapeCommitment(commitment({ promisor: { personId: null, raw: 'Chris', unresolvedWhy: 'the first name "Chris" belongs to 2 declared people' } }), { today: TODAY, people });
  assert.equal(shaped.counterpart.status, 'unresolved');
  assert.equal(shaped.counterpart.name, 'Chris');
  assert.match(shaped.counterpart.why, /belongs to 2/);
  assert.equal(shaped.counterpart.personId, null, 'never guessed onto a colleague');
});

test('"nobody named" is not an unresolved identity, and is not counted as one', () => {
  const mine = c.shapeCommitment(commitment({ direction: 'by-nick', promisor: { personId: 'person:nick-ward', raw: 'Nick' }, beneficiary: { kind: 'unknown', personId: null, raw: null } }), { today: TODAY, people });
  assert.equal(mine.direction, 'i-owe');
  assert.equal(mine.counterpart.status, 'not-named');
  const unresolved = c.shapeCommitment(commitment({ promisor: { personId: null, raw: 'Chris', unresolvedWhy: 'x' } }), { today: TODAY, people });
  const counts = c.summariseCommitments([mine, unresolved]);
  assert.equal(counts.unresolved, 1);
  assert.equal(counts.notNamed, 1);
});

test('a due date says what KIND of date it is; only a stated deadline is "overdue"', () => {
  assert.equal(c.dueContext({ date: '2026-09-30', basis: 'stated' }, TODAY).relative, 'overdue');
  assert.equal(c.dueContext({ date: '2026-09-30', basis: 'set' }, TODAY).kind, 'set');
  assert.equal(c.dueContext({ date: '2026-09-30', basis: 'default' }, TODAY).kind, 'placeholder');
  assert.match(c.dueContext({ date: '2026-09-30', basis: 'stated' }, TODAY).label, /3 days past · stated deadline/);
  const none = c.dueContext(null, TODAY);
  assert.equal(none.relative, 'none');
  const counts = c.summariseCommitments([
    c.shapeCommitment(commitment({ due: { date: '2026-09-30', basis: 'set' } }), { today: TODAY, people }),
    c.shapeCommitment(commitment({ due: { date: '2026-09-30', basis: 'stated' } }), { today: TODAY, people }),
  ]);
  assert.equal(counts.overdue, 1, 'an overdue PLAN is not a broken promise');
});

test('2. a meeting link renders from the world model, linked or explicitly not', () => {
  const linked = c.shapeCommitment(commitment({ meetingId: 'graph:m1', meeting: { notePath: 'Meetings/2026/09/2026-09-18 – Ops Review.md', occurrence: { start: '2026-09-18T16:00', meetingId: 'graph:m1' } } }), { today: TODAY, people });
  assert.equal(linked.meeting.linked, true);
  assert.equal(linked.meeting.title, 'Ops Review');
  assert.equal(linked.meeting.start, '2026-09-18T16:00');
  const unlinked = c.shapeCommitment(commitment({ meeting: { notePath: 'Meetings/2026/04/2026-04-30 – 1-2-1 Naomi.md', occurrence: null, why: 'no calendar occurrence with other people overlaps the recording' } }), { today: TODAY, people });
  assert.equal(unlinked.meeting.linked, false);
  assert.match(unlinked.meeting.why, /no calendar occurrence/);
});

test('fact / observation / inference travels on every commitment', () => {
  const s = c.shapeCommitment(commitment(), { today: TODAY, people });
  assert.equal(s.provenance.kind, 'observation');
  assert.equal(s.provenance.confidence, 0.8);
});

// ── sources ─────────────────────────────────────────────────────────────────

const desc = (over = {}) => ({ sourceId: 'healthkit.neuro-ios', label: 'Health', what: 'sleep', importance: 'medium', lifecycle: 'expected', staleAfterMs: 1, ...over });

test('6. quiet is not stale', () => {
  assert.equal(c.sourceVerdict({ known: true, state: 'healthy', freshness: 'quiet' }, 'expected'), 'quiet');
  assert.equal(c.sourceVerdict({ known: true, state: 'healthy', freshness: 'stale' }, 'expected'), 'stale');
  assert.equal(c.sourceMatters(c.shapeSource({ known: true, state: 'healthy', freshness: 'quiet' }, desc())), false, 'quiet never asks for attention');
});

test('7. stale is not failing — and failing-and-stale shows both columns', () => {
  const s = c.shapeSource({ known: true, state: 'failing', freshness: 'stale', consecutiveFailures: 4 }, desc());
  assert.equal(s.verdict, 'failing');
  assert.equal(s.transport.state, 'failing');
  assert.equal(s.freshness.state, 'stale', 'the stale column is not collapsed into failing');
  assert.equal(c.sourceVerdict({ known: true, state: 'healthy', freshness: 'stale' }, 'expected'), 'stale');
});

test('8. unknown is not healthy', () => {
  assert.equal(c.sourceVerdict(null, 'expected'), 'unknown');
  assert.equal(c.sourceVerdict({ known: false, state: 'unknown', freshness: 'unknown' }, 'expected'), 'unknown');
  assert.equal(c.sourceVerdict({ known: true, state: 'healthy', freshness: 'unknown' }, 'expected'), 'unknown', 'healthy transport with no freshness verdict is not "seeing"');
  const s = c.shapeSource(null, desc());
  assert.notEqual(s.verdict, 'seeing');
  assert.equal(s.transport.state, 'unknown');
});

test('9. a retired source is never an active blind source', () => {
  const s = c.shapeSource({ known: true, state: 'healthy', freshness: 'stale', lifecycle: 'retired' }, desc({ lifecycle: 'retired' }));
  assert.equal(s.verdict, 'retired');
  assert.equal(c.sourceMatters(s), false);
  // Positive control: the same row, expected, DOES matter.
  assert.equal(c.sourceMatters(c.shapeSource({ known: true, state: 'healthy', freshness: 'stale' }, desc())), true);
});

test('a source serves a domain only by what its data IS, never by transport', () => {
  assert.deepEqual(c.shapeSource(null, desc()).domains.map((d) => d.domain), ['health', 'fitness']);
  assert.deepEqual(c.shapeSource(null, desc({ sourceId: 'microsoft.calendar' })).domains, [], 'a calendar serves no domain by itself');
  assert.deepEqual(c.shapeSource(null, desc({ sourceId: 'eventkit.neuro-ios' })).domains, []);
});

// ── findings ────────────────────────────────────────────────────────────────

const riskRow = (over = {}) => ({
  findingId: 'commitment-risk:commitment:task:344:1', commitmentId: 'commitment:task:344', status: 'active', level: 'high',
  novelty: 'repeated', summary: 'You committed to X, due 30 Sep; still open.', why: 'overdue: 3 days overdue',
  triggers: [{ kind: 'overdue' }], evidence: { commitment: { id: 'commitment:task:344', source: { kind: 'meeting-task' } }, direction: 'by-nick' },
  confidence: 0.75, firstCreatedAt: '2026-10-03T11:30:10Z', resolvedAt: null,
  attention: { mode: 'shadow', decidedAt: '2026-10-03T11:30:10Z', push: false, why: 'Focus mode is on', shadow: true, sent: false },
  ...over,
});

test('18. the findings screen shows shadow/live state', () => {
  const f = c.shapeFinding('commitment-risk', riskRow(), 'shadow');
  assert.equal(f.shadow, true);
  assert.equal(f.mode, 'shadow');
  assert.equal(f.attention.shadow, true);
  assert.equal(f.attention.sent, false);
  const live = c.shapeFinding('source-blindness', { findingId: 'sb:1', source: 'healthkit.neuro-ios', label: 'Health', status: 'active', condition: 'stale', change: 'new', whyItMatters: 'w', confidence: 0.9, severity: 'medium', firstDetectedAt: 't', evidence: [12, 13], attention: null }, 'live');
  assert.equal(live.shadow, false);
});

test('19. the suppression reason renders', () => {
  const f = c.shapeFinding('commitment-risk', riskRow(), 'shadow');
  assert.equal(f.attention.wouldInterrupt, false);
  assert.equal(f.attention.suppressedBecause, 'Focus mode is on');
});

test('20. no chain-of-thought is exposed — only audit fields, and evidence refs are ids', () => {
  const f = c.shapeFinding('commitment-risk', riskRow({ attention: { push: false, why: 'quiet hours', reasoning: 'SECRET-THOUGHT', prompt: 'SECRET-PROMPT' } }), 'shadow');
  const json = JSON.stringify(f);
  assert.ok(!json.includes('SECRET-THOUGHT') && !json.includes('SECRET-PROMPT'), 'raw model reasoning leaked into the payload');
  for (const banned of ['reasoning', 'prompt', 'thinking', 'chainOfThought']) assert.ok(!(banned in f));
  // Evidence references are ids, never stray words from the blob.
  assert.ok(f.evidenceRefs.includes('commitment:task:344'));
  assert.ok(!f.evidenceRefs.includes('by-nick'));
  assert.equal(f.versionRecorded, false, 'the version is the current code\'s and says so');
});

// ── Now ─────────────────────────────────────────────────────────────────────

const item = (over) => ({
  id: over.id, kind: 'commitment', description: over.description || over.id, direction: 'i-owe',
  counterpart: { status: 'not-named', name: null }, state: 'open',
  due: c.dueContext(over.due || { date: '2026-10-04', basis: 'stated' }, TODAY),
  domains: over.domains || domains.resolveDomains([]), importance: over.importance || null, provenance: { kind: 'fact' },
});

test('11. one canonical item does not render three times', () => {
  const decision = { primary: { kind: 'item', title: 'Send the figures' }, secondary: [], context: { label: 'Steady' }, poolAvailable: true };
  const out = c.composeNow({
    decision,
    nextEvents: [{ id: 'm1', title: 'Send the figures', domains: domains.resolveDomains([]) }],
    commitments: [item({ id: 'c1', description: 'Send the figures' })],
  });
  assert.equal(out.sections.commitments, null, 'the decision already shows it; the commitments section must not repeat it');
  assert.equal(out.sections.nextEvent, null);
});

test('12. work does not automatically outrank a personal item', () => {
  // ⚠ Ids chosen so the final id tie-break would put WORK first ('a' < 'z'):
  // only the personal-importance rule can lift the personal item, so this test
  // cannot pass by alphabetical accident (it did, until a mutation showed it).
  const work = item({ id: 'a-work', due: { date: '2026-10-04', basis: 'stated' }, domains: domains.resolveDomains([{ domain: 'work', basis: 'inference' }]) });
  const personal = item({ id: 'z-ember', due: { date: '2026-10-04', basis: 'stated' }, domains: domains.resolveDomains([{ domain: 'ember', basis: 'declared' }]), importance: 'personally-important' });
  assert.equal(c.rankNowCommitments([{ ...personal, importance: null }, work])[0].id, 'a-work', 'positive control: without the importance, the tie-break favours work');
  const ranked = c.rankNowCommitments([work, personal]);
  assert.equal(ranked[0].id, 'z-ember', 'equal timing: what Nick said matters to him leads');
  // And domain alone moves nothing: two equal items rank by date/id, not domain.
  const w2 = item({ id: 'a-work', domains: domains.resolveDomains([{ domain: 'work', basis: 'inference' }]) });
  const p2 = item({ id: 'b-home', domains: domains.resolveDomains([{ domain: 'home', basis: 'declared' }]) });
  assert.deepEqual(c.rankNowCommitments([p2, w2]).map((x) => x.id), ['a-work', 'b-home'], 'order is the id tie-break, not the domain');
  assert.deepEqual(c.rankNowCommitments([w2, p2]).map((x) => x.id), ['a-work', 'b-home']);
});

test('13. no meaningful state produces the calm state', () => {
  const out = c.composeNow({ decision: { primary: null, secondary: [], context: { label: 'Steady' }, poolAvailable: true, gaps: [] } });
  assert.equal(out.calm, true);
  assert.equal(out.calmSay, 'Nothing needs you right now.');
});

test('14. uncertainty renders honestly — calm is never claimed over a blind read', () => {
  const out = c.composeNow({ decision: { primary: null, secondary: [], context: { label: 'Steady' }, poolAvailable: false }, gaps: [{ input: 'meetings', why: 'x' }] });
  assert.equal(out.calm, false);
  assert.match(out.calmSay, /not an all-clear/);
  assert.equal(out.uncertainty.unreadable, true);
});

test('off duty holds known-work items back and SAYS so; unknown-domain items are not hidden', () => {
  const decision = { primary: null, secondary: [], context: { label: 'Weekend' }, life: { showWork: false }, poolAvailable: true };
  const workMeeting = { id: 'm1', title: 'Tech Leadership', domains: domains.resolveDomains([{ domain: 'work', basis: 'inference' }]) };
  const unknownEvent = { id: 'm2', title: 'Vet', domains: domains.resolveDomains([]) };
  const out = c.composeNow({ decision, nextEvents: [workMeeting, unknownEvent], commitments: [] });
  assert.equal(out.sections.nextEvent.title, 'Vet');
  assert.equal(out.workHeld.count, 1);
  assert.match(out.workHeld.say, /held back while you're off duty/);
  // Positive control: on duty, the work meeting leads.
  const onDuty = c.composeNow({ decision: { ...decision, life: { showWork: true } }, nextEvents: [workMeeting, unknownEvent] });
  assert.equal(onDuty.sections.nextEvent.title, 'Tech Leadership');
  assert.equal(onDuty.workHeld, null);
});

test('only a stated deadline or a near plan reaches Now — never a placeholder or a stale plan', () => {
  assert.equal(c.commitmentIsNowRelevant(item({ id: 'a', due: { date: '2026-10-03', basis: 'default' } })), false);
  assert.equal(c.commitmentIsNowRelevant(item({ id: 'b', due: { date: '2026-09-20', basis: 'set' } })), false);
  assert.equal(c.commitmentIsNowRelevant(item({ id: 'c', due: { date: '2026-09-30', basis: 'stated' } })), true);
  assert.equal(c.commitmentIsNowRelevant(item({ id: 'd', due: { date: '2026-08-01', basis: 'stated' } })), false, 'too old for Now');
});

test('crowded-out is said only on evidence: a full work day AND a personal thing due', () => {
  const personal = [item({ id: 'p' })];
  assert.equal(c.crowdedOut({ workMeetingMinutes: 120, personalDue: personal }), null);
  assert.equal(c.crowdedOut({ workMeetingMinutes: 400, personalDue: [] }), null);
  const out = c.crowdedOut({ workMeetingMinutes: 360, personalDue: personal });
  assert.match(out.say, /Meetings fill 6h/);
});

test('coverage by domain keeps empty domains as rows and counts unknown', () => {
  const cov = c.coverageByDomain({
    commitmentItems: [item({ id: 'x', domains: domains.resolveDomains([{ domain: 'work', basis: 'inference' }]) }), item({ id: 'y' })],
    sourceItems: [c.shapeSource(null, desc())],
    goals: [], events: [],
  });
  assert.equal(cov.domains.length, domains.DOMAINS.length);
  assert.equal(cov.domains.find((r) => r.domain === 'work').commitments, 1);
  assert.equal(cov.domains.find((r) => r.domain === 'health').sources, 1);
  assert.equal(cov.domains.find((r) => r.domain === 'finance').commitments, 0);
  assert.equal(cov.unknown.commitments, 1);
});
