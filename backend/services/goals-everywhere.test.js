'use strict';

/**
 * Goals beyond the Goals card (15 Oct 2026): My Health, Outdoor/Projects, the
 * Monday briefing and chat. Pure shapers first, then the real routes over a
 * scratch SQLite, then real renders via esbuild.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-goalsx-')), 'a.db');
delete process.env.HA_TOKEN;

const db = require('../db/database');
const gm = require('./goal-measures');
const weekly = require('./briefing-weekly');
const briefings = require('./briefings');

// ── pure ────────────────────────────────────────────────────────────────────

const goal = (id, kind, extra = {}) => ({ id, title: `Goal ${id}`, status: 'active', domains: [], measure: kind ? { kind, ...extra } : null });

test('healthView: health measures only, on their tile, and the insights each bears on', () => {
  const read = { goals: [
    { goalId: 'a', progress: { state: 'behind', line: 'x', targetText: '130/80' }, levers: [
      { id: 'nutrition-salt', source: 'My Health' }, { id: 'hike-weather', source: 'Forecast' }] },
    { goalId: 'b', progress: { state: 'on-track', line: 'y' }, levers: [] },
    { goalId: 'c', progress: { state: 'met', line: 'z' }, levers: [{ id: 'activity-low', source: 'My Health' }] },
  ] };
  const v = gm.healthView(read, [
    goal('a', 'bp', { target: { sys: 130, dia: 80 } }),
    goal('b', 'hikes', { target: 2, period: 'week' }),
    { ...goal('c', 'steps', { target: 8000 }), status: 'paused' },
    goal('d', null),
  ]);
  assert.deepEqual(v.goals.map((g) => g.goalId), ['a', 'c'], 'hikes and unmeasured goals are not health goals');
  assert.equal(v.bySystem.bp[0].state, 'behind');
  assert.equal(v.bySystem.activity[0].state, 'paused');
  assert.deepEqual(Object.keys(v.byInsight), ['nutrition-salt'], 'only My Health levers, only from active goals');
  assert.deepEqual(v.goals.find((g) => g.goalId === 'c').levers, [], 'a paused goal lends nothing');
});

test('goalsWeek: needing-help first, unmeasured counted not judged, unread is unknown', () => {
  const w = weekly.goalsWeek({ goals: [
    { title: 'A', measure: { kind: 'bp' }, progress: { state: 'met', line: 'a' }, levers: [] },
    { title: 'B', measure: { kind: 'hikes' }, progress: { state: 'behind', line: 'b' }, levers: [{ title: 't', action: 'Plan Saturday', source: 'Forecast' }] },
    { title: 'C', measure: null, progress: null, levers: [] },
    { title: 'D', measure: { kind: 'sleep' }, paused: true },
  ] });
  assert.deepEqual(w.items.map((i) => i.title), ['B', 'A']);
  assert.equal(w.items[0].help.action, 'Plan Saturday');
  assert.equal(w.unmeasured, 1);
  assert.equal(weekly.goalsWeek(null).known, false);
});

test('the weekly push names goals; the work email never mentions them', () => {
  const p = { weeks: { report: { from: '2026-10-05', to: '2026-10-11' } }, csatRows: [], sla: [], volumes: [],
    goals: { known: true, items: [{ state: 'behind' }, { state: 'on-track' }] }, gaps: [{ source: 'your goals', why: 'x' }] };
  assert.match(briefings.weeklyPush(p).body, /Goals: 1 on track, 1 needs a push/);
  const html = briefings.weeklyEmailHtml({ ...p, slm: null, leaderboard: null }) || '';
  assert.doesNotMatch(html, /goal/i);
});

// ── real routes ─────────────────────────────────────────────────────────────

let server; let base;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
test.before(async () => {
  await db.init();
  const now = Date.now();
  for (let d = 1; d <= 10; d += 1) {
    const at = sqlTime(now - d * 86400000);
    db.insertHealthSample('blood_pressure_systolic', 146, at, 'test');
    db.insertHealthSample('blood_pressure_diastolic', 87, at, 'test');
  }
  require('./health-daily').sync({ days: 14 });
  const app = express();
  app.use(express.json());
  app.use('/api/health', require('../routes/health'));
  app.use('/api/canonical', require('../routes/canonical'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const json = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json() }; };
const post = (p, b) => json(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

test('My Health carries the BP goal on its tile, and the GP-review finding bears on it', async () => {
  await post('/api/canonical/goals', { title: 'Lower my blood pressure', domains: ['health'], measure: { kind: 'bp', target: { sys: 130, dia: 80 } } });
  await post('/api/canonical/goals', { title: 'Hills', domains: ['fitness'], measure: { kind: 'hikes', target: 4, period: 'month' } });
  const { status, body } = await json('/api/health/picture');
  assert.equal(status, 200);
  assert.equal(body.contract, 'health-picture-v1', 'the picture itself is unchanged');
  assert.equal(body.goals.contract, 'health-goals-v1');
  assert.deepEqual(body.goals.goals.map((g) => g.kind), ['bp']);
  assert.equal(body.goals.bySystem.bp[0].title, 'Lower my blood pressure');
  assert.ok(body.goals.byInsight['bp-high'], `bp-high should bear on the goal: ${JSON.stringify(Object.keys(body.goals.byInsight))}`);
});

test('progress narrows by kind, and refuses a kind it does not know', async () => {
  const hikes = await json('/api/canonical/goals/progress?kinds=hikes');
  assert.deepEqual(hikes.body.goals.map((g) => g.title), ['Hills']);
  assert.equal((await json('/api/canonical/goals/progress?kinds=hikes,vibes')).status, 400);
});

test('chat get_goals answers from the same judgement, unmeasured said as such', async () => {
  await post('/api/canonical/goals', { title: 'Read more', domains: ['leisure'] });
  const r = await require('./chat-tools').execute('get_goals', {});
  assert.equal(r.ok, true);
  const bp = r.goals.find((g) => g.title === 'Lower my blood pressure');
  assert.equal(bp.measured_by, 'Blood pressure');
  assert.ok(bp.what_would_help.length > 0);
  assert.equal(r.goals.find((g) => g.title === 'Read more').state, 'not measured');
});

// ── renders ─────────────────────────────────────────────────────────────────

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');
async function bundle(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'leaflet'],
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
    logLevel: 'silent',
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}
const html = (el) => renderToString(el).replace(/<!-- -->/g, '');

test('My Health renders the goals section, the tile goal and "bears on your goal"', async () => {
  const { MyHealthView } = await bundle('MyHealthPanel.jsx');
  const { body } = await json('/api/health/picture');
  const out = html(React.createElement(MyHealthView, { data: body, onNavigate() {} }));
  assert.match(out, /Your health goals/);
  assert.match(out, /Lower my blood pressure/);
  assert.match(out, /Goal 130\/80 ·/);
  assert.match(out, /Bears on your goal: Lower my blood pressure/);
  assert.doesNotMatch(out, /mh-insight--act[^"]*"[^>]*>\s*<div class="mh-insight-head"><span class="mh-chip mh-chip--act">Behind/, 'a slow goal is never painted as a fault');
});

test('My Health with no measured goal says how to set one, not nothing', async () => {
  const { HealthGoals } = await bundle('MyHealthPanel.jsx');
  assert.match(html(React.createElement(HealthGoals, { goals: { known: true, goals: [] } })), /None measured/);
  assert.match(html(React.createElement(HealthGoals, { goals: { known: false, why: 'x' } })), /not “no goals”/);
});

test('the goal note renders on Outdoor/Projects only when a goal applies', async () => {
  const { GoalNoteView } = await bundle('canonical/GoalsCard.jsx');
  assert.equal(html(React.createElement(GoalNoteView, { rows: [] })), '');
  const out = html(React.createElement(GoalNoteView, { rows: [{ goalId: 'g', title: 'Hills', progress: { state: 'behind', line: '1 of 4 this month' }, levers: [{ action: 'Plan Saturday' }] }] }));
  assert.match(out, /Your goal/);
  assert.match(out, /1 of 4 this month/);
  assert.match(out, /→ Plan Saturday/);
});

test('the weekly briefing renders goals with their one suggestion', async () => {
  const { GoalsWeek } = await bundle('BriefingsPanel.jsx');
  const out = html(React.createElement(GoalsWeek, { g: { known: true, items: [{ title: 'Hills', state: 'behind', line: '1 of 4', help: { action: 'Plan Saturday', source: 'Forecast' } }] } }));
  assert.match(out, /Your goals/);
  assert.match(out, /behind/);
  assert.match(out, /→ Plan Saturday/);
  assert.match(html(React.createElement(GoalsWeek, { g: { known: false } })), /not the same as “no progress”/);
});
