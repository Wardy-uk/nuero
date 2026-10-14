'use strict';

// attention-decision-v1 — one primary for every SAiM surface (14 Oct 2026).
// The fixture is the live 17:00 read that put the control and Alt at odds:
// block 115 running, the EOD ritual card, and a drafted agenda request waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const AD = require('./attention-decision');

const at = (h, m) => new Date(2026, 9, 14, h, m).getTime();
const ev = (sh, sm, eh, em, subject, attendeesOther, now) => ({
  start: `2026-10-14T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00.0000000`,
  end: `2026-10-14T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00.0000000`,
  subject, attendeesOther, allDay: false, running: at(sh, sm) <= now && now < at(eh, em),
});
const commit = (id, description, date) => ({ id: `commitment:task:${id}`, direction: 'i-owe', state: 'open', description, taskId: `task:neuro:${id}`, due: { date, kind: 'set' } });
const NT = 'NT-24162: Survey West Hants Responses not showing on CSV and Being recorded';

function live17({ now = at(17, 0), approvalExpires = '2026-10-15T05:00:00.000Z', withBlock = true, rows = undefined, agendaExtra = [] } = {}) {
  const blockRow = { blockId: 115, dateKey: '2026-10-14', startTime: '16:00', endTime: '17:30', status: 'scheduled', passed: false, tasks: [{ taskId: 345, text: NT }] };
  const laterRow = { blockId: 118, dateKey: '2026-10-14', startTime: '17:30', endTime: '17:45', status: 'scheduled', passed: false, tasks: [{ taskId: 400, text: 'File the expenses' }] };
  const payload = {
    poolAvailable: true,
    context: { activity: 'ritual' },
    work: { atDesk: false, deskKnown: true },
    primary: { kind: 'context', id: 'context-ritual', title: 'EOD outstanding', reason: 'The end-of-day wrap hasn’t been done yet.' },
    secondary: [{ kind: 'item', type: 'todo', title: 'Customer Care training plan and refreshers', urgency: 'normal' }],
    dropped: [],
    utterances: [{ say: 'Show me everything', intent: { kind: 'reveal' } }],
    approvals: { known: true, needsApproval: 1, needsReview: 0, say: '1 drafted email waits for your approval (a agenda request) — Actions, in NEURO on the desktop.', where: 'Actions, in NEURO on the desktop', soonestExpiresAt: approvalExpires },
    agenda: { known: true, scope: 'today', events: [
      ...(withBlock ? [ev(16, 0, 17, 30, `Task block: ${NT}`, false, now)] : []),
      ev(17, 30, 17, 45, 'Task block: File the expenses', false, now),
      ...agendaExtra,
    ] },
    situation: { sections: { commitments: [
      commit(283, 'Nick Ward to send breakdown of Parsons contacts', '2026-10-14'),
      commit(345, NT, '2026-10-14'),
      commit(375, 'West Hants Tennis Club: resolve the outstanding ticket tomorrow (8 October 2026). Must do tomorrow.', '2026-10-14'),
    ] } },
  };
  const live = {
    rows: rows !== undefined ? rows : (withBlock ? [blockRow, laterRow] : [laterRow]),
    block: withBlock ? { blockId: 115, startTime: '16:00', endTime: '17:30', running: true, tasks: [{ taskId: 345, text: NT, running: false }], allTicked: false } : null,
    session: null,
  };
  return { payload, live, now };
}

const decide = ({ payload, live, now }) => AD.decide(payload, live, { now });

test('the 17:00 case: the agenda request does NOT interrupt the running block — it stays visible as judgement', () => {
  const d = decide(live17());
  assert.equal(d.contract, 'attention-decision-v1');
  assert.equal(d.primary.kind, 'block');
  assert.equal(d.primary.rule, 'P5 block');
  assert.equal(d.primary.title, NT);
  assert.equal(d.secondary.judgement.count, 1);
  assert.equal(d.secondary.judgement.primary, false);
  const p4 = d.trace.find((t) => t.rule === 'P4 deadline');
  assert.equal(p4.applies, false);
  assert.match(p4.why, /closes in 7\d\d min/);
});

test('the same approval interrupts the block when its window closes within the hour', () => {
  const d = decide(live17({ approvalExpires: new Date(at(17, 40)).toISOString() }));
  assert.equal(d.primary.kind, 'needs-you');
  assert.equal(d.primary.rule, 'P4 deadline');
  assert.equal(d.context.block.blockId, 115, 'the block is still context');
});

test('with no block running, a waiting approval leads (P6), and the ritual is held', () => {
  const d = decide(live17({ withBlock: false }));
  assert.equal(d.primary.kind, 'needs-you');
  assert.equal(d.primary.rule, 'P6 approvals');
  assert.ok(d.secondary.held.some((h) => h.kind === 'ritual'));
});

test('a running block outranks the ritual; the ritual and due-today work are held, the block’s own task is not', () => {
  const d = decide(live17());
  assert.equal(d.context.doing, 'in a task block');
  assert.equal(d.context.ritual.phrase, 'the end-of-day wrap');
  const kinds = d.secondary.held.map((h) => h.kind);
  assert.equal(kinds[0], 'ritual');
  assert.ok(d.secondary.held.some((h) => /Parsons/.test(h.title)));
  assert.ok(!d.secondary.held.some((h) => /NT-24162/.test(h.title)));
  assert.equal(d.primary.actions[0].intent.kind, 'start-block');
});

test('a running meeting outranks a block, and a critical item outranks both', () => {
  const now = at(17, 0);
  const s = live17({ agendaExtra: [ev(16, 45, 17, 15, 'Weekly support leads', true, now)] });
  assert.equal(decide(s).primary.kind, 'meeting');
  s.payload.secondary.push({ kind: 'item', type: 'escalation', title: 'NT-1 breaching', urgency: 'critical', recordId: 9 });
  assert.equal(decide(s).primary.rule, 'P2 critical');
});

test('a solo task block is the next transition — from the block list, or from the diary when the list was not read', () => {
  const d = decide(live17());
  assert.equal(d.secondary.next.title, 'File the expenses');
  assert.equal(d.secondary.next.kind, 'block');
  const unread = decide(live17({ rows: null }));
  assert.equal(unread.secondary.next.title, 'File the expenses');
  assert.equal(unread.known.blocks, false);
});

test('stale wording is a correction, never repeated in a title', () => {
  const d = decide(live17());
  const wh = d.secondary.held.find((h) => /West Hants Tennis/.test(h.title));
  assert.equal(wh.title, 'West Hants Tennis Club: resolve the outstanding ticket');
  assert.equal(wh.fullTitle, null);
  assert.deepEqual(d.secondary.corrections.map((c) => c.taskId), [375]);
});

test('an unread pool is the only thing that outranks everything', () => {
  const s = live17();
  s.payload.poolAvailable = false;
  assert.equal(decide(s).primary.kind, 'blind');
});

test('every rule considered is in the trace, in order, up to the one that chose', () => {
  const d = decide(live17());
  assert.deepEqual(d.trace.map((t) => t.rule), ['P1 blind', 'P2 critical', 'P3 meeting', 'P4 deadline', 'P5 block']);
  assert.equal(d.trace.filter((t) => t.applies).length, 1);
});
