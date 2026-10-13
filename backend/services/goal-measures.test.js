'use strict';

/**
 * Goal measures (13 Oct 2026). Pure rules, then the whole chain over real HTTP
 * and a scratch SQLite: save a goal with a measure → health rows → progress
 * and levers come back from /api/canonical/goals/progress.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-goalm-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.HA_TOKEN;

const db = require('../db/database');
const gm = require('./goal-measures');

// ── pure ────────────────────────────────────────────────────────────────────

test('validate: refuses unknown kinds and bad targets rather than clamping', () => {
  assert.equal(gm.validateMeasure(null).ok, true);
  assert.equal(gm.validateMeasure({ kind: 'vibes' }).ok, false);
  assert.equal(gm.validateMeasure({ kind: 'hikes', target: 4 }).ok, false, 'a hikes target needs a period');
  assert.equal(gm.validateMeasure({ kind: 'hikes', target: 0, period: 'week' }).ok, false);
  assert.equal(gm.validateMeasure({ kind: 'bp', target: { sys: 80, dia: 90 } }).ok, false, 'diastolic above systolic is a typo');
  assert.equal(gm.validateMeasure({ kind: 'weight', target: 3 }).ok, false);
  assert.equal(gm.validateMeasure({ kind: 'sleep', target: 7.5, by: '31/12/2026' }).ok, false);
  const ok = gm.validateMeasure({ kind: 'bp', target: { sys: 130.4, dia: 80 }, by: '2027-01-31', junk: 1 });
  assert.deepEqual(ok.measure, { kind: 'bp', target: { sys: 130, dia: 80 }, by: '2027-01-31' });
});

const day = (d, f) => ({ day: d, complete: true, ...f });
function series(from, n, fn) {
  const out = [];
  const [y, m, d] = from.split('-').map(Number);
  for (let i = 0; i < n; i += 1) {
    const k = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    out.push(day(k, fn(i)));
  }
  return out.reverse(); // newest first, as recentDays returns
}

test('bp: a missing reading is unknown, never behind', () => {
  const r = gm.evaluate({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } }, startDate: '2026-09-01' }, { today: '2026-10-13', days: [] });
  assert.equal(r.state, 'unknown');
  assert.match(r.line, /not enough/);
});

test('bp: falling from the baseline is on-track; rising is moving-away', () => {
  const falling = series('2026-08-20', 54, (i) => ({ bpSystolic: 152 - i * 0.3, bpDiastolic: 92 - i * 0.1 }));
  const r = gm.evaluate({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } }, startDate: '2026-09-01' }, { today: '2026-10-13', days: falling });
  assert.equal(r.state, 'on-track', r.line);
  assert.ok(r.current.sys < r.baseline.sys);
  const rising = series('2026-08-20', 54, (i) => ({ bpSystolic: 135 + i * 0.3, bpDiastolic: 85 }));
  const w = gm.evaluate({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } }, startDate: '2026-09-01' }, { today: '2026-10-13', days: rising });
  assert.equal(w.state, 'moving-away', w.line);
});

test('bp: met only when BOTH halves are at target', () => {
  const rows = series('2026-09-20', 23, () => ({ bpSystolic: 125, bpDiastolic: 84 }));
  const r = gm.evaluate({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } }, startDate: '2026-10-13' }, { today: '2026-10-13', days: rows });
  assert.notEqual(r.state, 'met', 'diastolic 84 is still above 80');
});

test('weight: direction comes from baseline vs target; a by-date judges pace', () => {
  // 100 → 96 over six weeks, target 90 by 31 Dec — needs ~1kg/fortnight… behind.
  const rows = series('2026-08-25', 50, (i) => ({ weightKg: 100 - i * 0.08 }));
  const r = gm.evaluate({ measure: { kind: 'weight', target: 90, by: '2026-11-15' }, startDate: '2026-09-01' }, { today: '2026-10-13', days: rows });
  assert.equal(r.direction, 'down');
  assert.equal(r.state, 'behind', r.line);
  const easy = gm.evaluate({ measure: { kind: 'weight', target: 95, by: '2027-06-01' }, startDate: '2026-09-01' }, { today: '2026-10-13', days: rows });
  assert.equal(easy.state, 'on-track', easy.line);
});

test('hikes: counts confirmed hikes in the period; impossible remainder is behind', () => {
  const hiking = { active: true, weekStart: '2026-10-12', reliability: { level: 'ok' },
    weeks: [{ start: '2026-10-12', confirmed: [] }, { start: '2026-10-05', confirmed: [{ day: '2026-09-28' }, { day: '2026-10-11' }] }] };
  const month = gm.evaluate({ measure: { kind: 'hikes', target: 4, period: 'month' } }, { today: '2026-10-13', hiking });
  assert.equal(month.current, 1, 'only 11 Oct is in October');
  const week = gm.evaluate({ measure: { kind: 'hikes', target: 1, period: 'week' } }, { today: '2026-10-13', hiking });
  assert.equal(week.current, 0);
  const late = gm.evaluate({ measure: { kind: 'hikes', target: 25, period: 'month' } }, { today: '2026-10-13', hiking });
  assert.equal(late.state, 'behind');
  assert.match(late.line, /can’t be met/);
  assert.equal(gm.evaluate({ measure: { kind: 'hikes', target: 1, period: 'week' } }, { today: '2026-10-13', hiking: null }).state, 'unknown');
});

test('project: a blocker or a quiet spell is said; completed is met', () => {
  const p = { projectId: 'p1', name: 'Website', status: { status: 'active' }, lastProgress: { at: '2026-09-01T10:00:00Z' }, tasks: { open: [{ id: 1 }] }, blockers: [], nextAction: { text: 'Draft the About page', taskId: 12 } };
  const r = gm.evaluate({ measure: { kind: 'project', projectId: 'p1' } }, { today: '2026-10-13', projects: [p] });
  assert.equal(r.state, 'not-moving');
  assert.match(r.line, /42 days ago/);
  const lev = gm.leversFor({ measure: { kind: 'project', projectId: 'p1' } }, r, { today: '2026-10-13' });
  assert.match(lev[0].title, /About page/);
  assert.match(lev[0].action, /#12/);
  assert.equal(gm.evaluate({ measure: { kind: 'project', projectId: 'p1' } }, { today: '2026-10-13', projects: [{ ...p, status: { status: 'completed' } }] }).state, 'met');
  assert.equal(gm.evaluate({ measure: { kind: 'project', projectId: 'gone' } }, { today: '2026-10-13', projects: [p] }).state, 'unknown');
});

test('levers: only insights in the measure’s lever domains, never good ones, never without an action', () => {
  const picture = { insights: [
    { id: 'nutrition-salt', domain: 'nutrition', level: 'act', title: 'Salt', action: 'Cut salt' },
    { id: 'weight-up', domain: 'weight', level: 'watch', title: 'Weight up', action: 'Watch it' },
    { id: 'bp-ok', domain: 'bp', level: 'good', title: 'Fine', action: null },
    { id: 'spo2-low', domain: 'oxygen', level: 'watch', title: 'SpO2', action: 'x' },
    { id: 'signal-x', domain: 'activity', level: 'watch', title: 'no action', action: null },
  ] };
  const lev = gm.leversFor({ measure: { kind: 'bp', target: { sys: 130, dia: 80 } } }, { state: 'behind' }, { picture, today: '2026-10-13' });
  assert.deepEqual(lev.map((l) => l.id), ['nutrition-salt', 'weight-up']);
  assert.ok(lev.every((l) => l.source === 'My Health'));
  assert.deepEqual(gm.leversFor({ measure: null }, null, { picture }), []);
});

test('hike levers name a good-weather day when none is planned', () => {
  const lev = gm.leversFor({ measure: { kind: 'hikes', target: 1, period: 'week' } }, { state: 'behind' },
    { today: '2026-10-13', outdoor: { plans: [], days: [{ day: '2026-10-17', state: 'favourable', line: 'Looks favourable — dry.' }] } });
  assert.match(lev[0].title, /Saturday/);
  assert.match(lev[0].action, /calendar entry titled “hike”/);
});

test('nothing in the wording diagnoses or claims cause', () => {
  const src = fs.readFileSync(path.join(__dirname, 'goal-measures.js'), 'utf8');
  for (const w of ['caused by', 'because you', 'diagnos(is|e) (of|that)']) assert.equal(new RegExp(w, 'i').test(src), false, w);
});

// ── real HTTP ───────────────────────────────────────────────────────────────

let server; let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/canonical', require('../routes/canonical'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json() }; };

test('route: save a goal with a type and a measure, read it back, refuse a bad one, clear with null', async () => {
  const bad = await post('/api/canonical/goals', { title: 'Lower BP', domains: ['health'], measure: { kind: 'bp', target: { sys: 300, dia: 80 } } });
  assert.equal(bad.status, 400);
  assert.equal(db.all('SELECT * FROM goals').length, 0, 'a refused measure writes nothing');

  const made = await post('/api/canonical/goals', { title: 'Lower BP', domains: ['health'], startDate: '2026-09-01', measure: { kind: 'bp', target: { sys: 130, dia: 80 } } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(made.json.goal.measure, { kind: 'bp', target: { sys: 130, dia: 80 } });
  const id = made.json.goal.id;

  const untouched = await post(`/api/canonical/goals/${encodeURIComponent(id)}`, { importance: 'important-to-me' });
  assert.deepEqual(untouched.json.goal.measure, { kind: 'bp', target: { sys: 130, dia: 80 } }, 'omitting measure leaves it');

  // Health rows: a falling average from 1 Sep.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  for (let i = 60; i >= 1; i -= 1) {
    const k = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
    db.run('INSERT OR REPLACE INTO health_daily (day, bp_systolic, bp_diastolic, complete) VALUES (?, ?, ?, 1)', [k, 130 + i * 0.4, 82 + i * 0.1]);
  }
  await post(`/api/canonical/goals/${encodeURIComponent(id)}`, { startDate: new Date(Date.UTC(y, m - 1, d - 40)).toISOString().slice(0, 10) });
  const prog = await get('/api/canonical/goals/progress');
  assert.equal(prog.status, 200);
  const g = prog.json.goals.find((x) => x.goalId === id);
  assert.ok(g && g.progress, JSON.stringify(prog.json));
  assert.equal(g.progress.state, 'on-track', g.progress.line);
  assert.ok(Array.isArray(g.levers));

  const cat = await get('/api/canonical/goals/measures');
  assert.ok(cat.json.measures.some((x) => x.kind === 'hikes' && x.periods.includes('month')));

  const cleared = await post(`/api/canonical/goals/${encodeURIComponent(id)}`, { measure: null });
  assert.equal(cleared.json.goal.measure, null);
});

test('a goal measured in hikes drives the hiking loop whatever its title', async () => {
  db.run("UPDATE goals SET status = 'dropped'");
  await post('/api/canonical/goals', { title: 'Get out on the hills', domains: ['fitness'], measure: { kind: 'hikes', target: 4, period: 'month' } });
  const loop = require('./hiking-loop').read({ weeks: 1 });
  assert.equal(loop.active, true);
  assert.equal(loop.goal.title, 'Get out on the hills');
});

// ── Caffeine (13 Oct 2026) ─────────────────────────────────────────────────
test('caffeine reads LOGGED, finished days only — an unlogged day is unknown, never 0 mg', () => {
  const G = require('./goal-measures');
  const nut = { days: [
    { day: '2026-10-13', today: true, logged: true, totals: { dietary_caffeine: 900 } },   // today: still being logged
    { day: '2026-10-12', today: false, logged: true, totals: { dietary_caffeine: 300 } },
    { day: '2026-10-11', today: false, logged: false, totals: {} },                         // nothing logged
    { day: '2026-10-10', today: false, logged: true, totals: { dietary_caffeine: 200 } },
    { day: '2026-10-09', today: false, logged: true, totals: { dietary_caffeine: 100 } },
  ] };
  const rows = G.nutritionDays(nut);
  assert.deepEqual(rows.map((r) => r.day), ['2026-10-12', '2026-10-10', '2026-10-09']);
  const v = G.healthValue('caffeine', rows, '2026-10-13');
  assert.equal(v.value, 200, 'mean of the three logged days, not of seven');
  assert.equal(v.n, 3);
  assert.equal(G.healthValue('caffeine', rows.slice(0, 2), '2026-10-13').value, null, 'two logged days is not enough to say');
});

test('a caffeine goal judges against the target, aiming down', () => {
  const G = require('./goal-measures');
  assert.equal(G.validateMeasure({ kind: 'caffeine', target: 200 }).ok, true);
  assert.equal(G.validateMeasure({ kind: 'caffeine', target: 5000 }).ok, false, 'refused, never clamped');
  const nutritionDays = ['2026-10-12', '2026-10-11', '2026-10-10'].map((day) => ({ day, complete: true, caffeineMg: 350 }));
  const p = G.evaluate({ measure: { kind: 'caffeine', target: 200 }, startDate: '2026-10-13' }, { today: '2026-10-13', nutritionDays });
  assert.equal(p.currentText, '350 mg/day');
  assert.notEqual(p.state, 'met');
  const ok = G.evaluate({ measure: { kind: 'caffeine', target: 400 }, startDate: '2026-10-13' }, { today: '2026-10-13', nutritionDays });
  assert.equal(ok.state, 'met');
  assert.equal(G.evaluate({ measure: { kind: 'caffeine', target: 200 } }, { today: '2026-10-13', nutritionDays: null }).state, 'unknown');
});
