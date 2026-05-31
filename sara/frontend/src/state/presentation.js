// SARA shared UI-state — placeholder presentation content (WS2-WP1).
//
// Mission Control introduces three NEW UI-only fields that the WS1 State Engine
// model does not yet produce: "What Matters Now", "Up Next", and "Quick Actions".
// The build brief explicitly allows placeholder/static values for these — but they
// MUST live in the shared-state layer, NOT inside the screen component, so that no
// screen becomes a source of truth (charter principle 7; convergence failure
// condition: "state is hardcoded inside the screen instead of sourced from shared
// state").
//
// This module is that home. It is the swappable seam for these fields, exactly like
// backend/src/state/seed.js is for the engine domains: a later work package replaces
// these literals with values derived from the State Engine model, and the Mission
// Control screen does not change — it already reads them from shared state.
//
// `source: 'placeholder'` is stamped on the block so any consumer (and the UI) can
// tell this content is not derived from live state yet.

export const MISSION_CONTROL_PRESENTATION = {
  source: 'placeholder',

  // What Matters Now — the few things SARA would put in front of you right now.
  whatMattersNow: [
    {
      id: 'wmn-1',
      title: 'Two tickets breaching SLA',
      detail: 'Portal login loop and bulk export timeout both need a holding reply.',
      tone: 'urgent',
    },
    {
      id: 'wmn-2',
      title: "Willem's probation review is tomorrow",
      detail: 'Nothing drafted yet. 20 minutes now saves a scramble.',
      tone: 'attention',
    },
    {
      id: 'wmn-3',
      title: 'Nathan has gone quiet',
      detail: 'No ticket response logged since Wednesday.',
      tone: 'watch',
    },
  ],

  // Up Next — what is coming, in order, so the screen reads like a calm runway.
  upNext: [
    { id: 'next-1', time: '11:00', label: 'Stand-up with the support team' },
    { id: 'next-2', time: '13:30', label: '1-2-1 with Adele' },
    { id: 'next-3', time: '15:00', label: 'Probation review prep block' },
  ],

  // Quick Actions — large touch targets. These are intent placeholders for WS2-WP1;
  // wiring them to real handlers is a later work package. `action` is a stable id a
  // future handler map can switch on.
  quickActions: [
    { id: 'qa-capture', label: 'Capture', action: 'capture', icon: '✎' },
    { id: 'qa-queue', label: 'Open Queue', action: 'open-queue', icon: '▤' },
    { id: 'qa-focus', label: 'Start Focus', action: 'start-focus', icon: '◎' },
    { id: 'qa-brief', label: 'Daily Brief', action: 'daily-brief', icon: '☼' },
  ],
};
