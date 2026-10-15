'use strict';

// The attention contract end to end, pure: NEURO candidates (neuro-candidates-v1)
// → SAiM Attention Policy (saim-attention-v1). Fixture = the live 17:11 read on
// 14 Oct 2026 that put the control and Alt at odds.

const test = require('node:test');
const assert = require('node:assert/strict');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');

const at = (h, m, d = 14) => new Date(2026, 9, d, h, m).getTime();
const iso = (h, m, d = 14) => new Date(at(h, m, d)).toISOString();
const NT = 'NT-24162: Survey West Hants Responses not showing on CSV and Being recorded';
const WH = 'West Hants Tennis Club: resolve the outstanding ticket tomorrow (8 October 2026). Must do tomorrow.';
const work = { value: 'work', basis: 'classified', why: 'x' };
const cal = (sh, sm, eh, em, subject, attendeesOther, sp = work) => ({
  eventId: subject, source: 'graph', subject,
  start: `2026-10-14T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00.0000000`,
  end: `2026-10-14T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00.0000000`,
  startAt: iso(sh, sm), endAt: iso(eh, em), allDay: false, showAs: 'busy', attendeesOther, sphere: sp,
});
const commit = (id, description, date, sphere = 'work') => ({
  id: `commitment:task:${id}`, direction: 'i-owe', state: 'open', description, taskId: `task:neuro:${id}`,
  due: { date, kind: 'set' }, domains: { known: true, domains: [{ domain: sphere, basis: 'default' }], sphere, basis: 'default' },
});

function scenario({ now = at(17, 11), approvalExpires = '2026-10-15T05:00:00.000Z', block = true, calendar = null, home = null, personalDates = null } = {}) {
  const payload = {
    poolAvailable: true,
    context: { activity: 'ritual', duty: { onDuty: true } },
    work: { atDesk: true, deskKnown: true },
    primary: { kind: 'context', id: 'context-ritual', title: 'EOD outstanding', reason: 'The end-of-day wrap hasn’t been done yet.' },
    secondary: [{ kind: 'item', type: 'capacity', title: 'More work due by the end of today than you have time for', urgency: 'normal', recordId: 7 }],
    dropped: [],
    utterances: [{ say: 'Show me everything', intent: { kind: 'reveal' } }],
    approvals: { known: true, needsApproval: 1, needsReview: 0, say: '1 drafted email waits for your approval (a agenda request) — Actions, in NEURO on the desktop.', where: 'Actions, in NEURO on the desktop' },
    situation: { sections: { commitments: [
      commit(283, 'Nick Ward to send breakdown of Parsons contacts', '2026-10-14'),
      commit(345, NT, '2026-10-14'),
      commit(375, WH, '2026-10-14'),
    ] } },
    home, personalDates,
  };
  const rows = [
    ...(block ? [{ blockId: 115, dateKey: '2026-10-14', startTime: '16:00', endTime: '17:30', status: 'scheduled', passed: false, tasks: [{ taskId: 345, text: NT }] }] : []),
    { blockId: 118, dateKey: '2026-10-14', startTime: '17:30', endTime: '17:45', status: 'scheduled', passed: false, tasks: [{ taskId: 400, text: 'File the expenses' }] },
  ];
  const live = {
    rows,
    block: block ? { blockId: 115, startTime: '16:00', endTime: '17:30', running: true, tasks: [{ taskId: 345, text: NT, running: false }], allTicked: false } : null,
    session: null,
  };
  const facts = {
    calendar: calendar || [],
    calendarKnown: true,
    approvals: [{ actionId: 'pa_1', type: 'chase_agenda', status: 'prepared', expiresAt: approvalExpires, mailbox: 'work', title: 'chase agenda: The London Office Regroup' }],
    taskDomains: new Map([[345, { domain: 'work', basis: 'default' }], [400, { domain: 'work', basis: 'default' }]]),
    workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: iso(8, 0), todayEnd: iso(18, 0), nextStart: iso(8, 0, 15) },
  };
  return { candidates: NC.compose(payload, live, facts, { now }), now };
}
const decide = (s, surface) => POL.decide(s.candidates, { surface, now: s.now });

// ── NEURO candidates: facts, no judgement ─────────────────────────────────────

test('candidates: facts with provenance and sphere — and no lead, rule or recommendation', () => {
  const { candidates } = scenario();
  assert.equal(candidates.contract, 'neuro-candidates-v1');
  const kinds = candidates.candidates.map((c) => c.kind);
  for (const k of ['block', 'approval', 'attention-item', 'ritual', 'commitment']) assert.ok(kinds.includes(k), k);
  for (const c of candidates.candidates) {
    assert.ok(c.sphere && c.sphere.value, `${c.id} carries a sphere`);
    assert.ok(c.provenance && c.provenance.source, `${c.id} carries provenance`);
  }
  assert.ok(!JSON.stringify(candidates).match(/"(lead|recommended|rule)"/), 'NEURO’s field carries no judgement');
  const blk = candidates.candidates.find((c) => c.id === 'block:115');
  assert.equal(blk.facts.state, 'running');
  assert.equal(blk.sphere.basis, 'default', 'a default task domain says it is only the default');
});

test('candidates: wording that contradicts the planned date is a NEURO fact on the record', () => {
  const { candidates } = scenario();
  const wh = candidates.candidates.find((c) => c.taskId === 375);
  assert.match(wh.facts.wordingConflict, /“tomorrow” but it’s planned for today/);
  assert.equal(candidates.candidates.find((c) => c.taskId === 283).facts.wordingConflict, null);
  assert.equal(NC.wordingConflict('Set Heidi’s end date before September 30', '2026-10-14', at(17, 0)), null, 'a bare deadline is not judged');
});

test('candidates: an unclassified calendar is unknown, never guessed', () => {
  const { candidates } = scenario({ calendar: [cal(17, 45, 18, 0, 'Drop-in', false, null)] });
  const p = candidates.candidates.find((c) => c.kind === 'protected-time');
  assert.equal(p.sphere.value, 'unknown');
});

// ── SAiM policy: the approved 17:11 outcome ─────────────────────────────────

test('17:11, work desktop: the running block leads (S5); the agenda request is judgement with an effective deadline of 18:00', () => {
  const d = decide(scenario(), 'work-desktop');
  assert.equal(d.contract, 'saim-attention-v1');
  assert.equal(d.owner, 'saim');
  assert.equal(d.lead.rule, 'S5 protected block');
  assert.equal(d.lead.ref, 'block:115');
  assert.equal(d.lead.title, NT);
  assert.deepEqual(d.protected, { ref: 'block:115', kind: 'block', what: NT, until: '17:30' });
  assert.equal(d.judgement.length, 1);
  assert.equal(d.judgement[0].effectiveDeadline, iso(18, 0));
  assert.match(d.judgement[0].effectiveBasis, /expires before you next start/);
  assert.equal(d.recommended.say, 'I’m on it');
  assert.equal(d.recommended.intent.kind, 'start-block');
  const s4 = d.trace.find((t) => t.rule === 'S4 deadline inside the block');
  assert.equal(s4.applies, false);
  assert.match(s4.why, /effective deadline 18:00 today/);
});

test('17:11: the ritual, the capacity item and tasks due today are held until 17:30; the block’s own task is not', () => {
  const d = decide(scenario(), 'work-desktop');
  const refs = d.held.map((h) => h.ref);
  assert.ok(refs.includes('ritual:eod'));
  assert.ok(refs.includes('item:7'));
  assert.ok(refs.includes('commitment:task:283'));
  assert.ok(!refs.includes('commitment:task:345'));
  assert.ok(d.held.every((h) => h.returns === 'at 17:30'));
  const wh = d.held.find((h) => h.ref === 'commitment:task:375');
  assert.equal(wh.title, 'West Hants Tennis Club: resolve the outstanding ticket', 'SAiM never repeats the stale clause');
  assert.deepEqual(d.corrections.map((c) => c.taskId), [375]);
});

test('17:30, block over: the agenda request leads (S6), before 18:00 today', () => {
  const d = decide(scenario({ now: at(17, 31), block: false }), 'work-desktop');
  assert.equal(d.lead.rule, 'S6 judgement waiting');
  assert.match(d.lead.why, /before 18:00 today/);
  assert.equal(d.recommended.handOff, 'Actions, in NEURO on the desktop');
});

test('an approval whose effective deadline falls inside the block interrupts it (S4); the block stays protected', () => {
  const d = decide(scenario({ approvalExpires: iso(17, 20) }), 'work-desktop');
  assert.equal(d.lead.rule, 'S4 deadline inside the block');
  assert.equal(d.protected.ref, 'block:115');
});

test('a running meeting with others outranks the block; a critical item outranks both', () => {
  const s = scenario({ calendar: [cal(17, 0, 17, 25, 'Weekly support leads', true)] });
  assert.equal(decide(s, 'work-desktop').lead.rule, 'S3 meeting');
  s.candidates.candidates.push({ kind: 'attention-item', id: 'item:9', recordId: 9, title: 'NT-1 breaching', facts: { severity: 'critical', reason: 'SLA breached', gatePosition: 'secondary' }, sphere: work, actions: [], provenance: { source: 'attention.gate' } });
  assert.equal(decide(s, 'work-desktop').lead.rule, 'S2 critical');
});

// ── Scope ───────────────────────────────────────────────────────────────────

test('home scope: work never leads and never appears as held work — it is only counted', () => {
  const d = decide(scenario(), 'home-pi');
  assert.equal(d.scope.id, 'home');
  assert.equal(d.lead.rule, 'S11 nothing');
  assert.equal(d.protected, null);
  assert.equal(d.held.count, 0);
  assert.equal(d.judgement.length, 0);
  assert.ok(d.scope.excluded.work >= 5);
});

test('home scope: a family date that needs action leads; the work block is invisible', () => {
  const s = scenario({ personalDates: { active: [{ id: 'pd:1', kind: 'anniversary', date: '2026-10-19', person: 'Helen', state: 'action-may-be-needed', line: 'Wedding anniversary on Monday — card not done' }] } });
  const home = decide(s, 'home-pi');
  assert.equal(home.lead.ref, 'pd:1');
  assert.equal(home.lead.rule, 'S7 top item');
  const desk = decide(s, 'work-desktop');
  assert.equal(desk.lead.ref, 'block:115', 'different scopes may legitimately lead differently');
  assert.ok(desk.held.some((h) => h.ref === 'pd:1'), 'relevant personal context still reaches the work surface, held');
});

test('work scope: unknown sphere is shown; personal context only when relevant now', () => {
  const s = scenario();
  s.candidates.candidates.push({ kind: 'commitment', id: 'c:later', taskId: 9, title: 'Book the vet', time: { due: '2026-10-20' }, facts: { daysLate: -6, wordingConflict: null }, sphere: { value: 'personal', basis: 'set' }, actions: [], provenance: {} });
  const d = decide(s, 'work-desktop');
  assert.equal(d.scope.excluded.personal, 1);
});

// ── Consistency within a scope ──────────────────────────────────────────────

test('within a scope the lead, rule and protected context are identical on every manifestation', () => {
  const variants = [scenario(), scenario({ now: at(17, 31), block: false }), scenario({ approvalExpires: iso(17, 20) }),
    scenario({ personalDates: { active: [{ id: 'pd:1', kind: 'birthday', date: '2026-10-15', person: 'Isaac', state: 'action-may-be-needed', line: 'Isaac’s birthday tomorrow' }] } })];
  const byScope = {};
  for (const [id, sf] of Object.entries(POL.SURFACES)) (byScope[sf.scope] = byScope[sf.scope] || []).push(id);
  for (const s of variants) {
    for (const ids of Object.values(byScope)) {
      const ds = ids.map((id) => decide(s, id));
      for (const d of ds.slice(1)) {
        assert.deepEqual([d.lead.ref, d.lead.rule, d.protected], [ds[0].lead.ref, ds[0].lead.rule, ds[0].protected], `${ids.join('/')} agree`);
      }
    }
  }
});

test('manifestation changes only the shape: home has no buttons, phone at most two actions', () => {
  const s = scenario();
  const pi = decide(s, 'home-pi');
  assert.equal(pi.alternatives.length, 0);
  const phone = decide(s, 'phone');
  assert.ok(1 + phone.alternatives.length <= 2);
  assert.equal(typeof phone.held.count, 'number');
  assert.throws(() => POL.decide(s.candidates, { surface: 'toaster', now: s.now }), /unknown surface/);
});

test('blind: an unread attention pool leads on work surfaces only', () => {
  const s = scenario();
  s.candidates.constraints.poolReadable = false;
  assert.equal(decide(s, 'work-desktop').lead.rule, 'S1 blind');
  assert.notEqual(decide(s, 'home-pi').lead.rule, 'S1 blind');
});

test('the policy is SAiM’s: it requires nothing from NEURO’s backend', () => {
  const src = require('fs').readFileSync(require.resolve('../../saim/policy/attention-policy.cjs'), 'utf8');
  assert.doesNotMatch(src, /require\(['"][^'"]*backend/);
  assert.doesNotMatch(src, /require\(['"]\.\.?\/(services|db)/);
  assert.match(src, /module\.exports = \{ CONTRACT/, 'positive control: the scan read the policy file');
  assert.match(require('fs').readFileSync(require.resolve('./neuro-candidates'), 'utf8'), /require\('\.\.\/db\/database'\)/, 'positive control: the same scan does see a backend require');
});

test('live 15 Oct: a household obligation is said neutrally and its stale wording becomes a correction', () => {
  const s = scenario({ home: { needsYou: [{ kind: 'obligation', id: 'task:neuro:374', title: 'Book my car in for its MOT tomorrow (8 October 2026). Must do tomorrow.', why: 'still open, 3 days past its date' }] } });
  // compose again with the task's planned date, as gather() supplies it
  const raw = s.candidates;
  const homeC = raw.candidates.find((c) => c.kind === 'home');
  assert.equal(homeC.taskId, 374);
  const again = NC.compose({ home: { needsYou: [{ kind: 'obligation', id: 'task:neuro:374', title: homeC.title, why: 'still open, 3 days past its date' }] } }, {}, { taskDue: new Map([[374, '2026-10-12']]) }, { now: s.now });
  const h = again.candidates.find((c) => c.kind === 'home');
  assert.match(h.facts.wordingConflict, /says “tomorrow” but it’s planned for 12 October 2026/);
  const d = POL.decide(again, { surface: 'home-pi', now: s.now });
  assert.equal(d.lead.title, 'Book my car in for its MOT');
  assert.doesNotMatch(d.lead.why, /tomorrow|8 October|\.\./);
  assert.deepEqual(d.corrections.map((c) => c.taskId), [374]);
});
