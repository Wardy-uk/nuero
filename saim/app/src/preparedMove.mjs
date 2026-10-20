// SAiM's prepared move — the flow behind the approval surface (19 Oct 2026).
//
// PURE apart from the `call` it is handed, so tests drive it with fake answers.
// It follows the server's contract and adds nothing of its own:
//   GET  /api/prepared-moves/current  — read only; stores and mints nothing
//   POST /api/prepared-moves/request  — only on Nick's explicit click
//   POST /api/prepared-moves/confirm  — only on Nick's explicit click
//
// ⚠ Nothing here claims an outcome the server did not return. A receipt is
//   rendered from the receipt; a refusal from the refusal; a failed read shows
//   NOTHING (the surface stays as it was) rather than a broken or guessed panel.

const BASE = '/api/prepared-moves';

/** Never shown; distinguishes this screen's confirmations from another tab's. */
export function newSessionId(rand = Math.random) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = 'saim_';
  for (let i = 0; i < 20; i += 1) s += abc[Math.floor(rand() * abc.length)];
  return s;
}

/**
 * The read. → { kind: 'hidden' } | { kind: 'ready', view, option }
 * Hidden covers "nothing trustworthy is prepared" AND "could not ask" — the
 * surface must not grow a broken panel, and a guessed one is worse.
 */
export async function load(call) {
  let r;
  try { r = await call(`${BASE}/current`); } catch { return { kind: 'hidden', why: 'unreachable' }; }
  if (!r || r.status !== 200 || !r.body || r.body.contract !== 'prepared-move-view-v1') return { kind: 'hidden', why: 'unreadable' };
  const view = r.body;
  // Not finished in time is NOT "nothing prepared" — the answer is unknown yet.
  if (!view.move && view.pending) return { kind: 'pending', why: 'not-ready-in-time' };
  if (!view.move) return { kind: 'hidden', why: 'nothing-prepared', reason: (view.unavailable && view.unavailable.reason) || null };
  const first = (view.move.options || [])[0];
  return { kind: 'ready', view, option: first ? first.id : null };
}

/** How long to wait before asking again after a `pending` answer — a small, bounded list. */
export const PENDING_RETRY_DELAYS_MS = Object.freeze([1500, 3000, 6000]);

/**
 * The read, asked again ONLY while the answer is `pending`, at most
 * PENDING_RETRY_DELAYS_MS.length more times. A real "nothing prepared", an
 * unreachable NEURO or an unreadable answer is final and never retried. After
 * the last retry a still-pending answer is treated as nothing to show — quietly.
 * `onState` receives every intermediate state; `alive()` lets an unmounted
 * screen stop the loop.
 */
export async function loadWithRetry(call, { delays = PENDING_RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onState = () => {}, alive = () => true } = {}) {
  let s = await load(call);
  for (let i = 0; s.kind === 'pending' && i < delays.length; i++) {
    onState(s);
    await sleep(delays[i]);
    if (!alive()) return s;
    s = await load(call);
  }
  return s.kind === 'pending' ? { kind: 'hidden', why: 'still-pending' } : s;
}

/** Nick pressed "Ask to confirm". Mints a one-use confirmation for that option. */
/**
 * PURE. The one boundary standing between SAiM and acting, as the server
 * stated it on the read (authority.boundary) — or null. A boundary means a yes
 * could not be carried out, so no confirmation is asked for.
 */
export function boundaryOf(view) {
  const b = view && view.authority && view.authority.boundary;
  return b && typeof b.say === 'string' && b.say ? { gate: b.gate || null, say: b.say } : null;
}

export async function askToConfirm(call, { view, option, sessionId }) {
  // Lock closed or no allowance: nothing is requested — no record, no
  // confirmation. The boundary is named and the way past it is offered.
  // "Used up" is left to the server: a move already begun today may still be
  // finished, and only the server knows which move that was.
  const known = boundaryOf(view);
  if (known && known.gate !== 'used') return { kind: 'boundary', view, option, boundary: known };
  let r;
  try {
    r = await call(`${BASE}/request`, { method: 'POST', body: { option, sessionId } });
  } catch (e) {
    return { kind: 'refused', view, option, message: 'I couldn’t reach NEURO to prepare the confirmation. Nothing was changed.', again: true };
  }
  const b = r.body || {};
  if (r.status === 200 && b.ok && b.grantId) {
    return { kind: 'confirming', view, option, request: b };
  }
  if (b.boundary && typeof b.boundary.say === 'string') return { kind: 'boundary', view, option, boundary: { gate: b.boundary.gate || null, say: b.boundary.say } };
  return { kind: 'refused', view, option, message: `${b.error || 'NEURO would not prepare the confirmation.'} Nothing was changed.`, again: true };
}

/** Nick pressed "Confirm". Spends the confirmation; renders whatever the server answers. */
export async function confirm(call, { view, option, request, now = Date.now() }) {
  if (!request || !request.grantId) return { kind: 'refused', view, option, message: 'There is no confirmation to use. Nothing was changed.', again: true };
  if (request.expiresAt && Date.parse(request.expiresAt) <= now) {
    return { kind: 'needs-again', view, option, message: 'That confirmation expired before it was used. Nothing was changed.' };
  }
  let r;
  try {
    r = await call(`${BASE}/confirm`, { method: 'POST', body: { recordId: request.recordId, version: request.version, option: request.option, grantId: request.grantId } });
  } catch {
    // Unknown: the request may or may not have arrived. Never "done", never "nothing happened".
    return { kind: 'unknown', view, option, message: 'I lost the connection while confirming, so I can’t tell whether anything was written. Asking again is safe: anything already done is found, not repeated.' };
  }
  const b = r.body || {};
  if (r.status === 200 && b.ok && b.receipt) return { kind: 'receipt', view, option, receipt: b.receipt };
  if (b.disabled) return { kind: 'locked', view, option, serverError: b.error || null };
  if (/expired|already been used|confirming again|changed since/i.test(b.error || '')) {
    return { kind: 'needs-again', view, option, message: `${b.error}` };
  }
  return { kind: 'refused', view, option, message: b.error || 'NEURO refused the confirmation. Nothing was changed.', again: true };
}

const STEP_NAME = { calendar: 'Calendar block', note: 'Draft note' };
const STATUS_WORDS = {
  done: 'done and read back',
  'already-done': 'already in place — not repeated',
  unverified: 'saved, but it did not read back as confirmed',
  failed: 'not saved',
  refused: 'refused before anything was written',
  'removed-since': 'made earlier and since removed — not recreated',
  stopped: 'not attempted — SAiM’s actions were stopped',
};

/** PURE. The receipt in plain lines — every word from the receipt itself. */
export function receiptLines(receipt) {
  return (receipt.steps || []).map((s) => ({
    step: STEP_NAME[s.step] || s.step,
    status: s.status === 'failed' && s.provablyNotApplied === false ? 'may not have been saved' : (STATUS_WORDS[s.status] || s.status),
    ok: s.status === 'done' || s.status === 'already-done',
    target: s.target,
    note: s.note || s.unconfirmed || s.error || null,
  }));
}

/** The production transport: the app's own auth headers, the raw status kept. */
export function makeCall({ fetchImpl, apiUrl, authHeaders }) {
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetchImpl(apiUrl(path), { method, headers: authHeaders(path), ...(body ? { body: JSON.stringify(body) } : {}) });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  };
}
