'use strict';

/**
 * SAiM greets Nick when he walks into a room that can speak.
 *
 * Nick, 11 Sep 2026. This half DETECTS the arrival and DELIVERS the words; NEURO
 * (`POST /api/greeting`) decides whether to speak and what to say, so the HomePod
 * and the study tablet cannot phrase it two ways or keep two cooldowns.
 *
 * ⚠ AN ARRIVAL IS A SURE ROOM THAT HAS HELD. The fingerprint's `sure` room, unchanged
 * for ARRIVAL_MS — walking through the kitchen to the garden is not arriving in the
 * kitchen. It reuses the display route's own pure pieces (resolveRoom, classify,
 * sustainedClock) rather than a second idea of where he is, but keeps its OWN clock
 * state: it runs on a timer, and the display route only runs when a screen polls.
 *
 * ⚠ NO GREETING FOR A RESTART. The first sure room after boot is where he already
 * was, not somewhere he walked into — so anything that becomes an arrival inside
 * WARMUP_MS is marked as seen and never spoken. The backend restarts on deploys.
 *
 * ⚠ ONLY ROOMS THAT CAN SPEAK, and only the ones configured. `SAIM_GREET_SPEAKERS`
 * unset means the greeter never starts — a voice in the house is opt-in per room:
 *   SAIM_GREET_SPEAKERS="living-room=ha:media_player.living_room,study=sensor"
 *   - `ha:<media_player>` speaks through Home Assistant's tts.speak (the HomePod,
 *     over the Apple TV integration) using SAIM_GREET_TTS_ENTITY (default tts.piper)
 *   - `sensor` hands the words to that room's sensor app to speak itself
 *
 * Every refusal is LOGGED with NEURO's reason: a greeting that silently never comes
 * is indistinguishable from a broken one.
 */

const store = require('../presence/store');
const profiles = require('../presence/profiles');
const { classify } = require('../presence/fingerprint');
const { resolveRoom } = require('../presence/rooms');
const presence = require('../routes/presence');
const ha = require('../telemetry/homeAssistant');
const neuroConfig = require('../integrations/neuroConfig');
const pending = require('./pending');
const { spokenForm } = require('../../../../shared/spoken.cjs');

// How long a sure room must hold before it is an arrival. Was 25s; measured on the
// second live test the greeting landed ~60s after he walked in (≈16s for the
// fingerprint to become sure, the 25s hold, a wobble resetting it, polling). The
// wobble is MIN_AWAY_MS's job now, so this only has to rule out a walk-through.
const ARRIVAL_MS = 10 * 1000;
const WARMUP_MS = 60 * 1000;
const TICK_MS = 3 * 1000;
// ⚠ A RETURN ONLY COUNTS AFTER A REAL ABSENCE. Measured 11 Sep 2026 on the first
// live test: with Nick sat still in the study, the fingerprint called another room
// `sure` for 16 SECONDS and came back, and the detector greeted him "welcome back"
// for an arrival that never happened. His real walk out and back was ~56s, so 45s
// sits between the wobble and the walk.
const MIN_AWAY_MS = 45 * 1000;

/** "living-room=ha:media_player.x,study=sensor" -> Map. PURE. Bad entries are dropped. */
function parseSpeakers(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(',')) {
    const [room, spec] = part.split('=').map((s) => (s || '').trim());
    if (!/^[a-z0-9-]{1,40}$/.test(room || '') || !spec) continue;
    if (spec === 'sensor') out.set(room, { kind: 'sensor' });
    else if (/^ha:media_player\.[a-z0-9_]+$/.test(spec)) out.set(room, { kind: 'ha', entity: spec.slice(3) });
    // ⚠ A WYOMING SATELLITE IS NOT A `media_player`, which is why the living
    //   room could not be moved off the HomePod by configuration alone. The
    //   Pi 4's USB speaker is reachable ONLY as `assist_satellite.living_room`
    //   — Home Assistant lists four media_players here and none of them is it
    //   (checked live, 21 Sep 2026: the HomePod, two Sky Glass, one
    //   unavailable). `tts.speak` cannot address a satellite; `announce` can.
    else if (/^ha_satellite:assist_satellite\.[a-z0-9_]+$/.test(spec)) {
      out.set(room, { kind: 'ha_satellite', entity: spec.slice('ha_satellite:'.length) });
    }
  }
  return out;
}

/**
 * Has he just arrived somewhere? PURE.
 * @param {{announcedSince, room, since, leftAt}} state  from the previous call
 * @param {{room, since, sustained}} clock  from sustainedClock
 */
function nextArrival(state, clock, now, {
  arrivalMs = ARRIVAL_MS, bootedAt = 0, warmupMs = WARMUP_MS, minAwayMs = MIN_AWAY_MS,
} = {}) {
  const s = { announcedSince: null, room: null, since: null, leftAt: {}, ...(state || {}) };
  const next = { ...s, leftAt: { ...s.leftAt } };
  const room = clock ? clock.room : null;
  const since = clock ? clock.since : null;

  // When he LEFT a room is when the next room began — so a wobble away and back
  // is measured as the short absence it was.
  if (room !== s.room && s.room != null) next.leftAt[s.room] = since != null ? since : now;
  next.room = room;
  next.since = since;

  if (!clock || !clock.sustained || clock.sustained.ms < arrivalMs) return { state: next, arrival: null };
  if (since === s.announcedSince) return { state: next, arrival: null };

  next.announcedSince = since;
  if (now - bootedAt < warmupMs) return { state: next, arrival: null, suppressed: 'warm-up' };
  const left = s.leftAt[room];
  if (left != null && since - left < minAwayMs) {
    return { state: next, arrival: null, suppressed: `back after ${Math.round((since - left) / 1000)}s — not an arrival` };
  }
  return { state: next, arrival: room };
}

function createGreeter({ env = process.env, fetchImpl = (...a) => fetch(...a), log = console } = {}) {
  const speakers = parseSpeakers(env.SAIM_GREET_SPEAKERS);
  const bootedAt = Date.now();
  const st = { lastRoom: null, room: null, since: null, arrival: {} };
  let timer = null;

  async function claim(room) {
    const ready = neuroConfig.readiness(env);
    if (!ready.ready) return { ok: false, why: 'NEURO not configured' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Number(env.SAIM_GREET_TIMEOUT_MS) || 20000);
    try {
      const res = await fetchImpl(`${neuroConfig.getBaseUrl(env)}/api/greeting`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...neuroConfig.authHeaders(env) },
        body: JSON.stringify({ room }),
        signal: ctl.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.ok !== true) return { ok: false, why: `NEURO answered ${res.status}` };
      return body;
    } catch (e) {
      return { ok: false, why: e.name === 'AbortError' ? 'NEURO timed out' : e.message };
    } finally {
      clearTimeout(t);
    }
  }

  async function speakViaHa(entity, text) {
    const base = (env.SAIM_HA_BASE_URL || '').replace(/\/+$/, '');
    const token = env.SAIM_HA_TOKEN || '';
    if (!base || !token) return { ok: false, why: 'Home Assistant not configured' };
    try {
      const res = await fetchImpl(`${base}/api/services/tts/speak`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_id: env.SAIM_GREET_TTS_ENTITY || 'tts.piper',
          media_player_entity_id: entity,
          message: text,
          cache: false,
        }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok ? { ok: true } : { ok: false, why: `Home Assistant answered ${res.status}` };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }

  /**
   * Speak through a Wyoming assist satellite.
   *
   * ⚠ A SECOND NAMED DOOR, never a general "call any HA service" helper —
   * `ha-rooms.js` refuses one outright ("an open proxy into a house") and this
   * follows that rule: one service, one shape, nothing interpolated but the
   * entity and the words.
   *
   * ⚠ IT USES THE SATELLITE'S OWN VOICE. `assist_satellite.announce` speaks
   * through the pipeline that satellite is already assigned to — piper here —
   * so this needs no `tts` entity and must NOT be given one: naming a second
   * engine is how one room comes to sound different from the rest of the house.
   */
  async function speakViaSatellite(entity, text) {
    const base = (env.SAIM_HA_BASE_URL || '').replace(/\/+$/, '');
    const token = env.SAIM_HA_TOKEN || '';
    if (!base || !token) return { ok: false, why: 'Home Assistant not configured' };
    try {
      const res = await fetchImpl(`${base}/api/services/assist_satellite/announce`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entity, message: text }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok ? { ok: true } : { ok: false, why: `Home Assistant answered ${res.status}` };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }

  async function deliver(room) {
    const speaker = speakers.get(room);
    if (!speaker) return { spoken: false, why: 'room has no speaker' };
    const c = await claim(room);
    if (!c.ok) { log.warn(`[greeter] ${room}: no greeting — ${c.why}`); return { spoken: false, why: c.why }; }
    if (!c.speak || !c.text) { log.log(`[greeter] ${room}: staying quiet — ${c.why}`); return { spoken: false, why: c.why }; }

    // ⚠ SPOKEN FORM, AT THE ONE POINT BOTH KINDS PASS THROUGH. `CLAUDE.md`'s
    // first line says the name is pronounced "Sam" and nothing implemented it,
    // so the satellite said "say-im" out loud (heard 21 Sep 2026). Doing it
    // HERE rather than in each branch means the Android tablet is covered by
    // the server and its Kotlin `TextToSpeech` needs no change — and the two
    // cannot drift. It renders one name; it never edits her words.
    const spoken = spokenForm(c.text);

    if (speaker.kind === 'sensor') {
      pending.put(room, spoken);
      log.log(`[greeter] ${room}: greeting queued for the room's sensor`);
      return { spoken: true, via: 'sensor' };
    }
    const viaSatellite = speaker.kind === 'ha_satellite';
    const r = viaSatellite
      ? await speakViaSatellite(speaker.entity, spoken)
      : await speakViaHa(speaker.entity, spoken);
    if (!r.ok) log.warn(`[greeter] ${room}: Home Assistant did not speak — ${r.why}`);
    else log.log(`[greeter] ${room}: greeted via ${speaker.entity}`);
    // ⚠ `via` NAMES THE DOOR, not just "ha" — two different services with
    //   different failure modes, and a log that cannot tell them apart sends
    //   the reader to the wrong one.
    return { spoken: r.ok, via: viaSatellite ? 'ha_satellite' : 'ha', why: r.why || null };
  }

  async function tick(nowMs = Date.now()) {
    const now = new Date(nowMs);
    // ⚠ House sensors only. An office desk hearing the watch must not feed the house
    // arbitration or the fingerprint — a greeting composed from that would be SAiM
    // welcoming him into a room he is twenty miles from.
    const arbitration = resolveRoom(presence.houseOnly(store.all()), now, { previousRoom: st.lastRoom });
    if (arbitration.status === 'present') st.lastRoom = arbitration.room;
    else if (arbitration.status === 'absent') st.lastRoom = null;

    const home = presence.homePresence(ha.getTelemetry());
    const inferred = classify(presence.liveVector(arbitration), profiles.all());
    const clock = presence.sustainedClock({ room: st.room, since: st.since },
      { inferred, arbitration, home, now: nowMs });
    st.room = clock.room;
    st.since = clock.since;

    const { state, arrival, suppressed } = nextArrival(st.arrival, clock, nowMs, { bootedAt });
    st.arrival = state;
    if (suppressed) log.log(`[greeter] ${clock.room}: not greeting — ${suppressed}`);
    if (arrival && speakers.has(arrival)) return deliver(arrival);
    return null;
  }

  function start() {
    if (!speakers.size) {
      log.log('[greeter] SAIM_GREET_SPEAKERS not set — greetings off');
      return false;
    }
    log.log(`[greeter] greeting on arrival in: ${[...speakers].map(([r, s]) => `${r} (${s.kind === 'ha' ? s.entity : 'sensor'})`).join(', ')}`);
    timer = setInterval(() => { tick().catch((e) => log.warn('[greeter] tick failed: ' + e.message)); }, TICK_MS);
    if (timer.unref) timer.unref();
    return true;
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, tick, deliver, speakers, state: st };
}

module.exports = { createGreeter, parseSpeakers, nextArrival, ARRIVAL_MS, WARMUP_MS, MIN_AWAY_MS };
