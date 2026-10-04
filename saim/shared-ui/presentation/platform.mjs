// Which kind of surface THIS shell is (Build 12O).
//
// ⚠ DECLARED, NOT INFERRED. Each shell already knows what it is: the kiosk
//   build is only ever a wall/tablet screen, Electron exposes `saimNative`, and
//   everything else is the phone app. Sniffing a user agent or a touch API to
//   guess the same fact is how a laptop with a touchscreen becomes a phone.
//
// The one override is the URL (`?surface=kiosk|phone|desktop`), because the
// tablets and wall panels are started at a fixed address — the same reason
// `?look=` lives on the URL. Never persisted.

let declared = null;

export function declarePlatform(p) { declared = p; }

export function platformNow() {
  try {
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('surface');
      if (q === 'kiosk') return 'kiosk';
      if (q === 'desktop') return 'electron';
      if (q === 'phone') return 'phone-app';
      // Electron wins over a declaration: it loads the kiosk build from :3005 on
      // the laptop, and a desk screen is not a wall.
      if (window.saimNative) return 'electron';
      if (declared) return declared;
    }
  } catch { /* fall through */ }
  return declared || 'phone-app';
}

export function viewportWidth() {
  try { return typeof window !== 'undefined' ? window.innerWidth || 400 : 400; } catch { return 400; }
}
