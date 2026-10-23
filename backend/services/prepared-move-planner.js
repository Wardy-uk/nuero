'use strict';

/**
 * THE PREPARED-MOVE PLANNER (21 Oct 2026) — SAiM tries to COMPLETE the work,
 * not merely to prepare a note about it. For one candidate it takes the work
 * to the furthest safe, truthful, reviewable point, in this order:
 *
 *   1. DO       — an explicitly allow-listed adapter completes the work.
 *                 ⚠ The allow-list is EMPTY in this MVP: nothing NEURO holds
 *                 today can finish a task without inventing a fact or making
 *                 an unapproved commitment. `DO_ADAPTERS` is where one goes.
 *   2. DRAFT    — the real deliverable: the email reply itself (a governed
 *                 reply_email, sent only after Nick's approval code), the
 *                 meeting preparation itself, or the project note itself.
 *   3. SCHEDULE — one attendee-free block, ONLY when Nick's own judgement or
 *                 authorship is needed to finish (the draft has open gaps).
 *   4. ASK      — when SAiM cannot safely do or draft it, the exact blocker
 *                 and what Nick must supply, as a question he can answer. His
 *                 answer becomes a source fact ("you said") and the move is
 *                 planned again as a NEW version.
 *
 * TWO ENTRY ROUTES, ONE PIPELINE: the automatic scan (prepared-move-scan) and
 * the manual "Make this ready" on a Now item (routes/prepared-moves /prepare)
 * both call `planAndStore()`. There is no second screening, builder, store or
 * confirmation path.
 *
 * WHERE CANDIDATES COME FROM: production's own decision, read-only, through
 * the existing prepared-move `prepare()` (canonical Now's lead and what it
 * held, in that order). That slice still owns the Planner-register case; this
 * planner never prepares a candidate it already selected.
 *
 * NOTHING EXTERNAL IS WRITTEN HERE. Planning reads (and, for a draft, asks the
 * model and reads the email it answers); storing writes one immutable NEURO
 * row. Every external change happens only in prepared-move-exec, after Nick
 * confirms the exact stored version.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTRACT = 'prepared-move-v2';
const KINDS = Object.freeze(['email-reply', 'meeting-prep', 'project-note']);
/** Completing adapters (step 1). Deliberately empty in the MVP — see header. */
const DO_ADAPTERS = Object.freeze([]);
/** Project folders never written into, whatever a task's source says. */
const DENY_FOLDERS = Object.freeze(['Archive', 'PIP', '_about.md']);
/** A meeting this soon cannot be prepared for in time; one already started is not prepared at all. */
const MIN_MEETING_LEAD_MIN = 15;
const BLOCK_MINUTES = 30;
const ANSWER_MAX = 1000;
const ONE_TO_ONE = /\b1\s*[-:]?\s*(?:2\s*[-:]?\s*1|to\s*1|on\s*1)\b|\bone[- ]to[- ]one\b|\b1:1\b/i;
const AUTOMATED = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounces?|alerts?)([._-]|@)/i;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DAY = 86400000;
const ymdLondon = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLong = (d) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || null;

const moveKeyFor = (kind, sourceKey) => `saim-move:v2:${kind}:${sourceKey}`;

// ── Pure screens ─────────────────────────────────────────────────────────────

/**
 * PURE. Could this Now item be made ready at all? Read from the item alone —
 * used to OFFER "Make this ready"; the full screen still decides.
 */
function quickEligible(item) {
  if (!item || typeof item !== 'object') return null;
  const m = item.meta || {};
  if (item.type === 'email' && item.id === 'email-urgent' && m.emailId) return { kind: 'email-reply', label: 'Draft the reply' };
  if (item.type === 'meeting' && m.withOthers === true && Number(m.minutesAway) >= MIN_MEETING_LEAD_MIN && !ONE_TO_ONE.test(String(item.title || ''))) return { kind: 'meeting-prep', label: 'Make the meeting prep ready' };
  if (item.type === 'todo') return { kind: 'project-note', label: 'Make this ready' };
  return null;
}

/** PURE. A safe note title from a task's own words: one line, plain characters, bounded. */
function safeTitle(text) {
  const t = String(text || '').replace(/[^A-Za-z0-9 ,'&()-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 3) return null;
  return t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, '').trim() : t;
}

/**
 * PURE. Does a drafted text bring in a FACT its sources do not hold? Every
 * email address, URL, number/date token and proper-name-looking word (a
 * capitalised word that does not start a sentence) must appear in the source
 * text. A short vocabulary of greetings and sign-offs is allowed. Errs towards
 * refusing: a refused draft is asked for again; an invented fact reaches Nick.
 */
const ALLOWED_WORDS = new Set(['I', 'Nick', 'Hi', 'Hello', 'Thanks', 'Thank', 'Best', 'Regards', 'Cheers', 'Kind', 'Many', 'OK', 'Ok', 'Yes', 'No', 'SAiM', 'NEURO', 'Draft', 'Suggested']);
function ungrounded(text, sources) {
  const src = String(sources || '').toLowerCase();
  const out = new Set();
  const draft = String(text || '');
  for (const m of draft.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []) if (!src.includes(m.toLowerCase())) out.add(m);
  for (const m of draft.match(/https?:\/\/\S+/g) || []) if (!src.includes(m.toLowerCase())) out.add(m);
  for (const m of draft.match(/\d[\w:/.,%£$-]*/g) || []) { const t = m.replace(/[.,]+$/, ''); if (t && !src.includes(t.toLowerCase())) out.add(t); }
  for (const sentence of draft.split(/(?<=[.!?:\n])\s+|\n+/)) {
    const words = sentence.replace(/^[\s\-*>#"'“‘(]+/, '').split(/\s+/);
    words.forEach((w, i) => {
      const clean = w.replace(/^[("'“‘]+|[)"'”’.,;:!?]+$/g, '').replace(/['’]s$/, '');
      if (i === 0 || !/^[A-Z][a-zA-Z'’-]+$/.test(clean) || ALLOWED_WORDS.has(clean)) return;
      if (!src.includes(clean.toLowerCase())) out.add(clean);
    });
  }
  return [...out];
}

/** PURE. The default questions when SAiM lacks what it needs, by blocker. */
function questionFor(blocker, ctx = {}) {
  if (blocker === 'no-folder') return { id: 'folder', question: 'Which project folder should this note go in?', why: 'The task does not come from a project note, so SAiM does not know where the work lives.', choices: ctx.folders || [] };
  if (blocker === 'no-content') return { id: 'purpose', question: 'What should this cover? A sentence or two is enough.', why: 'Your notes say nothing about it yet beyond the task itself, so a draft would be invented.' };
  if (blocker === 'no-meeting-facts') return { id: 'aim', question: `What do you want out of ${ctx.title || 'this meeting'}?`, why: 'SAiM found nothing in your notes about the people in it or what is open with them.' };
  return null;
}

// ── Readers (read-only) ──────────────────────────────────────────────────────

const _db = () => require('../db/database');
const vaultRoot = () => process.env.OBSIDIAN_VAULT_PATH || '';

function projectFolders() {
  try {
    return fs.readdirSync(path.join(vaultRoot(), 'Projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !DENY_FOLDERS.includes(e.name)).map((e) => e.name).sort();
  } catch { return []; }
}
const _exists = (rel) => { try { return fs.existsSync(path.join(vaultRoot(), rel)); } catch { return false; } };
const _read = (rel) => { try { return fs.readFileSync(path.join(vaultRoot(), rel), 'utf8'); } catch { return null; } };

/** Default dependencies; tests swap any of them. */
const DEFAULT_DEPS = {
  prepareV1: (o) => require('./prepared-move').prepare(o),
  roster: () => { try { return require('./entities').getRoster(); } catch { return { full: [] }; } },
  triageEntry: (id) => { try { return (require('./email-triage').getStoredTriage() || []).find((e) => e.id === id) || null; } catch { return null; } },
  emailBody: async (id) => {
    try {
      if (require('./gmail-intake').isGmailId(id)) { const g = await require('./gmail-intake').readMessage(id); return g && g.ok && g.exists ? String(g.body || '') : null; }
      const m = await require('./microsoft').fetchEmailById(id);
      return m ? String(m.body || m.preview || '') : null;
    } catch { return null; }
  },
  liveReply: (id) => require('./prepared-actions').liveReplyFor(id),
  task: (id) => { try { return _db().get(`SELECT id, text, status, due_date, origin_path, source, domain, estimate_minutes FROM tasks WHERE id = ?`, [id]) || null; } catch { return null; } },
  meetingEvent: (eventId) => {
    try { return _db().get(`SELECT event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, fetched_at FROM calendar_cache WHERE event_id = ? ORDER BY fetched_at DESC LIMIT 1`, [eventId]) || null; } catch { return null; }
  },
  meetingPeople: (eventId) => {
    try { return _db().all(`SELECT p.name, p.email FROM wm_meeting_participants p WHERE p.meeting_id = ?`, [`graph:${eventId}`]); } catch { return []; }
  },
  meetingPrep: (meeting) => { try { return require('../routes/meeting-prep-view')._buildPrep(meeting); } catch (e) { return { attendees: [], recentDecisions: [], vaultContext: [], gaps: [{ input: 'prep', why: e.message }] }; } },
  evidenceLines: (text, { roster, folder }) => _projectLines(text, { roster, folder }),
  diary: (fromYmd, days) => _diary(fromYmd, days),
  findSlot: (opts) => require('./task-blocks').findSlot(opts),
  holidays: () => { try { return require('./working-days').holidaySet(); } catch { return new Set(); } },
  // Booked off on that day (People HR via NOVA). Unknown is NOT off — the
  // fresh checks re-read leave before anything is written.
  // 23 Oct 2026: TRI-STATE, failing closed. 'off' (known and booked off),
  // 'working' (known and not off), or 'unknown' (unreadable, not yet synced,
  // or a reader error). An unknown day is never offered a time.
  leaveState: (day) => {
    try {
      const ta = require('./team-availability');
      const r = ta.selfAbsenceOn(day, ta.snapshot(new Date()));
      if (!r || r.known !== true) return 'unknown';
      return r.off === true ? 'off' : r.off === false ? 'working' : 'unknown';
    } catch { return 'unknown'; }
  },
  activeV2: (now) => require('./prepared-move-store').activeV2({ now }),
  // A Keep my word promise, read from the ledger (read only).
  promise: (key, now) => { const l = require('./promise-ledger').read({ now }); if ((l.gaps || []).some((g) => g.input === 'tasks')) throw new Error('the task list could not be read'); return (l.promises || []).find((x) => x.key === key) || null; },
  promiseDelivered: (key) => { try { return require('./promise-score').readProofs().proofs.has(key); } catch { return false; } },
  // Projects Nick explicitly linked this task to (Build 24's project_task_links) — their vault folders.
  projectLinks: (taskId) => { try { return _db().all(`SELECT p.vault_path FROM project_task_links l JOIN projects p ON p.project_id = l.project_id WHERE l.task_id = ? AND l.state = 'linked' AND p.removed_at IS NULL AND p.vault_path IS NOT NULL`, [taskId]).map((r) => r.vault_path); } catch { return []; } },
  promiseOwed: (p, answers) => require('./promise-owed').stateFor(p, { answer: require('./promise-owed').latestOwed(answers) }),
  completed: (moveKey) => require('./prepared-move-store').completedMove(moveKey),
  draft: (kind, input) => require('./prepared-move-drafter').draft(kind, input),
  answers: (moveKey) => require('./prepared-move-store').answersFor(moveKey),
  suppression: (moveKey, now) => require('./prepared-move-store').suppression(moveKey, now),
  latest: (moveKey) => require('./prepared-move-store').latest(moveKey),
  store: (packet, o) => require('./prepared-move-store').store(packet, o),
  markChecked: (id, now) => require('./prepared-move-store').markChecked(id, now),
};

/** Lines in ONE project folder (and nowhere else) that share 3+ words with the task. */
function _projectLines(text, { roster, folder }) {
  const pm = require('./prepared-move');
  const want = new Set(pm.tokens(text));
  const out = [];
  const dir = path.join(vaultRoot(), 'Projects', folder);
  let files = [];
  const walk = (d, rel, depth) => {
    if (depth > 3) return;
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'Archive') walk(path.join(d, e.name), r, depth + 1); } else if (e.name.endsWith('.md')) files.push(r);
    }
  };
  walk(dir, `Projects/${folder}`, 0);
  files = files.slice(0, 400);
  for (const rel of files) {
    const body = _read(rel); if (!body) continue;
    if (pm.employmentScreen({ sourceText: body, roster, sourceTitle: path.basename(rel, '.md') }).sensitive) continue;
    const lines = body.replace(/\r\n/g, '\n').split('\n');
    lines.forEach((l, i) => {
      const clean = l.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (clean.length < 25 || clean.length > 600 || /^\|?\s*[-:]+\s*\|/.test(clean)) return;
      const shared = pm.tokens(clean).filter((w) => want.has(w));
      if (shared.length >= 3) out.push({ text: clean, cite: `${rel}:${i + 1}`, score: shared.length });
    });
  }
  return out.sort((a, b) => b.score - a.score || a.cite.localeCompare(b.cite)).slice(0, 8);
}

function _diary(fromYmd, days) {
  const db = _db();
  const to = ymdLondon(Date.parse(`${fromYmd}T12:00:00Z`) + days * DAY);
  try {
    const rows = db.all(`SELECT subject, start_time, end_time, is_all_day, show_as, attendees_other, is_organizer FROM calendar_cache WHERE start_time >= ? AND start_time <= ? ORDER BY start_time`, [`${fromYmd}T00:00:00`, `${to}T23:59:59`]);
    const f = db.get(`SELECT MAX(fetched_at) m FROM calendar_cache WHERE source = 'graph'`);
    const fetchedAt = f && f.m ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(f.m)) ? f.m : `${String(f.m).replace(' ', 'T')}Z`).toISOString() : null;
    const { heldDespiteFree } = require('./context-state');
    const events = rows.map((r) => {
      const ev = { date: String(r.start_time).slice(0, 10), start: r.start_time, end: r.end_time, subject: r.subject, isAllDay: Boolean(r.is_all_day), showAs: r.show_as || 'busy', attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null, isOrganizer: r.is_organizer === 1 ? true : r.is_organizer === 0 ? false : null };
      return heldDespiteFree(ev) ? { ...ev, showAs: 'busy' } : ev;
    });
    return { known: true, events, fetchedAt };
  } catch (e) { return { known: false, why: e.message, events: [], fetchedAt: null }; }
}

// ── Normalising a production candidate to one SOURCE ─────────────────────────

/**
 * A production-order candidate → { kind, sourceKey, source, ref, title } or a
 * withhold. A todo is tied to exactly one NEURO task (v1's resolver); an email
 * to its id; a meeting to its calendar event id.
 */
function normalise(c, deps) {
  const item = c.item;
  if (!item) return { withhold: 'unresolvable', why: 'The item behind this could not be read.' };
  const q = quickEligible(item);
  if (!q) {
    if (item.type === 'weekly_risk') return { withhold: 'employment-route', why: 'A deliverable of your own performance plan — routing only.' };
    if (item.type === 'meeting' && ONE_TO_ONE.test(String(item.title || ''))) return { withhold: 'employment-route', why: '1-2-1 preparation is NOVA’s, and a 1-2-1 is an employment conversation — SAiM does not draft it.' };
    if (item.type === 'meeting' && item.meta && item.meta.withOthers !== true) return { withhold: 'not-a-commitment', why: 'A block with nobody else in it has nothing to prepare for others.' };
    if (item.type === 'meeting') return { withhold: 'too-soon', why: `It starts in under ${MIN_MEETING_LEAD_MIN} minutes — too soon to prepare well.` };
    return { withhold: 'unsupported-kind', why: `SAiM has no safe way to take “${item.type}” items forward yet — it can draft email replies, meeting preparation and project notes.` };
  }
  if (q.kind === 'email-reply') return { kind: q.kind, sourceKey: `email:${item.meta.emailId}`, source: { emailId: item.meta.emailId }, ref: c.ref, title: item.title };
  if (q.kind === 'meeting-prep') {
    const eventId = String(item.id).replace(/^cal-/, '');
    return { kind: q.kind, sourceKey: `meeting:${eventId}@${String(item.meta.start || '').slice(0, 16)}`, source: { eventId, start: item.meta.start || null }, ref: c.ref, title: item.title };
  }
  const res = require('./prepared-move').resolveTodoCard(item);
  if (!res.unique) return { withhold: res.hits.length ? 'ambiguous' : 'unresolvable', why: res.hits.length ? `${res.hits.length} records carry exactly this wording, so SAiM cannot tell which one this is.` : 'No open task carries exactly this wording.' };
  if (res.unique.system !== 'neuro') return { withhold: 'unsupported-kind', why: 'A Microsoft task — the existing prepared move covers board cards with a project register row; this one has none SAiM can use.' };
  if (res.unique.domain === 'personal') return { withhold: 'personal-domain', why: 'A personal task — outside work preparation.' };
  return { kind: 'project-note', sourceKey: `task:${res.unique.taskId}`, source: { taskId: res.unique.taskId }, ref: c.ref, title: item.title };
}

// ── Building one candidate ───────────────────────────────────────────────────

/**
 * Screen and gather ONE normalised candidate. Returns either
 *   { ok: false, withhold, why }                     — nothing to offer, said why;
 *   { ok: true, plan: 'ask', ... }                   — needs something from Nick;
 *   { ok: true, plan: 'draft', ..., needsDraft }     — ready for the drafter.
 * Reads only. `evidenceHash` identifies the inputs, so an unchanged candidate
 * can be recognised BEFORE paying for a model call.
 */
/**
 * READ-ONLY. Is this task's promise for a PRIVATE DRAFT only? True when its
 * own wording is ordinary but the meeting/project note it came from discusses
 * people's employment (prepared-move.employmentScreen over the source note).
 * → { privateDraft, categories, sourceText }
 */
function promiseMode(task, roster) {
  if (!task || !task.origin_path) return { privateDraft: false, categories: [], sourceText: null };
  const note = _read(task.origin_path);
  const emp = require('./prepared-move').employmentScreen({ wording: task.text, sourceTitle: path.basename(task.origin_path, '.md'), sourceText: note || '', roster });
  return { privateDraft: emp.sensitive && !emp.categories.includes('hr-wording') && !emp.categories.includes('pip-deliverable'), categories: emp.categories, sourceText: note };
}

/**
 * READ-ONLY. The gather result for a private working brief: a deterministic
 * draft (private-brief.compose — no model, nothing invented), saved beside its
 * source note, with the decisions as the things only Nick can supply.
 */
/**
 * READ-ONLY. Where a private draft is kept (26 Oct 2026, Nick's rule). Never
 * asked, never guessed, never beside the source meeting: the meeting note is
 * EVIDENCE, not a destination. A project's folder ONLY when exactly one
 * existing project is demonstrated — the task's own origin is inside that
 * project's folder, and/or Nick explicitly linked the task to it — and no
 * evidence points anywhere else. Otherwise the fixed holding place
 * Projects/Working (private-brief.WORKING_FOLDER).
 *   → { folder, project|null, basis: 'task-origin'|'project-link'|'none'|'conflict', candidates }
 */
function destinationFor(task, deps) {
  const brief = require('./private-brief');
  const folders = projectFolders();
  const found = new Map(); // project folder → basis
  const origin = /^Projects\/([^/]+)\//.exec(String((task && task.origin_path) || ''));
  if (origin && folders.includes(origin[1])) found.set(origin[1], 'task-origin');
  let links = [];
  try { links = (deps.projectLinks || DEFAULT_DEPS.projectLinks)(task.id) || []; } catch { links = []; }
  for (const vp of links) {
    const m = /^Projects\/([^/]+)$/.exec(String(vp || ''));
    if (m && folders.includes(m[1]) && !found.has(m[1])) found.set(m[1], 'project-link');
  }
  if (found.size === 1) { const [project, basis] = [...found][0]; return { folder: `Projects/${project}`, project, basis, candidates: [project] }; }
  return { folder: brief.WORKING_FOLDER, project: null, basis: found.size ? 'conflict' : 'none', candidates: [...found.keys()] };
}

/** Bumped whenever what a private draft IS changes (26 Oct 2026: the interview + where it is kept). */
const PRIVATE_DRAFT_RULE = 'interview-1';

function privateBriefGather({ n, p, task, mode, roster, answers, said, observed, freshness, nowMs, deps }) {
  const brief = require('./private-brief');
  const origin = String(task.origin_path || '');
  const t = safeTitle(task.text);
  if (!t) return { ok: false, withhold: 'unresolvable', why: 'The task’s wording cannot be made into a note name.' };
  const dest = destinationFor(task, deps);
  const notePath = `${dest.folder}/${t} (private draft).md`;
  const employment = { sensitive: true, categories: mode.categories, mode: 'private-draft' };
  observed.push({ fact: `Task #${task.id} is open: “${task.text}”${task.due_date ? `, due ${dayLong(task.due_date)}` : ''}.`, source: { kind: 'task', ref: `tasks #${task.id}`, observedAt: new Date(nowMs).toISOString() } });
  observed.push({ fact: 'Its source note discusses people’s employment, so SAiM only prepares a private draft for you — no decision, no contact, nothing sent.', source: { kind: 'note', ref: origin || 'the promise', observedAt: new Date(nowMs).toISOString() } });
  observed.push({ fact: dest.project
    ? `It belongs to one project, ${dest.project} (${dest.basis === 'task-origin' ? 'the task came from that project’s notes' : 'you linked the task to it'}), so the draft is kept there.`
    : `No single project is evidenced${dest.basis === 'conflict' ? ` (it points at ${dest.candidates.join(' and ')})` : ''}, so the draft is kept in your working drafts.`, source: { kind: 'note', ref: dest.folder, observedAt: new Date(nowMs).toISOString() } });
  const src = brief.sourceLines(mode.sourceText || '', p.text || task.text, roster);
  const purpose = said('purpose');
  if (!src.lines.length && !purpose) {
    return { ok: true, plan: 'ask', title: task.text, observed, facts: [], freshness, questions: [{ id: 'purpose', question: 'What should this private draft help you decide?', why: 'Your notes say nothing SAiM can use about it beyond the task’s wording, so a draft would have nothing to stand on.', choices: [] }], employment, privateDraft: true, evidenceHash: sha(JSON.stringify([n.sourceKey, 'private-ask-purpose', answers || []])) };
  }
  if (_exists(notePath)) return { ok: false, withhold: 'already-in-progress', why: `Your private draft already exists: ${notePath}.` };
  // The interview's own answers and parks are placed by compose(); anything else Nick said (what it is for) is quoted as-is.
  const ivIds = new Set(brief.interviewFor(p.text || task.text).map((q) => q.id));
  const youSaid = (answers || []).filter((a) => !['owed', 'withdraw', 'folder', brief.PARK_ID].includes(a.questionId) && !ivIds.has(a.questionId)).map((a) => ({ text: a.text }));
  const todayYmd = new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
  const out = brief.compose({
    title: task.text, promiseText: p.text || task.text, dueLabel: task.due_date ? `Due ${dayLong(task.due_date)}` : null,
    source: { path: origin, title: path.basename(origin, '.md') }, lines: src.lines, leftOut: src.leftOut, said: youSaid, answers: answers || [], todayYmd,
  });
  return {
    ok: true, plan: 'draft', needsDraft: false, privateDraft: { text: out.text, gaps: out.gaps, leftOut: src.leftOut, interview: out.interview },
    title: task.text, task: { id: task.id, text: task.text, due: task.due_date || null },
    // Projects/Working is created by the governed save itself if it is not there yet.
    notePath, folder: dest.folder, destination: dest, folderExists: dest.folder === brief.WORKING_FOLDER ? true : _exists(dest.folder), observed, facts: out.facts, freshness,
    // The RULE is part of the evidence: a draft planned under an older rule (no interview, another place) must never match a fresh one.
    evidenceHash: sha(JSON.stringify([n.sourceKey, 'private-draft', PRIVATE_DRAFT_RULE, dest.folder, task.text, src.lines.map((l) => l.line + l.text), src.leftOut, answers || []])),
    employment,
  };
}

async function gather(n, ctx) {
  const { deps, roster, nowMs, answers } = ctx;
  const pm = require('./prepared-move');
  const ledger = require('./promise-ledger');
  const said = (id) => { const a = (answers || []).filter((x) => x.questionId === id).pop(); return a ? a.text : null; };
  const facts = []; // { text, cite, kind:'source'|'you' }
  const observed = [];
  const freshness = [];
  for (const a of answers || []) if (!['owed', 'withdraw', 'park'].includes(a.questionId)) facts.push({ text: a.text, cite: `you, ${String(a.at).slice(0, 16).replace('T', ' ')}`, kind: 'you' });

  if (n.kind === 'email-reply') {
    const e = deps.triageEntry(n.source.emailId);
    if (!e || e.dismissed) return { ok: false, withhold: 'gone', why: 'That email is no longer waiting in your inbox triage.' };
    const from = String(e.fromEmail || '').toLowerCase();
    if (!from) return { ok: false, withhold: 'unresolvable', why: 'The email has no sender address to reply to.' };
    if (AUTOMATED.test(from)) return { ok: false, withhold: 'not-a-commitment', why: 'It comes from an automated address — there is nobody to reply to.' };
    if (ledger.hrSensitivity(e.subject || '', e.subject || '').sensitive) return { ok: false, withhold: 'employment-route', categories: ['hr-wording'], why: 'It reads as an employment matter — SAiM does not draft those.' };
    const live = deps.liveReply(n.source.emailId);
    if (live) return { ok: false, withhold: 'already-in-progress', why: `A reply to it is already ${live.status} in Actions.` };
    const body = await deps.emailBody(n.source.emailId);
    if (!body || body.trim().length < 20) return { ok: false, withhold: 'unreadable', why: 'SAiM could not read the email itself, so it will not guess at a reply. Open it in your inbox.' };
    const emp = pm.employmentScreen({ wording: `${e.subject || ''}\n${body}`, sourceTitle: e.subject || '', sourceText: body, roster });
    if (emp.sensitive) return { ok: false, withhold: 'employment-route', categories: emp.categories, why: 'It discusses named people’s employment — SAiM does not draft those.' };
    const receivedAt = e.received || e.receivedAt || null;
    const triagedAt = e.triagedAt || null;
    freshness.push({ kind: 'triage', ref: 'email triage', observedAt: triagedAt, maxHours: 26 });
    observed.push({ fact: `${e.from || from} wrote “${e.subject || '(no subject)'}”${receivedAt ? ` on ${dayLong(receivedAt)}` : ''}.`, source: { kind: 'email', ref: `email ${String(n.source.emailId).slice(0, 12)}…`, observedAt: receivedAt } });
    if (e.reason) observed.push({ fact: `Triage put it in your action lane: ${e.reason}.`, source: { kind: 'triage', ref: 'email triage', observedAt: triagedAt } });
    const quoted = body.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 20 && !/^(>|from:|sent:|to:|subject:)/i.test(l)).slice(0, 4);
    for (const q of quoted) facts.push({ text: q.length > 240 ? `${q.slice(0, 239)}…` : q, cite: 'the email', kind: 'source' });
    return {
      ok: true, plan: 'draft', needsDraft: true,
      title: e.subject || n.title, who: e.from || from, whoFirst: firstName(e.from) || from,
      email: { id: n.source.emailId, subject: e.subject || '', from, fromName: e.from || null, body: body.slice(0, 6000) },
      observed, facts, freshness,
      evidenceHash: sha(JSON.stringify([n.sourceKey, sha(body), e.subject, answers || []])),
      employment: emp,
    };
  }

  if (n.kind === 'meeting-prep') {
    const ev = deps.meetingEvent(n.source.eventId);
    if (!ev) return { ok: false, withhold: 'gone', why: 'That meeting is no longer in your calendar.' };
    if (ev.show_as === 'cancelled') return { ok: false, withhold: 'gone', why: 'That meeting has been cancelled.' };
    if (require('./meeting-finish').skippedNow(ev)) return { ok: false, withhold: 'gone', why: 'You said you’re not going to that meeting.' };
    if (ev.attendees_other !== 1) return { ok: false, withhold: 'not-a-commitment', why: 'Nobody else is in it.' };
    if (ONE_TO_ONE.test(ev.subject || '')) return { ok: false, withhold: 'employment-route', why: '1-2-1 preparation is NOVA’s.' };
    if (ledger.hrSensitivity(ev.subject || '', ev.subject || '').sensitive) return { ok: false, withhold: 'employment-route', categories: ['hr-meeting-title'], why: 'Its title reads as an employment matter.' };
    const startLocal = String(ev.start_time).slice(0, 16);
    const startMs = require('./prepared-move-exec').londonMs(startLocal.slice(0, 10), startLocal.slice(11, 16));
    if (startMs - nowMs < MIN_MEETING_LEAD_MIN * 60000) return { ok: false, withhold: 'too-soon', why: 'It starts too soon to prepare for.' };
    const fetchedAt = ev.fetched_at ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(ev.fetched_at)) ? ev.fetched_at : `${String(ev.fetched_at).replace(' ', 'T')}Z`).toISOString() : null;
    freshness.push({ kind: 'calendar', ref: 'calendar_cache', observedAt: fetchedAt, maxHours: 2 });
    const people = (deps.meetingPeople(n.source.eventId) || []).filter((p) => !/nickw@|nick\.ward@/i.test(String(p.email || '')));
    observed.push({ fact: `“${ev.subject}” is ${dayLong(startLocal)} ${startLocal.slice(11, 16)}–${String(ev.end_time).slice(11, 16)}${people.length ? ` with ${people.map((p) => p.name || p.email).join(', ')}` : ''}.`, source: { kind: 'calendar', ref: 'calendar_cache', observedAt: fetchedAt } });
    const prep = deps.meetingPrep({ subject: ev.subject, attendees: people.map((p) => ({ name: p.name, email: p.email })), organizer: null, location: null });
    for (const a of prep.attendees || []) {
      for (const w of (Array.isArray(a.waitingOn) ? a.waitingOn : []).slice(0, 3)) {
        facts.push({ text: `${a.name}: noted as outstanding — “${w.text}”`, cite: w.sourcePath || 'waiting-on (no source recorded — check it before raising it)', kind: 'source' });
      }
      if (a.role) facts.push({ text: `${a.name} — ${a.role}`, cite: `People/${a.name}.md`, kind: 'source' });
    }
    for (const d of (prep.recentDecisions || []).slice(0, 3)) facts.push({ text: d.text, cite: `Decision Log ${d.date || ''}`.trim(), kind: 'source' });
    for (const v of (prep.vaultContext || []).slice(0, 3)) facts.push({ text: `Recent note mentioning ${v.person}: ${v.label}`, cite: v.source, kind: 'source' });
    const realFacts = facts.filter((f) => f.kind === 'source');
    if (!realFacts.length && !said('aim')) {
      return { ok: true, plan: 'ask', title: ev.subject, observed, facts, freshness, questions: [questionFor('no-meeting-facts', { title: ev.subject })], meeting: { start: startLocal, end: String(ev.end_time).slice(0, 16), title: ev.subject }, evidenceHash: sha(JSON.stringify([n.sourceKey, 'ask', answers || []])) };
    }
    const folder = `Meetings/${startLocal.slice(0, 4)}/${startLocal.slice(5, 7)}`;
    const t = safeTitle(ev.subject);
    if (!t) return { ok: false, withhold: 'unresolvable', why: 'The meeting title cannot be made into a note name.' };
    return {
      ok: true, plan: 'draft', needsDraft: true, title: ev.subject,
      meeting: { start: startLocal, end: String(ev.end_time).slice(0, 16), title: ev.subject, people: people.map((p) => p.name || p.email) },
      notePath: `${folder}/${startLocal.slice(0, 10)} – ${t} Prep.md`, folderExists: _exists(folder),
      observed, facts, freshness,
      evidenceHash: sha(JSON.stringify([n.sourceKey, facts.map((f) => f.text), answers || []])),
      employment: { sensitive: false, categories: [] },
    };
  }

  // project-note
  const task = deps.task(n.source.taskId);
  if (!task || !['open', 'in-progress'].includes(task.status)) return { ok: false, withhold: 'gone', why: 'That task is no longer open.' };
  if (task.domain === 'personal') return { ok: false, withhold: 'personal-domain', why: 'A personal task.' };
  if (ledger.hrSensitivity(task.text, '').sensitive) return { ok: false, withhold: 'employment-route', categories: ['hr-wording'], why: 'It reads as an employment matter — routing only.' };
  // A Keep my word promise (24 Oct 2026): who it is owed to comes first — from
  // its own notes, or from Nick's answer to the ONE question asked. Never a guess.
  if (n.source.promiseKey) {
    const p = deps.promise(n.source.promiseKey, nowMs);
    if (!p || !p.open) return { ok: false, withhold: 'gone', why: 'That promise is no longer open.' };
    if (p.sensitivity && p.sensitivity.sensitive) return { ok: false, withhold: 'employment-route', why: require('../../saim/policy/promises.cjs').ROUTING_TEXT };
    // ⚠ PRIVATE-DRAFT MODE (25 Oct 2026). The promise's own wording is ordinary
    // (both checks above passed) but its SOURCE NOTE discusses people's
    // employment: SAiM may not take any employment action, but it MAY prepare a
    // private, non-decisive working brief for Nick (private-brief.js). Who it is
    // owed to is irrelevant to that, so it is never asked first.
    const mode = promiseMode(task, roster);
    if (mode.privateDraft) return privateBriefGather({ n, p, task, mode, roster, answers, said, observed, freshness, nowMs, deps });
    const o = deps.promiseOwed(p, answers);
    if (o.question) {
      return { ok: true, plan: 'ask', title: task.text, observed, facts, freshness, questions: [o.question], promiseKey: p.key, evidenceHash: sha(JSON.stringify([n.sourceKey, 'ask-owed', answers || []])) };
    }
    const who = o.owedTo.self ? 'nobody else — it is yours' : (o.owedTo.resolved || o.owedTo.group);
    if (o.source === 'nick') facts.push({ text: `It is owed to ${who}.`, cite: `you, ${String(o.answer.at).slice(0, 16).replace('T', ' ')}`, kind: 'you' });
    else facts.push({ text: `It is owed to ${who}.`, cite: (p.source && p.source.path) || 'the promise', kind: 'source' });
    observed.push({ fact: `It is a promise${p.source && p.source.title ? ` from “${p.source.title}”` : ''}, owed to ${who}${o.source === 'nick' ? ' (you said)' : ''}.`, source: { kind: o.source === 'nick' ? 'you' : 'note', ref: p.key, observedAt: new Date(nowMs).toISOString() } });
    // A message to ONE named person is delivered by the existing governed
    // delivery note (promise-delivery), not by a project note — hand it there.
    if (o.owedTo.resolved && require('./promise-workbench').MESSAGE_ACT.test(p.text || '')) {
      return { ok: false, handoff: true, withhold: 'delivery-note', why: `It is a message to ${o.owedTo.resolved} — SAiM can draft the delivery note for your approval instead. Nothing is sent.` };
    }
  }
  const folders = projectFolders();
  const fromOrigin = (/^Projects\/([^/]+)\//.exec(String(task.origin_path || '')) || [])[1] || null;
  const answeredFolder = said('folder');
  const folder = fromOrigin && folders.includes(fromOrigin) ? fromOrigin : (answeredFolder && folders.includes(answeredFolder.trim()) ? answeredFolder.trim() : null);
  observed.push({ fact: `Task #${task.id} is open: “${task.text}”${task.due_date ? `, due ${dayLong(task.due_date)}` : ''}.`, source: { kind: 'task', ref: `tasks #${task.id}`, observedAt: new Date(nowMs).toISOString() } });
  if (task.origin_path) {
    const note = _read(task.origin_path);
    const emp = pm.employmentScreen({ wording: task.text, sourceTitle: path.basename(task.origin_path, '.md'), sourceText: note || '', roster });
    if (emp.sensitive) return { ok: false, withhold: 'employment-route', categories: emp.categories, why: 'Its source note discusses named colleagues’ employment — routing only.' };
  }
  if (!folder) {
    return { ok: true, plan: 'ask', title: task.text, observed, facts, freshness, questions: [questionFor('no-folder', { folders })], evidenceHash: sha(JSON.stringify([n.sourceKey, 'ask-folder', answers || []])) };
  }
  if (DENY_FOLDERS.includes(folder)) return { ok: false, withhold: 'employment-route', why: 'That folder is never written into.' };
  const lines = deps.evidenceLines(task.text, { roster, folder });
  for (const l of lines) facts.push({ text: l.text, cite: l.cite, kind: 'source' });
  if (!lines.length && !said('purpose')) {
    return { ok: true, plan: 'ask', title: task.text, observed, facts, freshness, questions: [questionFor('no-content')], evidenceHash: sha(JSON.stringify([n.sourceKey, 'ask-purpose', answers || []])) };
  }
  const t = safeTitle(task.text);
  if (!t) return { ok: false, withhold: 'unresolvable', why: 'The task’s wording cannot be made into a note name.' };
  const notePath = `Projects/${folder}/${t} (draft).md`;
  if (_exists(notePath)) return { ok: false, withhold: 'already-in-progress', why: `A draft already exists: ${notePath}.` };
  return {
    ok: true, plan: 'draft', needsDraft: true, title: task.text, task: { id: task.id, text: task.text, due: task.due_date || null },
    notePath, folder, folderExists: _exists(`Projects/${folder}`), observed, facts, freshness,
    evidenceHash: sha(JSON.stringify([n.sourceKey, task.text, lines.map((l) => l.cite + l.text), answers || []])),
    employment: { sensitive: false, categories: [] },
  };
}

/** PURE. Freshness rows → { ok, rows }. A source with no stamp is stale. */
function freshnessOf(rows, nowMs) {
  const out = rows.map((r) => {
    const t = Date.parse(r.observedAt || '');
    const ageHours = Number.isFinite(t) ? Math.round(((nowMs - t) / 3600000) * 10) / 10 : null;
    return { ...r, ageHours, stale: ageHours == null || ageHours > r.maxHours };
  });
  return { ok: out.every((r) => !r.stale), rows: out };
}

/**
 * PURE. The proposal packet. Every sentence comes from the gathered evidence,
 * the draft, and the slot — nothing from the model is a fact.
 */
function composeV2({ n, g, draft, slot, alternatives = [], decision, duty, nowMs, origin }) {
  const kind = n.kind;
  const moveKey = moveKeyFor(kind, n.sourceKey);
  const fresh = freshnessOf(g.freshness || [], nowMs);
  const base = {
    ref: n.ref, title: g.title || n.title, kind, sourceKey: n.sourceKey, source: n.source, moveKey,
    evidenceHash: g.evidenceHash, observed: g.observed || [], freshness: fresh.rows,
    screens: { employment: g.employment || { sensitive: false, categories: [] }, freshnessOk: fresh.ok, recordUnique: true },
    ...(g.privateDraft ? { privateDraft: privateDraftView() } : {}),
    do: { considered: DO_ADAPTERS.length ? DO_ADAPTERS : [], why: 'Nothing NEURO can do today completes this without inventing a fact or committing you to something, so SAiM goes as far as a draft.' },
  };
  if (g.plan === 'ask') {
    return {
      ...base, plan: 'ask',
      headline: g.privateDraft ? 'I can prepare a private draft for you — I need one thing first.'
        : ((g.questions || [])[0] || {}).id === 'owed' ? 'I can take this forward — I need to know who it is owed to.'
        : kind === 'project-note' ? 'I can start this — I need one thing from you first.' : kind === 'meeting-prep' ? `I can prepare for ${g.title} — tell me what you want from it.` : 'I need one thing from you before I can draft this.',
      outcome: { goal: kind === 'meeting-prep' ? `Walk into ${g.title} prepared.` : `Get “${g.title}” started.`, firstStep: 'Answer the question below.' },
      ask: { questions: g.questions },
      deliverable: { kind, title: g.title, sourceFacts: g.facts || [], suggested: null, gaps: [] },
      preparation: [{ did: 'Screened it and gathered what your notes say.', sideEffect: 'none' }],
      decision: { slots: [], proposedWrites: [] },
      authority: { needsApproval: [], mustNot: g.privateDraft ? MUST_NOT_PRIVATE : MUST_NOT[kind] },
      verification: { checks: [] },
    };
  }
  const writes = [];
  const sourceFacts = g.facts || [];
  const gaps = (draft && draft.gaps) || [];
  let headline; let goal; let firstStep; let doneWhen; let deliverableTitle; let noteContent = null;
  if (kind === 'email-reply') {
    headline = `I drafted the reply to ${g.whoFirst}.`;
    goal = `Answer ${g.who} about “${g.email.subject || g.title}”.`;
    firstStep = 'Read the reply; if it is right, confirm and it goes to Actions for your approval — nothing is sent until you approve it there.';
    doneWhen = 'The reply is sent from Actions after your approval and found in Sent Items.';
    deliverableTitle = `Reply: ${g.email.subject || g.title}`;
    writes.push({ kind: 'governed.reply', emailId: g.email.id, mode: 'reply', to: g.email.from, toName: g.email.fromName, subject: g.email.subject, body: draft.text });
  } else {
    const isPrep = kind === 'meeting-prep';
    headline = isPrep ? `I made the prep for ${g.title} ready.` : g.privateDraft ? `I prepared a private draft for you — ${require('./private-brief').LABEL.replace(/^Private draft for Nick — /, '')}` : `I drafted “${safeTitle(g.title)}”.`;
    goal = isPrep ? `Walk into ${g.title} on ${dayLong(g.meeting.start)} ${g.meeting.start.slice(11, 16)} with what is open in front of you.` : `Get “${g.title}” from a task to a first draft.`;
    firstStep = gaps.length ? `Fill in what only you know: ${gaps[0]}` : 'Read the draft and save it.';
    doneWhen = isPrep ? 'The prep note is saved and the meeting happens with it to hand.' : 'The draft is saved and your own words go past what SAiM wrote.';
    deliverableTitle = isPrep ? `${g.title} — prep` : g.privateDraft ? `${safeTitle(g.title)} — private draft` : `${safeTitle(g.title)} (draft)`;
    if (g.privateDraft) {
      goal = `Think “${g.title}” through yourself, with what your notes say in one place.`;
      firstStep = 'Read the decisions in the draft — they are yours to make.';
      doneWhen = 'You have made the decisions yourself. SAiM makes none and sends nothing.';
    }
    noteContent = g.privateDraft ? draft.text : noteMarkdown({ title: deliverableTitle, kind, sourceFacts, suggested: draft.text, gaps, why: isPrep ? `Prepared for ${g.title}, ${dayLong(g.meeting.start)} ${g.meeting.start.slice(11, 16)}.` : `Prepared from task #${g.task.id}: “${g.task.text}”.` });
    writes.push({ kind: 'vault.note', path: g.notePath });
  }
  const slots = [{ id: 'approve', ...(slot ? { date: slot.date, start: slot.startTime, end: slot.endTime } : {}) },
    ...alternatives.map((a, i) => ({ id: `slot-${i + 1}`, date: a.date, start: a.startTime, end: a.endTime }))];
  // A private draft whose interview still has open questions (26 Oct 2026):
  // the ONLY thing that can be confirmed is saving it UNFINISHED, which books
  // no time. "Save it and protect the time" (approve) is refused by the
  // executor until every question is answered or parked.
  const interview = g.privateDraft && draft && draft.interview ? draft.interview : null;
  if (interview && interview.open > 0) slots.unshift({ id: 'unfinished' });
  if (slot) writes.push({ kind: 'calendar.solo', title: blockTitle(deliverableTitle), attendees: [], body: `Prepared by SAiM. Finish: ${g.notePath || deliverableTitle}` });
  return {
    ...base, plan: 'draft', headline,
    ...(interview ? { interview } : {}),
    outcome: { goal, firstStep, doneWhen },
    deliverable: {
      kind, title: deliverableTitle, sourceFacts,
      suggested: { label: g.privateDraft ? require('./private-brief').LABEL : 'Suggested wording — SAiM wrote this from the sources above; check it before you use it.', text: draft.text },
      gaps, path: g.notePath || null, ...(g.destination ? { destination: g.destination } : {}), to: g.email ? { email: g.email.from, name: g.email.fromName } : null,
    },
    forum: kind === 'meeting-prep' ? { title: g.title, start: g.meeting.start } : null,
    preparation: [{ did: `Drafted the ${kind === 'email-reply' ? 'reply' : 'note'} from ${sourceFacts.length} source line${sourceFacts.length === 1 ? '' : 's'}${slot ? ` and found ${BLOCK_MINUTES} free minutes to finish it` : ''}.`, sideEffect: 'none — nothing saved, booked or sent', draft: noteContent || draft.text }],
    decision: { slots, proposedWrites: writes, forum: kind === 'meeting-prep' ? { title: g.title, start: g.meeting.start } : null },
    why: slot ? `A block is proposed because the draft leaves ${gaps.length} thing${gaps.length === 1 ? '' : 's'} only you can supply.` : (g.noTimeBecause || null),
    noTimeBecause: g.noTimeBecause || null,
    authority: { needsApproval: writes.map((w) => w.kind), mustNot: g.privateDraft ? MUST_NOT_PRIVATE : MUST_NOT[kind] },
    verification: { checks: writes.map((w) => ({ what: w.kind === 'governed.reply' ? 'The reply waits in Actions, not sent' : w.kind === 'vault.note' ? 'The note exists with exactly the confirmed text' : 'The block exists, just you', how: 'read back after writing' })) },
    origin,
  };
}

const MUST_NOT = Object.freeze({
  'email-reply': ['Send the reply — it waits in Actions for your approval code', 'Choose who it goes to — it answers the original sender only', 'Create a task, chase anyone or change a commitment'],
  'meeting-prep': ['Message, invite or email anyone in the meeting', 'Accept, decline or move the meeting', 'Create a task or change a commitment'],
  'project-note': ['Overwrite an existing note', 'Email, invite or message anyone', 'Create a task, move a deadline or tick the task'],
});

/** What a private working draft can never do (25 Oct 2026). */
const MUST_NOT_PRIVATE = Object.freeze([
  'Make an employment decision, or present anything as one',
  'Set targets, terms or rewards for anyone, or judge anyone’s work',
  'Contact, invite or send anything to anyone',
  'Change a People note, assign a task, or publish anything',
]);

/** PURE. How a private draft is labelled wherever it is shown. */
function privateDraftView() {
  const b = require('./private-brief');
  return { label: b.LABEL, cannot: b.CANNOT, can: b.CAN, promise: b.PROMISE };
}

function blockTitle(t) {
  const s = `Finish ${String(t).replace(/[^A-Za-z0-9 ,'&()–-]+/g, ' ').replace(/\s+/g, ' ').trim()}`;
  const cut = s.length > 70 ? s.slice(0, 70).replace(/\s+\S*$/, '') : s;
  return cut.replace(/[^A-Za-z0-9)]+$/, '');
}

/** PURE. The note as saved: source facts and SAiM's wording kept visibly apart. */
function noteMarkdown({ title, sourceFacts, suggested, gaps, why }) {
  return [
    `# ${title}`, '',
    `> ${why} Prepared by SAiM. Nothing here is agreed.`, '',
    '## What your sources say', '',
    ...(sourceFacts.length ? sourceFacts.map((f) => `- ${f.text} _(${f.kind === 'you' ? 'you said' : f.cite})_`) : ['- _(nothing found)_']), '',
    '## Suggested draft (SAiM wrote this — check it)', '',
    String(suggested || '').trim(), '',
    ...(gaps.length ? ['## Still needed from you', '', ...gaps.map((x) => `- [ ] ${x}`), ''] : []),
  ].join('\n');
}

/** The working window a block may sit in — task-blocks' own (09:00–17:30). */
const DUTY = Object.freeze({ start: 9 * 60, end: 17 * 60 + 30 });
const LEAD_MIN = 10;          // time to confirm before a block starts
const SLOT_WORKING_DAYS = 10; // how far ahead to look, in WORKING days, today included
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMins = (t) => { const x = /T(\d\d):(\d\d)/.exec(String(t || '')); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };

/**
 * PURE. The next genuinely available slot (22 Oct 2026): today if a free
 * `minutes` window remains inside the working window (after now + a lead to
 * confirm), else the earliest on the next working day — looking through
 * `workingDays` working days in all. A day that is a weekend, a bank holiday
 * (`nonWorking`) is skipped and does not use up the window. Each working day's
 * LEAVE is tri-state (`leave(day)`): 'off' → skipped; 'working' → considered;
 * anything else (unknown, unreadable) → NOT offered a time — leave that cannot
 * be checked never reads as "not off" (23 Oct 2026). Busy = any timed event
 * that is not free or cancelled (the diary already turns "free but held"
 * meetings into busy). Every slot keeps a buffer either side of a meeting.
 * → { slot: {date,startTime,endTime}|null, searched, skipped, leaveUnknown, why, leaveBlocked }
 */
function nextSlot({ events = [], nowMs, nonWorking = new Set(), leave = () => 'unknown', minutes = BLOCK_MINUTES, buffer = 5, workingDays = SLOT_WORKING_DAYS } = {}) {
  const wd = require('../../shared/working-days.cjs');
  const today = ymdLondon(nowMs);
  const nowLocal = new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'Europe/London' });
  const nowMin = Number(nowLocal.slice(11, 13)) * 60 + Number(nowLocal.slice(14, 16));
  const searched = []; const skipped = []; const leaveUnknown = [];
  for (let i = 0; i < 40 && searched.length < workingDays; i++) {
    const day = ymdLondon(Date.parse(`${today}T12:00:00Z`) + i * DAY);
    if (!wd.isWorkingDay(new Date(`${day}T12:00:00`), nonWorking)) continue;
    searched.push(day);
    let st; try { st = leave(day); } catch { st = 'unknown'; }
    if (st === 'off') { skipped.push(day); continue; }
    if (st !== 'working') { leaveUnknown.push(day); continue; }
    let cursor = DUTY.start;
    if (day === today) cursor = Math.max(cursor, Math.ceil((nowMin + LEAD_MIN) / 5) * 5);
    const busy = (events || []).filter((e) => e && !e.isAllDay && e.showAs !== 'free' && e.showAs !== 'cancelled' && String(e.start).slice(0, 10) === day)
      .map((e) => [toMins(e.start), toMins(e.end)]).filter(([x, y]) => x != null && y != null).sort((x, y) => x[0] - y[0]);
    for (const [st, en] of busy) {
      if (st - buffer - cursor >= minutes) break;
      cursor = Math.max(cursor, en + buffer);
    }
    if (cursor + minutes <= DUTY.end) return { slot: { date: day, startTime: hhmm(cursor), endTime: hhmm(cursor + minutes) }, searched, skipped, leaveUnknown };
  }
  if (leaveUnknown.length) {
    return { slot: null, searched, skipped, leaveUnknown, leaveBlocked: true,
      why: `I couldn’t safely check your leave for ${leaveUnknown.length === searched.length ? 'any' : `${leaveUnknown.length}`} of the next ${workingDays} working days, so I haven’t proposed a time` };
  }
  return { slot: null, searched, skipped, leaveUnknown, why: `no free ${minutes} minutes in the next ${workingDays} working days` };
}

function _slotFor(deps, nowMs) {
  const today = ymdLondon(nowMs);
  const diary = deps.diary(today, 21);
  if (!diary.known) return { known: false, why: 'the calendar could not be read' };
  const r = nextSlot({ events: diary.events, nowMs, nonWorking: deps.holidays(), leave: (d) => deps.leaveState(d) });
  if (!r.slot) return { known: true, slot: null, why: r.why, leaveBlocked: Boolean(r.leaveBlocked) };
  return { known: true, slot: r.slot, diaryFetchedAt: diary.fetchedAt, today: r.slot.date === today };
}

// ── The one pipeline ─────────────────────────────────────────────────────────

/**
 * Plan ONE move and store it. `ref` (manual "Make this ready") forces that
 * candidate; without it (the scan) the first candidate in production's order
 * that passes every screen is taken. `source` re-plans a stored move from its
 * own source (after Nick answers a question) without production's order.
 *
 * → { ok, outcome: 'stored'|'unchanged'|'covered-by-v1'|'none'|'withheld', record?, withheld[], why? }
 */
async function planAndStore({ now = Date.now(), ref = null, source = null, origin = 'scan', firstOrigin = null, skipKeys = null, noBlockKinds = null, deps: over = {} } = {}) {
  const deps = { ...DEFAULT_DEPS, ...over };
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const v1 = await deps.prepareV1({ now: nowMs });
  const duty = (v1 && v1.duty) || { onDuty: false, why: 'unknown' };
  const decision = { decidedAt: (v1 && v1.decision && v1.decision.decidedAt) || new Date(nowMs).toISOString(), rule: v1 && v1.decision && v1.decision.rule, lead: v1 && v1.decision && v1.decision.lead };
  const roster = deps.roster();
  const withheld = [];

  // ⚠ NO GLOBAL ONE-ACTIVE RULE (24 Oct 2026). A manual "Make this ready" is
  // ALWAYS prepared, whatever else SAiM has open — another proposal is never
  // deferred, replaced or touched here. The automatic scan keeps its own cap
  // (prepared-move-scan: one unscheduled review at a time). Every other rule —
  // eligibility, the allowance, per-move confirmation — is unchanged.
  let list;
  if (source) list = [{ n: source }];
  else if (ref && /^promise:/.test(ref)) {
    // A held Keep my word promise, taken forward by Nick from its card.
    const key = ref.slice('promise:'.length);
    let p;
    try { p = deps.promise(key, nowMs); } catch (e) { return { ok: false, outcome: 'withheld', why: `NEURO couldn’t read your promises (${e.message}), so nothing is prepared.`, withheld }; }
    if (!p) return { ok: false, outcome: 'none', why: 'That promise is no longer in what NEURO holds.', withheld };
    if (p.sensitivity && p.sensitivity.sensitive) return { ok: false, outcome: 'withheld', reason: 'employment-route', why: require('../../saim/policy/promises.cjs').ROUTING_TEXT, withheld };
    if (!p.open) return { ok: false, outcome: 'withheld', reason: 'gone', why: 'That promise is closed — there is nothing left to prepare.', withheld };
    if (deps.promiseDelivered(key)) return { ok: false, outcome: 'withheld', reason: 'delivered', why: 'That promise was already delivered and read back.', withheld };
    const lead = p.leadTaskId || (p.taskIds || [])[0];
    if (!lead) return { ok: false, outcome: 'withheld', reason: 'unresolvable', why: 'That promise has no task behind it.', withheld };
    list = [{ n: { kind: 'project-note', sourceKey: `task:${lead}`, source: { taskId: lead, promiseKey: key }, ref, title: p.text } }];
  } else {
    const cands = (v1 && v1.candidates) || [];
    list = (ref ? cands.filter((c) => c.ref === ref) : cands).map((c) => ({ c }));
    if (ref && !list.length) return { ok: false, outcome: 'none', why: 'That item is no longer in what SAiM is weighing up right now.', withheld };
  }
  const skip = new Set(skipKeys || []);

  for (const entry of list) {
    const c = entry.c;
    if (c && v1 && v1.selected && v1.selected.ref === c.ref) {
      // The register slice already prepared this one — one move, one pipeline.
      return { ok: true, outcome: 'covered-by-v1', why: 'SAiM has already prepared this — it is on your SAiM home.', withheld };
    }
    const n = entry.n || normalise(c, deps);
    if (n.withhold) { withheld.push({ ref: c && c.ref, title: c && c.title, reason: n.withhold, why: n.why }); continue; }
    const moveKey = moveKeyFor(n.kind, n.sourceKey);
    // The scan never re-prepares a move it already has open — it moves on.
    if (!ref && !source && skip.has(moveKey)) continue;
    // A review move may be withheld from the scan while its cap is taken.
    if (!ref && !source && (noBlockKinds || []).includes(n.kind)) {
      withheld.push({ ref: n.ref, title: n.title, reason: 'review-cap', why: 'Another prepared item is still waiting for you to choose a time, so SAiM hasn’t started a second one.' });
      continue;
    }
    const sup = deps.suppression(moveKey, nowMs);
    if (sup && !source) {
      withheld.push({ ref: n.ref, title: n.title, reason: sup.response, why: sup.say });
      if (ref) return { ok: false, outcome: 'withheld', why: sup.say, withheld };
      continue;
    }
    // Already carried out (a complete receipt): done — never offered again.
    if (!source && deps.completed(moveKey)) {
      withheld.push({ ref: n.ref, title: n.title, reason: 'done', why: 'You confirmed this one and it was carried out.' });
      if (ref) return { ok: false, outcome: 'withheld', why: 'You already confirmed this one and it was carried out.', withheld };
      continue;
    }
    // A repeated manual press for the same item returns its OPEN proposal — no
    // duplicate, no new draft, no model call. (A promise press returns one only
    // if it was made for that promise.)
    if (ref && !source) {
      const prior = deps.latest(moveKey);
      // A stored QUESTION is never handed back unexamined (25 Oct 2026): what
      // SAiM needs may have changed (a promise that only allows a private draft
      // no longer needs "who is it owed to?"). Re-gathering an ask is cheap —
      // no model call — and an unchanged one comes back as 'existing' below.
      const live = prior && prior.packet && prior.packet.contract === CONTRACT && Date.parse(prior.evidenceExpiresAt) > nowMs
        && prior.packet.selected && prior.packet.selected.plan !== 'ask'
        && (!n.source.promiseKey || (prior.packet.selected.source || {}).promiseKey === n.source.promiseKey);
      if (live) {
        let still = false;
        try { still = (await recheck(prior.packet, { deps: over })).ok === true; } catch { still = false; }
        if (still) { deps.markChecked(prior.id, nowMs); return { ok: true, outcome: 'existing', record: prior, withheld }; }
      }
    }
    const answers = deps.answers(moveKey) || [];
    let g;
    try { g = await gather(n, { deps, roster, nowMs, answers }); } catch (e) { g = { ok: false, withhold: 'unreadable', why: `SAiM could not read what this rests on (${e.message}).` }; }
    if (!g.ok && g.handoff) {
      if (ref || source) return { ok: true, outcome: 'handoff', why: g.why, handoff: { to: 'promise-delivery', key: n.source.promiseKey }, withheld };
      continue;
    }
    if (!g.ok) {
      withheld.push({ ref: n.ref, title: n.title, reason: g.withhold, why: g.why, categories: g.categories });
      if (ref || source) return { ok: false, outcome: 'withheld', why: g.why, reason: g.withhold, withheld };
      continue;
    }
    // Unchanged evidence → the stored proposal stands; no model call is bought.
    const prior = deps.latest(moveKey);
    // ⚠ The match is only kept if the stored proposal still stands: an unchanged hash over a
    // packet that now fails its own re-check (an older rule, a moved source) is re-planned —
    // handing it back is how "Nothing more to prepare" reached Nick with nothing prepared (26 Oct 2026).
    let stands = false;
    if (prior && prior.packet && prior.packet.selected && prior.packet.selected.evidenceHash === g.evidenceHash) {
      try { stands = prior.packet.selected.plan === 'ask' || (await recheck(prior.packet, { deps: over })).ok === true; } catch { stands = false; }
    }
    if (stands) {
      deps.markChecked(prior.id, nowMs);
      return { ok: true, outcome: ref && !source && prior.packet.selected.plan === 'ask' ? 'existing' : 'unchanged', record: prior, withheld };
    }
    let draft = null; let slot = null; let alternatives = [];
    if (g.plan === 'draft') {
      if (g.notePath && g.folderExists === false) {
        const why = `The folder ${path.posix.dirname(g.notePath)} does not exist, and SAiM never creates folders.`;
        withheld.push({ ref: n.ref, title: n.title, reason: 'no-location', why });
        if (ref || source) return { ok: false, outcome: 'withheld', why, withheld };
        continue;
      }
      const sourcesText = [g.title, ...(g.facts || []).map((f) => f.text), g.email ? g.email.body : '', g.email ? g.email.fromName || '' : '', g.meeting ? (g.meeting.people || []).join(' ') : ''].join('\n');
      // A private working draft is composed, not generated (private-brief.js):
      // no model is asked, so there is nothing to ground-check.
      const d = g.privateDraft ? { ok: true, text: g.privateDraft.text, gaps: g.privateDraft.gaps, interview: g.privateDraft.interview, composed: true }
        : await deps.draft(n.kind, { title: g.title, facts: g.facts, email: g.email || null, meeting: g.meeting || null, task: g.task || null });
      if (!d || !d.ok || !String(d.text || '').trim()) {
        const why = `SAiM could not draft it just now${d && d.why ? ` (${d.why})` : ''} — it will try again later.`;
        withheld.push({ ref: n.ref, title: n.title, reason: 'no-draft', why });
        if (ref || source) return { ok: false, outcome: 'withheld', why, withheld };
        continue;
      }
      const bad = d.composed ? [] : ungrounded([d.text, ...(d.gaps || [])].join('\n'), sourcesText);
      if (bad.length) {
        const why = `The draft brought in things your sources do not say (${bad.slice(0, 3).join(', ')}), so SAiM did not keep it.`;
        withheld.push({ ref: n.ref, title: n.title, reason: 'ungrounded', why });
        if (ref || source) return { ok: false, outcome: 'withheld', why, withheld };
        continue;
      }
      draft = { text: String(d.text).trim(), gaps: (d.gaps || []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 5), ...(d.interview ? { interview: d.interview } : {}) };
      // SCHEDULE — only when the draft needs Nick's own authorship to finish.
      if (n.kind === 'project-note' && draft.gaps.length) {
        const s = _slotFor(deps, nowMs);
        if (s.known && !s.slot && s.leaveBlocked) {
          // Leave could not be checked: the DRAFT may still be offered, but no
          // time is proposed — never a block on a day SAiM cannot verify.
          g.noTimeBecause = `${s.why}.`;
        } else if (!s.known || !s.slot) {
          const why = `It needs your own time to finish, and ${s.why || 'no safe slot was found'} — so nothing is offered.`;
          withheld.push({ ref: n.ref, title: n.title, reason: 'no-safe-slot', why });
          if (ref || source) return { ok: false, outcome: 'withheld', why, withheld };
          continue;
        } else {
          slot = s.slot;
          g.freshness = [...(g.freshness || []), { kind: 'calendar', ref: 'calendar_cache', observedAt: s.diaryFetchedAt, maxHours: 2 }];
        }
      }
    }
    const selected = composeV2({ n, g, draft, slot, alternatives, decision, duty, nowMs, origin });
    if (!selected.screens.freshnessOk) {
      const stale = selected.freshness.filter((r) => r.stale).map((r) => `${r.ref} (${r.ageHours == null ? 'unreadable' : `${r.ageHours}h old`})`);
      const why = `A source it rests on is stale: ${stale.join(', ')}.`;
      withheld.push({ ref: n.ref, title: n.title, reason: 'stale', why });
      if (ref || source) return { ok: false, outcome: 'withheld', why, withheld };
      continue;
    }
    const packet = { contract: CONTRACT, generatedAt: new Date(nowMs).toISOString(), origin, firstOrigin: firstOrigin || origin, decision, duty, selected, withheld };
    const st = deps.store(packet, { now: nowMs });
    if (!st.ok) {
      withheld.push({ ref: n.ref, title: n.title, reason: 'refused', why: st.why });
      if (ref || source) return { ok: false, outcome: 'withheld', why: st.why, withheld };
      continue;
    }
    return { ok: true, outcome: st.created ? 'stored' : 'unchanged', record: st.record, withheld };
  }
  return { ok: true, outcome: 'none', why: 'Nothing in today’s list passed every check.', withheld };
}

/**
 * PURE-ish (reads only; no model call, no network). Would the planner take this
 * normalised candidate forward? The cheap half of `gather` — enough to OFFER
 * "Make this ready" only where pressing it can do something real. The full
 * screen still runs when he presses it.
 */
function prescreen(n, deps, nowMs) {
  const ledger = require('./promise-ledger');
  if (n.kind === 'email-reply') {
    const e = deps.triageEntry(n.source.emailId);
    if (!e || e.dismissed) return 'gone';
    const from = String(e.fromEmail || '').toLowerCase();
    if (!from || AUTOMATED.test(from)) return 'not-a-commitment';
    if (ledger.hrSensitivity(e.subject || '', e.subject || '').sensitive) return 'employment-route';
    if (deps.liveReply(n.source.emailId)) return 'already-in-progress';
    return null;
  }
  if (n.kind === 'meeting-prep') {
    const ev = deps.meetingEvent(n.source.eventId);
    if (!ev || ev.show_as === 'cancelled' || ev.attendees_other !== 1) return 'not-a-commitment';
    if (require('./meeting-finish').skippedNow(ev)) return 'gone';
    if (ONE_TO_ONE.test(ev.subject || '') || ledger.hrSensitivity(ev.subject || '', ev.subject || '').sensitive) return 'employment-route';
    const st = String(ev.start_time).slice(0, 16);
    if (require('./prepared-move-exec').londonMs(st.slice(0, 10), st.slice(11, 16)) - nowMs < MIN_MEETING_LEAD_MIN * 60000) return 'too-soon';
    return null;
  }
  const t = deps.task(n.source.taskId);
  if (!t || !['open', 'in-progress'].includes(t.status)) return 'gone';
  if (t.domain === 'personal') return 'personal-domain';
  if (ledger.hrSensitivity(t.text, '').sensitive) return 'employment-route';
  return null;
}

/** The Now rows a candidate is drawn as (mobile-snapshot's ids). */
function rowIdsFor(c, n) {
  const ids = [];
  if (c.item && c.item.id) ids.push(`attention:${c.item.id}`);
  if (n.kind === 'meeting-prep' && c.item.meta && c.item.meta.start) ids.push(`event:derived:${c.item.meta.start}:${String(c.item.title || '').slice(0, 60)}`);
  if (n.kind === 'project-note') ids.push(`task:${n.source.taskId}`);
  return ids;
}

/**
 * The Now items SAiM can genuinely take forward right now, each with its EXACT
 * production ref (what /prepare takes) and the Now row ids it is drawn as.
 * READ-ONLY — runs inside a read-only pass. Held, personal, employment, gone,
 * deferred, declined, done and already-prepared-elsewhere items are left out:
 * no dead buttons.
 */
async function eligibleNow({ now = Date.now(), deps: over = {} } = {}) {
  const deps = { ...DEFAULT_DEPS, ...over };
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const v1 = await deps.prepareV1({ now: nowMs });
  const out = [];
  if (!v1 || !v1.duty || v1.duty.onDuty !== true) return { onDuty: false, items: out };
  for (const c of v1.candidates || []) {
    if (v1.selected && v1.selected.ref === c.ref) continue;
    const n = normalise(c, deps);
    if (n.withhold) continue;
    const moveKey = moveKeyFor(n.kind, n.sourceKey);
    if (deps.suppression(moveKey, nowMs) || deps.completed(moveKey)) continue;
    if (prescreen(n, deps, nowMs)) continue;
    const q = quickEligible(c.item);
    const prior = deps.latest(moveKey);
    out.push({ ref: c.ref, kind: n.kind, label: q.label, title: n.title, rowIds: rowIdsFor(c, n), prepared: Boolean(prior && Date.parse(prior.evidenceExpiresAt) > nowMs), recordId: prior && Date.parse(prior.evidenceExpiresAt) > nowMs ? prior.id : null });
  }
  return { onDuty: true, items: out };
}

/**
 * Re-check a stored v2 proposal against the world NOW (read-only): the source
 * still exists and is still owed, nothing else has taken it forward, and the
 * draft still screens clean. Used by the fresh checks before any write.
 */
/** PURE-ish (clock only). Has the meeting a meeting-prep move is for already started? Unknown → false. */
function meetingStarted(selected, nowMs = Date.now()) {
  const st = String((selected && selected.forum && selected.forum.start) || '').slice(0, 16);
  if (!selected || selected.kind !== 'meeting-prep' || st.length < 16) return false;
  const startMs = require('./prepared-move-exec').londonMs(st.slice(0, 10), st.slice(11, 16));
  return Number.isFinite(startMs) && startMs <= nowMs;
}

async function recheck(packet, { deps: over = {} } = {}) {
  const deps = { ...DEFAULT_DEPS, ...over };
  const s = packet && packet.selected;
  if (!s) return { ok: false, why: 'there is no prepared move' };
  const ledger = require('./promise-ledger');
  const draft0 = ((s.preparation || []).find((p) => p.draft) || {}).draft || '';
  const isPrivate = s.screens && s.screens.employment && s.screens.employment.mode === 'private-draft';
  // A private draft's "You said" section is Nick's own words in his own note — screened as SAiM's text it would end the interview the moment he wrote "pay".
  const draft = isPrivate ? require('./private-brief').samText(draft0) : draft0;
  if (ledger.hrSensitivity(`${s.title}\n${draft}`).sensitive) return { ok: false, why: 'it now reads as an employment matter' };
  if (s.kind === 'email-reply') {
    const e = deps.triageEntry(s.source.emailId);
    if (!e || e.dismissed) return { ok: false, why: 'the email is no longer waiting in triage — it may already be answered' };
    const live = deps.liveReply(s.source.emailId);
    // Our own draft, already in Actions from an earlier confirm, is not "someone else's".
    const ours = ((s.decision || {}).proposedWrites || []).find((w) => w.kind === 'governed.reply');
    const same = live && ours && live.draft && String(live.draft.body || '').trim() === String(ours.body || '').trim();
    if (live && !same) return { ok: false, why: `a different reply to that email is already ${live.status} in Actions` };
    return { ok: true };
  }
  if (s.kind === 'meeting-prep') {
    const ev = deps.meetingEvent(s.source.eventId);
    if (!ev || ev.show_as === 'cancelled') return { ok: false, why: 'the meeting is no longer in your calendar' };
    if (require('./meeting-finish').skippedNow(ev)) return { ok: false, why: 'you said you’re not going to that meeting' };
    if (String(ev.start_time).slice(0, 16) !== String(s.forum && s.forum.start)) return { ok: false, why: 'the meeting has moved since this was prepared' };
    // Prep for a meeting that has started is no longer prep (22 Oct 2026: the
    // 16:00 prep was still on the Surface at 17:20, under the next diary item).
    if (meetingStarted(s)) return { ok: false, why: 'the meeting has already started' };
    return { ok: true };
  }
  if (s.screens && s.screens.employment && s.screens.employment.mode === 'private-draft' && s.plan === 'draft') {
    if (!require('./private-brief').isPrivateDraft(draft0)) return { ok: false, why: 'the draft is no longer marked as your private draft' };
    // Planned under the 25 Oct rule (no interview; kept beside the meeting): never handed back or confirmed — prepared again.
    const note = ((s.decision || {}).proposedWrites || []).find((w) => w.kind === 'vault.note');
    if (!s.interview || !note || !require('./prepared-move-exec').PRIVATE_NOTE_RULE(String(note.path || ''))) return { ok: false, why: 'it was prepared under an older rule — prepare it again' };
    if (((s.decision || {}).proposedWrites || []).some((w) => !['vault.note', 'calendar.solo'].includes(w.kind))) return { ok: false, why: 'a private draft may only save a note and hold your own time' };
  }
  const t = deps.task(s.source.taskId);
  if (!t || !['open', 'in-progress'].includes(t.status)) return { ok: false, why: 'the task is no longer open' };
  if (t.text !== s.title) return { ok: false, why: 'the task’s wording has changed since this was prepared' };
  if (s.source.promiseKey) {
    let p = null;
    try { p = deps.promise(s.source.promiseKey, Date.now()); } catch { return { ok: false, why: 'NEURO couldn’t read the promise it is for' }; }
    if (!p || !p.open) return { ok: false, why: 'the promise is no longer open' };
    if (deps.promiseDelivered(s.source.promiseKey)) return { ok: false, why: 'the promise was already delivered' };
  }
  return { ok: true };
}

/**
 * "Do this" (23 Oct 2026): a finished task-agent output becomes the SAME
 * project-note prepared move the planner makes itself — the same moveKey
 * (`task:<id>`), destination rule (one evidenced project folder, else
 * Projects/Working), note shape, optional solo block (only when the run left
 * work only Nick can do, through the same slot finder and leave checks),
 * request / confirm / executor and receipts. Nothing new can be confirmed here:
 * this only STORES a proposal. An employment matter is refused, as the
 * executor would refuse it.
 *   → { ok, outcome: 'stored'|'unchanged'|'withheld', record?, why? }
 */
async function planAgentOutput({ taskId, output, sourceFacts = [], remaining = [], now = Date.now(), deps: over = {} } = {}) {
  const deps = { ...DEFAULT_DEPS, ...over };
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const task = deps.task(Number(taskId));
  if (!task || !['open', 'in-progress'].includes(task.status)) return { ok: false, outcome: 'withheld', why: 'The task is no longer open.' };
  const text = String((output && output.markdown) || '').trim();
  if (!text) return { ok: false, outcome: 'withheld', why: 'There is no draft to save.' };
  if (require('./promise-ledger').hrSensitivity(`${task.text}\n${text}`).sensitive) {
    return { ok: false, outcome: 'withheld', reason: 'employment-route', why: 'This reads as an employment / people matter, and NEURO never saves those as notes on its own — keep it in the workspace, or copy it yourself.' };
  }
  const t = safeTitle(task.text);
  if (!t) return { ok: false, outcome: 'withheld', why: 'The task’s wording cannot be made into a note name.' };
  const dest = destinationFor(task, deps);
  const brief = require('./private-brief');
  const notePath = `${dest.folder}/${t} (draft).md`;
  if (dest.folder !== brief.WORKING_FOLDER && !_exists(dest.folder)) return { ok: false, outcome: 'withheld', why: `The folder ${dest.folder} does not exist, and NEURO never creates folders.` };
  const n = { kind: 'project-note', sourceKey: `task:${task.id}`, source: { taskId: task.id }, ref: `task-agent:${task.id}:${output.id}`, title: task.text };
  const moveKey = moveKeyFor(n.kind, n.sourceKey);
  const prior = deps.latest(moveKey);
  const evidenceHash = sha(JSON.stringify(['task-agent', n.sourceKey, task.text, output.id, text, remaining]));
  if (prior && prior.packet && prior.packet.selected && prior.packet.selected.evidenceHash === evidenceHash) {
    let stands = false;
    try { stands = (await recheck(prior.packet, { deps: over })).ok === true; } catch { stands = false; }
    if (stands) { deps.markChecked(prior.id, nowMs); return { ok: true, outcome: 'unchanged', record: prior }; }
  }
  if (_exists(notePath)) return { ok: false, outcome: 'withheld', why: `A draft already exists: ${notePath}.` };
  const gaps = (remaining || []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 5);
  const g = {
    ok: true, plan: 'draft', title: task.text, task: { id: task.id, text: task.text, due: task.due_date || null },
    notePath, folder: dest.folder, destination: dest, folderExists: true,
    observed: [{ fact: `Task #${task.id} is open: “${task.text}”.`, source: { kind: 'task', ref: `tasks #${task.id}`, observedAt: new Date(nowMs).toISOString() } }],
    facts: sourceFacts.slice(0, 12), freshness: [{ kind: 'task', ref: `tasks #${task.id}`, observedAt: new Date(nowMs).toISOString(), maxHours: 2 }],
    evidenceHash, employment: { sensitive: false, categories: [] },
  };
  let slot = null;
  if (gaps.length) {
    const s = _slotFor(deps, nowMs);
    if (s.known && s.slot) { slot = s.slot; g.freshness.push({ kind: 'calendar', ref: 'calendar_cache', observedAt: s.diaryFetchedAt, maxHours: 2 }); } else g.noTimeBecause = `${s.why || 'no safe slot was found'}.`;
  }
  const decision = { decidedAt: new Date(nowMs).toISOString(), rule: 'task-agent', lead: null };
  const selected = composeV2({ n, g, draft: { text, gaps }, slot, decision, duty: null, nowMs, origin: 'task-agent' });
  selected.headline = `NEURO drafted “${safeTitle(task.text)}” — save it to the vault?`;
  selected.preparation[0].did = `NEURO’s Do this run wrote this from ${sourceFacts.length} linked source${sourceFacts.length === 1 ? '' : 's'}${slot ? ` and found ${BLOCK_MINUTES} free minutes for what only you can do` : ''}.`;
  if (!selected.screens.freshnessOk) return { ok: false, outcome: 'withheld', why: 'The calendar it was checked against is stale — try again in a few minutes.' };
  const packet = { contract: CONTRACT, generatedAt: new Date(nowMs).toISOString(), origin: 'task-agent', firstOrigin: 'manual', decision, duty: null, selected, withheld: [] };
  const st = deps.store(packet, { now: nowMs });
  if (!st.ok) return { ok: false, outcome: 'withheld', why: st.why };
  return { ok: true, outcome: st.created ? 'stored' : 'unchanged', record: st.record };
}

module.exports = { meetingStarted, planAgentOutput,
  CONTRACT, KINDS, DO_ADAPTERS, DENY_FOLDERS, BLOCK_MINUTES, ANSWER_MAX, MIN_MEETING_LEAD_MIN,
  moveKeyFor, quickEligible, safeTitle, ungrounded, questionFor, normalise, gather, freshnessOf, composeV2, noteMarkdown, blockTitle,
  planAndStore, recheck, prescreen, promiseMode, destinationFor, MUST_NOT_PRIVATE, eligibleNow, rowIdsFor, projectFolders, nextSlot, SLOT_WORKING_DAYS, DEFAULT_DEPS,
};
