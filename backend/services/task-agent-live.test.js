'use strict';

/**
 * "Do this" against the REAL Anthropic API (23 Oct 2026) — DISPOSABLE KEY ONLY.
 *
 * ⚠ The key comes ONLY from a disposable key Nick created for testing, in ONE of:
 *     - the environment variable TASK_AGENT_LIVE_ANTHROPIC_KEY, or
 *     - the file %LOCALAPPDATA%\neuro\task-agent-live-anthropic.key (first line)
 *   It never reads ANTHROPIC_API_KEY (deleted from this process first), never
 *   loads backend/.env, never prints, logs or stores the key, and uses a
 *   throwaway DB, vault and AI-gate ledger. Without a key it SKIPS and says so.
 *
 * One harmless synthetic task, one synthetic note, the configured provider path
 * end to end (task-agent → anthropic-provider → AI gate → ledger). Model:
 * TASK_AGENT_LIVE_MODEL, else NEURO's default (claude-sonnet-4-6). Proves:
 *   1. a real provider failure (an invalid key → 401) keeps nothing;
 *   2. a real TIMEOUT (TASK_AGENT_REQUEST_TIMEOUT_MS shortened to 1 ms) keeps nothing;
 *   3. the real run: the model id is accepted, a useful safe result, tokens and
 *      cost on the run AND on the gate ledger, matching;
 *   4. a repeat press makes no further call; nothing outside the run was written.
 * Exhausted credit cannot be forced without draining a key; its handling is
 * proven with the SDK's real error shape in task-agent-next.test.js.
 *
 *   node --test backend/services/task-agent-live.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'neuro', 'task-agent-live-anthropic.key');
function liveKey() {
  if (process.env.TASK_AGENT_LIVE_ANTHROPIC_KEY) return String(process.env.TASK_AGENT_LIVE_ANTHROPIC_KEY).trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}
const LIVE = liveKey();
const SKIP = LIVE ? null : `no disposable key: set TASK_AGENT_LIVE_ANTHROPIC_KEY or put it in ${KEY_FILE} — the real-provider proof was NOT run (the production key is never used).`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-live-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.AI_MODE = 'hybrid';
if (process.env.TASK_AGENT_LIVE_MODEL) process.env.TASK_AGENT_MODEL = process.env.TASK_AGENT_LIVE_MODEL; else delete process.env.TASK_AGENT_MODEL;
delete process.env.ANTHROPIC_API_KEY; // never the production key
delete process.env.AI_GATE_DB_PATH;   // the gate's per-test throwaway ledger
delete process.env.AI_GATE_MODE;
delete process.env.TASK_AGENT_REQUEST_TIMEOUT_MS;
for (const k of ['OPENROUTER_ALLOWED_TASKS', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];

test('real Anthropic path: failure and timeout keep nothing; the real run is gated, costed and useful; resume is clean', { skip: SKIP || false, timeout: 240000 }, async () => {
  const db = require('../db/database');
  fs.mkdirSync(path.join(VAULT, 'Projects', 'Garden'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'Projects', 'Garden', 'Plant care.md'), '# Plant care\n\nThe office fern needs water twice a week and indirect light. Mist the leaves on Fridays.\n');
  await db.init();
  const taskStore = require('./task-store');
  const tc = require('./task-context');
  const agent = require('./task-agent');
  const gate = require('./ai-gate');
  const anthropic = require('./providers/anthropic-provider');
  const id = taskStore.createTask({ text: 'Write a three-item checklist for looking after the office fern', source: 'test' }).id;
  tc.ensure();
  assert.equal(tc.link({ taskId: id, type: 'note', ref: 'Projects/Garden/Plant care.md' }).ok, true);

  const count = (sql) => { try { return db.get(sql).n; } catch { return 'absent'; } };
  const vault = () => { const o = {}; const w = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) w(p); else if (!/NEURO Tasks \(export\)\.md$/.test(p)) o[path.relative(VAULT, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } }; w(VAULT); return o; };
  const outward = () => ({
    vault: vault(), tasks: JSON.stringify(db.all('SELECT id, text, status, due_date FROM tasks ORDER BY id')),
    actions: count('SELECT COUNT(*) n FROM prepared_actions'), ledger: count('SELECT COUNT(*) n FROM external_write_ledger'),
    calendar: count('SELECT COUNT(*) n FROM calendar_cache'), intents: count('SELECT COUNT(*) n FROM human_action_intents'),
    grants: count('SELECT COUNT(*) n FROM saim_authority_grants'), moves: count('SELECT COUNT(*) n FROM prepared_moves'),
  });
  const before = outward();
  const use = (key) => { process.env.ANTHROPIC_API_KEY = key; anthropic._internals.setClient(null); };

  // 1. A real provider failure: an invalid key → the real API answers 401.
  use('sk-ant-invalid-for-test-only');
  await agent.start(id, { awaitTurn: true });
  let v = agent.view(id);
  assert.equal(v.run.status, 'failed');
  assert.equal((v.run.outputs || []).length, 0, 'nothing kept from the failed call');
  assert.deepEqual(outward(), before, 'a failure writes nothing');

  // 2. A real timeout: the real SDK, the real network, a 1 ms limit.
  use(LIVE);
  process.env.TASK_AGENT_REQUEST_TIMEOUT_MS = '1';
  try { await agent.start(id, { awaitTurn: true }); } finally { delete process.env.TASK_AGENT_REQUEST_TIMEOUT_MS; }
  v = agent.view(id);
  assert.equal(v.run.status, 'failed');
  assert.equal(v.run.errorKind, 'timeout', `classified as a timeout: ${v.run.error}`);
  assert.equal((v.run.outputs || []).length, 0, 'nothing kept from the timed-out call');
  assert.deepEqual(outward(), before, 'a timeout writes nothing');

  // 3. The real run, once.
  const r = await agent.start(id, { awaitTurn: true });
  assert.equal(r.kicked, true);
  v = agent.view(id);
  assert.ok(['ready', 'needs-answer'].includes(v.run.status), `a useful safe result: ${v.run.status} ${v.run.error || ''}`);
  if (v.run.status === 'ready') assert.ok((v.run.outputs || []).length >= 1 && /fern|water|light|mist/i.test(v.run.outputs.map((o) => o.markdown).join(' ')), 'a checklist grounded in the fixture note');
  const model = process.env.TASK_AGENT_MODEL || agent.DEFAULT_MODEL;
  assert.equal(v.run.usage.model, model, 'the configured model was accepted by Anthropic');
  assert.ok(v.run.usage.promptTokens > 0 && v.run.usage.completionTokens > 0, 'real tokens on the run');
  assert.ok(v.run.usage.costUsd > 0 && v.run.usage.costUsd < 0.5, `cost recorded and bounded: $${v.run.usage.costUsd}`);
  const tickets = (() => { const g = new (require('better-sqlite3'))(gate.ledgerPath(), { readonly: true }); try { return g.prepare("SELECT model, status, decision, mode, cost_usd, in_tokens, out_tokens FROM gate_tickets WHERE call_class = 'task_agent' AND status = 'settled'").all(); } catch (e) { return { error: e.message }; } finally { g.close(); } })();
  const prof = gate.profile({});
  const row = (prof.byClass || []).find((c) => c.app === 'neuro' && c.callClass === 'task_agent');
  assert.ok(row && row.calls >= 1 && row.usd > 0, 'the gate ledger holds the task_agent tickets with their cost');
  assert.equal(prof.mode, 'shadow', 'shadow mode: recorded, not blocking');
  assert.ok(Math.abs(row.usd - v.run.usage.costUsd) < 0.0005, `ledger cost ($${row.usd}) matches the run ($${v.run.usage.costUsd})`);
  // Report — model, tokens, ledger, cost. Never the prompt or the key.
  console.log(`[live] model ${v.run.usage.model}; status ${v.run.status}; ${v.run.usage.promptTokens} in / ${v.run.usage.completionTokens} out; run cost $${v.run.usage.costUsd}; ledger: ${row.calls} task_agent ticket(s), $${row.usd}, mode ${prof.mode}; tickets ${JSON.stringify(tickets)}`);

  // 4. A repeat press makes no further call; nothing outside the run was written.
  const again = agent.start(id);
  assert.equal(again.kicked, false);
  assert.deepEqual(outward(), before, 'no vault, task, calendar, prepared action, confirmation, allowance or move');
  delete process.env.ANTHROPIC_API_KEY;
});
