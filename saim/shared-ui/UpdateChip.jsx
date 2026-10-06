import React, { useEffect, useState } from 'react';
import { watchVersion } from '../../shared/version-watch.mjs';
import './UpdateChip.css';

/* global __APP_BUILD__ */
const BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : null;

/**
 * Amber when a newer build of this app is being served than the one on screen
 * (5 Oct 2026, after NOVA's status bar). Renders NOTHING otherwise: SAiM is
 * not a dashboard of her own plumbing, so the chip appears only when there is
 * something to do about it. Both shells (phone PWA, kiosk) mount this one.
 */
// A plain reload can be answered by the old service worker; this clears it and
// the caches first, as RefreshButton does. ⚠ It NEVER touches IndexedDB — the
// offline outbox there holds captures that have not reached NEURO yet.
async function hardReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
    }
  } catch { /* nothing to remove */ }
  try {
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k).catch(() => {}))); }
  } catch { /* ditto */ }
  window.location.reload();
}

// ⚠ A WALL SCREEN NOBODY TOUCHES CANNOT ANSWER A CHIP. The living-room kiosk
// ran a superseded build (huge across-the-room type) for a day after the fix
// shipped, because nothing ever reloads it (6 Oct 2026). With `autoReload` it
// reloads itself once a newer build is served AND nobody has touched it for
// AUTO_RELOAD_IDLE_MS AND no text box has focus — so a half-typed capture is
// never thrown away. Kiosk only; a phone keeps the chip and its owner decides.
const AUTO_RELOAD_IDLE_MS = 3 * 60 * 1000;

export default function UpdateChip({ onReload = hardReload, autoReload = false }) {
  const [newer, setNewer] = useState(null);
  useEffect(() => watchVersion({ current: BUILD, url: `${import.meta.env.BASE_URL || '/'}version.json`, onState: (s) => setNewer(s.newer) }), []);
  useEffect(() => {
    if (!autoReload || !newer) return undefined;
    let last = Date.now();
    const touched = () => { last = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, touched, { passive: true }));
    const t = setInterval(() => {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (!typing && Date.now() - last >= AUTO_RELOAD_IDLE_MS) { clearInterval(t); onReload(); }
    }, 30 * 1000);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, touched)); };
  }, [autoReload, newer, onReload]);
  if (!newer) return null;
  return (
    <button type="button" className="update-chip" onClick={onReload}
      title={`This screen is running ${BUILD || 'an older build'}; ${newer} is available. Tap to reload.`}>
      {newer} available — reload
    </button>
  );
}
