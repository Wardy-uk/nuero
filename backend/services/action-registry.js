'use strict';

/**
 * The action authority model and the ONE registry of action types NEURO may
 * prepare (Build 6A, 3 Oct 2026). PURE — no DB, no network, no clock.
 *
 * ── Why one registry ───────────────────────────────────────────────────────
 *
 * Before Build 6, what an action was allowed to do was implied by its NAME,
 * scattered across services: the presenter guessed "outbound" from a type
 * string, the Build 5 table refused `executed` with a trigger, and the legacy
 * approval queue (`saim_actions`) ran whatever `executeAction` had a case for.
 * Authority inferred from names is authority nobody wrote down. This file is
 * where it is written down for the governed path, and everything else asks it.
 *
 * ── Authority levels ───────────────────────────────────────────────────────
 *
 *   A0  read / investigate                      — no side effect at all
 *   A1  internal state change                   — NEURO's own tables
 *   A2  reversible local action                 — Nick's own systems, undoable
 *   A3  pre-approved low-risk external action   — leaves the building, standing consent
 *   A4  consequential external action           — leaves the building as Nick;
 *                                                 explicit approval of the EXACT payload
 *
 * ⚠ The registry is an ALLOW-LIST. A type not named here cannot be prepared,
 * approved or executed (`policyFor` answers null and every caller refuses on
 * null). Build 6 registered ONE executable type, `chase_commitment`; Build 8
 * (3 Oct 2026) adds the three outbound emails the legacy `saim_actions` queue
 * used to send with a PIN-only approve and no ledger — `reply_email`,
 * `chase_agenda`, `send_weekly_risk_report` — so that EVERY email NEURO can
 * send as Nick goes through one executor, one approval proof and one ledger.
 * No new capability was added: each of the four existed before Build 8.
 *
 * ⚠ Per-type policy, not one generic "email" policy. What differs is written
 * here, not inferred by the executor: how the draft is made (a new message, or
 * a Graph reply in the original thread), how many people it may reach, whether
 * anyone may be copied, which body format is sent, and what counts as a
 * duplicate. The executor reads these fields; it holds no type list of its own.
 *
 * ⚠ Nothing here grants authority by being present: `executable: false` types
 * can be prepared and approved (the approval is RECORDED) and nothing will
 * ever run them. The SQL triggers on `prepared_actions` repeat the executable
 * allow-list, so the database refuses what this file does not permit even if
 * a caller forgets to ask.
 */

const crypto = require('crypto');

const AUTHORITY = Object.freeze({
  A0: Object.freeze({ level: 0, label: 'Read / investigate', external: false, requiresApproval: false }),
  A1: Object.freeze({ level: 1, label: 'Internal state change', external: false, requiresApproval: false }),
  A2: Object.freeze({ level: 2, label: 'Reversible local action', external: false, requiresApproval: false }),
  A3: Object.freeze({ level: 3, label: 'Pre-approved low-risk external action', external: true, requiresApproval: false }),
  A4: Object.freeze({
    level: 4,
    label: 'Consequential external action requiring explicit approval',
    external: true,
    requiresApproval: true,
    // What an A4 executor must provide. Checked by validateRegistry() and by
    // tests, so a future A4 type cannot be registered without them.
    requirements: Object.freeze([
      'explicit approval',
      'exact target known before approval',
      'exact payload visible before approval',
      'payload immutable after approval (an edit is a new version)',
      'stable execution idempotency key',
      'execution ledger (append/audit only)',
      'separate verification of the external side effect',
      'terminal failure visible',
      'an uncertain outcome is never retried automatically',
      'complete audit history',
    ]),
  }),
});

const ACTION_TYPES = Object.freeze({
  // Ask the colleague who owes Nick something where it has got to, by email,
  // as Nick. The one thing Build 6 can do.
  chase_commitment: Object.freeze({
    type: 'chase_commitment',
    authority: 'A4',
    requiresApproval: true,
    executable: true,
    executor: 'microsoft.mail',
    verification: 'sent-items',
    channel: 'email',
    // Uncertain → verify; never resend automatically. A resend needs Nick:
    // an edit creates a new version, which needs a new approval.
    retryPolicy: 'human-review',
    uncertaintyPolicy: 'verify-only',
    approvalTtlHours: 24,
    preparedTtlHours: 72,
    maxRecipients: 1,
    targetIsRecipient: true,
    cc: false,
    attachments: false,
    sendMode: 'new-message',
    bodyFormat: 'text',
    duplicate: 'one live chase per (commitment, person); none within 7 days of a verified one',
    preparation: 'a high commitment-risk finding with no progress evidence, or the Chase button — unambiguous person, one address',
    execution: 'commitment still open, no progress, same person and address, not snoozed/deferred/chased since, Nick has not emailed them since',
    label: 'Chase a commitment by email',
  }),
  // Build 8C. A reply IN THE ORIGINAL THREAD, as Nick. The highest-risk type:
  // the recipients vary, the words are conversational, and replying to the
  // wrong person or thread is consequential. So the exact recipients — to AND
  // cc — are resolved when it is PREPARED and bound into the approval; Graph is
  // never left to pick them. Sources: Nick's own words in the Inbox composer,
  // or a model draft from the legacy `draft_reply` card (gate 1), which now
  // prepares one of these instead of queueing a PIN-approvable send.
  reply_email: Object.freeze({
    type: 'reply_email',
    authority: 'A4',
    requiresApproval: true,
    executable: true,
    executor: 'microsoft.mail',
    verification: 'sent-items',
    channel: 'email',
    retryPolicy: 'human-review',
    uncertaintyPolicy: 'verify-only',
    approvalTtlHours: 24,
    preparedTtlHours: 72,
    maxRecipients: 25,
    targetIsRecipient: false,
    cc: true,
    attachments: false,
    sendMode: 'reply',
    bodyFormat: 'text',
    duplicate: 'one live reply per source email; none once a reply to that email has gone since it was prepared',
    preparation: 'Nick\'s words from the Inbox composer, or an approved draft_reply; recipients resolved from the original message',
    execution: 'original message still exists in the same thread from the same sender, no reply already sent in that thread since it was prepared',
    label: 'Reply to an email',
  }),
  // Build 8D. Ask a meeting organiser what the meeting is for (Nick's 14 Aug
  // policy: any meeting with no agenda or outcome gets one polite request).
  // A new email, one recipient: the organiser.
  chase_agenda: Object.freeze({
    type: 'chase_agenda',
    authority: 'A4',
    requiresApproval: true,
    executable: true,
    executor: 'microsoft.mail',
    verification: 'sent-items',
    channel: 'email',
    retryPolicy: 'human-review',
    uncertaintyPolicy: 'verify-only',
    approvalTtlHours: 24,
    preparedTtlHours: 72,
    maxRecipients: 1,
    targetIsRecipient: true,
    cc: false,
    attachments: false,
    sendMode: 'new-message',
    bodyFormat: 'text',
    duplicate: 'one chase per meeting, ever — a second ask is worse than none',
    preparation: 'meeting-triage.assess says the invite carries no agenda or outcome; organiser address known',
    execution: 'meeting still exists, not cancelled, more than 2 hours away, same organiser, Nick has not responded, still no agenda, Nick has not written to the organiser about it since',
    label: 'Ask a meeting organiser for the agenda',
  }),
  // Build 8E. The PIP's Monday report to Chris. Generating the report stays
  // automated; SENDING it is this action. The approved artefact is FROZEN in
  // the row (markdown Nick reads + the exact HTML that is sent, both hashed),
  // so a regenerated report can never ride an earlier approval: a newer
  // version supersedes (or, if already approved, expires) the old one.
  send_weekly_risk_report: Object.freeze({
    type: 'send_weekly_risk_report',
    authority: 'A4',
    requiresApproval: true,
    executable: true,
    executor: 'microsoft.mail',
    verification: 'sent-items',
    channel: 'email',
    retryPolicy: 'human-review',
    uncertaintyPolicy: 'verify-only',
    approvalTtlHours: 24,
    preparedTtlHours: 72,
    maxRecipients: 1,
    targetIsRecipient: true,
    cc: false,
    attachments: false,
    sendMode: 'new-message',
    bodyFormat: 'html',
    editable: false,
    notEditableWhy: 'the report is generated — change it on the Weekly Risk panel and queue it again, which prepares a new version',
    duplicate: 'one live send per report week; the week must not already be recorded as sent',
    preparation: 'the Weekly Risk panel\'s Queue send: finished report, a resolved single recipient',
    execution: 'week not already sent, no newer version of the report prepared, same recipient, Nick has not sent it by hand since',
    label: 'Send the weekly risk report',
  }),
  // A holding note to someone Nick owes. Prepared and approvable since Build 5,
  // NOT executable: its draft carries a [date] only Nick can fill, and Build 6
  // ships one executor. Approving it records the decision and sends nothing.
  draft_update_email: Object.freeze({
    type: 'draft_update_email',
    authority: 'A4',
    requiresApproval: true,
    executable: false,
    executor: null,
    verification: null,
    channel: 'email',
    retryPolicy: 'human-review',
    approvalTtlHours: 24,
    label: 'Holding note to someone you owe (prepare-only)',
    notExecutableWhy: 'prepare-only in Build 6 — only chase_commitment has an executor',
  }),
  // The Build 5 name for the chase. Rows prepared under it were approved on the
  // stated terms that NOTHING would be sent, so they must never execute now
  // that something can: an approval binds to the terms it was given under.
  draft_chase_email: Object.freeze({
    type: 'draft_chase_email',
    authority: 'A4',
    requiresApproval: true,
    executable: false,
    executor: null,
    verification: null,
    channel: 'email',
    retryPolicy: 'human-review',
    approvalTtlHours: 24,
    label: 'Chase (Build 5, prepare-only)',
    notExecutableWhy: 'prepared under Build 5, whose approval terms were "nothing is sent" — it never executes',
  }),
});

// The only executor names that exist. An executable type naming anything else
// fails validateRegistry(), and the executor refuses an unknown name.
const EXECUTORS = Object.freeze(['microsoft.mail']);
const SEND_MODES = Object.freeze(['new-message', 'reply']);
const BODY_FORMATS = Object.freeze(['text', 'html']);

function policyFor(type) {
  return Object.prototype.hasOwnProperty.call(ACTION_TYPES, type) ? ACTION_TYPES[type] : null;
}

function isRegistered(type) { return policyFor(type) !== null; }

function canExecute(type) {
  const p = policyFor(type);
  return !!(p && p.executable && EXECUTORS.includes(p.executor));
}

function executableTypes() {
  return Object.keys(ACTION_TYPES).filter(canExecute);
}

/** Every rule an entry must satisfy. Returns a list of problems; empty = valid. */
function validateRegistry(types = ACTION_TYPES) {
  const problems = [];
  for (const [key, p] of Object.entries(types)) {
    if (p.type !== key) problems.push(`${key}: type field does not match its key`);
    if (!AUTHORITY[p.authority]) problems.push(`${key}: unknown authority ${p.authority}`);
    if (AUTHORITY[p.authority] && AUTHORITY[p.authority].requiresApproval && p.requiresApproval !== true) {
      problems.push(`${key}: ${p.authority} requires approval`);
    }
    if (p.executable) {
      if (!EXECUTORS.includes(p.executor)) problems.push(`${key}: executable with unknown executor ${p.executor}`);
      if (!p.verification) problems.push(`${key}: executable with no verification`);
      if (p.authority === 'A4' && p.retryPolicy !== 'human-review') problems.push(`${key}: A4 must not retry automatically`);
      // Build 8: every executable type states HOW it sends and what a duplicate
      // is — the executor reads these, so an entry missing one cannot run.
      if (!SEND_MODES.includes(p.sendMode)) problems.push(`${key}: executable with unknown sendMode ${p.sendMode}`);
      if (!BODY_FORMATS.includes(p.bodyFormat)) problems.push(`${key}: executable with unknown bodyFormat ${p.bodyFormat}`);
      if (!(Number(p.maxRecipients) >= 1)) problems.push(`${key}: executable with no recipient limit`);
      if (!p.duplicate) problems.push(`${key}: executable with no duplicate rule`);
      if (p.authority === 'A4' && p.uncertaintyPolicy !== 'verify-only') problems.push(`${key}: A4 uncertainty must be verify-only`);
    }
  }
  return problems;
}

// ── payload identity ──────────────────────────────────────────────────────

/** Stable JSON: keys sorted at every level, so equal content gives equal text. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The hash an approval binds to: WHAT is sent, to WHOM, as which version of
 * which action. Recipients are lower-cased so a case difference is not a
 * different person; subject and body are exact, because a changed word is a
 * changed message.
 */
function payloadHash({ actionType, version, commitmentId, target, draft }) {
  const to = ((draft && draft.to) || []).map((r) => String((r && r.email) || '').trim().toLowerCase());
  const bind = bindFor(actionType, target, draft);
  return sha256(canonical({
    actionType,
    version: Number(version) || 1,
    commitmentId,
    targetPersonId: (target && target.personId) || null,
    targetEmail: String((target && target.email) || '').trim().toLowerCase(),
    to,
    cc: ((draft && draft.cc) || []).map((r) => String((r && r.email) || '').toLowerCase()),
    subject: (draft && draft.subject) || '',
    body: (draft && draft.body) || '',
    // Omitted entirely when null, so a chase_commitment hashes exactly as it
    // did in Builds 6–7 (canonical() drops undefined keys).
    bind: bind || undefined,
  }));
}

/**
 * What else an approval must bind for a type, beyond who/subject/body — always
 * DERIVED from the stored target and draft, never stored itself, so tampering
 * with any of it changes the recomputed hash and the executor refuses.
 *
 *   reply_email             the source message, its thread, and reply vs reply-all
 *   chase_agenda            the meeting and the start it was asked about
 *   send_weekly_risk_report the week, the report version Nick read, and the
 *                           EXACT HTML that is sent (hashed)
 */
function bindFor(actionType, target, draft) {
  const t = target || {};
  const d = draft || {};
  if (actionType === 'reply_email') {
    return { emailId: t.emailId || null, conversationId: t.conversationId || null, mode: d.mode || 'reply' };
  }
  if (actionType === 'chase_agenda') return { eventId: t.eventId || null, start: t.start || null };
  if (actionType === 'send_weekly_risk_report') {
    return { week: t.week || null, reportVersion: t.reportVersion || null, htmlHash: d.html ? sha256(String(d.html)) : null };
  }
  return null;
}

/** Hash of the evidence Nick was shown. Recorded with the approval as a snapshot reference. */
function evidenceHash(evidence) { return sha256(canonical(evidence || null)); }

// A visible placeholder NEURO could not fill ("[date]"). A body still carrying
// one is not a message anybody should send.
const PLACEHOLDER_RE = /\[(date|name|when|time|details?)\]/i;
function hasUnfilledPlaceholder(body) { return PLACEHOLDER_RE.test(String(body || '')); }

module.exports = {
  AUTHORITY, ACTION_TYPES, EXECUTORS, SEND_MODES, BODY_FORMATS,
  policyFor, isRegistered, canExecute, executableTypes, validateRegistry,
  canonical, payloadHash, bindFor, evidenceHash, hasUnfilledPlaceholder, sha256,
};
