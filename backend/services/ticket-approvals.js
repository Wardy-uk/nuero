'use strict';

/**
 * Approve or decline a pending Jira Service Management approval from the
 * Escalations page (30 Oct 2026). Nick: a ticket Tier 2 rejected sits in
 * "Pending Rejection Approval (to CC)" until he answers it — "it needs to wire
 * in full to Jira so I can approve or reject it as well".
 *
 *  - The approval is READ LIVE from Jira on every press. The browser sends only
 *    the ticket key and the decision; the approval id is never taken from it, so
 *    a stale screen cannot answer an approval that has since changed.
 *  - Exactly ONE pending approval Nick can answer must exist. None, or more than
 *    one, is refused with the reason — never a guess at which one he meant.
 *  - External writer `jira.approval` (A3, human-only, ledgered): written to the
 *    ledger BEFORE the call, keyed on the approval id, so one approval is
 *    answered once, ever; an unknown outcome blocks a repeat until he checks.
 *  - Read back: the same approval must now carry the decision asked for.
 */

const ext = require('./external-writes');

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const DECISIONS = ['approve', 'decline'];
const FINAL = { approve: 'approved', decline: 'declined' };

function normaliseKey(k) {
  const key = String(k || '').trim().toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

function _deps(over = {}) {
  const jira = require('./jira');
  return {
    list: (key) => jira.fetchRequestApprovals(key),
    answer: (key, id, decision) => jira.answerRequestApproval(key, id, decision),
    now: () => Date.now(),
    ...over,
  };
}

/** PURE: which approval a press would answer, or why none. */
function pickPending(approvals) {
  const pending = (approvals || []).filter((a) => a.finalDecision === 'pending');
  if (pending.length === 0) return { why: 'There is no pending approval on this ticket — it may already have been answered.' };
  const mine = pending.filter((a) => a.canAnswer);
  if (mine.length === 0) return { why: `The pending approval${pending.length > 1 ? 's are' : ' is'} not one Jira lets you answer.` };
  if (mine.length > 1) return { why: `${mine.length} pending approvals on this ticket — answer it in Jira so the right one is chosen.` };
  return { approval: mine[0] };
}

/** What is pending on a ticket. Read only. */
async function status(rawKey, depsOver) {
  const d = _deps(depsOver);
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  let approvals;
  try { approvals = await d.list(key); } catch (e) { return { ok: false, status: 502, error: `Couldn't read the approvals on ${key}: ${e.message}` }; }
  if (approvals == null) return { ok: false, status: 503, error: 'Jira is not configured.' };
  const pick = pickPending(approvals);
  return { ok: true, key, approvals, pending: pick.approval || null, why: pick.why || null };
}

async function decide({ key: rawKey, decision, initiatedBy = 'nick' }, depsOver) {
  const d = _deps(depsOver);
  const key = normaliseKey(rawKey);
  if (!key) return { ok: false, status: 400, error: `"${rawKey}" is not a ticket key` };
  if (!DECISIONS.includes(decision)) return { ok: false, status: 400, error: 'decision must be approve or decline' };

  let approvals;
  try { approvals = await d.list(key); } catch (e) { return { ok: false, status: 502, error: `Couldn't read the approvals on ${key}: ${e.message}. Nothing was answered.` }; }
  if (approvals == null) return { ok: false, status: 503, error: 'Jira is not configured. Nothing was answered.' };
  const pick = pickPending(approvals);
  if (!pick.approval) return { ok: false, status: 409, outcome: 'nothing-pending', error: pick.why };
  const appr = pick.approval;

  const claim = ext.begin({ writer: 'jira.approval', key: `jira-approval:${key}:${appr.id}`, target: key,
    request: { key, approvalId: appr.id, name: appr.name, decision }, initiatedBy, now: d.now() });
  if (!claim.ok) {
    if (claim.duplicate) return { ok: false, status: 409, outcome: 'duplicate', error: `That approval on ${key} was already answered from NEURO.` };
    if (claim.blocked) return { ok: false, status: 409, outcome: 'blocked', ledgerKey: claim.entry.key,
      error: `The last attempt to answer this approval on ${key} has an unknown outcome. Check the ticket in Jira first.` };
    return { ok: false, status: 400, outcome: 'refused', error: claim.why };
  }

  try {
    await d.answer(key, appr.id, decision);
  } catch (e) {
    const st = ext.classifyError(e);
    ext.settle(claim.entry.id, { status: st, result: { error: e.message }, now: d.now() });
    return { ok: false, status: 502, outcome: st, error: st === 'failed'
      ? `Jira refused it: ${e.message}. Nothing was answered.`
      : `Jira didn't answer clearly (${e.message}). It may or may not have been ${FINAL[decision]} — check ${key} before trying again.` };
  }

  let readback = 'unreadable';
  try {
    const after = (await d.list(key)) || [];
    const same = after.find((a) => a.id === appr.id);
    readback = !same ? 'approval not found' : same.finalDecision === FINAL[decision] ? `${FINAL[decision]}` : `shows ${same.finalDecision}`;
  } catch { /* stays unreadable */ }
  const confirmed = readback === FINAL[decision];
  ext.settle(claim.entry.id, { status: confirmed ? 'confirmed' : 'applied-unverified', result: { approvalId: appr.id }, readback, now: d.now() });

  return {
    ok: true, key, decision, approval: { id: appr.id, name: appr.name },
    outcome: confirmed ? 'confirmed' : 'applied-unverified', readback,
    warning: confirmed ? null : `Jira accepted it but NEURO couldn't confirm the decision (${readback}). Check ${key}.`,
  };
}

module.exports = { decide, status, pickPending, DECISIONS };
