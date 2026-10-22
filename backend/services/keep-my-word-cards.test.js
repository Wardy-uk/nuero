'use strict';

// The four Holding the week cards (keep-my-word-cards-v1), PURE.
//   every card in every state has ONE primary that opens something (never blank)
//   "Not measured yet" names the missing evidence and the promises it affects
//   Monday: a verified send opens the receipt and report — never a send control
//   Next: "Start this block" only when a session is genuinely possible
//   the server and the shared UI agree on which target kinds mutate

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cards = require('./keep-my-word-cards');

const NOW = Date.parse('2026-10-22T09:00:00Z'); // Thu 10:00 London
const entry = (over = {}) => ({ key: 'p1', text: 'Send Chris the rota', taskIds: [101], outcome: 'pending', due: { date: '2026-10-23' }, evidence: [], ...over });
const score = (over = {}) => ({ week: { label: 'This week' }, ratio: null, proofSource: { status: 'not-connected', linkedActions: 0 }, entries: [entry()], counts: { undated: 2 }, gaps: [], mondayReport: { state: 'due', dueLabel: 'Monday 12:00' }, ...over });
const work = (over = {}) => [{ title: 'Call metrics in Nova', moveKey: 'm1', path: 'Projects/Working/Call metrics.md', block: { date: '2026-10-22', start: '10:05', end: '10:35' }, task: { id: 350, text: 'Call metrics in Nova' }, ...over }];

const STATES = {
  calm: { score: score({ ratio: { kept: 3, of: 3 }, proofSource: { status: 'connected' }, entries: [entry({ outcome: 'kept-on-time' })], mondayReport: { state: 'sent-verified-on-time', evidence: [{ kind: 'verified-send', provenBy: '2026-10-20T11:00:00Z' }], report: { subject: 'Weekly risk', sentAt: '2026-10-20T11:00:00Z', recipients: ['Chris Middleton'] } } }) },
  held: { score: score({ entries: [entry({ outcome: 'unverified', rule: 'ticked' })] }), session: { taskId: 999, text: 'Something else', stale: false }, work: work() },
  prepared: { score: score(), work: work() },
  verified: { score: score({ ratio: { kept: 1, of: 1 }, proofSource: { status: 'connected' } }), receipt: { calendar: { date: '2026-10-23', start: '10:30', end: '11:00' }, notePath: 'Projects/Working/x.md' } },
  'no-data': { score: null },
};

for (const [name, input] of Object.entries(STATES)) {
  test(`${name}: every card has a primary that opens something, a secondary at most, and a detail`, () => {
    const c = cards.cardsFrom({ ...input, now: NOW });
    assert.equal(c.contract, cards.CONTRACT);
    for (const id of ['kept', 'monday', 'next', 'judgement']) {
      const card = c[id];
      assert.ok(card.primary && card.primary.label && card.primary.open && card.primary.open.kind, `${name}/${id}: a primary`);
      assert.ok(card.detail && card.detail.title, `${name}/${id}: a detail to open`);
      if (card.secondary) assert.ok(card.secondary.open, `${name}/${id}: a secondary opens something`);
    }
  });
}

test('not measured: names the missing evidence and lists the affected promises', () => {
  const k = cards.cardsFrom({ score: score(), now: NOW }).kept;
  assert.equal(k.state, 'not-measured');
  assert.match(k.detail.missing[0], /No promise delivery has been prepared yet/);
  assert.deepEqual(k.detail.affected, ['p1']);
  assert.match(k.detail.notCounted.say[0], /Two promises have no date/);
  const off = cards.cardsFrom({ score: score({ proofSource: { status: 'not-connected', linkedActions: 2 } }), now: NOW }).kept;
  assert.match(off.detail.missing[0], /“Send approved emails” is off/);
});

test('Monday: sent and read back opens the receipt and report — no send label anywhere', () => {
  const m = cards.cardsFrom({ ...STATES.calm, now: NOW }).monday;
  assert.equal(m.primary.open.kind, 'detail');
  assert.ok(m.detail.receipt && m.detail.report);
  assert.doesNotMatch(`${m.primary.label} ${m.secondary.label}`, /send/i);
  const due = cards.cardsFrom({ score: score(), now: NOW }).monday;
  assert.deepEqual(due.primary.open, { kind: 'view', view: 'weekly-risk' }, 'still due: the governed preparation path');
});

test('Next: Start only within 10 minutes of the block, with a task, and no live session', () => {
  const start = cards.cardsFrom({ score: score(), work: work(), now: NOW }).next;
  assert.equal(start.primary.open.kind, 'session-start');
  assert.equal(start.primary.open.taskId, 350);
  assert.equal(start.detail.block.when.includes('10:05'), true);
  const early = cards.cardsFrom({ score: score(), work: work({ block: { date: '2026-10-22', start: '15:00', end: '15:30' } }), now: NOW }).next;
  assert.equal(early.primary.open.kind, 'detail');
  assert.match(early.detail.session.why, /available at 15:00/);
  const busy = cards.cardsFrom({ ...STATES.held, now: NOW }).next;
  assert.equal(busy.primary.open.kind, 'detail');
  assert.match(busy.detail.session.why, /is running/);
  const noTask = cards.cardsFrom({ score: score(), work: work({ task: null }), now: NOW }).next;
  assert.match(noTask.detail.session.why, /no task linked/);
});

test('Judgement: one item per ticked-without-proof promise, reviewed one at a time', () => {
  const j = cards.cardsFrom({ ...STATES.held, now: NOW }).judgement;
  assert.equal(j.state, 'waiting');
  assert.equal(j.detail.count, 1);
  assert.match(j.primary.label, /Review it/);
  assert.equal(cards.cardsFrom({ score: score(), now: NOW }).judgement.state, 'none');
});

test('a sensitive promise carries no title and no evidence', () => {
  const k = cards.cardsFrom({ score: score({ entries: [entry({ sensitive: true, evidence: [{ kind: 'x', say: 'Naomi said' }] })] }), now: NOW }).kept;
  assert.equal(k.detail.promises[0].title, null);
  assert.deepEqual(k.detail.promises[0].evidence, []);
});

test('the shared UI and the server agree on which target kinds mutate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'shared-ui', 'presentation', 'KeepMyWord.jsx'), 'utf8');
  const m = src.match(/export const MUTATING_KINDS = \[([^\]]*)\]/);
  assert.ok(m, 'positive control: MUTATING_KINDS is declared in the shared UI');
  const client = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  assert.deepEqual(client, [...cards.MUTATING].sort());
  assert.equal(cards.isMutating({ kind: 'session-start' }), true);
  assert.equal(cards.isMutating({ kind: 'detail' }), false);
});
