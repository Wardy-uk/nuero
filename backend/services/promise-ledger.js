'use strict';

/**
 * The promise ledger — NEURO's FACTS about promises Nick made in meetings
 * (18 Oct 2026). READ-ONLY: this module writes nothing, anywhere.
 *
 * A "promise" here is a task NEURO promoted from a meeting note
 * (`tasks.source = 'meeting-promotion'`). For each one it reports what can be
 * OBSERVED, never what SAiM thinks of it:
 *   - the exact sentence in the source note it came from;
 *   - who it is owed to, ONLY where a name resolves to exactly one person —
 *     an ambiguous first name ("Chris", "Nathan") is reported as ambiguous with
 *     its candidates, never guessed;
 *   - how often it SLIPPED: due-date moves (the activity log's task_triaged
 *     events), lapsed task blocks (released / dropped), and a stated date in its
 *     own wording that has passed;
 *   - the next meeting with the person it is owed to;
 *   - whether it is HR / employment SENSITIVE (classified here, by rule);
 *   - duplicate task records that are the SAME promise, grouped (read-time,
 *     deterministic; an explicit "not the same" from Nick is honoured).
 *
 * Judgement about these facts lives in SAiM's policy (saim/policy/promise-*.cjs).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACT = 'promise-ledger-v1';
/** How far back a promise is considered (closed ones too, for duplicate linking). */
const LOOKBACK_DAYS = 120;
/** Two records are one promise above this score AND sharing a counterpart (or both owed to nobody named). */
const SAME_PROMISE_SCORE = 0.55;
/** Upcoming meetings are looked for this far ahead. */
const MEETING_AHEAD_DAYS = 14;

const _db = () => require('../db/database');

// ── HR / employment sensitivity ──────────────────────────────────────────────

/**
 * A promise is HR-SENSITIVE when its wording (or its source note's title) is
 * about an individual's employment. Deliberately broad: a false positive costs a
 * routing note instead of a draft; a false negative drafts an employee message.
 */
const HR_PATTERNS = Object.freeze([
  /\bflexible[- ]working\b/i, /\bflexi(ble)?[- ]?work(ing)? request\b/i,
  /\bend date\b/i, /\bnotice period\b/i, /\bresign/i, /\bredundan/i, /\bdismiss/i, /\bdisciplinary\b/i,
  /\bgrievance\b/i, /\bprobation/i, /\bperformance improvement plan\b/i, /\bperformance (review|intervention|warning)\b/i,
  /\bcapability (meeting|process|hearing)\b/i, /\babsence\b/i, /\bsick(ness)?\b/i, /\breturn[- ]to[- ]work\b/i, /\bRTW\b/,
  /\boccupational health\b/i, /\breasonable adjustment/i, /\bfit (to work|note)\b/i,
  /\bcontract(ual)? (change|hours|terms)\b/i, /\bsalary\b/i, /\bpay (rise|review|increase)\b/i,
  /\bmaternity\b/i, /\bpaternity\b/i, /\bparental leave\b/i, /\bretention\b/i, /\bexit interview\b/i,
  /\bHR\b/, /\blegal risk\b/i, /\btribunal\b/i, /\bwarning letter\b/i,
  // Added from the live snapshot (18 Oct 2026): wording about one person's
  // employment that the first list missed. Erring sensitive costs a routing
  // note instead of a draft; erring the other way drafts to an employee.
  /\bhearing\b/i, /\blight duties\b/i, /\brole viability\b/i, /\bviability of (his|her|their) role\b/i,
  /\bmonitor\b[^.]*\bproductivity\b/i, /\bphased return\b/i, /\bwelfare\b/i,
]);

/** PURE. Which rule (if any) makes this HR-sensitive. */
function hrSensitivity(text, sourceTitle = '') {
  for (const s of [String(text || ''), String(sourceTitle || '')]) {
    for (const re of HR_PATTERNS) {
      const m = re.exec(s);
      if (m) return { sensitive: true, rule: re.source, matched: m[0], where: s === text ? 'wording' : 'source-note' };
    }
  }
  return { sensitive: false, rule: null, matched: null, where: null };
}

// ── Source context: ordinary wording about a person in an employment situation ──

// Terms that make a line about a PERSON an employment matter: their circumstances,
// adjustments, capability, absence, monitoring, performance, wellbeing or status.
const CONTEXT_PATTERNS = Object.freeze([
  ...HR_PATTERNS,
  /\bfit note\b/i, /\baccommodations?\b/i, /\badjustments?\b/i, /\bcapabilit/i, /\babsen(t|ce)\b/i,
  /\bmedical(ly)?\b/i, /\bsurger(y|ies)\b/i, /\billness\b/i, /\binfection\b/i, /\brecovery\b/i, /\bhealth\b/i,
  /\bmonitor(ing|ed)?\b/i, /\bperformance\b/i, /\bwell-?being\b/i, /\bemployment\b/i, /\bcontract\b/i,
  /\bleave\b/i, /\bunderperform/i, /\bconduct\b/i, /\bpersonal (circumstances|situation|matter)\b/i,
]);
// A note whose title says it is about employee cases makes every named person in it a case.
const EMPLOYEE_TITLE = /\bemployee (cases?|accommodations?|adjustments?|relations|matters?)\b|\baccommodations?\b|\bwelfare\b|\babsence\b/i;

/**
 * PURE. Is a promise whose own wording is ordinary still an employment matter,
 * because its SOURCE NOTE discusses a person it names in those terms?
 * Conservative by design: any other line naming the same person with a context
 * term, or a note titled as employee cases, is enough.
 */
function contextSensitivity(noteText, taskText, title, roster) {
  const subjects = namesIn(taskText, roster).people.map((p) => p.name);
  if (!subjects.length || !noteText) return { sensitive: false };
  if (EMPLOYEE_TITLE.test(String(title || ''))) {
    return { sensitive: true, rule: 'employee-title', matched: String(title).match(EMPLOYEE_TITLE)[0], where: 'source-context', about: subjects };
  }
  const want = norm(taskText);
  // ⚠ A line can only name a subject if it CONTAINS one of that subject's words
  // (first name — a full name contains it — or an alias they own). Checking that
  // with `includes` first skips the regex matcher on almost every line; it is an
  // exact pre-filter, not a heuristic, because every `word()` match implies the
  // substring. Without it this ran the whole roster's regexes per line of every
  // source note and blocked the event loop for ~4s a minute (23 Oct 2026).
  const needles = new Set(subjects.map((s) => s.split(/\s+/)[0].toLowerCase()));
  for (const [alias, owner] of roster.aliases || new Map()) if (subjects.includes(owner)) needles.add(String(alias).toLowerCase());
  for (const raw of String(noteText).replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const lowerRaw = raw.toLowerCase();
    let mentions = false;
    for (const n of needles) if (lowerRaw.includes(n)) { mentions = true; break; }
    if (!mentions) continue;
    if (norm(raw).includes(want.slice(0, 50))) continue; // the promise's own line is judged by its wording
    const named = namesIn(raw, roster).people.map((p) => p.name).filter((n) => subjects.includes(n));
    if (!named.length) continue;
    const hit = CONTEXT_PATTERNS.map((re) => re.exec(raw)).find(Boolean);
    if (hit) return { sensitive: true, rule: 'person-context', matched: hit[0], where: 'source-context', about: named };
  }
  return { sensitive: false };
}

// ── Names → people (exactly one, or say so) ──────────────────────────────────

const SELF = new Set(['nick', 'nick ward']);

// Compiled once per word: a Unicode-property RegExp is expensive to build, and
// namesIn runs per line of every source note. Bounded — the roster is ~45 names.
const WORD_RE = new Map();
function wordRe(w) {
  let re = WORD_RE.get(w);
  if (!re) {
    re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    if (WORD_RE.size > 2000) WORD_RE.clear();
    WORD_RE.set(w, re);
  }
  return re;
}

/** PURE. People a piece of text names. A first name only counts when it is unique in the roster. */
function namesIn(text, roster) {
  const lower = String(text || '').toLowerCase();
  const found = new Map();
  const ambiguous = new Map();
  const word = wordRe;
  for (const full of roster.full || []) {
    if (SELF.has(full.toLowerCase())) continue;
    if (word(full.toLowerCase()).test(lower)) found.set(full, 'full-name');
  }
  // Possessive forms ("Stephen’s") are matched by the word boundary on the name itself.
  const firstCount = new Map();
  for (const full of roster.full || []) { const f = full.split(/\s+/)[0].toLowerCase(); firstCount.set(f, (firstCount.get(f) || 0) + 1); }
  for (const [first, n] of firstCount) {
    if (SELF.has(first) || !word(first).test(lower)) continue;
    const owners = (roster.full || []).filter((f) => f.split(/\s+/)[0].toLowerCase() === first);
    if ([...found.keys()].some((f) => f.split(/\s+/)[0].toLowerCase() === first)) continue; // the full name already said it
    if (n === 1) found.set(owners[0], 'unique-first-name');
    else ambiguous.set(first, owners);
  }
  for (const [alias, owner] of roster.aliases || new Map()) {
    // Nick never owes Nick: his own aliases ("Nick", "NW") are skipped like his name.
    if (SELF.has(String(owner).toLowerCase())) continue;
    if (!found.has(owner) && word(alias).test(lower)) found.set(owner, 'alias');
  }
  return {
    people: [...found].map(([name, basis]) => ({ name, basis })),
    ambiguous: [...ambiguous].map(([first, owners]) => ({ said: first, candidates: owners })),
  };
}

// ── Source sentence ──────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** PURE. The note line this promise came from, and nearby lines that share its subject. */
function sourceSentence(noteText, taskText) {
  const lines = String(noteText || '').replace(/\r\n/g, '\n').split('\n');
  const want = norm(taskText).slice(0, 60);
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (norm(lines[i]).includes(want)) { at = i; break; }
  if (at < 0) {
    // Fall back to the best token overlap among checkbox lines.
    const dd = require('./task-dedupe');
    const cands = lines.map((l, i) => ({ l, i })).filter((x) => /^\s*-\s*\[[ x]\]/i.test(x.l));
    const best = dd.findEquivalent(taskText, cands.map((c) => c.l.replace(/^\s*-\s*\[[ x]\]\s*/i, '')), { minScore: 0.5 });
    if (best && cands[best.index]) at = cands[best.index].i;
  }
  const line = at >= 0 ? lines[at].replace(/^\s*-\s*\[[ x]\]\s*/i, '').trim() : null;
  // Context: other lines of the same note that share ≥2 content words with the promise.
  const STOP = new Set(['the', 'and', 'for', 'with', 'nick', 'ward', 'will', 'into', 'from', 'that', 'this', 'next', 'week', 'about']);
  const words = new Set(norm(taskText).split(' ').filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.replace(/s$/, '')));
  const context = [];
  if (words.size) {
    for (let i = 0; i < lines.length; i++) {
      if (i === at) continue;
      const lw = new Set(norm(lines[i]).split(' ').map((w) => w.replace(/s$/, '')));
      let shared = 0; for (const w of words) if (lw.has(w)) shared += 1;
      if (shared >= 2) context.push(lines[i].replace(/^\s*[-*>]\s*(\[[ x]\]\s*)?/, '').replace(/\*\*/g, '').trim());
    }
  }
  return { line, lineNumber: at >= 0 ? at + 1 : null, context: context.slice(0, 3) };
}

// ── Duplicate records → one promise ──────────────────────────────────────────

/** PURE. Groups task records that are one promise. Returns [[taskId,...], ...]; `notSame` holds "a|b" pairs Nick split. */
function groupDuplicates(records, { notSame = new Set() } = {}) {
  const dd = require('./task-dedupe');
  const toks = records.map((r) => dd.tokenize(r.text));
  const idf = dd.buildIdf(toks);
  const parent = new Map(records.map((r) => [r.taskId, r.taskId]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const owedKey = (r) => (r.owedTo.people.map((p) => p.name).sort().join('|') || '');
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]; const b = records[j];
      const key = [a.taskId, b.taskId].sort((x, y) => x - y).join('|');
      if (notSame.has(key)) continue;
      // Same person (or neither names anyone) — two different people's promises are never one.
      if (owedKey(a) !== owedKey(b)) continue;
      const s = dd.scorePair(toks[i], toks[j], idf).score;
      if (s >= SAME_PROMISE_SCORE) parent.set(find(a.taskId), find(b.taskId));
    }
  }
  const groups = new Map();
  for (const r of records) { const k = find(r.taskId); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r.taskId); }
  return [...groups.values()].map((g) => g.sort((x, y) => x - y));
}

// ── Readers ──────────────────────────────────────────────────────────────────

function _vaultRoot() { return process.env.OBSIDIAN_VAULT_PATH || ''; }

function _readNote(rel) {
  const root = _vaultRoot();
  if (!root || !rel) return null;
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null; // never outside the vault
  try { return fs.readFileSync(full, 'utf-8'); } catch { return null; }
}

function _roster() {
  try { return require('./entities').getRoster(); } catch { return { full: [], firstNames: new Map(), aliases: new Map() }; }
}

/** The person ids NEURO's world model uses (person:<slug>). */
const personId = (name) => `person:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

function _nextMeeting(db, name, nowMs) {
  const nowLocal = new Date(nowMs).toLocaleString('sv-SE', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London' }).replace(' ', 'T').slice(0, 16);
  const until = new Date(nowMs + MEETING_AHEAD_DAYS * 86400000).toLocaleString('sv-SE', { timeZone: process.env.NEURO_TIMEZONE || 'Europe/London' }).replace(' ', 'T').slice(0, 16);
  try {
    const row = db.get(`SELECT m.title, m.start_local FROM wm_meetings m JOIN wm_meeting_participants p ON p.meeting_id = m.meeting_id
      WHERE p.person_id = ? AND m.status = 'scheduled' AND m.start_local > ? AND m.start_local <= ? ORDER BY m.start_local LIMIT 1`, [personId(name), nowLocal, until]);
    if (row) return { title: row.title, start: row.start_local, basis: 'attendee' };
  } catch { /* world model not built in this database */ }
  // Fallback: a 1-2-1 named for them ("1-2-1 — Nick / Stephen"). Labelled as the weaker basis.
  const first = String(name).split(/\s+/)[0];
  try {
    const rows = db.all(`SELECT subject, start_time FROM calendar_cache WHERE attendees_other = 1 AND COALESCE(is_all_day,0) = 0
      AND substr(start_time,1,16) > ? AND substr(start_time,1,16) <= ? ORDER BY start_time`, [nowLocal, until]);
    const hit = rows.find((r) => new RegExp(`(?:^|[^\\p{L}])(${name}|${first})(?![\\p{L}])`, 'iu').test(r.subject || '') && /1-2-1|1:1|one[- ]to[- ]one/i.test(r.subject || ''))
      || rows.find((r) => new RegExp(`(?:^|[^\\p{L}])${name}(?![\\p{L}])`, 'iu').test(r.subject || ''));
    if (hit) return { title: hit.subject, start: String(hit.start_time).slice(0, 16), basis: 'subject' };
  } catch { /* calendar unreadable — no meeting, said as unknown below */ }
  return null;
}

/**
 * Every promise NEURO holds, with its facts. `notSame` is Nick's explicit
 * "these are different promises" decisions (agent_state.promise_not_same).
 */
function read({ now = Date.now() } = {}) {
  const db = _db();
  const gaps = [];
  const since = new Date(now - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  let rows = [];
  try {
    rows = db.all(`SELECT id, text, status, due_date, created_at, completed_at, origin_path FROM tasks
      WHERE source = 'meeting-promotion' AND substr(created_at,1,10) >= ? ORDER BY id`, [since]);
  } catch (e) { gaps.push({ input: 'tasks', why: e.message }); }
  const roster = _roster();
  if (!roster.full || !roster.full.length) gaps.push({ input: 'people', why: 'no People notes could be read — nobody can be named' });

  // Due-date moves, per task, from the activity log (every move ever recorded).
  // A move Nick made on purpose through the promise loop is a RE-COMMIT: kept
  // apart (never a slip) but still a re-date, which promise-score-v1 counts.
  const moves = new Map();
  const recommits = new Map();
  try {
    for (const a of db.all(`SELECT event_data, created_at FROM activity_log WHERE event_type = 'task_triaged' AND event_data LIKE '%due_date%'`)) {
      let d; try { d = JSON.parse(a.event_data); } catch { continue; }
      if (!d || !Array.isArray(d.fields) || !d.fields.includes('due_date')) continue;
      // A date Nick set on purpose through the promise loop is a re-commit, not a slip.
      if (d.reason === 'recommit') {
        const rid = Number(d.taskId);
        if (!recommits.has(rid)) recommits.set(rid, []);
        recommits.get(rid).push(String(a.created_at).replace(' ', 'T'));
        continue;
      }
      const id = Number(d.taskId);
      if (!moves.has(id)) moves.set(id, []);
      moves.get(id).push(String(a.created_at).replace(' ', 'T'));
    }
  } catch (e) { gaps.push({ input: 'activity', why: e.message }); }

  // Lapsed blocks, per task.
  const blocks = new Map();
  try {
    for (const b of db.all(`SELECT bi.task_id, b.date_key, b.start_time, b.end_time, b.status FROM task_block_items bi JOIN task_blocks b ON b.id = bi.block_id`)) {
      if (!blocks.has(b.task_id)) blocks.set(b.task_id, []);
      blocks.get(b.task_id).push({ date: b.date_key, start: b.start_time, end: b.end_time || null, status: b.status });
    }
  } catch (e) { gaps.push({ input: 'task-blocks', why: e.message }); }

  // Nick's explicit "this one is safe" — lifts ONLY context-derived sensitivity, never wording or title.
  let safeOverride = new Set();
  try { safeOverride = new Set(JSON.parse(db.getState('promise_safe_override') || '[]').map(Number)); } catch { safeOverride = new Set(); }
  let notSame = new Set();
  try { notSame = new Set(JSON.parse(db.getState('promise_not_same') || '[]')); } catch { notSame = new Set(); }

  const cdue = require('./commitment-due');
  const records = rows.map((t) => {
    const note = _readNote(t.origin_path);
    const title = t.origin_path ? path.basename(t.origin_path, '.md') : '';
    const src = note ? sourceSentence(note, t.text) : { line: null, lineNumber: null, context: [] };
    const owedTo = namesIn(t.text, roster);
    // Nobody named in the wording: the note's own sentences about the same subject may name them.
    const fromNote = owedTo.people.length ? null : namesIn(src.context.join(' \n '), roster);
    let stated = null;
    try { const created = new Date(t.created_at); const s = cdue.statedDue(t.text, created); if (s) stated = { date: s.date, phrase: s.phrase }; } catch { /* no stated date */ }
    const b = blocks.get(t.id) || [];
    return {
      taskId: t.id, text: t.text, status: t.status, due: t.due_date || null,
      createdAt: String(t.created_at).slice(0, 10), completedAt: t.completed_at ? String(t.completed_at).slice(0, 10) : null,
      source: { path: t.origin_path || null, title, line: src.line, lineNumber: src.lineNumber, context: src.context, readable: Boolean(note) },
      owedTo, owedToFromNote: fromNote,
      statedDate: stated,
      slips: {
        dueMoves: (moves.get(t.id) || []).length,
        dueMovesAt: (moves.get(t.id) || []).slice(-8),
        allDueMovesAt: (moves.get(t.id) || []).slice(),
        recommitsAt: (recommits.get(t.id) || []).slice(),
        // Time still protected for it: an open block (scheduled, or awaiting its write-up).
        booked: b.filter((x) => x.status === 'scheduled' || x.status === 'awaiting-writeup').map((x) => ({ taskId: t.id, date: x.date, start: x.start, end: x.end, status: x.status })),
        blocks: b.length,
        lapsedBlocks: b.filter((x) => x.status === 'released' || x.status === 'dropped').length,
        lapsedBlockDates: b.filter((x) => x.status === 'released' || x.status === 'dropped').map((x) => x.date),
      },
      sensitivity: _sensitivity(t, note, title, roster, safeOverride),
    };
  });

  const groups = groupDuplicates(records, { notSame });
  const byId = new Map(records.map((r) => [r.taskId, r]));
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const promises = groups.map((ids) => {
    const recs = ids.map((id) => byId.get(id));
    const open = recs.filter((r) => r.status === 'open' || r.status === 'in-progress');
    const lead = open[open.length - 1] || recs[recs.length - 1];
    const people = [...new Map(recs.flatMap((r) => r.owedTo.people).map((p) => [p.name, p])).values()];
    const fromNote = people.length ? null : recs.map((r) => r.owedToFromNote).find((x) => x && (x.people.length || x.ambiguous.length)) || null;
    const ambiguous = recs.flatMap((r) => r.owedTo.ambiguous);
    const sensitive = recs.map((r) => r.sensitivity).find((s) => s.sensitive) || { sensitive: false };
    const firstSeen = recs.map((r) => r.createdAt).sort()[0];
    const stated = recs.map((r) => r.statedDate).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    const next = people.length === 1 ? _nextMeeting(db, people[0].name, nowMs) : null;
    return {
      key: `promise:${ids[0]}`,
      taskIds: ids,
      leadTaskId: lead.taskId,
      text: lead.text,
      open: open.length > 0,
      // A tick is not delivery: a record closed with no evidence is reported as such (task 149).
      tickedWithoutEvidence: recs.filter((r) => r.status === 'done').map((r) => r.taskId),
      firstSeen,
      due: lead.due,
      statedDate: stated,
      owedTo: { people, ambiguous, fromNote, resolved: people.length === 1 ? people[0].name : null },
      source: lead.source,
      sources: recs.map((r) => ({ taskId: r.taskId, path: r.source.path, line: r.source.line })),
      slips: {
        dueMoves: recs.reduce((n, r) => n + r.slips.dueMoves, 0),
        lapsedBlocks: recs.reduce((n, r) => n + r.slips.lapsedBlocks, 0),
        blocks: recs.reduce((n, r) => n + r.slips.blocks, 0),
        statedDatePassed: Boolean(stated && stated.date < new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10)),
        // The most recent observed slip (a date move or a lapsed block), for recency.
        lastSlipAt: recs.flatMap((r) => [...r.slips.dueMovesAt.map((x) => x.slice(0, 10)), ...r.slips.lapsedBlockDates]).sort().pop() || null,
        // Every recorded date move (UTC, 'YYYY-MM-DDTHH:MM:SS'), and every re-commit, for week scoping.
        dueMovesAt: recs.flatMap((r) => r.slips.allDueMovesAt).sort(),
        recommitsAt: recs.flatMap((r) => r.slips.recommitsAt).sort(),
      },
      // How each record closed, when it did: a tick is 'done', a deliberate abandon is 'dropped'.
      records: recs.map((r) => ({ taskId: r.taskId, status: r.status, completedAt: r.completedAt })),
      booked: recs.flatMap((r) => r.slips.booked).sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`)),
      nextMeeting: next,
      sensitivity: sensitive,
    };
  });

  return { contract: CONTRACT, readAt: new Date(nowMs).toISOString(), promises, gaps };
}

function _sensitivity(t, note, title, roster, safeOverride) {
  const own = hrSensitivity(t.text, title);
  if (own.sensitive) return own;
  const ctx = contextSensitivity(note, t.text, title, roster);
  if (ctx.sensitive && safeOverride.has(Number(t.id))) return { sensitive: false, overridden: ctx };
  return ctx.sensitive ? ctx : own;
}

/** A stable hash of the facts a proposal rests on (which promises, how many slips). */
function evidenceHash(items) {
  const parts = items.map((p) => `${p.key}:${p.slips.dueMoves}:${p.slips.lapsedBlocks}:${p.slips.statedDatePassed ? 1 : 0}`).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

module.exports = {
  CONTRACT, LOOKBACK_DAYS, SAME_PROMISE_SCORE, HR_PATTERNS,
  hrSensitivity, contextSensitivity, CONTEXT_PATTERNS, namesIn, sourceSentence, groupDuplicates, evidenceHash, personId,
  read,
};
