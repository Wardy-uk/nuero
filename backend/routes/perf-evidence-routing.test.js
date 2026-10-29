'use strict';

/**
 * The performance evidence feed VANTAGE reads (29 Oct 2026).
 *
 * Real HTTP, real SQLite, a temp vault. Pins: the window is refused not
 * clamped; counter-evidence (overdue, late) is in the feed; personal tasks are
 * not; an unreadable vault is a named gap, not an empty meetings list.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-perf-ev-'));
process.env.NEURO_DB_PATH = path.join(scratch, 'scratch.db');
const vault = path.join(scratch, 'vault');
process.env.OBSIDIAN_VAULT_PATH = vault;
fs.mkdirSync(path.join(vault, 'Meetings', '2026', '10'), { recursive: true });

const express = require('express');
const db = require('../db/database');
const feed = require('../services/perf-evidence-feed');

let server;
let base;

before(async () => {
  await db.init();
  const raw = db.getDb();
  const ins = raw.prepare(`INSERT INTO tasks (text, status, due_date, domain, dedupe_key, completed_at, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('Write the escalation runbook', 'open', '2026-10-10', 'work', 'k1', null, 'commitment');
  ins.run('Book the dentist', 'open', '2026-10-10', 'personal', 'k2', null, null);
  ins.run('Send QA rubric to team', 'done', '2026-10-05', 'work', 'k3', '2026-10-08 09:00:00', 'improvement');
  ins.run('On time thing', 'done', '2026-10-09', 'work', 'k4', '2026-10-08 09:00:00', null);
  raw.prepare(`INSERT INTO wins (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at)
    VALUES ('2026-10-07','2026-10-07T10:00:00','git','commit','Shipped NOVA fix','abc',3,'w1','2026-10-07')`).run();
  raw.prepare(`INSERT INTO wins (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at)
    VALUES ('2026-10-07','2026-10-07T11:00:00','activity','task_done','Book my car in for its MOT','9',1,'w2','2026-10-07')`).run();
  fs.writeFileSync(path.join(vault, 'Meetings', '2026', '10', '2026-10-06 – Support Leadership.md'),
    '---\ntype: meeting\ndate: 2026-10-06\n---\n# Support Leadership\nRecording - Plaud ID: `abc`\n## Summary\nAgreed the [[QA framework|QA]] rollout.\n');
  fs.writeFileSync(path.join(vault, 'Meetings', '2026', '10', '2026-10-06 – Support Leadership 2.md'), '---\ntype: meeting\n---\ntwin');

  const app = express();
  app.use('/api/perf-evidence', require('./perf-evidence'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };

test('a junk or oversized window is refused, never clamped', async () => {
  assert.equal((await get('/api/perf-evidence/candidates?from=2026-10-01&to=lastweek')).status, 400);
  assert.equal((await get('/api/perf-evidence/candidates?from=2026-01-01&to=2026-03-01')).status, 400);
  assert.equal((await get('/api/perf-evidence/candidates?from=2026-10-09&to=2026-10-01')).status, 400);
  assert.equal(feed.parseWindow('2026-02-31', '2026-03-01').error, 'from must be YYYY-MM-DD');
});

test('the feed carries work, counter-evidence included, and never personal tasks', async () => {
  const { status, body } = await get('/api/perf-evidence/candidates?from=2026-10-01&to=2026-10-14');
  assert.equal(status, 200);
  const ids = body.items.map((i) => i.id);
  assert.ok(ids.includes('task-overdue:1:2026-10-10'), 'open work task past due is evidence against');
  assert.ok(!ids.some((i) => i.startsWith('task-overdue:2')), 'personal task leaked');
  assert.ok(ids.includes('task-late:3'), 'done after due date is in');
  assert.ok(!ids.includes('task-late:4'), 'done on time is not late');
  assert.ok(ids.includes('win:1'));
  assert.ok(!ids.includes('win:2'), 'a task completion from the wins ledger is not taken — it cannot tell work from personal');
  assert.ok(ids.includes('task-done:4'), 'a work task done on time comes from the tasks table');
  assert.ok(!ids.includes('task-done:3'), 'done late is task-late, not task-done');
  const meetings = body.items.filter((i) => i.kind === 'meeting');
  assert.equal(meetings.length, 1, 'the " 2" twin is skipped');
  assert.match(meetings[0].detail, /QA rollout/);
  assert.doesNotMatch(meetings[0].detail, /Plaud ID/);
  // Lateness is a fact, not a verdict: NEURO labels nothing 'against' (29 Oct 2026 —
  // a one-day slip on a fix Nick found and made had been sorted as evidence against him).
  assert.equal(body.items.find((i) => i.id === 'task-overdue:1:2026-10-10').hint, null);
  const late = body.items.find((i) => i.id === 'task-late:3');
  assert.equal(late.hint, null);
  assert.match(late.detail, /Done 2026-10-08 \(due 2026-10-05, 3 day\(s\) later\)/);
  assert.doesNotMatch(late.detail, /after its due date/);
  for (const s of Object.values(body.sources)) assert.equal(s.ok, true);
});

test('an employment matter keeps its title and loses its detail; a failing screen withholds', () => {
  const sensitive = feed.candidates({ from: '2026-10-01', to: '2026-10-14' }, { screen: () => ({ sensitive: true, categories: ['employee-cases-note'] }) });
  const m = sensitive.items.find((i) => i.kind === 'meeting');
  assert.equal(m.sensitive, true);
  assert.doesNotMatch(m.detail, /QA rollout/);
  assert.match(m.title, /Support Leadership/);
  assert.ok(!sensitive.items.some((i) => '_screenText' in i), 'the full text never leaves NEURO');
  const broken = feed.candidates({ from: '2026-10-01', to: '2026-10-14' }, { screen: () => { throw new Error('boom'); } });
  assert.equal(broken.items.find((i) => i.kind === 'meeting').sensitive, true);
  const clean = feed.candidates({ from: '2026-10-01', to: '2026-10-14' }, { screen: () => ({ sensitive: false, categories: [] }) });
  assert.match(clean.items.find((i) => i.kind === 'meeting').detail, /QA rollout/, 'positive control');
});

test('an unreadable vault is a named gap, not an empty meetings list', () => {
  const out = feed.candidates({ from: '2026-10-01', to: '2026-10-14' }, { vaultRoot: path.join(scratch, 'nope') });
  assert.equal(out.sources.meetings.ok, false);
  assert.match(out.sources.meetings.error, /Meetings/);
  assert.equal(out.sources.wins.ok, true);
});

test('a 1-2-1 is withheld by its title, and health or personal-life text by its words, whatever the injected screen says', () => {
  const { personalScreen, meetingText } = feed._internals;
  assert.equal(personalScreen({ title: 'Meeting: One-on-One 1 Tier Two Performance and Career Progression' }).sensitive, true);
  assert.equal(personalScreen({ title: 'Meeting: Return to work', text: '' }).sensitive, true);
  assert.equal(personalScreen({ title: 'Meeting: Jira review', text: 'The employee said a cyst had grown' }).sensitive, true);
  assert.equal(personalScreen({ title: 'Meeting: Stand-up', text: 'Maria has 30 tickets over five days' }).sensitive, false, 'positive control');
  const fence = String.fromCharCode(10);
  const cleaned = meetingText(['## Summary', '[](plaud://image?x=1)', '**A stand-up** on queues'].join(fence));
  assert.doesNotMatch(cleaned, /plaud:|\*\*|^Summary/m);
  fs.writeFileSync(path.join(vault, 'Meetings', '2026', '10', '2026-10-07 – 1-2-1 with Someone.md'), '---\ntype: meeting\n---\n## Summary\nTalked about their medical leave.\n');
  const out = feed.candidates({ from: '2026-10-01', to: '2026-10-14' }, { screen: () => ({ sensitive: false, categories: [] }) });
  const m = out.items.find((i) => /1-2-1 with Someone/.test(i.title));
  assert.equal(m.sensitive, true);
  assert.doesNotMatch(m.detail, /medical/);
});
