'use strict';

/**
 * Blocks, ticks and outcome notes.
 *
 * ⚠ **THE HOLD IS GONE (15 Sep 2026, Nick's call: "being in a block should not
 * stop me independently ticking off a task").** From 18 Aug a `done` on a
 * blocked task was held at `in-progress` until an outcome note was written, on
 * the reasoning that a window in the diary is not evidence the work happened.
 * Measured over the whole life of that rule, the sweep logged `0 completed` on
 * every pass — not one block was ever closed by a write-up — so all it ever did
 * was delay each completion by ~24h until the ageing pass released the block,
 * while the task sat at `in-progress`, which the read path reports as plain
 * `open`. It presented as a checkbox that did nothing.
 *
 * Separate from task-blocks.test.js because these need a real DB and a real
 * vault on disk, where that file is pure. What is pinned here now:
 *
 *   - ticking a blocked task COMPLETES it, immediately, with no hold
 *   - the tick PROPAGATES: every open block holding it shows the box ticked
 *   - a block settles itself once its ticked work is done, so it stops asking
 *     for a write-up nobody owes
 *   - the note still EXISTS and still works — `isOutcomeWritten` still refuses
 *     an empty stub, `saveNote` still completes the block
 *   - release() needs a reason, and records it
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hold-'));
process.env.NEURO_DB_PATH = path.join(root, 'hold.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const taskStore = require('./task-store');
const taskBlocks = require('./task-blocks');

test.before(async () => { await db.init(); });

// Each fixture gets its own slot: the uniqueness guard is on (date, start_time)
// now, because a block holds many tasks and the thing to prevent is two events
// landing on top of each other.
let slotSeq = 0;
const pad = n => String(n).padStart(2, '0');

/**
 * A window that has already STARTED and is not yet a day old.
 *
 * ⚠ These used to be fixed dates in August, and the suite only passed because
 * nothing aged a block out: the hold applied to any open block at any distance.
 * Since 14 Sep 2026 it applies only inside that band, so a fixture dated weeks
 * ago is a block that has correctly expired — the test would have been asserting
 * the opposite of the rule. Deriving the window from the clock also takes the
 * date bomb out of the file: nothing here can start failing because a real date
 * rolled past a literal, which this repo has been bitten by twice.
 *
 * Each call steps a quarter-hour further back, so every fixture gets its own
 * (date_key, start_time) — crossing midnight is fine and still inside the day.
 */
/**
 * The slot construction, as a PURE function of the clock and the sequence.
 *
 * Split out so the uniqueness rule can be pinned across a whole day of possible
 * `now` values. The bug it replaces only fired when the band happened to
 * straddle midnight — green on the Pi at 15:00 and red on this laptop at 18:30 —
 * so a test that calls it at whatever time the suite happens to run proves
 * nothing about the case that actually breaks.
 *
 * Returns the sequence value the CALLER should hold next, because skipping
 * consumes one.
 */
function slotAt(nowMs, seq) {
  // Steps FORWARD from twenty hours ago, one WHOLE MINUTE per fixture, so a
  // fixture created later also sits later in the day: `listTaskBlockRows` orders
  // by (date, start) descending and the tests about "the most recent block" mean
  // the one worked most recently, not the one inserted last.
  //
  // ⚠⚠ ONE MINUTE PER FIXTURE, AND THE LAST FIVE MINUTES OF A DAY ARE SKIPPED,
  // so every fixture owns a distinct (date_key, start_time) BY CONSTRUCTION.
  // The previous version stepped 1.5 minutes and then CLAMPED anything past
  // 23:55 back to 23:55, which collapsed several fixtures onto one slot and
  // violated UNIQUE(date_key, start_time). The failure surfaced on whichever
  // test drew the duplicate rather than on the helper — the same shape as the
  // hand-sized step this replaced, wearing a clock instead of a calendar.
  //
  // Skipping ADVANCES the sequence, so a skipped minute is never revisited and
  // uniqueness survives the jump across midnight.
  //
  // The clamp existed to stop a four-minute window overflowing into "24:03",
  // which would parse as EARLIER than its start; reserving the last five minutes
  // of the day does that job without collapsing anything.
  const BASE_MIN = 20 * 60;
  const LAST_SAFE_MIN = 24 * 60 - 6; // 23:54 — leaves room for a 4-minute window
  let at;
  let startMin;
  do {
    // 600 minutes of band walks from 20h to 10h ago — comfortably in the past,
    // comfortably inside STALE_AFTER_MS, with room as tests are added. Nothing
    // here can reach the present.
    at = new Date(nowMs - (BASE_MIN - (seq++ % 600)) * 60000);
    startMin = at.getHours() * 60 + at.getMinutes();
  } while (startMin > LAST_SAFE_MIN);
  const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return {
    dateKey: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    startTime: hhmm(startMin),
    endTime: hhmm(startMin + 4),
    nextSeq: seq,
  };
}

function recentSlot() {
  const s = slotAt(Date.now(), slotSeq);
  slotSeq = s.nextSeq;
  return s;
}

/** Tasks with a block already scheduled, and its stub on disk. */
function blockedTasks(texts, { dateKey = null, startTime = null, endTime = null } = {}) {
  const slot = recentSlot();
  dateKey = dateKey || slot.dateKey;
  startTime = startTime || slot.startTime;
  endTime = endTime || (startTime === slot.startTime ? slot.endTime : '15:00');
  const list = Array.isArray(texts) ? texts : [texts];
  const tasks = list.map(text => {
    const { id } = taskStore.createTask({ text, source: 'manual', skipExport: true });
    const row = db.getTaskRow(id);
    // ⚠ `createTask` FOLDS on normalised text (dedupe_key is UNIQUE), so two
    // fixtures in this file sharing a wording are ONE task — and the second
    // test then silently inherits whatever the first did to it. That cost a
    // real half hour: 'Did this one' was already `done` from a fixture 400
    // lines up, so `updateTask` saw no transition, skipped the tick
    // propagation, and the failure surfaced as an unrelated reschedule
    // refusing. Caught here, at the collision, rather than wherever it lands.
    assert.equal(row.status, 'open',
      `fixture text "${text}" collided with an existing task (#${id}, ${row.status}) — give it its own wording`);
    return row;
  });
  const notePath = taskBlocks.outcomeNotePath(tasks, dateKey, startTime);
  const blockId = db.createTaskBlockRow({
    date_key: dateKey,
    start_time: startTime,
    end_time: endTime,
    minutes: 60,
    minutes_assumed: 1,
    note_path: notePath,
    status: 'scheduled',
  });
  for (const t of tasks) db.addTaskBlockItem(blockId, t.id, null);

  const full = path.join(process.env.OBSIDIAN_VAULT_PATH, notePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, taskBlocks.renderStub(tasks, db.getTaskBlockRow(blockId)), 'utf8');
  return { taskIds: tasks.map(t => t.id), taskId: tasks[0].id, blockId, notePath, full };
}

/** Back-compat shim so the single-task tests below read unchanged. */
function blockedTask(text, opts = {}) { return blockedTasks(text, opts); }

function writeUp(full) {
  fs.writeFileSync(
    full,
    fs.readFileSync(full, 'utf8').replace(
      '## What came of it\n',
      '## What came of it\nDrafted the cover matrix and sent it to Chris for review on Friday.\n'
    ),
    'utf8'
  );
}

test('ticking a blocked task completes it — a block never holds a tick', () => {
  const { taskId, blockId, notePath } = blockedTask('Build the succession cover matrix');

  const result = taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(result.status, 'done',
    'being in a block must not stop a task being ticked off (Nick, 15 Sep 2026)');
  assert.equal(result.held, undefined,
    '`held` is gone, not nulled: a key that can never be set is a payload field with no writer');

  // The tick still reaches the block — otherwise the block and the task list
  // disagree about work that has just been finished.
  const item = db.listTaskBlockItems(blockId).find(i => i.task_id === taskId);
  assert.equal(item.awaiting, 1);
  assert.ok(fs.readFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, notePath), 'utf8'));
});

test('a completed task IS logged as a completion, and stamped', () => {
  const { taskId } = blockedTask('Write the Tier 2 ageing note');
  taskStore.updateTask(taskId, { status: 'done' });
  // Under the hold this was null for ~24h, so a day's finished work was missing
  // from the wins ledger and from "what did I get done today".
  assert.ok(db.getTaskRow(taskId).completed_at, 'a finished task must carry its completion stamp');
});

test('a block stops asking for a write-up once its ticked work is done', () => {
  const { taskId, blockId } = blockedTask('Draft the headcount split for production ops');
  taskStore.updateTask(taskId, { status: 'done' });

  // `refreshBlockStatus`: a block owes a write-up only while it holds ticked
  // work that is NOT done. With the tick completing outright, nothing is owed.
  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
});

test('the note still works — writing one up completes the block', () => {
  const { taskId, blockId, full } = blockedTask('Draft the Tier 3 ageing summary');
  taskStore.updateTask(taskId, { status: 'done' });

  writeUp(full);
  const swept = taskBlocks.sweep();

  assert.equal(db.getTaskBlockRow(blockId).status, 'complete',
    'the write-up is optional now, but it must still close the block when it lands');
  assert.deepEqual(swept.gaps, []);
  assert.ok(swept.completed.some(c => c.blockId === blockId));
});

test('a task written up BEFORE the tick completes straight away', () => {
  const { taskId, full } = blockedTask('Review the escalation reason codes');
  writeUp(full);
  const result = taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(result.status, 'done');
  assert.equal(result.held, undefined);
});

test('the sweep leaves an un-written block alone and counts it', () => {
  const { blockId } = blockedTask('Chase the Sandford renewal');
  const swept = taskBlocks.sweep();
  assert.ok(swept.stillOpen >= 1);
  assert.ok(!swept.completed.some(c => c.blockId === blockId));
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
});

test('a note Nick renamed is still found, by the task id in its frontmatter', () => {
  const { taskId, blockId, full } = blockedTask('Book the Q4 planning session');
  taskStore.updateTask(taskId, { status: 'done' });   // ticked, so it is owed a note
  writeUp(full);
  fs.renameSync(full, path.join(path.dirname(full), 'Renamed by Nick.md'));

  taskBlocks.sweep();
  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.match(db.getTaskBlockRow(blockId).note_path, /Renamed by Nick\.md$/,
    'the record must follow the note, or it points at a file that no longer exists');
});

test('an unreadable vault does not hold the task', () => {
  // The one place this fails OPEN, deliberately. A Syncthing hiccup would
  // otherwise refuse every completion Nick made, in the single screen he uses to
  // find what he owes.
  const { taskId } = blockedTask('Write up the Tier 1 handover');
  const real = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'nowhere');
  try {
    assert.equal(taskStore.updateTask(taskId, { status: 'done' }).status, 'done');
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = real;
  }
});

test('dropping a task is never held — abandoning is not a claim needing proof', () => {
  const { taskId } = blockedTask('Something that turned out not to matter');
  assert.equal(taskStore.updateTask(taskId, { status: 'dropped' }).status, 'dropped');
});

test('release needs a reason, and stores it', () => {
  const { taskId, blockId } = blockedTask('Sit in on the SMT update');
  taskStore.updateTask(taskId, { status: 'done' });   // ticked, and done

  const before = db.getTaskBlockRow(blockId).status;
  const refused = taskBlocks.release(blockId, '   ');
  assert.equal(refused.ok, false, 'a reasonless release is a second, quieter way of saying done');
  assert.equal(db.getTaskBlockRow(blockId).status, before,
    'a refused release must leave the block exactly as it was');

  const done = taskBlocks.release(blockId, 'Meeting was cancelled, nothing to write up');
  assert.equal(done.ok, true);
  const block = db.getTaskBlockRow(blockId);
  assert.equal(block.status, 'released');
  assert.match(block.release_reason, /cancelled/);
  assert.equal(db.getTaskRow(taskId).status, 'done');
  assert.deepEqual(done.completedTaskIds, [taskId]);
});

test('a released block stays distinguishable from one that earned its note', () => {
  const { blockId: releasedId } = blockedTask('Released work');
  taskBlocks.release(releasedId, 'no outcome worth writing');

  const { taskId, blockId: completedId, full } = blockedTask('Completed work');
  taskStore.updateTask(taskId, { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  assert.equal(db.getTaskBlockRow(releasedId).status, 'released');
  assert.equal(db.getTaskBlockRow(completedId).status, 'complete');
  assert.equal(db.getTaskRow(taskId).status, 'done');
});

test('two blocks cannot occupy the same slot', () => {
  // The guard is on the SLOT now, not the task: a block holds many tasks, and
  // the failure to prevent is two events landing on top of each other.
  // A date of its own, so the auto-assigned fixture slots cannot collide here.
  blockedTask('Only once please', { dateKey: '2026-07-01', startTime: '11:00' });
  assert.throws(() => db.createTaskBlockRow({
    date_key: '2026-07-01', start_time: '11:00', end_time: '12:00',
    minutes: 60, minutes_assumed: 0, note_path: 'x.md', status: 'scheduled',
  }), /UNIQUE/);
});

test('a future block is listed, but flagged as not yet owing a write-up', () => {
  // This replaces an earlier rule that HID upcoming blocks ("a 2pm block is not
  // outstanding at 9am"). That was right about the words and wrong about the
  // screen: once tasks are grouped into a window, the grouping is the thing to
  // work through, and hiding it meant the batch vanished from the screen it was
  // made on. So it is listed, and `passed` carries the distinction instead.
  const { blockId } = blockedTask('Tomorrow work', { dateKey: '2099-01-05', startTime: '14:00' });

  const early = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 9, 0) });
  const earlyRow = early.rows.find(r => r.blockId === blockId);
  assert.ok(earlyRow, 'the block must be visible as a group before its slot');
  assert.equal(earlyRow.passed, false);

  const later = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 16, 0) });
  assert.equal(later.rows.find(r => r.blockId === blockId).passed, true,
    'once the slot is behind us it owes a write-up');

  // The old behaviour is still reachable for a caller that wants only what is
  // owed — the nudge path cares about that, not about the diary.
  const owedOnly = taskBlocks.listOutstanding({ now: new Date(2099, 0, 5, 9, 0), includeUpcoming: false });
  assert.ok(!owedOnly.rows.some(r => r.blockId === blockId));
});

// ── Batching: several tasks in one window ────────────────────────────────────

test('a batch ticks every task in it, on one note, and holds none', () => {
  const { taskIds, blockId, notePath } = blockedTasks([
    'Approve the Sandford refund',
    'Reply to Chris about headcount',
    'File the FOC report',
  ]);

  for (const id of taskIds) {
    assert.equal(taskStore.updateTask(id, { status: 'done' }).status, 'done',
      `task #${id} did not complete — a batch must not hold any of its tasks`);
  }
  // One note between them. Three notes for one sitting is friction that would
  // stop the write-up happening at all.
  assert.equal(db.getTaskBlockRow(blockId).note_path, notePath);
  for (const id of taskIds) {
    assert.equal(db.listTaskBlockItems(blockId).find(i => i.task_id === id).awaiting, 1,
      'every tick must reach the one shared note');
  }
});

test('writing up a batch completes ONLY the tasks that were ticked', () => {
  // The rule the whole batch design turns on. A window of four routinely
  // finishes three; completing the fourth because a note exists would put work
  // in the ledger that nobody did — the exact failure "a win is detected, not
  // declared" exists to stop.
  const { taskIds, blockId, full } = blockedTasks([
    'Cancel the duplicate licence',
    'Send the Tier 2 ageing figures',
    'Read the incident postmortem',
  ]);
  const [ticked1, ticked2, never] = taskIds;

  taskStore.updateTask(ticked1, { status: 'done' });
  taskStore.updateTask(ticked2, { status: 'done' });

  writeUp(full);
  const swept = taskBlocks.sweep();

  assert.equal(db.getTaskRow(ticked1).status, 'done');
  assert.equal(db.getTaskRow(ticked2).status, 'done');
  assert.equal(db.getTaskRow(never).status, 'open',
    'a task nobody ticked was marked done because someone wrote a note');

  const entry = swept.completed.find(c => c.blockId === blockId);
  assert.deepEqual(entry.taskIds, [ticked1, ticked2]);
  // Reported, not hidden: "you wrote it up and one is still open" is information.
  assert.deepEqual(entry.stillOpenTaskIds, [never]);
  assert.equal(db.getTaskBlockRow(blockId).status, 'complete');
});

test('a task left open by a batch can still be ticked afterwards', () => {
  // Once the block is complete it owes nothing, so the second tick must land
  // rather than hold against a block that is already written up.
  const { taskIds, full } = blockedTasks(['Do the first thing', 'Do the second thing']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const after = taskStore.updateTask(taskIds[1], { status: 'done' });
  assert.equal(after.status, 'done');
  assert.equal(after.held, undefined, 'a written-up block must not keep holding');
});

test('releasing a batch closes the block without completing untouched work', () => {
  const { taskIds, blockId } = blockedTasks(['Abandoned one', 'Abandoned two']);
  const result = taskBlocks.release(blockId, 'Day got eaten by an escalation');

  assert.equal(result.ok, true);
  assert.deepEqual(result.completedTaskIds, []);
  for (const id of taskIds) assert.equal(db.getTaskRow(id).status, 'open');
  assert.equal(db.getTaskBlockRow(blockId).status, 'released');
});

test('the outstanding list names every task in the block and which are ticked', () => {
  const { taskIds, blockId } = blockedTasks(['Ticked job', 'Untouched job']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const { rows } = taskBlocks.listOutstanding({ now: new Date() });
  const row = rows.find(r => r.blockId === blockId);
  assert.ok(row, 'a passed block owing a write-up must be listed');
  assert.equal(row.tasks.length, 2);
  assert.equal(row.tasks.find(t => t.taskId === taskIds[0]).awaiting, true);
  assert.equal(row.tasks.find(t => t.taskId === taskIds[1]).awaiting, false);
});

test('a second block does not land on the first — even before any calendar sync', () => {
  // calendar_cache only refreshes on a sync, so a block created a moment ago is
  // not in it; if Graph refused the event it never will be. Without counting
  // NEURO's own blocks the slot search hands out the same gap every time, which
  // is one-to-one-booking.planAll()'s lesson word for word.
  const { id } = taskStore.createTask({ text: 'First of two back to back', skipExport: true });
  const { id: id2 } = taskStore.createTask({ text: 'Second of two back to back', skipExport: true });

  const now = new Date(2026, 8, 2, 7, 0);          // Wed 2 Sep 2026, empty diary
  const first = taskBlocks.plan(id, { now, minutes: 30 });
  assert.equal(first.ok, true);

  db.createTaskBlockRow({
    date_key: first.slot.date, start_time: first.slot.startTime, end_time: first.slot.endTime,
    minutes: 30, minutes_assumed: 0, note_path: 'x.md', status: 'scheduled',
  });

  const second = taskBlocks.plan(id2, { now, minutes: 30 });
  assert.equal(second.ok, true);
  assert.notEqual(
    `${second.slot.date} ${second.slot.startTime}`,
    `${first.slot.date} ${first.slot.startTime}`,
    'the second block was offered the slot the first already holds'
  );
});

test('a dropped block frees its slot again', () => {
  const { id } = taskStore.createTask({ text: 'Slot freed by dropping', skipExport: true });
  const now = new Date(2026, 8, 3, 7, 0);          // Thu 3 Sep 2026

  const first = taskBlocks.plan(id, { now, minutes: 30 });
  const blockId = db.createTaskBlockRow({
    date_key: first.slot.date, start_time: first.slot.startTime, end_time: first.slot.endTime,
    minutes: 30, minutes_assumed: 0, note_path: 'y.md', status: 'scheduled',
  });
  taskBlocks.drop(blockId);

  const again = taskBlocks.plan(id, { now, minutes: 30 });
  assert.equal(again.slot.startTime, first.slot.startTime,
    'dropping a block is a decision that the time is no longer spoken for');
});

// ── Taking a task back out of a block ────────────────────────────────────────

test('removing a task drops its membership and its hold, not the task', async () => {
  const { taskIds, blockId } = blockedTasks(['Stays in the block', 'Comes back out']);
  const [stays, leaves] = taskIds;

  const result = await taskBlocks.removeTask(blockId, leaves);
  assert.equal(result.ok, true);
  assert.equal(result.remaining, 1);

  // The task is untouched and ordinary again.
  assert.equal(db.getTaskRow(leaves).status, 'open');
  assert.equal(taskStore.updateTask(leaves, { status: 'done' }).status, 'done');

  // ⚠ And the one LEFT BEHIND completes just the same — being in a block is
  // not a reason a task cannot be ticked. Removing it from the block must not
  // be the thing that makes it tickable, or the escape hatch becomes the route.
  assert.equal(taskStore.updateTask(stays, { status: 'done' }).status, 'done');
  assert.equal(db.listTaskBlockItems(blockId).find(i => i.task_id === stays).awaiting, 1);
});

test('removing the last task is refused — drop the block instead', async () => {
  const { taskIds, blockId } = blockedTasks(['The only one']);
  const result = await taskBlocks.removeTask(blockId, taskIds[0]);

  assert.equal(result.ok, false);
  assert.equal(result.lastTask, true);
  assert.match(result.error, /drop the block/);
  // An empty block is a window in the diary for nothing, and a note nobody can
  // write. Nothing was removed.
  assert.equal(db.listTaskBlockItems(blockId).length, 1);
});

test('a block that has been reopened owes its write-up again', async () => {
  // The one route left to `awaiting-writeup`: a task ticked in a block and then
  // REOPENED is ticked work that is no longer done, which is exactly what
  // `refreshBlockStatus` asks. Pinned because that status is otherwise
  // unreachable now, and an unreachable status is dead state.
  const { taskIds, blockId } = blockedTasks(['Ticked then reopened', 'Never ticked']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');

  taskStore.updateTask(taskIds[0], { status: 'open' });
  taskBlocks.refreshBlockStatus(blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');

  // Removing it takes the claim away with it.
  await taskBlocks.removeTask(blockId, taskIds[0]);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled',
    'the block kept claiming to be waiting on a write-up for work it no longer holds');
});

test('a task cannot be removed from a block that is already finished', async () => {
  const { taskIds, blockId, full } = blockedTasks(['One', 'Two']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const result = await taskBlocks.removeTask(blockId, taskIds[1]);
  assert.equal(result.ok, false);
  assert.match(result.error, /complete/);
});

test('removing a task that is not in the block says so', async () => {
  const { blockId } = blockedTasks(['In the block', 'Also in it']);
  const { id: outsider } = taskStore.createTask({ text: 'Not in any block', skipExport: true });
  const result = await taskBlocks.removeTask(blockId, outsider);
  assert.equal(result.ok, false);
  assert.match(result.error, /not in this block/);
});

test('an upcoming block is listed, so a batch does not vanish when you make it', () => {
  // The earlier cut hid future blocks as "not outstanding yet", which meant the
  // batch Nick had just created disappeared from the screen he created it on.
  const { blockId } = blockedTasks(['Later today one', 'Later today two'], { dateKey: '2099-03-04', startTime: '14:00' });
  const { rows } = taskBlocks.listOutstanding({ now: new Date(2099, 2, 4, 8, 0) });

  const row = rows.find(r => r.blockId === blockId);
  assert.ok(row, 'a block later today must still be visible as a group');
  assert.equal(row.passed, false, 'it is in the diary, not owing a write-up');
  assert.equal(row.tasks.length, 2);
});

// ── Writing the note on demand ───────────────────────────────────────────────

test('createNote writes the stub when it is missing', () => {
  const { blockId, full } = blockedTasks(['Note went missing']);
  fs.unlinkSync(full);   // vault write failed, or Nick deleted it

  const result = taskBlocks.createNote(blockId);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.ok(fs.existsSync(full), 'without this the block is held for a note there is nowhere to write');
});

test('createNote NEVER overwrites an existing note', () => {
  // The whole safety of the button. Clobbering a written-up note would destroy
  // the one thing this feature protects, in one click, with no undo.
  const { blockId, full } = blockedTasks(['Already written up']);
  writeUp(full);
  const before = fs.readFileSync(full, 'utf8');

  const result = taskBlocks.createNote(blockId);
  assert.equal(result.created, false);
  assert.match(result.reason, /already exists/);
  assert.equal(fs.readFileSync(full, 'utf8'), before, 'the write-up was overwritten');
  // Reported as a success: the note Nick wanted is there, which is what he asked for.
  assert.equal(result.ok, true);
});

test('a re-written stub lists what is in the block NOW, not what was', async () => {
  const { taskIds, blockId, full } = blockedTasks(['Kept task', 'Removed task']);
  await taskBlocks.removeTask(blockId, taskIds[1]);
  fs.unlinkSync(full);

  taskBlocks.createNote(blockId);
  const raw = fs.readFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, db.getTaskBlockRow(blockId).note_path), 'utf8');
  assert.ok(raw.includes('Kept task'));
  assert.ok(!raw.includes('Removed task'), 'the note named a task that is no longer in the block');
});

test('createNote on a block with nothing in it is refused, not written', () => {
  const { blockId } = blockedTasks(['Only task']);
  db.removeTaskBlockItem(blockId, db.listTaskBlockItems(blockId)[0].task_id);
  const result = taskBlocks.createNote(blockId);
  assert.equal(result.ok, false);
  assert.match(result.error, /no tasks/);
});

// ── Writing the note from inside NEURO ───────────────────────────────────────

test('the editor opens a missing note as a fresh stub, not an error', () => {
  const { blockId, full } = blockedTasks(['Note deleted in Obsidian']);
  fs.unlinkSync(full);

  const view = taskBlocks.readNoteForEdit(blockId);
  assert.equal(view.ok, true);
  assert.equal(view.exists, false, 'create and edit are the same act from where Nick sits');
  assert.ok(view.raw.includes('Note deleted in Obsidian'));
  assert.equal(view.written, false);
});

test('saving real prose completes the ticked tasks immediately', () => {
  // The sweep stays the mechanism for notes written in Obsidian. Here Nick is
  // looking at the screen, and a ten-minute wait to learn whether his words
  // counted is what would stop him trusting the rule.
  const { taskIds, blockId } = blockedTasks(['Ticked one', 'Never touched']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(blockId);
  const saved = taskBlocks.saveNote(
    blockId,
    view.raw.replace('## What came of it\n', '## What came of it\nCleared the first one; the second needs Chris.\n'),
    { baseHash: view.hash }
  );

  assert.equal(saved.ok, true);
  assert.equal(saved.released, true);
  assert.deepEqual(saved.completedTaskIds, [taskIds[0]]);
  assert.deepEqual(saved.stillOpenTaskIds, [taskIds[1]]);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open');
  assert.equal(db.getTaskBlockRow(blockId).status, 'complete');
});

test('saving something that still says nothing does not release the block', () => {
  const { taskIds, blockId } = blockedTasks(['Still open after a non-answer']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(blockId);
  const saved = taskBlocks.saveNote(blockId, view.raw.replace('## What came of it\n', '## What came of it\ndone\n'), {
    baseHash: view.hash,
  });

  assert.equal(saved.ok, true, 'the words are still saved — they are his');
  assert.equal(saved.released, false);
  assert.match(saved.reason, /characters/);
  // ⚠ The BLOCK is not released. The task is done either way now — the empty
  // stub rule is about whether the window got a record, never about the tick.
  assert.notEqual(db.getTaskBlockRow(blockId).status, 'complete');
});

test('a note changed in the vault since loading refuses the save', () => {
  // The same file is open in Obsidian and delivered by Syncthing. Without this,
  // saving from a card left open since this morning silently destroys whatever
  // was written there since — and NEURO cannot merge prose.
  const { blockId, full } = blockedTasks(['Edited in two places']);
  const view = taskBlocks.readNoteForEdit(blockId);

  fs.writeFileSync(full, view.raw + '\nWritten in Obsidian while the card sat open.\n', 'utf8');

  const saved = taskBlocks.saveNote(blockId, view.raw + '\nWritten in NEURO.\n', { baseHash: view.hash });
  assert.equal(saved.ok, false);
  assert.equal(saved.conflict, true);
  assert.match(fs.readFileSync(full, 'utf8'), /Written in Obsidian/, 'the vault copy was overwritten');
});

test('frontmatter edited away is restored, so the note stays findable', () => {
  // `task_ids` is the link back to the block. Lose it and a renamed note can
  // never be matched again, and the block holds forever.
  const { blockId, full } = blockedTasks(['Frontmatter clobbered']);
  const view = taskBlocks.readNoteForEdit(blockId);

  const saved = taskBlocks.saveNote(blockId, 'Just my summary, typed over the whole file.', { baseHash: view.hash });
  assert.equal(saved.ok, true);

  const raw = fs.readFileSync(full, 'utf8');
  assert.match(raw, /^---\n/, 'the note lost its frontmatter');
  assert.match(raw, /task_ids:/);
  assert.ok(raw.includes('Just my summary'));
});

test('a finished block is not editable', () => {
  const { taskIds, blockId, full } = blockedTasks(['Already done and dusted']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const saved = taskBlocks.saveNote(blockId, 'trying to rewrite history', { baseHash: null });
  assert.equal(saved.ok, false);
  assert.match(saved.error, /not waiting on a write-up/);
});

// ── Undoing a drop ───────────────────────────────────────────────────────────

test('a dropped block can be restored, because dropping deletes nothing', async () => {
  const { taskIds, blockId } = blockedTasks(['Dropped by mistake', 'Also in that block']);
  taskBlocks.drop(blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'dropped');

  const result = taskBlocks.restore(blockId);
  assert.equal(result.ok, true);
  assert.equal(result.tasks, 2);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
  assert.equal(db.listTaskBlockItems(blockId).length, 2, 'the membership must survive a drop');
  for (const id of taskIds) assert.equal(db.getTaskRow(id).status, 'open');
});

test('restoring returns a block to awaiting-writeup if a task was ticked', () => {
  // A task ticked before the drop is still ticked, and still owed a write-up.
  // Always restoring to 'scheduled' would lose that.
  const { taskIds, blockId } = blockedTasks(['Ticked before the drop', 'Untouched']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  taskBlocks.drop(blockId);

  taskBlocks.restore(blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');
});

test('only a dropped block can be restored', () => {
  // A released block completed the ticked tasks and a complete one earned its
  // note. Reversing either is a decision to un-finish work, not an undo.
  const { taskIds, blockId, full } = blockedTasks(['Finished properly']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);
  taskBlocks.sweep();

  const result = taskBlocks.restore(blockId);
  assert.equal(result.ok, false);
  assert.match(result.error, /not dropped/);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');
});

// ── Ticks survive the round trip between the card and the note ───────────────

test('ticks made on the card show up in the note when it is opened', () => {
  // The bug this fixes: the checklist was written when the block was created and
  // never updated, so it showed every task unticked however many had been ticked
  // off since. Two screens disagreeing about the same fact.
  const { taskIds, blockId } = blockedTasks(['Did this one', 'Did not do this']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(blockId);
  assert.ok(view.raw.includes(`- [x] Did this one <!--t:${taskIds[0]}-->`),
    'a task ticked on the card still showed unticked in the note');
  assert.ok(view.raw.includes(`- [ ] Did not do this <!--t:${taskIds[1]}-->`));
});

test('ticking a box in the note records the tick in NEURO', () => {
  const { taskIds, blockId } = blockedTasks(['Ticked in the note', 'Left alone']);
  const view = taskBlocks.readNoteForEdit(blockId);

  const edited = view.raw
    .replace(`- [ ] Ticked in the note <!--t:${taskIds[0]}-->`, `- [x] Ticked in the note <!--t:${taskIds[0]}-->`)
    .replace('## What came of it\n', '## What came of it\nGot the first one finished, second slipped.\n');

  const saved = taskBlocks.saveNote(blockId, edited, { baseHash: view.hash });
  assert.equal(saved.released, true);
  assert.deepEqual(saved.completedTaskIds, [taskIds[0]]);
  assert.deepEqual(saved.stillOpenTaskIds, [taskIds[1]]);
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open');
});

test('unticking a box in the note takes the tick back', () => {
  const { taskIds, blockId } = blockedTasks(['Ticked then reconsidered', 'Other']);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  assert.equal(db.listTaskBlockItems(blockId).find(i => i.task_id === taskIds[0]).awaiting, 1);

  const view = taskBlocks.readNoteForEdit(blockId);
  const edited = view.raw.replace(`- [x] Ticked then reconsidered <!--t:${taskIds[0]}-->`,
    `- [ ] Ticked then reconsidered <!--t:${taskIds[0]}-->`);

  taskBlocks.saveNote(blockId, edited, { baseHash: view.hash });
  assert.equal(db.listTaskBlockItems(blockId).find(i => i.task_id === taskIds[0]).awaiting, 0);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled',
    'nothing is ticked any more, so nothing is owed');
});

test('a box ticked in Obsidian is honoured by the sweep', () => {
  // The note is most likely to be finished in Obsidian, and a tick made there
  // would otherwise be ignored in favour of a card Nick never opened.
  const { taskIds, blockId, full, notePath } = blockedTasks(['Done in Obsidian', 'Not done']);
  const view = taskBlocks.readNoteForEdit(blockId);

  fs.writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, notePath),
    view.raw
      .replace(`- [ ] Done in Obsidian <!--t:${taskIds[0]}-->`, `- [x] Done in Obsidian <!--t:${taskIds[0]}-->`)
      .replace('## What came of it\n', '## What came of it\nWrote this up in Obsidian on the train.\n'),
    'utf8');

  const swept = taskBlocks.sweep();
  const entry = swept.completed.find(c => c.blockId === blockId);
  assert.deepEqual(entry.taskIds, [taskIds[0]]);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open');
});

test('a task already done shows ticked, even though it never held', () => {
  // It completed straight away because the note already had a write-up, so
  // `awaiting` was never set. Keying the box on that flag alone would show a
  // finished task unticked — the note contradicting the task list.
  const { taskIds, blockId, full } = blockedTasks(['One of a pair', 'Two of a pair']);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(
    '## What came of it\n', '## What came of it\nA summary written before any box was ticked.\n'), 'utf8');

  taskStore.updateTask(taskIds[0], { status: 'done' });
  const view = taskBlocks.readNoteForEdit(blockId);
  assert.ok(view.raw.includes('A summary written before any box was ticked.'));
  assert.match(view.raw, /- \[x\] One/);
});

// ── Several blocks at once ───────────────────────────────────────────────────

test('separate blocks stay independent', () => {
  // Separated by slot rather than by day: a block days old has expired and no
  // longer holds, so two live blocks necessarily share a date (14 Sep 2026).
  const a = blockedTasks(['Day one, job one', 'Day one, job two']);
  const b = blockedTasks(['Day two, job one', 'Day two, job two']);

  taskStore.updateTask(a.taskIds[0], { status: 'done' });
  taskStore.updateTask(b.taskIds[1], { status: 'done' });

  // Each tick lands in its own note and nowhere else.
  const viewA = taskBlocks.readNoteForEdit(a.blockId);
  const viewB = taskBlocks.readNoteForEdit(b.blockId);
  assert.ok(viewA.raw.includes(`- [x] Day one, job one <!--t:${a.taskIds[0]}-->`));
  assert.ok(viewA.raw.includes(`- [ ] Day one, job two <!--t:${a.taskIds[1]}-->`));
  assert.ok(viewB.raw.includes(`- [ ] Day two, job one <!--t:${b.taskIds[0]}-->`));
  assert.ok(viewB.raw.includes(`- [x] Day two, job two <!--t:${b.taskIds[1]}-->`));

  // Writing one up leaves the other exactly as it was.
  taskBlocks.saveNote(a.blockId, viewA.raw.replace('## What came of it\n',
    '## What came of it\nGot the first of the two done today.\n'), { baseHash: viewA.hash });

  assert.equal(db.getTaskBlockRow(a.blockId).status, 'complete');
  assert.equal(db.getTaskBlockRow(b.blockId).status, 'scheduled',
    'writing one block up must not touch another');
  // Both tasks were ticked, so both are done. A write-up in one window was
  // never what closed the other's work, and is no longer what closes its own.
  assert.equal(db.getTaskRow(a.taskIds[0]).status, 'done');
  assert.equal(db.getTaskRow(b.taskIds[1]).status, 'done');
});

test('two blocks on the same day get their own notes', () => {
  const a = blockedTasks(['Morning job'], { dateKey: '2026-06-03', startTime: '09:00' });
  const b = blockedTasks(['Afternoon job'], { dateKey: '2026-06-03', startTime: '14:00' });
  assert.notEqual(a.notePath, b.notePath, 'both blocks would write over each other');
});

test('a task in two open blocks is ticked in both, and reported honestly', () => {
  // Legitimate: work that did not finish gets blocked again. Under the hold the
  // NEWER block was picked to hold the tick; now neither holds it and both show
  // the box ticked, which is the honest rendering of one finished task.
  const first = blockedTasks(['Carried over', 'Only in the first']);
  const second = blockedTasks(['Only in the second']);
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);

  assert.equal(taskStore.updateTask(first.taskIds[0], { status: 'done' }).status, 'done');
  for (const id of [first.blockId, second.blockId]) {
    assert.equal(db.listTaskBlockItems(id).find(i => i.task_id === first.taskIds[0]).awaiting, 1,
      `block #${id} did not record the tick`);
  }

  // Writing up the second block is still a normal write-up.
  const view = taskBlocks.readNoteForEdit(second.blockId);
  taskBlocks.saveNote(second.blockId, view.raw.replace('## What came of it\n',
    '## What came of it\nPicked up the carried-over one and finished it.\n'), { baseHash: view.hash });
  assert.equal(db.getTaskRow(first.taskIds[0]).status, 'done');

  // The FIRST block must not now claim that task is still outstanding.
  taskStore.updateTask(first.taskIds[1], { status: 'done' });
  const viewFirst = taskBlocks.readNoteForEdit(first.blockId);
  const saved = taskBlocks.saveNote(first.blockId, viewFirst.raw.replace('## What came of it\n',
    '## What came of it\nCleared what was left in this window.\n'), { baseHash: viewFirst.hash });

  assert.ok(!saved.stillOpenTaskIds.includes(first.taskIds[0]),
    'a task already finished in another block was reported as still open');
});

test('the sweep handles several blocks in one pass', () => {
  const a = blockedTasks(['Swept A']);
  const b = blockedTasks(['Swept B']);
  const c = blockedTasks(['Not written up']);

  for (const x of [a, b, c]) taskStore.updateTask(x.taskIds[0], { status: 'done' });
  writeUp(a.full);
  writeUp(b.full);

  const swept = taskBlocks.sweep();
  const ids = swept.completed.map(x => x.blockId);
  assert.ok(ids.includes(a.blockId) && ids.includes(b.blockId));
  assert.ok(!ids.includes(c.blockId), 'a block with no write-up must not be closed as one');
  assert.equal(db.getTaskBlockRow(c.blockId).status, 'scheduled');
  // ⚠ And c's TASK is done regardless. The sweep decides the fate of BLOCKS,
  // never of ticks — that separation is the whole of this change.
  assert.equal(db.getTaskRow(c.taskIds[0]).status, 'done');
  assert.deepEqual(swept.gaps, []);
});

// ── Ticked is ticked everywhere; only one block carries the write-up ─────────

test('ticking a task ticks it in every block that holds it', () => {
  // Nick's rule, 18 Aug: "if I tick it off, it's ticked off — but it only needs
  // discussing in the block that's closing it."
  // Both blocks hold more than one task, which is when a note carries a
  // checklist at all — a single-task block has nothing to tick.
  const first = blockedTasks(['Carried over again', 'Only in the first again']);
  const second = blockedTasks(['Second block A', 'Second block B']);
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);
  taskBlocks.writeChecklistToNote(second.blockId);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });

  for (const id of [first.blockId, second.blockId]) {
    const view = taskBlocks.readNoteForEdit(id);
    assert.ok(view.raw.includes(`- [x] Carried over again <!--t:${first.taskIds[0]}-->`),
      `block #${id} still showed the task unticked`);
  }
});

test('neither block is left asking for a write-up once the work is done', () => {
  const first = blockedTasks(['Shared task']);
  const second = blockedTasks(['Something else']);
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);
  taskBlocks.writeChecklistToNote(second.blockId);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });

  // Under the hold both blocks went to `awaiting-writeup` and the task sat at
  // in-progress until one of them was written up. Now the task is simply done,
  // and neither block is owed anything — a window that demands a record for
  // finished work is the nag this codebase keeps deleting.
  assert.equal(db.getTaskRow(first.taskIds[0]).status, 'done');
  for (const id of [first.blockId, second.blockId]) {
    assert.equal(db.getTaskBlockRow(id).status, 'scheduled',
      `block #${id} is asking for a write-up nobody owes`);
  }

  // Writing one up anyway is still a normal, supported thing to do.
  const view = taskBlocks.readNoteForEdit(second.blockId);
  taskBlocks.saveNote(second.blockId, view.raw.replace('## What came of it\n',
    '## What came of it\nPicked up the shared one and finished it here.\n'), { baseHash: view.hash });
  assert.equal(db.getTaskBlockRow(second.blockId).status, 'complete');
  assert.equal(db.getTaskBlockRow(first.blockId).status, 'scheduled');
});

test('a settle is per TASK, not "this block is finished now"', () => {
  // The rule the old `awaiting-writeup` dance was protecting still matters: a
  // write-up in one window must not reach into another block and settle work it
  // does not hold. Pinned on the ITEMS, which is where the fact lives now.
  const first = blockedTasks(['Shared again', 'Its own work']);
  const second = blockedTasks(['Elsewhere']);
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });

  const view = taskBlocks.readNoteForEdit(second.blockId);
  taskBlocks.saveNote(second.blockId, view.raw.replace('## What came of it\n',
    '## What came of it\nClosed the shared one over here.\n'), { baseHash: view.hash });

  // The second block closed. The first still holds its own untouched work and
  // is untouched itself.
  assert.equal(db.getTaskBlockRow(second.blockId).status, 'complete');
  assert.equal(db.getTaskBlockRow(first.blockId).status, 'scheduled');
  assert.equal(db.getTaskRow(first.taskIds[1]).status, 'open',
    'a write-up in another window closed work it never held');
  assert.equal(db.listTaskBlockItems(first.blockId).find(i => i.task_id === first.taskIds[1]).awaiting, 0);
});

test('unticking a task unticks it everywhere too', () => {
  const first = blockedTasks(['On the fence']);
  const second = blockedTasks(['Other work']);
  db.addTaskBlockItem(second.blockId, first.taskIds[0], null);
  taskBlocks.writeChecklistToNote(second.blockId);

  taskStore.updateTask(first.taskIds[0], { status: 'done' });
  taskBlocks.setTickEverywhere(first.taskIds[0], false);

  for (const id of [first.blockId, second.blockId]) {
    assert.equal(
      db.listTaskBlockItems(id).find(i => i.task_id === first.taskIds[0]).awaiting, 0,
      `block #${id} kept a tick that was taken back`
    );
  }
});

// ── The due date follows the block ──────────────────────────────────────────
//
// Blocking a task IS deciding when it is being done, so a due date that says
// otherwise leaves it in the overdue lane on a day it is already scheduled for.
// The direction matters: pulling a date in is bookkeeping, pushing one out moves
// a deadline, and only the second has to be reported.

/** Graph is not reachable from a test, and does not need to be — the write-back
 *  happens before the event is created, which is exactly what the last of these
 *  pins. */
function withoutGraph(fn) {
  const microsoft = require('./microsoft');
  const real = microsoft.createCalendarEvent;
  microsoft.createCalendarEvent = async () => ({ created: false, reason: 'no graph in tests' });
  try { return fn(); } finally { microsoft.createCalendarEvent = real; }
}

function freshTask(text, dueDate = null) {
  const { id } = taskStore.createTask({ text, source: 'manual', skipExport: true });
  if (dueDate) taskStore.updateTask(id, { due_date: dueDate });
  return id;
}

test('blocking a task sets its due date to the day of the block', async () => {
  const id = freshTask('Write the charter');
  assert.equal(db.getTaskRow(id).due_date, null);

  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-10', startTime: '10:00', minutes: 30,
  }));

  assert.equal(db.getTaskRow(id).due_date, '2026-09-10');
  // Reported even though Graph refused — the date really did move, and a caller
  // reading updates only on success would call a half-done state nothing.
  assert.deepEqual(res.dueUpdates.map(u => [u.taskId, u.from, u.to, u.later]),
    [[id, null, '2026-09-10', false]]);
});

test('pulling a due date IN is not reported as moving a deadline', async () => {
  const id = freshTask('Due next week', '2026-09-20');
  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-11', startTime: '10:00', minutes: 30,
  }));
  assert.equal(db.getTaskRow(id).due_date, '2026-09-11');
  assert.equal(res.dueUpdates[0].later, false);
});

test('pushing a due date OUT moves a deadline, and says so', async () => {
  const id = freshTask('Due tomorrow', '2026-09-02');
  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-12', startTime: '10:00', minutes: 30,
  }));
  assert.equal(db.getTaskRow(id).due_date, '2026-09-12');
  assert.deepEqual(
    res.dueUpdates.map(u => ({ from: u.from, to: u.to, later: u.later })),
    [{ from: '2026-09-02', to: '2026-09-12', later: true }],
  );
});

test('a task already due on the day is left alone, not rewritten', async () => {
  const id = freshTask('Already dated', '2026-09-13');
  const res = await withoutGraph(() => taskBlocks.schedule([id], {
    date: '2026-09-13', startTime: '10:00', minutes: 30,
  }));
  assert.equal(db.getTaskRow(id).due_date, '2026-09-13');
  assert.deepEqual(res.dueUpdates, [], 'nothing changed, so nothing to report');
});

test('saveDue:false leaves every due date where it was', async () => {
  const a = freshTask('Untouched A');
  const b = freshTask('Untouched B', '2026-09-03');
  await withoutGraph(() => taskBlocks.schedule([a, b], {
    date: '2026-09-14', startTime: '10:00', minutes: 60, saveDue: false,
  }));
  assert.equal(db.getTaskRow(a).due_date, null);
  assert.equal(db.getTaskRow(b).due_date, '2026-09-03');
});

test('plan() says which deadlines the window would push out, and creates nothing', () => {
  const early = freshTask('Owed sooner', '2026-09-04');
  const late = freshTask('Owed later', '2026-09-30');
  const none = freshTask('No date');

  const draft = taskBlocks.plan([early, late, none], {
    date: '2026-09-15', startTime: '10:00', minutes: 60,
  });

  assert.equal(draft.ok, true);
  assert.equal(draft.dueLaterCount, 1, 'only the one due before the block is pushed out');
  assert.deepEqual(draft.tasks.map(t => t.dueMovesLater), [true, false, false]);
  assert.deepEqual(draft.tasks.map(t => t.dueDate), ['2026-09-04', '2026-09-30', null]);
  // Planning is a read. A plan that had already moved the dates would make the
  // preview the act it exists to precede.
  assert.equal(db.getTaskRow(early).due_date, '2026-09-04');
  assert.equal(db.getTaskRow(late).due_date, '2026-09-30');
  assert.equal(db.getTaskRow(none).due_date, null);
});

// ── Rescheduling a block that did not happen ────────────────────────────────
//
// The property that matters is the one about ticks: a tick is finished work, so
// it must NEVER travel into a future slot. Everything else here exists to stop
// the recovery path costing more than the missed window did.

/** Graph, answering. `withoutGraph` above makes schedule() fail by design, which
 *  is the wrong shape for testing a move — a reschedule that cannot create the
 *  new block correctly refuses to touch the old one. */
function withGraph(fn) {
  const microsoft = require('./microsoft');
  const real = {
    create: microsoft.createCalendarEvent,
    update: microsoft.updateCalendarEvent,
    del: microsoft.deleteCalendarEvent,
  };
  const deleted = [];
  let seq = 0;
  microsoft.createCalendarEvent = async () => ({ created: true, event: { id: `evt-${++seq}`, webLink: null } });
  microsoft.updateCalendarEvent = async () => ({ updated: true });
  microsoft.deleteCalendarEvent = async (id) => { deleted.push(id); return { deleted: true }; };
  const done = (r) => { Object.assign(microsoft, {
    createCalendarEvent: real.create, updateCalendarEvent: real.update, deleteCalendarEvent: real.del,
  }); return r; };
  return Promise.resolve(fn(deleted)).then(done, (e) => { done(); throw e; });
}

test('an untouched block moves whole, and its old event is deleted', async () => {
  const { taskIds, blockId } = blockedTasks(['Charter V2', 'Rejection reasons'], { dateKey: '2026-09-01' });
  db.updateTaskBlockRow(blockId, { event_id: 'evt-old' });

  const res = await withGraph(async (deleted) => {
    const r = await taskBlocks.reschedule(blockId, { date: '2026-09-15', startTime: '10:00', minutes: 60 });
    assert.deepEqual(deleted, ['evt-old'], 'the old event should not survive an empty block');
    return r;
  });

  assert.equal(res.ok, true);
  assert.equal(res.from.action, 'dropped');
  assert.equal(db.getTaskBlockRow(blockId).status, 'dropped');
  assert.equal(res.moved.length, 2);
  // Both tasks are in the new block, and only there.
  const moved = db.listTaskBlockItems(res.to.blockId).map(i => i.task_id).sort();
  assert.deepEqual(moved, [...taskIds].sort());
  assert.equal(db.listTaskBlockItems(blockId).length, 0);
});

test('a TICKED task never moves — the sitting it belongs to has happened', async () => {
  // The whole rule, and it survives the hold going: carrying finished work into
  // a future slot would put a completion in the diary that has already happened
  // and make the new block's note responsible for a sitting already had.
  const { taskIds, blockId } = blockedTasks(['Did this one before moving the rest', 'Never started', 'Also not started'], { dateKey: '2026-09-01' });
  db.updateTaskBlockRow(blockId, { event_id: 'evt-part' });
  taskStore.updateTask(taskIds[0], { status: 'done' });
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done', 'the tick completes outright now');

  const res = await withGraph(async (deleted) => {
    const r = await taskBlocks.reschedule(blockId, { date: '2026-09-16', startTime: '10:00', minutes: 60 });
    // A block that produced real work is a record of where the time went.
    assert.deepEqual(deleted, [], 'an event holding finished work must not be deleted');
    return r;
  });

  assert.equal(res.ok, true);
  assert.equal(res.from.action, 'kept');
  assert.deepEqual(res.moved.map(m => m.taskId).sort(), [taskIds[1], taskIds[2]].sort());

  // The ticked one is still on the old block, and still done.
  const left = db.listTaskBlockItems(blockId);
  assert.deepEqual(left.map(i => i.task_id), [taskIds[0]]);
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done');

  // And it did not follow the others into the new slot.
  const next = db.listTaskBlockItems(res.to.blockId).map(i => i.task_id);
  assert.ok(!next.includes(taskIds[0]), 'a ticked task reached the new block');
});

test('asking to move a ticked task is REFUSED, not quietly skipped', async () => {
  const { taskIds, blockId } = blockedTasks(['Done already', 'Outstanding']);
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const res = await withGraph(() => taskBlocks.reschedule(blockId, {
    date: '2026-09-17', startTime: '10:00', minutes: 60, taskIds: [taskIds[0], taskIds[1]],
  }));
  assert.equal(res.ok, false);
  assert.match(res.error, /ticked/i);
  assert.deepEqual(res.tickedIds, [taskIds[0]]);
  // Nothing moved.
  assert.equal(db.listTaskBlockItems(blockId).length, 2);
});

test('part of a block can be moved on its own', async () => {
  const { taskIds, blockId } = blockedTasks(['Move me', 'Leave me', 'Leave me too'], { dateKey: '2026-09-01' });

  const res = await withGraph(() => taskBlocks.reschedule(blockId, {
    date: '2026-09-18', startTime: '10:00', minutes: 30, taskIds: [taskIds[0]],
  }));
  assert.equal(res.ok, true);
  assert.equal(res.from.action, 'kept');
  assert.deepEqual(db.listTaskBlockItems(blockId).map(i => i.task_id).sort(), [taskIds[1], taskIds[2]].sort());
  assert.deepEqual(db.listTaskBlockItems(res.to.blockId).map(i => i.task_id), [taskIds[0]]);
});

test('a block with nothing outstanding is refused — it needs a note, not a slot', async () => {
  const { taskIds, blockId } = blockedTasks(['The only one'], { dateKey: '2026-09-01' });
  taskStore.updateTask(taskIds[0], { status: 'done' });

  const res = await withGraph(() => taskBlocks.reschedule(blockId, { date: '2026-09-19', startTime: '10:00' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /write-up/i);
});

test('a failed new block leaves the old one exactly as it was', async () => {
  // Order is load-bearing: detaching first and then failing would leave the
  // tasks in no block at all, which is worse than the missed window.
  const { blockId } = blockedTasks(['Stays put A', 'Stays put B'], { dateKey: '2026-09-01' });
  const before = db.listTaskBlockItems(blockId).length;

  const clash = blockedTasks(['Occupant'], { dateKey: '2026-09-20', startTime: '11:00' });
  assert.ok(clash.blockId);

  const res = await taskBlocks.reschedule(blockId, { date: '2026-09-20', startTime: '11:00', minutes: 60 });
  assert.equal(res.ok, false);
  assert.equal(res.rescheduling, blockId);
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled');
  assert.equal(db.listTaskBlockItems(blockId).length, before);
});

test('a finished block is not reopened by giving it a new slot', async () => {
  // released / complete / dropped all ended the block deliberately. `restore` is
  // the way back from a drop; a new slot is not an undo.
  const { blockId } = blockedTasks(['Abandoned'], { dateKey: '2026-09-01' });
  taskBlocks.drop(blockId);
  const res = await withGraph(() => taskBlocks.reschedule(blockId, { date: '2026-09-21', startTime: '10:00' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /dropped/);
});

// ---------------------------------------------------------------------------
// Adding a task to a window that already exists
// ---------------------------------------------------------------------------

/** Graph is not reachable from a test; the membership is written before it anyway. */
function withoutUpdate(fn) {
  const microsoft = require('./microsoft');
  const real = microsoft.updateCalendarEvent;
  microsoft.updateCalendarEvent = async () => ({ updated: false, reason: 'no graph in tests' });
  try { return fn(); } finally { microsoft.updateCalendarEvent = real; }
}

/**
 * The diary, or the absence of one. `null` makes it UNREADABLE, which is a
 * different fact from empty and has to stay testable as one.
 */
function withCalendar(rows, fn) {
  const real = db.getCalendarEvents;
  db.getCalendarEvents = rows === null
    ? () => { throw new Error('calendar unreadable'); }
    : () => rows;
  try { return fn(); } finally { db.getCalendarEvents = real; }
}

// ⚠ Each block gets its OWN DAY, not just its own slot. readCalendar folds
// NEURO's blocks in as events, so two fixtures on one day are walls to each
// other and every extension would silently measure zero.
let daySeq = 0;
function nextDay() { return `2026-12-${String(++daySeq).padStart(2, '0')}`; }

/** A 10:00-10:30 block on a day of its own, ahead of `at()`. */
function ahead(text) {
  const dateKey = nextDay();
  const made = blockedTasks(text, { dateKey, startTime: '10:00' });
  db.updateTaskBlockRow(made.blockId, { end_time: '10:30', minutes: 30, minutes_assumed: 0 });
  return { ...made, dateKey };
}
const at = (dateKey, time = '09:00') => new Date(`${dateKey}T${time}:00`);

test('a task joins an existing block, and the window grows by what it takes', async () => {
  const { blockId, dateKey } = ahead('Draft the capacity note');
  const extra = freshTask('Chase the Sandford escalation');
  taskStore.updateTask(extra, { estimateMinutes: 30 });

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, extra, { now: at(dateKey) })));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.total, 2);
  assert.equal(res.extendedBy, 30);
  assert.equal(db.getTaskBlockRow(blockId).end_time, '11:00');
  assert.equal(db.getTaskBlockRow(blockId).minutes, 60);
  assert.ok(db.listTaskBlockItems(blockId).some(i => i.task_id === extra));
});

test('an un-estimated task extends by the assumption, and the window says it is a guess', async () => {
  const { blockId, dateKey } = ahead('Write the charter');
  const extra = freshTask('Something nobody has sized');

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, extra, { now: at(dateKey) })));

  assert.equal(res.estimateAssumed, true);
  assert.equal(res.minutesAssumed, true);
  assert.equal(db.getTaskBlockRow(blockId).minutes_assumed, 1);
  // ⚠ And the guess is NOT written back onto the task. The window is shared, so
  // splitting it across members would invent a number per task.
  assert.equal(db.getTaskRow(extra).estimate_minutes, null);
});

test('the next meeting caps the extension, and the shortfall is REPORTED', async () => {
  const { blockId, dateKey } = ahead('Prep the board pack');
  const extra = freshTask('A two-hour job');
  taskStore.updateTask(extra, { estimateMinutes: 120 });

  const res = await withCalendar([{
    start_time: `${dateKey}T11:00:00`, end_time: `${dateKey}T12:00:00`,
    subject: 'SMT update', is_all_day: 0, show_as: 'busy',
  }], () => withoutUpdate(() => taskBlocks.addTask(blockId, extra, { now: at(dateKey) })));

  assert.equal(res.ok, true, 'overpacking is reported, never refused');
  assert.ok(res.extendedBy > 0 && res.extendedBy < 120, `extended ${res.extendedBy}`);
  assert.match(res.extendNote, /SMT update/);
  assert.equal(res.overpacked, true);
  assert.ok(db.getTaskBlockRow(blockId).end_time < '11:00');
});

test('an unreadable diary adds the task and lengthens NOTHING', async () => {
  // ⚠ The refusal that matters. Lengthening blind would put a real event over a
  // meeting nobody could see; the membership takes nobody else's time, so it
  // still happens.
  const { blockId, dateKey } = ahead('Review the runbook');
  const extra = freshTask('Another thing entirely');

  const res = await withCalendar(null, () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, extra, { now: at(dateKey) })));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.calendarKnown, false);
  assert.equal(res.extendedBy, 0);
  assert.match(res.extendNote, /could not be read/);
  assert.equal(db.getTaskBlockRow(blockId).end_time, '10:30');
  assert.equal(db.listTaskBlockItems(blockId).length, 2);
});

test('a window that has already gone REFUSES — that is a sitting, not a plan', async () => {
  const { blockId, dateKey } = ahead('Work from a window that has been');
  const extra = freshTask('Work for a window that has been');

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, extra, { now: at(dateKey, '14:00') })));

  assert.equal(res.ok, false);
  assert.equal(res.passed, true);
  assert.match(res.error, /already gone/);
  assert.equal(db.listTaskBlockItems(blockId).length, 1, 'the refusal must not half-apply');
});

test('a task already blocked elsewhere is refused, and the other block is NAMED', async () => {
  // Two live blocks holding one task is two holds, two outcome notes, and a
  // sweep with no way to say which sitting the evidence belongs to.
  const first = ahead('Sitting in its own block');
  const second = ahead('A different block entirely');

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(second.blockId, first.taskId, { now: at(second.dateKey) })));

  assert.equal(res.ok, false);
  assert.equal(res.elsewhereBlockId, first.blockId);
  assert.match(res.error, /already blocked at/);
});

test('adding the same task twice FOLDS and says so, rather than doing nothing', async () => {
  const { blockId, taskId, dateKey } = ahead('The one already in there');

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, taskId, { now: at(dateKey) })));

  assert.equal(res.ok, true);
  assert.equal(res.already, true);
  assert.equal(db.listTaskBlockItems(blockId).length, 1);
});

test('the due date follows the block, and pushing one out is reported as such', async () => {
  const { blockId, dateKey } = ahead('The anchor task');
  const extra = freshTask('Dated for another day', '2026-11-01');

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, extra, { now: at(dateKey) })));

  assert.equal(db.getTaskRow(extra).due_date, dateKey);
  assert.equal(res.dueUpdate.from, '2026-11-01');
  assert.equal(res.dueUpdate.to, dateKey);
  assert.equal(res.dueUpdate.later, true, 'pushing a deadline out is not the same act as pulling one in');
});

test('a released block is not a window any more', async () => {
  const { blockId, dateKey } = ahead('Done and dusted');
  db.updateTaskBlockRow(blockId, { status: 'released', release_reason: 'nothing to write up' });
  const extra = freshTask('Far too late for this');

  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, extra, { now: at(dateKey) })));

  assert.equal(res.ok, false);
  assert.match(res.error, /not a window any more/);
});

test("the cap is the service's, so both ways into a block honour one number", async () => {
  const { blockId, dateKey } = ahead('First of many');
  for (let i = 1; i < taskBlocks.MAX_TASKS_PER_BLOCK; i++) {
    const id = freshTask(`Filler task number ${i} for the cap`);
    const r = await withCalendar([], () => withoutUpdate(() =>
      taskBlocks.addTask(blockId, id, { now: at(dateKey) })));
    assert.equal(r.ok, true, `filler ${i}: ${r.error}`);
  }
  const overflow = freshTask('One task too many for the window');
  const res = await withCalendar([], () => withoutUpdate(() =>
    taskBlocks.addTask(blockId, overflow, { now: at(dateKey) })));
  assert.equal(res.ok, false);
  assert.match(res.error, /at most/);
});

// ── One task, one window (8 Sep 2026) ────────────────────────────────────────
//
// `addTask` had always refused a task that was already in another open block,
// and the CREATION path said nothing — so every other route in was free to
// block the same task again. It never self-corrected because a block holds its
// task OPEN, so a blocked task stays in `activeTodos()` and is re-offered on
// every run. Measured on the live Pi: four tasks each in two open blocks, one
// of them booked twice in one day by the planner's own morning and afternoon
// runs.

test('a task already in an open block cannot be blocked again', () => {
  const { taskId, blockId, dateKey } = ahead('Review where the process broke down');

  const res = withCalendar([], () => taskBlocks.plan([taskId], {
    date: '2026-12-30', startTime: '14:00', now: at(dateKey),
  }));

  assert.equal(res.ok, false, 'the second window was allowed — this is the duplicate bug');
  assert.equal(res.blockedElsewhere[0].blockId, blockId);
  // Named, so the refusal can be acted on rather than merely obeyed: the answer
  // is to move THAT block, and Nick has to be able to find it.
  assert.match(res.error, /10:00/);
  assert.match(res.error, /2026-12/);
});

test('schedule refuses it too, and creates nothing', async () => {
  const { taskId, blockId, dateKey } = ahead('Chase the Tier 2 ageing figures');
  const before = db.listTaskBlockRows({}).length;

  const res = await withCalendar([], () => taskBlocks.schedule([taskId], {
    date: '2026-12-31', startTime: '14:00', now: at(dateKey),
  }));

  assert.equal(res.ok, false);
  assert.equal(db.listTaskBlockRows({}).length, before, 'a block row was written despite the refusal');
  assert.equal(db.listTaskBlockRows({ taskId, openOnly: true }).length, 1);
  assert.equal(db.listTaskBlockRows({ taskId, openOnly: true })[0].id, blockId);
});

test('the block being moved is not a clash with itself', () => {
  // reschedule creates the new block BEFORE detaching from the old one, on
  // purpose: a taken slot or a Graph refusal must leave the old block intact.
  // At that moment the movers are legitimately still members of it.
  const { taskId, blockId, dateKey } = ahead('Prep for the risk meeting');

  const res = withCalendar([], () => taskBlocks.plan([taskId], {
    date: '2026-12-29', startTime: '14:00', ignoreBlockId: blockId, now: at(dateKey),
  }));

  assert.equal(res.ok, true, res.error);
});

test('a block that has ENDED does not hold its task hostage', () => {
  // dropped / released / complete are all finished. Refusing on one of those
  // would make a task unblockable for ever after one abandoned window.
  const { taskId, blockId, dateKey } = ahead('Scope the interim status messaging');
  db.updateTaskBlockRow(blockId, { status: 'dropped' });

  const res = withCalendar([], () => taskBlocks.plan([taskId], {
    date: '2026-12-28', startTime: '14:00', now: at(dateKey),
  }));

  assert.equal(res.ok, true, res.error);
});

test('blockedTaskIds returns null on a read failure, never an empty set', () => {
  // The caller is the day planner, which uses this to leave already-blocked
  // work alone. An empty set reads as "nothing is blocked" and would put it
  // straight back to booking the same task twice a day, silently.
  const real = db.listTaskBlockRows;
  db.listTaskBlockRows = () => { throw new Error('blocks unreadable'); };
  try {
    assert.equal(taskBlocks.blockedTaskIds(), null);
  } finally {
    db.listTaskBlockRows = real;
  }
});

test('a window ENDED today is not an invitation to book another (16 Sep 2026)', () => {
  // Measured on the live store: #30 (Krista) and #137 were each booked TWICE on
  // 4 Sep, the second booking following a drop — the planner overruling a
  // decision Nick had just made, in his own diary. The ledger could not know,
  // because it recorded block ids and never what went into them.
  const planner = require('./day-planner');
  const { taskId, blockId, dateKey } = ahead('Review the TPFG attribution rules');

  // The planner booked it this morning, and Nick dropped the window.
  planner.stampPlanned(dateKey, planner.MORNING.key, [blockId], [taskId]);
  db.updateTaskBlockRow(blockId, { status: 'dropped' });

  const input = withCalendar([], () => planner.gather(at(dateKey)));

  assert.equal(input.tasks.some(t => t.id === taskId), false,
    'the planner re-booked work whose window Nick had just ended');
  assert.ok(input.replanHeld >= 1, 'a silent shortfall looks exactly like a quiet day');
});

test('the same task IS planned again the next day', () => {
  // The memory is day-scoped on purpose. The task is still open and still owed.
  const planner = require('./day-planner');
  const { taskId, blockId, dateKey } = ahead('Chase the Micom commercials pack');

  planner.stampPlanned(dateKey, planner.MORNING.key, [blockId], [taskId]);
  db.updateTaskBlockRow(blockId, { status: 'dropped' });

  const tomorrow = new Date(`${dateKey}T09:00:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const input = withCalendar([], () => planner.gather(tomorrow));

  assert.equal(input.replanHeld, 0, 'yesterday must not suppress today');
  assert.ok(input.tasks.some(t => t.id === taskId),
    'a task taken out of yesterday is still open, still owed, and plannable');
});

test('"not today" in the lane is honoured by the planner', () => {
  // The lane offers a defer with a reason and a return time, stored in
  // attention_records — and the planner never asked, so a task Nick had just
  // pushed to tomorrow could be booked into this afternoon.
  const planner = require('./day-planner');
  const lifecycle = require('./attention-lifecycle');
  const text = 'Write up the escalation accuracy findings';
  const taskId = freshTask(text);

  const rec = lifecycle.upsert({ id: `todo-${taskId}`, type: 'todo', title: text, reason: 'overdue', urgency: 'high' });
  lifecycle.act(rec.id, 'defer', { reason: 'not-now', minutes: 24 * 60 });

  // ⚠ Planned against the REAL clock, not this file's December fixture days. A
  // deferral is stored as an absolute `defer_until` off the wall clock, so
  // gathering for a date months ahead reads every deferral as long expired —
  // the test would pass or fail on the fixture calendar rather than the rule.
  const input = withCalendar([], () => planner.gather(new Date()));

  assert.equal(input.tasks.some(t => t.id === taskId), false,
    'the planner booked time for work Nick had just put off');
  assert.ok(input.deferredHeld >= 1, 'what was held back must be reported');
  assert.equal(input.deferralsKnown, true);

  lifecycle.act(rec.id, 'undefer');
});

test('UNKNOWN never blocks, and never passes for a check that happened', () => {
  // one-to-one-booking's awayCheck rule: an unreadable lifecycle must not stop
  // the planner working, but a plan that skipped the check must not look like
  // one that made it.
  const planner = require('./day-planner');
  const lifecycle = require('./attention-lifecycle');
  const text = 'Prepare the Tier 2 ageing summary';
  const taskId = freshTask(text);
  const dateKey = nextDay();

  const real = lifecycle.deferredKeys;
  lifecycle.deferredKeys = () => { throw new Error('lifecycle unreadable'); };
  let input;
  try {
    input = withCalendar([], () => planner.gather(at(dateKey)));
  } finally {
    lifecycle.deferredKeys = real;
  }

  assert.ok(input.tasks.some(t => t.id === taskId), 'a failed check must not stop the planner');
  assert.equal(input.deferralsKnown, false, 'it must SAY the check did not happen');
  assert.ok(input.gaps.some(g => /deferrals unreadable/.test(g)));
});

test('the day planner leaves already-blocked work alone, and says how much', () => {
  const planner = require('./day-planner');
  const { taskId, dateKey } = ahead('Fix auto-assignment of unassigned production tickets');

  const input = withCalendar([], () => planner.gather(at(dateKey)));

  assert.equal(input.tasks.some(t => t.id === taskId), false,
    'the planner would book a second window for work already in the diary');
  assert.ok(input.blockedHeld >= 1, 'a silent shortfall looks exactly like a quiet day');
  assert.equal(input.blockedKnown, true);
});

test('an unreadable block list plans NOTHING rather than planning blind', () => {
  const planner = require('./day-planner');
  const real = db.listTaskBlockRows;
  db.listTaskBlockRows = () => { throw new Error('blocks unreadable'); };
  try {
    const input = withCalendar([], () => planner.gather(new Date('2026-12-15T09:00:00')));
    assert.deepEqual(input.tasks, []);
    assert.equal(input.blockedKnown, false);
    assert.ok(input.gaps.some(g => /block membership unreadable/.test(g)));
  } finally {
    db.listTaskBlockRows = real;
  }
});

// ── scheduleMoving — the standup's "put it in 14:30 to 16:00" (11 Sep 2026) ─────
//
// A task whose earlier window came and went unworked is the COMMON case when
// Nick commits to it again at a standup. `schedule` correctly refuses it (one
// task, one window), so this gathers tasks out of wherever they sit into ONE new
// block — under reschedule's rules, because it is the same act.

test('scheduleMoving takes a task out of its dead block and into the new one', async () => {
  const stale = blockedTasks(['Review the Krista issue'], { dateKey: '2026-10-01', startTime: '12:35' });
  db.updateTaskBlockRow(stale.blockId, { event_id: 'evt-krista-old' });
  const { id: fresh } = taskStore.createTask({ text: 'NDC data fixes', source: 'manual', skipExport: true });

  const res = await withGraph(async (deleted) => {
    const r = await taskBlocks.scheduleMoving([stale.taskId, fresh], { date: '2026-10-03', startTime: '14:30', minutes: 90 });
    assert.deepEqual(deleted, ['evt-krista-old'], 'the emptied old block should not leave its event behind');
    return r;
  });

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(db.listTaskBlockItems(res.blockId).map(i => i.task_id).sort(), [stale.taskId, fresh].sort());
  assert.equal(db.listTaskBlockItems(stale.blockId).length, 0, 'still in the old block = two live holds');
  assert.equal(db.getTaskBlockRow(stale.blockId).status, 'dropped');
  assert.equal(res.movedFrom.length, 1);
  assert.equal(res.movedFrom[0].blockId, stale.blockId);
});

test('scheduleMoving leaves the rest of a shared old block where it was', async () => {
  const old = blockedTasks(['Move me', 'Leave me'], { dateKey: '2026-10-04', startTime: '10:00' });
  const res = await withGraph(() => taskBlocks.scheduleMoving([old.taskIds[0]], { date: '2026-10-05', startTime: '14:30', minutes: 60 }));

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(db.listTaskBlockItems(old.blockId).map(i => i.task_id), [old.taskIds[1]]);
  assert.equal(db.getTaskBlockRow(old.blockId).status, 'scheduled');
  assert.equal(res.movedFrom[0].action, 'kept');
});

test('scheduleMoving never moves a TICKED task, and says which', async () => {
  const old = blockedTasks(['Done in its own window'], { dateKey: '2026-10-06', startTime: '09:00' });
  taskStore.updateTask(old.taskId, { status: 'done' }); // held, awaiting write-up

  const res = await withGraph(() => taskBlocks.scheduleMoving([old.taskId], { date: '2026-10-07', startTime: '14:30', minutes: 60 }));

  assert.equal(res.ok, false);
  assert.match(res.error, new RegExp(`#${old.taskId}`));
  assert.equal(db.listTaskBlockItems(old.blockId).length, 1, 'a refused move must touch nothing');
  assert.equal(db.listTaskBlockRows({ taskId: old.taskId, openOnly: true }).length, 1);
});

test('scheduleMoving asked again for the slot it already filled folds, rather than clashing with itself', async () => {
  const { id } = taskStore.createTask({ text: 'Retry-safe standup booking', source: 'manual', skipExport: true });
  const first = await withGraph(() => taskBlocks.scheduleMoving([id], { date: '2026-10-08', startTime: '14:30', minutes: 60 }));
  assert.equal(first.ok, true, first.error);

  const again = await withGraph(() => taskBlocks.scheduleMoving([id], { date: '2026-10-08', startTime: '14:30', minutes: 60 }));
  assert.equal(again.ok, true, again.error);
  assert.equal(again.already, true);
  assert.equal(again.blockId, first.blockId);
  assert.equal(db.getTaskBlockRow(first.blockId).status, 'scheduled', 'the retry must not drop the block it is already in');
});

test('scheduleMoving with Outlook refusing still leaves ONE hold, not two', async () => {
  const old = blockedTasks(['Graph is down today'], { dateKey: '2026-10-09', startTime: '09:00' });
  const res = await withoutGraph(() => taskBlocks.scheduleMoving([old.taskId], { date: '2026-10-10', startTime: '14:30', minutes: 60 }));

  assert.equal(res.ok, false, 'an Outlook refusal is still reported as one');
  assert.ok(res.blockId);
  assert.equal(db.listTaskBlockRows({ taskId: old.taskId, openOnly: true }).length, 1);
});

// ── Ageing a block out (14 Sep 2026) ─────────────────────────────────────────
//
// These go through the real DB, the real vault and the real sweep, because the
// bug was never in the judgement — `isStale` is pinned pure next door — it was
// that nothing ever ASKED. Twelve blocks sat open across six days holding 18
// open tasks, and the only symptom Nick could see was a checkbox that would not
// stick.

/**
 * A block whose window closed `hoursAgo` hours ago, with its stub on disk.
 *
 * Each call steps a few minutes further back so two fixtures asking for the same
 * age do not collide on the (date_key, start_time) uniqueness guard.
 */
let agedSeq = 0;
function agedBlock(texts, hoursAgo) {
  const at = new Date(Date.now() - hoursAgo * 3600000 - (agedSeq++ * 7) * 60000);
  const p2 = n => String(n).padStart(2, '0');
  const startMin = Math.max(0, at.getHours() * 60 + at.getMinutes() - 30);
  const hhmm = m => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
  return blockedTasks(texts, {
    dateKey: `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())}`,
    startTime: hhmm(startMin),
    endTime: hhmm(startMin + 20),
  });
}

test('a future block does not hold a tick — there is no sitting to write up yet', () => {
  // openOnly includes 'scheduled', which is every block the day planner books on
  // a timer, so before this a task was un-tickable from the moment it was
  // planned. This is the case Nick actually hit.
  const { taskId } = blockedTasks(['Booked for later today'], { dateKey: '2099-05-05', startTime: '15:30' });
  const result = taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(result.held, undefined, 'a slot that has not happened cannot hold a tick');
  assert.equal(result.status, 'done');
});

test('a block a day past its window stops holding, and the sweep closes it', () => {
  const { taskId, blockId } = agedBlock(['Worked on it, never wrote it up'], 30);

  // Still held-looking on the block, but the tick must now go straight through.
  const result = taskStore.updateTask(taskId, { status: 'done' });
  assert.equal(result.held, undefined, 'a block a day old has stopped owing a note');
  assert.equal(result.status, 'done');

  const swept = taskBlocks.sweep();
  assert.ok(swept.expired.some(e => e.blockId === blockId), 'the stale block must be aged out');
  const row = db.getTaskBlockRow(blockId);
  assert.equal(row.status, 'released');
  assert.match(row.release_reason, /aged out by neuro/i,
    'the reason is the only thing separating this from a close Nick made himself');
});

test('ageing out closes the BLOCK and touches no task either way', () => {
  // Closing the block is not a claim that everything in the window got done —
  // that was true under the hold and is still true. What has changed is that
  // the ticked task was ALREADY done at the moment Nick ticked it, so the
  // ageing pass has nothing left to rescue: it is bookkeeping about a window,
  // not the delayed second half of a completion.
  const { taskIds, blockId } = agedBlock(['Ticked before it went stale', 'Never touched'], 2);
  assert.equal(taskStore.updateTask(taskIds[0], { status: 'done' }).status, 'done',
    'a two-hour-old block must not hold a tick');

  // A day later, the write-up is not coming.
  const swept = taskBlocks.sweep({ now: new Date(Date.now() + 30 * 3600000) });
  assert.ok(swept.expired.some(e => e.blockId === blockId));
  assert.equal(db.getTaskRow(taskIds[0]).status, 'done', 'the tick he made must not be lost');
  assert.equal(db.getTaskRow(taskIds[1]).status, 'open', 'nobody did this one');
});

test('a write-up BEATS the clock — a stale block that was written up completes properly', () => {
  // Order matters: a note landing on a three-day-old block must still close it
  // as a completion rather than losing the race to the ageing pass.
  const { taskIds, blockId, full } = agedBlock(['Written up late'], 2);
  taskStore.updateTask(taskIds[0], { status: 'done' });
  writeUp(full);

  const swept = taskBlocks.sweep({ now: new Date(Date.now() + 72 * 3600000) });
  assert.ok(swept.completed.some(c => c.blockId === blockId), 'the write-up must win');
  assert.ok(!swept.expired.some(e => e.blockId === blockId));
  assert.equal(db.getTaskBlockRow(blockId).status, 'complete',
    'complete and released are different facts — only one of them earned its note');
});

test('a dry-run sweep ages nothing out', () => {
  const { blockId } = agedBlock(['Left alone by the dry run'], 30);
  const swept = taskBlocks.sweep({ dryRun: true });
  assert.ok(swept.expired.some(e => e.blockId === blockId), 'it must still be REPORTED');
  assert.equal(db.getTaskBlockRow(blockId).status, 'scheduled', 'but not written');
});

// ── The fixture helper itself ───────────────────────────────────────────────
//
// Pinned because it broke silently on 16 Sep 2026 and the failure landed on an
// unrelated test 1,000 lines away: the old helper clamped anything past 23:55
// back to 23:55, collapsing several fixtures onto one (date_key, start_time) and
// tripping the UNIQUE index. It fired only when the band straddled midnight, so
// the suite was green on the Pi and red on the laptop an hour later.

test('every fixture gets its own slot, at EVERY time of day', () => {
  // A test that runs at whatever o'clock the suite happens to start proves
  // nothing about the case that breaks, so this walks a whole day in 10-minute
  // steps and checks the midnight crossing from every side.
  const base = Date.UTC(2026, 8, 16, 0, 0, 0);
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    const now = base + minute * 60000;
    const seen = new Set();
    let seq = 0;
    for (let i = 0; i < 200; i++) {
      const s = slotAt(now, seq);
      seq = s.nextSeq;
      const key = `${s.dateKey} ${s.startTime}`;
      assert.ok(!seen.has(key),
        `duplicate slot ${key} at fixture ${i} when now is ${new Date(now).toISOString()}`);
      seen.add(key);
    }
  }
});

test('a fixture window never overflows midnight', () => {
  // "24:03" parses as EARLIER than its start and reads as an ancient block.
  const base = Date.UTC(2026, 8, 16, 0, 0, 0);
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    let seq = 0;
    for (let i = 0; i < 200; i++) {
      const s = slotAt(base + minute * 60000, seq);
      seq = s.nextSeq;
      assert.ok(s.endTime < '24:00', `window ended at ${s.endTime}`);
      assert.ok(s.endTime > s.startTime, `${s.startTime}..${s.endTime} is not a window`);
    }
  }
});

test('fixtures stay in the past, and inside the stale window', () => {
  // Both ends matter: a slot in the FUTURE has not been sat in and would be held
  // by the not-yet-started rule, and one older than STALE_AFTER_MS has aged out.
  // Either turns a fixture into a test of something nobody meant to test.
  const now = Date.UTC(2026, 8, 16, 14, 30, 0);
  let seq = 0;
  for (let i = 0; i < 200; i++) {
    const s = slotAt(now, seq);
    seq = s.nextSeq;
    const at = Date.parse(`${s.dateKey}T${s.startTime}:00`);
    const agoHours = (now - at) / 3600000;
    assert.ok(agoHours > 0, `fixture ${i} is in the future (${s.dateKey} ${s.startTime})`);
    assert.ok(agoHours < 24, `fixture ${i} is ${agoHours.toFixed(1)}h old — past STALE_AFTER_MS`);
  }
});
