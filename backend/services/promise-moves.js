'use strict';

/**
 * A Keep my word promise as a PREPARED MOVE (24 Oct 2026). Read only.
 *
 * What the promise card offers, and what MCP clients read, about taking ONE
 * promise forward through the existing prepared-move pipeline (planner ref
 * `promise:<key>` → one project-note move for its lead task, carrying the
 * promise key). Nothing here prepares, stores or writes: pressing the card's
 * control (or an MCP /prepare) does that through routes/prepared-moves.
 *
 * States (one per promise):
 *   offer           nothing prepared yet — the control ("Tell SAiM who it is
 *                   owed to" when that is what is missing, else "Make this ready")
 *   ask             SAiM asked a question on the promise's move — the question,
 *                   with the record and version to answer it against
 *   needs-decision  drafted, and it needs Nick to choose a time before anything
 *                   is scheduled (a proposed slot is NOT a booking)
 *   ready           drafted; nothing needs booking — waiting for his confirm
 *   scheduled       the private block was WRITTEN and read back (store.scheduledFor)
 *   done            carried out (a complete receipt)
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayShort = (d) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };

const OWED_CONTROL = 'Tell SAiM who it is owed to';
const READY_CONTROL = 'Make this ready';

/** PURE. The schedule sentence for a booked block. */
function scheduledSay(b) {
  return b && b.date ? `Scheduled for ${dayShort(b.date)}, ${b.start}–${b.end} — your time to finish it is booked.` : 'Your time to finish it is booked.';
}

/**
 * The move state of one workbench item. `deps` (tests): planner, store, now.
 * → null when the promise is not one SAiM can take forward from here.
 */
function moveFor(item, { now = Date.now(), deps = {} } = {}) {
  if (!item || !item.key || !item.preparation) return null;
  const planner = deps.planner || require('./prepared-move-planner');
  const store = deps.store || require('./prepared-move-store');
  const owed = require('./promise-owed');
  const lead = item.leadTaskId || (item.taskIds || [])[0];
  if (!lead) return null;
  const ref = `promise:${item.key}`;
  const moveKey = planner.moveKeyFor('project-note', `task:${lead}`);
  const rec = store.latest(moveKey);
  const mine = rec && rec.packet && rec.packet.contract === 'prepared-move-v2' && ((rec.packet.selected || {}).source || {}).promiseKey === item.key;
  if (mine) {
    const s = rec.packet.selected;
    const booked = store.scheduledFor(moveKey);
    if (store.completedMove(moveKey)) return { state: booked ? 'scheduled' : 'done', ref, moveKey, recordId: rec.id, version: rec.version, scheduled: booked, say: booked ? scheduledSay(booked) : 'Carried out — every change was read back.' };
    const sup = store.suppression(moveKey, now);
    if (sup) return { state: sup.response, ref, moveKey, recordId: rec.id, version: rec.version, say: sup.say };
    if (Date.parse(rec.evidenceExpiresAt) > now) {
      if (s.plan === 'ask') {
        const q = ((s.ask || {}).questions || [])[0] || null;
        return { state: 'ask', ref, moveKey, recordId: rec.id, version: rec.version, question: q, headline: s.headline, say: q ? q.question : s.headline };
      }
      if (booked) return { state: 'scheduled', ref, moveKey, recordId: rec.id, version: rec.version, scheduled: booked, say: scheduledSay(booked) };
      if (store.needsBlock(rec)) {
        const slot = ((s.decision || {}).slots || [])[0] || {};
        return { state: 'needs-decision', ref, moveKey, recordId: rec.id, version: rec.version, headline: s.headline,
          say: `Prepared — it needs your decision before I can schedule it${slot.date ? ` (I’d suggest ${dayShort(slot.date)}, ${slot.start}–${slot.end}; nothing is booked yet)` : ''}. It’s on your SAiM home.` };
      }
      return { state: 'ready', ref, moveKey, recordId: rec.id, version: rec.version, headline: s.headline, say: `${s.headline} It’s on your SAiM home for you to confirm.` };
    }
  }
  // Nothing open for this promise: offer the one control that takes it forward.
  const p = item.preparation;
  if (p.state === 'waiting-for-Nick' && p.missing === 'owed-to') {
    return { state: 'offer', ref, moveKey, control: OWED_CONTROL, question: owed.firstQuestion(), say: null };
  }
  if (p.state === 'needs-a-block') return { state: 'offer', ref, moveKey, control: READY_CONTROL, question: null, say: null };
  return null;
}

/** The promises at risk, what is missing and their moves — for MCP. Read only. */
async function list({ now = Date.now() } = {}) {
  const wb = require('./promise-workbench').read({ now });
  const items = (wb.items || []).map((it) => ({
    key: it.key, ref: `promise:${it.key}`, title: it.title, owedTo: it.owedTo || null, owedToSaidBy: it.owedToSaidBy || null,
    due: it.due, preparation: it.preparation,
    missing: it.preparation && it.preparation.missing === 'owed-to' ? [{ questionId: 'owed', question: 'Who is this owed to?' }] : [],
    move: moveFor(it, { now }),
  }));
  return {
    contract: 'promise-moves-v1', state: wb.state, why: wb.why, items,
    how: 'To take one forward: POST /api/prepared-moves/prepare { ref }. If its move asks a question, POST /api/prepared-moves/answer { recordId, version, questionId, text } with Nick’s own words — a full name or a group. SAiM never guesses who it is owed to, and nothing is sent or booked without Nick’s confirmation in SAiM.',
  };
}

module.exports = { OWED_CONTROL, READY_CONTROL, moveFor, list, scheduledSay };
