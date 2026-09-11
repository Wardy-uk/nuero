'use strict';

/**
 * What SARA says when Nick walks into a room that can speak.
 *
 * Nick, 11 Sep 2026: "if when I walked into a room where speech was enabled, SARA
 * could actually greet me" — "it should vary the greeting so we don't get bored.
 * If it's work hours, work related; if not, doesn't need to say anything other than
 * the greeting."
 *
 * The ARRIVAL is decided in sara/backend (the room sensors live there); this module
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

const LEDGER_KEY = 'sara_greetings';
const COOLDOWN_MINUTES = 90;
const RECENT_KEEP = 4;
// Work hours for the WORDS, not for duty: on a working day, 08:00–18:00.
const WORK_START_MINUTES = 8 * 60;
const WORK_END_MINUTES = 18 * 60;

// ⚠ Every opener uses his name (Nick, 11 Sep 2026, after "Welcome back." on the
// first live test: "it didn't use my name"). A greeting without it reads as an
// announcement to the room rather than SARA speaking to him. Pinned by a test.
const OPENERS = {
  morning: ['Morning, Nick.', 'Good morning, Nick.', 'Morning, Nick. Here we go.'],
  afternoon: ['Afternoon, Nick.', 'Good afternoon, Nick.', 'Hey, Nick.'],
  evening: ['Evening, Nick.', 'Good evening, Nick.', 'Hey, Nick.'],
  any: ['Hi, Nick.', 'There you are, Nick.'],
  // Only once he has already been greeted today — "welcome back" to the first
  // arrival of the day is a small lie, and small lies are what make a voice grate.
  again: ['Welcome back, Nick.', 'Hello again, Nick.', 'Back again, Nick.'],
};

const ROOM_OPENERS = {
  study: ['Back at the desk, Nick.'],
};

const LEADS = ['Top of the list:', 'First thing worth knowing:', 'Most pressing:', 'One thing:', 'Heads up:'];

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
 * Should SARA speak at all? PURE.
 * @returns {{speak: boolean, why: string|null}}
 */
function decide({ room, now, quiet, inMeeting, ledger, cooldownMinutes = COOLDOWN_MINUTES }) {
  if (!room) return { speak: false, why: 'no room' };
  if (quiet) return { speak: false, why: 'quiet hours' };
  if (inMeeting) return { speak: false, why: 'in a meeting' };
  const last = ledger && ledger.rooms && ledger.rooms[room];
  const lastMs = last ? new Date(last).getTime() : NaN;
  if (Number.isFinite(lastMs) && now.getTime() - lastMs < cooldownMinutes * 60000) {
    return { speak: false, why: `greeted in the ${room} ${Math.round((now.getTime() - lastMs) / 60000)} min ago` };
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
 * The words. PURE.
 * @param {object} o
 * @param {Date} o.now
 * @param {string} o.room
 * @param {boolean} o.workHours
 * @param {string|null} o.workTitle  the attention feed's primary item title, or null
 * @param {object} o.ledger          for recent openers/leads and "already greeted today"
 * @param {function} [o.rng]
 */
function compose({ now, room, workHours, workTitle, ledger = {}, rng = Math.random }) {
  const greetedToday = ledger.lastAnyAt && dateKey(new Date(ledger.lastAnyAt)) === dateKey(now);
  const pool = [
    ...OPENERS[dayPart(now)],
    ...OPENERS.any,
    ...(greetedToday ? OPENERS.again : []),
    ...(ROOM_OPENERS[room] || []),
  ];
  const opener = pick(pool, ledger.recentOpeners, rng);

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

function recordGreeting(ledger, { room, now, opener, lead }) {
  const next = {
    rooms: { ...(ledger.rooms || {}), [room]: now.toISOString() },
    lastAnyAt: now.toISOString(),
    recentOpeners: [opener, ...(ledger.recentOpeners || []).filter((o) => o !== opener)].slice(0, RECENT_KEEP),
    recentLeads: lead
      ? [lead, ...(ledger.recentLeads || []).filter((l) => l !== lead)].slice(0, RECENT_KEEP)
      : (ledger.recentLeads || []),
  };
  return next;
}

/**
 * Claim a greeting for an arrival: gate it, compose it, record it.
 *
 * `preview` composes and gates without recording, so the voice can be checked
 * without spending the cooldown.
 */
async function claim({ room, now = new Date(), preview = false } = {}) {
  const ledger = readLedger();

  let quiet = false;
  try {
    const settings = require('./attention-settings');
    const s = settings.read();
    // SARA paused counts as quiet too — Nick told her to stop.
    quiet = settings.isQuietAt(s, now) || settings.isPaused(s, now) || s.enabled === false;
  } catch { /* unreadable settings: fall through to the other gates */ }

  let inMeeting = false;
  try {
    inMeeting = Boolean(require('./attention').currentMeetingEvent(now));
  } catch { /* an unreadable diary is not a meeting */ }

  const decision = decide({ room, now, quiet, inMeeting, ledger });
  if (!decision.speak && !preview) return { speak: false, why: decision.why, text: null };

  let workingDay = false;
  try {
    const wd = require('./working-days');
    workingDay = wd.isWorkingDay(now);
  } catch { /* unknown: treat as not a working day, so the greeting is just a greeting */ }
  const workHours = isWorkHours(now, workingDay);

  let workTitle = null;
  if (workHours) {
    try {
      const payload = await require('./attention').build({ now });
      const p = payload && payload.primary;
      if (p && p.kind === 'item' && p.title) workTitle = p.title;
    } catch (e) {
      // A failed feed costs the work line, never the greeting.
      console.warn('[Greeting] attention unavailable:', e.message);
    }
  }

  const words = compose({ now, room, workHours, workTitle, ledger });
  if (!preview) {
    try {
      db.setState(LEDGER_KEY, JSON.stringify(recordGreeting(ledger, { room, now, ...words })));
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
  OPENERS, LEADS, ROOM_OPENERS, COOLDOWN_MINUTES, LEDGER_KEY,
};
