'use strict';

/**
 * What Nick is listening to (5 Oct 2026). Sent by NEURO's iOS app, which can
 * only see the system Music app (Apple Music and the library) — Spotify,
 * podcasts and anything else are invisible to it, so "nothing playing" from
 * the phone means "nothing the Music app is playing", never "silence".
 *
 * One record, the newest, in agent_state: this is a right-now fact, not a
 * history. It is shown only while it is current — `playing`, and reported in
 * the last FRESH_MS — because the app reports when it wakes, not continuously,
 * and an old "playing" would describe a song that ended an hour ago.
 */

const db = require('../db/database');

const KEY = 'now_playing';
const FRESH_MS = 15 * 60 * 1000;
const STATES = Object.freeze(['playing', 'paused', 'stopped']);
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/** Validate and store a report. An older report never replaces a newer one. */
function record(body = {}, { now = Date.now() } = {}) {
  const state = STATES.includes(body.state) ? body.state : null;
  if (!state) return { ok: false, error: `state must be one of ${STATES.join(', ')}` };
  const at = Date.parse(body.at);
  if (!Number.isFinite(at) || at > now + 5 * 60 * 1000) return { ok: false, error: 'at must be an ISO time, not in the future' };
  const item = {
    state,
    title: clip(body.title, 200),
    artist: clip(body.artist, 200),
    album: clip(body.album, 200),
    app: clip(body.app, 40) || 'Music',
    client: clip(body.client, 20),
    at: new Date(at).toISOString(),
  };
  let held = null;
  try { held = JSON.parse(db.getState(KEY) || 'null'); } catch { held = null; }
  if (held && Date.parse(held.at) > at) return { ok: true, stored: false, reason: 'an equal or newer report is already held' };
  db.setState(KEY, JSON.stringify(item));
  // Build 30: a PLAYING report adds its day to the artist/album aggregates.
  // Never allowed to fail the report; the track title is not kept there.
  try { require('./leisure').observeNowPlaying(item, { now }); } catch (e) { console.warn('[Leisure] now-playing not folded:', e.message); }
  return { ok: true, stored: true, item };
}

/** The current track, or null when nothing is known to be playing now. */
function current({ now = Date.now() } = {}) {
  let held = null;
  try { held = JSON.parse(db.getState(KEY) || 'null'); } catch { return null; }
  if (!held || held.state !== 'playing' || !held.title) return null;
  const age = now - Date.parse(held.at);
  if (!Number.isFinite(age) || age > FRESH_MS) return null;
  return { ...held, ageMinutes: Math.round(age / 60000) };
}

function latest() {
  try { return JSON.parse(db.getState(KEY) || 'null'); } catch { return null; }
}

module.exports = { KEY, FRESH_MS, STATES, record, current, latest };
