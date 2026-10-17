'use strict';

// "Warm this room until I leave" (17 Oct 2026).
//
// Nick, 17 Oct 2026: "when I'm in a room that is below comfort — give me a
// mechanism to turn the heating on in that room". The design he agreed:
//
//   1. ACCEPT (his tap, nothing else) puts the room's radiator into `heat` at
//      20°C. BEFORE writing, NEURO records what the radiator was doing (hvac
//      mode, target, preset), and after writing it READS THE RADIATOR BACK so
//      "Home Assistant took it" and "the radiator now says 20" stay different
//      facts.
//   2. ON LEAVING the room, NEURO puts the radiator back the way it found it —
//      UNLESS someone else is home (the household sensor), in which case the
//      restore is HELD and done when the house empties.
//   3. If anyone changed that radiator after NEURO did (its mode or target is no
//      longer what NEURO set), the restore is DROPPED. A later human change is
//      never overwritten — the restore is a consequence of HIS tap, and a tap
//      ten minutes ago does not outrank Helen turning the dial just now.
//   4. Every pending restore is PERSISTED (agent_state), so a backend restart —
//      several a day on deploys — cannot strand a radiator at 20°C for ever.
//   5. Every raise, restore, hold and drop is a line in Activity.
//
// ⚠ NOTHING HERE STARTS ON ITS OWN. `raise()` has exactly one caller —
//   rooms.act(), behind POST /api/rooms/:key/accept, which is an attended press.
//   The restore is unattended, which is exactly why it carries the household
//   gate (`room-offers.householdPermitsActing`, failing CLOSED) and the
//   changed-since guard.
//
// ⚠ "LEFT" NEEDS EVIDENCE. Presence tracks the WATCH, and the bedroom sensor
//   has gone deaf for days at a time (PowerGenie / iAware, Oct 2026). A blind
//   spell is not him walking out, so a restore fires only when he is
//   POSITIVELY in another room, or has not been seen in ANY room for
//   LEFT_UNSEEN_MS (15 min). Shorter blind spells wait — the cost of waiting is
//   a warm room for a few more minutes; the cost of guessing is the heat going
//   off while he sits in it.
//
// PURE where it judges (`planRestore`, `describeState`); the rest reads and
// writes through `ha-rooms`' named doors only.

const db = require('../db/database');
const haRooms = require('./ha-rooms');
const offersLib = require('./room-offers');

const HOLDS_KEY = 'room_heat_holds';
const HISTORY_KEY = 'room_heat_history';
const MAX_HISTORY = 50;
const LEFT_UNSEEN_MS = 15 * 60 * 1000;

// ── Store ────────────────────────────────────────────────────────────────────

function _load(key) {
  try {
    const raw = db.getState(key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : (key === HISTORY_KEY ? [] : {});
  } catch {
    // ⚠ Unreadable is NOT empty: an empty holds map would forget a radiator
    // NEURO owes a restore. Callers treat null as "do nothing this pass".
    return null;
  }
}

function _save(key, value) {
  db.setState(key, JSON.stringify(value));
}

function holds() {
  const h = _load(HOLDS_KEY);
  return h === null ? null : h;
}

function history() {
  const h = _load(HISTORY_KEY);
  return Array.isArray(h) ? h : [];
}

function _finish(hold, outcome) {
  const list = history();
  list.unshift({ ...hold, finished: outcome });
  _save(HISTORY_KEY, list.slice(0, MAX_HISTORY));
}

// One operation at a time. The sweep and an accept can overlap (a cron tick
// and a tap), and both read-modify-write the holds map around awaited HA
// calls — serialising them is what stops one silently undoing the other.
let _chain = Promise.resolve();
function _serial(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

function _log(kind, hold, detail = {}, now = Date.now()) {
  try {
    require('./personal-obligations').logEvent(kind, {
      subjectId: 'room:' + hold.room,
      actor: kind === 'room-heat-raised' || kind === 'room-heat-raise-failed' ? 'nick' : 'neuro',
      detail: { area: hold.area, entity: hold.entity, previous: hold.previous, setTo: hold.setTo, ...detail },
      dedupeKey: kind + ':' + hold.id + (detail.dedupe ? ':' + detail.dedupe : ''),
      now,
    });
  } catch (e) {
    console.warn('[room-heat] activity not recorded:', e.message);
  }
}

// ── Pure ─────────────────────────────────────────────────────────────────────

/** How a radiator state reads in a sentence: "off", "on its schedule", "set to 12°C". PURE. */
function describeState(s) {
  if (!s) return 'unknown';
  const mode = String(s.hvacMode || '').toLowerCase();
  const fmt = (c) => (Number.isInteger(c) ? String(c) : Number(c).toFixed(1)) + '°C';
  if (mode === 'off') return 'off';
  if (mode === 'auto') return 'on its schedule';
  if (typeof s.targetC === 'number') return 'set to ' + fmt(s.targetC);
  return mode || 'unknown';
}

/**
 * Should this hold be restored now? PURE.
 *
 * @param hold       the persisted hold
 * @param visit      { room, unseenSince } — room-episode's view (slug or null)
 * @param live       readClimate() result for the radiator
 * @param household  { known, othersHome, who }
 * @returns {{ action: 'wait'|'hold'|'drop'|'restore', why }}
 */
function planRestore(hold, { visit, live, household, now = Date.now(), leftUnseenMs = LEFT_UNSEEN_MS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const room = visit && visit.room ? visit.room : null;

  // 1. Still here → nothing to do. A NEW visit to the same room (he stepped
  //    out and came back) is still "here": he has not left it.
  if (room && room === hold.room) return { action: 'wait', why: 'still in the ' + hold.area.toLowerCase() };

  // 2. Has he LEFT? Positively elsewhere, or unseen everywhere long enough.
  if (!room) {
    const since = visit && Number.isFinite(visit.unseenSince) ? visit.unseenSince : null;
    if (since === null) return { action: 'wait', why: 'cannot tell where you are' };
    if (nowMs - since < leftUnseenMs) return { action: 'wait', why: 'not seen for ' + Math.round((nowMs - since) / 60000) + ' min — not sure you have left' };
  }

  // 3. The radiator must be readable — never restore, or drop, blind.
  if (!live || live.known !== true) return { action: 'wait', why: 'could not read the radiator' + (live && live.why ? ' (' + live.why + ')' : '') };

  // 4. ⚠ A LATER CHANGE WINS. If the radiator is no longer what NEURO set, a
  //    person (or the schedule) has taken it since — drop the restore.
  const set = hold.setTo || {};
  const modeNow = String(live.state || '').toLowerCase();
  if (modeNow !== set.hvacMode || live.targetC !== set.targetC) {
    return { action: 'drop', why: 'changed since NEURO set it — now ' + describeState({ hvacMode: modeNow, targetC: live.targetC }) };
  }

  // 5. The restore is unattended: never around someone else. Fails CLOSED.
  const may = offersLib.householdPermitsActing(household);
  if (!may.permitted) return { action: 'hold', why: may.why };

  return { action: 'restore', why: room ? 'you are in another room' : 'not seen in any room for a while' };
}

// ── Raise (the attended half) ────────────────────────────────────────────────

/**
 * Put the radiator into heat at the offer's target, recording what it was.
 * ONLY called by rooms.act() for a re-derived `warm-room` offer.
 *
 * @returns {{ ok, reason, verified, previous, setTo }}
 */
function raise({ offer, room, episode, offerKey, now = new Date() }) {
  return _serial(async () => {
    const entity = offer && offer.action && offer.action.entity;
    const toC = offer && offer.action && offer.action.toC;
    if (!entity || typeof toC !== 'number') return { ok: false, reason: 'the offer carries no radiator action', verified: false };

    const map = holds();
    if (map === null) return { ok: false, reason: 'could not read the restore list — nothing was changed, so nothing can be stranded', verified: false };

    // The state BEFORE, read fresh — never the offer's copy, which may be
    // a poll old.
    const before = await haRooms.readClimate(entity);
    if (!before.known) return { ok: false, reason: 'could not read the radiator before changing it (' + before.why + ') — nothing was changed', verified: false };

    // ⚠ A raise on a radiator NEURO already holds keeps the ORIGINAL "before".
    //   Recording our own 20°C as the previous state would make the restore a
    //   no-op and strand the room warm.
    const existing = map[entity];
    const previous = existing && existing.previous
      ? existing.previous
      : { hvacMode: before.state, targetC: before.targetC, presetMode: before.presetMode };

    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const hold = {
      id: (existing && existing.id) || entity + '@' + nowMs,
      entity,
      area: offer.area,
      room,
      episode,
      offerKey,
      raisedAt: new Date(nowMs).toISOString(),
      previous,
      setTo: { hvacMode: 'heat', targetC: toC },
      status: 'raising',
      verified: false,
    };
    // ⚠ PERSISTED BEFORE THE FIRST WRITE. A crash between the HA call and the
    //   save must leave a restore NEURO owes, not a radiator nobody remembers.
    map[entity] = hold;
    _save(HOLDS_KEY, map);

    let modeChanged = false;
    if (String(before.state).toLowerCase() !== 'heat') {
      const m = await haRooms.setHvacMode(entity, 'heat');
      if (!m.ok) {
        delete map[entity];
        _save(HOLDS_KEY, map);
        const outcome = { ok: false, reason: 'Home Assistant refused to switch it to heat: ' + m.reason, verified: false };
        _log('room-heat-raise-failed', hold, { reason: outcome.reason }, nowMs);
        return { ...outcome, previous, setTo: null };
      }
      modeChanged = true;
    }

    const t = await haRooms.setClimateTarget(entity, toC);
    if (!t.ok) {
      if (modeChanged) {
        // Mode moved, target did not. Keep the hold so leaving puts the mode
        // back, and say exactly that.
        hold.setTo = { hvacMode: 'heat', targetC: before.targetC };
        hold.status = 'active';
        map[entity] = hold;
        _save(HOLDS_KEY, map);
      } else {
        delete map[entity];
        _save(HOLDS_KEY, map);
      }
      const outcome = { ok: false, reason: 'Home Assistant refused the temperature: ' + t.reason + (modeChanged ? ' (it was switched to heat, which goes back when you leave)' : ' — nothing was changed'), verified: false };
      _log('room-heat-raise-failed', hold, { reason: outcome.reason }, nowMs);
      return { ...outcome, previous, setTo: modeChanged ? hold.setTo : null };
    }

    // Read back. ⚠ "HA accepted" is transport, "the radiator says 20" is the
    // fact; they are reported apart.
    const after = await haRooms.readClimate(entity);
    const verified = after.known === true && String(after.state).toLowerCase() === 'heat' && after.targetC === toC;
    hold.status = 'active';
    hold.verified = verified;
    map[entity] = hold;
    _save(HOLDS_KEY, map);
    const reason = verified ? null : after.known
      ? 'Home Assistant took it, but the radiator still reads ' + describeState({ hvacMode: after.state, targetC: after.targetC }) + ' — it may not have caught up yet'
      : 'Home Assistant took it, but the radiator could not be read back (' + after.why + ')';
    _log('room-heat-raised', hold, { verified, reason }, nowMs);
    return { ok: true, reason, verified, previous, setTo: hold.setTo };
  });
}

// ── Restore (the unattended half, consequence of the tap) ────────────────────

async function _restoreOne(hold) {
  const prev = hold.previous || {};
  const mode = String(prev.hvacMode || '').toLowerCase();
  const steps = [];
  if (!['heat', 'auto', 'off'].includes(mode)) {
    return { ok: false, reason: 'the recorded previous mode "' + prev.hvacMode + '" is not one NEURO can put back', steps };
  }
  if (mode !== 'heat') {
    // `auto` hands it back to the schedule, which sets its own target —
    // re-sending the old target would override the schedule's current slot.
    const r = await haRooms.setHvacMode(hold.entity, mode);
    steps.push({ step: 'mode ' + mode, ok: r.ok, reason: r.reason || null });
    if (!r.ok) return { ok: false, reason: r.reason, steps };
  } else if (typeof prev.targetC === 'number' && prev.targetC !== hold.setTo.targetC) {
    const r = await haRooms.setClimateTarget(hold.entity, prev.targetC);
    steps.push({ step: 'target ' + prev.targetC, ok: r.ok, reason: r.reason || null });
    if (!r.ok) return { ok: false, reason: r.reason, steps };
  }
  const after = await haRooms.readClimate(hold.entity);
  const verified = after.known === true && String(after.state).toLowerCase() === mode
    && (mode !== 'heat' || typeof prev.targetC !== 'number' || after.targetC === prev.targetC);
  return { ok: true, verified, steps, reason: verified ? null : 'Home Assistant took it; the radiator has not confirmed yet' };
}

/**
 * One pass over every pending restore. Called by rooms.sweepHolds() with the
 * visit it just advanced and the house it just read. Never throws.
 *
 * @returns {{ checked, restored, held, dropped, failed, waiting, results }}
 */
function sweep({ visit, household, now = new Date() } = {}) {
  return _serial(async () => {
    const out = { checked: 0, restored: 0, held: 0, dropped: 0, failed: 0, waiting: 0, results: [] };
    const map = holds();
    if (map === null) { out.error = 'could not read the restore list'; return out; }
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    for (const entity of Object.keys(map)) {
      const hold = map[entity];
      if (!hold || hold.status === 'raising') continue; // a raise is mid-flight
      out.checked++;
      let live;
      try { live = await haRooms.readClimate(entity); } catch (e) { live = { known: false, why: e.message }; }

      // A raise not yet confirmed is confirmed the first time the radiator
      // reads what NEURO set.
      if (!hold.verified && live.known && String(live.state).toLowerCase() === hold.setTo.hvacMode && live.targetC === hold.setTo.targetC) {
        hold.verified = true;
      }

      const plan = planRestore(hold, { visit, live, household, now: nowMs });
      out.results.push({ entity, area: hold.area, action: plan.action, why: plan.why });

      if (plan.action === 'wait') { out.waiting++; continue; }
      if (plan.action === 'hold') {
        out.held++;
        if (hold.status !== 'held') {
          hold.status = 'held';
          hold.heldSince = new Date(nowMs).toISOString();
          hold.heldWhy = plan.why;
          _log('room-heat-restore-held', hold, { why: plan.why }, nowMs);
        }
        continue;
      }
      if (plan.action === 'drop') {
        out.dropped++;
        delete map[entity];
        _finish(hold, { action: 'dropped', why: plan.why, at: new Date(nowMs).toISOString() });
        _log('room-heat-restore-dropped', hold, { why: plan.why }, nowMs);
        continue;
      }
      // restore
      let r;
      try { r = await _restoreOne(hold); } catch (e) { r = { ok: false, reason: e.message }; }
      if (r.ok) {
        out.restored++;
        delete map[entity];
        _finish(hold, { action: 'restored', why: plan.why, verified: r.verified, at: new Date(nowMs).toISOString() });
        _log('room-heat-restored', hold, { why: plan.why, verified: r.verified, reason: r.reason }, nowMs);
      } else {
        // ⚠ A failed restore KEEPS the hold and tries again next pass — the
        //   radiator is still at 20 and NEURO still owes putting it back. Logged
        //   once per distinct reason, not every minute.
        out.failed++;
        hold.lastError = r.reason;
        _log('room-heat-restore-failed', hold, { reason: r.reason, dedupe: String(r.reason).slice(0, 60) }, nowMs);
      }
    }
    _save(HOLDS_KEY, map);
    return out;
  });
}

/** Active holds as a screen needs them: "Warming the living room to 20°C until you leave". PURE over the map. */
function active(map = holds()) {
  if (!map) return [];
  return Object.values(map).filter(Boolean).map((h) => ({
    entity: h.entity,
    area: h.area,
    room: h.room,
    toC: h.setTo && h.setTo.targetC,
    status: h.status,
    verified: !!h.verified,
    heldWhy: h.status === 'held' ? h.heldWhy || null : null,
    previous: h.previous,
    say: h.status === 'held'
      ? 'The ' + String(h.area).toLowerCase() + ' radiator stays at ' + h.setTo.targetC + '°C for now — ' + (h.heldWhy || 'someone else is home') + '. It goes back to ' + describeState(h.previous) + ' when the house is empty.'
      : 'Warming the ' + String(h.area).toLowerCase() + ' to ' + h.setTo.targetC + '°C until you leave — then back to ' + describeState(h.previous) + '.',
  }));
}

module.exports = {
  raise,
  sweep,
  active,
  holds,
  history,
  planRestore,
  describeState,
  HOLDS_KEY,
  HISTORY_KEY,
  LEFT_UNSEEN_MS,
};
