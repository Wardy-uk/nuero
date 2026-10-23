'use strict';

/**
 * NEURO and VANTAGE reserving against ONE ledger at the same moment (23 Oct 2026).
 *
 * Two separate processes — one running NEURO's ai-gate.js with NEURO's class
 * registry, the other running VANTAGE's own copy of the file with VANTAGE's
 * registry — start on a shared barrier and race to reserve $0.05 tickets under a
 * $1.00 cap in ENFORCE mode. Proven:
 *
 *  - exactly 20 tickets are allowed across both apps, and they cost ≤ the cap
 *    (no overspend: the cap read and the insert are one IMMEDIATE transaction);
 *  - every ticket id is unique (no duplicate ticket);
 *  - settling each allowed ticket twice: the second settle is refused every time
 *    and recorded as `duplicate-settle`;
 *  - both apps won tickets (the race was real, not one process finishing first).
 *
 * VANTAGE's file is read from the sibling checkout; without one this skips and
 * says so (NEURO's file is then the only one tested, by the other suites).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NEURO_GATE = require.resolve('./ai-gate');
const NEURO_CLASSES = require.resolve('./ai-gate-classes');

function vantageServices() {
  const roots = [path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..', '..', '..', '..', '..')];
  const dirs = roots.flatMap((r) => [
    path.join(r, 'Service Desk Continual Improvement', '.claude', 'worktrees', 'ai-gate', 'backend', 'services'),
    path.join(r, 'Service Desk Continual Improvement', 'backend', 'services'),
  ]);
  return dirs.find((d) => fs.existsSync(path.join(d, 'ai-gate.js')) && fs.readFileSync(path.join(d, 'ai-gate.js'), 'utf8').includes('function checkLedgerConfig')) || null;
}

const WORKER = String.raw`
const fs = require('fs');
const [gatePath, classesPath, app, callClass, barrier, tries] = process.argv.slice(1);
const gate = require(gatePath);
const { REGISTRY } = require(classesPath);
gate.register(app);
// Spin until the barrier file appears, so both processes start reserving together.
while (!fs.existsSync(barrier)) { const t = Date.now(); while (Date.now() - t < 2) { /* spin */ } }
const out = [];
for (let i = 0; i < Number(tries); i++) {
  const t = gate.reserve({ app, callClass, provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', maxInputTokens: 40000, maxOutputTokens: 2000 }, REGISTRY);
  out.push({ id: t.id, decision: t.decision, reasons: t.reasons, admitted: t.admitted, estUsd: t.estUsd, degraded: t.degraded || null });
  // A short pause between requests, as real callers have: without it SQLite's
  // busy back-off lets whichever process got the lock first take every ticket,
  // and the other only ever sees a full cap — no contention to prove anything.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
}
const settles = [];
for (const t of out.filter((x) => x.admitted)) {
  settles.push({ id: t.id, first: gate.settle(t.id, { ok: true, costUsd: 0.05 }).ok, second: gate.settle(t.id, { ok: true, costUsd: 0.05 }) });
}
process.stdout.write(JSON.stringify({ app, out, settles }));
`;

function run(args, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', WORKER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; let e = '';
    c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; });
    c.on('close', (code) => (code === 0 ? resolve(JSON.parse(o)) : reject(new Error(`exit ${code}: ${e}`))));
  });
}

test('two apps, one ledger, one cap: no overspend, no duplicate ticket, a second settle always refused', async (t) => {
  const vdir = vantageServices();
  if (!vdir) return t.skip('no VANTAGE checkout with the shared gate beside this one');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gate-two-'));
  const ledger = path.join(dir, 'ledger.db');
  const barrier = path.join(dir, 'go');
  const env = { ...process.env, AI_GATE_DB_PATH: ledger, AI_GATE_MODE: 'enforce', AI_GATE_DAILY_CAP_USD: '1' };
  // VANTAGE's checkout may not carry the native driver; it resolves NEURO's.
  env.NODE_PATH = [path.resolve(__dirname, '..', '..', 'node_modules'), path.resolve(__dirname, '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);

  // Mint the ledger first so neither process races CREATE TABLE.
  const gate = require('./ai-gate');
  const saved = process.env.AI_GATE_DB_PATH; process.env.AI_GATE_DB_PATH = ledger; gate._reset();
  const id = gate.ledgerInfo().id;

  const runs = Promise.all([
    run([NEURO_GATE, NEURO_CLASSES, 'neuro', 'chat_sync', barrier, '30'], env),
    run([path.join(vdir, 'ai-gate.js'), path.join(vdir, 'ai-gate-classes.js'), 'vantage', 'coach', barrier, '30'], env),
  ]);
  await new Promise((r) => setTimeout(r, 1500)); // both have registered and are spinning
  fs.writeFileSync(barrier, '1');
  const [n, v] = await runs;

  const all = [...n.out, ...v.out];
  assert.equal(all.filter((x) => x.degraded).length, 0, 'the ledger was written, not bypassed');
  assert.equal(all.length, 60);
  assert.ok(all.every((x) => x.estUsd === 0.05), 'each ticket is a $0.05 worst case');
  const allowed = all.filter((x) => x.admitted);
  assert.equal(allowed.length, 20, '$1.00 ÷ $0.05');
  const spend = allowed.reduce((s, x) => s + x.estUsd, 0);
  assert.ok(spend <= 1 + 1e-9, `no overspend (${spend})`);
  assert.ok(all.filter((x) => !x.admitted).every((x) => x.reasons.includes('daily-cap')), 'every refusal is the cap');
  assert.equal(new Set(all.map((x) => x.id)).size, 60, 'every ticket id is unique');
  assert.ok(n.out.some((x) => x.admitted) && v.out.some((x) => x.admitted), 'both apps won tickets — a real race');

  const settles = [...n.settles, ...v.settles];
  assert.equal(settles.length, 20);
  assert.ok(settles.every((s) => s.first === true));
  assert.ok(settles.every((s) => s.second.ok === false), 'a second settle is never accepted');

  const p = gate.profile();
  assert.equal(p.events['duplicate-settle'], 20, 'each refused second settle is recorded');
  assert.equal(gate.ledgerInfo().id, id);
  assert.deepEqual(gate.ledgerInfo().apps.map((a) => a.app), ['neuro', 'vantage'], 'both apps registered on the one ledger');

  process.env.AI_GATE_DB_PATH = saved; gate._reset();
});
