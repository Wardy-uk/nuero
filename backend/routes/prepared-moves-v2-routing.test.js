'use strict';

/**
 * /api/prepared-moves/{prepare,respond,answer} and the stored-record /request,
 * over real HTTP through NEURO's real api-auth and authority guard (21 Oct
 * 2026). The planner's readers are stubbed; the store, grants and matrix are
 * real. Machine clients (the MCP gateway's API token) may make ready, defer,
 * decline and answer — never ask to confirm, never confirm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-v2-routes-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'Projects', 'Support Hub'), { recursive: true });

const db = require('../db/database');
const planner = require('../services/prepared-move-planner');
const exec = require('../services/prepared-move-exec');

const NOW = Date.now();
const ID = 'email-abc-123';
const REF = 'held:email-urgent';
const cand = { ref: REF, role: 'held', title: 'Renewal question', item: { type: 'email', id: 'email-urgent', title: 'Renewal question', meta: { emailId: ID } } };
const BODY = 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month? We need your answer.';
Object.assign(planner.DEFAULT_DEPS, {
  prepareV1: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(NOW).toISOString() }, duty: { onDuty: true, why: 'working' }, selected: null, withheld: [], candidates: [cand] }),
  roster: () => ({ full: [] }),
  triageEntry: (id) => (id === ID ? { id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(NOW).toISOString() } : null),
  emailBody: async () => BODY,
  liveReply: () => null,
  draft: async () => ({ ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick', gaps: [] }),
});
exec._setDeps({ readDuty: async () => ({ onDuty: true, why: 'working' }) });
require('../services/prepared-move').readDuty = async () => ({ onDuty: true, why: 'working' });

let server; let base;
test.before(async () => {
  await db.init();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/prepared-moves', require('./prepared-moves'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api/prepared-moves`;
});
test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const PIN = { 'X-NEURO-PIN': 'pin-1234' };
const TOKEN = { 'X-NEURO-API-TOKEN': 'tok-5678' };
async function post(route, body, headers = PIN) {
  const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test('prepare: strict body, refs only, unauthenticated refused', async () => {
  assert.equal((await post('/prepare', { ref: REF, date: '2026-01-01' })).status, 400, 'a date is an attempt, not a typo');
  assert.equal((await post('/prepare', { ref: 'not a ref' })).status, 400);
  assert.equal((await post('/prepare', { ref: REF }, {})).status, 401);
});

test('a desktop chat (API token) can make it ready — a proposal only, nothing written, and it is told only Nick confirms', async () => {
  const r = await post('/prepare', { ref: REF }, TOKEN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.move.kind, 'email-reply');
  assert.equal(r.json.move.prepared.headline, 'I drafted the reply to Sam.');
  assert.match(r.json.confirmWhere, /Only Nick/);
  assert.equal(db.get(`SELECT COUNT(*) n FROM prepared_actions`).n, 0, 'no reply draft in Actions');
  assert.equal(db.get(`SELECT COUNT(*) n FROM human_action_intents`).n, 0, 'no confirmation minted');
  // …but it can never ask to confirm or confirm.
  const req = await post('/request', { recordId: r.json.move.recordId, sessionId: 'session_mcp_0001' }, TOKEN);
  assert.equal(req.status, 403);
  // The same ref from Nick's screen converges on the same stored proposal.
  const mine = await post('/prepare', { ref: REF });
  assert.equal(mine.json.move.recordId, r.json.move.recordId);
  assert.equal(mine.json.outcome, 'unchanged');
});

test('Nick can ask to confirm the STORED proposal: the exact writes, and nothing is sent', async () => {
  const p = await post('/prepare', { ref: REF });
  const r = await post('/request', { recordId: p.json.move.recordId, sessionId: 'session_nick_0001' });
  // Locked device: the boundary is named — never a confirmation for a yes that cannot be carried out.
  assert.equal(r.status, 409);
  assert.match(r.json.error, /locked/i);
  assert.equal(db.get(`SELECT COUNT(*) n FROM human_action_intents`).n, 0);
  // Lock open and an allowance for today: the server's exact question and writes.
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  const budget = require('../services/authority-budget');
  budget._test.reset(); budget._test.grantToday({ now: Date.now() });
  try {
    const ok = await post('/request', { recordId: p.json.move.recordId, sessionId: 'session_nick_0002' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.confirmation.question, 'Put this reply in Actions for your approval?');
    assert.match(ok.json.confirmation.writes.join(' '), /It is NOT sent/);
    assert.match(ok.json.confirmation.contacts, /Nothing is sent/);
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; budget._test.reset(); }
});

test('respond and answer: bounded, refused not clamped, recorded with who did it', async () => {
  const p = await post('/prepare', { ref: REF }, TOKEN);
  const { recordId, recordVersion } = p.json.move;
  assert.equal((await post('/respond', { recordId, version: recordVersion, response: 'defer', days: 30, reason: 'not-now' }, TOKEN)).status, 400);
  assert.equal((await post('/respond', { recordId, version: recordVersion, response: 'defer', days: 1, reason: 'not-now', note: 'x' }, TOKEN)).status, 400);
  const d = await post('/respond', { recordId, version: recordVersion, response: 'defer', days: 1, reason: 'waiting-on-someone' }, TOKEN);
  assert.equal(d.status, 200); assert.equal(d.json.suppression.response, 'deferred');
  assert.match(db.get(`SELECT by FROM prepared_move_responses ORDER BY id DESC LIMIT 1`).by, /^machine:/);
  assert.equal((await post('/prepare', { ref: REF })).status, 409, 'a deferred move is not re-proposed on request');
  assert.equal((await post('/respond', { recordId, version: recordVersion, response: 'restore' })).status, 200);
  assert.equal((await post('/answer', { recordId, version: recordVersion, questionId: 'purpose', text: 'x' })).status, 400, 'not a question this move asked');
  const m = require('../services/authority-matrix');
  for (const r of ['/prepare', '/respond', '/answer']) assert.equal(m.resolve('POST', `/api/prepared-moves${r}`).capability, 'saim.prepared-move.propose');
  assert.equal(m.resolve('POST', '/api/prepared-moves/confirm').capability, 'saim.prepared-move');
});
