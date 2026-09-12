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
// ⚠ AN INTENT EXPIRES. `TTL_MS` is two minutes — about one agent poll. If he is
//   not at the machine the moment he asks, the request dies rather than firing
//   an hour later when he has walked away or somebody else is using it. A
//   queued action with no deadline is how "open my music" becomes a surprise.
//
// ⚠ SINGLE USE, AND THE AGENT SAYS WHAT HAPPENED. Claimed intents are removed
//   on handover, so a retried poll cannot launch twice; the agent reports the
//   outcome back on its next POST so a surface can say "opened" rather than
//   "sent, hopefully".

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

const TTL_MS = 2 * 60 * 1000;

// Bounded: this is a hand-off queue, not a log. More than a couple pending means
// something is wrong, and the cap stops a stuck agent growing the blob.
const MAX_PENDING = 5;

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && Array.isArray(v.pending) ? v : { pending: [], outcomes: [] };
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
    return { ok: false, reason: 'not something SARA can open: "' + app + '"' };
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
function claim({ host = null, now = Date.now() } = {}) {
  const state = _load();
  if (!state) return { intents: [], gaps: ['could not read the intent queue'] };

  const live = claimable(state.pending, now);
  // ⚠ Host-scoped when the intent named one: "open it on the laptop I am at"
  // must not fire on a different machine that happens to poll first.
  const mine = live.filter(i => !i.host || !host || i.host === host);
  if (!mine.length) {
    if (state.pending.length !== live.length) { state.pending = live; _save(state); }
    return { intents: [], gaps: [] };
  }

  state.pending = live.filter(i => !mine.includes(i));
  _save(state);
  return { intents: mine.map(i => ({ id: i.id, app: i.app })), gaps: [] };
}

/** The agent tells us what actually happened. */
function record(id, ok, detail = null) {
  const state = _load();
  if (!state) return { ok: false, reason: 'could not read the intent queue' };
  state.outcomes = [...(state.outcomes || []), { id, ok: Boolean(ok), detail: detail || null, at: new Date().toISOString() }];
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

module.exports = { queue, claim, record, status, isExpired, claimable, APPS, TTL_MS, MAX_PENDING, STATE_KEY };
