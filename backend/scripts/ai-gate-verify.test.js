'use strict';

/**
 * backend/scripts/ai-gate-verify.js — the read-only post-deploy check (23 Oct 2026).
 * Run end to end against temp .env files and a real ledger: it passes only when
 * both files name one absolute ledger that both apps have registered on, fails
 * naming the problem otherwise, and changes neither the env files nor the ledger.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const http = require('http');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'ai-gate-verify.js');
const { envValue, comparePaths, checkAccess, compareIdentity } = require('./ai-gate-verify');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gate-verify-'));
const hash = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

function envFile(name, body) { const f = path.join(DIR, name); fs.writeFileSync(f, body); return f; }
function verify(neuroEnv, vantageEnv) {
  const r = spawnSync(process.execPath, [SCRIPT, '--neuro-env', neuroEnv, '--vantage-env', vantageEnv], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('envValue reads dotenv lines the way dotenv does (quotes, comments, export, last wins)', () => {
  assert.equal(envValue('A=1\nAI_GATE_DB_PATH=/mnt/data/ai-gate/ledger.db\n', 'AI_GATE_DB_PATH'), '/mnt/data/ai-gate/ledger.db');
  assert.equal(envValue('AI_GATE_DB_PATH="/x y/l.db"', 'AI_GATE_DB_PATH'), '/x y/l.db');
  assert.equal(envValue('export AI_GATE_DB_PATH=/a.db # note', 'AI_GATE_DB_PATH'), '/a.db');
  assert.equal(envValue('# AI_GATE_DB_PATH=/commented.db', 'AI_GATE_DB_PATH'), null);
  assert.equal(envValue('AI_GATE_DB_PATH=/a.db\r\nAI_GATE_DB_PATH=/b.db\r\n', 'AI_GATE_DB_PATH'), '/b.db');
  assert.equal(envValue('AI_GATE_DB_PATH=', 'AI_GATE_DB_PATH'), null);
});

test('comparePaths: unset, relative and different are each named; identical is clean', () => {
  assert.match(comparePaths(null, '/a.db').join(), /NEURO: AI_GATE_DB_PATH is not set/);
  assert.match(comparePaths('data/a.db', '/a.db').join(), /NEURO: .* not absolute/);
  assert.match(comparePaths('/a.db', '/b.db').join(), /DIFFERENT ledgers/);
  assert.deepEqual(comparePaths('/a.db', '/a.db'), []);
  // Two path strings that resolve to one file are the same ledger.
  assert.deepEqual(comparePaths('/link/a.db', '/real/a.db', (p) => p.replace('/link/', '/real/')), []);
});

test('end to end: passes on one registered ledger, and reads without writing anything', () => {
  const ledger = path.join(fs.mkdtempSync(path.join(DIR, 'ok-')), 'ledger.db');
  process.env.AI_GATE_DB_PATH = ledger;
  const gate = require('../services/ai-gate');
  gate._reset();
  gate.register('neuro'); gate.register('vantage');
  gate.reserve({ app: 'neuro', callClass: 'chat_sync', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', maxInputTokens: 1000, maxOutputTokens: 100 }, { chat_sync: { maxInputTokens: 200000, maxOutputTokens: 16000 } });
  const n = envFile('n.env', `PORT=3001\nAI_GATE_DB_PATH=${ledger}\n`);
  const v = envFile('v.env', `AI_GATE_DB_PATH="${ledger}"\n`);
  const before = [hash(n), hash(v), hash(ledger), hash(ledger + '-wal')];
  const r = verify(n, v);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /✔ NEURO and VANTAGE write the one shared ledger/);
  assert.match(r.out, /neuro\s+started .* \(running\)/);
  assert.match(r.out, /vantage\s+started .* \(running\)/);
  assert.match(r.out, /neuro\s+allow\s+reserved\s+1/);
  assert.deepEqual([hash(n), hash(v), hash(ledger), hash(ledger + '-wal')], before, 'nothing was written');

  // A ledger only one app has registered on fails, naming the other.
  const solo = path.join(fs.mkdtempSync(path.join(DIR, 'solo-')), 'ledger.db');
  process.env.AI_GATE_DB_PATH = solo; gate._reset(); gate.register('neuro');
  const s = verify(envFile('sn.env', `AI_GATE_DB_PATH=${solo}`), envFile('sv.env', `AI_GATE_DB_PATH=${solo}`));
  assert.equal(s.status, 1, s.out);
  assert.match(s.out, /VANTAGE has not registered on this ledger/);
  gate._reset();
});

test('end to end: different paths, an unset path and a missing ledger all fail by name', () => {
  const a = path.join(DIR, 'a.db'); const b = path.join(DIR, 'b.db');
  let r = verify(envFile('d1.env', `AI_GATE_DB_PATH=${a}`), envFile('d2.env', `AI_GATE_DB_PATH=${b}`));
  assert.equal(r.status, 1); assert.match(r.out, /DIFFERENT ledgers/);
  r = verify(envFile('u1.env', 'PORT=1'), envFile('u2.env', `AI_GATE_DB_PATH=${a}`));
  assert.equal(r.status, 1); assert.match(r.out, /NEURO: AI_GATE_DB_PATH is not set/);
  const missing = path.join(DIR, 'never', 'ledger.db');
  r = verify(envFile('m1.env', `AI_GATE_DB_PATH=${missing}`), envFile('m2.env', `AI_GATE_DB_PATH=${missing}`));
  assert.equal(r.status, 1); assert.match(r.out, /folder .* does not exist \(create it: install -d -m 0700/);
  assert.equal(fs.existsSync(path.dirname(missing)), false, 'the check created nothing');
  const emptyDir = fs.mkdtempSync(path.join(DIR, 'empty-')); const notYet = path.join(emptyDir, 'ledger.db');
  r = verify(envFile('y1.env', `AI_GATE_DB_PATH=${notYet}`), envFile('y2.env', `AI_GATE_DB_PATH=${notYet}`));
  assert.equal(r.status, 1); assert.match(r.out, /does not exist yet — has either app started/);
  assert.equal(fs.existsSync(notYet), false, 'the check created no ledger');
});

/* ---- release checks, 23 Oct 2026: access, permission width, identity, locking ---- */

function verifyAsync(argv) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...argv]);
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (status) => resolve({ status, out }));
  });
}

test('checkAccess: missing folder, a file where the folder should be, and an unwritable ledger are each named', () => {
  const base = fs.mkdtempSync(path.join(DIR, 'acc-'));
  assert.match(checkAccess(path.join(base, 'nope', 'l.db')).problems.join(), /does not exist \(create it: install -d -m 0700/);
  const notDir = path.join(base, 'plainfile'); fs.writeFileSync(notDir, 'x');
  assert.match(checkAccess(path.join(notDir, 'l.db')).problems.join(), /is not a directory/);
  const ro = path.join(base, 'ro.db'); fs.writeFileSync(ro, 'x'); fs.chmodSync(ro, 0o444);
  try { assert.match(checkAccess(ro).problems.join(), /ro\.db is not readable and writable/); } finally { fs.chmodSync(ro, 0o644); }
  assert.deepEqual(checkAccess(path.join(base, 'fresh.db')).problems, [], 'positive control: a writable folder with no ledger yet is fine');
});

test('checkAccess: a folder writable by group or others is wider than one user needs; 0700 is clean', () => {
  const stub = (mode) => ({ statSync: () => ({ isDirectory: () => true, mode, uid: 1000 }), accessSync: () => {}, existsSync: () => false });
  assert.match(checkAccess('/mnt/data/ai-gate/ledger.db', stub(0o40775), 'linux').problems.join(), /writable by group or others \(mode 775\).*0700/);
  assert.match(checkAccess('/mnt/data/ai-gate/ledger.db', stub(0o42775), 'linux').problems.join(), /writable by group or others/);
  assert.deepEqual(checkAccess('/mnt/data/ai-gate/ledger.db', stub(0o40700), 'linux').problems, []);
  assert.match(checkAccess('/mnt/data/ai-gate/ledger.db', stub(0o40700), 'linux').notes.join(), /folder mode 0700, owner uid 1000/);
});

test('compareIdentity: match is clean; a different id, no id, or an app that cannot be asked are each named', () => {
  const ok = (id) => ({ body: { ledger: { id } } });
  assert.deepEqual(compareIdentity('L1', ok('L1'), ok('L1')), []);
  assert.match(compareIdentity('L1', ok('L1'), ok('L2')).join(), /Identity mismatch: VANTAGE is writing ledger L2, but the file holds L1/);
  assert.match(compareIdentity('L1', { error: 'ECONNREFUSED' }, ok('L1')).join(), /NEURO could not be asked .*ECONNREFUSED/);
  assert.match(compareIdentity('L1', ok('L1'), { body: { ok: false, degraded: 'The shared AI ledger is unavailable.' } }).join(), /VANTAGE reports no ledger id \(The shared AI ledger is unavailable\.\)/);
});

test('--live end to end: both running apps are asked with their own PINs; a mismatched id fails, and no PIN is printed', async () => {
  const ledger = path.join(fs.mkdtempSync(path.join(DIR, 'live-')), 'ledger.db');
  process.env.AI_GATE_DB_PATH = ledger;
  const gate = require('../services/ai-gate'); gate._reset(); gate.register('neuro'); gate.register('vantage');
  const id = gate.ledgerInfo().id; assert.ok(id);
  const seen = {};
  const serve = (name, header, pin, reportId) => new Promise((r) => {
    const s = http.createServer((req, res) => {
      seen[name] = req.headers[header];
      if (req.url !== '/api/ai-gate/profile' || req.headers[header] !== pin) { res.writeHead(401); return res.end('{}'); }
      // The REAL shapes: NEURO answers bare; VANTAGE wraps every route as { ok, data }.
      const profile = { ok: true, ledger: { id: reportId }, ...(name === 'neuro' ? { peer: { state: reportId === id ? 'match' : 'mismatch' } } : {}) };
      res.end(JSON.stringify(name === 'vantage' ? { ok: true, data: profile } : profile));
    }).listen(0, '127.0.0.1', () => r(s));
  });
  const n = await serve('neuro', 'x-neuro-pin', 'neuro-secret-pin', id);
  const vGood = await serve('vantage', 'x-vantage-pin', 'vantage-secret-pin', id);
  const ne = envFile('ln.env', `AI_GATE_DB_PATH=${ledger}\nNEURO_PIN=neuro-secret-pin\n`);
  const ve = envFile('lv.env', `AI_GATE_DB_PATH=${ledger}\nVANTAGE_PIN=vantage-secret-pin\n`);
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const servers = [n, vGood];
  try {
  let r = await verifyAsync(['--neuro-env', ne, '--vantage-env', ve, '--live', '--neuro-url', url(n), '--vantage-url', url(vGood)]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /NEURO's own peer check: match/);
  assert.equal(seen.neuro, 'neuro-secret-pin'); assert.equal(seen.vantage, 'vantage-secret-pin');
  assert.ok(!/secret-pin/.test(r.out), 'no PIN in the output');

  const vBad = await serve('vantage', 'x-vantage-pin', 'vantage-secret-pin', 'some-other-ledger'); servers.push(vBad);
  r = await verifyAsync(['--neuro-env', ne, '--vantage-env', ve, '--live', '--neuro-url', url(n), '--vantage-url', url(vBad)]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Identity mismatch: VANTAGE is writing ledger some-other-ledger/);

  r = await verifyAsync(['--neuro-env', ne, '--vantage-env', ve, '--live', '--neuro-url', url(n), '--vantage-url', 'http://127.0.0.1:9']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /VANTAGE could not be asked/);
  } finally { for (const s of servers) s.close(); gate._reset(); } // a failed assertion must not leave servers holding the process open
});

test('--lock-probe: a ledger another process keeps write-locked is a named lock failure; released, it passes and nothing is written', async () => {
  const ledger = path.join(fs.mkdtempSync(path.join(DIR, 'lock-')), 'ledger.db');
  process.env.AI_GATE_DB_PATH = ledger;
  const gate = require('../services/ai-gate'); gate._reset(); gate.register('neuro'); gate.register('vantage'); gate._reset();
  const ne = envFile('kn.env', `AI_GATE_DB_PATH=${ledger}`); const ve = envFile('kv.env', `AI_GATE_DB_PATH=${ledger}`);
  const holderSrc = [
    "const D = require('better-sqlite3');",
    `const d = new D(${JSON.stringify(ledger)});`,
    "d.exec('BEGIN IMMEDIATE');",
    "d.prepare('INSERT INTO gate_meta(key, value) VALUES (?, ?)').run('lock-holder', 'x');",
    "process.stdout.write('held');",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const holder = spawn(process.execPath, ['-e', holderSrc], { cwd: __dirname });
  await new Promise((r, j) => { holder.stdout.once('data', r); holder.once('exit', (c) => j(new Error(`holder exited ${c}`))); });
  try {
    const r = await verifyAsync(['--neuro-env', ne, '--vantage-env', ve, '--lock-probe']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Lock\/concurrency failure: the ledger stayed write-locked for 3 s/);
  } finally { holder.kill(); await new Promise((r) => holder.once('exit', r)); }
  const before = hash(ledger);
  const r = await verifyAsync(['--neuro-env', ne, '--vantage-env', ve, '--lock-probe']);
  assert.match(r.out, /write lock taken and released in \d+ ms \(rolled back; nothing written\)/, r.out);
  assert.equal(hash(ledger), before, 'the probe wrote nothing to the ledger');
  const D = require('better-sqlite3'); const d = new D(ledger, { readonly: true });
  try { assert.equal(d.prepare("SELECT COUNT(*) n FROM gate_meta WHERE key='lock-holder'").get().n, 0, "the killed holder's uncommitted insert never landed"); } finally { d.close(); }
});
