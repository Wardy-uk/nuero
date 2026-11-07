// "Turn on and send" (7 Nov 2026). A send that is blocked ONLY because its
// switch is off used to answer "Settings → Switches → …", which at the moment
// Nick has decided to send meant: navigate, find the switch, come back, find the
// draft, press again. Now the same press offers to flip that one switch and
// send. Transport-free like sendPrepared.mjs: `call(path, {method, body})`
// resolves to { status, body }.
//
// ⚠ Only the switch FOR THIS KIND is touched (email vs calendar are separate on
//   purpose — feature-flags), and only on Nick's press. The server still refuses
//   machine callers on both routes; nothing here decides who may send.

import { sendPrepared } from './sendPrepared.mjs';

const CALENDAR = /^(create|reschedule|cancel)_calendar_event$/;

export const SWITCH_LABEL = Object.freeze({
  governed_execution: 'Send approved emails',
  governed_calendar: 'Send approved calendar changes',
});

/** Which switch governs this action. PURE. */
export function switchFor(action) {
  return action && CALENDAR.test(String(action.actionType || '')) ? 'governed_calendar' : 'governed_execution';
}

/**
 * PURE. Is sending this action blocked by its switch? `sending` is the
 * `/api/prepared-actions` answer ({ enabled, calendar }); unknown (null) is
 * never a block — the server answers on the press instead.
 */
export function gateOf(sending, action) {
  if (!action || action.executes === false || !sending) return null;
  const key = switchFor(action);
  const on = key === 'governed_calendar' ? sending.calendar : sending.enabled;
  if (on !== false) return null;
  return { key, label: SWITCH_LABEL[key] };
}

/** PURE. Did a send come back refused because the switch is off? */
export function isSwitchedOff(r) {
  return Boolean(r && !r.ok && /is switched off/i.test(String(r.error || '')));
}

export async function turnOnSwitch(call, key) {
  if (!SWITCH_LABEL[key]) return { ok: false, error: 'unknown switch' };
  let r;
  try {
    r = await call(`/api/feature-flags/${encodeURIComponent(key)}`, { method: 'POST', body: { enabled: true } });
  } catch (e) { return { ok: false, error: e.message || 'NEURO could not be reached' }; }
  const b = (r && r.body) || {};
  if (r && r.status === 200 && b.ok !== false) return { ok: true };
  return { ok: false, error: b.error || `HTTP ${r && r.status}` };
}

/** Flip this action's switch on, then send it — the same one-press send. */
export async function turnOnAndSend(call, action, opts = {}) {
  const t = await turnOnSwitch(call, switchFor(action));
  if (!t.ok) return { ok: false, error: `“${SWITCH_LABEL[switchFor(action)]}” could not be turned on — ${t.error}. Nothing was sent.` };
  return sendPrepared(call, action, opts);
}

/** The switch state, as the queue route reports it. Null when unreadable. */
export async function loadSending(call) {
  try {
    const r = await call('/api/prepared-actions?limit=1');
    return r && r.status === 200 && r.body && r.body.ok ? (r.body.sending || null) : null;
  } catch { return null; }
}
