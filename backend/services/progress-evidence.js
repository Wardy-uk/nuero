'use strict';

/**
 * Progress evidence (Build 5D, 3 Oct 2026).
 *
 * An open commitment is not proof that nothing happened. Nick sends the figures
 * from Outlook, ticks a line in a later meeting note, and the task in NEURO
 * stays open because he never came back to it. This answers one bounded
 * question per commitment: has anything NEURO can see since it was made said it
 * moved, or happened?
 *
 * ── Fact, observation, inference — and never more than that ────────────────
 *
 *  FACT         an authoritative source says so: the commitment is completed
 *               (a NEURO tick, a Planner completion, Nick marking a waiting-on
 *               done), cancelled, or reopened. Only facts change status, and
 *               NOTHING in this file changes status.
 *  OBSERVATION  something NEURO saw: an email Nick sent to that person whose
 *               subject shares content words with the commitment; a later
 *               note line that matches it. Stored as evidence with the exact
 *               rule that matched and what it matched on.
 *  INFERENCE    what the observations together suggest: `likely_fulfilled`.
 *               Derived at read time by deriveProgress(), recorded with its
 *               reasons, and kept SEPARATE from status. "Probably sent" is
 *               never "done".
 *
 * ── Precedence (deriveProgress, PURE) ───────────────────────────────────────
 *
 *   1. authoritative completed               → fulfilled          (fact)
 *   2. authoritative cancelled / superseded  → closed             (fact)
 *   3. inferred done, then a NEWER authoritative reopen or a newer
 *      "still outstanding" line              → contradicted       (fact beats inference)
 *   4. strong done observation               → likely_fulfilled   (inference)
 *   5. any progress observation, or the task marked in progress
 *                                            → progress_observed  (observation)
 *   6. nothing, every applicable source read → no_evidence
 *   7. nothing, and a source could not be read → unknown
 *
 * Absence is never evidence of completion: a commitment that stops appearing
 * in later notes stays exactly where it was.
 *
 * ── Bounded on purpose ──────────────────────────────────────────────────────
 *
 * Sent mail: only messages to the commitment's own counterparty (the named
 * beneficiary, the person who owes it, or a KNOWN attendee list of the meeting
 * it came from), sent after it was made, sharing at least one content word
 * with it. "Nick emailed Chris" is not evidence about any particular promise
 * to Chris, and is never recorded. Metadata only — no bodies.
 *
 * Later notes: meeting write-ups dated AFTER the one it came from (never the
 * same recording's other variants), and daily notes from the day it was made,
 * within LATER_NOTE_DAYS. A line must match the commitment at the same strict
 * score the action-candidate fold uses (0.85), measured on exactly this
 * vocabulary — Nick's own meetings, where every action reads "Nick will …".
 *
 * Evidence is published as `observation.progress.evidence` and folded in the
 * world-model consumer (alongside the commitments it is about), so a replay of
 * the log reproduces every progress state exactly.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/database');

const LATER_NOTE_DAYS = 60;
const SENT_MAIL_DAYS = 60;
const MAX_NOTE_FILES = 400;
const MAX_EVIDENCE_PER_COMMITMENT = 5;
const LINE_MATCH_SCORE = 0.85; // action-candidates.FOLD_SCORE: measured on meeting-extracted wording
const SCAN_THROTTLE_MS = 30 * 60 * 1000;
const SCAN_STATE_KEY = 'progress_evidence_scan';
const SELF = 'person:nick-ward';

const STATES = ['fulfilled', 'closed', 'contradicted', 'likely_fulfilled', 'progress_observed', 'no_evidence', 'unknown'];

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };

// ── the fold (world-model consumer) ─────────────────────────────────────────

function applyEvidence(ev) {
  const p = ev.payload;
  if (!p || !p.commitmentId || !p.kind || !p.ref) return;
  db.run(`INSERT INTO wm_progress_evidence (commitment_id, kind, ref, evidence_event_id, at, polarity, strength,
            provenance_kind, reason, detail_json, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'observation', ?, ?, ?)
          ON CONFLICT(commitment_id, kind, ref) DO UPDATE SET evidence_event_id = excluded.evidence_event_id,
            at = excluded.at, polarity = excluded.polarity, strength = excluded.strength, reason = excluded.reason,
            detail_json = excluded.detail_json, received_at = excluded.received_at`,
  [p.commitmentId, p.kind, String(p.ref), ev.eventId, p.at, p.polarity, p.strength, p.reason || null,
    JSON.stringify({ ...(p.detail || {}), rule: p.rule || null }), ev.receivedAt]);
}

function reset() { db.run('DELETE FROM wm_progress_evidence'); }

// ── the judgement (PURE) ────────────────────────────────────────────────────

/**
 * The derived progress state of one commitment. PURE: everything it needs is
 * passed in. Never returns a status — `state` is a reading, not an authority.
 *
 *   commitment  shaped commitment (status, completionAuthority, completedAt)
 *   task        shaped linked task or null
 *   evidence    [{ evidenceId, kind, ref, at, polarity, strength, reason, detail }]
 *   history     [{ change, at, authority }] for this commitment
 *   coverage    { sentMail: 'ok'|'unavailable'|'not-applicable', laterNotes: 'ok'|'unavailable'|'not-applicable' }
 */
function deriveProgress({ commitment, task = null, evidence = [], history = [], coverage = {} }) {
  const out = (state, basis, reasons, extra = {}) => ({ state, basis, reasons, evidenceIds: [], ...extra });
  if (!commitment) return out('unknown', 'none', ['no such commitment']);

  if (commitment.status === 'completed') {
    return out('fulfilled', 'fact', [`completed by ${commitment.completionAuthority || 'its owning source'}`],
      { authority: commitment.completionAuthority || null, at: commitment.completedAt || null });
  }
  if (commitment.status === 'cancelled' || commitment.status === 'superseded') {
    return out('closed', 'fact', [`${commitment.status} by its owning source`]);
  }
  // The commitment follows its task; a completed task ahead of the projection
  // catching up is still a fact.
  if (task && task.status === 'completed') {
    return out('fulfilled', 'fact', [`linked task completed by ${task.completionAuthority || 'its owning source'}`],
      { authority: task.completionAuthority || null, at: task.completedAt || null });
  }

  const ev = Array.isArray(evidence) ? evidence : [];
  const done = ev.filter((e) => e.polarity === 'done' && e.strength === 'strong');
  const notDone = ev.filter((e) => e.polarity === 'not-done');
  const progress = ev.filter((e) => e.polarity === 'progress' || (e.polarity === 'done' && e.strength !== 'strong'));
  const reopens = (Array.isArray(history) ? history : []).filter((h) => h.change === 'reopened');

  if (done.length) {
    const lastDone = done.map((e) => String(e.at)).sort().pop();
    const laterReopen = reopens.filter((h) => String(h.at) > lastDone);
    const laterOpenLine = notDone.filter((e) => String(e.at) > lastDone);
    if (laterReopen.length || laterOpenLine.length) {
      const reasons = [];
      if (laterReopen.length) reasons.push(`reopened by ${laterReopen[laterReopen.length - 1].authority || 'its owning source'} after the evidence`);
      if (laterOpenLine.length) reasons.push('a later note lists it as still open');
      return out('contradicted', 'fact', [...reasons, 'the authoritative state beats the inference: it stays open'],
        { evidenceIds: [...done, ...laterOpenLine].map((e) => e.evidenceId) });
    }
    return out('likely_fulfilled', 'inference', done.map((e) => e.reason || e.kind),
      { evidenceIds: done.map((e) => e.evidenceId), confidence: done.length > 1 ? 0.8 : 0.65,
        note: 'an inference from what NEURO saw, not a completion: the commitment stays open until its owning source closes it' });
  }

  const marked = task && task.rawStatus === 'in-progress';
  if (progress.length || marked) {
    const reasons = progress.map((e) => e.reason || e.kind);
    if (marked) reasons.push('linked task marked in progress');
    return out('progress_observed', 'observation', reasons, { evidenceIds: progress.map((e) => e.evidenceId) });
  }

  const blind = Object.entries(coverage || {}).filter(([, v]) => v === 'unavailable').map(([k]) => k);
  if (blind.length) {
    return out('unknown', 'none', [`could not look: ${blind.join(', ')} — not the same as nothing having happened`],
      notDone.length ? { restatedOpen: notDone.length } : {});
  }
  return out('no_evidence', 'none',
    notDone.length ? ['a later note still lists it as open'] : ['nothing NEURO checked says it moved'],
    notDone.length ? { restatedOpen: notDone.length, evidenceIds: notDone.map((e) => e.evidenceId) } : {});
}

// ── matching rules (PURE) ───────────────────────────────────────────────────

let _dedupe = null;
const dd = () => (_dedupe || (_dedupe = require('./task-dedupe')));

// A commitment whose ACT is a communication can be done by an email. One whose
// act is anything else ("build the dashboard") cannot: an email about it is
// progress at most.
const DELIVERY_VERB = /\b(send|share|provide|forward|email|e-mail|deliver|submit|circulate|confirm|reply|respond|update|inform|tell|feed\s*back|follow\s+up|let\s+\w+\s+know)\b/i;

// Mail that left in Nick's name without Nick writing it: calendar responses,
// sharing and comment notifications, auto-replies. Measured on the first live
// pass (3 Oct): "Nicholas Ward has shared Power BI Report …", "Nick Ward left a
// comment in …" and "Accepted: …" were 6 of the 8 rows recorded.
const AUTOMATED_SUBJECT = /^(accepted|declined|tentative|tentatively accepted|canceled|cancelled|updated invitation|invitation|automatic reply|out of office|undeliverable|read)\s*:|\bhas shared\b|\bshared .* with you\b|\bleft a comment\b|\bmentioned you\b|\bassigned you\b/i;

// Evidence carries the version of the rule that matched it. When a rule is
// found wrong on live data the old rows stay in the append-only log — they
// cannot be removed — but are no longer READ, and every read says how many it
// set aside. Bump a version only with a written reason.
//   sent-email@1 → @2 (3 Oct): one shared word ("team", "call") was enough,
//                  and automated mail in Nick's name counted.
const RULES = { 'sent-email': 'sent-email@2', 'later-note': 'later-note@2' };
const CURRENT_RULES = new Set(Object.values(RULES));

function contentTokens(text, exclude = new Set()) {
  const out = new Set();
  for (const t of dd().tokenize(text)) if (!exclude.has(t)) out.add(t);
  return out;
}

/** Tokens of people's names, so "Chris" in a subject is not a shared content word. */
function nameTokens(names) {
  const out = new Set();
  for (const n of names || []) for (const t of dd().tokenize(n)) out.add(t);
  return out;
}

/**
 * One sent message against one commitment. PURE. Returns an evidence payload
 * body or null. `targets` are the addresses that make a recipient relevant.
 */
function matchSentEmail(commitment, msg, { targets, names = [] }) {
  if (!msg || !commitment || !targets || !targets.size) return null;
  const created = String(commitment.createdAt || '').replace(' ', 'T');
  if (!created || !msg.sentAt || String(msg.sentAt) <= created) return null;
  const recipients = [...(msg.to || []), ...(msg.cc || [])].map((a) => String(a).toLowerCase());
  const hit = recipients.find((a) => targets.has(a));
  if (!hit) return null;
  if (AUTOMATED_SUBJECT.test(String(msg.subject || ''))) return null; // sent in his name, not by him
  const exclude = nameTokens(names);
  const a = contentTokens(commitment.description, exclude);
  const b = contentTokens(msg.subject, exclude);
  const shared = [...a].filter((t) => b.has(t));
  if (!shared.length) return null; // "sent Chris an email" is not evidence about this promise
  // One shared word is a coincidence, not a reference: "team" and "call" are in
  // half his mail (sent-email@2).
  if (shared.length < 2) return null;
  const detail = { recipient: hit, subject: String(msg.subject || '').slice(0, 160), shared, hasAttachments: !!msg.hasAttachments };
  if (commitment.direction !== 'by-nick') {
    return { polarity: 'progress', strength: 'partial', reason: `chased by email: sent to the person who owes it, subject shares "${shared.join(', ')}"`, detail };
  }
  if (shared.length >= 2 && DELIVERY_VERB.test(commitment.description)) {
    return { polarity: 'done', strength: 'strong',
      reason: `sent to the counterparty after it was made; subject shares "${shared.join(', ')}"; the commitment is a communication${msg.hasAttachments ? '; carried an attachment' : ''}`,
      detail };
  }
  return { polarity: 'progress', strength: 'partial',
    reason: `sent to the counterparty about "${shared.join(', ')}" — but the commitment is not a communication, so an email about it is not doing it`,
    detail };
}

const CHECKBOX = /^\s*[-*+]\s*\[([ xX/>])\]\s*(.*)$/;
const BULLET = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/;
const DONE_RE = /\b(done|completed?|delivered|finished|sorted|resolved|actioned)\b|✅|\b(?:has|have|was|were)\s+been\s+(?:sent|shared|provided|confirmed|submitted|delivered|set)\b|\balready\s+(?:sent|shared|confirmed|provided|done)\b/i;
const PAST_RE = /\b(sent|shared|confirmed|provided|submitted|emailed|forwarded|booked|arranged|circulated)\b/i;
const FUTURE_RE = /\b(will|to be|needs?\s+to|should|must|going\s+to)\b|^\s*\w+(?:\s+\w+)?\s+to\s+\w+/i;
const NOT_DONE_RE = /\b(still|outstanding|pending|not\s+yet|overdue|chas(?:e|ed|ing)|remains?|carried|awaiting|yet\s+to)\b/i;

/** What a note line says about the action it names. PURE. null = not an action line. */
function classifyLine(line) {
  const box = String(line).match(CHECKBOX);
  if (box) {
    const mark = box[1];
    if (mark === 'x' || mark === 'X') return { text: box[2], polarity: 'done', strength: 'strong', cue: 'ticked [x]' };
    if (mark === '/') return { text: box[2], polarity: 'progress', strength: 'partial', cue: 'marked in progress [/]' };
    return { text: box[2], polarity: 'not-done', strength: 'partial', cue: mark === '>' ? 'deferred [>]' : 'listed open [ ]' };
  }
  const b = String(line).match(BULLET);
  if (!b) return null;
  const text = b[1];
  if (NOT_DONE_RE.test(text)) return { text, polarity: 'not-done', strength: 'partial', cue: 'says still outstanding' };
  if (DONE_RE.test(text)) return { text, polarity: 'done', strength: 'strong', cue: 'says done' };
  if (PAST_RE.test(text) && !FUTURE_RE.test(text)) return { text, polarity: 'done', strength: 'strong', cue: 'reported in the past tense' };
  // A plain bullet that merely restates the action says nothing about whether
  // it happened. Measured on the live vault (3 Oct): recording these put 91
  // rows of noise into an append-only log on the first dry run.
  return null;
}

/**
 * How much of the COMMITMENT a line restates, with people's names removed.
 * PURE. The dedupe scorer measures containment of the SHORTER side, so
 * "- [[Nick Ward]]" scored 1.0 against every commitment naming Nick Ward —
 * caught on the first live dry run. A line is about a commitment only if it
 * carries most of the commitment's own words.
 */
function lineCoverage(commitmentTokens, lineTokens, idf, names) {
  const own = [...commitmentTokens].filter((t) => !names.has(t));
  const lt = new Set([...lineTokens].filter((t) => !names.has(t)));
  if (own.length < 2) return { score: 0, shared: [] };
  const w = (t) => (idf.get(t) ?? 1);
  const total = own.reduce((s, t) => s + w(t), 0);
  const shared = own.filter((t) => lt.has(t));
  if (shared.length < 2) return { score: 0, shared };
  return { score: Math.round((shared.reduce((s, t) => s + w(t), 0) / total) * 1000) / 1000, shared };
}

// Sections NEURO writes into daily notes itself: a line there quoting a task
// is NEURO talking, not Nick reporting.
const GENERATED_SECTION = /^#{1,6}\s+.*\b(saim|sara)\b.*actions?\b|^#{1,6}\s+.*\b(alerts?|log|activity)\b/i;

// ── producers ───────────────────────────────────────────────────────────────

function _safePublish(input, opts) {
  try { return require('./event-bus').publishEvent(input, opts); } catch (e) {
    console.warn(`[ProgressEvidence] could not publish: ${e.message}`);
    return null;
  }
}

function _fingerprint(x) { return crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 32); }

/** Publish one piece of evidence, change-keyed so a re-classified line is a new fact and a re-scan is nothing. */
function publishEvidence(commitmentId, kind, ref, body, at, nowMs) {
  const ck = require('./change-key');
  const payload = { commitmentId, kind, ref: String(ref), at, rule: RULES[kind] || null, ...body };
  payload.fingerprint = _fingerprint(payload);
  const subjectId = `${commitmentId}|${kind}|${hash(ref)}`.slice(0, 256);
  const held = ck.latest('progress-evidence', subjectId, ['observation.progress.evidence']);
  if (ck.isUnchanged(held, payload.fingerprint)) return { duplicate: true, unchanged: true };
  return _safePublish({
    type: 'observation.progress.evidence',
    occurredAt: at,
    source: { system: kind === 'sent-email' ? 'microsoft-graph' : 'vault', recordId: String(ref).slice(0, 256) },
    subject: { entityType: 'progress-evidence', entityId: subjectId },
    idempotencyKey: ck.observationKey('progress-evidence', subjectId, held, payload.fingerprint),
    payload,
  }, { now: nowMs });
}

function _openCommitments(nowMs) {
  const since = new Date(nowMs - LATER_NOTE_DAYS * 86400000).toISOString().slice(0, 10);
  return require('./world-obligations').listCommitments({ status: 'open', limit: 2000 })
    .filter((c) => String(c.createdAt || c.source.date || '').slice(0, 10) >= since);
}

function _emailsOf(personId) {
  if (!personId) return [];
  return db.all(`SELECT value FROM wm_person_identities WHERE kind = 'email' AND person_id = ?`, [personId]).map((r) => r.value);
}

/** Who a sent email must go to for it to say anything about this commitment. */
function targetsFor(c, selfEmails) {
  const out = new Map(); // email → display name
  const add = (personId, name) => { for (const e of _emailsOf(personId)) out.set(e, name); };
  if (c.direction === 'by-nick') {
    if (c.beneficiary.personId) add(c.beneficiary.personId, c.beneficiary.displayName);
    else if (c.beneficiary.kind === 'meeting' && c.meetingId) {
      // Only a KNOWN attendee list. A meeting the world model never saw the
      // invite for has no participants, and then there is nobody to match.
      for (const p of db.all('SELECT email, name FROM wm_meeting_participants WHERE meeting_id = ?', [c.meetingId])) {
        if (!selfEmails.has(String(p.email).toLowerCase())) out.set(String(p.email).toLowerCase(), p.name);
      }
    }
  } else if (c.promisor.personId && c.promisor.personId !== SELF) {
    add(c.promisor.personId, c.promisor.displayName);
  }
  return out;
}

async function scanSentMail({ now = Date.now(), deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const fetchSent = deps.fetchSent || ((sinceIso) => require('./microsoft').fetchSentMail({ sinceIso, maxResults: 200 }));
  const selfList = deps.selfEmails ? await deps.selfEmails() : await (async () => {
    const out = [];
    try { const a = await require('./microsoft').getSignedInAddress(); if (a) out.push(a); } catch { /* unknown */ }
    return out.concat(_emailsOf(SELF));
  })();
  const self = new Set(selfList.map((e) => String(e).toLowerCase()));
  const open = _openCommitments(nowMs);
  const withTargets = open.map((c) => ({ c, t: targetsFor(c, self) })).filter((x) => x.t.size);
  if (!withTargets.length) return { ok: true, considered: open.length, withTargets: 0, published: 0, fetched: 0 };
  const sinceIso = new Date(nowMs - SENT_MAIL_DAYS * 86400000).toISOString();
  let sent;
  try { sent = await fetchSent(sinceIso); } catch (e) { return { ok: false, why: `sent mail unreadable: ${e.message}` }; }
  if (!sent || !Array.isArray(sent.messages)) return { ok: false, why: 'Graph could not be asked for sent mail (not signed in, or it did not answer)' };
  let published = 0;
  for (const { c, t } of withTargets) {
    const names = [...t.values(), c.promisor.displayName, 'Nick Ward'].filter(Boolean);
    const hits = sent.messages
      .map((m) => ({ m, r: matchSentEmail(c, m, { targets: new Set(t.keys()), names }) }))
      .filter((x) => x.r)
      .sort((a, b) => String(b.m.sentAt).localeCompare(String(a.m.sentAt)))
      .slice(0, MAX_EVIDENCE_PER_COMMITMENT);
    for (const { m, r } of hits) {
      const res = publishEvidence(c.commitmentId, 'sent-email', m.id, r, new Date(m.sentAt).toISOString(), nowMs);
      if (res && !res.duplicate) published += 1;
    }
  }
  return { ok: true, considered: open.length, withTargets: withTargets.length, fetched: sent.messages.length,
    complete: sent.complete !== false, published };
}

function _plaudId(text) {
  const m = String(text).match(/^plaud_id:\s*"?([A-Za-z0-9_]+)"?\s*$/m);
  if (!m) return null;
  try { return require('../../shared/plaud-id.cjs').canonicalPlaudId(m[1]); } catch { return m[1]; }
}

/** Candidate note files: Meetings/YYYY/MM and Daily, dated in the window. */
function _noteFiles(vaultRoot, sinceDay, untilDay) {
  const out = [];
  const take = (rel, day) => { if (day >= sinceDay && day <= untilDay) out.push({ rel, day }); };
  try {
    for (const y of fs.readdirSync(path.join(vaultRoot, 'Meetings'))) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const mo of fs.readdirSync(path.join(vaultRoot, 'Meetings', y))) {
        if (!/^\d{2}$/.test(mo) || `${y}-${mo}` < sinceDay.slice(0, 7)) continue;
        for (const f of fs.readdirSync(path.join(vaultRoot, 'Meetings', y, mo))) {
          const d = f.match(/^(\d{4}-\d{2}-\d{2})/);
          if (d && f.endsWith('.md')) take(`Meetings/${y}/${mo}/${f}`, d[1]);
        }
      }
    }
  } catch { /* no Meetings folder: nothing from it */ }
  try {
    for (const f of fs.readdirSync(path.join(vaultRoot, 'Daily'))) {
      const d = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (d) take(`Daily/${f}`, d[1]);
    }
  } catch { /* no Daily folder */ }
  return out.sort((a, b) => b.day.localeCompare(a.day)).slice(0, MAX_NOTE_FILES);
}

function scanLaterNotes({ now = Date.now(), vaultRoot = process.env.OBSIDIAN_VAULT_PATH } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!vaultRoot || !fs.existsSync(vaultRoot)) return { ok: false, why: 'vault not configured or not mounted — absence of notes is not evidence' };
  const open = _openCommitments(nowMs).filter((c) => c.description);
  if (!open.length) return { ok: true, considered: 0, published: 0, files: 0 };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const earliest = open.map((c) => String(c.createdAt || '').slice(0, 10)).filter(Boolean).sort()[0] || today;
  const files = _noteFiles(vaultRoot, earliest, today);

  const lines = []; // { rel, day, plaud, n, text, cls, tokens }
  const plaudOf = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(vaultRoot, f.rel), 'utf8'); } catch { continue; }
    const norm = text.split(String.fromCharCode(13)).join('');
    plaudOf.set(f.rel, _plaudId(norm));
    const daily = f.rel.startsWith('Daily/');
    let generated = false;
    norm.split('\n').forEach((ln, i) => {
      if (/^#{1,6}\s/.test(ln)) { generated = GENERATED_SECTION.test(ln); return; }
      // Daily notes: only Nick's own ticks, never NEURO's log lines.
      if (daily && (generated || !CHECKBOX.test(ln))) return;
      const cls = classifyLine(ln);
      if (!cls || cls.text.length < 8 || cls.text.length > 300) return;
      lines.push({ rel: f.rel, day: f.day, n: i + 1, raw: ln.trim().slice(0, 240), cls, tokens: dd().tokenize(cls.text) });
    });
  }
  const idf = dd().buildIdf([...lines.map((l) => l.tokens), ...open.map((c) => dd().tokenize(c.description))]);
  let names = new Set(['nick', 'ward']);
  try { names = new Set([...names, ...nameTokens(db.all('SELECT display_name FROM wm_people').map((r) => r.display_name))]); } catch { /* names stay minimal */ }

  let published = 0;
  for (const c of open) {
    const ctoks = dd().tokenize(c.description);
    if (ctoks.size < 2) continue;
    const created = String(c.createdAt || '').slice(0, 10);
    const srcPath = c.source.path || (c.meeting && c.meeting.notePath) || null;
    let srcPlaud = srcPath ? plaudOf.get(srcPath) : null;
    if (srcPath && srcPlaud === undefined) {
      try { srcPlaud = _plaudId(fs.readFileSync(path.join(vaultRoot, srcPath), 'utf8')); } catch { srcPlaud = null; }
    }
    const srcDay = String(c.source.date || created).slice(0, 10);
    const hits = [];
    for (const l of lines) {
      // Later than the write-up it came from — and never another variant of
      // the SAME recording, which restates it by construction.
      if (l.rel === srcPath) continue;
      if (srcPlaud && plaudOf.get(l.rel) === srcPlaud) continue;
      if (l.rel.startsWith('Meetings/') ? l.day <= srcDay : l.day < created) continue;
      const s = lineCoverage(ctoks, l.tokens, idf, names);
      if (s.score < LINE_MATCH_SCORE) continue;
      hits.push({ l, s });
    }
    hits.sort((a, b) => b.l.day.localeCompare(a.l.day) || b.s.score - a.s.score);
    for (const { l, s } of hits.slice(0, MAX_EVIDENCE_PER_COMMITMENT)) {
      const body = {
        polarity: l.cls.polarity, strength: l.cls.strength,
        reason: `a later ${l.rel.startsWith('Daily/') ? 'daily note' : 'meeting note'} (${l.day}) ${l.cls.cue}; matches it at ${s.score}`,
        detail: { notePath: l.rel, line: l.n, text: l.raw, score: s.score, shared: s.shared.slice(0, 6), cue: l.cls.cue },
      };
      const res = publishEvidence(c.commitmentId, 'later-note', `${l.rel}#L${l.n}`, body, `${l.day}T12:00:00.000Z`, nowMs);
      if (res && !res.duplicate) published += 1;
    }
  }
  return { ok: true, considered: open.length, files: files.length, lines: lines.length, published };
}

function _scanState() {
  try { return JSON.parse(db.getState(SCAN_STATE_KEY) || '{}'); } catch { return {}; }
}

/**
 * Run both producers, at most every SCAN_THROTTLE_MS. Called at the head of the
 * commitment-risk pass — evidence is gathered when it is about to be used,
 * not on a timer of its own. Never throws; the outcome of each source is kept
 * so a reader can tell "nothing found" from "could not look".
 */
async function refresh({ now = Date.now(), force = false, deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const st = _scanState();
  if (!force && st.at && nowMs - Date.parse(st.at) < SCAN_THROTTLE_MS) return { skipped: 'throttled', state: st };
  let sentMail; let laterNotes;
  try { sentMail = await scanSentMail({ now: nowMs, deps }); } catch (e) { sentMail = { ok: false, why: e.message }; }
  try { laterNotes = scanLaterNotes({ now: nowMs, vaultRoot: deps.vaultRoot }); } catch (e) { laterNotes = { ok: false, why: e.message }; }
  const next = { at: new Date(nowMs).toISOString(), sentMail, laterNotes };
  try { db.setState(SCAN_STATE_KEY, JSON.stringify(next)); } catch { /* the read still works; coverage reads unknown */ }
  return next;
}

/** Coverage of the last scan, as deriveProgress wants it. */
function coverage() {
  const st = _scanState();
  const one = (x) => (!x ? 'unavailable' : x.ok ? 'ok' : 'unavailable');
  return { sentMail: one(st.sentMail), laterNotes: one(st.laterNotes), scannedAt: st.at || null,
    why: { sentMail: st.sentMail && !st.sentMail.ok ? st.sentMail.why : null, laterNotes: st.laterNotes && !st.laterNotes.ok ? st.laterNotes.why : null } };
}

// ── reading ─────────────────────────────────────────────────────────────────

function _rows(commitmentId) {
  return db.all('SELECT * FROM wm_progress_evidence WHERE commitment_id = ? ORDER BY at DESC', [commitmentId]).map((r) => ({
    evidenceId: r.evidence_event_id, kind: r.kind, ref: r.ref, at: r.at, polarity: r.polarity, strength: r.strength,
    provenance: r.provenance_kind, reason: r.reason, detail: parse(r.detail_json) || {},
  }));
}

/** Evidence matched by a CURRENT rule. Rows from a retired rule are kept in the log and not read. */
function evidenceFor(commitmentId) {
  return _rows(commitmentId).filter((e) => CURRENT_RULES.has(e.detail.rule));
}

function retiredFor(commitmentId) {
  return _rows(commitmentId).filter((e) => !CURRENT_RULES.has(e.detail.rule)).length;
}

/** The derived progress of one commitment, with its evidence. */
function progressFor(commitmentId, { cov = coverage() } = {}) {
  const wo = require('./world-obligations');
  const commitment = wo.getCommitment(commitmentId);
  if (!commitment) return null;
  const task = commitment.relatedTaskId ? wo.getTask(commitment.relatedTaskId) : null;
  const evidence = evidenceFor(commitmentId);
  const history = db.all('SELECT change, at, authority FROM wm_obligation_history WHERE entity_id = ? ORDER BY id', [commitmentId]);
  const applicable = {
    sentMail: cov.sentMail,
    laterNotes: commitment.source.path || commitment.meeting ? cov.laterNotes : 'not-applicable',
  };
  return { commitmentId, ...deriveProgress({ commitment, task, evidence, history, coverage: applicable }), evidence,
    retiredEvidence: retiredFor(commitmentId),
    coverage: { ...applicable, scannedAt: cov.scannedAt } };
}

function summary() {
  const cov = coverage();
  const ids = db.all('SELECT DISTINCT commitment_id FROM wm_progress_evidence').map((r) => r.commitment_id);
  const byState = {};
  const items = [];
  for (const id of ids) {
    const p = progressFor(id, { cov });
    if (!p) continue;
    byState[p.state] = (byState[p.state] || 0) + 1;
    items.push({ commitmentId: id, state: p.state, basis: p.basis, reasons: p.reasons, evidence: p.evidence.length });
  }
  const retired = db.all('SELECT detail_json FROM wm_progress_evidence').filter((r) => !CURRENT_RULES.has((parse(r.detail_json) || {}).rule)).length;
  return { coverage: cov, withEvidence: items.filter((i) => i.evidence > 0).length, byState, retiredRuleRows: retired, rules: RULES, items };
}

module.exports = {
  STATES, LATER_NOTE_DAYS, LINE_MATCH_SCORE, SCAN_STATE_KEY,
  applyEvidence, reset,
  deriveProgress, matchSentEmail, classifyLine, lineCoverage, targetsFor, DELIVERY_VERB,
  publishEvidence, scanSentMail, scanLaterNotes, refresh, coverage,
  evidenceFor, progressFor, summary,
};
