// POST /api/kiosk/exit — close the on-screen kiosk browser.
//
// The Pi 5 touchscreen has no keyboard, so there is otherwise no way to leave the
// SARA kiosk (Chromium --kiosk blocks window.close() for its main tab). The frontend
// Exit button calls this; we kill only the kiosk browser. The desktop launcher
// (scripts/start-sara.sh) runs Chromium in the foreground with an EXIT trap that
// restores the Pi taskbar, so killing Chromium lets the launcher exit cleanly and the
// user lands back on the Pi desktop. This backend (PM2 sara-backend) keeps running, so
// the kiosk can be relaunched from the desktop icon.
const express = require('express');
const { exec } = require('child_process');

const router = express.Router();

router.post('/exit', (_req, res) => {
  // Best-effort across Chromium binary names. Detached and fire-and-forget so it can
  // never take this process down; errors (e.g. running off-Pi where pkill is absent)
  // are ignored. Reply first — the browser making the request is about to be closed.
  res.json({ ok: true });
  exec(
    'pkill -x chromium; pkill -x chromium-browser; pkill -f "/usr/lib/chromium/chromium"',
    { timeout: 5000 },
    () => {}
  );
});

module.exports = router;
