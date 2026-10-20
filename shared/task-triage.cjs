'use strict';

/**
 * What a task is still missing before it is triaged — PURE, one rule for the
 * server and every screen (20 Oct 2026).
 *
 * Nick's ask: "allow me to run through all tickets that haven't been
 * classified, prioritised, not estimated etc." His fields (his call, 20 Oct):
 * MoSCoW (a GUESS counts as missing — confirming it is the decision), priority,
 * estimate, due date and origin.
 *
 * ⚠ "NONE" IS A DECISION, NOT A GAP. Plenty of tasks genuinely have no due
 * date, and without a way to say so they would sit in triage for ever, which
 * is how a queue stops being opened. So every field except MoSCoW can be
 * answered "none", stored in `triageNone`, and a field in that list is not
 * missing. MoSCoW has no "none" — "Won't" IS the answer to "does this matter".
 *
 * ⚠ The row shape is the one `/api/todos` builds BEFORE `decorateTask` runs.
 * decorateTask overwrites `moscow` with the classifier's reading, so a row read
 * after it never looks un-rated — the reason the server stamps `triage` on the
 * row before decoration rather than leaving each client to work it out.
 */

const FIELDS = ['moscow', 'priority', 'estimate', 'due', 'origin'];
const NONE_ALLOWED = ['priority', 'estimate', 'due', 'origin'];

/** A stored none-list, cleaned: known, none-able fields only, no repeats. */
function normNone(value) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = list.split(','); }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const f = String(v || '').trim();
    if (NONE_ALLOWED.includes(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * The fields this row still needs a decision on, in FIELDS order.
 * Expects: moscow (raw, undecorated), moscowProposed, taskPriority,
 * estimateMinutes, due_date, origin, originProposed, triageNone.
 */
function missingFields(row) {
  if (!row) return [];
  const none = normNone(row.triageNone);
  const missing = [];
  if (!row.moscow || row.moscowProposed) missing.push('moscow');
  if (row.taskPriority == null && !none.includes('priority')) missing.push('priority');
  if (row.estimateMinutes == null && !none.includes('estimate')) missing.push('estimate');
  if (!row.due_date && !none.includes('due')) missing.push('due');
  if ((!row.origin || row.originProposed) && !none.includes('origin')) missing.push('origin');
  return missing;
}

/**
 * Whether a row can be triaged at all: NEURO owns it (task_id) or Microsoft
 * does (ms_id). A daily-note line has nowhere to hold the answers.
 */
function triageable(row) {
  return Boolean(row && !row.done && (row.task_id || row.ms_id));
}

/**
 * Once a field has a value it is no longer "none" — the list keeps only the
 * fields still answered "none". `values` uses the same field names as FIELDS.
 */
function pruneNone(none, values) {
  return normNone(none).filter((f) => values[f] == null);
}

module.exports = { FIELDS, NONE_ALLOWED, normNone, missingFields, triageable, pruneNone };
