// Keep my word — the phone and Alt's call to the ONE existing door that
// PREPARES a promise's governed delivery note (21 Oct 2026). It never sends,
// approves or confirms anything: the draft waits in Actions for Nick's
// approval code. A refusal comes back WHOLE (apiFetch truncates bodies, and the
// employment routing sentence must not be cut), so the thread can show the
// server's own reason.
import { apiUrl, authHeaders } from './api';

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
