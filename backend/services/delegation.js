'use strict';

/**
 * Delegation prompts (1 Nov 2026) — "this could go to Naomi".
 *
 * When an email or a task clearly fits one of Nick's direct reports, NEURO
 * suggests handing it over and drafts the hand-over. It suggests; it never
 * hands anything over on its own.
 *
 * CANDIDATES
 *   - work-triage emails filed DELEGATE, or ACTION from a customer / the queue
 *     (an outside sender, or a ticket/customer word in the subject or preview);
 *   - open NEURO tasks that are NOT a commitment Nick personally owes someone
 *     (origin != 'commitment'), not personal, not Jira-owned, not linked to a
 *     Microsoft task, not repeating.
 *
 * JUDGING — one model call per item (gate class `delegation_suggest`, cloud),
 * given the item and a compact roster of the CURRENT direct reports (team-roster:
 * role, team, any `owns:` / `responsibilities:` / `skills:` / `areas:` frontmatter)
 * plus what each has been handed before (open/recent waiting-on items and earlier
 * hand-overs). The model must name ONE person and a one-line why, or "none".
 * The server then REFUSES unless: confidence is "high"; the name is exactly a
 * current, non-archived direct report; NOVA's People HR feed can be read for them
 * and shows no leave in the next seven days (unknown leave refuses).
 *
 * Each item is judged ONCE — keyed on (kind, id, hash of its text) — whatever the
 * verdict, so a "none" is never re-bought. A model failure stores nothing (it is
 * asked again next pass). "Not this one" is remembered per item, any wording.
 * Never more than MAX_OPEN suggestions open at once; the pass stops judging once
 * that many are open.
 *
 * HANDING OVER — a governed compose_email from the work mailbox to that person
 * (origin `delegation`, one press via intent grant). The draft is a template, no
 * model call, and states only what NEURO holds: the task text and notes, or the
 * email's subject, sender and preview. What done looks like and by when are
 * `[details]` / `[date]` gaps unless the task already carries a due date — Nick
 * is never committed to anything the record does not say. A gap left in blocks
 * the send twice: here (409) and in the executor (registry placeholder check).
 *
 * AFTER THE SEND IS VERIFIED (reconcile, read back from prepared_actions — never
 * on `executed`): a waiting_on row is recorded ("what <Name> owes Nick") and
 *   - a task is set to `dropped` with a note naming who has it. Decision: the
 *     task list is what NICK does; delegated work he does not do, and the follow-
 *     up (chase, lapse, looks-done) already lives in Waiting on. Keeping the task
 *     open with a marker would leave it in Must-Move, the triage queue, the
 *     planner and the overdue counts while someone else does it.
 *   - an email is dismissed from triage as `delegated`.
 * A send that failed or Nick rejected puts the suggestion back to open.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_OPEN = 3;
const MAX_JUDGE_PER_PASS = 6;
const LEAVE_WINDOW_DAYS = 7;
const ORIGIN = 'delegation';
const LIVE_ACTION = new Set(['prepared', 'approved', 'executing', 'executed', 'execution_uncertain']);
const EXTRA_FIELDS = ['owns', 'responsibilities', 'skills', 'areas'];
const CUSTOMER_RE = /\b(customer|client|ticket|NT-\d+|escalat\w*|queue|jira|servicehub|service desk|support request|complain\w*)\b/i;
const OWN_DOMAIN = /@nurtur\.tech$/i;

let ensured = false;
const inflight = { scan: null };

function _db() { return require('../db/database'); }
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const londonDay = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const hashOf = (s) => crypto.createHash('sha256').update(String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 24);

function ensureTable() {
  if (ensured) return;
  const db = _db();
  db.run(`CREATE TABLE IF NOT EXISTS delegation_suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_kind   TEXT NOT NULL CHECK(item_kind IN ('task','email')),
    item_id     TEXT NOT NULL,
    text_hash   TEXT NOT NULL,
    judged_at   TEXT NOT NULL,
    verdict     TEXT NOT NULL,           -- suggest | none | low-confidence | not-a-report | refused | unreadable
    reason      TEXT,
    person      TEXT,
    why         TEXT,
    confidence  TEXT,
    status      TEXT NOT NULL,           -- open | judged | dismissed | prepared | sent | expired | closed
    action_id   TEXT,
    decided_at  TEXT,
    waiting_key TEXT,
    UNIQUE(item_kind, item_id, text_hash)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_delegation_status ON delegation_suggestions(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_delegation_item ON delegation_suggestions(item_kind, item_id)');
  ensured = true;
}

// ── PURE ────────────────────────────────────────────────────────────────────

/** An email worth asking about: DELEGATE, or ACTION from a customer / the queue. */
function isCandidateEmail(e) {
  if (!e || e.dismissed || !e.id) return false;
  if (e.category === 'DELEGATE') return true;
  if (e.category !== 'ACTION') return false;
  const outside = e.fromEmail && !OWN_DOMAIN.test(String(e.fromEmail));
  return !!outside || CUSTOMER_RE.test(`${e.subject || ''} ${e.preview || ''}`);
}

/** A task worth asking about: open, work, not a personal commitment, nothing outside NEURO owns it. */
function isCandidateTask(t) {
  if (!t || !(t.status === 'open' || t.status === 'in-progress')) return false;
  if (t.origin === 'commitment') return false;
  if (t.domain === 'personal') return false;
  if (t.ms_id) return false;
  if (t.recurrence_json) return false;
  if (/^jira/i.test(String(t.source || ''))) return false;
  return true;
}

function itemText(kind, item) {
  return kind === 'task'
    ? `${item.text || ''}\n${item.notes || ''}`
    : `${item.subject || ''}\n${item.fromEmail || ''}\n${item.preview || ''}`;
}

function buildPrompt({ kind, item, roster }) {
  const what = kind === 'task'
    ? [`TASK: ${clip(item.text, 300)}`, item.notes ? `Notes: ${clip(item.notes, 500)}` : null, item.due_date ? `Due: ${item.due_date}` : null]
    : [`EMAIL from ${clip(item.from, 80)} <${clip(item.fromEmail, 120)}>`, `Subject: ${clip(item.subject, 200)}`, `Preview: ${clip(item.preview, 500)}`];
  const people = roster.map((p) => {
    const parts = [`- ${p.name} — ${p.role || 'no role recorded'}, ${p.group || p.team || 'no team recorded'}`];
    for (const f of EXTRA_FIELDS) if (p[f] && p[f].length) parts.push(`  ${f}: ${p[f].join('; ')}`);
    if (p.history && p.history.length) parts.push(`  handed before: ${p.history.join('; ')}`);
    return parts.join('\n');
  });
  return [
    "You decide whether one piece of Nick Ward's work clearly belongs with ONE of his direct reports.",
    'Nick is Head of Technical Support. Only suggest someone when the work plainly fits their role or what they already own.',
    'If it is Nick\'s own job (a decision, a manager conversation, something only he can do), or it fits nobody clearly, answer none.',
    '',
    ...what.filter(Boolean),
    '',
    'DIRECT REPORTS:',
    ...people,
    '',
    'Answer with JSON only, nothing else:',
    '{"person": "<exact full name from the list, or none>", "why": "<one line, under 100 characters, e.g. she runs Tier 2 billing>", "confidence": "high|medium|low"}',
  ].join('\n');
}

function parseAnswer(text) {
  const s = String(text || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!o || typeof o !== 'object') return null;
    return { person: clip(o.person, 80), why: clip(o.why, 140), confidence: clip(o.confidence, 10).toLowerCase() };
  } catch { return null; }
}

/**
 * The server's verdict on the model's answer. PURE. Leave is a map name →
 * { known, dates:Set } and `windowDays` the London dates to check.
 */
function judge(answer, { roster, leave, windowDays }) {
  if (!answer) return { verdict: 'unreadable', reason: 'the answer could not be read' };
  if (!answer.person || /^none$/i.test(answer.person)) return { verdict: 'none', reason: 'fits nobody clearly' };
  const p = roster.find((r) => r.name.toLowerCase() === answer.person.toLowerCase());
  if (!p) return { verdict: 'not-a-report', reason: `${answer.person} is not a current direct report` };
  if (answer.confidence !== 'high') return { verdict: 'low-confidence', reason: `confidence ${answer.confidence || 'not given'}`, person: p.name, why: answer.why };
  const off = leave(p.name);
  if (!off || !off.known) return { verdict: 'refused', reason: `could not check ${p.name}'s leave${off && off.reason ? ` (${off.reason})` : ''}`, person: p.name, why: answer.why };
  const away = windowDays.filter((d) => off.dates.has(d));
  if (away.length) return { verdict: 'refused', reason: `${p.name} is on leave ${away[0]}`, person: p.name, why: answer.why };
  if (!answer.why) return { verdict: 'refused', reason: 'no reason given', person: p.name };
  return { verdict: 'suggest', person: p.name, why: answer.why };
}

/** "Thu 6 Nov" from YYYY-MM-DD, sliced, never parsed into a zone. */
function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${+m[3]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1]}`;
}

/**
 * The hand-over email. PURE, a template — it says only what NEURO holds. The
 * two things it cannot know are left as [details] / [date] gaps, which the
 * send refuses while they remain.
 */
function composeDraft({ kind, item, person }) {
  const first = String(person || '').split(/\s+/)[0] || person;
  const lines = [`Hi ${first},`, '', 'Could you pick this up for me, please?', ''];
  let subject;
  if (kind === 'task') {
    subject = `Could you take this on? ${clip(item.text, 90)}`;
    lines.push(`What it is: ${clip(item.text, 400)}`);
    if (item.notes) lines.push('', `Context: ${clip(item.notes, 1200)}`);
    if (item.origin_path && !/^email:/.test(item.origin_path)) lines.push('', `It came from: ${item.origin_path}`);
  } else {
    subject = `Handing over: ${clip(item.subject, 110) || '(no subject)'}`;
    lines.push(`What it is: the email "${clip(item.subject, 200) || '(no subject)'}" from ${clip(item.from, 80) || 'unknown sender'}${item.fromEmail ? ` <${clip(item.fromEmail, 120)}>` : ''}${item.received ? `, received ${String(item.received).slice(0, 10)}` : ''}.`);
    if (item.preview) lines.push('', 'It says:', ...clip(item.preview, 1200).split(/(?<=[.!?])\s+/).map((l) => `> ${l}`));
  }
  const due = kind === 'task' && item.due_date ? dayLabel(item.due_date) : null;
  lines.push('', 'What done looks like: [details]', `By when: ${due || '[date]'}`, '', 'Happy to talk it through if that helps — just grab me.', '', 'Thanks,', 'Nick');
  return { subject, body: lines.join('\n') };
}

// ── deps ────────────────────────────────────────────────────────────────────

function _readExtras(name) {
  const vault = process.env.OBSIDIAN_VAULT_PATH || '';
  const out = {};
  try {
    const text = fs.readFileSync(path.join(vault, 'People', `${name}.md`), 'utf-8').replace(/\r\n/g, '\n');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return out;
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const km = /^([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
      if (!km || !EXTRA_FIELDS.includes(km[1])) continue;
      const val = km[2].trim();
      const items = [];
      if (val.startsWith('[')) items.push(...val.replace(/^\[|\]$/g, '').split(','));
      else if (val) items.push(val);
      else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j += 1) items.push(lines[j].replace(/^\s*-\s+/, ''));
      out[km[1]] = items.map((s) => clip(s.replace(/^["']|["']$/g, ''), 80)).filter(Boolean).slice(0, 8);
    }
  } catch { /* no note, no extras */ }
  return out;
}

function _history(name) {
  const out = [];
  try {
    const first = String(name).split(/\s+/)[0].toLowerCase();
    const rows = _db().all("SELECT text FROM waiting_on WHERE lower(person) = ? ORDER BY last_seen DESC LIMIT 4", [first]);
    for (const r of rows) out.push(clip(r.text, 70));
  } catch { /* no history */ }
  return out;
}

function _defaultDeps() {
  return {
    reports: () => require('./team-roster').directReports(),
    extras: _readExtras,
    history: _history,
    leaveFor: (name) => { const ta = require('./team-availability'); return ta.daysOffFor(name, ta.snapshot()); },
    emails: () => require('./email-triage').getStoredTriage(),
    tasks: () => _db().listTaskRows({ status: 'all', includeDone: false }),
    task: (id) => require('./task-store').getTask(Number(id)),
    run: (prompt) => require('./ai-routing').runTask('delegation_suggest', { prompt, maxTokens: 300 }, { forceCloud: true, timeout: 45000 }),
    getAction: (id) => require('./prepared-actions').get(id),
    prepareCompose: (a) => require('./prepared-actions').prepareCompose(a),
    recordWaiting: (a) => require('./waiting-on').record(a),
    updateTask: (id, f) => require('./task-store').updateTask(id, f),
    dismissEmail: (id) => require('./email-triage').dismissEmail(id, 'delegated'),
    now: () => Date.now(),
  };
}
const _d = (over) => ({ ..._defaultDeps(), ...(over || {}) });

function _roster(d) {
  let reports = [];
  try { reports = d.reports() || []; } catch { reports = []; }
  return reports.filter((p) => p && p.name && !p.archived).map((p) => ({ ...p, ...d.extras(p.name), history: d.history(p.name) }));
}

function _windowDays(nowMs) {
  const out = [];
  for (let i = 0; i < LEAVE_WINDOW_DAYS; i += 1) out.push(londonDay(nowMs + i * 86400000));
  return out;
}

// ── reads ───────────────────────────────────────────────────────────────────

function _row(id) { ensureTable(); return _db().get('SELECT * FROM delegation_suggestions WHERE id = ?', [Number(id)]); }
function _openCount() { ensureTable(); return _db().get("SELECT COUNT(*) AS n FROM delegation_suggestions WHERE status IN ('open','prepared')").n; }

function _itemFor(row, d) {
  if (row.item_kind === 'task') {
    const t = d.task(row.item_id);
    return t && (t.status === 'open' || t.status === 'in-progress') ? t : null;
  }
  const e = (d.emails() || []).find((x) => x.id === row.item_id);
  return e && !e.dismissed ? e : null;
}

function _shape(row, item, d) {
  const roster = _roster(d);
  const p = roster.find((r) => r.name === row.person);
  const draft = item ? composeDraft({ kind: row.item_kind, item, person: row.person }) : null;
  return {
    id: row.id, kind: row.item_kind, itemId: row.item_id, status: row.status,
    title: row.item_kind === 'task' ? clip(item && item.text, 160) : clip(item && item.subject, 160),
    person: row.person, first: String(row.person || '').split(/\s+/)[0], email: (p && p.email) || null,
    why: row.why, line: `Could go to ${String(row.person || '').split(/\s+/)[0]} — ${row.why}`,
    draft, actionId: row.action_id || null,
    blocker: p && p.email ? null : `${row.person} has no email address in their People note`,
  };
}

/**
 * The open suggestions (≤ MAX_OPEN), revalidated: an item that has gone is
 * closed, a person no longer a report or now on leave is expired.
 */
function list({ deps } = {}) {
  ensureTable();
  const d = _d(deps);
  reconcile({ deps });
  const nowMs = d.now();
  const roster = _roster(d);
  const days = _windowDays(nowMs);
  const rows = _db().all("SELECT * FROM delegation_suggestions WHERE status IN ('open','prepared') ORDER BY id");
  const out = [];
  for (const row of rows) {
    const item = _itemFor(row, d);
    if (!item && row.status === 'open') { _set(row.id, { status: 'closed', reason: 'the item is no longer open' }, nowMs); continue; }
    if (row.status === 'open') {
      const p = roster.find((r) => r.name === row.person);
      const off = p ? d.leaveFor(p.name) : null;
      const away = off && off.known ? days.find((x) => off.dates.has(x)) : null;
      if (!p || !off || !off.known || away) {
        _set(row.id, { status: 'expired', reason: !p ? `${row.person} is no longer a direct report` : away ? `${row.person} is on leave ${away}` : `could not check ${row.person}'s leave` }, nowMs);
        continue;
      }
    }
    out.push(_shape(row, item, d));
  }
  return { contract: 'delegation-v1', max: MAX_OPEN, suggestions: out.slice(0, MAX_OPEN) };
}

function _set(id, fields, nowMs = Date.now()) {
  const cols = Object.keys(fields);
  _db().run(`UPDATE delegation_suggestions SET ${cols.map((c) => `${c} = ?`).join(', ')}, decided_at = ? WHERE id = ?`,
    [...cols.map((c) => fields[c]), new Date(nowMs).toISOString(), Number(id)]);
}

// ── the pass ────────────────────────────────────────────────────────────────

function _candidates(d) {
  const out = [];
  let emails = [];
  try { emails = d.emails() || []; } catch { emails = []; }
  for (const e of emails.filter(isCandidateEmail).sort((a, b) => String(b.received || '').localeCompare(String(a.received || '')))) {
    out.push({ kind: 'email', id: String(e.id), item: e });
  }
  let tasks = [];
  try { tasks = d.tasks() || []; } catch { tasks = []; }
  for (const t of tasks.filter(isCandidateTask).sort((a, b) => Number(b.id) - Number(a.id))) out.push({ kind: 'task', id: String(t.id), item: t });
  return out;
}

/**
 * Judge candidates not yet judged, at most MAX_JUDGE_PER_PASS calls, stopping
 * once MAX_OPEN suggestions are open. One pass at a time.
 */
function scan({ deps } = {}) {
  if (inflight.scan) return inflight.scan;
  inflight.scan = _scan(deps).finally(() => { inflight.scan = null; });
  return inflight.scan;
}

async function _scan(deps) {
  ensureTable();
  const d = _d(deps);
  const db = _db();
  const nowMs = d.now();
  const res = { judged: 0, suggested: 0, skipped: 0, failed: 0, open: _openCount() };
  if (res.open >= MAX_OPEN) return { ...res, why: 'already at the limit of open suggestions' };
  const roster = _roster(d);
  if (!roster.length) return { ...res, why: 'no direct reports could be read' };
  const days = _windowDays(nowMs);
  for (const c of _candidates(d)) {
    if (res.judged >= MAX_JUDGE_PER_PASS || _openCount() >= MAX_OPEN) break;
    const hash = hashOf(itemText(c.kind, c.item));
    const seen = db.get(`SELECT 1 FROM delegation_suggestions WHERE item_kind = ? AND item_id = ?
      AND (text_hash = ? OR status = 'dismissed' OR status IN ('open','prepared','sent'))`, [c.kind, c.id, hash]);
    if (seen) { res.skipped += 1; continue; }
    let answer;
    try {
      const r = await d.run(buildPrompt({ kind: c.kind, item: c.item, roster }));
      if (!r || !r.text) throw new Error((r && r.reason) || 'no AI provider answered');
      answer = parseAnswer(r.text);
    } catch (e) {
      // Not bought: nothing stored, asked again next pass. Stop — a dead
      // provider must not be asked six times in a row.
      res.failed += 1; res.error = clip(e.message, 160);
      break;
    }
    const v = judge(answer, { roster, leave: d.leaveFor, windowDays: days });
    res.judged += 1;
    const open = v.verdict === 'suggest' && _openCount() < MAX_OPEN;
    db.run(`INSERT OR IGNORE INTO delegation_suggestions (item_kind, item_id, text_hash, judged_at, verdict, reason, person, why, confidence, status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [c.kind, c.id, hash, new Date(nowMs).toISOString(), v.verdict, v.reason || null, v.person || null, v.why || null,
      answer ? answer.confidence || null : null, open ? 'open' : 'judged']);
    if (open) res.suggested += 1;
  }
  res.open = _openCount();
  return res;
}

// ── Nick's answers ──────────────────────────────────────────────────────────

/** "Not this one" — remembered for this item, whatever its wording becomes. */
function dismiss(id, { deps } = {}) {
  const d = _d(deps);
  const row = _row(id);
  if (!row) return { ok: false, code: 404, error: 'no such suggestion' };
  if (row.status !== 'open') return { ok: false, code: 409, error: `this suggestion is ${row.status}` };
  _set(row.id, { status: 'dismissed', reason: 'Not this one' }, d.now());
  return { ok: true };
}

const GAP_RE = /\[[^\]\n]{1,60}\]/g;

/**
 * Prepare the hand-over email (governed compose_email, origin `delegation`).
 * The client then spends one intent grant to send it. A repeat press returns
 * the live action. Any [gap] left in the subject or body refuses.
 */
function handOver(id, { subject, body, deps } = {}) {
  const d = _d(deps);
  const row = _row(id);
  if (!row) return { ok: false, code: 404, error: 'no such suggestion' };
  if (row.status === 'prepared' && row.action_id) {
    const a = d.getAction(row.action_id);
    if (a && LIVE_ACTION.has(a.status)) return { ok: true, already: true, action: a };
  }
  if (row.status !== 'open' && row.status !== 'prepared') return { ok: false, code: 409, error: `this suggestion is ${row.status}` };
  const item = _itemFor(row, d);
  if (!item) return { ok: false, code: 409, error: 'the item is no longer open' };
  const p = _roster(d).find((r) => r.name === row.person);
  if (!p) return { ok: false, code: 409, error: `${row.person} is no longer a direct report` };
  if (!p.email) return { ok: false, code: 409, error: `${row.person} has no email address in their People note` };
  const off = d.leaveFor(p.name);
  const away = off && off.known ? _windowDays(d.now()).find((x) => off.dates.has(x)) : null;
  if (!off || !off.known) return { ok: false, code: 409, error: `could not check ${p.name}'s leave` };
  if (away) return { ok: false, code: 409, error: `${p.name} is on leave ${away}` };
  const draft = composeDraft({ kind: row.item_kind, item, person: row.person });
  const subj = String(subject == null ? draft.subject : subject).trim();
  const text = String(body == null ? draft.body : body).replace(/\r\n/g, '\n').trim();
  const gaps = [...new Set([...(`${subj}\n${text}`.match(GAP_RE) || [])])];
  if (gaps.length) return { ok: false, code: 409, error: `fill in ${gaps.join(', ')} before sending`, gaps };
  const r = d.prepareCompose({
    from: 'work', to: [{ name: p.name, email: p.email }], subject: subj, body: text, origin: ORIGIN,
    generatedBy: 'template (delegation hand-over, edited by Nick)',
    evidence: { delegationId: row.id, itemKind: row.item_kind, itemId: row.item_id, person: p.name },
    now: d.now(),
  });
  if (!r.ok) return r;
  _set(row.id, { status: 'prepared', action_id: r.action.actionId }, d.now());
  return { ok: true, already: false, action: r.action };
}

/**
 * After the send: read each prepared hand-over back. VERIFIED → record the
 * waiting-on row and close the item; failed / rejected / gone → open again.
 */
function reconcile({ deps } = {}) {
  ensureTable();
  const d = _d(deps);
  const out = { sent: 0, reopened: 0 };
  const rows = _db().all("SELECT * FROM delegation_suggestions WHERE status = 'prepared' AND action_id IS NOT NULL");
  for (const row of rows) {
    let a = null;
    try { a = d.getAction(row.action_id); } catch { a = null; }
    if (a && LIVE_ACTION.has(a.status)) continue;
    const nowMs = d.now();
    if (!a || a.status !== 'verified') {
      _set(row.id, { status: 'open', action_id: null }, nowMs);
      out.reopened += 1;
      continue;
    }
    try {
      let key = null;
      if (row.item_kind === 'task') {
        const t = d.task(row.item_id);
        const w = t ? d.recordWaiting({ person: row.person, text: t.text, sourceDate: londonDay(nowMs) }) : null;
        key = w && w.key;
        if (t && (t.status === 'open' || t.status === 'in-progress')) {
          const note = `Delegated to ${row.person} on ${londonDay(nowMs)} — tracked in Waiting on.`;
          d.updateTask(t.id, { status: 'dropped', notes: t.notes ? `${t.notes}\n${note}` : note });
        }
      } else {
        const e = (d.emails() || []).find((x) => x.id === row.item_id);
        const w = d.recordWaiting({ person: row.person, text: `Handle the email "${clip(e ? e.subject : 'handed over', 140)}"`, sourceDate: londonDay(nowMs) });
        key = w && w.key;
        d.dismissEmail(row.item_id);
      }
      _set(row.id, { status: 'sent', waiting_key: key }, nowMs);
      out.sent += 1;
    } catch (e) { console.warn(`[Delegation] after-send record for #${row.id} failed: ${e.message}`); }
  }
  return out;
}

module.exports = {
  MAX_OPEN, MAX_JUDGE_PER_PASS, ORIGIN,
  isCandidateEmail, isCandidateTask, buildPrompt, parseAnswer, judge, composeDraft, hashOf,
  list, scan, dismiss, handOver, reconcile, ensureTable,
  _internals: { _windowDays, GAP_RE },
};
