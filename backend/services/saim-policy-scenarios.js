'use strict';

/**
 * The SAiM Attention Policy decision table, as data (15 Oct 2026).
 *
 * Each scenario is a set of NEURO facts, run through the REAL candidate
 * composer (`neuro-candidates.compose`) and the REAL policy
 * (`saim/policy/attention-policy.cjs`) for one surface. The test
 * (`saim-policy-scenarios.test.js`) asserts the outcome; the generator
 * (`scripts/saim-policy-table.js`) prints the same runs as the contract's
 * decision table, so the table cannot drift from what the code does.
 *
 * Day: Thursday 15 Oct 2026, a working day, hours 08:00–18:00, local time.
 * Test fixture only — nothing here is read at runtime.
 */

const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');

const at = (h, m, d = 15) => new Date(2026, 9, d, h, m).getTime();
const iso = (h, m, d = 15) => new Date(at(h, m, d)).toISOString();
const wall = (h, m, d = 15) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.0000000`;
const WORK = { value: 'work', basis: 'classified', why: 'you classified the Outlook calendar as work' };

const commit = (id, description, date, sphere = 'work') => ({
  id: `commitment:task:${id}`, direction: 'i-owe', state: 'open', description, taskId: `task:neuro:${id}`,
  due: { date, kind: 'set' }, domains: { known: true, domains: [{ domain: sphere, basis: 'set' }], sphere: sphere === 'work' ? 'work' : 'personal', basis: 'set' },
});
const card = (type, urgency, title, extra = {}) => ({ kind: 'item', type, urgency, title, recordId: extra.recordId || `r-${type}`, reason: extra.reason || null, meta: extra.meta || null });
const meetingEvent = (sh, sm, eh, em, subject) => ({
  eventId: subject, source: 'graph', subject, start: wall(sh, sm), end: wall(eh, em), startAt: iso(sh, sm), endAt: iso(eh, em),
  allDay: false, showAs: 'busy', attendeesOther: true, sphere: WORK,
});

/**
 * One scenario → candidates → decision.
 * opts: now, surface, block {id,start,end,task}, approvals [{id,expiresAt,title}], calendar, payload overrides,
 *       unreadable (pool/diary/blocks/approvals/home all unread).
 */
function build(o) {
  const now = o.now;
  const blk = o.block || null;
  const rows = o.unreadable ? null : blk ? [{ blockId: blk.id, dateKey: '2026-10-15', startTime: blk.start, endTime: blk.end, status: 'scheduled', passed: false, tasks: [{ taskId: blk.taskId, text: blk.task }] }] : [];
  const live = {
    rows,
    session: null,
    block: blk && !o.unreadable ? { blockId: blk.id, startTime: blk.start, endTime: blk.end, running: true, tasks: [{ taskId: blk.taskId, text: blk.task, running: false }], allTicked: false } : null,
  };
  const payload = {
    poolAvailable: !o.unreadable,
    context: { activity: o.activity || 'working', duty: { onDuty: o.onDuty !== false } },
    work: { atDesk: true, deskKnown: true },
    primary: o.primary || null,
    secondary: o.secondary || [],
    dropped: [],
    utterances: o.utterances || [],
    approvals: o.unreadable ? { known: false } : { known: true, needsApproval: (o.approvals || []).length, needsReview: 0, where: 'Actions, in NEURO on the desktop' },
    situation: o.unreadable ? null : { sections: { commitments: o.commitments || [] } },
    home: o.unreadable ? null : (o.home || { needsYou: [], exceptions: [] }),
    personalDates: o.personalDates || null,
  };
  const facts = {
    calendar: o.unreadable ? null : (o.calendar || []),
    calendarKnown: !o.unreadable,
    approvals: o.unreadable ? null : (o.approvals || []).map((a) => ({ actionId: a.id, type: 'chase_agenda', status: 'prepared', expiresAt: a.expiresAt, mailbox: 'work', title: a.title })),
    taskDomains: new Map(blk ? [[blk.taskId, { domain: 'work', basis: 'set' }]] : []),
    workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: iso(8, 0), todayEnd: iso(18, 0), nextStart: iso(8, 0, 16) },
    gaps: o.unreadable ? [{ input: 'task-blocks', why: 'unreadable' }, { input: 'calendar', why: 'unreadable' }, { input: 'approvals', why: 'unreadable' }] : [],
  };
  const candidates = NC.compose(payload, live, facts, { now });
  const decision = POL.decide(candidates, { surface: o.surface, now });
  return { candidates, decision };
}

const BLOCK = { id: 130, start: '14:00', end: '15:30', taskId: 600, task: 'Customer Care training plan and refreshers' };
const DUE_TODAY = [commit(283, 'Nick Ward to send breakdown of Parsons contacts', '2026-10-15'), commit(375, 'West Hants Tennis Club: resolve the outstanding ticket tomorrow (8 October 2026). Must do tomorrow.', '2026-10-15')];
const CATCH_UP_CARD = card('meeting', 'critical', 'Nick Catch Up', { recordId: 'att_catchup', reason: 'Starting soon', meta: { start: wall(14, 30), minutesAway: 8, withOthers: true } });
const JOIN = { say: 'Join / prep now', intent: { kind: 'navigate', tab: 'prep', recordId: 'att_catchup' } };

const SCENARIOS = [
  {
    id: '1', name: 'Active work block, non-urgent approval',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', block: BLOCK, commitments: DUE_TODAY,
      approvals: [{ id: 'pa_1', expiresAt: iso(9, 0, 20), title: 'chase agenda: Quarterly review' }] }),
    expect: { rule: 'S5 protected block', lead: 'block:130', protected: 'block:130', recommended: 'I’m on it' },
  },
  {
    id: '2a', name: 'Active block, approval whose effective deadline is today (after the block)',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', block: BLOCK, commitments: DUE_TODAY,
      approvals: [{ id: 'pa_2', expiresAt: iso(6, 0, 16), title: 'chase agenda: The London Office Regroup' }] }),
    expect: { rule: 'S5 protected block', lead: 'block:130', protected: 'block:130', judgementEffective: iso(18, 0) },
  },
  {
    id: '2b', name: 'Active block, approval whose effective deadline falls inside the block',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', block: BLOCK,
      approvals: [{ id: 'pa_3', expiresAt: iso(15, 0), title: 'chase agenda: Ops sync' }] }),
    expect: { rule: 'S4 deadline inside the block', lead: 'approval:pa_3', protected: 'block:130' },
  },
  {
    id: '3', name: 'Meeting with others in under ten minutes, during an active block',
    build: () => build({ now: at(14, 22), surface: 'work-desktop', block: BLOCK, primary: CATCH_UP_CARD, utterances: [JOIN],
      calendar: [meetingEvent(14, 30, 15, 0, 'Nick Catch Up')] }),
    expect: { rule: 'S3a imminent meeting transition', lead: 'meeting:14:30:Nick Catch Up', protected: 'block:130', recommended: 'Join / prep now' },
  },
  {
    id: '4', name: 'Out-of-hours home evening',
    build: () => build({ now: at(20, 30), surface: 'home-pi', activity: 'off', onDuty: false,
      primary: { kind: 'context', id: 'context-ritual', title: 'EOD outstanding', reason: 'The end-of-day wrap hasn’t been done yet.' },
      commitments: DUE_TODAY, approvals: [{ id: 'pa_4', expiresAt: iso(9, 0, 20), title: 'chase agenda: Quarterly review' }],
      home: { needsYou: [{ kind: 'obligation', id: 'home:bins', title: 'Put the bins out', why: 'collection is tomorrow morning' }], exceptions: [] },
      personalDates: { active: [{ id: 'pd:isaac', kind: 'birthday', date: '2026-10-16', person: 'Isaac', state: 'action-may-be-needed', line: 'Isaac’s birthday tomorrow — card not done' }] } }),
    expect: { rule: 'S7 top item', lead: 'home:home:bins', protected: null, excludedWork: true },
  },
  {
    id: '5a', name: 'Family item needing action, during work',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', block: BLOCK,
      personalDates: { active: [{ id: 'pd:anniv', kind: 'anniversary', date: '2026-10-15', person: 'Helen', state: 'action-may-be-needed', line: 'Wedding anniversary today — nothing booked' }] } }),
    expect: { rule: 'S5 protected block', lead: 'block:130', protected: 'block:130', heldIncludes: 'pd:anniv' },
  },
  {
    id: '5b', name: 'Home hazard (genuine risk), during work',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', block: BLOCK,
      home: { needsYou: [{ kind: 'hazard', id: 'hazard:Kitchen leak', title: 'Kitchen leak: water detected', why: 'a household hazard sensor is reporting' }], exceptions: [] } }),
    expect: { rule: 'S2 critical risk', lead: 'home:hazard:Kitchen leak', protected: 'block:130' },
  },
  {
    id: '6a', name: 'Unreadable or missing data — work desktop',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', unreadable: true }),
    expect: { rule: 'S1 blind', lead: null, protected: null },
  },
  {
    id: '6b', name: 'Unreadable or missing data — home Pi',
    build: () => build({ now: at(20, 30), surface: 'home-pi', unreadable: true }),
    expect: { rule: 'S1 blind', lead: null, protected: null },
  },
  {
    id: '7', name: 'Phone interruption with constrained actions (scenario 3 on the phone)',
    build: () => build({ now: at(14, 22), surface: 'phone', block: BLOCK, primary: CATCH_UP_CARD, secondary: [card('nudge', 'medium', 'Log your water')],
      utterances: [JOIN, { say: 'Not now', intent: { kind: 'act', action: 'defer', recordId: 'att_catchup' } }, { say: 'Seen it', intent: { kind: 'act', action: 'acknowledge', recordId: 'att_catchup' } }],
      calendar: [meetingEvent(14, 30, 15, 0, 'Nick Catch Up')] }),
    expect: { rule: 'S3a imminent meeting transition', lead: 'meeting:14:30:Nick Catch Up', protected: 'block:130', recommended: 'Join / prep now', maxActions: 2 },
  },
  {
    id: '8', name: 'Unclassified type rated critical, during an active block',
    build: () => build({ now: at(14, 20), surface: 'work-desktop', block: BLOCK,
      secondary: [card('payroll_cutoff', 'critical', 'Payroll cut-off for overtime claims', { reason: 'closes at 15:00' })] }),
    expect: { rule: 'S2u unclassified potential risk', lead: 'item:r-payroll_cutoff', protected: 'block:130', reviewType: 'payroll_cutoff' },
  },
];

/** A row of the decision table: what went in, what came out, and why. */
function row(s) {
  const { candidates, decision: d } = s.build();
  const kinds = {};
  for (const c of candidates.candidates) { const k = `${c.kind}/${c.sphere.value}`; kinds[k] = (kinds[k] || 0) + 1; }
  const held = Array.isArray(d.held) ? d.held.map((h) => `${h.title} (${h.why})`) : [`${d.held.count} (count only)`];
  const applied = d.trace.find((t) => t.applies);
  return {
    id: s.id, name: s.name, surface: d.surface.id, scope: d.scope.id,
    candidates: Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(', ') || 'none',
    excluded: Object.entries(d.scope.excluded).map(([k, n]) => `${k}×${n}`).join(', ') || 'none',
    lead: d.lead.title ? `${d.lead.title}` : '—',
    why: d.lead.why,
    rule: d.lead.rule,
    protected: d.protected ? `${d.protected.what} (until ${d.protected.until})` : '—',
    held: held.length ? held.join('; ') : '—',
    judgement: d.judgement.map((j) => `${j.what} — by ${j.effectiveDeadline ? new Date(j.effectiveDeadline).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?'} (${j.effectiveBasis})`).join('; ') || '—',
    recommended: d.recommended ? (d.recommended.handOff ? `hand-off: ${d.recommended.say} (${d.recommended.handOff})` : d.recommended.say) : '—',
    alternatives: d.alternatives.map((a) => a.say).join(', ') || '—',
    trace: d.trace.map((t) => (t.applies ? `**${t.rule}**` : t.rule.split(' ')[0])).join(' → '),
    traceWhy: applied ? applied.why : '',
    review: d.review.unclassified.map((u) => `${u.type}×${u.count}`).join(', ') || '—',
    decision: d,
  };
}

module.exports = { SCENARIOS, row, build, at, iso };
