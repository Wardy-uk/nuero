'use strict';

/**
 * The shared AI budget gate (22 Oct 2026). Real SQLite ledger in a temp file.
 *
 *  - reserve → settle is atomic and single-use: a second settle is refused and
 *    recorded, and two processes reserving on one file never lose a ticket;
 *  - unknown class / model / price and unbounded input/output are refusals the
 *    gate RECORDS (shadow admits them; enforce does not);
 *  - settlement prefers the vendor's cost, then tokens × price, then the reserved
 *    worst case (pessimistic) — never zero for "not told";
 *  - concurrency applies to local workloads too;
 *  - the day is London's, and there is NO daily cap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gate-'));
let n = 0;
function fresh() {
  n += 1;
  process.env.AI_GATE_DB_PATH = path.join(DIR, `ledger-${n}.db`);
  delete process.env.AI_GATE_MODE;
  const gate = require('./ai-gate');
  gate._reset();
  return gate;
}

const REG = {
  radar: { maxInputTokens: 40000, maxOutputTokens: 8000 },
  chat_sync: { maxInputTokens: 200000, maxOutputTokens: 16000 },
  local_job: { local: true, maxInputTokens: 10000, maxOutputTokens: 2000, maxConcurrent: 1 },
  $providers: { ollama: { maxConcurrent: 1 } },
};
const spec = (o = {}) => ({ app: 'neuro', callClass: 'chat_sync', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', maxInputTokens: 1000, maxOutputTokens: 500, ...o });

test('reserve prices the worst case across fallbacks; settle uses the vendor cost first', () => {
  const gate = fresh();
  const t = gate.reserve(spec({ fallbackModels: ['google/gemini-2.5-flash'] }), REG);
  assert.equal(t.decision, 'allow');
  assert.equal(t.admitted, true);
  // haiku: (1000*1 + 500*5)/1e6 = 0.0035; gemini: (1000*0.3+500*2.5)/1e6 = 0.00155 → worst 0.0035
  assert.equal(t.estUsd, 0.0035);
  const s = gate.settle(t, { ok: true, model: 'anthropic/claude-haiku-4.5', promptTokens: 900, completionTokens: 100, costUsd: 0.0012 });
  assert.deepEqual(s, { ok: true, costUsd: 0.0012, basis: 'vendor' });
});

test('a ticket settles ONCE: the second settle is refused and recorded (no double-spend)', () => {
  const gate = fresh();
  const t = gate.reserve(spec(), REG);
  assert.equal(gate.settle(t, { ok: true, costUsd: 0.001 }).ok, true);
  const again = gate.settle(t, { ok: true, costUsd: 0.001 });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate-settle');
  const p = gate.profile();
  assert.equal(p.spendUsd, 0.001, 'counted once');
  assert.equal(p.events['duplicate-settle'], 1);
  assert.equal(gate.settle({ id: 'not-a-ticket' }, {}).reason, 'unknown-ticket');
});

test('unknown price / model / class and unbounded calls are refusals — recorded in shadow, refused in enforce', () => {
  const gate = fresh();
  const t = gate.reserve(spec({ model: 'mistralai/some-unpriced-model' }), REG);
  assert.equal(t.decision, 'refuse');
  assert.ok(t.reasons.includes('unknown-price'));
  assert.equal(t.admitted, true, 'shadow: the call still goes ahead');
  assert.equal(t.estUsd, null, 'an unpriced worst case is unknown, never 0');
  assert.deepEqual(gate.reserve(spec({ callClass: 'mystery' }), REG).reasons, ['unknown-class']);
  assert.ok(gate.reserve(spec({ model: null }), REG).reasons.includes('unknown-model'));
  assert.ok(gate.reserve(spec({ maxOutputTokens: undefined }), REG).reasons.includes('unbounded-output'));
  assert.ok(gate.reserve(spec({ maxInputTokens: undefined }), REG).reasons.includes('unbounded-input'));
  assert.ok(gate.reserve(spec({ callClass: 'radar', maxInputTokens: 90000 }), REG).reasons.includes('input-over-bound'));
  assert.ok(gate.reserve(spec({ fallbackModels: ['unpriced/x'] }), REG).reasons.includes('unknown-price'), 'a fallback must be priced too');

  process.env.AI_GATE_MODE = 'enforce';
  const e = gate.reserve(spec({ model: 'mistralai/some-unpriced-model' }), REG);
  assert.equal(e.admitted, false);
  assert.equal(e.mode, 'enforce');
  delete process.env.AI_GATE_MODE;

  const p = gate.profile();
  const reasons = Object.fromEntries(p.refusals.map((r) => [r.reason, r.count]));
  assert.ok(reasons['unknown-price'] >= 3);
  assert.equal(reasons['unknown-class'], 1);
  assert.ok(p.unpricedModels.includes('mistralai/some-unpriced-model'));
});

test('settlement is pessimistic when usage is unknown, unknown when nothing is priced, and never 0 for "not told"', () => {
  const gate = fresh();
  const t = gate.reserve(spec(), REG);
  assert.deepEqual(gate.settle(t, { ok: true }), { ok: true, costUsd: 0.0035, basis: 'pessimistic' });
  const t2 = gate.reserve(spec(), REG);
  assert.deepEqual(gate.settle(t2, { ok: true, promptTokens: 1000, completionTokens: 200 }), { ok: true, costUsd: 0.002, basis: 'priced' });
  const t3 = gate.reserve(spec({ model: 'unpriced/x' }), REG);
  assert.deepEqual(gate.settle(t3, { ok: true }), { ok: true, costUsd: null, basis: 'unknown' });
  const t4 = gate.reserve(spec(), REG);
  assert.deepEqual(gate.settle(t4, { ok: false, error: 'HTTP 500' }), { ok: true, costUsd: 0.0035, basis: 'pessimistic' }, 'a failed call may still have been billed');
});

test('local workloads: free, but concurrency applies per class and per provider', () => {
  const gate = fresh();
  const local = (o = {}) => spec({ callClass: 'local_job', provider: 'ollama', model: 'qwen2.5:1.5b', ...o });
  const a = gate.reserve(local(), REG);
  assert.equal(a.decision, 'allow');
  assert.equal(a.estUsd, 0);
  const b = gate.reserve(local(), REG);
  assert.deepEqual(b.reasons, ['concurrency']);
  gate.settle(a, { ok: true });
  gate.settle(b, { ok: true });
  assert.equal(gate.reserve(local(), REG).decision, 'allow', 'released once settled');
  assert.ok(gate.reserve(spec({ callClass: 'chat_sync', provider: 'ollama', model: 'qwen2.5:3b' }), REG).reasons.includes('concurrency'), 'provider-wide limit across classes');
  assert.equal(gate.settledCost({ provider: 'ollama', est_usd: 0 }, {}).basis, 'local');
});

test('an unsettled ticket expires after the TTL and is settled pessimistically', () => {
  const gate = fresh();
  const t0 = Date.parse('2026-10-22T09:00:00Z');
  const t = gate.reserve(spec(), REG, { now: t0 });
  const p = gate.profile({ now: t0 + gate.RESERVATION_TTL_MS + 1000 });
  assert.equal(p.spendUsd, 0.0035);
  assert.equal(p.pessimisticCalls, 1);
  assert.equal(gate.settle(t, { ok: true }, { now: t0 + gate.RESERVATION_TTL_MS + 2000 }).reason, 'duplicate-settle', 'an expired ticket cannot be settled again');
});

test('the ledger day is London’s, and there is no daily cap', () => {
  const gate = fresh();
  assert.equal(gate.londonDay(Date.parse('2026-10-22T23:30:00Z')), '2026-10-23', 'BST: 00:30 next day');
  assert.equal(gate.londonDay(Date.parse('2026-12-01T23:30:00Z')), '2026-12-01', 'GMT');
  const p = gate.profile();
  assert.equal(p.dailyCapUsd, null);
  assert.match(p.capSay, /Nick has not chosen one/);
  assert.equal(p.mode, 'shadow');
});

test('the profile names Radar’s share of the shared day', () => {
  const gate = fresh();
  const now = Date.parse('2026-10-22T10:00:00Z');
  const r = gate.reserve({ ...spec(), app: 'vantage', callClass: 'radar', model: 'anthropic/claude-sonnet-4.5' }, REG, { now });
  gate.settle(r, { ok: true, costUsd: 0.03 }, { now });
  const c = gate.reserve(spec(), REG, { now });
  gate.settle(c, { ok: true, costUsd: 0.01 }, { now });
  const p = gate.profile({ now });
  assert.equal(p.spendUsd, 0.04);
  assert.deepEqual(p.share, { callClass: 'radar', usd: 0.03, fraction: 0.75 });
  assert.deepEqual(p.byApp.map((a) => a.app).sort(), ['neuro', 'vantage']);
  assert.ok(p.byClass.find((x) => x.app === 'vantage' && x.callClass === 'radar'));
});

test('two PROCESSES reserving on one ledger never lose or duplicate a ticket (IMMEDIATE transactions)', () => {
  fresh();
  const file = process.env.AI_GATE_DB_PATH;
  const script = `
    process.env.AI_GATE_DB_PATH = ${JSON.stringify(file)};
    const gate = require(${JSON.stringify(path.join(__dirname, 'ai-gate.js'))});
    const REG = { chat_sync: { maxInputTokens: 200000, maxOutputTokens: 16000 } };
    for (let i = 0; i < 40; i++) {
      const t = gate.reserve({ app: process.argv[1], callClass: 'chat_sync', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', maxInputTokens: 10, maxOutputTokens: 10 }, REG);
      if (!t.id) throw new Error('degraded: ' + t.degraded);
      gate.settle(t, { ok: true, costUsd: 0.001 });
    }`;
  const { spawn } = require('child_process');
  const run = (app) => new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const p = spawn(process.execPath, ['-e', script, app], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
  return Promise.all([run('neuro'), run('vantage')]).then(() => {
    const gate = require('./ai-gate');
    gate._reset();
    const p = gate.profile();
    assert.equal(p.calls, 80);
    assert.equal(p.spendUsd, 0.08);
    assert.equal(p.events['duplicate-settle'], undefined);
  });
});

test('under node --test a gate with no configured path never writes the real shared ledger', () => {
  const saved = process.env.AI_GATE_DB_PATH;
  delete process.env.AI_GATE_DB_PATH;
  try {
    const gate = require('./ai-gate');
    assert.ok(process.env.NODE_TEST_CONTEXT, 'positive control: running under the test runner');
    assert.notEqual(gate.ledgerPath(), path.join(os.homedir(), '.ai-gate', 'ledger.db'));
  } finally { process.env.AI_GATE_DB_PATH = saved; }
});

test('run(): reserve → call → settle, and a throw settles the ticket as failed', async () => {
  const gate = fresh();
  const v = await gate.run(spec(), REG, async (t) => { assert.ok(t.id); return { value: 'ok', usage: { costUsd: 0.002 } }; });
  assert.equal(v, 'ok');
  await assert.rejects(gate.run(spec(), REG, async () => { throw new Error('boom'); }), /boom/);
  const p = gate.profile();
  assert.equal(p.calls, 2);
  assert.equal(p.spendUsd, 0.0055, 'the failed call is settled at its worst case');
  process.env.AI_GATE_MODE = 'enforce';
  await assert.rejects(gate.run(spec({ callClass: 'nope' }), REG, async () => 'never'), gate.GateRefused);
  delete process.env.AI_GATE_MODE;
});
