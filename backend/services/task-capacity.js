'use strict';

/**
 * Can the work due actually be done in the time there is? (5 Oct 2026)
 *
 * Two questions, both from the task SIZES (the estimate is the top of the
 * band — shared/task-size.cjs) against the free time in the diary:
 *
 *   OVER CAPACITY — for each coming day, the work due BY that day (overdue
 *   counts from now) against the free time between now and the end of that
 *   day. Cumulative, because work due Friday can be done Tuesday: a single
 *   day "over" means nothing if the days before it are empty.
 *
 *   START BY — for a big task (more than an hour), the latest moment to start
 *   it and still finish by its due date, walking BACK through free time. If
 *   that moment is already past, it cannot be done in time on free time alone.
 *   Each big task is judged on its own; the cumulative check is what catches
 *   several of them competing for the same hours.
 *
 * Free time: working days only (working-days), 09:00–17:30 (task-blocks' slot
 * window), minus diary entries that block (cancelled / free / all-day are not
 * walls — findSlot's rule, so the two cannot disagree). NEURO's own task
 * blocks are NOT busy here: they are time for this work.
 *
 * ⚠ An unestimated task counts as ASSUMED_MINUTES and is counted as assumed —
 * the answer says how many of its minutes are guesses. ⚠ An unreadable diary
 * is `known:false`, never "you are free all week".
 */

const DAY_START_MIN = 9 * 60;
const DAY_END_MIN = 17 * 60 + 30;
const ASSUMED_MINUTES = 30;
const HORIZON_DAYS = 14;
const SHOW_DAYS = 7;
const BIG_TASK_MINUTES = 60; // above this is M or bigger

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minOf = (iso) => {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** Free intervals [start,end) in minutes for one day. PURE. */
function freeIntervals({ busy = [], fromMin = DAY_START_MIN }) {
  let cursor = Math.max(DAY_START_MIN, fromMin);
  const out = [];
  const sorted = busy.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  for (const [s, e] of sorted) {
    if (e <= cursor) continue;
    if (s >= DAY_END_MIN) break;
    if (s > cursor) out.push([cursor, Math.min(s, DAY_END_MIN)]);
    cursor = Math.max(cursor, e);
    if (cursor >= DAY_END_MIN) break;
  }
  if (cursor < DAY_END_MIN) out.push([cursor, DAY_END_MIN]);
  return out;
}

/**
 * PURE. tasks: [{ id, text, due (YYYY-MM-DD|null), minutes|null }]
 * events: [{ date, start, end, isAllDay, showAs }]   now: Date
 * isWorking: (Date) => bool
 */
function computeCapacity({ tasks = [], events = [], now = new Date(), isWorking = () => true, horizon = HORIZON_DAYS }) {
  const today = dayKey(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const busyByDay = new Map();
  for (const ev of events) {
    if (!ev || ev.isAllDay || ev.showAs === 'free' || ev.showAs === 'cancelled') continue;
    const s = minOf(ev.start); const e = minOf(ev.end);
    if (s == null || e == null) continue;
    const k = String(ev.date || String(ev.start).slice(0, 10));
    if (!busyByDay.has(k)) busyByDay.set(k, []);
    busyByDay.get(k).push([s, e]);
  }

  // The days, with their free time.
  const days = [];
  for (let i = 0; i < horizon; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const key = dayKey(d);
    const working = isWorking(d);
    const free = working ? freeIntervals({ busy: busyByDay.get(key) || [], fromMin: i === 0 ? nowMin : DAY_START_MIN }) : [];
    days.push({ date: key, working, free, freeMinutes: free.reduce((a, [s, e]) => a + (e - s), 0) });
  }
  const indexOf = new Map(days.map((d, i) => [d.date, i]));

  const est = (t) => (Number.isFinite(t.minutes) && t.minutes > 0 ? t.minutes : ASSUMED_MINUTES);
  const dated = tasks.filter((t) => t && t.due);
  let assumedCount = 0;

  // ── Over capacity, cumulatively ──
  const dueOn = new Array(days.length).fill(0);
  for (const t of dated) {
    if (!(Number.isFinite(t.minutes) && t.minutes > 0)) assumedCount += 1;
    const i = t.due < today ? 0 : indexOf.get(t.due);
    if (i === undefined) continue; // beyond the horizon
    dueOn[i] += est(t);
  }
  let cumDue = 0; let cumFree = 0; let overload = null;
  const shown = days.slice(0, SHOW_DAYS).map((d, i) => {
    cumDue += dueOn[i]; cumFree += d.freeMinutes;
    const short = cumDue - cumFree;
    if (short > 0 && !overload) overload = { by: d.date, shortMinutes: short, dueMinutes: cumDue, freeMinutes: cumFree };
    return { date: d.date, working: d.working, freeMinutes: d.freeMinutes, dueMinutes: dueOn[i], cumulativeDue: cumDue, cumulativeFree: cumFree, shortMinutes: Math.max(0, short) };
  });

  // ── Start by, for big tasks ──
  const startBy = [];
  for (const t of dated) {
    const need = est(t);
    if (!(Number.isFinite(t.minutes) && t.minutes > BIG_TASK_MINUTES)) continue;
    const endIdx = t.due < today ? 0 : indexOf.get(t.due);
    if (endIdx === undefined) continue;
    let remaining = need; let latest = null;
    for (let i = endIdx; i >= 0 && remaining > 0; i--) {
      const free = days[i].free;
      for (let j = free.length - 1; j >= 0 && remaining > 0; j--) {
        const [s, e] = free[j];
        const take = Math.min(remaining, e - s);
        remaining -= take;
        if (remaining === 0) latest = { date: days[i].date, time: hhmm(e - take) };
      }
    }
    // overdue: already past its date — the question is only how soon.
    // cannot-finish: even starting now, the free time before the due date is short.
    // start-today: the latest start falls today.
    let status = null;
    if (t.due < today) status = 'overdue';
    else if (remaining > 0) status = 'cannot-finish';
    else if (latest.date === today) status = 'start-today';
    if (status) {
      startBy.push({ id: t.id, text: t.text, due: t.due, minutes: need, latestStart: latest, status, shortMinutes: Math.max(0, remaining) });
    }
  }
  const RANK = { overdue: 0, 'cannot-finish': 1, 'start-today': 2 };
  startBy.sort((a, b) => RANK[a.status] - RANK[b.status] || String(a.due).localeCompare(String(b.due)));

  return { known: true, days: shown, overload, startBy, assumedCount, datedCount: dated.length };
}

/** Read the open tasks and the diary, then compute. Never throws. */
function read({ now = new Date() } = {}) {
  let tasks;
  try {
    tasks = require('./task-store').activeTodos().map((t) => ({
      id: t.task_id || null,
      text: t.text,
      due: t.due_date ? String(t.due_date).slice(0, 10) : null,
      minutes: t.estimateMinutes == null ? null : Number(t.estimateMinutes),
    }));
  } catch (e) {
    return { known: false, why: `tasks unreadable: ${e.message}` };
  }
  let events = [];
  try {
    const db = require('../db/database');
    const to = new Date(now.getTime() + HORIZON_DAYS * 86400000);
    events = db.getCalendarEvents(`${dayKey(now)}T00:00:00`, `${dayKey(to)}T23:59:59`).map((r) => ({
      date: String(r.start_time || '').slice(0, 10), start: r.start_time, end: r.end_time,
      isAllDay: Boolean(r.is_all_day), showAs: r.show_as || 'busy',
    }));
  } catch (e) {
    return { known: false, why: `diary unreadable: ${e.message}` };
  }
  let isWorking = (d) => d.getDay() !== 0 && d.getDay() !== 6;
  try {
    const wd = require('../../shared/working-days.cjs');
    const set = require('./working-days').holidaySet();
    isWorking = (d) => wd.isWorkingDay(d, set);
  } catch { /* weekends-only fallback */ }
  return computeCapacity({ tasks, events, now, isWorking });
}

module.exports = { computeCapacity, freeIntervals, read, ASSUMED_MINUTES, BIG_TASK_MINUTES, DAY_START_MIN, DAY_END_MIN };
