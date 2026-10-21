'use strict';

/**
 * /api/saim-authority over real HTTP, through NEURO's real api-auth and
 * authority guard, against a scratch database. Pins: every route is human-only;
 * a body may carry only the fields a route names; granting needs the preview's
 * one-use confirmation and grants exactly what it showed; granting never opens
 * the device lock; stop is immediate and resume needs its own confirmation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-authority-routes-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
delete process.env.SAIM_PREPARED_MOVE_EXECUTION;

const db = require('../db/database');
const budget = require('../services/authority-budget');

let server; let base;
test.before(async () => {
  await db.init();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/saim-authority', require('./saim-authority'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const PIN = { 'X-NEURO-PIN': 'pin-1234' };
function call(method, route, body, headers = PIN) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/saim-authority/${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('every route refuses machine callers — API token and declared machine — and nothing changes', async () => {
  budget._test.reset();
  const routes = [['GET', 'status'], ['POST', 'grant/preview', {}], ['POST', 'grant', { confirmToken: `ac_${'a'.repeat(20)}` }], ['POST', 'revoke', {}], ['POST', 'stop', {}], ['POST', 'resume/preview', {}], ['POST', 'resume', { confirmToken: `ac_${'a'.repeat(20)}` }]];
  for (const headers of [{ 'X-NEURO-API-TOKEN': 'tok-5678' }, { ...PIN, 'X-Neuro-Machine-Client': 'mcp-local' }]) {
    for (const [m, r, b] of routes) assert.equal((await call(m, r, b, headers)).status, 403, `${m} ${r}`);
  }
  assert.equal((await call('GET', 'status', undefined, {})).status, 401, 'no credential');
  assert.equal(budget.stopState().stopped, false, 'a refused stop did nothing');
  assert.equal(budget.status().grant, null);
  const m = require('../services/authority-matrix');
  assert.equal(m.CAPABILITIES['saim.authority'].machine, 'refuse');
  const policy = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js'), 'utf8');
  for (const id of ['get_saim_authority_status', 'post_saim_authority_grant_preview', 'post_saim_authority_grant', 'post_saim_authority_revoke', 'post_saim_authority_stop', 'post_saim_authority_resume_preview', 'post_saim_authority_resume']) {
    assert.match(policy, new RegExp(`${id}:`), id);
  }
});

test('zero by default, and the status names both gates in Nick’s words', async () => {
  budget._test.reset();
  const s = await call('GET', 'status');
  assert.equal(s.status, 200);
  assert.equal(s.json.contract, 'saim-authority-v1');
  assert.equal(s.json.gates.device.say, 'Carrying out moves is switched off on NEURO’s server.');
  assert.equal(s.json.gates.allowance.say, 'You haven’t allowed SAiM to carry out any prepared moves today.');
  assert.equal(s.json.canAct, false);
  assert.equal(s.json.summary, 'SAiM can prepare moves, but carrying them out is switched off on NEURO’s server and you haven’t allowed any today.');
});

test('grant: strict body, exact preview, one-use confirmation — and the device stays locked', async () => {
  budget._test.reset();
  for (const extra of [{ spendPence: 0 }, { contacts: 0 }, { notes: 1 }, { enabled: true }, { lock: 'open' }]) {
    const r = await call('POST', 'grant/preview', extra);
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.match(r.json.error, /this takes only day, blockMinutes/);
  }
  assert.equal((await call('POST', 'grant/preview', { blockMinutes: 45 })).status, 400);
  const p = await call('POST', 'grant/preview', { blockMinutes: 30 });
  assert.equal(p.status, 200);
  assert.match(p.json.statement.join('\n'), /up to three private calendar blocks of up to 30 minutes each \(just you, nobody invited\)/);
  assert.match(p.json.statement.join('\n'), /switched off on NEURO’s server right now/);
  assert.equal(budget.status().grant, null, 'a preview grants nothing');
  assert.equal((await call('POST', 'grant', { confirmToken: p.json.confirmToken, blockMinutes: 30 })).status, 400, 'terms cannot be re-sent with the confirmation');
  const g = await call('POST', 'grant', { confirmToken: p.json.confirmToken });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal((await call('POST', 'grant', { confirmToken: p.json.confirmToken })).status, 409, 'one use');
  const s = (await call('GET', 'status')).json;
  assert.equal(s.gates.allowance.say, 'Today SAiM may carry out up to three prepared moves, each only after you confirm it.');
  assert.equal(s.gates.device.open, false, 'granting never opens the device lock');
  assert.equal(s.canAct, false);
  assert.equal(s.summary, 'SAiM can prepare moves, but carrying them out is switched off on NEURO’s server.');
  assert.equal(require('../services/feature-flags').isEnabled('saim_prepared_move_execution'), false);
  const rv = await call('POST', 'revoke', {});
  assert.equal(rv.status, 200); assert.equal(rv.json.revoked, true);
  assert.equal((await call('GET', 'status')).json.grant, null);
});

test('stop is immediate; resume needs its own confirmation', async () => {
  budget._test.reset();
  assert.equal((await call('POST', 'stop', { reason: 'x' })).status, 400, 'stop takes nothing');
  assert.equal((await call('POST', 'stop', {})).status, 200);
  assert.equal((await call('GET', 'status')).json.summary, 'All SAiM actions are stopped.');
  assert.equal((await call('POST', 'resume', { confirmToken: `ac_${'b'.repeat(20)}` })).status, 409);
  const p = await call('POST', 'resume/preview', {});
  assert.equal(p.status, 200);
  assert.equal((await call('POST', 'resume', { confirmToken: p.json.confirmToken })).status, 200);
  assert.equal((await call('GET', 'status')).json.stopped, false);
});
