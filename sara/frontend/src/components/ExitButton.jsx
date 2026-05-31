import { useState } from 'react';
import './ExitButton.css';

// Exit control for the Pi kiosk (WS2-WP2).
//
// The Pi touchscreen has no keyboard, so there is no other way out of the Chromium
// kiosk. This lives in the app shell, so it appears on EVERY view. It is two-step
// (confirm-then-quit) so a stray touch can't drop you out: tap shows "Close SARA?",
// and only "Close" actually quits. On confirm it asks the SARA backend to close the
// kiosk browser (POST /api/kiosk/exit); the desktop launcher restores the Pi taskbar
// as it exits. Off-Pi (e.g. a desktop browser) the backend kill is a no-op and we
// fall back to window.close().
export default function ExitButton() {
  const [phase, setPhase] = useState('idle'); // idle | confirm | closing

  async function quit() {
    setPhase('closing');
    try {
      await fetch('/api/kiosk/exit', { method: 'POST' });
    } catch {
      window.close();
    }
  }

  if (phase === 'closing') {
    return (
      <div className="exit exit--status" role="status">
        Closing SARA…
      </div>
    );
  }

  if (phase === 'confirm') {
    return (
      <div className="exit exit--confirm" role="dialog" aria-label="Close SARA?">
        <span className="exit__ask">Close SARA?</span>
        <button type="button" className="exit__act exit__act--yes" onClick={quit}>
          Close
        </button>
        <button
          type="button"
          className="exit__act exit__act--no"
          onClick={() => setPhase('idle')}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="exit exit__trigger"
      aria-label="Exit SARA"
      title="Exit SARA"
      onClick={() => setPhase('confirm')}
    >
      <span aria-hidden="true">⏻</span>
    </button>
  );
}
