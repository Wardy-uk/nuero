'use strict';

/**
 * "Looks done" — evidence that an OPEN task has already been done (1 Nov 2026).
 *
 * NEURO OFFERS to close; it NEVER closes. A task is a promise Nick reads to find
 * what he owes, and a wrong "looks done" that he trusts loses work silently —
 * so every rule here errs towards saying nothing, and the press that closes is
 * the ordinary task-store completion (wins, Microsoft push and blocks behave
 * exactly as for a tick).
 *
 * Four kinds of evidence, each carrying the VERSION of the rule that matched
 * (progress-evidence's habit: a rule found wrong on live data is bumped, never
 * quietly retuned under rows that were judged by the old one):
 *
 *   sent-email   — a work email in Sent Items (METADATA only: subject,
 *                  recipients, time), sent AFTER the task was created, sharing
 *                  ≥2 DISTINCTIVE content words with the task (people's names
 *                  stripped, rarity judged against Nick's whole task pool), not
 *                  automated mail in his name, and only for a task whose ACT is
 *                  a communication — "build the dashboard" is not done by an
 *                  email about it. When the task names a person NEURO holds an
 *                  address for, the mail must have gone to them.
 *   daily-tick   — a `- [x]` line in a daily note dated on/after the task was
 *                  created that carries the task's `<!--task:N-->` marker, or
 *                  matches it at task-dedupe's FOLD_SCORE.
 *   ms-complete  — the Planner / To Do task this one is LINKED to (`ms_id`) is
 *                  complete in Microsoft. Nothing closes the NEURO half today.
 *   jira-resolved— a Jira ticket the task NAMES at the start of its wording is
 *                  resolved. A ticket in the jira-tasks ledger is Jira-OWNED and
 *                  is closed by jira-tasks.sync, so it is skipped here.
 *
 * ⚠ An unreadable source is a NAMED GAP, never "no evidence", and the evidence
 * it produced on the last good pass is CARRIED FORWARD rather than vanishing.
 * ⚠ "Not yet" suppresses THAT piece of evidence (its key) for that task; a newer
 * piece of evidence has a different key and is offered again.
 * ⚠ Reads write nothing. The scheduled pass is the only writer of the store.
 * ⚠ No message id ever leaves this module: an email's key is a hash.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const dd = () => require('./task-dedupe');

const RULES = Object.freeze({
  'sent-email': 'done-sent-email@1',
  'daily-tick': 'done-daily-tick@1',
  'ms-complete': 'done-ms-complete@1',
  'jira-resolved': 'done-jira-resolved@1',
});

const STORE_KEY = 'task_done_evidence';
const NOT_YET_KEY = 'task_done_evidence_not_yet';
const SENT_MAIL_DAYS = 60;
const DAILY_DAYS = 60;
// task-dedupe / action-candidates FOLD_SCORE — the same bar the cross-note fold uses.
const TICK_SCORE = 0.85;
// A shared word is DISTINCTIVE only if at most this share of Nick's tasks carry
// it. "team", "review", "support" sit in a tenth of his list; "screenshot" does not.
const DISTINCT_SHARE = 0.05;
const MIN_DISTINCT_SHARED = 2;
// Of the task's own (name-stripped) content weight, how much the subject must cover.
const MIN_EMAIL_COVERAGE = 0.4;

// ── Pure: what kind of task an email can satisfy ─────────────────────────────

const LEAD_IN = /^\s*(?:nick(?:olas)?(?:\s+ward)?|i)\s+(?:to|will|should|must|needs?\s+to)\s+/i;
const COMM_VERB = /^(send|email|e-mail|reply|respond|chase|share|forward|confirm|tell|inform|let)$/i;

/**
 * True when the task's ACT is a communication: its FIRST verb (after "Nick to")
 * is one, or a second verb joined by "and" ("Set and confirm …"). A noun later in
 * the wording is not the act — "NT-31244: TPFG AI Email Editor feedback" names an
 * email editor, it does not ask for an email (measured on the live list, 1 Nov).
 */
function isCommunicationTask(text, { firstNames = new Set() } = {}) {
  const raw = String(text || '').replace(LEAD_IN, '');
  if (/^\s*\[?[A-Z][A-Z0-9]+-\d+/.test(raw)) return false; // a ticket title, not an instruction
  const words = raw.toLowerCase().replace(/[^a-z\- ]+/g, ' ').split(/\s+/).filter(Boolean);
  // "Email" and "share" are nouns as often as verbs ("Email template QA checklist").
  // As a verb they are followed by WHO or a determiner: "Email Chris …", "Share the …".
  const isVerb = (w, next) => {
    if (w === 'let') return /\blet\s+\w+(?:\s+\w+)?\s+know\b/i.test(raw);
    if (!COMM_VERB.test(w || '')) return false;
    if (NOUNISH.has(w)) return !!next && (OBJECT_WORDS.has(next) || firstNames.has(next));
    return true;
  };
  if (isVerb(words[0], words[1])) return true;
  if (words[1] === 'and' && isVerb(words[2], words[3])) return true;
  return false;
}

const NOUNISH = new Set(['email', 'e-mail', 'share', 'forward']);
const OBJECT_WORDS = new Set(['the', 'a', 'an', 'my', 'our', 'his', 'her', 'their', 'him', 'them', 'it', 'this', 'that', 'these', 'those', 'back', 'out', 'over', 'round', 'across', 'everyone', 'team', 'all', 'with', 'to']);

// ── Pure: dates ──────────────────────────────────────────────────────────────

/** tasks.created_at is SQLite's UTC 'YYYY-MM-DD HH:MM:SS'. */
function createdMs(task) {
  const s = String((task && (task.created_at || task.createdAt)) || '');
  if (!s) return NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

function londonDayOf(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function dayLabel(input) {
  if (!input) return null;
  const s = String(input);
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T12:00:00Z`) : Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
}

// ── Pure: tokens ─────────────────────────────────────────────────────────────

// People's names, and the communication verbs themselves: "Send …" in a task and
// "Sent: …" in a subject share a word that says nothing about WHAT was sent.
const VERB_WORDS = ['send', 'sent', 'email', 'reply', 'respond', 'chase', 'share', 'forward', 'confirm', 'tell', 'inform', 'follow', 'update', 're', 'fw', 'fwd'];
function nameTokens(people) {
  const out = new Set(['nick', 'nicholas', 'ward']);
  for (const v of VERB_WORDS) for (const t of dd().tokenize(v)) out.add(t);
  for (const p of people || []) for (const t of dd().tokenize(p.name || '')) out.add(t);
  return out;
}

function contentTokens(text, exclude) {
  const out = new Set();
  for (const t of dd().tokenize(text || '')) if (!exclude || !exclude.has(t)) out.add(t);
  return out;
}

/** Context built once per pass: IDF over the task pool + who people are. */
function buildContext(allTasks, people = []) {
  const sets = (allTasks || []).map((t) => dd().tokenize(t.text || ''));
  const idf = dd().buildIdf(sets);
  const n = Math.max(sets.length, 1);
  const distinctIdf = Math.log((n + 1) / (Math.max(1, Math.floor(n * DISTINCT_SHARE)) + 0.5));
  const names = nameTokens(people);
  const byEmail = new Map();
  for (const p of people || []) for (const e of p.emails || []) byEmail.set(String(e).toLowerCase(), p.name);
  const firstNames = new Set((people || []).map((p) => String(p.name || '').split(/\s+/)[0].toLowerCase()).filter(Boolean));
  return { idf, distinctIdf, names, people: people || [], byEmail, firstNames };
}

/** People the task NAMES: a full name, or a first name exactly one person carries. */
function peopleNamedIn(text, people) {
  const s = ` ${String(text || '').toLowerCase().replace(/[’'`]s\b/g, '').replace(/[^a-z\- ]+/g, ' ')} `;
  const firsts = new Map();
  for (const p of people || []) {
    const first = String(p.name || '').split(/\s+/)[0].toLowerCase();
    if (first) firsts.set(first, (firsts.get(first) || 0) + 1);
  }
  const out = [];
  for (const p of people || []) {
    const full = String(p.name || '').toLowerCase().trim();
    const first = full.split(/\s+/)[0];
    if (!full) continue;
    if (s.includes(` ${full} `) || (first && firsts.get(first) === 1 && first.length > 2 && s.includes(` ${first} `))) out.push(p);
  }
  return out;
}

// ── Pure: the four judges ────────────────────────────────────────────────────

function hashRef(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

/**
 * One sent message against one task. PURE. Returns evidence or null.
 * msg: { id, subject, to[], cc[], sentAt }.  ctx: buildContext(); self: Set of Nick's addresses.
 */
function judgeSentEmail(task, msg, ctx, { self = new Set(), automated = null } = {}) {
  if (!task || !msg || !ctx) return null;
  if (!isCommunicationTask(task.text, ctx)) return null;
  const created = createdMs(task);
  const sent = Date.parse(msg.sentAt || '');
  if (!Number.isFinite(created) || !Number.isFinite(sent) || sent <= created) return null;
  const subject = String(msg.subject || '');
  const auto = automated || require('./progress-evidence').AUTOMATED_SUBJECT;
  if (auto.test(subject)) return null;
  const recipients = [...(msg.to || []), ...(msg.cc || [])].map((a) => String(a).toLowerCase()).filter((a) => !self.has(a));
  if (!recipients.length) return null; // a note to himself is not doing it
  const named = peopleNamedIn(task.text, ctx.people);
  const namedEmails = new Set(named.flatMap((p) => (p.emails || []).map((e) => String(e).toLowerCase())));
  let to = null;
  if (namedEmails.size) {
    to = recipients.find((a) => namedEmails.has(a)) || null;
    if (!to) return null; // the task names who it is for, and this did not go to them
  }
  const a = contentTokens(task.text, ctx.names);
  const b = contentTokens(subject, ctx.names);
  const shared = [...a].filter((t) => b.has(t));
  const distinct = shared.filter((t) => (ctx.idf.get(t) ?? Infinity) >= ctx.distinctIdf);
  if (distinct.length < MIN_DISTINCT_SHARED) return null;
  let taskWeight = 0; let sharedWeight = 0;
  for (const t of a) taskWeight += ctx.idf.get(t) ?? 1;
  for (const t of shared) sharedWeight += ctx.idf.get(t) ?? 1;
  const coverage = taskWeight > 0 ? sharedWeight / taskWeight : 0;
  if (coverage < MIN_EMAIL_COVERAGE) return null;
  const recipient = to || recipients[0];
  const who = ctx.byEmail.get(recipient) || recipient;
  const day = dayLabel(msg.sentAt);
  return {
    kind: 'sent-email', rule: RULES['sent-email'],
    key: `sent-email:${hashRef(msg.id || `${subject}|${msg.sentAt}`)}`,
    at: new Date(sent).toISOString(),
    say: `Sent “${subject.slice(0, 120)}” to ${who}${day ? `, ${day}` : ''}`,
    detail: { subject: subject.slice(0, 160), to: who, shared: distinct, coverage: Number(coverage.toFixed(2)) },
  };
}

const TICKED = /^\s*[-*+]\s*\[[xX]\]\s*(.*)$/;
const MARKER = /<!--\s*task:(\d+)\s*-->|\(\s*task\s*#(\d+)\s*\)/i;

/** Strip what a daily line carries that is not its words: tags, markers, time ranges. */
function cleanLine(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\(\s*task\s*#\d+\s*\)/gi, ' ')
    .replace(/\s+[—–-]\s+\d{1,2}[:.]\d{2}\s+block\b/gi, ' ')
    .replace(/(^|\s)#[\w-]+/g, ' ')
    .replace(/\(\s*\d{1,2}[:.]?\d{0,2}\s*[–-]\s*\d{1,2}[:.]?\d{0,2}\s*\)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * One ticked daily-note line against one task. PURE.
 * line: { date: 'YYYY-MM-DD', path, lineNo, text } (text = the raw line).
 */
function judgeDailyTick(task, line, ctx) {
  if (!task || !line || !ctx) return null;
  const m = TICKED.exec(String(line.text || ''));
  if (!m) return null;
  const created = createdMs(task);
  if (!Number.isFinite(created) || !/^\d{4}-\d{2}-\d{2}$/.test(String(line.date || ''))) return null;
  if (line.date < londonDayOf(created)) return null; // ticked before the task existed: a different thing
  const words = cleanLine(m[1]);
  const marker = MARKER.exec(m[1]);
  let basis;
  if (marker) {
    if (Number(marker[1] || marker[2]) !== Number(task.id)) return null;
    basis = 'marker';
  } else {
    const r = dd().scorePair(dd().tokenize(task.text || ''), dd().tokenize(words), ctx.idf);
    if (r.shared.length < 2 || r.score < TICK_SCORE) return null;
    basis = 'wording';
  }
  if (!words) return null;
  const day = dayLabel(line.date);
  return {
    kind: 'daily-tick', rule: RULES['daily-tick'],
    key: `daily-tick:${line.path}#${line.lineNo}`,
    at: `${line.date}T12:00:00.000Z`,
    say: `Ticked in your daily note${day ? `, ${day}` : ''}: “${words.slice(0, 120)}”`,
    detail: { basis, path: line.path, line: line.lineNo },
  };
}

/** The linked Microsoft task is complete. source: { system, status, completed_at, removed }. */
function judgeMsComplete(task, source) {
  if (!task || !task.ms_id || !source) return null;
  if (source.status !== 'completed' || Number(source.removed) === 1) return null;
  const board = source.system === 'ms-todo' ? 'To Do' : 'Planner';
  const day = dayLabel(source.completed_at);
  return {
    kind: 'ms-complete', rule: RULES['ms-complete'],
    key: `ms-complete:${hashRef(`${task.ms_id}|${source.completed_at || ''}`)}`,
    at: source.completed_at || null,
    say: `Marked complete in ${board}${day ? ` on ${day}` : ''}`,
    detail: { board },
  };
}

/** A ticket the task names is resolved. issue: mapAssignedIssue shape. */
function judgeJira(task, issue) {
  if (!task || !issue || issue.resolved !== true) return null;
  return {
    kind: 'jira-resolved', rule: RULES['jira-resolved'],
    key: `jira-resolved:${issue.key}:${hashRef(`${issue.status}|${issue.updated || ''}`)}`,
    at: issue.updated || null,
    say: `${issue.key} is ${issue.status || 'resolved'} in Jira`,
    detail: { ticket: issue.key, status: issue.status || null },
  };
}

/** Recurring tasks come back by design; done-evidence for one occurrence says nothing about the next. */
function eligible(task) {
  if (!task) return false;
  if (!['open', 'in-progress'].includes(task.status)) return false;
  if (task.recurrence_json) return false;
  return true;
}

/**
 * Compose every task's evidence. PURE. inputs are already-read sources;
 * a source that is `null` was unreadable (and its evidence comes from `carry`).
 */
function compose({ tasks, allTasks = tasks, people = [], self = [], sent = null, ticks = null,
  msSources = null, jira = null, jiraKeyFor = () => null, carry = {} }) {
  const ctx = buildContext(allTasks, people);
  const selfSet = new Set((self || []).map((e) => String(e).toLowerCase()));
  const items = [];
  for (const t of tasks || []) {
    if (!eligible(t)) continue;
    const ev = [];
    if (sent) for (const m of sent) { const r = judgeSentEmail(t, m, ctx, { self: selfSet }); if (r) ev.push(r); }
    else for (const e of (carry[t.id] || []).filter((x) => x.kind === 'sent-email')) ev.push(e);
    if (ticks) for (const l of ticks) { const r = judgeDailyTick(t, l, ctx); if (r) ev.push(r); }
    else for (const e of (carry[t.id] || []).filter((x) => x.kind === 'daily-tick')) ev.push(e);
    if (t.ms_id) {
      if (msSources) { const r = judgeMsComplete(t, msSources.get(t.ms_id)); if (r) ev.push(r); }
      else for (const e of (carry[t.id] || []).filter((x) => x.kind === 'ms-complete')) ev.push(e);
    }
    const key = jiraKeyFor(t);
    if (key) {
      if (jira) { const r = judgeJira(t, jira.get(key)); if (r) ev.push(r); }
      else for (const e of (carry[t.id] || []).filter((x) => x.kind === 'jira-resolved')) ev.push(e);
    }
    if (!ev.length) continue;
    const seen = new Set();
    const uniq = ev.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    items.push({ taskId: t.id, text: t.text, evidence: uniq });
  }
  return items;
}

// ── Readers (I/O) ────────────────────────────────────────────────────────────

function _readJson(key, fallback) {
  try { const raw = db.getState(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function _people() {
  const rows = db.all(`SELECT p.display_name AS name, i.value AS email FROM wm_people p
    LEFT JOIN wm_person_identities i ON i.person_id = p.person_id AND i.kind = 'email'`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) map.set(r.name, { name: r.name, emails: [] });
    if (r.email) map.get(r.name).emails.push(String(r.email).toLowerCase());
  }
  return [...map.values()];
}

function _dailyTicks(vaultRoot, sinceDay) {
  if (!vaultRoot || !path.isAbsolute(vaultRoot)) return { ok: false, why: 'the vault path is not configured' };
  const dir = path.join(vaultRoot, 'Daily');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return { ok: false, why: `daily notes unreadable: ${e.code || e.message}` }; }
  const out = [];
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
    if (!m || m[1] < sinceDay) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    let generated = false;
    lines.forEach((ln, i) => {
      if (/^#{1,6}\s/.test(ln)) generated = /\b(saim|sara)\b.*actions?\b|\b(alerts?|log|activity)\b/i.test(ln);
      if (!generated && TICKED.test(ln)) out.push({ date: m[1], path: `Daily/${f}`, lineNo: i + 1, text: ln });
    });
  }
  return { ok: true, lines: out };
}

/**
 * The scheduled pass: read every source, judge, store. The ONLY writer.
 * deps (tests): fetchSent(sinceIso), selfEmails(), fetchIssueStates(keys), vaultRoot, now.
 */
async function refresh({ now = Date.now(), deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const allTasks = db.all('SELECT id, text, status, created_at, ms_id, ms_source, recurrence_json FROM tasks');
  const tasks = allTasks.filter(eligible);
  const gaps = [];
  const prior = _readJson(STORE_KEY, null);
  const carry = {};
  for (const it of (prior && Array.isArray(prior.items) ? prior.items : [])) carry[it.taskId] = it.evidence || [];

  let people = [];
  try { people = _people(); } catch (e) { gaps.push({ source: 'people', why: `people unreadable: ${e.message}` }); }

  // Sent mail
  let sent = null; let self = [];
  const commTasks = tasks.filter((t) => isCommunicationTask(t.text, buildContext([], people)));
  if (commTasks.length) {
    try {
      self = deps.selfEmails ? await deps.selfEmails() : await (async () => {
        const out = [];
        try { const a = await require('./microsoft').getSignedInAddress(); if (a) out.push(a); } catch { /* unknown */ }
        try { for (const r of db.all(`SELECT value FROM wm_person_identities WHERE kind = 'email' AND person_id = 'person:nick-ward'`)) out.push(r.value); } catch { /* none */ }
        return out;
      })();
      const oldest = Math.min(...commTasks.map(createdMs).filter(Number.isFinite), nowMs);
      const sinceIso = new Date(Math.max(oldest, nowMs - SENT_MAIL_DAYS * 86400000)).toISOString();
      const fetchSent = deps.fetchSent || ((s) => require('./microsoft').fetchSentMail({ sinceIso: s, maxResults: 500 }));
      const r = await fetchSent(sinceIso);
      if (!r || !Array.isArray(r.messages)) gaps.push({ source: 'sent-mail', why: 'Sent Items could not be read (not signed in to Microsoft, or it did not answer)' });
      else {
        sent = r.messages;
        if (r.complete === false) gaps.push({ source: 'sent-mail', why: 'Sent Items was only partly read; older mail was not checked', partial: true });
      }
    } catch (e) { gaps.push({ source: 'sent-mail', why: `Sent Items could not be read: ${e.message}` }); }
  } else sent = [];

  // Daily notes
  let ticks = null;
  const vaultRoot = deps.vaultRoot !== undefined ? deps.vaultRoot : process.env.OBSIDIAN_VAULT_PATH;
  const r = _dailyTicks(vaultRoot, londonDayOf(nowMs - DAILY_DAYS * 86400000));
  if (r.ok) ticks = r.lines; else gaps.push({ source: 'daily-notes', why: r.why });

  // Linked Microsoft tasks
  let msSources = null;
  try {
    msSources = new Map();
    for (const row of db.all(`SELECT system, record_id, status, completed_at, removed FROM wm_task_sources WHERE system IN ('ms-planner','ms-todo')`)) msSources.set(row.record_id, row);
  } catch (e) { msSources = null; gaps.push({ source: 'microsoft-tasks', why: `linked Microsoft tasks unreadable: ${e.message}` }); }

  // Jira tickets a task names (never a Jira-OWNED task — jira-tasks.sync closes those)
  let jira = null; let jiraKeyFor = () => null;
  try {
    const jt = require('./jira-tasks');
    const owned = new Set(Object.values(jt.readLinks() || {}).map(Number));
    const projects = new Set([process.env.JIRA_PROJECT_KEY || 'NT']);
    for (const k of Object.keys(jt.readLinks() || {})) { const pm = /^([A-Z][A-Z0-9]+)-\d+$/.exec(k); if (pm) projects.add(pm[1]); }
    const JK = require('../../shared/jira-key.cjs');
    jiraKeyFor = (t) => {
      if (owned.has(Number(t.id))) return null;
      const hit = JK.ticketFor(t.id, t.text, { links: null, projects: [...projects] });
      return hit ? hit.key : null;
    };
    const keys = [...new Set(tasks.map(jiraKeyFor).filter(Boolean))];
    if (keys.length) {
      const fetchStates = deps.fetchIssueStates || ((k) => require('./jira').fetchIssueStates(k));
      const res = await fetchStates(keys);
      if (!res || !Array.isArray(res.issues)) gaps.push({ source: 'jira', why: 'Jira could not be asked about the tickets tasks name' });
      else jira = new Map(res.issues.map((i) => [i.key, i]));
    } else jira = new Map();
  } catch (e) { gaps.push({ source: 'jira', why: `Jira unreadable: ${e.message}` }); }

  const items = compose({ tasks, allTasks, people, self, sent, ticks, msSources, jira, jiraKeyFor, carry });

  // Prune "not yet" entries for tasks that are no longer open.
  const notYet = _readJson(NOT_YET_KEY, {});
  const openIds = new Set(tasks.map((t) => String(t.id)));
  let pruned = false;
  for (const id of Object.keys(notYet)) if (!openIds.has(String(id))) { delete notYet[id]; pruned = true; }
  if (pruned) db.setState(NOT_YET_KEY, JSON.stringify(notYet));

  const store = { at: new Date(nowMs).toISOString(), rules: RULES, items, gaps,
    considered: tasks.length, communicationTasks: commTasks.length };
  db.setState(STORE_KEY, JSON.stringify(store));
  return { ok: true, considered: tasks.length, offered: items.length, gaps };
}

/** What the screens show. Writes nothing. */
function read({ taskId = null } = {}) {
  const store = _readJson(STORE_KEY, null);
  if (!store) return { ok: true, known: false, why: 'NEURO has not looked for evidence yet', items: [], count: 0, gaps: [], rules: RULES };
  const notYet = _readJson(NOT_YET_KEY, {});
  const items = [];
  for (const it of store.items || []) {
    if (taskId != null && Number(it.taskId) !== Number(taskId)) continue;
    const row = db.getTaskRow ? db.getTaskRow(Number(it.taskId)) : db.get('SELECT * FROM tasks WHERE id = ?', [it.taskId]);
    if (!row || !['open', 'in-progress'].includes(row.status)) continue; // closed since the pass
    const hidden = new Set(notYet[it.taskId] || []);
    const evidence = (it.evidence || []).filter((e) => !hidden.has(e.key));
    if (!evidence.length) continue;
    items.push({ taskId: Number(it.taskId), text: row.text, evidence, say: evidence[0].say, more: evidence.length - 1 });
  }
  return { ok: true, known: true, at: store.at, items, count: items.length, gaps: store.gaps || [], rules: RULES };
}

/** "Not yet": suppress the evidence currently offered for a task (or one key). */
function notYet(taskId, { key = null } = {}) {
  const id = Number(taskId);
  const current = read({ taskId: id }).items[0];
  if (!current) return { ok: false, status: 404, error: 'Nothing is being offered for that task' };
  const keys = key ? current.evidence.filter((e) => e.key === key).map((e) => e.key) : current.evidence.map((e) => e.key);
  if (!keys.length) return { ok: false, status: 404, error: 'That evidence is not being offered for this task' };
  const store = _readJson(NOT_YET_KEY, {});
  store[id] = [...new Set([...(store[id] || []), ...keys])];
  db.setState(NOT_YET_KEY, JSON.stringify(store));
  return { ok: true, suppressed: keys.length };
}

module.exports = {
  RULES, STORE_KEY, NOT_YET_KEY, TICK_SCORE, DISTINCT_SHARE, MIN_EMAIL_COVERAGE,
  isCommunicationTask, createdMs, dayLabel, cleanLine, peopleNamedIn, buildContext,
  judgeSentEmail, judgeDailyTick, judgeMsComplete, judgeJira, eligible, compose,
  refresh, read, notYet,
};
