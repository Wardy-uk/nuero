// Hike suggestion → hike-safety arm form (1 Nov 2026).
//
// "Plan it" on a hike suggestion (Now, Life → Outdoor) hands the arm form its
// prefill here and navigates; the form takes it ONCE on mount. Arming still
// needs Nick's press — this only fills the form.
let _prefill = null;
let _navigate = null;

export function registerNavigator(fn) { _navigate = typeof fn === 'function' ? fn : null; }

/** Open Hike safety with the arm form pre-filled. */
export function planHike(prefill) {
  _prefill = prefill || null;
  if (_navigate) _navigate('hike-safety');
}

/** The pending prefill, taken once. */
export function takeHikePrefill() { const p = _prefill; _prefill = null; return p; }
