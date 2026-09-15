'use strict';

// SAiM in a room: read, judge, offer, remember, act (12 Sep 2026).
//
// The composer. `ha-rooms` reads, `room-offers` judges, `room-episode` decides
// what counts as one visit, and this file joins them, remembers what Nick said,
// and is the ONLY thing that performs an action on the house.
//
// ⚠ IT RIDES BESIDE THE POOL, IT DOES NOT JOIN IT. `decision-engine` stays the
//   one place something becomes worth surfacing and `attention.gate()` the one
//   place it is filtered. A room offer is a fact about RIGHT NOW rather than a
//   thing to decide about later, so it must never compete with a breaching
//   escalation for the primary slot — the same call `ambient.js` makes, for the
//   same reason. This adds no candidates and re-ranks nothing.
//
// ⚠ THE CLIENT SENDS A KEY AND NOTHING ELSE. Acting re-reads the house and
//   re-derives the offer server-side; the entity ids in the request are
//   ignored, because a client that can name entities is a client that can turn
//   on anything in the house. The key is checked against a freshly computed
//   offer, so an offer that has stopped being true cannot be executed late.
//
// ⚠ AN OFFER IS ASKED ONCE PER VISIT. The key is scoped to the episode, so a
//   decline means "not this time" and the next visit mints a new key and is a
//   fair question again. That is Nick's spec, and it is why no separate
//   expiry is needed.
//
// ⚠ DECISIONS ARE THE TRAINING SET. Every yes and no is stored WITH the context
//   that produced it — how far off sunset, what the lights were doing, the room
//   temperature. That is what eventually promotes lights from asking to acting,
//   and it is the reason this asks at all rather than guessing from day one.

const db = require('../db/database');
const haRooms = require('./ha-rooms');
const offers = require('./room-offers');
const episode = require('./room-episode');

const EPISODE_KEY = 'room_episode_state';
const DECISIONS_KEY = 'room_offer_decisions';

// Keep the decision log bounded. Keys are visit-scoped so they are never reused;
// this is a rolling record for learning, not a permanent store.
const MAX_DECISIONS = 400;

// The house is read on every attention poll and several surfaces poll. HA is on
// localhost so the read is cheap, but there is no reason to do it four times in
// four seconds. Short enough that presence changes are still seen well inside
// the 45s wobble window.
const READ_CACHE_MS = process.env.ROOMS_READ_CACHE_MS !== undefined
  ? Number(process.env.ROOMS_READ_CACHE_MS)
  : 10_000;

let _cache = { at: 0, house: null };

function _loadDecisions() {
  try {
    const raw = db.getState(DECISIONS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    // ⚠ Unreadable is NOT empty. Returning {} would re-offer everything he has
    // already declined this visit, which is precisely the nagging this avoids.
    return null;
  }
}

function _saveDecisions(map) {
  const keys = Object.keys(map);
  if (keys.length > MAX_DECISIONS) {
    keys
      .sort((a, b) => (map[a].at || '').localeCompare(map[b].at || ''))
      .slice(0, keys.length - MAX_DECISIONS)
      .forEach(k => delete map[k]);
  }
  try {
    db.setState(DECISIONS_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[rooms] could not save decisions:', e.message);
  }
}

async function _readHouse(now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  if (_cache.house && nowMs - _cache.at < READ_CACHE_MS) return _cache.house;
  const house = await haRooms.readHouse();
  _cache = { at: nowMs, house };
  return house;
}

function _advanceEpisode(presence, now) {
  let prev = null;
  try {
    const raw = db.getState(EPISODE_KEY);
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }
  const r = episode.advance(prev, presence, now);
  try {
    db.setState(EPISODE_KEY, JSON.stringify(r.state));
  } catch (e) {
    console.warn('[rooms] could not persist episode:', e.message);
  }
  return r;
}

/**
 * What SAiM would say about the room Nick is in, right now.
 *
 * @returns {{ known, room, episode, offers, decided, gaps, considered }}
 */
async function snapshot({ now = new Date() } = {}) {
  const house = await _readHouse(now);
  const gaps = [...(house.gaps || [])];

  const visit = _advanceEpisode(house.presence, now);

  if (!house.known) {
    return { known: false, room: null, episode: null, offers: [], decided: [], household: house.household || null, gaps, considered: [] };
  }

  const judged = offers.assess({
    rooms: house.rooms,
    presence: house.presence,
    sun: house.sun,
    // ⚠ Without this the gate sits permanently CLOSED — safe, and indistinguishable
    // from being wired. Caught live, not by the unit tests, because `assess()` is
    // pure and its own suite supplies the household itself.
    household: house.household,
    now,
    gaps,
  });

  const decisions = _loadDecisions();
  if (decisions === null) {
    // ⚠ Fails CLOSED, unlike the attention gate. There, hiding work on a failed
    // read is the expensive direction; here the failure mode is SAiM asking the
    // same question repeatedly, and an unreadable memory is exactly the state in
    // which she cannot know she has already asked.
    return {
      known: true,
      room: visit.room,
      episode: visit.episode,
      offers: [],
      decided: [],
      household: house.household,
      gaps: [...judged.gaps, 'could not read what you have already answered — holding off rather than asking again'],
      considered: judged.considered,
    };
  }

  const open = [];
  const decided = [];
  for (const o of judged.offers) {
    const key = episode.keyFor(o.key, visit.episode);
    const prior = decisions[key];
    if (prior) {
      decided.push({ key, kind: o.kind, area: o.area, decision: prior.decision, at: prior.at });
      continue;
    }
    open.push({ ...o, key });
  }

  return {
    known: true,
    room: visit.room,
    episode: visit.episode,
    offers: open,
    decided,
    household: house.household,
    gaps: judged.gaps,
    considered: judged.considered,
  };
}

/**
 * Record what Nick said, with the context that produced the offer.
 *
 * `decision` is 'accepted' or 'declined'. Anything else is REFUSED rather than
 * stored as a shrug — an unrecognised answer and "no" are different facts, and
 * the second is the one that teaches.
 */
function record(key, decision, context = null) {
  if (decision !== 'accepted' && decision !== 'declined') {
    return { ok: false, reason: 'decision must be accepted or declined' };
  }
  const map = _loadDecisions();
  if (map === null) return { ok: false, reason: 'could not read the decision log' };
  map[key] = { decision, at: new Date().toISOString(), context: context || null };
  _saveDecisions(map);
  return { ok: true, key, decision };
}

/**
 * Do the thing. The ONLY path from a request to a change in the house.
 *
 * ⚠ The offer is re-derived from a FRESH read and matched on key. So: an offer
 * that is no longer true cannot be executed (the lights went on some other way,
 * he left the room, dawn arrived), and nothing a client names can be acted on
 * unless SAiM independently decided to offer it.
 */
async function act(key, { now = new Date() } = {}) {
  _cache = { at: 0, house: null }; // never act on a cached view of the house
  const snap = await snapshot({ now });
  if (!snap.known) return { ok: false, reason: 'could not read the house' };

  const offer = snap.offers.find(o => o.key === key);
  if (!offer) {
    const already = snap.decided.find(d => d.key === key);
    if (already) return { ok: false, reason: 'already answered (' + already.decision + ')' };
    return { ok: false, reason: 'that offer is no longer on the table' };
  }

  let result;
  if (offer.kind === 'lights-on') {
    result = await haRooms.turnOnLights(offer.entities);
  } else if (offer.kind === 'warm-room') {
    result = await haRooms.setClimateTarget(offer.entities[0], offer.targetC);
  } else {
    // ⚠ A kind with no executor is REFUSED locally, never passed through.
    return { ok: false, reason: 'no executor for "' + offer.kind + '"' };
  }

  // Recorded whether or not the house obeyed: he said yes, and that is the
  // signal worth learning from. The failure is reported separately.
  record(key, 'accepted', {
    kind: offer.kind,
    area: offer.area,
    why: offer.why,
    currentC: offer.currentC ?? null,
    subject: offer.subject,
  });

  return { ok: result.ok, reason: result.reason || null, offer: { kind: offer.kind, area: offer.area }, result };
}

/** Say no. Records the decline against this visit; the next visit may ask again. */
async function decline(key, { now = new Date() } = {}) {
  const snap = await snapshot({ now });
  const offer = snap.offers.find(o => o.key === key);
  return record(key, 'declined', offer ? { kind: offer.kind, area: offer.area, why: offer.why } : null);
}

/** Everything Nick has answered, newest first — the learning set. */
function history(limit = 50) {
  const map = _loadDecisions();
  if (map === null) return { ok: false, reason: 'could not read the decision log', entries: [] };
  const entries = Object.entries(map)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
  return { ok: true, entries, total: Object.keys(map).length };
}

module.exports = {
  snapshot,
  act,
  decline,
  record,
  history,
  EPISODE_KEY,
  DECISIONS_KEY,
  MAX_DECISIONS,
};
