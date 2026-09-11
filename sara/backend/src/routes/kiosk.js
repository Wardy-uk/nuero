// POST /api/kiosk/exit — close the on-screen kiosk browser.
//
// The Pi 5 touchscreen has no keyboard, so there is otherwise no way to leave the
// SARA kiosk (Chromium --kiosk blocks window.close() for its main tab). The frontend
// Exit button calls this; we kill only the kiosk browser. The desktop launcher
// (scripts/start-sara.sh) runs Chromium in the foreground with an EXIT trap that
// restores the Pi taskbar, so killing Chromium lets the launcher exit cleanly and the
// user lands back on the Pi desktop. This backend (PM2 sara-backend) keeps running, so
// the kiosk can be relaunched from the desktop icon.
//
// ⚠ THE BROWSER IS NOT ALWAYS ON THIS HOST (11 Sep 2026). The desk screen moved to
// pi-dev on 19 Jun and loads this backend over the tailnet, so Exit ran pkill on
// pi5 — where no browser runs — answered ok:true, and nothing closed. It now
// checks first and says so, rather than reporting a close that did not happen.
const express = require('express');
const { exec, execSync } = require('child_process');

const router = express.Router();

function browserRunsHere() {
  try {
    execSync('pgrep -x chromium || pgrep -x chromium-browser', { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false; // no match, or no pgrep (off-Pi) — either way nothing here to close
  }
}

router.post('/exit', (_req, res) => {
  if (!browserRunsHere()) {
    return res.json({
      ok: false,
      reason: 'browser-elsewhere',
      error: 'This screen’s browser runs on another machine, so SARA can’t close it from here.',
    });
  }
  // Best-effort across Chromium binary names. Detached and fire-and-forget so it can
  // never take this process down. Reply first — the browser making the request is
  // about to be closed.
  res.json({ ok: true });
  exec(
    'pkill -x chromium; pkill -x chromium-browser; pkill -f "/usr/lib/chromium/chromium"',
    { timeout: 5000 },
    () => {}
  );
});

module.exports = router;
