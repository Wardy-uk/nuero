// Keep my word — the phone and Alt's call to the ONE existing door that
// PREPARES a promise's governed delivery note (21 Oct 2026). It never sends,
// approves or confirms anything: the draft waits in Actions for Nick's
// approval code. A refusal comes back WHOLE (apiFetch truncates bodies, and the
// employment routing sentence must not be cut), so the thread can show the
// server's own reason.
import { apiUrl, authHeaders } from './api';
import { promiseMoveRequest } from './promiseMoveRequest.mjs';

export const deliveryPath = (key) => `/api/promises/${encodeURIComponent(key)}/prepare`;

/** → the route's JSON ({ ok, action, already } | { ok: false, error, ... }). Never throws. */
export async function prepareDelivery(key, { fetchImpl = fetch } = {}) {
  const path = deliveryPath(key);
  try {
    const res = await fetchImpl(apiUrl(path), { method: 'POST', headers: authHeaders(path, { 'Content-Type': 'application/json' }), body: '{}' });
    const body = await res.json().catch(() => null);
    if (body && typeof body === 'object') return res.ok ? body : { ...body, ok: false };
    return { ok: false, error: `NEURO answered ${res.status}, so nothing was drafted.` };
  } catch {
    return { ok: false, error: 'NEURO didn’t answer, so nothing was drafted.' };
  }
}

/**
 * Keep my word (24 Oct 2026): take a held promise forward as a prepared move —
 * only through the prepared-move routes, which store a PROPOSAL or Nick's
 * answer and nothing else. → the route's JSON (ok:false on a refusal). Never throws.
 *   { action: 'prepare', ref } | { action: 'answer', recordId, version, questionId, text }
 */
export async function promiseMove(op, { fetchImpl = fetch } = {}) {
  const req = promiseMoveRequest(op);
  if (!req) return { ok: false, error: 'That isn’t something this card can do.' };
  const { path, body } = req;
  try {
    const res = await fetchImpl(apiUrl(path), { method: 'POST', headers: authHeaders(path, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    const b = await res.json().catch(() => null);
    if (b && typeof b === 'object') return res.ok ? b : { ...b, ok: false };
    return { ok: false, error: `NEURO answered ${res.status}.` };
  } catch {
    return { ok: false, error: 'NEURO didn’t answer.' };
  }
}
