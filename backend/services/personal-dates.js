'use strict';

/**
 * Personal dates with lead time (Build 17L–Q, 7 Oct 2026).
 *
 * "What is coming up, when, who is it, is anything planned, do I need to do
 * anything?" — for birthdays, anniversaries and similar dates NEURO is
 * EXPLICITLY told about. Computed at read time from what already exists; there
 * is no second calendar. The only thing stored is what CHANGED (for Activity)
 * and what the attention policy said (shadow), in `personal_date_events`.
 *
 * ── What counts as a personal date (17L/M — explicit only) ──────────────────
 *   • an event in the phone's BIRTHDAYS calendar — iOS generates it from
 *     Contacts, so the container itself says "this is a birthday";
 *   • an event whose own title SAYS birthday or anniversary — the label on
 *     the event, never a guess from other words ("Tracey's do" is nothing);
 *   • a `birthday:` / `anniversary:` line in a People or Companions note —
 *     Nick's own declaration (none exist on 7 Oct 2026; the reader is ready).
 * Kind is read from those labels. IMPORTANCE and RELATIONSHIP are never
 * inferred: importance only from Nick's annotation (entity
 * `personal-date:<id>`), relationship only from the person's own note.
 *
 * ── Lead time (17N) — conservative, explicit wins ──────────────────────────
 *   birthday 7 days · anniversary 14 days · other 3 days. Nick can set a
 *   date's lead (`setLead`). Outside the lead window a date is `later` —
 *   listed if asked, never on Now, never a prompt.
 *
 * ── States (17O) ───────────────────────────────────────────────────────────
 *   nothing-needed   in the window, nothing planned, nothing known to do
 *   prep-exists      a task that NAMES the person (or the date) is linked —
 *                    open, or already done
 *   action-may-be-needed   that linked task is still OPEN and the date is ≤
 *                    ACTION_DAYS away — the only state that may ask the
 *                    attention policy anything
 *   passed           the day has gone; listed for one day, then leaves
 * NEURO never creates a task for a date (17O). A linked task is shown as
 * "linked by name", because that is all the link is.
 *
 * ── Dedupe (17Q) — strong evidence only ────────────────────────────────────
 * Two sightings are ONE date only when they fall on the same day, are the same
 * kind, and name the same person in FULL (≥2 words, case- and apostrophe-
 * folded) — e.g. the Google "Tracey Allen's birthday" and the Contacts
 * "Tracey Allen’s 16th Birthday". Same day + same first name only, or no name
 * at all, stays separate.
 */

const db = require('../db/database');

const DEFAULT_LEAD = Object.freeze({ birthday: 7, anniversary: 14, other: 3 });
const MAX_LEAD = 60;
const ACTION_DAYS = 2;
const LATER_DAYS = 45;
const KINDS = Object.freeze(['birthday', 'anniversary', 'other']);
const STATES = Object.freeze(['nothing-needed', 'prep-exists', 'action-may-be-needed', 'passed']);
const LEADS_KEY = 'personal_date_leads';
const DAY_MS = 86400000;

function _utc(day) { return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)); }
function addDays(day, n) { return new Date(_utc(day) + n * DAY_MS).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((_utc(b) - _utc(a)) / DAY_MS); }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayName(day) { return DAYS[new Date(_utc(day)).getUTCDay()]; }
function _fold(s) { return String(s || '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim(); }

/** Pure. The kind a title EXPLICITLY states, or null. */
function kindFromTitle(title) {
  const t = _fold(title);
  if (/\bbirthday\b|\bbday\b/i.test(t)) return 'birthday';
  if (/\banniversary\b/i.test(t)) return 'anniversary';
  return null;
}

/** Pure. "Tracey Allen's 16th Birthday" → "Tracey Allen"; null when the title names nobody. */
function personFromTitle(title) {
  const m = _fold(title).match(/^(.+?)'s?\s+(?:\d+(?:st|nd|rd|th)\s+)?(?:birthday|bday|anniversary)\b/i);
  if (!m) return null;
  const name = m[1].replace(/[^\p{L}\p{M}' -]/gu, '').trim();
  return name && !/^(our|my|the|wedding|work)$/i.test(name) ? name : null;
}

/** Pure. A person key that only a FULL name can produce. */
function personKey(name) {
  const n = _fold(name).toLowerCase();
  return n.split(' ').filter(Boolean).length >= 2 ? n : null;
}

/**
 * Pure. Turn raw sightings into personal dates, merging only on strong
 * evidence. sighting: { title, date (YYYY-MM-DD), kind, person, source:{...} }
 */
function dedupe(sightings) {
  const out = new Map();
  for (const s of sightings) {
    const pk = personKey(s.person);
    const key = pk ? `${s.kind}:${pk}:${s.date}` : `${s.kind}:title:${_fold(s.title).toLowerCase()}:${s.date}`;
    const id = `pd:${key}`;
    const held = out.get(id);
    if (held) { held.sources.push(s.source); continue; }
    out.set(id, { id, title: s.title, kind: s.kind, date: s.date, person: s.person || null, recurrence: s.recurrence || 'as-in-calendar',
      sources: [s.source], merged: false });
  }
  for (const d of out.values()) d.merged = d.sources.length > 1;
  return [...out.values()];
}

/** Pure. When a declared MM-DD falls next, from `today`. */
function nextOccurrence(mmdd, today) {
  const m = String(mmdd || '').match(/^(?:\d{4}-|--)?(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = +today.slice(0, 4);
  for (const y of [year, year + 1]) {
    const d = `${y}-${m[1]}-${m[2]}`;
    if (!Number.isFinite(_utc(d)) || new Date(_utc(d)).toISOString().slice(0, 10) !== d) continue; // 29 Feb in a common year
    if (d >= addDays(today, -1)) return d;
  }
  return null;
}

/**
 * Pure. Which tasks look like preparation for a date. A task is linked only
 * when its text NAMES the person in full, or — for a date with no person —
 * contains the date's own label word (birthday / anniversary) AND is due on
 * or before the date. Shown as "linked by name", never as fact.
 */
function linkPrep(date, tasks) {
  const pk = personKey(date.person);
  const out = [];
  for (const t of tasks || []) {
    const text = _fold(t.title).toLowerCase();
    const due = t.due && t.due.date ? t.due.date : null;
    const byName = pk && text.includes(pk);
    const byLabel = !pk && date.kind !== 'other' && new RegExp(`\\b${date.kind}\\b`).test(text) && due && due <= date.date && due >= addDays(date.date, -MAX_LEAD);
    if (byName || byLabel) out.push({ taskId: t.taskId, title: t.title, status: t.status, due, link: byName ? 'names the person' : `mentions the ${date.kind}` });
  }
  return out;
}

/** Pure. One date's state, from the clock and its linked preparation. */
function stateFor(date, { today, lead }) {
  const away = daysBetween(today, date.date);
  if (away < 0) return { state: 'passed', away };
  if (away > lead) return { state: 'later', away };
  const open = date.prep.filter((p) => p.status === 'open');
  if (open.length && away <= ACTION_DAYS) return { state: 'action-may-be-needed', away };
  if (date.prep.length) return { state: 'prep-exists', away };
  return { state: 'nothing-needed', away };
}

/** Pure. One line, from templates. No countdown nagging, no "don't forget". */
function lineFor(date, st) {
  const what = date.kind === 'birthday' ? `${date.person ? `${date.person}'s birthday` : date.title}`
    : date.kind === 'anniversary' ? (date.person ? `${date.person}'s anniversary` : date.title) : date.title;
  const when = st.away === 0 ? 'today' : st.away === 1 ? 'tomorrow' : st.away < 7 ? `on ${dayName(date.date)}` : `on ${dayName(date.date)} ${Number(date.date.slice(8, 10))} ${new Date(_utc(date.date)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  if (st.state === 'passed') return `${cap(what)} was ${st.away === -1 ? 'yesterday' : `on ${dayName(date.date)}`}.`;
  if (st.state === 'action-may-be-needed') return `${cap(what)} is ${when} — "${date.prep.find((p) => p.status === 'open').title}" is still open.`;
  if (st.state === 'prep-exists') {
    const open = date.prep.find((p) => p.status === 'open');
    return open ? `${cap(what)} is ${when}. "${open.title}" is on your list.` : `${cap(what)} is ${when}. "${date.prep[0].title}" is done.`;
  }
  return `${cap(what)} is ${when}.`;
}

// ── readers ─────────────────────────────────────────────────────────────────

function _calendarSightings(fromDay, toDay) {
  const rows = db.all(`SELECT meeting_id, provider, title, start_local, is_all_day, calendar_key, calendar_name FROM wm_meetings
                        WHERE status = 'scheduled' AND merged_into IS NULL AND substr(start_local, 1, 10) >= ? AND substr(start_local, 1, 10) <= ?`, [fromDay, toDay]);
  const out = [];
  for (const r of rows) {
    const inBirthdays = String(r.calendar_name || '').trim().toLowerCase() === 'birthdays';
    const kind = kindFromTitle(r.title) || (inBirthdays ? 'birthday' : null);
    if (!kind) continue;
    // In the Birthdays calendar a bare title IS the contact's name.
    const person = personFromTitle(r.title) || (inBirthdays && !kindFromTitle(r.title) ? _fold(r.title) : null);
    out.push({ title: _fold(r.title), date: String(r.start_local).slice(0, 10), kind, person,
      source: { provider: r.provider, meetingId: r.meeting_id, calendar: r.calendar_name || null, calendarKey: r.calendar_key || null,
        basis: inBirthdays ? 'birthdays-calendar' : 'title-label' } });
  }
  return out;
}

/** People / Companions frontmatter: `birthday:` / `anniversary:` — Nick's own declaration. */
function _declaredSightings(today) {
  const fs = require('fs'); const path = require('path');
  const root = process.env.OBSIDIAN_VAULT_PATH;
  const out = []; const gaps = [];
  if (!root) return { sightings: out, gaps: [{ input: 'vault', why: 'vault path not configured — declared dates unread' }] };
  for (const dir of ['People', 'Companions']) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md') && !f.startsWith('_')); } catch { continue; }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(root, dir, f), 'utf8'); } catch { continue; }
      const fm = text.startsWith('---') ? text.slice(3, Math.max(3, text.indexOf('\n---', 3))) : '';
      const name = f.replace(/\.md$/, '');
      const rel = (fm.match(/^relationship:[ \t]*(.+)$/m) || [])[1] || null;
      for (const kind of ['birthday', 'anniversary']) {
        const m = fm.match(new RegExp(`^${kind}:[ \\t]*["']?([0-9-]+)["']?[ \\t]*$`, 'm'));
        if (!m) continue;
        const date = nextOccurrence(m[1], today);
        if (!date) { gaps.push({ input: `${dir}/${name}`, why: `${kind} "${m[1]}" is not YYYY-MM-DD or MM-DD` }); continue; }
        out.push({ title: `${name}'s ${kind}`, date, kind, person: name, recurrence: 'yearly', relationship: rel ? rel.trim() : null,
          source: { provider: 'vault', note: `${dir}/${name}`, basis: 'declared' } });
      }
    }
  }
  return { sightings: out, gaps };
}

function _leads() { try { return JSON.parse(db.getState(LEADS_KEY) || '{}') || {}; } catch { return {}; } }

function _importance(ids) {
  if (!ids.length) return {};
  try {
    return Object.fromEntries(db.all(`SELECT entity_id, importance FROM life_annotations WHERE entity_id IN (${ids.map(() => '?').join(',')})`, ids.map((id) => `personal-date:${id}`))
      .map((r) => [r.entity_id.replace(/^personal-date:/, ''), r.importance]));
  } catch { return {}; }
}

/** The loop, read now. */
function read({ now = Date.now(), tasks = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = require('./world-model').localMinute(nowMs).slice(0, 10);
  const gaps = [];
  let sightings = [];
  try { sightings = sightings.concat(_calendarSightings(addDays(today, -1), addDays(today, LATER_DAYS))); } catch (e) { gaps.push({ input: 'calendar', why: e.message }); }
  const declared = _declaredSightings(today);
  sightings = sightings.concat(declared.sightings); gaps.push(...declared.gaps);
  let taskList = tasks;
  if (!taskList) {
    try { taskList = require('./world-obligations').listTasks({ status: 'all', limit: 2000 }).filter((t) => t.status === 'open' || (t.completedAt && Date.parse(t.completedAt) >= nowMs - 60 * DAY_MS)); } catch (e) { taskList = []; gaps.push({ input: 'tasks', why: e.message }); }
  }
  const leads = _leads();
  const dates = dedupe(sightings);
  const imp = _importance(dates.map((d) => d.id));
  const shaped = dates.map((d) => {
    const lead = Number.isInteger(leads[d.id]) ? leads[d.id] : DEFAULT_LEAD[d.kind] || DEFAULT_LEAD.other;
    const relationship = (sightings.find((s) => personKey(s.person) && personKey(s.person) === personKey(d.person) && s.relationship) || {}).relationship || null;
    const full = { ...d, lead, leadBasis: Number.isInteger(leads[d.id]) ? 'set' : 'default', importance: imp[d.id] || null,
      importanceBasis: imp[d.id] ? 'declared' : null, relationship, relationshipBasis: relationship ? 'declared' : null, prep: linkPrep(d, taskList) };
    const st = stateFor(full, { today, lead });
    return { ...full, ...st, line: lineFor(full, st) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return {
    today,
    active: shaped.filter((d) => !['later', 'passed'].includes(d.state)),
    later: shaped.filter((d) => d.state === 'later'),
    passed: shaped.filter((d) => d.state === 'passed' && d.away === -1),
    defaults: DEFAULT_LEAD, gaps,
    rule: 'Only dates a calendar or your notes explicitly call a birthday or anniversary. Importance and relationships are never guessed.',
  };
}

// ── what changed → personal_date_events (Activity), and the attention verdict ──

function _event(dateId, kind, key, detail, at, actor = 'neuro') {
  return db.run(`INSERT OR IGNORE INTO personal_date_events (date_id, kind, dedupe_key, actor, at, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
    [dateId, kind, `${dateId}:${kind}:${key}`, actor, at, JSON.stringify(detail || {})]).changes;
}

/**
 * Record transitions once and ask the attention policy (SHADOW — rule
 * `personal-date`, never offered by deliver()) only for a date whose state is
 * action-may-be-needed. Idempotent. Never sends anything; never creates a task.
 */
async function refresh({ now = Date.now(), deps = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const at = new Date(nowMs).toISOString();
  const r = read({ now: nowMs, tasks: deps.tasks || null });
  let written = 0; let asked = 0;
  for (const d of r.active) {
    for (const p of d.prep) {
      written += _event(d.id, 'prep-linked', p.taskId, { date: d.date, title: d.title, task: p.title, link: p.link }, at);
      if (p.status === 'completed') written += _event(d.id, 'prep-completed', p.taskId, { date: d.date, title: d.title, task: p.title }, at);
    }
    if (d.state === 'action-may-be-needed') {
      const n = _event(d.id, 'action-window', d.date, { date: d.date, title: d.title, line: d.line }, at);
      written += n;
      if (n) {
        let decision;
        try {
          const { moment } = await (deps.readMoment ? deps.readMoment(nowMs) : require('./ambient-push').readMoment({ now: new Date(nowMs) }));
          const v = require('./ambient-push').worthInterrupting({ kind: 'personal-date', text: d.line, dateId: d.id }, moment);
          decision = { push: !!v.push, why: v.why || null, wouldSay: v.push ? v.message : null };
        } catch (e) { decision = { push: false, why: `could not read the moment: ${e.message}` }; }
        _event(d.id, 'attention', d.date, { ...decision, shadow: true, sent: false }, at);
        asked += 1;
      }
    }
  }
  return { written, asked, active: r.active.length };
}

/** Nick sets how far ahead a date should show (1–60 days); null returns it to the default. */
function setLead(id, days, { now = Date.now() } = {}) {
  if (!/^pd:/.test(String(id || ''))) return { ok: false, status: 400, error: 'id must be a personal date id (pd:…)' };
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= MAX_LEAD)) return { ok: false, status: 400, error: `days must be a whole number from 1 to ${MAX_LEAD}, or null` };
  const leads = _leads();
  if (days === null) delete leads[id]; else leads[id] = days;
  db.setState(LEADS_KEY, JSON.stringify(leads));
  _event(id, 'lead-set', `${days}:${Date.now()}`, { days }, new Date(now instanceof Date ? now.getTime() : now).toISOString(), 'nick');
  return { ok: true, id, days };
}

function events({ since = null, limit = 200 } = {}) {
  return (since
    ? db.all('SELECT * FROM personal_date_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?', [since, limit])
    : db.all('SELECT * FROM personal_date_events ORDER BY at DESC, id DESC LIMIT ?', [limit]))
    .map((r) => ({ id: r.id, dateId: r.date_id, kind: r.kind, actor: r.actor, at: r.at, detail: JSON.parse(r.detail_json || '{}') }));
}

module.exports = {
  DEFAULT_LEAD, MAX_LEAD, ACTION_DAYS, KINDS, STATES,
  kindFromTitle, personFromTitle, personKey, dedupe, nextOccurrence, linkPrep, stateFor, lineFor,
  read, refresh, setLead, events,
};
