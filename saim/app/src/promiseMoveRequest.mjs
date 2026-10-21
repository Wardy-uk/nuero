// Keep my word — what a promise card's op becomes on the wire (25 Oct 2026).
// PURE, no imports: the phone (promiseDelivery.mjs) and the NEURO desktop
// (AdhdPanel) both build their request here, so the two cannot drift.

/**
 * PURE. The ONE request a card op becomes — shared by the phone and the
 * desktop so the two cannot drift. Only these four; anything else is refused.
 *   prepare  → POST /api/prepared-moves/prepare { ref }
 *   withdraw → POST /api/prepared-moves/prepare { ref, withdraw: 'owed' }  (remove an earlier answer)
 *   answer   → POST /api/prepared-moves/answer  { recordId, version, questionId, text }
 *   park     → POST /api/prepared-moves/answer  { recordId, version, questionId, park: true }
 */
export function promiseMoveRequest(op) {
  const o = op || {};
  if (o.action === 'answer') return { path: '/api/prepared-moves/answer', body: { recordId: o.recordId, version: o.version, questionId: o.questionId, text: o.text } };
  if (o.action === 'park') return { path: '/api/prepared-moves/answer', body: { recordId: o.recordId, version: o.version, questionId: o.questionId, park: true } };
  if (o.action === 'withdraw') return { path: '/api/prepared-moves/prepare', body: { ref: o.ref, withdraw: 'owed' } };
  if (o.action === 'prepare') return { path: '/api/prepared-moves/prepare', body: { ref: o.ref } };
  return null;
}
