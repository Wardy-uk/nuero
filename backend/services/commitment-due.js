'use strict';

/**
 * When a commitment spotted in a meeting note or an email is due (14 Sep 2026).
 *
 * Nick's rule: "unless a due date is specifically mentioned, by default apply
 * 10 days". Both halves needed building, because neither existed —
 * `action-candidates` hard-coded `dueDate: null` on every candidate it raised,
 * so a commitment promoted out of the review queue arrived in the task store
 * with no date at all, however plainly the sentence named one.
 *
 * ⚠ **THE HARD PART IS THAT MOST DATES IN THESE SENTENCES ARE NOT DEADLINES.**
 * Measured over the last 400 `capture_todo` candidates on the live Pi, twelve
 * carried an ISO date and at least three of those were something else:
 *
 *     "publish internally BY 2026-09-16"            a deadline
 *     "monitor metrics STARTING 2026-09-16"         a start date
 *     "speak with Chris (RETURNING 2026-08-25)"     somebody else's return
 *     "the 2026-06-04 escalation"                   a reference to a past event
 *
 * So a rule that took any date it found would be wrong about a quarter of the
 * time, and wrong in the expensive direction: two of those three are in the
 * PAST, and a task born overdue is a broken commitment in the weekly risk
 * report Chris reads. A missed deadline word costs the default instead, which
 * is merely a date Nick can change.
 *
 * Hence two refusals:
 *
 *  1. **A date must be GOVERNED BY A DEADLINE CUE** — "by", "before", "due",
 *     "no later than", "ahead of", "on". `starting`, `since`, `from` and
 *     `returning` are not cues and never become one; the point is not to list
 *     every wrong word but to require a right one, so a phrasing nobody
 *     anticipated falls to the default rather than inventing a deadline.
 *  2. **A stated date in the PAST is refused**, and falls back to the default.
 *     A commitment being promoted to a task now cannot sensibly be due before
 *     now: it is either a reference to something that already happened or a
 *     deadline already gone, and manufacturing overdue work out of either is
 *     the failure this is most careful about.
 *
 * Pure — no DB, no vault, no network, and `now` is passed rather than read.
 */

// Nick's number (14 Sep 2026). Deliberately CALENDAR days, not working days:
// he asked for ten, and ten is what a date arrived at by counting should mean.
// A default landing on a Saturday is a date he can move; a default that is
// quietly twelve days because two of them were a weekend is a rule nobody can
// predict from its own name.
const DEFAULT_DUE_DAYS = 10;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// What must sit immediately before a date for it to be a DEADLINE rather than
// a fact about some other day. Anchored to the end, so it has to govern THIS
// date rather than merely appear somewhere earlier in a long sentence. The
// filler group carries the phrasings that actually occur in the live data —
// "by end of", "by the morning of", "by close of business".
const CUE = new RegExp(
  '\\b(?:by|before|due(?:\\s+(?:by|on))?|no\\s+later\\s+than|ahead\\s+of|in\\s+time\\s+for|on)\\s+'
  + '(?:the\\s+)?'
  + '(?:(?:start|end|beginning|morning|afternoon|evening|close)\\s+of\\s+(?:the\\s+)?(?:day\\s+|business\\s+)?)?'
  + '$',
  'i',
);

function pad(n) { return String(n).padStart(2, '0'); }
function toKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/** Midnight local on the day `d` falls in. Never toISOString() — the Pi may run UTC. */
function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/**
 * A real calendar date, or null.
 *
 * ⚠ Validated by ROUND TRIP rather than by range: `new Date(2026, 1, 31)` is a
 * perfectly happy 3 March, so "31 February" would otherwise be accepted and
 * silently moved. A date that does not come back as the one asked for is not a
 * date.
 */
function makeDate(year, month, day) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/**
 * Every date-shaped run in the text, with where it started.
 *
 * A year is optional on the written forms, and an omitted one resolves to
 * whichever year puts the date NEAREST to `now` — a commitment made in December
 * and due "by 5 January" means the January three weeks away, not the one eleven
 * months back.
 */
function findDates(text, now) {
  const out = [];
  const push = (index, raw, date) => { if (date) out.push({ index, raw, date }); };

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  for (let m; (m = iso.exec(text)) !== null;) {
    push(m.index, m[0], makeDate(Number(m[1]), Number(m[2]), Number(m[3])));
  }

  const dmy = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
  for (let m; (m = dmy.exec(text)) !== null;) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    push(m.index, m[0], makeDate(year, Number(m[2]), Number(m[1])));
  }

  const names = MONTHS.join('|');
  // "16 September 2026", "16th September", "September 16, 2026"
  const dayFirstRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${names})\\b(?:,?\\s+(\\d{4}))?`, 'gi');
  const monthFirstRe = new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi');
  for (const [re, dayFirst] of [[dayFirstRe, true], [monthFirstRe, false]]) {
    for (let m; (m = re.exec(text)) !== null;) {
      const day = Number(dayFirst ? m[1] : m[2]);
      const month = MONTHS.indexOf(String(dayFirst ? m[2] : m[1]).toLowerCase()) + 1;
      if (m[3]) { push(m.index, m[0], makeDate(Number(m[3]), month, day)); continue; }
      let best = null;
      for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
        const d = makeDate(y, month, day);
        if (!d) continue;
        if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
      }
      push(m.index, m[0], best);
    }
  }

  return out.sort((a, b) => a.index - b.index);
}

/**
 * The date this commitment STATES it is due, or null if it does not state one.
 *
 * Returns the phrase as well, so a caller can say WHICH words it read — a date
 * NEURO decided from a sentence must be quotable back, or a wrong one is
 * untraceable.
 */
function statedDue(text, now = new Date()) {
  if (!text) return null;
  const today = midnight(now);

  for (const hit of findDates(String(text), now)) {
    const before = String(text).slice(0, hit.index);
    const cue = before.match(CUE);
    if (!cue) continue;                              // a date, but not a deadline
    if (midnight(hit.date) < today) continue;        // already gone — see the header
    return { date: toKey(hit.date), phrase: `${cue[0].trim()} ${hit.raw}`.trim() };
  }
  return null;
}

/**
 * What due date to give a commitment being promoted to a task.
 *
 * `source` is the point of the return shape: `stated` and `default` are
 * different claims about the same field, and a screen that wants to say "NEURO
 * picked this" rather than "the meeting said this" has to be able to tell them
 * apart.
 */
function resolveDueDate(text, { now = new Date(), defaultDays = DEFAULT_DUE_DAYS } = {}) {
  const stated = statedDue(text, now);
  if (stated) return { date: stated.date, source: 'stated', phrase: stated.phrase };

  const d = midnight(now);
  d.setDate(d.getDate() + defaultDays);
  return { date: toKey(d), source: 'default', phrase: null };
}

module.exports = {
  DEFAULT_DUE_DAYS,
  resolveDueDate,
  statedDue,
  // Exported for the tests: the two halves fail in different ways, and one
  // entry point would make a parsing bug look like a cue bug.
  findDates,
};
