'use strict';

/**
 * Performance evidence feed (29 Oct 2026) — what NEURO can show about Nick's
 * own work in a date window, for VANTAGE's Performance Evidence section.
 *
 * READ-ONLY, and it JUDGES NOTHING. Which SFIA skill an item bears on, and
 * whether it counts, is VANTAGE's model's proposal and then Nick's decision.
 * This only says what happened, when, and where it is recorded.
 *
 * Counter-evidence is included on purpose (Nick, 29 Oct 2026: "literally
 * everything"): a work task left open past its due date, and one finished
 * after it, are items too. They carry a `hint` of 'against', which is a
 * statement about the item's shape, not a verdict — a set date can be a plan
 * rather than a promise, and the task's `origin` travels with it so VANTAGE can
 * tell a commitment from Nick's own stretch goal.
 *
 * Every source reports whether it answered. A source that could not be read is
 * a named gap, never an empty list — "no meetings that week" and "could not read
 * the vault" lead to different conclusions about a man's performance.
 *
 * Personal-domain tasks are never included. Work only.
 */

const fs = require('fs');
const path = require('path');

const MAX_WINDOW_DAYS = 31;
const MAX_ITEMS = 1500;
const EXCERPT = 700;

const isDateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Validate a window. Refused, never clamped. Pure. */
function parseWindow(from, to) {
  if (!isDateKey(from)) return { error: 'from must be YYYY-MM-DD' };
  if (!isDateKey(to)) return { error: 'to must be YYYY-MM-DD' };
  if (to < from) return { error: 'to is before from' };
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_WINDOW_DAYS) return { error: `window is ${days} days; at most ${MAX_WINDOW_DAYS}` };
  return { from, to, days };
}

/** Local date key — never toISOString (the Pi may run UTC). */
function localKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const clip = (s, n = EXCERPT) => {
  const t = String(s || '').replace(/\r/g, '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** SQLite CURRENT_TIMESTAMP is UTC with no zone. Pure. */
function sqliteToIso(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

function fm(content) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  if (!c.startsWith('---\n')) return { meta: {}, body: c };
  const end = c.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: c };
  const meta = {};
  for (const line of c.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: c.slice(end + 4) };
}

// ── sources ─────────────────────────────────────────────────────────────────

function tasksOverdue(db, w, today) {
  // Open work tasks whose due date fell inside the window and has passed.
  const until = w.to < today ? w.to : prevDay(today);
  if (until < w.from) return [];
  return db.prepare(`
    SELECT id, text, due_date, origin, origin_proposed, source, status
      FROM tasks
     WHERE status IN ('open','in-progress') AND domain = 'work'
       AND due_date IS NOT NULL AND substr(due_date,1,10) BETWEEN ? AND ?
  `).all(w.from, until).map((t) => ({
    id: `task-overdue:${t.id}:${String(t.due_date).slice(0, 10)}`,
    source: 'tasks', kind: 'task-overdue', hint: null,
    at: `${String(t.due_date).slice(0, 10)}T17:00:00`,
    title: t.text,
    detail: `Due ${String(t.due_date).slice(0, 10)}; still open ${daysBetween(t.due_date, today)} day(s) on. Origin: ${t.origin ? `${t.origin}${t.origin_proposed ? ' (inferred)' : ''}` : 'not classified'}.`,
    ref: `neuro:task:${t.id}`,
  }));
}

/** Whole days from one date key to another. Pure. */
function daysBetween(a, b) {
  return Math.round((Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`)) / 86400000);
}

function tasksLate(db, w) {
  return db.prepare(`
    SELECT id, text, due_date, completed_at, origin, origin_proposed
      FROM tasks
     WHERE status = 'done' AND domain = 'work' AND due_date IS NOT NULL AND completed_at IS NOT NULL
       AND substr(completed_at,1,10) BETWEEN ? AND ?
       AND substr(completed_at,1,10) > substr(due_date,1,10)
  `).all(w.from, w.to).map((t) => ({
    id: `task-late:${t.id}`,
    source: 'tasks', kind: 'task-late', hint: null,
    at: sqliteToIso(t.completed_at),
    title: t.text,
    detail: `Done ${String(t.completed_at).slice(0, 10)} (due ${String(t.due_date).slice(0, 10)}, ${daysBetween(t.due_date, t.completed_at)} day(s) later). Origin: ${t.origin ? `${t.origin}${t.origin_proposed ? ' (inferred)' : ''}` : 'not classified'}.`,
    ref: `neuro:task:${t.id}`,
  }));
}

/**
 * Wins, minus what another source here already carries or what is not Nick's work:
 *  - task completions (`activity`/`task_done`, `task`): the ledger does not know a
 *    task's DOMAIN, and live on 29 Oct it carried "Book my car in for its MOT";
 *    work tasks come from the tasks table instead (`tasksDone`);
 *  - `meeting` and `reply`: the meetings and replies sources carry them richer;
 *  - `ritual` ("Standup done", daily) and NEURO's own drafted replies.
 * Measured on the live feed 20-28 Oct 2026: 83 wins, 71 of them one of these.
 */
const WIN_EXCLUDED_SOURCES = new Set(['task', 'meeting', 'reply', 'ritual']);
const WIN_EXCLUDED_KINDS = new Set(['task_done', 'draft_reply']);

function tasksDone(db, w) {
  return db.prepare(`
    SELECT id, text, due_date, completed_at, origin, origin_proposed
      FROM tasks
     WHERE status = 'done' AND domain = 'work' AND completed_at IS NOT NULL
       AND substr(completed_at,1,10) BETWEEN ? AND ?
       AND (due_date IS NULL OR substr(completed_at,1,10) <= substr(due_date,1,10))
  `).all(w.from, w.to).map((t) => ({
    id: `task-done:${t.id}`,
    source: 'tasks', kind: 'task-done', hint: 'for',
    at: sqliteToIso(t.completed_at),
    title: t.text,
    detail: `Done ${String(t.completed_at).slice(0, 10)}${t.due_date ? `, on or before its due date ${String(t.due_date).slice(0, 10)}` : ''}. Origin: ${t.origin ? `${t.origin}${t.origin_proposed ? ' (inferred)' : ''}` : 'not classified'}.`,
    ref: `neuro:task:${t.id}`,
  }));
}

function winsIn(db, w) {
  return db.prepare(`
    SELECT id, date_key, occurred_at, source, kind, text, evidence, count
      FROM wins WHERE date_key BETWEEN ? AND ? ORDER BY occurred_at
  `).all(w.from, w.to).filter((r) => !WIN_EXCLUDED_SOURCES.has(r.source) && !WIN_EXCLUDED_KINDS.has(r.kind)).map((r) => ({
    id: `win:${r.id}`,
    source: 'wins', kind: `win:${r.source}`, hint: 'for',
    at: r.occurred_at,
    title: r.count > 1 ? `${r.text} (×${r.count})` : r.text,
    detail: `Recorded by NEURO's wins ledger (${r.source}${r.kind ? ` / ${r.kind}` : ''}).`,
    ref: r.evidence ? `${r.source}:${r.evidence}` : null,
  }));
}

function repliesSent(db, w) {
  return db.prepare(`
    SELECT id, subject, from_name, recipients, body, sent_at
      FROM sent_replies WHERE substr(sent_at,1,10) BETWEEN ? AND ?
  `).all(w.from, w.to).map((r) => {
    let to = [];
    try { to = (JSON.parse(r.recipients || '[]') || []).map((x) => x.name || x.email).filter(Boolean); } catch { /* none */ }
    return {
      id: `reply:${r.id}`,
      source: 'email', kind: 'reply-sent', hint: null,
      at: r.sent_at,
      title: `Replied: ${r.subject || '(no subject)'}`,
      detail: `${to.length ? `To ${to.slice(0, 4).join(', ')}. ` : ''}${clip(r.body, 500)}`,
      _screenText: `${r.subject || ''}
${r.body || ''}`,
      ref: null,
    };
  });
}

function managementLog(db, w) {
  return db.prepare(`
    SELECT id, entry_date, logged_at, type, person, summary, action, status
      FROM management_log WHERE substr(entry_date,1,10) BETWEEN ? AND ?
  `).all(w.from, w.to).map((r) => ({
    id: `mlog:${r.id}`,
    source: 'management-log', kind: `mlog:${r.type}`, hint: null,
    at: `${String(r.entry_date).slice(0, 10)}T12:00:00`,
    title: `${r.type}${r.person ? ` with ${r.person}` : ''}: ${clip(r.summary, 120)}`,
    detail: clip(`${r.summary}${r.action ? `\nAction: ${r.action}` : ''}\nStatus: ${r.status}. Logged ${String(r.logged_at).slice(0, 10)}.`),
    ref: `neuro:management-log:${r.id}`,
  }));
}

function decisions(db, w) {
  return db.prepare(`
    SELECT id, decision_text, created_at FROM decisions
     WHERE substr(created_at,1,10) BETWEEN ? AND ?
  `).all(w.from, w.to).map((r) => ({
    id: `decision:${r.id}`,
    source: 'decisions', kind: 'decision', hint: null,
    at: sqliteToIso(r.created_at),
    title: `Decision: ${clip(r.decision_text, 140)}`,
    detail: clip(r.decision_text),
    ref: null,
  }));
}

/**
 * The part of a meeting note worth reading: from its summary-ish section if it
 * has one, without the Plaud boilerplate (title echo, "Recording", Plaud ID).
 */
function meetingText(body) {
  const plain = String(body || '')
    .replace(/!?\[[^\]]*\]\((?:plaud|https?):[^)]*\)/g, '')        // Plaud cards and image/link markup
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/\*\*([^*]+)\*\*/g, '$1');
  const at = plain.search(/^#{1,4}\s*(Summary|Overview|Meeting Notes|Key Points|Discussion|Conclusions?)\b/im);
  const from = at >= 0 ? plain.slice(at) : plain;
  return from.split('\n')
    // Plaud's recording block (Created / Started / Duration / Device) sits UNDER
    // the first '# Summary' heading, so it led every excerpt (30 Oct 2026).
    .filter((l) => !/Plaud ID|^\s*Recording\b|^\s*Transcript:|^\s*-?\s*(Created|Started|Duration|Device)\s*:|^\s*(Date|Location):.*(Calculated|Insert)/i.test(l))
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter((l) => l && !/^(Summary|Overview|Meeting Notes)$/i.test(l))
    .join('\n');
}

/**
 * PURE. Does this item concern someone's health or personal life, or is it a
 * people conversation by its nature? (29 Oct 2026)
 *
 * employmentScreen needs a NAMED colleague on 2+ lines; a 1-2-1 write-up that
 * says "the employee" throughout sailed past it and put a team member's medical
 * details into VANTAGE. So two blunter rules, erring towards withholding:
 *  - a 1-2-1 / HR-type meeting is withheld by its TITLE, whatever it says;
 *  - any health or personal-circumstance term anywhere withholds the item.
 * A false withhold costs a line of context; a false pass copies someone's
 * private life into another system and a model prompt.
 */
const PEOPLE_MEETING = /\b(1[- ]?(2|to)[- ]?1|one[- ]on[- ]one|1:1|one to one|HR\b|human resources|return to work|RTW|welfare|wellbeing|absence|sickness|disciplinary|grievance|probation|investigation meeting|performance review|appraisal|occupational health|exit interview)\b/i;
const PERSONAL = /\b(medical|medication|medicine|diagnos\w*|surgery|surgical|hospital|GP\b|doctor|dentist|dental|sick(ness)?|ill(ness)?\b|injur\w*|cyst|tumou?r|cancer|pregnan\w*|maternity|paternity|miscarri\w*|bereave\w*|funeral|passed away|mental health|anxiety|depress\w*|stress(ed)? leave|counsell?ing|therapy|therapist|assault\w*|police|divorce|disabilit\w*|fit note|occupational health|OH report|accommodation(s)?|carer|caring responsibilit\w*|childcare|condition)\b/i;

function personalScreen({ title = '', text = '' } = {}) {
  if (PEOPLE_MEETING.test(title)) return { sensitive: true, categories: ['people-meeting'] };
  if (PERSONAL.test(`${title}\n${text}`)) return { sensitive: true, categories: ['personal'] };
  return { sensitive: false, categories: [] };
}

/** Meeting write-ups in Meetings/YYYY/MM for the window. */
function meetings(vaultRoot, w) {
  const out = [];
  const months = new Set();
  for (let d = new Date(`${w.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= w.to; d.setUTCDate(d.getUTCDate() + 1)) {
    months.add(d.toISOString().slice(0, 7));
  }
  for (const ym of months) {
    const dir = path.join(vaultRoot, 'Meetings', ym.slice(0, 4), ym.slice(5, 7));
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const f of files) {
      if (!f.endsWith('.md') || / 2\.md$/.test(f) || /Prep\.md$/i.test(f)) continue;
      const day = (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
      let content;
      try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const { meta, body } = fm(content);
      if (meta.type && !/meeting|transcript/i.test(meta.type)) continue;
      const date = (String(meta.date || meta.start_at || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || day;
      if (!date || date < w.from || date > w.to) continue;
      const text = meetingText(body);
      out.push({
        id: `meeting:${path.posix.join('Meetings', ym.slice(0, 4), ym.slice(5, 7), f)}`,
        source: 'meetings', kind: 'meeting', hint: null,
        at: `${date}T12:00:00`,
        title: `Meeting: ${f.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}\s*[–-]?\s*/, '')}`,
        detail: clip(text, 900),
        _screenText: text,
        ref: `vault:${path.posix.join('Meetings', ym.slice(0, 4), ym.slice(5, 7), f)}`,
      });
    }
  }
  return out;
}

const SOURCES = [
  ['tasks-overdue', (ctx) => tasksOverdue(ctx.db, ctx.w, ctx.today)],
  ['tasks-late', (ctx) => tasksLate(ctx.db, ctx.w)],
  ['tasks-done', (ctx) => tasksDone(ctx.db, ctx.w)],
  ['wins', (ctx) => winsIn(ctx.db, ctx.w)],
  ['replies-sent', (ctx) => repliesSent(ctx.db, ctx.w)],
  ['management-log', (ctx) => managementLog(ctx.db, ctx.w)],
  ['decisions', (ctx) => decisions(ctx.db, ctx.w)],
  ['meetings', (ctx) => {
    if (!ctx.vaultRoot) throw new Error('vault not configured');
    if (!fs.existsSync(path.join(ctx.vaultRoot, 'Meetings'))) throw new Error('Meetings/ not found in the vault');
    return meetings(ctx.vaultRoot, ctx.w);
  }],
  // What others said about Nick's work, read from meetings inside NEURO by
  // perf-feedback.js (the cache only — never a model call on this read path).
  ['feedback', (ctx) => require('./perf-feedback').itemsFor(ctx.w)],
  // Confluence pages Nick wrote or substantially revised (perf-confluence.js;
  // the cache only — read hourly by the scheduler, never on this read path).
  ['confluence', (ctx) => require('./perf-confluence').itemsFor(ctx.w)],
];

/** What the feed deliberately does not carry yet, so nobody reads it as the whole picture. */
const NOT_INCLUDED = [
  'Outlook Sent Items not sent through NEURO (only replies NEURO sent are here)',
  'Jira ticket work and escalations raised (NOVA owns those)',
  'Personal-domain tasks (never — work only)',
  'Microsoft To Do / Planner completions (the wins ledger cannot tell work from personal for those)',
  'SharePoint documents (job descriptions and other files there are not read)',
];

function defaultScreen() {
  const pm = require('./prepared-move');
  let roster;
  try { roster = require('./entities').getRoster(); } catch { roster = null; }
  return ({ sourceTitle, sourceText }) => {
    if (!roster) return { sensitive: true, categories: ['roster-unreadable'] };
    return pm.employmentScreen({ wording: sourceTitle, sourceTitle, sourceText, roster });
  };
}

function prevDay(key) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Candidates for a window. `deps` are injectable for tests.
 * @returns {{ ok, from, to, items, sources:{[name]:{ok,count?,error?}}, truncated, notIncluded }}
 */
function candidates({ from, to } = {}, deps = {}) {
  const w = parseWindow(from, to);
  if (w.error) { const e = new Error(w.error); e.status = 400; throw e; }
  const db = deps.db || require('../db/database').getDb();
  const vaultRoot = deps.vaultRoot !== undefined ? deps.vaultRoot : (process.env.OBSIDIAN_VAULT_PATH || '');
  const today = deps.today || localKey();
  const ctx = { db, w, vaultRoot, today };
  const items = [];
  const sources = {};
  for (const [name, fn] of SOURCES) {
    try {
      const got = fn(ctx);
      sources[name] = { ok: true, count: got.length };
      items.push(...got);
    } catch (e) {
      sources[name] = { ok: false, error: e.message };
    }
  }
  // ⚠ Employment matters are withheld (29 Oct 2026). Found on the first live
  // read: a meeting excerpt described a named colleague's personal situation.
  // That a conversation happened is evidence of how Nick manages; WHAT it was
  // about is the colleague's, and must not be copied into VANTAGE or a model
  // prompt. NEURO's own screen decides (prepared-move.employmentScreen — HR
  // wording, or a note discussing named people's sickness/absence/etc. on 2+
  // lines). A screen that fails withholds rather than passes.
  const screen = deps.screen || defaultScreen();
  for (const it of items) {
    const text = it._screenText || it.detail || '';
    delete it._screenText;
    if (!['meetings', 'email', 'management-log', 'decisions', 'confluence'].includes(it.source)) continue;
    // The blunt personal screen ALWAYS runs, injected screen or not.
    let verdict = personalScreen({ title: it.title, text });
    if (!verdict.sensitive) {
      try { verdict = screen({ sourceTitle: it.title, sourceText: text }); } catch { verdict = { sensitive: true, categories: ['screen-failed'] }; }
    }
    if (verdict.sensitive) {
      it.sensitive = true;
      it.detail = 'Details withheld — this concerns an employee matter. Open it in NEURO to read it.';
    }
  }
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const truncated = items.length > MAX_ITEMS;
  return {
    ok: true, from: w.from, to: w.to,
    items: truncated ? items.slice(-MAX_ITEMS) : items,
    sources, truncated, notIncluded: NOT_INCLUDED,
  };
}

module.exports = { candidates, parseWindow, MAX_WINDOW_DAYS, _internals: { meetings, meetingText, personalScreen, sqliteToIso, fm } };
