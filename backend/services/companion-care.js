'use strict';

/**
 * Build 20E–K — Ember's care, as a small read model over what Nick said.
 *
 * Ember is a COMPANION (personal-world, `wm_companions`, a vault note with
 * `type: pet`) and never a Person. This module adds the one thing the world
 * model did not have: what looking after her involves, and only what Nick has
 * told NEURO about it.
 *
 * ── A care item exists only if Nick made it exist ─────────────────────────
 *   • he CREATED it here (companion_care_items) — a vet appointment, a flea
 *     treatment, a walk he wants to see on the Radar;
 *   • he LINKED an existing task / reminder / calendar entry / commitment /
 *     personal date to her care (companion_links);
 *   • a title that says "Ember" is a MENTION (personal-world.mentions) and
 *     stays one — it never becomes a care link.
 * Nothing is generated: no vaccination year, monthly flea cycle or quarterly
 * worming is assumed. A NEXT date is calculated only from a recurrence Nick
 * entered on the item, counted from the day he marked it done.
 *
 * ── Walks (20H) ────────────────────────────────────────────────────────────
 *   confirmed       Nick confirmed the day, ticked a walk care item that day,
 *                   or completed a task he linked to her walks that day
 *   planned         an open walk item / linked walk task is due that day, or
 *                   a calendar entry he linked as a walk falls on it
 *   no_evidence     walks are set up and nothing above is true
 *   recording_gap   the only evidence would be a linked Reminders task, and
 *                   the Reminders feed is stale or failing — can't tell
 *   not_applicable  Nick said so for the day, or walks are not set up at all
 * Nick's own walking is NEVER evidence: no workout, step count, place or
 * location is read here. A dog walk is not inferred from a human one.
 * Nothing here notifies; there is no "missed walk" anything.
 *
 * The shapers are PURE; the store and readers below are the only DB code.
 */

const crypto = require('crypto');

const CARE_KINDS = Object.freeze(['walk', 'vet', 'vaccination', 'flea', 'worm', 'medication', 'grooming', 'insurance', 'other']);
const KIND_LABELS = Object.freeze({
  walk: 'walk', vet: 'vet appointment', vaccination: 'vaccination', flea: 'flea treatment', worm: 'worm treatment',
  medication: 'medication', grooming: 'grooming', insurance: 'insurance / admin', other: 'care',
});
// An appointment happens on its date; there is nothing to "do" before it unless
// Nick linked preparation. A treatment is something to do by its date.
const APPOINTMENT_KINDS = new Set(['vet', 'grooming', 'walk']);
const UNITS = Object.freeze(['day', 'week', 'month', 'year']);
const ENTITY_RE = /^(task:|commitment:|meeting:|pd:)/;
const WALK_MARKS = Object.freeze(['walked', 'not-applicable']);
const WALK_STATES = Object.freeze(['planned', 'confirmed', 'no_evidence', 'recording_gap', 'not_applicable']);
const NEEDS_AHEAD_DAYS = 1;
const NEEDS_OVERDUE_DAYS = 14;
const WALK_HISTORY_DAYS = 7;

const DAY_MS = 86400000;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const _utc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const addDays = (d, n) => new Date(_utc(d) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((_utc(b) - _utc(a)) / DAY_MS);
const TZ = () => process.env.NEURO_TIMEZONE || 'Europe/London';

/** A local YYYY-MM-DD for an instant (ISO string or ms). PURE given the zone. */
function localDay(at) {
  if (at === null || at === undefined || at === '') return null;
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ() });
}

// ── pure ────────────────────────────────────────────────────────────────────

/** Validate a recurrence exactly as Nick entered it. PURE. null = none. */
function parseRecurrence(r) {
  if (r === null || r === undefined || r === '') return { ok: true, value: null };
  if (typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'recurrence must be { every, unit } or null' };
  const every = Number(r.every);
  if (!Number.isInteger(every) || every < 1 || every > 365) return { ok: false, error: 'recurrence.every must be a whole number from 1 to 365' };
  if (!UNITS.includes(r.unit)) return { ok: false, error: `recurrence.unit must be one of ${UNITS.join(', ')}` };
  return { ok: true, value: { every, unit: r.unit } };
}

/** "every 4 weeks". PURE. */
function recurrenceWords(rec) {
  if (!rec) return null;
  return rec.every === 1 ? `every ${rec.unit}` : `every ${rec.every} ${rec.unit}s`;
}

/**
 * The next date from an EXPLICIT recurrence, counted from `from`. PURE.
 * A month step keeps the day of the month where it exists and otherwise
 * lands on the month's last day (31 Jan + 1 month = 28/29 Feb).
 */
function nextDate(from, rec) {
  if (!rec || !isDay(from)) return null;
  if (rec.unit === 'day') return addDays(from, rec.every);
  if (rec.unit === 'week') return addDays(from, rec.every * 7);
  const months = rec.unit === 'year' ? rec.every * 12 : rec.every;
  const y = +from.slice(0, 4); const m = +from.slice(5, 7) - 1; const d = +from.slice(8, 10);
  const target = new Date(Date.UTC(y, m + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Validate a create request. PURE. Nothing is defaulted into existence. */
function validateItem({ kind, title, dueDate, dueTime, recurrence, note } = {}) {
  if (!CARE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${CARE_KINDS.join(', ')}` };
  const t = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
  if (!t) return { ok: false, error: 'a title is required — what is it?' };
  if (t.length > 200) return { ok: false, error: 'title is too long' };
  if (dueDate !== undefined && dueDate !== null && dueDate !== '' && !isDay(dueDate)) return { ok: false, error: 'dueDate must be YYYY-MM-DD' };
  if (dueTime !== undefined && dueTime !== null && dueTime !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) return { ok: false, error: 'dueTime must be HH:MM' };
  const rec = parseRecurrence(recurrence);
  if (!rec.ok) return rec;
  if (rec.value && !(dueDate && isDay(dueDate))) return { ok: false, error: 'a repeating item needs the date it is next due' };
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 1000)) return { ok: false, error: 'note must be text under 1000 characters' };
  return {
    ok: true,
    value: { kind, title: t, dueDate: dueDate || null, dueTime: dueTime || null, recurrence: rec.value, note: typeof note === 'string' && note.trim() ? note.trim() : null },
  };
}

/**
 * Where a care item stands today. PURE. Same evidence rule as a personal
 * obligation: Nick's own date ≤1 day away (or up to 14 past) for something
 * to DO; an appointment is planned until its day. Importance never matters.
 */
function careStatus(item, today) {
  if (item.status !== 'open') return { actionState: 'none', needsNow: false, why: item.status === 'done' ? 'done' : 'cancelled' };
  if (!item.dueDate) return { actionState: 'preparation_open', needsNow: false, why: 'open, with no date' };
  const away = daysBetween(today, item.dueDate);
  if (APPOINTMENT_KINDS.has(item.kind)) {
    if (away < 0) return { actionState: 'unknown', needsNow: false, why: `its date passed ${-away} day${away === -1 ? '' : 's'} ago and it is not marked done` };
    return { actionState: 'planned', needsNow: false, why: away === 0 ? 'today' : away === 1 ? 'tomorrow' : `in ${away} days` };
  }
  if (away <= NEEDS_AHEAD_DAYS && away >= -NEEDS_OVERDUE_DAYS) {
    return { actionState: 'needs_you', needsNow: true, why: away < 0 ? `still open, ${-away} day${away === -1 ? '' : 's'} past its date` : away === 0 ? 'due today' : 'due tomorrow' };
  }
  if (away < -NEEDS_OVERDUE_DAYS) return { actionState: 'unknown', needsNow: false, why: `more than ${NEEDS_OVERDUE_DAYS} days past its date and not marked done` };
  return { actionState: 'preparation_open', needsNow: false, why: `due in ${away} days` };
}

/** A care item as a surface sees it. PURE. */
function shapeItem(row, { today, companionName = null } = {}) {
  let rec = null;
  try { rec = row.recurrence_json ? JSON.parse(row.recurrence_json) : null; } catch { rec = null; }
  const item = {
    id: row.care_id, companionId: row.companion_id, kind: row.kind, kindLabel: KIND_LABELS[row.kind] || row.kind,
    title: row.title, dueDate: row.due_date || null, dueTime: row.due_time || null,
    recurrence: rec, recurrenceWords: recurrenceWords(rec), status: row.status, note: row.note || null,
    createdAt: row.created_at, updatedAt: row.updated_at, provenance: 'created by you',
  };
  const st = careStatus(item, today);
  return { ...item, ...st, companionName };
}

/**
 * The walk state for one day. PURE.
 *   day, today
 *   mark       'walked' | 'not-applicable' | null       Nick's word for the day
 *   items      walk care items (shaped) — open ones due that day plan it
 *   log        care log rows of kind walk — done_on that day confirms
 *   linked     walk-linked entities resolved: [{ entityId, kind:'task'|'meeting'|…, title, status, dueDate, day, completedOn, source }]
 *   setUp      true when walks have ever been set up (an item, a link or a mark)
 *   remindersFresh  true | false | null — health of the Reminders feed
 */
function walkDay({ day, today, mark = null, items = [], log = [], linked = [], setUp = false, remindersFresh = null }) {
  if (mark === 'not-applicable') return { day, state: 'not_applicable', why: 'you said no walk was needed that day', evidence: [] };
  const evidence = [];
  if (mark === 'walked') evidence.push({ kind: 'confirmation', why: 'you confirmed it' });
  for (const l of log) if (l.kind === 'walk' && l.done_on === day) evidence.push({ kind: 'care-item', why: `you ticked "${l.title}"` });
  for (const x of linked) if (x.kindOf === 'task' && x.status === 'completed' && x.completedOn === day) evidence.push({ kind: 'linked-task', why: `"${x.title}" (linked by you) was completed` });
  if (evidence.length) return { day, state: 'confirmed', why: evidence[0].why, evidence };
  if (!setUp) return { day, state: 'not_applicable', why: 'walks are not set up for her — nothing tells NEURO about them', evidence: [] };
  const plans = [];
  for (const i of items) if (i.kind === 'walk' && i.status === 'open' && i.dueDate === day) plans.push(`"${i.title}"${i.dueTime ? ` at ${i.dueTime}` : ''}`);
  for (const x of linked) {
    if (x.kindOf === 'task' && x.status === 'open' && x.dueDate === day) plans.push(`"${x.title}" (linked by you)`);
    if (x.kindOf === 'meeting' && x.day === day && x.status !== 'cancelled') plans.push(`"${x.title}"${x.time ? ` at ${x.time}` : ''} in your calendar (linked by you)`);
  }
  const reliesOnReminders = linked.some((x) => x.kindOf === 'task' && x.source === 'Reminders' && (x.dueDate === day || x.status === 'open'));
  if (plans.length && day >= today) return { day, state: 'planned', why: `planned: ${plans[0]}`, evidence: [] };
  if (reliesOnReminders && remindersFresh === false) {
    return { day, state: 'recording_gap', why: 'a linked Reminders task would say, but the Reminders feed is not fresh — can\'t tell', evidence: [] };
  }
  return { day, state: 'no_evidence', why: plans.length ? `planned (${plans[0]}) but nothing recorded it happened` : 'nothing recorded for this day', evidence: [] };
}

/**
 * Care items for the Future Radar. PURE. Only items Nick created, with a date
 * in the window, still open. Walks show as planned; a treatment as to-do.
 */
function radarItems(items, { today, last, companionName }) {
  const out = [];
  for (const i of items) {
    if (i.status !== 'open' || !i.dueDate) continue;
    if (!(i.dueDate <= last && (i.dueDate >= today || i.actionState === 'needs_you'))) continue;
    out.push({
      id: i.id, title: `${companionName} — ${i.kindLabel === 'care' ? i.title : i.kindLabel}`, detail: i.title,
      date: i.dueDate, time: i.dueTime || null, kind: 'care', careKind: i.kind,
      actionState: i.actionState, needsWhy: i.why,
      whyVisible: [`you added this to ${companionName}'s care${i.recurrenceWords ? ` (${i.recurrenceWords}, as you set it)` : ''}`, i.why].filter(Boolean),
      companion: { id: i.companionId, name: companionName, careKind: i.kind },
    });
  }
  return out;
}

// ── store ───────────────────────────────────────────────────────────────────

function _db() { return require('../db/database'); }

function _companion(companionId) {
  const pw = require('./personal-world');
  return pw.listCompanions().find((c) => c.id === companionId) || null;
}

function _log(kind, { subjectId, actor = 'nick', detail = {}, now = Date.now() } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey: `${kind}:${subjectId}:${detail.entityId || detail.careId || ''}:${now}`, now });
}

/** Nick creates a care item. Refused unless the companion exists. */
function createItem(companionId, body = {}, { now = Date.now() } = {}) {
  const c = _companion(companionId);
  if (!c) return { ok: false, status: 404, error: 'no such companion' };
  const v = validateItem(body);
  if (!v.ok) return { ...v, status: 400 };
  const iso = new Date(now).toISOString();
  const id = `care:${crypto.randomUUID()}`;
  _db().run(`INSERT INTO companion_care_items (care_id, companion_id, kind, title, due_date, due_time, recurrence_json, status, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  [id, companionId, v.value.kind, v.value.title, v.value.dueDate, v.value.dueTime, v.value.recurrence ? JSON.stringify(v.value.recurrence) : null, v.value.note, iso, iso]);
  _log('care-item-created', { subjectId: companionId, detail: { careId: id, companion: c.name, kind: v.value.kind, title: v.value.title, dueDate: v.value.dueDate }, now });
  return { ok: true, item: shapeItem(_row(id), { today: localDay(now), companionName: c.name }) };
}

function _row(id) { return _db().get('SELECT * FROM companion_care_items WHERE care_id = ?', [id]); }

/**
 * Nick marks a care item done. With a recurrence HE entered, the item stays
 * open at its next date (counted from the day it was done); without one it
 * is closed. Either way the completion is logged, append-only.
 */
function completeItem(careId, { doneOn = null } = {}, { now = Date.now() } = {}) {
  const row = _row(careId);
  if (!row) return { ok: false, status: 404, error: 'no such care item' };
  if (row.status !== 'open') return { ok: false, status: 409, error: `it is already ${row.status}` };
  const today = localDay(now);
  const day = doneOn === null || doneOn === undefined || doneOn === '' ? today : doneOn;
  if (!isDay(day)) return { ok: false, status: 400, error: 'doneOn must be YYYY-MM-DD' };
  if (day > today) return { ok: false, status: 400, error: 'doneOn cannot be in the future' };
  let rec = null; try { rec = row.recurrence_json ? JSON.parse(row.recurrence_json) : null; } catch { rec = null; }
  const next = rec ? nextDate(day, rec) : null;
  const iso = new Date(now).toISOString();
  const db = _db();
  db.run(`INSERT INTO companion_care_log (care_id, companion_id, kind, title, done_on, due_was, next_due, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [careId, row.companion_id, row.kind, row.title, day, row.due_date || null, next, iso]);
  if (next) db.run('UPDATE companion_care_items SET due_date = ?, updated_at = ? WHERE care_id = ?', [next, iso, careId]);
  else db.run("UPDATE companion_care_items SET status = 'done', updated_at = ? WHERE care_id = ?", [iso, careId]);
  const c = _companion(row.companion_id);
  // A walk ticked off is not an Activity line (20U: no per-walk noise).
  if (row.kind !== 'walk') _log('care-item-completed', { subjectId: row.companion_id, detail: { careId, companion: c ? c.name : null, kind: row.kind, title: row.title, doneOn: day, nextDue: next }, now });
  return { ok: true, doneOn: day, nextDue: next, item: shapeItem(_row(careId), { today, companionName: c ? c.name : null }) };
}

function cancelItem(careId, { now = Date.now() } = {}) {
  const row = _row(careId);
  if (!row) return { ok: false, status: 404, error: 'no such care item' };
  if (row.status !== 'open') return { ok: false, status: 409, error: `it is already ${row.status}` };
  _db().run("UPDATE companion_care_items SET status = 'cancelled', updated_at = ? WHERE care_id = ?", [new Date(now).toISOString(), careId]);
  return { ok: true };
}

/** Does the entity a link names exist? Refused rather than stored dangling. */
function _entityExists(entityId, now) {
  const wo = require('./world-obligations');
  if (entityId.startsWith('task:')) return !!wo.getTask(entityId);
  if (entityId.startsWith('commitment:')) return !!wo.getCommitment(entityId);
  if (entityId.startsWith('meeting:')) return !!_db().get('SELECT 1 FROM wm_meetings WHERE meeting_id = ?', [entityId.slice('meeting:'.length)]);
  if (entityId.startsWith('pd:')) {
    try {
      const pd = require('./personal-dates').read({ now });
      return [...(pd.active || []), ...(pd.later || [])].some((d) => d.id === entityId);
    } catch { return false; }
  }
  return false;
}

/** Nick links an existing item to her care. Explicit only. */
function link(companionId, { entityId, careKind = 'other', label = null } = {}, { now = Date.now() } = {}) {
  const c = _companion(companionId);
  if (!c) return { ok: false, status: 404, error: 'no such companion' };
  if (typeof entityId !== 'string' || !ENTITY_RE.test(entityId) || entityId.length > 400) {
    return { ok: false, status: 400, error: 'entityId must be a task, reminder (task:…), calendar entry (meeting:…), commitment or personal date (pd:…)' };
  }
  if (!CARE_KINDS.includes(careKind)) return { ok: false, status: 400, error: `careKind must be one of ${CARE_KINDS.join(', ')}` };
  if (!_entityExists(entityId, now)) return { ok: false, status: 404, error: 'NEURO does not hold that item' };
  const db = _db();
  const held = db.get('SELECT care_kind FROM companion_links WHERE companion_id = ? AND entity_id = ?', [companionId, entityId]);
  db.run(`INSERT INTO companion_links (companion_id, entity_id, care_kind, set_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(companion_id, entity_id) DO UPDATE SET care_kind = excluded.care_kind, set_at = excluded.set_at`,
  [companionId, entityId, careKind, new Date(now).toISOString()]);
  if (!held || held.care_kind !== careKind) _log('care-link-added', { subjectId: companionId, detail: { entityId, companion: c.name, careKind, label }, now });
  return { ok: true, already: !!held && held.care_kind === careKind, link: { companionId, entityId, careKind } };
}

function unlink(companionId, { entityId, label = null } = {}, { now = Date.now() } = {}) {
  if (typeof entityId !== 'string' || !ENTITY_RE.test(entityId)) return { ok: false, status: 400, error: 'entityId is required' };
  const r = _db().run('DELETE FROM companion_links WHERE companion_id = ? AND entity_id = ?', [companionId, entityId]);
  const c = _companion(companionId);
  if (r && r.changes) _log('care-link-removed', { subjectId: companionId, detail: { entityId, companion: c ? c.name : null, label }, now });
  return { ok: true, removed: !!(r && r.changes) };
}

/** Every explicit care link, as a Map entityId → [{ companionId, name, careKind }]. */
function linkMap() {
  const out = new Map();
  try {
    const names = new Map(require('./personal-world').listCompanions().map((c) => [c.id, c.name]));
    for (const r of _db().all('SELECT companion_id, entity_id, care_kind FROM companion_links')) {
      out.set(r.entity_id, [...(out.get(r.entity_id) || []), { companionId: r.companion_id, name: names.get(r.companion_id) || r.companion_id, careKind: r.care_kind }]);
    }
  } catch { /* no table yet: no links */ }
  return out;
}

/** Nick's word for a day's walk. Not for a future day. */
function markWalk(companionId, { day, mark } = {}, { now = Date.now() } = {}) {
  if (!_companion(companionId)) return { ok: false, status: 404, error: 'no such companion' };
  const today = localDay(now);
  const d = day === undefined || day === null || day === '' ? today : day;
  if (!isDay(d)) return { ok: false, status: 400, error: 'day must be YYYY-MM-DD' };
  if (d > today) return { ok: false, status: 400, error: 'a walk cannot be confirmed for a day that has not happened' };
  if (daysBetween(d, today) > 60) return { ok: false, status: 400, error: 'only the last 60 days can be marked' };
  if (!WALK_MARKS.includes(mark)) return { ok: false, status: 400, error: `mark must be one of ${WALK_MARKS.join(', ')}` };
  _db().run(`INSERT INTO companion_walk_marks (companion_id, day, mark, set_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(companion_id, day) DO UPDATE SET mark = excluded.mark, set_at = excluded.set_at`,
  [companionId, d, mark, new Date(now).toISOString()]);
  return { ok: true, day: d, mark };
}

function unmarkWalk(companionId, { day } = {}) {
  if (!isDay(day)) return { ok: false, status: 400, error: 'day must be YYYY-MM-DD' };
  const r = _db().run('DELETE FROM companion_walk_marks WHERE companion_id = ? AND day = ?', [companionId, day]);
  return { ok: true, removed: !!(r && r.changes) };
}

// ── readers ─────────────────────────────────────────────────────────────────

function _remindersFresh() {
  try {
    const rows = _db().all("SELECT freshness, state FROM source_health WHERE source_id LIKE 'reminders.%' AND source_id != 'reminders.unknown'");
    if (!rows.length) return null;
    return rows.some((r) => r.freshness === 'fresh' && r.state !== 'failing');
  } catch { return null; }
}

/** Resolve one linked entity to what a surface shows. Titles, dates, states only. */
function _resolve(entityId, careKind, ctx) {
  const wo = require('./world-obligations');
  try {
    if (entityId.startsWith('task:')) {
      const t = wo.getTask(entityId);
      if (!t) return { entityId, careKind, kindOf: 'task', found: false };
      const lead = (t.sources || []).find((s) => s.role === 'leading') || (t.sources || [])[0] || {};
      const isReminder = lead.system === 'eventkit-reminders';
      // A reminder from a list Nick has not tracked is not read (Build 20A).
      if (isReminder && !(t.container && ctx.sc.isTracked({ id: t.container.id }, { byKey: ctx.lists }))) {
        return { entityId, careKind, kindOf: 'task', found: true, hidden: true, title: t.title, why: 'its reminder list is not tracked, so NEURO does not read it' };
      }
      return { entityId, careKind, kindOf: 'task', found: true, title: t.title, status: t.status === 'completed' ? 'completed' : t.status === 'unknown' ? 'unknown' : t.status === 'cancelled' ? 'cancelled' : 'open',
        dueDate: t.due ? t.due.date : null, completedOn: localDay(t.completedAt), source: isReminder ? 'Reminders' : lead.system === 'neuro' ? 'NEURO' : /^ms-/.test(lead.system || '') ? 'Microsoft' : null };
    }
    if (entityId.startsWith('commitment:')) {
      const c = wo.getCommitment(entityId);
      return c ? { entityId, careKind, kindOf: 'commitment', found: true, title: c.description || c.title || entityId, status: c.status, dueDate: c.due ? c.due.date : null }
        : { entityId, careKind, kindOf: 'commitment', found: false };
    }
    if (entityId.startsWith('meeting:')) {
      const m = _db().get('SELECT title, start_local, is_all_day, status FROM wm_meetings WHERE meeting_id = ?', [entityId.slice('meeting:'.length)]);
      if (!m) return { entityId, careKind, kindOf: 'meeting', found: false };
      const day = require('./hiking-loop').entryDay(m.start_local, m.is_all_day === 1);
      return { entityId, careKind, kindOf: 'meeting', found: true, title: m.title, day, time: m.is_all_day === 1 ? null : String(m.start_local).slice(11, 16), status: m.status };
    }
    if (entityId.startsWith('pd:')) {
      const d = (ctx.dates || []).find((x) => x.id === entityId);
      return d ? { entityId, careKind, kindOf: 'personal-date', found: true, title: d.title, day: d.date } : { entityId, careKind, kindOf: 'personal-date', found: false };
    }
  } catch (e) { return { entityId, careKind, found: false, why: e.message }; }
  return { entityId, careKind, found: false };
}

/**
 * The care read for one companion: next explicit item, open items, recent
 * completions, linked items, mentions (inference), and walks — today plus
 * the last week.
 */
function read(companionId, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const c = _companion(companionId);
  if (!c) return { ok: false, status: 404, error: 'no such companion' };
  const db = _db();
  const today = localDay(nowMs);
  const gaps = [];
  const items = db.all('SELECT * FROM companion_care_items WHERE companion_id = ? ORDER BY COALESCE(due_date, \'9999\'), created_at', [companionId])
    .map((r) => shapeItem(r, { today, companionName: c.name }));
  const open = items.filter((i) => i.status === 'open');
  const log = db.all('SELECT * FROM companion_care_log WHERE companion_id = ? ORDER BY done_on DESC, id DESC LIMIT 60', [companionId]);
  const sc = require('./source-classification');
  let dates = [];
  try { const pd = require('./personal-dates').read({ now: nowMs }); dates = [...(pd.active || []), ...(pd.later || [])]; } catch (e) { gaps.push({ input: 'personal-dates', why: e.message }); }
  const ctx = { sc, lists: sc.classificationMap('reminder-list'), dates };
  const links = db.all('SELECT entity_id, care_kind, set_at FROM companion_links WHERE companion_id = ? ORDER BY set_at', [companionId]);
  const linked = links.map((l) => ({ ..._resolve(l.entity_id, l.care_kind, ctx), linkedAt: l.set_at }));
  const marks = new Map(db.all('SELECT day, mark FROM companion_walk_marks WHERE companion_id = ?', [companionId]).map((m) => [m.day, m.mark]));
  const walkLinked = linked.filter((l) => l.careKind === 'walk' && l.found && !l.hidden);
  const setUp = items.some((i) => i.kind === 'walk') || links.some((l) => l.care_kind === 'walk') || marks.size > 0;
  const fresh = _remindersFresh();
  const walks = [];
  for (let n = 0; n <= WALK_HISTORY_DAYS; n += 1) {
    const day = addDays(today, -n);
    walks.push(walkDay({ day, today, mark: marks.get(day) || null, items, log, linked: walkLinked, setUp, remindersFresh: fresh }));
  }
  // Mentions: an inference, kept apart from links (20G).
  let mentions = [];
  try {
    const companions = [c];
    const linkedIds = new Set(links.map((l) => l.entity_id));
    mentions = require('./world-obligations').listTasks({ status: 'open', limit: 2000 })
      .filter((t) => !linkedIds.has(t.taskId) && require('./personal-world').mentions(t.title, companions).length)
      .slice(0, 20).map((t) => ({ entityId: t.taskId, title: t.title, basis: 'inference', why: `mentions ${c.name} — not a link you made` }));
  } catch (e) { gaps.push({ input: 'mentions', why: e.message }); }
  const dated = open.filter((i) => i.dueDate);
  const next = dated.find((i) => i.dueDate >= today) || dated[0] || null;
  return {
    ok: true, asOf: new Date(nowMs).toISOString(), today,
    companion: { id: c.id, name: c.name, species: c.species, breed: c.breed, entityType: 'pet', notePath: c.notePath },
    next,
    open,
    recent: log.slice(0, 10).map((l) => ({ careId: l.care_id, kind: l.kind, kindLabel: KIND_LABELS[l.kind] || l.kind, title: l.title, doneOn: l.done_on, nextDue: l.next_due })),
    linked,
    mentions,
    walk: { today: walks[0], history: walks.slice(1), setUp, remindersFresh: fresh,
      rule: `A walk counts only when you confirm it, tick a walk item, or complete a task you linked to her walks. Your own walking, steps, workouts and location are never read as ${c.name}'s walk. Nothing reminds you about a walk.` },
    counts: { open: open.length, dated: dated.length, linked: links.length, needsNow: open.filter((i) => i.needsNow).length },
    rule: `Only what you told NEURO: care items you added, and items you linked to ${c.name}. Nothing is scheduled for her by itself — a next date comes only from a repeat you set.`,
    gaps,
  };
}

/** Every companion's dated care items in a window, for the Radar. */
function radar({ today, last, now = Date.now() } = {}) {
  const out = [];
  try {
    for (const c of require('./personal-world').listCompanions()) {
      const rows = _db().all("SELECT * FROM companion_care_items WHERE companion_id = ? AND status = 'open' AND due_date IS NOT NULL", [c.id]);
      out.push(...radarItems(rows.map((r) => shapeItem(r, { today, companionName: c.name })), { today, last, companionName: c.name }));
    }
  } catch (e) { console.warn('[CompanionCare] radar items unreadable:', e.message); return { items: out, error: e.message }; }
  return { items: out };
}

const TABLES = ['companion_care_items', 'companion_care_log', 'companion_links', 'companion_walk_marks'];

module.exports = {
  CARE_KINDS, KIND_LABELS, WALK_STATES, WALK_MARKS, UNITS, TABLES,
  // pure
  parseRecurrence, recurrenceWords, nextDate, validateItem, careStatus, shapeItem, walkDay, radarItems, localDay,
  // store
  createItem, completeItem, cancelItem, link, unlink, linkMap, markWalk, unmarkWalk,
  // readers
  read, radar,
};
