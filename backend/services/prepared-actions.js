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
 *   • A machine client cannot approve (routes/prepared-actions.js refuses the
 *     API token): A4 approval is Nick's, in NEURO.
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
 *   • not chased in the last RECENT_CHASE_DAYS, no chase queued in the legacy
 *     approval queue, no live governed action already, not rejected this episode
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
  if (ctx.pendingChase) return no('a chase for this is already waiting in the approval queue');
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
      body: `Hi ${first},\n\n${where ? `Following up from ${where}: ` : 'Following up: '}you were going to ${what}. Could you let me know where it's got to?\n\nThanks,\nNick`,
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
    createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
    approval: r.approved_payload_hash ? {
      by: r.approved_by, at: r.approved_at, payloadHash: r.approved_payload_hash,
      evidenceHash: r.approved_evidence_hash || null, expiresAt: r.approval_expires_at,
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

/**
 * Nick approves the EXACT payload he was shown.
 *
 *   payloadHash  the hash the screen displayed — REQUIRED, must equal the row's
 *   approver     who approved (the route sets it from the authenticated session)
 *
 * Approval of a non-executable type is recorded and runs nothing; the response
 * says which. Executing is the executor's job, triggered by the route.
 */
function approve(actionId, { payloadHash = null, approver = null, note: why = null, now = Date.now() } = {}) {
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
  const r = transition(actionId, 'approved', {
    note: why, now: nowMs, allowedFrom: ['prepared'],
    set: {
      approved_by: approver,
      approved_at: new Date(nowMs).toISOString(),
      approved_payload_hash: cur.payload_hash,
      approved_evidence_hash: cur.evidence_hash || null,
      approval_expires_at: new Date(nowMs + (policy.approvalTtlHours || 24) * 3600000).toISOString(),
    },
  });
  return {
    ...r,
    executable: policy.executable,
    notice: policy.executable
      ? 'Approved. This exact message is now sent as you, then checked in Sent Items.'
      : `Approval recorded. ${policy.notExecutableWhy || 'This type does not execute'} — nothing has been sent and nothing will be sent from here.`,
  };
}

function reject(actionId, { note: why = null, now = Date.now() } = {}) {
  return transition(actionId, 'rejected', { note: why, now, allowedFrom: ['prepared', 'approved'] });
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
  if (!registry.isRegistered(cur.action_type)) return { ok: false, code: 409, error: 'not a registered action type' };
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

  const tx = () => db.batchSaves(() => {
    db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, subject_ref, action_type, version,
              parent_action_id, target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class,
              approval_required, status, created_at, expires_at, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A4', 1, 'prepared', ?, ?, ?, ?)`,
    [newId, key, cur.finding_id, cur.commitment_id, cur.subject_ref, cur.action_type, version, cur.action_id,
      cur.target_json, cur.reason, cur.evidence_json, cur.evidence_hash, JSON.stringify(draft), hash, nowIso,
      new Date(nowMs + EXPIRY_HOURS * 3600000).toISOString(),
      JSON.stringify([{ at: nowIso, from: null, to: 'prepared', note: `version ${version}, edited by ${editor} from ${cur.action_id}` }]), nowIso]);
    if (cur.status === 'prepared') {
      const r = transition(actionId, 'superseded', { note: `edited — replaced by ${newId} (v${version})`, now: nowMs, allowedFrom: ['prepared'] });
      if (!r.ok) throw new Error(r.error);
    } else {
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
  for (const r of db.all(`SELECT action_id, finding_id, expires_at FROM prepared_actions WHERE status = 'prepared'`)) {
    if (r.expires_at && r.expires_at <= iso) {
      if (transition(r.action_id, 'expired', { note: `not decided within ${EXPIRY_HOURS}h`, now: nowMs, allowedFrom: ['prepared'] }).ok) expired += 1;
      continue;
    }
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
  pendingChase: (c) => {
    if (!String(c.source.ref || '').startsWith('waiting-on:')) return false;
    const key = c.source.ref.slice('waiting-on:'.length);
    return !!db.get(`SELECT id FROM saim_actions WHERE type = 'chase_commitment' AND status = 'pending'
                     AND json_extract(payload, '$.waitingKey') = ?`, [key]);
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
      context: { existing, pendingChase: d.pendingChase(c), deferred: d.deferred(c), snoozedUntil: d.snoozedUntil(c), nowMs },
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
  prepareFromRisk, approve, reject, edit, sweep, transition, note, governedChaseLive,
  counterpartyFor: _counterparty, ACCEPTED_TARGET_METHODS,
  get, forFinding, forCommitment, list, countsByStatus,
};
