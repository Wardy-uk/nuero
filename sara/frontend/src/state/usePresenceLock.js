import { useCallback, useEffect, useRef, useState } from 'react';

// usePresenceLock — SARA's "walked away" auto-lock (WS2-WP3).
//
// Two independent triggers raise the lock; either is enough:
//   1. IDLE — no touch/pointer/key activity for `idleMs`. This is the reliable
//      desk-level "you walked away" signal and needs no hardware. Primary trigger.
//   2. AWAY — the backend /api/presence reports `away: true` (Home Assistant proximity:
//      a phone tracker today, a Private BLE distance sensor for the iPhone/Apple Watch
//      later). Requires `awayStreak` consecutive away polls so a single noisy reading
//      can't lock you. `away: null` (unknown / not configured / HA down) NEVER locks —
//      only idle does — so a blind signal can't lock you out.
//
// Unlock is manual (tap the lock screen). On unlock we reset the idle clock and require
// presence to come back before AWAY can re-arm, so returning to your desk and tapping
// doesn't immediately re-lock.
export function usePresenceLock({
  idleMs = 3 * 60 * 1000, // lock after 3 min of no interaction
  pollMs = 15 * 1000, // ask the backend "am I away?" every 15s
  awayStreak = 2, // consecutive away polls required before AWAY locks
} = {}) {
  const [locked, setLocked] = useState(false);
  const [reason, setReason] = useState(null); // 'idle' | 'away' | 'manual'

  const idleTimer = useRef(null);
  const awayCount = useRef(0);
  const lockedRef = useRef(false);
  lockedRef.current = locked;

  const lock = useCallback((why) => {
    if (lockedRef.current) return;
    setReason(why);
    setLocked(true);
  }, []);

  const resetIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => lock('idle'), idleMs);
  }, [idleMs, lock]);

  const unlock = useCallback(() => {
    awayCount.current = 0; // require a fresh away streak before AWAY can re-fire
    setLocked(false);
    setReason(null);
    resetIdle();
  }, [resetIdle]);

  const lockNow = useCallback(() => lock('manual'), [lock]);

  // Idle activity tracking. While locked we stop arming the idle timer (already locked);
  // interaction only matters again after unlock.
  useEffect(() => {
    if (locked) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      return undefined;
    }
    const bump = () => resetIdle();
    const events = ['pointerdown', 'touchstart', 'keydown', 'mousemove', 'wheel'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    resetIdle();
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [locked, resetIdle]);

  // AWAY polling. Only locks on a confirmed away streak; never locks on null/unknown.
  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
      try {
        const res = await fetch('/api/presence');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            if (data.away === true) {
              awayCount.current += 1;
              if (awayCount.current >= awayStreak) lock('away');
            } else if (data.away === false) {
              awayCount.current = 0; // present -> reset
            }
            // data.away === null -> unknown: leave the streak untouched, don't lock.
          }
        }
      } catch {
        /* network hiccup -> ignore; idle timer still protects you */
      }
      if (!cancelled) timer = setTimeout(poll, pollMs);
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs, awayStreak, lock]);

  return { locked, reason, lockNow, unlock };
}
