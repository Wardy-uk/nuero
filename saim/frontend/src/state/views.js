// View IDENTIFIERS — a vocabulary, no longer a screen registry.
//
// ⚠ WHAT THIS USED TO BE, and why it is smaller now. Until 31 Aug 2026 this was
// the kiosk's screen registry: fourteen entries with labels and blurbs, a
// `VIEW_REGISTRY` the ViewSwitcher rendered, and a `status` field claiming each
// one existed. All fourteen screens are gone — the kiosk mounts the phone's
// registry (`saim/shared-ui/tabs.jsx`) and both shells are one app now — so a
// registry describing screens nobody can reach was a document about a system
// that no longer exists. That is the shape that let a deleted Jira queue go on
// being read for seven weeks, and it does not get to stay.
//
// ⚠ WHY IT STILL EXISTS AT ALL. `state/saimState.jsx` threads these ids through
// ~888 lines of navigation that nothing currently renders: urgent-view
// snapshots, focus-action targets, interruption notices. Unpicking that is a
// real refactor with real regression risk, and none of it is on screen, so the
// honest interim is to keep the VOCABULARY those code paths speak and delete
// the part that lied — the claim that each id names a screen you can open.
//
// So: no registry, no labels, no blurbs, no `status: 'available'`. Just ids and
// the alias map, and a note saying what they are.
//
// TODO (not tonight): remove the view-selection half of `saimState` entirely,
// then delete this file. Until then, adding an id here does NOT create a screen.

/** Ids the legacy navigation paths in `saimState` still refer to. */
export const SAIM_VIEWS = {
  PRESENCE: 'presence',
  COGNITION: 'cognition',
  CONTEXT: 'context',
  BRIEFING: 'mission-control',
  SAiM: 'companion',
  STANDUP: 'standup',
  QUEUE: 'executive-dashboard',
  ATWORK: 'at-work',
  TEAM: 'team',
  FOCUS: 'focus',
  TODOS: 'todos',
  VAULT: 'vault',
  CAPTURE: 'capture',
  SETTINGS: 'settings',
};

const VIEW_ALIASES = {
  'mission-control': SAIM_VIEWS.BRIEFING,
  'executive-dashboard': SAIM_VIEWS.QUEUE,
  companion: SAIM_VIEWS.SAiM,
  'stream-deck': SAIM_VIEWS.CAPTURE,
};

// ⚠ The kiosk's starting screen is NOT decided here any more — `DEFAULT_TAB` in
// `saim/shared-ui/tabs.jsx` owns that, for both shells. This is only the value
// `saimState` initialises its unrendered `currentView` to.
export const DEFAULT_VIEW = SAIM_VIEWS.PRESENCE;

export function normalizeViewId(id) {
  return VIEW_ALIASES[id] || id;
}
