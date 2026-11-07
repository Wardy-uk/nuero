// Ticking a task off — ONE helper for every surface (7 Nov 2026, audit F1/F2/F15/F17).
//
// Four copies of the owner order had grown up (NEURO Tasks, SAiM Tasks, Now's
// quick wins, the time-fit card, Life's ticks), each handling a different
// subset of what the server can answer. This is the one copy. Transport-free:
// `call(path, { method, body })` must resolve to { status, body }, the same
// shape as sendPrepared.mjs / startTask.mjs.
//
// Owner order (a NEURO task can also carry ms_id; the task store is the record
// that matters, and its /complete route pushes to Microsoft itself):
//   task_id              → POST /api/tasks/:id/complete   (or /reopen)
//   ms_id                → POST /api/todos/complete-ms
//   filePath+lineNumber  → POST /api/todos/toggle         (a vault checkbox)
//
// What happened is RETURNED, never implied. Five outcomes, and a surface must
// not paint two of them as a tick:
//   done      — closed.
//   repeated  — a repeating NEURO task: this occurrence is done, the SAME task
//               is back at its next date (`notice`, `nextDue`, `label`).
//   rolled    — a recurring Microsoft task: Microsoft closed the occurrence and
//               rolled it forward (`notice`).
//   held      — the server held the tick (`held` carries why).
//   refused   — nothing moved; `reason` is the server's own words (a Jira-linked
//               task: "NT-x closes this one").
//   error     — NEURO could not be reached / answered nonsense.

/** "NT-123 closes this one — resolve it in Jira." or null. PURE. */
export function jiraHint(item) {
  const key = item && item.jiraKey;
  return key ? `${key} closes this one — resolve the ticket in Jira and NEURO closes it on the next sync.` : null;
}

/** Which owner closes this row, or null. PURE. */
export function ownerOf(item) {
  if (!item) return null;
  if (item.task_id != null && item.task_id !== '') return { kind: 'neuro', taskId: Number(item.task_id) };
  if (item.ms_id) return { kind: 'microsoft', msId: String(item.ms_id) };
  if (item.filePath && item.lineNumber != null) return { kind: 'file', filePath: item.filePath, lineNumber: item.lineNumber };
  return null;
}

/** Can this row be ticked from a screen at all? PURE. */
export const canComplete = (item) => Boolean(ownerOf(item));

const ok2xx = (r) => r && r.status >= 200 && r.status < 300;
const errOf = (r, fallback) => (r && r.body && (r.body.error || r.body.message)) || fallback;

/**
 * @param call  ({status, body}) transport
 * @param item  a task row — task_id / ms_id / source / filePath / lineNumber / jiraKey / text
 * @param opts  { reopen } — un-tick a NEURO task (others toggle back via the same route)
 * @returns {Promise<{kind:string, text?:string, notice?:string|null, nextDue?:string|null,
 *   label?:string|null, held?:object|null, reason?:string, warning?:string|null, jiraKey?:string|null, taskId?:number}>}
 */
export async function completeTask(call, item, { reopen = false } = {}) {
  const owner = ownerOf(item);
  const text = (item && item.text) || '';
  const jiraKey = (item && item.jiraKey) || null;
  if (!call) return { kind: 'error', text, reason: 'This screen can’t tick tasks off.' };
  if (!owner) return { kind: 'refused', text, reason: 'NEURO has no handle on this task, so it can’t be ticked from here.' };
  try {
    if (owner.kind === 'neuro') {
      const r = await call(`/api/tasks/${owner.taskId}/${reopen ? 'reopen' : 'complete'}`, { method: 'POST' });
      const b = (r && r.body) || {};
      if (!ok2xx(r)) {
        // The server's words verbatim — it is the one place that knows which ticket.
        return { kind: r && r.status >= 400 && r.status < 500 ? 'refused' : 'error', text, jiraKey, taskId: owner.taskId,
          reason: errOf(r, `the server refused it (${r ? r.status : 'no answer'}) and gave no reason`) };
      }
      const held = (b.task && b.task.held) || null;
      if (held) return { kind: 'held', text, held, taskId: owner.taskId };
      if (b.recurred) {
        return { kind: 'repeated', text, taskId: owner.taskId,
          notice: b.recurred.notice || (b.recurred.nextDue ? `Done — next due ${b.recurred.nextDue}` : 'Done — it repeats'),
          nextDue: b.recurred.nextDue || null, label: b.recurred.label || null, recurred: b.recurred };
      }
      const ms = b.msPush || null;
      const warning = ms && ms.completed === false && ms.reason ? `Done here, but Microsoft didn’t take it — ${ms.reason}` : null;
      return { kind: 'done', text, taskId: owner.taskId, warning, reopened: reopen };
    }
    if (owner.kind === 'microsoft') {
      const r = await call('/api/todos/complete-ms', { method: 'POST', body: { msId: owner.msId, source: item.source || null, filePath: item.filePath, lineNumber: item.lineNumber } });
      const b = (r && r.body) || {};
      if (!ok2xx(r)) return { kind: r && r.status >= 400 && r.status < 500 ? 'refused' : 'error', text, reason: errOf(r, `Microsoft completion failed (${r ? r.status : 'no answer'})`) };
      if (b.rolled) return { kind: 'rolled', text, notice: b.notice || 'Microsoft closed this occurrence and rolled the task forward.', rolled: b.rolled };
      return { kind: 'done', text, warning: b.warning ? `Ticked here, but not in Microsoft — ${b.warning}` : null };
    }
    const r = await call('/api/todos/toggle', { method: 'POST', body: { filePath: owner.filePath, lineNumber: owner.lineNumber } });
    const b = (r && r.body) || {};
    if (!ok2xx(r)) return { kind: r && r.status >= 400 && r.status < 500 ? 'refused' : 'error', text, reason: errOf(r, `the vault line could not be ticked (${r ? r.status : 'no answer'})`) };
    // toggle is a toggle: if it came back open, it un-ticked — say so rather than claim done.
    if (b.status && b.status !== 'done' && !reopen) return { kind: 'refused', text, reason: 'that line was already ticked, so it has been put back open — press again if it is done' };
    return { kind: 'done', text, reopened: reopen };
  } catch (e) {
    return { kind: 'error', text, reason: (e && e.message) || 'NEURO didn’t answer, so nothing was ticked.' };
  }
}

/** Did the row actually go done (so it may be painted ticked)? PURE. */
export const wentDone = (o) => Boolean(o && o.kind === 'done');

/** One honest line for a row to show after a tick. PURE. Null for a plain done. */
export function outcomeLine(o) {
  if (!o) return null;
  switch (o.kind) {
    case 'done': return o.warning || null;
    case 'repeated': return `↻ ${o.notice}${o.label ? ` (repeats ${o.label})` : ''}`;
    case 'rolled': return `↻ ${o.notice}`;
    case 'held': return `Held — ${(o.held && (o.held.reason || o.held.say)) || 'the server held the tick'}.`;
    case 'refused': return `Not closed — ${o.reason}`;
    case 'error': return `Not ticked — ${o.reason}`;
    default: return null;
  }
}

/** The tone for that line. PURE. */
export function outcomeTone(o) {
  if (!o) return null;
  if (o.kind === 'done') return o.warning ? 'warn' : 'ok';
  if (o.kind === 'repeated' || o.kind === 'rolled') return 'info';
  if (o.kind === 'held') return 'warn';
  return 'bad';
}

/** Undo the most recent occurrence of a repeating NEURO task. → { ok, error? } */
export async function undoRepeat(call, taskId) {
  try {
    const r = await call(`/api/tasks/${Number(taskId)}/recurrence/undo`, { method: 'POST' });
    if (ok2xx(r)) return { ok: true };
    return { ok: false, error: (r && r.body && (r.body.message || r.body.error)) || `refused (${r ? r.status : 'no answer'})` };
  } catch (e) { return { ok: false, error: (e && e.message) || 'NEURO didn’t answer' }; }
}
