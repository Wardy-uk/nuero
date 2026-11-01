'use strict';

/**
 * Calendar care (1 Nov 2026) — the PURE half. No DB, no network, no clock.
 *
 * Three jobs, each a PROPOSAL Nick answers with a press; nothing here acts:
 *
 *   1. Protect time when the week fills up — the coming week's real-meeting
 *      load as a share of 09:00–17:30 working time, and the afternoon (or the
 *      longest free stretch) worth keeping clear.
 *   2. Agendas for meetings Nick organises — whether an invite body already
 *      says what the meeting is for (Teams join boilerplate is NOT an agenda),
 *      and the words NEURO would add.
 *   3. Meetings he never attends — a recurring series whose last three held
 *      occurrences each carry EVIDENCE he was not there.
 *
 * ⚠ Times are Europe/London wall clock `YYYY-MM-DDTHH:MM` strings, compared as
 * strings and never parsed into a Date (the BST bug).
 */

const { isRealMeeting } = require('./context-state');

const WORK_START = 9 * 60;            // 09:00
const WORK_END = 17 * 60 + 30;        // 17:30
const DAY_MINUTES = WORK_END - WORK_START; // 510
const LOAD_THRESHOLD = 0.6;
const AFTERNOON_START = 13 * 60 + 30; // 13:30
const AFTERNOON_END = 17 * 60;        // 17:00
const MIN_STRETCH = 120;              // a stretch shorter than two hours is not worth protecting
const PROTECT_SUBJECT = 'Protected — no meetings';

// NEURO's own solo blocks. They have nobody else in them, so isRealMeeting
// already refuses them; matched by name as a second guard so a block that ever
// carried an attendee still never counts as a meeting load.
const NEURO_SUBJECTS = [/^plaud admin\b/i, /^focus block\b/i, /^protected — no meetings$/i, /^take a break$/i];

// ── small helpers ───────────────────────────────────────────────────────────

const minute = (s) => String(s || '').replace(' ', 'T').slice(0, 16);
const dateOf = (s) => minute(s).slice(0, 10);
const clockMin = (s) => { const m = minute(s); return (+m.slice(11, 13)) * 60 + (+m.slice(14, 16)); };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const lc = (s) => String(s || '').trim().toLowerCase();

function addDays(dateStr, n) {
  const t = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
/** 1 = Monday … 7 = Sunday, from the date alone. */
function isoDow(dateStr) {
  const d = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10))).getUTCDay();
  return d === 0 ? 7 : d;
}
/** Monday–Friday of the week holding `dateStr`. */
function weekDays(dateStr) {
  const mon = addDays(dateStr, 1 - isoDow(dateStr));
  return [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
}

/** A calendar_cache row → the event shape context-state judges. */
function rowToEvent(r) {
  const tri = (v) => (v === 1 || v === true ? true : v === 0 || v === false ? false : null);
  return {
    id: r.event_id || r.id || null,
    subject: r.subject || '',
    start: minute(r.start_time || r.start),
    end: minute(r.end_time || r.end),
    isAllDay: r.is_all_day === 1 || r.is_all_day === true || r.isAllDay === true,
    isCancelled: r.isCancelled === true || /^cancel+ed:/i.test(String(r.subject || '')),
    showAs: r.show_as || r.showAs || 'busy',
    attendeesOther: tri(r.attendees_other !== undefined ? r.attendees_other : r.attendeesOther),
    isOrganizer: tri(r.is_organizer !== undefined ? r.is_organizer : r.isOrganizer),
    source: r.source || 'graph',
  };
}

function isNeuroBlock(ev, neuroIds = new Set()) {
  if (ev.id && neuroIds.has(ev.id)) return true;
  return NEURO_SUBJECTS.some((rx) => rx.test(String(ev.subject || '').trim()));
}

/** Does this event count towards the meeting load? Real meeting, not one of NEURO's blocks. */
function countsAsMeeting(ev, neuroIds) {
  return isRealMeeting(ev) && !isNeuroBlock(ev, neuroIds);
}

/** Merge [from,to) minute intervals. */
function union(intervals) {
  const xs = intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of xs) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
const total = (ivs) => ivs.reduce((s, [a, b]) => s + (b - a), 0);

/** An event's span on `date`, in minutes, clipped to [lo, hi). */
function spanOn(ev, date, lo, hi) {
  if (ev.isAllDay) return null;
  const s = minute(ev.start); const e = minute(ev.end);
  if (!s || !e || e <= s) return null;
  if (dateOf(s) > date || dateOf(e) < date) return null;
  const a = dateOf(s) < date ? 0 : clockMin(s);
  const b = dateOf(e) > date ? 24 * 60 : clockMin(e);
  const from = Math.max(a, lo); const to = Math.min(b, hi);
  return to > from ? [from, to] : null;
}

// ── 1. protect time ─────────────────────────────────────────────────────────

/**
 * The coming week's meeting load. PURE.
 *   events     calendar rows already mapped by rowToEvent (work calendar)
 *   week       Monday–Friday date strings
 *   leave      Set of dates Nick is off (People HR)
 *   holidays   Set of bank holiday dates
 * Returns { days:[{date, working, why, meetingMinutes, available}], meetingMinutes, available, share }.
 * `share` is null when no working time is left in the week (never 0 — there is
 * nothing to divide).
 */
function weekLoad({ events, week, leave = new Set(), holidays = new Set(), neuroIds = new Set() }) {
  const days = week.map((date) => {
    const why = holidays.has(date) ? 'bank holiday' : leave.has(date) ? 'leave' : null;
    if (why) return { date, working: false, why, meetingMinutes: 0, available: 0 };
    const spans = events.filter((ev) => countsAsMeeting(ev, neuroIds)).map((ev) => spanOn(ev, date, WORK_START, WORK_END)).filter(Boolean);
    return { date, working: true, why: null, meetingMinutes: total(union(spans)), available: DAY_MINUTES };
  });
  const meetingMinutes = days.reduce((s, d) => s + d.meetingMinutes, 0);
  const available = days.reduce((s, d) => s + d.available, 0);
  return { days, meetingMinutes, available, share: available > 0 ? meetingMinutes / available : null };
}

/** Is there already a protected block in the week? */
function hasProtectedBlock(events, week) {
  const set = new Set(week);
  return events.some((ev) => lc(ev.subject) === lc(PROTECT_SUBJECT) && set.has(dateOf(ev.start)));
}

/**
 * Where to protect. PURE. Prefers a WHOLE free afternoon (13:30–17:00 with no
 * real meeting in it) — fewest of Nick's own busy blocks, then earliest; else
 * the longest stretch of ≥2h free of real meetings inside working hours,
 * earliest on a tie. `days` are the working days still to come. null = nowhere.
 */
function chooseProtectSlot({ events, days, neuroIds = new Set() }) {
  const afternoons = [];
  for (const date of days) {
    const meetings = events.filter((ev) => countsAsMeeting(ev, neuroIds)).map((ev) => spanOn(ev, date, AFTERNOON_START, AFTERNOON_END)).filter(Boolean);
    if (meetings.length) continue;
    const otherBusy = events.filter((ev) => ev.showAs !== 'free' && !ev.isCancelled)
      .map((ev) => spanOn(ev, date, AFTERNOON_START, AFTERNOON_END)).filter(Boolean);
    afternoons.push({ date, busy: total(union(otherBusy)) });
  }
  if (afternoons.length) {
    afternoons.sort((a, b) => a.busy - b.busy || (a.date < b.date ? -1 : 1));
    const d = afternoons[0].date;
    return { date: d, start: `${d}T${hhmm(AFTERNOON_START)}`, end: `${d}T${hhmm(AFTERNOON_END)}`, kind: 'afternoon', minutes: AFTERNOON_END - AFTERNOON_START };
  }
  let best = null;
  for (const date of days) {
    const busy = union(events.filter((ev) => countsAsMeeting(ev, neuroIds)).map((ev) => spanOn(ev, date, WORK_START, WORK_END)).filter(Boolean));
    let cursor = WORK_START;
    for (const [a, b] of [...busy, [WORK_END, WORK_END]]) {
      const len = a - cursor;
      if (len >= MIN_STRETCH && (!best || len > best.minutes)) {
        best = { date, start: `${date}T${hhmm(cursor)}`, end: `${date}T${hhmm(a)}`, kind: 'stretch', minutes: len };
      }
      cursor = Math.max(cursor, b);
    }
  }
  return best;
}

// ── 2. agendas ──────────────────────────────────────────────────────────────

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', bull: '•' };

/** HTML (or plain) invite body → text lines. PURE. */
function bodyToText(body) {
  let s = String(body || '');
  s = s.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h\d|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#') && k !== '#39') return String.fromCodePoint(parseInt(k.slice(1), 10));
    return ENTITIES[k] !== undefined ? ENTITIES[k] : ' ';
  });
  return s.split(/\r?\n/).map((l) => l.replace(/[ \t ]+/g, ' ').trim());
}

// Lines that are the online-meeting join block and nothing else. Anchored and
// specific: "Join the meeting now" is boilerplate, "Join us to agree the plan"
// is not.
const BOILERPLATE_LINES = [
  /^microsoft teams( meeting)?\b.*$/i,
  /^need help\??$/i,
  /^join (the |this )?meeting( now)?$/i,
  /^join (microsoft )?teams meeting$/i,
  /^join on (your computer|a video conferencing device|the web)\b.*$/i,
  /^click here to join the meeting$/i,
  /^join with a video conferencing device$/i,
  /^join by phone$/i,
  /^meeting id:.*$/i,
  /^passcode:.*$/i,
  /^phone (conference|call) id:.*$/i,
  /^(conference|video) id:.*$/i,
  /^tenant key:.*$/i,
  /^dial[- ]in.*$/i,
  /^dial in by phone$/i,
  /^find a local number.*$/i,
  /^reset (dial-in )?pin.*$/i,
  /^for organi[sz]ers:.*$/i,
  /^meeting options.*$/i,
  /^learn more.*$/i,
  /^more info$/i,
  /^org help.*$/i,
  /^privacy and security.*$/i,
  /^(help|legal) ?\|.*$/i,
  /^\+?[\d\s(),#-]{7,}[a-z ,]*$/i,               // +44 20 3443 8435,,123456# United Kingdom, London
  /^\d{3}[\d ]{6,}#?$/,                         // bare conference ids
  /^https?:\/\/\S+$/i,
  /^<https?:\/\/\S+>$/i,
  /^•\s*$/,
  /^[_\-=─]{6,}$/,
  /^\|$/,
  /^download teams\b.*$/i,
  /^or call in( \(audio only\))?$/i,
  /^zoom meeting$/i,
  /^join zoom meeting$/i,
  /^google meet joining info$/i,
  /^join with google meet.*$/i,
];

/** What is left of an invite body once the join boilerplate is gone. PURE. */
function meaningfulText(body) {
  const lines = bodyToText(body);
  // A Teams/Zoom block is fenced by long underscore lines: drop a fenced block
  // whole when it is a join block (mentions Teams/Zoom/Meet or a join link).
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    if (/^_{10,}$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^_{10,}$/.test(lines[j])) j++;
      const block = lines.slice(i + 1, j).join('\n');
      if (/teams|zoom|google meet|webex|meeting id|join/i.test(block)) { i = j + 1; continue; }
    }
    kept.push(lines[i]);
    i++;
  }
  return kept
    .map((l) => l.replace(/<?(https?|tel|mailto):[^\s>]+>?/gi, '').replace(/\s+\|\s*$/, '').trim())
    .filter((l) => l && !BOILERPLATE_LINES.some((rx) => rx.test(l)))
    .join('\n')
    .trim();
}

const MIN_AGENDA_CHARS = 15;

/**
 * Does the invite already say what the meeting is for? PURE.
 * ⚠ Errs towards YES: a body with any real sentence in it is Nick's (or the
 * organiser's) words, and NEURO does not offer to add an agenda over them.
 * Only an empty body, join boilerplate, or the subject repeated reads as none.
 */
function hasAgenda(body, { subject = '' } = {}) {
  const text = meaningfulText(body);
  const alnum = text.replace(/[^a-z0-9]/gi, '');
  if (alnum.length < MIN_AGENDA_CHARS) return false;
  if (lc(text).replace(/[^a-z0-9]/g, '') === lc(subject).replace(/[^a-z0-9]/g, '')) return false;
  return true;
}

const GAP_RE = /\[[^\]\n]{1,80}\]/g;
/** The [gaps] still in an agenda Nick is about to add. PURE. */
function gapsIn(text) { return String(text || '').match(GAP_RE) || []; }

/**
 * The agenda NEURO proposes. PURE.
 *   evidence  { previous: {start, notePath}|null, commitments:[{text}], owedFromPrevious:[{person,text}] }
 * From the previous occurrence's write-up when it has open items; else a
 * minimal template whose [gaps] Nick fills before it can be added.
 */
function agendaDraft({ subject, evidence }) {
  const e = evidence || {};
  const actions = (e.commitments || []).map((c) => String(c.text || '').trim()).filter(Boolean);
  const owed = (e.owedFromPrevious || []).map((w) => `${w.person ? `${w.person}: ` : ''}${String(w.text || '').trim()}`).filter(Boolean);
  if (e.previous && (actions.length || owed.length)) {
    const when = e.previous.start ? ` (${e.previous.start.slice(8, 10)}/${e.previous.start.slice(5, 7)})` : '';
    const lines = ['Agenda'];
    let n = 1;
    if (actions.length) { lines.push(`${n++}. Actions from last time${when}`); for (const a of actions) lines.push(`   • ${a}`); }
    if (owed.length) { lines.push(`${n++}. Still open from others`); for (const o of owed) lines.push(`   • ${o}`); }
    lines.push(`${n}. Anything new`);
    return { text: lines.join('\n'), source: 'write-up', previous: e.previous };
  }
  return {
    text: ['Agenda', '1. [first topic]', '2. [second topic]', 'Outcome: [what we want decided or agreed by the end]'].join('\n'),
    source: 'template', previous: e.previous || null,
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The agenda as HTML, placed at the TOP of the existing body (inside <body> when there is one). PURE. */
function mergeAgendaIntoBody(existingHtml, agendaText) {
  const block = `<div>${String(agendaText).split('\n').map((l) => esc(l).replace(/^( +)/, (m) => '&nbsp;'.repeat(m.length))).join('<br>')}</div><div><br></div>`;
  const html = String(existingHtml || '');
  const m = html.match(/<body\b[^>]*>/i);
  if (m) return html.slice(0, m.index + m[0].length) + block + html.slice(m.index + m[0].length);
  return block + html;
}

/** Is the approved agenda in the body read back? Every non-empty line, whitespace-collapsed. PURE. */
function bodyHoldsAgenda(bodyHtml, agendaText) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const hay = norm(bodyToText(bodyHtml).join(' '));
  const lines = String(agendaText || '').split('\n').map(norm).filter(Boolean);
  return lines.length > 0 && lines.every((l) => hay.includes(l));
}

/** Is this meeting a daily stand-up (or other near-daily series)? PURE. */
function isDailyish({ subject, datesSeen = [] }) {
  if (/stand[\s-]?up/i.test(String(subject || ''))) return true;
  return new Set(datesSeen).size >= 6;
}

// ── 3. meetings he never attends ────────────────────────────────────────────

const NEED = 3;

/** Key for one occurrence: its provider id and wall-clock start. */
const occKey = (eventId, start) => `${eventId}@${minute(start)}`;

/**
 * Evidence Nick was NOT at one occurrence. PURE. Conservative on purpose:
 *   declined      Graph says he declined it (not a leave auto-decline)
 *   not-attending he pressed "I'm not in it"
 *   elsewhere     a write-up proves he was in ANOTHER real meeting overlapping it
 * A missing write-up on its own is never evidence. Returns {kind, detail} or null.
 *
 *   ctx.declined     Set of occKeys Nick declined (Graph response or his press)
 *   ctx.skipped      Set of occKeys he marked "I'm not in it"
 *   ctx.others       other real meetings [{id, subject, start, end}]
 *   ctx.writeUps     [{start}] PLAUD write-up start times (wall clock)
 */
function occurrenceEvidence(occ, ctx = {}) {
  const key = occKey(occ.id, occ.start);
  if (occ.responseStatus === 'declined' || (ctx.declined && ctx.declined.has(key))) return { kind: 'declined', detail: 'you declined it' };
  if (ctx.skipped && ctx.skipped.has(key)) return { kind: 'not-attending', detail: 'you marked it “I’m not in it”' };
  const dur = Math.max(1, wallDiff(occ.start, occ.end));
  for (const o of ctx.others || []) {
    if (o.id === occ.id) continue;
    const ov = Math.min(wallStamp(o.end), wallStamp(occ.end)) - Math.max(wallStamp(o.start), wallStamp(occ.start));
    if (ov < dur / 2) continue;
    // Proof he was IN the other one: a write-up starting within 20 min of the
    // other meeting's start, and not within 20 min of this one's (a recording
    // that could belong to either proves nothing).
    const hit = (ctx.writeUps || []).find((w) => Math.abs(wallDiff(o.start, w.start)) <= 20 && Math.abs(wallDiff(occ.start, w.start)) > 20);
    if (hit) return { kind: 'elsewhere', detail: `you were in “${o.subject}” (written up)` };
  }
  return null;
}

function wallStamp(s) {
  const m = minute(s);
  return Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, +m.slice(8, 10), +m.slice(11, 13), +m.slice(14, 16)) / 60000;
}
function wallDiff(a, b) { return wallStamp(b) - wallStamp(a); }

/**
 * Is a series one he never attends? PURE. `occurrences` are the HELD past
 * occurrences, newest first, each with `.evidence` (from occurrenceEvidence)
 * and `.onLeave`. A leave day is NEUTRAL — skipped, neither counting for nor
 * against (being away is not a verdict on the meeting). Flagged only when the
 * last three non-leave occurrences ALL carry evidence.
 */
function seriesVerdict(occurrences) {
  const considered = occurrences.filter((o) => !o.onLeave).slice(0, NEED);
  if (considered.length < NEED) return { flagged: false, why: `only ${considered.length} past occurrence(s) to judge`, last: considered };
  const missing = considered.filter((o) => !o.evidence);
  if (missing.length) return { flagged: false, why: `${missing.length} of the last ${NEED} has no evidence you missed it`, last: considered };
  return { flagged: true, why: `you missed the last ${NEED}`, last: considered };
}

module.exports = {
  WORK_START, WORK_END, DAY_MINUTES, LOAD_THRESHOLD, AFTERNOON_START, AFTERNOON_END, MIN_STRETCH, PROTECT_SUBJECT, NEED,
  minute, dateOf, addDays, isoDow, weekDays, rowToEvent, isNeuroBlock, countsAsMeeting, union, spanOn,
  weekLoad, hasProtectedBlock, chooseProtectSlot,
  bodyToText, meaningfulText, hasAgenda, gapsIn, agendaDraft, mergeAgendaIntoBody, bodyHoldsAgenda, isDailyish,
  occKey, occurrenceEvidence, seriesVerdict,
};
