'use strict';

// Doing something on the laptop, without ever opening a door into it.
// (12 Sep 2026)
//
// Nick: *"if it doesn't look like we can do it at the moment, build a way round
// it."* The blocked thing was launching anything on his work laptop — iTunes,
// a repo in VS Code, a terminal. The desktop agent is OUTBOUND ONLY by design
// and that is the property worth keeping, so this does not add an inbound
// channel. It is a PULL.
//
// ⚠⚠ NOTHING CONNECTS TO THE LAPTOP. The agent already POSTs a sample every two
//   minutes. That POST's RESPONSE may now carry a queued intent, so the laptop
//   fetches its own instructions on a connection it opened itself. There is no
//   listening port, no inbound firewall rule, and nothing on the network can
//   reach the machine. Losing that would be the single largest new attack
//   surface in the estate, and none of this needs it.
//
// ⚠⚠ THE PI CAN NAME AN ID, NEVER A COMMAND. An intent is `{ id, app }` where
//   `app` is a key from a FIXED VOCABULARY below. The mapping from key to an
//   actual executable lives in the agent's own config ON THE LAPTOP, so this
//   server cannot name a path, cannot pass arguments, and cannot invent a new
//   app by sending a different string — an unknown key is refused locally,
//   before anything runs. That is `neuroCapture`'s named-door rule applied to
//   code execution: a kind not in the table is refused rather than passed
//   through.
//
// ⚠⚠ ONLY A DELIBERATE HUMAN ACT QUEUES ONE. No rule, no timer, no model and no
//   automation may call `queue()` — it is reachable from a button press and
//   nothing else. An agent that could decide on its own to run things on his
//   work machine is a different product with a different risk, and the room
//   work has already established that acting unattended is earned, not assumed.
//
// ⚠ AN INTENT EXPIRES. If he is not at the machine the moment he asks, the
//   request dies rather than firing an hour later when he has walked away or
//   somebody else is using it. A queued action with no deadline is how "open
//   my music" becomes a surprise.
//
// ⚠⚠ `TTL_MS` WAS TWO MINUTES, DESCRIBED AS "about one agent poll" — and the
//   agent's sample interval is ALSO 120s, so the deadline and the poll were
//   the same number. Measured live on 13 Sep 2026: a browser intent took
//   **111 seconds** to open, and a music intent queued moments later EXPIRED
//   unfired. A press therefore either crawled or died, which is what "the
//   launch buttons all failed" actually was.
//
//   Two things fix it and both are needed. The agent now claims intents on a
//   SEPARATE, CHEAP poll (`POST /intents/claim`, every few seconds) rather
//   than only when it posts a sample — so a press is acted on in seconds.
//   And the deadline is no longer sized to one poll: a missed poll must not
//   be able to eat the request, so it is comfortably wider than the claim
//   cadence while still being far too short to fire at somebody who has left.
//
// ⚠ SINGLE USE, AND THE AGENT SAYS WHAT HAPPENED. Claimed intents are removed
//   on handover, so a retried poll cannot launch twice; the agent reports the
//   outcome back on its next POST so a surface can say "opened" rather than
//   "sent, hopefully".

/**
 * WHAT THIS MACHINE MAY BE ASKED TO OPEN. PURE.
 *
 * Nick, 13 Sep 2026: *"there needs to be a degree of device awareness"* — every
 * surface offered the SAME hardcoded four apps to whatever happened to be
 * listening, so a button could name a program the target machine does not have,
 * or act on a laptop in another room.
 *
 * ⚠⚠ NOTHING NEW HAD TO BE SENSED. The agent has declared `canOpen` on every
 *   sample since the pull channel shipped; the route read it to decide a claim
 *   and NOTHING STORED IT, so no surface could know what a given machine could
 *   do. Device awareness was a field already arriving and being thrown away.
 *
 * ⚠ A MACHINE THAT HAS NOT SAID GETS NO BUTTONS, and the reason is said out
 *   loud. `canOpen: null` is 'it has not told me', NOT 'it can open nothing'
 *   and NOT 'offer everything and hope' — and the third is what produced the
 *   failing buttons in the first place. Offering nothing costs a feature on a
 *   stale agent; offering everything costs a button that fails, which is worse
 *   because it teaches him the whole row is unreliable.
 *
 * ⚠ IT IS INTERSECTED WITH `APPS`, NEVER TRUSTED WHOLE. The list arrives from
 *   the laptop, so an agent naming something this server does not understand
 *   must not be able to put an unknown id on a button.
 *
 * ⚠ THE HOST TRAVELS WITH THE OFFER. A press has to be able to say WHICH
 *   machine it will act on — half the point of device awareness is not silently
 *   opening iTunes on a laptop upstairs.
 *
 * @returns {{ known, host, apps: [{id,label}], why }}
 */
function offer({ canOpen = null, atDesk = false, deskKnown = true, host = null } = {}) {
  if (deskKnown === false) {
    return { known: false, host: null, apps: [], why: 'I can’t see your laptop' };
  }
  if (!atDesk) {
    // An intent has a deadline, so offering while nothing is at the machine
    // queues work that dies unclaimed and reads as a broken button.
    return { known: true, host: host || null, apps: [], why: 'you’re not at the laptop' };
  }
  if (!Array.isArray(canOpen)) {
    return {
      known: false,
      host: host || null,
      apps: [],
      why: 'that machine hasn’t said what it can open',
    };
  }

  const apps = canOpen
    .map(a => String(a || '').trim().toLowerCase())
    .filter(a => Object.prototype.hasOwnProperty.call(APPS, a))
    .map(a => ({ id: a, label: BUTTON_LABELS[a] || APPS[a] }));

  if (!apps.length) {
    // It SPOKE and named nothing this server understands. A real answer, and a
    // different fact from silence.
    return { known: true, host: host || null, apps: [], why: 'nothing it can open is set up here' };
  }
  return { known: true, host: host || null, apps, why: null };
}

const db = require('../db/database');

const STATE_KEY = 'desk_intents';

// ⚠ THE WHOLE VOCABULARY. Adding a key here is a deliberate decision, and it
// still does nothing until the agent's own config on the laptop maps it to a
// command. Two independent edits, on two machines, are required to make this
// server able to start a new kind of program.
const APPS = {
  music: 'your music player',
  code: 'VS Code',
  terminal: 'a terminal',
  browser: 'your browser',
};

// ⚠ TWO LABELS PER APP, AND THEY ARE NOT INTERCHANGEABLE. `APPS` is PROSE, for
//   sentences ("I'll open your music player"); these are BUTTON labels, which
//   have to be short and read as a thing rather than a phrase. Rendering the
//   prose on a button gives you one reading "your music player", which is how
//   the first cut of the device-aware row shipped before this was split out.
//
// ⚠ BOTH LIVE HERE, so no surface invents its own. A second vocabulary is how
//   one client comes to offer something the route refuses.
const BUTTON_LABELS = {
  music: 'Music',
  code: 'VS Code',
  terminal: 'Terminal',
  browser: 'Browser',
};

const TTL_MS = 5 * 60 * 1000;

// Bounded: this is a hand-off queue, not a log. More than a couple pending means
// something is wrong, and the cap stops a stuck agent growing the blob.
const MAX_PENDING = 5;

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (!v || !Array.isArray(v.pending)) return { pending: [], outcomes: [], claimed: [] };
    // ⚠ A blob written before claims were recorded has no `claimed` key. It
    // reads as an empty list, which is the OLD behaviour exactly — nothing in
    // flight is reported rather than anything being invented about it.
    return { ...v, claimed: Array.isArray(v.claimed) ? v.claimed : [] };
  } catch {
    // ⚠ Unreadable is not empty: returning a fresh queue would drop an intent
    // that may already have been promised to him on screen.
    return null;
  }
}

function _save(state) {
  try {
    db.setState(STATE_KEY, JSON.stringify({
      pending: state.pending.slice(-MAX_PENDING),
      outcomes: state.outcomes.slice(-20),
      // Bounded like the other two. This is a hand-off queue, not a log.
      claimed: (state.claimed || []).slice(-MAX_PENDING),
    }));
    return true;
  } catch (e) {
    console.warn('[desk-intents] could not save:', e.message);
    return false;
  }
}

/** PURE: has this intent outlived its deadline? */
function isExpired(intent, now = Date.now()) {
  const at = Date.parse(intent && intent.at);
  if (!Number.isFinite(at)) return true; // ⚠ unreadable stamp = expired, never live
  return now - at > TTL_MS;
}

/** PURE: what the agent should be handed, given a queue and the clock. */
function claimable(pending = [], now = Date.now()) {
  return pending.filter(i => i && APPS[i.app] && !isExpired(i, now));
}

/**
 * Ask for something to be opened on the laptop.
 *
 * ⚠ Callers: a human-triggered route ONLY. See the header.
 */
function queue(app, { host = null, why = null } = {}) {
  if (!APPS[app]) {
    // Refused HERE as well as on the laptop. Two independent refusals, because
    // this is the one path in the system that ends in code running on his
    // work machine.
    return { ok: false, reason: 'not something SAiM can open: "' + app + '"' };
  }
  const state = _load();
  if (!state) return { ok: false, reason: 'could not read the intent queue' };

  const intent = {
    id: 'di_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    app,
    host,
    why: why || null,
    at: new Date().toISOString(),
  };
  state.pending = [...claimable(state.pending), intent];
  if (!_save(state)) return { ok: false, reason: 'could not save the intent' };
  return { ok: true, intent: { id: intent.id, app, label: APPS[app] }, expiresInMs: TTL_MS };
}

/**
 * Handed to the agent on its next POST. Claiming REMOVES them, so a retry
 * cannot launch the same thing twice.
 */
/**
 * @param {object} opts
 *   canOpen  what the AGENT says it understands. \u26a0 REQUIRED in practice:
 *            claiming is a server-side act, so an agent that knows nothing
 *            about intents would still cause one to be claimed and would then
 *            discard it with the response \u2014 Nick presses a button and nothing
 *            ever happens, silently. An agent that does not announce the
 *            capability is handed NOTHING and the intent stays queued for one
 *            that does. Same rule as refusing a NOVA bridge that predates a
 *            field rather than reading its absence as an empty answer.
 */
function claim({ host = null, now = Date.now(), canOpen = null } = {}) {
  const state = _load();
  if (!state) return { intents: [], gaps: ['could not read the intent queue'] };

  const live = claimable(state.pending, now);
  // ⚠ Host-scoped when the intent named one: "open it on the laptop I am at"
  // must not fire on a different machine that happens to poll first.
  const able = Array.isArray(canOpen) ? new Set(canOpen) : null;
  const mine = live.filter(i =>
    (!i.host || !host || i.host === host)
    // \u26a0 An agent that did not say it can open things gets nothing, and the
    //   intent is LEFT QUEUED rather than consumed.
    && able !== null && able.has(i.app));
  if (!mine.length) {
    if (state.pending.length !== live.length) { state.pending = live; _save(state); }
    return { intents: [], gaps: [] };
  }

  state.pending = live.filter(i => !mine.includes(i));
  // ⚠⚠ CLAIMING REMOVED THE ONLY RECORD THAT A REQUEST WAS IN FLIGHT. Once
  //   the agent took an intent it was gone from `pending` and had no outcome
  //   yet, so from the server's side a request the laptop was mid-way through
  //   opening was INDISTINGUISHABLE from one that had never been made — which
  //   meant the operation phase would have read STANDING BY while the card
  //   beside it said "the laptop has taken it". Two parts of one screen
  //   disagreeing about the same request.
  //
  // ⚠ It is a separate list rather than a flag on the pending entry, because
  //   `claimable()` is what `queue()` prunes with and a claimed intent must
  //   never be handed to a second agent.
  state.claimed = [...(state.claimed || []).filter(c => !isExpired(c, now)),
    ...mine.map(i => ({ id: i.id, app: i.app, host: i.host || null, at: new Date(now).toISOString() }))];
  _save(state);
  return { intents: mine.map(i => ({ id: i.id, app: i.app })), gaps: [] };
}

/** The agent tells us what actually happened. */
function record(id, ok, detail = null) {
  const state = _load();
  if (!state) return { ok: false, reason: 'could not read the intent queue' };
  state.outcomes = [...(state.outcomes || []), { id, ok: Boolean(ok), detail: detail || null, at: new Date().toISOString() }];
  // Settled — it is no longer in flight. Leaving it in `claimed` would hold the
  // surface on "waiting for the laptop" over a request that has already
  // answered, which is the stale-warning failure one route along.
  state.claimed = (state.claimed || []).filter(c => c && c.id !== id);
  _save(state);
  return { ok: true };
}

/** What a surface can say about a request it made. */
function status(id) {
  const state = _load();
  if (!state) return { known: false, why: 'could not read the intent queue' };
  const outcome = (state.outcomes || []).find(o => o.id === id);
  if (outcome) return { known: true, state: outcome.ok ? 'opened' : 'failed', detail: outcome.detail };
  const pending = state.pending.find(i => i.id === id);
  if (pending) {
    return isExpired(pending)
      // ⚠ Named rather than left looking live: "you were not at the machine"
      // is a fact he can act on.
      ? { known: true, state: 'expired', detail: 'you were not at the laptop in time' }
      : { known: true, state: 'waiting', detail: 'waiting for the laptop to check in' };
  }
  return { known: true, state: 'claimed', detail: 'the laptop has taken it' };
}

/**
 * What is in flight right now, so the operation phase can say so.
 *
 * Two lists, and they are DIFFERENT FACTS:
 *   requested — queued and nobody has picked it up. The request is out and the
 *               laptop has not answered. This is `executing`.
 *   taken     — an agent claimed it and has not reported back. The machine is
 *               doing it; we do not yet know whether it worked. This is
 *               `verifying`, and it is the whole reason claims are recorded.
 *
 * ⚠ An UNREADABLE queue is `known: false`, never two empty lists. "I could not
 *   look" and "nothing is in flight" license opposite sentences, and this file
 *   already makes that distinction for `_load`.
 *
 * ⚠ Expired entries are excluded from both. A request that outlived its
 *   deadline is not in flight — it is over, and `status()` names it `expired`.
 *   Nothing is WRITTEN here: this is a read, and pruning on a polled path would
 *   make a read that happens to run often change what the queue holds.
 */
function inFlight({ now = Date.now() } = {}) {
  const state = _load();
  if (!state) return { known: false, why: 'could not read the intent queue', requested: [], taken: [] };
  const live = (entry) => entry && APPS[entry.app] && !isExpired(entry, now);
  const shape = (entry) => ({ id: entry.id, app: entry.app, label: APPS[entry.app], host: entry.host || null, at: entry.at });
  const settled = new Set((state.outcomes || []).map(o => o && o.id));
  return {
    known: true,
    why: null,
    requested: (state.pending || []).filter(i => live(i) && !settled.has(i.id)).map(shape),
    taken: (state.claimed || []).filter(c => live(c) && !settled.has(c.id)).map(shape),
  };
}

module.exports = { queue, claim, record, status, inFlight, isExpired, claimable, offer, APPS, BUTTON_LABELS, TTL_MS, MAX_PENDING, STATE_KEY };
