'use strict';

/**
 * "You might like" (13 Oct 2026) — artists Nick has not heard, found from the
 * ones he has. Build 30 had no catalogue, so its suggestions were continuations
 * only; this adds ONE outside source: Deezer's public API (no key, no account),
 * which answers "artists related to X" and gives each a top track with a 30 s
 * preview. Checked live from pi5 before building.
 *
 * Rules:
 *   • Seeds are what NEURO already believes, never re-judged here. Nick's
 *     rating sets the weight: LOVE 5, like 3, merely played a lot (`interest`)
 *     1. "Just background", disliked, not-mine and "don't use for suggestions"
 *     are never seeds. A loved song lends its artist the love weight.
 *   • Never suggest the familiar: anything already heard, or already an item
 *     (saved, liked, disliked) is out — and that is re-checked at READ time,
 *     so a "Not for me" pressed a minute ago removes it at once.
 *   • A seed is matched to Deezer by EXACT normalised name or not at all — the
 *     wrong "Phoenix" would make every suggestion about someone else.
 *   • Only ARTIST NAMES leave NEURO, and only on the refresh (≤ every 12 h,
 *     inside the personal-ops job). Reads write nothing and call nothing.
 *   • A failed refresh keeps the last good list and says it is stale; it never
 *     empties the panel. Nothing here notifies.
 */

const M = require('./leisure-model');

const KEY = 'leisure_discovery';
const REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;
const MAX_SEEDS = 8;
const SHOW = 6;
const API = 'https://api.deezer.com';

const _db = () => require('../db/database');
const _json = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

// ── pure ────────────────────────────────────────────────────────────────────

/** Seeds from observations + items, using Build 30's own affinity rule. */
function seedsFrom({ observations = [], items = [], today }) {
  const byRef = new Map(items.filter((i) => i.sourceRef).map((i) => [i.sourceRef, i]));
  const seeds = new Map();
  const add = (name, weight, why) => {
    const k = M.norm(name);
    if (!k) return;
    const held = seeds.get(k);
    if (!held) seeds.set(k, { name, weight, why: [why] });
    else { held.weight = Math.max(held.weight, weight); if (!held.why.includes(why)) held.why.push(why); }
  };
  for (const o of observations) {
    if (!['artist', 'album', 'music_track'].includes(o.kind)) continue;
    const explicit = byRef.get(o.ref) || null;
    if (explicit && explicit.notBasis) continue;
    const a = M.affinity({ explicit, days: o.days, today });
    const artist = o.kind === 'artist' ? o.title : o.creator;
    if (!artist) continue;
    const what = o.kind === 'artist' ? 'you' : `“${o.title}”`;
    const loved = explicit && explicit.preference === 'loved';
    if (a.state === 'strong_interest') add(artist, loved ? 5 : 3, o.kind === 'artist' ? (loved ? 'you love them' : 'you like them') : `you ${loved ? 'love' : 'like'} ${what}`);
    else if (a.state === 'interest' && M.onRepeat(o.days, today)) add(artist, 2, o.kind === 'artist' ? 'you keep playing them' : `you keep playing ${what}`);
    else if (a.state === 'interest') add(artist, 1, o.kind === 'artist' ? 'you play them a lot' : `you play ${what} a lot`);
  }
  // Things Nick added himself (not from listening) that he likes.
  for (const i of items) {
    if (i.sourceRef || i.notBasis || i.ownership !== 'nick') continue;
    if (!['liked', 'loved'].includes(i.preference) && !i.wantMore) continue;
    const w = i.preference === 'loved' ? 5 : 3;
    const verb = i.preference === 'loved' ? 'love' : 'like';
    if (i.kind === 'artist') add(i.title, w, `you ${verb} them`);
    else if (['album', 'music_track'].includes(i.kind) && i.creator) add(i.creator, w, `you ${verb} “${i.title}”`);
  }
  return [...seeds.values()].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)).slice(0, MAX_SEEDS);
}

/** Every artist name NEURO already knows Nick has met — never suggested. */
function knownArtists({ observations = [], items = [] }) {
  const k = new Set();
  for (const o of observations) {
    if (o.kind === 'artist') k.add(M.norm(o.title));
    else if (o.creator) k.add(M.norm(o.creator));
  }
  for (const i of items) {
    if (i.kind === 'artist') k.add(M.norm(i.title));
    else if (i.creator && ['album', 'music_track'].includes(i.kind)) k.add(M.norm(i.creator));
  }
  k.delete('');
  return k;
}

/**
 * Rank related artists across seeds. An artist related to several of Nick's is
 * a stronger suggestion than one related to a single seed; ties go to the more
 * widely followed (fewer obscure misses).
 */
function rank({ seeds = [], related = {}, known = new Set(), limit = SHOW * 2 }) {
  const out = new Map();
  for (const s of seeds) {
    for (const r of related[M.norm(s.name)] || []) {
      const k = M.norm(r.name);
      if (!k || known.has(k)) continue;
      const held = out.get(k) || { name: r.name, deezerId: r.id, link: r.link || null, picture: r.picture || null, fans: r.fans || 0, score: 0, because: [] };
      held.score += s.weight;
      if (!held.because.includes(s.name)) held.because.push(s.name);
      out.set(k, held);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score || b.fans - a.fans || a.name.localeCompare(b.name)).slice(0, limit);
}

const _and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "because you love M83 and listen to Dire Straits" — the loved ones named as loved. */
function becauseLine(because = [], seeds = []) {
  if (!because.length) return null;
  const loved = new Set(seeds.filter((s) => s.weight >= 5).map((s) => M.norm(s.name)));
  const shown = because.slice(0, 3);
  const rest = because.length - shown.length;
  const love = shown.filter((n) => loved.has(M.norm(n)));
  const other = shown.filter((n) => !loved.has(M.norm(n)));
  const parts = [];
  if (love.length) parts.push(`love ${_and(love)}`);
  if (other.length) parts.push(`listen to ${_and(other)}`);
  return `because you ${parts.join(' and ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

// ── io ──────────────────────────────────────────────────────────────────────

async function _get(fetchImpl, url) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Deezer answered ${r.status}`);
  const j = await r.json();
  if (j && j.error) throw new Error(`Deezer: ${j.error.message || j.error.type || 'error'}`);
  return j;
}

function _inputs() {
  const L = require('./leisure');
  const today = require('./world-model').localMinute(Date.now()).slice(0, 10);
  return { observations: L.listObservations(), items: L.listItems(), today };
}

function _held() { return _json(_db().getState(KEY), null); }

/**
 * Ask Deezer again. Throttled to REFRESH_EVERY_MS unless the seeds changed or
 * `force`. Never throws; a failure keeps the previous list.
 */
async function refresh({ now = Date.now(), force = false, fetchImpl = globalThis.fetch, inputs } = {}) {
  const db = _db();
  const prev = _held();
  let inp;
  try { inp = inputs || _inputs(); } catch (e) { return { ok: false, error: `could not read listening: ${e.message}` }; }
  const seeds = seedsFrom(inp);
  const fingerprint = seeds.map((s) => `${M.norm(s.name)}:${s.weight}`).join('|');
  if (!force && prev && prev.fingerprint === fingerprint && now - Date.parse(prev.asOf) < REFRESH_EVERY_MS) {
    return { ok: true, skipped: true, why: 'fresh' };
  }
  if (!seeds.length) {
    db.setState(KEY, JSON.stringify({ asOf: new Date(now).toISOString(), fingerprint, seeds: [], items: [], unmatched: [], lastError: null }));
    return { ok: true, seeds: 0, items: 0 };
  }
  try {
    const related = {}; const unmatched = [];
    for (const s of seeds) {
      const found = await _get(fetchImpl, `${API}/search/artist?q=${encodeURIComponent(s.name)}&limit=5`);
      const hit = (found.data || []).find((a) => M.norm(a.name) === M.norm(s.name));
      if (!hit) { unmatched.push(s.name); continue; }
      const rel = await _get(fetchImpl, `${API}/artist/${hit.id}/related?limit=15`);
      related[M.norm(s.name)] = (rel.data || []).map((a) => ({ id: a.id, name: a.name, link: a.link, picture: a.picture_medium || null, fans: a.nb_fan || 0 }));
    }
    const ranked = rank({ seeds, related, known: knownArtists(inp) });
    // A song to try for each — the top track and its 30-second preview.
    const items = [];
    for (const c of ranked) {
      let track = null;
      try {
        const top = await _get(fetchImpl, `${API}/artist/${c.deezerId}/top?limit=1`);
        const t = (top.data || [])[0];
        if (t) track = { title: t.title, link: t.link || null, preview: t.preview || null };
      } catch { track = null; }
      items.push({ ...c, track });
    }
    const out = { asOf: new Date(now).toISOString(), fingerprint, seeds: seeds.map((s) => ({ name: s.name, weight: s.weight, why: s.why })), items, unmatched, lastError: null };
    db.setState(KEY, JSON.stringify(out));
    return { ok: true, seeds: seeds.length, items: items.length, unmatched: unmatched.length };
  } catch (e) {
    const keep = prev ? { ...prev, lastError: e.message, lastErrorAt: new Date(now).toISOString() } : { asOf: null, fingerprint: null, seeds: [], items: [], unmatched: [], lastError: e.message, lastErrorAt: new Date(now).toISOString() };
    db.setState(KEY, JSON.stringify(keep));
    return { ok: false, error: e.message };
  }
}

/** What the card shows. Reads only; re-filters against what Nick has met since. */
function read({ now = Date.now(), inputs } = {}) {
  const held = _held();
  if (!held) return { known: false, why: 'not looked yet — NEURO asks Deezer within the next half hour', items: [], seeds: [] };
  let known = new Set();
  try { known = knownArtists(inputs || _inputs()); } catch { /* unread: show the stored list */ }
  const items = (held.items || []).filter((i) => !known.has(M.norm(i.name))).slice(0, SHOW)
    .map((i) => ({ name: i.name, link: i.link, picture: i.picture, because: i.because, why: becauseLine(i.because, held.seeds || []), track: i.track }));
  const ageMs = held.asOf ? now - Date.parse(held.asOf) : null;
  return {
    known: true, asOf: held.asOf, stale: !!held.lastError, lastError: held.lastError || null,
    ageHours: ageMs == null ? null : Math.round(ageMs / 3600000),
    seeds: held.seeds || [], unmatched: held.unmatched || [], items,
    source: 'Deezer — artist names only leave NEURO',
  };
}

module.exports = { KEY, REFRESH_EVERY_MS, SHOW, seedsFrom, knownArtists, rank, becauseLine, refresh, read };
