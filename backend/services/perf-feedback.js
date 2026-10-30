'use strict';

/**
 * Feedback about Nick, from meetings (30 Oct 2026) — for VANTAGE's Performance
 * Evidence.
 *
 * Nick: "are we fully utilising verbal feedback I'm getting from Chris in
 * meetings that are just me and him?" — no: the feed's privacy screen withholds
 * every 1-2-1 by its title, so what Chris said about Nick's work never reached
 * VANTAGE. This reads meeting notes INSIDE NEURO and carries out only what
 * someone said ABOUT NICK'S WORK — praise, concerns, expectations, requests.
 *
 * Nick's weighting, highest first (his order, 30 Oct 2026):
 *   1 manager-1to1     just Nick and his line manager
 *   2 tech-leadership  Chris and Ricky together / a tech leadership meeting
 *   3 risk             the risk meeting
 *   4 seniors          any meeting with Chris, Ricky or Damon in it
 *   5 other            any other meeting — peers and direct reports count too
 *
 * ⚠ Privacy is enforced HERE, after the model, not left to the prompt:
 *  - a line carrying any health / personal-circumstance term is dropped;
 *  - a line naming any colleague other than the person giving the feedback is
 *    dropped (the giver may be named; Nick may be named);
 *  - a DIRECT REPORT is never named — attributed as "a direct report" — and a
 *    line containing their own name is dropped (Nick's call: lines about him
 *    only, by role, never their name, never anything about them).
 * The note itself never leaves NEURO; only the extracted lines do.
 *
 * Each note is read ONCE per content hash (table perf_feedback), so a re-read
 * costs nothing and an edited note is read again. A failed read is recorded
 * and retried; it is never stored as "no feedback".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TIERS = {
  1: { key: 'manager-1to1', label: '1-2-1 with your line manager' },
  2: { key: 'tech-leadership', label: 'tech leadership meeting' },
  3: { key: 'risk', label: 'risk meeting' },
  4: { key: 'seniors', label: 'meeting with senior leaders' },
  5: { key: 'other', label: 'meeting' },
};
const SENIORS_DEFAULT = ['Chris Middleton', 'Ricky Bostock', 'Damon Bullimore'];
const BACKFILL_DAYS = 400;
const PER_RUN = 12;
const DAILY_DEFAULT = 150;
const PERSONAL = /\b(medical|medication|medicine|diagnos\w*|surgery|surgical|hospital|GP\b|doctor|dentist|dental|sick(ness)?|ill(ness)?\b|injur\w*|cyst|tumou?r|cancer|pregnan\w*|maternity|paternity|miscarri\w*|bereave\w*|funeral|passed away|mental health|anxiety|depress\w*|stress(ed)? leave|counsell?ing|therapy|therapist|assault\w*|police|divorce|disabilit\w*|fit note|occupational health|OH report|accommodation(s)?|carer|caring responsibilit\w*|childcare|condition|wellbeing|welfare|absence|disciplinary|grievance|probation)\b/i;

// First names that are also ordinary words — never treated as naming someone.
const COMMON_WORDS = new Set(['will', 'mark', 'may', 'april', 'june', 'grace', 'joy', 'rose', 'faith', 'bill', 'sky', 'dawn', 'summer', 'chase', 'bob', 'pat', 'sue', 'ray', 'art', 'drew', 'jack', 'frank', 'max', 'rich', 'guy']);

let ready = false;
function db() {
  const d = require('../db/database').getDb();
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS perf_feedback (
      path        TEXT PRIMARY KEY,
      hash        TEXT NOT NULL,
      meeting_day TEXT,
      tier        INTEGER,
      title       TEXT,
      items_json  TEXT,
      error       TEXT,
      read_at     TEXT NOT NULL
    )`);
    ready = true;
  }
  return d;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

function fm(content) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  if (!c.startsWith('---\n')) return { meta: {}, people: [], body: c };
  const end = c.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, people: [], body: c };
  const head = c.slice(4, end);
  const meta = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !/^\s/.test(line)) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  const people = [...head.matchAll(/\[\[(?:People\/)?([^\]|]+)/g)].map((m) => m[1].trim());
  return { meta, people, body: c.slice(end + 4) };
}

/** Everyone in the meeting: frontmatter people ∪ the body's "Participants:" line. Pure. */
function participantsOf(people, body) {
  const out = new Set(people);
  let unnamed = 0;
  const m = String(body || '').match(/^\s*Participants?:\s*(.+)$/im);
  if (m) {
    for (const raw of m[1].split(/[,;]| and /)) {
      const n = raw.replace(/\[\[|\]\]|\*/g, '').trim();
      if (!n) continue;
      if (/^speaker\s*\d+$/i.test(n) || /unknown|\[/i.test(n)) unnamed += 1; else out.add(n);
    }
  }
  return { names: [...out], unnamed };
}

/** Nick's weighting of the setting. Pure. */
function tierOf({ title, names, unnamed }, { manager, seniors, self = 'Nick Ward' }) {
  const others = [...new Map(names.filter((n) => norm(n) !== norm(self)).map((n) => [norm(n), n])).values()];
  const has = (who) => others.some((n) => norm(n) === norm(who) || norm(n).split(' ')[0] === norm(who).split(' ')[0] && norm(who).split(' ').length === 1);
  if (manager && others.length === 1 && has(manager) && !unnamed) return 1;
  if (/\btech(nical)? leadership\b/i.test(title) || (has('Chris Middleton') && has('Ricky Bostock'))) return 2;
  if (/\brisk\b/i.test(title)) return 3;
  if (seniors.some(has)) return 4;
  return 5;
}

/** Plaud boilerplate out; the substance in. Pure. */
function noteText(body) {
  return String(body || '')
    .replace(/!?\[[^\]]*\]\((?:plaud|https?):[^)]*\)/g, '')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .split('\n')
    .filter((l) => !/^\s*-?\s*(Plaud ID|Created|Started|Duration|Device|Transcript)\s*:/i.test(l) && !/^#{1,4}\s*Recording\s*$/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function roleOf(name, ctx) {
  const n = norm(name);
  if (!n || /^\s*(speaker\s*\d*|unknown)\s*$/i.test(String(name))) return 'unknown';
  if (ctx.self && n === norm(ctx.self)) return 'self';
  if (ctx.manager && n === norm(ctx.manager)) return 'manager';
  if (ctx.directReports.some((d) => norm(d) === n)) return 'direct-report';
  if (ctx.seniors.some((s) => norm(s) === n)) return 'senior';
  return 'colleague';
}

/**
 * The privacy and shape guard over the model's answer. Pure.
 * @returns {Array<{from, role, stance, said, about}>}
 */
function guardItems(raw, ctx) {
  const list = Array.isArray(raw?.feedback) ? raw.feedback : [];
  const out = [];
  const colleagues = ctx.roster.filter((n) => norm(n) !== norm(ctx.self));
  const first = (n) => norm(n).split(' ')[0];
  const firstCount = new Map();
  for (const c of colleagues) firstCount.set(first(c), (firstCount.get(first(c)) || 0) + 1);
  const word = (w, text) => new RegExp(`(^| )${w}( |$)`).test(text);
  for (const f of list) {
    const giver = String(f?.from || '').trim();
    const said = String(f?.said || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (said.length < 12) continue;
    const about = String(f?.about || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null;
    const all = norm(`${said} ${about || ''}`);
    if (PERSONAL.test(`${said} ${about || ''}`)) continue;
    // Any OTHER colleague named → dropped (the line is about them too). A full
    // name always counts; a first name only when exactly one colleague has it,
    // it is not the giver's own first name, and it is not an ordinary word.
    const named = colleagues.some((c) => {
      if (norm(c) === norm(giver)) return false;
      if (word(norm(c), all)) return true;
      const fn = first(c);
      return fn.length > 2 && firstCount.get(fn) === 1 && fn !== first(giver) && !COMMON_WORDS.has(fn) && word(fn, all);
    });
    if (named) continue;
    const role = roleOf(giver, ctx);
    // Nick's own words are not feedback about him.
    if (role === 'self') continue;
    if (role === 'direct-report' && word(first(giver), all)) continue;
    const stance = ['for', 'against'].includes(f?.stance) ? f.stance : null;
    out.push({ from: role === 'direct-report' || role === 'unknown' ? null : (giver || null), role, stance, said, about });
    if (out.length >= 12) break;
  }
  return out;
}

const PROMPT = `You extract FEEDBACK ABOUT NICK WARD (Head of Technical Support) from one meeting's notes. Answer ONLY with JSON:
{"feedback":[{"from":"Chris Middleton","said":"...","stance":"for|against|neutral","about":"what work it concerns"}]}
WHAT COUNTS
- Something a person in the meeting said that judges, praises, criticises, questions or sets an expectation about NICK'S OWN work, decisions, behaviour or management: "Chris was pleased with the KPI pack", "Ricky wants Nick to escalate earlier", "a team member said Nick's coaching on calls helped".
- A request for Nick to change or improve something counts (stance against or neutral). Praise is "for".
WHAT DOES NOT COUNT
- Tasks or action items handed to Nick ("Nick to do X", "Nick is tasked with Y") — unless the person also judged how he is doing.
- Anything Nick himself said. Status updates, general discussion, decisions not about Nick's performance.
- Anything about another person's performance, health, personal life or circumstances — never include it, even in passing.
RULES
- said: one or two sentences, in plain words, about Nick's work only. Name nobody except the person giving the feedback; never mention any other colleague.
- from: the full name of who said it, exactly as listed in PEOPLE IN THE MEETING; "unknown" if the notes do not say who.
- Only what the notes support. If there is no feedback about Nick, answer {"feedback":[]}.`;

function context() {
  const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
  let roster = [];
  try { roster = [...(require('./entities').getRoster().full || [])]; } catch {}
  if (!roster.length) {
    try { roster = fs.readdirSync(path.join(vaultRoot, 'People')).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.replace(/\.md$/, '')); } catch {}
  }
  let directReports = [];
  // Anyone who has ever reported to Nick — a former report's 1-2-1 is still theirs.
  try { directReports = require('./team-roster').readPeople().filter((p) => p.directReport).map((p) => p.name); } catch {}
  let manager = 'Chris Middleton';
  try {
    const me = fs.readFileSync(path.join(vaultRoot, 'People', 'Nick Ward.md'), 'utf8');
    const m = me.match(/^manager:\s*"?\[\[(?:People\/)?([^\]|]+)/m);
    if (m) manager = m[1].trim();
  } catch {}
  const seniors = String(process.env.PERF_FEEDBACK_SENIORS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    vaultRoot, roster: [...new Set([...roster, ...SENIORS_DEFAULT])], directReports, manager,
    seniors: seniors.length ? seniors : SENIORS_DEFAULT, self: 'Nick Ward',
  };
}

/** Every meeting note under Meetings/ (not transcripts, twins or prep). */
function listNotes(vaultRoot, sinceDay) {
  const root = path.join(vaultRoot, 'Meetings');
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!/^_|transcripts?/i.test(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!e.name.endsWith('.md') || / 2\.md$/.test(e.name) || /prep\.md$/i.test(e.name) || e.name.startsWith('_')) continue;
      const day = (e.name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
      if (day && day < sinceDay) continue;
      out.push({ abs: path.join(dir, e.name), rel: path.relative(vaultRoot, path.join(dir, e.name)).split(path.sep).join('/'), day });
    }
  };
  walk(root);
  return out;
}

function readNote(n, ctx) {
  const content = fs.readFileSync(n.abs, 'utf8');
  const { meta, people, body } = fm(content);
  if (meta.type && !/meeting|transcript/i.test(meta.type)) return null;
  const day = (String(meta.date || meta.start_at || '').match(/^\d{4}-\d{2}-\d{2}/) || [])[0] || n.day;
  const title = String(meta.title || path.basename(n.abs, '.md').replace(/^\d{4}-\d{2}-\d{2}\s*[–-]?\s*/, ''));
  const p = participantsOf(people, body);
  const tier = tierOf({ title, ...p }, ctx);
  return { content, meta, body, day, title, tier, participants: p, hash: crypto.createHash('sha1').update(content).digest('hex') };
}

async function extractOne(n, note, ctx, deps = {}) {
  let text = noteText(note.body).slice(0, 24000);
  // A 1-2-1 with the line manager: the transcript too — it is where what he
  // actually said lives. Bounded; never leaves NEURO except as the guarded lines.
  if (note.tier === 1 && note.meta.transcript_path) {
    try {
      const t = fs.readFileSync(path.join(ctx.vaultRoot, `${note.meta.transcript_path.replace(/\.md$/, '')}.md`), 'utf8');
      text += `\n\nTRANSCRIPT (may be partly unattributed):\n${noteText(fm(t).body).slice(0, 40000)}`;
    } catch {}
  }
  const people = note.participants.names.map((nm) => `${nm} (${roleOf(nm, ctx) === 'direct-report' ? 'Nick\'s direct report' : roleOf(nm, ctx) === 'manager' ? 'Nick\'s line manager' : roleOf(nm, ctx)})`).join('; ');
  const prompt = `${PROMPT}\n\nMEETING: ${note.title} (${note.day || 'undated'})\nPEOPLE IN THE MEETING: ${people || 'not recorded'}\n\nNOTES:\n${text}`;
  const run = deps.run || ((p) => require('./ai-routing').runTask('perf_feedback_extract', { prompt: p, maxTokens: 1500 }, { forceCloud: true, timeout: 120000 }));
  const r = await run(prompt);
  if (!r || !r.text) throw new Error((r && r.reason) || 'no AI provider answered');
  let j;
  const t = String(r.text).trim().replace(/^```[a-z]*\s*\n?|\n?```\s*$/g, '');
  try { j = JSON.parse(t); } catch { const a = t.indexOf('{'); const b = t.lastIndexOf('}'); j = JSON.parse(t.slice(a, b + 1)); }
  return guardItems(j, ctx);
}

function todayKey() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

/** One pass: read up to PER_RUN unread notes, highest tier first, newest first. */
async function run({ limit = PER_RUN, deps = {} } = {}) {
  const ctx = deps.ctx || context();
  if (!ctx.vaultRoot) return { ok: false, error: 'vault not configured' };
  const d = db();
  const dailyCap = Number(process.env.PERF_FEEDBACK_DAILY) || DAILY_DEFAULT;
  const readToday = d.prepare("SELECT count(*) n FROM perf_feedback WHERE substr(read_at,1,10) = ?").get(todayKey()).n;
  const room = Math.max(0, Math.min(limit, dailyCap - readToday));
  if (!room) return { ok: true, read: 0, stopped: 'daily-cap' };
  const since = new Date(Date.now() - BACKFILL_DAYS * 864e5).toISOString().slice(0, 10);
  const known = new Map(d.prepare('SELECT path, hash, error FROM perf_feedback').all().map((r) => [r.path, r]));
  const todo = [];
  for (const n of listNotes(ctx.vaultRoot, since)) {
    let note;
    try { note = readNote(n, ctx); } catch { continue; }
    if (!note) continue;
    const k = known.get(n.rel);
    if (k && k.hash === note.hash && !k.error) continue;
    todo.push({ n, note });
  }
  todo.sort((a, b) => a.note.tier - b.note.tier || String(b.note.day || '').localeCompare(String(a.note.day || '')));
  const up = d.prepare(`INSERT INTO perf_feedback (path, hash, meeting_day, tier, title, items_json, error, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, meeting_day = excluded.meeting_day,
    tier = excluded.tier, title = excluded.title, items_json = excluded.items_json, error = excluded.error, read_at = excluded.read_at`);
  let read = 0; let found = 0; let failed = 0;
  for (const { n, note } of todo.slice(0, room)) {
    try {
      const items = await extractOne(n, note, ctx, deps);
      // A note's attendee list can be short (22 May: frontmatter said Chris and
      // Nick; Ricky spoke). Anyone named who gave feedback was in the room.
      const givers = items.map((i) => i.from).filter(Boolean);
      const tier = givers.length
        ? Math.max(note.tier, tierOf({ title: note.title, names: [...note.participants.names, ...givers], unnamed: note.participants.unnamed }, ctx))
        : note.tier;
      up.run(n.rel, note.hash, note.day, tier, note.title, JSON.stringify(items), null, new Date().toISOString());
      found += items.length;
    } catch (e) {
      up.run(n.rel, note.hash, note.day, note.tier, note.title, null, String(e.message).slice(0, 300), new Date().toISOString());
      failed += 1;
    }
    read += 1;
  }
  return { ok: true, read, found, failed, remaining: Math.max(0, todo.length - read) };
}

function status() {
  const d = db();
  const r = d.prepare('SELECT count(*) n, sum(error IS NOT NULL) failed, sum(json_array_length(coalesce(items_json, \'[]\'))) items FROM perf_feedback').get();
  return { notesRead: r.n, failed: r.failed || 0, feedbackItems: r.items || 0 };
}

/** Feed items for a window (read-only: the cache, never a model call). */
function itemsFor(w) {
  const rows = db().prepare('SELECT * FROM perf_feedback WHERE meeting_day >= ? AND meeting_day <= ? AND items_json IS NOT NULL').all(w.from, w.to);
  const out = [];
  for (const r of rows) {
    let items = [];
    try { items = JSON.parse(r.items_json); } catch {}
    const tier = TIERS[r.tier] || TIERS[5];
    items.forEach((f, i) => {
      const who = f.role === 'direct-report' ? 'a direct report'
        : f.role === 'manager' ? `${f.from} (your line manager)`
          : f.role === 'senior' ? `${f.from} (senior leader)`
            : f.from ? `${f.from} (colleague)` : 'someone in the meeting';
      out.push({
        id: `feedback:${crypto.createHash('sha1').update(`${r.path}#${i}#${f.said}`).digest('hex').slice(0, 16)}`,
        source: 'feedback', kind: `feedback-t${r.tier}`, hint: f.stance,
        at: `${r.meeting_day}T12:00:00`,
        title: `Feedback from ${who} — ${tier.label} (weight ${r.tier} of 5)`,
        detail: `${f.said}${f.about ? ` (About: ${f.about})` : ''}`,
        ref: `vault:${r.path}`,
      });
    });
  }
  return out;
}

module.exports = { run, status, itemsFor, TIERS, _internals: { participantsOf, tierOf, guardItems, noteText, fm, roleOf } };
