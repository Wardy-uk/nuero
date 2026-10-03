/**
 * Retired NEURO view ids and where they now land (Build 10).
 *
 * A retired screen keeps its id working — old links, `?view=` launch intents,
 * notifications and muscle memory all still arrive somewhere sensible — but
 * nothing renders it. One map, used by the launch intent AND by navigation,
 * so the sidebar highlights the screen actually shown.
 *
 *  briefing, focus  → merged into Now (Build 10E). Both answered "what should
 *                     I do now?", which Now answers canonically.
 *  qa               → retired: its upstream webhook answers 404 and it had
 *                     no opens in 60 days.
 *  strava           → retired: never authenticated; activity arrives through
 *                     Apple Health. Strava's API is a dead end.
 *  kpi-tracker      → departmental; lives in VANTAGE. Lands on a hand-off.
 *  plan             → retired in Build 9 (the 90-day plan ended).
 */
export const RETIRED_VIEWS = Object.freeze({
  briefing: 'today',
  focus: 'today',
  qa: 'today',
  strava: 'today',
  plan: 'today',
  'kpi-tracker': 'moved-vantage',
});

export function canonicalView(id) {
  if (!id) return 'today';
  return Object.prototype.hasOwnProperty.call(RETIRED_VIEWS, id) ? RETIRED_VIEWS[id] : id;
}

export const VANTAGE_URL = 'https://vantage.nickward.co.uk';
