'use strict';

/**
 * The shared AI ledger's path contract (23 Oct 2026).
 *
 * NEURO and VANTAGE must write ONE ledger file. Nothing may rely on them running
 * as the same Unix user, so the path is never derived from a home directory: it
 * is the explicit absolute AI_GATE_DB_PATH both .env files name, checked at
 * startup, and the two apps prove they share it by the ledger id minted INSIDE
 * the file.
 *
 *  - outside `node --test` a missing / relative / folder-missing / not-a-folder
 *    path refuses to start, naming the problem (checked in a child process with
 *    the test context removed, so the test-only fallback cannot hide it);
 *  - two opens of one file read the same ledger id; two files read different
 *    ids, and sameLedger() says mismatch;
 *  - register() records who opened the ledger, with configured and real paths;
 *  - the daily cap refuses the request that would cross it and nothing before;
 *  - the peer check compares VANTAGE's reported ledger id with NEURO's;
 *  - both servers call assertLedgerConfig BEFORE anything else opens a port.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gate-cfg-'));
const GATE = require.resolve('./ai-gate');

/** Run assertLedgerConfig in a child WITHOUT the test context (as on the Pi). */
function startupCheck(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  if (!('AI_GATE_DB_PATH' in extraEnv)) delete env.AI_GATE_DB_PATH;
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  const code = `try { const c = require(${JSON.stringify(GATE)}).assertLedgerConfig('NEURO'); console.log('OK ' + c.path); } catch (e) { console.log('REFUSED ' + e.message); process.exit(3); }`;
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('startup refuses a missing AI_GATE_DB_PATH, and says what to set', () => {
  const r = startupCheck({ AI_GATE_DB_PATH: undefined });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /NEURO cannot start: AI_GATE_DB_PATH is not set/);
  assert.match(r.out, /same absolute path/);
});

test('startup refuses a RELATIVE path', () => {
  const r = startupCheck({ AI_GATE_DB_PATH: 'data/ledger.db' });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /must be absolute; got "data\/ledger.db"/);
});

test('startup refuses a path whose folder does not exist (it never creates one)', () => {
  const missing = path.join(DIR, 'nope', 'ledger.db');
  const r = startupCheck({ AI_GATE_DB_PATH: missing });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /does not exist/);
  assert.equal(fs.existsSync(path.dirname(missing)), false, 'the check created nothing');
});

test('startup refuses a path whose "folder" is a file', () => {
  const file = path.join(DIR, 'a-file');
  fs.writeFileSync(file, 'x');
  const r = startupCheck({ AI_GATE_DB_PATH: path.join(file, 'ledger.db') });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /is not a directory/);
});

test('startup refuses an unreadable ledger file', (t) => {
  if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) {
    return t.skip('file modes do not deny access on Windows or to root; the Pi runs this as nickw');
  }
  const d = fs.mkdtempSync(path.join(DIR, 'ro-'));
  const f = path.join(d, 'ledger.db');
  fs.writeFileSync(f, '');
  fs.chmodSync(f, 0o000);
  try {
    const r = startupCheck({ AI_GATE_DB_PATH: f });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /not readable and writable/);
  } finally { fs.chmodSync(f, 0o600); }
});

test('startup accepts an absolute path in an existing folder (positive control)', () => {
  const ok = path.join(fs.mkdtempSync(path.join(DIR, 'ok-')), 'ledger.db');
  const r = startupCheck({ AI_GATE_DB_PATH: ok });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^OK /);
  assert.equal(fs.existsSync(ok), false, 'checking does not create the ledger');
});

test('ledgerPath never falls back to a per-user default outside tests', () => {
  const gate = require('./ai-gate');
  assert.equal(gate.ledgerPath({}), null);
  assert.equal(gate.ledgerPath({ HOME: '/home/nickw' }), null);
  assert.equal(gate.ledgerPath({ AI_GATE_DB_PATH: '/mnt/data/ai-gate/ledger.db' }), '/mnt/data/ai-gate/ledger.db');
});

test('one file = one ledger id, read by two separate processes; two files = mismatch', () => {
  const file = path.join(fs.mkdtempSync(path.join(DIR, 'id-')), 'ledger.db');
  const other = path.join(fs.mkdtempSync(path.join(DIR, 'id2-')), 'ledger.db');
  const idOf = (f, app) => {
    const code = `const g = require(${JSON.stringify(GATE)}); g.register(${JSON.stringify(app)}); console.log(JSON.stringify(g.ledgerInfo()));`;
    const r = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, AI_GATE_DB_PATH: f }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const a = idOf(file, 'neuro');
  const b = idOf(file, 'vantage');
  const c = idOf(other, 'vantage');
  assert.ok(a.id && /^[0-9a-f-]{36}$/.test(a.id));
  assert.equal(a.id, b.id, 'the second app reads the id the first minted');
  assert.notEqual(a.id, c.id);
  assert.deepEqual(b.apps.map((x) => x.app), ['neuro', 'vantage'], 'both registrations are in the one file');
  assert.equal(b.apps[0].configured_path, file);
  assert.ok(b.apps[0].real_path, 'the resolved path is recorded too');

  const gate = require('./ai-gate');
  assert.equal(gate.sameLedger(a, b).state, 'match');
  const mm = gate.sameLedger(a, c);
  assert.equal(mm.state, 'mismatch');
  assert.match(mm.say, /DIFFERENT ledgers/);
  assert.equal(gate.sameLedger(a, null).state, 'unknown', 'no report is not a match');
  assert.equal(gate.sameLedger(null, a).state, 'unknown');
});

test('the daily cap refuses exactly the request that would cross it (enforce), and is unset by default', () => {
  const gate = require('./ai-gate');
  assert.equal(gate.capUsd({}), null);
  assert.equal(gate.capUsd({ AI_GATE_DAILY_CAP_USD: '0' }), null, 'zero is no cap, never a zero budget');
  assert.equal(gate.capUsd({ AI_GATE_DAILY_CAP_USD: 'lots' }), null);
  assert.equal(gate.capUsd({ AI_GATE_DAILY_CAP_USD: '2.5' }), 2.5);

  process.env.AI_GATE_DB_PATH = path.join(fs.mkdtempSync(path.join(DIR, 'cap-')), 'ledger.db');
  process.env.AI_GATE_MODE = 'enforce';
  process.env.AI_GATE_DAILY_CAP_USD = '0.12';
  gate._reset();
  try {
    const REG = { chat_sync: { maxInputTokens: 200000, maxOutputTokens: 16000 } };
    const spec = { app: 'neuro', callClass: 'chat_sync', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', maxInputTokens: 40000, maxOutputTokens: 2000 }; // $0.05 worst case
    const t1 = gate.reserve(spec, REG); const t2 = gate.reserve(spec, REG); const t3 = gate.reserve(spec, REG);
    assert.deepEqual([t1.admitted, t2.admitted, t3.admitted], [true, true, false]);
    assert.deepEqual(t3.reasons, ['daily-cap']);
    // Settling one cheaper than its reservation frees room for the next.
    gate.settle(t1, { ok: true, costUsd: 0.01 });
    assert.equal(gate.reserve(spec, REG).admitted, true);
    // An unpriceable request cannot be shown to fit under a cap.
    assert.ok(gate.reserve({ ...spec, model: 'mystery/model' }, REG).reasons.includes('daily-cap'));
    assert.equal(gate.profile().dailyCapUsd, 0.12);
  } finally {
    delete process.env.AI_GATE_MODE; delete process.env.AI_GATE_DAILY_CAP_USD;
    gate._reset();
  }
});

test('the peer check: match, mismatch, unreachable and not-configured', async () => {
  const gate = require('./ai-gate');
  process.env.AI_GATE_DB_PATH = path.join(fs.mkdtempSync(path.join(DIR, 'peer-')), 'ledger.db');
  gate._reset();
  const mine = gate.ledgerInfo();
  const clientPath = require.resolve('./vantage-client');
  const peerPath = require.resolve('./ai-gate-peer');
  const saved = require.cache[clientPath];
  const withVantage = (stub) => {
    require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };
    delete require.cache[peerPath];
    return require('./ai-gate-peer');
  };
  const errs = []; const realErr = console.error; console.error = (m) => errs.push(String(m));
  try {
    let peer = withVantage({ isConfigured: () => true, get: async () => ({ ledger: { id: mine.id, path: '/mnt/data/ai-gate/ledger.db' } }) });
    assert.equal((await peer.check()).state, 'match');
    assert.equal(peer.last().state, 'match');

    peer = withVantage({ isConfigured: () => true, get: async () => ({ ledger: { id: 'some-other-ledger', path: '/home/x/ledger.db' } }) });
    const mm = await peer.check();
    assert.equal(mm.state, 'mismatch');
    assert.ok(errs.some((e) => /DIFFERENT ledgers/.test(e)), 'a mismatch is logged loudly');

    peer = withVantage({ isConfigured: () => true, get: async () => { throw new Error('timeout'); } });
    assert.equal((await peer.check()).state, 'unreachable');

    peer = withVantage({ isConfigured: () => false, get: async () => { throw new Error('must not be called'); } });
    assert.equal((await peer.check()).state, 'not-configured');

    // A VANTAGE older than this change reports no ledger: unknown, never a match.
    peer = withVantage({ isConfigured: () => true, get: async () => ({ ok: true }) });
    assert.equal((await peer.check()).state, 'unknown');
  } finally {
    console.error = realErr;
    if (saved) require.cache[clientPath] = saved; else delete require.cache[clientPath];
    delete require.cache[peerPath];
    gate._reset();
  }
});

test('reserve and settle take the write lock up front (IMMEDIATE)', () => {
  // Measured 23 Oct 2026: with a DEFERRED transaction the two-app race still never
  // overspends — SQLite WAL refuses the stale write (SQLITE_BUSY_SNAPSHOT) rather
  // than commit it — but that refusal lands in the catch and the ticket comes back
  // DEGRADED and admitted: fail-open under contention. IMMEDIATE removes the window.
  const src = fs.readFileSync(require.resolve('./ai-gate'), 'utf8');
  const fn = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  assert.match(fn('reserve'), /\}\)\.immediate\(\);/);
  assert.match(fn('settle'), /\}\)\.immediate\(\);/);
});

test('both servers check the ledger config before they serve anything', (t) => {
  const neuro = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = neuro.indexOf("assertLedgerConfig('NEURO')");
  assert.ok(at > 0, 'NEURO checks at startup');
  assert.ok(at < neuro.indexOf('.listen('), 'before listen');
  assert.ok(at > neuro.indexOf('applyLegacyEnv()'), 'after .env is loaded');
  assert.match(neuro, /register\('neuro'\)/);

  const roots = [path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..', '..', '..', '..', '..', '..')];
  const candidates = roots.flatMap((r) => [
    path.join(r, 'Service Desk Continual Improvement', 'backend', 'server.js'),
    path.join(r, 'Service Desk Continual Improvement', '.claude', 'worktrees', 'ai-gate', 'backend', 'server.js'),
  ]).filter((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes("assertLedgerConfig('VANTAGE')"));
  if (!candidates.length) return t.skip('no VANTAGE checkout with the gate beside this one');
  const v = fs.readFileSync(candidates[0], 'utf8');
  const vat = v.indexOf("assertLedgerConfig('VANTAGE')");
  assert.ok(vat > v.indexOf("require('dotenv')"), 'VANTAGE checks after its .env is loaded');
  assert.ok(vat < v.indexOf('app.listen('), 'and before it listens');
  assert.match(v, /register\('vantage'\)/);
});
