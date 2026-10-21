// Keep my word — taking a held promise forward as a prepared move (24 Oct 2026).
//
// PURE. The shell does the network (`onPromiseMove(op)` → the route's JSON,
// with ok:false on a refusal); this turns that answer into what the card
// shows. It decides nothing: the server says what is missing, what was
// prepared and what happens next.
//
//   op = { action: 'prepare', ref }                                    → POST /api/prepared-moves/prepare
//   op = { action: 'answer', recordId, version, questionId, text }    → POST /api/prepared-moves/answer
//   op = { action: 'park', recordId, version, questionId }            → POST /api/prepared-moves/answer { park: true }
//   op = { action: 'withdraw', ref }                                   → POST /api/prepared-moves/prepare { withdraw: 'owed' }
//
// ⚠ ONE CONTRACT (26 Oct 2026). A promise's move comes back as `promiseMove` —
// the SAME object the card reads off canonical Now (promise-moves.stateOf) —
// so the desktop and the phone render one interpretation of one response:
//   → { kind: 'move', move }         the card re-renders from the move (an
//                                     interview question, the draft's state…)
//     { kind: 'handoff', say }       a message to one person: the delivery note path
//     { kind: 'refused', message, keep }  keep = the answer was NOT saved; leave it in the box
//     { kind: 'note', say }          the server's own sentence, when there is no move
//   (`ask` / `prepared` remain for an older backend that sends no promiseMove.)
//
// ⚠ There is no generic "Nothing more to prepare" any more: that sentence was
// shown over a press that had prepared nothing, because a stored record the
// view refused came back as success. An ok answer with nothing to show says so.

export function promiseMoveResult(body, { answering = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (!b.ok) {
    const saved = answering && b.answered === true;
    return { kind: 'refused', message: `${b.error || 'NEURO refused that.'}${answering ? (saved ? ' Your answer was saved.' : ' Your answer was not saved — it is still in the box.') : ' Nothing was changed.'}`, keep: answering && !saved };
  }
  if (b.promiseMove && typeof b.promiseMove === 'object' && b.promiseMove.state) return { kind: 'move', move: b.promiseMove };
  if (b.outcome === 'handoff') return { kind: 'handoff', say: b.say || 'SAiM can draft the delivery note for your approval. Nothing is sent.' };
  if (b.outcome === 'withdrawn') return { kind: 'note', say: b.say || 'Your earlier answer was removed.' };
  const m = b.move;
  if (m && m.plan === 'ask' && m.ask && (m.ask.questions || []).length) {
    const q = m.ask.questions[0];
    return { kind: 'ask', question: { id: q.id, question: q.question, why: q.why || null, choices: q.choices || [] }, recordId: m.recordId, version: m.recordVersion, headline: (m.prepared && m.prepared.headline) || null };
  }
  if (m) return { kind: 'prepared', say: `${(m.prepared && m.prepared.headline) || 'It’s prepared.'} Nothing is saved, booked or sent until you confirm.` };
  return { kind: 'note', say: b.say || 'SAiM couldn’t take this further just now. Nothing was saved, booked or sent.' };
}
