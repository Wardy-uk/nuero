'use strict';

// Greetings waiting for a room's sensor to collect them — the study tablet's sensor
// app picks its greeting up from the reply to its next reading and speaks it with
// Android's own text-to-speech.
//
// In memory and short-lived on purpose: a greeting is about an arrival that just
// happened. One the tablet did not collect within the minute is about a moment that
// has passed, and speaking it late is worse than not speaking it. Nothing here is a
// store — sara/backend stores nothing.

const MAX_AGE_MS = 60 * 1000;
const pending = new Map();
let counter = 0;

function put(room, text, now = Date.now()) {
  counter += 1;
  const g = { id: `${now}-${counter}`, text, at: now };
  pending.set(room, g);
  return g;
}

/** Hand over (and forget) the greeting for this room, if one is still fresh. */
function take(room, now = Date.now()) {
  const g = pending.get(room);
  if (!g) return null;
  pending.delete(room);
  return now - g.at <= MAX_AGE_MS ? { id: g.id, text: g.text } : null;
}

function reset() { pending.clear(); }

module.exports = { put, take, reset, MAX_AGE_MS };
