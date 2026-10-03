'use strict';

/**
 * Prepared actions (Build 5E, 3 Oct 2026) — the first step from noticing to
 * doing, and deliberately ONLY the first step.
 *
 * A commitment-at-risk finding says "this promise is about to matter and still
 * looks open". When that is strong enough, NEURO may PREPARE the obvious next
 * move — a short chase to the colleague who owes Nick something, or a holding
 * note to the colleague Nick owes — so that if Nick agrees, the work of
 * writing it is already done.
 *
 * ── Authority A4, approval required, and in Build 5 NOTHING EXECUTES ───────
 *
 * The draft would leave the building as Nick, so it is consequential (A4) and
 * approval is always required. Approving RECORDS a decision. There is no
 * executor: this module imports no mail, Teams, push or Graph code (pinned by
 * a source scan), the table refuses `executed` with a trigger, and the API's
 * approve answers `executed: false`. A future build that wants to send must
 * add an executor, drop the trigger in a migration that says so, and route the
 * send through the existing outbound gates.
 *
 * ── Conservative creation: most findings prepare nothing ────────────────────
 *
 * Prepared only when ALL hold (shouldPrepare, PURE):
 *   • the finding is active, level high, confidence ≥ MIN_CONFIDENCE
 *   • the commitment is open and nothing NEURO saw suggests it moved
 *     (progress `no_evidence`) — and Nick's sent mail WAS checked, because a
 *     chase drafted over an email he already sent is the expensive mistake
 *   • the person is UNAMBIGUOUS: resolved by exact name or an alias exactly one
 *     person claims (a first name alone is not enough to write to someone),
 *     not Nick, with exactly one address
 *   • the action is obvious from the direction: owed TO Nick → chase the
 *     person who owes it; owed BY Nick to a NAMED person → a holding note to
 *     them. Owed to "the meeting" or to nobody named → nothing
 *   • not chased in the last RECENT_CHASE_DAYS, no chase already queued in the
 *     approval queue, no prepared/approved action already, and Nick did not
 *     reject one for this episode
 *   • not snoozed, not deferred "not today"
 *
 * Drafts are deterministic templates — no model call, no invented facts. What
 * NEURO cannot know (a new date) is a visible placeholder for Nick to fill.
 */

const crypto = require('crypto');
const db = require('../db/database');

const MIN_CONFIDENCE = 0.7;
const RECENT_CHASE_DAYS = 7;
const EXPIRY_HOURS = 72;
const SELF = 'person:nick-ward';
const ACCEPTED_TARGET_METHODS = new Set(['exact-name', 'exact-alias', 'delivery-verb+exact-name']);
const STATUSES = ['prepared', 'approved', 'rejected', 'expired', 'cancelled', 'executed'];

const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : null);

// ── the decision (PURE) ─────────────────────────────────────────────────────

/**
 * Should NEURO prepare an action for this finding? PURE.
 * Returns { prepare: false, why } or { prepare: true, actionType, target }.
 *
 *   finding     shaped commitment-risk finding
 *   commitment  shaped commitment
 *   progress    { state, ... } from progress-evidence.progressFor
 *   person      { personId, displayName, emails[], method } — the counterparty, resolved
 *   context     { existing[], pendingChase, deferred, snoozedUntil, nowMs }
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
  if (commitment.direction === 'to-nick') actionType = 'draft_chase_email';
  else if (commitment.direction === 'by-nick' && commitment.beneficiary && commitment.beneficiary.kind === 'person') actionType = 'draft_update_email';
  else return no(commitment.direction === 'by-nick'
    ? `owed to ${commitment.beneficiary && commitment.beneficiary.kind === 'meeting' ? 'the meeting as a whole' : 'nobody named'} — no single person to write to`
    : 'direction unknown');

  if (!person || !person.personId) return no(`the ${actionType === 'draft_chase_email' ? 'person who owes it' : 'person it is owed to'} is unresolved (${commitment.promisor && commitment.promisor.unresolvedWhy || 'no person'})`);
  if (person.personId === SELF) return no('the counterparty resolves to Nick');
  if (!ACCEPTED_TARGET_METHODS.has(person.method)) return no(`resolved only by ${person.method} — not unambiguous enough to write to`);
  const emails = Array.isArray(person.emails) ? person.emails : [];
  if (emails.length !== 1) return no(emails.length ? `${person.displayName} has ${emails.length} addresses — not choosing one` : `${person.displayName} has no address on record`);

  if (commitment.lastProgressAt) {
    const since = ((ctx.nowMs || Date.now()) - Date.parse(String(commitment.lastProgressAt).replace(' ', 'T'))) / 86400000;
    if (Number.isFinite(since) && since < RECENT_CHASE_DAYS) return no(`chased ${Math.floor(since)} day(s) ago`);
  }
  if (ctx.pendingChase) return no('a chase for this is already waiting in the approval queue');
  const live = (ctx.existing || []).find((a) => a.status === 'prepared' || a.status === 'approved');
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

/**
 * The exact words. In Nick's voice (it would go out as him), short, and only
 * facts NEURO holds: who, what was agreed, where. A date nobody stated is a
 * visible [placeholder], never an invention.
 */
function draftFor(actionType, commitment, target) {
  const first = String(target.displayName || '').split(/\s+/)[0] || 'there';
  const what = actionPhrase(commitment.description);
  const where = meetingPhrase(commitment);
  const subjectWhat = what.length > 60 ? `${what.slice(0, 57)}…` : what;
  if (actionType === 'draft_chase_email') {
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
  return {
    actionId: r.action_id, findingId: r.finding_id, commitmentId: r.commitment_id, actionType: r.action_type,
    target: parse(r.target_json), reason: r.reason, evidence: parse(r.evidence_json), draft: parse(r.draft_json),
    authorityClass: r.authority_class, approvalRequired: r.approval_required === 1, status: r.status,
    createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at, decisionNote: r.decision_note,
    history: parse(r.history_json) || [], updatedAt: r.updated_at,
    idempotencyKey: r.idempotency_key,
    // Said on every read, so no surface can imply otherwise.
    executes: false,
  };
}

function get(actionId) { return shape(db.get('SELECT * FROM prepared_actions WHERE action_id = ?', [actionId])); }
function forFinding(findingId) {
  return shape(db.get('SELECT * FROM prepared_actions WHERE finding_id = ? ORDER BY created_at DESC LIMIT 1', [findingId]));
}
function forCommitment(commitmentId) {
  return db.all('SELECT * FROM prepared_actions WHERE commitment_id = ? ORDER BY created_at DESC', [commitmentId]).map(shape);
}
function list({ status = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return (status && STATUSES.includes(status)
    ? db.all('SELECT * FROM prepared_actions WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, lim])
    : db.all('SELECT * FROM prepared_actions ORDER BY created_at DESC LIMIT ?', [lim])).map(shape);
}

function _transition(actionId, to, note, nowIso, allowedFrom) {
  const cur = db.get('SELECT * FROM prepared_actions WHERE action_id = ?', [actionId]);
  if (!cur) return { ok: false, code: 404, error: 'no such prepared action' };
  if (cur.status === to) return { ok: true, already: true, action: shape(cur) };
  if (!allowedFrom.includes(cur.status)) return { ok: false, code: 409, error: `it is ${cur.status}; only ${allowedFrom.join('/')} can become ${to}` };
  const history = parse(cur.history_json) || [];
  history.push({ at: nowIso, from: cur.status, to, note: note || null });
  db.run(`UPDATE prepared_actions SET status = ?, decided_at = CASE WHEN ? IN ('approved', 'rejected') THEN ? ELSE decided_at END,
            decision_note = CASE WHEN ? IN ('approved', 'rejected') THEN ? ELSE decision_note END,
            history_json = ?, updated_at = ? WHERE action_id = ?`,
  [to, to, nowIso, to, note || null, JSON.stringify(history), nowIso, actionId]);
  return { ok: true, action: get(actionId) };
}

/**
 * Nick approves. RECORDED, NOT EXECUTED — in Build 5 there is nothing that
 * could execute it. Returns the action and says so.
 */
function approve(actionId, { note = null, now = Date.now() } = {}) {
  const r = _transition(actionId, 'approved', note, new Date(now).toISOString(), ['prepared']);
  return { ...r, executed: false, notice: 'Approval recorded. Build 5 prepares only — nothing has been sent and nothing will be sent from here.' };
}

function reject(actionId, { note = null, now = Date.now() } = {}) {
  return _transition(actionId, 'rejected', note, new Date(now).toISOString(), ['prepared', 'approved']);
}

/** Age out prepared actions past their expiry, and cancel any whose finding has resolved. */
function sweep({ now = Date.now() } = {}) {
  const iso = new Date(now).toISOString();
  let expired = 0; let cancelled = 0;
  for (const r of db.all(`SELECT action_id, finding_id, expires_at FROM prepared_actions WHERE status = 'prepared'`)) {
    if (r.expires_at && r.expires_at <= iso) {
      if (_transition(r.action_id, 'expired', `not decided within ${EXPIRY_HOURS}h`, iso, ['prepared']).ok) expired += 1;
      continue;
    }
    const f = db.get('SELECT status, resolution FROM commitment_risk_findings WHERE finding_id = ?', [r.finding_id]);
    if (!f || f.status !== 'active') {
      if (_transition(r.action_id, 'cancelled', `the risk it answered resolved (${f ? f.resolution : 'finding gone'})`, iso, ['prepared']).ok) cancelled += 1;
    }
  }
  return { expired, cancelled };
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
 * evaluator pass prepares nothing new. Returns counts and every "why not".
 */
function prepareFromRisk({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const nowMs = now instanceof Date ? now.getTime() : now;
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
    // one process shouldPrepare's "already prepared/approved" check refuses a
    // duplicate first. Belt and braces, and NOT mutation-checked for that reason.
    const key = `prepared:${c.commitmentId}:${f.episode}:${decision.actionType}`;
    const actionId = `pa_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
    const draft = draftFor(decision.actionType, c, decision.target);
    const reason = decision.actionType === 'draft_chase_email'
      ? `${decision.target.displayName} owes Nick this, it is at risk (${f.why}), and nothing NEURO can see says it moved.`
      : `Nick owes ${decision.target.displayName} this, it is at risk (${f.why}), and nothing NEURO can see says it moved.`;
    const evidence = {
      finding: { findingId: f.findingId, level: f.level, confidence: f.confidence, triggers: f.triggers, summary: f.summary },
      commitment: { commitmentId: c.commitmentId, description: c.description, direction: c.direction, source: c.source, due: c.due },
      progress: { state: progress.state, reasons: progress.reasons, coverage: progress.coverage },
      target: decision.target,
    };
    const res = db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json,
              reason, evidence_json, draft_json, authority_class, approval_required, status, created_at, expires_at, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'A4', 1, 'prepared', ?, ?, ?, ?)
            ON CONFLICT(idempotency_key) DO NOTHING`,
    [actionId, key, f.findingId, c.commitmentId, decision.actionType, JSON.stringify(decision.target), reason,
      JSON.stringify(evidence), JSON.stringify(draft), iso, new Date(nowMs + EXPIRY_HOURS * 3600000).toISOString(),
      JSON.stringify([{ at: iso, from: null, to: 'prepared', note: 'prepared from a high-level commitment-risk finding' }]), iso]);
    if (res.changes) { out.prepared += 1; console.log(`[PreparedActions] prepared ${decision.actionType} → ${decision.target.displayName} (${actionId}); NOT sent`); }
    else out.existing += 1;
  }
  return out;
}

module.exports = {
  MIN_CONFIDENCE, RECENT_CHASE_DAYS, EXPIRY_HOURS, STATUSES,
  shouldPrepare, draftFor, actionPhrase,
  prepareFromRisk, approve, reject, sweep,
  get, forFinding, forCommitment, list,
};
