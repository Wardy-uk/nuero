// Next steps on SAiM (3 Nov 2026) — the PURE half: where a row's Start goes,
// and which row a push or a link asked to open. Shared by the view and the
// shell so the two cannot disagree. No DOM, no fetch.

export const NEXT_STEPS_TAB = 'next-steps';

// NEURO desktop view id → the SAiM tab that does the same job. Anything not
// here opens NEURO desktop itself — a second, worse copy of a screen SAiM does
// not have is not a mobile version of it.
export const TAB_FOR_VIEW = Object.freeze({
  todos: 'tasks',
  tasks: 'tasks',
  drafts: 'drafts',
  'meeting-prep': 'prep',
  prep: 'prep',
  standup: 'standup',
  chat: 'chat',
  capture: 'capture',
  today: 'now',
  now: 'now',
  task: 'task',
});

export const NEURO_DESKTOP_URL = 'https://neuro.nickward.co.uk/';

/** PURE. The NEURO desktop link for a view, carrying any flat context values. */
export function desktopUrlFor(view, context = null) {
  const u = new URL(NEURO_DESKTOP_URL);
  u.searchParams.set('view', String(view || 'today'));
  if (context && typeof context === 'object') {
    for (const [k, v] of Object.entries(context)) {
      if (v == null || typeof v === 'object') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/**
 * PURE. What pressing a row's Start means on SAiM:
 *   { kind: 'act', action }       — caught-up / done-for-now → POST /act
 *   { kind: 'calendar' }          — open the inline add-to-calendar form
 *   { kind: 'tab', tab, context } — a SAiM tab does this job
 *   { kind: 'url', url }          — NEURO desktop, in a new window
 */
export function startPlan(item) {
  const start = (item && item.start) || {};
  if (start.action === 'caught-up' || start.action === 'done-for-now') return { kind: 'act', action: start.action };
  if (start.action === 'add-to-calendar') return { kind: 'calendar' };
  const tab = TAB_FOR_VIEW[start.view];
  if (tab) return { kind: 'tab', tab, context: start.context || null };
  return { kind: 'url', url: desktopUrlFor(start.view, start.context) };
}

/**
 * PURE. The row a launch asked for: a push carries `nextStep: "<item id>"` in
 * its data; a link carries `?tab=next-steps&item=<id>`. Returns the id, or null.
 */
export function nextStepFromLaunch({ tab = null, item = null, payload = null } = {}) {
  const fromPush = payload && typeof payload === 'object' && payload.nextStep;
  if (fromPush) return String(fromPush);
  if (tab === NEXT_STEPS_TAB && item) return String(item);
  return null;
}
