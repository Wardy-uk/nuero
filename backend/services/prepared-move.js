'use strict';

/**
 * A PREPARED MOVE — SAiM works one real commitment up before asking Nick
 * anything (19 Oct 2026). LOCAL-ONLY SLICE: nothing here is mounted on a
 * route, scheduled, pushed or written. It READS, composes, and returns.
 *
 * The contract (`prepared-move-v1`) answers six questions about ONE thing:
 *   observed     — facts, each with its source and how fresh it is;
 *   judgement    — SAiM's interpretation, its confidence, and why;
 *   outcome      — the goal worth protecting (which may be one Nick never
 *                  stated — marked `stated:false` with its basis);
 *   preparation  — what SAiM has already checked or drafted, with no side effect;
 *   decision     — the smallest thing it needs from him, and the alternatives;
 *   authority    — what it may do itself, what needs his yes, what it must not do;
 *   verification — how it will know the outcome actually happened.
 *
 * WHERE THE CANDIDATE COMES FROM: production's own decision, never a second
 * ranking. `canonical-read.now({ readOnly: true })` gives the lead and what it
 * held; each is screened in THAT order and the first one that is a real,
 * readable commitment SAiM can safely prepare is chosen.
 * Everything screened out is returned with the reason and the evidence that is
 * missing — "withheld" is an answer, not an absence.
 *
 * WITHHELD, ALWAYS: a stale or unreadable source; a
 * card that cannot be tied to exactly one record; anything whose preparation
 * would need a network call (this slice makes none); personal-domain items.
 *
 * The composer (`composePacket`) and the screens are PURE so both the
 * trustworthy and the unsafe case pin without a database or a vault.
 */

const fs = require('fs');
const path = require('path');

const CONTRACT = 'prepared-move-v1';
/** What SAiM says about a move she prepared while he is off duty or on leave. */
const HELD_SAY = 'I’ve prepared this for your next working morning.';
const DAY = 86400000;

/** How old each source may be before a claim built on it is withheld. */
const MAX_AGE_HOURS = Object.freeze({
  decision: 2,        // the snapshot the decision was computed from
  calendar: 2,        // calendar_cache (syncs every 5 minutes)
  availability: 26,   // People HR via NOVA (refreshed every 30 minutes)
  'planner-mirror': 26, // Tasks/Microsoft Tasks.md (synced from Graph)
});

/** Notes never quoted as evidence: transcripts, archive, daily notes, tasks, system reports. */
const EVIDENCE_EXCLUDE = [/^Archive\//, /\/Archive\//, /^Plaud\//, /^Daily\//, /^Tasks\//, /^Documents\/System\//];

const STOP = new Set('a an and the to of for in on with by every each from what is are be that this it as at or not stating'.split(' '));
// A word's stem never changes, so it is remembered per word — a pure function
// memo (no vault content, nothing that can go stale), bounded in size.
const _stems = new Map();
const stem = (w) => {
  let s = _stems.get(w);
  if (s === undefined) { s = w.replace(/(ations?|ation|ions?|ing|ed|es|s)$/, ''); if (_stems.size < 200000) _stems.set(w, s); }
  return s;
};
const tokens = (t) => [...new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
const ymdLondon = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const hoursOld = (iso, nowMs) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.round(((nowMs - t) / 3600000) * 10) / 10 : null; };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Wall-clock strings are SLICED, never parsed into a zone (the BST rule).
const dayLabel = (d) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const hm = (s) => String(s || '').slice(11, 16);

// ── Screens (PURE) ───────────────────────────────────────────────────────────

/** PURE. Freshness of every source a claim rests on; any stale/unknown one withholds. */
function freshnessScreen(sources, nowMs) {
  const rows = sources.map((s) => {
    const ageHours = s.observedAt ? hoursOld(s.observedAt, nowMs) : null;
    const max = MAX_AGE_HOURS[s.kind];
    const stale = ageHours == null ? true : (max != null && ageHours > max);
    return { ...s, ageHours, maxHours: max ?? null, stale };
  });
  // A source marked optional only adds a caveat; every other one must be fresh.
  return { ok: rows.every((r) => !r.stale || r.optional), rows, caveats: rows.filter((r) => r.stale && r.optional) };
}

// ── Readers (read-only) ──────────────────────────────────────────────────────

const _db = () => require('../db/database');
const vaultRoot = () => process.env.OBSIDIAN_VAULT_PATH || '';

function _read(rel) {
  try { return fs.readFileSync(path.join(vaultRoot(), rel), 'utf8'); } catch { return null; }
}
function _mtime(rel) {
  try { return fs.statSync(path.join(vaultRoot(), rel)).mtime.toISOString(); } catch { return null; }
}
function _walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let ents = [];
  try { ents = fs.readdirSync(path.join(vaultRoot(), dir), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) _walk(rel, out, depth + 1);
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/**
 * Resolve a held todo card to exactly ONE record. The card carries no id —
 * only the task's words, its source and due date — so the match is EXACT text
 * against (a) NEURO's open tasks and (b) the Microsoft mirror's open lines.
 * Zero or several matches is not a guess, it is a withhold.
 */
function resolveTodoCard(card) {
  const text = String(card.title || '').trim();
  const hits = [];
  try {
    for (const t of _db().all(`SELECT id, text, due_date, origin_path, source, domain FROM tasks WHERE status IN ('open','in-progress') AND text = ?`, [text])) {
      hits.push({ system: 'neuro', taskId: t.id, text: t.text, due: t.due_date, originPath: t.origin_path, source: t.source, domain: t.domain });
    }
  } catch { /* the mirror may still answer */ }
  const mirrorRel = 'Tasks/Microsoft Tasks.md';
  const mirror = _read(mirrorRel);
  if (mirror) {
    let plan = null;
    mirror.replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      const h = /^###\s+(.+?)\s*$/.exec(line); if (h) plan = h[1];
      if (/^##\s/.test(line)) plan = null;
      const m = /^- \[ \] (.+?)(?:\s+\(\d+%\))?(?:\s+📅\s*(\d{4}-\d{2}-\d{2}))?\s*(?:<!--rec:[^>]*-->)?\s*<!--id:(.*?)-->/.exec(line);
      if (m && m[1].trim() === text) hits.push({ system: 'planner', msId: m[3], text: m[1].trim(), due: m[2] || null, plan, mirror: { path: mirrorRel, line: i + 1, observedAt: _mtime(mirrorRel) } });
    });
  }
  return { hits, unique: hits.length === 1 ? hits[0] : null };
}

/** The tracker row anywhere under Projects/ that carries this exact Planner id. */
function findRegisterRow(msId) {
  if (!msId) return null;
  for (const rel of _walk('Projects')) {
    const text = _read(rel); if (!text || !text.includes(msId)) continue;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const header = (() => { for (let i = 0; i < lines.length; i++) if (/^\|\s*ID\s*\|/i.test(lines[i])) return { i, cols: lines[i].split('|').slice(1, -1).map((c) => c.trim()) }; return null; })();
    const idx = lines.findIndex((l) => l.startsWith('|') && l.includes(msId));
    if (idx < 0) continue;
    const cells = lines[idx].split('|').slice(1, -1).map((c) => c.trim());
    const row = {}; if (header) header.cols.forEach((c, k) => { row[c.toLowerCase()] = cells[k] || ''; });
    return { path: rel, line: idx + 1, observedAt: _mtime(rel), project: path.basename(path.dirname(rel)), row, cells };
  }
  return null;
}

/**
 * Lines elsewhere in the vault that already say something about this action:
 * a line counts when it shares 3+ of the action's distinctive words. Ranked by
 * overlap, at most 2 a file, never from excluded notes.
 */
/** Thrown when a preparation runs past its deadline — the caller offers nothing. */
class BudgetExceeded extends Error {}
const _overBudget = (deadline) => { if (deadline && Date.now() > deadline) throw new BudgetExceeded('preparation ran past its time budget'); };

/**
 * One preparation's view of the evidence notes: walked once, each note read,
 * screened and tokenised at most once. Lives for ONE call only — nothing is
 * stored, so nothing can go stale between calls.
 */
/**
 * Derived facts about each evidence note — its text, token set and cleaned
 * lines — remembered IN MEMORY, keyed on the note's path, size and
 * modification time. Every call
 * re-stats every note, so an edited note is always re-read: nothing derived
 * from an old version of a note is ever used. Never written anywhere.
 */
const _noteIndex = new Map();
function _noteEntry(rel) {
  let st = null;
  try { st = fs.statSync(path.join(vaultRoot(), rel)); } catch { _noteIndex.delete(rel); return null; }
  const id = `${st.size}:${st.mtimeMs}`;
  let e = _noteIndex.get(rel);
  if (!e || e.id !== id) {
    e = { id, text: _read(rel), mtimeIso: st.mtime.toISOString(), toks: null, lines: null };
    _noteIndex.set(rel, e);
  }
  return e;
}

function makeCorpus({ deadline = null } = {}) {
  let files = null;
  const seen = new Map(); // one stat per note per call
  const entry = (rel) => { if (!seen.has(rel)) seen.set(rel, _noteEntry(rel)); return seen.get(rel); };
  return {
    deadline,
    files() {
      if (!files) {
        files = [..._walk('Projects'), ..._walk('Meetings/2026/10'), ..._walk('Meetings/2026/09')];
        // Forget notes that are no longer in the scanned folders (moved, deleted).
        const live = new Set(files);
        for (const rel of _noteIndex.keys()) if (!live.has(rel)) _noteIndex.delete(rel);
      }
      return files;
    },
    read(rel) { const e = entry(rel); return e ? e.text : null; },
    mtime(rel) { const e = entry(rel); return e ? e.mtimeIso : null; },
    fileTokens(rel) { const e = entry(rel); if (!e.toks) e.toks = tokens(e.text); return e.toks; },
    lines(rel) {
      const e = entry(rel);
      if (!e.lines) {
        e.lines = e.text.replace(/\r\n/g, '\n').split('\n').map((l, i) => {
          const clean = l.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          const usable = !(clean.length < 25 || clean.length > 1200 || /^\|?\s*[-:]+\s*\|/.test(clean));
          return { i, clean, usable, toks: null };
        });
      }
      return e.lines;
    },
  };
}

/**
 * Warm the in-memory note index after startup, so the first Surface read is
 * not the one that pays for reading every evidence note (19 Oct 2026).
 * READ-ONLY: it reads notes and the roster, writes nothing, mints nothing and
 * makes no network call. It yields to the event loop every `yieldEvery` notes,
 * so it never holds up a request, and a second call joins the first.
 */
let _warming = null;
function warmEvidenceIndex({ yieldEvery = 20 } = {}) {
  if (_warming) return _warming;
  _warming = require('./read-only-scope').run(async () => {
    const t0 = Date.now();
    const c = makeCorpus();
    let notes = 0;
    for (const rel of c.files()) {
      if (EVIDENCE_EXCLUDE.some((re) => re.test(rel))) continue;
      if (!c.read(rel)) continue;
      c.fileTokens(rel); c.lines(rel);
      notes += 1;
      if (notes % yieldEvery === 0) await new Promise((res) => setImmediate(res));
    }
    return { notes, ms: Date.now() - t0 };
  }).then((p) => ({ ...p.result, writesRefused: p.writesRefused, refused: p.refused })).finally(() => { _warming = null; });
  return _warming;
}

function findEvidenceLines(actionText, { roster, excludePath = null, limit = 30, perFileMax = 6, min = 3, patterns = null, stats = null, corpus = makeCorpus() } = {}) {
  const want = new Set(tokens(actionText));
  const found = [];
  for (const rel of corpus.files()) {
    _overBudget(corpus.deadline);
    if (rel === excludePath || EVIDENCE_EXCLUDE.some((re) => re.test(rel))) continue;
    const text = corpus.read(rel); if (!text) continue;
    if (patterns && !patterns.some((re) => re.test(text))) continue;
    // The screen is asked only of a note that could contribute: same outcome,
    // because a note with nothing to offer is skipped either way — but the
    // count of notes left out still covers every note that WOULD have counted.
    const couldCount = patterns || corpus.fileTokens(rel).filter((w) => want.has(w)).length >= min;
    if (!couldCount) continue;
    const perFile = [];
    for (const ln of corpus.lines(rel)) {
      if (!ln.usable) continue;
      if (patterns) { if (patterns.some((re) => re.test(ln.clean))) perFile.push({ path: rel, line: ln.i + 1, text: ln.clean, shared: [], score: 99 }); continue; }
      if (!ln.toks) ln.toks = tokens(ln.clean);
      const shared = ln.toks.filter((w) => want.has(w));
      if (shared.length >= min) perFile.push({ path: rel, line: ln.i + 1, text: ln.clean, shared, score: shared.length });
    }
    perFile.sort((a, b) => b.score - a.score);
    found.push(...perFile.slice(0, perFileMax).map((x) => ({ ...x, observedAt: corpus.mtime(rel) })));
  }
  return found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Calendar rows in time-fit's shape; free-but-held meetings (his own standup) are walls. */
function readDiary(fromYmd, days) {
  const db = _db();
  const to = ymdLondon(Date.parse(`${fromYmd}T12:00:00Z`) + days * DAY);
  let rows = [];
  let fetchedAt = null;
  try {
    rows = db.all(`SELECT event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, is_organizer, source, fetched_at FROM calendar_cache WHERE start_time >= ? AND start_time <= ? ORDER BY start_time`, [`${fromYmd}T00:00:00`, `${to}T23:59:59`]);
    const f = db.all(`SELECT MAX(fetched_at) m FROM calendar_cache WHERE source = 'graph'`)[0];
    fetchedAt = f && f.m ? new Date(String(f.m).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(f.m)) ? '' : 'Z')).toISOString() : null;
  } catch (e) { return { known: false, why: e.message, events: [], fetchedAt: null }; }
  const { heldDespiteFree } = require('./context-state');
  const events = rows.map((r) => {
    const ev = { date: String(r.start_time).slice(0, 10), start: r.start_time, end: r.end_time, subject: r.subject, isAllDay: Boolean(r.is_all_day), showAs: r.show_as || 'busy', attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null, isOrganizer: r.is_organizer === 1 ? true : r.is_organizer === 0 ? false : null };
    return heldDespiteFree(ev) ? { ...ev, showAs: 'busy', heldDespiteFree: true } : ev;
  });
  return { known: true, events, fetchedAt };
}

/**
 * The next meeting where this commitment would be raised: a scheduled meeting
 * whose title IS the project's name, or that a named co-owner organises.
 */
function nextForum({ project, coOwnerEmails = [], nowMs }) {
  const db = _db();
  const nowLocal = new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T').slice(0, 16);
  let rows = [];
  try { rows = db.all(`SELECT meeting_id, title, start_local, end_local, status, organizer_email, response_status FROM wm_meetings WHERE status = 'scheduled' AND kind = 'meeting' AND start_local > ? ORDER BY start_local LIMIT 200`, [nowLocal]); } catch { return null; }
  const want = String(project || '').toLowerCase();
  for (const m of rows) {
    if (m.start_local > ymdLondon(nowMs + 10 * DAY) + 'T23:59') break;
    const byTitle = want && String(m.title).toLowerCase() === want;
    const byOrganiser = coOwnerEmails.includes(String(m.organizer_email || '').toLowerCase());
    if (!byTitle && !byOrganiser) continue;
    let people = [];
    try { people = db.all(`SELECT name, email, response FROM wm_meeting_participants WHERE meeting_id = ?`, [m.meeting_id]); } catch { /* attendees unknown */ }
    return { ...m, matchedBy: [byTitle && 'title-is-project', byOrganiser && 'co-owner-organises'].filter(Boolean), people };
  }
  return null;
}

/** "Mel Ellis" → the People note it names. Exact name or alias = observation; a nickname = inference, said as one. */
function resolveOwner(name, roster) {
  const n = String(name || '').trim();
  const exact = (roster.full || []).find((f) => f.toLowerCase() === n.toLowerCase());
  if (exact) return { name: exact, basis: 'exact-name', kind: 'observation' };
  const [first, ...rest] = n.split(/\s+/); const surname = rest.join(' ').toLowerCase();
  if (!first || !surname) return null;
  const c = (roster.full || []).filter((f) => { const p = f.split(/\s+/); return p.slice(1).join(' ').toLowerCase() === surname && p[0].toLowerCase().startsWith(first.toLowerCase()); });
  return c.length === 1 ? { name: c[0], basis: `the only People note with surname ${rest.join(' ')} whose first name starts "${first}"`, kind: 'inference' } : null;
}

function _peopleEmail(name) {
  const t = _read(`People/${name}.md`); const m = t && /^email:\s*"?([^"\s]+)"?\s*$/m.exec(t);
  return m ? m[1].toLowerCase() : null;
}

// ── Draft (PURE) ─────────────────────────────────────────────────────────────

/**
 * Build the working draft from lines the vault already holds. Every section
 * cites its line; anything that cannot be extracted is listed as a gap rather
 * than filled in.
 */
function draftFromEvidence({ action, registerRef, lines, consolidation }) {
  const cite = (l) => `${l.path}:${l.line}`;
  const fieldsLine = lines.find((l) => /every escalation must (show|carry|include)/i.test(l.text));
  // A list of three or more after "criteria for" — "A, B and C." — is the set of receiving teams.
  const teamsLine = lines.find((l) => /criteria for [^.|]+?,[^.|]+?\band\b[^.|]+?\./i.test(l.text));
  const missingLine = lines.find((l) => /without stating exactly what is missing/i.test(l.text));
  const freeText = lines.find((l) => /rejection reason.{0,20}free text|free text.{0,40}rejection reason/i.test(l.text));
  const gaps = [];
  const fields = fieldsLine ? (/must show (?:the )?(.+?)\.?\s*\|/i.exec(fieldsLine.text + '|') || [])[1] : null;
  const fieldList = fields ? fields.split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean) : [];
  if (!fieldList.length) gaps.push('the minimum fields an escalation must carry');
  const teams = teamsLine ? (/criteria for (.+?)\./i.exec(teamsLine.text) || [])[1] : null;
  const teamList = teams ? teams.split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean) : [];
  if (!teamList.length) gaps.push('which teams receive escalations');
  const md = [
    `# ${registerRef.id} — Triage and escalation acceptance criteria (DRAFT prepared by SAiM)`,
    '',
    `> ${action}`,
    `> Source: ${registerRef.path}:${registerRef.line} (${registerRef.source}). Nothing here is agreed — it is what your notes already say, arranged.`,
    '',
    '## Every escalation must carry',
    ...(fieldList.length ? fieldList.map((f) => `- ${f.charAt(0).toUpperCase()}${f.slice(1)}`) : ['- _(not found in the notes — to write)_']),
    ...(fieldsLine ? [`  _from ${cite(fieldsLine)}_`] : []),
    '',
    '## A rejection must say',
    '- Exactly what is missing — never a bare return',
    `  _from ${missingLine ? cite(missingLine) : `${registerRef.path}:${registerRef.line}`}_`,
    ...(freeText ? ['- A reason from a fixed list', `  _today the rejection reason is free text — ${cite(freeText)}_`] : []),
    '',
    '## What each team accepts',
    '| Team | Accepts when | Rejects with |',
    '|---|---|---|',
    ...(teamList.length ? teamList.map((t) => `| ${t} | _to agree_ | _to agree_ |`) : ['| _(teams not found)_ | | |']),
    ...(teamsLine ? ['', `_Team list from ${cite(teamsLine)}_`] : []),
    '',
    '## Open questions for the meeting',
    ...(consolidation ? [`- The team list predates the ${consolidation.date} consolidation decision (${consolidation.what}) — does that change who receives escalations? _from ${consolidation.cite}_`] : ['- _(none found in the notes)_']),
  ].join('\n');
  return { markdown: md, cites: [fieldsLine, teamsLine, missingLine, freeText].filter(Boolean).map(cite), gaps, teams: teamList, fields: fieldList };
}

/** "Publish triage and escalation acceptance criteria for…" → "Triage and escalation criteria draft". */
function blockTitleFor(reg) {
  const m = /^\w+\s+(.+?)\s+(?:acceptance\s+)?criteria\b/i.exec(String(reg.action || ''));
  return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} criteria draft` : `${reg.id} draft`;
}

/** Beside the register, with the register's own prefix: "SIP - Action Register.md" → "SIP - T1 Acceptance Criteria (draft).md". */
function notePathFor(reg) {
  const dir = path.posix.dirname(String(reg.path || '').split('\\').join('/'));
  const prefix = (/^(.+? - )/.exec(path.posix.basename(String(reg.path || ''))) || [])[1] || '';
  return `${dir}/${prefix}${reg.id} Acceptance Criteria (draft).md`;
}

// ── The packet (PURE) ────────────────────────────────────────────────────────

/**
 * PURE. Everything gathered about ONE screened, eligible candidate → the
 * contract. No reading, no clock beyond `nowMs`.
 */
function composePacket(ev, nowMs) {
  const o = []; // observed
  const src = (kind, ref, observedAt) => ({ kind, ref, observedAt });
  const card = ev.card;
  o.push({ id: 'held', kind: 'observation', fact: `SAiM's production decision is holding "${card.title}" (${card.reason}).`, source: src('decision', `canonical Now · ${ev.decision.rule} · held ${card.ref}`, ev.decision.decidedAt) });
  o.push({ id: 'planner', kind: 'observation', fact: `It is a card on the Planner board "${ev.record.plan}", open, due ${dayLabel(ev.record.due)} — ${ev.daysLate} day${ev.daysLate === 1 ? '' : 's'} ago.`, source: src('planner-mirror', `${ev.record.mirror.path}:${ev.record.mirror.line}`, ev.record.mirror.observedAt) });
  o.push({ id: 'register', kind: 'observation', fact: `It is ${ev.register.id} in the ${ev.register.project} action register: "${ev.register.action}". Owners: ${ev.register.owner}. Register due date ${ev.register.due}. Source: ${ev.register.source}.`, source: src('vault', `${ev.register.path}:${ev.register.line}`, ev.register.observedAt) });
  for (const l of ev.observedLines) o.push({ id: `line:${l.path}:${l.line}`, kind: 'observation', fact: `"${l.text.length > 220 ? l.text.slice(0, 219) + '…' : l.text}"`, source: src('vault', `${l.path}:${l.line}`, l.observedAt) });
  if (ev.consolidation) o.push({ id: 'consolidation', kind: 'observation', fact: `Decided at the ${dayLabel(ev.consolidation.date)} meeting: "${ev.consolidation.what}".`, source: src('vault', ev.consolidation.cite, ev.consolidation.observedAt) });
  if (ev.forum) o.push({ id: 'forum', kind: 'observation', fact: `"${ev.forum.title}" is on ${dayLabel(ev.forum.start_local)} ${hm(ev.forum.start_local + ':00')}–${hm(ev.forum.end_local + ':00')}, organised by ${ev.forum.organiserName || ev.forum.organizer_email}; ${ev.forum.people.filter((p) => !/nickw@/i.test(p.email)).map((p) => `${p.name} (${String(p.email).toLowerCase() === String(ev.forum.organizer_email).toLowerCase() ? 'organiser' : (p.response && p.response !== 'none' ? p.response : 'no answer')})`).join(', ')}. Your own response: ${ev.forum.response_status}.`, source: src('calendar', `wm_meetings ${ev.forum.meeting_id.slice(0, 18)}…`, ev.diary.fetchedAt) });
  if (ev.leave) o.push({ id: 'leave', kind: 'observation', fact: `People HR has you on ${ev.leave.detail || 'leave'} today (${dayLabel(ev.today)}).`, source: src('availability', 'team_availability (NOVA ← People HR)', ev.leave.fetchedAt) });
  o.push({ id: 'no-draft', kind: 'observation', fact: `No note in the vault edited since the register row was added (${ev.register.addedNote || 'its creation'}) is a draft of these criteria: ${ev.draftSearch.searched} notes under Projects/ and Meetings/ searched.`, source: src('vault', 'search', ev.draftSearch.at), caveat: 'The vault is not the only place a draft could be — a Word document, Teams or email would not show here.' });

  const coOwner = ev.coOwner;
  const late = ev.daysLate;
  const judgement = {
    kind: 'inference',
    summary: `${ev.register.id} has passed two dates (${ev.register.due} on the register, ${dayLabel(ev.record.due)} on Planner) with no draft in the vault. ${ev.forum ? `${ev.forum.title} on ${dayLabel(ev.forum.start_local)} is where ${coOwner ? coOwner.name.split(' ')[0] : 'its co-owner'} will see where it stands — arriving with a draft turns a ${late}-day slip into an agenda item instead of an apology.` : 'There is no meeting ahead where it will be raised.'}`,
    confidence: ev.forum && coOwner ? 'moderate' : 'low',
    because: [
      'Its Planner date has passed and production is already holding it as overdue (observed).',
      'Nothing in the vault is a draft of it (observed, vault only — hence not high).',
      ev.forum ? `The ${ev.forum.title} meeting matches by ${ev.forum.matchedBy.join(' and ')} (observed).` : null,
      coOwner && coOwner.kind === 'inference' ? `"${ev.register.ownerNames[1] || ''}" is taken to be ${coOwner.name}: ${coOwner.basis} (inference).` : null,
      'Most of the content already exists in Mel\'s review and the April escalation review — the work is arranging, not inventing (observed lines above).',
    ].filter(Boolean),
    notToday: ev.leave ? 'You are on leave today. Nothing here asks for you before your next working morning.' : null,
  };

  const outcome = {
    goal: ev.forum
      ? `Arrive at ${ev.forum.title} on ${dayLabel(ev.forum.start_local)} with ${ev.register.id} drafted, agree it there, then publish it to the teams.`
      : `Get ${ev.register.id} drafted and agreed.`,
    stated: false,
    basis: `You never wrote this goal down. It follows from: the register names you and ${coOwner ? coOwner.name : 'a co-owner'} as owners; the action is "publish"; ${ev.forum ? `${ev.forum.title} is the project's own meeting` : 'no forum was found'}.`,
    protects: `${ev.register.project} ${ev.register.id} — "${ev.register.action}"`,
    doneWhen: 'The criteria are agreed in the meeting and the Planner card is closed with a link to the published version.',
  };

  const preparation = [
    { did: `Tied the held card to exactly one record — Planner id ${ev.record.msId} — and to register row ${ev.register.id} by that same id.`, sideEffect: 'none' },
    { did: `Searched the vault for what is already written about this action (${ev.evidence.length} matching lines in ${new Set(ev.evidence.map((l) => l.path)).size} notes) and arranged the ${ev.draft.cites.length} that state it directly into a draft (below), each part citing its line.${ev.draft.gaps.length ? ` Could not find: ${ev.draft.gaps.join('; ')}.` : ''}`, sideEffect: 'none — the draft exists only in this packet', draft: ev.draft.markdown },
    ev.forum ? { did: `Checked ${ev.forum.title}: who is in it and that you haven't answered the invite.`, sideEffect: 'none — the invite is untouched' } : null,
    ev.leaveUnknown ? { did: 'Could not check People HR for leave, so the times below assume you are working.', sideEffect: 'none' } : null,
    ev.slot && ev.slot.date ? { did: `Found the first ${ev.slot.minutes}-minute gap in your diary before it: ${dayLabel(ev.slot.date)} ${ev.slot.startTime}–${ev.slot.endTime}${ev.slot.assumed ? ` (${ev.slot.minutes} minutes is NEURO's default for a task with no estimate — the content is already drafted)` : ''}. Skipped ${ev.leave ? 'today (leave), ' : ''}bank holidays, weekends, and meetings you hold that are marked free (your standups).`, sideEffect: 'none — nothing booked' } : { did: `Looked for a gap before the meeting: ${ev.slot ? ev.slot.reason : 'diary unreadable'}.`, sideEffect: 'none' },
  ].filter(Boolean);

  // The two writes a yes would make, as data — the executor builds from THIS, never from prose.
  const slots = ev.slot && ev.slot.date ? [
    { id: 'approve', date: ev.slot.date, start: ev.slot.startTime, end: ev.slot.endTime },
    ...ev.alternatives.map((a, i) => ({ id: `slot-${i + 1}`, date: a.date, start: a.startTime, end: a.endTime })),
  ] : [];
  const blockTitle = blockTitleFor(ev.register);
  const notePath = notePathFor(ev.register);
  const proposedWrites = slots.length ? [
    { kind: 'calendar.solo', title: blockTitle, slot: 'chosen', attendees: [], body: `Prepared by SAiM${ev.forum ? ` for ${ev.forum.title} on ${dayLabel(ev.forum.start_local)} ${hm(ev.forum.start_local + ':00')}` : ''}. Draft: ${notePath}` },
    { kind: 'vault.note', path: notePath },
  ] : [];

  const decision = ev.slot && ev.slot.date ? {
    slots, proposedWrites,
    forum: ev.forum ? { title: ev.forum.title, start: ev.forum.start_local } : null,
    ask: `Book ${dayLabel(ev.slot.date)} ${ev.slot.startTime}–${ev.slot.endTime} to finish this draft before ${ev.forum ? `${ev.forum.title} at ${hm(ev.forum.start_local + ':00')} on ${dayLabel(ev.forum.start_local)}` : 'it slips again'}?`,
    smallest: 'one yes',
    options: [
      { id: 'approve', label: 'Yes — book it and save the draft' },
      ...ev.alternatives.map((a, i) => ({ id: `slot-${i + 1}`, label: `${dayLabel(a.date)} ${a.startTime}–${a.endTime} instead` })),
      { id: 'not-this-week', label: 'Not this week', needs: 'the date you will commit to instead' },
      { id: 'done-elsewhere', label: 'It is already written', needs: 'where it lives, so I can stop tracking it' },
    ],
    notAsked: ['Whether to accept the meeting invite — your call, untouched.', 'Anything to Mel, Chris or Ricky — nothing goes to anyone.'],
  } : { ask: 'When will you draft this?', smallest: 'a date', options: [], missing: ['a free slot before the meeting'] };

  const authority = {
    automatic: ['Read the decision, the diary, the Planner mirror and the vault', 'Compose the draft and this packet in memory'],
    needsApproval: ev.slot && ev.slot.date ? [
      `Create a solo calendar block "${blockTitle}" ${dayLabel(ev.slot.date)} ${ev.slot.startTime}–${ev.slot.endTime} (no attendees, so no invite leaves the building)`,
      `Save the draft as a vault note: ${notePath}`,
    ] : [],
    mustNot: [
      'Email, message or invite Mel, Chris, Ricky or anyone else',
      'Accept or decline the meeting invite',
      'Move, rename, assign or tick the shared Planner card',
      'Publish the criteria to the teams',
      'Create a NEURO task or goal for this',
    ],
  };

  const verification = {
    checks: [
      ev.slot && ev.slot.date ? { what: 'The block exists in your calendar at that time', how: 'read back from the calendar after creating it', by: `${ev.slot.date} ${ev.slot.startTime}` } : null,
      { what: 'The draft grew past what SAiM wrote', how: 'the saved note has your own text beyond the skeleton (the outcome-note rule: 25+ characters of prose outside the scaffolding)', by: ev.forum ? ev.forum.start_local.replace('T', ' ') : null },
      ev.forum ? { what: `${ev.forum.title} discussed it`, how: `a meeting write-up dated ${ev.forum.start_local.slice(0, 10)} mentions acceptance criteria or ${ev.register.id}`, by: `${ymdLondon(Date.parse(ev.forum.start_local + ':00Z') + DAY)} 12:00` } : null,
      { what: 'The Planner card closes', how: 'the Microsoft mirror shows it ticked — a tick alone is not delivery, so it counts only with one of the above', by: null },
    ].filter(Boolean),
    ifNot: 'If none of these is true by the day after the meeting, the packet comes back as "not verified" — it is never marked done on the strength of the booking.',
  };

  return { observed: o, judgement, outcome, preparation, decision, authority, verification };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** PURE. The order production decided in: the lead, then what it held, as it listed them. */
// A ref names a pool item directly ("held:todo-overdue-summary", in a meeting) or
// an attention RECORD ("item:att_…", otherwise). A record is tied back to its
// pool item by the record's dedupe_key — lifecycle's own key, not a second one.
function productionOrder(saim, pool, recordKeys = {}) {
  const lc = require('./attention-lifecycle');
  const byId = new Map((pool || []).map((i) => [i.id, i]));
  const resolve = (ref) => {
    const id = String(ref || '').replace(/^(item|held):/, '');
    if (byId.has(id)) return byId.get(id);
    const key = recordKeys[id];
    return key ? (pool || []).find((i) => lc.dedupeKeyFor(i) === key || lc.legacyKeyFor(i) === key) || null : null;
  };
  const out = [];
  if (saim && saim.lead) out.push({ ref: saim.lead.ref, rule: saim.lead.rule, title: saim.lead.title, kind: saim.lead.kind, item: resolve(saim.lead.ref), role: 'lead' });
  for (const h of (saim && saim.held) || []) {
    out.push({ ref: h.ref, rule: null, title: h.title, kind: h.kind || null, why: h.why, item: resolve(h.ref), role: 'held' });
  }
  return out;
}

/**
 * Read production's decision and prepare the first eligible candidate.
 * READ-ONLY: makes no write, no network call; returns the packet or says why not.
 */
/** Production's decision, read-only: canonical Now (the lead and what it held) + the pool behind it. */
async function readDecision(nowMs) {
  const gaps = [];
  const nowView = await require('./canonical-read').now({ now: nowMs, readOnly: true });
  let pool = [];
  try { pool = (await require('./decision-engine').evaluate()).items || []; } catch (e) { gaps.push({ input: 'decision-engine', why: e.message }); }
  return { nowView, pool, gaps };
}

/**
 * PURE. May a work move be put in front of Nick now? Leave beats everything;
 * otherwise life-state's own decision (`life.showWork`). An unreadable life read
 * FAILS CLOSED — preparing is fine, asking him to commit work is not, and "I
 * couldn't tell whether you're working" must not become "you are".
 */
function dutyFor({ life, leave } = {}) {
  if (leave) return { onDuty: false, why: 'leave' };
  if (!life || typeof life.showWork !== 'boolean') return { onDuty: false, why: 'unknown' };
  if (life.showWork === false) return { onDuty: false, why: 'off-duty' };
  return { onDuty: true, why: 'working' };
}

/** The same rule, read now (confirm-time gate). Read-only. */
async function readDuty(nowMs = Date.now()) {
  const pass = await require('./read-only-scope').run(async () => {
    let life = null;
    try { life = await require('./life-state').read(new Date(nowMs)); } catch { life = null; }
    let leave = null;
    try {
      const ta = require('./team-availability');
      const off = ta.selfAbsenceOn(ymdLondon(nowMs), ta.snapshot(new Date(nowMs)));
      if (off.off) leave = off;
    } catch { /* unknown leave does not make him on leave; life decides */ }
    return dutyFor({ life, leave });
  });
  return pass.result;
}

async function prepare({ now = Date.now(), snapshotAt = null, deps = {}, budgetBy = null } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  // One corpus per call: each evidence note is read and screened at most once.
  const corpus = makeCorpus({ deadline: budgetBy });
  // The decision is READ, never refreshed: no row written, nothing sent off this
  // machine (services/read-only-scope) — for /current and /request alike.
  const pass = await require('./read-only-scope').run(() => (deps.readDecision || readDecision)(nowMs));
  const read = pass.result;
  _overBudget(budgetBy);
  const { nowView, pool } = read;
  const gaps = [...(read.gaps || [])];
  const saim = nowView.saim || {};
  const decidedAt = snapshotAt || saim.decidedAt || new Date(nowMs).toISOString();
  const decision = { rule: saim.lead && saim.lead.rule, lead: saim.lead || null, decidedAt, policyVersion: saim.policyVersion || null, workingWindow: nowView.candidates && nowView.candidates.constraints && nowView.candidates.constraints.workingWindow };

  let roster = { full: [] };
  try { roster = require('./entities').getRoster(); } catch (e) { gaps.push({ input: 'people', why: e.message }); }
  const today = ymdLondon(nowMs);
  const ta = require('./team-availability');
  const snap = ta.snapshot(new Date(nowMs));
  const leaveToday = ta.selfAbsenceOn(today, snap);
  const leave = leaveToday.off ? { ...leaveToday, fetchedAt: snap.fetchedAt } : null;

  // Off duty or on leave a work move may be PREPARED but not put in front of him.
  const duty = dutyFor({ life: nowView.life, leave });

  const findings = [];
  if (leave && decision.workingWindow && decision.workingWindow.todayIsWorking) findings.push(`Production treats today as a working day (workingWindow.todayIsWorking = true), but People HR has you on ${leave.detail || 'leave'}.`);

  const withheld = [];
  let selected = null;
  // Attention records the decision names, read only for their dedupe_key.
  const recordKeys = {};
  for (const ref of [saim.lead && saim.lead.ref, ...((saim.held || []).map((h) => h.ref))]) {
    const id = String(ref || '').replace(/^(item|held):/, '');
    if (!/^att_/.test(id)) continue;
    try { const rec = (deps.getRecord || ((x) => _db().getAttentionRecord(x)))(id); if (rec && rec.dedupe_key) recordKeys[id] = rec.dedupe_key; } catch { /* unresolved — withheld below */ }
  }
  const order = productionOrder(saim, pool, recordKeys);
  for (const c of order) {
    _overBudget(budgetBy);
    const item = c.item;
    if (c.role === 'lead' && c.kind === 'meeting') {
      withheld.push({ ref: c.ref, title: c.title, reason: 'not-a-commitment', why: 'The lead is a calendar entry, not something owed.' });
      if (/anniversary|birthday/i.test(c.title)) findings.push(`Production's lead is "${c.title}" as a meeting with others (rule ${c.rule}) — a personal phone-calendar entry, so everything else is held behind it.`);
      continue;
    }
    if (c.role === 'held' && /^home:|personal/.test(c.ref)) { withheld.push({ ref: c.ref, title: c.title, reason: 'personal-domain', why: 'Personal, not an operational commitment — outside this slice.' }); continue; }
    if (!item) { withheld.push({ ref: c.ref, title: c.title, reason: 'unresolvable', why: 'Production held it, but the item behind the reference could not be read.', missing: ['the pool item for this reference'] }); continue; }

    if (item.type === 'weekly_risk') {
      withheld.push({ ref: c.ref, title: item.title, reason: 'unsupported-kind', why: 'Preparing the weekly report reads NOVA KPIs over the network — this slice makes no requests.' });
      continue;
    }
    if (item.type === 'capacity' && item.meta && item.meta.taskId) {
      withheld.push({ ref: c.ref, title: item.title, reason: 'not-a-commitment', why: 'A capacity warning about a task, not the task.' });
      continue;
    }
    if (item.type === 'capacity') { withheld.push({ ref: c.ref, title: item.title, reason: 'not-a-commitment', why: 'A capacity summary across tasks, not one commitment.' }); continue; }
    if (item.type === 'email') { withheld.push({ ref: c.ref, title: item.title, reason: 'not-assessed', why: 'Email content is not read for a prepared move in this slice.' }); continue; }
    if (item.type !== 'todo') { withheld.push({ ref: c.ref, title: item.title, reason: 'unsupported-kind', why: `No preparation path for "${item.type}" yet.` }); continue; }

    // ── A held todo: resolve, screen, gather, compose. ──
    const res = resolveTodoCard(item);
    if (!res.unique) { withheld.push({ ref: c.ref, title: item.title, reason: res.hits.length ? 'ambiguous' : 'unresolvable', why: res.hits.length ? `${res.hits.length} records carry exactly this wording.` : 'No open record carries exactly this wording.', missing: ['one record this card is about'] }); continue; }
    const record = res.unique;
    if (record.domain === 'personal') { withheld.push({ ref: c.ref, title: item.title, reason: 'personal-domain', why: 'Personal task.' }); continue; }
    if (record.system !== 'planner') { withheld.push({ ref: c.ref, title: item.title, reason: 'unsupported-kind', why: 'Only Planner commitments with a register row are prepared in this slice.' }); continue; }
    const register = findRegisterRow(record.msId);
    if (!register) { withheld.push({ ref: c.ref, title: item.title, reason: 'no-context', why: 'No tracker row carries this Planner id, so what it is for and who co-owns it cannot be read.', missing: ['a project register row naming this Planner id'] }); continue; }
    const r = register.row;
    const reg = { id: r.id || register.cells[0], action: r.action || register.cells[1], source: r.source || '', owner: r.owner || '', due: r.due || '', notes: r.notes || '', path: register.path, line: register.line, observedAt: register.observedAt, project: register.project, addedNote: (/Added (\d\d\/\d\d)/.exec(r.notes || '') || [])[1] };
    reg.ownerNames = reg.owner.split(/,\s*/).map((s) => s.trim()).filter(Boolean);

    const diary = readDiary(today, 14);
    const fresh = freshnessScreen([
      { kind: 'decision', ref: 'snapshot', observedAt: decidedAt },
      { kind: 'calendar', ref: 'calendar_cache', observedAt: diary.fetchedAt },
      { kind: 'availability', ref: 'team_availability', observedAt: snap.fetchedAt || null, optional: true },
      { kind: 'planner-mirror', ref: record.mirror.path, observedAt: record.mirror.observedAt },
    ], nowMs);
    if (!diary.known || !fresh.ok) { withheld.push({ ref: c.ref, title: item.title, reason: 'stale', why: 'A source this would rest on is stale or unreadable.', missing: fresh.rows.filter((x) => x.stale && !x.optional).map((x) => `${x.ref} (${x.ageHours == null ? 'unreadable' : `${x.ageHours}h old, limit ${x.maxHours}h`})`) }); continue; }

    // Every candidate is screened; only ONE is prepared — the first in production's order.
    if (selected) { withheld.push({ ref: c.ref, title: item.title, reason: 'eligible-not-prepared', why: 'Passed every screen, but SAiM prepares one move at a time and an earlier one in production\'s order was chosen.' }); continue; }

    const coOwnerName = reg.ownerNames.find((n) => !/^nick( ward)?$/i.test(n));
    const coOwner = coOwnerName ? resolveOwner(coOwnerName, roster) : null;
    const coOwnerEmail = coOwner ? _peopleEmail(coOwner.name) : null;
    const forum = nextForum({ project: reg.project, coOwnerEmails: coOwnerEmail ? [coOwnerEmail] : [], nowMs });
    if (forum) forum.organiserName = (forum.people.find((p) => String(p.email).toLowerCase() === String(forum.organizer_email).toLowerCase()) || {}).name || null;

    // What the notes already say about the action, plus how rejections are recorded today.
    // Three passes: lines about the action itself; how rejections are recorded today; and the
    // requirement statements the drafter looks for (what an escalation must carry, what a
    // rejection must say).
    const stats = {};
    const evidence = [
      ...findEvidenceLines(reg.action, { roster, excludePath: register.path, stats, corpus }),
      ...findEvidenceLines('escalation rejection reason free text dropdown', { roster, limit: 6, min: 4, stats, corpus }),
      ...findEvidenceLines('', { roster, limit: 6, stats, corpus, patterns: [/\bevery escalation must (show|carry|include)\b/i, /\bwithout stating exactly what is missing\b/i] }),
    ].filter((l, i, a) => a.findIndex((x) => x.path === l.path && x.line === l.line) === i);
    // The latest decision in the notes that changes who the "teams" are.
    const consolidation = (() => {
      // A DECISION line (it starts with the verb) in a dated meeting note that names a receiving team.
      const teamWords = /\b(TPJ|Tier [123]|Development|Customer Care|Finance|Customer Success)\b/;
      const hits = findEvidenceLines('consolidate into main NT Jira project escalation SLA', { roster, limit: 40, corpus })
        .filter((l) => /^Meetings\/\d{4}\/\d\d\/\d{4}-\d\d-\d\d/.test(l.path) && /^[-*>\s]*\**consolidate\b/i.test(l.text) && teamWords.test(l.text))
        .sort((a, b) => b.path.localeCompare(a.path));
      const l = hits[0];
      return l ? { date: /(\d{4}-\d\d-\d\d)/.exec(l.path)[1], what: l.text.replace(/^[-*>\s]+/, '').replace(/\.$/, ''), cite: `${l.path}:${l.line}`, observedAt: l.observedAt } : null;
    })();
    // Absence of a draft: no note edited since the row was added mentions the action's id with "criteria".
    const draftSearch = (() => {
      const files = [..._walk('Projects'), ..._walk('Meetings/2026/10')];
      // From the day the register says the row was added ("Added 23/09"); unknown → the last 60 days.
      const added = reg.addedNote ? `${today.slice(0, 4)}-${reg.addedNote.slice(3, 5)}-${reg.addedNote.slice(0, 2)}` : null;
      const since = added ? Date.parse(`${added}T00:00:00Z`) : nowMs - 60 * DAY;
      // A note NAMED for this work (the criteria, or the register id) edited since the row was added.
      const hits = files.filter((rel) => rel !== register.path).filter((rel) => { const t = _mtime(rel); return t && Date.parse(t) >= since; }).filter((rel) => /criteria/i.test(path.basename(rel)) || path.basename(rel).startsWith(`${reg.id} `) || path.basename(rel).includes(` ${reg.id} `));
      return { searched: files.length, hits, at: new Date(nowMs).toISOString() };
    })();
    if (draftSearch.hits.length) { withheld.push({ ref: c.ref, title: item.title, reason: 'already-in-progress', why: `A draft may already exist: ${draftSearch.hits.join(', ')}.` }); continue; }

    const tf = require('./time-fit');
    const tb = require('./task-blocks');
    const wd = require('./working-days');
    const nonWorking = new Set([...wd.holidaySet(), ...(leave ? [today] : [])]);
    const minutes = tf.ASSUMED_MINUTES;
    const deadline = forum ? forum.start_local : null;
    const first = tb.findSlot({ minutes, events: diary.events, now: new Date(nowMs), nonWorking });
    const beforeDeadline = (s) => s && s.date && (!deadline || `${s.date}T${s.endTime}` <= deadline);
    const slot = first.date ? (beforeDeadline(first) ? { ...first, minutes, assumed: true } : { reason: `the first ${minutes}-minute gap (${dayLabel(first.date)} ${first.startTime}) is after the meeting` }) : { reason: first.reason };
    // Two alternatives, from the same wall rule, on the days before the meeting.
    const alternatives = [];
    if (slot.date) {
      for (let d = 0; d < 10 && alternatives.length < 2; d++) {
        const day = ymdLondon(Date.parse(`${today}T12:00:00Z`) + d * DAY);
        if (nonWorking.has(day) || [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
        if (deadline && day > deadline.slice(0, 10)) break;
        const g = tb.freeGapsOn({ dateKey: day, events: diary.events.filter((e) => !(e.showAs === 'free')), now: new Date(nowMs), minGap: minutes + tf.BUFFER_MINUTES });
        for (const gap of (g.gaps || [])) {
          const start = gap.start; const end = (() => { const [h, m] = start.split(':').map(Number); const t = h * 60 + m + minutes; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; })();
          if ((day === slot.date && start === slot.startTime) || (deadline && `${day}T${end}` > deadline)) continue;
          alternatives.push({ date: day, startTime: start, endTime: end });
          if (alternatives.length >= 2) break;
        }
      }
    }

    const draft = draftFromEvidence({ action: reg.action, registerRef: { id: reg.id, path: reg.path, line: reg.line, source: reg.source }, lines: evidence, consolidation });
    // Shown as observations: the lines the draft rests on, then other trackers carrying the same action id.
    const cited = new Set(draft.cites);
    const idCell = new RegExp(`\\|\\s*${reg.id}\\s*\\|`);
    const observedLines = [
      ...evidence.filter((l) => cited.has(`${l.path}:${l.line}`)),
      ...evidence.filter((l) => !cited.has(`${l.path}:${l.line}`) && l.path.split('/')[1] !== reg.project && idCell.test(l.text)),
    ].filter((l, i, a) => a.findIndex((x) => x.path === l.path && x.line === l.line) === i).slice(0, 6);
    const daysLate = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${record.due}T12:00:00Z`)) / DAY);
    const packet = composePacket({
      card: { ref: c.ref, title: item.title, reason: item.reason }, decision, record, register: reg, evidence, observedLines, consolidation,
      forum, diary,
      leave: leave ? { ...leave } : null, leaveUnknown: !leaveToday.known, today, coOwner, draft, draftSearch, slot, alternatives, daysLate,
      screens: { freshness: fresh },
    }, nowMs);
    selected = {
      ref: c.ref, title: item.title, record: { system: 'planner', msId: record.msId, plan: record.plan },
      // The register row as data, so a surface can say what the work IS in plain
      // words without parsing prose — and keep the row id for traceability only.
      subject: { id: reg.id, action: reg.action, project: reg.project },
      presentAt: duty.onDuty ? 'now' : 'your next working morning',
      freshness: fresh.rows,
      screens: { freshnessOk: fresh.ok, recordUnique: true },
      ...packet,
    };
  }

  return {
    contract: CONTRACT,
    generatedAt: new Date(nowMs).toISOString(),
    decision: { rule: decision.rule, lead: decision.lead && decision.lead.title, decidedAt, policyVersion: decision.policyVersion },
    duty,
    selected,
    withheld,
    findings,
    gaps: [...gaps, ...((nowView.gaps || []).map((g) => ({ input: g.input, why: g.why })))],
    // Production's order, as data, for the general planner (prepared-move-planner):
    // every candidate it screened, with the pool item behind it. Not part of
    // the packet's hash — what a confirmation binds is the selected move.
    candidates: order.map((c) => ({ ref: c.ref, role: c.role, rule: c.rule || null, title: c.title, kind: c.kind || null, item: c.item ? { type: c.item.type, id: c.item.id, title: c.item.title, reason: c.item.reason || null, urgency: c.item.urgency || null, meta: c.item.meta || null } : null })),
    noneBecause: selected ? null : 'No candidate in production\'s decision passed every screen — each is listed under withheld with what is missing.',
  };
}

module.exports = { CONTRACT, MAX_AGE_HOURS, blockTitleFor, notePathFor, resolveTodoCard, freshnessScreen, composePacket, draftFromEvidence, productionOrder, resolveOwner, tokens, prepare, dutyFor, readDuty, HELD_SAY, BudgetExceeded, warmEvidenceIndex, _test: { makeCorpus, noteIndex: _noteIndex } };
