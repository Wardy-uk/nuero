'use strict';

// Earned auto-filing of meeting actions (1 Nov 2026, Nick's call).
//
// Actions the transcript-processor reads out of a meeting go to the Spotted
// review queue as pending capture_todo candidates. Nick approves or rejects each.
// Once his record shows the reader is right — at least 80% of the LAST 20
// decided transcript-action candidates approved — new ones are filed straight as
// tasks, through the SAME approve path the Spotted queue uses (so fold, dedupe,
// recording memory and origin=commitment all apply), each marked "filed
// automatically" with an Undo on the task card. If the rate falls back under 80%
// it switches back to review.
//
// Rules, all pinned by tests:
//   - decided = executed (approved) or rejected. Superseded, expired and pending
//     are NOT decisions — NEURO retired them, Nick said nothing;
//   - an auto-filed one Nick drops (Undo, or dropping the task any other way)
//     within 7 days of filing counts as a REJECTION — that is the feedback that
//     can switch auto-filing off again;
//   - fewer than 20 decided = review, whatever the rate. 4/4 is not a record;
//   - the gate is computed every time from the actions table and the tasks
//     table; the only stored state is the ledger of what was auto-filed (action →
//     task, when), which those tables cannot say on their own.

const db = require('../db/database');

const WINDOW = 20;
const THRESHOLD = 0.8;
const UNDO_DAYS = 7;
const LEDGER_KEY = 'meeting_actions_autofiled';
const LEDGER_MAX = 500;
const DAY_MS = 86400000;

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC, unmarked) or ISO → ms. */
function msOf(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/**
 * The gate. PURE.
 * `decided` is newest-first: [{ verdict: 'approved'|'rejected', autoFiled? }].
 * Only the first WINDOW count.
 */
function assessGate(decided, { window = WINDOW, threshold = THRESHOLD } = {}) {
  const last = (Array.isArray(decided) ? decided : []).slice(0, window);
  const approved = last.filter((d) => d && d.verdict === 'approved').length;
  const rejected = last.filter((d) => d && d.verdict === 'rejected').length;
  const n = approved + rejected;
  const rate = n ? approved / n : null;
  const auto = n >= window && rate != null && rate >= threshold;
  const pct = Math.round(threshold * 100);
  const line = auto
    ? `Meeting actions: ${approved}/${n} approved — filed automatically while ${pct}% of the last ${window} stay approved. Undo on a task counts against it.`
    : n < window
      ? `Meeting actions: ${approved}/${n} approved — filed for review until ${pct}% of the last ${window}.`
      : `Meeting actions: ${approved}/${n} approved — under ${pct}% of the last ${window}, so they’re filed for review.`;
  return { mode: auto ? 'auto' : 'review', decided: n, approved, rejected, rate, window, threshold, line };
}

function readLedger() {
  try {
    const v = JSON.parse(db.getState(LEDGER_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function writeLedger(list) {
  db.setState(LEDGER_KEY, JSON.stringify(list.slice(-LEDGER_MAX)));
}

/**
 * The last WINDOW decided transcript-action candidates, newest first, each with
 * Nick's verdict. An auto-filed one whose task he dropped within UNDO_DAYS of
 * filing is a rejection.
 */
function readDecided({ window = WINDOW } = {}) {
  const rows = db.all(
    `SELECT id, status, resolved_at, payload FROM saim_actions
      WHERE type = 'capture_todo' AND status IN ('executed', 'rejected')
        AND json_extract(payload, '$.extractedFrom') = 'transcript-action'
      ORDER BY resolved_at DESC, id DESC LIMIT ?`,
    [window]
  );
  const ledger = new Map(readLedger().map((e) => [Number(e.actionId), e]));
  return rows.map((r) => {
    const filed = ledger.get(Number(r.id));
    if (r.status === 'rejected') return { id: r.id, verdict: 'rejected', autoFiled: Boolean(filed) };
    if (filed && filed.taskId) {
      const t = db.get('SELECT status, updated_at FROM tasks WHERE id = ?', [filed.taskId]);
      if (t && t.status === 'dropped' && msOf(t.updated_at) - msOf(filed.filedAt) <= UNDO_DAYS * DAY_MS) {
        return { id: r.id, verdict: 'rejected', autoFiled: true, via: 'task-dropped' };
      }
    }
    return { id: r.id, verdict: 'approved', autoFiled: Boolean(filed) };
  });
}

/** The live gate, never throws: an unreadable store is review. */
function state() {
  try { return assessGate(readDecided()); } catch (e) {
    return { ...assessGate([]), mode: 'review', error: e.message, line: 'Meeting actions: the approval record could not be read — filed for review.' };
  }
}

function _meetingName(sourcePath) {
  const base = String(sourcePath || '').split('/').pop().replace(/\.md$/i, '');
  return base.replace(/^\d{4}-\d{2}-\d{2}\s*[–-]\s*/, '') || base || 'a meeting';
}

/**
 * After a transcript has queued its candidates: if the gate is open, file the
 * new ones through the Spotted queue's own approve path. Returns what it did.
 * `approve` is injectable for tests; it defaults to routes/actions.approveAction.
 */
async function afterTranscript(queued, { approve = null, now = new Date() } = {}) {
  const ids = (queued && Array.isArray(queued.createdIds)) ? queued.createdIds : [];
  const gate = state();
  if (!ids.length || gate.mode !== 'auto') return { mode: gate.mode, filed: [], gate };
  const run = approve || require('../routes/actions').approveAction;
  const filed = [];
  const ledger = readLedger();
  for (const id of ids) {
    const action = db.getSaimAction(id);
    if (!action || action.status !== 'pending') continue;
    const meeting = _meetingName(action.payload && action.payload.sourcePath);
    const autoFiled = { meeting, at: now.toISOString(), actionId: id };
    // Still pending, so the payload may change — the executor copies it onto the task.
    db.updateSaimActionPayload(id, { ...action.payload, autoFiled });
    let r;
    try { r = await run(id); } catch (e) { r = { status: 500, body: { ok: false, detail: e.message } }; }
    const ok = r && r.status === 200 && r.body && r.body.ok;
    if (ok) {
      ledger.push({ actionId: id, taskId: r.body.taskId || null, filedAt: autoFiled.at, meeting });
      filed.push({ actionId: id, taskId: r.body.taskId || null });
    } else {
      console.warn(`[MeetingActionsGate] Could not file #${id}: ${(r && r.body && (r.body.detail || r.body.error)) || 'unknown'} — left for review`);
    }
  }
  if (filed.length) writeLedger(ledger);
  console.log(`[MeetingActionsGate] Filed ${filed.length} of ${ids.length} meeting action(s) automatically (${gate.approved}/${gate.decided} approved)`);
  return { mode: 'auto', filed, gate };
}

/** The ledger entry for a task, or null. */
function autoFiledFor(taskId) {
  return readLedger().find((e) => Number(e.taskId) === Number(taskId)) || null;
}

/**
 * Undo an auto-filed task: drop it. Within UNDO_DAYS of filing it is also a
 * rejection of the candidate (it counts against the gate and is remembered for
 * the recording). After that it is just a dropped task.
 */
function undo(taskId, { now = Date.now() } = {}) {
  const entry = autoFiledFor(taskId);
  if (!entry) return { ok: false, code: 404, error: 'NEURO did not file this task automatically' };
  const taskStore = require('./task-store');
  const task = taskStore.getTask(Number(taskId));
  if (!task) return { ok: false, code: 404, error: 'task not found' };
  if (task.status !== 'dropped') taskStore.updateTask(Number(taskId), { status: 'dropped' });
  const within = msOf(now) - msOf(entry.filedAt) <= UNDO_DAYS * DAY_MS;
  let counted = false;
  if (within) {
    const action = db.getSaimAction(entry.actionId);
    if (action && action.status === 'executed') {
      db.updateSaimActionStatus(action.id, 'rejected');
      try { require('./action-candidates').rememberReviewedAction(action, 'rejected'); } catch { /* memory is best-effort */ }
      counted = true;
    }
  }
  return { ok: true, taskId: Number(taskId), dropped: true, countedAgainst: counted, gate: state() };
}

module.exports = { assessGate, readDecided, state, afterTranscript, autoFiledFor, undo, WINDOW, THRESHOLD, UNDO_DAYS, LEDGER_KEY };
