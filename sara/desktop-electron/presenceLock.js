// Watch presence → OS lock, decided in the Electron MAIN process.
//
// ⚠ WHY IT LIVES HERE NOW (11 Sep 2026). The lock used to be decided in the
// renderer by `usePresenceLock`, inside the KIOSK build. Two things then took it
// away without anyone deciding to: the laptop shortcut was pointed at the PHONE
// build (sara.nickward.co.uk, 1 Sep), which never had the hook, and the kiosk
// replaced the hook with NEURO's server-side display verdict (~2 Sep). The native
// bridge in preload.js stayed exposed with nothing calling it, so "the Watch locks
// my laptop" silently stopped — for over a week — while every piece of it looked
// intact. Deciding it here makes it independent of WHICH SARA the window loads.
//
// It reads the Watch reporter's `presence.json` directly: the reporter is on this
// machine, so there is no reason to route a local file through a local server that
// may not be running.
//
// PURE: `step(state, input)` takes a reading, the time and the system idle, and
// returns the next state plus what to do. No fs, no clock, no Electron — pinned by
// presenceLock.test.js.

const STALE_MS = 30 * 1000;   // the reporter heartbeats ~6s; 30s old is a dead reporter
const AWAY_STREAK = 2;        // consecutive fresh "away" reads before a lock is armed
const GRACE_MS = 5 * 1000;    // warning time between arming and locking
const INPUT_GRACE_S = 5;      // input this recent means he is at the keyboard

function initialState() {
  return {
    awayCount: 0,
    graceUntil: null,   // a lock is counting down
    lockedBySara: false,
    armed: false,       // ⚠ must have SEEN him present before the first lock can fire
  };
}

/** Read a presence payload, or say why it cannot be trusted. PURE. */
function assessReading(payload, now) {
  if (!payload || typeof payload !== 'object') return { known: false, why: 'unreadable' };
  const updated = Date.parse(payload.updated);
  if (!Number.isFinite(updated)) return { known: false, why: 'no-timestamp' };
  // ⚠ A STALE FILE IS A BLIND READING, NEVER "AWAY". The reporter crashed on
  // 4 Sep and its last word stood on disk; read as a fact, a dead sensor that
  // last said away would lock the machine for ever, and one that last said
  // present would suppress nothing harmful but tell a lie. Neither is allowed to act.
  if (now - updated > STALE_MS) return { known: false, why: 'stale' };
  if (payload.status === 'away' || payload.away === true) return { known: true, away: true };
  if (payload.status === 'present' || payload.present === true) return { known: true, away: false };
  return { known: false, why: 'undecided' };
}

/**
 * One tick. Returns `{ state, action }` where action is one of
 * null | 'warn' | 'cancel-warn' | 'lock' | 'wake'.
 */
function step(prev, { payload, now, idleS }) {
  const s = { ...prev };
  const r = assessReading(payload, now);
  const inputFresh = Number.isFinite(idleS) && idleS < INPUT_GRACE_S;

  // Blind: act on nothing, and abandon any countdown — never lock on a guess.
  if (!r.known) {
    s.awayCount = 0;
    if (s.graceUntil != null) { s.graceUntil = null; return { state: s, action: 'cancel-warn' }; }
    return { state: s, action: null };
  }

  if (!r.away) {
    s.awayCount = 0;
    s.armed = true;
    if (s.lockedBySara) {
      // He came back to a machine SARA locked: nudge the display so Hello can sign
      // him in. Hello does the authentication — nothing here unlocks anything.
      s.lockedBySara = false;
      return { state: s, action: 'wake' };
    }
    if (s.graceUntil != null) { s.graceUntil = null; return { state: s, action: 'cancel-warn' }; }
    return { state: s, action: null };
  }

  // Away.
  if (s.lockedBySara || !s.armed) return { state: s, action: null };

  // ⚠ Fresh keyboard/mouse input overrides the Watch. The reporter already fuses
  // input, but its file can be up to a heartbeat old; a lock landing mid-sentence
  // because the Watch read weak is the failure that gets a feature switched off.
  if (inputFresh) {
    s.awayCount = 0;
    if (s.graceUntil != null) { s.graceUntil = null; return { state: s, action: 'cancel-warn' }; }
    return { state: s, action: null };
  }

  if (s.graceUntil != null) {
    if (now >= s.graceUntil) {
      s.graceUntil = null;
      s.awayCount = 0;
      s.lockedBySara = true;
      s.armed = false; // re-arms only once he has been seen present again
      return { state: s, action: 'lock' };
    }
    return { state: s, action: null };
  }

  s.awayCount += 1;
  if (s.awayCount >= AWAY_STREAK) {
    s.graceUntil = now + GRACE_MS;
    return { state: s, action: 'warn' };
  }
  return { state: s, action: null };
}

/** Windows unlocked by any means: SARA no longer holds the lock. */
function onOSUnlocked(prev) {
  return { ...prev, lockedBySara: false, graceUntil: null, awayCount: 0 };
}

module.exports = { step, assessReading, initialState, onOSUnlocked, STALE_MS, AWAY_STREAK, GRACE_MS, INPUT_GRACE_S };
