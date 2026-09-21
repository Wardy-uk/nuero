'use strict';

/**
 * What SAiM says when Nick walks into a room that can speak.
 *
 * Nick, 11 Sep 2026: "if when I walked into a room where speech was enabled, SAiM
 * could actually greet me" — "it should vary the greeting so we don't get bored.
 * If it's work hours, work related; if not, doesn't need to say anything other than
 * the greeting."
 *
 * The ARRIVAL is decided in saim/backend (the room sensors live there); this module
 * decides whether to speak and what the words are, so every speaker — the HomePod,
 * the study tablet, anything added later — says one thing one way.
 *
 * Split like `pi-health.assess()`: `decide()` and `compose()` are PURE (clock and
 * randomness passed in), `claim()` does the reads and writes the ledger.
 *
 * ⚠ Rules, each a way a greeting becomes the thing that gets muted:
 *  - NOT OVERNIGHT. Quiet hours are attention-settings' (Nick's own override, else
 *    PUSH_QUIET_HOURS) — one statement about when to leave him alone, not a second.
 *  - NOT IN A MEETING. Walking into the study for a Teams call is not a moment to
 *    be read the top of the task list out loud.
 *  - ONCE PER ROOM PER COOLDOWN. Fetching a drink and coming back is not arriving.
 *  - VARIED, WITHOUT A MODEL CALL. Deterministic pools with the last few openers
 *    excluded: instant, free, and works with the Pi's models offline. A model asked
 *    for a cheery line is exactly how it invents a meeting (the 7 Sep briefing bug).
 *  - WORK HOURS ADD ONE THING, AND ONLY A REAL ONE. The attention feed's own primary
 *    item, never a count invented here; nothing pressing means greeting only — no
 *    "all clear", because a greeting cannot see what the feed could not.
 */

const db = require('../db/database');

const LEDGER_KEY = 'saim_greetings';
const COOLDOWN_MINUTES = 90;

// How close a meeting has to be before it is worth saying at the door. Wide
// enough to be useful walking in, short enough that it is still true by the
// time he sits down.
const MEETING_SOON_MINUTES = 15;

// How many recent brief kinds to remember. ONE, deliberately: it stops her
// repeating herself on the way back in without making a fact unsayable for the
// rest of the day.
const BRIEF_KEEP = 1;
const RECENT_KEEP = 4;
// Work hours for the WORDS, not for duty: on a working day, 08:00–18:00.
const WORK_START_MINUTES = 8 * 60;
const WORK_END_MINUTES = 18 * 60;

// ⚠ Every opener uses his name (Nick, 11 Sep 2026, after "Welcome back." on the
// first live test: "it didn't use my name"). A greeting without it reads as an
// announcement to the room rather than SAiM speaking to him. Pinned by a test.
// ⚠ NATURAL, CASUAL, FRIENDLY (Nick, 12 Sep 2026) — the first cut read like an
// announcement rather than a person. Still SAiM's register, not a cheerful assistant's:
// no exclamation marks, no "great to see you", nothing that fakes delight. Warm and dry,
// the way somebody in the room would actually say it. Pinned by tests.
const OPENERS = {
  morning: ['Morning, Nick.', 'Morning, Nick. You\'re up.', 'Morning, Nick. Right then.', 'Morning, Nick. How\'d you sleep?'],
  afternoon: ['Afternoon, Nick.', 'Hey, Nick.', 'Afternoon, Nick. How\'s it going?', 'Hey Nick. Afternoon.'],
  evening: ['Evening, Nick.', 'Hey, Nick.', 'Evening, Nick. Long day?', 'Evening, Nick. Still at it?'],
  any: ['Hi, Nick.', 'There you are, Nick.', 'Hey there, Nick.', 'Oh, hello Nick.'],
  // Only once he has already been greeted today — "welcome back" to the first
  // arrival of the day is a small lie, and small lies are what make a voice grate.
  again: ['Welcome back, Nick.', 'Back again, Nick.', 'That was quick, Nick.', 'Hello again, Nick.'],
};

const ROOM_OPENERS = {
  study: ['Back at the desk, Nick.', 'Desk time, Nick.'],
};

const LEADS = ['While you\'re here —', 'One for you —', 'Worth knowing —', 'Heads up —', 'Top of the pile —'];

function dayPart(now) {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Work hours for the purpose of choosing words. PURE. */
function isWorkHours(now, isWorkingDay) {
  if (!isWorkingDay) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= WORK_START_MINUTES && mins < WORK_END_MINUTES;
}

/**
 * Should SAiM speak at all? PURE.
 * @returns {{speak: boolean, why: string|null}}
 */
function decide({ room, client, now, quiet, inMeeting, ledger, cooldownMinutes = COOLDOWN_MINUTES }) {
  // WARNING  A ROOM AND A CLIENT ARE BOTH ARRIVALS, AND THEY COOL DOWN
  //   SEPARATELY. Walking into the study and opening SAiM on the phone are two
  //   different arrivals, so one must not silence the other - a man who checks
  //   his phone in the kitchen would otherwise never be greeted by the kitchen
  //   again. What they DO share is `recentKinds` and `lastAnyAt`, so she does
  //   not tell him about the rain twice on two surfaces and the once-a-day
  //   sleep line stays once a day across all of them. The existing comment on
  //   `recentKinds` already draws that line: a variety rule, not a suppression.
  const where = room || client;
  if (!where) return { speak: false, why: 'no room or client' };
  if (quiet) return { speak: false, why: 'quiet hours' };
  if (inMeeting) return { speak: false, why: 'in a meeting' };
  const seen = room ? (ledger && ledger.rooms) : (ledger && ledger.clients);
  const last = seen && seen[where];
  const lastMs = last ? new Date(last).getTime() : NaN;
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < cooldownMinutes * 60000) {
    const mins = Math.round((now.getTime() - lastMs) / 60000);
    return {
      speak: false,
      why: room ? `greeted in the ${room} ${mins} min ago` : `greeted on ${client} ${mins} min ago`,
    };
  }
  return { speak: true, why: null };
}

/** Pick from `pool` avoiding `recent` where possible. PURE given `rng`. */
function pick(pool, recent, rng) {
  const fresh = pool.filter((p) => !(recent || []).includes(p));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rng() * from.length) % from.length];
}

function terminate(s) {
  const t = String(s || '').trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * THE ONE THING WORTH SAYING AS HE WALKS IN. PURE.
 *
 * Nick, 13 Sep 2026: *"take JARVIS as a concept and build it into SAiM."* The
 * greeting already had the hard parts - she notices him arrive, she owns a
 * cooldown, and NEURO decides the words while SAiM only delivers them. What
 * it said was a greeting plus the top task, which is the same sentence
 * whatever is actually happening.
 *
 * WARNING  ONE LINE, NEVER A LIST. A briefing at the door is noise; JARVIS is
 *   terse. Everything here competes for a single slot and the ranking IS the
 *   product - what earns an interruption at the moment of walking in.
 *
 * WARNING  IT ADDS NO NEW REASON TO SPEAK. Every guard above still decides
 *   WHETHER she speaks - quiet hours, paused, in a meeting, the cooldown, the
 *   room having a speaker. This only chooses the words once that is settled.
 *
 * WARNING  EVERY FACT IS ALREADY ON THE PAYLOAD, and an unreadable one simply
 *   drops out of the ranking. Nothing here fetches, nothing here infers, and a
 *   missing input can only ever make her say LESS.
 *
 * @returns {{ kind, line }|null}  null means fall through to the work line.
 */
function briefLine({
  now,
  room = null,
  workHours = false,
  firstToday = false,
  agenda = null,
  primary = null,
  rooms = null,
  weather = null,
  lastNight = null,
  recentKinds = [],
} = {}) {
  const said = new Set(Array.isArray(recentKinds) ? recentKinds : []);
  const fresh = (kind, line) => (line && !said.has(kind) ? { kind, line } : null);

  // 1. A MEETING ABOUT TO START. The most time-bound thing there is, and the
  //    one he would be annoyed to be told about afterwards.
  //
  // WARNING  A REAL MEETING ONLY - `attendeesOther` must be exactly TRUE. Half
  //   his diary is solo focus blocks, and announcing one as a meeting is the
  //   three-valued trap `isRealMeeting` exists for.
  const events = (agenda && agenda.known === true && Array.isArray(agenda.events)) ? agenda.events : [];
  const next = events.find(e => e
    && e.attendeesOther === true
    && Number.isFinite(e.minutesAway)
    && e.minutesAway >= 0
    && e.minutesAway <= MEETING_SOON_MINUTES);
  if (next) {
    const who = String(next.subject || '').trim();
    const mins = next.minutesAway;
    const when = mins <= 1 ? 'now' : `in ${mins} minutes`;
    const hit = fresh('meeting', who ? `${terminate(who)} ${when}.` : `Something in the diary ${when}.`);
    if (hit) return hit;
  }

  // 2. SOMETHING BREACHING. The one class of work that outranks the room he is
  //    standing in, and the documented exception to staying off work talk.
  if (primary && primary.kind === 'item' && primary.urgency === 'critical' && primary.title) {
    const hit = fresh('critical', terminate(String(primary.title).trim()));
    if (hit) return hit;
  }

  // 3. THE ROOM HE JUST WALKED INTO IS COLD.
  //
  // WARNING  IT READS THE OFFER, never a raw temperature it judged itself.
  //   `room-offers` already decided what counts as cold (19C, Nick's number),
  //   refused a Fahrenheit-looking reading, and scoped it to the room he is
  //   actually in. A second opinion here is how two parts of one system come to
  //   disagree about whether the living room is cold.
  const offers = (rooms && rooms.known === true && Array.isArray(rooms.offers)) ? rooms.offers : [];
  // WARNING  THE KIND IS `warm-room`, WHICH IS WHAT `room-offers` EMITS. The
  //   first cut guessed `heating` and matched nothing - silently, because a
  //   find() that returns undefined is indistinguishable from a warm house.
  //   Pinned against the producer in the tests.
  const cold = offers.find(o => o && o.kind === 'warm-room' && Number.isFinite(o.currentC));
  if (cold) {
    const hit = fresh('cold', `It's ${Math.round(cold.currentC)} in here.`);
    if (hit) return hit;
  }

  // 4. WEATHER THAT IS ABOUT TO MATTER.
  //
  // WARNING  THE WORDS ARE `weather-outlook`'S, taken verbatim. It already
  //   decided what is worth mentioning (0.2mm is drizzle nobody needs warning
  //   about) and phrased it once so every surface says it the same way.
  const lines = (weather && weather.known === true && Array.isArray(weather.outlook)) ? weather.outlook : [];
  if (lines.length) {
    const hit = fresh('weather', terminate(String(lines[0]).trim()));
    if (hit) return hit;
  }

  // 5. HOW HE SLEPT - once, on the first greeting of the day, and only when it
  //    was out of the ordinary FOR THAT WEEKDAY.
  //
  // WARNING  IT STATES AND NEVER DIAGNOSES. "Nine and a half, well above your
  //   usual Sunday" is checkable against his own data; "you must be tired" is a
  //   verdict nothing here has standing to give - `health-daily`'s line,
  //   inherited rather than re-decided.
  if (firstToday && lastNight && lastNight.known === true && lastNight.notable === true
      && Number.isFinite(lastNight.asleepHours) && lastNight.usualLine) {
    const h = Math.floor(lastNight.asleepHours);
    const m = Math.round((lastNight.asleepHours - h) * 60);
    const hit = fresh('sleep', `You slept ${h}h${String(m).padStart(2, '0')} - ${lastNight.usualLine}.`);
    if (hit) return hit;
  }

  // Nothing earned the slot. The work line below is the fallback, and off duty
  // there is no line at all - which is the correct answer most of the time.
  return null;
}

/**
 * The words. PURE.
 * @param {object} o
 * @param {Date} o.now
 * @param {string} o.room
 * @param {boolean} o.workHours
 * @param {string|null} o.workTitle  the attention feed's primary item title, or null
 * @param {object} o.ledger          for recent openers/leads and "already greeted today"
 * @param {function} [o.rng]
 */
function compose({ now, room, workHours, workTitle, brief = null, ledger = {}, rng = Math.random }) {
  const greetedToday = ledger.lastAnyAt && dateKey(new Date(ledger.lastAnyAt)) === dateKey(now);
  const pool = [
    ...OPENERS[dayPart(now)],
    ...OPENERS.any,
    ...(greetedToday ? OPENERS.again : []),
    ...(ROOM_OPENERS[room] || []),
  ];
  const opener = pick(pool, ledger.recentOpeners, rng);

  // WARNING  THE BRIEF WINS. It is chosen for the moment - a meeting about to
  //   start, a breach, a cold room, rain coming - and the work line is the
  //   fallback for when nothing has earned the slot. Putting both in would make
  //   a briefing out of a greeting, which is the thing JARVIS never does.
  if (brief && brief.line) {
    return { text: `${opener} ${brief.line}`, opener, lead: null, briefKind: brief.kind || null };
  }

  const title = workHours && workTitle ? String(workTitle).trim() : '';
  if (!title) return { text: opener, opener, lead: null };

  const lead = pick(LEADS, ledger.recentLeads, rng);
  return { text: `${opener} ${lead} ${terminate(title)}`, opener, lead };
}

function readLedger() {
  try {
    const v = JSON.parse(db.getState(LEDGER_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function recordGreeting(ledger, { room, client, now, opener, lead, briefKind = null }) {
  const next = {
    rooms: room ? { ...(ledger.rooms || {}), [room]: now.toISOString() } : { ...(ledger.rooms || {}) },
    // WARNING  A SEPARATE MAP, NOT A ROOM CALLED "saim-ios". `rooms` is read by
    //   the arrival detector and keyed on sensor room ids; putting a client in
    //   there would make the phone look like somewhere in the house to every
    //   future reader of this ledger.
    clients: client ? { ...(ledger.clients || {}), [client]: now.toISOString() } : { ...(ledger.clients || {}) },
    lastAnyAt: now.toISOString(),
    recentOpeners: [opener, ...(ledger.recentOpeners || []).filter((o) => o !== opener)].slice(0, RECENT_KEEP),
    recentLeads: lead
      ? [lead, ...(ledger.recentLeads || []).filter((l) => l !== lead)].slice(0, RECENT_KEEP)
      : (ledger.recentLeads || []),
    // WARNING  WHICH KINDS she has just used, so she does not mention the
    //   weather twice running. Kept SHORT on purpose: it is a variety rule, not
    //   a suppression - a meeting about to start must be sayable again tomorrow,
    //   and a cold room again this evening.
    recentKinds: briefKind
      ? [briefKind, ...(ledger.recentKinds || []).filter((k) => k !== briefKind)].slice(0, BRIEF_KEEP)
      : (ledger.recentKinds || []),
  };
  return next;
}

/**
 * Claim a greeting for an arrival: gate it, compose it, record it.
 *
 * `preview` composes and gates without recording, so the voice can be checked
 * without spending the cooldown.
 */
async function claim({ room, client = null, now = new Date(), preview = false } = {}) {
  const ledger = readLedger();

  let quiet = false;
  try {
    const settings = require('./attention-settings');
    const s = settings.read();
    // SAiM paused counts as quiet too — Nick told her to stop.
    quiet = settings.isQuietAt(s, now) || settings.isPaused(s, now) || s.enabled === false;
  } catch { /* unreadable settings: fall through to the other gates */ }

  let inMeeting = false;
  try {
    inMeeting = Boolean(require('./attention').currentMeetingEvent(now));
  } catch { /* an unreadable diary is not a meeting */ }

  const decision = decide({ room, client, now, quiet, inMeeting, ledger });
  if (!decision.speak && !preview) return { speak: false, why: decision.why, text: null };

  let workingDay = false;
  try {
    const wd = require('./working-days');
    workingDay = wd.isWorkingDay(now);
  } catch { /* unknown: treat as not a working day, so the greeting is just a greeting */ }
  const workHours = isWorkHours(now, workingDay);

  // THE FACTS SHE COULD MENTION, read ONCE.
  //
  // WARNING  THE PAYLOAD IS READ WHATEVER THE HOUR NOW. It used to be fetched
  //   only during work hours, because the only thing taken from it was the top
  //   task - but a meeting about to start, a cold room and rain in half an hour
  //   all matter at the weekend, and that is most of what makes her useful at
  //   the door. It is one read per ARRIVAL, and arrivals are capped by a
  //   90-minute cooldown.
  //
  // WARNING  A FAILED FEED COSTS THE LINE, NEVER THE GREETING. She still says
  //   hello; she just has nothing to add, which is the honest outcome.
  let workTitle = null;
  let brief = null;
  try {
    const payload = await require('./attention').build({ now });
    const p = payload && payload.primary;
    if (workHours && p && p.kind === 'item' && p.title) workTitle = p.title;
    brief = briefLine({
      now,
      room: room || null,
      workHours,
      // Once a day for the sleep line: the first time she speaks to him.
      firstToday: !(ledger.lastAnyAt && dateKey(new Date(ledger.lastAnyAt)) === dateKey(now)),
      agenda: payload && payload.agenda,
      primary: p,
      rooms: payload && payload.rooms,
      weather: payload && payload.weather,
      lastNight: payload && payload.lastNight,
      // WARNING  SHE DOES NOT SAY THE SAME KIND OF THING TWICE RUNNING. Told
      //   about the weather on the way in, she finds something else next time
      //   or says nothing - the rule the opener and lead pools already follow.
      recentKinds: Array.isArray(ledger.recentKinds) ? ledger.recentKinds : [],
    });
  } catch (e) {
    console.warn('[Greeting] attention unavailable:', e.message);
  }

  const words = compose({ now, room, workHours, workTitle, brief, ledger });
  if (!preview) {
    try {
      db.setState(LEDGER_KEY, JSON.stringify(recordGreeting(ledger, { room, client, now, ...words })));
    } catch (e) {
      console.warn('[Greeting] ledger write failed:', e.message);
    }
  }
  return {
    speak: preview ? decision.speak : true,
    why: decision.why,
    text: words.text,
    workHours,
    preview: Boolean(preview),
  };
}

module.exports = {
  claim, decide, compose, isWorkHours, dayPart, recordGreeting, pick,
  briefLine, MEETING_SOON_MINUTES,
  OPENERS, LEADS, ROOM_OPENERS, COOLDOWN_MINUTES, LEDGER_KEY,
};
