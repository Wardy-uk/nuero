'use strict';

/**
 * Delegating tasks by hand (6 Nov 2026) — Nick: "add a delegate function to
 * tasks. I should be able to delegate one specifically, or combine a couple into
 * one single delegation. These should then sit in Commitments, not Tasks, but be
 * clearly ID'd as tasks I've specifically delegated."
 *
 * services/delegation.js is NEURO SUGGESTING a hand-over (one item, a model call,
 * a high bar). This is Nick CHOOSING: one task or several, NEURO or Microsoft,
 * to one direct report, as ONE delegation.
 *
 * TWO WAYS TO HAND OVER
 *   email — the same governed compose_email the suggestion path uses (origin
 *           `delegation`, one press via intent grant). The tasks leave his list
 *           only once the send is READ BACK as verified (reconcile), never on
 *           "executed". A [gap] left in the draft refuses.
 *   told  — he already told them (in a 1-2-1, on Teams). Recorded at once; no
 *           email is invented.
 *
 * WHAT A DELEGATION DOES (one record, `task_delegations`)
 *   - ONE waiting_on row: what <person> now owes Nick. One task → its wording;
 *     several → the wordings joined. That row is what the world model projects
 *     into Commitments (owed to me), so this adds no second commitments store.
 *   - each NEURO task → `dropped` with a note naming who has it (the suggestion
 *     path's decision: the task list is what NICK does);
 *   - each Microsoft task → a private `delegated` marker in ms-task-local, which
 *     hides the mirror line. Microsoft is NOT told (the board is shared and
 *     NEURO cannot edit most of it).
 *   A NEURO task linked to a Microsoft one marks both.
 *
 * LABELLING — `byWaitingKey()` is the ONE answer to "is this commitment a
 * delegation, of what": it reads this table AND the suggestion path's sent rows
 * (delegation_suggestions.waiting_key), so a hand-over made either way is
 * labelled the same way, with the task ids.
 *
 * TAKE BACK — closes the waiting_on row (dropped), reopens the NEURO tasks that
 * are still dropped, clears the Microsoft markers. Works for both sources.
 */

const crypto = require('crypto');

const ORIGIN = 'delegation';
const MAX_ITEMS = 8;
const LIVE_ACTION = new Set(['prepared', 'approved', 'executing', 'executed', 'execution_uncertain']);
const GAP_RE = /\[[^\]\n]{1,60}\]/g;
const VIA = ['email', 'told'];

let ensured = false;
function _db() { return require('../db/database'); }
function _hasTable(name) {
  try { return !!_db().get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]); } catch { return false; }
}
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const londonDay = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);

function ensureTable() {
  if (ensured) return;
  _db().run(`CREATE TABLE IF NOT EXISTS task_delegations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    person       TEXT NOT NULL,
    items_json   TEXT NOT NULL,
    via          TEXT NOT NULL CHECK(via IN ('email','told')),
    status       TEXT NOT NULL CHECK(status IN ('prepared','delegated','cancelled','taken-back')),
    action_id    TEXT,
    waiting_key  TEXT,
    created_at   TEXT NOT NULL,
    delegated_at TEXT,
    decided_at   TEXT,
    reason       TEXT
  )`);
  _db().run('CREATE INDEX IF NOT EXISTS idx_task_delegations_status ON task_delegations(status)');
  ensured = true;
}

// ── PURE ────────────────────────────────────────────────────────────────────

/** "Thu 6 Nov" from YYYY-MM-DD, sliced, never parsed into a zone. */
function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${+m[3]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1]}`;
}

/** The waiting_on wording for a delegation: what the person now owes Nick. */
function commitmentText(items) {
  if (items.length === 1) return clip(items[0].title, 400);
  return clip(items.map((i) => i.title).join('; '), 400);
}

/** "#493", "Planner" — how one delegated item is named on a card. */
function itemLabel(i) {
  if (i.kind === 'task') return `#${i.id}`;
  return i.source ? String(i.source).replace(/^MS\s+/, '') : 'Microsoft';
}

/**
 * The hand-over email. PURE, a template — only what NEURO holds. What done looks
 * like is a [details] gap; by when is the EARLIEST due date of the tasks, else a
 * [date] gap. The send refuses while either remains.
 */
function composeDraft({ person, items }) {
  const first = String(person || '').split(/\s+/)[0] || person;
  const one = items.length === 1;
  const subject = one
    ? `Could you take this on? ${clip(items[0].title, 90)}`
    : `Could you take these on? ${clip(items[0].title, 60)} + ${items.length - 1} more`;
  const lines = [`Hi ${first},`, '', one ? 'Could you pick this up for me, please?' : `Could you pick these ${items.length} up for me, please?`, ''];
  if (one) {
    lines.push(`What it is: ${clip(items[0].title, 400)}`);
    if (items[0].notes) lines.push('', `Context: ${clip(items[0].notes, 1200)}`);
  } else {
    for (const i of items) lines.push(`- ${clip(i.title, 300)}${i.due ? ` (due ${dayLabel(i.due)})` : ''}`);
  }
  const dues = items.map((i) => i.due).filter(Boolean).sort();
  lines.push('', 'What done looks like: [details]', `By when: ${dues.length ? dayLabel(dues[0]) : '[date]'}`, '',
    'Happy to talk it through if that helps — just grab me.', '', 'Thanks,', 'Nick');
  return { subject, body: lines.join('\n') };
}

/** Items from a request body: [{kind:'task'|'ms', id}], deduped, refused not repaired. */
function parseItems(raw) {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'choose at least one task' };
  if (raw.length > MAX_ITEMS) return { ok: false, error: `at most ${MAX_ITEMS} tasks in one delegation` };
  const out = []; const seen = new Set();
  for (const r of raw) {
    const kind = r && r.kind; const id = r && r.id != null ? String(r.id).trim() : '';
    if (!['task', 'ms'].includes(kind) || !id) return { ok: false, error: 'each item needs kind task|ms and an id' };
    if (kind === 'task' && !/^\d+$/.test(id)) return { ok: false, error: `"${id}" is not a NEURO task id` };
    const k = `${kind}:${id}`;
    if (!seen.has(k)) { seen.add(k); out.push({ kind, id }); }
  }
  return { ok: true, items: out };
}

// ── deps ────────────────────────────────────────────────────────────────────

function _defaultDeps() {
  return {
    reports: () => require('./team-roster').directReports(),
    leaveFor: (name) => { const ta = require('./team-availability'); return ta.daysOffFor(name, ta.snapshot()); },
    task: (id) => require('./task-store').getTask(Number(id)),
    jiraOwned: (id) => { try { return require('./jira-tasks').isJiraOwned(Number(id)); } catch { return false; } },
    msTasks: () => (require('./obsidian').parseVaultTodos().active || []).filter((t) => t.ms_id && !t.task_id),
    getAction: (id) => require('./prepared-actions').get(id),
    prepareCompose: (a) => require('./prepared-actions').prepareCompose(a),
    recordWaiting: (a) => require('./waiting-on').record(a),
    openWaiting: (key) => require('./waiting-on').openForDelegation(key),
    resolveWaiting: (key, s) => require('./waiting-on').resolve(key, s),
    updateTask: (id, f) => require('./task-store').updateTask(id, f),
    setMsLocal: (msId, f) => require('./ms-task-local').set(msId, f),
    msLocal: (msId) => require('./ms-task-local').get(msId),
    now: () => Date.now(),
  };
}
const _d = (over) => ({ ..._defaultDeps(), ...(over || {}) });

function _people(d) {
  let reports = [];
  try { reports = d.reports() || []; } catch { reports = []; }
  return reports.filter((p) => p && p.name && !p.archived);
}

/** Who Nick can delegate to: his live direct reports, with leave over the next 7 days said, never refused. */
function people({ deps } = {}) {
  const d = _d(deps);
  const nowMs = d.now();
  const days = []; for (let i = 0; i < 7; i += 1) days.push(londonDay(nowMs + i * 86400000));
  return _people(d).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    let leave = null;
    try {
      const off = d.leaveFor(p.name);
      if (!off || !off.known) leave = { known: false, say: 'leave could not be checked' };
      else {
        const away = days.filter((x) => off.dates.has(x));
        leave = { known: true, away, say: away.length ? `on leave ${dayLabel(away[0])}${away.length > 1 ? ` (+${away.length - 1} more day${away.length > 2 ? 's' : ''})` : ''}` : null };
      }
    } catch { leave = { known: false, say: 'leave could not be checked' }; }
    return { name: p.name, first: p.name.split(/\s+/)[0], email: p.email || null, team: p.group || p.team || null, leave };
  });
}

/** Item keys already in a live delegation (prepared or delegated). */
function _busyKeys() {
  ensureTable();
  const out = new Map();
  for (const r of _db().all("SELECT id, items_json, status FROM task_delegations WHERE status IN ('prepared','delegated')")) {
    let items = []; try { items = JSON.parse(r.items_json) || []; } catch { items = []; }
    for (const i of items) out.set(`${i.kind}:${i.id}`, r);
  }
  return out;
}

/** Resolve requested items against what NEURO holds now. Refuses anything not open or already handed over. */
function resolveItems(raw, d) {
  const p = parseItems(raw);
  if (!p.ok) return { ok: false, code: 400, error: p.error };
  const busy = _busyKeys();
  let ms = null;
  const out = [];
  for (const it of p.items) {
    if (busy.has(`${it.kind}:${it.id}`)) {
      const r = busy.get(`${it.kind}:${it.id}`);
      return { ok: false, code: 409, error: `${it.kind === 'task' ? `#${it.id}` : 'that Microsoft task'} is already ${r.status === 'prepared' ? 'in a hand-over email waiting to send' : 'delegated'}` };
    }
    if (it.kind === 'task') {
      const t = d.task(it.id);
      if (!t) return { ok: false, code: 404, error: `no task #${it.id}` };
      if (!(t.status === 'open' || t.status === 'in-progress')) return { ok: false, code: 409, error: `#${it.id} is ${t.status}` };
      if (d.jiraOwned(it.id)) return { ok: false, code: 409, error: `#${it.id} is a Jira ticket — reassign it in Jira` };
      out.push({ kind: 'task', id: String(t.id), title: clip(t.text, 300), due: t.due_date || null, notes: t.notes ? clip(t.notes, 1200) : null, msId: t.ms_id || null });
    } else {
      if (!ms) { try { ms = d.msTasks() || []; } catch (e) { return { ok: false, code: 503, error: `could not read your Microsoft tasks — ${e.message}` }; } }
      const t = ms.find((x) => String(x.ms_id) === it.id);
      if (!t) return { ok: false, code: 404, error: 'that Microsoft task is not open on your list (or is already delegated)' };
      out.push({ kind: 'ms', id: it.id, title: clip(t.text, 300), due: t.due_date || null, notes: null, source: t.source || null, plan: t.msPlan || null });
    }
  }
  return { ok: true, items: out };
}

function _person(name, d) {
  const clean = String(name || '').trim().toLowerCase();
  return _people(d).find((p) => p.name.toLowerCase() === clean) || null;
}

/** The draft for a delegation, before anything is sent or recorded. */
function draft({ person, items, deps } = {}) {
  const d = _d(deps);
  const p = _person(person, d);
  if (!p) return { ok: false, code: 400, error: `${person || 'nobody'} is not one of your current direct reports` };
  const r = resolveItems(items, d);
  if (!r.ok) return r;
  return { ok: true, person: p.name, email: p.email || null, items: r.items.map(({ notes, ...i }) => ({ ...i, label: itemLabel(i) })), draft: composeDraft({ person: p.name, items: r.items }) };
}

function _insert({ person, items, via, status, actionId = null, nowMs }) {
  ensureTable();
  const iso = new Date(nowMs).toISOString();
  const store = items.map(({ notes, ...i }) => i);
  const r = _db().run(`INSERT INTO task_delegations (person, items_json, via, status, action_id, created_at) VALUES (?,?,?,?,?,?)`,
    [person, JSON.stringify(store), via, status, actionId, iso]);
  return Number(r.lastInsertRowid);
}

function _row(id) { ensureTable(); return _db().get('SELECT * FROM task_delegations WHERE id = ?', [Number(id)]); }
function _set(id, fields, nowMs) {
  const cols = Object.keys(fields);
  _db().run(`UPDATE task_delegations SET ${cols.map((c) => `${c} = ?`).join(', ')}, decided_at = ? WHERE id = ?`,
    [...cols.map((c) => fields[c]), new Date(nowMs).toISOString(), Number(id)]);
}

/**
 * Delegate. `via: told` records at once. `via: email` prepares the governed
 * email and returns the action for the client to send with one intent grant.
 */
function delegate({ person, items, via = 'email', subject, body, deps } = {}) {
  const d = _d(deps);
  if (!VIA.includes(via)) return { ok: false, code: 400, error: `via must be ${VIA.join(' or ')}` };
  const p = _person(person, d);
  if (!p) return { ok: false, code: 400, error: `${person || 'nobody'} is not one of your current direct reports` };
  const r = resolveItems(items, d);
  if (!r.ok) return r;
  const nowMs = d.now();
  if (via === 'told') {
    const id = _insert({ person: p.name, items: r.items, via, status: 'prepared', nowMs });
    const done = _complete(_row(id), d, nowMs);
    return { ok: true, id, status: 'delegated', waitingKey: done.waitingKey, notes: done.notes };
  }
  if (!p.email) return { ok: false, code: 409, error: `${p.name} has no email address in their People note — use "I’ve told them" or add one` };
  const dr = composeDraft({ person: p.name, items: r.items });
  const subj = String(subject == null ? dr.subject : subject).trim();
  const text = String(body == null ? dr.body : body).replace(/\r\n/g, '\n').trim();
  const gaps = [...new Set([...(`${subj}\n${text}`.match(GAP_RE) || [])])];
  if (gaps.length) return { ok: false, code: 409, error: `fill in ${gaps.join(', ')} before sending`, gaps };
  const id = _insert({ person: p.name, items: r.items, via, status: 'prepared', nowMs });
  const pr = d.prepareCompose({
    from: 'work', to: [{ name: p.name, email: p.email }], subject: subj, body: text, origin: ORIGIN,
    generatedBy: 'template (task delegation, edited by Nick)',
    evidence: { taskDelegationId: id, person: p.name, items: r.items.map((i) => `${i.kind}:${i.id}`) },
    now: nowMs,
  });
  if (!pr.ok) { _set(id, { status: 'cancelled', reason: pr.error || 'the email could not be prepared' }, nowMs); return pr; }
  _set(id, { action_id: pr.action.actionId }, nowMs);
  return { ok: true, id, status: 'prepared', action: pr.action };
}

/** Make it so: the waiting_on row, NEURO tasks dropped, Microsoft tasks marked. */
function _complete(row, d, nowMs) {
  let items = []; try { items = JSON.parse(row.items_json) || []; } catch { items = []; }
  const day = londonDay(nowMs);
  const w = d.recordWaiting({ person: row.person, text: commitmentText(items), sourceDate: day });
  const key = w && w.key;
  if (key && w.status !== 'open') d.openWaiting(key);
  const notes = [];
  const marker = { to: row.person, at: new Date(nowMs).toISOString(), id: row.id };
  for (const i of items) {
    try {
      if (i.kind === 'task') {
        const t = d.task(i.id);
        if (t && (t.status === 'open' || t.status === 'in-progress')) {
          const note = `Delegated to ${row.person} on ${day} — in Commitments → Delegated.`;
          d.updateTask(t.id, { status: 'dropped', notes: t.notes ? `${t.notes}\n${note}` : note });
        }
        if (t && t.ms_id) d.setMsLocal(t.ms_id, { delegated: marker });
      } else {
        d.setMsLocal(i.id, { delegated: marker });
      }
    } catch (e) { notes.push(`${itemLabel(i)}: ${e.message}`); }
  }
  _set(row.id, { status: 'delegated', waiting_key: key || null, delegated_at: new Date(nowMs).toISOString() }, nowMs);
  return { waitingKey: key, notes };
}

/** Read prepared hand-over emails back: VERIFIED → delegated; failed / rejected / gone → cancelled. */
function reconcile({ deps } = {}) {
  const out = { delegated: 0, cancelled: 0 };
  // Called on every Commitments read: with no table there is nothing to read
  // back, and creating one here would make a read write.
  if (!_hasTable('task_delegations')) return out;
  const d = _d(deps);
  for (const row of _db().all("SELECT * FROM task_delegations WHERE status = 'prepared' AND action_id IS NOT NULL")) {
    let a = null; try { a = d.getAction(row.action_id); } catch { a = null; }
    if (a && LIVE_ACTION.has(a.status)) continue;
    const nowMs = d.now();
    if (!a || a.status !== 'verified') {
      _set(row.id, { status: 'cancelled', reason: a ? `the email was ${a.status}` : 'the email is gone' }, nowMs);
      out.cancelled += 1;
      continue;
    }
    try { _complete(row, d, nowMs); out.delegated += 1; }
    catch (e) { console.warn(`[TaskDelegation] after-send record for #${row.id} failed: ${e.message}`); }
  }
  return out;
}

/**
 * waiting key → the delegation behind it, from BOTH paths. `items` carry the
 * task ids, so a card can say "#493". An unreadable table yields what it can.
 */
function byWaitingKey({ deps } = {}) {
  const d = _d(deps);
  const out = new Map();
  // ⚠ A READ MUST NOT CREATE TABLES (build29 "reads write nothing"). A table that
  // does not exist yet means no delegation was ever made — a true empty answer.
  const has = _hasTable;
  try {
    if (!has('task_delegations')) throw Object.assign(new Error('none yet'), { quiet: true });
    for (const r of _db().all("SELECT * FROM task_delegations WHERE status = 'delegated' AND waiting_key IS NOT NULL")) {
      let items = []; try { items = JSON.parse(r.items_json) || []; } catch { items = []; }
      out.set(r.waiting_key, { key: r.waiting_key, source: 'manual', id: r.id, to: r.person, at: r.delegated_at, via: r.via,
        items: items.map((i) => ({ kind: i.kind, id: i.id, title: i.title, label: itemLabel(i) })) });
    }
  } catch (e) { if (!e.quiet) console.warn(`[TaskDelegation] read failed: ${e.message}`); }
  try {
    if (!has('delegation_suggestions')) throw Object.assign(new Error('none yet'), { quiet: true });
    for (const r of _db().all("SELECT * FROM delegation_suggestions WHERE status = 'sent' AND waiting_key IS NOT NULL")) {
      if (out.has(r.waiting_key)) continue;
      let title = null;
      if (r.item_kind === 'task') { try { const t = d.task(r.item_id); title = t ? clip(t.text, 300) : null; } catch { title = null; } }
      const item = r.item_kind === 'task'
        ? { kind: 'task', id: String(r.item_id), title, label: `#${r.item_id}` }
        : { kind: 'email', id: String(r.item_id), title: null, label: 'email' };
      out.set(r.waiting_key, { key: r.waiting_key, source: 'suggestion', id: r.id, to: r.person, at: r.decided_at, via: 'email', items: [item] });
    }
  } catch (e) { if (!e.quiet) console.warn(`[TaskDelegation] suggestion read failed: ${e.message}`); }
  return out;
}

/**
 * Take a delegation back, by its waiting key (either path). The waiting_on row
 * is dropped; NEURO tasks still dropped come back open; Microsoft markers clear.
 */
function takeBack(key, { deps } = {}) {
  const d = _d(deps);
  const del = byWaitingKey({ deps }).get(String(key || ''));
  if (!del) return { ok: false, code: 404, error: 'no delegation behind that commitment' };
  const nowMs = d.now();
  const notes = [];
  for (const i of del.items) {
    try {
      if (i.kind === 'task') {
        const t = d.task(i.id);
        if (t && t.status === 'dropped') {
          const note = `Taken back from ${del.to} on ${londonDay(nowMs)}.`;
          d.updateTask(t.id, { status: 'open', notes: t.notes ? `${t.notes}\n${note}` : note });
        }
        if (t && t.ms_id && d.msLocal(t.ms_id)) d.setMsLocal(t.ms_id, { delegated: null });
      } else if (i.kind === 'ms') {
        d.setMsLocal(i.id, { delegated: null });
      }
    } catch (e) { notes.push(`${i.label}: ${e.message}`); }
  }
  d.resolveWaiting(String(key), 'dropped');
  if (del.source === 'manual') _set(del.id, { status: 'taken-back' }, nowMs);
  else { try { _db().run("UPDATE delegation_suggestions SET status = 'closed', reason = 'taken back', decided_at = ? WHERE id = ?", [new Date(nowMs).toISOString(), del.id]); } catch (e) { notes.push(e.message); } }
  return { ok: true, notes };
}

/** Hand-over emails prepared but not yet read back — so a card can say "waiting for Sent Items". */
function pending() {
  ensureTable();
  return _db().all("SELECT id, person, items_json, action_id, created_at FROM task_delegations WHERE status = 'prepared'").map((r) => {
    let items = []; try { items = JSON.parse(r.items_json) || []; } catch { items = []; }
    return { id: r.id, person: r.person, actionId: r.action_id, at: r.created_at, items: items.map((i) => ({ kind: i.kind, id: i.id, label: itemLabel(i) })) };
  });
}

module.exports = {
  ORIGIN, MAX_ITEMS,
  composeDraft, commitmentText, parseItems, itemLabel, dayLabel,
  people, draft, delegate, reconcile, byWaitingKey, takeBack, pending, ensureTable,
};
