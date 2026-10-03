'use strict';

/**
 * The approval-gated executor (Build 6C–6G, 3 Oct 2026).
 *
 *   OBSERVE → UNDERSTAND → JUDGE → PREPARE → APPROVE → EXECUTE → VERIFY
 *                                                      ^^^^^^^^^^^^^^^^^ here
 *
 * The first and only path in NEURO's governed pipeline that creates an external
 * side effect, and only for a type the registry marks executable (Build 6:
 * `chase_commitment`, by Microsoft email). There is no generic "run this
 * action" door: `EXECUTORS` holds one function, and a type naming anything else
 * is refused before a provider is touched.
 *
 * ── Execution, in order ────────────────────────────────────────────────────
 *
 *   1. PREFLIGHT, repeated at execution time even though preparation and
 *      approval already checked: the approval binds this exact payload hash and
 *      has not expired; the commitment is still open; progress does not say it
 *      is done; the target still resolves to the same person and the same
 *      single address; not snoozed / deferred; not chased by any route since it
 *      was prepared; no other governed chase for it in flight; and Nick has not
 *      emailed that person since it was prepared (a LIVE Sent Items read).
 *      A world that moved CANCELS the action; a check that could not be made
 *      leaves it approved, to be tried again, until the approval expires.
 *   2. CLAIM — one synchronous transaction: approved → executing (conditional
 *      on the status) plus an attempt row whose `execution_key` is UNIQUE per
 *      approved version. A double approval, a double click, two workers or two
 *      processes all reach this, and exactly one wins.
 *   3. DRAFT — create the message as a draft. Nothing is sent. The provider
 *      returns its internetMessageId, which is WRITTEN TO THE LEDGER before the
 *      send is requested.
 *   4. SEND the draft. 202 → `executed` (transport evidence, NOT verification).
 *      A definitive refusal → `failed`, proven unsent. Anything else — timeout,
 *      network, 5xx, 429 — → `execution_uncertain`, and it is NEVER resent.
 *   5. VERIFY — find that internetMessageId in Sent Items and check sender,
 *      recipient, subject and time. Only that makes it `verified`.
 *
 * ── What it never does ─────────────────────────────────────────────────────
 *
 *   • send without an approval that matches the payload (and the SQL triggers
 *     refuse the state change even if this code were wrong)
 *   • resend automatically: one attempt per approved version, enforced by a
 *     UNIQUE key; a resend needs Nick to edit (a new version) and approve again
 *   • push a notification: failures and uncertainty surface in State of Play;
 *     the attention engine remains the only interruption authority
 *   • complete the commitment: chasing is not finishing; the commitment stays
 *     owned by its authoritative source
 *   • log or publish content: ids and statuses only
 */

const crypto = require('crypto');
const db = require('../db/database');
const registry = require('./action-registry');
const pa = require('./prepared-actions');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STALE_EXECUTING_MS = 5 * MINUTE;   // a claim older than this, not running here, was interrupted
const SETTLE_MS = 15 * MINUTE;           // an uncertain send still a draft after this never went
const VERIFY_GIVE_UP_MS = DAY;           // accepted but never seen in Sent Items → uncertain, for Nick
const VERIFY_WINDOW_MS = 7 * DAY;        // stop polling Sent Items after this; it stays surfaced
const VERIFY_INTERVAL_MS = 90 * 1000;    // minimum gap between checks of one action
const CLOCK_SKEW_MS = 5 * MINUTE;

const BOOT_ID = crypto.randomUUID();
const inFlight = new Set();

const iso = (ms) => new Date(ms).toISOString();
const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now());
const lc = (s) => String(s || '').trim().toLowerCase();
const shortHash = (s) => (s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16) : null);
const normBody = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// ── dependencies (injectable for tests) ─────────────────────────────────────

const DEFAULT_DEPS = {
  mail: () => require('./action-mail'),
  enabled: () => require('./feature-flags').isEnabled('governed_execution'),
  commitment: (id) => require('./world-obligations').getCommitment(id),
  progress: (id) => require('./progress-evidence').progressFor(id),
  counterparty: (c) => pa.counterpartyFor(c),
  waiting: (key) => {
    const r = db.get('SELECT status, asked_at, snoozed_until FROM waiting_on WHERE key = ?', [key]);
    return r ? { status: r.status, askedAt: r.asked_at, snoozedUntil: r.snoozed_until } : null;
  },
  // true / false, or null when the decision store could not be read.
  deferred: (c) => {
    try {
      const lc2 = require('./attention-lifecycle');
      return !!lc2.deferredKeys().get(lc2.dedupeKeyFor({ type: 'todo', title: c.description }));
    } catch { return null; }
  },
  markChased: (key, nowMs) => require('./waiting-on').markChased(key, { now: nowMs }),
};

function _deps(over) {
  if (over && over.mailApi) return over; // already resolved
  const d = { ...DEFAULT_DEPS, ...(over || {}) };
  return { ...d, mailApi: typeof d.mail === 'function' ? d.mail() : d.mail };
}

const waitingKey = (subjectRef) => (String(subjectRef || '').startsWith('waiting-on:') ? subjectRef.slice('waiting-on:'.length) : null);

// ── preflight (PURE) ────────────────────────────────────────────────────────

/**
 * Every safety-critical check, repeated at execution. PURE.
 * Returns { ok: true } or { ok: false, code, why, terminal }.
 * `terminal: true` — the world moved; cancel. `false` — could not check; wait.
 */
function executionChecks({ action, policy, commitment, progress, person, waiting, deferred, otherLive, nowMs }) {
  const stop = (code, why, terminal = true) => ({ ok: false, code, why, terminal });
  if (!policy || !policy.executable) return stop('not-executable', `${action.actionType} is not executable`);
  const ap = action.approval;
  if (!ap || !ap.payloadHash) return stop('not-approved', 'there is no approval on record');
  if (ap.payloadHash !== action.payloadHash) return stop('approval-mismatch', 'the approval does not match this payload');
  const recomputed = registry.payloadHash({ actionType: action.actionType, version: action.version,
    commitmentId: action.commitmentId, target: action.target, draft: action.draft });
  if (recomputed !== action.payloadHash) return stop('payload-tampered', 'the stored payload no longer matches the hash that was approved');
  if (!ap.expiresAt || !(Date.parse(ap.expiresAt) > nowMs)) return stop('approval-expired', 'the approval expired before it could run — nothing was sent');

  const draft = action.draft || {};
  const target = action.target || {};
  const to = Array.isArray(draft.to) ? draft.to : [];
  if (to.length !== 1 || to.length > (policy.maxRecipients || 1) || lc(to[0].email) !== lc(target.email) || !lc(target.email)) {
    return stop('recipient-mismatch', 'the draft must go to exactly the one person it was prepared for');
  }
  if ((Array.isArray(draft.cc) && draft.cc.length) || (Array.isArray(draft.bcc) && draft.bcc.length)) return stop('cc-not-allowed', 'nobody is copied in Build 6');
  if (registry.hasUnfilledPlaceholder(draft.body) || registry.hasUnfilledPlaceholder(draft.subject)) return stop('placeholder', 'the draft still carries a [placeholder]');

  if (!commitment) return stop('commitment-gone', 'the commitment no longer exists');
  if (commitment.status !== 'open') return stop('commitment-closed', `the commitment is ${commitment.status} — nothing to chase`);
  if (!progress || progress.state === 'unknown') return stop('progress-unknown', 'could not read whether it has moved — not sending over an unknown', false);
  if (['fulfilled', 'closed', 'likely_fulfilled'].includes(progress.state)) {
    return stop('likely-done', `progress is ${progress.state} (${(progress.reasons || []).join('; ')}) — a chase now would ask about something already done`);
  }

  if (!person || !person.personId) return stop('target-unresolved', 'the person no longer resolves');
  if (person.personId !== target.personId) return stop('target-changed', 'the commitment now points at a different person');
  if (!pa.ACCEPTED_TARGET_METHODS.has(person.method)) return stop('target-ambiguous', `the person now resolves only by ${person.method}`);
  const emails = Array.isArray(person.emails) ? person.emails : [];
  if (emails.length !== 1) return stop('target-address-ambiguous', `the person now has ${emails.length} addresses`);
  if (lc(emails[0]) !== lc(target.email)) return stop('target-address-changed', 'the person\'s address changed since approval');

  if (waiting) {
    if (waiting.status && waiting.status !== 'open') return stop('waiting-closed', `the waiting-on item is ${waiting.status}`);
    if (waiting.snoozedUntil && Date.parse(waiting.snoozedUntil) > nowMs) return stop('snoozed', `snoozed until ${String(waiting.snoozedUntil).slice(0, 10)}`);
    if (waiting.askedAt) {
      const t = Date.parse(String(waiting.askedAt).replace(' ', 'T'));
      if (Number.isFinite(t) && t > Date.parse(action.createdAt)) return stop('chased-elsewhere', 'they were chased by another route after this was prepared');
      if (Number.isFinite(t) && nowMs - t < pa.RECENT_CHASE_DAYS * DAY) return stop('chased-recently', `chased ${Math.floor((nowMs - t) / DAY)} day(s) ago`);
    }
  }
  if (deferred === null) return stop('deferral-unknown', 'could not read Nick\'s "not today" decisions', false);
  if (deferred) return stop('deferred', 'Nick deferred it "not today"');
  if (otherLive) return stop('duplicate', `another chase for this (${otherLive.action_id}) is already ${otherLive.status}`);
  return { ok: true };
}

function _otherLive(action, nowMs) {
  if (!action.subjectRef) return null;
  return db.get(`SELECT action_id, status FROM prepared_actions WHERE subject_ref = ? AND action_id <> ? AND action_type = 'chase_commitment'
                 AND (status IN ('executing', 'execution_uncertain', 'executed') OR (status = 'verified' AND verified_at >= ?))
                 LIMIT 1`, [action.subjectRef, action.actionId, iso(nowMs - pa.RECENT_CHASE_DAYS * DAY)]);
}

async function preflight(action, policy, d, nowMs) {
  const commitment = d.commitment(action.commitmentId);
  let progress = null;
  try { progress = commitment ? d.progress(action.commitmentId) : null; } catch { progress = null; }
  const person = commitment ? d.counterparty(commitment) : null;
  const key = waitingKey(action.subjectRef);
  const sync = executionChecks({
    action, policy, commitment, progress, person,
    waiting: key ? d.waiting(key) : null,
    deferred: commitment ? d.deferred(commitment) : false,
    otherLive: _otherLive(action, nowMs),
    nowMs,
  });
  if (!sync.ok) return sync;
  // LIVE: has Nick emailed them since this was prepared? Progress evidence is a
  // periodic scan; a message sent five minutes ago would not be in it yet.
  const sent = await d.mailApi.sentToSince(action.target.email, action.createdAt);
  if (!sent) return { ok: false, code: 'sent-mail-unreadable', why: 'could not read Sent Items to check you have not already written to them', terminal: false };
  if (sent.count > 0) return { ok: false, code: 'already-emailed', why: `you have emailed ${action.target.displayName || 'them'} since this was prepared — not sending; review it`, terminal: true };
  return { ok: true };
}

// ── the ledger ──────────────────────────────────────────────────────────────

function _openAttempt(actionId) {
  return db.get('SELECT * FROM action_attempts WHERE action_id = ? AND finished_at IS NULL', [actionId]);
}
function _latestAttempt(actionId) {
  return db.get('SELECT * FROM action_attempts WHERE action_id = ? ORDER BY attempt DESC LIMIT 1', [actionId]);
}
function attemptsFor(actionId) {
  return db.all('SELECT * FROM action_attempts WHERE action_id = ? ORDER BY attempt', [actionId]).map((r) => ({
    attemptId: r.attempt_id, attempt: r.attempt, executionKey: r.execution_key, startedAt: r.started_at,
    draftId: r.draft_id, internetMessageId: r.internet_message_id, draftCreatedAt: r.draft_created_at,
    sendRequestedAt: r.send_requested_at, sendHttpStatus: r.send_http_status, sendOutcome: r.send_outcome,
    errorCategory: r.error_category, errorDetail: r.error_detail, retrySafe: r.retry_safe === null ? null : r.retry_safe === 1,
    finishedAt: r.finished_at, finalState: r.final_state,
  }));
}
function verificationsFor(actionId) {
  return db.all('SELECT * FROM action_verifications WHERE action_id = ? ORDER BY id', [actionId]).map((r) => ({
    id: r.id, attemptId: r.attempt_id, checkedAt: r.checked_at, outcome: r.outcome, proof: JSON.parse(r.proof_json),
  }));
}

function _attemptSet(attemptId, cols) {
  const keys = Object.keys(cols);
  db.run(`UPDATE action_attempts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE attempt_id = ? AND finished_at IS NULL`,
    [...keys.map((k) => cols[k]), attemptId]);
}
function _attemptFinish(attemptId, cols, nowMs) { _attemptSet(attemptId, { ...cols, finished_at: iso(nowMs) }); }

/**
 * The claim: approved → executing plus the attempt row, atomically. Returns the
 * attempt, or null when another caller already holds (or ever held) it.
 */
function _claim(action, nowMs) {
  const key = `exec:${action.actionId}:${action.payloadHash}`;
  try {
    return db.batchSaves(() => {
      if (db.get('SELECT 1 FROM action_attempts WHERE execution_key = ?', [key])) return null;
      const n = db.get('SELECT COALESCE(MAX(attempt), 0) n FROM action_attempts WHERE action_id = ?', [action.actionId]).n + 1;
      const t = pa.transition(action.actionId, 'executing', { now: nowMs, allowedFrom: ['approved'], note: `attempt ${n}`, eventExtra: { attempt: n } });
      if (!t.ok || t.already) return null;
      const attemptId = `${action.actionId}#${n}`;
      db.run(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at)
              VALUES (?, ?, ?, ?, ?, ?)`, [attemptId, action.actionId, n, key, BOOT_ID, iso(nowMs)]);
      return { attemptId, attempt: n, executionKey: key };
    });
  } catch (e) {
    // A UNIQUE collision (two processes) rolls the whole claim back.
    console.warn(`[Executor] claim of ${action.actionId} refused: ${e.message}`);
    return null;
  }
}

function _recordChase(actionId, d, nowMs) {
  const a = pa.get(actionId);
  if (!a || !waitingKey(a.subjectRef)) return;
  const row = db.get('SELECT chase_recorded_at FROM prepared_actions WHERE action_id = ?', [actionId]);
  if (row && row.chase_recorded_at) return;
  try {
    d.markChased(waitingKey(a.subjectRef), nowMs);
    pa.note(actionId, { chase_recorded_at: iso(nowMs) });
  } catch (e) { console.warn(`[Executor] could not record the chase for ${actionId}: ${e.message}`); }
}

// ── the one executor ────────────────────────────────────────────────────────

async function _mailExecutor(action, claim, d, clock) {
  const id = action.actionId;
  const mail = d.mailApi;
  const failBeforeSend = (category, detail, status = null) => {
    const now = clock();
    _attemptFinish(claim.attemptId, { error_category: category, error_detail: detail, send_http_status: status, retry_safe: 1, final_state: 'failed' }, now);
    const t = pa.transition(id, 'failed', { now, allowedFrom: ['executing'], note: detail,
      set: { retry_safe: 1, outcome_detail: `${detail} — nothing was sent` }, eventExtra: { attempt: claim.attempt, code: category } });
    console.log(`[Executor] ${id} failed before sending (${category}); nothing sent`);
    return { ok: false, status: 'failed', code: category, detail: `${detail} — nothing was sent`, action: t.action };
  };

  // 3. DRAFT — nothing is sent by this.
  const dr = await mail.createDraft({
    to: [{ email: action.target.email, name: action.target.displayName }],
    subject: action.draft.subject,
    body: action.draft.body,
  });
  if (!dr.ok) return failBeforeSend(dr.category || 'unknown', 'Microsoft would not create the draft', dr.status);
  if (!dr.id || !dr.internetMessageId) {
    if (dr.id) _attemptSet(claim.attemptId, { draft_id: dr.id });
    try { if (dr.id) await mail.deleteDraft(dr.id); } catch { /* best effort */ }
    return failBeforeSend('no-handle', 'Microsoft returned no message id to verify against');
  }
  // ⚠ The handle reaches the ledger BEFORE the send is requested. This is what
  // makes every later outcome verifiable, including this process dying mid-send.
  _attemptSet(claim.attemptId, { draft_id: dr.id, internet_message_id: dr.internetMessageId, draft_created_at: iso(clock()) });
  _attemptSet(claim.attemptId, { send_requested_at: iso(clock()) });

  // 4. SEND.
  const s = await mail.sendDraft(dr.id);
  const now = clock();
  if (s.outcome === 'accepted') {
    _attemptFinish(claim.attemptId, { send_outcome: 'accepted', send_http_status: s.status, retry_safe: 0, final_state: 'executed' }, now);
    pa.transition(id, 'executed', { now, allowedFrom: ['executing'], note: `Microsoft accepted the send (HTTP ${s.status}) — verifying`,
      set: { executed_at: iso(now), retry_safe: 0 }, eventExtra: { attempt: claim.attempt, messageRef: shortHash(dr.internetMessageId) } });
    _recordChase(id, d, now);
    console.log(`[Executor] ${id} executed (accepted by Microsoft); verifying in Sent Items`);
  } else if (s.outcome === 'rejected') {
    _attemptFinish(claim.attemptId, { send_outcome: 'rejected', send_http_status: s.status, error_category: s.category || null,
      error_detail: 'Microsoft refused the send', retry_safe: 1, final_state: 'failed' }, now);
    pa.transition(id, 'failed', { now, allowedFrom: ['executing'], note: `Microsoft refused the send (${s.category || s.status})`,
      set: { retry_safe: 1, outcome_detail: `Microsoft refused the send (${s.category || `HTTP ${s.status}`}) — nothing was sent` },
      eventExtra: { attempt: claim.attempt, code: s.category || `http_${s.status}` } });
    try { await mail.deleteDraft(dr.id); } catch { /* best effort */ }
    console.log(`[Executor] ${id} failed: send refused (${s.category || s.status}); nothing sent`);
    return { ok: false, status: 'failed', code: s.category || 'refused', detail: 'Microsoft refused the send — nothing was sent', action: pa.get(id) };
  } else {
    _attemptFinish(claim.attemptId, { send_outcome: 'uncertain', send_http_status: s.status, error_category: s.category || 'unknown',
      error_detail: 'no definite answer from Microsoft', retry_safe: 0, final_state: 'execution_uncertain' }, now);
    pa.transition(id, 'execution_uncertain', { now, allowedFrom: ['executing'], note: `no definite answer (${s.category || s.status}) — verifying, never resending`,
      set: { retry_safe: 0, outcome_detail: 'Microsoft gave no definite answer, so it may have been sent. NEURO is checking Sent Items and will NOT resend it.' },
      eventExtra: { attempt: claim.attempt, code: s.category || 'unknown', messageRef: shortHash(dr.internetMessageId) } });
    console.log(`[Executor] ${id} execution uncertain (${s.category || s.status}); verifying, will not resend`);
  }

  // 5. VERIFY now; the reconciler keeps checking if this first look is early.
  try { await verify(id, { now: clock(), deps: d }); } catch (e) { console.warn(`[Executor] verify ${id}: ${e.message}`); }
  const after = pa.get(id);
  return { ok: ['executed', 'verified', 'execution_uncertain'].includes(after.status), status: after.status, detail: after.outcomeDetail, action: after };
}

const EXECUTORS = Object.freeze({ 'microsoft.mail': _mailExecutor });

/**
 * Execute ONE approved action. Idempotent: anything but `approved` returns
 * `already`; the claim lets exactly one caller through.
 */
async function execute(actionId, { now, deps } = {}) {
  const d = _deps(deps);
  const clock = () => (now !== undefined ? msOf(now) : Date.now());
  if (inFlight.has(actionId)) return { ok: true, already: true, status: 'executing', detail: 'already running' };
  const action = pa.get(actionId);
  if (!action) return { ok: false, code: 'not-found', detail: 'no such prepared action' };
  if (action.status !== 'approved') return { ok: true, already: true, status: action.status, action };
  const policy = registry.policyFor(action.actionType);
  if (!policy || !registry.canExecute(action.actionType)) {
    return { ok: false, code: 'not-executable', status: action.status, detail: policy ? policy.notExecutableWhy : 'not a registered action type' };
  }
  const run = EXECUTORS[policy.executor];
  if (!run) return { ok: false, code: 'no-executor', status: action.status, detail: `no executor named ${policy.executor}` };
  if (!d.enabled()) {
    pa.note(actionId, { last_block: 'sending is switched off (Settings → Switches → "Send a chase once you approve it")' });
    return { ok: false, code: 'switched-off', transient: true, status: 'approved', detail: 'Approved, but sending is switched off — nothing was sent.' };
  }

  inFlight.add(actionId);
  try {
    const pre = await preflight(action, policy, d, clock());
    if (!pre.ok) {
      if (pre.terminal) {
        const to = pre.code === 'approval-expired' ? 'expired' : 'cancelled';
        const t = pa.transition(actionId, to, { now: clock(), allowedFrom: ['approved'], note: pre.why,
          set: { retry_safe: 1, outcome_detail: `${pre.why} — nothing was sent` }, eventExtra: { code: pre.code } });
        console.log(`[Executor] ${actionId} ${to} at execution (${pre.code}); nothing sent`);
        return { ok: false, code: pre.code, status: t.action ? t.action.status : to, detail: `${pre.why} — nothing was sent`, action: t.action };
      }
      pa.note(actionId, { last_block: pre.why });
      return { ok: false, code: pre.code, transient: true, status: 'approved', detail: `${pre.why}. It stays approved and NEURO will try again; nothing was sent.` };
    }
    const claim = _claim(action, clock());
    if (!claim) return { ok: true, already: true, status: pa.get(actionId).status };
    console.log(`[Executor] ${actionId} claimed (attempt ${claim.attempt})`);
    return await run(pa.get(actionId), claim, d, clock);
  } finally {
    inFlight.delete(actionId);
  }
}

// ── verification (6F) ───────────────────────────────────────────────────────

/** Does this Sent Items message match what was approved? PURE. */
function judgeSentItem(m, { action, attempt, signedIn }) {
  const target = lc(action.target && action.target.email);
  const started = Date.parse(attempt.started_at || attempt.startedAt);
  const sent = Date.parse(m.sentAt);
  const checks = {
    messageId: lc(m.internetMessageId) === lc(attempt.internet_message_id || attempt.internetMessageId),
    recipient: Array.isArray(m.to) && m.to.length === 1 && lc(m.to[0]) === target,
    noCopies: !(m.cc && m.cc.length) && !(m.bcc && m.bcc.length),
    subject: (m.subject || '') === (action.draft && action.draft.subject),
    time: Number.isFinite(sent) && Number.isFinite(started) && sent >= started - CLOCK_SKEW_MS,
    sender: signedIn ? lc(m.from) === lc(signedIn) : null,
    // Recorded, not required: the message id is the identity. A server-side
    // disclaimer would change the body without changing which message it is.
    body: m.bodyText === null || m.bodyText === undefined ? null : normBody(m.bodyText).startsWith(normBody(action.draft && action.draft.body)),
  };
  const required = ['messageId', 'recipient', 'noCopies', 'subject', 'time'];
  const ok = required.every((k) => checks[k] === true) && checks.sender !== false;
  return { ok, checks };
}

function _recordVerification(action, attempt, outcome, proof, nowMs) {
  const last = db.get('SELECT outcome, proof_json FROM action_verifications WHERE attempt_id = ? ORDER BY id DESC LIMIT 1', [attempt.attempt_id]);
  pa.note(action.actionId, { last_check_at: iso(nowMs) });
  // Append when the ANSWER changed; an identical repeat only touches last_check_at.
  if (last && last.outcome === outcome) return false;
  db.run('INSERT INTO action_verifications (action_id, attempt_id, checked_at, outcome, proof_json) VALUES (?, ?, ?, ?, ?)',
    [action.actionId, attempt.attempt_id, iso(nowMs), outcome, JSON.stringify(proof)]);
  return true;
}

/**
 * Verify one executed / uncertain action against Sent Items. NEVER sends.
 * Outcomes: verified | not_found | ambiguous | provider_unavailable.
 */
async function verify(actionId, { now, deps } = {}) {
  const d = _deps(deps);
  const nowMs = now !== undefined ? msOf(now) : Date.now();
  const action = pa.get(actionId);
  if (!action) return { outcome: null, detail: 'no such action' };
  if (!['executed', 'execution_uncertain'].includes(action.status)) return { outcome: null, already: true, status: action.status };
  const attempt = _latestAttempt(actionId);
  if (!attempt || !attempt.internet_message_id) {
    if (action.status === 'executed') {
      pa.transition(actionId, 'execution_uncertain', { now: nowMs, allowedFrom: ['executed'], note: 'no message id on record to verify against',
        set: { outcome_detail: 'There is no message id on record to check Sent Items against. Review it in Outlook; it will not be resent.' } });
    }
    return { outcome: 'ambiguous', detail: 'no verification handle' };
  }

  const mail = d.mailApi;
  const proof = { attemptId: attempt.attempt_id, messageRef: shortHash(attempt.internet_message_id) };
  const found = await mail.findSent(attempt.internet_message_id);
  let outcome;
  if (!found || !found.ok) {
    outcome = 'provider_unavailable';
    proof.category = (found && found.category) || 'unavailable';
  } else if (found.messages.length === 0) {
    outcome = 'not_found';
  } else if (found.messages.length > 1) {
    outcome = 'ambiguous';
    proof.count = found.messages.length;
  } else {
    const signedIn = await mail.signedInAddress();
    const j = judgeSentItem(found.messages[0], { action, attempt, signedIn });
    proof.checks = j.checks;
    proof.sentItemId = found.messages[0].id || null;
    outcome = j.ok ? 'verified' : 'ambiguous';
  }

  if (outcome === 'not_found' && attempt.draft_id) {
    try { proof.draftState = await mail.draftState(attempt.draft_id); } catch { proof.draftState = 'unavailable'; }
  }
  _recordVerification(action, attempt, outcome, proof, nowMs);

  if (outcome === 'verified') {
    pa.transition(actionId, 'verified', { now: nowMs, allowedFrom: ['executed', 'execution_uncertain'],
      note: 'found in Sent Items: right recipient, subject and time',
      set: { verified_at: iso(nowMs), retry_safe: 0, outcome_detail: 'Sent, and confirmed in Sent Items.' },
      eventExtra: { attempt: attempt.attempt, messageRef: proof.messageRef } });
    _recordChase(actionId, d, nowMs);
    console.log(`[Executor] ${actionId} verified in Sent Items`);
  } else if (outcome === 'ambiguous') {
    if (action.status === 'executed') {
      pa.transition(actionId, 'execution_uncertain', { now: nowMs, allowedFrom: ['executed'], note: 'Sent Items match is ambiguous',
        set: { outcome_detail: 'Sent Items holds something that does not cleanly match what was approved. Review it in Outlook; it will not be resent.' },
        eventExtra: { attempt: attempt.attempt, code: 'ambiguous' } });
    } else {
      pa.note(actionId, { outcome_detail: 'Sent Items holds something that does not cleanly match what was approved. Review it in Outlook; it will not be resent.' });
    }
  } else if (outcome === 'not_found') {
    const sendAt = Date.parse(attempt.send_requested_at || attempt.started_at);
    if (action.status === 'execution_uncertain' && proof.draftState === 'draft' && nowMs - sendAt >= SETTLE_MS) {
      // Proof it never went: the message is still sitting in Drafts long after
      // the send was asked for. Failed, proven unsent — and the stray draft is
      // removed so it cannot be sent by hand by mistake.
      pa.transition(actionId, 'failed', { now: nowMs, allowedFrom: ['execution_uncertain'], note: 'still a draft — Microsoft never sent it',
        set: { retry_safe: 1, outcome_detail: 'Microsoft never sent it (it was still a draft long after the send was asked for). Nothing was sent. Edit it to send again.' },
        eventExtra: { attempt: attempt.attempt, code: 'never-sent' } });
      try { await mail.deleteDraft(attempt.draft_id); } catch { /* best effort */ }
    } else if (action.status === 'executed' && nowMs - Date.parse(action.executedAt) >= VERIFY_GIVE_UP_MS) {
      pa.transition(actionId, 'execution_uncertain', { now: nowMs, allowedFrom: ['executed'], note: 'accepted but never found in Sent Items',
        set: { outcome_detail: 'Microsoft accepted it but it has not appeared in Sent Items after a day. Check Outlook; it will not be resent.' },
        eventExtra: { attempt: attempt.attempt, code: 'not-found' } });
    }
  }
  return { outcome, proof, status: pa.get(actionId).status };
}

// ── recovery / reconciliation (6G) ──────────────────────────────────────────

/**
 * An `executing` action whose claim is no longer running (a restart, a crash):
 * decide from the LEDGER what could have happened, never by resending.
 *   no message id          → the draft was never recorded, so no send was asked → failed, unsent
 *   id, no send requested  → stopped before the send → failed, unsent (stray draft removed)
 *   id, send requested     → it may have gone → execution_uncertain → verify
 */
async function _recoverInterrupted(row, d, nowMs) {
  const att = _openAttempt(row.action_id);
  if (!att) {
    pa.transition(row.action_id, 'execution_uncertain', { now: nowMs, allowedFrom: ['executing'], note: 'executing with no open attempt',
      set: { retry_safe: 0, outcome_detail: 'NEURO lost track of this send. Check Outlook; it will not be resent.' } });
    return 'uncertain-no-attempt';
  }
  if (!att.internet_message_id || !att.send_requested_at) {
    _attemptFinish(att.attempt_id, { error_category: 'abandoned', error_detail: 'interrupted before the send was requested', retry_safe: 1, final_state: 'failed' }, nowMs);
    pa.transition(row.action_id, 'failed', { now: nowMs, allowedFrom: ['executing'], note: 'interrupted before the send was requested',
      set: { retry_safe: 1, outcome_detail: 'NEURO stopped before asking Microsoft to send it. Nothing was sent. Edit it to send again.' },
      eventExtra: { attempt: att.attempt, code: 'interrupted-before-send' } });
    if (att.draft_id) { try { await d.mailApi.deleteDraft(att.draft_id); } catch { /* best effort */ } }
    return 'failed-unsent';
  }
  _attemptFinish(att.attempt_id, { send_outcome: 'uncertain', error_category: 'interrupted', error_detail: 'interrupted after the send was requested',
    retry_safe: 0, final_state: 'execution_uncertain' }, nowMs);
  pa.transition(row.action_id, 'execution_uncertain', { now: nowMs, allowedFrom: ['executing'], note: 'interrupted after the send was requested — verifying, never resending',
    set: { retry_safe: 0, outcome_detail: 'NEURO was interrupted after asking Microsoft to send it. Checking Sent Items; it will NOT be resent.' },
    eventExtra: { attempt: att.attempt, code: 'interrupted', messageRef: shortHash(att.internet_message_id) } });
  return 'uncertain';
}

/**
 * The durable pass: expire and cancel, recover interrupted claims, execute
 * approved actions whose trigger was missed, and verify anything unverified.
 * Idempotent: running it twice changes nothing the first run did not.
 */
async function reconcile({ now, deps } = {}) {
  const d = _deps(deps);
  const clock = () => (now !== undefined ? msOf(now) : Date.now());
  const out = { swept: pa.sweep({ now: clock() }), recovered: [], executed: [], verified: [], checked: 0 };

  for (const row of db.all(`SELECT action_id FROM prepared_actions WHERE status = 'executing'`)) {
    if (inFlight.has(row.action_id)) continue;
    const att = _openAttempt(row.action_id);
    const age = att ? clock() - Date.parse(att.started_at) : Infinity;
    if (att && att.boot_id === BOOT_ID && age < STALE_EXECUTING_MS) continue;
    out.recovered.push({ actionId: row.action_id, as: await _recoverInterrupted(row, d, clock()) });
  }

  for (const row of db.all(`SELECT action_id FROM prepared_actions WHERE status = 'approved' ORDER BY approved_at`)) {
    const r = await execute(row.action_id, { now: clock(), deps: d });
    out.executed.push({ actionId: row.action_id, status: r.status, code: r.code || null });
  }

  const windowStart = iso(clock() - VERIFY_WINDOW_MS);
  for (const row of db.all(`SELECT action_id, last_check_at FROM prepared_actions
                            WHERE status IN ('executed', 'execution_uncertain') AND updated_at >= ?`, [windowStart])) {
    if (row.last_check_at && clock() - Date.parse(row.last_check_at) < VERIFY_INTERVAL_MS) continue;
    out.checked += 1;
    const v = await verify(row.action_id, { now: clock(), deps: d });
    out.verified.push({ actionId: row.action_id, outcome: v.outcome, status: v.status });
  }
  return out;
}

/** What the ledger says right now, for State of Play and the production check. */
function status({ now = Date.now() } = {}) {
  const nowMs = msOf(now);
  const counts = pa.countsByStatus();
  const stuck = db.all(`SELECT action_id, status, updated_at FROM prepared_actions WHERE
      (status = 'executing' AND updated_at < ?) OR (status = 'approved' AND approval_expires_at < ?)`,
  [iso(nowMs - STALE_EXECUTING_MS), iso(nowMs)]).map((r) => ({ actionId: r.action_id, status: r.status, since: r.updated_at }));
  const needsReview = db.all(`SELECT action_id, status, outcome_detail, updated_at FROM prepared_actions
      WHERE status IN ('execution_uncertain', 'failed') AND updated_at >= ? ORDER BY updated_at DESC LIMIT 20`, [iso(nowMs - 14 * DAY)])
    .map((r) => ({ actionId: r.action_id, status: r.status, detail: r.outcome_detail, at: r.updated_at }));
  const attempts = db.get('SELECT COUNT(*) n FROM action_attempts').n;
  const sendsRequested = db.get('SELECT COUNT(*) n FROM action_attempts WHERE send_requested_at IS NOT NULL').n;
  return { counts, stuck, needsReview, attempts, sendsRequested, executableTypes: registry.executableTypes(), bootId: BOOT_ID };
}

module.exports = {
  execute, verify, reconcile, status, executionChecks, judgeSentItem,
  attemptsFor, verificationsFor,
  EXECUTORS, STALE_EXECUTING_MS, SETTLE_MS, VERIFY_GIVE_UP_MS,
  _bootId: () => BOOT_ID,
};
