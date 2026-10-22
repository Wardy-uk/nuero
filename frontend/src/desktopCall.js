import { apiFetch } from './api';

// The prepared-move client's `call` shape ({status, body}) over NEURO's own
// authenticated fetch, so the shared component talks to the routes it already uses.
export async function desktopCall(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}
