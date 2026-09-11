'use strict';

/**
 * SARA greets Nick when he walks into a room that can speak.
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
 * ⚠ ONLY ROOMS THAT CAN SPEAK, and only the ones configured. `SARA_GREET_SPEAKERS`
 * unset means the greeter never starts — a voice in the house is opt-in per room:
 *   SARA_GREET_SPEAKERS="living-room=ha:media_player.living_room,study=sensor"
 *   - `ha:<media_player>` speaks through Home Assistant's tts.speak (the HomePod,
 *     over the Apple TV integration) using SARA_GREET_TTS_ENTITY (default tts.piper)
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

const ARRIVAL_MS = 25 * 1000;
const WARMUP_MS = 60 * 1000;
const TICK_MS = 5 * 1000;

/** "living-room=ha:media_player.x,study=sensor" -> Map. PURE. Bad entries are dropped. */
function parseSpeakers(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(',')) {
    const [room, spec] = part.split('=').map((s) => (s || '').trim());
    if (!/^[a-z0-9-]{1,40}$/.test(room || '') || !spec) continue;
    if (spec === 'sensor') out.set(room, { kind: 'sensor' });
    else if (/^ha:media_player\.[a-z0-9_]+$/.test(spec)) out.set(room, { kind: 'ha', entity: spec.slice(3) });
  }
  return out;
}

/**
 * Has he just arrived somewhere? PURE.
 * @param {{announcedSince:number|null}} state
 * @param {{room, since, sustained}} clock  from sustainedClock
 */
function nextArrival(state, clock, now, { arrivalMs = ARRIVAL_MS, bootedAt = 0, warmupMs = WARMUP_MS } = {}) {
  const announcedSince = state ? state.announcedSince : null;
  if (!clock || !clock.sustained || clock.sustained.ms < arrivalMs) return { state: { announcedSince }, arrival: null };
  if (clock.since === announcedSince) return { state: { announcedSince }, arrival: null };
  const next = { announcedSince: clock.since };
  if (now - bootedAt < warmupMs) return { state: next, arrival: null, suppressed: 'warm-up' };
  return { state: next, arrival: clock.room };
}

function createGreeter({ env = process.env, fetchImpl = (...a) => fetch(...a), log = console } = {}) {
  const speakers = parseSpeakers(env.SARA_GREET_SPEAKERS);
  const bootedAt = Date.now();
  const st = { lastRoom: null, room: null, since: null, announcedSince: null };
  let timer = null;

  async function claim(room) {
    const ready = neuroConfig.readiness(env);
    if (!ready.ready) return { ok: false, why: 'NEURO not configured' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Number(env.SARA_GREET_TIMEOUT_MS) || 20000);
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
    const base = (env.SARA_HA_BASE_URL || '').replace(/\/+$/, '');
    const token = env.SARA_HA_TOKEN || '';
    if (!base || !token) return { ok: false, why: 'Home Assistant not configured' };
    try {
      const res = await fetchImpl(`${base}/api/services/tts/speak`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_id: env.SARA_GREET_TTS_ENTITY || 'tts.piper',
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

  async function deliver(room) {
    const speaker = speakers.get(room);
    if (!speaker) return { spoken: false, why: 'room has no speaker' };
    const c = await claim(room);
    if (!c.ok) { log.warn(`[greeter] ${room}: no greeting — ${c.why}`); return { spoken: false, why: c.why }; }
    if (!c.speak || !c.text) { log.log(`[greeter] ${room}: staying quiet — ${c.why}`); return { spoken: false, why: c.why }; }

    if (speaker.kind === 'sensor') {
      pending.put(room, c.text);
      log.log(`[greeter] ${room}: greeting queued for the room's sensor`);
      return { spoken: true, via: 'sensor' };
    }
    const r = await speakViaHa(speaker.entity, c.text);
    if (!r.ok) log.warn(`[greeter] ${room}: Home Assistant did not speak — ${r.why}`);
    else log.log(`[greeter] ${room}: greeted via ${speaker.entity}`);
    return { spoken: r.ok, via: 'ha', why: r.why || null };
  }

  async function tick(nowMs = Date.now()) {
    const now = new Date(nowMs);
    const arbitration = resolveRoom(store.all(), now, { previousRoom: st.lastRoom });
    if (arbitration.status === 'present') st.lastRoom = arbitration.room;
    else if (arbitration.status === 'absent') st.lastRoom = null;

    const home = presence.homePresence(ha.getTelemetry());
    const inferred = classify(presence.liveVector(arbitration), profiles.all());
    const clock = presence.sustainedClock({ room: st.room, since: st.since },
      { inferred, arbitration, home, now: nowMs });
    st.room = clock.room;
    st.since = clock.since;

    const { state, arrival, suppressed } = nextArrival({ announcedSince: st.announcedSince }, clock, nowMs, { bootedAt });
    st.announcedSince = state.announcedSince;
    if (suppressed) log.log(`[greeter] ${clock.room}: arrival during warm-up — not greeting`);
    if (arrival && speakers.has(arrival)) return deliver(arrival);
    return null;
  }

  function start() {
    if (!speakers.size) {
      log.log('[greeter] SARA_GREET_SPEAKERS not set — greetings off');
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

module.exports = { createGreeter, parseSpeakers, nextArrival, ARRIVAL_MS, WARMUP_MS };
