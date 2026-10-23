// The SAiM desktop workspace gate (Build Brief 003, Option B, 23 Oct 2026).
//
// PURE — no fetch, no DOM. The server switch `saim_desktop_workspace` (Settings
// → Switches) decides whether NEURO Desktop opens on SAiM instead of Now. Every
// branch that cannot be sure answers OFF, because off is exactly today's
// behaviour: Now is the home and nothing moves.

export const SAIM_FLAG = 'saim_desktop_workspace';
export const SAIM_VIEW = 'saim';
export const NOW_VIEW = 'today';

/**
 * Is the switch on, read from a GET /api/feature-flags answer?
 * Unreadable, malformed, a failed request, a missing key, or anything other
 * than `enabled === true` → false.
 */
export function flagEnabled(json, key = SAIM_FLAG) {
  try {
    if (!json || typeof json !== 'object' || json.ok === false || !Array.isArray(json.flags)) return false;
    const f = json.flags.find((x) => x && x.key === key);
    return Boolean(f && f.enabled === true);
  } catch {
    return false;
  }
}

/** Where a launch with NO explicit `?view=` or `?item=` lands. */
export function homeView(flagOn) {
  return flagOn === true ? SAIM_VIEW : NOW_VIEW;
}

/**
 * Should the shell move from Now to SAiM once the switch has been read?
 * Only for a default launch (no `?view=` / `?item=`), only while still on Now,
 * and only when the switch is positively on. `?view=today` therefore always
 * shows Now.
 */
export function shouldOpenSaim({ defaultLaunch, activeView, flagOn }) {
  return defaultLaunch === true && activeView === NOW_VIEW && flagOn === true;
}

/** Does the current URL carry an explicit launch target? */
export function isDefaultLaunch(search) {
  try {
    const p = new URLSearchParams(search || '');
    return !p.get('view') && !p.get('item');
  } catch {
    return false;
  }
}
