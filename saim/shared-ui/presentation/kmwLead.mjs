/**
 * PURE. Is the lead card this promise's own task? Only by an id the server gave both —
 * the card's task (capacity cards carry `meta.taskId`) or its promise link
 * (`open.ref`) — never by matching titles. Shared by NEURO's Now and the SAiM
 * shells (6 Nov 2026) so the promise joins its lead card the same way everywhere.
 */
export function leadIsThePromise(card, kmw) {
  const t = kmw && kmw.thread;
  if (!card || !t) return false;
  if (card.meta && card.meta.taskId != null && t.taskId != null && Number(card.meta.taskId) === Number(t.taskId)) return true;
  return Boolean(card.open && t.key && card.open.ref === `promise:${t.key}`);
}
