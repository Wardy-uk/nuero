'use strict';

/**
 * "Done" on a Now card that looks like a meeting (14 Sep 2026).
 *
 * `completionTargetFor` is right that a MEETING has nothing to close — but
 * NEURO books its OWN task blocks into the same calendar, so they arrive as
 * meeting cards too, and the one kind of "meeting" with real work behind it was
 * the one where Done could do nothing at all. It answered "Nothing was closed —
 * nothing to complete", which reads as a dead button rather than as an answer.
 *
 * Real DB throughout: the pure half cannot see the link, because the whole
 * point is that the link is in the database — `task_blocks.event_id` is the
 * Graph event id a meeting record already carries in its dedupe key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mtg-'));
process.env.NEURO_DB_PATH = path.join(root, 'mtg.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const taskStore = require('./task-store');
const lifecycle = require('./attention-lifecycle');

test.before(async () => { await db.init(); });

let seq = 0;

/** A block in the calendar, its tasks, and the meeting record that reminds him. */
function blockCard(texts, { eventId = null } = {}) {
  const n = seq++;
  const event = eventId || `AAMkEVENT${n}`;
  const p = v => String(v).padStart(2, '0');
  // A window still ahead: the reminder fires before the block starts, which is
  // exactly when Nick pressed Done.
  const at = new Date(Date.now() + (21 + n) * 60000);
  const dateKey = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  // ⚠ The window must genuinely be AHEAD, not merely described as such: a
  // block already under way holds the tick for its write-up (14 Sep 2026), so a
  // fixture with a start in the past tests the hold and not this.
  const startTime = `${p(at.getHours())}:${p(at.getMinutes())}`;

  const tasks = texts.map(t => taskStore.createTask({ text: t, source: 'manual', skipExport: true }).id);
  const blockId = db.createTaskBlockRow({
    event_id: event,
    date_key: dateKey,
    start_time: startTime,
    end_time: '23:59',
    minutes: 60,
    minutes_assumed: 1,
    note_path: `Tasks/Outcomes/block-${n}.md`,
    status: 'scheduled',
  });
  for (const id of tasks) db.addTaskBlockItem(blockId, id, null);

  const record = lifecycle.upsert({
    id: `cal-${event}`,
    type: 'meeting',
    title: `Task block: ${texts[0]}`,
    reason: 'In 21 minutes',
    urgency: 'high',
    meta: { start: `${dateKey}T${startTime}:00`, minutesAway: 21 },
  });
  return { blockId, tasks, recordId: record.id, event };
}

test('Done on a single-task block closes that task', () => {
  // The case from the screenshot: one task, and the button did nothing at all.
  const { tasks, recordId } = blockCard(['Transcribe leadership meeting and complete all actions from it']);
  const r = lifecycle.act(recordId, 'complete');
  assert.equal(r.ok, true);
  assert.equal(r.taskCompleted, true, 'the one task behind the block must close');
  assert.match(r.taskWhy, new RegExp(`#${tasks[0]}`), 'and it must say which');
  assert.equal(db.getTaskRow(tasks[0]).status, 'done');
});

test('Done on a MULTI-task block refuses, and names the count', () => {
  // ⚠ One press cannot mean "finish all three". A batch routinely finishes some
  // of what it held, and closing the rest because a reminder was dismissed puts
  // work in the wins ledger nobody did — the rule the write-up sweep follows.
  const { tasks, recordId } = blockCard(['First of three', 'Second of three', 'Third of three']);
  const r = lifecycle.act(recordId, 'complete');
  assert.equal(r.taskCompleted, false);
  assert.match(r.taskWhy, /3 tasks/, 'the count is the reason — a bare refusal teaches nothing');
  for (const id of tasks) assert.equal(db.getTaskRow(id).status, 'open', 'nothing may be closed');
});

test('Done on a REAL meeting says what it is, not that something failed', () => {
  const record = lifecycle.upsert({
    id: 'cal-AAMkREALMEETING',
    type: 'meeting',
    title: 'Weekly Meeting: Sprint Planning',
    reason: 'In 10 minutes',
    urgency: 'high',
    meta: { start: '2026-09-14T14:00:00', minutesAway: 10 },
  });
  const r = lifecycle.act(record.id, 'complete');
  assert.equal(r.taskCompleted, false);
  assert.match(r.taskWhy, /not a task/, 'the honest answer, not "nothing to complete"');
});

test('a block whose tasks are all ticked asks for its write-up', () => {
  const { tasks, blockId, recordId } = blockCard(['Already ticked']);
  db.setTaskBlockItemAwaiting(blockId, tasks[0], true);
  const r = lifecycle.act(recordId, 'complete');
  assert.equal(r.taskCompleted, false);
  assert.match(r.taskWhy, /write-up/);
});

test('a FINISHED block is not something a reminder can act on', () => {
  const { tasks, blockId, recordId } = blockCard(['In a dropped block']);
  db.updateTaskBlockRow(blockId, { status: 'dropped' });
  const r = lifecycle.act(recordId, 'complete');
  assert.equal(r.taskCompleted, false);
  assert.match(r.taskWhy, /not a task/, 'a closed block reads as an ordinary meeting');
  assert.equal(db.getTaskRow(tasks[0]).status, 'open');
});

// ── An opaque id is never a label ────────────────────────────────────────────

test('a meeting card shows the TIME, never the Graph event id', () => {
  // ⚠ `ref` is rendered on the card. This was `card.id` — "cal-" plus a
  // 150-character Graph id, printed as a wall of base64 under the word
  // CALENDAR. Same species as the email id that reached the review queue as a
  // label.
  const ev = lifecycle.evidenceFor({
    id: 'cal-AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWQyNmMzN2UyMTBmOQBGAAAAAAA7R6hC4',
    type: 'meeting',
    title: 'Task block: something',
    meta: { start: '2026-09-14T14:00:00', location: 'Teams' },
  });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].ref, '14:00');
  assert.ok(!/AAMk/.test(ev[0].ref), 'no Graph id may reach a rendered label');
  assert.equal(ev[0].sourceId, 'cal-AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWQyNmMzN2UyMTBmOQBGAAAAAAA7R6hC4',
    'the id still travels, for matching a card back to its source');
});

test('the meeting time is SLICED, never re-parsed', () => {
  // Graph was already asked for Europe/London wall-clock times; re-parsing
  // re-applies an offset and shows every BST event an hour out. That is the
  // calendar's own bug, one surface along.
  assert.equal(
    lifecycle.evidenceFor({ id: 'cal-x', type: 'meeting', meta: { start: '2026-06-15T09:30:00' } })[0].ref,
    '09:30',
  );
});

test('an email card shows the SENDER, never the message id', () => {
  const ev = lifecycle.evidenceFor({
    id: 'email-urgent',
    type: 'email',
    meta: { emailId: 'AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4', from: 'Paul Adams', subject: 'Risk register' },
  });
  assert.equal(ev[0].ref, 'Paul Adams');
  assert.equal(ev[0].detail, 'Risk register');
  assert.ok(!/AAMk/.test(ev[0].ref));
});

test('an unrecorded sender SAYS so rather than falling back to the blob', () => {
  const ev = lifecycle.evidenceFor({
    id: 'email-urgent',
    type: 'email',
    meta: { emailId: 'AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4' },
  });
  assert.match(ev[0].ref, /not recorded/);
  assert.ok(!/AAMk/.test(ev[0].ref));
});

test('a block ALREADY UNDER WAY holds the tick, and says so', () => {
  // Not a regression — the other half of the write-up rule. Done on a window he
  // is sitting in is a real statement, held at in-progress until the note lands,
  // and `taskHeld` is what lets the card say that rather than reporting a
  // failure.
  const n = seq++;
  const p = v => String(v).padStart(2, '0');
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const started = new Date(now.getTime() - 20 * 60000);

  const id = taskStore.createTask({ text: 'Mid-window work', source: 'manual', skipExport: true }).id;
  const event = `AAMkLIVE${n}`;
  const blockId = db.createTaskBlockRow({
    event_id: event,
    date_key: dateKey,
    start_time: `${p(started.getHours())}:${p(started.getMinutes())}`,
    end_time: '23:59',
    minutes: 60,
    minutes_assumed: 1,
    note_path: `Tasks/Outcomes/live-${n}.md`,
    status: 'scheduled',
  });
  db.addTaskBlockItem(blockId, id, null);
  const record = lifecycle.upsert({
    id: `cal-${event}`,
    type: 'meeting',
    title: 'Task block: Mid-window work',
    reason: 'Starting now',
    urgency: 'high',
    meta: { start: `${dateKey}T09:00:00`, minutesAway: 0 },
  });

  const r = lifecycle.act(record.id, 'complete');
  assert.equal(r.taskHeld, true, 'held is a third outcome, not a failure');
  assert.equal(r.taskCompleted, false);
  assert.equal(db.getTaskRow(id).status, 'in-progress', 'the tick is kept, not thrown away');
});
