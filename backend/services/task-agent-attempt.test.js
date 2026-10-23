'use strict';

/**
 * "Do this" PER-ATTEMPT work budgets (23 Oct 2026). Real task store, real
 * task-context over a temp vault, the REAL Anthropic provider tool loop (only the
 * SDK client scripted — every request it would SEND is captured), real HTTP behind
 * the real api-auth + authority guard. Network blocked.
 *
 * Proves, separately from the daily $15 / 20-run allowance (which stays as saved and
 * still refuses on its own):
 *   - Settings: defaults 8 rounds / 6 notes / 3 searches / 80,000 input tokens /
 *     $2.00 / 4,000 output tokens; bounded, refused-not-clamped, owner-only;
 *   - a huge permitted note enters the prompt only as a bounded excerpt;
 *   - every limit (rounds, notes, searches, input tokens, cost) — including a final
 *     request that WOULD exceed the remaining budget, which is never sent;
 *   - the model is told before its last round to write the brief;
 *   - a capped attempt stops cleanly with its partial brief, what was done and what
 *     remains, and ONE "Continue working" control;
 *   - Continue working = exactly one new bounded part, counted as a daily run, with no
 *     repeated search; repeated presses, refresh and a restart never duplicate a search,
 *     read, model call or draft;
 *   - no full restricted, excluded, Archive or Security review/ content ever enters a prompt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-attempt-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
delete process.env.ANTHROPIC_API_KEY;
process.env.AI_MODE = 'hybrid';
delete process.env.AI_GATE_MODE;
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS', 'OPENROUTER_ALLOWED_TASKS']) delete process.env[k];
global.fetch = async () => { throw new Error('network blocked'); };

function write(rel, text) { const p = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }

const db = require('../db/database');
const taskStore = require('./task-store');
const tc = require('./task-context');
const agent = require('./task-agent');
const anthropic = require('./providers/anthropic-provider');
const taSettings = require('./task-agent-settings');

const sent = []; let script = []; let nid = 1; let usageIn = 1000;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use') => ({ model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage: { input_tokens: usageIn, output_tokens: 300 } });
const end = () => reply([{ type: 'text', text: 'ok' }], 'end_turn');
const toolResults = () => sent.flatMap((b) => { const m = JSON.parse(b).messages; const last = m[m.length - 1]; return Array.isArray(last.content) ? last.content.filter((c) => c.type === 'tool_result').map((c) => c.content) : []; });
anthropic._internals.setClient({ messages: { create: async (params) => { sent.push(JSON.stringify({ system: params.system, messages: params.messages })); return script.shift() || end(); } } });

const searches = [];
let searchResults = [];
const T = {};
let server; let base;
function req(method, url, body, headers = { 'X-NEURO-PIN': 'pin-1234' }) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* none */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
const limits = (a) => { const r = taSettings.save({ attempt: a }); assert.equal(r.ok, true, JSON.stringify(r.errors)); };
const DEFAULT_ATTEMPT = { maxRounds: 8, maxNotes: 6, maxSearches: 3, maxInputTokens: 80000, maxAttemptUsd: 2, maxOutputTokens: 4000 };
const budgetOf = (id) => JSON.parse(db.getState(`task_agent_budget:${id}`) || 'null');

const BIG = 'Projects/Rota/Huge rota history.md';
const MARK_DEEP = 'DEEP-MARKER-BEYOND-THE-EXCERPT';
const NOTES = ['Projects/Rota/A.md', 'Projects/Rota/B.md', 'Projects/Rota/C.md', 'Projects/Rota/D.md'];

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  taSettings.save({ apiKey: 'sk-ant-test-not-a-real-key-0000000000', enabled: true, dailyUsd: 15, dailyRuns: 20 });
  write(BIG, `# Huge rota history\n\n${'Week notes: cover was arranged and recorded. '.repeat(2000)}\n${MARK_DEEP}\n`);
  for (const n of NOTES) write(n, `# ${path.basename(n, '.md')}\n\nRota fact ${path.basename(n, '.md')}.\n`);
  write('Archive/Old rota.md', '# Old rota\n\nARCHIVE-MARKER-NEVER-IN-PROMPT\n');
  write('Security review/Rota passwords.md', '# Passwords\n\nSECURITY-MARKER hunter2\n');
  write('Projects/Rota/Opted out.md', '---\nneuro_context: exclude\n---\n# Opted out\n\nOPTOUT-MARKER\n');
  write('Meetings/2026/10/Private rota.md', '---\nprivate: true\n---\n# Private rota\n\nRESTRICTED-BODY-MARKER confidential detail.\nAgreed to plan the rota cover.\n');
  const mk = (text, extra = {}) => taskStore.createTask({ text, source: 'test', ...extra }).task;
  T.big = mk('Summarise the rota history');
  T.rounds = mk('Plan the rota cover for week 47');
  T.notes = mk('Check the rota facts');
  T.searches = mk('Find the rota decisions');
  T.input = mk('Compare the rota notes');
  T.cost = mk('Review the rota costs');
  T.priv = mk('Plan the rota cover', { origin_path: 'Meetings/2026/10/Private rota.md' });
  tc.ensure();
  assert.equal(tc.link({ taskId: T.big.id, type: 'note', ref: BIG }).ok, true);
  for (const n of NOTES) for (const t of [T.notes, T.input]) tc.link({ taskId: t.id, type: 'note', ref: n });
  agent._internals.setDeps({ search: async (q) => { searches.push(q); return searchResults; } });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-agent', require('../routes/task-agent'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { try { server.close(); } catch { /* */ } agent._internals.setDeps(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

test('Settings: the attempt defaults, bounded and refused-not-clamped, owner-only; the daily $15 / 20 stays as saved', async () => {
  const g = await req('GET', '/api/task-agent/settings');
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.attempt, DEFAULT_ATTEMPT);
  assert.equal(g.json.dailyUsd, 15); assert.equal(g.json.dailyRuns, 20);
  assert.match(g.json.attemptSay, /separately from the daily budget/);
  for (const bad of [{ maxRounds: 1 }, { maxRounds: 21 }, { maxAttemptUsd: '2.005' }, { maxInputTokens: '80,000' }, { maxNotes: 0 }, { surprise: 1 }]) {
    const r = await req('POST', '/api/task-agent/settings', { attempt: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(taSettings.attemptLimits(), DEFAULT_ATTEMPT, 'a refused save changes nothing');
  const ok = await req('POST', '/api/task-agent/settings', { attempt: { maxRounds: '10' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.settings.attempt.maxRounds, 10);
  assert.equal(ok.json.settings.dailyUsd, 15); assert.equal(ok.json.settings.dailyRuns, 20);
  for (const h of [{ 'X-NEURO-API-TOKEN': 'tok-5678' }, { 'X-NEURO-KIOSK-TOKEN': 'kiosk-9012' }, { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' }]) {
    const r = await req('POST', '/api/task-agent/settings', { attempt: { maxRounds: 3 } }, h);
    assert.ok(r.status === 401 || r.status === 403, JSON.stringify(h));
  }
  limits(DEFAULT_ATTEMPT);
  // only Do this reads them: no other provider or caller references the attempt limits
  for (const f of ['providers/openrouter-provider.js', 'ai-routing.js', 'claude.js', 'chat-tools.js']) {
    const p = path.join(__dirname, f); if (fs.existsSync(p)) assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /attemptLimits|maxAttemptUsd/, f);
  }
});

test('a huge permitted note enters the prompt only as a bounded excerpt', async () => {
  sent.length = 0;
  script = [reply([tu('read_note', { path: BIG })]), reply([tu('save_output', { kind: 'brief', title: 'Rota history brief', markdown: '- cover was arranged' })]), reply([tu('finish', { completed: ['Brief'], remaining: [] })]), end()];
  const v = await agent.start(T.big.id, { awaitTurn: true });
  assert.equal(v.run.status, 'ready');
  const all = sent.join('\n');
  assert.ok(!all.includes(MARK_DEEP), 'text past the excerpt never sent');
  const read = toolResults().find((r) => r.includes('Huge rota history'));
  const text = JSON.parse(read).text;
  assert.ok(text.length <= agent.MAX_READ_CHARS, `excerpt ${text.length} ≤ ${agent.MAX_READ_CHARS}`);
  assert.equal(JSON.parse(read).truncated, true);
  assert.ok(fs.statSync(path.join(VAULT, BIG)).size > 80000, 'the fixture really was large');
});

test('ROUNDS: the 4th request (over a 3-round limit) is never sent; NEURO warns before its last round; the partial brief is kept', async () => {
  limits({ ...DEFAULT_ATTEMPT, maxRounds: 3 });
  sent.length = 0; searches.length = 0; searchResults = [];
  script = [
    reply([tu('search_vault', { query: 'leave week 47' })]),
    reply([tu('save_output', { kind: 'brief', title: 'Week 47 cover brief', markdown: '## Draft\n- Week 47: two on leave' })]),
    reply([tu('search_vault', { query: 'cover swaps' })]),
    reply([tu('search_vault', { query: 'never sent' })]),
  ];
  const v = await agent.start(T.rounds.id, { awaitTurn: true });
  assert.equal(sent.length, 3, 'exactly the limit was sent');
  assert.equal(v.run.status, 'capped');
  assert.equal(v.run.cap.limit, 'rounds');
  assert.ok(toolResults().some((r) => /FINAL ROUND NEXT/.test(r)), 'the model was told before its last round');
  assert.deepEqual(v.run.outputs.map((o) => o.title), ['Week 47 cover brief'], 'the useful partial brief is kept');
  const w = v.workspace;
  assert.equal(w.status.label, 'Paused at this attempt’s limit');
  assert.match(w.continue.say, /used this attempt’s 3 model rounds/);
  assert.match(w.continue.completed.join(' '), /Prepared brief: “Week 47 cover brief”/);
  assert.ok(w.continue.remaining.length >= 1);
  assert.equal(w.continue.label, 'Continue working');
  assert.match(w.continue.cost, /counts as another run/);
  assert.equal(w.need, null); assert.ok(w.done.length <= 3);
  assert.equal(budgetOf(T.rounds.id).rounds, 3);
});

test('a plain press, refresh and a restart on a capped attempt make no model call, search or draft', async () => {
  const n = sent.length; const s0 = searches.length; const b0 = budgetOf(T.rounds.id);
  for (let i = 0; i < 3; i += 1) { const r = await req('POST', `/api/task-agent/tasks/${T.rounds.id}/start`, {}); assert.equal(r.status, 200); assert.equal(r.json.run.status, 'capped'); }
  assert.equal(agent.view(T.rounds.id).run.status, 'capped');
  assert.equal(sent.length, n); assert.equal(searches.length, s0);
  assert.deepEqual(budgetOf(T.rounds.id), b0, 'the attempt budget is untouched');
});

test('CONTINUE WORKING: one press = exactly one new bounded part, counted as a daily run, no repeated search; a second press while it runs adds nothing', async () => {
  const runs0 = taSettings.runsToday(); const s0 = searches.length; const n0 = sent.length;
  script = [
    reply([tu('search_vault', { query: 'leave week 47' })]), // already run in part 1 → served from the attempt's log, not searched again
    reply([tu('save_output', { kind: 'brief', title: 'Week 47 cover brief', markdown: '## Plan\n- Week 47: Sam covers 2nd line' })]),
    reply([tu('finish', { completed: ['Finished the brief'], remaining: [] })]), end(),
  ];
  const first = req('POST', `/api/task-agent/tasks/${T.rounds.id}/continue`, {});
  const second = req('POST', `/api/task-agent/tasks/${T.rounds.id}/continue`, {});
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  // The second press either finds the part running (returned as it is) or already finished
  // (nothing to continue) — never a second part.
  assert.ok((b.status === 200 && b.json.kicked === false) || b.status === 409, JSON.stringify({ s: b.status, k: b.json && b.json.kicked }));
  assert.equal(a.json.kicked, true);
  await agent._internals.waitFor(T.rounds.id);
  const v = agent.view(T.rounds.id);
  assert.equal(v.run.status, 'ready');
  assert.equal(taSettings.runsToday(), runs0 + 1, 'the continuation counted as ONE run');
  assert.equal(searches.length, s0, 'the repeated query was not searched again');
  assert.equal(sent.length - n0, 3, 'one bounded part: three requests');
  assert.equal(budgetOf(T.rounds.id).tranche, 2);
  assert.deepEqual(v.run.outputs.map((o) => o.title), ['Week 47 cover brief'], 'the draft was updated, not duplicated');
  const again = await req('POST', `/api/task-agent/tasks/${T.rounds.id}/continue`, {});
  assert.equal(again.status, 409, 'nothing to continue once ready');
});

test('NOTES: a third distinct note over a 2-note limit is refused ("you have enough"); NEURO writes from what it has', async () => {
  limits({ ...DEFAULT_ATTEMPT, maxNotes: 2 });
  sent.length = 0;
  script = [reply([tu('read_note', { path: NOTES[0] })]), reply([tu('read_note', { path: NOTES[1] })]), reply([tu('read_note', { path: NOTES[2] })]),
    reply([tu('save_output', { kind: 'answer', title: 'Rota facts', markdown: '- A and B' })]), reply([tu('finish', { completed: ['Answered'], remaining: [] })]), end()];
  const v = await agent.start(T.notes.id, { awaitTurn: true });
  assert.equal(budgetOf(T.notes.id).notes, 2);
  assert.ok(toolResults().some((r) => /You have enough to work with/.test(r)));
  const readResults = toolResults().map((r) => JSON.parse(r)).filter((r) => r.text);
  assert.equal(readResults.length, 2, 'two notes read in full');
  assert.ok(!readResults.some((r) => /Rota fact [CD]/.test(r.text)), 'the third note was never read into a prompt');
  const user = JSON.parse(sent[0]).messages[0].content;
  assert.ok((user.match(/Rota fact [A-D]\./g) || []).length <= 2, 'linked excerpts are bounded by the note limit too');
  assert.equal(v.run.status, 'ready');
});

test('SEARCHES: the second search over a 1-search limit is refused, and no search runs for it', async () => {
  limits({ ...DEFAULT_ATTEMPT, maxSearches: 1 });
  searches.length = 0; searchResults = [];
  script = [reply([tu('search_vault', { query: 'decisions one' })]), reply([tu('search_vault', { query: 'decisions two' })]),
    reply([tu('save_output', { kind: 'notes', title: 'Rota decisions', markdown: '- none found' })]), reply([tu('finish', { completed: ['Looked'], remaining: [] })]), end()];
  await agent.start(T.searches.id, { awaitTurn: true });
  assert.deepEqual(searches, ['decisions one']);
});

test('INPUT TOKENS: a request that would take the attempt past its input budget is computed, refused and NOT sent', async () => {
  limits({ ...DEFAULT_ATTEMPT, maxInputTokens: 10000 });
  sent.length = 0; usageIn = 3800;
  script = [reply([tu('read_note', { path: NOTES[0] })]), reply([tu('read_note', { path: NOTES[1] })]), reply([tu('save_output', { kind: 'brief', title: 'Rota comparison', markdown: '- A vs B' })]), reply([tu('read_note', { path: NOTES[2] })]), end()];
  const v = await agent.start(T.input.id, { awaitTurn: true });
  usageIn = 1000;
  const b = budgetOf(T.input.id);
  assert.ok(b.inputTokens <= 10000, `actual input ${b.inputTokens} within the budget`);
  assert.ok(sent.length < 5, `the over-budget request was not sent (${sent.length} sent)`);
  assert.equal(v.run.status, 'capped'); assert.equal(v.run.cap.limit, 'input');
  assert.match(v.workspace.continue.say, /past this attempt’s 10,000 input tokens/);
});

test('COST: a request whose worst case would cross the attempt cost limit is refused and NOT sent; the daily $15 is untouched', async () => {
  limits({ ...DEFAULT_ATTEMPT, maxAttemptUsd: 0.1, maxOutputTokens: 6000 }); // each request's worst case ≈ $0.09+
  sent.length = 0;
  script = [reply([tu('save_output', { kind: 'brief', title: 'Rota cost brief', markdown: '- costs' })]), reply([tu('search_vault', { query: 'cost a' })]), reply([tu('search_vault', { query: 'cost b' })]), reply([tu('search_vault', { query: 'cost c' })]), end()];
  const v = await agent.start(T.cost.id, { awaitTurn: true });
  const b = budgetOf(T.cost.id);
  assert.equal(v.run.status, 'capped'); assert.equal(v.run.cap.limit, 'cost');
  assert.ok(b.costUsd <= 0.1, `actual attempt cost $${b.costUsd} within $0.10`);
  assert.ok(sent.length >= 1 && sent.length < 4);
  assert.match(v.workspace.continue.say, /past this attempt’s \$0\.10 cost limit/);
  assert.equal(taSettings.read().dailyUsd, 15);
});

test('the DAILY 20-run limit still refuses Continue working on its own', async () => {
  limits(DEFAULT_ATTEMPT);
  const key = taSettings._internals.RUNS_KEY;
  const saved = db.getState(key);
  db.setState(key, JSON.stringify({ day: require('./ai-gate').londonDay(Date.now()), count: 20 }));
  try {
    const r = await req('POST', `/api/task-agent/tasks/${T.cost.id}/continue`, {});
    assert.equal(r.status, 429); assert.equal(r.json.limit, 'runs');
    assert.equal(agent.view(T.cost.id).run.status, 'capped', 'still paused; nothing started');
  } finally { db.setState(key, saved); }
  const s = taSettings.read(); assert.equal(s.dailyUsd, 15); assert.equal(s.dailyRuns, 20);
});

test('restart mid-attempt: an interrupted part resumes in the SAME budget (not reset) and repeats no search', async () => {
  limits({ ...DEFAULT_ATTEMPT, maxRounds: 4 });
  searches.length = 0; searchResults = [];
  script = [reply([tu('search_vault', { query: 'restart query' })]), reply([tu('ask_nick', { kind: 'missing', question: 'Which week should the rota plan cover?', why: 'Two weeks are possible.', after: 'NEURO will draft that week.' })]), end()];
  const t = taskStore.createTask({ text: 'Draft the restart rota', source: 'test' }).task;
  let v = await agent.start(t.id, { awaitTurn: true });
  assert.equal(v.run.status, 'needs-answer');
  const b0 = budgetOf(t.id);
  // simulate a restart while the answer turn was running
  const raw = JSON.parse(db.getState(`task_agent_run:${t.id}`));
  raw.status = 'running'; raw.question = null; raw.heartbeatAt = new Date(Date.now() - 3600e3).toISOString();
  db.setState(`task_agent_run:${t.id}`, JSON.stringify(raw));
  assert.equal(agent.view(t.id).run.status, 'interrupted');
  script = [reply([tu('search_vault', { query: 'restart query' })]), reply([tu('save_output', { kind: 'plan', title: 'Restart rota plan', markdown: '- week 47' })]), reply([tu('finish', { completed: ['Plan'], remaining: [] })]), end()];
  v = await agent.start(t.id, { awaitTurn: true });
  const b1 = budgetOf(t.id);
  assert.equal(b1.tranche, b0.tranche, 'same part');
  assert.ok(b1.rounds > b0.rounds, 'rounds kept counting from where they were');
  assert.deepEqual(searches, ['restart query'], 'the repeated query was not searched again');
  assert.equal(v.run.outputs.length, 1);
});

test('no full restricted, excluded, Archive or Security review/ content ever enters a prompt', async () => {
  limits(DEFAULT_ATTEMPT);
  sent.length = 0;
  searchResults = ['Archive/Old rota.md', 'Security review/Rota passwords.md', 'Projects/Rota/Opted out.md', 'Meetings/2026/10/Private rota.md'].map((p) => ({ relativePath: p, excerpts: ['x'] }));
  script = [reply([tu('search_vault', { query: 'rota everything' })]),
    reply([tu('read_note', { path: 'Archive/Old rota.md' }), tu('read_note', { path: 'Security review/Rota passwords.md' }), tu('read_note', { path: 'Projects/Rota/Opted out.md' }), tu('read_note', { path: 'Meetings/2026/10/Private rota.md' })]),
    reply([tu('save_output', { kind: 'plan', title: 'Rota plan', markdown: '- plan' })]), reply([tu('finish', { completed: ['Plan'], remaining: [] })]), end()];
  await agent.start(T.priv.id, { awaitTurn: true });
  const all = sent.join('\n');
  for (const m of ['ARCHIVE-MARKER-NEVER-IN-PROMPT', 'SECURITY-MARKER', 'hunter2', 'OPTOUT-MARKER', 'RESTRICTED-BODY-MARKER']) assert.ok(!all.includes(m), `${m} never sent`);
  assert.ok(sent.length >= 2, 'positive control: the attempt did run');
  searchResults = [];
});
