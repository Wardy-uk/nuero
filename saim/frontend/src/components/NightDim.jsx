import { useEffect, useRef } from 'react';
import './NightDim.css';

// Overnight, the screen goes down — and comes back up when he touches it.
//
// Nick, 2 Oct 2026: "overnight (times should be a setting) the screens should
// dim — 9pm to 7am for now — unless I'm interacting." WHEN is decided by the
// backend (`night.dim`, which already accounts for a recent touch); this only
// draws it and reports the touch.
//
// ⚠ THREE WAYS DOWN, ONE DECISION. The overlay works on every browser. Fully
// Kiosk (the tablets) also lowers the real backlight through its JS interface
// when that is enabled — an overlay on a lit LCD is still a lit LCD in a dark
// bedroom. The Pi's display agent lowers its own panel from the same flag.
//
// ⚠ THE FIRST TOUCH IS SWALLOWED. Tapping a dark screen is how you wake it, not
// how you press whatever happened to be under your thumb in the dark — so the
// overlay takes that tap, and only the next one reaches SAiM.
//
// ⚠ DIM, NEVER BLACK. A black screen at 2am is indistinguishable from a dead
// tablet, and the clock should still be readable from the bed.

const FULLY_NIGHT_LEVEL = 8; // of 255

export default function NightDim({ dim, nightActive, onWake }) {
  const restoreTo = useRef(null);

  useEffect(() => {
    const fully = typeof window !== 'undefined' ? window.fully : null;
    if (!fully || typeof fully.setScreenBrightness !== 'function') return;
    try {
      if (dim) {
        if (restoreTo.current === null && typeof fully.getScreenBrightness === 'function') {
          const now = Number(fully.getScreenBrightness());
          restoreTo.current = Number.isFinite(now) && now > FULLY_NIGHT_LEVEL ? now : 180;
        }
        fully.setScreenBrightness(FULLY_NIGHT_LEVEL);
      } else if (restoreTo.current !== null) {
        fully.setScreenBrightness(restoreTo.current);
        restoreTo.current = null;
      }
    } catch { /* the overlay still dims */ }
  }, [dim]);

  // Any touch while lit at night keeps it awake, so reading something does not
  // dim it under him mid-sentence. Capture phase, so nothing can swallow it.
  // ⚠ Only at night — by day a tap is not a wake, and posting one per tap all
  // day would be traffic for nothing.
  useEffect(() => {
    if (!nightActive) return undefined;
    const extend = () => onWake();
    window.addEventListener('pointerdown', extend, { capture: true, passive: true });
    return () => window.removeEventListener('pointerdown', extend, { capture: true });
  }, [nightActive, onWake]);

  if (!dim) return null;
  return (
    <div
      className="nightdim"
      aria-hidden="true"
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    />
  );
}
