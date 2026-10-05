'use strict';

/**
 * What Nick can DO to a commitment from the Commitments screen (5 Oct 2026):
 * close it (done / not owed) and say who it is with.
 *
 * A world-model commitment is a projection — it is never written here. Each
 * action goes to the record that OWNS it, and the world model follows through
 * the producers' existing hooks:
 *
 *   meeting-waiting-on  → the waiting_on row (done / dropped; person_full)
 *   neuro-task, meeting-task, declared-commitment → the NEURO task (done / dropped)
 *   management-log      → refused: it is closed in Weekly risk, where the log lives
 *
 * "Not owed" is `dropped`, never `done`: closing a misparse as completed would
 * put work in the wins ledger nobody did.
 */

const db = require('../db/database');

const OUTCOMES = Object.freeze(['done', 'not-owed']);

function _row(id) {
  return id ? db.get('SELECT commitment_id, source_kind, source_ref, related_task_id, status, direction FROM wm_commitments WHERE commitment_id = ?', [id]) : null;
}

const waitingKey = (ref) => (typeof ref === 'string' && ref.startsWith('waiting-on:') ? ref.slice('waiting-on:'.length) : null);

function _taskId(r) {
  if (r.related_task_id) return r.related_task_id;
  const m = /^neuro-task:(\d+)$/.exec(String(r.source_ref || ''));
  return m ? Number(m[1]) : null;
}

/** Close a commitment at its owner. Returns { ok, owner, ... } or { ok:false, status, error }. */
function resolve(id, outcome) {
  if (!OUTCOMES.includes(outcome)) return { ok: false, status: 400, error: `outcome must be one of ${OUTCOMES.join(', ')}` };
  const r = _row(id);
  if (!r) return { ok: false, status: 404, error: 'no such commitment' };
  if (r.status !== 'open') return { ok: false, status: 409, error: `already ${r.status}` };

  if (r.source_kind === 'meeting-waiting-on') {
    const key = waitingKey(r.source_ref);
    const item = key ? require('./waiting-on').resolve(key, outcome === 'done' ? 'done' : 'dropped') : null;
    if (!item) return { ok: false, status: 404, error: 'the waiting-on row behind this commitment is gone' };
    return { ok: true, owner: 'waiting-on', status: item.status };
  }
  if (r.source_kind === 'management-log') {
    return { ok: false, status: 409, error: 'this comes from the management log — close it in Weekly risk' };
  }
  const taskId = _taskId(r);
  if (!taskId) return { ok: false, status: 409, error: `no task behind this commitment (${r.source_kind})` };
  let task;
  // task-store refuses some ticks by rule (a Jira-owned task closes in Jira) —
  // that is an answer with a reason, not a fault.
  try { task = require('./task-store').updateTask(taskId, { status: outcome === 'done' ? 'done' : 'dropped' }); }
  catch (e) { return { ok: false, status: 409, error: e.message }; }
  if (!task) return { ok: false, status: 404, error: `task ${taskId} is gone` };
  return { ok: true, owner: 'task', taskId, status: task.status };
}

/**
 * Say who owes a waiting-on commitment. The name must be a People note
 * (exactly, case-insensitively) — a typed name nobody has a note for would
 * stay unresolved and look as though it worked.
 */
function setPromisor(id, name) {
  const r = _row(id);
  if (!r) return { ok: false, status: 404, error: 'no such commitment' };
  if (r.source_kind !== 'meeting-waiting-on') return { ok: false, status: 409, error: 'only a commitment owed to you has a "who" to set here' };
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return { ok: false, status: 400, error: 'a name is required' };
  const person = require('./world-model').listPeople().find((p) => String(p.displayName || '').toLowerCase() === clean.toLowerCase());
  if (!person) return { ok: false, status: 400, error: `no People note called "${clean}"` };
  const key = waitingKey(r.source_ref);
  const wo = require('./waiting-on');
  const item = key ? wo.setPersonFull(key, person.displayName) : null;
  if (!item) return { ok: false, status: 404, error: 'the waiting-on row behind this commitment is gone' };
  return { ok: true, personId: person.personId, name: person.displayName };
}

module.exports = { OUTCOMES, resolve, setPromisor, _internals: { waitingKey } };
