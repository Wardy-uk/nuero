'use strict';

/**
 * Leave guard (21 Oct 2026) — Nick's People HR leave, acted on.
 *
 * Two jobs, both Nick's design calls, asked before building:
 *
 * 1. AUTO-DECLINE (`autoDecline`) — an invite Nick did NOT organise, still
 *    unanswered, on a day People HR says he is off, is declined with a short
 *    note. UNATTENDED, behind the Settings switch `leave_auto_decline` (default
 *    OFF — turning it on is the approval), through the external-write ledger
 *    (`microsoft.calendar.leave-decline`) and read back from Graph. One push
 *    lists what went. Never: a meeting he organises, one he already answered
 *    (an accept on a leave day is his decision), a past one, or anything when
 *    his own leave could not be read.
 *
 * 2. CLASHES (`analyse` / `apply`) — when leave appears, everything already in
 *    the way is worked out and offered on ONE review card ("Leave clashes" on
 *    Now), applied with one tap, items untickable:
 *      - a 1-2-1 Nick organises → moved by the 1-2-1 planner's rules to after
 *        the leave (their leave AND his);
 *      - another meeting he organises → moved to the same time on the first
 *        free working day back; a RECURRING occurrence is cancelled for that
 *        day instead (moving one standup onto a day that already has one is
 *        not a fix);
 *      - someone else's meeting he accepted → declined;
 *      - a task block → moved after the leave;
 *      - a NEURO task due on a leave day → a COMMITMENT (someone is waiting)
 *        moves BEFORE the leave, his own work AFTER it, onto the nearest day
 *        with CAPACITY for its estimated size (diary free time minus what is
 *        already due that day). No day with room → the nearest one, flagged.
 *    Anything that tells another person goes through the governed calendar
 *    actions, confirmed on the card with one-use grants (origin `leave-clash`,
 *    or `1to1-move` so a 1-2-1's stamps and move history follow).
 *
 * The leave itself comes from `team-availability` (People HR via NOVA) and is
 * approved leave only; NOVA carries no half-day marker, so a half day reads as
 * a whole one — said on the card, never assumed away.
 */

const db = require('../db/database');

const AUTO_FLAG = 'leave_auto_decline';
const WRITER = 'microsoft.calendar.leave-decline';
const STATE_KEY = 'leave_clashes';
const SEEN_KEY = 'leave_seen_dates';
const DECLINE_COMMENT = "I'm on annual leave that day, so I won't be able to make this one. — Nick";
const DAY_FROM = 9 * 60;
const DAY_TO = 17 * 60 + 30;
const ASSUMED_TASK_MINUTES = 30;
const SEARCH_WORKING_DAYS = 10;

// ── pure ─────────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(s, n) { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); }
function minuteOf(stamp) { const [h, m] = String(stamp).slice(11, 16).split(':').map(Number); return h * 60 + m; }
function clock(day, min) { return `${day}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`; }

/** PURE. Does this event sit on a leave day? All-day spans are end-EXCLUSIVE (Graph). */
function onLeave(ev, leave) {
  const first = String(ev.start || '').slice(0, 10);
  if (!ev.isAllDay) return leave.has(first);
  const last = String(ev.end || '').slice(0, 10);
  for (let d = first; d < (last || addDays(first, 1)); d = addDays(d, 1)) if (leave.has(d)) return true;
  return false;
}

/** PURE. Group leave dates into runs; non-working days between them do not break a run. */
function leavePeriods(dates, isWorking) {
  const sorted = [...new Set(dates)].sort();
  const runs = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last) {
      let gapOk = true;
      for (let x = addDays(last.to, 1); x < d; x = addDays(x, 1)) if (isWorking(x)) { gapOk = false; break; }
      if (gapOk) { last.to = d; last.dates.push(d); continue; }
    }
    runs.push({ from: d, to: d, dates: [d] });
  }
  return runs;
}

/** PURE. The first working day after `day` that is not leave. */
function nextWorkingDay(day, { isWorking, leave }) {
  let d = addDays(day, 1);
  for (let i = 0; i < 60 && (!isWorking(d) || leave.has(d)); i++) d = addDays(d, 1);
  return d;
}

/** PURE. What the clash card should do with one calendar event on a leave day. */
function classifyEvent(ev, { selfEmail, oneToOne }) {
  if (String(ev.showAs || '').toLowerCase() === 'cancelled') return null;
  if (String(ev.responseStatus || '') === 'declined') return null;
  if (ev.isAllDay && String(ev.showAs || '').toLowerCase() === 'free') return null; // a birthday, a hiking day
  if (ev.isOrganizer === false) return { kind: 'decline' };
  if (ev.isOrganizer !== true) return { kind: 'info', why: 'NEURO could not tell whether you organise this' };
  const self = String(selfEmail || '').toLowerCase();
  const others = (ev.attendees || []).filter(a => a.email && a.email.toLowerCase() !== self);
  if (!others.length) return { kind: 'solo' };
  if (oneToOne.test(String(ev.subject || '')) && others.length === 1) return { kind: 'move-121', email: others[0].email };
  if (ev.type === 'occurrence') return { kind: 'cancel' };
  return { kind: 'move' };
}

/** PURE. Free diary minutes in the working window, from busy events that day. */
function freeMinutes(day, events) {
  const busy = (events || [])
    .filter(e => String(e.start || '').slice(0, 10) === day && !e.isAllDay)
    .filter(e => !['free', 'cancelled'].includes(String(e.showAs || 'busy').toLowerCase()))
    .map(e => [Math.max(DAY_FROM, minuteOf(e.start)), Math.min(DAY_TO, minuteOf(e.end))])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let used = 0; let cursor = DAY_FROM;
  for (const [a, b] of busy) { if (b <= cursor) continue; used += b - Math.max(a, cursor); cursor = Math.max(cursor, b); }
  return DAY_TO - DAY_FROM - used;
}

/**
 * PURE. The day a task should move to: walk `candidates` in order and take the
 * first whose free diary time, less what is already due there, holds the task.
 * None does → the first candidate, `fits:false`.
 */
function pickTaskDay(size, candidates, { events, dueLoad }) {
  for (const d of candidates) {
    const room = freeMinutes(d, events) - (dueLoad.get(d) || 0);
    if (room >= size) return { date: d, fits: true, room };
  }
  return candidates.length ? { date: candidates[0], fits: false, room: freeMinutes(candidates[0], events) - (dueLoad.get(candidates[0]) || 0) } : null;
}

/** PURE. First slot of `minutes` on `day` free of every busy event — at `prefer` if it is free. */
function slotOnDay(day, events, minutes, prefer = null) {
  const busy = (events || [])
    .filter(e => String(e.start || '').slice(0, 10) === day)
    .filter(e => String(e.showAs || 'busy').toLowerCase() !== 'cancelled')
    .filter(e => !(e.isAllDay && String(e.showAs || '').toLowerCase() === 'free'))
    .map(e => (e.isAllDay ? [0, 24 * 60] : [minuteOf(e.start), minuteOf(e.end)]));
  const free = (s) => !busy.some(([a, b]) => s < b && s + minutes > a);
  if (prefer != null && prefer >= DAY_FROM && prefer + minutes <= DAY_TO && free(prefer)) return prefer;
  for (let s = DAY_FROM; s + minutes <= DAY_TO; s += 30) if (free(s)) return s;
  return null;
}

/** PURE. Invites the timer may decline: someone else's, unanswered, on leave, still to come. */
function autoDeclineCandidates(events, leave, nowStamp) {
  return (events || []).filter(ev => ev.isOrganizer === false
    && ['notResponded', 'none'].includes(String(ev.responseStatus || ''))
    && String(ev.showAs || '').toLowerCase() !== 'cancelled'
    && !/^graph-/.test(String(ev.id || ''))
    && String(ev.start || '') > nowStamp
    && onLeave(ev, leave));
}

// ── reads ────────────────────────────────────────────────────────────────────

function _nowStamp(now) {
  const d = new Date(now);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Nick's future leave, or `known:false` with the reason. */
function myLeave(now = new Date()) {
  const availability = require('./team-availability');
  const r = availability.selfDaysOff(availability.snapshot());
  if (!r.known) return { known: false, reason: r.reason, dates: new Set() };
  const today = ymd(new Date(now));
  return { known: true, dates: new Set([...r.dates].filter(d => d >= today)), coversTo: r.coversTo || null };
}

function _isWorking() {
  const wd = require('./working-days');
  return (d) => wd.isWorkingDay(new Date(`${d}T12:00:00`), []);
}

async function _selfEmail() {
  try { return await require('./microsoft').getSignedInAddress(); } catch { return null; }
}

// ── decline (shared by the timer and the card) ───────────────────────────────

/**
 * Decline one invite for leave, through the ledger, read back. Never throws.
 * `initiatedBy` is 'timer' for the switch-gated pass and 'nick' for a card tap.
 */
async function declineForLeave(ev, { initiatedBy = 'nick', comment = DECLINE_COMMENT, now = Date.now() } = {}) {
  const ext = require('./external-writes');
  const key = `leave-decline:${ev.id}@${String(ev.start).slice(0, 16)}`;
  const claim = ext.begin({ writer: WRITER, key, target: ev.subject || 'a meeting',
    request: { eventId: ev.id, start: String(ev.start).slice(0, 16) }, initiatedBy, now });
  if (!claim.ok) return { ok: Boolean(claim.duplicate), already: Boolean(claim.duplicate), error: claim.duplicate ? null : claim.why };
  const cal = require('./action-calendar');
  let r;
  try { r = await cal.declineEvent(ev.id, { comment }); } catch (e) { r = { outcome: 'uncertain', category: e.message }; }
  if (r.outcome === 'rejected') {
    ext.settle(claim.entry.id, { status: 'failed', result: { status: r.status, category: r.category } });
    return { ok: false, error: `Microsoft refused the decline (${r.status || r.category})` };
  }
  if (r.outcome !== 'accepted') {
    ext.settle(claim.entry.id, { status: 'uncertain', result: { status: r.status, category: r.category } });
    return { ok: false, uncertain: true, error: 'no clear answer from Microsoft — check Outlook before trying again' };
  }
  const back = await cal.responseOf(ev.id).catch(() => null);
  const confirmed = back === 'declined' || back === 'gone';
  ext.settle(claim.entry.id, { status: confirmed ? 'confirmed' : 'applied-unverified', readback: back || 'unreadable' });
  // A declined meeting needs no "what is it for?" email: withdraw any unsent one.
  try {
    const n = require('./prepared-actions').withdrawAgendaChase(ev.id, { why: 'you declined it — on leave that day', now });
    if (n) console.log(`[LeaveGuard] withdrew ${n} agenda request(s) for "${ev.subject}"`);
  } catch (e) { console.warn('[LeaveGuard] agenda withdraw failed:', e.message); }
  return { ok: true, verified: confirmed };
}

// ── 1. auto-decline ──────────────────────────────────────────────────────────

async function autoDecline({ now = new Date() } = {}) {
  if (!require('./feature-flags').isEnabled(AUTO_FLAG)) return { ok: true, skipped: 'switched off' };
  const leave = myLeave(now);
  if (!leave.known) return { ok: false, skipped: `your leave could not be read — ${leave.reason}` };
  if (!leave.dates.size) return { ok: true, declined: [] };
  const sorted = [...leave.dates].sort();
  let events;
  try {
    events = await require('./microsoft').fetchCalendarEvents(sorted[0], sorted[sorted.length - 1]);
  } catch (e) { return { ok: false, error: `calendar unreadable: ${e.message}` }; }
  const todo = autoDeclineCandidates(events || [], leave.dates, _nowStamp(now));
  const declined = [];
  const failed = [];
  for (const ev of todo) {
    const r = await declineForLeave(ev, { initiatedBy: 'timer' });
    if (r.ok && !r.already) declined.push({ subject: ev.subject, start: String(ev.start).slice(0, 16), organizer: ev.organizer || null });
    else if (!r.ok) failed.push({ subject: ev.subject, start: String(ev.start).slice(0, 16), error: r.error });
  }
  if (declined.length || failed.length) {
    try {
      const fmt = (x) => `${x.subject} (${x.start.slice(5, 10)} ${x.start.slice(11)})`;
      await require('./webpush').sendToAll(
        `SAiM — declined ${declined.length} invite${declined.length === 1 ? '' : 's'} on your leave`,
        [declined.length ? declined.map(fmt).join(', ') : null,
          failed.length ? `Could not decline: ${failed.map(fmt).join(', ')}` : null].filter(Boolean).join(' · ').slice(0, 300),
        { type: 'leave_declined', url: '/?view=calendar' },
      );
    } catch (e) { console.warn('[LeaveGuard] push failed:', e.message); }
    console.log(`[LeaveGuard] auto-declined ${declined.length}, failed ${failed.length}`);
  }
  return { ok: true, declined, failed };
}

// ── 2. clashes ───────────────────────────────────────────────────────────────

async function analyse({ now = new Date() } = {}) {
  const leave = myLeave(now);
  const out = { computedAt: new Date(now).toISOString(), leaveKnown: leave.known, periods: [], items: [], gaps: [] };
  if (!leave.known) { out.gaps.push(`your leave could not be read — ${leave.reason}`); return out; }
  if (!leave.dates.size) return out;

  const isWorking = _isWorking();
  const periods = leavePeriods([...leave.dates], isWorking).map(p => ({ ...p, back: nextWorkingDay(p.to, { isWorking, leave: leave.dates }) }));
  out.periods = periods.map(({ from, to, dates, back }) => ({ from, to, days: dates.length, back }));
  const periodOf = (day) => periods.find(p => day >= p.from && day <= p.to) || null;
  const today = ymd(new Date(now));
  const horizon = addDays(periods[periods.length - 1].back, 28);

  const booking = require('./one-to-one-booking');
  const bi = booking._internals;
  let events = [];
  try { events = (await require('./microsoft').fetchCalendarEvents(today, horizon)) || []; } catch (e) {
    out.gaps.push(`calendar unreadable: ${e.message}`);
  }
  const selfEmail = await _selfEmail();
  if (!selfEmail) out.gaps.push('your own address could not be read, so solo blocks may show as meetings');
  const roster = require('./one-to-one-detect').buildRoster({ includeInactive: false }).people || [];
  const byEmail = new Map(roster.filter(p => p.email).map(p => [p.email.toLowerCase(), p.name]));

  // The diary we plan INTO: everything that stays, plus each thing we place.
  const onLeaveEvents = events.filter(ev => !/^graph-/.test(String(ev.id || '')) && onLeave(ev, leave.dates));
  const moving = new Set();
  const decided = onLeaveEvents.map(ev => ({ ev, c: classifyEvent(ev, { selfEmail, oneToOne: bi.ONE_TO_ONE_SUBJECT }) })).filter(x => x.c);
  for (const { ev, c } of decided) if (['move', 'move-121', 'cancel', 'decline'].includes(c.kind)) moving.add(ev.id);
  const working = events.filter(e => !moving.has(e.id));

  for (const { ev, c } of decided) {
    const start16 = String(ev.start).slice(0, 16);
    const day = start16.slice(0, 10);
    const p = periodOf(day) || periods[0];
    const base = { id: `ev:${ev.id}@${start16}`, eventId: ev.id, title: ev.subject || '(no subject)', when: start16,
      organizer: ev.organizer || null, attendees: (ev.attendees || []).length };
    const minutes = ev.isAllDay ? null : Math.max(15, minuteOf(ev.end) - minuteOf(ev.start));
    if (c.kind === 'decline') {
      out.items.push({ ...base, action: 'decline', why: `${ev.organizer || 'Someone else'}'s meeting on your leave` + (ev.responseStatus === 'notResponded' ? ' (not yet answered)' : '') });
    } else if (c.kind === 'cancel') {
      out.items.push({ ...base, action: 'cancel', why: 'a repeating meeting you organise — skip this one while you are off' });
    } else if (c.kind === 'move-121') {
      const person = byEmail.get(String(c.email).toLowerCase()) || null;
      if (!person) { out.items.push({ ...base, action: 'move', why: 'a 1-2-1 with someone NEURO cannot match to a report', ...placeMeeting(working, p, minutes, ev, leave.dates, isWorking) }); continue; }
      const days = bi.eligibleDays(working, p.back, addDays(p.back, 21)).filter(d => !leave.dates.has(d));
      const away = bi.awayFor(person);
      const slot = bi.findSlotInDays(working, days, 0, minutes, away.dates);
      if (slot) bi.reserve(working, person, slot);
      out.items.push({ ...base, action: 'move', person, oneToOne: true,
        proposed: slot ? { start: slot.start.slice(0, 16), end: slot.end.slice(0, 16) } : null,
        why: slot ? '1-2-1 moved to after your leave (their leave and yours checked)' : 'no 1-2-1 slot in the three weeks after your leave',
        ...bi.leaveCheckFor(away, slot && slot.date) });
    } else if (c.kind === 'move') {
      out.items.push({ ...base, action: 'move', why: 'your meeting — same time on the first free working day back', ...placeMeeting(working, p, minutes, ev, leave.dates, isWorking) });
    } else if (c.kind === 'solo') {
      const block = db.getTaskBlockByEventId ? db.getTaskBlockByEventId(ev.id) : null;
      if (block) out.items.push({ ...base, action: 'block', blockId: block.id, proposed: { date: p.back }, why: 'a task block — moved to your first day back' });
      else out.items.push({ ...base, action: 'info', why: 'your own block — left alone' });
    } else {
      out.items.push({ ...base, action: 'info', why: c.why });
    }
  }

  // Tasks due on leave days. Personal tasks stay — doing them on holiday is fine.
  const rows = db.listTaskRows({}).filter(t => t.domain !== 'personal' && t.due_date && leave.dates.has(String(t.due_date).slice(0, 10)));
  const moving_ = new Set(rows.map(t => t.id));
  const dueLoad = new Map();
  for (const t of db.listTaskRows({})) {
    if (!t.due_date || moving_.has(t.id)) continue;
    const d = String(t.due_date).slice(0, 10);
    dueLoad.set(d, (dueLoad.get(d) || 0) + (t.estimate_minutes || ASSUMED_TASK_MINUTES));
  }
  for (const t of rows) {
    const due = String(t.due_date).slice(0, 10);
    const p = periodOf(due) || periods[0];
    const size = t.estimate_minutes || ASSUMED_TASK_MINUTES;
    const commitment = t.origin === 'commitment';
    const before = [];
    for (let d = addDays(p.from, -1), n = 0; d >= today && n < SEARCH_WORKING_DAYS; d = addDays(d, -1)) {
      if (isWorking(d) && !leave.dates.has(d)) { before.push(d); n++; }
    }
    const after = [];
    for (let d = p.back, n = 0; n < SEARCH_WORKING_DAYS + 5; d = addDays(d, 1)) {
      if (isWorking(d) && !leave.dates.has(d)) { after.push(d); n++; }
    }
    const goBefore = commitment && before.length > 0;
    const pick = pickTaskDay(size, goBefore ? before : after, { events: working, dueLoad });
    if (!pick) continue;
    dueLoad.set(pick.date, (dueLoad.get(pick.date) || 0) + size);
    out.items.push({
      id: `task:${t.id}`, taskId: t.id, action: 'due', title: t.text, when: due,
      proposed: { date: pick.date }, fits: pick.fits, size, sizeAssumed: !t.estimate_minutes,
      why: (commitment ? (goBefore ? 'a commitment — due before you go' : 'a commitment, but there is no working day before your leave') : 'your own work — after you are back')
        + (pick.fits ? `, on the nearest day with room for ${size} min` : ` — no day nearby has ${size} min free; nearest offered`),
    });
  }
  out.note = 'Leave comes from People HR via NOVA (approved leave only). A half day reads as a whole day.';
  return out;
}

/** Same clock time on the first free working day back, else the first gap that day or after. */
function placeMeeting(working, period, minutes, ev, leave, isWorking) {
  if (!minutes) return { proposed: null };
  const prefer = minuteOf(ev.start);
  for (let d = period.back, n = 0; n < SEARCH_WORKING_DAYS; d = addDays(d, 1)) {
    if (!isWorking(d) || leave.has(d)) continue;
    n++;
    const s = slotOnDay(d, working, minutes, prefer);
    if (s != null) {
      working.push({ id: `held:${ev.id}`, start: clock(d, s), end: clock(d, s + minutes), showAs: 'busy' });
      return { proposed: { start: clock(d, s).slice(0, 16), end: clock(d, s + minutes).slice(0, 16) }, sameTime: s === prefer };
    }
  }
  return { proposed: null };
}

function stored() {
  try { return JSON.parse(db.getState(STATE_KEY) || 'null'); } catch { return null; }
}
function _save(a) { db.setState(STATE_KEY, JSON.stringify(a)); }

/** Recompute and store. Applied/dismissed ids are carried over so a refresh does not re-offer them. */
async function refresh({ now = new Date() } = {}) {
  const prev = stored();
  const a = await analyse({ now });
  a.done = (prev && prev.done) || {};
  a.items = a.items.filter(i => !a.done[i.id]);
  _save(a);
  return a;
}

/**
 * After the leave cache refreshes: new leave dates → recompute, and push once
 * when there is something to act on. First run treats existing leave as new.
 */
async function detectNew({ now = new Date() } = {}) {
  const leave = myLeave(now);
  if (!leave.known) return { ok: false, reason: leave.reason };
  let seen = [];
  try { seen = JSON.parse(db.getState(SEEN_KEY) || '[]'); } catch { seen = []; }
  const fresh = [...leave.dates].filter(d => !seen.includes(d));
  db.setState(SEEN_KEY, JSON.stringify([...leave.dates].sort()));
  if (!fresh.length) return { ok: true, fresh: [] };
  const a = await refresh({ now });
  const actionable = a.items.filter(i => i.action !== 'info');
  if (actionable.length) {
    try {
      await require('./webpush').sendToAll(
        `SAiM — ${actionable.length} thing${actionable.length === 1 ? '' : 's'} clash with your leave`,
        `Leave ${fresh.sort()[0]}${fresh.length > 1 ? ` to ${fresh[fresh.length - 1]}` : ''}: I've worked out where each one should go. Review on Now.`,
        { type: 'leave_clashes', url: '/?view=today' },
      );
    } catch (e) { console.warn('[LeaveGuard] push failed:', e.message); }
  }
  return { ok: true, fresh, items: actionable.length };
}

/**
 * Apply the ticked items. Internal changes happen here; anything that tells
 * another person comes back as a PREPARED governed action for the screen to
 * confirm with its own intent grant (moves/cancels), or is declined through the
 * ledger on this tap. Each item is independent; nothing is retried.
 */
async function apply({ ids = [], edits = {} } = {}) {
  const a = stored();
  if (!a || !Array.isArray(a.items)) return { ok: false, error: 'nothing to apply — refresh the leave check' };
  const pick = a.items.filter(i => ids.includes(i.id) && i.action !== 'info');
  if (!pick.length) return { ok: false, error: 'none of those items are on the card any more' };
  const pa = require('./prepared-actions');
  const results = [];
  const eventCache = new Map();
  const liveEvent = async (item) => {
    const day = item.when.slice(0, 10);
    if (!eventCache.has(day)) eventCache.set(day, (await require('./microsoft').fetchCalendarEvents(day, day).catch(() => null)) || null);
    const list = eventCache.get(day);
    if (!list) return { error: 'calendar unreadable' };
    const ev = list.find(e => e.id === item.eventId && String(e.start).slice(0, 16) === item.when);
    return ev ? { ev } : { error: 'that meeting is no longer where it was — refresh the card' };
  };

  for (const item of pick) {
    const e = edits[item.id] || {};
    try {
      if (item.action === 'due') {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : item.proposed.date;
        const row = require('./task-store').updateTask(item.taskId, { due_date: date });
        results.push({ id: item.id, ok: Boolean(row), title: item.title, detail: row ? `due ${date}` : 'task not found' });
      } else if (item.action === 'block') {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : item.proposed.date;
        const r = await require('./task-blocks').reschedule(item.blockId, { date });
        results.push({ id: item.id, ok: Boolean(r && r.ok), title: item.title, detail: r && r.ok ? `moved to ${date}` : (r && r.error) || 'not moved' });
      } else {
        const live = await liveEvent(item);
        if (live.error) { results.push({ id: item.id, ok: false, title: item.title, error: live.error }); continue; }
        if (item.action === 'decline') {
          const r = await declineForLeave(live.ev, { initiatedBy: 'nick' });
          results.push({ id: item.id, ok: r.ok, title: item.title, detail: r.ok ? (r.verified ? 'declined' : 'declined (not read back)') : null, error: r.error });
        } else if (item.action === 'cancel') {
          const r = pa.prepareCalendarCancel({ event: live.ev, comment: "Skipping this one — I'm on annual leave that day.", origin: 'leave-clash', context: { reason: 'leave' } });
          results.push({ id: item.id, ok: r.ok, title: item.title, error: r.ok ? null : r.error, action: r.ok ? _ref(r.action) : null });
        } else if (item.action === 'move') {
          const start = e.start || (item.proposed && item.proposed.start);
          const end = e.end || (item.proposed && item.proposed.end);
          if (!start || !end) { results.push({ id: item.id, ok: false, title: item.title, error: 'no new time chosen' }); continue; }
          const r = pa.prepareCalendarReschedule({
            event: live.ev, start: `${start.slice(0, 16)}:00`, end: `${end.slice(0, 16)}:00`,
            origin: item.oneToOne ? '1to1-move' : 'leave-clash',
            context: { person: item.person || null, reason: 'On annual leave' },
          });
          results.push({ id: item.id, ok: r.ok, title: item.title, error: r.ok ? null : r.error, action: r.ok ? _ref(r.action) : null });
        }
      }
    } catch (err) {
      results.push({ id: item.id, ok: false, title: item.title, error: err.message });
    }
  }
  // Internal changes and declines are done; a prepared action is done only once
  // the screen confirms it — the card marks those via `markDone`.
  a.done = a.done || {};
  for (const r of results) if (r.ok && !r.action) a.done[r.id] = new Date().toISOString();
  a.items = a.items.filter(i => !a.done[i.id]);
  _save(a);
  return { ok: results.some(r => r.ok), results };
}

function _ref(x) { return { actionId: x.actionId, version: x.version || 1, payloadHash: x.payloadHash, status: x.status, origin: x.origin }; }

/** The screen confirmed (or Nick dismissed) these items — drop them from the card. */
function markDone(ids = []) {
  const a = stored();
  if (!a) return { ok: false };
  a.done = a.done || {};
  for (const id of ids) a.done[id] = new Date().toISOString();
  a.items = (a.items || []).filter(i => !a.done[i.id]);
  _save(a);
  return { ok: true, remaining: a.items.length };
}

module.exports = {
  AUTO_FLAG, WRITER, DECLINE_COMMENT,
  analyse, refresh, stored, detectNew, apply, markDone, autoDecline, declineForLeave, myLeave,
  // pure
  onLeave, leavePeriods, nextWorkingDay, classifyEvent, freeMinutes, pickTaskDay, slotOnDay, autoDeclineCandidates,
};
