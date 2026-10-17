'use strict';

// Repeating tasks through the REAL task store against a scratch DB: complete →
// reopened at the next fixed slot, missed slots skipped, one open copy, each
// occurrence counted, drop ends the series, Microsoft/Jira refused, un-tick.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ Before any require — database.js fixes its path on first load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-recur-'));
process.env.NEURO_DB_PATH = path.join(root, 'recur.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const taskStore = require('./task-store');
const lifecycle = require('./attention-lifecycle');

test.before(async () => { await db.init(); });

const FORTNIGHT = { kind: 'interval', every: 2, unit: 'week' };
let n = 0;
function make(extra = {}) {
  n += 1;
  return taskStore.createTask({ text: `Review the auto heating schedule ${n} ${'x'.repeat(n)}`, source: 'test', ...extra });
}
function doneRows(taskId) {
  return db.all("SELECT id, event_data FROM activity_log WHERE event_type = 'task_done'")
    .filter(r => JSON.parse(r.event_data).taskId === taskId);
}

test('a rule set at creation is stored, labelled, and anchored on the due date', () => {
  const { id, task } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  assert.deepEqual(task.recurrence, { kind: 'interval', every: 2, unit: 'week', anchor: '2026-10-31' });
  assert.equal(task.recurrenceLabel, 'Every 2 weeks');
  const shaped = taskStore.activeTodos().find(t => t.task_id === id);
  assert.equal(shaped.recurrenceLabel, 'Every 2 weeks');
  assert.equal(shaped.repeat.anchor, '2026-10-31');
});

test('FIXED SLOT: completing early reopens the SAME task at the slot after the one that was due', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const out = taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-29' });
  assert.equal(out.id, id, 'same task id — links and history stay on one row');
  assert.equal(out.status, 'open');
  assert.equal(out.due_date, '2026-11-14');
  assert.equal(out.recurred.completedDue, '2026-10-31');
  assert.equal(out.recurred.nextDue, '2026-11-14');
  assert.equal(out.recurred.notice, 'Done — next due Sat 14 Nov');
});

test('SKIP MISSED: an overdue occurrence ticked late jumps to the next FUTURE slot, one copy only', () => {
  const { id, task } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const out = taskStore.updateTask(id, { status: 'done' }, { today: '2026-11-20' });
  assert.equal(out.due_date, '2026-11-28');
  const copies = db.all('SELECT id, status FROM tasks WHERE text = ?', [task.text]);
  assert.equal(copies.length, 1, 'never a second open copy');
  assert.equal(copies[0].status, 'open');
});

test('EACH OCCURRENCE IS COUNTED: two completions leave two task_done rows (two wins)', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-31' });
  taskStore.updateTask(id, { status: 'done' }, { today: '2026-11-14' });
  const rows = doneRows(id);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id, 'distinct activity ids → distinct activity:<id> wins');
  const history = taskStore.recurrenceHistory(id);
  assert.deepEqual(history.map(h => [h.slotDue, h.nextDue]), [['2026-11-14', '2026-11-28'], ['2026-10-31', '2026-11-14']]);
});

test('a one-off task still closes for good', () => {
  const { id } = make({ due_date: '2026-10-31' });
  const out = taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-29' });
  assert.equal(out.status, 'done');
  assert.equal(out.recurred, undefined);
});

test('DROP ENDS THE SERIES', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const out = taskStore.updateTask(id, { status: 'dropped' });
  assert.equal(out.status, 'dropped');
  assert.equal(out.recurrence_json, null);
  assert.equal(out.recurrence, null);
});

test('PATCH: omitted leaves the rule, null stops it repeating, a new rule replaces it', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  assert.ok(taskStore.updateTask(id, { notes: 'hi' }).recurrence);
  const stopped = taskStore.updateTask(id, { recurrence: null });
  assert.equal(stopped.recurrence, null);
  const again = taskStore.updateTask(id, { recurrence: { kind: 'last-working-day' } });
  assert.equal(again.recurrenceLabel, 'Last working day of the month');
  assert.equal(again.recurrence.anchor, '2026-10-31');
});

test('a dateless task given a rule gets its first slot as its due date', () => {
  const { id } = make({ recurrence: { kind: 'interval', unit: 'week', anchor: '2030-01-07' } });
  assert.equal(db.getTaskRow(id).due_date, '2030-01-07');
});

test('REFUSED: a bad rule writes nothing — not even the task', () => {
  const before = db.get('SELECT COUNT(*) AS c FROM tasks').c;
  assert.throws(() => make({ due_date: '2026-10-31', recurrence: { kind: 'interval', unit: 'week', every: 99 } }), /at most 52/);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM tasks').c, before);
  const { id } = make({ due_date: '2026-10-31' });
  assert.throws(() => taskStore.updateTask(id, { recurrence: { kind: 'weekdays', days: ['funday'] } }), /unknown day/);
  assert.equal(db.getTaskRow(id).recurrence_json, null);
});

test('REFUSED: a Microsoft-linked task cannot repeat in NEURO', () => {
  assert.throws(() => make({ ms_id: 'ms-abc', recurrence: FORTNIGHT, due_date: '2026-10-31' }), /Microsoft/);
  const { id } = make({ ms_id: 'ms-def', due_date: '2026-10-31' });
  assert.throws(() => taskStore.updateTask(id, { recurrence: FORTNIGHT }), /Microsoft/);
});

test('REFUSED: a repeating task cannot be linked to Microsoft afterwards', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const r = require('./task-dedupe').linkPair(id, 'ms-later');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'task_repeats');
  assert.equal(db.getTaskRow(id).ms_id, null);
});

test('REFUSED: a Jira-owned task cannot repeat', () => {
  const { id } = make({ due_date: '2026-10-31' });
  db.setState('jira_task_links', JSON.stringify({ 'NT-9999': id }));
  try {
    assert.throws(() => taskStore.updateTask(id, { recurrence: FORTNIGHT }), /NT-9999/);
  } finally {
    db.setState('jira_task_links', JSON.stringify({}));
  }
});

test('a deferral made against THIS occurrence does not suppress the next one', () => {
  const { id, task } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const key = lifecycle.dedupeKeyFor({ type: 'todo', title: task.text });
  const at = new Date().toISOString();
  db.insertAttentionRecord({
    id: `att_test_${id}`, dedupeKey: key, type: 'todo', state: 'deferred', title: task.text,
    firstSeenAt: at, lastSeenAt: at, stateChangedAt: at,
  });
  taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-31' });
  const rec = db.getAttentionRecord(`att_test_${id}`);
  assert.equal(rec.state, 'resolved');
  assert.equal(rec.resolution, 'occurrence-done');
});

test('a block holding the occurrence keeps no tick on the reopened task (its write-up cannot complete the next one)', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const blockId = db.createTaskBlockRow({
    date_key: '2026-10-31', start_time: '10:00', end_time: '10:30', minutes: 30,
    note_path: 'Tasks/Blocks/test.md', status: 'scheduled',
  });
  db.addTaskBlockItem(blockId, id, 30);
  taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-31' });
  const item = db.listTaskBlockItems(blockId).find(i => i.task_id === id);
  assert.equal(Boolean(item.awaiting), false, 'tick cleared');
  assert.notEqual(db.getTaskBlockRow(blockId).status, 'awaiting-writeup');
});

test('UN-TICK: undo restores the due date and removes that occurrence\'s task_done; refused a second time', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-29' });
  assert.equal(doneRows(id).length, 1);
  const undone = taskStore.undoLastOccurrence(id);
  assert.equal(undone.ok, true);
  assert.equal(undone.task.due_date, '2026-10-31');
  assert.equal(doneRows(id).length, 0);
  const again = taskStore.undoLastOccurrence(id);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-undone');
});

test('UN-TICK is refused once the task has moved on', () => {
  const { id } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  taskStore.updateTask(id, { status: 'done' }, { today: '2026-10-29' });
  taskStore.updateTask(id, { due_date: '2026-11-20' });
  const r = taskStore.undoLastOccurrence(id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'changed');
  assert.equal(db.getTaskRow(id).due_date, '2026-11-20', 'nothing touched');
});

test('the export says a task repeats', () => {
  const { task } = make({ due_date: '2026-10-31', recurrence: FORTNIGHT });
  const text = require('./task-export').buildExport(db.listTaskRows({ status: 'open' }), taskStore.counts());
  const line = text.split('\n').find(l => l.includes(task.text));
  assert.match(line, /↻ Every 2 weeks/);
});
