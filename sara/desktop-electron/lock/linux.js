// Linux lock adapter — no-op by design.
//
// On the Pi, SARA owns the whole screen (Chromium kiosk / fullscreen Electron), so the
// in-app LockScreen overlay IS the lock. We deliberately do NOT call loginctl/OS lock
// here: an OS lock screen over the kiosk would need a system password the touch-only
// wall display has no way to enter. canOSLock:false tells the renderer to stay
// overlay-only, exactly as today.
function noop() {
  return Promise.resolve(true);
}

module.exports = { lock: noop, wake: noop, canOSLock: false, name: 'linux' };
