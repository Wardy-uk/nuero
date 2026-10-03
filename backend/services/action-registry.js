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
 * null). Build 6 registers exactly ONE executable type, `chase_commitment`.
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
    approvalTtlHours: 24,
    maxRecipients: 1,
    cc: false,
    attachments: false,
    label: 'Chase a commitment by email',
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
  }));
}

/** Hash of the evidence Nick was shown. Recorded with the approval as a snapshot reference. */
function evidenceHash(evidence) { return sha256(canonical(evidence || null)); }

// A visible placeholder NEURO could not fill ("[date]"). A body still carrying
// one is not a message anybody should send.
const PLACEHOLDER_RE = /\[(date|name|when|time|details?)\]/i;
function hasUnfilledPlaceholder(body) { return PLACEHOLDER_RE.test(String(body || '')); }

module.exports = {
  AUTHORITY, ACTION_TYPES, EXECUTORS,
  policyFor, isRegistered, canExecute, executableTypes, validateRegistry,
  canonical, payloadHash, evidenceHash, hasUnfilledPlaceholder,
};
