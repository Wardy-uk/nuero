'use strict';

// Where should this go? (12 Sep 2026)
//
// PURE. Takes the endpoints, what is being sent, and the situation; returns
// where it should go and why. No DB, no network, no clock — `now` is passed.
//
// Nick's ask was "launch iTunes on my laptop, or the HomePod, or my phone,
// depending where I am", and then: *"think wider — anticipate my
// requirements."* The wider thing is that EVERY action SAiM takes has an
// intent and an ENDPOINT, and he should never have to name the endpoint. Music
// is one case. Speaking, notifying, showing and playing are the same problem.
//
// ⚠⚠ THE AXIS THAT MATTERS IS NOT LOCATION, IT IS AUDIENCE.
//   The obvious model is "send it to the nearest device". That is wrong in the
//   one direction that cannot be undone: the living-room TV and the kiosk are
//   in a FAMILY ROOM. Routing "NT-27530 has breached, Naomi hasn't replied in
//   nine days" to the nearest speaker reads a colleague's name, a customer's
//   ticket and Nick's work out loud to whoever is on the sofa. The phone and
//   the laptop are his; the kiosk and the TV are the household's.
//
//   So content carries a PRIVACY and an endpoint carries an AUDIENCE, and
//   private content NEVER lands on a shared endpoint. If no private endpoint is
//   reachable it REFUSES and says so — it does not downgrade. This is VESTA's
//   rule (a work event's subject is ABSENT from the response, not hidden by
//   CSS) applied to devices instead of fields.
//
// ⚠ AN UNREACHABLE TARGET IS NAMED, NEVER SILENTLY SUBSTITUTED. "The HomePod
//   isn't reachable, so I used the telly" and "I played it on the telly" are
//   different statements, and only the first lets him fix anything. Same rule
//   as the room offers: `off` and `unavailable` are not the same fact.
//
// ⚠ CAPABILITY, NOT DEVICE TYPE. The mic on the kiosk exists because a mic is
//   plugged in, not because it is "the kiosk" — that is already how
//   `speechRecognition.js` decides. An endpoint declares what it can DO, so a
//   HomePod appearing in Home Assistant later is a row in a table, not a
//   rewrite.
//
// ⚠ IT RESOLVES; IT DOES NOT SEND. Nothing here performs an action. The caller
//   takes the answer to the transport that already owns that channel — webpush,
//   the satellite, `media_player.play_media` — each of which keeps its own
//   rules. A router that also sent would be a second place those rules live.

// What an endpoint can do. A capability is a promise about the DEVICE, not
// about whether it is a good idea right now — that is the situation's job.
const CAPABILITIES = ['speak', 'notify', 'show', 'play', 'listen'];

// Who can perceive it.
//   private  only Nick, in practice: his phone, his laptop.
//   shared   anyone in the room: the kiosk screen, the living-room TV.
const AUDIENCES = ['private', 'shared'];

// How sensitive the thing being sent is.
//   private  work detail, health, a named colleague, anything from the vault.
//   ambient  a light, the time, the weather, a timer — nothing is revealed.
const PRIVACY = ['private', 'ambient'];

function isReachable(ep) {
  return Boolean(ep && ep.reachable !== false);
}

/**
 * @param {object} req
 *   capability  one of CAPABILITIES
 *   privacy     'private' | 'ambient'  (default 'private' — see below)
 *   endpoints   [{ id, label, capabilities:[], room, audience, reachable, why }]
 *   context     { room, quiet, onDuty, inMeeting, atDesk, known }
 *   urgent      bypasses the quiet gate. Operational only.
 * @returns {{ endpoint, why, alternatives, refused, gaps }}
 */
function resolve(req = {}) {
  const gaps = [];
  const refused = [];
  const capability = req.capability;
  // ⚠ DEFAULT PRIVATE. An unstated privacy is not a licence to broadcast; the
  // expensive mistake here is reading work aloud in a family room, and it must
  // take a deliberate 'ambient' to do it.
  const privacy = req.privacy === 'ambient' ? 'ambient' : 'private';
  const ctx = req.context || {};
  const all = Array.isArray(req.endpoints) ? req.endpoints : [];

  if (!CAPABILITIES.includes(capability)) {
    return { endpoint: null, why: 'unknown capability "' + capability + '"', alternatives: [], refused, gaps };
  }
  if (!all.length) {
    return { endpoint: null, why: 'no endpoints are configured', alternatives: [], refused, gaps: ['no endpoints'] };
  }

  let pool = all.filter(e => Array.isArray(e.capabilities) && e.capabilities.includes(capability));
  if (!pool.length) {
    return { endpoint: null, why: 'nothing here can ' + capability, alternatives: [], refused, gaps };
  }

  // ── The audience gate. First, and non-negotiable. ────────────────────────
  if (privacy === 'private') {
    for (const e of pool.filter(e => e.audience === 'shared')) {
      refused.push({ id: e.id, why: 'shared with the household — not for work detail' });
    }
    pool = pool.filter(e => e.audience !== 'shared');
    if (!pool.length) {
      // ⚠ REFUSES rather than downgrading. Saying it somewhere everyone can
      // hear is worse than not saying it.
      return {
        endpoint: null,
        why: 'the only ' + capability + ' endpoints here are shared with the household, and this is private',
        alternatives: [], refused, gaps,
      };
    }
  }

  // ── Reachability ─────────────────────────────────────────────────────────
  for (const e of pool.filter(e => !isReachable(e))) {
    refused.push({ id: e.id, why: e.why || 'not reachable' });
  }
  pool = pool.filter(isReachable);
  if (!pool.length) {
    return { endpoint: null, why: 'nothing that can ' + capability + ' is reachable right now', alternatives: [], refused, gaps };
  }

  // ── The situation ────────────────────────────────────────────────────────
  // ⚠ Being in a meeting silences SPEECH entirely, whatever the urgency — it is
  // the one state where interrupting is actively wrong, and `context-state` has
  // said so since it shipped. A notification still lands; it is quiet.
  if (capability === 'speak' && ctx.inMeeting) {
    return { endpoint: null, why: 'you are in a meeting', alternatives: [], refused, gaps };
  }
  if (capability === 'speak' && ctx.quiet && !req.urgent) {
    return { endpoint: null, why: 'quiet hours', alternatives: [], refused, gaps };
  }

  // ── Ranking ──────────────────────────────────────────────────────────────
  const ranked = pool
    .map(e => ({ e, score: score(e, ctx, capability) }))
    .sort((a, b) => b.score.n - a.score.n);

  const best = ranked[0];
  // ⚠ Not knowing where he is is NOT an error — it just means the ranking was
  // decided on weaker evidence, and a surface should be able to say so.
  if (ctx.known === false || !ctx.room) gaps.push('I do not know which room you are in, so this is a best guess');

  return {
    endpoint: best.e,
    why: best.score.why,
    alternatives: ranked.slice(1).map(r => ({ id: r.e.id, why: r.score.why })),
    refused,
    gaps,
  };
}

/**
 * How good a fit is this endpoint, right now? Higher wins.
 *
 * Deliberately a small number of coarse reasons rather than a tuned formula:
 * every one has to be explainable in a sentence, because the answer is shown.
 */
function score(e, ctx, capability) {
  // ⚠ THE DESK IS CHECKED FIRST, and it is about the REASON rather than the
  // winner. When he is at the laptop in the office, both rules pick the desktop
  // — but "you are at the laptop" is a more precise and more useful thing to
  // show him than "you are in the office", and the reason is rendered.
  // `atDesk` comes from the agent actively reporting a foreground app, so it is
  // stronger evidence of where he is looking than the room is.
  if (e.id === 'desktop' && ctx.atDesk) {
    return { n: 100, why: 'you are at the laptop' };
  }
  // In the room he is standing in.
  if (e.room && ctx.room && sameRoom(e.room, ctx.room)) {
    return { n: 95, why: 'you are in the ' + e.room };
  }
  // ⚠ The phone is the FALLBACK ON PURPOSE: it is the only endpoint that
  // follows him, so it is the one place a thing can be left that he will
  // certainly see. It never wins over a device he is demonstrably at, because
  // a buzz in his pocket while he is looking at a screen is the worse choice.
  if (e.id === 'phone') return { n: 50, why: 'it follows you' };
  if (e.room) return { n: 10, why: 'it is in the ' + e.room + ', which is not where you are' };
  return { n: 20, why: 'no better option' };
}

function sameRoom(a, b) {
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Every endpoint that could serve this, in order — for a caller that wants to
 * fan out (a critical alert) rather than pick one.
 *
 * ⚠ Still audience-gated. "Critical" is not a reason to read a colleague's name
 * out in the living room; it is a reason to reach every PRIVATE endpoint.
 */
function resolveAll(req = {}) {
  const first = resolve(req);
  if (!first.endpoint) return { endpoints: [], ...first };
  return { endpoints: [first.endpoint, ...first.alternatives.map(a => a.id)], ...first };
}


/**
 * What KIND of device is behind a web-push subscription?
 *
 * ⚠ A push endpoint names the PUSH SERVICE, not the device. `web.push.apple.com`
 *   means Apple pushed it — an iPhone, an iPad, a Mac — and an iPad on the
 *   kitchen worktop is a SHARED screen. So this returns a LIKELIHOOD and never a
 *   certainty, and an explicit label from the client always wins over it.
 *
 * ⚠ UNKNOWN IS TREATED AS PRIVATE, deliberately, and REPORTED. Refusing would
 *   silence a subscription that predates labelling — today that is the only one
 *   there is, so the safe-looking choice would mean Nick gets no notifications
 *   at all. Sending while COUNTING the unknowns fails in the working direction
 *   and keeps the gap visible, which is what lets it be closed rather than
 *   discovered.
 */
function classifyPushEndpoint(url, label = null) {
  const known = { phone: 'private', desktop: 'private', kiosk: 'shared', tv: 'shared' };
  if (label && known[label]) {
    return { audience: known[label], label, confidence: 'stated', why: 'the client said it is the ' + label };
  }
  const host = (String(url || '').match(/^https?:\/\/([^/]+)/) || [])[1] || '';
  if (/apple\.com$/i.test(host)) {
    return { audience: 'private', label: null, confidence: 'inferred', why: 'an Apple push endpoint — probably his phone, but an iPad on a worktop is shared' };
  }
  return { audience: 'private', label: null, confidence: 'unknown', why: 'nothing says what device this is — treated as private so it still works, and counted' };
}
module.exports = { resolve, resolveAll, score, sameRoom, classifyPushEndpoint, CAPABILITIES, AUDIENCES, PRIVACY };
