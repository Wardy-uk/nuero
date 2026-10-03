'use strict';

/**
 * Meeting context — the first SEMANTIC evaluator (Build 3D, 3 Oct 2026).
 *
 * Not "meeting in 15 minutes" (the calendar already says that). The question
 * is: before a meeting with other people in it, does NEURO already hold
 * something about THIS meeting worth having in mind as he walks in?
 *
 *   "Tech Leadership starts at 10:00. 2 of your actions from the last one
 *    (7 Sep) are still open, and Naomi still owes you 1 item from it."
 *
 * ── Shadow only. There is no live path in this build. ───────────────────────
 *
 * The evaluator produces a FINDING (meeting_context_findings) and asks the
 * EXISTING attention policy — ambient-push.worthInterrupting, with the same
 * moment and the same universal vetoes — what it WOULD do at the recommended
 * time. It records that verdict. It never sends, never queues, never returns a
 * winner to ambient-push. MEETING_CONTEXT_MODE is shadow (default) or off; a
 * 'live' value is read as shadow on purpose.
 *
 * ── Anti-spam: a finding needs EVIDENCE, not a calendar entry ───────────────
 *
 * Prefer false negatives. A meeting is only considered if it is a REAL meeting
 * (other people in it, per the world model's three-valued `kind` — unknown is
 * not enough), not declined, not a broadcast (> MAX_PARTICIPANTS), and starts
 * in the next 15–75 minutes. It becomes a finding ONLY with one of:
 *
 *   • an open task Nick took on from the PREVIOUS occurrence's write-up
 *   • an open waiting-on item somebody owes him FROM that write-up
 *   • an unanswered high-urgency email from someone in the meeting WHOSE
 *     SUBJECT IS ABOUT IT (shares the meeting title's content words)
 *
 * Open waiting-on items for attendees in general, and urgent emails from them
 * about other things, are SUPPORTING evidence only. Measured on the live data
 * (3 Oct): with any urgent email counting, every meeting Chris attends fired —
 * and every meeting at all, until Nick's own address was recognised (the
 * calendar knows him as nickw@, his People note declares no address). Who NICK
 * is comes from the signed-in Microsoft account; if that cannot be read, email
 * is not assessed at all rather than guessed.
 *
 * ── How "the previous one" is found ─────────────────────────────────────────
 *
 * calendar_history (kept since 29 Aug 2026) gives the last occurrence with the
 * same subject; its write-up is the Meetings/ note dated that day whose PLAUD
 * `start_at` — verified on 17 Sep data to be UTC with no zone marker — falls
 * within that occurrence's span (±20 min). Exactly one candidate, or none.
 * Plaud names notes from its summary, never the calendar subject, so title
 * matching would mostly miss; time is the link.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');
const wm = require('./world-model');

const WINDOW_MIN = 15;
const WINDOW_MAX = 75;
const RECOMMEND_BEFORE_MIN = 20;
const MAX_PARTICIPANTS = 12;
const NOTE_SLACK_MIN = 20;
const SELF_PERSON = 'person:nick-ward';
const MAX_LIST = 5;

function mode() {
  const m = String(process.env.MEETING_CONTEXT_MODE || 'shadow').toLowerCase();
  return m === 'off' ? 'off' : 'shadow';
}

const lower = (s) => String(s || '').trim().toLowerCase();

// Words that say nothing about WHICH meeting: an email mentioning "weekly" is
// not about the Weekly Meeting.
const GENERIC = new Set(['meeting', 'weekly', 'monthly', 'daily', 'catch', 'check', 'sync', 'call', 'review', 'team',
  'update', 'with', 'nick', 'and', 'the', 'for', 'about', 'what', 'mean', 'want', 'session', 'chat']);

function contentWords(s) {
  return [...new Set(lower(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w)))];
}

/** Is this email ABOUT this meeting? PURE. Two content words shared — or the only one the title has. */
function emailRelates(meetingTitle, subject) {
  const title = contentWords(meetingTitle);
  if (!title.length) return false;
  const subj = new Set(contentWords(subject));
  const shared = title.filter((w) => subj.has(w)).length;
  return title.length === 1 ? shared === 1 : shared >= 2;
}

/** A wall-clock minute string shifted by `min` minutes (no zone involved). */
function shiftLocal(local, min) {
  const t = Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), +local.slice(11, 13), +local.slice(14, 16)) + min * 60000;
  return new Date(t).toISOString().slice(0, 16);
}

// ── evidence readers (real stores; injectable for tests) ────────────────────

function _previousOccurrence(meeting) {
  return db.get(
    `SELECT start_time, end_time, subject FROM calendar_history
      WHERE lower(trim(subject)) = ? AND substr(start_time, 1, 10) < ? AND attendees_other = 1
      ORDER BY start_time DESC LIMIT 1`,
    [lower(meeting.title), meeting.start.slice(0, 10)]
  );
}

function _noteFor(occ, vaultRoot = process.env.OBSIDIAN_VAULT_PATH) {
  if (!occ) return { note: null, why: 'no earlier occurrence in calendar history (kept since 29 Aug 2026)' };
  if (!vaultRoot) return { note: null, why: 'vault not configured', unreadable: true };
  const day = occ.start_time.slice(0, 10);
  const dir = path.join(vaultRoot, 'Meetings', day.slice(0, 4), day.slice(5, 7));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(day) && f.endsWith('.md')); } catch {
    return { note: null, why: `no Meetings folder for ${day.slice(0, 7)}` };
  }
  const start = occ.start_time.slice(0, 16);
  const end = (occ.end_time || occ.start_time).slice(0, 16);
  const lo = shiftLocal(start, -NOTE_SLACK_MIN);
  const hi = shiftLocal(end, NOTE_SLACK_MIN);
  const hits = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { continue; }
    const m = text.match(/^start_at:\s*"?([0-9T:-]+)/m);
    if (!m) continue;
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(m[1]) ? m[1] : `${m[1]}Z`); // PLAUD writes UTC, unmarked
    if (!Number.isFinite(ms)) continue;
    const local = wm.localMinute(ms);
    if (local >= lo && local <= hi) hits.push(`Meetings/${day.slice(0, 4)}/${day.slice(5, 7)}/${f}`);
  }
  if (hits.length === 1) return { note: hits[0], why: null };
  if (hits.length > 1) return { note: null, why: `${hits.length} write-ups match that occurrence — not guessing which` };
  return { note: null, why: `no write-up found for the ${day} occurrence` };
}

function _tasksFromNote(notePath) {
  return db.all(
    `SELECT id, text, status, due_date FROM tasks
      WHERE (origin_path = ? OR origin_path LIKE ?) AND status IN ('open', 'in-progress') ORDER BY id`,
    [notePath, `%/${notePath}`]
  );
}

function _waitingOn() {
  return require('./waiting-on').list({ status: 'open' });
}

function _flaggedEmails() {
  return require('./email-triage').getFlaggedItems();
}

function _uniqueFirstName(displayName) {
  try {
    const first = String(displayName || '').split(/\s+/)[0];
    const owner = require('./entities').getRoster().firstNames.get(first.toLowerCase());
    return owner === displayName ? first : null;
  } catch { return null; }
}

const DEFAULT_DEPS = {
  previousOccurrence: _previousOccurrence,
  noteFor: (occ) => _noteFor(occ),
  tasksFromNote: _tasksFromNote,
  waitingOn: _waitingOn,
  flaggedEmails: _flaggedEmails,
  uniqueFirstName: _uniqueFirstName,
  // Who NICK is: the signed-in Microsoft account (authoritative) plus any
  // address his People note declares. Async; resolved once per evaluate().
  selfEmails: async () => {
    const out = [];
    try { const a = await require('./microsoft').getSignedInAddress(); if (a) out.push(a); } catch { /* unknown */ }
    const p = wm.getPerson(SELF_PERSON);
    return out.concat(p ? p.emails : []);
  },
  readMoment: (now) => require('./ambient-push').readMoment({ now: new Date(now) }),
};

// ── the judgement ───────────────────────────────────────────────────────────

/**
 * Gather bounded evidence for one meeting. Every reader that fails is a
 * MISSING item with a reason, never an empty result — "could not look" and
 * "nothing there" are different facts, and only the second is evidence.
 */
function gather(meeting, deps) {
  const evidence = { previous: null, commitments: [], owedFromPrevious: [], attendeeOwed: [], emails: [], otherEmails: 0 };
  const missing = [];
  const self = new Set((Array.isArray(deps.self) ? deps.self : []).map(lower));
  if (!self.size) missing.push({ input: 'self', why: 'NEURO cannot tell which attendee is Nick (no signed-in address) — email not assessed' });
  const others = meeting.participants.filter((p) => !self.has(p.email) && p.personId !== SELF_PERSON);
  const otherEmails = new Set(others.map((p) => p.email));

  let note = null;
  try {
    const occ = deps.previousOccurrence(meeting);
    const found = deps.noteFor(occ);
    note = found.note;
    if (occ) evidence.previous = { start: occ.start_time.slice(0, 16), title: occ.subject, notePath: note };
    if (!note) missing.push({ input: 'previous-write-up', why: found.why });
  } catch (e) { missing.push({ input: 'previous-write-up', why: `unreadable: ${e.message}` }); }

  if (note) {
    try {
      evidence.commitments = deps.tasksFromNote(note).slice(0, MAX_LIST)
        .map((t) => ({ taskId: t.id, text: String(t.text).slice(0, 160), status: t.status, due: t.due_date || null }));
    } catch (e) { missing.push({ input: 'tasks', why: `unreadable: ${e.message}` }); }
  }

  let waiting = null;
  try { waiting = deps.waitingOn(); } catch (e) { missing.push({ input: 'waiting-on', why: `unreadable: ${e.message}` }); }
  if (waiting) {
    if (note) {
      evidence.owedFromPrevious = waiting.filter((w) => w.sourcePath === note).slice(0, MAX_LIST)
        .map((w) => ({ key: w.key, person: w.person, text: String(w.text).slice(0, 160) }));
    }
    for (const p of others.filter((x) => x.personId)) {
      const first = deps.uniqueFirstName(p.displayName);
      if (!first) continue; // an ambiguous first name attributes nothing
      const items = waiting.filter((w) => w.person === first);
      if (items.length) evidence.attendeeOwed.push({ personId: p.personId, displayName: p.displayName, open: items.length });
    }
  }

  if (self.size) {
    try {
      const flagged = deps.flaggedEmails();
      if (!flagged || !flagged.lastScan) missing.push({ input: 'email', why: 'triage has never run — not the same as no email' });
      else {
        const fromOthers = (flagged.items || []).filter((e) => otherEmails.has(lower(e.fromEmail)) && e.urgency === 'high');
        const relevant = fromOthers.filter((e) => emailRelates(meeting.title, e.subject));
        evidence.emails = relevant.slice(0, MAX_LIST)
          .map((e) => ({ emailId: e.emailId, from: e.from, subject: String(e.subject || '').slice(0, 160), received: e.received }));
        // Supporting only: urgent, from someone in the meeting, about something else.
        evidence.otherEmails = fromOthers.length - relevant.length;
      }
    } catch (e) { missing.push({ input: 'email', why: `unreadable: ${e.message}` }); }
  }

  return { evidence, missing, others };
}

/**
 * Should this meeting produce a finding? PURE over the gathered evidence.
 * Returns { finding: bool, why, confidence, triggers }.
 */
/** The structural gate: is this a meeting worth considering at all? PURE. null = yes, else why not. */
function gate(meeting) {
  if (meeting.kind !== 'meeting') return `not a meeting with other people (${meeting.kind})`;
  if (meeting.responseStatus === 'declined') return 'declined';
  if (meeting.participants.length > MAX_PARTICIPANTS) return `a broadcast (${meeting.participants.length} people)`;
  return null;
}

function assess(meeting, gathered) {
  const blocked = gate(meeting);
  if (blocked) return { finding: false, why: blocked };
  const e = gathered.evidence;
  const triggers = [];
  if (e.commitments.length) triggers.push('open-commitments-from-previous');
  if (e.owedFromPrevious.length) triggers.push('owed-from-previous');
  if (e.emails.length) triggers.push('urgent-email-from-attendee');
  if (!triggers.length) return { finding: false, why: 'nothing NEURO holds is specific to this meeting' };
  // Starts at 0.6; each independent kind of evidence adds 0.1; capped. A
  // missing reader lowers it — the read is thinner than it looks.
  const confidence = Math.max(0.3, Math.min(0.9, 0.5 + 0.1 * triggers.length + (e.attendeeOwed.length ? 0.05 : 0)
    - 0.05 * gathered.missing.filter((m) => /unreadable/.test(m.why)).length));
  return { finding: true, why: triggers.join(', '), confidence: Math.round(confidence * 100) / 100, triggers };
}

const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

/** One sentence, deterministic, no model. States the evidence; draws no conclusion. */
function summarise(meeting, evidence) {
  const parts = [`${meeting.title} starts at ${meeting.start.slice(11, 16)}.`];
  const prevDay = evidence.previous ? evidence.previous.start.slice(0, 10) : null;
  if (evidence.commitments.length) parts.push(`${plural(evidence.commitments.length, 'action', 'actions')} you took from the last one${prevDay ? ` (${prevDay})` : ''} ${evidence.commitments.length === 1 ? 'is' : 'are'} still open.`);
  if (evidence.owedFromPrevious.length) {
    const who = [...new Set(evidence.owedFromPrevious.map((w) => w.person))].join(', ');
    parts.push(`${who} still ${evidence.owedFromPrevious.length === 1 ? 'owes' : 'owe'} you ${plural(evidence.owedFromPrevious.length, 'item', 'items')} from it.`);
  }
  if (evidence.emails.length) parts.push(`${plural(evidence.emails.length, 'urgent email', 'urgent emails')} from people in it ${evidence.emails.length === 1 ? 'is' : 'are'} unanswered.`);
  return parts.join(' ');
}

// ── the store ───────────────────────────────────────────────────────────────

function _fingerprint(x) {
  return crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);
}

function _row(id) { return db.get('SELECT * FROM meeting_context_findings WHERE finding_id = ?', [id]); }

/**
 * One pass. Runs from the durable runtime every five minutes.
 * Returns { considered, created, updated, withdrawn, expired, decided, skipped }.
 */
async function evaluate({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (!Array.isArray(d.self)) {
    try { d.self = await Promise.resolve(d.selfEmails()); } catch { d.self = []; }
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const nowLocal = wm.localMinute(nowMs);
  const iso = new Date(nowMs).toISOString();
  const out = { mode: mode(), considered: 0, created: 0, updated: 0, withdrawn: 0, expired: 0, decided: 0, skipped: [] };
  if (out.mode === 'off') return out;

  out.expired = db.run(`UPDATE meeting_context_findings SET status = 'expired', updated_at = ?
                         WHERE status = 'active' AND start_local <= ?`, [iso, nowLocal]).changes;

  const candidates = wm.nextMeetings({ now: nowMs, limit: 20, withinMinutes: WINDOW_MAX })
    .filter((m) => wm.minutesBetween(nowLocal, m.start) >= WINDOW_MIN);
  for (const meeting of candidates) {
    out.considered += 1;
    const id = `meeting-context:${meeting.meetingId}:${meeting.start}`;
    const existing = _row(id);
    const gathered = gather(meeting, d);
    const verdict = assess(meeting, gathered);
    if (!verdict.finding) {
      out.skipped.push({ meetingId: meeting.meetingId, why: verdict.why });
      if (existing && existing.status === 'active') {
        db.run(`UPDATE meeting_context_findings SET status = 'withdrawn', updated_at = ?, trigger_json = ? WHERE finding_id = ?`,
          [iso, JSON.stringify({ why: verdict.why }), id]);
        out.withdrawn += 1;
      }
      continue;
    }
    const recommended = (() => {
      const r = shiftLocal(meeting.start, -RECOMMEND_BEFORE_MIN);
      return r < nowLocal ? nowLocal : r;
    })();
    const evidenceRefs = {
      ...gathered.evidence,
      meetingEvidence: meeting.provenance.evidence,
      sources: meeting.sources.map((s) => `${s.provider}:${s.role}`),
      people: meeting.people,
    };
    const fp = _fingerprint([evidenceRefs, gathered.missing, verdict.triggers]);
    const fields = [meeting.meetingId, meeting.title, meeting.start, JSON.stringify({ why: verdict.why, triggers: verdict.triggers }),
      JSON.stringify(evidenceRefs), JSON.stringify(gathered.missing), verdict.confidence, recommended,
      summarise(meeting, gathered.evidence), fp, iso];
    if (!existing) {
      db.run(`INSERT INTO meeting_context_findings (meeting_id, title, start_local, trigger_json, evidence_json, missing_json,
                confidence, recommended_at_local, summary, evidence_fingerprint, updated_at, finding_id, status, first_created_at, decisions)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0)`, [...fields, id, iso]);
      out.created += 1;
      console.log(`[MeetingContext] (shadow) ${summarise(meeting, gathered.evidence)}`);
    } else if (existing.evidence_fingerprint !== fp || existing.status !== 'active') {
      db.run(`UPDATE meeting_context_findings SET meeting_id = ?, title = ?, start_local = ?, trigger_json = ?, evidence_json = ?,
                missing_json = ?, confidence = ?, recommended_at_local = ?, summary = ?, evidence_fingerprint = ?, updated_at = ?,
                status = 'active' WHERE finding_id = ?`, [...fields, id]);
      out.updated += 1;
    }
  }

  // What the EXISTING attention policy would do, once per finding, at the
  // recommended moment. Shadow: recorded, never sent.
  const due = db.all(`SELECT * FROM meeting_context_findings WHERE status = 'active' AND attention_decided_at IS NULL
                       AND recommended_at_local <= ?`, [nowLocal]);
  for (const f of due) {
    let decision;
    try {
      const { moment } = await d.readMoment(nowMs);
      const ap = require('./ambient-push');
      const v = ap.worthInterrupting({ kind: 'meeting-context', text: f.summary, findingId: f.finding_id }, moment);
      decision = { push: !!v.push, why: v.why || null, urgency: v.urgency || null, wouldSay: v.push ? v.message : null };
    } catch (e) {
      decision = { push: false, why: `could not read the moment: ${e.message}` };
    }
    db.run(`UPDATE meeting_context_findings SET attention_decided_at = ?, attention_json = ?, attention_mode = 'shadow',
              decisions = decisions + 1, updated_at = ? WHERE finding_id = ?`,
    [iso, JSON.stringify({ ...decision, shadow: true, sent: false }), iso, f.finding_id]);
    out.decided += 1;
  }
  return out;
}

function findings({ status = null, limit = 50 } = {}) {
  const rows = status
    ? db.all('SELECT * FROM meeting_context_findings WHERE status = ? ORDER BY start_local DESC LIMIT ?', [status, limit])
    : db.all('SELECT * FROM meeting_context_findings ORDER BY start_local DESC LIMIT ?', [limit]);
  return rows.map((r) => ({
    findingId: r.finding_id, meetingId: r.meeting_id, title: r.title, start: r.start_local, status: r.status,
    summary: r.summary, confidence: r.confidence, recommendedAt: r.recommended_at_local,
    trigger: JSON.parse(r.trigger_json), evidence: JSON.parse(r.evidence_json), missing: JSON.parse(r.missing_json),
    attention: r.attention_json ? { mode: r.attention_mode, decidedAt: r.attention_decided_at, ...JSON.parse(r.attention_json) } : null,
    firstCreatedAt: r.first_created_at, updatedAt: r.updated_at,
  }));
}

module.exports = {
  mode, gate, gather, assess, summarise, evaluate, findings, shiftLocal, emailRelates, DEFAULT_DEPS,
  WINDOW_MIN, WINDOW_MAX, RECOMMEND_BEFORE_MIN, MAX_PARTICIPANTS,
  _noteFor,
};
