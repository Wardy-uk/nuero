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

const SCRIPT = path.join(__dirname, 'ai-gate-verify.js');
const { envValue, comparePaths } = require('./ai-gate-verify');
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
  assert.equal(r.status, 1); assert.match(r.out, /does not exist yet/);
  assert.equal(fs.existsSync(path.dirname(missing)), false, 'the check created nothing');
});
