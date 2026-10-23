'use strict';

/**
 * Held work: one count and one sentence for everything every surface says when
 * the attention gate held work back (Build Brief 002, 23 Oct 2026; D-008).
 *
 * A calm summary used to sit beside a held pool with nothing saying so: off
 * duty, five work items, two of them capacity warnings, were held back as "not
 * working", while the headline read "Quiet Friday" and the summary read
 * "Nothing needs you right now." Held work may stay held. It may not vanish
 * into an all-clear.
 *
 * PURE. No DB, no clock. Shared by attention.js, presentation-intent,
 * saim-surface, canonical-read and saim/policy so that every screen carries
 * the same count and the same words.
 *
 * Only gate drops tagged `heldFor: 'off'` count: work the duty or life read
 * kept off the screen. A deferral Nick made himself is his decision, not held
 * work. So is a meeting or a focus session; those surfaces have their own
 * headline.
 */

const URGENT = new Set(['high', 'critical']);

/**
 * Is this pool item URGENT WORK that an on-duty gate must never hide?
 * Uses existing semantics only. This invents no urgency policy.
 *
 * Counted:
 *   - a capacity card (decision-engine `collectCapacity`, always high);
 *   - the overdue-task card (`todo-overdue-top` / `-summary`) when the engine
 *     rated it high or critical.
 *
 * ⚠ AMBIGUOUS, DOCUMENTED: an overdue task that is not a plan task is rated
 *   `medium` by decision-engine, so it is NOT counted here and can still be
 *   held on duty. It is then counted and named as held, never silent.
 */
function isUrgentWork(item) {
  if (!item || typeof item !== 'object') return false;
  const urgent = URGENT.has(String(item.urgency || '').toLowerCase());
  if (!urgent) return false;
  if (item.type === 'capacity') return true;
  if (item.type === 'todo' && /^todo-overdue/.test(String(item.id || ''))) return true;
  return false;
}

/**
 * Count the held work and say it once.
 * @param {Array}  dropped  attention gate `dropped` entries
 * @param {object} opts
 * @param {number} [opts.extra=0]     held work the gate never saw (composeNow's
 *                                    held diary events, commitments, reminders)
 * @param {boolean} [opts.onDuty=false] a working day in hours, as opposed to off duty
 * @returns {{count:number, urgent:number, say:string|null}}
 */
function heldWork(dropped, { extra = 0, onDuty = false } = {}) {
  const gate = (Array.isArray(dropped) ? dropped : []).filter((d) => d && d.heldFor === 'off');
  const urgent = gate.filter((d) => URGENT.has(String(d.urgency || '').toLowerCase())).length;
  const more = Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0;
  const count = gate.length + more;
  if (!count) return { count: 0, urgent: 0, say: null };
  // Straight apostrophes: the existing "held back while you're off duty" line is
  // pinned in that form across the NEURO and iOS suites.
  const where = onDuty ? "while you don't look to be working" : "while you're off duty";
  const s = count === 1 ? '' : 's';
  const urgentPart = urgent ? (urgent === count && count > 1 ? ', all urgent' : urgent === count ? ", and it's urgent" : `, ${urgent} of them urgent`) : '';
  return { count, urgent, say: `${count} work item${s} held back ${where}${urgentPart}.` };
}

module.exports = { isUrgentWork, heldWork, URGENT };
