'use strict';

/**
 * The music play log (16 Oct 2026). Nick: "keep a log for 24 hrs - after that
 * only keep stuff I've interacted with."
 *
 * One row per track START, from either device. A re-report of the same track
 * (the laptop's 10-minute heartbeat, the phone re-sending on wake, a pause and
 * resume) extends the row instead of adding one: a play is the same song,
 * from the same device, reported again within FRESH_MS of its last report.
 *
 * KEPT = something Nick SAID about its song, album or artist: a rating
 * (love / like / just background / not for me), "more like this", "not mine"
 * or "don't use for suggestions". Listening on its own never keeps a row.
 * Clearing the rating lets the row go on the next prune. Ratings live in
 * leisure_items (source_ref = the observation key), so there is no second
 * store of what he said.
 *
 * READS WRITE NOTHING: list() hides expired unrated rows itself; only
 * record() (each report) and prune() (each report + the personal-ops pass)
 * delete.
 */

const M = require('./leisure-model');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;   // same as now-playing: a report older than this is not "still playing"
const LIST_LIMIT = 300;

function _db() { return require('../db/database'); }

// The one SQL test for "Nick said something about this", shared by prune and
// list so the two cannot disagree about what survives. `t` is the play table alias.
const interacted = (t) => `EXISTS (SELECT 1 FROM leisure_items i
  WHERE i.source_ref IN (${t}.track_key, ${t}.album_key, ${t}.artist_key)
    AND (i.preference IS NOT NULL OR i.want_more = 1 OR i.ownership <> 'nick' OR i.not_basis = 1))`;

function _keys(item) {
  const by = Object.fromEntries(M.musicKeys(item).map((k) => [k.kind, k.key]));
  return { track: by.music_track || null, album: by.album || null, artist: by.artist || null };
}

/** Log a now-playing report. Only a playing report with a title and an artist is a play. */
function record(item, source) {
  if (!item || item.state !== 'playing' || !item.title || !item.artist) return { logged: false };
  const k = _keys(item);
  const at = Date.parse(item.at);
  if (!k.track || !k.artist || !Number.isFinite(at)) return { logged: false };
  const db = _db();
  const last = db.get('SELECT * FROM music_plays WHERE source = ? ORDER BY played_at DESC LIMIT 1', [source]);
  if (last && last.track_key === k.track) {
    const lastAt = Date.parse(last.last_reported_at);
    if (at <= lastAt) return { logged: false, why: 'already covered' };   // a retry or a late copy
    if (at - lastAt <= FRESH_MS) {
      db.run('UPDATE music_plays SET last_reported_at = ? WHERE id = ?', [item.at, last.id]);
      return { logged: true, extended: last.id };
    }
  }
  db.run(`INSERT OR IGNORE INTO music_plays (source, app, title, artist, album, track_key, album_key, artist_key, played_at, last_reported_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [source, item.app || null, item.title, item.artist, item.album || null, k.track, k.album, k.artist, item.at, item.at]);
  return { logged: true };
}

/** Delete plays older than 24 hours that Nick has said nothing about. */
function prune({ now = Date.now() } = {}) {
  const cutoff = new Date(now - WINDOW_MS).toISOString();
  const r = _db().run(`DELETE FROM music_plays WHERE played_at < ? AND NOT ${interacted('music_plays')}`, [cutoff]);
  return { deleted: r && typeof r.changes === 'number' ? r.changes : null };
}

const RATING = { loved: 'love', liked: 'like', neutral: 'background', disliked: 'not-for-me', 'not-for-me': 'not-for-me' };

/** The last 24 hours, newest first, plus older plays kept because Nick said something about them. */
function list({ now = Date.now() } = {}) {
  const db = _db();
  const cutoff = new Date(now - WINDOW_MS).toISOString();
  const rows = db.all(`SELECT p.*, (${interacted('p')}) AS kept FROM music_plays p
    WHERE p.played_at >= ? OR ${interacted('p')} ORDER BY p.played_at DESC LIMIT ?`, [cutoff, LIST_LIMIT]);
  const prefs = new Map();
  const prefOf = (key) => {
    if (!key) return null;
    if (!prefs.has(key)) { const r = db.get('SELECT preference FROM leisure_items WHERE source_ref = ?', [key]); prefs.set(key, r ? r.preference : null); }
    return prefs.get(key);
  };
  const out = rows.map((r) => {
    const rated = ['track', 'album', 'artist'].filter((lvl) => prefOf(r[`${lvl}_key`]));
    return {
      id: r.id, source: r.source, app: r.app, title: r.title, artist: r.artist, album: r.album,
      ref: r.track_key, playedAt: r.played_at, lastReportedAt: r.last_reported_at,
      rating: RATING[prefOf(r.track_key)] || null,
      // Which level Nick rated: 'track' | 'album' | 'artist'; ['said'] = another correction (not mine, more like this).
      keptBecause: rated.length ? rated : (r.kept ? ['said'] : []),
    };
  });
  return {
    windowHours: 24,
    last24h: out.filter((r) => r.playedAt >= cutoff),
    kept: out.filter((r) => r.playedAt < cutoff),
    rule: 'Every song is logged for 24 hours. After that it is kept only if you rated the song, its album or its artist.',
  };
}

module.exports = { WINDOW_MS, record, prune, list };
