import { apiUrl } from './api';

/**
 * Nick-direct confirm (9 Oct 2026). Called from the click that IS the decision
 * (Book, Move, Create): ask for a one-use intent grant for the EXACT prepared
 * action the screen holds, then spend it to make the change at once. No
 * Actions card, no approval code.
 *
 * The server decides who this is (it refuses machine callers) and binds the
 * grant to the action's version and payload hash, so a changed action, a
 * double click or a stale screen is refused with `needsConfirm` rather than
 * sent. Nothing here claims who initiated anything — the server records that.
 *
 * Returns { ok, executed, status, needsConfirm, error, action }.
 */

const SESSION_KEY = 'neuro_ui_session';

function sessionId() {
  try {
    let s = sessionStorage.getItem(SESSION_KEY);
    if (!s) {
      const b = new Uint8Array(12);
      crypto.getRandomValues(b);
      s = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(SESSION_KEY, s);
    }
    return s;
  } catch {
    return `nosession${Date.now()}`;
  }
}

async function post(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return json || { ok: false, error: `HTTP ${res.status}` };
}

export async function executeDirect(action) {
  if (!action || !action.actionId || !action.payloadHash) {
    return { ok: false, executed: false, error: 'Nothing to confirm — the action was not prepared.' };
  }
  const id = encodeURIComponent(action.actionId);
  const grant = await post(`/api/prepared-actions/${id}/intent-grant`, {
    version: action.version || 1, payloadHash: action.payloadHash, surface: 'neuro-web', sessionId: sessionId(),
  });
  if (!grant.ok) return { ok: false, executed: false, needsConfirm: !!grant.needsConfirm, error: grant.error };
  const r = await post(`/api/prepared-actions/${id}/execute-direct`, { grantId: grant.grantId, payloadHash: action.payloadHash });
  if (!r.ok) return { ok: false, executed: false, needsConfirm: !!r.needsConfirm, error: r.error };
  return { ok: true, executed: !!r.executed, status: r.status, detail: r.detail, action: r.action };
}

/** One honest line for what happened — from the status the server reported. */
export function directOutcome(r) {
  if (!r) return { tone: 'bad', text: 'Could not complete.' };
  if (r.needsConfirm) return { tone: 'warn', text: 'This action needs confirming again.' };
  if (!r.ok) return { tone: 'bad', text: `Could not complete — ${r.error || 'unknown error'}` };
  const where = /calendar/.test(String(r.action?.actionType || '')) ? 'your calendar' : 'Sent Items';
  if (r.status === 'verified') return { tone: 'ok', text: `Confirmed — checked in ${where}.` };
  if (r.status === 'executed') return { tone: 'ok', text: `Done — confirming it in ${where} now.` };
  if (r.status === 'execution_uncertain') return { tone: 'warn', text: 'Outcome uncertain — not resent. NEURO will check and say what happened.' };
  return { tone: 'bad', text: `Could not complete (${r.status || 'unknown'}). ${r.detail || ''}`.trim() };
}
