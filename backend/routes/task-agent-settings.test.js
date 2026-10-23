'use strict';

/**
 * Settings → AI & SAiM → Anthropic for "Do this" (Stage 1, 23 Oct 2026).
 *
 * Real HTTP, real api-auth + authority guard, the REAL settings service, the REAL
 * task agent, the REAL Anthropic provider and AI gate (only the SDK client is
 * scripted). Network blocked. Proves:
 *
 *  1. defaults: off, no key, $1.00 and 10 runs a day; the temporary-storage notice
 *     and the "limits are active, gate is shadow" statement;
 *  2. owner only: API token, a declared machine client, the kiosk and no auth get
 *     nothing from any settings route;
 *  3. the key is never returned — not the key, its last four, its length or a hash —
 *     by any route, nor written to activity; it can be replaced and cleared;
 *  4. validation names the field and an invalid save changes nothing;
 *  5. switched off / no saved key: Do this is refused, nothing is created, no call;
 *     ANTHROPIC_API_KEY alone does not make it run;
 *  6. the run limit: the (N+1)th new run is refused before anything is created;
 *  7. the dollar limit: refused at the door when no step fits, and mid-run before
 *     the request that would cross it — nothing from that turn kept;
 *  8. the limits block ONLY Do this: another Anthropic call with Do this's budget
 *     spent still runs, the shared gate stays shadow, and no other code reads them;
 *  9. the synthetic connection test: confirm required; one bounded request; model,
 *     tokens, cost, ledger; no prompt or key; no task, draft, action, move, vault
 *     write; a failure is reported without the key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-settings-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
process.env.ANTHROPIC_API_KEY = 'env-key-used-by-other-features-only';
process.env.AI_MODE = 'hybrid';
delete process.env.AI_GATE_MODE;
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS', 'OPENROUTER_ALLOWED_TASKS', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];

global.fetch = async () => { throw new Error('network blocked'); };

const db = require('../db/database');
const taskStore = require('../services/task-store');
const agent = require('../services/task-agent');
const settings = require('../services/task-agent-settings');
const anthropic = require('../services/providers/anthropic-provider');

const KEY = 'sk-ant-api03-DISPOSABLE-test-key-ZZZZ-9f3k2';
const KEY2 = 'sk-ant-api03-SECOND-test-key-QQQQ-77aa1';
let server; let base;

// ── scripted SDK client ─────────────────────────────────────────────────────
const seen = [];
let script = [];
let nid = 1;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use', usage = { input_tokens: 1000, output_tokens: 250 }) => ({ model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage });
const end = () => reply([{ type: 'text', text: 'ok' }], 'end_turn');
anthropic._internals.setClient({ messages: { create: async (params, opts) => {
  seen.push({ prompt: JSON.stringify({ system: params.system, messages: params.messages }), model: params.model, max: params.max_tokens, opts });
  const step = script.shift();
  if (!step) return end();
  if (step instanceof Error) throw step;
  return typeof step === 'function' ? step(params) : step;
} } });

const NICK = { 'X-NEURO-PIN': 'pin-1234' };
function call(method, route, body, headers = NICK) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { let json = {}; try { json = JSON.parse(s || '{}'); } catch { json = {}; } resolve({ status: res.statusCode, json, raw: s }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const count = (sql) => { try { return db.get(sql).n; } catch { return 'absent'; } };
const runKeys = () => count("SELECT COUNT(*) n FROM agent_state WHERE key LIKE 'task_agent_run:%'");
function vaultHash() {
  const h = crypto.createHash('sha1');
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (!/NEURO Tasks \(export\)\.md$/.test(p)) h.update(p).update(fs.readFileSync(p)); } };
  walk(VAULT); return h.digest('hex');
}
function leaks(text) {
  const t = String(text);
  return [KEY, KEY2, KEY.slice(-4), KEY2.slice(-4), KEY.slice(0, 18), crypto.createHash('sha256').update(KEY).digest('hex')].filter((x) => t.includes(x))
    .concat(new RegExp(`"(len|length|keyLength)"\\s*:\\s*${KEY.length}\\b`).test(t) ? ['length'] : []);
}
async function press(id, body = {}) { const r = await call('POST', `/api/task-agent/tasks/${id}/start`, body); await agent._internals.waitFor(id); return r; }
async function state(id) { return (await call('GET', `/api/task-agent/tasks/${id}`)).json; }
const mk = (text) => taskStore.createTask({ text, source: 'test' }).id;
const saveOutput = () => [reply([tu('save_output', { kind: 'notes', title: 'Summary', markdown: 'a summary' })]), reply([tu('finish', { completed: ['done'], remaining: [] })]), end()];
const resetRuns = () => db.setState(settings._internals.RUNS_KEY, '');

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/task-agent', require('./task-agent'));
  app.use('/api/ai-gate', require('./ai-gate'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

// ── 1 ──
test('defaults: off, no key, $1.00 and 10 runs; the notice and the cap statement', async () => {
  const r = await call('GET', '/api/task-agent/settings');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.configured, false);
  assert.equal(r.json.dailyUsd, 1);
  assert.equal(r.json.dailyRuns, 10);
  assert.equal(r.json.model, 'claude-sonnet-4-6');
  assert.deepEqual(r.json.models.map((m) => m.id), ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
  assert.equal(r.json.notice, 'This key is stored on this NEURO server. Encrypted secret storage is the next security upgrade.');
  assert.match(r.json.capSay, /limits are active/);
  assert.match(r.json.capSay, /independent of the wider AI gate, which is still in shadow mode/);
  assert.equal(r.json.gateMode, 'shadow');
  assert.equal(r.json.today.runs, 0);
  assert.equal(r.json.today.usd, 0);
  assert.ok(r.json.resetsAt);
  assert.ok(!/encrypt(ed)? (at rest|storage is on)/i.test(r.raw.replace(r.json.notice, '')), 'never presented as encrypted');
});

// ── 2 ──
test('owner only: API token, a machine client, the kiosk and no auth get nothing', async () => {
  const others = [{ 'X-NEURO-API-TOKEN': 'tok-5678' }, { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' }, { 'X-NEURO-KIOSK-TOKEN': 'kiosk-9012' }];
  for (const h of others) {
    assert.equal((await call('GET', '/api/task-agent/settings', undefined, h)).status, 403);
    assert.equal((await call('POST', '/api/task-agent/settings', { enabled: true }, h)).status, 403);
    assert.equal((await call('POST', '/api/task-agent/settings/test', { confirm: true }, h)).status, 403);
  }
  for (const [m, p] of [['GET', '/api/task-agent/settings'], ['POST', '/api/task-agent/settings'], ['POST', '/api/task-agent/settings/test']]) {
    assert.equal((await call(m, p, m === 'POST' ? {} : undefined, {})).status, 401);
  }
  assert.equal(settings.read().enabled, false, 'nothing changed');
});

// ── 3 + 4 ──
test('the key is never returned or logged; invalid saves change nothing; replace and clear work', async () => {
  // invalid: each names its field, nothing is written
  for (const [body, field] of [[{ dailyUsd: 0 }, 'dailyUsd'], [{ dailyUsd: -1 }, 'dailyUsd'], [{ dailyUsd: 'abc' }, 'dailyUsd'], [{ dailyUsd: 51 }, 'dailyUsd'],
    [{ dailyRuns: 1.5 }, 'dailyRuns'], [{ dailyRuns: 0 }, 'dailyRuns'], [{ model: 'gpt-4' }, 'model'], [{ enabled: 'yes' }, 'enabled'],
    [{ enabled: true }, 'enabled'], [{ apiKey: 'short' }, 'apiKey'], [{ apiKey: '' }, 'apiKey'], [{ apiKey: KEY, dailyRuns: -3 }, 'dailyRuns']]) {
    const r = await call('POST', '/api/task-agent/settings', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.json.errors.some((e) => e.field === field), `${JSON.stringify(body)} → ${field}`);
    assert.deepEqual(leaks(r.raw), []);
  }
  assert.equal(settings.configured(), false, 'the key in a refused save was not stored');
  assert.equal((await call('POST', '/api/task-agent/settings', { secret: 'x' })).status, 400, 'unexpected field');

  const s1 = await call('POST', '/api/task-agent/settings', { apiKey: KEY, dailyUsd: 2.5, dailyRuns: 4 });
  assert.equal(s1.status, 200);
  assert.equal(s1.json.ok, true);
  assert.ok(s1.json.changed.includes('apiKey'));
  assert.equal(s1.json.settings.configured, true);
  assert.equal(s1.json.settings.enabled, false, 'saving a key does not switch it on');
  assert.deepEqual(leaks(s1.raw), []);
  const g = await call('GET', '/api/task-agent/settings');
  assert.deepEqual(leaks(g.raw), []);
  assert.deepEqual(Object.keys(g.json).filter((k) => /key/i.test(k)), [], 'no key-ish field at all; only "configured"');

  const s2 = await call('POST', '/api/task-agent/settings', { apiKey: KEY2 });
  assert.equal(s2.status, 200);
  assert.equal(settings.apiKey(), KEY2, 'replaced');
  const s3 = await call('POST', '/api/task-agent/settings', { enabled: true });
  assert.equal(s3.json.settings.enabled, true);
  const c = await call('POST', '/api/task-agent/settings', { clearKey: true });
  assert.equal(c.json.settings.configured, false);
  assert.equal(c.json.settings.enabled, false, 'clearing the key switches Do this off');
  assert.equal((await call('POST', '/api/task-agent/settings', { clearKey: true, apiKey: KEY })).status, 400, 'not both');

  const act = JSON.stringify(db.all("SELECT * FROM activity_log WHERE event_type LIKE 'task_agent%'"));
  assert.deepEqual(leaks(act), [], 'activity never carries the key');
  assert.match(act, /changed/);
});

// ── 5 ──
test('switched off, or no saved key: refused, nothing created, no call — ANTHROPIC_API_KEY alone does not run it', async () => {
  const id = mk('Draft the rota summary');
  const n0 = seen.length; const r0 = runKeys();
  const off = await press(id);
  assert.equal(off.status, 409);
  assert.match(off.json.error, /switched off/);
  assert.equal(runKeys(), r0); assert.equal(seen.length, n0);

  // On, but the key was cleared: the env key used by other features must not stand in.
  db.setState(settings._internals.SETTINGS_KEY, JSON.stringify({ enabled: true, model: 'claude-sonnet-4-6', dailyUsd: 1, dailyRuns: 10 }));
  const nokey = await press(id);
  assert.equal(nokey.status, 409);
  assert.match(nokey.json.error, /No Anthropic key is saved/);
  assert.equal(runKeys(), r0); assert.equal(seen.length, n0);
});

// ── 6 ──
test('the run limit: the (N+1)th new run is refused before anything is created, with the reset time', async () => {
  settings.save({ apiKey: KEY, enabled: true, dailyRuns: 2, dailyUsd: 5 });
  resetRuns();
  const a = mk('Run limit A'); const b = mk('Run limit B'); const c = mk('Run limit C');
  script = saveOutput(); assert.equal((await press(a)).status, 200);
  script = saveOutput(); assert.equal((await press(b)).status, 200);
  assert.equal((await state(a)).run.status, 'ready');
  const n0 = seen.length; const r0 = runKeys();
  const third = await press(c);
  assert.equal(third.status, 429);
  assert.equal(third.json.limit, 'runs');
  assert.match(third.json.error, /limit of 2 Do this runs is reached\. It resets at midnight \(UK time\)\. Nothing was created\./);
  assert.ok(third.json.resetsAt && new Date(third.json.resetsAt) > new Date());
  assert.equal(runKeys(), r0, 'no run record');
  assert.equal(seen.length, n0, 'no model request');
  assert.equal((await state(c)).run, null);
  // a repeat press on an existing run is not a new run and is not refused
  assert.equal((await press(a)).status, 200);
  const s = (await call('GET', '/api/task-agent/settings')).json;
  assert.equal(s.today.runs, 2);
  assert.equal(s.today.remainingRuns, 0);
});

// ── 7 ──
test('the dollar limit: refused at the door when no step fits; mid-run the request that would cross it is not sent and nothing is kept', async () => {
  resetRuns();
  const spent = settings.spendToday().usd;
  // Door: room for less than one step (Sonnet step worst case $0.084).
  settings.save({ dailyUsd: Math.round((spent + 0.05) * 100) / 100, dailyRuns: 50 });
  const id = mk('Budget door task');
  const n0 = seen.length; const r0 = runKeys();
  const r = await press(id);
  assert.equal(r.status, 429);
  assert.equal(r.json.limit, 'budget');
  assert.match(r.json.error, /Not enough of today’s \$[0-9.]+ Do this budget is left for a step.*resets at midnight \(UK time\)\. Nothing was created\./);
  assert.equal(runKeys(), r0); assert.equal(seen.length, n0);
  assert.equal(settings.runsToday(), 0, 'a refused run is not counted');

  // Mid-run: the first request goes; the budget then drops, so the second is refused before it is sent.
  settings.save({ dailyUsd: 10 });
  const mid = mk('Budget mid-run task');
  script = [() => { settings.save({ dailyUsd: Math.round((settings.spendToday().usd + 0.02) * 100) / 100 }); return reply([tu('save_output', { kind: 'notes', title: 'Half', markdown: 'half done' })]); },
    reply([tu('finish', { completed: ['x'], remaining: [] })])];
  const before = seen.length;
  await press(mid);
  const v = await state(mid);
  assert.equal(seen.length, before + 1, 'exactly one request was sent');
  assert.equal(v.run.status, 'failed');
  assert.equal(v.run.errorKind, 'limit');
  assert.match(v.run.error, /would take today’s Do this spend .* over the \$[0-9.]+ budget\. It resets at midnight \(UK time\)\. Nothing from this step was kept\./);
  assert.equal((v.run.outputs || []).length, 0, 'the half-finished turn kept nothing');
  // A press now is a resume and is refused (no room), not re-run.
  const again = await press(mid);
  assert.equal(again.status, 429);
  assert.equal(seen.length, before + 1);

  // An unreadable ledger fails CLOSED: no start, no request.
  settings.save({ dailyUsd: 10 });
  settings._internals.setDeps({ profile: () => null });
  try {
    const blind = mk('Ledger unreadable task');
    const n1 = seen.length; const r1 = runKeys();
    const b = await press(blind);
    assert.equal(b.status, 429);
    assert.equal(b.json.limit, 'ledger');
    assert.match(b.json.error, /cannot read today’s AI spend/);
    assert.equal(runKeys(), r1); assert.equal(seen.length, n1);
    assert.throws(() => settings.guardRequest({ model: 'claude-sonnet-4-6', maxInputTokens: 10, maxOutputTokens: 10 }), /cannot read today’s AI spend/);
    assert.equal((await call('GET', '/api/task-agent/settings')).json.today.known, false);
  } finally { settings._internals.setDeps(null); }
});

test('a run sends the SAVED key to the provider — never the ANTHROPIC_API_KEY other features use', async () => {
  resetRuns();
  settings.save({ apiKey: KEY, enabled: true, dailyUsd: 10, dailyRuns: 50 });
  const orig = anthropic.chatWithTools;
  const keys = [];
  anthropic.chatWithTools = (sys, msgs, tools, runTool, opts) => { keys.push(opts.apiKey); return orig(sys, msgs, tools, runTool, opts); };
  try {
    script = saveOutput();
    await press(mk('Which key is used'));
  } finally { anthropic.chatWithTools = orig; }
  assert.deepEqual(keys, [KEY]);
  assert.notEqual(keys[0], process.env.ANTHROPIC_API_KEY);
});

// ── 8 ──
test('the limits block ONLY Do this: another Anthropic call still runs, the gate stays shadow, nothing else reads them', async () => {
  settings.save({ dailyUsd: 0.01 });
  assert.equal(settings.budgetOpen().ok, false, 'Do this has no room');
  const n0 = seen.length;
  script = [reply([{ type: 'text', text: 'hello' }], 'end_turn')];
  const out = await anthropic.chat('sys', [{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-6', maxTokens: 50, callClass: 'chat_sync' });
  assert.equal(out.text, 'hello');
  assert.equal(seen.length, n0 + 1, 'a non-Do-this Anthropic call is not blocked');
  assert.equal((await call('GET', '/api/ai-gate/profile')).json.mode, 'shadow');
  assert.equal(require('../services/ai-gate-classes').REGISTRY.task_agent.maxPerDay, undefined, 'no gate-level limit was set');

  // No other code reads the Do this limits.
  const root = path.join(__dirname, '..');
  const readers = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (n === 'node_modules' || n.startsWith('.')) continue; if (fs.statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(n) && !/\.test\.js$/.test(n) && /task-agent-settings|guardRequest|claimRun/.test(fs.readFileSync(p, 'utf8'))) readers.push(path.relative(root, p).replace(/\\/g, '/')); } };
  walk(path.join(root, 'services')); walk(path.join(root, 'routes'));
  assert.deepEqual(readers.sort(), ['routes/task-agent.js', 'services/task-agent-settings.js', 'services/task-agent.js']);
  const openrouter = fs.readFileSync(path.join(root, 'services/providers/openrouter-provider.js'), 'utf8');
  assert.ok(!/beforeRequest|task-agent-settings/.test(openrouter));
});

// ── 9 ──
test('the connection test: confirm required; one bounded request; reports model/tokens/cost/ledger; no prompt, no key, no work', async () => {
  settings.save({ dailyUsd: 5 });
  const id = mk('Untouched by the connection test');
  const before = { runs: runKeys(), tasks: count('SELECT COUNT(*) n FROM tasks'), actions: count('SELECT COUNT(*) n FROM prepared_actions'), moves: count('SELECT COUNT(*) n FROM prepared_moves'), vault: vaultHash(), task: JSON.stringify(taskStore.getTask(id)), runCount: settings.runsToday() };

  const ask = await call('POST', '/api/task-agent/settings/test', {});
  assert.equal(ask.status, 400);
  assert.equal(ask.json.needsConfirm, true);
  assert.ok(ask.json.estimateUsd > 0 && ask.json.estimateUsd < 0.01);
  assert.equal((await call('POST', '/api/task-agent/settings/test', { confirm: true, prompt: 'x' })).status, 400, 'no other field');

  const n0 = seen.length;
  script = [reply([{ type: 'text', text: 'OK' }], 'end_turn', { input_tokens: 31, output_tokens: 2 })];
  const t = await call('POST', '/api/task-agent/settings/test', { confirm: true });
  assert.equal(t.status, 200, t.raw);
  assert.equal(t.json.ok, true);
  assert.equal(t.json.model, 'claude-sonnet-4-6');
  assert.equal(t.json.promptTokens, 31);
  assert.equal(t.json.completionTokens, 2);
  assert.ok(t.json.costUsd > 0);
  assert.equal(t.json.ledger.recorded, true);
  assert.equal(seen.length, n0 + 1, 'exactly one request');
  assert.ok(seen[seen.length - 1].max <= 16, 'bounded output');
  assert.equal(seen[seen.length - 1].opts.maxRetries, 0);
  assert.ok(!/connection check/i.test(t.raw), 'the prompt is not returned');
  assert.deepEqual(leaks(t.raw), []);
  const prof = (await call('GET', '/api/ai-gate/profile')).json;
  assert.ok(prof.byClass.some((r) => r.app === 'neuro' && r.callClass === 'task_agent_test'));

  // failure: the SDK message carries the key — the answer must not
  script = [Object.assign(new Error(`invalid x-api-key ${KEY}`), { status: 401 })];
  const f = await call('POST', '/api/task-agent/settings/test', { confirm: true });
  assert.equal(f.json.ok, false);
  assert.match(f.json.error, /rejected the key \(401\)/);
  script = [Object.assign(new Error(`weird upstream failure for ${KEY}`), { status: 418 })];
  const f2 = await call('POST', '/api/task-agent/settings/test', { confirm: true });
  assert.equal(f2.json.ok, false);
  assert.deepEqual(leaks(f2.raw), [], 'an unrecognised error is redacted');
  // A key with no recognisable shape is still removed — by its exact value.
  const PLAIN = 'plainkey-Abc123-xyz789-q';
  settings.save({ apiKey: PLAIN });
  script = [Object.assign(new Error(`odd failure mentioning ${PLAIN}`), { status: 418 })];
  const f3 = await call('POST', '/api/task-agent/settings/test', { confirm: true });
  assert.equal(f3.json.ok, false);
  assert.ok(!f3.raw.includes(PLAIN), 'the exact saved key is redacted');
  settings.save({ apiKey: KEY });

  const after = { runs: runKeys(), tasks: count('SELECT COUNT(*) n FROM tasks'), actions: count('SELECT COUNT(*) n FROM prepared_actions'), moves: count('SELECT COUNT(*) n FROM prepared_moves'), vault: vaultHash(), task: JSON.stringify(taskStore.getTask(id)), runCount: settings.runsToday() };
  assert.deepEqual(after, before, 'no task attempt, task change, draft, action, move, vault write or run count');
  const act = JSON.stringify(db.all("SELECT * FROM activity_log WHERE event_type = 'task_agent_settings'"));
  assert.deepEqual(leaks(act), []);
  assert.ok(!/connection check|Reply OK/i.test(act), 'no prompt in activity');
});
