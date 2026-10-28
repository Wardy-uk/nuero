'use strict';

/**
 * Auto-schedule — spread the tasks Nick picked across working days by
 * setting their DUE DATES (Nick, 28 Oct 2026: due dates only, never the diary).
 *
 * Design calls, asked one at a time:
 *   - It writes due dates and nothing else. No calendar block, no Outlook.
 *   - "Max hours a day" is TASK time only. Meetings in the diary do not count
 *     against it — the cap is predictable rather than a guess about how much of
 *     a meeting-heavy day is really free.
 *   - Tasks are packed in LIST order (MoSCoW band, then his drag order / the
 *     score). Nothing is re-sorted here: the caller sends them in order and the
 *     plan keeps it. A small task after a big one does NOT backfill an earlier
 *     day, because that would quietly put a could-do ahead of a must-do.
 *
 * `plan()` is PURE (the pi-health.assess() split) — no DB, no clock, no
 * network — so the packing rule pins without a calendar. `planFor()` adds the
 * two facts only the server has: bank holidays and Nick's booked leave.
 *
 * This module PLANS. It writes nothing; the panel applies each date through the
 * existing task and Microsoft edit routes, so there is no second write path.
 */

const shared = require('../../shared/working-days.cjs');

const ASSUMED_MINUTES = 30;          // time-fit's assumption, said on every row it fills
const MIN_HOURS = 0.5;
const MAX_HOURS = 12;
const MAX_ITEMS = 200;
const MAX_SPAN_DAYS = 366;           // a plan running past a year is a typo, not a plan

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function _parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const d = new Date(`${s}T12:00:00`);
  if (Number.isNaN(d.getTime()) || shared.toDateStr(d) !== s) return null; // 2026-02-31 is refused, not rolled
  return d;
}

/**
 * Refused, never clamped: a clamped input answers a question nobody asked while
 * looking like it answered the one they did.
 */
function validate({ startDate, maxHours, items, today }) {
  const start = _parseDay(startDate);
  if (!start) return 'startDate must be a real date (YYYY-MM-DD)';
  if (today && startDate < today) return 'startDate is in the past';
  const h = Number(maxHours);
  if (!Number.isFinite(h) || h < MIN_HOURS || h > MAX_HOURS) return `maxHours must be between ${MIN_HOURS} and ${MAX_HOURS}`;
  if (!Array.isArray(items) || !items.length) return 'pick at least one task';
  if (items.length > MAX_ITEMS) return `at most ${MAX_ITEMS} tasks at once`;
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it.key !== 'string' || !it.key) return 'every task needs a key';
    if (seen.has(it.key)) return `task ${it.key} is listed twice`;
    seen.add(it.key);
    const m = it.estimateMinutes;
    if (m != null && (!Number.isFinite(Number(m)) || Number(m) <= 0)) return `task ${it.key} has an unusable estimate`;
  }
  return null;
}

/**
 * Pack `items` (in order) into working days from `startDate`.
 *   nonWorking — Set of YYYY-MM-DD bank holidays / leave days to skip
 *   reasons    — optional Map day -> 'holiday' | 'leave' (for the skipped list)
 */
function plan({ startDate, maxHours, items, nonWorking = new Set(), reasons = new Map() }) {
  const cap = Math.round(Number(maxHours) * 60);
  const skipped = [];
  const days = [];
  const assignments = [];

  let cursor = _parseDay(startDate);
  let spanned = 0;
  const firstWorking = (d) => {
    while (!shared.isWorkingDay(d, nonWorking)) {
      const key = shared.toDateStr(d);
      const why = reasons.get(key) || shared.nonWorkingReason(d, nonWorking);
      if (why && why !== 'weekend') skipped.push({ date: key, reason: why });
      d = shared.addDays(d, 1);
      if (++spanned > MAX_SPAN_DAYS) return null;
    }
    return d;
  };

  cursor = firstWorking(cursor);
  let day = null;
  const openDay = (d) => { day = { date: shared.toDateStr(d), minutes: 0, keys: [], overCap: false }; days.push(day); };
  if (cursor) openDay(cursor);

  for (const it of items) {
    if (!cursor) break;
    const assumed = it.estimateMinutes == null;
    const minutes = assumed ? ASSUMED_MINUTES : Math.round(Number(it.estimateMinutes));
    if (day.minutes > 0 && day.minutes + minutes > cap) {
      cursor = firstWorking(shared.addDays(cursor, 1));
      if (!cursor) break;
      spanned += 1;
      openDay(cursor);
    }
    // A task bigger than the cap gets a day of its own and says so, rather than
    // never fitting anywhere.
    day.minutes += minutes;
    day.keys.push(it.key);
    if (day.minutes > cap) day.overCap = true;
    assignments.push({ key: it.key, date: day.date, minutes, assumed, overCap: minutes > cap });
  }

  const unplaced = items.slice(assignments.length).map(it => it.key);
  return {
    capMinutes: cap,
    assignments,
    days,
    skipped,
    unplaced,
    assumedCount: assignments.filter(a => a.assumed).length,
    lastDate: days.length ? days[days.length - 1].date : null,
  };
}

/**
 * The server half: bank holidays from working-days, Nick's leave from People HR
 * (via team-availability). Unknown leave never blocks the plan, but it is SAID —
 * a plan that skipped the check must never pass for one that made it.
 */
function planFor({ startDate, maxHours, items, now = new Date() }) {
  const today = shared.toDateStr(now);
  const problem = validate({ startDate, maxHours, items, today });
  if (problem) return { ok: false, error: problem };

  const workingDays = require('./working-days');
  const holidays = workingDays.holidaySet();
  const nonWorking = new Set(holidays);
  const reasons = new Map([...holidays].map(d => [d, 'holiday']));

  let leave = { checked: false, reason: 'not read', coversTo: null };
  try {
    const availability = require('./team-availability');
    const off = availability.selfDaysOff(availability.snapshot(now));
    if (off.known) {
      for (const d of off.dates) { nonWorking.add(d); if (!reasons.has(d)) reasons.set(d, 'leave'); }
      leave = { checked: true, reason: null, coversTo: off.coversTo || null };
    } else {
      leave = { checked: false, reason: off.reason || 'leave could not be read', coversTo: null };
    }
  } catch (e) {
    leave = { checked: false, reason: e.message, coversTo: null };
  }

  const result = plan({ startDate, maxHours, items, nonWorking, reasons });
  // Leave is only known up to the feed's horizon; days past it were not checked.
  const pastHorizon = leave.checked && leave.coversTo && result.lastDate && result.lastDate > leave.coversTo;
  return { ok: true, ...result, leave: { ...leave, pastHorizon: Boolean(pastHorizon) } };
}

module.exports = { plan, planFor, validate, ASSUMED_MINUTES, MIN_HOURS, MAX_HOURS };
