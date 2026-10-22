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
 * A scheduled item (its block booked) is not unfinished and is not listed.
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
  return { ok: true, contract: 'prepared-drafts-v1', generatedAt: new Date(now).toISOString(), items: shape(rows), counts: Object.fromEntries(ORDER.map((k) => [k, rows.filter((r) => r.status === k).length])), gaps };
}

module.exports = { STATUS, ORDER, ACTION, HELD_DUTY, kindLabel, statusFor, shape, list };
