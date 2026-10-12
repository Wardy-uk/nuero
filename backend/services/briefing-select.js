'use strict';

/**
 * What goes in a briefing, and in what order (12 Oct 2026). PURE — no DB, no
 * clock, no network — so the rules pin without any of them.
 *
 * Nick's brief: "she needs to know everything that I need to know before I need
 * to know it — not a fixed agenda". So nothing here is a section that always
 * exists. Every source PROPOSES candidates (briefing-gather.js); this module
 * decides which earn a place:
 *
 *   1. A day off drops WORK before ranking — not hidden after — except a
 *      candidate marked `critical` (the exception the Surface already makes).
 *   2. Below `BAR` a candidate is held back and COUNTED, never silently lost.
 *   3. Order is needs-you first, then priority, then time of day.
 *   4. The push carries the top `push` items; the screen carries up to `screen`.
 *   5. Sections are derived from what the items ARE, and an empty one does not
 *      exist. "Needs you" is a fact about the item, not a heading to fill.
 *   6. It always ends honestly: what could not be read is named. A blind spot
 *      must never look like a quiet day.
 *
 * Learning is bounded and visible: a kind Nick keeps marking "not useful" loses
 * priority (`penaltyFor`), never below the bar for something that needs him,
 * and every adjustment is reported on the payload.
 */

const SPHERES = Object.freeze(['work', 'personal', 'health', 'context']);
const BAR = 30;
const DEFAULT_BUDGET = Object.freeze({ push: 3, screen: 14 });

// Learning from "not useful": 5 points per dismissal in the window, capped.
const PENALTY_PER_DISMISSAL = 5;
const PENALTY_CAP = 20;
const FEEDBACK_WINDOW_DAYS = 30;

const SECTION_ORDER = Object.freeze(['needs-you', 'today', 'coming-up', 'worth-knowing']);
const SECTION_LABELS = Object.freeze({
  'needs-you': 'Needs you',
  today: 'Today',
  'coming-up': 'Coming up',
  'worth-knowing': 'Worth knowing',
});

function _num(v, d = 0) {
  return Number.isFinite(v) ? v : d;
}

/**
 * Validate and normalise one candidate. Returns null for anything unusable,
 * so a gatherer's bug costs one line rather than the briefing.
 */
function normalise(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.key !== 'string' || !c.key) return null;
  if (typeof c.title !== 'string' || !c.title.trim()) return null;
  const sphere = SPHERES.includes(c.sphere) ? c.sphere : null;
  if (!sphere) return null;
  return {
    key: c.key,
    kind: typeof c.kind === 'string' && c.kind ? c.kind : 'other',
    sphere,
    title: c.title.trim(),
    detail: typeof c.detail === 'string' && c.detail.trim() ? c.detail.trim() : null,
    why: typeof c.why === 'string' && c.why.trim() ? c.why.trim() : null,
    priority: Math.max(0, Math.min(100, _num(c.priority, 0))),
    needsYou: c.needsYou === true,
    critical: c.critical === true,
    when: typeof c.when === 'string' && /^\d{2}:\d{2}$/.test(c.when) ? c.when : null,
    date: typeof c.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : null,
    source: typeof c.source === 'string' ? c.source : null,
    link: typeof c.link === 'string' ? c.link : null,
    items: Array.isArray(c.items) ? c.items.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8) : [],
  };
}

/**
 * Should a dated thing surface today? The lead-time rule: from `leadDays`
 * before it is due until the day itself; anything overdue by up to
 * `overdueDays` also surfaces. Dates are YYYY-MM-DD strings compared as
 * strings — never parsed into a Date, which re-applies a zone.
 */
function withinLead({ due, today, leadDays = 0, overdueDays = 14 }) {
  if (!due || !today) return false;
  const d = _dayIndex(due);
  const t = _dayIndex(today);
  if (d === null || t === null) return false;
  const diff = d - t; // days until due
  return diff <= leadDays && diff >= -overdueDays;
}

function _dayIndex(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

/** Days from `today` to `date` (negative = past). Null when either is unreadable. */
function daysBetween(today, date) {
  const a = _dayIndex(today);
  const b = _dayIndex(date);
  return a === null || b === null ? null : b - a;
}

/**
 * The priority penalty for a kind, from Nick's recent "not useful" presses.
 * `feedback` is { [kind]: [YYYY-MM-DD, …] }.
 */
function penaltyFor(kind, feedback, today) {
  const dates = Array.isArray(feedback?.[kind]) ? feedback[kind] : [];
  const recent = dates.filter((d) => {
    const n = daysBetween(d, today);
    return n !== null && n >= 0 && n <= FEEDBACK_WINDOW_DAYS;
  }).length;
  return Math.min(PENALTY_CAP, recent * PENALTY_PER_DISMISSAL);
}

/** Which section an item belongs in — derived from what it is. */
function sectionOf(item, today) {
  if (item.needsYou) return 'needs-you';
  if (item.when || (item.date && item.date === today)) return 'today';
  if (item.date && daysBetween(today, item.date) > 0) return 'coming-up';
  return 'worth-knowing';
}

function _compare(a, b) {
  if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
  if (b.effective !== a.effective) return b.effective - a.effective;
  const at = a.when || '99:99';
  const bt = b.when || '99:99';
  if (at !== bt) return at.localeCompare(bt);
  return a.key.localeCompare(b.key);
}

/**
 * Select and arrange.
 *
 *   candidates  raw candidates from the gatherers
 *   dayType     'work' | 'off'
 *   today       YYYY-MM-DD
 *   feedback    { [kind]: dates[] } — "not useful" presses
 *   budget      { push, screen }
 *   gaps        [{ source, why }] — sources that could not be read
 */
function select({ candidates = [], dayType = 'work', today = null, feedback = {}, budget = DEFAULT_BUDGET, gaps = [] } = {}) {
  const held = { work: 0, belowBar: 0, overBudget: 0, invalid: 0 };
  const adjusted = [];
  const seen = new Set();
  const pool = [];

  for (const raw of candidates) {
    const c = normalise(raw);
    if (!c) { held.invalid += 1; continue; }
    if (seen.has(c.key)) continue; // first proposal of a thing wins
    seen.add(c.key);

    // 1. A day off is not a work day with the work hidden.
    if (dayType === 'off' && c.sphere === 'work' && !c.critical) { held.work += 1; continue; }

    // Learning, bounded: never applied to something that needs him or is critical.
    let effective = c.priority;
    if (!c.needsYou && !c.critical) {
      const p = penaltyFor(c.kind, feedback, today);
      if (p > 0) {
        effective = Math.max(0, effective - p);
        adjusted.push({ key: c.key, kind: c.kind, penalty: p });
      }
    }

    // 2. The bar. Something that needs him always clears it.
    if (!c.needsYou && !c.critical && effective < BAR) { held.belowBar += 1; continue; }

    pool.push({ ...c, effective });
  }

  pool.sort(_compare);

  const screenMax = Math.max(1, _num(budget?.screen, DEFAULT_BUDGET.screen));
  const pushMax = Math.max(0, _num(budget?.push, DEFAULT_BUDGET.push));
  // Needs-you items are never cut by the budget: dropping one is the failure
  // the whole briefing exists to prevent.
  const needs = pool.filter((i) => i.needsYou || i.critical);
  const rest = pool.filter((i) => !(i.needsYou || i.critical));
  const room = Math.max(0, screenMax - needs.length);
  const shown = [...needs, ...rest.slice(0, room)];
  held.overBudget = rest.length - Math.min(rest.length, room);

  const items = shown.map((i) => ({ ...i, section: sectionOf(i, today) }));
  const sections = SECTION_ORDER
    .map((id) => ({ id, label: SECTION_LABELS[id], items: items.filter((i) => i.section === id) }))
    .filter((s) => s.items.length > 0);

  const push = items.slice(0, pushMax).map((i) => i.key);
  const needsYouCount = items.filter((i) => i.section === 'needs-you').length;

  return {
    dayType,
    sections,
    items,
    push,
    needsYouCount,
    held,
    adjusted,
    gaps: (Array.isArray(gaps) ? gaps : []).filter((g) => g && g.source),
    close: closingLine({ needsYouCount, shown: items.length, gaps }),
  };
}

/** The honest close. A blind spot is named; a clear day is said once. */
function closingLine({ needsYouCount = 0, shown = 0, gaps = [] } = {}) {
  const blind = (gaps || []).filter((g) => g && g.source).map((g) => g.source);
  const parts = [];
  if (!shown) parts.push('Nothing needs you.');
  else if (!needsYouCount) parts.push('Nothing else needs you.');
  else parts.push('That’s everything that needs you.');
  if (blind.length) {
    parts.push(`I couldn’t read ${_list(blind)}, so this isn’t the whole picture.`);
  }
  return parts.join(' ');
}

function _list(xs) {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** The push headline + body, composed once from the selection. */
function pushText(selection, { kind = 'daily', dayLabel = '' } = {}) {
  const top = selection.items.filter((i) => selection.push.includes(i.key));
  const n = selection.needsYouCount;
  const title = kind === 'weekly'
    ? `Weekly briefing${dayLabel ? ` — ${dayLabel}` : ''}`
    : n
      ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you today`
      : `Your ${selection.dayType === 'off' ? 'day off' : 'day'}${dayLabel ? ` — ${dayLabel}` : ''}`;
  const lines = top.map((i) => `• ${i.title}`);
  if (!lines.length) lines.push(selection.close);
  return { title, body: lines.join('\n') };
}

module.exports = {
  select, normalise, withinLead, daysBetween, penaltyFor, sectionOf, closingLine, pushText,
  SPHERES, BAR, DEFAULT_BUDGET, SECTION_ORDER, SECTION_LABELS,
  PENALTY_PER_DISMISSAL, PENALTY_CAP, FEEDBACK_WINDOW_DAYS,
};
