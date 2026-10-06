'use strict';

/**
 * Escalating a Jira ticket through NOVA — the ONE implementation (Build 13L).
 *
 * Two doors reach it: the Escalation form (`POST /api/escalation`) and the
 * legacy approval queue's `escalate_ticket` card (queued from chat). Before
 * Build 13 each called `nova.escalate` itself with no record, no duplicate
 * guard and no readback; the form also accepted the machine API token.
 *
 * Detection is not action: `jira.syncEscalations` and the escalation feed only
 * READ. This file is the only NEURO code that changes a ticket.
 *
 * Writer `nova.escalate` in external-writes.js (A3, human-only). Callers must
 * already have refused a machine client.
 */

const nova = require('./nova-client');
const ext = require('./external-writes');

const READBACK_WINDOW_MS = 2 * 60 * 1000;

/**
 * @returns {Promise<{ok, outcome, result?, ledger, duplicate?, blocked?, error?, note?}>}
 *   outcome: confirmed | applied-unverified | duplicate | blocked | failed | uncertain | refused
 */
async function escalate({ ticketKey, reasonCode, neededBy = null, notes = null }, { now = Date.now, deps = {} } = {}) {
  const client = deps.nova || nova;
  const key = String(ticketKey || '').trim().toUpperCase();
  if (!key) return { ok: false, outcome: 'refused', error: 'ticket key is required' };
  if (!reasonCode) return { ok: false, outcome: 'refused', error: 'reason code is required' };
  const request = { ticketKey: key, reasonCode, neededBy: neededBy || null, notes: notes || null };
  const idem = `escalate:${key}:${reasonCode}:${ext.localDate(now())}`;
  const claim = ext.begin({ writer: 'nova.escalate', key: idem, target: key, request, initiatedBy: 'nick', now: now() });
  if (!claim.ok) {
    if (claim.duplicate) return { ok: true, outcome: 'duplicate', duplicate: true, result: claim.entry.result, ledger: claim.entry,
      note: `${key} was already escalated for this reason today — not repeated.` };
    if (claim.blocked) return { ok: false, outcome: 'blocked', blocked: true, ledger: claim.entry,
      error: `The last escalation of ${key} for this reason has an unknown outcome. Check the ticket, then resolve it before escalating again.` };
    return { ok: false, outcome: 'refused', error: claim.why };
  }
  const startedAt = now();
  let result;
  try {
    result = await client.escalate(request);
  } catch (e) {
    const status = ext.classifyError(e);
    const ledger = ext.settle(claim.entry.id, { status, result: { error: e.message }, now: now() });
    return { ok: false, outcome: status, ledger, error: e.message,
      note: status === 'uncertain' ? 'NOVA may or may not have applied it — check the ticket before trying again.' : 'NOVA refused it; nothing was changed.' };
  }
  let readback = 'unreadable';
  try {
    const t = await client.getTicket(key);
    const fresh = (t.comments || []).some((c) => c.jsdPublic === false && Date.parse(c.created) >= startedAt - READBACK_WINDOW_MS);
    readback = fresh ? 'internal comment present' : 'no new internal comment found';
  } catch { /* stays unreadable */ }
  const status = readback === 'internal comment present' ? 'confirmed' : 'applied-unverified';
  const ledger = ext.settle(claim.entry.id, { status, result, readback, now: now() });
  return { ok: true, outcome: status, result, ledger };
}

module.exports = { escalate, READBACK_WINDOW_MS };
