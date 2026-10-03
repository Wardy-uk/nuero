'use strict';

/**
 * Prepared actions — from noticing to doing, with Nick's approval in between.
 *
 * Build 5E (3 Oct 2026) made the first step: a commitment-at-risk finding may
 * PREPARE the obvious next move, and Nick's approval was RECORDED and executed
 * nothing. Build 6 (same day) lets exactly ONE registered type —
 * `chase_commitment` — execute after approval. This module is still the
 * PREPARE / APPROVE half and still imports no sender of any kind (pinned by a
 * source scan); the EXECUTE / VERIFY half is services/action-executor.js.
 *
 * ── Authority comes from the registry, never from a name ───────────────────
 *
 * services/action-registry.js is the allow-list. A type it does not know cannot
 * be prepared or approved; a type it marks `executable: false` can be approved
 * and that approval is recorded and runs nothing. The SQL triggers installed
 * by db/migrate-build6-actions.js repeat the executable allow-list, so the
 * database refuses what the registry does not permit.
 *
 * ── The approval contract (6B) ─────────────────────────────────────────────
 *
 * The failure to prevent: Nick approves "Can you confirm Heidi's end date?",
 * context changes, the system regenerates different words, and different words
 * go out under an approval given for the first ones. So:
 *
 *   • A row's PAYLOAD (type, version, target, subject, body, commitment) is
 *     immutable — enforced by trigger. An edit creates a NEW ROW, version + 1,
 *     which needs its own approval; the old one becomes `superseded`.
 *   • Approving requires the caller to send the payload hash it DISPLAYED.
 *     A mismatch is refused: you approve what you saw, not what is there now.
 *   • The approval records approver, time, payload hash, evidence hash and an
 *     expiry, and is itself immutable (trigger). The trigger also refuses an
 *     approval whose hash is not the row's.
 *   • A machine client cannot approve. The route refuses the API token, and
 *     since Build 7 approve() itself requires a human-approval PROOF — a
 *     server-issued single-use challenge for this exact action/version/hash
 *     plus Nick's approval code (approval-proof.js) — which a DB trigger
 *     repeats. Holding the PIN is not enough: the local MCP server has it.
 *   • Execution re-checks everything that could have changed (executor), and
 *     an action whose world moved is CANCELLED, never silently re-drafted.
 *
 * ── Conservative creation: most findings prepare nothing (shouldPrepare) ───
 *
 * Prepared only when ALL hold:
 *   • the finding is active, level high, confidence ≥ MIN_CONFIDENCE
 *   • the commitment is open and nothing NEURO saw suggests it moved
 *     (progress `no_evidence`), and Nick's sent mail WAS checked
 *   • the person is UNAMBIGUOUS (exact name / an alias one person claims), not
 *     Nick, with exactly one address
 *   • the action follows from the direction: owed TO Nick → chase_commitment;
 *     owed BY Nick to a named person → draft_update_email (prepare-only)
 *   • not chased in the last RECENT_CHASE_DAYS (chaseBlock — the ONE duplicate
 *     check, shared with the Chase button), no live chase already, not
 *     rejected this episode
 *   • not snoozed, not deferred "not today"
 *
 * Drafts are deterministic templates — no model call, no invented facts.
 */

const crypto = require('crypto');
const db = require('../db/database');
const registry = require('./action-registry');

const MIN_CONFIDENCE = 0.7;
const RECENT_CHASE_DAYS = 7;
const EXPIRY_HOURS = 72;
const SELF = 'person:nick-ward';
const ACCEPTED_TARGET_METHODS = new Set(['exact-name', 'exact-alias', 'delivery-verb+exact-name']);
const STATUSES = ['prepared', 'approved', 'executing', 'execution_uncertain', 'executed', 'verified',
  'failed', 'rejected', 'expired', 'cancelled', 'superseded'];
const TERMINAL = new Set(['verified', 'failed', 'rejected', 'expired', 'cancelled', 'superseded']);
// A governed action in one of these states means a chase is under way or done.
const LIVE = new Set(['prepared', 'approved', 'executing', 'execution_uncertain', 'executed']);
const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

const EVENT_FOR = {
  prepared: 'action.prepared', approved: 'action.approved', rejected: 'action.rejected',
  superseded: 'action.superseded', executing: 'action.execution.started',
  execution_uncertain: 'action.execution.uncertain', executed: 'action.executed',
  verified: 'action.verified', failed: 'action.failed', expired: 'action.expired', cancelled: 'action.cancelled',
};

const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : null);
const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now());

// ── the decision (PURE) ─────────────────────────────────────────────────────

/**
 * Should NEURO prepare an action for this finding? PURE.
 * Returns { prepare: false, why } or { prepare: true, actionType, target }.
 */
function shouldPrepare({ finding, commitment, progress, person, context = {} }) {
  const no = (why) => ({ prepare: false, why });
  if (!finding || finding.status !== 'active') return no('the finding is not active');
  if (finding.level !== 'high') return no(`level ${finding.level}: only a high-level risk earns a prepared action`);
  if (!(finding.confidence >= MIN_CONFIDENCE)) return no(`confidence ${finding.confidence} is below ${MIN_CONFIDENCE}`);
  if (!commitment || commitment.status !== 'open') return no('the commitment is not open');

  if (!progress) return no('progress could not be read — not preparing over an unknown');
  if (progress.state !== 'no_evidence') return no(`progress is ${progress.state} (${(progress.reasons || []).join('; ')}) — a draft is only prepared when nothing suggests it moved`);
  if (!progress.coverage || progress.coverage.sentMail !== 'ok') {
    return no('Nick\'s sent mail could not be checked — a chase over an email he may already have sent is the mistake to avoid');
  }

  const ctx = context;
  if (ctx.snoozedUntil && Date.parse(ctx.snoozedUntil) > (ctx.nowMs || Date.now())) return no(`snoozed until ${String(ctx.snoozedUntil).slice(0, 10)}`);
  if (ctx.deferred) return no('deferred "not today" by Nick');

  let actionType;
  if (commitment.direction === 'to-nick') actionType = 'chase_commitment';
  else if (commitment.direction === 'by-nick' && commitment.beneficiary && commitment.beneficiary.kind === 'person') actionType = 'draft_update_email';
  else return no(commitment.direction === 'by-nick'
    ? `owed to ${commitment.beneficiary && commitment.beneficiary.kind === 'meeting' ? 'the meeting as a whole' : 'nobody named'} — no single person to write to`
    : 'direction unknown');
  if (!registry.isRegistered(actionType)) return no(`${actionType} is not a registered action type`);

  if (!person || !person.personId) return no(`the ${actionType === 'chase_commitment' ? 'person who owes it' : 'person it is owed to'} is unresolved (${commitment.promisor && commitment.promisor.unresolvedWhy || 'no person'})`);
  if (person.personId === SELF) return no('the counterparty resolves to Nick');
  if (!ACCEPTED_TARGET_METHODS.has(person.method)) return no(`resolved only by ${person.method} — not unambiguous enough to write to`);
  const emails = Array.isArray(person.emails) ? person.emails : [];
  if (emails.length !== 1) return no(emails.length ? `${person.displayName} has ${emails.length} addresses — not choosing one` : `${person.displayName} has no address on record`);

  if (commitment.lastProgressAt) {
    const since = ((ctx.nowMs || Date.now()) - Date.parse(String(commitment.lastProgressAt).replace(' ', 'T'))) / 86400000;
    if (Number.isFinite(since) && since < RECENT_CHASE_DAYS) return no(`chased ${Math.floor(since)} day(s) ago`);
  }
  if (ctx.recentChase) return no(ctx.recentChase);
  const live = (ctx.existing || []).find((a) => LIVE.has(a.status));
  if (live) return no(`already ${live.status} as ${live.actionId}`);
  const refused = (ctx.existing || []).find((a) => a.status === 'rejected' && a.findingId === finding.findingId);
  if (refused) return no('Nick rejected the prepared action for this risk episode');

  return { prepare: true, actionType, target: { personId: person.personId, displayName: person.displayName, email: emails[0], method: person.method } };
}

// ── the draft (PURE, deterministic, no model) ───────────────────────────────

/** The action, as a phrase: "send the support figures", with the owner's name stripped. */
function actionPhrase(description) {
  const s = String(description || '').trim()
    .replace(/^[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?(?:\s+(?:to|will|should|must)\b|\s*[:\-–—])\s*/, '')
    .replace(/[.;]+$/, '');
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : '';
}

function meetingPhrase(commitment) {
  const occ = commitment.meeting && commitment.meeting.occurrence;
  if (occ && occ.subject) return `${occ.subject} on ${dayLabel(occ.start.slice(0, 10))}`;
  if (commitment.source && commitment.source.date) return `our conversation on ${dayLabel(String(commitment.source.date).slice(0, 10))}`;
  return null;
}

function _placeholders(body) {
  const out = [];
  const re = /\[(date|name|when|time|details?)\]/gi;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) out.push(m[1].toLowerCase());
  return [...new Set(out)];
}

/**
 * The exact words. In Nick's voice (they go out as him), short, and only facts
 * NEURO holds: who, what was agreed, where. No deadline, reason, consequence or
 * urgency the evidence does not carry; no CC; no mention of how it was drafted.
 * A date nobody stated is a visible [placeholder], never an invention.
 */
function draftFor(actionType, commitment, target) {
  const first = String(target.displayName || '').split(/\s+/)[0] || 'there';
  const what = actionPhrase(commitment.description);
  const where = meetingPhrase(commitment);
  const subjectWhat = what.length > 60 ? `${what.slice(0, 57)}…` : what;
  if (actionType === 'chase_commitment' || actionType === 'draft_chase_email') {
    return {
      channel: 'email', voice: 'nick', generatedBy: 'template (no model call)',
      to: [{ name: target.displayName, email: target.email }],
      subject: `Following up: ${subjectWhat}`,
      // The tone rule the retired waiting-on chase carried (Build 7 keeps it):
      // it asks, it gives the out, and it never implies the person failed —
      // these go to people who work for Nick.
      body: `Hi ${first},\n\n${where ? `Following up from ${where}: ` : 'Following up: '}you were going to ${what}. Could you let me know where it's got to?\n\nNo rush if it's moved down the list — just let me know.\n\nThanks,\nNick`,
      placeholders: [],
    };
  }
  return {
    channel: 'email', voice: 'nick', generatedBy: 'template (no model call)',
    to: [{ name: target.displayName, email: target.email }],
    subject: `Update: ${subjectWhat}`,
    body: `Hi ${first},\n\nA quick update on ${what}${where ? ` (from ${where})` : ''}: it isn't with you yet. I'll have it to you by [date].\n\nThanks,\nNick`,
    placeholders: ['date'],
  };
}

// ── the store ───────────────────────────────────────────────────────────────

function shape(r) {
  if (!r) return null;
  const policy = registry.policyFor(r.action_type);
  return {
    actionId: r.action_id, findingId: r.finding_id, commitmentId: r.commitment_id, subjectRef: r.subject_ref || null,
    actionType: r.action_type, version: r.version || 1, parentActionId: r.parent_action_id || null,
    target: parse(r.target_json), reason: r.reason, evidence: parse(r.evidence_json), evidenceHash: r.evidence_hash || null,
    draft: parse(r.draft_json), payloadHash: r.payload_hash,
    authorityClass: r.authority_class, approvalRequired: r.approval_required === 1, status: r.status,
    origin: r.origin || 'risk',
    createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
    approval: r.approved_payload_hash ? {
      by: r.approved_by, at: r.approved_at, payloadHash: r.approved_payload_hash,
      evidenceHash: r.approved_evidence_hash || null, expiresAt: r.approval_expires_at,
      mechanism: r.approval_mechanism || null, challengeId: r.approval_challenge_id || null,
    } : null,
    executedAt: r.executed_at || null, verifiedAt: r.verified_at || null,
    outcomeDetail: r.outcome_detail || null, retrySafe: r.retry_safe === null || r.retry_safe === undefined ? null : r.retry_safe === 1,
    lastBlock: r.last_block || null, lastCheckAt: r.last_check_at || null,
    history: parse(r.history_json) || [], updatedAt: r.updated_at,
    idempotencyKey: r.idempotency_key,
    // From the registry, on every read, so no surface can imply otherwise.
    registered: !!policy,
    executes: registry.canExecute(r.action_type),
    notExecutableWhy: policy && !policy.executable ? policy.notExecutableWhy || 'not executable' : (policy ? null : 'not a registered action type'),
  };
}

const _row = (actionId) => db.get('SELECT * FROM prepared_actions WHERE action_id = ?', [actionId]);
function get(actionId) { return shape(_row(actionId)); }
function forFinding(findingId) {
  return shape(db.get('SELECT * FROM prepared_actions WHERE finding_id = ? ORDER BY created_at DESC, version DESC LIMIT 1', [findingId]));
}
function forCommitment(commitmentId) {
  return db.all('SELECT * FROM prepared_actions WHERE commitment_id = ? ORDER BY created_at DESC, version DESC', [commitmentId]).map(shape);
}
function list({ status = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return (status && STATUSES.includes(status)
    ? db.all('SELECT * FROM prepared_actions WHERE status = ? ORDER BY updated_at DESC LIMIT ?', [status, lim])
    : db.all('SELECT * FROM prepared_actions ORDER BY updated_at DESC LIMIT ?', [lim])).map(shape);
}
/**
 * Every row still in play — prepared, approved, in flight, uncertain, or a
 * failure proven unsent — UNBOUNDED by page (Build 9). The route's buckets were
 * computed over the newest 50 by updated_at while `counts` were global, so an
 * older draft still awaiting approval could fall off "Needs approval" while the
 * count beside it still included it. The live set is small by construction
 * (one live chase per commitment, one reply per email, one report per week).
 */
function listLive() {
  return db.all(
    `SELECT * FROM prepared_actions
      WHERE status IN ('prepared','approved','executing','executed','execution_uncertain')
         OR (status = 'failed' AND retry_safe = 1)
      ORDER BY updated_at DESC`,
  ).map(shape);
}

/** What is waiting on Nick (approval / review), summarised. Never throws. */
function needsYou() {
  const summary = require('./approval-summary');
  try {
    const rows = db.all(
      `SELECT action_type, status, retry_safe, created_at FROM prepared_actions
        WHERE status IN ('prepared','execution_uncertain') OR (status = 'failed' AND retry_safe = 1)`,
    );
    let sendingEnabled = null;
    try { sendingEnabled = require('./feature-flags').isEnabled('governed_execution'); } catch { sendingEnabled = null; }
    return summary.summarise(rows, { sendingEnabled });
  } catch (e) {
    return summary.unknown(e.message);
  }
}

function countsByStatus() {
  const out = {};
  for (const r of db.all('SELECT status, COUNT(*) n FROM prepared_actions GROUP BY status')) out[r.status] = r.n;
  return out;
}

/**
 * Publish one lifecycle event. REFERENCES ONLY (see event-types.js). Never
 * allowed to fail the transition it describes: history_json on the row is the
 * authoritative audit; the event is the cross-system signal.
 */
function _event(row, status, nowIso, extra = {}) {
  const type = EVENT_FOR[status];
  if (!type) return;
  try {
    const target = parse(row.target_json) || {};
    require('./event-bus').publishEvent({
      type,
      occurredAt: nowIso,
      source: { system: 'neuro', recordId: row.action_id },
      subject: { entityType: 'prepared-action', entityId: row.action_id },
      idempotencyKey: `action:${row.action_id}:${status}`,
      payload: {
        actionId: row.action_id, actionType: row.action_type, version: row.version || 1,
        commitmentId: row.commitment_id, targetPersonId: target.personId || null, ...extra,
      },
    }, { now: Date.parse(nowIso) });
  } catch (e) {
    console.warn(`[PreparedActions] could not record ${type} for ${row.action_id}: ${e.message}`);
  }
}

/**
 * The ONE status writer. Conditional on the status the caller saw, so two
 * concurrent callers cannot both move it. `set` carries extra columns written
 * in the same UPDATE (the triggers see them together).
 */
function transition(actionId, to, { note = null, now = Date.now(), allowedFrom, set = {}, eventExtra = {} } = {}) {
  const nowIso = new Date(msOf(now)).toISOString();
  const cur = _row(actionId);
  if (!cur) return { ok: false, code: 404, error: 'no such prepared action' };
  if (cur.status === to) return { ok: true, already: true, action: shape(cur) };
  if (!allowedFrom.includes(cur.status)) return { ok: false, code: 409, error: `it is ${cur.status}; only ${allowedFrom.join('/')} can become ${to}` };
  const history = parse(cur.history_json) || [];
  history.push({ at: nowIso, from: cur.status, to, note: note || null });
  const cols = { ...set, status: to, history_json: JSON.stringify(history), updated_at: nowIso };
  if (to === 'approved' || to === 'rejected') { cols.decided_at = nowIso; cols.decision_note = note || null; }
  const keys = Object.keys(cols);
  const res = db.run(`UPDATE prepared_actions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE action_id = ? AND status = ?`,
    [...keys.map((k) => cols[k]), actionId, cur.status]);
  if (!res.changes) {
    const now2 = _row(actionId);
    return now2 && now2.status === to
      ? { ok: true, already: true, action: shape(now2) }
      : { ok: false, code: 409, error: `it changed underneath (now ${now2 ? now2.status : 'gone'})` };
  }
  const after = _row(actionId);
  _event(after, to, nowIso, eventExtra);
  return { ok: true, action: shape(after), from: cur.status };
}

/** Record something operational (not a state change) on the row. */
function note(actionId, set) {
  const keys = Object.keys(set).filter((k) => ['last_block', 'last_check_at', 'outcome_detail', 'chase_recorded_at', 'retry_safe'].includes(k));
  if (!keys.length) return;
  db.run(`UPDATE prepared_actions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE action_id = ?`, [...keys.map((k) => set[k]), actionId]);
}

// ── approval (6B) ───────────────────────────────────────────────────────────

const sendingEnabled = () => require('./feature-flags').isEnabled('governed_execution');

/**
 * Nick approves the EXACT payload he was shown.
 *
 *   payloadHash   the hash the screen displayed — REQUIRED, must equal the row's
 *   challengeId   a challenge NEURO issued for this action/version/hash  ┐ the
 *   approvalCode  the code Nick typed (services/approval-proof.js)       ┘ proof
 *   approver      who approved (the route sets it)
 *
 * ⚠ Build 7: the human-approval proof is checked HERE, not only in the route,
 * so no in-process caller can approve without it either; and a DB trigger
 * refuses an approval whose challenge was not accepted for this exact payload.
 *
 * ⚠ An executable type cannot be approved while sending is switched off: an
 * approval that sits held until it silently expires — or that sends hours later
 * when the switch is flipped — is the confusing outcome, so it is refused with
 * the reason before the code is even asked for.
 *
 * Approval of a non-executable type is recorded and runs nothing; the response
 * says which. Executing is the executor's job, triggered by the route.
 */
function approve(actionId, {
  payloadHash = null, challengeId = null, approvalCode = null, approver = null, note: why = null,
  now = Date.now(), sending = sendingEnabled,
} = {}) {
  const nowMs = msOf(now);
  const cur = _row(actionId);
  if (!cur) return { ok: false, code: 404, error: 'no such prepared action' };
  const policy = registry.policyFor(cur.action_type);
  if (!policy) return { ok: false, code: 409, error: `${cur.action_type} is not a registered action type — it cannot be approved` };
  if (cur.status === 'approved' || (cur.approved_payload_hash && cur.status !== 'prepared')) {
    if (cur.approved_payload_hash && payloadHash === cur.approved_payload_hash) return { ok: true, already: true, action: shape(cur), executable: policy.executable };
    return { ok: false, code: 409, error: `it is already ${cur.status}` };
  }
  if (cur.status !== 'prepared') return { ok: false, code: 409, error: `it is ${cur.status}; only a prepared action can be approved` };
  if (!approver || typeof approver !== 'string') return { ok: false, code: 400, error: 'an approval must name its approver' };
  if (!payloadHash || typeof payloadHash !== 'string') {
    return { ok: false, code: 400, error: 'send the payloadHash you were shown — an approval binds to the exact words, recipient and version you reviewed' };
  }
  const recomputed = registry.payloadHash({ actionType: cur.action_type, version: cur.version, commitmentId: cur.commitment_id,
    target: parse(cur.target_json), draft: parse(cur.draft_json) });
  if (recomputed !== cur.payload_hash) {
    return { ok: false, code: 409, error: 'this action\'s stored payload does not match its own hash — refusing to approve it' };
  }
  if (payloadHash !== cur.payload_hash) {
    return { ok: false, code: 409, error: 'the draft is not the one you were shown — reload it and review it again' };
  }
  if (cur.expires_at && Date.parse(cur.expires_at) <= nowMs) {
    transition(actionId, 'expired', { note: `not decided within ${EXPIRY_HOURS}h`, now: nowMs, allowedFrom: ['prepared'] });
    return { ok: false, code: 409, error: 'it has expired — NEURO will prepare a fresh one if it is still needed' };
  }
  const draft = parse(cur.draft_json) || {};
  if (registry.hasUnfilledPlaceholder(draft.body) || registry.hasUnfilledPlaceholder(draft.subject)) {
    return { ok: false, code: 409, error: 'the draft still has a [placeholder] in it — edit it first; that creates a new version to approve' };
  }
  if (policy.executable && !sending()) {
    return { ok: false, code: 409, error: 'Sending is switched off (Settings → Switches → "Send approved emails"), so approving would send nothing. Turn it on first, then approve.' };
  }
  // The proof. Burns the challenge whatever the outcome.
  const proof = require('./approval-proof').consume({
    challengeId, approvalCode, actionId, version: cur.version || 1, payloadHash: cur.payload_hash, now: nowMs,
  });
  if (!proof.ok) return { ok: false, code: proof.code || 403, error: proof.error };
  const r = transition(actionId, 'approved', {
    note: why, now: nowMs, allowedFrom: ['prepared'],
    set: {
      approved_by: approver,
      approved_at: new Date(nowMs).toISOString(),
      approved_payload_hash: cur.payload_hash,
      approved_evidence_hash: cur.evidence_hash || null,
      approval_expires_at: new Date(nowMs + (policy.approvalTtlHours || 24) * 3600000).toISOString(),
      approval_mechanism: proof.proof.mechanism,
      approval_challenge_id: proof.proof.challengeId,
    },
    eventExtra: { mechanism: proof.proof.mechanism, challengeRef: proof.proof.challengeId.slice(0, 11) },
  });
  return {
    ...r,
    executable: policy.executable,
    notice: policy.executable
      ? `Approved. This exact ${cur.action_type === 'send_weekly_risk_report' ? 'report' : 'email'} is now sent as you, then checked in Sent Items.`
      : `Approval recorded. ${policy.notExecutableWhy || 'This type does not execute'} — nothing has been sent and nothing will be sent from here.`,
  };
}

/** `actor` is recorded in the decision note: who refused it is part of the audit. */
function reject(actionId, { note: why = null, now = Date.now(), actor = null } = {}) {
  const text = actor ? `rejected by ${actor}${why ? ` — ${why}` : ''}` : why;
  return transition(actionId, 'rejected', { note: text, now, allowedFrom: ['prepared', 'approved'] });
}

/**
 * Edit = a NEW VERSION. The old row is never changed (the trigger refuses);
 * it becomes `superseded` (or, for a failed one proven unsent, stays failed and
 * records its successor). The recipient cannot be edited here — the target was
 * resolved unambiguously, and a free-typed address would bypass that rule.
 */
function edit(actionId, { subject, body, payloadHash = null, editor = 'nick', now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const nowIso = new Date(nowMs).toISOString();
  const cur = _row(actionId);
  if (!cur) return { ok: false, code: 404, error: 'no such prepared action' };
  const policy = registry.policyFor(cur.action_type);
  if (!policy) return { ok: false, code: 409, error: 'not a registered action type' };
  if (policy.editable === false) return { ok: false, code: 409, error: `${policy.label} cannot be edited here: ${policy.notEditableWhy}` };
  const failedUnsent = cur.status === 'failed' && cur.retry_safe === 1;
  if (cur.status !== 'prepared' && !failedUnsent) {
    return { ok: false, code: 409, error: cur.status === 'failed'
      ? 'it may have been sent — it cannot be edited and resent until that is settled'
      : `it is ${cur.status}; only a prepared action (or a failed one proven unsent) can be edited` };
  }
  if (db.get('SELECT action_id FROM prepared_actions WHERE parent_action_id = ?', [actionId])) {
    return { ok: false, code: 409, error: 'it has already been edited — edit the newest version' };
  }
  if (!payloadHash || payloadHash !== cur.payload_hash) return { ok: false, code: 409, error: 'the draft is not the one you were shown — reload it first' };
  const old = parse(cur.draft_json) || {};
  const s = typeof subject === 'string' ? subject.trim() : old.subject;
  const b = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : old.body;
  if (!s || s.length > MAX_SUBJECT) return { ok: false, code: 400, error: `the subject must be 1–${MAX_SUBJECT} characters` };
  if (!b || b.length > MAX_BODY) return { ok: false, code: 400, error: `the message must be 1–${MAX_BODY} characters` };
  if (s === old.subject && b === old.body && !failedUnsent) return { ok: false, code: 400, error: 'nothing changed' };

  const version = (cur.version || 1) + 1;
  const rootKey = String(cur.idempotency_key).replace(/#v\d+$/, '');
  const key = `${rootKey}#v${version}`;
  const newId = `pa_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
  const target = parse(cur.target_json);
  const draft = { ...old, subject: s, body: b, placeholders: _placeholders(`${s}\n${b}`),
    generatedBy: `${old.generatedBy || 'template'}; edited by ${editor}`, editedFrom: cur.action_id };
  const hash = registry.payloadHash({ actionType: cur.action_type, version, commitmentId: cur.commitment_id, target, draft });

  // ⚠ Build 7: the old version is superseded BEFORE the new one is inserted.
  // One active chase per commitment is a UNIQUE index now, so inserting first
  // would collide with the version it replaces. Both happen in one transaction:
  // a failed insert leaves the old version prepared, never neither.
  const tx = () => db.batchSaves(() => {
    if (cur.status === 'prepared') {
      const r = transition(actionId, 'superseded', { note: `edited — replaced by ${newId} (v${version})`, now: nowMs, allowedFrom: ['prepared'] });
      if (!r.ok) throw new Error(r.error);
    }
    db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
              parent_action_id, target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class,
              approval_required, status, origin, created_at, expires_at, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A4', 1, 'prepared', ?, ?, ?, ?, ?)`,
    [newId, key, cur.finding_id, cur.commitment_id, cur.subject_ref, cur.action_type, version, cur.action_id,
      cur.target_json, cur.reason, cur.evidence_json, cur.evidence_hash, JSON.stringify(draft), hash, cur.origin || null, nowIso,
      new Date(nowMs + EXPIRY_HOURS * 3600000).toISOString(),
      JSON.stringify([{ at: nowIso, from: null, to: 'prepared', note: `version ${version}, edited by ${editor} from ${cur.action_id}` }]), nowIso]);
    if (cur.status !== 'prepared') {
      const history = parse(cur.history_json) || [];
      history.push({ at: nowIso, from: cur.status, to: cur.status, note: `resend prepared as ${newId} (v${version}) by ${editor}` });
      db.run('UPDATE prepared_actions SET history_json = ?, updated_at = ? WHERE action_id = ?', [JSON.stringify(history), nowIso, actionId]);
    }
  });
  try { tx(); } catch (e) { return { ok: false, code: 409, error: e.message }; }
  _event(_row(newId), 'prepared', nowIso, { editedFrom: cur.action_id });
  return { ok: true, action: get(newId), supersedes: actionId };
}

/**
 * Age out and cancel. Prepared past expiry → expired; prepared whose finding
 * resolved → cancelled; approved past its approval expiry (execution never ran
 * — the brake was on, or Microsoft was unreachable for a day) → expired.
 */
function sweep({ now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const iso = new Date(nowMs).toISOString();
  let expired = 0; let cancelled = 0; let approvalsExpired = 0;
  for (const r of db.all(`SELECT action_id, finding_id, expires_at, origin FROM prepared_actions WHERE status = 'prepared'`)) {
    if (r.expires_at && r.expires_at <= iso) {
      if (transition(r.action_id, 'expired', { note: `not decided within ${EXPIRY_HOURS}h`, now: nowMs, allowedFrom: ['prepared'] }).ok) expired += 1;
      continue;
    }
    // Only a RISK-prepared action answers a commitment-risk finding (Build 5/6
    // rows carry no origin, which means risk). A chase Nick asked for, a reply
    // he wrote, an agenda request or the weekly report answers no finding, so a
    // finding resolving is not a reason to withdraw it — only expiry (above)
    // and the executor's own re-checks apply to those.
    if (r.origin && r.origin !== 'risk') continue;
    const f = db.get('SELECT status, resolution FROM commitment_risk_findings WHERE finding_id = ?', [r.finding_id]);
    if (!f || f.status !== 'active') {
      if (transition(r.action_id, 'cancelled', { note: `the risk it answered resolved (${f ? f.resolution : 'finding gone'})`, now: nowMs, allowedFrom: ['prepared'] }).ok) cancelled += 1;
    }
  }
  for (const r of db.all(`SELECT action_id, approval_expires_at FROM prepared_actions WHERE status = 'approved'`)) {
    if (r.approval_expires_at && r.approval_expires_at <= iso) {
      const t = transition(r.action_id, 'expired', { note: 'approved but not executed before the approval expired — nothing was sent', now: nowMs,
        allowedFrom: ['approved'], set: { retry_safe: 1, outcome_detail: 'approval expired before execution; nothing was sent' } });
      if (t.ok) approvalsExpired += 1;
    }
  }
  return { expired, cancelled, approvalsExpired };
}

/**
 * Is a governed chase under way (or recently done) for this subject? Used by
 * the LEGACY chase path in both directions so the two queues cannot chase the
 * same person about the same thing twice. Returns the action or null.
 */
function governedChaseLive(subjectRef, { now = Date.now(), includePrepared = true } = {}) {
  if (!subjectRef) return null;
  const since = new Date(msOf(now) - RECENT_CHASE_DAYS * 86400000).toISOString();
  const states = includePrepared ? [...LIVE] : [...LIVE].filter((s) => s !== 'prepared');
  const r = db.get(`SELECT * FROM prepared_actions WHERE subject_ref = ? AND action_type = 'chase_commitment'
                    AND (status IN (${states.map(() => '?').join(',')}) OR (status = 'verified' AND verified_at >= ?))
                    ORDER BY updated_at DESC LIMIT 1`, [subjectRef, ...states, since]);
  return shape(r);
}

// ── one chase episode at a time (7D) ────────────────────────────────────────

/**
 * THE duplicate check, shared by every way a chase can be prepared. Answers
 * whether a new chase for (commitment, person) may be prepared now.
 *
 *   { block: false }                         — prepare
 *   { block: true, live: action, why }       — one is already under way: show it
 *   { block: true, why }                     — chased recently: do not prepare
 *
 * The database repeats the first rule as a partial UNIQUE index
 * (ux_prepared_actions_one_active_chase), so a second live chase is refused
 * even by a caller that forgot to ask. The recent-chase rule needs a clock, so
 * it lives here only — and the executor checks `asked_at` again before sending.
 */
function chaseBlock({ commitmentId, personId, subjectRef = null, nowMs = Date.now() }) {
  const live = db.get(`SELECT * FROM prepared_actions WHERE action_type = 'chase_commitment' AND commitment_id = ?
                       AND json_extract(target_json, '$.personId') = ? AND status IN (${[...LIVE].map(() => '?').join(',')})
                       ORDER BY updated_at DESC LIMIT 1`, [commitmentId, personId, ...LIVE]);
  if (live) return { block: true, live: shape(live), why: `a chase for this is already ${live.status}` };
  const since = new Date(nowMs - RECENT_CHASE_DAYS * 86400000).toISOString();
  const verified = db.get(`SELECT action_id, verified_at FROM prepared_actions WHERE action_type = 'chase_commitment' AND commitment_id = ?
                           AND status = 'verified' AND verified_at >= ? ORDER BY verified_at DESC LIMIT 1`, [commitmentId, since]);
  if (verified) return { block: true, why: `chased on ${String(verified.verified_at).slice(0, 10)} (confirmed in Sent Items) — wait ${RECENT_CHASE_DAYS} days between chases` };
  if (subjectRef && String(subjectRef).startsWith('waiting-on:')) {
    const w = db.get('SELECT asked_at FROM waiting_on WHERE key = ?', [subjectRef.slice('waiting-on:'.length)]);
    const t = w && w.asked_at ? Date.parse(String(w.asked_at).replace(' ', 'T')) : NaN;
    if (Number.isFinite(t) && nowMs - t < RECENT_CHASE_DAYS * 86400000) {
      return { block: true, why: `chased ${Math.floor((nowMs - t) / 86400000)} day(s) ago — wait ${RECENT_CHASE_DAYS} days between chases` };
    }
  }
  return { block: false };
}

const isUniqueViolation = (e) => /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String((e && (e.code || '')) + ' ' + (e && e.message)));

// ── from the Chase button (7B) ──────────────────────────────────────────────

/**
 * Should the Chase button prepare a chase? PURE. The same target rules as a
 * risk-prepared chase (the executor re-checks them, so a looser rule here would
 * only produce an action that is cancelled at send time), minus the risk
 * finding: Nick asking is the reason.
 */
function shouldPrepareFromButton({ commitment, person, progress, waiting, deferred, nowMs = Date.now() }) {
  const no = (why, code = 409) => ({ prepare: false, why, code });
  if (!commitment) return no('NEURO has not modelled this commitment yet (its world model catches up every 10 minutes) — try again shortly', 404);
  if (commitment.status !== 'open') return no(`the commitment is ${commitment.status} — nothing to chase`);
  if (commitment.direction !== 'to-nick') return no('this is something you owe, not something owed to you');
  if (waiting && waiting.status && waiting.status !== 'open') return no(`it is already ${waiting.status}`);
  if (waiting && waiting.snoozedUntil && Date.parse(waiting.snoozedUntil) > nowMs) return no(`you snoozed it until ${String(waiting.snoozedUntil).slice(0, 10)} — unsnooze it first`);
  if (deferred) return no('you deferred it "not today" — bring it back first');
  if (progress && ['fulfilled', 'closed', 'likely_fulfilled'].includes(progress.state)) {
    return no(`NEURO has evidence it may already be done (${(progress.reasons || []).join('; ') || progress.state}) — not drafting a chase for it`);
  }
  if (!person || !person.personId) return no(`NEURO cannot tell who "${(commitment.promisor && commitment.promisor.raw) || 'they'}" is (${(commitment.promisor && commitment.promisor.unresolvedWhy) || 'no single person matches'}) — add an alias or the full name to their People note`);
  if (person.personId === SELF) return no('that resolves to you');
  if (!ACCEPTED_TARGET_METHODS.has(person.method)) return no(`${person.displayName} is matched only by ${person.method} — add an alias to their People note so it is unambiguous`);
  const emails = Array.isArray(person.emails) ? person.emails : [];
  if (emails.length !== 1) return no(emails.length ? `${person.displayName} has ${emails.length} addresses on record — not choosing one` : `${person.displayName} has no email: in their People note`);
  return { prepare: true, actionType: 'chase_commitment', target: { personId: person.personId, displayName: person.displayName, email: emails[0], method: person.method } };
}

const BUTTON_DEPS = {
  commitmentByRef: (ref) => {
    const r = db.get('SELECT commitment_id FROM wm_commitments WHERE source_ref = ? ORDER BY updated_at DESC LIMIT 1', [ref]);
    return r ? require('./world-obligations').getCommitment(r.commitment_id) : null;
  },
  progress: (id) => require('./progress-evidence').progressFor(id),
  counterparty: (c) => _counterparty(c),
  waiting: (key) => {
    const r = db.get('SELECT status, snoozed_until, first_seen, source_path FROM waiting_on WHERE key = ?', [key]);
    return r ? { status: r.status, snoozedUntil: r.snoozed_until, firstSeen: r.first_seen, sourcePath: r.source_path } : null;
  },
  deferred: (c) => DEFAULT_DEPS.deferred(c),
};

/**
 * The Chase button. PREPARES a governed chase_commitment — the same table, the
 * same payload contract, the same approval and the same executor as a chase
 * NEURO prepares from a risk finding. Sends nothing, calls no provider.
 *
 * Returns { ok, action, already } — `already` when a chase for this is already
 * under way, so pressing twice shows the one that exists rather than a second.
 */
function prepareFromWaitingOn(key, { now = Date.now(), deps = {} } = {}) {
  const d = { ...BUTTON_DEPS, ...deps };
  const nowMs = msOf(now);
  const nowIso = new Date(nowMs).toISOString();
  const ref = `waiting-on:${key}`;
  const waiting = d.waiting(key);
  if (!waiting) return { ok: false, code: 404, error: 'no such waiting-on item' };
  const c = d.commitmentByRef(ref);
  let progress = null;
  try { progress = c ? d.progress(c.commitmentId) : null; } catch { progress = null; }
  const person = c ? d.counterparty(c) : null;
  const decision = shouldPrepareFromButton({ commitment: c, person, progress, waiting, deferred: c ? d.deferred(c) : false, nowMs });
  if (!decision.prepare) return { ok: false, code: decision.code, error: decision.why };

  const block = chaseBlock({ commitmentId: c.commitmentId, personId: decision.target.personId, subjectRef: ref, nowMs });
  if (block.block) {
    return block.live ? { ok: true, already: true, action: block.live, notice: `${block.why} — it is in Actions` } : { ok: false, code: 409, error: block.why };
  }

  const draft = draftFor('chase_commitment', c, decision.target);
  const evidence = {
    origin: 'chase-button',
    commitment: { commitmentId: c.commitmentId, description: c.description, direction: c.direction, source: c.source, due: c.due || null },
    progress: progress ? { state: progress.state, reasons: progress.reasons, coverage: progress.coverage } : null,
    target: decision.target,
    waitingOn: { key, firstSeen: waiting.firstSeen || null, sourcePath: waiting.sourcePath || null },
  };
  const idemKey = `chase-button:${c.commitmentId}:${decision.target.personId}:${nowIso}`;
  const actionId = `pa_${crypto.createHash('sha1').update(idemKey).digest('hex').slice(0, 16)}`;
  const payloadHash = registry.payloadHash({ actionType: 'chase_commitment', version: 1, commitmentId: c.commitmentId, target: decision.target, draft });
  try {
    db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
              target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class, approval_required, status, origin,
              created_at, expires_at, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, 'chase_commitment', 1, ?, ?, ?, ?, ?, ?, 'A4', 1, 'prepared', 'chase-button', ?, ?, ?, ?)`,
    [actionId, idemKey, `chase-button:${c.commitmentId}`, c.commitmentId, ref, JSON.stringify(decision.target),
      `You pressed Chase: ${decision.target.displayName} owes you this.`,
      JSON.stringify(evidence), registry.evidenceHash(evidence), JSON.stringify(draft), payloadHash, nowIso,
      new Date(nowMs + EXPIRY_HOURS * 3600000).toISOString(),
      JSON.stringify([{ at: nowIso, from: null, to: 'prepared', note: 'prepared from the Chase button — awaiting approval, nothing sent' }]), nowIso]);
  } catch (e) {
    // The index: another path (or a double click) got there first.
    if (isUniqueViolation(e)) {
      const again = chaseBlock({ commitmentId: c.commitmentId, personId: decision.target.personId, subjectRef: ref, nowMs });
      if (again.live) return { ok: true, already: true, action: again.live, notice: `${again.why} — it is in Actions` };
    }
    throw e;
  }
  _event(_row(actionId), 'prepared', nowIso, { origin: 'chase-button' });
  console.log(`[PreparedActions] prepared chase_commitment (${actionId}) from the Chase button for ${decision.target.personId}; awaiting approval — NOT sent`);
  return { ok: true, already: false, action: get(actionId) };
}

// ── Build 8: the other outbound emails ──────────────────────────────────────
//
// Each producer that used to put a PIN-approvable send into the legacy
// `saim_actions` queue now PREPARES one of these instead: the Inbox composer
// and draft_reply (reply_email), meeting triage (chase_agenda), the Weekly Risk
// panel (send_weekly_risk_report). Preparing sends nothing and calls no sender;
// the exact recipients and words are bound into the row, and the same approval
// proof, executor, ledger and Sent Items verification as a chase apply.

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const lcs = (s) => String(s || '').trim().toLowerCase();
const shortSha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/** Recipients as [{name,email}], from strings or objects; invalid ones dropped and counted. */
function _recipients(list) {
  const out = [];
  let bad = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const email = lcs(typeof r === 'string' ? r : r && (r.email || r.address));
    if (!EMAIL_RE.test(email)) { bad += 1; continue; }
    if (out.some((x) => x.email === email)) continue;
    out.push({ name: (r && typeof r === 'object' && r.name) || null, email });
  }
  return { list: out, bad };
}

/**
 * The one INSERT every Build 8 preparer uses. Born `prepared`, A4, approval
 * required (the triggers repeat all three). `supersede` — an existing row this
 * one replaces — is moved FIRST, in the same transaction, because the
 * one-active-per-subject indexes would otherwise refuse the new row.
 */
function _insertPrepared({ actionType, subjectKey, findingId, subjectRef, target, reason, evidence, draft, origin,
  idemRoot, nowMs, expiresMs = null, supersede = null }) {
  const policy = registry.policyFor(actionType);
  const nowIso = new Date(nowMs).toISOString();
  const version = supersede ? (supersede.version || 1) + 1 : 1;
  const key = supersede ? `${String(supersede.idempotency_key).replace(/#v\d+$/, '')}#v${version}` : idemRoot;
  const actionId = `pa_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
  const payloadHash = registry.payloadHash({ actionType, version, commitmentId: subjectKey, target, draft });
  const ttl = new Date(Math.min(nowMs + (policy.preparedTtlHours || EXPIRY_HOURS) * 3600000, expiresMs || Infinity)).toISOString();
  db.batchSaves(() => {
    if (supersede) {
      const r = supersede.how === 'expire'
        ? transition(supersede.action_id, 'expired', { now: nowMs, allowedFrom: ['approved'], note: supersede.note,
          set: { retry_safe: 1, outcome_detail: `${supersede.note} — nothing was sent` } })
        : transition(supersede.action_id, 'superseded', { now: nowMs, allowedFrom: ['prepared'], note: supersede.note });
      if (!r.ok) throw new Error(r.error);
    }
    db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
              parent_action_id, target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class,
              approval_required, status, origin, created_at, expires_at, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A4', 1, 'prepared', ?, ?, ?, ?, ?)`,
    [actionId, key, findingId, subjectKey, subjectRef, actionType, version, supersede ? supersede.action_id : null,
      JSON.stringify(target), reason, JSON.stringify(evidence), registry.evidenceHash(evidence), JSON.stringify(draft), payloadHash,
      origin, nowIso, ttl,
      JSON.stringify([{ at: nowIso, from: null, to: 'prepared', note: `${supersede ? `version ${version}, replacing ${supersede.action_id}; ` : ''}prepared by ${origin} — awaiting approval, nothing sent` }]),
      nowIso]);
  });
  _event(_row(actionId), 'prepared', nowIso, { origin });
  // IDs only: never an address, a subject or the words.
  console.log(`[PreparedActions] prepared ${actionType} (${actionId}, v${version}) from ${origin}; awaiting approval — NOT sent`);
  return get(actionId);
}

/** The live (or, for `andSent`, sent) governed action of a type for a subject. */
function _liveFor(actionType, subjectKey, { andSent = false } = {}) {
  const states = andSent ? [...LIVE, 'verified'] : [...LIVE];
  return db.get(`SELECT * FROM prepared_actions WHERE action_type = ? AND commitment_id = ? AND status IN (${states.map(() => '?').join(',')})
                 ORDER BY created_at DESC, version DESC LIMIT 1`, [actionType, subjectKey, ...states]);
}

const REPLY_DEPS = {
  // READ-ONLY (mail-read.js): preparing imports no sender — pinned since Build 5.
  mail: () => require('./mail-read'),
};

/**
 * 8C — prepare a reply, in the original thread, with EXACT recipients.
 *
 *   emailId   the Graph id of the message being answered
 *   body      Nick's words (composer) or a model draft he has seen (draft_reply)
 *   mode      'reply' | 'replyAll'
 *   to, cc    optional explicit lists (the composer). Omitted → resolved now from
 *             the original message: reply → its sender; reply-all → its sender,
 *             plus everyone else on it except Nick.
 *
 * Async: the original message is READ (its thread, sender and recipients are
 * what the approval binds). Could not read it → refuse; never a guessed thread.
 * Pressing Send again while an earlier draft for the same email still awaits
 * approval REPLACES it (a new version); one already approved or sending is
 * refused — a second reply is worse than none.
 */
async function prepareReply({ emailId, body, mode = 'reply', to = null, cc = null, origin = 'composer', now = Date.now(), deps = {} } = {}) {
  const d = { ...REPLY_DEPS, ...deps };
  const mail = typeof d.mail === 'function' ? d.mail() : d.mail;
  const nowMs = msOf(now);
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!emailId) return { ok: false, code: 400, error: 'which email is this a reply to? (no emailId)' };
  if (!text) return { ok: false, code: 400, error: 'the reply is empty' };
  if (text.length > MAX_BODY) return { ok: false, code: 400, error: `the reply must be at most ${MAX_BODY} characters` };
  if (!['reply', 'replyAll'].includes(mode)) return { ok: false, code: 400, error: 'mode must be reply or replyAll' };

  const orig = await mail.readMessage(emailId);
  if (!orig || !orig.ok) return { ok: false, code: 503, error: 'could not read the email being replied to — nothing was prepared (try again)' };
  if (!orig.exists) return { ok: false, code: 404, error: 'that email no longer exists in your mailbox' };
  const self = lcs(await mail.signedInAddress());

  let toList; let ccList;
  if (Array.isArray(to)) {
    const t = _recipients(to); const c = _recipients(cc);
    if (t.bad || c.bad) return { ok: false, code: 400, error: 'one of the addresses is not a valid email address' };
    toList = t.list; ccList = c.list.filter((x) => !toList.some((y) => y.email === x.email));
  } else {
    if (!orig.from) return { ok: false, code: 409, error: 'the email has no sender address to reply to' };
    toList = [{ name: orig.fromName || null, email: lcs(orig.from) }];
    ccList = [];
    if (mode === 'replyAll') {
      if (!self) return { ok: false, code: 503, error: 'could not tell which address is yours, so a reply-all\'s recipients cannot be worked out — nothing was prepared' };
      ccList = _recipients([...(orig.to || []), ...(orig.cc || [])]).list.filter((x) => x.email !== self && x.email !== toList[0].email);
    }
  }
  if (!toList.length) return { ok: false, code: 400, error: 'add at least one recipient' };
  const policy = registry.policyFor('reply_email');
  if (toList.length + ccList.length > policy.maxRecipients) return { ok: false, code: 400, error: `a reply may reach at most ${policy.maxRecipients} people` };

  const subjectKey = `email:${emailId}`;
  const live = _liveFor('reply_email', subjectKey);
  let supersede = null;
  if (live) {
    if (live.status !== 'prepared') return { ok: false, code: 409, error: `a reply to this email is already ${live.status} — check Actions → Drafted by NEURO`, action: shape(live) };
    supersede = { ...live, note: 'replaced by a newer reply to the same email' };
  }
  const subject = /^\s*re\s*:/i.test(orig.subject || '') ? orig.subject : `RE: ${orig.subject || ''}`.trim();
  const target = {
    kind: 'email-thread', emailId, conversationId: orig.conversationId, internetMessageId: orig.internetMessageId,
    from: lcs(orig.from), fromName: orig.fromName || null, originalSubject: orig.subject || '', receivedAt: orig.receivedAt || null,
  };
  const draft = {
    channel: 'email', voice: 'nick', mode,
    generatedBy: origin === 'composer' ? 'typed by Nick in the Inbox composer' : 'model draft (draft_reply), shown before approval',
    to: toList, cc: ccList, subject, body: text, placeholders: _placeholders(text),
  };
  const evidence = {
    origin,
    original: { from: target.from, fromName: target.fromName, subject: target.originalSubject, receivedAt: target.receivedAt },
    recipientsFrom: Array.isArray(to) ? 'chosen in the composer' : (mode === 'replyAll' ? 'everyone on the original, except you' : 'the original sender'),
  };
  try {
    const action = _insertPrepared({
      actionType: 'reply_email', subjectKey, findingId: `reply:${emailId}`, subjectRef: subjectKey, target, draft, evidence, origin,
      reason: `Reply to ${target.fromName || target.from} on "${target.originalSubject || '(no subject)'}"`,
      idemRoot: `reply:${emailId}:${new Date(nowMs).toISOString()}:${shortSha(text)}`, nowMs, supersede,
    });
    return { ok: true, already: false, action };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = _liveFor('reply_email', subjectKey);
      if (again) return { ok: false, code: 409, error: `a reply to this email is already ${again.status}`, action: shape(again) };
    }
    return { ok: false, code: 409, error: e.message };
  }
}

/**
 * 8D — prepare an agenda request for a meeting meeting-triage judged needs
 * one. Sync: the caller has already fetched the event. ONE per meeting, ever
 * (a sent one blocks for good; the database repeats it in an index).
 */
function prepareAgendaChase({ event, body, why = null, now = Date.now() } = {}) {
  const nowMs = msOf(now);
  if (!event || !event.id) return { ok: false, code: 400, error: 'no meeting' };
  const organiser = lcs(event.organizer && (event.organizer.email || event.organizer.address));
  if (!EMAIL_RE.test(organiser)) return { ok: false, code: 409, error: 'the meeting has no organiser address to ask' };
  const text = String(body || '').trim();
  if (!text) return { ok: false, code: 400, error: 'no request text' };
  const start = Date.parse(event.start);
  if (!Number.isFinite(start) || start - nowMs < 2 * 3600000) return { ok: false, code: 409, error: 'the meeting is less than two hours away — too late to ask' };
  const subjectKey = `meeting:${event.id}`;
  // Two guards, stated: this check, and ux_prepared_actions_one_agenda_chase
  // (migrate-build8-actions), which refuses the insert below for a meeting
  // already asked about — sent ones included. The index is mutation-checked;
  // this check is belt and braces and is NOT, because the index catches the
  // same case and the catch below hands back the existing action either way.
  const existing = _liveFor('chase_agenda', subjectKey, { andSent: true });
  if (existing) return { ok: true, already: true, action: shape(existing) };
  const target = {
    kind: 'meeting', eventId: event.id, start: event.start, subject: event.subject || '',
    email: organiser, displayName: (event.organizer && event.organizer.name) || organiser,
  };
  const draft = {
    channel: 'email', voice: 'nick', generatedBy: 'template (meeting-triage.buildChaser, no model call)',
    to: [{ name: target.displayName, email: organiser }], subject: `Re: ${target.subject || 'your meeting'}`, body: text, placeholders: [],
  };
  const evidence = { origin: 'meeting-triage', meeting: { eventId: event.id, subject: target.subject, start: event.start }, why };
  try {
    const action = _insertPrepared({
      actionType: 'chase_agenda', subjectKey, findingId: `agenda:${event.id}`, subjectRef: subjectKey, target, draft, evidence,
      origin: 'meeting-triage', reason: `Ask ${target.displayName} what "${target.subject}" is for (${why || 'no agenda or outcome on the invite'})`,
      idemRoot: `agenda:${event.id}`, nowMs, expiresMs: start - 2 * 3600000,
    });
    return { ok: true, already: false, action };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = _liveFor('chase_agenda', subjectKey, { andSent: true });
      if (again) return { ok: true, already: true, action: shape(again) };
    }
    return { ok: false, code: 409, error: e.message };
  }
}

/**
 * 8E — prepare the weekly risk report send. The report is FROZEN into the row:
 * the markdown Nick reads and the exact HTML that is sent (hashed into the
 * approval). Queueing again after the report changed:
 *   • the earlier one is still awaiting approval → it is superseded (new version)
 *   • the earlier one is APPROVED but not sent → its approval is EXPIRED, so an
 *     approval given for one report can never send another
 *   • the earlier one is sending / sent → refused
 * Queueing again with an identical report hands back the same action.
 */
function prepareWeeklyReport({ week, recipient, subject, markdown, html, snapshotDate = null, escalateCount = null,
  vaultPath = null, generatedAt = null, now = Date.now() } = {}) {
  const nowMs = msOf(now);
  if (!week) return { ok: false, code: 400, error: 'no report week' };
  const email = lcs(recipient && recipient.email);
  if (!EMAIL_RE.test(email)) return { ok: false, code: 409, error: 'no valid recipient address' };
  if (!String(markdown || '').trim() || !String(html || '').trim()) return { ok: false, code: 409, error: 'the report body is empty' };
  const reportVersion = shortSha(markdown);
  const subjectKey = `weekly-risk:${week}`;
  const live = _liveFor('send_weekly_risk_report', subjectKey);
  let supersede = null;
  if (live) {
    const lt = parse(live.target_json) || {};
    if (['executing', 'executed', 'execution_uncertain'].includes(live.status)) {
      return { ok: false, code: 409, error: `this week's report is already ${live.status} — check Actions → Drafted by NEURO`, action: shape(live) };
    }
    if (lt.reportVersion === reportVersion && lcs(lt.email) === email) return { ok: true, already: true, action: shape(live) };
    supersede = live.status === 'approved'
      ? { ...live, how: 'expire', note: 'the report was regenerated after this was approved — its approval cannot send the new report' }
      : { ...live, note: 'replaced by a regenerated report' };
  }
  const target = {
    kind: 'weekly-risk-report', week, reportVersion, snapshotDate, escalateCount, vaultPath,
    generatedAt: generatedAt || new Date(nowMs).toISOString(),
    email, displayName: (recipient && recipient.name) || email, recipientSource: (recipient && recipient.source) || null,
  };
  const draft = {
    channel: 'email', voice: 'nick', format: 'html', generatedBy: 'weekly-risk.build (no model call)',
    to: [{ name: target.displayName, email }], subject, body: String(markdown), html: String(html), placeholders: [],
  };
  const evidence = { origin: 'weekly-risk', week, reportVersion, snapshotDate, escalateCount, vaultPath, recipientSource: target.recipientSource };
  try {
    const action = _insertPrepared({
      actionType: 'send_weekly_risk_report', subjectKey, findingId: `weekly-risk:${week}`, subjectRef: subjectKey, target, draft, evidence,
      origin: 'weekly-risk', reason: `Weekly risk report for w/c ${week}, due to ${target.displayName} by midday`,
      idemRoot: `weekly-risk:${week}:${reportVersion}:${new Date(nowMs).toISOString()}`, nowMs, supersede,
    });
    return { ok: true, already: false, action, superseded: supersede ? supersede.action_id : null };
  } catch (e) {
    return { ok: false, code: 409, error: e.message };
  }
}

/** The governed weekly report action for a week, newest first (any status). */
function weeklyReportFor(week) {
  return shape(db.get(`SELECT * FROM prepared_actions WHERE action_type = 'send_weekly_risk_report' AND commitment_id = ?
                       ORDER BY created_at DESC, version DESC LIMIT 1`, [`weekly-risk:${week}`]));
}

/** Has this meeting ever been asked about through the governed path? (meeting-triage's seen set) */
function agendaAsked(eventId) {
  return !!_liveFor('chase_agenda', `meeting:${eventId}`, { andSent: true });
}

/** Chases the pre-Build-7 queue sent: recorded, never verified. */
function legacyHistory() {
  try {
    return db.all('SELECT * FROM action_legacy_history ORDER BY occurred_at DESC').map((r) => ({
      legacyRef: r.legacy_ref, actionType: r.action_type, status: r.status, provenance: r.provenance,
      subjectRef: r.subject_ref, target: { name: r.target_name, email: r.target_email, source: r.target_source },
      channelRequested: r.channel_requested, occurredAt: r.occurred_at, queuedAt: r.queued_at, note: r.note,
      verified: false,
    }));
  } catch { return []; }
}

// ── from findings ───────────────────────────────────────────────────────────

function _counterparty(c) {
  const wm = require('./world-model');
  const pick = c.direction === 'to-nick'
    ? { personId: c.promisor.personId, method: c.promisor.method }
    : { personId: c.beneficiary.personId, method: c.beneficiary.method };
  if (!pick.personId) return null;
  const p = wm.getPerson(pick.personId);
  return p ? { personId: p.personId, displayName: p.displayName, emails: p.emails, method: pick.method } : null;
}

const DEFAULT_DEPS = {
  findings: () => require('./commitment-risk').findings({ status: 'active', limit: 200 }),
  commitment: (id) => require('./world-obligations').getCommitment(id),
  progress: (id) => require('./progress-evidence').progressFor(id),
  counterparty: _counterparty,
  // Build 7: the legacy queue no longer holds chases, so "a chase pending in
  // the old queue" became "chased recently" — the central chaseBlock answers.
  recentChase: (c, person, nowMs) => {
    if (c.direction !== 'to-nick' || !person || !person.personId) return null;
    const blk = chaseBlock({ commitmentId: c.commitmentId, personId: person.personId, subjectRef: c.source && c.source.ref, nowMs });
    return blk.block && !blk.live ? blk.why : null;
  },
  snoozedUntil: (c) => {
    if (!String(c.source.ref || '').startsWith('waiting-on:')) return null;
    const r = db.get('SELECT snoozed_until FROM waiting_on WHERE key = ?', [c.source.ref.slice('waiting-on:'.length)]);
    return r ? r.snoozed_until : null;
  },
  deferred: (c) => {
    try {
      const lc = require('./attention-lifecycle');
      return !!lc.deferredKeys().get(lc.dedupeKeyFor({ type: 'todo', title: c.description }));
    } catch { return true; } // unreadable: do not prepare over a decision we cannot see
  },
};

/**
 * One pass over the active commitment-risk findings. Prepares at most one
 * action per (commitment, episode, type) — the idempotency key — so a repeated
 * evaluator pass prepares nothing new. PREPARING SENDS NOTHING AND CALLS NO
 * PROVIDER: it writes a row Nick can read. Returns counts and every "why not".
 */
function prepareFromRisk({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const nowMs = msOf(now);
  const iso = new Date(nowMs).toISOString();
  const out = { swept: sweep({ now: nowMs }), considered: 0, prepared: 0, existing: 0, declined: [] };
  for (const f of d.findings()) {
    out.considered += 1;
    const c = d.commitment(f.commitmentId);
    if (!c) { out.declined.push({ findingId: f.findingId, why: 'commitment not found' }); continue; }
    let progress = null;
    try { progress = d.progress(c.commitmentId); } catch { progress = null; }
    const person = d.counterparty(c);
    const existing = forCommitment(c.commitmentId);
    const decision = shouldPrepare({
      finding: f, commitment: c, progress, person,
      context: { existing, recentChase: d.recentChase(c, person, nowMs), deferred: d.deferred(c), snoozedUntil: d.snoozedUntil(c), nowMs },
    });
    if (!decision.prepare) { out.declined.push({ findingId: f.findingId, commitmentId: c.commitmentId, why: decision.why }); continue; }

    // The UNIQUE key is the second guard, for two passes in two processes: in
    // one process shouldPrepare's "already live" check refuses a duplicate
    // first. Belt and braces, and NOT mutation-checked for that reason.
    const key = `prepared:${c.commitmentId}:${f.episode}:${decision.actionType}`;
    const actionId = `pa_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
    const draft = draftFor(decision.actionType, c, decision.target);
    const reason = decision.actionType === 'chase_commitment'
      ? `${decision.target.displayName} owes Nick this, it is at risk (${f.why}), and nothing NEURO can see says it moved.`
      : `Nick owes ${decision.target.displayName} this, it is at risk (${f.why}), and nothing NEURO can see says it moved.`;
    const evidence = {
      finding: { findingId: f.findingId, level: f.level, confidence: f.confidence, triggers: f.triggers, summary: f.summary },
      commitment: { commitmentId: c.commitmentId, description: c.description, direction: c.direction, source: c.source, due: c.due },
      progress: { state: progress.state, reasons: progress.reasons, coverage: progress.coverage },
      target: decision.target,
    };
    const payloadHash = registry.payloadHash({ actionType: decision.actionType, version: 1, commitmentId: c.commitmentId, target: decision.target, draft });
    const res = db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
              target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class, approval_required, status,
              created_at, expires_at, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'A4', 1, 'prepared', ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO NOTHING`,
    [actionId, key, f.findingId, c.commitmentId, (c.source && c.source.ref) || null, decision.actionType,
      JSON.stringify(decision.target), reason, JSON.stringify(evidence), registry.evidenceHash(evidence),
      JSON.stringify(draft), payloadHash, iso, new Date(nowMs + EXPIRY_HOURS * 3600000).toISOString(),
      JSON.stringify([{ at: iso, from: null, to: 'prepared', note: 'prepared from a high-level commitment-risk finding' }]), iso]);
    if (res.changes) {
      out.prepared += 1;
      _event(_row(actionId), 'prepared', iso);
      // IDs only: never the address or the words.
      console.log(`[PreparedActions] prepared ${decision.actionType} (${actionId}) for ${decision.target.personId}; awaiting Nick's approval — NOT sent`);
    } else out.existing += 1;
  }
  return out;
}

module.exports = {
  MIN_CONFIDENCE, RECENT_CHASE_DAYS, EXPIRY_HOURS, STATUSES, TERMINAL, LIVE,
  shouldPrepare, draftFor, actionPhrase,
  prepareFromRisk, prepareFromWaitingOn, shouldPrepareFromButton, chaseBlock, legacyHistory,
  prepareReply, prepareAgendaChase, prepareWeeklyReport, weeklyReportFor, agendaAsked,
  approve, reject, edit, sweep, transition, note, governedChaseLive,
  counterpartyFor: _counterparty, ACCEPTED_TARGET_METHODS,
  get, forFinding, forCommitment, list, listLive, needsYou, countsByStatus,
};
