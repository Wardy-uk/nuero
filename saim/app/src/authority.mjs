// What SAiM may do — the flow behind the authority control (20 Oct 2026).
//
// PURE apart from the `call` it is handed. Follows the server's contract
// (`saim-authority-v1`) and adds nothing of its own: every sentence on the
// screen is the server's. Granting and resuming are two presses — a preview
// that shows exactly the terms, then a confirm that spends the one-use token
// minted for those terms. Revoking and stopping are one press: reducing
// authority needs no ceremony.

const BASE = '/api/saim-authority';

/** Read the status. → { kind: 'ready', status } | { kind: 'unreadable' } */
export async function loadStatus(call) {
  let r;
  try { r = await call(`${BASE}/status`); } catch { return { kind: 'unreadable', message: 'I couldn’t reach NEURO to read what SAiM may do.' }; }
  if (!r || r.status !== 200 || !r.body || r.body.contract !== 'saim-authority-v1') {
    return { kind: 'unreadable', message: (r && r.body && r.body.error) || 'I couldn’t read what SAiM may do.' };
  }
  return { kind: 'ready', status: r.body };
}

async function post(call, route, body = {}) {
  try {
    const r = await call(`${BASE}/${route}`, { method: 'POST', body });
    return { ok: Boolean(r && r.status === 200 && r.body && r.body.ok), body: (r && r.body) || {} };
  } catch {
    return { ok: false, body: { error: 'I couldn’t reach NEURO. Nothing was changed.' } };
  }
}

/** Step 1 of granting: the exact terms, with a one-use confirmation. Grants nothing. */
export async function previewGrant(call, { blockMinutes = 30 } = {}) {
  const r = await post(call, 'grant/preview', { blockMinutes });
  return r.ok ? { kind: 'granting', preview: r.body } : { kind: 'error', message: r.body.error || 'NEURO would not prepare that allowance.' };
}

/** Step 2: grant exactly what was shown. */
export async function grant(call, preview) {
  const r = await post(call, 'grant', { confirmToken: preview.confirmToken });
  return r.ok ? { kind: 'done', message: 'Allowance given.' } : { kind: 'error', message: r.body.error || 'The allowance was not given.' };
}

export async function revoke(call) {
  const r = await post(call, 'revoke');
  return r.ok ? { kind: 'done', message: r.body.revoked ? 'Today’s allowance is taken away.' : 'There was no allowance to take away.' } : { kind: 'error', message: r.body.error || 'The allowance was not changed.' };
}

export async function stopAll(call) {
  const r = await post(call, 'stop');
  return r.ok ? { kind: 'done', message: 'All SAiM actions are stopped.' } : { kind: 'error', message: r.body.error || 'SAiM’s actions could not be stopped — try again.' };
}

export async function previewResume(call) {
  const r = await post(call, 'resume/preview');
  return r.ok ? { kind: 'resuming', preview: r.body } : { kind: 'error', message: r.body.error || 'NEURO would not prepare that.' };
}

export async function resume(call, preview) {
  const r = await post(call, 'resume', { confirmToken: preview.confirmToken });
  return r.ok ? { kind: 'done', message: 'SAiM’s actions can run again, within today’s allowance.' } : { kind: 'error', message: r.body.error || 'Nothing was changed.' };
}

/** PURE. The step a receipt line reads as — the receipt's own words only. */
export function receiptSummary(rc) {
  const step = (s) => (s.step === 'calendar' ? 'Calendar block' : s.step === 'note' ? 'Note' : s.step);
  return (rc.steps || []).map((s) => `${step(s)}: ${s.status === 'done' ? 'done and read back' : s.status === 'already-done' ? 'already in place' : s.status === 'stopped' ? 'not attempted (stopped)' : s.status === 'failed' ? 'not saved' : s.status === 'removed-since' ? 'since removed' : s.status}`);
}
