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
 *   scheduled       the solo block was WRITTEN and read back (store.scheduledFor)
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
 * PURE (given the store's reads). ONE prepared-move record as the promise card
 * shows it — the shared contract (26 Oct 2026): the card reads it off Now, and
 * /prepare and /answer return the SAME object as `promiseMove`, so the desktop
 * and the phone render one interpretation of one response.
 *   → { state, ref, moveKey, recordId, version, say, question?, interview?, destinationSay?, ... } | null
 */
function stateOf(rec, { now = Date.now(), store, extra = {}, ref, moveKey }) {
  const s = rec.packet.selected;
  const booked = store.scheduledFor(moveKey);
  const dest = (s.deliverable || {}).destination || null;
  // Never a claim that something is saved or where — only where it WILL go when Nick chooses to save it.
  const destinationSay = s.privateDraft && s.plan === 'draft'
    ? `Not saved yet. When you choose to save it, this draft will go in ${dest && dest.project ? `the ${dest.project} project` : 'Working drafts'}.`
    : null;
  if (store.completedMove(moveKey)) return { ...extra, state: booked ? 'scheduled' : 'done', ref, moveKey, recordId: rec.id, version: rec.version, scheduled: booked, say: booked ? scheduledSay(booked) : 'Carried out — every change was read back.' };
  const sup = store.suppression(moveKey, now);
  if (sup) return { ...extra, state: sup.response, ref, moveKey, recordId: rec.id, version: rec.version, say: sup.say };
  if (!(Date.parse(rec.evidenceExpiresAt) > now)) return null;
  if (s.plan === 'ask') {
    const q = ((s.ask || {}).questions || [])[0] || null;
    return { ...extra, state: 'ask', ref, moveKey, recordId: rec.id, version: rec.version, question: q, headline: s.headline, say: q ? q.question : s.headline };
  }
  const iv = s.interview || null;
  const ivView = iv ? {
    done: iv.done, total: iv.total, open: iv.open,
    n: iv.next ? iv.questions.findIndex((x) => x.id === iv.next.id) + 1 : null,
    said: iv.questions.filter((q) => q.state === 'answered').map((q) => ({ id: q.id, decision: q.decision, answer: q.answer })),
    parked: iv.questions.filter((q) => q.state === 'parked').map((q) => ({ id: q.id, decision: q.decision })),
  } : null;
  // A legacy private draft (before 31 Oct 2026) still being worked through: the ONE next question, answerable or parkable.
  if (s.plan === 'draft' && iv && iv.next) {
    const q = iv.next;
    return { ...extra, state: 'interview', ref, moveKey, recordId: rec.id, version: rec.version, headline: s.headline,
      question: { id: q.id, question: q.question, why: q.why || null, choices: [], canPark: true },
      interview: ivView, destinationSay,
      say: `Decision ${ivView.n} of ${iv.total}: ${q.question}` };
  }
  if (booked) return { ...extra, state: 'scheduled', ref, moveKey, recordId: rec.id, version: rec.version, scheduled: booked, say: scheduledSay(booked) };
  if (store.needsBlock(rec)) {
    const slot = ((s.decision || {}).slots || [])[0] || {};
    return { ...extra, state: 'needs-decision', ref, moveKey, recordId: rec.id, version: rec.version, headline: s.headline, interview: ivView, destinationSay,
      say: iv ? `Every decision is answered or parked — it’s ready to save${slot.date ? ` and protect the time (I’d suggest ${dayShort(slot.date)}, ${slot.start}–${slot.end}; nothing is booked yet)` : ''}.`
        : `Prepared — it needs your decision before I can schedule it${slot.date ? ` (I’d suggest ${dayShort(slot.date)}, ${slot.start}–${slot.end}; nothing is booked yet)` : ''}.` };
  }
  return { ...extra, state: 'ready', ref, moveKey, recordId: rec.id, version: rec.version, headline: s.headline, interview: ivView, destinationSay, say: `${s.headline} Ready for you to confirm.` };
}

/**
 * The shared contract for a route's answer: the record a promise's move just
 * became, as the card shows it. Null for anything that is not a promise's move.
 */
function fromRecord(rec, { now = Date.now(), deps = {} } = {}) {
  const s = rec && rec.packet && rec.packet.selected;
  const key = s && s.source && s.source.promiseKey;
  if (!key) return null;
  const store = deps.store || require('./prepared-move-store');
  const extra = { owedAnswer: null, focusRef: `promise:${key}` };
  return stateOf(rec, { now, store, extra, ref: `promise:${key}`, moveKey: rec.moveKey });
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
  const said = item.owedToSaidBy && item.owedToSaidBy.text ? item.owedToSaidBy.text : null;
  // An earlier owed-to answer is never a trap: shown with a way to remove it.
  const owedAnswer = said ? { text: said, ignored: false, say: `You said it is owed to “${said}”.`, control: 'Change' } : null;
  const extra = { owedAnswer, focusRef: ref };
  const rec = store.latest(moveKey);
  const mine = rec && rec.packet && rec.packet.contract === 'prepared-move-v2' && ((rec.packet.selected || {}).source || {}).promiseKey === item.key;
  if (mine) {
    const st = stateOf(rec, { now, store, extra, ref, moveKey });
    if (st) return st;
  }
  // Nothing open for this promise: offer the one control that takes it forward.
  const p = item.preparation;
  if (p.state === 'waiting-for-Nick' && p.missing === 'owed-to') {
    return { ...extra, state: 'offer', ref, moveKey, control: OWED_CONTROL, question: owed.firstQuestion(), say: null };
  }
  if (p.state === 'needs-a-block') return { ...extra, state: 'offer', ref, moveKey, control: READY_CONTROL, question: null, say: null };
  return null;
}

/** The promises at risk, what is missing and their moves — for MCP. Read only. */
async function list({ now = Date.now() } = {}) {
  const wb = require('./promise-workbench').read({ now });
  const items = (wb.items || []).map((it) => ({
    key: it.key, ref: `promise:${it.key}`, title: it.title, owedTo: it.owedTo || null, owedToSaidBy: it.owedToSaidBy || null,
    due: it.due, preparation: it.preparation,
    move: moveFor(it, { now }),
  })).map((x) => ({
    ...x,
    // What is missing is the MOVE's question when it has one.
    missing: x.move && ['ask', 'interview'].includes(x.move.state) && x.move.question ? [{ questionId: x.move.question.id, question: x.move.question.question, recordId: x.move.recordId, version: x.move.version, canPark: Boolean(x.move.question.canPark) }]
      : x.preparation && x.preparation.missing === 'owed-to' ? [{ questionId: 'owed', question: 'Who is this owed to?' }] : [],
  }));
  return {
    contract: 'promise-moves-v1', state: wb.state, why: wb.why, items,
    how: 'To take one forward: POST /api/prepared-moves/prepare { ref }. If its move asks a question, POST /api/prepared-moves/answer { recordId, version, questionId, text } with Nick’s own words — a full name or a group. To remove an earlier owed-to answer: POST /api/prepared-moves/prepare { ref, withdraw: "owed" }. SAiM never guesses who it is owed to, and nothing is saved, sent or booked without Nick’s confirmation in SAiM.',
  };
}

module.exports = { OWED_CONTROL, READY_CONTROL, stateOf, fromRecord, moveFor, list, scheduledSay };
