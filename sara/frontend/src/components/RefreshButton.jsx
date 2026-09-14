import { useState } from 'react';
import './RefreshButton.css';

// "Get me the current build" — for the screens that never reload.
//
// Nick, 14 Sep 2026: "all tablet sessions need a refresh button - fire tablet is
// still on the old deploy." It was, and nothing was broken: `vite.config.js` sets
// `registerType: 'autoUpdate'`, which checks for a new service worker ON PAGE
// LOAD — and a kiosk page is opened once and then left open for days. The study
// tablet, the work Fire, the Pi desk display and the Electron window are all
// screens whose defining property is that nobody ever reloads them, so the one
// moment the update check fires is the one moment that never comes round again.
// A deploy lands on the server and every tablet goes on rendering whatever it
// booted with, looking completely fine.
//
// ⚠ THE BUILD LABEL IS NOT DECORATION — it is the evidence the button worked.
// Without it a press produces a brief flicker and an identical screen, which is
// indistinguishable from a press that did nothing, on exactly the surface where
// "am I looking at the new build?" was already unanswerable (the evening lost on
// 15 Aug went on that inference). So the label is shown BEFORE the reload, and
// he can read it again after. That is also why this is two taps rather than one:
// the first tap answers the question, the second acts on it.
//
// ⚠ IT CLEARS CACHES AND SERVICE WORKERS. IT MUST NEVER TOUCH INDEXEDDB.
// The offline outbox lives there (`sara/app/src/mobile/localStore.js`) and holds
// captures that have not yet reached NEURO — thoughts whose only copy is on this
// device. `caches.delete()` cannot see IndexedDB, which is what makes this safe;
// a future hand reaching for `indexedDB.deleteDatabase()` "to be thorough" would
// destroy the one thing refreshing is not allowed to cost. Pinned by a test.
//
// ⚠ IT RELOADS THE CURRENT URL, never `/`. The kiosks are started on
// `…:3005/?room=study` and `?room=bedroom`; navigating to the bare root would
// silently strip the room and the screen would stop knowing where it is.
export default function RefreshButton({ buildLabel }) {
  const [phase, setPhase] = useState('idle'); // idle | open | working

  async function refresh() {
    setPhase('working');

    // ⚠ Every step is best-effort and NOTHING here may abort the reload. The
    // whole point of the press is to end up on a fresh page; failing to clear
    // one cache is not a reason to leave him sat on the old build, and a button
    // that throws instead of reloading is the failure it exists to fix.
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      }
    } catch { /* no service worker to remove is a fine outcome */ }

    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
      }
    } catch { /* ditto */ }

    // Same URL, so the `?room=` the kiosk was started with survives.
    window.location.reload();
  }

  return (
    <div className="refreshnav">
      {phase !== 'idle' && (
        <div className="refreshnav__panel" role="dialog" aria-label="Refresh SARA">
          <span className="refreshnav__build">
            {/* An unlabelled build is its own fact, and reads differently from a
                label that simply has not changed. */}
            {buildLabel ? `Build ${buildLabel}` : 'This build is unlabelled'}
          </span>
          <div className="refreshnav__acts">
            <button
              type="button"
              className="refreshnav__act refreshnav__act--no"
              onClick={() => setPhase('idle')}
              disabled={phase === 'working'}
            >
              Cancel
            </button>
            <button
              type="button"
              className="refreshnav__act refreshnav__act--yes"
              onClick={refresh}
              disabled={phase === 'working'}
            >
              {phase === 'working' ? 'Reloading…' : 'Reload now'}
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        className={`navbtn${phase !== 'idle' ? ' navbtn--on' : ''}`}
        aria-label="Refresh SARA"
        aria-expanded={phase !== 'idle'}
        onClick={() => setPhase(phase === 'idle' ? 'open' : 'idle')}
      >
        <span className="navbtn__icon" aria-hidden="true">⟳</span>
        <span className="navbtn__label">Refresh</span>
      </button>
    </div>
  );
}
