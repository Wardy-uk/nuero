'use strict';

/**
 * Repeating NEURO tasks — the schedule, PURE (17 Oct 2026).
 *
 * Nick's rules, and the whole design hangs off them:
 *
 *   1. FIXED CALENDAR SLOTS. The next due date is computed from the schedule,
 *      never from when the box was ticked. A fortnightly review due on a
 *      Saturday stays on Saturdays however late it is done.
 *   2. ONE OPEN COPY, EVER. A repeating task that is overdue stays ONE task.
 *      Ticking it moves it to the next slot that is still in the future — any
 *      slots missed in between are skipped, never stacked up as a backlog.
 *
 * Nothing here touches a database, a clock or the network: `today` and the
 * non-working set are passed in, so every rule pins without a Pi under it (the
 * `working-days.cjs` split). Dates are `YYYY-MM-DD` strings throughout and all
 * arithmetic is done in UTC on those strings, so BST cannot move a slot.
 *
 * A rule is one of four kinds, always with an `anchor` (the first slot the
 * series is counted from) and an `every`:
 *
 *   { kind: 'interval',         every: 2, unit: 'day'|'week'|'month', anchor }
 *   { kind: 'weekdays',         every: 1, days: ['mon','wed','fri'],  anchor }
 *   { kind: 'nth-weekday',      every: 1, nth: 1|2|3|4|-1, weekday: 'mon', anchor }
 *   { kind: 'last-working-day', every: 1, anchor }
 *
 * ⚠ A month interval is counted from the ANCHOR each time, never chained from
 * the previous slot: a series anchored on 31 Jan goes 28/29 Feb, 31 Mar, 30 Apr,
 * 31 May. Chaining would lose the 31st for ever after the first February.
 */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_WORDS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const NTH_WORDS = { 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', '-1': 'Last' };
const KINDS = ['interval', 'weekdays', 'nth-weekday', 'last-working-day'];
const UNITS = ['day', 'week', 'month'];
// Refused above these, never clamped. A fortnightly review typed as "every 200
// weeks" is a typo, and quietly turning it into 52 would be the system
// disagreeing with him while looking like it agreed.
const MAX_EVERY = { day: 365, week: 52, month: 24 };
const ALLOWED_KEYS = {
  interval: ['kind', 'every', 'unit', 'anchor'],
  weekdays: ['kind', 'every', 'days', 'anchor'],
  'nth-weekday': ['kind', 'every', 'nth', 'weekday', 'anchor'],
  'last-working-day': ['kind', 'every', 'anchor'],
};
// How far forward a search may look before it is a bug, not a schedule.
const SEARCH_LIMIT_DAYS = 366 * 3;

// ── Date strings, in UTC ────────────────────────────────────────────────────

function isDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = _toUtc(s);
  // Round-trips, so 2026-02-31 is refused rather than rolled into March.
  return !Number.isNaN(d.getTime()) && _fromUtc(d) === s;
}

function _toUtc(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function _fromUtc(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function addDays(s, n) {
  const d = _toUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return _fromUtc(d);
}

function daysBetween(a, b) {
  return Math.round((_toUtc(b).getTime() - _toUtc(a).getTime()) / 86400000);
}

function _dow(s) {
  return _toUtc(s).getUTCDay();
}

function _daysInMonth(y, m0) {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** The anchor's day of month, clamped into a shorter month — counted from the anchor. */
function addMonthsClamped(anchor, months) {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = (m - 1) + months;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const day = Math.min(d, _daysInMonth(ty, tm));
  return _fromUtc(new Date(Date.UTC(ty, tm, day)));
}

function _monthIndex(s) {
  const [y, m] = s.split('-').map(Number);
  return y * 12 + (m - 1);
}

function _monthStart(index) {
  return _fromUtc(new Date(Date.UTC(Math.floor(index / 12), index % 12, 1)));
}

function _mondayOf(s) {
  const dow = _dow(s);
  return addDays(s, dow === 0 ? -6 : 1 - dow);
}

function _isNonWorking(s, nonWorking) {
  const dow = _dow(s);
  if (dow === 0 || dow === 6) return true;
  return Boolean(nonWorking && typeof nonWorking.has === 'function' && nonWorking.has(s));
}

/** The nth (1-4) or last (-1) given weekday of the month at `index`. */
function _nthWeekdayOf(index, nth, weekday) {
  const target = DAY_NAMES.indexOf(weekday);
  const first = _monthStart(index);
  if (nth === -1) {
    const [y, m] = first.split('-').map(Number);
    let s = _fromUtc(new Date(Date.UTC(y, m - 1, _daysInMonth(y, m - 1))));
    while (_dow(s) !== target) s = addDays(s, -1);
    return s;
  }
  let s = first;
  while (_dow(s) !== target) s = addDays(s, 1);
  return addDays(s, 7 * (nth - 1));
}

/**
 * The last WORKING day of the month at `index`: back from the month end over
 * weekends and anything in `nonWorking` (bank holidays). A month whose last
 * Friday is Good Friday's neighbour still lands on a day the office is open.
 */
function _lastWorkingDayOf(index, nonWorking) {
  const first = _monthStart(index);
  const [y, m] = first.split('-').map(Number);
  let s = _fromUtc(new Date(Date.UTC(y, m - 1, _daysInMonth(y, m - 1))));
  for (let i = 0; i < 31 && _isNonWorking(s, nonWorking); i += 1) s = addDays(s, -1);
  return s;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Check a rule and return it normalised, or refuse it with a reason.
 *
 * ⚠ REFUSED, NEVER CLAMPED OR GUESSED. An unknown kind, an unknown key, a day
 * name nobody recognises or an `every` out of range is a 400 with the reason —
 * "I did not understand you" and "I did something slightly different" are not
 * the same answer, and only one of them is honest about a schedule that will
 * put work in front of him for months.
 *
 * `defaultAnchor` is used when the rule carries none (the task's due date, else
 * today — the caller decides).
 */
function validateRule(input, { defaultAnchor = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'recurrence must be an object' };
  }
  const kind = input.kind;
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `recurrence.kind must be one of ${KINDS.join(', ')}` };
  }
  const unknown = Object.keys(input).filter(k => !ALLOWED_KEYS[kind].includes(k));
  if (unknown.length) return { ok: false, error: `recurrence has unknown field(s) for ${kind}: ${unknown.join(', ')}` };

  const every = input.every == null ? 1 : input.every;
  if (!Number.isInteger(every) || every < 1) return { ok: false, error: 'recurrence.every must be a whole number of 1 or more' };

  const anchor = input.anchor == null ? defaultAnchor : input.anchor;
  if (!isDateStr(anchor)) return { ok: false, error: 'recurrence.anchor must be a real date (YYYY-MM-DD)' };

  if (kind === 'interval') {
    if (!UNITS.includes(input.unit)) return { ok: false, error: `recurrence.unit must be one of ${UNITS.join(', ')}` };
    if (every > MAX_EVERY[input.unit]) return { ok: false, error: `recurrence.every is at most ${MAX_EVERY[input.unit]} for ${input.unit}s` };
    return { ok: true, rule: { kind, every, unit: input.unit, anchor } };
  }
  if (kind === 'weekdays') {
    if (every > MAX_EVERY.week) return { ok: false, error: `recurrence.every is at most ${MAX_EVERY.week} weeks` };
    if (!Array.isArray(input.days) || !input.days.length) return { ok: false, error: 'recurrence.days must list at least one day (mon..sun)' };
    const days = input.days.map(d => String(d).toLowerCase());
    const bad = days.filter(d => !DAY_NAMES.includes(d));
    if (bad.length) return { ok: false, error: `recurrence.days has unknown day(s): ${bad.join(', ')}` };
    if (new Set(days).size !== days.length) return { ok: false, error: 'recurrence.days lists a day twice' };
    // Stored Monday-first, so two equal rules compare equal and label the same.
    const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    return { ok: true, rule: { kind, every, days: order.filter(d => days.includes(d)), anchor } };
  }
  if (kind === 'nth-weekday') {
    if (every > MAX_EVERY.month) return { ok: false, error: `recurrence.every is at most ${MAX_EVERY.month} months` };
    // No 5th: "5th Monday" does not exist in most months, and silently skipping
    // those months is a schedule nobody asked for. Last (-1) covers the intent.
    if (![1, 2, 3, 4, -1].includes(input.nth)) return { ok: false, error: 'recurrence.nth must be 1, 2, 3, 4 or -1 (last)' };
    const weekday = String(input.weekday || '').toLowerCase();
    if (!DAY_NAMES.includes(weekday)) return { ok: false, error: 'recurrence.weekday must be a day (mon..sun)' };
    return { ok: true, rule: { kind, every, nth: input.nth, weekday, anchor } };
  }
  // last-working-day
  if (every > MAX_EVERY.month) return { ok: false, error: `recurrence.every is at most ${MAX_EVERY.month} months` };
  return { ok: true, rule: { kind, every, anchor } };
}

function parseStored(json) {
  if (!json) return null;
  try {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    const v = validateRule(raw);
    return v.ok ? v.rule : null;
  } catch {
    return null;
  }
}

// ── The schedule ────────────────────────────────────────────────────────────

/**
 * The first slot of the series on or after `from`. PURE.
 * Never earlier than the anchor. Null only if nothing is found inside a
 * three-year search, which a valid rule cannot produce.
 */
function firstSlotOnOrAfter(rule, from, nonWorking = null) {
  const start = from < rule.anchor ? rule.anchor : from;

  if (rule.kind === 'interval' && rule.unit !== 'month') {
    const step = rule.every * (rule.unit === 'week' ? 7 : 1);
    const gap = daysBetween(rule.anchor, start);
    const k = Math.max(0, Math.ceil(gap / step));
    return addDays(rule.anchor, k * step);
  }

  if (rule.kind === 'interval') {
    // Months: counted from the anchor, clamped into short months.
    let k = Math.max(0, Math.floor((_monthIndex(start) - _monthIndex(rule.anchor)) / rule.every) - 1);
    for (let i = 0; i < 400; i += 1, k += 1) {
      const slot = addMonthsClamped(rule.anchor, k * rule.every);
      if (slot >= start) return slot;
    }
    return null;
  }

  if (rule.kind === 'weekdays') {
    const anchorWeek = _mondayOf(rule.anchor);
    let s = start;
    for (let i = 0; i < SEARCH_LIMIT_DAYS; i += 1, s = addDays(s, 1)) {
      if (!rule.days.includes(DAY_NAMES[_dow(s)])) continue;
      const weeks = Math.round(daysBetween(anchorWeek, _mondayOf(s)) / 7);
      if (weeks % rule.every === 0) return s;
    }
    return null;
  }

  // nth-weekday / last-working-day: a slot per eligible month, counted from the
  // anchor's month.
  const anchorMonth = _monthIndex(rule.anchor);
  let index = Math.max(anchorMonth, _monthIndex(start) - 1);
  for (let i = 0; i < 400; i += 1, index += 1) {
    if ((index - anchorMonth) % rule.every !== 0) continue;
    const slot = rule.kind === 'nth-weekday'
      ? _nthWeekdayOf(index, rule.nth, rule.weekday)
      : _lastWorkingDayOf(index, nonWorking);
    if (slot >= start) return slot;
  }
  return null;
}

/**
 * The due date after an occurrence is completed. PURE.
 *
 * The first slot strictly after BOTH the occurrence that was due and today:
 *   - done early (due Sat 31 Oct, ticked Thu 29th) → the slot after the 31st;
 *   - done late (due 31 Oct, ticked 20 Nov) → 14 Nov has gone, so 28 Nov. The
 *     missed slot is SKIPPED, never stacked — one open copy, ever;
 *   - ⚠ a slot falling TODAY counts as covered by today's tick. Doing an
 *     overdue occurrence on the day the next one falls due does the work once,
 *     and leaving it due today would ask for it twice in one sitting.
 *
 * `completedDue` may be null (a repeating task that somehow has no date): then
 * today alone decides.
 */
function nextDueAfterCompletion(rule, { completedDue = null, today, nonWorking = null } = {}) {
  if (!rule || !isDateStr(today)) return null;
  const floor = isDateStr(completedDue) && completedDue > today ? completedDue : today;
  return firstSlotOnOrAfter(rule, addDays(floor, 1), nonWorking);
}

/** The first due date for a task that has just been given a rule. */
function firstDue(rule, { today, nonWorking = null } = {}) {
  if (!rule || !isDateStr(today)) return null;
  return firstSlotOnOrAfter(rule, today < rule.anchor ? rule.anchor : today, nonWorking);
}

/** Up to `count` slots from `from` — for previews and tests. */
function upcoming(rule, { from, count = 5, nonWorking = null } = {}) {
  const out = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    const s = firstSlotOnOrAfter(rule, cursor, nonWorking);
    if (!s) break;
    out.push(s);
    cursor = addDays(s, 1);
  }
  return out;
}

// ── Words ───────────────────────────────────────────────────────────────────

function _ordinalMonths(every) {
  return every === 1 ? 'every month' : `every ${every} months`;
}

/** How a rule reads on a card. Null for no rule — never "one-off" on every row. */
function describe(rule) {
  if (!rule) return null;
  const every = rule.every || 1;
  if (rule.kind === 'interval') {
    if (every === 1) return { day: 'Every day', week: 'Every week', month: 'Every month' }[rule.unit];
    return `Every ${every} ${rule.unit}s`;
  }
  if (rule.kind === 'weekdays') {
    const isWorkweek = rule.days.length === 5 && !rule.days.includes('sat') && !rule.days.includes('sun');
    if (every === 1 && isWorkweek) return 'Every weekday';
    const list = rule.days.length === 1 ? DAY_WORDS[rule.days[0]] : rule.days.map(d => DAY_LABELS[d]).join(', ');
    return every === 1 ? `Every ${list}` : `Every ${every} weeks on ${list}`;
  }
  if (rule.kind === 'nth-weekday') {
    const base = `${NTH_WORDS[String(rule.nth)]} ${DAY_WORDS[rule.weekday]} of the month`;
    return every === 1 ? base : `${NTH_WORDS[String(rule.nth)]} ${DAY_WORDS[rule.weekday]}, ${_ordinalMonths(every)}`;
  }
  if (rule.kind === 'last-working-day') {
    return every === 1 ? 'Last working day of the month' : `Last working day, ${_ordinalMonths(every)}`;
  }
  return null;
}

/** "Fri 14 Nov" — sliced from the string, never a Date in the reader's zone. */
function shortDate(s) {
  if (!isDateStr(s)) return null;
  const d = _toUtc(s);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${DAY_LABELS[DAY_NAMES[d.getUTCDay()]]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

module.exports = {
  KINDS,
  UNITS,
  DAY_NAMES,
  MAX_EVERY,
  isDateStr,
  addDays,
  addMonthsClamped,
  validateRule,
  parseStored,
  firstSlotOnOrAfter,
  nextDueAfterCompletion,
  firstDue,
  upcoming,
  describe,
  shortDate,
};
