'use strict';

/**
 * Display text (C5, 15 Oct 2026): what a person may READ, kept apart from raw
 * identifiers and internal types. PURE.
 *
 *   isSafeDisplay(s) — true unless the string carries something only a machine
 *     should see: an ISO timestamp or a raw JS Date string, a record id (Graph
 *     message id, prepared-action id, task/block/approval ref, HA entity id), an
 *     INTERNAL type token from NEURO's own vocabularies, or task markup. Nick's
 *     own words may contain anything else — a snake_case word he typed is his,
 *     so the check names the known internal vocabularies rather than banning a
 *     shape.
 *   cleanText(s)     — strip task markup and collapse whitespace.
 *   whenText(iso, now) — "18:00 today" / "09:00 tomorrow" / "09:00 Tue 20 Oct",
 *     in the backend's local zone.
 */

// NEURO's internal vocabularies — never shown as words.
const INTERNAL = Object.freeze([
  // decision-engine item types
  // (machine-shaped tokens only: an English word like 'escalation' is fine on its own)
  'nova_flag', 'weekly_risk', 'weekly-risk', 'source-blind', 'plan_closure', 'payroll_cutoff', 'ticket_commitment', 'uat_volunteers',
  // prepared-action types
  'chase_commitment', 'chase_agenda', 'reply_email', 'compose_email', 'send_weekly_risk_report',
  'create_calendar_event', 'reschedule_calendar_event', 'cancel_calendar_event',
  // candidate kinds and refs
  'attention-item', 'protected-time', 'personal-date', 'home-exception',
  // policy / contract internals
  'riskBasis', 'gatePosition', 'neuro-candidates', 'saim-attention', 'saim-handoff',
]);
const INTERNAL_RE = new RegExp(`(^|[^A-Za-z0-9_-])(${INTERNAL.map((t) => t.replace(/[-]/g, '\\-')).join('|')})(?=$|[^A-Za-z0-9_-])`);
const UNSAFE = [
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // ISO timestamp
  /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{4}\b/, // Date#toDateString
  /GMT[+-]\d{4}/, // Date#toString
  /\bAAMk[A-Za-z0-9+/=_-]{6,}/, // Graph id
  /\bpa_[0-9a-f]{6,}\b/, // prepared action id
  /\b(task:neuro:\d+|block:\d+|approval:pa_|item:[A-Za-z0-9_-]+|home:hazard:|meeting:\d{2}:\d{2}:)/, // candidate refs
  /\bbinary_sensor\.[a-z0-9_]+/, // HA entity id
  /<!--|-->/, // task markup
  /\bneuro:\?/, // a link, not words
  // an action type with its underscores turned into spaces, used as a label ("chase agenda: …")
  /^(chase commitment|chase agenda|reply email|compose email|send weekly risk report|create calendar event|reschedule calendar event|cancel calendar event)\b/i,
];

function isSafeDisplay(s) {
  if (s == null) return true;
  if (typeof s !== 'string') return false;
  if (INTERNAL_RE.test(s)) return false;
  return !UNSAFE.some((re) => re.test(s));
}

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/(^|\s)#[a-z][\w-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A display string, or null if it would not be safe — never a raw value passed through. */
function safe(s) {
  const t = cleanText(s);
  return t && isSafeDisplay(t) ? t : null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
function dayText(d, now) {
  const n = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return 'today';
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  if (same(d, t)) return 'tomorrow';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
/** An instant → "18:00 today" / "09:00 tomorrow" / "09:00 Tue 20 Oct". null for no/unreadable time. */
function whenText(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${hhmm(d)} ${dayText(d, now)}`;
}
/** A date key (YYYY-MM-DD, wall clock) → "today" / "tomorrow" / "Tue 20 Oct". Sliced, never shifted. */
function dateText(key, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || '').slice(0, 10));
  if (!m) return null;
  return dayText(new Date(+m[1], +m[2] - 1, +m[3], 12), now);
}

module.exports = { INTERNAL, isSafeDisplay, cleanText, safe, whenText, dateText };
