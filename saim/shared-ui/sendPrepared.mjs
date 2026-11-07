// One press sends a prepared action, on ANY attended surface (7 Nov 2026).
//
// The same flow as the desktop's frontend/src/directAction.js — a one-use
// intent grant bound to the action's version and payload hash, then spend it —
// but transport-free, so the SAiM phone app, the desktop and shared components
// all use ONE copy. `call(path, { method, body })` must resolve to
// { status, body } (desktopCall / saim apiCall shape).
//
// Nick, 24 Oct 2026: "if I click send or any other action, I want it to do it
// there and then." The server still refuses machine callers and checks the
// grant; nothing here decides who may send.

let _session = null;
function sessionId() {
  if (_session) return _session;
  try {
    let s = sessionStorage.getItem('neuro_ui_session');
    if (!s) {
      s = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('neuro_ui_session', s);
    }
    _session = s;
  } catch {
    _session = `nosession${Date.now()}`;
  }
  return _session;
}

/**
 * @param {(path:string, opts:{method:string, body?:object}) => Promise<{status:number, body:any}>} call
 * @param {{actionId:string, version?:number, payloadHash:string}} action
 * @param {{surface?:string}} [opts]
 * @returns {Promise<{ok:boolean, executed?:boolean, status?:string, needsConfirm?:boolean, error?:string, action?:object}>}
 */
// ⚠ `surface` must be one intent-grants.SURFACES accepts: 'neuro-web' (every
// browser surface, the SAiM phone PWA included), 'neuro-ios', or 'saim-kiosk'
// (only with the kiosk's own token). Anything else is refused 400.
export async function sendPrepared(call, action, { surface = 'neuro-web' } = {}) {
  if (!action || !action.actionId || !action.payloadHash) {
    return { ok: false, error: 'Nothing to send — the draft was not prepared.' };
  }
  const id = encodeURIComponent(action.actionId);
  let g;
  try {
    g = await call(`/api/prepared-actions/${id}/intent-grant`, {
      method: 'POST',
      body: { version: action.version || 1, payloadHash: action.payloadHash, surface, sessionId: sessionId() },
    });
  } catch (e) { return { ok: false, error: e.message || 'NEURO could not be reached' }; }
  const grant = (g && g.body) || {};
  if (!grant.ok) return { ok: false, needsConfirm: !!grant.needsConfirm, error: grant.error || `HTTP ${g && g.status}` };
  let x;
  try {
    x = await call(`/api/prepared-actions/${id}/execute-direct`, {
      method: 'POST', body: { grantId: grant.grantId, payloadHash: action.payloadHash },
    });
  } catch (e) { return { ok: false, error: e.message || 'NEURO could not be reached' }; }
  const r = (x && x.body) || {};
  if (!r.ok) return { ok: false, needsConfirm: !!r.needsConfirm, error: r.error || `HTTP ${x && x.status}` };
  return { ok: true, executed: !!r.executed, status: r.status, detail: r.detail, action: r.action };
}

/** One honest line for what happened. PURE. */
export function sendOutcome(r) {
  if (!r) return { tone: 'bad', text: 'Could not send.' };
  if (r.needsConfirm) return { tone: 'warn', text: 'It changed since you saw it — press again to send this version.' };
  if (!r.ok) return { tone: 'bad', text: `Not sent — ${r.error || 'unknown error'}` };
  const where = /calendar/.test(String(r.action && r.action.actionType || '')) ? 'your calendar' : 'Sent Items';
  if (r.status === 'verified') return { tone: 'ok', text: `Sent — checked in ${where}.` };
  if (r.status === 'executed') return { tone: 'ok', text: `Sent — confirming it in ${where} now.` };
  if (r.status === 'execution_uncertain') return { tone: 'warn', text: 'Not sure it went — NEURO will not resend, and will check and tell you.' };
  if (r.status === 'approved' || r.status === 'recorded') return { tone: 'ok', text: 'Done.' };
  return { tone: 'bad', text: `Not sent (${r.status || 'unknown'}). ${r.detail || ''}`.trim() };
}
