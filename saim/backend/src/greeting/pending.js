'use strict';

// Greetings waiting for a room's sensor to collect them — the study tablet's sensor
// app picks its greeting up from the reply to its next reading and speaks it with
// Android's own text-to-speech.
//
// In memory and short-lived on purpose: a greeting is about an arrival that just
// happened. One the tablet did not collect within the minute is about a moment that
// has passed, and speaking it late is worse than not speaking it. Nothing here is a
// store — saim/backend stores nothing.

const MAX_AGE_MS = 60 * 1000;
const CLIP_TTL_MS = 5 * 60 * 1000;
const pending = new Map();
// id -> { promise: Promise<Buffer|null>, at } — her natural-voice clip, rendered by
// NEURO the moment the greeting is queued, so it is usually ready by the time the
// tablet asks. In memory and short-lived, like the greeting itself.
const clips = new Map();
// id -> { room, ask, at } — what a greeting ASKED (22 Oct 2026). A "yes" or "no"
// heard straight after it answers THIS and nothing else, once, within ASK_TTL_MS.
const asks = new Map();
const ASK_TTL_MS = 2 * 60 * 1000;
let counter = 0;
let renderer = null;

/** Who renders a clip: `(text) => Promise<Buffer>`. Unset means "no clip". */
function setRenderer(fn) { renderer = typeof fn === 'function' ? fn : null; }

function put(room, text, now = Date.now(), ask = null) {
  counter += 1;
  const g = { id: `${now}-${counter}`, text, at: now, listen: Boolean(ask) };
  pending.set(room, g);
  for (const [id, a] of asks) if (now - a.at > ASK_TTL_MS) asks.delete(id);
  if (ask) asks.set(g.id, { room, ask, at: now });
  // ⚠ Nick, 2 Oct 2026: Android's own voice was "so unnatural that it was
  // annoying". Render her real voice up front; a failure resolves to null and
  // the tablet falls back to its own voice, never to silence.
  if (renderer) {
    for (const [id, c] of clips) if (now - c.at > CLIP_TTL_MS) clips.delete(id);
    clips.set(g.id, { at: now, promise: Promise.resolve().then(() => renderer(text)).catch(() => null) });
  }
  return g;
}

/** Hand over (and forget) the greeting for this room, if one is still fresh. */
function take(room, now = Date.now()) {
  const g = pending.get(room);
  if (!g) return null;
  pending.delete(room);
  if (now - g.at > MAX_AGE_MS) return null;
  const out = { id: g.id, text: g.text };
  // The tablet listens after speaking ONLY when the greeting asked something.
  if (g.listen) out.listen = true;
  if (clips.has(g.id)) out.audio = `/api/presence/greeting-audio/${encodeURIComponent(g.id)}`;
  return out;
}

/** The clip for an id, or null if there is none (or it failed). */
async function clip(id) {
  const c = clips.get(String(id));
  if (!c) return null;
  return c.promise;
}

/**
 * Spend the question a greeting asked: returns { room, ask } once, for the room that
 * heard it, inside ASK_TTL_MS. A second answer, a stale one or one from another
 * room's sensor gets null — never acted on twice, never late.
 */
function answer(id, room, now = Date.now()) {
  const a = asks.get(String(id));
  if (!a) return null;
  if (a.room !== room) return null;
  asks.delete(String(id));
  if (now - a.at > ASK_TTL_MS) return null;
  return { room: a.room, ask: a.ask };
}

/** Is there an unspent question for this greeting, from this room? Does not spend it. */
function hasAsk(id, room, now = Date.now()) {
  const a = asks.get(String(id));
  return Boolean(a && a.room === room && now - a.at <= ASK_TTL_MS);
}

function reset() { pending.clear(); clips.clear(); asks.clear(); }

module.exports = { put, take, clip, answer, hasAsk, setRenderer, reset, MAX_AGE_MS, ASK_TTL_MS };
