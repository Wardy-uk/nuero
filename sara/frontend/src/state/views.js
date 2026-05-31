// SARA view system — the "one state, many views" registry (WS2-WP1).
//
// Protected principle 7 (charter): SARA's UI must be view-based and
// interchangeable. Screens are *representations* of the one shared state model;
// they do not own data and they are not the architecture. This module is the
// canonical list of views and the current-view default — the structural proof
// that the project is NOT hardcoded around a single home screen.
//
// All six declared views now have real screens (Mission Control from WS2-WP1;
// Executive Dashboard + Presence from WS2A-WP1; Focus, Companion and Stream Deck added
// after). Companion is an honest v0 shell — it has no chat channel in the WS1 contract
// yet, so it presents shared state and a disabled composer rather than faking replies.
// The registry's `status` field stays the seam: a future view is added as `planned`
// (rendering the PlannedView fallback) until its screen is wired into ViewRouter, with
// no change to the shared-state model.
//
// This is the "view type definition" called for in the build brief, expressed in
// plain JS to match the existing converged runtime (React + Vite, no TypeScript).

// Canonical SaraView identifiers. The string value is the stable view id used in
// the registry, the router, and (later) the recommended/selected view in state.
export const SARA_VIEWS = {
  MISSION_CONTROL: 'mission-control',
  EXECUTIVE_DASHBOARD: 'executive-dashboard',
  PRESENCE: 'presence',
  FOCUS: 'focus',
  COMPANION: 'companion',
  STREAM_DECK: 'stream-deck',
};

// The view registry. Order here is the order views are offered in the UI. Every
// view is a representation of the same shared state — none of them is "the app".
//   status: 'available' -> a screen exists and renders now
//   status: 'planned'   -> reserved by the architecture; screen is a placeholder
export const VIEW_REGISTRY = [
  {
    id: SARA_VIEWS.MISSION_CONTROL,
    label: 'Mission Control',
    blurb: 'At-a-glance situational view: what matters now and up next.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.EXECUTIVE_DASHBOARD,
    label: 'Executive Dashboard',
    blurb: 'Queue, people and SLA metrics at depth.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.PRESENCE,
    label: 'Presence',
    blurb: 'Calm ambient view for when SARA is just present.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.FOCUS,
    label: 'Focus',
    blurb: 'One thing, timeboxed — the current do-next.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.COMPANION,
    label: 'Companion',
    blurb: 'Conversational companion mode.',
    status: 'available',
  },
  {
    id: SARA_VIEWS.STREAM_DECK,
    label: 'Stream Deck',
    blurb: 'Large touch-action grid for quick triggers.',
    status: 'available',
  },
];

// The view SARA opens on. Manual selection (charter: "manual user-selected view")
// is supported via the view switcher. As of WS5-WP1 the State Engine also derives a
// *recommended* view (model.inference.recommendedView), surfaced by RecommendedView —
// but it is ADVISORY ONLY: it never sets DEFAULT_VIEW or currentView on its own. SARA
// opens on Mission Control and only a user action changes the view.
export const DEFAULT_VIEW = SARA_VIEWS.MISSION_CONTROL;

export function getView(id) {
  return VIEW_REGISTRY.find((v) => v.id === id) || null;
}
