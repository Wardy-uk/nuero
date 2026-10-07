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

// ── Build 18P: how much of the truth this list can see ─────────────────────
//
// "These are all your upcoming birthdays" is a claim about COVERAGE, and the
// list had no idea what it covered. Measured 7 Oct 2026: the phone pushes 14
// days ahead while this reads 45 ahead and a lead can be 60 — so a birthday
// 20 days out in the phone's Birthdays calendar was simply invisible, and the
// list looked complete anyway. Now the list says what it is.
//
//   complete  a phone calendar push is fresh, it looks at least as far ahead
//             as the furthest lead in use, the Birthdays calendar is visible,
//             and the notes were readable
//   partial   any of those is false — and each reason is named
//   unknown   no push has ever recorded coverage (an older app build)
const HEADING_COMPLETE = 'Upcoming birthdays and anniversaries';
const HEADING_PARTIAL = 'Known dates from currently available sources';

/**
 * PURE. calendar: [{ client, fresh, aheadDays, birthdays: 'seen'|'kept-out'|'not-visible'|null }]
 */
function coverageVerdict({ calendar = [], notesReadable = true, neededAhead = DEFAULT_LEAD.anniversary } = {}) {
  const reasons = [];
  const measured = calendar.filter((c) => Number.isFinite(c.aheadDays));
  const fresh = measured.filter((c) => c.fresh);
  if (!calendar.length || !measured.length) {
    reasons.push('NEURO has not yet measured what the phone\'s calendar push covers — that starts with its next push — so dates from the phone may be missing.');
  } else if (!fresh.length) {
    reasons.push('The phone calendar has not pushed recently, so anything added or removed on the phone since then is not reflected.');
  }
  const horizon = fresh.length ? Math.max(...fresh.map((c) => c.aheadDays)) : measured.length ? Math.max(...measured.map((c) => c.aheadDays)) : null;
  if (horizon != null && horizon < neededAhead) {
    reasons.push(`The phone only sends ${horizon} days ahead, but a date can need ${neededAhead} days' notice — anything further out on the phone cannot be seen yet.`);
  }
  const bd = calendar.map((c) => c.birthdays).filter(Boolean);
  if (bd.length && !bd.includes('seen')) {
    reasons.push(bd.includes('kept-out') ? 'The Birthdays calendar is set to Ignore on Life, so contacts\' birthdays are not read.'
      : 'The phone is not showing NEURO a Birthdays calendar, so contacts\' birthdays are not read.');
  }
  if (!notesReadable) reasons.push('The vault could not be read, so birthdays written in People and Companions notes are missing.');
  const state = !measured.length ? 'unknown' : reasons.length ? 'partial' : 'complete';
  return { state, heading: state === 'complete' ? HEADING_COMPLETE : HEADING_PARTIAL, reasons, horizonDays: horizon, neededAhead };
}

function _coverage(neededAhead) {
  const calendar = [];
  try {
    const cov = require('./apple-ingest').calendarCoverage();
    const health = Object.fromEntries(db.all("SELECT source_id, freshness FROM source_health WHERE source_id LIKE 'eventkit.%'").map((r) => [r.source_id, r.freshness]));
    for (const c of cov.clients) {
      const bdays = c.calendars.filter((k) => k.type === 'birthday' || String(k.title || '').trim().toLowerCase() === 'birthdays');
      calendar.push({ client: c.client, aheadDays: c.aheadDays, at: c.at,
        fresh: health[`eventkit.${/-ios$/.test(c.client) ? c.client : `${c.client}-ios`}`] === 'fresh' || (c.ageHours != null && c.ageHours <= 12),
        birthdays: !bdays.length ? 'not-visible' : bdays.some((k) => k.kept === 'kept') ? 'seen' : 'kept-out' });
    }
  } catch { /* no coverage readable → unknown */ }
  const notesReadable = !!process.env.OBSIDIAN_VAULT_PATH && (() => { try { require('fs').accessSync(require('path').join(process.env.OBSIDIAN_VAULT_PATH, 'People')); return true; } catch { return false; } })();
  return { ...coverageVerdict({ calendar, notesReadable, neededAhead }), calendar };
}

/**
 * Build 18S, PURE. The same person and kind on DIFFERENT days across explicit
 * sources is a CONFLICT: shown, never resolved by picking one. Only a full
 * name can make two sightings "the same person" (personKey).
 */
function markConflicts(dates) {
  const groups = new Map();
  for (const d of dates) {
    const pk = personKey(d.person);
    if (!pk) continue;
    const k = `${d.kind}:${pk}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  for (const list of groups.values()) {
    const days = [...new Set(list.map((d) => d.date.slice(5)))];
    if (days.length < 2) continue;
    for (const d of list) {
      d.conflict = { otherDates: list.filter((o) => o !== d).map((o) => ({ date: o.date, sources: o.sources.map((s) => s.basis) })),
        note: `Your sources disagree about ${d.person}'s ${d.kind} — NEURO has not picked one.` };
    }
  }
  return dates;
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
function read({ now = Date.now(), tasks = null, deps = {} } = {}) {
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
  const dates = markConflicts(dedupe(sightings));
  const imp = _importance(dates.map((d) => d.id));
  const shaped = dates.map((d) => {
    const lead = Number.isInteger(leads[d.id]) ? leads[d.id] : DEFAULT_LEAD[d.kind] || DEFAULT_LEAD.other;
    const relationship = (sightings.find((s) => personKey(s.person) && personKey(s.person) === personKey(d.person) && s.relationship) || {}).relationship || null;
    const full = { ...d, lead, leadBasis: Number.isInteger(leads[d.id]) ? 'set' : 'default', importance: imp[d.id] || null,
      importanceBasis: imp[d.id] ? 'declared' : null, relationship, relationshipBasis: relationship ? 'declared' : null, prep: linkPrep(d, taskList) };
    const st = stateFor(full, { today, lead });
    const line = lineFor(full, st);
    return { ...full, ...st, line: full.conflict ? `${line} ${full.conflict.note}` : line };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const neededAhead = Math.max(DEFAULT_LEAD.anniversary, ...Object.values(leads).filter(Number.isInteger));
  const coverage = deps.coverage || _coverage(neededAhead);
  return {
    today,
    heading: coverage.heading,
    coverage,
    complete: coverage.state === 'complete',
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

// ── Build 18Q: Nick states a birthday or anniversary on a People/Companion note ──
//
// ⚠ EXPLICIT ONLY, AND ON A NOTE THAT ALREADY EXISTS. This never creates a
// person, never infers a date from anything, and never creates a calendar
// event. The note is the record (it is Nick's own declaration in his own
// vault); `personal_date_events` records that NEURO wrote it, and when.
// ⚠ REMOVAL REMOVES THE LINE and nothing recreates it: read() derives dates
// from what the note says NOW, and never from the event history.
// ⚠ A CONFLICT IS REPORTED, NOT REFUSED: if the phone's calendar names the same
// person (by full name) on another day, Nick's declaration is still written —
// it is his — and read() shows both, unresolved.

const DECLARED_DIRS = ['People', 'Companions'];

/** PURE. A date Nick typed → the stored form, or an error. YYYY-MM-DD or MM-DD. */
function parseDeclaredDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, error: 'date must be YYYY-MM-DD or MM-DD' };
  const y = m[1] ? +m[1] : 2000; // a leap year, so 02-29 is allowed without a year
  const d = new Date(Date.UTC(y, +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return { ok: false, error: `${s} is not a real date` };
  if (m[1] && (y < 1900 || y > 2100)) return { ok: false, error: 'year must be between 1900 and 2100' };
  return { ok: true, value: s };
}

function _notePath(entity) {
  const path = require('path');
  const root = process.env.OBSIDIAN_VAULT_PATH;
  if (!root) return { ok: false, status: 503, error: 'vault not configured' };
  const m = String(entity || '').match(/^(People|Companions)\/([^/\\]{1,120})$/);
  if (!m || m[2].includes('..') || m[2].startsWith('_') || m[2].startsWith('.')) return { ok: false, status: 400, error: 'entity must be People/<Name> or Companions/<Name>' };
  const file = path.join(root, m[1], `${m[2]}.md`);
  if (!require('fs').existsSync(file)) return { ok: false, status: 404, error: `${entity} has no note — create the note first; NEURO does not create people` };
  return { ok: true, file, dir: m[1], name: m[2] };
}

/** The People and Companions NEURO could attach a date to, with what each declares. */
function declaredEntities() {
  const fs = require('fs'); const path = require('path');
  const root = process.env.OBSIDIAN_VAULT_PATH;
  if (!root) return { ok: false, error: 'vault not configured', entities: [] };
  const out = [];
  for (const dir of DECLARED_DIRS) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md') && !f.startsWith('_')); } catch { continue; }
    for (const f of files) {
      let fm = '';
      try { const t = fs.readFileSync(path.join(root, dir, f), 'utf8'); fm = t.startsWith('---') ? t.slice(3, Math.max(3, t.indexOf('\n---', 3))) : ''; } catch { continue; }
      const val = (k) => ((fm.match(new RegExp(`^${k}:[ \\t]*["']?([0-9-]+)["']?[ \\t]*$`, 'm')) || [])[1] || null);
      out.push({ entity: `${dir}/${f.replace(/\.md$/, '')}`, kind: dir === 'People' ? 'person' : 'companion', birthday: val('birthday'), anniversary: val('anniversary') });
    }
  }
  return { ok: true, entities: out.sort((a, b) => a.entity.localeCompare(b.entity)) };
}

/**
 * Set (date) or remove (date === null) a declared birthday/anniversary.
 * Returns { ok, changed, previous, value, conflicts }.
 */
function setDeclared({ entity, kind, date } = {}, { now = Date.now() } = {}) {
  if (!['birthday', 'anniversary'].includes(kind)) return { ok: false, status: 400, error: 'kind must be birthday or anniversary' };
  const where = _notePath(entity);
  if (!where.ok) return where;
  let value = null;
  if (date !== null) {
    const p = parseDeclaredDate(date);
    if (!p.ok) return { ok: false, status: 400, error: p.error };
    value = p.value;
  }
  const fs = require('fs');
  const fe = require('./frontmatter-edit');
  const text = fs.readFileSync(where.file, 'utf8');
  const fm = text.startsWith('---') ? text.slice(3, Math.max(3, text.indexOf('\n---', 3))) : '';
  const previous = (fm.match(new RegExp(`^${kind}:[ \\t]*["']?([0-9-]+)["']?[ \\t]*$`, 'm')) || [])[1] || null;
  const hasLine = new RegExp(`^${kind}:`, 'm').test(fm);
  if (value === previous && (value !== null || !hasLine)) return { ok: true, changed: false, previous, value, conflicts: [] };
  const next = value === null ? fe.removeFrontmatterKey(text, kind) : fe.upsertFrontmatterValue(text, kind, value);
  fs.writeFileSync(where.file, next, 'utf8');
  const at = new Date(now instanceof Date ? now.getTime() : now).toISOString();
  _event(`declared:${entity}:${kind}`, value === null ? 'declared-removed' : 'declared-set', `${value}:${at}`,
    { entity, kind, date: value, previous, title: `${where.name}'s ${kind}` }, at, 'nick');
  // Conservative duplicate/conflict check — FULL-name match only, against what
  // the phone's calendars currently say. Reported, never auto-resolved.
  let conflicts = [];
  if (value) {
    try {
      const pk = personKey(where.name);
      const today = require('./world-model').localMinute(Date.now()).slice(0, 10);
      conflicts = _calendarSightings(addDays(today, -1), addDays(today, 400))
        .filter((s) => s.kind === kind && pk && personKey(s.person) === pk && s.date.slice(5) !== value.slice(-5))
        .map((s) => ({ date: s.date, calendar: s.source.calendar }));
    } catch { conflicts = []; }
  }
  return { ok: true, changed: true, previous, value, conflicts };
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
  // Build 18
  HEADING_COMPLETE, HEADING_PARTIAL, coverageVerdict, markConflicts,
  parseDeclaredDate, declaredEntities, setDeclared,
};
