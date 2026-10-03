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
  // Build 11K: the calendar transport and its OWN switch.
  calendar: () => require('./action-calendar'),
  calendarEnabled: () => require('./feature-flags').isEnabled('governed_calendar'),
  // What a calendar change leaves in NEURO's records (1-2-1 stamps, the move
  // history, NOVA's session) — the work book()/reschedule() used to do inline.
  recordCalendar: (a) => require('./one-to-one-booking').afterGovernedCalendar(a),
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
  agendaAssess: (ev, nowMs) => require('./meeting-triage').assess(ev, { now: new Date(nowMs) }),
  reportLocked: (week) => require('./weekly-risk').isLocked(week),
  // What a send leaves behind in NEURO's own records, per type. Never mutates a
  // commitment, task or world-model row: sending is not finishing (8F).
  recordReply: (a) => {
    require('./sent-replies').record({
      emailId: a.target.emailId, subject: a.target.originalSubject || null,
      fromName: a.target.fromName || null, fromEmail: a.target.from || null,
      recipients: [...(a.draft.to || []), ...(a.draft.cc || [])], recipientsSource: 'explicit',
      replyAll: a.draft.mode === 'replyAll', body: a.draft.body,
    });
    try { require('./email-triage').dismissEmail(a.target.emailId, 'replied'); } catch { /* triage bookkeeping only */ }
  },
  recordReport: (a) => {
    require('./weekly-risk').markSent(a.target.week, {
      actionId: a.actionId, recipients: a.draft.to, subject: a.draft.subject, body: a.draft.body,
    });
    try {
      const log = require('./management-log');
      const open = log.list({ limit: 500 }).find((r) => r.status !== 'done' && /weekly team risk .* report to Chris/i.test(r.summary));
      if (open) log.update(open.id, { status: 'done' });
    } catch { /* bookkeeping must never fail a send that already happened */ }
  },
};

function _deps(over) {
  if (over && over.mailApi && over.calApi) return over; // already resolved
  const d = { ...DEFAULT_DEPS, ...(over || {}) };
  return {
    ...d,
    mailApi: d.mailApi || (typeof d.mail === 'function' ? d.mail() : d.mail),
    calApi: d.calApi || (typeof d.calendar === 'function' ? d.calendar() : d.calendar),
  };
}

const waitingKey = (subjectRef) => (String(subjectRef || '').startsWith('waiting-on:') ? subjectRef.slice('waiting-on:'.length) : null);

// ── preflight (PURE) ────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const stopWith = (code, why, terminal = true) => ({ ok: false, code, why, terminal });

/**
 * The checks EVERY outbound type shares (Build 8F). PURE. The approval binds
 * this exact payload and has not expired; the recipients are the approved
 * shape for the type (count, copies, blind copies); no [placeholder] remains.
 */
function commonChecks({ action, policy, nowMs }) {
  const stop = stopWith;
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
  const cc = Array.isArray(draft.cc) ? draft.cc : [];
  if (!to.length || to.length + cc.length > (policy.maxRecipients || 1) || to.some((r) => !EMAIL_RE.test(lc(r && r.email)))) {
    return stop('recipient-mismatch', `the draft must go to between 1 and ${policy.maxRecipients || 1} valid address(es)`);
  }
  if (policy.targetIsRecipient && (to.length !== 1 || !lc(target.email) || lc(to[0].email) !== lc(target.email))) {
    return stop('recipient-mismatch', 'the draft must go to exactly the one person it was prepared for');
  }
  if (cc.length && !policy.cc) return stop('cc-not-allowed', `nobody may be copied on ${action.actionType}`);
  if (cc.some((r) => !EMAIL_RE.test(lc(r && r.email)))) return stop('recipient-mismatch', 'a copied address is not valid');
  if (Array.isArray(draft.bcc) && draft.bcc.length) return stop('bcc-not-allowed', 'nothing NEURO sends has a blind copy');
  if (registry.hasUnfilledPlaceholder(draft.body) || registry.hasUnfilledPlaceholder(draft.subject)) return stop('placeholder', 'the draft still carries a [placeholder]');
  if (policy.bodyFormat === 'html' && !String(draft.html || '').trim()) return stop('no-body', 'there is no frozen HTML to send');
  return { ok: true };
}

/**
 * chase_commitment's checks, repeated at execution. PURE. Kept under its
 * Build 6 name (tests and the record refer to it): common checks first, then
 * the commitment, the person and the waiting-on item.
 * Returns { ok: true } or { ok: false, code, why, terminal }.
 * `terminal: true` — the world moved; cancel. `false` — could not check; wait.
 */
function executionChecks({ action, policy, commitment, progress, person, waiting, deferred, otherLive, nowMs }) {
  const stop = stopWith;
  const common = commonChecks({ action, policy, nowMs });
  if (!common.ok) return common;
  const target = action.target || {};

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

/**
 * Another action of the SAME type for the SAME subject that has gone, or is
 * going (Build 8K). For reply/agenda/report the subject key is commitment_id
 * (`email:…`, `meeting:…`, `weekly-risk:…`). A verified one counts when it was
 * verified after this one was PREPARED — i.e. this draft was written without
 * knowing about it; for the agenda chase any verified one counts, ever.
 */
function _otherSent(action, { ever = false } = {}) {
  return db.get(`SELECT action_id, status FROM prepared_actions WHERE action_type = ? AND commitment_id = ? AND action_id <> ?
                 AND (status IN ('executing', 'execution_uncertain', 'executed') OR (status = 'verified' AND (? = 1 OR verified_at >= ?)))
                 LIMIT 1`, [action.actionType, action.commitmentId, action.actionId, ever ? 1 : 0, action.createdAt]);
}

/**
 * Per-type preflight (Build 8F). Each returns { ok } or a stop — terminal when
 * the world moved (cancel), not terminal when a check could not be made (wait).
 * All run AFTER commonChecks, and each ends with a LIVE Sent Items read: the
 * periodic scans are minutes behind, and a message Nick sent five minutes ago
 * is the duplicate that matters.
 */
const PREFLIGHT = {
  async chase_commitment(action, policy, d, nowMs) {
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
    const sent = await d.mailApi.sentToSince(action.target.email, action.createdAt);
    if (!sent) return stopWith('sent-mail-unreadable', 'could not read Sent Items to check you have not already written to them', false);
    if (sent.count > 0) return stopWith('already-emailed', `you have emailed ${action.target.displayName || 'them'} since this was prepared — not sending; review it`);
    return { ok: true };
  },

  // 8C: the thread must still be the one Nick approved a reply to.
  async reply_email(action, policy, d) {
    const t = action.target || {};
    const other = _otherSent(action);
    if (other) return stopWith('duplicate', `another reply to this email (${other.action_id}) is already ${other.status}`);
    const m = await d.mailApi.readMessage(t.emailId);
    if (!m || !m.ok) return stopWith('message-unreadable', 'could not read the email being replied to', false);
    if (!m.exists) return stopWith('thread-gone', 'the email being replied to no longer exists');
    if (t.conversationId && m.conversationId && m.conversationId !== t.conversationId) return stopWith('thread-changed', 'the email now belongs to a different thread');
    if (t.from && lc(m.from) !== lc(t.from)) return stopWith('sender-changed', 'the email\'s sender is not the one the reply was prepared for');
    const sent = await d.mailApi.sentInConversationSince(t.conversationId, action.createdAt);
    if (!sent) return stopWith('sent-mail-unreadable', 'could not read Sent Items to check you have not already replied', false);
    if (sent.count > 0) return stopWith('already-replied', 'you have already replied in this thread since this was prepared — not sending a second reply; review it');
    return { ok: true };
  },

  // 8D: still a meeting worth asking about, still nobody has answered.
  async chase_agenda(action, policy, d, nowMs) {
    const t = action.target || {};
    const other = _otherSent(action, { ever: true });
    if (other) return stopWith('duplicate', `the organiser was already asked about this meeting (${other.action_id}, ${other.status})`);
    const r = await d.mailApi.readEvent(t.eventId);
    if (!r || !r.ok) return stopWith('meeting-unreadable', 'could not read the meeting from the calendar', false);
    const ev = r.event || {};
    if (ev.isCancelled) return stopWith('meeting-cancelled', 'the meeting has been cancelled');
    const start = Date.parse(ev.start || t.start);
    if (!Number.isFinite(start) || start - nowMs < 2 * HOUR) return stopWith('meeting-too-close', 'the meeting starts within two hours (or has passed) — too late to ask');
    const organiser = lc((ev.organizer && (ev.organizer.email || ev.organizer.address)) || '');
    if (organiser && organiser !== lc(t.email)) return stopWith('organiser-changed', 'the meeting has a different organiser now');
    if (ev.responseStatus && !['none', 'notResponded'].includes(ev.responseStatus)) return stopWith('already-responded', `you have already responded to it (${ev.responseStatus})`);
    let verdict = null;
    try { verdict = d.agendaAssess(ev, nowMs); } catch { verdict = null; }
    if (verdict && verdict.chase === false) return stopWith('agenda-arrived', `the invite no longer needs a chase (${verdict.reason})`);
    const sent = await d.mailApi.sentToSince(t.email, action.createdAt);
    if (!sent) return stopWith('sent-mail-unreadable', 'could not read Sent Items to check you have not already asked', false);
    const subj = lc(t.subject);
    if (sent.count > 0 && (!subj || (sent.subjects || []).some((s) => lc(s).includes(subj)))) {
      return stopWith('already-emailed', 'you have written to the organiser about this meeting since this was prepared');
    }
    return { ok: true };
  },

  // 8E: the week must not already be sent, and this must be the newest report.
  async send_weekly_risk_report(action, policy, d) {
    const t = action.target || {};
    const other = _otherSent(action);
    if (other) return stopWith('duplicate', `this week's report is already ${other.status} (${other.action_id})`);
    let locked = null;
    try { locked = d.reportLocked(t.week); } catch { locked = null; }
    if (locked === null) return stopWith('report-unreadable', 'could not read whether this week was already sent', false);
    if (locked) return stopWith('already-sent', `the report for w/c ${t.week} is already recorded as sent`);
    const newer = db.get(`SELECT action_id FROM prepared_actions WHERE action_type = 'send_weekly_risk_report' AND commitment_id = ?
                          AND action_id <> ? AND created_at > ? AND status NOT IN ('rejected') LIMIT 1`,
    [action.commitmentId, action.actionId, action.createdAt]);
    if (newer) return stopWith('superseded-by-newer', `a newer version of this report was prepared (${newer.action_id}) — approve that one`);
    const sent = await d.mailApi.sentToSince(t.email, action.createdAt);
    if (!sent) return stopWith('sent-mail-unreadable', 'could not read Sent Items to check you have not sent it by hand', false);
    const subj = lc(action.draft && action.draft.subject);
    if ((sent.subjects || []).some((s) => lc(s) === subj)) return stopWith('already-emailed', 'you have already sent this report by hand since it was prepared');
    return { ok: true };
  },
};

// ── Build 11K: calendar preflight ──────────────────────────────────────────

const minuteOf = (s) => String(s || '').replace(' ', 'T').slice(0, 16);
function _wallMinutes(a, b) {
  const t = (x) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10), +x.slice(11, 13), +x.slice(14, 16));
  return Math.round((t(b) - t(a)) / 60000);
}
function _nowLocal(nowMs) {
  try { return require('./world-model').localMinute(nowMs); } catch { return new Date(nowMs).toISOString().slice(0, 16); }
}
const _sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const _emails = (list) => (list || []).map((r) => lc(r && r.email)).filter(Boolean).sort();

/**
 * The checks every calendar change shares. PURE. The slot must still be in
 * the future, and the event (for a move/cancel) must still be the one that
 * was prepared: same id, same start, Nick its organiser, attendees unchanged.
 */
function calendarChecks({ action, policy, event, nowLocal }) {
  const d = action.draft || {};
  const t = action.target || {};
  const op = policy.sendMode;
  if (op === 'calendar-create' || op === 'calendar-update') {
    if (!d.start || !d.end || minuteOf(d.end) <= minuteOf(d.start)) return stopWith('bad-times', 'the approved times are not a real slot');
    if (_wallMinutes(nowLocal, minuteOf(d.start)) < 5) return stopWith('slot-passed', 'the approved slot has started or passed — too late to send it');
  }
  if (op === 'calendar-update' || op === 'calendar-cancel') {
    if (!event) return stopWith('event-unreadable', 'could not read the meeting from the calendar', false);
    if (event.exists === false) return stopWith('event-gone', 'the meeting no longer exists');
    const e = event.event || {};
    if (e.id && t.eventId && e.id !== t.eventId) return stopWith('event-changed', 'the calendar returned a different event');
    if (e.isCancelled) return stopWith('event-cancelled', 'the meeting has already been cancelled');
    if (e.isOrganizer === false) return stopWith('not-organiser', 'you are not the organiser any more — only the organiser can change it for everyone');
    if (t.fromStart && e.start && e.start !== minuteOf(t.fromStart)) return stopWith('event-moved', `the meeting has moved since this was prepared (it is now ${e.start.replace('T', ' ')})`);
    if (d.subject && e.subject !== undefined && e.subject !== d.subject) return stopWith('event-renamed', 'the meeting has been renamed since this was prepared');
    if (!_sameSet(e.attendees || [], _emails(d.to))) return stopWith('attendees-changed', 'the people in the meeting have changed since this was prepared');
    if (op === 'calendar-cancel' && _wallMinutes(nowLocal, e.start) < 0) return stopWith('slot-passed', 'the meeting has already started — not cancelling it now');
  }
  return { ok: true };
}

PREFLIGHT.create_calendar_event = async function createCalendarEvent(action, policy, d, nowMs) {
  const other = _otherSent(action, { ever: true });
  if (other) return stopWith('duplicate', `this booking was already made (${other.action_id}, ${other.status})`);
  const sync = calendarChecks({ action, policy, event: null, nowLocal: _nowLocal(nowMs) });
  if (!sync.ok) return sync;
  // A LIVE read: an event with this title already at this start — booked by
  // hand, or by a path NEURO does not see — is the duplicate that matters.
  const at = await d.calApi.eventsAt(minuteOf(action.draft.start));
  if (!at || !at.ok) return stopWith('calendar-unreadable', 'could not read the calendar to check it is not already booked', false);
  const title = lc(action.draft.subject);
  if (at.events.some((e) => lc(e.subject) === title && !e.isCancelled)) {
    return stopWith('already-booked', 'an event with this title is already in the calendar at that time — not sending a second invite');
  }
  return { ok: true };
};

async function _calendarUpdatePreflight(action, policy, d, nowMs) {
  const other = db.get(`SELECT action_id, status FROM prepared_actions WHERE action_type IN ('reschedule_calendar_event', 'cancel_calendar_event')
                        AND commitment_id = ? AND action_id <> ? AND status IN ('executing', 'execution_uncertain', 'executed') LIMIT 1`,
  [action.commitmentId, action.actionId]);
  if (other) return stopWith('duplicate', `another change to this meeting (${other.action_id}) is already ${other.status}`);
  const event = await d.calApi.readEvent(action.target.eventId);
  return calendarChecks({ action, policy, event: event && event.ok ? event : null, nowLocal: _nowLocal(nowMs) });
}
PREFLIGHT.reschedule_calendar_event = _calendarUpdatePreflight;
PREFLIGHT.cancel_calendar_event = _calendarUpdatePreflight;

async function preflight(action, policy, d, nowMs) {
  const common = commonChecks({ action, policy, nowMs });
  if (!common.ok) return common;
  const run = PREFLIGHT[action.actionType];
  // An executable type with no preflight is refused, not waved through.
  if (!run) return stopWith('no-preflight', `${action.actionType} has no execution checks — it cannot run`);
  return run(action, policy, d, nowMs);
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

/**
 * What a send leaves in NEURO's own records, once per action (the column is
 * still called chase_recorded_at; since Build 8 it means "the after-send
 * record was written" for every type). Runs on `executed` (Microsoft accepted
 * it) and again on `verified` — the second is a no-op. Never allowed to fail
 * the send: the mail has already left.
 */
function _recordChase(actionId, d, nowMs) {
  const a = pa.get(actionId);
  if (!a) return;
  const row = db.get('SELECT chase_recorded_at FROM prepared_actions WHERE action_id = ?', [actionId]);
  if (row && row.chase_recorded_at) return;
  try {
    if (a.actionType === 'chase_commitment') {
      if (!waitingKey(a.subjectRef)) return;
      d.markChased(waitingKey(a.subjectRef), nowMs);
    } else if (a.actionType === 'reply_email') {
      d.recordReply(a);
    } else if (a.actionType === 'send_weekly_risk_report') {
      d.recordReport(a);
    } else if (registry.isCalendarType(a.actionType)) {
      d.recordCalendar(a);
    }
    // chase_agenda: the governed row IS the record ("asked once, ever").
    pa.note(actionId, { chase_recorded_at: iso(nowMs) });
  } catch (e) { console.warn(`[Executor] could not record the send for ${actionId}: ${e.message}`); }
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

  // 3. DRAFT — nothing is sent by this. How the draft is made is the type's
  // registered sendMode; what goes in it is ONLY the approved payload.
  const policy = registry.policyFor(action.actionType) || {};
  const draft = action.draft || {};
  const wantTo = (draft.to || []).map((r) => lc(r.email)).sort();
  const wantCc = (draft.cc || []).map((r) => lc(r.email)).sort();
  let dr;
  if (policy.sendMode === 'reply') {
    // Threaded under the source message; Graph's choice of addressees is then
    // OVERWRITTEN with the approved list and READ BACK before anything is sent.
    dr = await mail.createReplyDraft(action.target.emailId, { mode: draft.mode, comment: draft.body });
    if (dr.ok && dr.id) {
      _attemptSet(claim.attemptId, { draft_id: dr.id });
      const p = await mail.patchDraft(dr.id, { to: draft.to, cc: draft.cc || [], subject: draft.subject });
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (!p.ok) {
        try { await mail.deleteDraft(dr.id); } catch { /* best effort */ }
        return failBeforeSend(p.category || 'unknown', 'Microsoft would not set the reply\'s recipients', p.status);
      }
      if (!same(p.to.map(lc).sort(), wantTo) || !same(p.cc.map(lc).sort(), wantCc) || (p.bcc && p.bcc.length) || p.subject !== draft.subject) {
        try { await mail.deleteDraft(dr.id); } catch { /* best effort */ }
        return failBeforeSend('recipient-mismatch', 'the reply draft did not hold exactly the approved recipients and subject');
      }
      if (!dr.internetMessageId && p.internetMessageId) dr.internetMessageId = p.internetMessageId;
    }
  } else {
    dr = await mail.createDraft({
      to: draft.to.map((r) => ({ email: r.email, name: r.name || (lc(r.email) === lc(action.target.email) ? action.target.displayName : undefined) })),
      cc: draft.cc || [],
      subject: draft.subject,
      body: policy.bodyFormat === 'html' ? draft.html : draft.body,
      contentType: policy.bodyFormat === 'html' ? 'HTML' : 'Text',
    });
  }
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

/**
 * Build 11K: the calendar executor. Same shape as the mail one — the HANDLE
 * reaches the ledger before the provider is asked, one attempt per approved
 * version, a definitive refusal is proven-not-made, anything else is verified
 * and never retried.
 *
 * The handle is NEURO's marker (`neuro:<action>:<attempt>`), written to the
 * ledger's message-id column; for a create it is stamped onto the event as an
 * extended property AND sent as Graph's transactionId, so a retried POST
 * cannot make a second event and a timed-out one can be found.
 */
async function _calendarExecutor(action, claim, d, clock) {
  const id = action.actionId;
  const cal = d.calApi;
  const policy = registry.policyFor(action.actionType) || {};
  const draft = action.draft || {};
  const handle = `neuro:${id}:${claim.attempt}`;
  _attemptSet(claim.attemptId, { internet_message_id: handle, draft_id: action.target && action.target.eventId ? action.target.eventId : null, draft_created_at: iso(clock()) });
  _attemptSet(claim.attemptId, { send_requested_at: iso(clock()) });

  let r;
  if (policy.sendMode === 'calendar-create') {
    r = await cal.createEvent(draft, { transactionId: crypto.createHash('sha256').update(handle).digest('hex').slice(0, 32), marker: handle });
    if (r.outcome === 'accepted' && r.event && r.event.id) _attemptSet(claim.attemptId, { draft_id: r.event.id });
  } else if (policy.sendMode === 'calendar-update') {
    r = await cal.moveEvent(action.target.eventId, { start: draft.start, end: draft.end, timeZone: draft.timeZone });
  } else {
    r = await cal.cancelEvent(action.target.eventId, { comment: draft.body || '' });
  }
  const now = clock();
  const what = policy.sendMode === 'calendar-create' ? 'invite' : policy.sendMode === 'calendar-update' ? 'move' : 'cancellation';
  if (r.outcome === 'accepted') {
    _attemptFinish(claim.attemptId, { send_outcome: 'accepted', send_http_status: r.status, retry_safe: 0, final_state: 'executed' }, now);
    pa.transition(id, 'executed', { now, allowedFrom: ['executing'], note: `Microsoft accepted the ${what} (HTTP ${r.status}) — reading it back`,
      set: { executed_at: iso(now), retry_safe: 0 }, eventExtra: { attempt: claim.attempt, messageRef: shortHash(handle) } });
    _recordChase(id, d, now);
    console.log(`[Executor] ${id} executed (calendar ${what} accepted); verifying by read-back`);
  } else if (r.outcome === 'rejected') {
    _attemptFinish(claim.attemptId, { send_outcome: 'rejected', send_http_status: r.status, error_category: r.category || null,
      error_detail: `Microsoft refused the ${what}`, retry_safe: 1, final_state: 'failed' }, now);
    pa.transition(id, 'failed', { now, allowedFrom: ['executing'], note: `Microsoft refused the ${what} (${r.category || r.status})`,
      set: { retry_safe: 1, outcome_detail: `Microsoft refused the ${what} (${r.category || `HTTP ${r.status}`}) — nothing changed and nobody was told` },
      eventExtra: { attempt: claim.attempt, code: r.category || `http_${r.status}` } });
    console.log(`[Executor] ${id} failed: calendar ${what} refused; nothing changed`);
    return { ok: false, status: 'failed', code: r.category || 'refused', detail: `Microsoft refused the ${what} — nothing changed`, action: pa.get(id) };
  } else {
    _attemptFinish(claim.attemptId, { send_outcome: 'uncertain', send_http_status: r.status, error_category: r.category || 'unknown',
      error_detail: 'no definite answer from Microsoft', retry_safe: 0, final_state: 'execution_uncertain' }, now);
    pa.transition(id, 'execution_uncertain', { now, allowedFrom: ['executing'], note: `no definite answer (${r.category || r.status}) — reading back, never repeating`,
      set: { retry_safe: 0, outcome_detail: `Microsoft gave no definite answer, so the ${what} may have gone. NEURO is reading the calendar and will NOT try again.` },
      eventExtra: { attempt: claim.attempt, code: r.category || 'unknown', messageRef: shortHash(handle) } });
    console.log(`[Executor] ${id} calendar ${what} uncertain; verifying, will not repeat`);
  }
  try { await verify(id, { now: clock(), deps: d }); } catch (e) { console.warn(`[Executor] verify ${id}: ${e.message}`); }
  const after = pa.get(id);
  return { ok: ['executed', 'verified', 'execution_uncertain'].includes(after.status), status: after.status, detail: after.outcomeDetail, action: after };
}

const EXECUTORS = Object.freeze({ 'microsoft.mail': _mailExecutor, 'microsoft.calendar': _calendarExecutor });

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
  const calendarType = policy.executor === 'microsoft.calendar';
  if (!(calendarType ? d.calendarEnabled() : d.enabled())) {
    const label = registry.SWITCH_LABELS[registry.switchFor(action.actionType)];
    pa.note(actionId, { last_block: `switched off (Settings → Switches → "${label}")` });
    return { ok: false, code: 'switched-off', transient: true, status: 'approved', detail: `Approved, but "${label}" is switched off — nothing was sent.` };
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
  const started = Date.parse(attempt.started_at || attempt.startedAt);
  const sent = Date.parse(m.sentAt);
  const draft = action.draft || {};
  const policy = registry.policyFor(action.actionType) || {};
  // The approved recipient SETS — exactly these, no more, no fewer (Build 8:
  // a reply can go to several people; a chase still to exactly one).
  const want = (list) => (list || []).map((r) => lc(r && r.email)).sort().join(',');
  const got = (list) => (list || []).map(lc).sort().join(',');
  const checks = {
    messageId: lc(m.internetMessageId) === lc(attempt.internet_message_id || attempt.internetMessageId),
    recipient: Array.isArray(m.to) && m.to.length > 0 && got(m.to) === want(draft.to)
      && (!policy.targetIsRecipient || (m.to.length === 1 && lc(m.to[0]) === lc(action.target && action.target.email))),
    noCopies: got(m.cc) === want(draft.cc) && !(m.bcc && m.bcc.length),
    subject: (m.subject || '') === draft.subject,
    time: Number.isFinite(sent) && Number.isFinite(started) && sent >= started - CLOCK_SKEW_MS,
    sender: signedIn ? lc(m.from) === lc(signedIn) : null,
    // A reply must have landed in the thread it was approved for.
    thread: policy.sendMode === 'reply' ? (!!m.conversationId && m.conversationId === (action.target && action.target.conversationId)) : null,
    // Recorded, not required: the message id is the identity. A server-side
    // disclaimer would change the body without changing which message it is.
    // Not judged for HTML (the stored text is the markdown Nick read).
    body: m.bodyText === null || m.bodyText === undefined || policy.bodyFormat === 'html' ? null : normBody(m.bodyText).startsWith(normBody(draft.body)),
  };
  const required = ['messageId', 'recipient', 'noCopies', 'subject', 'time'];
  const ok = required.every((k) => checks[k] === true) && checks.sender !== false && checks.thread !== false;
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
  if (registry.isCalendarType(action.actionType)) return _verifyCalendar(action, d, nowMs);
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

// ── Build 11L: calendar verification ────────────────────────────────────────

/**
 * Does the event the calendar holds match what was approved? PURE.
 *   create      NEURO's marker, exact title, start, end, attendee set,
 *               location (when one was approved), online flag, not cancelled
 *   reschedule  the SAME event id, at the NEW approved time, attendee set
 *               unchanged (nobody added or dropped by the move)
 *   cancel      the event is gone or marked cancelled
 */
function judgeCalendarEvent(found, { action, handle }) {
  const policy = registry.policyFor(action.actionType) || {};
  const d = action.draft || {};
  const t = action.target || {};
  if (policy.sendMode === 'calendar-cancel') {
    const done = found.exists === false || (found.event && found.event.isCancelled === true);
    return { ok: done, checks: { gone: found.exists === false, cancelled: !!(found.event && found.event.isCancelled) } };
  }
  const e = found.event || {};
  const checks = {
    event: policy.sendMode === 'calendar-create' ? e.marker === handle : e.id === t.eventId,
    title: (e.subject || '') === d.subject,
    start: e.start === minuteOf(d.start),
    end: e.end === minuteOf(d.end),
    attendees: _sameSet(e.attendees || [], _emails(d.to)),
    location: d.location ? lc(e.location) === lc(d.location) : null,
    online: d.isOnline ? e.isOnline === true : null,
    notCancelled: e.isCancelled !== true,
  };
  // A move never re-titles: the title check applies to what was approved, and
  // a reschedule's draft carries the event's own title.
  const ok = ['event', 'title', 'start', 'end', 'attendees', 'notCancelled'].every((k) => checks[k] === true)
    && checks.location !== false && checks.online !== false;
  return { ok, checks };
}

async function _verifyCalendar(action, d, nowMs) {
  const actionId = action.actionId;
  const attempt = _latestAttempt(actionId);
  if (!attempt || !attempt.internet_message_id) {
    if (action.status === 'executed') {
      pa.transition(actionId, 'execution_uncertain', { now: nowMs, allowedFrom: ['executed'], note: 'no handle on record to read back',
        set: { outcome_detail: 'There is no handle on record to check the calendar against. Look in Outlook; it will not be repeated.' } });
    }
    return { outcome: 'ambiguous', detail: 'no verification handle' };
  }
  const policy = registry.policyFor(action.actionType) || {};
  const cal = d.calApi;
  const handle = attempt.internet_message_id;
  const proof = { attemptId: attempt.attempt_id, handleRef: shortHash(handle) };
  let found = null;
  let outcome;
  if (policy.sendMode === 'calendar-create') {
    const r = await cal.findByMarker(handle);
    if (!r || !r.ok) { outcome = 'provider_unavailable'; proof.category = (r && r.category) || 'unavailable'; }
    else if (r.events.length === 0) outcome = 'not_found';
    else if (r.events.length > 1) { outcome = 'ambiguous'; proof.count = r.events.length; }
    else found = { exists: true, event: r.events[0] };
  } else {
    const r = await cal.readEvent(action.target.eventId);
    if (!r || !r.ok) { outcome = 'provider_unavailable'; proof.category = (r && r.category) || 'unavailable'; }
    else found = r;
  }
  if (found) {
    const j = judgeCalendarEvent(found, { action, handle });
    proof.checks = j.checks;
    if (found.event && found.event.id) proof.eventId = found.event.id;
    if (j.ok) outcome = 'verified';
    else if (policy.sendMode === 'calendar-update' && found.event && found.event.start === minuteOf(action.target.fromStart)) outcome = 'not_found';
    else if (policy.sendMode === 'calendar-cancel' && found.event && !found.event.isCancelled) outcome = 'not_found';
    else outcome = 'ambiguous';
  }
  _recordVerification(action, attempt, outcome, proof, nowMs);

  const sendAt = Date.parse(attempt.send_requested_at || attempt.started_at);
  if (outcome === 'verified') {
    pa.transition(actionId, 'verified', { now: nowMs, allowedFrom: ['executed', 'execution_uncertain'],
      note: 'read back from the calendar: exactly what was approved',
      set: { verified_at: iso(nowMs), retry_safe: 0, outcome_detail: 'Done, and confirmed by reading the calendar back.' },
      eventExtra: { attempt: attempt.attempt, messageRef: proof.handleRef } });
    _recordChase(actionId, d, nowMs);
    console.log(`[Executor] ${actionId} verified in the calendar`);
  } else if (outcome === 'ambiguous') {
    const detail = 'The calendar holds something that does not cleanly match what was approved. Check it in Outlook; it will not be repeated.';
    if (action.status === 'executed') {
      pa.transition(actionId, 'execution_uncertain', { now: nowMs, allowedFrom: ['executed'], note: 'calendar read-back does not match',
        set: { outcome_detail: detail }, eventExtra: { attempt: attempt.attempt, code: 'ambiguous' } });
    } else pa.note(actionId, { outcome_detail: detail });
  } else if (outcome === 'not_found') {
    // Proof it never happened: a successful read, long after the call, still
    // shows the world as it was. Failed, proven unchanged — never retried here.
    if (action.status === 'execution_uncertain' && nowMs - sendAt >= SETTLE_MS) {
      pa.transition(actionId, 'failed', { now: nowMs, allowedFrom: ['execution_uncertain'], note: 'read back long after the call: nothing changed',
        set: { retry_safe: 1, outcome_detail: 'The calendar shows nothing changed long after the request, so it never happened and nobody was told. Prepare it again to retry.' },
        eventExtra: { attempt: attempt.attempt, code: 'never-happened' } });
    } else if (action.status === 'executed' && nowMs - Date.parse(action.executedAt) >= VERIFY_GIVE_UP_MS) {
      pa.transition(actionId, 'execution_uncertain', { now: nowMs, allowedFrom: ['executed'], note: 'accepted but never seen in the calendar',
        set: { outcome_detail: 'Microsoft accepted it but the calendar does not show it after a day. Check Outlook; it will not be repeated.' },
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
    const pol = registry.policyFor(row.action_type || (pa.get(row.action_id) || {}).actionType) || {};
    if (att.draft_id && pol.executor === 'microsoft.mail') { try { await d.mailApi.deleteDraft(att.draft_id); } catch { /* best effort */ } }
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
  execute, verify, reconcile, status, executionChecks, commonChecks, judgeSentItem, preflight, PREFLIGHT,
  calendarChecks, judgeCalendarEvent,
  attemptsFor, verificationsFor,
  EXECUTORS, STALE_EXECUTING_MS, SETTLE_MS, VERIFY_GIVE_UP_MS,
  _bootId: () => BOOT_ID,
};
