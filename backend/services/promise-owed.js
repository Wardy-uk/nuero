'use strict';

/**
 * Who a held promise is owed to, when only Nick can say (24 Oct 2026).
 *
 * A Keep my word promise whose notes do not name one recipient used to end in
 * "Waiting for you" with only "Open the task". Now the card asks the ONE
 * missing question in place, through the existing prepared-move question
 * machinery: the promise becomes a prepared move (planner ref
 * `promise:<key>`), the move asks `owed` ("Who is this owed to?"), and Nick's
 * answer is a `prepared_move_answers` row on THAT move's record, whose packet
 * names the exact promise (`selected.source.promiseKey`). Nothing else stores
 * it: no People note, task or ledger row is changed.
 *
 * ⚠ NEVER A GUESS. An answer resolves to a recipient only as
 *   - one People note's FULL name (case-insensitive), or an alias exactly one
 *     person claims (entities.getRoster's own rule);
 *   - several such names ("Chris Middleton and Ricky Bostock") — a group of
 *     people, never one of them;
 *   - words that name nobody in People ("the TLO team") — kept exactly as Nick
 *     wrote them, with NO address: nothing is ever looked up or inferred.
 * A first name (even a unique one), a partial name, an email address or a
 * name two people share is NOT resolved: the question is asked again, naming
 * the candidates. Only the LATEST owed answer counts, and only once it resolves.
 *
 * PURE apart from `answerFor` (one read of NEURO's own store) and `overlay`.
 */

const QUESTION_ID = 'owed';
const MAX_LEN = 120;
/**
 * Words that mean "nobody else — it's mine" (25 Oct 2026). Nick answered "Me"
 * to "Who is this owed to?"; recorded as a GROUP called "Me", that trapped the
 * promise (a recipient nobody can be sent anything). It now means the promise
 * is his own: no recipient is needed and none is ever invented.
 */
const SELF_RE = /^(?:me|myself|just me|only me|me only|mine|i do|for me|my own|nobody|no one|no-one|none|nick|nick ward|me \(nick\))\.?$/i;
/** An answer withdrawn by Nick (append-only): its row is kept, it no longer counts. */
const WITHDRAW_ID = 'withdraw';

const norm = (s) => String(s || '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();

/** PURE. The first question. */
function firstQuestion() {
  return {
    id: QUESTION_ID,
    question: 'Who is this owed to?',
    why: 'Your notes don’t name who it is owed to, so only you can say. SAiM won’t guess — name a person (their full name) or a group.',
    choices: [],
  };
}

/** PURE. Nick's words → what they name. Never a guess. */
function resolveAnswer(text, roster = {}) {
  const t = norm(text);
  if (!t) return { kind: 'unclear', why: 'empty' };
  if (t.length > MAX_LEN) return { kind: 'unclear', why: 'too-long' };
  if (/@/.test(t)) return { kind: 'unclear', why: 'address' };
  if (SELF_RE.test(t)) return { kind: 'self' };
  const full = (roster.full || []).filter((n) => !/^nick ward$/i.test(n));
  const byLower = new Map(full.map((n) => [n.toLowerCase(), n]));
  const aliases = roster.aliases instanceof Map ? roster.aliases : new Map(Object.entries(roster.aliases || {}));
  const one = (part) => {
    const p = lc(part);
    if (byLower.has(p)) return { name: byLower.get(p) };
    const a = aliases.get(p);
    if (a && byLower.has(String(a).toLowerCase())) return { name: byLower.get(String(a).toLowerCase()) };
    // A name that is only a first name, or only part of a name: candidates, never a pick.
    const words = p.split(' ');
    const cands = full.filter((n) => {
      const nl = n.toLowerCase();
      return words.length && words.every((w) => nl.split(' ').includes(w));
    });
    return { candidates: cands };
  };
  const parts = t.split(/\s*(?:,|&|\band\b|\+)\s*/i).map((x) => x.trim()).filter(Boolean);
  const hits = parts.map((p) => ({ part: p, ...one(p) }));
  const unsure = hits.filter((h) => !h.name && h.candidates.length);
  if (unsure.length) {
    const candidates = [...new Set(unsure.flatMap((h) => h.candidates))].sort();
    return { kind: 'ambiguous', said: unsure.map((h) => h.part).join(', '), candidates };
  }
  const named = hits.filter((h) => h.name).map((h) => h.name);
  if (named.length === parts.length) {
    const names = [...new Set(named)];
    return names.length === 1 ? { kind: 'person', name: names[0] } : { kind: 'people', names };
  }
  if (!named.length) return { kind: 'stated', text: t };
  // Some parts are People, some are not: kept as Nick wrote it, never split into an address list.
  return { kind: 'stated', text: t };
}

/** PURE. The owed answer that counts among a move's answers (respecting a later withdrawal). */
function latestOwed(answers) {
  let last = null;
  for (const a of answers || []) {
    if (a.questionId === QUESTION_ID) last = a;
    else if (a.questionId === WITHDRAW_ID && a.text === QUESTION_ID) last = null;
  }
  return last;
}

/** PURE. The question to ask again, or null when the answer resolved. */
function nextQuestion(resolution) {
  if (!resolution) return firstQuestion();
  if (resolution.kind === 'ambiguous') {
    const n = resolution.candidates.length;
    return {
      id: QUESTION_ID,
      question: n === 1 ? `Do you mean ${resolution.candidates[0]}? Give their full name.` : `Which ${resolution.said} do you mean?`,
      why: `“${resolution.said}” could be ${n === 1 ? 'more than one person' : `${n} people in your People notes`}, so SAiM won’t pick. Choose the full name, or type a group.`,
      choices: n > 1 ? resolution.candidates : [],
    };
  }
  if (resolution.kind === 'unclear') {
    return {
      id: QUESTION_ID,
      question: 'Who is this owed to?',
      why: resolution.why === 'address'
        ? 'SAiM takes addresses only from People notes — give the person’s full name instead.'
        : resolution.why === 'too-long' ? `Keep it to a name or a group — under ${MAX_LEN} characters.` : 'Name a person (their full name) or a group.',
      choices: [],
    };
  }
  return null;
}

/** PURE. A resolved answer as a ledger-shaped owedTo — never with an address. */
function owedFromResolution(r, answer) {
  if (!r) return null;
  const stated = { by: answer.by, at: answer.at, text: answer.text };
  if (r.kind === 'self') return { people: [], ambiguous: [], fromNote: null, resolved: null, group: null, self: true, stated };
  if (r.kind === 'person') return { people: [{ name: r.name, basis: 'nick-said' }], ambiguous: [], fromNote: null, resolved: r.name, stated };
  if (r.kind === 'people') return { people: [], ambiguous: [], fromNote: null, resolved: null, group: r.names.join(', '), groupNames: r.names, stated };
  if (r.kind === 'stated') return { people: [], ambiguous: [], fromNote: null, resolved: null, group: r.text, groupNames: [], stated };
  return null;
}

/** The latest owed answer recorded for EXACTLY this promise. Read only. */
function answerFor(promiseKey, { db = require('../db/database') } = {}) {
  if (!promiseKey) return null;
  try {
    if (!db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='prepared_move_answers'`)) return null;
    const r = db.get(`SELECT a.question_id, a.text, a.by, a.at, a.record_id, a.version FROM prepared_move_answers a JOIN prepared_moves m ON m.id = a.record_id
                      WHERE (a.question_id = ? OR (a.question_id = ? AND a.text = ?)) AND json_extract(m.packet_json, '$.selected.source.promiseKey') = ?
                      ORDER BY a.id DESC LIMIT 1`, [QUESTION_ID, WITHDRAW_ID, QUESTION_ID, promiseKey]);
    // The latest word is a withdrawal → nothing counts (the earlier row stays, for the record).
    if (!r || r.question_id === WITHDRAW_ID) return null;
    return { text: r.text, by: r.by, at: r.at, recordId: r.record_id, version: r.version };
  } catch { return null; }
}

/**
 * The owed-to state of one promise: from its own notes, else from Nick's
 * latest answer, else the question to ask. → { owedTo, source, question, resolution }
 */
function stateFor(p, { roster = null, answer = undefined, db } = {}) {
  if (p && p.owedTo && p.owedTo.resolved) return { owedTo: p.owedTo, source: 'notes', question: null, resolution: null };
  // `answer` may be the move's answer LIST (the planner's view) — take the one that counts.
  if (Array.isArray(answer)) answer = latestOwed(answer);
  const a = answer === undefined ? answerFor(p && p.key, { db }) : answer;
  if (!a) return { owedTo: null, source: null, question: firstQuestion(), resolution: null, answer: null };
  let r;
  try { r = resolveAnswer(a.text, roster || require('./entities').getRoster()); } catch { r = { kind: 'unclear', why: 'roster' }; }
  const owedTo = owedFromResolution(r, a);
  return owedTo ? { owedTo, source: 'nick', question: null, resolution: r, answer: a } : { owedTo: null, source: null, question: nextQuestion(r), resolution: r, answer: a };
}

/**
 * Promises with Nick's resolved answer applied (only where their own notes
 * name nobody). The ledger rows themselves are untouched; this is a READ-time
 * overlay, so taking the answer back is just answering again.
 */
function overlay(promises, { roster = null, db } = {}) {
  let ros = roster;
  return (promises || []).map((p) => {
    if (!p || (p.owedTo && p.owedTo.resolved)) return p;
    const a = answerFor(p.key, { db });
    if (!a) return p;
    try { if (!ros) ros = require('./entities').getRoster(); } catch { ros = { full: [] }; }
    const s = stateFor(p, { roster: ros, answer: a });
    return s.owedTo ? { ...p, owedTo: s.owedTo } : p;
  });
}

module.exports = { QUESTION_ID, WITHDRAW_ID, SELF_RE, latestOwed, MAX_LEN, firstQuestion, resolveAnswer, nextQuestion, owedFromResolution, answerFor, stateFor, overlay };
