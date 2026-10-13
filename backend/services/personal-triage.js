'use strict';

/**
 * Personal triage (13 Oct 2026) — the work Inbox's sorting and verdicts, for
 * nick@, contact@ and Gmail. Nick: "personal inbox still needs work — it's not
 * the same as work inbox", then "we can use AI — keep work and personal
 * separate though".
 *
 * SEPARATE BY CONSTRUCTION. The state lives on the `personal_inbox` row
 * (`triage_json`), never in the work `email_triage` blob; mute rules and the
 * feedback rollup have their own agent_state keys; nothing here raises a nudge,
 * and nothing in email-triage reads this. saim@ is not sorted (it is the
 * bounce watch).
 *
 * ONE CLASSIFIER, TWO QUESTIONS. Batching, parsing and the "no answer is not
 * FYI" rule are email-triage's `classifyBatch`; this only supplies a personal
 * prompt and turns the answer into a lane.
 *
 * ⚠ A MODEL ANSWER IS BOUGHT ONCE. `aiClassified` + `aiCategory` + `aiUrgency`
 *   + `triagedAt` stay on the row for as long as the row exists — dismissed or
 *   not — so a message is never sent to the model twice (the 8 Sep work-inbox
 *   bug was a dismissal compaction that dropped exactly these fields). The row
 *   leaves only when the message leaves the mailbox window.
 * ⚠ A failed or skipped batch leaves `aiClassified: false` and the message in
 *   an UNSORTED section — never filed as FYI.
 * ⚠ A promotion survives re-classification (it is applied at read time).
 */

const et = require('./email-triage');

const INBOXES = ['nick', 'contact', 'gmail'];
const SENDER_RULES_KEY = 'personal_triage_muted_senders';
const SUBJECT_RULES_KEY = 'personal_triage_muted_subjects';
const FEEDBACK_KEY = 'personal_triage_feedback';
const LAST_RUN_KEY = 'personal_triage_time';
const MAX_PER_PASS = 100; // five batches; the rest next pass (every 5 minutes)

// NEURO's own acts. Absent from DISMISS_REASONS (no caller can pass them) and
// never counted as a verdict — same list as the work inbox.
const SENDER_MUTED = 'sender-muted';
const SUBJECT_MUTED = 'subject-muted';
const AGED_OUT = et._internals.AGED_OUT;
const SECTION_CLEARED = et._internals.SECTION_CLEARED;
const DISMISS_REASONS = et._internals.DISMISS_REASONS; // done | not-relevant | replied | unspecified
const JUDGED = new Set(['done', 'not-relevant', 'replied']);
const CATEGORIES = new Set(['ACTION', 'FYI', 'DELEGATE', 'IGNORE']);
const URGENCIES = new Set(['high', 'medium', 'low']);

function _db() { return require('../db/database'); }

/** The personal question (13 Oct 2026). Same four categories as work, so the screens group the same way. */
function personalPrompt(batch, emailList) {
  return `You are sorting Nick Ward's PERSONAL email — home, family, money, life admin, hobbies. Not his work at Nurtur.
Put each email in exactly one category:
- ACTION: Nick has to do something or reply — a person waiting on him, a bill, payment problem, renewal or expiring card, a form, booking or appointment to sort.
- DELEGATE: it is for someone else in the household (for example Helen) to deal with, or should be passed on.
- FYI: worth knowing, nothing to do — receipts, payment confirmations, order and delivery updates, statements, sign-in codes he asked for.
- IGNORE: marketing, newsletters, offers, surveys, automated noise.
And an urgency: high (money at risk, a deadline today or tomorrow, someone waiting urgently), medium, or low. Most personal email is low.
Respond with ONLY a JSON array. Format: [{"index": 0, "category": "ACTION", "urgency": "medium", "reason": "brief reason max 8 words"}, ...]

Sort these ${batch.length} emails:\n\n${emailList}`;
}

function _parse(raw) {
  if (!raw) return {};
  try { const t = JSON.parse(raw); return t && typeof t === 'object' && !Array.isArray(t) ? t : {}; } catch { return {}; }
}
function _write(id, t) { _db().run('UPDATE personal_inbox SET triage_json = ? WHERE id = ?', [JSON.stringify(t), id]); }

/** PURE. Which section a sorted row renders in. */
function laneOf(t) {
  if (t.promoted) return 'reply';
  if (!t.aiClassified || !CATEGORIES.has(t.aiCategory)) return 'unsorted';
  if (t.aiCategory === 'IGNORE') return 'ignore';
  if (t.aiCategory === 'DELEGATE') return 'delegate';
  if (t.aiCategory === 'ACTION') return t.aiUrgency === 'high' ? 'urgent' : 'reply';
  return 'fyi';
}

/** PURE. A personal_inbox row as the card the work Inbox renders. */
function entryOf(row) {
  const t = _parse(row.triage_json);
  const lane = laneOf(t);
  const category = t.promoted ? 'ACTION' : (lane === 'unsorted' ? null : t.aiCategory);
  let why = null;
  if (row.mailbox === 'gmail') {
    try { const e = JSON.parse(row.ext_json || 'null'); why = e && e.reason ? (require('./gmail-rule').REASON_WORDS[e.reason] || null) : null; } catch { why = null; }
  }
  const reason = [t.aiReason || null, t.promoted ? 'promoted by Nick' : null].filter(Boolean).join(' · ');
  return {
    id: row.id, mailbox: row.mailbox, source: row.mailbox,
    from: row.from_name || row.from_email, fromEmail: row.from_email, subject: row.subject, preview: row.preview || '',
    received: row.received, isRead: row.seen === 1,
    category, lane, urgency: t.promoted ? (t.aiUrgency === 'high' ? 'high' : 'medium') : (t.aiUrgency || null),
    reason, why,
    aiClassified: !!t.aiClassified, aiCategory: t.aiCategory || null, triagedAt: t.triagedAt || null,
    promoted: !!t.promoted, dismissed: !!t.dismissed, dismissReason: t.dismissReason || null, dismissedAt: t.dismissedAt || null,
  };
}

function _rows(mailboxes = INBOXES) {
  const boxes = mailboxes.filter((m) => INBOXES.includes(m));
  if (!boxes.length) return [];
  return _db().all(`SELECT * FROM personal_inbox WHERE mailbox IN (${boxes.map(() => '?').join(',')}) ORDER BY received DESC`, boxes);
}
function _row(id) {
  const r = _db().get('SELECT * FROM personal_inbox WHERE id = ?', [String(id || '')]);
  return r && INBOXES.includes(r.mailbox) ? r : null;
}

// ── mute rules: their OWN keys, the work inbox's normalisation ───────────────

const { normaliseSender, normaliseSubject, subjectRuleKey } = et._internals;
function _readMap(key) {
  try { const p = JSON.parse(_db().getState(key) || '{}'); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; }
}
function _writeMap(key, m) { _db().setState(key, JSON.stringify(m)); }

function _ownAddresses() {
  const pm = require('./personal-mail');
  const own = INBOXES.map((k) => pm.addressFor(k)).concat(['saim', 'neuro'].map((k) => pm.addressFor(k)));
  try { own.push(require('./mail-identity').WORK_ADDRESS); } catch { /* not knowing is not a reason to refuse */ }
  return new Set(own.map((a) => normaliseSender(a)).filter(Boolean));
}

function muteSender(address, { name = null, subject = null } = {}) {
  const key = normaliseSender(address);
  if (!key) return { ok: false, reason: 'no sender address on that email' };
  if (_ownAddresses().has(key)) return { ok: false, reason: 'that is one of your own addresses' };
  const rules = _readMap(SENDER_RULES_KEY);
  const existing = rules[key];
  rules[key] = { address: key, name: name || existing?.name || null, mutedAt: existing?.mutedAt || new Date().toISOString(), sampleSubject: existing?.sampleSubject || subject || null };
  _writeMap(SENDER_RULES_KEY, rules);
  return { ok: true, kind: 'sender', muted: key, alreadyMuted: !!existing };
}
function unmuteSender(address) {
  const key = normaliseSender(address);
  const rules = _readMap(SENDER_RULES_KEY);
  if (!key || !rules[key]) return { ok: false, reason: 'that sender is not muted' };
  delete rules[key];
  _writeMap(SENDER_RULES_KEY, rules);
  return { ok: true, unmuted: key };
}
function muteSubject(address, subject, { name = null } = {}) {
  const key = subjectRuleKey(address, subject);
  if (!key) return { ok: false, reason: normaliseSender(address) ? 'that email has no subject to mute' : 'no sender address on that email' };
  const rules = _readMap(SUBJECT_RULES_KEY);
  const existing = rules[key];
  rules[key] = { key, address: normaliseSender(address), name: name || existing?.name || null, subject: existing?.subject || String(subject || '').trim(), mutedAt: existing?.mutedAt || new Date().toISOString() };
  _writeMap(SUBJECT_RULES_KEY, rules);
  return { ok: true, kind: 'subject', key, subject: rules[key].subject, address: rules[key].address, alreadyMuted: !!existing };
}
function unmuteSubject(key) {
  const rules = _readMap(SUBJECT_RULES_KEY);
  if (!key || !rules[key]) return { ok: false, reason: 'that subject is not muted' };
  delete rules[key];
  _writeMap(SUBJECT_RULES_KEY, rules);
  return { ok: true, unmuted: key };
}
function listMuted() {
  const by = (a, b) => String(b.mutedAt || '').localeCompare(String(a.mutedAt || ''));
  return { senders: Object.values(_readMap(SENDER_RULES_KEY)).sort(by), subjects: Object.values(_readMap(SUBJECT_RULES_KEY)).sort(by) };
}

/** PURE. What a mute rule does to one undismissed row's triage, or null. */
function muteVerdict(row, t, senders, subjects) {
  if (t.dismissed) return null;
  const s = normaliseSender(row.from_email);
  if (s && senders[s]) return SENDER_MUTED;
  const k = subjectRuleKey(row.from_email, row.subject);
  if (k && subjects[k]) return SUBJECT_MUTED;
  return null;
}

/** Apply the mute rules to every row; returns how many were filed. */
function _applyMutes(now = new Date().toISOString()) {
  const senders = _readMap(SENDER_RULES_KEY);
  const subjects = _readMap(SUBJECT_RULES_KEY);
  if (!Object.keys(senders).length && !Object.keys(subjects).length) return 0;
  let filed = 0;
  for (const row of _rows()) {
    const t = _parse(row.triage_json);
    const v = muteVerdict(row, t, senders, subjects);
    if (!v) continue;
    _write(row.id, { ...t, dismissed: true, dismissedAt: now, dismissReason: v });
    filed += 1;
  }
  return filed;
}

/** The FYI section ages out exactly as the work one does (FYI + IGNORE, never ACTION/DELEGATE/promoted). */
function _ageOut(now = Date.now()) {
  const rows = _rows();
  const entries = rows.map(entryOf);
  const { entries: out, aged } = et._internals.ageOutInformational(entries, { now });
  if (!aged) return 0;
  out.forEach((e, i) => {
    if (e.dismissed && !entries[i].dismissed) {
      const t = _parse(rows[i].triage_json);
      _write(rows[i].id, { ...t, dismissed: true, dismissedAt: e.dismissedAt, dismissReason: AGED_OUT });
    }
  });
  return aged;
}

// ── classifying ──────────────────────────────────────────────────────────────

/**
 * Sort what has no model answer yet (newest first, at most MAX_PER_PASS), then
 * re-apply mutes and the FYI age-out. Run inside the personal-inbox pass.
 * `deps.classifyBatch(batch)` replaces the model in tests. Never throws.
 */
async function classifyPending({ deps = {}, limit = MAX_PER_PASS } = {}) {
  const classify = deps.classifyBatch || ((batch) => et._internals.classifyBatch(batch, { buildPrompt: personalPrompt, shadow: false }));
  const rows = _rows();
  const pending = rows.filter((r) => { const t = _parse(r.triage_json); return !t.aiClassified && !t.dismissed; });
  const todo = pending.slice(0, limit);
  const out = { pending: pending.length, asked: todo.length, classified: 0, unanswered: 0, failedBatches: 0, reused: rows.length - pending.length, deferred: pending.length - todo.length };
  const B = et._internals.CLASSIFY_BATCH;
  for (let i = 0; i < todo.length; i += B) {
    const slice = todo.slice(i, i + B);
    const batch = slice.map((r) => ({ id: r.id, from: r.from_name || r.from_email || '', fromEmail: r.from_email || '', subject: r.subject || '', preview: r.preview || '' }));
    let answers = [];
    try { answers = await classify(batch); } catch (e) {
      out.failedBatches += 1;
      console.warn(`[PersonalTriage] batch ${i}-${i + slice.length - 1} failed: ${e.message}`);
    }
    const byId = new Map((answers || []).map((a) => [a.id, a]));
    for (const r of slice) {
      const t = _parse(r.triage_json);
      const a = byId.get(r.id);
      const cat = a && String(a.category || '').toUpperCase();
      if (!a || !CATEGORIES.has(cat)) {
        // No answer is NO ANSWER: unsorted, retried next pass, never FYI.
        out.unanswered += 1;
        _write(r.id, { ...t, aiClassified: false, attempts: (t.attempts || 0) + 1, lastAttemptAt: new Date().toISOString() });
        continue;
      }
      const urg = String(a.urgency || '').toLowerCase();
      _write(r.id, {
        ...t, aiClassified: true, aiCategory: cat, aiUrgency: URGENCIES.has(urg) ? urg : 'low',
        aiReason: String(a.reason || '').slice(0, 80), triagedAt: new Date().toISOString(),
      });
      out.classified += 1;
    }
  }
  if (out.unanswered) console.warn(`[PersonalTriage] ${out.unanswered}/${todo.length} emails got no model answer — left unsorted, retried next pass`);
  if (out.asked) console.log(`[PersonalTriage] sorted ${out.classified}, reused ${out.reused}${out.deferred ? `, ${out.deferred} left for the next pass` : ''}`);
  out.muted = _applyMutes();
  out.agedOut = _ageOut();
  _db().setState(LAST_RUN_KEY, String(Date.now()));
  return out;
}

// ── reading ──────────────────────────────────────────────────────────────────

/** The sections, like the work Inbox's GET /api/email/triage. `mailbox` = 'all' or one of nick/contact/gmail. */
function byLane({ mailbox = 'all' } = {}) {
  const boxes = mailbox === 'all' ? INBOXES : [mailbox];
  if (!boxes.every((b) => INBOXES.includes(b))) return null;
  const live = _rows(boxes).map(entryOf).filter((e) => !e.dismissed);
  return {
    mailbox,
    urgent: live.filter((e) => e.lane === 'urgent'),
    reply: live.filter((e) => e.lane === 'reply'),
    action: live.filter((e) => e.category === 'ACTION'),
    delegate: live.filter((e) => e.category === 'DELEGATE'),
    fyi: live.filter((e) => e.category === 'FYI'),
    ignore: live.filter((e) => e.category === 'IGNORE'),
    unsorted: live.filter((e) => e.lane === 'unsorted'),
    lastRun: _db().getState(LAST_RUN_KEY) || null,
    fyiAgeOutDays: et._internals.AGE_OUT_DAYS,
    feedback: getFeedback(),
  };
}

// ── verdicts ─────────────────────────────────────────────────────────────────

function _readRollup() {
  try {
    const r = JSON.parse(_db().getState(FEEDBACK_KEY) || '{}');
    return { judged: r.judged || 0, notRelevant: r.notRelevant || 0, underRanked: r.underRanked || 0, byCategory: r.byCategory || {} };
  } catch { return { judged: 0, notRelevant: 0, underRanked: 0, byCategory: {} }; }
}
function _fold(entry, kind) {
  const r = _readRollup();
  const key = `${entry.urgency || 'none'}/${entry.category || 'unsorted'}`;
  const b = r.byCategory[key] || { judged: 0, notRelevant: 0, underRanked: 0 };
  b.judged += 1; r.judged += 1;
  if (kind === 'not-relevant') { b.notRelevant += 1; r.notRelevant += 1; }
  if (kind === 'under') { b.underRanked = (b.underRanked || 0) + 1; r.underRanked += 1; }
  r.byCategory[key] = b;
  _db().setState(FEEDBACK_KEY, JSON.stringify(r));
}
/** How the personal sort scores against Nick's verdicts. Only his verdicts count; null when there are none. */
function getFeedback() {
  const r = _readRollup();
  return {
    judged: r.judged, notRelevant: r.notRelevant, underRanked: r.underRanked,
    misrankRate: r.judged ? Math.round(((r.notRelevant + r.underRanked) / r.judged) * 100) : null,
    byCategory: r.byCategory,
  };
}

/**
 * SYNC core of a dismissal: record the reason, fold a real verdict into the
 * feedback, and (for not-relevant) mute the subject or the sender. The
 * executor calls this with 'replied' after a send. Returns { ok, muted } or
 * { ok:false, reason }.
 */
function recordDismissal(id, reason = 'unspecified', { mute = null } = {}) {
  const row = _row(id);
  if (!row) return { ok: false, reason: 'not in the personal inbox' };
  const clean = DISMISS_REASONS.has(reason) ? reason : 'unspecified';
  const t = _parse(row.triage_json);
  const entry = entryOf(row);
  const now = new Date().toISOString();
  const already = !!t.dismissed;
  _write(row.id, { ...t, dismissed: true, dismissedAt: already ? t.dismissedAt : now, dismissReason: already ? t.dismissReason : clean });
  // A verdict counts once: pressing Done on something already filed adds nothing.
  if (!already && JUDGED.has(clean)) _fold(entry, clean);
  let muted = null;
  if (clean === 'not-relevant') {
    muted = mute === 'sender'
      ? muteSender(row.from_email, { name: row.from_name, subject: row.subject })
      : muteSubject(row.from_email, row.subject, { name: row.from_name });
    if (muted.ok) _applyMutes(now);
  }
  return { ok: true, muted };
}

/**
 * The card's Done / Read & dismiss / Subject not relevant / Mute sender.
 * `markRead` also sets \Seen on the server mailbox; the dismissal stands
 * whether or not that half worked, and a failure is reported in words.
 */
async function dismiss(id, { reason = 'done', markRead = false, mute = null, deps } = {}) {
  const r = recordDismissal(id, reason, { mute });
  if (!r.ok) return r;
  let readError = null;
  if (markRead) {
    try {
      const m = await require('./personal-inbox').markRead(id, { deps });
      if (!m || !m.marked) readError = `Dismissed, but it could not be marked read in the mailbox (${(m && m.reason) || 'error'}).`;
    } catch (e) { readError = `Dismissed, but it could not be marked read in the mailbox (${e.message}).`; }
  }
  return { ...r, ...(readError ? { readError } : {}) };
}

/** "Needs action": move it to Action and keep it there through every re-sort. */
function promote(id) {
  const row = _row(id);
  if (!row) return { ok: false, reason: 'not in the personal inbox' };
  const t = _parse(row.triage_json);
  if (t.dismissed) return { ok: false, reason: 'already dismissed' };
  if (t.promoted) return { ok: true, promoted: true, already: true };
  const before = entryOf(row);
  _write(row.id, { ...t, promoted: true, promotedAt: new Date().toISOString() });
  _fold(before, 'under');
  return { ok: true, promoted: true };
}

/** Clear the FYI section (FYI + IGNORE) of one mailbox or all. dryRun = the count the confirm quotes. */
function clearFyi({ mailbox = 'all', dryRun = false } = {}) {
  const boxes = mailbox === 'all' ? INBOXES : [mailbox];
  if (!boxes.every((b) => INBOXES.includes(b))) return { ok: false, error: 'no such mailbox' };
  const rows = _rows(boxes);
  const entries = rows.map(entryOf);
  const { entries: out, cleared } = et._internals.clearInformational(entries);
  if (cleared && !dryRun) {
    out.forEach((e, i) => {
      if (e.dismissed && !entries[i].dismissed) _write(rows[i].id, { ..._parse(rows[i].triage_json), dismissed: true, dismissedAt: e.dismissedAt, dismissReason: SECTION_CLEARED });
    });
  }
  return { ok: true, cleared, dryRun };
}

module.exports = {
  INBOXES, MAX_PER_PASS,
  personalPrompt, laneOf, entryOf, muteVerdict,
  classifyPending, byLane, getFeedback,
  recordDismissal, dismiss, promote, clearFyi,
  muteSender, unmuteSender, muteSubject, unmuteSubject, listMuted,
  SENDER_RULES_KEY, SUBJECT_RULES_KEY, FEEDBACK_KEY,
};
