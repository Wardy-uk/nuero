// The developer/test view: `?debug=1` on the URL, per device, never stored.
// Implementation details (build ids, lock state, budgets, reasons) appear ONLY
// here — never on the surface Nick reads.
export function isDebugView(search = (typeof window !== 'undefined' ? window.location.search : '')) {
  try { return new URLSearchParams(search).get('debug') === '1'; } catch { return false; }
}
