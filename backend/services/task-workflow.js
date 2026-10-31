'use strict';

/**
 * task-workflow-v1 — what the Task workflow screen reads (31 Oct 2026).
 *
 * SAiM's Keep my word card now only PRESENTS a promise and offers "Start this
 * task"; everything that used to crowd it (the prepared move and its save step,
 * the delivery note, the evidence, the task's tools) lives on one screen per
 * task. This is that screen's one read:
 *
 *   task    the task row (any task, promise or not) — or null
 *   thread  the SAME thread object keep-my-word composes (threadFrom/oneThread,
 *           delivery readiness + the prepared move) for this task's promise,
 *           even when it is not one of the workbench's top two — or null
 *
 * Read-only. It writes nothing, stamps nothing and mints nothing.
 */

const CONTRACT = 'task-workflow-v1';

/** PURE. The promise key that holds this task, from the ledger's promises. */
function promiseKeyFor(promises, taskId) {
  const id = Number(taskId);
  if (!Number.isFinite(id)) return null;
  const p = (promises || []).find((x) => x.open && (x.taskIds || []).map(Number).includes(id));
  return p ? p.key : null;
}

/** PURE. The task row as the screen shows it. */
function taskView(row) {
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    dueDate: row.due_date || null,
    moscow: row.moscow || null,
    priority: row.priority ?? null,
    estimateMinutes: row.estimate_minutes ?? null,
    domain: row.domain || null,
    source: row.source || null,
  };
}

/**
 * The thread for ONE promise key, composed as Now composes it. Returns
 * { thread, why } — thread null with a reason when the promise is not open,
 * not held, or cannot be shown.
 */
function threadFor(key, { now = Date.now(), ledger = null } = {}) {
  const led = ledger || require('./promise-ledger').read({ now });
  const proofs = require('./promise-score').readProofs();
  const workbench = require('./promise-workbench').read({ now, ledger: led, proofs: proofs.proofs, onlyKey: key });
  const item = (workbench.items || [])[0] || null;
  if (!item) return { thread: null, why: workbench.state === 'not-safe-to-prepare' ? workbench.why : 'There is no open promise NEURO can show for this.' };
  let sending = false;
  try { sending = require('./feature-flags').isEnabled('governed_execution') === true; } catch { sending = false; }
  let deliveryItems = {};
  if (item.preparation && item.preparation.state === 'needs-a-draft') {
    try { deliveryItems = Object.fromEntries(require('./promise-delivery').readiness([item.key], { ledger: led })); } catch { deliveryItems = {}; }
  }
  let move = null;
  try { move = require('./promise-moves').moveFor(item, { now }); } catch { move = null; }
  let authority = null;
  try { authority = require('./authority-budget').brief({ now }); } catch { authority = null; }
  const kmw = require('./keep-my-word');
  const thread = kmw.threadFrom({ items: [item] }, authority, { sending, items: deliveryItems }, move ? { [item.key]: move } : null);
  if (thread) delete thread.others;
  return { thread, why: null };
}

/** The screen's read. `taskId` and/or `key`; null when neither names anything. */
function read({ taskId = null, key = null, now = Date.now() } = {}) {
  const taskStore = require('./task-store');
  const id = taskId == null || taskId === '' ? null : Number(taskId);
  let row = null;
  if (id != null && Number.isFinite(id)) { try { row = taskStore.getTask(id); } catch { row = null; } }
  let pkey = key || null;
  let ledger = null;
  if (!pkey && row) {
    try { ledger = require('./promise-ledger').read({ now }); pkey = promiseKeyFor(ledger.promises, row.id); } catch { pkey = null; }
  }
  let thread = null;
  let threadWhy = null;
  if (pkey) {
    try { ({ thread, why: threadWhy } = threadFor(pkey, { now, ledger })); } catch (e) { threadWhy = `NEURO couldn’t read this promise: ${e.message}`; }
  }
  if (!row && thread && thread.taskId) { try { row = taskStore.getTask(Number(thread.taskId)); } catch { row = null; } }
  if (!row && !thread) return null;
  return { contract: CONTRACT, task: taskView(row), key: pkey, thread, threadWhy };
}

module.exports = { CONTRACT, promiseKeyFor, taskView, threadFor, read };
