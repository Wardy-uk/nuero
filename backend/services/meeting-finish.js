'use strict';

/**
 * "That's finished" — a meeting that ended early.
 *
 * ⚠ WHY. Nick, 8 Sep 2026: *"we should probably add a 'done' button for when a
 * meeting ends early ;)"*. Being in a meeting is the ONE state where SARA
 * interrupting is actively wrong, so `context-state` sets `quiet` and
 * `attention.gate()` holds everything back — correctly, and entirely off the
 * CALENDAR's word. A meeting scheduled to 14:30 that broke up at 14:10 therefore
 * cost twenty minutes of a working day in which the surface refused to help,
 * and nothing anywhere could be told otherwise. The diary is a plan; this is the
 * one fact about it only Nick has.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 *
 * ⚠ IT RELEASES A STATE AND CAN NEVER CREATE ONE. There is deliberately no way
 *   to declare yourself INTO a meeting: the calendar decides that, and a manual
 *   way to make SARA go quiet is a mute button wearing a meeting's clothes.
 *
 * ⚠ IT IS KEYED TO THE OCCURRENCE, NEVER A BOOLEAN. A flag reading "not in a
 *   meeting" would silence the state for the NEXT meeting too — a different
 *   room, different people, and precisely the failure the quiet state exists to
 *   prevent. A recurring meeting's next occurrence is a different key.
 *
 * ⚠ IT EXPIRES AT THE MEETING'S OWN SCHEDULED END, and is pruned there. Past
 *   that the calendar agrees with it and the record says nothing; keeping it is
 *   an ever-growing blob whose old keys can only ever match something they
 *   should not.
 *
 * ⚠ NOTHING IS WRITTEN TO THE CALENDAR. The meeting is not Nick's to shorten —
 *   other people are in it, and Graph would mail every one of them. This
 *   records where HE is, not when the meeting ended, and `scheduledEnd` keeps
 *   the diary's own fact intact beside it.
 *
 * ⚠ THERE IS A WAY BACK (`resume`), because the cost of a wrong press is SARA
 *   speaking up in a real meeting — the exact failure being guarded. Every other
 *   reversible decision in this codebase has one (`restore`, `unmerge`,
 *   `unlink`, `forget`, `undefer`) and this is the one where the wrong direction
 *   is most visible to other people.
 *
 * ⚠ THE OVERRIDE IS APPLIED ONCE, AT THE INPUT (`applyTo`), rather than
 *   threaded as a flag through `context-state`, `agendaFor` and `transitions`.
 *   Three consumers each remembering to honour a field is three chances to
 *   forget one, and a surface still calling him "in a meeting" after he has said
 *   he is out is worse than the twenty minutes this fixes. Rewriting the
 *   effective `end` means every one of them — including any written later — is
 *   right by default, and it hands `transitions` its post-meeting "anything to
 *   capture?" prompt for free, which is the moment the follow-ups are still in
 *   his head.
 *
 * PURE half (`keyFor`, `applyTo`, `prune`) — no DB, no clock beyond what it is
 * given. Store half reads and writes `agent_state.meeting_finished_early`.
 *
 * CommonJS.
 */

const STATE_KEY = 'meeting_finished_early';

// Enough for a day of meetings several times over. A bound at all is what stops
// a stuck writer turning a KV value into the thing that slows the feed down.
const MAX_ENTRIES = 40;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function toMs(v) {
  if (!v) return NaN;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * The identity of one OCCURRENCE. PURE.
 *
 * ⚠ The calendar id is preferred and the start-plus-subject fallback exists
 * because the ICS and NOVA-bridge paths synthesise ids that are not stable
 * across a sync. The START is in the key either way, which is what keeps a
 * recurring meeting's Tuesday from matching its Wednesday.
 *
 * Returns null when there is not enough to identify it — and a null key is
 * REFUSED by `finish()` rather than stored, because an entry that matches
 * nothing is indistinguishable from one that has already expired, and an entry
 * that matches everything would silence the whole diary.
 */
function keyFor(event) {
  if (!isObj(event)) return null;
  const start = typeof event.start === 'string' ? event.start.trim() : '';
  if (!start) return null;
  const id = typeof event.id === 'string' ? event.id.trim() : '';
  if (id) return `id:${id}::${start}`;
  const subject = typeof event.subject === 'string' ? event.subject.trim().toLowerCase() : '';
  if (!subject) return null;
  return `at:${start}::${subject}`;
}

/**
 * Drop entries whose meeting was due to end before `now`. PURE.
 *
 * At that point the calendar says the same thing the override does, so the
 * override has nothing left to say. Anything unparseable is dropped too — a
 * record that cannot be aged out is one that never expires.
 */
function prune(entries, now = new Date()) {
  const nowMs = toMs(now);
  const out = {};
  if (!isObj(entries) || !Number.isFinite(nowMs)) return out;
  for (const [key, e] of Object.entries(entries)) {
    if (!isObj(e)) continue;
    const endMs = toMs(e.scheduledEnd);
    if (!Number.isFinite(endMs) || endMs <= nowMs) continue;
    out[key] = e;
  }
  return out;
}

/**
 * Apply the overrides to a calendar input. PURE.
 *
 * ⚠ It only ever moves an end EARLIER, and never before the start. An override
 * that could extend a meeting would be a way to make SARA go quiet for longer,
 * which rule one forbids; a negative-length event would break every consumer
 * that subtracts two times.
 *
 * ⚠ The diary's own fact survives as `scheduledEnd`, so nothing has been lost —
 * only what NEURO now believes about where Nick is has changed.
 */
function applyTo(calendar, entries, now = new Date()) {
  if (!isObj(calendar) || calendar.known !== true || !Array.isArray(calendar.events)) return calendar;
  if (!isObj(entries) || !Object.keys(entries).length) return calendar;

  const events = calendar.events.map((ev) => {
    const key = keyFor(ev);
    const hit = key ? entries[key] : null;
    if (!isObj(hit)) return ev;

    const startMs = toMs(ev.start);
    const endMs = toMs(ev.end);
    const atMs = toMs(hit.at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(atMs)) return ev;
    // Already over by the diary's own reckoning — nothing to override.
    if (endMs <= atMs) return ev;

    const effective = new Date(Math.max(startMs, Math.min(atMs, endMs)));
    return {
      ...ev,
      end: effective.toISOString(),
      // What the diary says, kept. Anything wanting the meeting's own shape —
      // rather than where Nick was — reads this.
      scheduledEnd: ev.end,
      finishedEarly: true,
    };
  });

  return { ...calendar, events };
}

// ── Store ───────────────────────────────────────────────────────────────────

function _db() {
  return require('../db/database');
}

/** Everything still live, pruned. Never throws — an unreadable store overrides nothing. */
function list(now = new Date()) {
  try {
    const raw = _db().getState(STATE_KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return prune(parsed, now);
  } catch (e) {
    console.warn('[MeetingFinish] could not read overrides:', e.message);
    return {};
  }
}

function _write(entries) {
  const keys = Object.keys(entries);
  // Oldest out first if it ever ran away. Entries are keyed by start time, so
  // this drops the meetings furthest in the past.
  const bounded = keys.length <= MAX_ENTRIES
    ? entries
    : Object.fromEntries(keys.sort().slice(-MAX_ENTRIES).map((k) => [k, entries[k]]));
  _db().setState(STATE_KEY, JSON.stringify(bounded));
  return bounded;
}

/**
 * Nick says he is out of this one.
 *
 * ⚠ REFUSES anything it cannot identify, anything already over, and anything
 * that is not a meeting NEURO would have gone quiet for in the first place —
 * `attendeesOther === true` is required, the same exact-true test
 * `context-state.isRealMeeting` makes, because releasing a state that was never
 * set is a button that appears to do something and does not.
 */
function finish(event, now = new Date()) {
  const key = keyFor(event);
  if (!key) return { ok: false, reason: 'unidentifiable' };
  if (!isObj(event) || event.attendeesOther !== true) return { ok: false, reason: 'not-a-meeting' };

  const startMs = toMs(event.start);
  const endMs = toMs(event.end);
  const nowMs = toMs(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'unreadable-times' };
  }
  if (nowMs < startMs) return { ok: false, reason: 'not-started' };
  if (nowMs >= endMs) return { ok: false, reason: 'already-over' };

  const entries = prune(list(now), now);
  entries[key] = {
    at: new Date(nowMs).toISOString(),
    scheduledEnd: new Date(endMs).toISOString(),
    subject: typeof event.subject === 'string' ? event.subject.trim() : null,
  };
  try {
    _write(entries);
  } catch (e) {
    console.warn('[MeetingFinish] could not store override:', e.message);
    return { ok: false, reason: 'store-failed' };
  }
  return { ok: true, key, entry: entries[key] };
}

/** The way back. Silent about a key that was not there — it is already resumed. */
function resume(key, now = new Date()) {
  const entries = prune(list(now), now);
  const had = Object.prototype.hasOwnProperty.call(entries, key);
  if (had) delete entries[key];
  try {
    _write(entries);
  } catch (e) {
    console.warn('[MeetingFinish] could not clear override:', e.message);
    return { ok: false, reason: 'store-failed' };
  }
  return { ok: true, cleared: had };
}

module.exports = {
  keyFor,
  prune,
  applyTo,
  list,
  finish,
  resume,
  STATE_KEY,
  MAX_ENTRIES,
};
