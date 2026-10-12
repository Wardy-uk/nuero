'use strict';

/**
 * The briefings through REAL routes over a real scratch database (12 Oct 2026).
 * Every gatherer is overridden, so nothing here touches NOVA, Graph, Jira, the
 * vault or the push service. Pins:
 *   - the email boundary: personal and health never reach the Nurtur mailbox,
 *     and a day off sends no email at all
 *   - delivery happens once per day
 *   - a push with no push_log row is reported UNKNOWN, never sent
 *   - literal routes are not swallowed by '/:id'
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-briefings-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.OBSIDIAN_VAULT_PATH;
delete process.env.NOVA_BRIDGE_URL;
delete process.env.NOVA_BRIDGE_SECRET;

const db = require('../db/database');
const briefings = require('../services/briefings');

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/briefings', require('./briefings'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) { server.closeAllConnections?.(); server.close(); } });

const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, json: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

const none = () => [];
function dailyOverrides({ off = false } = {}) {
  return {
    calendar: () => [],
    suppression: () => (off ? { suppressed: true, reason: 'weekend', source: 'calendar' } : { suppressed: false }),
    calendarReason: () => null,
    diary: none, oneToOnes: none, teamOff: none, commitments: none, email: none,
    escalations: () => [{ key: 'escalations:unseen', kind: 'escalations', sphere: 'work', needsYou: true, priority: 85, title: '2 escalations you haven’t replied to', items: ['NT-1 Broken feed'] }],
    tasks: () => [{ key: 'tasks:overdue:personal', kind: 'tasks-overdue', sphere: 'personal', needsYou: true, priority: 65, title: 'Book the dentist' }],
    radar: () => [{ key: 'radar:pd:helen', kind: 'radar-birthday', sphere: 'personal', priority: 75, needsYou: true, title: 'Helen’s birthday is on Friday' }],
    health: () => [{ key: 'health:rhr-elevated', kind: 'health-rhr-elevated', sphere: 'health', priority: 55, title: 'Resting heart rate up 3 days' }],
    weather: async () => 'cloudy, high 14°C',
  };
}

function fakeSend() {
  const sent = { push: [], email: [] };
  return {
    sent,
    send: {
      push: { sendToAll: async (title, body, data) => { sent.push.push({ title, body, data }); } },
      email: { sendBriefEmail: async (subject, html) => { sent.email.push({ subject, html }); return { sent: true }; } },
    },
  };
}

test('work day: the email carries WORK only — no personal, no health', async () => {
  const f = fakeSend();
  const now = new Date(2026, 9, 12, 8, 0); // Mon 12 Oct 08:00 local
  const b = await briefings.run('daily', { now, overrides: dailyOverrides(), send: f.send });
  assert.equal(b.dayType, 'work');
  assert.equal(f.sent.email.length, 1);
  const html = f.sent.email[0].html;
  assert.match(html, /NT-1 Broken feed/);
  assert.doesNotMatch(html, /dentist/);
  assert.doesNotMatch(html, /birthday/);
  assert.doesNotMatch(html, /heart rate/);
  // The screen keeps everything.
  const titles = b.payload.sections.flatMap((s) => s.items.map((i) => i.title));
  assert.ok(titles.includes('Book the dentist'));
  assert.ok(titles.includes('Resting heart rate up 3 days'));
});

test('a push with no push_log row is reported UNKNOWN, never sent', async () => {
  const b = briefings.get('daily', '2026-10-12');
  assert.equal(b.delivery.push.sent, false);
  assert.equal(b.delivery.push.outcome, 'unknown');
  assert.equal(b.delivery.email.sent, true);
});

test('delivery happens once per day; force re-delivers', async () => {
  const f = fakeSend();
  const now = new Date(2026, 9, 12, 8, 30);
  const again = await briefings.run('daily', { now, overrides: dailyOverrides(), send: f.send });
  assert.equal(again.skipped, 'already delivered today');
  assert.equal(f.sent.push.length, 0);
  await briefings.run('daily', { now, overrides: dailyOverrides(), send: f.send, force: true });
  assert.equal(f.sent.push.length, 1);
});

test('day off: no work at all, and NO email — with the reason recorded', async () => {
  const f = fakeSend();
  const now = new Date(2026, 9, 11, 8, 0); // Sunday
  const b = await briefings.run('daily', { now, overrides: dailyOverrides({ off: true }), send: f.send });
  assert.equal(b.dayType, 'off');
  const titles = b.payload.sections.flatMap((s) => s.items.map((i) => i.title));
  assert.ok(!titles.some((t) => /escalation/.test(t)));
  assert.equal(b.payload.held.work, 1);
  assert.equal(f.sent.email.length, 0);
  assert.match(b.delivery.email.reason, /day off/);
  assert.equal(f.sent.push.length, 1);
});

test('weekly: the email has KPIs and the SLM points, never blood pressure', async () => {
  const f = fakeSend();
  const now = new Date(2026, 9, 12, 8, 0);
  const b = await briefings.run('weekly', {
    now, send: f.send,
    overrides: {
      kpi: async () => ({ trend: [{ kpi: 'FRT Compliance (Open Queue)', measured: true, reported: { value: 91 }, compare: { value: 88 }, delta: 3, target: 90 }], csatRows: [{ key: 'csat-score', label: 'CSAT average score', now: '4.2/5', was: '4.0/5', delta: '▲ +0.2' }] }),
      volumes: async () => ({ series: [{ key: 'nt_legacy_new_tickets', points: [{ day: '2026-10-06', value: 40 }] }] }),
      leaderboard: async () => ({ ranked: [{ rank: 1, agentName: 'Top Person', compositeScore: 88, solved: 60, slaCompliancePct: 97, daysWorked: 5 }, { rank: 2, agentName: 'Last Person', compositeScore: 41, solved: 12, slaCompliancePct: 80, daysWorked: 5 }] }),
      slm: async () => ({ known: true, note: { name: '2026-10-09 – Support Leadership Meeting' }, highlights: ['Tier 2 SLA recovered'], lowlights: [], blockers: ['Dev ack slow'] }),
      bp: async () => [{ day: '2026-10-06', bpSystolic: 151, bpDiastolic: 91 }],
    },
  });
  assert.equal(f.sent.email.length, 1);
  const html = f.sent.email[0].html;
  assert.match(html, /FRT Compliance \(Open Queue\)/);
  assert.match(html, /Top Person/);
  assert.match(html, /Last Person/);
  assert.match(html, /Tier 2 SLA recovered/);
  assert.doesNotMatch(html, /151/);
  assert.equal(b.payload.bp.now.systolic, 151); // on the screen
  assert.match(f.sent.push[0].body, /CSAT 4\.2\/5/);
});

test('weekly: NOVA answering "ok" with no compliance rows is a named gap, never a short table', async () => {
  const f = fakeSend();
  const b = await briefings.run('weekly', {
    now: new Date(2026, 9, 12, 8, 0), send: f.send, force: true,
    overrides: {
      kpi: async () => ({ trend: [], csatRows: [] }),
      volumes: async () => ({ series: [] }),
      leaderboard: async () => ({ ranked: [] }),
      slm: async () => ({ known: false, why: 'none' }),
      bp: async () => [],
    },
  });
  assert.ok(b.payload.gaps.some((g) => /per-queue SLA/.test(g.source)));
});

test('routes: list, latest and /:id — literal paths are not read as an id', async () => {
  const list = await get('/api/briefings');
  assert.equal(list.status, 200);
  assert.ok(list.json.briefings.length >= 3);
  const latest = await get('/api/briefings/latest?kind=weekly');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.briefing.kind, 'weekly');
  const one = await get(`/api/briefings/${latest.json.briefing.id}`);
  assert.equal(one.json.briefing.id, latest.json.briefing.id);
  assert.equal((await get('/api/briefings/999999')).status, 404);
});

test('routes: feedback records and undoes; a junk kind is refused', async () => {
  const r = await post('/api/briefings/feedback', { kind: 'health-sleep' });
  assert.equal(r.json.count, 1);
  assert.ok(r.json.penalty > 0);
  const u = await post('/api/briefings/feedback', { kind: 'health-sleep', undo: true });
  assert.equal(u.json.count, 0);
  assert.equal((await post('/api/briefings/feedback', { kind: '' })).status, 400);
});

test('routes: run refuses an unknown kind', async () => {
  assert.equal((await post('/api/briefings/run', { kind: 'hourly' })).status, 400);
});
