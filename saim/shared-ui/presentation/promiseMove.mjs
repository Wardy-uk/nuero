// Keep my word — taking a held promise forward as a prepared move (24 Oct 2026).
//
// PURE. The shell does the network (`onPromiseMove(op)` → the route's JSON,
// with ok:false on a refusal); this turns that answer into what the card
// shows. It decides nothing: the server says what is missing, what was
// prepared and what happens next.
//
//   op = { action: 'prepare', ref }                                    → POST /api/prepared-moves/prepare
//   op = { action: 'answer', recordId, version, questionId, text }    → POST /api/prepared-moves/answer
//
// → { kind: 'ask', question, recordId, version, headline }
//   { kind: 'prepared', say }        a draft is ready — on the SAiM home
//   { kind: 'handoff', say }         a message to one person: the delivery note path
//   { kind: 'refused', message, keep }  keep = the answer was NOT saved; leave it in the box

export function promiseMoveResult(body, { answering = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (!b.ok) {
    const saved = answering && b.answered === true;
    return { kind: 'refused', message: `${b.error || 'NEURO refused that.'}${answering ? (saved ? ' Your answer was saved.' : ' Your answer was not saved — it is still in the box.') : ' Nothing was changed.'}`, keep: answering && !saved };
  }
  if (b.outcome === 'handoff') return { kind: 'handoff', say: b.say || 'SAiM can draft the delivery note for your approval. Nothing is sent.' };
  const m = b.move;
  if (m && m.plan === 'ask' && m.ask && (m.ask.questions || []).length) {
    const q = m.ask.questions[0];
    return { kind: 'ask', question: { id: q.id, question: q.question, why: q.why || null, choices: q.choices || [] }, recordId: m.recordId, version: m.recordVersion, headline: (m.prepared && m.prepared.headline) || null };
  }
  if (m) return { kind: 'prepared', say: `${(m.prepared && m.prepared.headline) || 'It’s prepared.'} It’s on your SAiM home — review it there; nothing is saved, booked or sent until you confirm.` };
  return { kind: 'prepared', say: b.say || 'Nothing more to prepare for that right now.' };
}
