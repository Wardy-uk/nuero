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
  pollMs = 5 * 1000, // ask the backend "am I away?" every 5s
  awayStreak = 2, // consecutive away polls required before AWAY locks
  graceMs = 5 * 1000, // AWAY: show a "locking…" countdown this long; activity cancels it
} = {}) {
  const [locked, setLocked] = useState(false);
  const [reason, setReason] = useState(null); // 'idle' | 'away' | 'manual'
  const [pending, setPending] = useState(null); // null | seconds left on the lock countdown
  const reasonRef = useRef(null);
  reasonRef.current = reason;

  const idleTimer = useRef(null);
  const awayCount = useRef(0);
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  const pendingRef = useRef(null); // mirrors `pending` for synchronous guards
  const countdownTimer = useRef(null);

  // Optional OS-level lock capability, provided by the Electron desktop shell
  // (window.saraNative). Undefined in a plain browser and disabled on the Pi kiosk
  // (canOSLock:false) — so this whole layer is a no-op there and the overlay alone
  // is the lock, exactly as before.
  const osCaps = useRef(null);
  useEffect(() => {
    let alive = true;
    window.saraNative?.capabilities?.()
      .then((c) => { if (alive) osCaps.current = c; })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const lock = useCallback((why) => {
    if (lockedRef.current) return;
    setReason(why);
    setLocked(true);
    // On capable platforms (Windows) also raise the real OS lock. Hello handles unlock.
    if (osCaps.current?.osLock) window.saraNative?.lockOS?.();
  }, []);

  // Cancel a running lock countdown (activity returned, or the Watch came back).
  const cancelCountdown = useCallback(() => {
    if (pendingRef.current == null) return;
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = null;
    pendingRef.current = null;
    setPending(null);
    window.saraNative?.attention?.(false); // release the front-and-centre warning window
  }, []);

  // Grace countdown before an AWAY lock: instead of locking instantly we show a visible
  // "Locking…" countdown and bring SARA to the front. Any activity — your keyboard/mouse
  // or the Watch returning — cancels it; only a countdown that runs out actually locks.
  // (Manual and idle locks don't use this — they're already deliberate.)
  const startCountdown = useCallback((why) => {
    if (lockedRef.current || pendingRef.current != null) return;
    const secs = Math.max(1, Math.ceil(graceMs / 1000));
    pendingRef.current = secs;
    setPending(secs);
    window.saraNative?.attention?.(true); // pop to front so the warning is seen anywhere
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = setInterval(() => {
      const next = (pendingRef.current ?? 0) - 1;
      if (next <= 0) {
        clearInterval(countdownTimer.current);
        countdownTimer.current = null;
        pendingRef.current = null;
        setPending(null);
        window.saraNative?.attention?.(false);
        lock(why);
      } else {
        pendingRef.current = next;
        setPending(next);
      }
    }, 1000);
  }, [graceMs, lock]);

  const resetIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => lock('idle'), idleMs);
  }, [idleMs, lock]);

  // Auto-unlock: only for an AWAY-triggered lock when the Watch returns. A manual or
  // idle lock still needs a deliberate tap (we don't want idle-lock to clear just
  // because the Watch is in range). Defined AFTER resetIdle so it closes over it.
  const autoUnlock = useCallback(() => {
    if (!lockedRef.current || reasonRef.current !== 'away') return;
    awayCount.current = 0;
    setLocked(false);
    setReason(null);
    // On Windows the OS is locked too: wake the display so Hello signs you back in.
    if (osCaps.current?.osLock) window.saraNative?.wakeOS?.();
    resetIdle();
  }, [resetIdle]);

  const unlock = useCallback(() => {
    awayCount.current = 0; // require a fresh away streak before AWAY can re-fire
    cancelCountdown();
    setLocked(false);
    setReason(null);
    resetIdle();
  }, [resetIdle, cancelCountdown]);

  const lockNow = useCallback(() => lock('manual'), [lock]);

  // OS-unlock auto-clear (Windows desktop only). When Windows itself is unlocked via
  // Hello, the Electron shell emits 'os-unlocked' — lift SARA's overlay too, since the
  // OS already re-authenticated you. No-op in a plain browser / on the Pi (no saraNative).
  useEffect(() => {
    const off = window.saraNative?.onOSUnlock?.(() => unlock());
    return () => { if (typeof off === 'function') off(); };
  }, [unlock]);

  // Idle activity tracking. While locked we stop arming the idle timer (already locked);
  // interaction only matters again after unlock.
  useEffect(() => {
    if (locked) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      return undefined;
    }
    const bump = () => { resetIdle(); cancelCountdown(); }; // local activity also aborts a countdown
    const events = ['pointerdown', 'touchstart', 'keydown', 'mousemove', 'wheel'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    resetIdle();
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [locked, resetIdle, cancelCountdown]);

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
              if (awayCount.current >= awayStreak) {
                // Grace countdown only where the lock is disruptive (Windows: real OS lock
                // + Hello). On the Pi kiosk the lock is just a cheap in-app overlay, so lock
                // instantly — keeping the Pi's behaviour unchanged.
                if (osCaps.current?.osLock) startCountdown('away');
                else lock('away');
              }
            } else if (data.away === false) {
              awayCount.current = 0; // present -> reset
              cancelCountdown(); // Watch/you came back mid-countdown -> abort the lock
              autoUnlock(); // walked back -> clear an away-lock automatically
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
  }, [pollMs, awayStreak, startCountdown, cancelCountdown, autoUnlock]);

  // Clear the countdown interval if the hook unmounts mid-count.
  useEffect(() => () => {
    if (countdownTimer.current) clearInterval(countdownTimer.current);
  }, []);

  return { locked, reason, pending, lockNow, unlock, dismissCountdown: cancelCountdown };
}
