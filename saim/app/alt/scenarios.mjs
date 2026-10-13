// SAiM Alt — DEVELOPMENT SCENARIOS.
//
// Controlled, stable states for design review, so the desktop surface can be
// judged one behavioural mode at a time instead of on whatever the live day is
// doing. Activated ONLY on SAiM Alt, ONLY by an explicit `?scenario=<id>`, and
// loaded by a separate dynamic import — the control app never imports this
// file, and the live path never loads it.
//
// ⚠ Every fixture is the REAL canonical payload shape (`/api/canonical/now`,
//   plus `/api/session` and the page-activity signal). There is no alternate
//   data model and no client-side decision engine: the same renderer that
//   draws the live read draws these. Each is validated by
//   `model.checkCoherence` in the tests.
// ⚠ PURE DATA. No fetch, no storage, no side effects.

const DESK_APPS = (ids) => {
  const labels = {
    claude: 'Claude', chatgpt: 'ChatGPT', music: 'Music', outlook: 'Outlook', teams: 'Teams',
    obsidian: 'Obsidian', excel: 'Excel', word: 'Word', nova: 'NOVA', vantage: 'VANTAGE', neuro: 'NEURO',
    plaud: 'Plaud', browser: 'Browser', code: 'VS Code', terminal: 'Terminal', ssms: 'SSMS', postman: 'Postman',
  };
  return ids.map((id) => ({ id, label: labels[id] }));
};

const HOST = 'DESKTOP-8LGF9RR';

/** A coherent canonical read. Each scenario overrides only what it is about. */
function base(over = {}) {
  return {
    ok: true,
    contract: 'canonical-v1',
    generatedAt: '2026-10-14T10:20:00.000Z',
    poolAvailable: true,
    quiet: false,
    situation: { calm: false, calmSay: null },
    context: {
      activity: 'steady',
      place: { known: true, name: 'Office', source: 'owntracks', room: null, roomSubject: null, roomWhy: null },
      confidence: { level: 'high', rationale: 'Every input answered and they agree.' },
      unknowns: [],
      cannotSee: null,
    },
    life: { doing: 'working', label: 'Working', showWork: true, place: { kind: 'work', label: 'Office' } },
    operation: { phase: 'monitoring', label: 'MONITORING', detail: null },
    primary: null,
    secondary: [],
    work: {
      known: true, kind: 'app', task: null, taskIds: [], app: 'olk', confidence: 'low', source: 'desktop-activity',
      atDesk: true, deskKnown: true, host: HOST, why: 'you are at the laptop in Outlook — which says nothing about which task',
      canOpen: ['claude', 'music', 'word', 'outlook'],
      deskOffer: { known: true, host: HOST, why: null, apps: DESK_APPS(['claude', 'music', 'word', 'outlook']) },
    },
    dropped: [],
    approvals: { known: true, needsApproval: 0, needsReview: 0, byType: {}, where: 'Actions, in NEURO on the desktop', say: null },
    transition: null,
    nextMeeting: null,
    gaps: [],
    utterances: [],
    ...over,
  };
}

const SCENARIOS = {
  // ── working — the primary design target ────────────────────────────────
  working: {
    label: 'Working',
    localActive: true,
    session: { session: { active: true, status: 'active', text: 'Customer Care training plan and refreshers', nextStep: 'Draft the refresher headings' } },
    data: base({
      context: { ...base().context, activity: 'in-focus-session' },
      operation: { phase: 'monitoring', label: 'MONITORING', detail: null },
      work: {
        ...base().work,
        kind: 'session', task: 'Customer Care training plan and refreshers', taskIds: [412], confidence: 'high',
        source: 'focus-session', why: 'you started a session on this',
      },
      dropped: [
        { id: 'todo-overdue-summary', type: 'todo', why: 'in a focus session — held until you surface' },
        { id: 'email-urgent', type: 'email', why: 'in a focus session — held until you surface' },
      ],
      nextMeeting: { key: 'graph:demo@2026-10-14T14:30', subject: 'Support leads catch-up', time: '14:30' },
      utterances: [
        { say: 'Make it smaller', intent: { kind: 'session', action: 'shrink' } },
        { say: 'I’ve stepped away', intent: { kind: 'session', action: 'step-away' } },
        { say: 'That’s done', intent: { kind: 'session', action: 'finish' } },
      ],
    }),
  },

  // ── stuck — a known task, the next action blocked or too large ─────────
  stuck: {
    label: 'Stuck',
    localActive: true,
    session: { session: { active: true, status: 'active', text: 'Rewrite the escalation runbook', nextStep: null, shrinks: 2 } },
    data: base({
      context: { ...base().context, activity: 'in-focus-session' },
      primary: {
        kind: 'item', type: 'todo', recordId: 88, urgency: 'normal',
        title: 'Rewrite the escalation runbook',
        say: 'Rewrite the escalation runbook',
        reason: 'Blocked: the new SLA tiers aren’t agreed yet, and this has been made smaller twice without a step that holds.',
      },
      work: {
        ...base().work,
        kind: 'session', task: 'Rewrite the escalation runbook', taskIds: [377], confidence: 'high',
        source: 'focus-session', why: 'you started a session on this',
      },
      utterances: [
        { say: 'Make it smaller', intent: { kind: 'session', action: 'shrink' } },
        { say: 'Waiting on someone', intent: { kind: 'act', action: 'defer', recordId: 88, reason: 'waiting-on-someone', minutes: 240 } },
        { say: 'Not now', intent: { kind: 'act', action: 'defer', recordId: 88, reason: 'not-now', minutes: 60 } },
      ],
    }),
  },

  // ── transition — a meeting is about to start ───────────────────────────
  transition: {
    label: 'Transition',
    localActive: true,
    session: { session: { active: true, status: 'active', text: 'Customer Care training plan and refreshers', nextStep: 'Draft the refresher headings' } },
    data: base({
      context: { ...base().context, activity: 'pre-meeting' },
      operation: { phase: 'monitoring', label: 'MONITORING', detail: null },
      work: {
        ...base().work,
        kind: 'session', task: 'Customer Care training plan and refreshers', taskIds: [412], confidence: 'high',
        source: 'focus-session', why: 'you started a session on this',
      },
      transition: {
        kind: 'leave-now',
        prompt: '“Support leads catch-up” starts in 10 minutes.',
        question: 'Leave now, or open the prep?',
        options: ['prep', 'dismiss'],
        tab: 'prep',
        meta: { start: '2026-10-14T14:30:00', subject: 'Support leads catch-up', minutesAway: 10 },
      },
      nextMeeting: { key: 'graph:demo@2026-10-14T14:30', subject: 'Support leads catch-up', time: '14:30' },
      generatedAt: '2026-10-14T13:20:00.000Z',
    }),
  },

  // ── judgement — a drafted reply waits for approval ─────────────────────
  judgement: {
    label: 'Judgement',
    localActive: true,
    session: null,
    data: base({
      approvals: {
        known: true, needsApproval: 1, needsReview: 0, byType: { reply_email: 1 },
        where: 'Actions, in NEURO on the desktop',
        say: 'Your reply to Chris Middleton about the SLA review is drafted and waiting for your approval.',
      },
    }),
  },

  // ── calm — work time, desk active, nothing pressing ────────────────────
  calm: {
    label: 'Calm',
    localActive: true,
    session: null,
    data: base({
      situation: { calm: true, calmSay: 'Nothing needs you right now.' },
      operation: { phase: 'standing_by', label: 'STANDING BY', detail: null },
    }),
  },

  // ── home — at home, outside working hours ──────────────────────────────
  home: {
    label: 'Home',
    localActive: false,
    session: null,
    data: base({
      generatedAt: '2026-10-14T19:40:00.000Z',
      situation: { calm: true, calmSay: 'Nothing needs you right now.' },
      context: {
        ...base().context,
        activity: 'off',
        place: { known: true, name: 'unknown', source: 'owntracks', room: null, roomSubject: null, roomWhy: null },
      },
      life: { doing: 'relaxing', label: 'Relaxing', showWork: false, place: { kind: 'home', label: 'home' } },
      operation: { phase: 'standing_by', label: 'STANDING BY', detail: null },
      primary: { kind: 'context', id: 'context-off', title: 'Evening at home', reason: 'Evening at home', say: 'Evening at home', actions: [] },
      work: {
        known: true, kind: 'app', task: null, app: null, atDesk: false, deskKnown: true, host: HOST,
        why: 'the laptop is idle', canOpen: ['claude', 'music', 'word', 'outlook'],
        deskOffer: { known: true, host: HOST, apps: [], why: 'you’re not at the laptop' },
      },
      dropped: [
        { id: 'todo-overdue-summary', type: 'todo', why: 'off duty — held until tomorrow' },
        { id: 'capacity-over', type: 'capacity', why: 'off duty — held until tomorrow' },
        { id: 'email-urgent', type: 'email', why: 'off duty — held until tomorrow' },
      ],
    }),
  },

  // ── conflict — desk in use, watch heard elsewhere ──────────────────────
  conflict: {
    label: 'Conflict',
    localActive: true,
    session: null,
    data: base({
      context: {
        ...base().context,
        activity: 'steady',
        place: { known: true, name: 'unknown', source: 'owntracks', room: 'living-room', roomSubject: 'watch', roomWhy: null },
      },
      life: { doing: 'working', label: 'Working', showWork: true, place: { kind: 'home', label: 'home' } },
      primary: { kind: 'context', id: 'context-steady', title: 'Working from home', reason: 'Working from home', say: 'Working from home', actions: [] },
      work: {
        known: true, kind: 'app', task: null, app: null, atDesk: false, deskKnown: true, host: HOST,
        why: 'the laptop agent last reported no activity', canOpen: ['claude', 'music', 'word', 'outlook'],
        deskOffer: { known: true, host: HOST, apps: [], why: 'you’re not at the laptop' },
      },
    }),
  },
};

/**
 * The scenario for an id: `{ id, label, data, session, localActive }`, or null.
 * Returns deep copies, so nothing a renderer does can change a fixture.
 */
export function getScenario(id) {
  const s = Object.prototype.hasOwnProperty.call(SCENARIOS, id) ? SCENARIOS[id] : null;
  if (!s) return null;
  return JSON.parse(JSON.stringify({ id, ...s }));
}

export const SCENARIO_LIST = Object.freeze(Object.keys(SCENARIOS));
