'use strict';

/**
 * Calendar care (1 Nov 2026) — the stores, readers and the three presses.
 * The judgements are PURE in calendar-care-model.js.
 *
 *   protect   the coming week is over 60% real meetings → propose ONE
 *             meeting-free afternoon. "Protect" creates an attendee-free block
 *             directly (nobody is told — calendar.solo, like task blocks).
 *   agenda    a meeting Nick organises within 24h whose invite says nothing →
 *             a drafted agenda. "Add agenda" PREPARES a governed
 *             update_calendar_event_body (attendees get Outlook's update), which
 *             the screen confirms with one press (intent grant).
 *   series    a recurring series he missed the last three times (declined, "I'm
 *             not in it", or written up in another meeting) → leave it:
 *             decline the series (ledgered, on his press) or, for his own
 *             series, a governed cancel. Keep / remind me in a month.
 *
 * ⚠ Nothing here acts on a timer. The pass only READS (the agenda half reads
 * invite bodies from Graph) and records proposals. Every write is a press.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const M = require('./calendar-care-model');

const STATE_KEY = 'calendar_care';
const SKIP_LOG_KEY = 'meeting_skip_log';
const AGENDA_LEAD_MS = 24 * 3600 * 1000;
const AGENDA_MIN_LEAD_MS = 30 * 60 * 1000;
const REMIND_DAYS = 30;
const SERIES_WRITER = 'microsoft.calendar.series-decline';
const SERIES_DECLINE_NOTE = 'I won’t be attending this series going forward — thank you. Happy to pick anything up by email.';

const msOf = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now());
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function localMinute(nowMs) {
  try { return require('./world-model').localMinute(nowMs); } catch { return new Date(nowMs).toISOString().slice(0, 16); }
}

// ── state ───────────────────────────────────────────────────────────────────

function readState() {
  try {
    const raw = db.getState(STATE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return { weeks: isObj(s.weeks) ? s.weeks : {}, agendas: isObj(s.agendas) ? s.agendas : {}, series: isObj(s.series) ? s.series : {} };
  } catch (e) {
    console.warn('[CalendarCare] state unreadable:', e.message);
    return null;
  }
}
function writeState(s) {
  // Bounded: agendas keep the last 120 occurrences, weeks the last 26.
  const trim = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => String(a[1].at || '').localeCompare(String(b[1].at || ''))).slice(-n));
  db.setState(STATE_KEY, JSON.stringify({ weeks: trim(s.weeks, 26), agendas: trim(s.agendas, 120), series: s.series }));
}
function update(fn) {
  const s = readState();
  if (!s) return { ok: false, error: 'calendar care state could not be read — nothing changed' };
  const r = fn(s);
  writeState(s);
  return r || { ok: true };
}

// ── readers (real stores; injectable in tests) ──────────────────────────────

function _calendarRows(fromDate, toDate) {
  return db.all(`SELECT event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, is_organizer, source
                   FROM calendar_cache WHERE source = 'graph' AND substr(start_time, 1, 10) >= ? AND substr(start_time, 1, 10) <= ?
                  ORDER BY start_time`, [fromDate, toDate]);
}
function _neuroIds() {
  const out = new Set();
  try { for (const r of db.all('SELECT event_id FROM task_blocks WHERE event_id IS NOT NULL')) out.add(r.event_id); } catch { /* table absent */ }
  return out;
}
function _leave() {
  try {
    const ta = require('./team-availability');
    const r = ta.selfDaysOff(ta.snapshot());
    return r.known ? { known: true, dates: r.dates } : { known: false, reason: r.reason, dates: new Set() };
  } catch (e) { return { known: false, reason: e.message, dates: new Set() }; }
}
function _holidays() {
  try { return require('./working-days').holidaySet(); } catch { return new Set(); }
}

const DEFAULT_DEPS = {
  calendarRows: _calendarRows,
  neuroIds: _neuroIds,
  leave: _leave,
  holidays: _holidays,
};

/** The next working day strictly after `today` (weekends and bank holidays skipped; leave is per-day, below). */
function _nextWorkingDay(today, holidays) {
  let d = M.addDays(today, 1);
  for (let i = 0; i < 14; i++) {
    if (M.isoDow(d) <= 5 && !holidays.has(d)) return d;
    d = M.addDays(d, 1);
  }
  return d;
}

// ── 1. protect time ─────────────────────────────────────────────────────────

/**
 * The week card. Read-only. Returns { week, load, threshold, offer|null, decided, gaps }.
 * `offer` exists only when the load is over the threshold, no protected block is
 * already in the week, Nick has not answered this week, and a slot exists.
 */
function weekView({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const nowMs = msOf(now);
  const nowLocal = localMinute(nowMs);
  const today = nowLocal.slice(0, 10);
  const holidays = d.holidays();
  const next = _nextWorkingDay(today, holidays);
  const week = M.weekDays(next);
  const gaps = [];
  let rows;
  try { rows = d.calendarRows(week[0], week[4]); } catch (e) { return { ok: false, week, error: `the calendar could not be read: ${e.message}` }; }
  const events = rows.map(M.rowToEvent);
  const leave = d.leave();
  if (!leave.known) gaps.push(`your leave could not be read (${leave.reason}) — every weekday is counted as working`);
  const neuroIds = d.neuroIds();
  const load = M.weekLoad({ events, week, leave: leave.dates, holidays, neuroIds });
  const st = readState();
  const weekKey = week[0];
  const decided = st ? st.weeks[weekKey] || null : null;
  const out = { ok: true, week: { from: week[0], to: week[4], key: weekKey }, load, threshold: M.LOAD_THRESHOLD, decided, offer: null, gaps, reason: null };
  if (load.share === null) { out.reason = 'no working days left in that week'; return out; }
  if (load.share <= M.LOAD_THRESHOLD) { out.reason = `${Math.round(load.share * 100)}% meetings — under ${Math.round(M.LOAD_THRESHOLD * 100)}%`; return out; }
  if (decided) { out.reason = decided.status === 'dismissed' ? 'you said not this week' : `already ${decided.status}`; return out; }
  if (M.hasProtectedBlock(events, week)) { out.reason = 'a protected block is already in that week'; return out; }
  if (!st) { out.reason = 'calendar care state unreadable'; return out; }
  const remaining = load.days.filter((x) => x.working && x.date >= next).map((x) => x.date);
  const slot = M.chooseProtectSlot({ events, days: remaining, neuroIds });
  if (!slot) { out.reason = 'no afternoon or two-hour stretch left free of meetings'; return out; }
  const pct = Math.round(load.share * 100);
  const day = new Date(`${slot.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  out.offer = {
    ...slot,
    say: slot.kind === 'afternoon'
      ? `Your week is ${pct}% meetings — protect ${day} afternoon?`
      : `Your week is ${pct}% meetings — protect ${day} ${slot.start.slice(11, 16)}–${slot.end.slice(11, 16)}?`,
    title: M.PROTECT_SUBJECT,
  };
  return out;
}

const _protecting = new Set();

/**
 * "Protect" — create the attendee-free block. Direct (calendar.solo): nobody is
 * invited, nothing leaves the building. Recomputed server-side; the client
 * sends only the week key. One per week.
 */
async function protect({ weekKey, now = Date.now(), deps = {} } = {}) {
  const view = weekView({ now, deps });
  if (!view.ok) return { ok: false, status: 503, error: view.error };
  if (!weekKey || weekKey !== view.week.key) return { ok: false, status: 409, error: 'that is not the week on offer any more — refresh' };
  if (view.decided && view.decided.status === 'protected') return { ok: true, already: true, decided: view.decided };
  if (!view.offer) return { ok: false, status: 409, error: `nothing to protect: ${view.reason}` };
  // A synchronous claim before any await: two presses cannot make two blocks.
  if (_protecting.has(weekKey)) return { ok: false, status: 409, error: 'already protecting this week' };
  _protecting.add(weekKey);
  try {
    const create = (deps && deps.createEvent) || ((x) => require('./microsoft').createCalendarEvent(x));
    const slot = view.offer;
    const r = await create({
      subject: M.PROTECT_SUBJECT, start: `${slot.start}:00`, end: `${slot.end}:00`, attendees: [],
      body: 'Kept clear of meetings by NEURO because the week was over 60% meetings. Delete it to give the time back.',
    });
    if (!r || !r.created) return { ok: false, status: 502, error: `Outlook did not create it (${(r && r.reason) || 'no answer'}) — nothing was made` };
    const entry = { status: 'protected', eventId: (r.event && r.event.id) || null, start: slot.start, end: slot.end, share: view.load.share, at: new Date(msOf(now)).toISOString() };
    update((s) => { s.weeks[weekKey] = entry; });
    console.log(`[CalendarCare] protected ${slot.start}–${slot.end.slice(11)} (week ${weekKey})`);
    return { ok: true, decided: entry };
  } finally { _protecting.delete(weekKey); }
}

function dismissWeek({ weekKey, now = Date.now() } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekKey || ''))) return { ok: false, status: 400, error: 'weekKey must be YYYY-MM-DD' };
  return update((s) => {
    if (s.weeks[weekKey] && s.weeks[weekKey].status === 'protected') return { ok: false, status: 409, error: 'that week is already protected' };
    s.weeks[weekKey] = { status: 'dismissed', at: new Date(msOf(now)).toISOString() };
    return { ok: true };
  });
}

// ── 2. agendas ──────────────────────────────────────────────────────────────

function _datesSeen(subject, start) {
  const lo = M.addDays(start.slice(0, 10), -7); const hi = M.addDays(start.slice(0, 10), 7);
  try {
    return db.all(`SELECT DISTINCT substr(start_time, 1, 10) AS d FROM calendar_history WHERE lower(trim(subject)) = ? AND substr(start_time, 1, 10) BETWEEN ? AND ?
                   UNION SELECT DISTINCT substr(start_time, 1, 10) FROM calendar_cache WHERE lower(trim(subject)) = ? AND substr(start_time, 1, 10) BETWEEN ? AND ?`,
    [String(subject).trim().toLowerCase(), lo, hi, String(subject).trim().toLowerCase(), lo, hi]).map((r) => r.d);
  } catch { return []; }
}

/** Organised meetings with other people starting within the next 24h. PURE over rows. */
function agendaCandidates(rows, { nowLocal, untilLocal, datesSeen = () => [] }) {
  return rows.map(M.rowToEvent).filter((ev) => {
    if (!ev.id || /^graph-/.test(ev.id)) return false;
    if (ev.isAllDay || ev.isCancelled) return false;
    if (ev.attendeesOther !== true || ev.isOrganizer !== true) return false;
    if (M.isNeuroBlock(ev)) return false;
    // 1-2-1s: NOVA owns the 1-2-1 conversation and its prep.
    if (/^1-2-1\b/i.test(ev.subject)) return false;
    if (ev.start <= nowLocal || ev.start > untilLocal) return false;
    if (M.isDailyish({ subject: ev.subject, datesSeen: datesSeen(ev.subject, ev.start) })) return false;
    return true;
  });
}

function _gatherEvidence(ev) {
  const mc = require('./meeting-context');
  const g = mc.gather({ title: ev.subject, start: ev.start, participants: [], kind: 'meeting' }, { ...mc.DEFAULT_DEPS, self: [] });
  return g.evidence;
}

const AGENDA_DEPS = {
  readBody: (id) => require('./calendar-read').readEventBody(id),
  gather: _gatherEvidence,
  datesSeen: _datesSeen,
};

/**
 * The agenda pass. Reads each candidate's invite body once (Graph GET), and for
 * one with no agenda records a drafted proposal. One per occurrence; a body
 * that cannot be read is retried on the next pass, never recorded.
 */
async function agendaPass({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...AGENDA_DEPS, ...deps };
  const nowMs = msOf(now);
  const nowLocal = localMinute(nowMs + AGENDA_MIN_LEAD_MS);
  const untilLocal = localMinute(nowMs + AGENDA_LEAD_MS);
  const st = readState();
  if (!st) return { ok: false, error: 'state unreadable' };
  let rows;
  try { rows = d.calendarRows(nowLocal.slice(0, 10), untilLocal.slice(0, 10)); } catch (e) { return { ok: false, error: e.message }; }
  const cands = agendaCandidates(rows, { nowLocal, untilLocal, datesSeen: d.datesSeen });
  const out = { ok: true, candidates: cands.length, proposed: 0, hasAgenda: 0, unreadable: 0 };
  for (const ev of cands) {
    const key = M.occKey(ev.id, ev.start);
    if (st.agendas[key]) continue;
    let r;
    try { r = await d.readBody(ev.id); } catch { r = null; }
    if (!r || !r.ok || !r.exists) { out.unreadable++; continue; }
    const at = new Date(nowMs).toISOString();
    if (M.hasAgenda(r.html, { subject: ev.subject })) { st.agendas[key] = { status: 'has-agenda', eventId: ev.id, start: ev.start, at }; out.hasAgenda++; continue; }
    let evidence = null;
    try { evidence = d.gather(ev); } catch (e) { console.warn('[CalendarCare] agenda evidence unreadable:', e.message); }
    const draft = M.agendaDraft({ subject: ev.subject, evidence });
    st.agendas[key] = { status: 'proposed', eventId: ev.id, start: ev.start, end: ev.end, subject: ev.subject, text: draft.text, source: draft.source,
      previous: draft.previous ? { start: draft.previous.start, notePath: draft.previous.notePath || null } : null, at };
    out.proposed++;
  }
  writeState(st);
  return out;
}

/** Proposals still worth showing (the meeting has not started). */
function agendaOffers({ now = Date.now() } = {}) {
  const st = readState();
  if (!st) return { ok: false, error: 'state unreadable', offers: [] };
  const nowLocal = localMinute(msOf(now));
  const offers = Object.entries(st.agendas)
    .filter(([, a]) => a.status === 'proposed' && a.start > nowLocal)
    .map(([key, a]) => ({ key, ...a, gaps: M.gapsIn(a.text), say: `Add an agenda to “${a.subject}”?` }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));
  return { ok: true, offers };
}

function agendaOfferFor(eventId, start, { now = Date.now() } = {}) {
  const r = agendaOffers({ now });
  return (r.offers || []).find((o) => o.eventId === eventId && (!start || o.start === M.minute(start))) || null;
}

/**
 * "Add agenda" — PREPARE the governed body update with the text Nick confirmed.
 * Re-reads the live event: it must still be his, still have other people, and
 * still have no agenda. Returns { ok, action } for the screen to confirm.
 */
async function prepareAgenda({ key, text, now = Date.now(), deps = {} } = {}) {
  const st = readState();
  if (!st) return { ok: false, status: 503, error: 'state unreadable — nothing prepared' };
  const a = st.agendas[key];
  if (!a || a.status !== 'proposed') return { ok: false, status: 404, error: 'no agenda proposal for that meeting' };
  const body = String(text == null ? a.text : text).replace(/\r\n/g, '\n').trim();
  if (!body) return { ok: false, status: 400, error: 'the agenda is empty' };
  if (body.length > 4000) return { ok: false, status: 400, error: 'the agenda is too long (4,000 characters at most)' };
  const gaps = M.gapsIn(body);
  if (gaps.length) return { ok: false, status: 400, error: `fill in or delete ${gaps.join(', ')} first — nothing is added with a gap in it`, gaps };
  const readBody = (deps && deps.readBody) || AGENDA_DEPS.readBody;
  const r = await readBody(a.eventId);
  if (!r || !r.ok) return { ok: false, status: 503, error: 'the meeting could not be read from Outlook — nothing prepared' };
  if (!r.exists) return { ok: false, status: 409, error: 'the meeting is no longer in your calendar' };
  const ev = r.event;
  if (ev.isOrganizer === false) return { ok: false, status: 409, error: 'you are not the organiser any more' };
  if (ev.start !== a.start) return { ok: false, status: 409, error: 'the meeting has moved since this was drafted — it will be looked at again' };
  if (M.hasAgenda(r.html, { subject: ev.subject })) {
    update((s) => { s.agendas[key] = { ...s.agendas[key], status: 'has-agenda', at: new Date(msOf(now)).toISOString() }; });
    return { ok: false, status: 409, error: 'the invite already says what it is for — nothing added' };
  }
  const pa = require('./prepared-actions');
  const res = pa.prepareCalendarBody({ event: { ...ev, attendees: (ev.attendees || []).map((e) => ({ email: e })) },
    agenda: body, bodyHtml: r.html, origin: 'meeting-agenda', now });
  if (!res.ok) return { ok: false, status: res.code || 409, error: res.error };
  update((s) => { s.agendas[key] = { ...s.agendas[key], actionId: res.action.actionId, confirmedText: body }; });
  return { ok: true, action: res.action, already: !!res.already };
}

/** After the screen confirmed it: record the outcome against the proposal. */
function agendaDone({ key, now = Date.now() } = {}) {
  return update((s) => {
    const a = s.agendas[key];
    if (!a) return { ok: false, status: 404, error: 'no such proposal' };
    if (!a.actionId) return { ok: false, status: 409, error: 'nothing was prepared for it' };
    let st = null;
    try { st = require('./prepared-actions').get(a.actionId); } catch { st = null; }
    if (!st || !['executed', 'verified'].includes(st.status)) return { ok: false, status: 409, error: `the agenda has not been added (${st ? st.status : 'unknown'})` };
    s.agendas[key] = { ...a, status: 'added', at: new Date(msOf(now)).toISOString() };
    return { ok: true };
  });
}

function dismissAgenda({ key, now = Date.now() } = {}) {
  return update((s) => {
    if (!s.agendas[key]) return { ok: false, status: 404, error: 'no such proposal' };
    s.agendas[key] = { ...s.agendas[key], status: 'dismissed', at: new Date(msOf(now)).toISOString() };
    return { ok: true };
  });
}

// ── 3. meetings he never attends ────────────────────────────────────────────

/** "I'm not in it" — kept durably (meeting-finish prunes its overrides at the meeting's end). */
function readSkipLog() {
  try { const raw = db.getState(SKIP_LOG_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
}

function _seriesRows() {
  return db.all(`SELECT meeting_id, provider_event_id, series_id, title, start_local, end_local, status, response_status, is_organizer, kind
                   FROM wm_meetings WHERE provider = 'graph' AND kind = 'meeting' ORDER BY start_local DESC`);
}
function _declinedKeys() {
  const out = new Set();
  try {
    for (const r of db.all(`SELECT request_json FROM external_write_ledger WHERE writer = 'microsoft.calendar.respond' AND status IN ('confirmed', 'applied-unverified')`)) {
      const q = JSON.parse(r.request_json || '{}');
      if (q.response === 'decline' && q.eventId && q.start) out.add(M.occKey(q.eventId, q.start));
    }
  } catch { /* table absent */ }
  return out;
}
function _leaveDeclineDates() {
  const out = new Set();
  try {
    for (const r of db.all(`SELECT request_json FROM external_write_ledger WHERE writer = 'microsoft.calendar.leave-decline'`)) {
      const q = JSON.parse(r.request_json || '{}');
      const s = q.start || (q.event && q.event.start);
      if (s) out.add(String(s).slice(0, 10));
    }
  } catch { /* table absent */ }
  return out;
}
/** PLAUD write-up start times (wall clock) for the given dates, from Meetings/YYYY/MM. */
function _writeUpsOn(dates) {
  const root = process.env.OBSIDIAN_VAULT_PATH;
  const out = [];
  if (!root) return out;
  const wm = require('./world-model');
  for (const day of new Set(dates)) {
    const dir = path.join(root, 'Meetings', day.slice(0, 4), day.slice(5, 7));
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.startsWith(day) && f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { continue; }
      const m = text.match(/^start_at:\s*"?([0-9T:.-]+)/m);
      if (!m) continue;
      const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(m[1]) ? m[1] : `${m[1]}Z`); // PLAUD writes UTC, unmarked
      if (Number.isFinite(ms)) out.push({ start: wm.localMinute(ms), note: `Meetings/${day.slice(0, 4)}/${day.slice(5, 7)}/${f}` });
    }
  }
  return out;
}

const SERIES_DEPS = {
  seriesRows: _seriesRows,
  declinedKeys: _declinedKeys,
  leaveDeclineDates: _leaveDeclineDates,
  writeUpsOn: _writeUpsOn,
  skipLog: readSkipLog,
};

const _norm = (s) => String(s || '').trim().toLowerCase();

/** Group rows into series: Graph seriesMasterId, else same title + weekday + time. PURE. */
function groupSeries(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (/^cancel+ed:/i.test(String(r.title || ''))) continue;
    const key = r.series_id ? `series:${r.series_id}`
      : `pattern:${_norm(r.title)}|${M.isoDow(r.start_local.slice(0, 10))}|${r.start_local.slice(11, 16)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/**
 * Series he never attends. Read-only. Each offer names its evidence per
 * occurrence and what can be done: decline (an invite, Graph series id known),
 * cancel (his own series), or neither (no series id — say so).
 */
function seriesView({ now = Date.now(), deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...SERIES_DEPS, ...deps };
  const nowLocal = localMinute(msOf(now));
  const st = readState();
  let rows;
  try { rows = d.seriesRows(); } catch (e) { return { ok: false, error: `the world model could not be read: ${e.message}`, offers: [] }; }
  const groups = groupSeries(rows);
  const declined = d.declinedKeys();
  const skipped = new Set(d.skipLog().map((x) => M.occKey(x.eventId, x.start)));
  const leave = d.leave();
  const leaveDays = new Set([...(leave.dates || []), ...d.leaveDeclineDates()]);
  const others = rows.filter((r) => r.status === 'scheduled' && ['organizer', 'accepted', 'tentativelyAccepted'].includes(r.response_status))
    .map((r) => ({ id: r.provider_event_id, subject: r.title, start: r.start_local, end: r.end_local, series: r.series_id }));
  const offers = [];
  for (const [key, list] of groups) {
    const upcoming = list.filter((r) => r.status === 'scheduled' && r.start_local > nowLocal).sort((a, b) => (a.start_local < b.start_local ? -1 : 1));
    if (!upcoming.length) continue; // nothing left to leave
    const held = list.filter((r) => r.end_local <= nowLocal && (r.status === 'scheduled' || r.response_status === 'declined'))
      .sort((a, b) => (a.start_local < b.start_local ? 1 : -1));
    if (held.length < M.NEED) continue;
    const dates = held.slice(0, 6).map((r) => r.start_local.slice(0, 10));
    const writeUps = d.writeUpsOn(dates);
    const occs = held.slice(0, 8).map((r) => {
      const occ = { id: r.provider_event_id, start: r.start_local, end: r.end_local, responseStatus: r.response_status };
      const onLeave = leaveDays.has(r.start_local.slice(0, 10));
      const seriesOthers = others.filter((o) => !(r.series_id && o.series === r.series_id) && _norm(o.subject) !== _norm(r.title));
      return { ...occ, onLeave, evidence: onLeave ? null : M.occurrenceEvidence(occ, { declined, skipped, others: seriesOthers, writeUps }) };
    });
    const v = M.seriesVerdict(occs);
    if (!v.flagged) continue;
    const decided = st ? st.series[key] || null : null;
    if (decided && (decided.status === 'kept' || decided.status === 'declined' || decided.status === 'cancelled')) continue;
    if (decided && decided.status === 'snoozed' && decided.until > new Date(msOf(now)).toISOString()) continue;
    const first = upcoming[0];
    const organiser = list.some((r) => r.is_organizer === 1);
    const seriesId = list.find((r) => r.series_id)?.series_id || null;
    offers.push({
      key, title: first.title, seriesId, organiser, next: first.start_local,
      say: `You’ve missed the last ${M.NEED} “${first.title}”. ${organiser ? 'Cancel the series?' : 'Leave the series?'}`,
      last: v.last.map((o) => ({ start: o.start, evidence: o.evidence })),
      can: seriesId ? (organiser ? 'cancel' : 'decline') : null,
      cannotWhy: seriesId ? null : 'NEURO cannot see this series in Outlook as one series — decline it there',
    });
  }
  return { ok: true, offers, leaveKnown: !!leave.known };
}

function _seriesOffer(key, now, deps) {
  const v = seriesView({ now, deps });
  if (!v.ok) return { error: v.error };
  return { offer: v.offers.find((o) => o.key === key) || null };
}

/**
 * Decline the whole series — an invite Nick did not organise. Ledgered A3 on his
 * press (the invite-card precedent), read back. Never for his own series.
 */
async function declineSeries({ key, note = null, initiatedBy = 'nick', now = Date.now(), deps = {} } = {}) {
  const { offer, error } = _seriesOffer(key, now, deps);
  if (error) return { ok: false, status: 503, error };
  if (!offer) return { ok: false, status: 404, error: 'that series is not on offer any more' };
  if (offer.can !== 'decline') return { ok: false, status: 409, error: offer.cannotWhy || 'that is your own series — cancel it instead' };
  const cal = (deps && deps.calendar) || require('./action-calendar');
  const comment = String(note == null ? SERIES_DECLINE_NOTE : note).slice(0, 1000);
  const ext = require('./external-writes');
  const claim = ext.begin({ writer: SERIES_WRITER, key: `series-decline:${offer.seriesId}`, target: offer.title,
    request: { seriesId: offer.seriesId, title: offer.title }, initiatedBy, now });
  if (!claim.ok && claim.duplicate) {
    update((s) => { s.series[key] = { status: 'declined', at: new Date(msOf(now)).toISOString() }; });
    return { ok: true, already: true, say: `You had already declined “${offer.title}”.` };
  }
  if (!claim.ok) return { ok: false, status: 409, error: claim.why };
  let r;
  try { r = await cal.declineEvent(offer.seriesId, { comment }); } catch (e) { r = { outcome: 'uncertain', category: e.message }; }
  if (r.outcome === 'rejected') {
    ext.settle(claim.entry.id, { status: 'failed', result: { status: r.status, category: r.category } });
    return { ok: false, status: 502, error: `Microsoft refused it (${r.status || r.category}) — nothing was sent` };
  }
  if (r.outcome !== 'accepted') {
    ext.settle(claim.entry.id, { status: 'uncertain', result: { status: r.status, category: r.category } });
    return { ok: false, status: 504, uncertain: true, error: 'No clear answer from Microsoft — check Outlook before pressing again.' };
  }
  const back = await cal.responseOf(offer.seriesId).catch(() => null);
  const confirmed = back === 'declined' || back === 'gone';
  ext.settle(claim.entry.id, { status: confirmed ? 'confirmed' : 'applied-unverified', readback: back || 'unreadable' });
  update((s) => { s.series[key] = { status: 'declined', verified: confirmed, at: new Date(msOf(now)).toISOString() }; });
  console.log(`[CalendarCare] declined series (${confirmed ? 'read back' : 'not read back'})`);
  return { ok: true, verified: confirmed, say: `Declined “${offer.title}” going forward${confirmed ? '' : ' — Microsoft took it, the calendar has not shown it yet'}. The organiser has been told.` };
}

/** Cancel his own series — PREPARES a governed cancel of the series master for one-press confirm. */
async function prepareSeriesCancel({ key, note = null, now = Date.now(), deps = {} } = {}) {
  const { offer, error } = _seriesOffer(key, now, deps);
  if (error) return { ok: false, status: 503, error };
  if (!offer) return { ok: false, status: 404, error: 'that series is not on offer any more' };
  if (offer.can !== 'cancel') return { ok: false, status: 409, error: offer.cannotWhy || 'that is not your series — decline it instead' };
  const read = (deps && deps.readEvent) || ((id) => require('./calendar-read').readEvent(id));
  const r = await read(offer.seriesId);
  if (!r || !r.ok) return { ok: false, status: 503, error: 'the series could not be read from Outlook — nothing prepared' };
  if (!r.exists) return { ok: false, status: 409, error: 'the series is no longer in your calendar' };
  const ev = r.event;
  const res = require('./prepared-actions').prepareCalendarCancel({
    event: { ...ev, attendees: (ev.attendees || []).map((e) => ({ email: e })) },
    comment: String(note == null ? 'Cancelling this series — thank you, everyone.' : note).slice(0, 1000),
    origin: 'series-exit', context: { series: true }, now,
  });
  if (!res.ok) return { ok: false, status: res.code || 409, error: res.error };
  update((s) => { s.series[key] = { ...(s.series[key] || {}), status: 'cancel-prepared', actionId: res.action.actionId, at: new Date(msOf(now)).toISOString() }; });
  return { ok: true, action: res.action, already: !!res.already };
}

function seriesAnswer({ key, answer, now = Date.now() } = {}) {
  if (!['keep', 'remind', 'cancelled'].includes(answer)) return { ok: false, status: 400, error: 'answer must be keep, remind or cancelled' };
  const nowMs = msOf(now);
  return update((s) => {
    if (answer === 'cancelled') {
      const cur = s.series[key];
      let st = null;
      try { st = cur && cur.actionId ? require('./prepared-actions').get(cur.actionId) : null; } catch { st = null; }
      if (!st || !['executed', 'verified'].includes(st.status)) return { ok: false, status: 409, error: 'the cancellation has not gone' };
      s.series[key] = { ...cur, status: 'cancelled', at: new Date(nowMs).toISOString() };
      return { ok: true };
    }
    s.series[key] = answer === 'keep'
      ? { status: 'kept', at: new Date(nowMs).toISOString() }
      : { status: 'snoozed', until: new Date(nowMs + REMIND_DAYS * 86400000).toISOString(), at: new Date(nowMs).toISOString() };
    return { ok: true };
  });
}

// ── the card ────────────────────────────────────────────────────────────────

function read({ now = Date.now(), deps = {} } = {}) {
  let week; let agendas; let series;
  try { week = weekView({ now, deps }); } catch (e) { week = { ok: false, error: e.message }; }
  try { agendas = agendaOffers({ now }); } catch (e) { agendas = { ok: false, error: e.message, offers: [] }; }
  try { series = seriesView({ now, deps }); } catch (e) { series = { ok: false, error: e.message, offers: [] }; }
  return { ok: true, week, agendas, series };
}

module.exports = {
  STATE_KEY, SKIP_LOG_KEY, SERIES_WRITER, SERIES_DECLINE_NOTE,
  readState, weekView, protect, dismissWeek,
  agendaCandidates, agendaPass, agendaOffers, agendaOfferFor, prepareAgenda, agendaDone, dismissAgenda,
  groupSeries, seriesView, declineSeries, prepareSeriesCancel, seriesAnswer, readSkipLog,
  read,
};
