'use strict';

/**
 * "Done" must close the work, or say plainly that it did not.
 *
 * ── The bug these pin ───────────────────────────────────────────────────────
 * Pressing Done on the Now page resolved the attention record and nothing else,
 * and the card was back within the second. Measured on the live Pi, 7 Sep 2026 —
 * four records for ONE task:
 *
 *   att_mtrbuits_4 | active   | first seen 14:19:44.464
 *   att_mtrbu72g_3 | resolved | 14:19:44.399   <- Done pressed here
 *   att_mtr888dd_2 | resolved | 12:38
 *   att_mtm89c7a_3 | resolved | 4 Sep
 *
 * Two causes, both pinned below. The task — "Stand up a temporary single view of
 * aged/blocked/cross-team tickets" — is a Microsoft To Do item with NO row in
 * `tasks`, and `completionTargetFor` could only look a completion up by TEXT
 * against that table. So it found nothing, closed nothing, the task stayed
 * overdue, and `decision-engine` correctly emitted the card again on the next
 * poll — where a terminal record never re-matches, so a brand-new one opened.
 *
 * The card then said "Done — card cleared", which was false in the one direction
 * that costs something: it read as a finished job over work still open on
 * somebody's board.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attcomp-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const lifecycle = require('./attention-lifecycle');
const taskStore = require('./task-store');
const { ownerOf } = require('./decision-engine');

test.before(async () => { await db.init(); });

let seq = 0;
function card(title, meta = {}) {
  seq += 1;
  return {
    kind: 'item',
    id: `todo-overdue-top-${seq}`,
    type: 'todo',
    title,
    urgency: 'medium',
    tier: 2,
    source: 'vault',
    meta: { dueDate: '2026-09-04', overdueCount: 8, ...meta },
  };
}

function seed(c) {
  const [rec] = lifecycle.reconcile([c], { now: new Date() });
  return rec;
}

// ── Who owns a task ──────────────────────────────────────────────────────────

test('a NEURO row is owned by NEURO, and by its id rather than its wording', () => {
  assert.deepEqual(ownerOf({ task_id: 42, text: 'Write it up' }), { kind: 'neuro', taskId: 42 });
});

test('a Microsoft mirror is owned by Microsoft, carrying the id Graph knows it by', () => {
  const owner = ownerOf({ ms_id: 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy', msSource: 'MS ToDo', source: 'MS ToDo' });
  assert.equal(owner.kind, 'microsoft');
  assert.equal(owner.msId, 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy');
  assert.equal(owner.msSource, 'MS ToDo');
});

test('a NEURO row that is ALSO linked to Microsoft is owned by NEURO', () => {
  // task-dedupe links a pair NEURO-leading, and task-store's own completion
  // pushes to Graph. Routing a linked row down the Microsoft path would close it
  // twice and log the win twice.
  const owner = ownerOf({ task_id: 7, ms_id: 'abc', text: 'Succession plan' });
  assert.equal(owner.kind, 'neuro');
});

test('⚠ a plain vault checkbox records its KIND and never a line number', () => {
  // An offset captured when the card was generated can name a different line by
  // the time Nick presses the button — the mirror is rewritten wholesale every
  // sync — and a completion written to the wrong line is not undone by the next
  // one. The position is deliberately not carried.
  const owner = ownerOf({ text: 'Something in a daily note', source: 'Daily 2026-09-01', filePath: '/v/Daily/x.md', lineNumber: 12 });
  assert.equal(owner.kind, 'file');
  assert.equal(owner.lineNumber, undefined);
  assert.equal(owner.filePath, undefined);
});

// ── What Done will close ─────────────────────────────────────────────────────

test('a Microsoft-owned card resolves to a Microsoft completion, never a text lookup', () => {
  const target = lifecycle.completionTargetFor(card('Stand up a temporary single view of aged/blocked/cross-team tickets', {
    owner: { kind: 'microsoft', msId: 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy', msSource: 'MS ToDo' },
  }));
  assert.equal(target.kind, 'ms');
  assert.equal(target.msId, 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy');
});

test('a NEURO-owned card resolves by id, so a reword cannot lose it', () => {
  const target = lifecycle.completionTargetFor(card('Anything at all', { owner: { kind: 'neuro', taskId: 99 } }));
  assert.equal(target.kind, 'task');
  assert.equal(target.by, 'id');
  assert.equal(target.taskId, 99);
});

test('a card with NO owner still falls back to the text lookup that shipped', () => {
  // Cards predating this change carry no owner, and a record already open in the
  // database is one of them. Refusing them outright would break completion for
  // every card on screen at deploy time.
  const target = lifecycle.completionTargetFor(card('An older card'));
  assert.equal(target.kind, 'task');
  assert.equal(target.by, 'text');
});

test('a meeting still has nothing to close', () => {
  assert.equal(lifecycle.completionTargetFor({ type: 'meeting', title: '1-2-1 with Hope' }), null);
});

// ── Acting ───────────────────────────────────────────────────────────────────

test('completing a NEURO-owned card closes that exact row, by id', () => {
  const { id: taskId } = taskStore.createTask({ text: 'File the risk assessment', source: 'test' });
  const rec = seed(card('File the risk assessment', { owner: { kind: 'neuro', taskId } }));

  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.taskCompleted, true);
  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.equal(result.pendingMicrosoft, null);
});

test('⚠ a Microsoft-owned card hands the push BACK rather than claiming a completion', () => {
  // `act` is synchronous — the lane's defer path calls it and it pins without a
  // database — while completing a Planner card is a Graph round trip. So the
  // record resolves (Nick's decision, which does not depend on Microsoft
  // answering) and the work is handed to the caller. Nothing here may report a
  // completion it has not made.
  const rec = seed(card('Stand up a temporary single view of aged/blocked/cross-team tickets', {
    owner: { kind: 'microsoft', msId: 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy', msSource: 'MS ToDo' },
  }));

  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.ok, true);
  assert.equal(result.taskCompleted, false, 'must not claim a completion it did not make');
  assert.equal(result.pendingMicrosoft.msId, 'BsfHOFyEGEC1KvEnPZzbtZcAIJCy');
  assert.equal(result.pendingMicrosoft.msSource, 'MS ToDo');
  assert.equal(db.getAttentionRecord(rec.id).state, 'resolved');
});

test('a vault checkbox says WHY the tick stopped here, rather than reading as nothing to do', () => {
  const rec = seed(card('Tidy the desk', { owner: { kind: 'file', source: 'Daily 2026-09-01' } }));
  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.taskCompleted, false);
  assert.match(result.taskWhy, /checkbox in the vault/);
  // And it must not silently claim there was nothing there.
  assert.notEqual(result.taskWhy, 'nothing to complete');
});

// ── Done on an escalation (11 Sep 2026) ─────────────────────────────────────

test('⚠ Done on an escalation takes THAT ticket off the list, counts once, and leaves the rest', () => {
  // Nick pressed Done on NT-30940 and the card came straight back: it is built
  // from Jira's "no reply, not seen" list, and resolving the record changed
  // neither. Nothing is written to Jira — the ticket stays open there.
  const jira = require('./jira');
  db.setState('escalation_seen', JSON.stringify({
    'NT-30940': { seen: false, hasComment: false, summary: 'Re: Formal Complaint', created: '2026-09-10T17:58:42+01:00' },
    'NT-11111': { seen: false, hasComment: false, summary: 'Another one', created: '2026-09-09T09:00:00+01:00' },
  }));
  const escCard = () => ({
    kind: 'item', id: 'escalations-unseen', type: 'escalation',
    title: 'NT-30940 — Re: Formal Complaint', urgency: 'critical', tier: 1, source: 'jira',
    meta: { ticket_key: 'NT-30940', escalations: [{ key: 'NT-30940' }] },
  });
  const handledCount = () => db.getActivityForDate(require('./time-fit').dateStr(new Date()))
    .filter((r) => r.event_type === 'escalation_handled').length;

  const rec = seed(escCard());
  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.ok, true);
  assert.equal(result.handled, true);
  assert.equal(result.taskCompleted, false, 'no task was closed, and it must not say one was');
  assert.match(result.taskWhy, /NT-30940.*still open in Jira/);

  const unseen = jira.getUnseenEscalations().map((e) => e.key);
  assert.ok(!unseen.includes('NT-30940'), 'the card would be regenerated');
  assert.ok(unseen.includes('NT-11111'), '⚠ a card naming one ticket must not clear another');
  assert.equal(handledCount(), 1, 'one win for the ticket');

  // Pressed again on a fresh record (a stale screen): still handled, no second win.
  const again = lifecycle.act(seed(escCard()).id, 'complete');
  assert.equal(again.handled, true);
  assert.equal(handledCount(), 1, '⚠ pressing Done twice must not count twice');
});

test('an escalation the sync no longer holds is said, not claimed as handled', () => {
  db.setState('escalation_seen', JSON.stringify({}));
  const rec = seed({
    kind: 'item', id: 'escalations-unseen', type: 'escalation', title: 'NT-99999 — gone', urgency: 'critical',
    meta: { ticket_key: 'NT-99999' },
  });
  const result = lifecycle.act(rec.id, 'complete');
  assert.equal(result.handled, false);
  assert.match(result.taskWhy, /no longer in the escalation sync/);
});

test('the owner survives the round trip through the record', () => {
  // The owner is stored in the record's meta and read back out of it at action
  // time. A card is generated at one poll and acted on minutes later, so this is
  // the only path the completion actually takes — a target computed from a live
  // card object would pass while the real one failed.
  const rec = seed(card('Chase the invoice', {
    owner: { kind: 'microsoft', msId: 'zz-ms-id', msSource: 'MS Planner' },
  }));
  const stored = db.getAttentionRecord(rec.id);
  const target = lifecycle.completionTargetFor({
    type: stored.type,
    title: stored.title,
    meta: JSON.parse(stored.meta || '{}'),
  });
  assert.equal(target.kind, 'ms');
  assert.equal(target.msId, 'zz-ms-id');
});
