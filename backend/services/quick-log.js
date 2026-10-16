'use strict';

/**
 * Log done — work that was asked for and finished on the spot (16 Oct 2026).
 *
 * "Sent the revised figures to Sarah" was never a task: nobody planned it and it
 * was done before it could be written down. Nick types it, presses Log done, and
 * NEURO records ONE completed task so it counts in the wins ledger and shows in
 * completed history — without ever having been open, due, blocked or focused.
 *
 * What makes it honest rather than a fake tick:
 *   - `source: 'saim-quick-log'` and `origin_detail.kind: 'quick-log'` with
 *     `loggedAfterCompletion: true` — the record says it was LOGGED after the
 *     fact, not completed from a planned task;
 *   - it is created already `done` (completed_at = now), with no due date, no
 *     estimate, no block and no session, so nothing that reads OPEN work
 *     (activeTodos, decision-engine, SAiM's candidates) can ever see it;
 *   - `distinct`: it never folds into an existing task with the same words.
 *
 * Undo is for the MOST RECENT quick log only, for 30 seconds. It reverses that
 * entry and nothing else: the task is marked `dropped` (kept, with `undoneAt`,
 * so the audit trail survives), its `task_done` activity row is removed, and any
 * wins row already materialised from that activity row is removed. An expired,
 * repeated or mismatched undo is refused and changes nothing.
 */

const db = require('../db/database');
const taskStore = require('./task-store');

const SOURCE = 'saim-quick-log';
const UNDO_WINDOW_MS = 30 * 1000;
const MAX_TEXT = 500;
const LAST_KEY = 'quick_log_last';

function readLast() {
  try { return JSON.parse(db.getState(LAST_KEY) || 'null'); } catch { return null; }
}
function writeLast(v) { db.setState(LAST_KEY, JSON.stringify(v)); }

function log(text, { now = Date.now(), by = 'nick' } = {}) {
  const words = String(text == null ? '' : text).trim();
  if (!words) return { ok: false, reason: 'blank', message: 'Type what you did first — nothing was logged.' };
  if (words.length > MAX_TEXT) return { ok: false, reason: 'too-long', message: `Keep it under ${MAX_TEXT} characters — nothing was logged.` };

  const at = new Date(now);
  const loggedAt = at.toISOString();
  const r = taskStore.createTask({
    text: words,
    status: 'done',
    source: SOURCE,
    distinct: true,
    skipExport: false,
    origin_detail: { kind: 'quick-log', loggedAfterCompletion: true, loggedAt, by, via: 'saim-alt' },
  });
  const id = r.id;
  // completed_at = now (createTaskRow does not stamp it; this db-level write does,
  // without task-store's completion side effects — there is no block to tick).
  db.updateTaskRow(id, { status: 'done' });

  // The same event a tick writes, so the wins ledger and "Done today" count it —
  // marked as a quick log so history can tell it apart from a planned completion.
  const info = db.run(
    `INSERT INTO activity_log (event_type, event_data, hour, day_of_week, date_key) VALUES (?, ?, ?, ?, ?)`,
    ['task_done', JSON.stringify({ taskId: id, text: words, moscow: null, source: SOURCE, quickLog: true, loggedAfterCompletion: true, ageDays: 0 }),
      at.getHours(), at.getDay(), at.toISOString().split('T')[0]],
  );
  const activityId = Number(info.lastInsertRowid);
  writeLast({ taskId: id, activityId, at: now, undone: false });
  return { ok: true, taskId: id, task: taskStore.getTask(id), activityId, undoUntil: new Date(now + UNDO_WINDOW_MS).toISOString() };
}

function undo(taskId, { now = Date.now() } = {}) {
  const id = Number(taskId);
  const last = readLast();
  if (!last || last.taskId !== id) return { ok: false, reason: 'not-latest', message: 'Only the most recent quick log can be undone.' };
  if (last.undone) return { ok: false, reason: 'already-undone', message: 'That one was already undone.' };
  if (now - last.at > UNDO_WINDOW_MS) return { ok: false, reason: 'expired', message: 'Too late to undo — it stays logged. Reopen or drop it in NEURO.' };
  const row = db.getTaskRow(id);
  if (!row || row.source !== SOURCE || row.status !== 'done') return { ok: false, reason: 'changed', message: 'That entry has changed since — nothing was undone.' };

  let detail = {};
  try { detail = JSON.parse(row.origin_detail || '{}') || {}; } catch {}
  db.updateTaskRow(id, {
    status: 'dropped',
    origin_detail: JSON.stringify({ ...detail, undoneAt: new Date(now).toISOString() }),
  });
  // Only this entry's own rows — matched by the ids recorded when it was logged.
  db.run(`DELETE FROM activity_log WHERE id = ? AND event_type = 'task_done'`, [last.activityId]);
  try { db.run('DELETE FROM wins WHERE evidence = ?', [`activity:${last.activityId}`]); } catch {}
  try { db.logActivity('quick_log_undone', { taskId: id, text: row.text }); } catch {}
  writeLast({ ...last, undone: true });
  try { taskStore.scheduleExport(); } catch {}
  return { ok: true, taskId: id };
}

module.exports = { log, undo, SOURCE, UNDO_WINDOW_MS, MAX_TEXT };
