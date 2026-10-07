'use strict';

/**
 * Build 15 over real HTTP: the Activity timeline (mounted AHEAD of the old
 * /api/activity router — the order is the mechanism), the hiking loop, and the
 * authority guard refusing a machine that tries to write a hike into Nick's
 * record. Real api-auth → real guard → real routers → real SQLite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b15-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b.db');
process.env.NEURO_PIN = 'pin-1515';
process.env.NEURO_API_TOKEN = 'machine-token';
process.env.NEURO_TIMEZONE = 'Europe/London';

const db = require('../db/database');

let server;
let base;
test.before(async () => {
  await db.init();
  db.run(`INSERT INTO goals (goal_id, title, domains_json, status, created_at, updated_at) VALUES ('goal:h', 'Hike weekly', '["health"]', 'active', 'x', 'x')`);
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  // Same order as server.js.
  app.use('/api/activity/timeline', require('./activity-timeline'));
  app.use('/api/activity', require('./activity'));
  app.use('/api/loops', require('./loops'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const AS = { machine: { 'X-Neuro-Api-Token': 'machine-token' }, nick: { 'X-Neuro-Pin': 'pin-1515' } };
async function call(method, url, who, body) {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...AS[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('GET /api/activity/timeline answers the timeline (not swallowed by /api/activity), with today\'s summary', async () => {
  const r = await call('GET', '/api/activity/timeline', 'nick');
  assert.equal(r.status, 200);
  assert.equal(r.body.contract, 'activity-v1');
  assert.deepEqual(r.body.today.lines, ['No autonomous actions today.']);
  assert.ok(Array.isArray(r.body.pending) && r.body.pending.some((p) => /iOS Build 16 .* not yet built/.test(p.text)));
  const s = await call('GET', '/api/activity/timeline/summary', 'nick');
  assert.equal(s.status, 200);
  assert.ok(s.body.today);
  // The old router still answers its own paths.
  assert.equal((await call('GET', '/api/activity/today', 'nick')).status, 200);
  // A machine may read Activity.
  assert.equal((await call('GET', '/api/activity/timeline?filter=problems', 'machine')).status, 200);
});

test('a bad filter / limit / date is REFUSED, never quietly widened', async () => {
  assert.equal((await call('GET', '/api/activity/timeline?filter=everything', 'nick')).status, 400);
  assert.equal((await call('GET', '/api/activity/timeline?limit=0', 'nick')).status, 400);
  assert.equal((await call('GET', '/api/activity/timeline?from=yesterday', 'nick')).status, 400);
});

test('the hiking loop: readable; Nick can confirm and plan; a MACHINE cannot write a hike into his record', async () => {
  const r = await call('GET', '/api/loops/hiking', 'nick');
  assert.equal(r.status, 200);
  assert.equal(r.body.active, true);
  const today = r.body.today;
  const m = await call('POST', '/api/loops/hiking/confirm', 'machine', { day: today });
  assert.equal(m.status, 403);
  assert.equal(db.get('SELECT COUNT(*) n FROM goal_loop_entries').n, 0, 'nothing was written');
  assert.equal((await call('POST', '/api/loops/hiking/plan', 'machine', { day: today })).status, 403);
  const ok = await call('POST', '/api/loops/hiking/confirm', 'nick', { day: today, note: 'short one' });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/loops/hiking/confirm', 'nick', { day: 'tomorrow' })).status, 400);
  const after = await call('GET', '/api/loops/hiking', 'nick');
  assert.equal(after.body.current.recording, 'confirmed');
  const w = await call('POST', `/api/loops/hiking/entries/${ok.body.id}/withdraw`, 'nick');
  assert.equal(w.status, 200);
  assert.notEqual((await call('GET', '/api/loops/hiking', 'nick')).body.current.recording, 'confirmed', 'withdrawn is withdrawn');
  // The Activity timeline carries the plan/confirm transitions as Nick's.
  const t = await call('GET', '/api/activity/timeline', 'nick');
  assert.ok(t.body.entries.some((e) => e.type === 'goal.hike.done' && e.actor === 'nick'));
  assert.ok(t.body.entries.some((e) => e.type === 'goal.hike.withdrawn'), 'taking it back is said, not silently undone');
});
