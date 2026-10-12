'use strict';

/**
 * Does the Briefings screen DRAW what the server composed (12 Oct 2026)?
 * DailyView / WeeklyView take the stored briefing as a prop, so a real render
 * reaches the branches (the container fetches in useEffect, which
 * renderToString never runs). A gap must render as a gap, never as nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const FILE = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'BriefingsPanel.jsx');

let mod = null;
async function load() {
  if (mod) return mod;
  const out = await esbuild.build({
    entryPoints: [FILE], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js',
        }));
      },
    }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
  return mod;
}

const daily = {
  id: 1, kind: 'daily', delivery: { push: { sent: true }, email: { sent: false, reason: 'day off — nothing work-related' } },
  payload: {
    dayLabel: 'Sunday 11 October', dayType: 'off', dayReason: 'weekend', context: { weather: 'cloudy, high 14°C' },
    sections: [
      { id: 'needs-you', label: 'Needs you', items: [{ key: 'radar:pd:helen', kind: 'radar-birthday', sphere: 'personal', needsYou: true, title: 'Helen’s birthday is on Friday', items: [] }] },
      { id: 'worth-knowing', label: 'Worth knowing', items: [{ key: 'health:sleep', kind: 'health-sleep', sphere: 'health', title: 'Slept 5h40 — usually 7h50 on a Sunday', why: 'More than an hour off.', items: [] }] },
    ],
    gaps: [{ source: 'your diary', why: 'the calendar cache is empty' }],
    held: { work: 3, belowBar: 2, overBudget: 0 },
    close: 'That’s everything that needs you. I couldn’t read your diary, so this isn’t the whole picture.',
  },
};

test('daily: sections, the day-off badge, held counts and the gap all render', async () => {
  const { DailyView } = await load();
  const html = renderToString(React.createElement(DailyView, { briefing: daily, onNotUseful: () => {} }));
  assert.match(html, /Needs you/);
  assert.match(html, /Helen’s birthday is on Friday/);
  assert.match(html, /Day off — weekend/);
  assert.match(html, /3 work items \(day off\)/);
  assert.match(html, /Couldn’t read:/);
  assert.match(html, /your diary/);
  assert.match(html, /Email not sent \(day off/);
});

test('daily: "Not useful" is offered on context, never on something that needs you', async () => {
  const { DailyView } = await load();
  const html = renderToString(React.createElement(DailyView, { briefing: daily, onNotUseful: () => {} }));
  assert.equal((html.match(/Not useful/g) || []).length, 1);
});

test('weekly: KPIs, volumes, leaderboard, SLM and BP render; unmeasured says so', async () => {
  const { WeeklyView } = await load();
  const weekly = {
    id: 2, kind: 'weekly', delivery: null,
    payload: {
      weeks: { report: { from: '2026-10-05', to: '2026-10-11' } },
      csatRows: [{ key: 'csat-score', label: 'CSAT average score', now: '4.2/5', was: '4.0/5', delta: '▲ +0.2' }],
      supportSla: {
        frt: { label: 'FRT compliance % (Support: CC + T2 + Prod)', target: 95, delta: 1.2, now: { pct: 96.1, met: 600, breached: 24, days: 7 }, was: { pct: 94.9, met: 0, breached: 0, days: 7 } },
        res: { label: 'Resolution compliance % (Support: CC + T2 + Prod)', target: 95, delta: -2, now: { pct: 88.4, met: 540, breached: 71, days: 5 }, was: { pct: 90.4, met: 0, breached: 0, days: 7 } },
      },
      sla: [
        { kpi: 'FRT Compliance (Open Queue)', measured: true, now: 88, was: 91, delta: -3, target: 90 },
        { kpi: 'Resolution Compliance (Tier 3)', measured: false, now: null, was: null, delta: null, target: null, lastSeen: '2026-09-29' },
      ],
      volumes: [{ name: 'raised', flow: true, now: 210, nowDays: 5, was: 190, delta: 20 }, { name: 'backlogDevelopment', flow: false, now: 64, asOf: '2026-10-11', was: 60, delta: 4 }],
      leaderboard: { top: { agentName: 'Top Person', compositeScore: 88, solved: 60, slaCompliancePct: 97, daysWorked: 5 }, weakest: { agentName: 'Last Person', compositeScore: 41, solved: 12, slaCompliancePct: 80, daysWorked: 5 }, rankedCount: 9, unranked: [] },
      slm: { known: true, note: { name: '2026-10-09 – Support Leadership Meeting' }, highlights: ['Tier 2 SLA recovered'], lowlights: [], blockers: ['Dev ack slow'] },
      bp: { now: { days: 4, systolic: 149, diastolic: 90 }, was: { days: 0 } },
      gaps: [], close: 'Everything above was read.',
    },
  };
  const html = renderToString(React.createElement(WeeklyView, { briefing: weekly })).replace(/<!-- -->/g, '');
  assert.match(html, /CSAT average score/);
  // The per-queue breakdown is its own tile, after the team tile (Nick, 12 Oct).
  assert.ok(html.indexOf('SLA by queue') > html.indexOf('Team SLA and CSAT'));
  assert.match(html, /FRT compliance % \(Support: CC \+ T2 \+ Prod\)/);
  assert.match(html, /600 of 624 tickets/);
  assert.match(html, /540 of 611 tickets, 5\/7 days/);
  // One decimal on the team rows: 94.7 must never read as a met 95%.
  assert.match(html, /88\.4%/);
  assert.match(html, /90% · missed/);
  assert.match(html, /not measured \(last 2026-09-29\)/);
  assert.match(html, /5\/7 days captured/);
  assert.match(html, /Top Person/);
  assert.match(html, /Weakest:/);
  assert.match(html, /Tier 2 SLA recovered/);
  assert.match(html, /Nothing recorded/);
  assert.match(html, /149\/90 mmHg/);
  assert.match(html, /Not delivered/);
});

test('daily toggle: Work shows only work, Personal only personal and health', async () => {
  const { DailyView } = await load();
  const work = renderToString(React.createElement(DailyView, { briefing: daily, mode: 'work' })).replace(/<!-- -->/g, '');
  assert.doesNotMatch(work, /Helen’s birthday/);
  assert.match(work, /Nothing work-related earned a place today/);
  const personal = renderToString(React.createElement(DailyView, { briefing: daily, mode: 'personal' })).replace(/<!-- -->/g, '');
  assert.match(personal, /Helen’s birthday/);
  assert.match(personal, /Slept 5h40/);
  assert.match(personal, /Showing personal only/);
});

test('weekly toggle: Personal hides the KPIs and shows the week ahead and the body', async () => {
  const { WeeklyView } = await load();
  const b = { id: 9, kind: 'weekly', delivery: null, payload: {
    weeks: { report: { from: '2026-10-05', to: '2026-10-11' } },
    csatRows: [{ key: 'csat-score', label: 'CSAT average score', now: '3.7 / 5', was: '3.0 / 5', delta: '▲' }],
    sla: [], volumes: [], leaderboard: null, slm: null,
    bp: { now: { days: 7, systolic: 144, diastolic: 85 }, was: { days: 7, systolic: 145, diastolic: 86 } },
    health: { sleepHours: { now: { days: 7, median: 7.5 }, was: { days: 7, median: 8 }, delta: -0.5 }, restingHr: { now: { days: 7, median: 76 }, was: { days: 6, median: 74 }, delta: 2 } },
    weekAhead: { known: true, items: [{ title: 'Helen’s birthday', date: '2026-10-16', needsYou: true }] },
    gaps: [], close: 'Everything above was read.',
  } };
  const personal = renderToString(React.createElement(WeeklyView, { briefing: b, mode: 'personal' })).replace(/<!-- -->/g, '');
  assert.doesNotMatch(personal, /CSAT average score/);
  assert.match(personal, /Your week ahead/);
  assert.match(personal, /Helen’s birthday/);
  assert.match(personal, /7h30/);
  assert.match(personal, /144\/85 mmHg/);
  const work = renderToString(React.createElement(WeeklyView, { briefing: b, mode: 'work' }));
  assert.match(work, /CSAT average score/);
  assert.doesNotMatch(work, /Your week ahead/);
  const unread = { ...b, payload: { ...b.payload, weekAhead: { known: false, items: [] } } };
  assert.match(renderToString(React.createElement(WeeklyView, { briefing: unread, mode: 'personal' })), /not the same as an empty week/);
});

test('an empty store renders a plain "none yet", not a crash', async () => {
  const { DailyView, WeeklyView } = await load();
  assert.match(renderToString(React.createElement(DailyView, { briefing: null })), /No daily briefing yet/);
  assert.match(renderToString(React.createElement(WeeklyView, { briefing: null })), /No weekly briefing yet/);
});
