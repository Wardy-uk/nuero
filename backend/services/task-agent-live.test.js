'use strict';

/**
 * "Do this" against the REAL Anthropic API (23 Oct 2026) — DISPOSABLE ONLY.
 *
 * ⚠ It runs ONLY when TASK_AGENT_LIVE_ANTHROPIC_KEY is set to a key Nick has
 * provided for testing. It never reads ANTHROPIC_API_KEY (which it deletes from
 * its own process first), never loads backend/.env, and uses a throwaway DB, a
 * throwaway vault and the gate's throwaway test ledger. Without the variable it
 * SKIPS and says why — it is not evidence until it has run.
 *
 * One harmless synthetic task, one synthetic note, the cheapest priced model the
 * installed SDK names (claude-haiku-4-5-20251001, $1/$5 per Mtok), so a full run
 * costs about a cent. Proves:
 *   - the real provider runs through the existing gate and its ledger;
 *   - input/output tokens and cost are recorded on the run AND on the ledger;
 *   - a real provider failure (a deliberately invalid key → 401) keeps nothing;
 *   - the next press with the real key resumes cleanly, once.
 *
 *   TASK_AGENT_LIVE_ANTHROPIC_KEY=<disposable key> node --test services/task-agent-live.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVE = process.env.TASK_AGENT_LIVE_ANTHROPIC_KEY || '';
const SKIP = LIVE ? null : 'TASK_AGENT_LIVE_ANTHROPIC_KEY is not set — the real-provider proof was NOT run (it needs a disposable key from Nick; the production key is never used).';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-live-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.AI_MODE = 'hybrid';
process.env.TASK_AGENT_MODEL = 'claude-haiku-4-5-20251001';
delete process.env.ANTHROPIC_API_KEY; // never the production key
delete process.env.AI_GATE_DB_PATH;   // the gate's per-test throwaway ledger
delete process.env.AI_GATE_MODE;
for (const k of ['OPENROUTER_ALLOWED_TASKS', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS']) delete process.env[k];

test('real Anthropic call through the gate: tokens and cost recorded; a failure keeps nothing; resume is clean', { skip: SKIP || false, timeout: 180000 }, async () => {
  const db = require('../db/database');
  fs.mkdirSync(path.join(tmp, 'vault', 'Projects', 'Garden'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'vault', 'Projects', 'Garden', 'Plant care.md'), '# Plant care\n\nThe office fern needs water twice a week and indirect light.\n');
  await db.init();
  const taskStore = require('./task-store');
  const tc = require('./task-context');
  const agent = require('./task-agent');
  const anthropic = require('./providers/anthropic-provider');
  const id = taskStore.createTask({ text: 'Write a three-item checklist for looking after the office fern', source: 'test' }).id;
  tc.ensure();
  assert.equal(tc.link({ taskId: id, type: 'note', ref: 'Projects/Garden/Plant care.md' }).ok, true);

  // 1. A real provider failure: an invalid key → the real API answers 401.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-invalid-for-test-only';
  anthropic._internals.setClient(null);
  await agent.start(id, { awaitTurn: true });
  let v = agent.view(id);
  assert.equal(v.run.status, 'failed');
  assert.equal((v.run.outputs || []).length, 0, 'nothing kept from the failed call');
  assert.equal(db.get('SELECT COUNT(*) n FROM prepared_actions').n, 0);

  // 2. The disposable key: the real run, once.
  process.env.ANTHROPIC_API_KEY = LIVE;
  anthropic._internals.setClient(null);
  const r = await agent.start(id, { awaitTurn: true });
  assert.equal(r.kicked, true);
  v = agent.view(id);
  assert.ok(['ready', 'needs-answer', 'blocked'].includes(v.run.status), `settled: ${v.run.status} ${v.run.error || ''}`);
  assert.equal(v.run.usage.model, 'claude-haiku-4-5-20251001');
  assert.ok(v.run.usage.promptTokens > 0 && v.run.usage.completionTokens > 0, 'real tokens recorded on the run');
  assert.ok(v.run.usage.costUsd > 0 && v.run.usage.costUsd < 0.25, `cost recorded and bounded: $${v.run.usage.costUsd}`);
  const prof = require('./ai-gate').profile({});
  const row = (prof.byClass || []).find((c) => c.app === 'neuro' && c.callClass === 'task_agent');
  assert.ok(row && row.calls >= 1 && row.usd > 0, 'the gate ledger holds the task_agent tickets with their cost');
  console.log(`[live] status ${v.run.status}; ${v.run.usage.promptTokens} in / ${v.run.usage.completionTokens} out; $${v.run.usage.costUsd}; gate tickets ${row.calls}, $${row.usd}`);

  // 3. A repeat press makes no further call.
  const again = agent.start(id);
  assert.equal(again.kicked, false);
  delete process.env.ANTHROPIC_API_KEY;
});
