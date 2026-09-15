'use strict';

// One visit to a room, as a thing with an identity (12 Sep 2026).
//
// PURE. Takes the previous state, the current presence reading and `now`, and
// returns the next state plus an episode id. No DB, no clock, no network — the
// caller persists the state (see `rooms.js`).
//
// WHY THIS EXISTS. Nick's rule for the lights is "ask when I walk in, and ask
// again if the window arrives while I am sitting here" — which means asking
// ONCE PER VISIT. The obvious key for a visit is the presence sensor's own
// `last_changed`, and it is wrong in a way that is invisible until it is
// annoying: a momentary drop to `unclear` and back restamps it, so a two-second
// wobble reads as leaving and re-entering the room and SAiM asks again. Ten
// wobbles in an evening is ten prompts, which is how she gets muted.
//
// ⚠ THE WOBBLE GUARD IS `saim/backend`'s, NOT A NEW NUMBER. `greeter.js` had
//   exactly this problem for greetings and measured the answer on real data:
//   the watch went unsure for SIXTEEN SECONDS and came back, and the detector
//   greeted an arrival that never happened, while his real walk out and back
//   was ~56 seconds. `MIN_AWAY_MS` 45s sits between the two. Re-deriving that
//   here would be a second opinion about the same physical fact, so it is
//   imported rather than guessed, and a test pins the two together.
//
// ⚠ UNREADABLE PRESENCE DOES NOT END A VISIT. `unclear`, `unavailable` and a
//   missing sensor all mean "I cannot see him", which is NOT "he left" — and
//   ending the visit on it would reopen a new one the moment the feed recovers,
//   re-asking everything he has already declined. The visit is held open and
//   only ends when he is positively seen SOMEWHERE ELSE, or when the feed has
//   been unreadable for longer than the away threshold.
//
// ⚠ AN EPISODE ID IS OPAQUE AND MUST NOT BE PARSED. It exists to make two
//   readings comparable, nothing more. It is deliberately NOT the timestamp of
//   entry, because that is a fact a surface would be tempted to render ("you
//   arrived at 18:04") off a signal that tracks a WATCH, not Nick.

// The one measured number, borrowed from the greeter. 45s sits between a 16s
// sensor wobble and a ~56s real walk out and back.
const MIN_AWAY_MS = 45 * 1000;

/** A fresh, empty state. */
function emptyState() {
  return { room: null, episode: null, enteredAt: null, lastSeenAt: null, unseenSince: null };
}

function toMs(v) {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function slug(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Advance the visit state by one reading.
 *
 * @param {object|null} prev      previous state (or null / emptyState())
 * @param {object|null} presence  { room, confidence } as read from HA
 * @param {Date|string} now
 * @param {object} [opts]         { minAwayMs }
 * @returns {{ state, episode, room, changed, why }}
 *   `episode` is null when he is not positively in a room.
 */
function advance(prev, presence, now, opts = {}) {
  const minAway = opts.minAwayMs ?? MIN_AWAY_MS;
  const nowMs = toMs(now);
  const s = prev && typeof prev === 'object' ? { ...emptyState(), ...prev } : emptyState();

  if (nowMs === null) {
    // ⚠ No clock means no judgement. Hold whatever we had; never invent a visit.
    return { state: s, episode: s.episode, room: s.room, changed: false, why: 'no readable clock' };
  }

  const sure = presence && presence.confidence === 'sure' && presence.room;
  const room = sure ? slug(presence.room) : null;

  // --- Not positively anywhere ---------------------------------------------
  if (!room) {
    if (!s.room) {
      return { state: { ...s, unseenSince: s.unseenSince ?? nowMs }, episode: null, room: null, changed: false, why: 'not seen' };
    }
    const unseenSince = s.unseenSince ?? nowMs;
    // ⚠ Held open, not ended — see the header. Only a LONG blind spell ends it.
    if (nowMs - unseenSince < minAway) {
      return {
        state: { ...s, unseenSince },
        episode: s.episode,
        room: s.room,
        changed: false,
        why: 'presence unreadable for ' + Math.round((nowMs - unseenSince) / 1000) + 's — visit held open',
      };
    }
    return {
      state: { ...emptyState(), unseenSince },
      episode: null,
      room: null,
      changed: true,
      why: 'unseen for longer than ' + Math.round(minAway / 1000) + 's — visit ended',
    };
  }

  // --- Positively in a room ------------------------------------------------
  // Same room, and either continuously seen or away only briefly: same visit.
  if (s.room === room && s.episode) {
    const gap = s.unseenSince === null ? 0 : nowMs - s.unseenSince;
    if (gap < minAway) {
      return {
        state: { ...s, lastSeenAt: nowMs, unseenSince: null },
        episode: s.episode,
        room,
        changed: false,
        why: gap > 0 ? 'back within ' + Math.round(gap / 1000) + 's — same visit' : 'still here',
      };
    }
    // Gone long enough and returned: a genuinely new visit, and a fair question
    // again. This is the case Nick's spec asks for on re-entry.
  }

  const episode = room + '@' + nowMs;
  return {
    state: { room, episode, enteredAt: nowMs, lastSeenAt: nowMs, unseenSince: null },
    episode,
    room,
    changed: true,
    why: s.room && s.room !== room ? 'moved from ' + s.room : 'arrived',
  };
}

/**
 * The dedupe key an offer carries, scoped to ONE visit.
 *
 * ⚠ Scoping to the visit is what makes "no" mean "not this time" rather than
 * "never". The attention lifecycle's own rule does the rest: a terminal record
 * never re-matches, so a decline is final FOR THIS KEY and the next visit mints
 * a new one.
 */
function keyFor(offerKey, episode) {
  return episode ? offerKey + '#' + episode : offerKey;
}

module.exports = { advance, keyFor, emptyState, slug, MIN_AWAY_MS };
