// SARA shared UI-state — placeholder presentation content (WS2-WP1 / WS2A-WP1).
//
// Three UI-only fields that the WS1 State Engine model does not yet produce —
// "What Matters Now", "Up Next", and "Quick Actions" — live here. The build brief
// explicitly allows placeholder/static values for these, but they MUST live in the
// shared-state layer, NOT inside any screen component, so that no screen becomes a
// source of truth (charter principle 7; convergence failure condition: "state is
// hardcoded inside the screen instead of sourced from shared state").
//
// This is the ONE shared placeholder presentation layer for every view. Mission
// Control (WS2), and now Executive Dashboard and Presence (WS2A), all read these same
// fields through shared state — none of them owns or duplicates the content. The
// block is view-neutral on purpose: a screen formats and orders it, nothing more.
//
// It is the swappable seam for these fields, exactly like backend/src/state/seed.js
// is for the engine domains: a later work package replaces these literals with values
// derived from the State Engine model, and no screen changes — they already read them
// from shared state.
//
// `source: 'placeholder'` is stamped on the block so any consumer (and the UI) can
// tell this content is not derived from live state yet.

export const SHARED_PRESENTATION = {
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

  standup: {
    source: 'placeholder',
    yesterday: [
      'Portal login loop acknowledged and re-owned.',
      'Adele closed the duplicate-import investigation.',
    ],
    carryForward: [
      "Prep Willem's probation review.",
      'Tighten the QA coaching notes for Nathan.',
    ],
    prompts: [
      'What is carrying forward that still matters today?',
      'What needs blocking time before lunch?',
      'Who needs a direct nudge from you today?',
    ],
  },

  todos: {
    source: 'placeholder',
    items: [
      { id: 'todo-1', title: "Draft Willem's probation review", state: 'due-today' },
      { id: 'todo-2', title: 'Review Nathan coaching notes', state: 'watch' },
      { id: 'todo-3', title: 'Capture Q2 skills matrix actions', state: 'backlog' },
    ],
  },

  capture: {
    source: 'placeholder',
    shortcuts: [
      { id: 'cap-1', label: 'Quick note', detail: 'Drop a thought into the inbox.' },
      { id: 'cap-2', label: 'Todo', detail: 'Add a task without breaking flow.' },
      { id: 'cap-3', label: 'Follow-up', detail: 'Pin something for later review.' },
    ],
  },
};
