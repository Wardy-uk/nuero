'use strict';

/**
 * The concise "Do this" workspace and its server-enforced run controls
 * (23 Oct 2026). Real task store, task-context over a temp vault, the REAL
 * Anthropic provider tool loop with only the SDK client scripted, real HTTP
 * behind the real api-auth + authority guard. Network blocked.
 *
 *  - the workspace is composed by the server: Status (one line + will/won't),
 *    What NEURO has done (≤3), What I need from you (one question or none),
 *    and a one-line trace summary;
 *  - the employment case: NEURO never chooses the decision — a generic question
 *    is refused, the specific decision is asked once, and after Nick states it the
 *    run finishes with the brief instead of asking again;
 *  - the same question is never asked twice unless the model says what changed;
 *  - searches are deduped across the attempt; a note is never read twice in one
 *    turn; exploration is capped and ends in "I have enough";
 *  - a live phase is visible while a turn is in flight and gone afterwards;
 *  - refresh restores the one question; a repeated press makes no model call;
 *  - kiosk, API token and declared machines get no workspace; chat has no tool.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ws-'));
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

const PLAN = 'Projects/Support Rota/Q4 rota notes.md';
const OTHER = 'Projects/Support Rota/Leave calendar.md';
const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example leaver catch up.md';

let script = []; let calls = 0; let nid = 1;
let onCreate = null;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use') => ({ model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 200 } });
const end = () => reply([{ type: 'text', text: 'ok' }], 'end_turn');
const lastToolResults = [];
anthropic._internals.setClient({ messages: { create: async (params) => {
  calls += 1;
  const last = params.messages[params.messages.length - 1];
  if (last && Array.isArray(last.content)) for (const c of last.content) if (c.type === 'tool_result') lastToolResults.push(typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
  if (onCreate) await onCreate();
  return script.shift() || end();
} } });

const searches = [];
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

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  taSettings.save({ apiKey: 'sk-ant-test-not-a-real-key-0000000000', enabled: true, dailyUsd: 50, dailyRuns: 200 });
  write(PLAN, '# Q4 rota notes\n\nCover gaps: weeks 44 and 47.\n');
  write(OTHER, '# Leave calendar\n\nWeek 47: two people on leave.\n');
  write(HR, '---\nprivate: true\n---\n# Leaver catch up\n\nAgreed to confirm Heidi Example end date once HR reply.\n');
  const mk = (text, extra = {}) => taskStore.createTask({ text, source: 'test', ...extra }).task;
  T.plain = mk('Plan the Q4 support rota cover');
  T.amb = mk('Sort out the report');
  T.hr = mk("Set and confirm Heidi Example's end date before September 30", { origin_path: HR });
  T.dedupe = mk('Work out the leave cover for week 47');
  T.cap = mk('Research the rota history');
  tc.ensure();
  assert.equal(tc.link({ taskId: T.plain.id, type: 'note', ref: PLAN }).ok, true);
  assert.equal(tc.link({ taskId: T.dedupe.id, type: 'note', ref: PLAN }).ok, true);
  const now = new Date().toISOString();
  db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, origin, state, confidence, reasons_json, restricted, created_at, updated_at) VALUES (?, 'note', ?, 'Leaver catch up', 'nightly-scan', 'pinned', 1, '[{"code":"origin","say":"This task was raised in this note."}]', 1, ?, ?)`, [T.hr.id, HR, now, now]);
  agent._internals.setDeps({ search: async (q) => { searches.push(q); return [{ relativePath: OTHER, excerpts: ['Week 47: two people on leave.'] }, { relativePath: PLAN, excerpts: ['Cover gaps'] }]; } });

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

test('employment acceptance case: generic question refused, the SPECIFIC decision asked once; workspace is three parts', async () => {
  script = [
    reply([tu('save_output', { kind: 'brief', title: 'Heidi Example – End Date Decision Brief', markdown: '## Facts\n- HR reply awaited\n## Options\n- 30 September 2026\n- 31 December 2026\n## Decision\nOpen — Nick to decide.' })]),
    reply([tu('ask_nick', { kind: 'authority', question: 'This is an employment matter. What do you decide, and should NEURO prepare anything further?', why: 'x', after: 'y' })]),
    reply([tu('ask_nick', { kind: 'authority', question: 'What end date should the brief record for Heidi Example?', why: 'The end date drives the notice letter and the handover plan.', after: 'NEURO will record it in the private brief and stop; it will not contact anyone.', options: ['30 September 2026', '31 December 2026'] })]),
    end(),
  ];
  lastToolResults.length = 0;
  const v = await agent.start(T.hr.id, { awaitTurn: true });
  assert.ok(lastToolResults.some((r) => /Ask the specific thing/.test(r)), 'the generic question was refused with the reason');
  assert.equal(v.run.status, 'needs-decision');
  const w = v.workspace;
  assert.equal(w.status.label, 'Waiting for your decision');
  assert.match(w.status.wont, /will not decide, contact anyone, promise anything or change anything/);
  assert.ok(w.done.length >= 1 && w.done.length <= 3);
  assert.ok(w.done.some((d) => /Prepared a private brief: “Heidi Example – End Date Decision Brief”/.test(d.say) && d.open && d.open.label === 'Open brief'));
  assert.ok(w.done.some((d) => /No one has been contacted and nothing has been changed\./.test(d.say)));
  assert.equal(w.need.question, 'What end date should the brief record for Heidi Example?');
  assert.deepEqual(w.need.options, ['30 September 2026', '31 December 2026']);
  assert.match(w.need.after, /record it in the private brief/);
  assert.equal(w.need.allowOther, true);
  assert.match(w.trace.summary, /^\d+ permitted sources? used · \d+ internal steps?$/);
  assert.doesNotMatch(JSON.stringify(w), /anything further/);
});

test('refresh restores the one question; a repeated press while waiting makes no model call and no second question', async () => {
  const before = calls;
  const a = agent.view(T.hr.id); const b = agent.view(T.hr.id);
  assert.equal(a.workspace.need.id, b.workspace.need.id);
  const r1 = await req('POST', `/api/task-agent/tasks/${T.hr.id}/start`, {});
  const r2 = await req('POST', `/api/task-agent/tasks/${T.hr.id}/start`, {});
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(r2.json.workspace.need.id, a.workspace.need.id, 'same question');
  assert.equal(calls, before, 'no model call');
  const g = await req('GET', `/api/task-agent/tasks/${T.hr.id}`);
  assert.equal(g.json.workspace.need.question, 'What end date should the brief record for Heidi Example?');
});

test('Nick states the date: NEURO records it in the brief and finishes — the decision is not re-asked, and re-asking the same question is refused', async () => {
  const v0 = agent.view(T.hr.id);
  script = [
    reply([tu('ask_nick', { kind: 'authority', question: 'Which end date should the brief record for Heidi Example?', why: 'x', after: 'y' })]),
    reply([tu('save_output', { kind: 'brief', title: 'Heidi Example – End Date Decision Brief', markdown: '## Decision\nNick: 31 December 2026.\n## Facts\n- HR reply awaited' })]),
    reply([tu('finish', { completed: ['Recorded your decision in the brief'], remaining: ['Issue the letter yourself'] })]),
    end(),
  ];
  lastToolResults.length = 0;
  const v = await agent.answer(T.hr.id, { questionId: v0.workspace.need.id, text: '31 December 2026', awaitTurn: true });
  assert.ok(lastToolResults.some((r) => /You already asked this and Nick answered: “31 December 2026”/.test(r)), 'the repeat was refused, quoting his answer');
  assert.equal(v.run.status, 'ready');
  assert.equal(v.workspace.need, null, 'no further question');
  assert.equal(v.workspace.status.label, 'Ready for you');
  assert.ok(v.run.outputs.every((o) => o.next && o.next.canSave === false), 'a people-matter brief is not offered for saving');
  assert.equal(v.run.answers.length, 1);
});

test('re-asking IS allowed when new evidence changed the question — and the workspace says what changed', async () => {
  script = [reply([tu('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'Different audiences.', after: 'NEURO will draft its outline.', options: ['Weekly risk report', 'SOAP report'] })]), end()];
  let v = await agent.start(T.amb.id, { awaitTurn: true });
  assert.equal(v.workspace.status.label, 'Waiting for your answer');
  script = [reply([tu('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'x', after: 'y', changed: 'Chris asked for both this week, so “the report” is still not clear.', options: ['Weekly risk report', 'SOAP report'] })]), end()];
  v = await agent.answer(T.amb.id, { questionId: v.workspace.need.id, text: 'the usual one', awaitTurn: true });
  assert.equal(v.run.status, 'needs-answer');
  assert.match(v.workspace.need.changed, /Chris asked for both/);
});

test('ordinary task, no question: Ready for you; done is evidence + the draft; the phase was live mid-turn and is gone after', async () => {
  const phases = [];
  onCreate = async () => { const p = agent.view(T.plain.id); if (p.run) phases.push(p.workspace.status.phase); };
  script = [reply([tu('read_note', { path: PLAN })]), reply([tu('save_output', { kind: 'plan', title: 'Q4 rota cover plan', markdown: '- Week 44\n- Week 47', sources: ['ctx:1'] })]), reply([tu('finish', { completed: ['Drafted the plan'], remaining: [] })]), end()];
  const v = await agent.start(T.plain.id, { awaitTurn: true });
  onCreate = null;
  assert.equal(v.run.status, 'ready');
  assert.equal(v.workspace.need, null);
  assert.equal(v.workspace.status.label, 'Ready for you');
  assert.ok(v.run.outputs.some((o) => o.next && o.next.canSave), 'its draft can be saved');
  assert.equal(v.workspace.status.phase, null);
  assert.match(v.workspace.done[0].say, /Checked the permitted evidence \(1 source\)/);
  assert.match(v.workspace.done[1].say, /Prepared a private plan: “Q4 rota cover plan”/);
  assert.ok(phases.includes('Checking evidence'), `phase seen while running: ${phases}`);
  assert.equal(db.getState(`task_agent_phase:${T.plain.id}`), null, 'phase cleared');
});

test('dedupe: a search is not repeated within the attempt (even across turns); a note is never read twice in one attempt', async () => {
  searches.length = 0; lastToolResults.length = 0;
  script = [
    reply([tu('search_vault', { query: 'leave week 47' })]),
    reply([tu('search_vault', { query: 'Leave  week 47' })]),
    reply([tu('read_note', { path: OTHER })]),
    reply([tu('read_note', { path: OTHER })]),
    reply([tu('ask_nick', { kind: 'missing', question: 'Who covers second line in week 47?', why: 'Two are on leave.', after: 'NEURO will put them in the cover plan.' })]),
    end(),
  ];
  let v = await agent.start(T.dedupe.id, { awaitTurn: true });
  assert.equal(searches.length, 1, 'the identical search ran once');
  assert.ok(lastToolResults.some((r) => /already ran this search/.test(r)));
  assert.ok(lastToolResults.some((r) => /already read this note in this attempt/.test(r)));
  script = [reply([tu('search_vault', { query: 'leave week 47' })]), reply([tu('save_output', { kind: 'plan', title: 'Week 47 cover', markdown: '- Sam covers' })]), reply([tu('finish', { completed: ['Plan'], remaining: [] })]), end()];
  v = await agent.answer(T.dedupe.id, { questionId: v.workspace.need.id, text: 'Sam', awaitTurn: true });
  assert.equal(searches.length, 1, 'not re-run in the next turn of the same attempt');
  assert.equal(v.run.steps.filter((s) => s.kind === 'read').length, 1, 'one read step for the note');
});

test('exploration is capped PER ATTEMPT: the 4th search is refused ("you have enough"), and the workspace says NEURO stopped exploring', async () => {
  searches.length = 0; lastToolResults.length = 0;
  script = [
    reply([tu('search_vault', { query: 'rota one' })]), reply([tu('search_vault', { query: 'rota two' })]), reply([tu('search_vault', { query: 'rota three' })]), reply([tu('search_vault', { query: 'rota four' })]),
    reply([tu('save_output', { kind: 'investigation', title: 'Rota history', markdown: '- found two notes' })]), reply([tu('finish', { completed: ['Summarised'], remaining: [] })]), end(),
  ];
  const v = await agent.start(T.cap.id, { awaitTurn: true });
  assert.equal(searches.length, 3, 'at most three searches an attempt (the default)');
  assert.ok(lastToolResults.some((r) => /You have enough to work with/.test(r)));
  assert.equal(v.run.enough, true);
  assert.match(v.workspace.status.enough, /stopped exploring once it had enough/);
});

test('no workspace for the kiosk, the API token or a declared machine; chat has no Do this tool', async () => {
  for (const h of [{ 'X-NEURO-KIOSK-TOKEN': 'kiosk-9012' }, { 'X-NEURO-API-TOKEN': 'tok-5678' }, { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' }]) {
    const r = await req('GET', `/api/task-agent/tasks/${T.hr.id}`, null, h);
    assert.ok(r.status === 403 || r.status === 401, JSON.stringify(h) + ' → ' + r.status);
    assert.ok(!r.json || !r.json.workspace);
  }
  const tools = fs.readFileSync(path.join(__dirname, 'chat-tools.js'), 'utf8');
  assert.doesNotMatch(tools, /task-agent|task_agent/);
});
