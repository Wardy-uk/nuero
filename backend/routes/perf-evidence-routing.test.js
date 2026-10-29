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
  fs.writeFileSync(path.join(vault, 'Meetings', '2026', '10', '2026-10-06 – Support Leadership.md'),
    '---\ntype: meeting\ndate: 2026-10-06\n---\n# Support Leadership\n## Summary\nAgreed the [[QA framework|QA]] rollout.\n');
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
  const meetings = body.items.filter((i) => i.kind === 'meeting');
  assert.equal(meetings.length, 1, 'the " 2" twin is skipped');
  assert.match(meetings[0].detail, /QA rollout/);
  assert.equal(body.items.find((i) => i.id === 'task-overdue:1:2026-10-10').hint, 'against');
  for (const s of Object.values(body.sources)) assert.equal(s.ok, true);
});

test('an unreadable vault is a named gap, not an empty meetings list', () => {
  const out = feed.candidates({ from: '2026-10-01', to: '2026-10-14' }, { vaultRoot: path.join(scratch, 'nope') });
  assert.equal(out.sources.meetings.ok, false);
  assert.match(out.sources.meetings.error, /Meetings/);
  assert.equal(out.sources.wins.ok, true);
});
