// Fallback adapter for any other platform (e.g. macOS dev) — overlay-only, no OS lock.
function noop() {
  return Promise.resolve(true);
}

module.exports = { lock: noop, wake: noop, canOSLock: false, name: 'noop' };
