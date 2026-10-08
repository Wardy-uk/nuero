'use strict';

/**
 * Apple Calendar and Reminders, pushed from the phone.
 *
 * ── Why push, and why Scriptable ─────────────────────────────────────────────
 *
 * NEURO cannot reach into iCloud. There is no server-side API worth having:
 * CalDAV against iCloud needs an app-specific password and is undocumented and
 * flaky, EventKit needs a Mac and Nick is on Windows, and Reminders has no web
 * API at all. So the phone pushes.
 *
 * Scriptable is the vehicle because it is already on his phone, already trusted,
 * already holds the NEURO API token in the Keychain for the widget, and has
 * native `Reminder` and `CalendarEvent` classes. A scheduled Shortcut runs it.
 * Nothing leaves the tailnet and no third party is involved.
 *
 * ⚠ Scriptable has NO HealthKit API — checked against its docs, not assumed.
 * Health is not and cannot be part of this; it already arrives via the FreeReps
 * app on /api/v1/ingest, and the route for moving off that would be Shortcuts'
 * "Find Health Samples", not this file.
 *
 * ── The calendar is the point ────────────────────────────────────────────────
 *
 * Until now NEURO could only see the WORK diary, so every "is Nick free"
 * answer — time-fit, the day planner, 1-2-1 booking, context-state — was wrong
 * outside working hours and blind to anything personal inside them. Apple events
 * land in the SAME `calendar_cache` as Graph events, with a `source` column,
 * precisely so all of those keep asking one question of one table.
 *
 * ⚠ That column is load-bearing for deletes. calendar-sync is replace-by-window
 * and runs every few minutes; it used to empty the whole table, which would have
 * wiped every Apple event minutes after it arrived, silently. See
 * db.clearCalendarCache.
 *
 * ── Reminders are one-way, and that is safe ──────────────────────────────────
 *
 * A reminder becomes a task. Completing that task does NOT complete the
 * reminder — NEURO cannot write to iCloud — so the reminder keeps being pushed.
 * That would be a resurrection loop except for one property of task-store:
 * `createTask` folds on dedupe_key into the existing row WHATEVER its status,
 * and the fold never touches status. So a re-pushed completed reminder folds
 * into the done task and stays done. Verified, not assumed, and pinned.
 *
 * Known limitation, stated rather than hidden: identity is the task TEXT, not
 * Apple's identifier, so renaming a reminder creates a second task. That is a
 * visible, droppable annoyance rather than a silent failure, and it is how every
 * other capture route in NEURO already behaves. An `external_id` column would
 * fix it and is deliberately not built until something needs it.
 */

const db = require('../db/database');
const { domainOrDefault } = require('../../shared/task-domain.cjs');

const SOURCE = 'apple';

// Where the last PUSH ATTEMPT is recorded, which is a different fact from the
// rows it produced. Freshness used to be read from `calendar_cache.fetched_at`
// alone, so a phone pushing faithfully every few minutes and storing nothing
// was indistinguishable from a phone that had stopped — and the senses row
// said "the Shortcut on your phone has stopped pushing" over an app that was
// running perfectly and simply had no permission. An attempt has to leave a
// trace even when it stores nothing, or the diagnosis names the wrong thing.
const PUSH_STATE_KEY = 'apple_last_push';

// Never allowed to fail the ingest: the events have landed, and a bookkeeping
// error must not be reported as a failed push.
function _recordPush(record) {
  try {
    db.setState(PUSH_STATE_KEY, JSON.stringify(record));
  } catch (e) {
    console.warn('[Apple] could not record the push attempt:', e.message);
  }
}

function _lastPush() {
  try {
    const raw = db.getState(PUSH_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Calendars whose events are never stored.
 *
 * Measured from the live device, not guessed: 23 calendars are visible, and the
 * defaults here are the ones that are artefacts rather than commitments.
 *
 *  • TWO subscribed UK holiday feeds are both on, which is why every bank
 *    holiday arrived twice. Both are excluded rather than one: `working-days`
 *    already knows the bank holidays from gov.uk and is what the day planner and
 *    1-2-1 booking actually consult, so these rows were duplicated noise in the
 *    one table that answers "is Nick free".
 *  • Zendone, Nozbe and Garmin write calendars from inside their own apps. They
 *    are dormant today; the risk is one waking up and quietly filling the diary
 *    with things that are not commitments.
 *
 * `Birthdays` is deliberately NOT excluded — a birthday is real personal context
 * and exactly the sort of thing a second brain should know about.
 *
 * ⚠ An event whose calendar is UNKNOWN is KEPT, which is the opposite of the
 * Reminders whitelist, on purpose. The failure directions are opposite: for
 * reminders the risk is a shopping list flooding the task store, so unknown is
 * skipped; for the calendar the risk is a MISSING event making a busy day look
 * free — the exact bug that took two rounds to find — so unknown is kept.
 */
const DEFAULT_SKIP_CALENDARS = [
  'UK Holidays',
  'Holidays in United Kingdom',
  'Garmin Workouts',
  'Nozbe',
  'zd-work', 'zd-home', 'zd-completed',
  'zendone-work', 'zendone-home', 'zendone-completed',
];

function skipCalendarNames() {
  const configured = process.env.APPLE_SKIP_CALENDARS;
  const source = configured === undefined ? DEFAULT_SKIP_CALENDARS.join(',') : configured;
  return source.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function calendarIsSkipped(name) {
  // Unknown is kept — see the warning above.
  if (!name) return false;
  return skipCalendarNames().includes(String(name).trim().toLowerCase());
}

// Build 11D: the reminders list whitelist and its `domainForList` ("work if
// named in APPLE_WORK_LISTS, otherwise personal") are gone. Which lists are
// tracked lives in source-classification — since Build 20A ONLY by Nick's
// explicit decision on the list's stable id (no name rule, no
// APPLE_REMINDER_LISTS); a list's DOMAIN is only what Nick classified it as.

/**
 * Normalise one pushed calendar event. PURE.
 *
 * Returns null for anything unusable rather than writing a half-row — a cached
 * event with no start is worse than a missing one, because every consumer reads
 * the cache as the truth about the diary.
 */
/**
 * A calendar time, as NEURO stores them: LOCAL WALL-CLOCK, no zone marker.
 *
 * ⚠ THE BST BUG, THIRD REPO. Everything downstream — the agenda, the
 * dashboards, `time-fit`, the widget — SLICES the time out of this string and
 * converts nothing, so a `Z` on the end is not a harmless extra: it renders an
 * hour early all summer, and an all-day event beginning at midnight BST is
 * `23:00Z` on the PREVIOUS DAY, which files it under yesterday and drops it out
 * of today's agenda altogether. Both were live on 13 Sep 2026: a 13:55
 * appointment showing 12:55, and that day's all-day event missing entirely.
 *
 * The Scriptable client sent local wall-clock deliberately and said why; the
 * Swift rewrite that replaced it used `ISO8601.string(from:)`, which is UTC,
 * and nothing in between noticed. ⚠ Least of all the countdown —
 * `minutesAway` does real date arithmetic and stayed CORRECT, so the clock face
 * lied while the "in 62 minutes" beside it did not.
 *
 * Fixed at the INGEST BOUNDARY rather than in one client: this is NEURO's
 * storage contract, so it belongs where NEURO's storage begins, and it then
 * holds for every client including the two that already disagree.
 *
 * ⚠ Converted against `NEURO_TIMEZONE`, never the host clock — the Pi runs
 * UTC, which would make this a silent no-op there and a working fix on a laptop.
 * `parseIcsDate`'s rule, reused rather than re-derived.
 *
 * ⚠ An unparseable value is returned UNCHANGED. A time nobody can read is not
 * an invitation to invent one, and a wrong hour is worse than an odd string.
 */
function toLocalWallClock(value) {
  const raw = String(value);
  // No zone marker means the client already sent wall-clock (the Scriptable
  // path). Leave it exactly alone — re-interpreting it as UTC is this same bug
  // running in the other direction.
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (!zoned) return raw;

  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return raw;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.NEURO_TIMEZONE || 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type) => (parts.find((p) => p.type === type) || {}).value;
  const y = part('year'); const mo = part('month'); const d = part('day');
  const hh = part('hour'); const mm = part('minute'); const ss = part('second');
  if (!y || !mo || !d || !hh || !mm || !ss) return raw;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}`;
}

function normaliseEvent(raw) {
  if (!raw || !raw.id || !raw.start) return null;
  const start = toLocalWallClock(raw.start);
  const end = raw.end ? toLocalWallClock(raw.end) : start;

  return {
    // Namespaced so an Apple identifier can never collide with a Graph one in
    // the UNIQUE(event_id) index — they are opaque strings from two systems
    // that have never heard of each other.
    //
    // ⚠ THE START TIME IS PART OF THE KEY, and it is not decoration. EventKit
    // gives every occurrence of a RECURRING event the SAME `identifier` — a
    // weekly Saturday commitment is one identifier and many occurrences. With
    // the identifier alone, `calendar_cache.event_id` is UNIQUE and the upsert
    // is INSERT OR REPLACE, so all of them would collapse into a single row and
    // a repeating event would appear in the diary exactly once. Nothing throws;
    // the calendar is just quietly wrong, in the direction of looking emptier
    // than it is — which is the worst direction for something whose entire job
    // is answering "is Nick free".
    id: `apple:${raw.id}:${start}`,
    subject: raw.title ? String(raw.title).slice(0, 400) : '(no title)',
    start,
    end,
    isAllDay: raw.isAllDay === true,
    location: raw.location ? String(raw.location).slice(0, 200) : null,
    organizer: raw.organizer ? String(raw.organizer).slice(0, 200) : null,
    // Apple has no free/busy flag as such. An all-day event is treated as free
    // rather than as a wall, matching how the agenda already filters Graph's —
    // a birthday must not block the afternoon.
    showAs: raw.isAllDay === true ? 'free' : 'busy',
    // ⚠ THREE-VALUED, and undefined must survive as undefined. Scriptable's
    // CalendarEvent.attendees is not always populated, and coercing that to
    // false would tell context-state "solo block" about a real meeting.
    // context-state requires exactly `true` to call something a meeting, so an
    // unknown fails closed on its own.
    // ⚠ The native client sends a COUNT (attendees minus Nick), the Scriptable
    // one a boolean. A positive count is evidence other people are in it; zero
    // is NOT evidence of a solo block — EventKit hands a personal appointment
    // no attendee list at all — so it stays unknown rather than "block".
    attendeesOther: typeof raw.attendeesOther === 'boolean' ? raw.attendeesOther
      : (typeof raw.attendeesOther === 'number' && raw.attendeesOther > 0 ? true : undefined),
    source: SOURCE,
    // Build 11C: WHICH calendar it came through — not stored in the cache (the
    // cache answers "is Nick free"), carried to the world model, where Nick's
    // classification of the calendar is applied at read time.
    calendarId: raw.calendarId ? String(raw.calendarId).slice(0, 200) : null,
    calendarTitle: raw.calendar ? String(raw.calendar).slice(0, 200) : null,
    recurring: raw.recurring === true ? true : raw.recurring === false ? false : null,
  };
}

/**
 * The calendars a push says the phone can see, as `{ id, title }`. Older
 * clients send bare titles; Build 11 clients send objects with the
 * calendarIdentifier. PURE.
 */
function visibleCalendars(calendars) {
  if (!Array.isArray(calendars)) return null;
  return calendars.map((c) => (c && typeof c === 'object'
    ? { id: c.id ? String(c.id) : null, title: String(c.title || c.name || ''),
      // Build 18N: EventKit's own calendar kind, when the client sends it.
      type: typeof c.type === 'string' && /^[a-z]{1,16}$/.test(c.type) ? c.type : null }
    : { id: null, title: String(c), type: null }));
}

// ── Build 18M: coverage, measured per push and per app ──────────────────────
//
// "The phone sends very few events" was a number with no denominator. What a
// push can say is: the window it looked at, which calendars it could see, and
// how many events each one had in that window (all-day and recurring counted
// separately, because EventKit expands recurrences into occurrences and a
// quiet calendar of yearly birthdays looks empty in two weeks). Kept PER APP,
// because iOS 17 partial access can give the two apps different views.
const PUSH_BY_CLIENT_KEY = 'apple_push_by_client';

/** PURE. The coverage half of a push record. */
function coverageOf({ from, to, events, calendars, at }) {
  const perCalendar = {};
  for (const c of calendars || []) {
    const k = c.id || `title:${c.title}`;
    perCalendar[k] = { id: c.id || null, title: c.title, type: c.type || null, events: 0, allDay: 0, recurring: 0 };
  }
  for (const e of events || []) {
    if (!e) continue;
    const k = e.calendarId ? String(e.calendarId) : `title:${e.calendar || '(unknown)'}`;
    const row = perCalendar[k] || (perCalendar[k] = { id: e.calendarId || null, title: e.calendar || '(unknown)', type: null, events: 0, allDay: 0, recurring: 0, notListed: true });
    row.events += 1;
    if (e.isAllDay === true) row.allDay += 1;
    if (e.recurring === true) row.recurring += 1;
  }
  const fromMs = Date.parse(String(from)); const toMs = Date.parse(String(to)); const atMs = Date.parse(String(at));
  return {
    window: { from, to },
    backDays: Number.isFinite(fromMs) && Number.isFinite(atMs) ? Math.round((atMs - fromMs) / 86400000) : null,
    aheadDays: Number.isFinite(toMs) && Number.isFinite(atMs) ? Math.round((toMs - atMs) / 86400000) : null,
    perCalendar: Object.values(perCalendar),
  };
}

function _recordClientPush(client, record) {
  try {
    const all = JSON.parse(db.getState(PUSH_BY_CLIENT_KEY) || '{}') || {};
    all[client || 'unknown'] = record;
    db.setState(PUSH_BY_CLIENT_KEY, JSON.stringify(all));
  } catch (e) { console.warn('[Apple] could not record per-app coverage:', e.message); }
}

/**
 * Replace the Apple events in the pushed window.
 *
 * Windowed rather than whole-source: the phone sends the range it looked at, and
 * deleting outside that range would throw away events from a wider push that a
 * narrower one simply did not ask about.
 *
 * ⚠ An EMPTY events array with a window is a legitimate "nothing in the diary"
 * and must clear the window. An empty array with NO window is refused — that is
 * the shape a broken client sends, and honouring it would silently empty the
 * personal calendar.
 */
function ingestCalendar({ from, to, events, calendars, client } = {}) {
  if (!from || !to) return { ok: false, error: 'a from/to window is required' };
  if (!Array.isArray(events)) return { ok: false, error: 'events must be an array' };

  // ── What the phone could SEE ───────────────────────────────────────────────
  //
  // Reported because "my Saturday event is missing" was unanswerable without it.
  // The sync said how many events it sent and nothing about where it looked, so
  // an empty diary and a calendar the phone cannot read produced an identical
  // result — the same conflation the whole codebase keeps stamping out.
  //
  // iOS 17 can grant an app partial calendar access, so a calendar absent from
  // this list is a PERMISSIONS answer, not an empty-diary one.
  const byCalendar = {};
  for (const e of events) {
    const name = (e && e.calendar) ? String(e.calendar) : '(unknown)';
    byCalendar[name] = (byCalendar[name] || 0) + 1;
  }
  const visibleObjs = visibleCalendars(calendars);
  const visible = visibleObjs ? visibleObjs.map((c) => c.title) : null;
  // ⚠ WHICH APP PUSHED — diagnostics, and NOT a second source. Both apps read
  // ONE EventKit store on one device, so they are two readers of one diary and
  // the rows stay under a single `apple` source; splitting them would put every
  // event in the diary twice. What this buys is attributability: with iOS 17
  // partial access the two apps can legitimately see DIFFERENT calendars, and a
  // count that flips between 23 and 3 needs to name who reported which.
  const who = typeof client === 'string' && /^[a-z0-9_-]{1,20}$/i.test(client) ? client : null;
  if (visible) {
    console.log(`[Apple] ${who || 'unknown client'}: ${visible.length} calendar(s) visible: ${visible.join(', ')}`);
  }
  console.log(`[Apple] ${events.length} event(s) in window ${from} → ${to}: ${JSON.stringify(byCalendar)}`);

  // ⚠ A PHONE THAT CAN SEE NO CALENDARS HAS NOT READ AN EMPTY DIARY.
  //
  // The write below is replace-by-window: it clears the range and re-inserts.
  // An unauthorised client sends a perfectly well-formed payload — a real
  // window, `events: []` — because EventKit hands it zero calendars rather
  // than an error, so the push would DELETE the range and answer ok. Measured
  // 13 Sep 2026: the native app pushed `0 calendar(s) visible` 323 times while
  // Nick's personal diary was simply absent from NEURO, and both halves
  // reported success. That is "I could not look" stored as "there is nothing
  // there", in the one table that answers whether he is free.
  //
  // The three cases stay distinct, and only the middle one is refused:
  //   • `visible` is a non-empty list — the phone looked. `events: []` is then
  //     a REAL empty window and must still clear, or a cancelled event lingers.
  //   • `visible` is an EMPTY list — the phone could not look. Refuse.
  //   • `visible` is null — a client too old to report them. Unknown, and
  //     lenient, because that client's pushes have always worked.
  //
  // Refused only when `events` is empty too: a payload carrying real events
  // from a client that also claims no calendars is incoherent, and between
  // losing those events and storing them the codebase's own asymmetry says a
  // missing event is the expensive failure.
  if (visible && visible.length === 0 && events.length === 0) {
    console.warn('[Apple] REFUSED: the phone reports it can see no calendars — window left alone');
    _recordPush({ at: new Date().toISOString(), client: who, visibleCalendars: 0, events: 0, stored: 0, refused: 'no-calendar-access' });
    return {
      ok: false,
      error: 'the phone can see no calendars — grant NEURO calendar access on the device',
      reason: 'no-calendar-access',
      window: { from, to },
      visibleCalendars: visible,
      cleared: false,
    };
  }

  // Build 11B: which calendars exist, for the classification screen — and how
  // many share a title, which is what makes a title-keyed classification
  // ambiguous for a client too old to send calendar ids. Never fails the push.
  if (visibleObjs) {
    try {
      const sc = require('./source-classification');
      sc.observeContainers('calendar', visibleObjs.filter((c) => !calendarIsSkipped(c.title)), { client: who });
      if (visibleObjs.every((c) => !c.id)) sc.noteDuplicateTitles('calendar', visible);
    } catch (e) { console.warn('[Apple] calendar containers not recorded:', e.message); }
  }

  // Artefact calendars — holiday feed duplicates, app-written calendars. Counted
  // per calendar rather than totalled, so a newly-noisy calendar is identifiable
  // rather than just a number going up.
  const skippedCalendars = {};
  const ignoredCalendars = {};
  // Calendars Nick ignored on Life. Read once per push; an unreadable store
  // ignores NOTHING, since a dropped real event is worse than a stray one.
  let ignored = () => false;
  try {
    const sc = require('./source-classification');
    const byKey = sc.classificationMap('calendar');
    const titleCount = sc.effectiveTitleCounts('calendar');
    ignored = (e) => sc.calendarIgnored({ id: e.calendarId || null, title: e.calendar || null }, { byKey, titleCount });
  } catch (err) { console.warn('[Apple] ignored calendars not read — keeping every event:', err.message); }
  const wanted = events.filter((e) => {
    const name = e && e.calendar ? String(e.calendar) : null;
    if (calendarIsSkipped(name)) { skippedCalendars[name] = (skippedCalendars[name] || 0) + 1; return false; }
    if (e && ignored(e)) { ignoredCalendars[name] = (ignoredCalendars[name] || 0) + 1; return false; }
    return true;
  });
  if (Object.keys(skippedCalendars).length) {
    console.log(`[Apple] skipped calendars: ${JSON.stringify(skippedCalendars)}`);
  }
  if (Object.keys(ignoredCalendars).length) {
    console.log(`[Apple] ignored calendars (set on Life): ${JSON.stringify(ignoredCalendars)}`);
  }

  const normalised = wanted.map(normaliseEvent).filter(Boolean);
  const rejected = wanted.length - normalised.length;

  // ── The same meeting, twice ────────────────────────────────────────────────
  //
  // Measured before building this: today NOTHING duplicates, because Nick's work
  // account is not added to the iOS Calendar app — 104 Graph events, and none of
  // them came back from the phone. But that is a setting, not a guarantee, and
  // the day it changes every work meeting arrives a second time under an
  // `apple:` id. Nothing would throw; the diary would simply be twice as full,
  // and `time-fit`, `findSlot` and the day planner would all quietly believe it.
  //
  // Graph WINS. It is authoritative for work: it carries the response status and
  // a real attendee list, where the Apple copy usually cannot even say whether
  // anyone else is in the meeting.
  //
  // Matched on start-minute plus subject rather than on an id, because the two
  // systems share no identifier at all — the Apple copy of an Exchange event has
  // its own local identifier and always will.
  let graphKeys = new Set();
  try {
    graphKeys = new Set(
      db.all(
        `SELECT substr(start_time, 1, 16) AS s, lower(subject) AS t
           FROM calendar_cache WHERE source = 'graph' AND start_time BETWEEN ? AND ?`,
        [String(from), String(to)]
      ).map((r) => `${r.s}|${r.t}`)
    );
  } catch (e) {
    // A failed lookup must not fail the push. Worst case is the duplication this
    // guard exists to prevent, which is visible; losing the whole sync is not.
    console.warn('[Apple] Could not read Graph events to de-duplicate:', e.message);
  }

  const rows = normalised.filter(
    (r) => !graphKeys.has(`${String(r.start).slice(0, 16)}|${String(r.subject).toLowerCase()}`)
  );
  const duplicates = normalised.length - rows.length;

  db.batchSaves(() => {
    db.clearCalendarWindow(SOURCE, String(from), String(to));
    for (const row of rows) db.upsertCalendarEvent(row);
  });

  // Build 3C: the world model. ALL normalised entries, including the ones the
  // cache just dropped as copies of a Graph meeting — the projector attaches
  // those to the Graph meeting as a SUPPORTING source, which is the record that
  // two systems agreed. Never allowed to fail the push.
  try {
    const wm = require('./world-model');
    const fromMs = Date.parse(String(from));
    const toMs = Date.parse(String(to));
    require('./world-sources').publishCalendarWindow({
      provider: 'apple',
      events: normalised,
      window: Number.isFinite(fromMs) && Number.isFinite(toMs)
        ? { fromLocal: wm.localMinute(fromMs), toLocal: wm.localMinute(toMs) } : null,
    });
  } catch (e) {
    console.warn('[Apple] world model not updated:', e.message);
  }

  const pushedAt = new Date().toISOString();
  _recordPush({
    at: pushedAt,
    client: who,
    visibleCalendars: visible ? visible.length : null,
    events: events.length,
    stored: rows.length,
    refused: null,
  });
  if (visibleObjs) {
    _recordClientPush(who, { at: pushedAt, client: who, events: events.length, stored: rows.length,
      ...coverageOf({ from, to, events, calendars: visibleObjs, at: pushedAt }) });
  }

  return {
    ok: true,
    window: { from, to },
    stored: rows.length,
    // Never silent. A push where half the events were unusable is a broken
    // client, and a bare success count reads as a quiet day.
    rejected,
    // Named rather than quietly dropped: if this starts climbing, the work
    // account has been added to the phone and that is worth knowing.
    duplicates,
    // The diagnostic half. `visibleCalendars: null` means an older copy of the
    // script that does not report them — distinct from an empty list, which
    // would mean the phone can see no calendars at all.
    visibleCalendars: visible,
    byCalendar,
    skippedCalendars,
  };
}

/**
 * Reminders, into the world model (Build 11D).
 *
 * ⚠ THIS USED TO WRITE NEURO TASK ROWS, and that was the wrong shape twice.
 * A reminder copied into `tasks` is a SECOND record of something Apple owns,
 * with nothing closing it when it is ticked on the phone (the `inbox_items`
 * failure), and it was stamped `domain: personal` by default — "personal
 * because it came from the iPhone", which is exactly the inference Build 10
 * ruled out. Live, it had produced ONE task in its whole life (3 Oct 2026).
 *
 * Now each reminder is a canonical TASK OBSERVATION under its own identity
 * (`eventkit-reminders:<calendarItemIdentifier>`), exactly as a Planner card
 * is: Apple is the authority on whether it is done, a tick on the phone is a
 * completion here, an untick is a reopen, and a complete read that no longer
 * lists it is a removal. Its domain is whatever Nick classified its LIST as —
 * unknown until he does.
 *
 * Which lists: every list the phone can see is RECORDED (so the classification
 * screen can offer it), but only TRACKED lists enter the world model — and
 * since Build 20A a list is tracked only when Nick said so on its stable id.
 * There is no default: the built-in "Reminders" list is unknown until he
 * decides (the phone has two lists of that name).
 *
 * ⚠ A reminder with NO id (an app build older than Build 11) is counted and
 * NOT projected: without Apple's identifier there is no identity, and
 * inventing one from the wording is how two different reminders with the
 * same words would become one.
 */
function ingestReminders({ reminders, lists = null, complete = false, client = null } = {}, { now = Date.now() } = {}) {
  if (!Array.isArray(reminders)) return { ok: false, error: 'reminders must be an array' };
  const sc = require('./source-classification');
  const who = typeof client === 'string' && /^[a-z0-9_-]{1,20}$/i.test(client) ? client : null;

  // The lists the phone could see. Older builds send none; derive them from
  // the reminders then (titles only).
  const listObjs = Array.isArray(lists)
    ? lists.map((l) => (l && typeof l === 'object' ? { id: l.id ? String(l.id) : null, title: String(l.title || '') } : { id: null, title: String(l) }))
    : [...new Map(reminders.filter((r) => r && r.list).map((r) => [String(r.listId || r.list), { id: r.listId ? String(r.listId) : null, title: String(r.list) }])).values()];
  sc.observeContainers('reminder-list', listObjs, { client: who, now });

  const byKey = sc.classificationMap('reminder-list');
  const titleCount = sc.effectiveTitleCounts('reminder-list', { now });
  const seenLists = {};
  const skippedLists = {};
  const tracked = [];
  let unidentified = 0;
  const rejected = [];
  for (const r of reminders) {
    const listTitle = r && r.list ? String(r.list) : '(no list)';
    seenLists[listTitle] = (seenLists[listTitle] || 0) + 1;
    if (!r || !r.list) { skippedLists[listTitle] = (skippedLists[listTitle] || 0) + 1; continue; }
    if (!sc.isTracked({ id: r.listId, title: r.list }, { byKey, titleCount })) { skippedLists[listTitle] = (skippedLists[listTitle] || 0) + 1; continue; }
    if (!r.title || !String(r.title).trim()) { rejected.push('a reminder with no title'); continue; }
    if (!r.id) { unidentified += 1; continue; }
    tracked.push(r);
  }

  // The lists this push covered completely: tracked, and actually read.
  const coveredLists = new Set(listObjs
    .filter((l) => sc.isTracked(l, { byKey, titleCount }))
    .map((l) => sc.containerKey('reminder-list', { id: l.id, title: l.title }))
    .filter(Boolean));
  const pub = require('./obligation-sources').publishReminders({
    reminders: tracked, complete: complete === true && Array.isArray(lists), coveredLists, now,
  });

  if (unidentified) {
    console.warn(`[Apple] ${unidentified} reminder(s) carried no id — not projected (this app build predates Build 11; rebuild it)`);
  }
  // Build 19A: per-list COUNTS for the audit (open / completed, tracked or
  // not). Counts only — no titles leave the push. Never fails the ingest.
  try {
    const audit = require('./reminder-audit');
    audit.recordPush(who || 'unknown', audit.countByList(reminders, listObjs, (l) => sc.isTracked(l, { byKey, titleCount })),
      { complete: complete === true && Array.isArray(lists), now });
  } catch (e) { console.warn('[Apple] reminder list counts not recorded:', e.message); }
  return {
    ok: !pub.error,
    error: pub.error || undefined,
    projected: tracked.length,
    changed: pub.changed || 0,
    removed: pub.removed || 0,
    complete: !!pub.complete,
    unidentified,
    rejected,
    seenLists,
    skippedLists,
    client: who,
  };
}

/**
 * What NEURO currently holds from the phone, so a stale push is visible.
 *
 * A push-based sync fails SILENTLY by definition — the phone simply stops
 * calling, and a frozen calendar answers every question exactly as a live one
 * does. Same species as the Jira cache that read as current for seven weeks.
 */
function status(now = new Date()) {
  try {
    const row = db.get(
      "SELECT COUNT(*) AS n, MAX(fetched_at) AS last FROM calendar_cache WHERE source = ?",
      [SOURCE]
    );
    const last = row && row.last ? new Date(`${String(row.last).replace(' ', 'T')}Z`) : null;
    const ageHours = last ? Math.round((now - last) / 36e5 * 10) / 10 : null;

    // ⚠ THE ATTEMPT AND THE ROWS ARE SEPARATE FACTS, and conflating them is
    // what made this report the wrong cause for two days. `lastPushAt` is when
    // an event last LANDED; `lastAttemptAt` is when the phone last CALLED. A
    // phone with no permission calls constantly and lands nothing, which reads
    // on the first number alone as a phone that has gone away — and sends the
    // reader to fix a Shortcut that was retired on 11 Sep 2026.
    const push = _lastPush();
    const attempt = push && push.at ? new Date(push.at) : null;
    const attemptAgeHours = attempt && !Number.isNaN(attempt.getTime())
      ? Math.round((now - attempt) / 36e5 * 10) / 10
      : null;

    // Three-valued on purpose. `unknown` covers both a phone that has never
    // called and a client too old to report its calendars; neither is evidence
    // that access was refused, and saying so would send Nick to Settings to fix
    // something that is not broken.
    let access = 'unknown';
    if (push) {
      if (push.refused === 'no-calendar-access' || push.visibleCalendars === 0) access = 'none';
      else if (typeof push.visibleCalendars === 'number' && push.visibleCalendars > 0) access = 'ok';
    }

    return {
      known: true,
      events: (row && row.n) || 0,
      lastPushAt: row ? row.last : null,
      ageHours,
      // Named rather than left for a caller to re-derive. The phone is meant to
      // push a few times a day; a day of silence means it has stopped calling.
      stale: ageHours === null ? true : ageHours > 24,
      lastAttemptAt: push ? push.at || null : null,
      attemptAgeHours,
      // ⚠ Silence and refusal are different faults with different fixes:
      // 'none' is answered in iOS Settings, a stale attempt clock is answered by
      // opening the app at all.
      access,
      visibleCalendars: push && push.visibleCalendars !== undefined ? push.visibleCalendars : null,
      // Which app last pushed. `null` is a client that did not say — unknown,
      // never a guess at whichever app happens to be installed.
      client: push && push.client ? push.client : null,
    };
  } catch (e) {
    return { known: false, why: e.message };
  }
}

/**
 * Build 18M/N: the calendar coverage audit — every phone calendar, per app,
 * with what it is, whether NEURO keeps it, and how many events it had in the
 * last window pushed. Measured, never assumed: a calendar with 0 events is
 * reported as 0 IN THAT WINDOW, which is not the same as empty.
 */
function calendarCoverage({ now = Date.now() } = {}) {
  let byClient = {};
  try { byClient = JSON.parse(db.getState(PUSH_BY_CLIENT_KEY) || '{}') || {}; } catch { byClient = {}; }
  let sc = null; let byKey = new Map(); let titleCount = new Map();
  try { sc = require('./source-classification'); byKey = sc.classificationMap('calendar'); titleCount = sc.effectiveTitleCounts('calendar'); } catch { sc = null; }
  const clients = Object.entries(byClient).map(([client, p]) => {
    const ageH = p.at ? Math.round((now - Date.parse(p.at)) / 36e5 * 10) / 10 : null;
    const calendars = (p.perCalendar || []).map((c) => {
      const r = sc ? sc.resolveFor('calendar', { id: c.id, title: c.title }, { byKey, titleCount }) : { classification: null, ambiguous: false };
      const cls = r.classification;
      const skipped = calendarIsSkipped(c.title);
      return { ...c,
        kept: skipped ? 'skipped-artefact' : cls && cls.tracked === false ? 'ignored-by-you' : 'kept',
        classification: cls ? { domains: cls.domains, tracked: cls.tracked } : null,
        classified: !!cls, ambiguousTitle: !!r.ambiguous };
    }).sort((a, b) => b.events - a.events || String(a.title).localeCompare(String(b.title)));
    return { client, at: p.at || null, ageHours: ageH, window: p.window || null, backDays: p.backDays, aheadDays: p.aheadDays,
      events: p.events, stored: p.stored, calendars,
      withEvents: calendars.filter((c) => c.events > 0).length, empty: calendars.filter((c) => c.events === 0).length,
      typesReported: calendars.some((c) => c.type) };
  });
  const horizons = clients.filter((c) => Number.isFinite(c.aheadDays)).map((c) => c.aheadDays);
  return {
    clients,
    measuredAt: new Date(now).toISOString(),
    // The policy as it stands, stated rather than left in two codebases.
    policy: {
      window: horizons.length ? `the phone looks ${Math.max(...horizons)} day(s) ahead and ${Math.max(...clients.map((c) => c.backDays || 0))} back` : 'no measured push yet',
      recurring: 'EventKit expands a recurring event into one row per occurrence inside the window; each occurrence is keyed apple:<id>:<start>',
      allDay: 'included, flagged isAllDay',
      deleted: 'replace-by-window: an event missing from a later push of the same window is removed; nothing outside the window is touched',
      skipped: 'two UK holiday feeds and app-written calendars (Zendone, Nozbe, Garmin) are never stored; anything you set to Ignore on Life is dropped',
      hidden: 'a calendar the app cannot see (iOS partial access) is absent from the push, which is a permission answer, not an empty diary',
    },
    note: clients.length ? null : 'No push has recorded coverage yet — this fills from the next phone push.',
  };
}

module.exports = {
  calendarCoverage,
  coverageOf,
  PUSH_BY_CLIENT_KEY,
  ingestCalendar,
  ingestReminders,
  status,
  SOURCE,
  PUSH_STATE_KEY,
  // pure, exported for tests
  normaliseEvent,
  visibleCalendars,
  toLocalWallClock,
};
