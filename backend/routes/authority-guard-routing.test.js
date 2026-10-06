'use strict';

/**
 * Build 14Z — the action surface, over real HTTP.
 *
 * The REAL auth middleware (services/api-auth.js, moved out of server.js for
 * exactly this) → the REAL authority guard → the REAL routers. Microsoft is
 * faked one layer below ms-complete (the service's Graph call), never at the
 * route, so the ledger, the bounds and the read-back handling all run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-authguard-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;
process.env.NEURO_PIN = 'pin-1111';
process.env.NEURO_API_TOKEN = 'machine-token';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-token';
delete process.env.SOURCE_BLIND_MODE;

const db = require('../db/database');
const microsoft = require('../services/microsoft');
const ext = require('../services/external-writes');

let server;
let base;
const graphCalls = [];

test.before(async () => {
  await db.init();
  microsoft.completeMicrosoftTask = async (msId) => {
    graphCalls.push(msId);
    return { completed: true, kind: 'planner', readback: 'confirmed', rolled: null };
  };
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/todos', require('./todos'));
  app.use('/api/microsoft', require('./microsoft'));
  app.use('/api/prepared-actions', require('./prepared-actions'));
  app.use('/api/feature-flags', require('./feature-flags'));
  app.use('/api/escalation', require('./escalation'));
  app.use('/api/rooms', require('./rooms'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

const AS = {
  machine: { 'X-Neuro-Api-Token': 'machine-token' },
  nick: { 'X-Neuro-Pin': 'pin-1111' },
  declared: { 'X-Neuro-Pin': 'pin-1111', 'X-Neuro-Machine-Client': 'mcp-local' },
  kiosk: { 'X-Neuro-Kiosk-Token': 'kiosk-token' },
};
async function call(method, url, who, body) {
  const r = await fetch(`${base}${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...AS[who] }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const refusals = () => db.all("SELECT * FROM activity_log WHERE event_type = 'authority_refused'");

// 1 — the arbitrary-body NOVA passthrough is gone, for EVERYONE, and logged.
test('14Z.1 the NOVA PATCH passthrough answers 410 to a machine AND to Nick, and is logged', async () => {
  const before = refusals().length;
  for (const who of ['machine', 'nick']) {
    const a = await call('PATCH', '/api/microsoft/planner/tasks/T1', who, { assignments: { x: {} }, percentComplete: 100 });
    assert.equal(a.status, 410, who);
    assert.equal(a.json.retired, true);
    const b = await call('PATCH', '/api/microsoft/todo/tasks/T1', who, { listId: 'L', status: 'completed' });
    assert.equal(b.status, 410, who);
    const c = await call('POST', '/api/microsoft/todo/tasks', who, { listId: 'L', title: 'x' });
    assert.equal(c.status, 410, who);
  }
  assert.equal(refusals().length - before, 6);
  assert.ok(typeof microsoft.updatePlannerTask === 'undefined' && typeof microsoft.updateTodoTask === 'undefined',
    'the forwarding functions are deleted, not merely unrouted');
});

// 2 — the one explicit edit refuses unknown fields rather than dropping them.
test('14Z.2 an unknown field on the explicit Microsoft edit is refused (400), not ignored', async () => {
  const r = await call('PATCH', '/api/todos/ms/AAMkTask1', 'nick', { title: 'x', assignments: { someone: {} } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /unknown field/);
  const nested = await call('PATCH', '/api/todos/ms/AAMkTask1', 'nick', { title: { $set: 'x' } });
  assert.equal(nested.status, 400);
  // Positive control: a machine never reaches the shape check at all.
  const m = await call('PATCH', '/api/todos/ms/AAMkTask1', 'machine', { title: 'x' });
  assert.equal(m.status, 403);
  assert.equal(m.json.capability, 'microsoft.task.fields');
});

// 3 + 10 — the token and a declared machine are not Nick.
test('14Z.3/10 a machine cannot approve — by token, or by declaring itself while holding the PIN', async () => {
  for (const who of ['machine', 'declared']) {
    const r = await call('POST', '/api/prepared-actions/pa_x/approve', who, { payloadHash: 'h', challengeId: 'c', code: '1' });
    assert.equal(r.status, 403, who);
    assert.equal(r.json.capability, 'approval.decide');
  }
  // Nick (PIN, no declaration) is NOT stopped by the guard — the route decides.
  const nick = await call('POST', '/api/prepared-actions/pa_x/approve', 'nick', {});
  assert.notEqual(nick.json.capability, 'approval.decide');
});

test('14Z.10 the API token does not reach security configuration', async () => {
  const r = await call('POST', '/api/feature-flags/governed_execution', 'machine', { enabled: true });
  assert.equal(r.status, 403);
  assert.equal(r.json.capability, 'config.security');
  const flags = require('../services/feature-flags');
  assert.equal(flags.isEnabled('governed_execution'), false, 'and nothing changed');
});

// 8 — Jira escalation: one door, and machines are refused at it.
test('14Z.8 a machine cannot escalate a Jira ticket; the refusal comes from the matrix', async () => {
  const r = await call('POST', '/api/escalation', 'machine', { ticketKey: 'NT-1', reasonCode: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.json.capability, 'jira.escalate');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM external_write_ledger WHERE writer = 'nova.escalate'").n, 0);
});

test('14Z.8 only nova-escalation.js calls NOVA\'s escalate (scan, with a positive control)', () => {
  const root = path.join(__dirname, '..');
  const callers = [];
  for (const dir of ['routes', 'services']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
      if (/\b(nova|novaClient|client)\.escalate\(/.test(src)) callers.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(callers, ['services/nova-escalation.js']);
});

// The attended surface keeps what a person in the room may do.
test('the kiosk token is an attended surface, not a machine — the room offer is the route\'s to answer', async () => {
  const k = await call('POST', '/api/rooms/light:nowhere/accept', 'kiosk');
  assert.notEqual(k.json.capability, 'homeassistant.room');
  const m = await call('POST', '/api/rooms/light:nowhere/accept', 'machine');
  assert.equal(m.status, 403);
  assert.equal(m.json.capability, 'homeassistant.room');
});

// 12 — reads are untouched.
test('14Z.12 a machine GET passes the guard untouched', async () => {
  const r = await call('GET', '/api/todos/ms-queue', 'machine');
  assert.equal(r.status, 200);
});

// 6 + 7 — machine completion: central path, ledger, once.
test('14Z.6/7 a machine Planner completion goes through ms-complete, is ledgered as machine, and runs ONCE', async () => {
  graphCalls.length = 0;
  const first = await call('POST', '/api/todos/complete-ms', 'machine', { msId: 'PLANNER-1', source: 'MS Planner' });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.deepEqual(graphCalls, ['PLANNER-1']);
  const row = db.get('SELECT * FROM external_write_ledger WHERE idempotency_key = ?', [`ms-complete:PLANNER-1:${ext.localDate()}`]);
  assert.equal(row.initiated_by, 'machine:n8n');
  assert.equal(row.status, 'confirmed');
  const again = await call('POST', '/api/todos/complete-ms', 'machine', { msId: 'PLANNER-1', source: 'MS Planner' });
  assert.equal(again.status, 200);
  assert.deepEqual(graphCalls, ['PLANNER-1'], 'a duplicate never reaches Graph');
});

test('14Z.9 an unknown earlier outcome is HELD for a machine, re-attempted for Nick (idempotent target)', async () => {
  graphCalls.length = 0;
  const key = `ms-complete:PLANNER-2:${ext.localDate()}`;
  db.run(`INSERT INTO external_write_ledger (writer, idempotency_key, target, authority, initiated_by, status, request_json, requested_at)
          VALUES ('microsoft.task.complete', ?, 'PLANNER-2', 'A3', 'machine:n8n', 'requested', '{}', ?)`, [key, new Date().toISOString()]);
  const m = await call('POST', '/api/todos/complete-ms', 'machine', { msId: 'PLANNER-2' });
  assert.equal(m.status, 400);
  assert.match(m.json.error, /unknown outcome/);
  assert.deepEqual(graphCalls, [], 'the machine did not retry');
  const n = await call('POST', '/api/todos/complete-ms', 'nick', { msId: 'PLANNER-2' });
  assert.equal(n.status, 200);
  assert.deepEqual(graphCalls, ['PLANNER-2'], 'Nick may — setting 100% twice is harmless');
});

test('14D a completion never UN-ticks a mirror line that is already done (no toggle semantics)', async () => {
  const file = path.join(vault, 'Tasks', 'Microsoft Tasks.md');
  fs.writeFileSync(file, '## MS Planner\n- [x] Already finished <!--id:PLANNER-3-->\n');
  const r = await call('POST', '/api/todos/complete-ms', 'machine', { msId: 'PLANNER-3' });
  assert.equal(r.status, 200);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[x\] Already finished/);
  // Positive control: an OPEN line is ticked.
  fs.writeFileSync(file, '## MS Planner\n- [ ] Still open <!--id:PLANNER-4-->\n');
  await call('POST', '/api/todos/complete-ms', 'machine', { msId: 'PLANNER-4' });
  assert.match(fs.readFileSync(file, 'utf8'), /- \[x\] Still open/);
});

test('14D a machine cannot reach a task by wording — an id with spaces is refused', async () => {
  const r = await call('POST', '/api/todos/complete-ms', 'machine', { msId: 'Parsons contact breakdown' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /exact Microsoft task id/);
});
