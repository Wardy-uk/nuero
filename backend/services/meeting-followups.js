'use strict';

// Follow-up emails after meetings (1 Nov 2026, agreed with Nick).
//
// When a meeting's PLAUD write-up links to a calendar occurrence with other
// people in it, NEURO either DRAFTS a follow-up email or ASKS whether to:
//
//   - TEAM meeting (at least one of Nick's live direct reports in it — 1-2-1s
//     included) → drafted automatically, one push "Follow-up ready for …";
//   - EXCEPT the daily 10:00 Team Standup (a recurring series at 10:00 whose
//     subject says stand-up) → nothing at all;
//   - every OTHER meeting with others → a prompt ("Draft a follow-up to …?",
//     Draft / Not this one). No model call and no draft until Nick presses
//     Draft; no push for a prompt.
//
// The draft is a governed compose_email from Nick's WORK mailbox to every
// other attendee — never Nick, never a room or resource, never someone with no
// address (named on the card). Subject "Follow-up: <meeting>". Body: a short
// summary, the decisions, and who owes what — drawn ONLY from the write-up and
// the transcript-processor's actions. The reply-drafter rule holds: the model
// may never commit Nick to anything the record does not say; whatever it does
// not know becomes a [details: …] gap, and a gap blocks sending (the executor's
// placeholder check). Nothing is ever sent automatically: origin
// `meeting-followup`, one press on the card sends it (intent grant).
//
// ONE draft per meeting occurrence, ever (UNIQUE occurrence key + a claim
// before the model call), never re-bought. Model unavailable = no draft, and
// the card says so.

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const ORIGIN = 'meeting-followup';
const TASK_TYPE = 'meeting_followup_draft';
const LOOKBACK_HOURS = 48;
const WAIT_FOR_TRANSCRIPT_MS = 2 * 3600000;
const MAX_AUTO_PER_PASS = 5;
const DRAFTING_STALE_MS = 10 * 60000;
const MAX_NOTE_CHARS = 14000;
const SELF_NAME = 'Nick Ward';
const BROADCAST_OVER = 8;   // more other attendees than this: asked, never drafted on its own
const MAX_RECIPIENTS = 25; // compose_email's own limit (action-registry)

// ── pure rules ──────────────────────────────────────────────────────────────

const STANDUP_RE = /\bstand[\s-]?up\b/i;

/**
 * The daily team standup. PURE. Measured on the live diary (1 Nov 2026): every
 * weekday "Team Standup", 10:00, organised by Nick, one recurring series.
 * Matched on the subject saying stand-up AND starting at 10:00 local, AND (when
 * the world model knows the event) belonging to a recurring series. An unknown
 * series (no world-model row) does not stop the match — the time and the words
 * are the rule.
 */
function isTeamStandup({ subject, start, seriesKnown = false, seriesId = null } = {}) {
  if (!STANDUP_RE.test(String(subject || ''))) return false;
  if (String(start || '').slice(11, 16) !== '10:00') return false;
  if (seriesKnown && !seriesId) return false;
  return true;
}

/** A room or resource on the invite. PURE. Graph's type is not stored, so by name. */
function isRoom(p) {
  const name = String((p && p.name) || '');
  const email = String((p && p.email) || '').toLowerCase();
  return /\broom\b/i.test(name) || /\b(boardroom|meeting room|resource)\b/i.test(name) || /^(room|rm)[-._]/.test(email);
}

/**
 * Who the follow-up goes to. PURE. Every other attendee with an address;
 * Nick, rooms and address-less people are excluded and NAMED.
 */
function recipientsFor(participants, { selfAddresses = [], selfName = SELF_NAME } = {}) {
  const mine = new Set(selfAddresses.filter(Boolean).map((a) => String(a).toLowerCase()));
  const to = []; const excluded = []; const seen = new Set();
  for (const p of Array.isArray(participants) ? participants : []) {
    const email = String((p && p.email) || '').trim().toLowerCase();
    const name = String((p && p.name) || '').trim();
    if ((email && mine.has(email)) || (name && name.toLowerCase() === selfName.toLowerCase())) continue; // Nick, never a recipient
    if (isRoom(p)) { excluded.push({ name: name || email, why: 'room or resource' }); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { excluded.push({ name: name || '(unnamed)', why: 'no email address' }); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    to.push({ name: name || email, email });
  }
  return { to, excluded };
}

/**
 * Draft automatically, prompt, or nothing. PURE.
 * `reports` = [{ name, email }] of Nick's live direct reports.
 */
function classify({ subject, start, seriesKnown = false, seriesId = null, participants = [], reports = [], selfAddresses = [], noteTitle = '' }) {
  if (isTeamStandup({ subject, start, seriesKnown, seriesId })) return { kind: 'skip', why: 'the daily team standup' };
  // The standup is `free` in the diary, so when another meeting starts at 10:00
  // the write-up links to THAT one (free is the tie-breaker) — live on 22 and 29
  // Oct: two standup recordings linked to the 19-person delivery call. A
  // write-up that itself says stand-up, at 10:00, is the standup.
  if (STANDUP_RE.test(String(noteTitle || '')) && String(start || '').slice(11, 16) === '10:00') return { kind: 'skip', why: 'the daily team standup (by its write-up)' };
  const others = recipientsFor(participants, { selfAddresses });
  const reportEmails = new Set(reports.map((r) => String(r.email || '').toLowerCase()).filter(Boolean));
  const reportNames = new Set(reports.map((r) => String(r.name || '').toLowerCase()).filter(Boolean));
  // A broadcast is not a team meeting (measured 1 Nov 2026: the Fortnightly SMT
  // update had 199 attendees and a direct report among them; a 19-person delivery
  // call had one). waiting-on's 8-attendee line for the same reason. Over what one
  // email may reach, there is nothing to offer at all.
  if (others.to.length > MAX_RECIPIENTS) return { kind: 'skip', why: `a broadcast of ${others.to.length} people` };
  const broadcast = others.to.length > BROADCAST_OVER;
  const team = (participants || []).filter((p) => {
    const e = String((p && p.email) || '').toLowerCase();
    const n = String((p && p.name) || '').toLowerCase();
    return (e && reportEmails.has(e)) || (n && reportNames.has(n));
  }).map((p) => p.name || p.email);
  if (team.length && !broadcast) return { kind: 'auto', why: `with ${team.join(', ')} (your team)`, team, ...others };
  if (team.length) return { kind: 'prompt', why: `${others.to.length} people, so asking first`, team, ...others };
  return { kind: 'prompt', why: 'a meeting with people outside your team', team: [], ...others };
}

/** Strip PLAUD noise; turn every bracketed unknown into a [details: …] gap. PURE. */
function gapify(text) {
  return String(text || '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a)
    .replace(/\[\]\([^)]*\)/g, '')
    .replace(/\[(?!details:)([^\]\n]{1,160})\](?!\()/gi, (m, inner) => `[details: ${inner.trim()}]`);
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'nick', 'ward', 'have', 'into', 'about', 'their', 'there', 'they', 'what', 'when', 'then', 'than', 'should', 'would', 'could', 'make', 'sure']);
function _tokens(s) { return String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []; }
/** Is this line supported by the record? At least 60% of its content words appear there. PURE. */
function grounded(line, source) {
  const words = _tokens(line).filter((w) => !STOP.has(w));
  if (!words.length) return true;
  const hay = new Set(_tokens(source));
  return words.filter((w) => hay.has(w)).length / words.length >= 0.6;
}

const NICK_COMMIT_RE = /\b(I(?:'|’)ll|I will|I am going to|I'm going to|Nick will|Nick to|Nick is going to)\b/i;
function ownerIsNick(owner) {
  return String(owner || '').split(/\s*(?:,|&|\band\b)\s*/i).some((part) => /^nick(\s+ward)?$/i.test(part.replace(/^@/, '').trim()));
}

/**
 * The email body. PURE. `model` = { summary, decisions[], actions[]?, gaps[] };
 * `record` = { title, day, actions (transcript, may be null), source }.
 * Anything committing Nick that the record does not carry becomes a gap.
 */
function composeBody({ to, model, record }) {
  const source = String(record.source || '');
  const lines = [];
  const greet = to.length === 1 ? `Hi ${String(to[0].name || '').split(/\s+/)[0] || 'there'},` : 'Hi all,';
  lines.push(greet, '', `A quick follow-up from ${record.title}${record.day ? ` (${record.day})` : ''}.`);
  const guard = (s) => {
    const t = gapify(String(s || '').trim());
    if (!t) return '';
    if (NICK_COMMIT_RE.test(t) && !grounded(t, source)) return `[details: confirm before sending — "${t.replace(/[[\]]/g, '').slice(0, 120)}" is not in the write-up]`;
    return t;
  };
  const summary = guard(model.summary);
  lines.push('', 'Summary', summary || '[details: summary]');
  const decisions = (Array.isArray(model.decisions) ? model.decisions : []).map(guard).filter(Boolean);
  if (decisions.length) { lines.push('', 'Decisions'); for (const d of decisions) lines.push(`- ${d}`); }

  // Who owes what: the transcript's own owners when it was read; else what the
  // model took from the write-up, where Nick's must be in the write-up.
  const fromTranscript = Array.isArray(record.actions) && record.actions.length;
  const acts = fromTranscript ? record.actions : (Array.isArray(model.actions) ? model.actions : []);
  const rendered = [];
  for (const a of acts) {
    if (!a || !String(a.task || '').trim()) continue;
    const task = gapify(String(a.task).trim());
    const ownerRaw = String(a.owner || '').trim();
    const owner = !ownerRaw || /^unknown$/i.test(ownerRaw) || /^speaker\s*\d+$/i.test(ownerRaw) ? '[details: who owns this]' : ownerRaw;
    if (!fromTranscript && ownerIsNick(ownerRaw) && !grounded(task, source)) {
      rendered.push(`- [details: confirm — "${task.replace(/[[\]]/g, '').slice(0, 120)}" for Nick is not in the write-up]`);
      continue;
    }
    const due = typeof a.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? ` (by ${a.due})` : '';
    rendered.push(`- ${owner}: ${task}${due}`);
  }
  if (rendered.length) { lines.push('', 'Actions'); lines.push(...rendered); }
  const gaps = (Array.isArray(model.gaps) ? model.gaps : []).map((g) => String(g || '').replace(/[[\]]/g, '').trim()).filter(Boolean);
  if (gaps.length) { lines.push('', 'To confirm before sending'); for (const g of gaps) lines.push(`- [details: ${g}]`); }
  lines.push('', 'Thanks,', 'Nick');
  return lines.join('\n');
}

function buildPrompt({ title, day, attendees, note, actions }) {
  const actLines = Array.isArray(actions) && actions.length
    ? actions.map((a) => `- ${a.owner || 'unknown'}: ${a.task}${a.due ? ` (due ${a.due})` : ''}`).join('\n')
    : null;
  return `You prepare a short follow-up email for Nick Ward, Head of Technical Support at Nurtur Limited, after a meeting. Direct, warm, concise British English.

Meeting: ${title}${day ? ` (${day})` : ''}
Attendees: ${attendees.join(', ') || '(unknown)'}

Rules:
- Use ONLY the write-up${actLines ? ' and the action list' : ''} below. Add nothing from general knowledge.
- Never commit Nick to an action, a date, a deadline or a fact the record does not say. In the write-up "the manager" usually means Nick.
- If something the email needs is not in the record, write it as [details: what is missing] — never guess it.
- Return ONLY a JSON object:
{
  "summary": "2-3 sentences: what the meeting covered and concluded",
  "decisions": ["each decision actually made, short"],
${actLines ? '  "gaps": ["anything the email needs that the record does not give"]' : '  "actions": [{ "owner": "Full Name or unknown", "task": "what they will do", "due": "YYYY-MM-DD or null" }],\n  "gaps": ["anything the email needs that the record does not give"]'}
}
${actLines ? `
Actions already agreed, with owners (do not repeat or change them):
${actLines}
` : ''}
Write-up:
${String(note || '').slice(0, MAX_NOTE_CHARS)}`;
}

/** Read the model's JSON. PURE. Unreadable → null. */
function parseModel(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!j || typeof j !== 'object' || typeof j.summary !== 'string' || !j.summary.trim()) return null;
    return {
      summary: j.summary,
      decisions: Array.isArray(j.decisions) ? j.decisions.filter((x) => typeof x === 'string') : [],
      actions: Array.isArray(j.actions) ? j.actions.filter((x) => x && typeof x.task === 'string') : [],
      gaps: Array.isArray(j.gaps) ? j.gaps.filter((x) => typeof x === 'string') : [],
    };
  } catch { return null; }
}

// ── store ───────────────────────────────────────────────────────────────────

function ensure() {
  db.run(`CREATE TABLE IF NOT EXISTS meeting_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurrence_key TEXT NOT NULL UNIQUE,
    meeting_id TEXT NOT NULL,
    subject TEXT,
    start_local TEXT,
    note_path TEXT,
    transcript_path TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('auto', 'prompt')),
    why TEXT,
    status TEXT NOT NULL CHECK(status IN ('prompted', 'drafting', 'drafted', 'declined', 'failed')),
    recipients_json TEXT,
    excluded_json TEXT,
    action_id TEXT,
    error TEXT,
    pushed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

function _row(r) {
  if (!r) return null;
  const parse = (v, d) => { try { return JSON.parse(v || 'null') ?? d; } catch { return d; } };
  return {
    id: r.id, occurrenceKey: r.occurrence_key, meetingId: r.meeting_id, subject: r.subject, start: r.start_local,
    notePath: r.note_path, transcriptPath: r.transcript_path, kind: r.kind, why: r.why, status: r.status,
    recipients: parse(r.recipients_json, []), excluded: parse(r.excluded_json, []), actionId: r.action_id || null,
    error: r.error || null, pushedAt: r.pushed_at || null, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// A READ never creates the table (canonical Now reads Drafts, and its read-only
// pass must leave the schema byte-identical — promise-shadow's pin).
function _exists() {
  try { return Boolean(db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meeting_followups'`)); } catch { return false; }
}

function get(id) { if (!_exists()) return null; return _row(db.get('SELECT * FROM meeting_followups WHERE id = ?', [id])); }

// ── reading the record ──────────────────────────────────────────────────────

function _vault() { return process.env.OBSIDIAN_VAULT_PATH || ''; }

function _fm(text) {
  const out = {};
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const k = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (k) out[k[1]] = k[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return out;
}

function _transcriptActions(transcriptPath) {
  if (!transcriptPath) return { read: false, actions: null };
  try {
    const v = db.getState(`transcript_${path.basename(transcriptPath, '.md')}`);
    if (!v) return { read: false, actions: null };
    const j = JSON.parse(v);
    return { read: true, actions: Array.isArray(j.actions) ? j.actions : [], summary: j.summary || null };
  } catch { return { read: false, actions: null }; }
}

function _participants(meetingId) {
  try { return db.all('SELECT email, name, is_organizer FROM wm_meeting_participants WHERE meeting_id = ?', [meetingId]); } catch { return []; }
}

function _series(meetingId) {
  try {
    const r = db.get('SELECT series_id FROM wm_meetings WHERE meeting_id = ?', [meetingId]);
    return r ? { seriesKnown: true, seriesId: r.series_id || null } : { seriesKnown: false, seriesId: null };
  } catch { return { seriesKnown: false, seriesId: null }; }
}

function _reports() {
  try { return require('./team-roster').directReports().map((p) => ({ name: p.name, email: p.email })); } catch { return []; }
}

function _selfAddresses() {
  const out = [require('./mail-identity').WORK_ADDRESS];
  return out;
}

function _dayWords(start) {
  const s = String(start || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(`${s.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Recent meeting write-ups in the vault (Meetings/YYYY/MM), newest month first. */
function _recentNotes(nowMs) {
  const vault = _vault();
  if (!vault) return { notes: [], gap: 'vault not configured' };
  const out = [];
  const months = new Set();
  for (const back of [0, 1]) {
    const d = new Date(nowMs); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back);
    months.add(`${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  for (const ym of months) {
    const dir = path.join(vault, 'Meetings', ...ym.split('/'));
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const rel = `Meetings/${ym}/${f}`;
      let head = '';
      try { head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { continue; }
      const fm = _fm(head);
      if (!fm.start_at) continue;
      const startMs = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(fm.start_at) ? fm.start_at : `${fm.start_at}Z`);
      if (!Number.isFinite(startMs) || nowMs - startMs > LOOKBACK_HOURS * 3600000 || startMs > nowMs) continue;
      out.push({ path: rel, startMs, title: fm.title || f.replace(/\.md$/, ''), transcriptPath: fm.transcript_path || null, twin: / \d+\.md$/.test(f) });
    }
  }
  // The original before a PLAUD " 2" twin, so one occurrence reads the same note every time.
  out.sort((a, b) => Number(a.twin) - Number(b.twin) || a.path.localeCompare(b.path));
  return { notes: out, gap: null };
}

// ── draft ───────────────────────────────────────────────────────────────────

const _inflight = new Map();

/**
 * Draft the follow-up for one row. One per occurrence, ever: claims the row
 * (prompted|failed → drafting) before any model call; a row with an action is
 * returned as it is. Never throws.
 */
function draft(id, deps = {}) {
  if (_inflight.has(id)) return _inflight.get(id);
  const p = _draft(id, deps).finally(() => _inflight.delete(id));
  _inflight.set(id, p);
  return p;
}

async function _draft(id, { runTask = null, push = null, now = Date.now() } = {}) {
  ensure();
  const row = get(id);
  if (!row) return { ok: false, code: 404, error: 'no such meeting follow-up' };
  if (row.actionId) return { ok: true, already: true, followup: row };
  if (row.status === 'declined') return { ok: false, code: 409, error: 'you said not this one' };
  const stamp = new Date(now).toISOString();
  const claim = db.run(`UPDATE meeting_followups SET status = 'drafting', error = NULL, updated_at = ?
                         WHERE id = ? AND action_id IS NULL AND status IN ('prompted', 'failed')`, [stamp, id]);
  if (!claim.changes) return { ok: true, already: true, followup: get(id) };
  const fail = (why) => {
    db.run(`UPDATE meeting_followups SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, [why, new Date().toISOString(), id]);
    return { ok: false, code: 409, error: why, followup: get(id) };
  };

  if (!row.recipients.length) return fail(row.excluded.length ? `no one to send it to (${row.excluded.map((e) => `${e.name}: ${e.why}`).join('; ')})` : 'no other attendee with an email address');
  const policy = require('./action-registry').policyFor('compose_email');
  if (row.recipients.length > policy.maxRecipients) return fail(`${row.recipients.length} attendees — more than one email may reach (${policy.maxRecipients})`);

  let note = '';
  try { note = fs.readFileSync(path.join(_vault(), row.notePath), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); } catch { return fail('the write-up could not be read'); }
  const tr = _transcriptActions(row.transcriptPath);
  const record = { title: row.subject, day: _dayWords(row.start), actions: tr.actions, source: `${note}\n${(tr.actions || []).map((a) => `${a.owner}: ${a.task}`).join('\n')}\n${tr.summary || ''}` };
  const prompt = buildPrompt({ title: row.subject, day: record.day, attendees: row.recipients.map((r) => r.name).concat(SELF_NAME), note, actions: tr.actions });

  let model = null;
  try {
    const run = runTask || require('./ai-routing').runTask;
    const r = await run(TASK_TYPE, { prompt, maxTokens: 1500 }, { forceCloud: true, timeout: 60000 });
    model = parseModel(r && r.text);
    if (!model) return fail('the model’s answer could not be read — no draft');
  } catch (e) {
    return fail(`the model was not available (${e.message}) — no draft`);
  }

  const body = composeBody({ to: row.recipients, model, record });
  const r = require('./prepared-actions').prepareCompose({
    from: 'work', to: row.recipients, subject: `Follow-up: ${row.subject}`, body, origin: ORIGIN,
    generatedBy: `drafted by NEURO from the PLAUD write-up of "${row.subject}"${tr.read ? ' and its transcript actions' : ''}`,
    evidence: { meeting: { id: row.meetingId, start: row.start, subject: row.subject }, notePath: row.notePath, followupId: row.id },
    now,
  });
  if (!r.ok) return fail(`the draft could not be prepared (${r.error})`);
  const actionId = r.action.actionId;
  db.run(`UPDATE meeting_followups SET status = 'drafted', action_id = ?, error = NULL, updated_at = ? WHERE id = ?`, [actionId, new Date().toISOString(), id]);

  if (row.kind === 'auto' && !row.pushedAt) {
    try {
      const send = push || ((t, b, d) => require('./webpush').sendToAll(t, b, d));
      await send(`Follow-up ready for ${row.subject}`, 'Drafted from the write-up — one press sends it. Nothing has been sent.',
        { type: 'meeting_followup', tab: 'drafts', url: '/?view=today', key: `meeting_followup:${row.id}` });
      db.run(`UPDATE meeting_followups SET pushed_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    } catch (e) { console.warn('[MeetingFollowups] push failed:', e.message); }
  }
  return { ok: true, already: false, followup: get(id), action: r.action };
}

// ── the sweep ───────────────────────────────────────────────────────────────

/**
 * Find new linked write-ups and record a prompt or an automatic draft for each.
 * Idempotent: an occurrence already recorded is left alone. Returns counts.
 */
async function sweep({ now = Date.now(), runTask = null, push = null } = {}) {
  ensure();
  const out = { scanned: 0, linked: 0, auto: 0, prompted: 0, skipped: 0, waiting: 0, drafted: 0, failed: 0, gaps: [] };
  if (!require('./feature-flags').isEnabled('meeting_followup_drafts')) return { ...out, off: true };
  // A draft interrupted by a restart goes back to failed (it can be pressed again).
  db.run(`UPDATE meeting_followups SET status = 'failed', error = 'interrupted — press Draft to try again'
           WHERE status = 'drafting' AND updated_at < ?`, [new Date(now - DRAFTING_STALE_MS).toISOString()]);
  const { notes, gap } = _recentNotes(now);
  if (gap) { out.gaps.push(gap); return out; }
  const sources = require('./obligation-sources');
  const reports = _reports();
  const seen = new Set();
  const toDraft = [];
  for (const n of notes) {
    out.scanned += 1;
    const link = sources.meetingLinkFor(n.path);
    const occ = link && link.occurrence;
    if (!occ) continue;
    const key = `${occ.meetingId}@${occ.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.linked += 1;
    if (db.get('SELECT id FROM meeting_followups WHERE occurrence_key = ?', [key])) continue;
    // Wait (up to 2h) for the transcript read, so who-owes-what has its owners.
    const tr = _transcriptActions(n.transcriptPath);
    if (n.transcriptPath && !tr.read && now - n.startMs < WAIT_FOR_TRANSCRIPT_MS) { out.waiting += 1; continue; }
    const participants = _participants(occ.meetingId);
    const c = classify({ subject: occ.subject, start: occ.start, ..._series(occ.meetingId), participants, reports, selfAddresses: _selfAddresses(), noteTitle: `${n.title} ${path.basename(n.path)}` });
    if (c.kind === 'skip') { out.skipped += 1; continue; }
    const stamp = new Date(now).toISOString();
    try {
      const info = db.run(`INSERT INTO meeting_followups (occurrence_key, meeting_id, subject, start_local, note_path, transcript_path, kind, why, status, recipients_json, excluded_json, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prompted', ?, ?, ?, ?)`,
      [key, occ.meetingId, occ.subject || n.title, occ.start, n.path, n.transcriptPath, c.kind, c.why, JSON.stringify(c.to), JSON.stringify(c.excluded), stamp, stamp]);
      if (c.kind === 'auto') { out.auto += 1; toDraft.push(info.lastInsertRowid); } else out.prompted += 1;
    } catch (e) {
      if (!/UNIQUE/i.test(e.message)) out.gaps.push(`${n.path}: ${e.message}`);
    }
  }
  for (const id of toDraft.slice(0, MAX_AUTO_PER_PASS)) {
    const r = await draft(id, { runTask, push, now });
    if (r.ok && !r.already) out.drafted += 1; else if (!r.ok) out.failed += 1;
  }
  return out;
}

/** Nick: not this one. A drafted one is withdrawn from his view; the action stays in Actions. */
function decline(id, { now = Date.now() } = {}) {
  ensure();
  const row = get(id);
  if (!row) return { ok: false, code: 404, error: 'no such meeting follow-up' };
  if (row.actionId) return { ok: false, code: 409, error: 'already drafted — reject it in Actions if you do not want it' };
  db.run(`UPDATE meeting_followups SET status = 'declined', updated_at = ? WHERE id = ?`, [new Date(now).toISOString(), id]);
  return { ok: true, followup: get(id) };
}

/** The newest version of a prepared action (an edit makes a new one). */
function _latestAction(actionId) {
  let id = actionId;
  for (let i = 0; i < 10 && id; i++) {
    const child = db.get('SELECT action_id FROM prepared_actions WHERE parent_action_id = ?', [id]);
    if (!child) break;
    id = child.action_id;
  }
  try { return id ? require('./prepared-actions').get(id) : null; } catch { return null; }
}

/**
 * What Nick sees: open prompts, drafts waiting for his press, and failures.
 * READ only. Recent (14 days).
 */
function list({ now = Date.now() } = {}) {
  if (!_exists()) return { items: [], gate: require('./meeting-actions-gate').state() };
  const since = new Date(now - 14 * 86400000).toISOString();
  const rows = db.all(`SELECT * FROM meeting_followups WHERE created_at >= ? AND status != 'declined' ORDER BY start_local DESC`, [since]).map(_row);
  const items = [];
  for (const r of rows) {
    let action = null;
    if (r.actionId) {
      action = _latestAction(r.actionId);
      if (action && !['prepared', 'approved', 'executing', 'execution_uncertain'].includes(action.status)) continue; // sent or rejected — done here
    }
    items.push({ ...r, action });
  }
  return { items, gate: require('./meeting-actions-gate').state() };
}

/** Drafts → Communication drafts rows. READ only. */
function draftRows(opts = {}) {
  return list(opts).items.map((r) => ({
    moveKey: `meeting-followup:${r.id}`, kindLabel: r.kind === 'auto' ? 'Meeting follow-up' : 'Follow-up offer',
    title: r.status === 'drafted' ? `Follow-up: ${r.subject}` : `Draft a follow-up to ${r.subject}?`,
    actionId: r.actionId, followupId: r.id,
    status: r.status === 'drafted' ? (r.action && r.action.draft && r.action.draft.placeholders && r.action.draft.placeholders.length ? 'In Actions — fill the [details] gaps first. Not sent.' : 'In Actions — one press sends it. Not sent.')
      : r.status === 'failed' ? `Not drafted — ${r.error}` : 'Draft it, or say not this one. Nothing is drafted until you press.',
    savedAt: r.updatedAt || r.createdAt,
  }));
}

module.exports = {
  ORIGIN, TASK_TYPE,
  isTeamStandup, isRoom, recipientsFor, classify, gapify, grounded, composeBody, buildPrompt, parseModel,
  sweep, draft, decline, list, draftRows, get, ensure, _inflight,
};
