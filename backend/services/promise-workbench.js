'use strict';

/**
 * promise-workbench-v1 — the (at most) TWO promises most at risk, and what
 * preparing each one would take (21 Oct 2026). READ-ONLY and DECIDES NOTHING
 * that acts: it creates no draft, block, task, action or allowance, and calls
 * no executor. Preparing is still the existing governed paths' job.
 *
 * ── Ranking: only four facts, in this order ─────────────────────────────────
 *   1. the STATED due point   overdue → due today → due within 2 days → this week
 *   2. the next meeting       a meeting with the person it is owed to before the
 *                             due point (or within 48 hours) comes first
 *   3. progress / delivery    nothing seen → progress seen → probably delivered
 *   4. booked time            no protected time before the due point first
 *   then the due date and the lowest task id, so the order is DETERMINISTIC.
 * Nothing else ranks: not wording, not how often it slipped, not who it is to.
 *
 * ── Preparation state (one per selected promise) ────────────────────────────
 *   ready               time is already booked for it before its due point
 *   needs-a-block       the work is not a message and no time is protected
 *   needs-a-draft       the promise IS a message to one named person
 *   waiting-for-Nick    only Nick can answer: it may already be delivered,
 *                       or who it is owed to is not named
 *   not-safe-to-prepare NEURO could not check whether it already happened
 *                       (progress unreadable or stale) — fails closed
 *
 * ── Withheld, never ranked ──────────────────────────────────────────────────
 *   ambiguous   the person it is owed to is a first name several people share,
 *               or more than one person
 *   unreadable  its source note could not be read
 *   undated     no stated or set date (the 10-day placeholder is not a date)
 * And the whole bench is empty, with the reason, when the task list could not
 * be read or the read is stale: an at-risk list built on a partial read is a
 * confident picture of a day nobody read.
 */

const score = require('./promise-score');

const CONTRACT = 'promise-workbench-v1';
const MAX_ITEMS = 2;
/** A promise further out than this is not at risk yet. */
const HORIZON_DAYS = 7;
/** A meeting this close makes the promise relevant whatever its due point. */
const MEETING_SOON_MS = 48 * 3600 * 1000;
/** A progress scan older than this cannot say "nothing happened". */
const PROGRESS_STALE_MS = 26 * 3600 * 1000;
/** A ledger read older than this is not a basis for preparing anything. */
const READ_STALE_MS = 15 * 60 * 1000;

const msOf = (now) => (typeof now === 'number' ? now : Date.parse(now));

// A promise whose ACT is a message (progress-evidence.DELIVERY_VERB's sense).
const MESSAGE_ACT = /\b(send|share|provide|forward|email|e-mail|circulate|confirm|reply|respond|inform|tell|feed\s*back|follow\s+up|let\s+\w+\s+know)\b/i;

const PREP_SAY = {
  ready: 'Time is already booked for it before it is due.',
  'needs-a-block': 'Nothing is booked for it before it is due.',
  'needs-a-draft': 'It is a message to one person; nothing is drafted yet.',
  'waiting-for-Nick': null, // composed from the reason
  'not-safe-to-prepare': null,
};

/** PURE. The due tier: 0 overdue, 1 today, 2 within 2 days, 3 this horizon, null beyond it. */
function dueTier(due, nowMs) {
  const today = score.londonWall(nowMs).date;
  if (due.endsMs <= nowMs) return 0;
  if (due.date === today) return 1;
  if (due.date <= score.addDays(today, 2)) return 2;
  if (due.date <= score.addDays(today, HORIZON_DAYS)) return 3;
  return null;
}

const PROGRESS_RANK = { no_evidence: 0, contradicted: 0, progress_observed: 1, likely_fulfilled: 2 };

/** PURE. Booked time that lands before the due point. */
function bookedBefore(booked, due) {
  return (booked || []).filter((b) => b && b.date && b.date <= due.date);
}

/** PURE. The meeting that makes this promise relevant, if any (with the person, before the due point or within 48h). */
function relevantMeeting(promise, due, nowMs) {
  const m = promise.nextMeeting;
  if (!m || !m.start) return null;
  const at = score.londonInstant(String(m.start).slice(0, 10), String(m.start).slice(11, 16));
  if (!Number.isFinite(at) || at < nowMs) return null;
  return at < due.endsMs || at - nowMs <= MEETING_SOON_MS ? { title: m.title, start: m.start, basis: m.basis || null, at } : null;
}

/** PURE. Why a promise is withheld, or null. */
function withholdReason(p, due) {
  const people = (p.owedTo && p.owedTo.people) || [];
  if ((p.owedTo && (p.owedTo.ambiguous || []).length) || people.length > 1) return 'ambiguous';
  if (!p.source || p.source.readable === false) return 'unreadable';
  if (!due.date) return 'undated';
  return null;
}

/** PURE. The preparation state of one selected promise, with the reason in words. */
function preparationFor(p, { due, progress, booked }) {
  if (!progress || progress.state === 'unknown' || progress.stale) {
    return { state: 'not-safe-to-prepare', why: progress && progress.stale
      ? 'NEURO’s check for whether it already happened is out of date, so nothing is prepared.'
      : 'NEURO couldn’t check whether it already happened, so nothing is prepared.' };
  }
  if (progress.state === 'likely_fulfilled') {
    return { state: 'waiting-for-Nick', why: 'It may already be delivered — only you can say. Nothing counts it as kept until a delivery is read back.' };
  }
  // Nick's own answer counts here too (promise-owed's read-time overlay): a
  // person, or a group kept exactly as he wrote it — never with a guessed address.
  const recipient = p.owedTo ? (p.owedTo.resolved || p.owedTo.group || null) : null;
  // "It's mine" (Nick said so): no recipient is needed, and none is invented.
  const own = Boolean(p.owedTo && p.owedTo.self);
  if (!recipient && !own) return { state: 'waiting-for-Nick', missing: 'owed-to', why: 'Your notes don’t name who it is owed to, so only you can say who should get it.' };
  if (booked.length) return { state: 'ready', why: PREP_SAY.ready };
  if (!own && MESSAGE_ACT.test(p.text || '')) return { state: 'needs-a-draft', why: PREP_SAY['needs-a-draft'] };
  return { state: 'needs-a-block', why: PREP_SAY['needs-a-block'] };
}

const TIER_SAY = ['overdue', 'due today', 'due within two days', 'due this week', 'not due yet'];

/**
 * PURE. The bench.
 *   promises   promise-ledger-v1 promises
 *   proofs     Map key → verified delivery (promise-score.readProofs)
 *   dueBases   Map key → due_basis | null
 *   progress   Map key → { state, reasons } | null  (progress-evidence, per lead task's commitment)
 *   freshness  { readAt, progressScannedAt }
 */
// `onlyKey` (31 Oct 2026, the task workflow screen): the bench for ONE promise,
// composed the same way whether or not it made the top two — a promise beyond the
// horizon is shown as "not due yet" rather than skipped. Withheld stays withheld.
function select({ promises = [], proofs = new Map(), dueBases = new Map(), progress = new Map(), freshness = {}, gaps = [], now, onlyKey = null }) {
  const nowMs = msOf(now);
  const out = { contract: CONTRACT, generatedAt: new Date(nowMs).toISOString(), items: [], withheld: { ambiguous: 0, unreadable: 0, undated: 0 }, considered: 0, state: 'ok', why: null };
  if (gaps.some((g) => g.input === 'tasks')) return { ...out, state: 'not-safe-to-prepare', why: 'NEURO couldn’t read the task list, so nothing is offered as at risk.' };
  const readAt = Date.parse(freshness.readAt || '');
  if (!Number.isFinite(readAt) || nowMs - readAt > READ_STALE_MS) {
    return { ...out, state: 'not-safe-to-prepare', why: 'The promise read is out of date, so nothing is offered as at risk.' };
  }
  const scanAt = Date.parse(freshness.progressScannedAt || '');
  const progressStale = !Number.isFinite(scanAt) || nowMs - scanAt > PROGRESS_STALE_MS;

  const candidates = [];
  for (const p of promises) {
    if (onlyKey && p.key !== onlyKey) continue;
    if (!p.open || proofs.has(p.key)) continue;
    const due = score.duePoint(p, dueBases.get(p.key) || null);
    const held = withholdReason(p, due);
    if (held) {
      // Withheld only if it would otherwise have been at risk; an undated one always counts.
      if (held === 'undated' || (due.date && dueTier(due, nowMs) !== null)) out.withheld[held] += 1;
      continue;
    }
    const tier = dueTier(due, nowMs) ?? (onlyKey ? 4 : null);
    const meeting = relevantMeeting(p, due, nowMs);
    if (tier === null && !meeting) continue;
    const pr = progress.get(p.key) || null;
    const prog = pr ? { ...pr, stale: progressStale } : null;
    const booked = bookedBefore(p.booked, due);
    const pRank = prog && PROGRESS_RANK[prog.state] !== undefined ? PROGRESS_RANK[prog.state] : 0;
    candidates.push({ p, due, tier: tier === null ? 3 : tier, meeting, prog, booked,
      key: [tier === null ? 3 : tier, meeting ? 0 : 1, pRank, booked.length ? 1 : 0, due.date, Math.min(...p.taskIds)] });
  }
  out.considered = candidates.length;
  candidates.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] === b.key[i]) continue;
      return typeof a.key[i] === 'string' ? a.key[i].localeCompare(b.key[i]) : a.key[i] - b.key[i];
    }
    return 0;
  });

  out.items = candidates.slice(0, MAX_ITEMS).map((c) => {
    const prep = preparationFor(c.p, { due: c.due, progress: c.prog, booked: c.booked });
    const because = [`${TIER_SAY[c.tier]} (${score.dayLabel(c.due.date)})`];
    if (c.meeting) because.push(`you meet ${c.p.owedTo.resolved || 'them'} ${c.meeting.at < c.due.endsMs ? 'before it is due' : 'within two days'}`);
    because.push(c.prog ? (c.prog.state === 'no_evidence' ? 'nothing NEURO checked says it moved' : c.prog.state === 'progress_observed' ? 'progress seen, not delivery' : c.prog.state === 'likely_fulfilled' ? 'probably delivered — not proven' : 'NEURO couldn’t check') : 'NEURO couldn’t check whether it moved');
    because.push(c.booked.length ? 'time is booked for it' : 'no time is booked for it');
    const evidence = [];
    evidence.push({ kind: 'due', fact: `Due ${score.dayLabel(c.due.date)} — ${c.due.basis === 'stated-in-wording' ? `the date in its own words${c.p.statedDate && c.p.statedDate.phrase ? ` (“${c.p.statedDate.phrase}”)` : ''}` : 'the date set on the task'}.` });
    if (c.p.source && c.p.source.line) evidence.push({ kind: 'source', fact: `From “${c.p.source.title}”: ${c.p.source.line}`, path: c.p.source.path || null });
    for (const r of ((c.prog && c.prog.reasons) || []).slice(0, 2)) evidence.push({ kind: 'progress', fact: r });
    for (const b of c.booked) evidence.push({ kind: 'booked', fact: `Booked ${score.dayLabel(b.date)} ${b.start}${b.end ? `–${b.end}` : ''}.` });
    if (c.meeting) evidence.push({ kind: 'meeting', fact: `Next meeting with ${c.p.owedTo.resolved}: ${c.meeting.title}, ${score.dayLabel(String(c.meeting.start).slice(0, 10))} ${String(c.meeting.start).slice(11, 16)}.` });
    return {
      key: c.p.key, taskIds: c.p.taskIds, leadTaskId: c.p.leadTaskId || c.p.taskIds[0],
      title: c.p.text,
      owedTo: c.p.owedTo.resolved || c.p.owedTo.group || null,
      owedToSaidBy: c.p.owedTo.stated ? { by: c.p.owedTo.stated.by, at: c.p.owedTo.stated.at, text: c.p.owedTo.stated.text } : null,
      owedToSelf: Boolean(c.p.owedTo.self),
      due: { date: c.due.date, basis: c.due.basis, endsAt: new Date(c.due.endsMs).toISOString(), tier: ['overdue', 'today', 'soon', 'this-week', 'later'][c.tier], say: TIER_SAY[c.tier] },
      nextMeeting: c.meeting ? { title: c.meeting.title, start: c.meeting.start } : null,
      booked: c.booked,
      progress: c.prog ? { state: c.prog.state, stale: c.prog.stale } : null,
      preparation: prep,
      because,
      evidence,
      source: c.p.source ? { title: c.p.source.title, path: c.p.source.path || null, line: c.p.source.line || null } : null,
    };
  });
  if (!out.items.length) out.why = 'No promise is at risk this week.';
  return out;
}

// ── Reader ───────────────────────────────────────────────────────────────────

function _progressFor(promises) {
  const map = new Map();
  let scannedAt = null;
  try {
    const pe = require('./progress-evidence');
    const cov = pe.coverage();
    scannedAt = cov.scannedAt || null;
    for (const p of promises) {
      try {
        const r = pe.progressFor(`commitment:task:${p.leadTaskId || p.taskIds[0]}`, { cov });
        map.set(p.key, r ? { state: r.state, reasons: r.reasons || [] } : null);
      } catch { map.set(p.key, null); }
    }
  } catch { /* progress unreadable → every item fails closed */ }
  return { map, scannedAt };
}

/** The bench for `now`. Reads only. */
function read({ now = Date.now(), ledger = null, proofs = null, onlyKey = null } = {}) {
  const nowMs = msOf(now);
  const raw = ledger || require('./promise-ledger').read({ now: nowMs });
  // Who it is owed to, where only Nick could say: his answer, read at this moment.
  const facts = { ...raw, promises: require('./promise-owed').overlay(raw.promises || []) };
  const pr = proofs || score.readProofs().proofs;
  const dueBases = score.readDueBases(facts.promises);
  const { map, scannedAt } = _progressFor(facts.promises);
  return select({ promises: facts.promises, proofs: pr, dueBases, progress: map, freshness: { readAt: facts.readAt, progressScannedAt: scannedAt }, gaps: facts.gaps, now: nowMs, onlyKey });
}

module.exports = { CONTRACT, MESSAGE_ACT, MAX_ITEMS, HORIZON_DAYS, READ_STALE_MS, PROGRESS_STALE_MS, dueTier, withholdReason, preparationFor, relevantMeeting, select, read };
