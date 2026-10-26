'use strict';

/**
 * Drafts (22 Oct 2026) — ONE place for every active, unfinished prepared item,
 * however it began (Nick's press, the scan, a promise card, MCP). NOT a store:
 * it reads the prepared-move store (`activeV2`: each move's newest version, not
 * deferred, declined, carried out or expired) and asks the SAME view, duty rule
 * and authority boundary the save step itself uses, so a status here is the state
 * the item will actually be in when it is opened.
 *
 * One plain status per item, and at most one action:
 *   needs-answer       "Needs your answer"       → open the exact question
 *   ready-to-save      "Ready to save"           → open the exact draft/save step
 *   ready-to-confirm   "Ready to confirm"        → open the real confirmation
 *   waiting-allowance  "Waiting for allowance"   → open the exact authority boundary
 *   held               "Held"                    → the precise reason; NO action
 * Those are the "Needs your confirmation" section. A saved item (its note written,
 * with or without a booked block) is NOT finished — it is in "Ready for you to work
 * on" (`savedWork`, below) until Nick ticks its task or abandons it.
 */

const STATUS = Object.freeze({
  'needs-answer': 'Needs your answer',
  'ready-to-save': 'Ready to save',
  'ready-to-confirm': 'Ready to confirm',
  'waiting-allowance': 'Waiting for allowance',
  held: 'Held',
});
const ORDER = ['needs-answer', 'ready-to-confirm', 'ready-to-save', 'waiting-allowance', 'held'];
const ACTION = Object.freeze({
  'needs-answer': { open: 'question', label: 'Answer the question' },
  'ready-to-save': { open: 'save', label: 'Open the draft' },
  'ready-to-confirm': { open: 'confirm', label: 'Open the confirmation' },
  'waiting-allowance': { open: 'authority', label: 'Open what SAiM may do' },
});
const HELD_DUTY = Object.freeze({
  'off-duty': 'Held until your next working morning — SAiM doesn’t carry this kind of move out outside working hours.',
  leave: 'Held while you’re on leave — it waits until you’re back.',
  unknown: 'Held — SAiM couldn’t tell whether you’re working, so it won’t act yet.',
});

/** PURE. What kind of thing this is, in Nick's words. */
function kindLabel(selected) {
  const s = selected || {};
  if (s.privateDraft) return 'Private working draft';
  if (s.kind === 'email-reply') return 'Reply draft';
  if (s.kind === 'meeting-prep') return 'Meeting prep';
  return 'Prepared note';
}

/**
 * PURE. One record's status from what the view said about it.
 *   record    the stored v2 record
 *   view      v2View's answer ({ move, held, why })
 *   boundary  the authority boundary now ({ gate, say } | null)
 */
function statusFor({ record, view, boundary = null }) {
  const s = ((record || {}).packet || {}).selected || {};
  const v = view || {};
  if (!v.move) return { status: 'held', say: `Held — it can’t be offered as it stands: ${v.why || 'it no longer passes its checks'}.` };
  if (v.held || v.move.held) return { status: 'held', say: HELD_DUTY[(v.held || {}).reason] || HELD_DUTY.unknown };
  const m = v.move;
  if (m.plan === 'ask') return { status: 'needs-answer', say: ((m.ask || {}).questions || [])[0] ? m.ask.questions[0].question : 'SAiM needs an answer before it can go on.' };
  const iv = s.interview || m.interview;
  if (iv && iv.next) return { status: 'needs-answer', say: `Decision ${Math.max(1, (iv.questions || []).findIndex((q) => q.id === iv.next.id) + 1)} of ${iv.total}: ${iv.next.question}` };
  const options = m.options || [];
  if (!options.length) {
    const why = (m.notOffered || []).map((n) => `${n.label}: ${n.why}`).join('; ');
    return { status: 'held', say: `Held — ${why || 'nothing can be offered right now'}.` };
  }
  if (boundary && (boundary.gate === 'allowance' || boundary.gate === 'stop')) return { status: 'waiting-allowance', say: boundary.say };
  if (boundary) return { status: 'held', say: boundary.say }; // the server switch, today's moves used up, unreadable: nothing here can change it
  if (s.kind === 'email-reply') return { status: 'ready-to-confirm', say: 'The reply is drafted — confirming puts it in Actions for your approval code. Nothing is sent until then.' };
  return { status: 'ready-to-save', say: (options[0] && options[0].writes && options[0].writes[0]) || 'Drafted — ready for you to save.' };
}

/** PURE. The list's shape, in its fixed order. */
function shape(rows) {
  return rows
    .map((r) => ({ ...r, statusLabel: STATUS[r.status], action: ACTION[r.status] || null }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}

// ── Saved work (22 Oct 2026) ─────────────────────────────────────────────────
//
// ⚠ "Executor completed" is NOT "Nick's work completed". A saved private working
// draft — with or without a booked solo block — is PLANNED WORK. Before this, three
// rules each dropped it from Drafts the moment the save ran: the complete receipt
// (`completedMove` in activeV2), the booked block (`scheduledFor` here), and the 2h
// evidence lifetime. Traced on the live DB for tasks 350 and 358 (22 Oct 2026):
// both saved a note and booked Thursday's block, both tasks still open, both gone
// from Drafts at once. Saved work now comes from the RECEIPTS, not the active
// proposals, and stays in "Ready for you to work on" until Nick ticks (or drops)
// the task, or abandons the draft here — then it is a compact receipt in History.

const OUTCOMES = ['done', 'abandoned', 'restore'];
const VAULT_NAME = () => process.env.OBSIDIAN_VAULT_NAME || 'Nicks knowledge base';
const HISTORY_LIMIT = 20;
const LONDON_DAY = (dateKey) => {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
};

let _outReady = false;
function _ensureOutcomes(db) {
  if (_outReady) return;
  db.getDb().exec(`CREATE TABLE IF NOT EXISTS prepared_move_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, move_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('done','abandoned','restore')),
    by TEXT NOT NULL, at TEXT NOT NULL)`);
  db.getDb().exec(`CREATE TRIGGER IF NOT EXISTS prepared_move_outcomes_no_update BEFORE UPDATE ON prepared_move_outcomes BEGIN SELECT RAISE(ABORT, 'append-only'); END`);
  _outReady = true;
}
function _latestOutcome(db, moveKey) {
  try { return db.get(`SELECT outcome, by, at FROM prepared_move_outcomes WHERE move_key = ? ORDER BY id DESC LIMIT 1`, [moveKey]); } catch { return null; }
}

/** Nick abandons a saved draft (or brings it back). Nothing is deleted — not the note, not the block. */
function setOutcome({ moveKey, outcome, by = 'nick', now = Date.now(), deps = {} } = {}) {
  const db = deps.db || require('../db/database');
  if (by !== 'nick') return { ok: false, status: 403, error: 'Only Nick, in NEURO, can abandon or restore a draft.' };
  if (!OUTCOMES.includes(outcome) || outcome === 'done') return { ok: false, status: 400, error: 'outcome must be abandoned or restore — the work is "done" when you tick its task.' };
  const r = _receipt(db, moveKey);
  if (!r) return { ok: false, status: 404, error: 'No saved draft for that move.' };
  _ensureOutcomes(db);
  db.run(`INSERT INTO prepared_move_outcomes (move_key, outcome, by, at) VALUES (?,?,?,?)`, [moveKey, outcome, by, new Date(now).toISOString()]);
  return { ok: true, moveKey, outcome };
}

function _receipt(db, moveKey) {
  try { const r = JSON.parse(db.getState(`saim_move_receipt:${moveKey}`) || 'null'); return r && r.target !== 'sandbox' ? r : null; } catch { return null; }
}

function _eventId(db, moveKey) {
  try {
    const row = db.get(`SELECT result_json FROM external_write_ledger WHERE writer = 'saim.move.calendar-block' AND idempotency_key = ? ORDER BY id DESC LIMIT 1`, [`${moveKey}:calendar`]);
    const j = row && JSON.parse(row.result_json || 'null');
    return (j && (j.id || j.eventId)) || null;
  } catch { return null; }
}

/** PURE. "Draft saved · scheduled for Thursday 23 October, 10:30" (or why not). */
function workStatus({ block, saved, nowMs }) {
  const what = saved === 'unfinished' ? 'Unfinished draft saved' : 'Draft saved';
  if (!block) return `${what} · no time booked`;
  const when = `${LONDON_DAY(block.date)}, ${block.start}`;
  let endMs = NaN;
  try { endMs = require('./promise-score').londonInstant(block.date, block.end); } catch { /* unknown → not "passed" */ }
  if (Number.isFinite(endMs) && nowMs > endMs) return `${what} · the booked time (${when}) has passed — the work is still open`;
  return `${what} · scheduled for ${when}`;
}

/**
 * READ. Every live, saved prepared move (a note was written), split into work still
 * open, communication drafts, and history. Writes nothing.
 */
function savedWork({ now = Date.now(), deps = {} } = {}) {
  const db = deps.db || require('../db/database');
  const store = deps.store || require('./prepared-move-store');
  const getTask = deps.getTask || ((id) => { try { return require('./task-store').getTask(id); } catch { return null; } });
  const out = { work: [], communication: [], history: [], gaps: [] };
  let rows = [];
  try { rows = db.all(`SELECT key, value FROM agent_state WHERE key LIKE 'saim_move_receipt:saim-move:v2:%'`); } catch (e) { out.gaps.push(`SAiM couldn’t read its saved drafts (${e.message})`); return out; }
  for (const row of rows) {
    let r; try { r = JSON.parse(row.value || 'null'); } catch { continue; }
    if (!r || r.target === 'sandbox' || !r.moveKey) continue;
    const steps = r.steps || [];
    const note = steps.find((x) => x && x.step === 'note' && (x.status === 'done' || x.status === 'already-done'));
    const reply = steps.find((x) => x && x.step === 'reply' && (x.status === 'done' || x.status === 'already-done'));
    if (!note && !reply) continue; // nothing was saved: still a proposal, or a failed run (the receipt explains it)
    let rec = null; try { rec = store.get(r.recordId); } catch { rec = null; }
    const s = (rec && rec.packet && rec.packet.selected) || {};
    const title = s.title || r.moveKey;
    if (reply && !note) {
      let pa = null;
      try { pa = reply.id ? db.get(`SELECT status, updated_at FROM prepared_actions WHERE id = ?`, [reply.id]) : null; } catch { pa = null; }
      const paSay = !pa ? 'In Actions' : pa.status === 'verified' || pa.status === 'executed' ? 'Sent — read back in Sent Items' : pa.status === 'rejected' || pa.status === 'superseded' || pa.status === 'cancelled' ? `Not sent (${pa.status})` : 'In Actions — waiting for your approval code. Not sent.';
      out.communication.push({ moveKey: r.moveKey, recordId: r.recordId, kindLabel: 'Reply draft', title, actionId: reply.id || null, status: paSay, savedAt: r.at || null });
      continue;
    }
    const taskId = s.source && s.source.taskId != null ? Number(s.source.taskId) : null;
    const t = taskId ? getTask(taskId) : null;
    const cal = store.scheduledFor(r.moveKey);
    const block = cal && cal.date ? { date: cal.date, start: cal.start, end: cal.end, label: `${LONDON_DAY(cal.date)}, ${cal.start}–${cal.end}`, eventId: _eventId(db, r.moveKey) } : null;
    const path = note.target || null;
    const item = {
      moveKey: r.moveKey, recordId: r.recordId, title, kindLabel: s.privateDraft ? 'Private working draft' : 'Saved draft', privateDraft: Boolean(s.privateDraft),
      path, obsidianUrl: path ? `obsidian://open?vault=${encodeURIComponent(VAULT_NAME())}&file=${encodeURIComponent(path.replace(/\.md$/i, ''))}` : null,
      task: t ? { id: t.id, text: t.text, status: t.status } : (taskId ? { id: taskId, text: null, status: 'unknown' } : null),
      block, outlookUrl: block && block.eventId ? `https://outlook.office.com/calendar/item/${encodeURIComponent(block.eventId)}` : null,
      savedAt: r.at || null, saved: r.option === 'unfinished' ? 'unfinished' : 'saved',
    };
    const o = _latestOutcome(db, r.moveKey);
    const taskDone = t && (t.status === 'done' || t.status === 'dropped');
    if (taskDone) out.history.push({ ...item, outcome: t.status === 'done' ? 'done' : 'dropped', at: t.completed_at || t.updated_at || null, status: t.status === 'done' ? 'Done — you ticked the task' : 'The task was dropped' });
    else if (o && o.outcome === 'abandoned') out.history.push({ ...item, outcome: 'abandoned', at: o.at, status: 'You abandoned this draft — the note and any block are still there', canRestore: true });
    else out.work.push({ ...item, status: workStatus({ block, saved: item.saved, nowMs: now }) });
  }
  // UAT volunteer emails waiting for Nick's press (26 Oct 2026). Only on the live
  // path: a caller with its own db fake gets none unless it passes uatRows.
  const uatRows = deps.uatRows || (deps.db ? () => [] : () => require('./uat-volunteers').draftRows());
  try { out.communication.push(...uatRows()); } catch (e) { out.gaps.push(`SAiM couldn’t read the UAT volunteer drafts (${e.message})`); }
  const by = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
  out.work.sort((a, b) => (a.block ? `${a.block.date} ${a.block.start}` : '9999').localeCompare(b.block ? `${b.block.date} ${b.block.start}` : '9999') || by('savedAt')(a, b));
  out.communication.sort(by('savedAt'));
  out.history = out.history.sort(by('at')).slice(0, HISTORY_LIMIT);
  return out;
}

/** Read the list. Writes nothing (no record, no grant, no check stamp). */
async function list({ now = Date.now(), deps = {} } = {}) {
  const store = deps.store || require('./prepared-move-store');
  const view = deps.view || require('./prepared-move-view');
  const readDuty = deps.readDuty || ((t) => require('./prepared-move').readDuty(t));
  const brief = deps.brief || ((o) => require('./authority-budget').brief(o));
  const gaps = [];
  let active = [];
  try { active = store.activeV2({ now, limit: 50 }); } catch (e) { return { ok: false, contract: 'prepared-drafts-v1', items: [], gaps: [`SAiM couldn’t read its drafts (${e.message})`] }; }
  let duty = null;
  try { duty = await readDuty(now); } catch { duty = { onDuty: false, why: 'unknown' }; }
  let boundary = null;
  try { boundary = (brief({ now }) || {}).boundary || null; } catch { boundary = { gate: 'unreadable', say: 'SAiM couldn’t check what it’s allowed to do.' }; }
  const rows = [];
  for (const rec of active) {
    if (store.scheduledFor(rec.moveKey)) continue; // booked: not unfinished
    const s = (rec.packet || {}).selected || {};
    let v;
    try { v = await view.v2View(rec, { now, duty }); } catch (e) { v = { move: null, why: e.message }; gaps.push(`${s.title || rec.moveKey}: ${e.message}`); }
    const st = statusFor({ record: rec, view: v, boundary });
    rows.push({
      recordId: rec.id, version: rec.version, moveKey: rec.moveKey, kind: s.kind || null, kindLabel: kindLabel(s), title: s.title || rec.moveKey,
      privateDraft: Boolean(s.privateDraft), promiseRef: (s.source && s.source.promiseKey) ? `promise:${s.source.promiseKey}` : null,
      startedBy: (rec.packet || {}).firstOrigin || (rec.packet || {}).origin || null,
      updatedAt: rec.createdAt || null, ...st,
    });
  }
  const items = shape(rows);
  const saved = savedWork({ now, deps });
  return {
    ok: true, contract: 'prepared-drafts-v2', generatedAt: new Date(now).toISOString(),
    items, // = sections.confirm (kept for older clients)
    sections: { confirm: items, work: saved.work, communication: saved.communication, history: saved.history },
    counts: { ...Object.fromEntries(ORDER.map((k) => [k, rows.filter((r) => r.status === k).length])), work: saved.work.length, communication: saved.communication.length, history: saved.history.length },
    gaps: [...gaps, ...saved.gaps],
  };
}

module.exports = { STATUS, ORDER, ACTION, HELD_DUTY, kindLabel, statusFor, shape, list, savedWork, workStatus, setOutcome };
