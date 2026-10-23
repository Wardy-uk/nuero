'use strict';

/**
 * "Do this" — the task agent (23 Oct 2026). Real HTTP, real api-auth, real
 * authority guard, real task store, real task-context over a temp vault, the REAL
 * Anthropic provider (its tool loop and AI-gate tickets) with only the SDK client
 * scripted, the REAL governed prepareCompose. The network is blocked: any fetch
 * fails the test that caused it.
 *
 * What it proves (see docs/task-agent.md):
 *   1. an ordinary task runs several safe steps to the end without asking;
 *   2. linked context is used, as Nick sees it;
 *   3. a people matter prepares a brief and stops at Nick's decision — no email;
 *   4. a genuine ambiguity is one question, and the answer continues the run;
 *   5. a manual-only step waits, then resumes;
 *   6. an email is prepared to the existing approval point and NOT approved or sent;
 *   7. refresh and repeated presses never duplicate a model call, draft or action;
 *   8. kiosk, API token (MCP/n8n) and declared machines get no control and no output;
 *   9. hard-excluded and restricted content never enters a prompt beyond the excerpt;
 *  10. nothing is written outside NEURO's own run record: vault, tasks, calendar,
 *      allowances, confirmations, ledger, outbound — all unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
delete process.env.ANTHROPIC_API_KEY; // Do this must not depend on it
process.env.AI_MODE = 'hybrid';
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS', 'OPENROUTER_ALLOWED_TASKS']) delete process.env[k];

const fetchCalls = [];
global.fetch = async (u) => { fetchCalls.push(String(u)); throw new Error('network blocked in task-agent test'); };

function write(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const db = require('../db/database');
const taskStore = require('../services/task-store');
const tc = require('../services/task-context');
const agent = require('../services/task-agent');
const anthropic = require('../services/providers/anthropic-provider');
const taSettings = require('../services/task-agent-settings');
// Do this runs on ITS OWN saved key (Settings), never ANTHROPIC_API_KEY. Generous limits here; the caps have their own test.

const PLAN = 'Projects/Support Rota/Q4 rota notes.md';
const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example leaver catch up.md';
const SEC = 'Security review/Service account passwords.md';
const PRIVATE_LINE = 'Heidi Example disclosed a private family matter which is confidential.';
const EXCERPT_LINE = 'Agreed to confirm Heidi Example end date once HR reply.';
const SECRET = 'admin password: hunter2';

let server; let base;
const T = {};

// ── the scripted Anthropic client ───────────────────────────────────────────
const seen = [];   // every request the provider sent (system + messages)
let script = [];
let nextId = 1;
function toolUse(name, input) { return { type: 'tool_use', id: `tu_${nextId++}`, name, input }; }
function reply(blocks, stop = 'tool_use') { return { model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage: { input_tokens: 1200, output_tokens: 300 } }; }
anthropic._internals.setClient({ messages: { create: async (params) => {
  seen.push(JSON.stringify({ system: params.system, messages: params.messages }));
  const step = script.shift();
  if (!step) return reply([{ type: 'text', text: 'Nothing more.' }], 'end_turn');
  return typeof step === 'function' ? step(params) : step;
} } });

// The task store's own export (rewritten when the FIXTURES create tasks) is not the agent's write.
function snapshot() {
  const files = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else if (!/NEURO Tasks \(export\)\.md$/.test(p)) files[path.relative(VAULT, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } };
  walk(VAULT);
  const count = (sql) => { try { return db.get(sql).n; } catch { return 'absent'; } };
  return {
    files,
    tasks: JSON.stringify(db.all('SELECT id, text, status, moscow, priority, due_date FROM tasks ORDER BY id')),
    calendar: count('SELECT COUNT(*) n FROM calendar_cache'),
    ledger: count('SELECT COUNT(*) n FROM external_write_ledger'),
    attempts: count('SELECT COUNT(*) n FROM action_attempts'),
    approved: count("SELECT COUNT(*) n FROM prepared_actions WHERE status != 'prepared'"),
    grants: count('SELECT COUNT(*) n FROM saim_authority_grants'),
    intents: count('SELECT COUNT(*) n FROM human_action_intents'),
    governed: db.getState('feature_flag:governed_execution'),
  };
}

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  taSettings.save({ apiKey: 'sk-ant-test-not-a-real-key-0000000000', enabled: true, dailyUsd: 50, dailyRuns: 200 });
  write('People/Jane Doe.md', '---\ntype: person\nemail: jane.doe@example.com\n---\n# Jane Doe\n');
  // Heidi HAS an address, so refusing her email is the people-matter guard's doing, not an unresolvable recipient.
  write('People/Heidi Example.md', '---\ntype: person\nemail: heidi.example@example.com\n---\n# Heidi Example\n');
  write(PLAN, '# Q4 rota notes\n\nCover gaps: weeks 44 and 47. Two people on leave in week 47.\nPrefer early/late split for 2nd line.\n');
  write(HR, `---\nprivate: true\n---\n# Leaver catch up\n\n${PRIVATE_LINE}\n${EXCERPT_LINE}\n`);
  write(SEC, `# Passwords\n\n${SECRET}\n`);
  T.plain = taskStore.createTask({ text: 'Plan the Q4 support rota cover', source: 'test' });
  T.hr = taskStore.createTask({ text: "Set and confirm Heidi Example's end date", source: 'test', origin_path: HR });
  T.amb = taskStore.createTask({ text: 'Sort out the report', source: 'test' });
  T.manual = taskStore.createTask({ text: 'Check the wallboard figures match Jira', source: 'test' });
  T.email = taskStore.createTask({ text: 'Send Jane Doe the agenda for Thursday', source: 'test' });
  T.idem = taskStore.createTask({ text: 'Draft the escalation checklist', source: 'test' });

  tc.ensure();
  const l = tc.link({ taskId: T.plain.id, type: 'note', ref: PLAN });
  assert.equal(l.ok, true, `linked the plan note: ${JSON.stringify(l).slice(0, 200)}`);
  const now = new Date().toISOString();
  const ins = (taskId, ref, title, restricted) => db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, preview, origin, state, confidence, reasons_json, restricted, created_at, updated_at) VALUES (?, 'note', ?, ?, ?, 'nightly-scan', 'pinned', 1, '[{"code":"origin","say":"This task was raised in this note."}]', ?, ?, ?)`, [taskId, ref, title, restricted ? null : 'preview', restricted ? 1 : 0, now, now]);
  ins(T.hr.id, HR, 'Leaver catch up', true);
  ins(T.hr.id, SEC, 'Service account passwords', true); // a legacy row into a HARD exclusion

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/task-agent', require('./task-agent'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

function call(method, route, body, headers = NICK) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/task-agent${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}'), raw: s }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const NICK = { 'X-NEURO-PIN': 'pin-1234' };
const LIMITED = {
  kiosk: { 'X-NEURO-KIOSK-TOKEN': 'kiosk-9012' },
  'api-token (MCP gateway, n8n)': { 'X-NEURO-API-TOKEN': 'tok-5678' },
  'local MCP (PIN + declared machine)': { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' },
  'chat client declaring itself': { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'chat' },
};
async function press(id, body = {}) {
  const r = await call('POST', `/tasks/${id}/start`, body);
  await agent._internals.waitFor(id);
  return r;
}
async function state(id) { return (await call('GET', `/tasks/${id}`)).json.run; }

// ── 1 + 2: an ordinary task, several safe steps, linked context used ─────────
test('ordinary task: reads linked context, saves real outputs, finishes without asking', async () => {
  const before = snapshot();
  const n0 = seen.length;
  script = [
    reply([toolUse('read_note', { path: PLAN })]),
    reply([toolUse('save_output', { kind: 'plan', title: 'Q4 rota cover plan', markdown: '- Week 44: cover gap filled by early/late split\n- Week 47: two on leave — swap 2nd line', sources: ['ctx:1'] }),
      toolUse('save_output', { kind: 'checklist', title: 'Rota checklist', markdown: '- [ ] Confirm leave dates\n- [ ] Publish rota' })]),
    reply([toolUse('finish', { understanding: 'Plan cover for Q4 using the rota notes.', completed: ['Drafted the Q4 cover plan', 'Drafted a publishing checklist'], remaining: ['Publish the rota — your step'] })]),
    reply([{ type: 'text', text: 'Done.' }], 'end_turn'),
  ];
  const r = await press(T.plain.id);
  assert.equal(r.status, 200);
  assert.equal(r.json.kicked, true);
  const run = await state(T.plain.id);
  assert.equal(run.status, 'ready', JSON.stringify(run.error));
  assert.equal(run.question, null, 'never asked');
  assert.equal(run.outputs.length, 2);
  assert.match(run.outputs[0].markdown, /Week 47/);
  const src = run.sources.find((s) => s.path === PLAN);
  assert.ok(src && src.used, 'the linked note is shown as used');
  assert.match(src.provenance, /./, 'with its provenance');
  assert.deepEqual(run.summary.completed, ['Drafted the Q4 cover plan', 'Drafted a publishing checklist']);
  assert.equal(run.understanding, 'Plan cover for Q4 using the rota notes.');
  assert.equal(run.usage.model, 'claude-sonnet-4-6');
  assert.ok(run.usage.promptTokens >= 1200 * 3 && run.usage.costUsd > 0, 'tokens and cost recorded');
  assert.equal(seen.length - n0, 4, 'four provider requests (one gate ticket each)');
  assert.ok(seen.slice(n0).some((p) => p.includes('Cover gaps: weeks 44 and 47')), 'the note text reached the model only through read_note');
  const act = db.all("SELECT event_data FROM activity_log WHERE event_type = 'task_agent'").map((x) => x.event_data).join('\n');
  assert.match(act, /"model":"claude-sonnet-4-6"/);
  assert.doesNotMatch(act, /Week 47|Cover gaps/, 'activity carries no output or prompt text');
  const after = snapshot();
  assert.deepEqual(after, before, 'nothing written outside the run record');
  assert.match(db.getState(agent._internals.KEY(T.plain.id)), /Q4 rota cover plan/);
  assert.doesNotMatch(db.getState(agent._internals.KEY(T.plain.id)), /WHAT YOU MAY NOT DO|SOURCES NICK HAS LINKED/, 'the prompt is never stored');
});

test('the AI gate saw every request under the task_agent class', () => {
  const gate = require('../services/ai-gate');
  const prof = gate.profile ? gate.profile({ app: 'neuro' }) : null;
  const text = JSON.stringify(prof || {});
  assert.match(text, /task_agent/, 'task_agent tickets are on the shared ledger');
});

// ── 3 + 9: a people matter — useful preparation, stops at Nick's decision ────
test('people matter: prepares the brief from the excerpt only, refuses email, stops at the decision', async () => {
  const before = snapshot();
  const n0 = seen.length;
  script = [
    reply([toolUse('prepare_email', { to: 'Heidi Example', subject: 'Your end date', body: 'Hi Heidi' })]),
    reply([toolUse('save_output', { kind: 'brief', title: 'End date decision brief', markdown: '## Facts\n- HR reply awaited [ctx]\n## Options\n1. Confirm\n2. Wait for HR\n## Risks\n- Confirming before HR replies' })]),
    reply([toolUse('finish', { completed: ['Prepared a decision brief'], remaining: ['The decision is yours'] })]),
    reply([{ type: 'text', text: 'Brief ready.' }], 'end_turn'),
  ];
  await press(T.hr.id);
  const run = await state(T.hr.id);
  assert.equal(run.sensitive.sensitive, true);
  assert.equal(run.status, 'needs-decision', 'ended at Nick\'s decision even though the model only said finish');
  assert.equal(run.question.kind, 'authority');
  assert.equal(run.outputs.length, 1, 'the brief WAS prepared — it did not stop before the preparatory work');
  assert.equal((run.handoffs || []).length, 0, 'no email prepared');
  assert.equal(db.get("SELECT COUNT(*) n FROM prepared_actions").n, 0);
  const prompts = seen.slice(n0).join('\n');
  assert.ok(prompts.includes('EMPLOYMENT / PEOPLE MATTER'), 'the model was told');
  assert.ok(prompts.includes('confirm Heidi Example end date'), 'the task-bounded excerpt reached the model');
  assert.ok(!prompts.includes('private family matter'), 'the rest of the restricted note did not');
  assert.ok(!prompts.includes('hunter2') && !prompts.includes('Security review') && !prompts.includes('Service account passwords'), 'the hard exclusion contributed nothing, not even its title');
  assert.ok(!run.sources.some((s) => /Security review|passwords/i.test(`${s.title} ${s.path}`)));
  const restricted = run.sources.find((s) => s.restricted);
  assert.ok(restricted && restricted.path === null, 'a restricted source carries no path');
  assert.deepEqual(snapshot(), before);
});

test('read_note refuses a restricted or hard-excluded path even if the model names it', async () => {
  script = [reply([toolUse('read_note', { path: SEC }), toolUse('read_note', { path: HR }), toolUse('search_vault', { query: 'passwords' }), toolUse('search_vault', { query: 'family matter' })]),
    reply([toolUse('finish', { completed: [], remaining: [] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];
  const t = taskStore.createTask({ text: 'Tidy the support wiki index', source: 'test' });
  const n0 = seen.length;
  await press(t.id);
  const tail = seen.slice(n0).join('\n');
  assert.ok(!tail.includes('hunter2') && !tail.includes('private family matter'), 'neither body ever returned to the model');
  assert.match(tail, /was not offered to you/);
});

// ── 4: a genuine ambiguity — one focused question, then the run continues ───
test('ambiguity: one question with options; the answer continues the same run; a repeat answer costs nothing', async () => {
  script = [
    reply([toolUse('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'They have different audiences and deadlines.', options: ['Weekly risk report', 'SOAP report'] })]),
    reply([{ type: 'text', text: 'Waiting.' }], 'end_turn'),
  ];
  await press(T.amb.id);
  let run = await state(T.amb.id);
  assert.equal(run.status, 'needs-answer');
  assert.equal(run.question.options.length, 2);
  assert.equal(run.understanding, null, 'stray closing text ("Waiting.") is never shown as the understanding');
  assert.equal(run.summary, null, 'a question turn reports no outcome yet');
  const qid = run.question.id;
  const n0 = seen.length;
  script = [
    (params) => { assert.match(JSON.stringify(params.messages), /A: Weekly risk report/, 'the answer is in the next prompt'); return reply([toolUse('save_output', { kind: 'plan', title: 'Weekly risk report plan', markdown: '- Gather KPIs' })]); },
    reply([toolUse('finish', { completed: ['Planned the weekly risk report'], remaining: [] })]),
    reply([{ type: 'text', text: 'ok' }], 'end_turn'),
  ];
  const a = await call('POST', `/tasks/${T.amb.id}/answer`, { questionId: qid, text: 'Weekly risk report' });
  assert.equal(a.status, 200);
  await agent._internals.waitFor(T.amb.id);
  run = await state(T.amb.id);
  assert.equal(run.status, 'ready');
  assert.equal(run.answers.length, 1);
  const n1 = seen.length;
  assert.equal(n1 - n0, 3);
  const again = await call('POST', `/tasks/${T.amb.id}/answer`, { questionId: qid, text: 'Weekly risk report' });
  assert.equal(again.status, 200);
  assert.equal(again.json.kicked, false);
  await agent._internals.waitFor(T.amb.id);
  assert.equal(seen.length, n1, 'a repeated answer made no model call');
});

// ── 5: a manual step only Nick can do, then resumption ──────────────────────
test('manual step: waits for Nick, then carries on from "I\'ve done it"', async () => {
  script = [
    reply([toolUse('save_output', { kind: 'checklist', title: 'Wallboard check', markdown: '- [ ] Compare open tickets' })]),
    reply([toolUse('ask_nick', { kind: 'manual', question: 'Open the wallboard and read me today\'s open-ticket count.', why: 'NEURO cannot reach the wallboard.' })]),
    reply([{ type: 'text', text: 'Waiting.' }], 'end_turn'),
  ];
  await press(T.manual.id);
  let run = await state(T.manual.id);
  assert.equal(run.status, 'needs-manual');
  script = [
    (params) => { assert.match(JSON.stringify(params.messages), /A: Done\. 42 open/); return reply([toolUse('save_output', { kind: 'answer', title: 'Wallboard vs Jira', markdown: 'Wallboard says 42; compare with Jira filter.' })]); },
    reply([toolUse('finish', { completed: ['Compared'], remaining: [] })]),
    reply([{ type: 'text', text: 'ok' }], 'end_turn'),
  ];
  await call('POST', `/tasks/${T.manual.id}/answer`, { questionId: run.question.id, text: '42 open', manualDone: true });
  await agent._internals.waitFor(T.manual.id);
  run = await state(T.manual.id);
  assert.equal(run.status, 'ready');
  assert.equal(run.outputs.length, 2, 'earlier work kept, new work added');
});

// ── 6: a governed email prepared to the existing approval point, not sent ───
test('email: prepared as a governed compose_email awaiting Nick\'s approval code; nothing sent or approved', async () => {
  const before = snapshot();
  script = [
    reply([toolUse('save_output', { kind: 'agenda', title: 'Thursday agenda', markdown: '1. Rota\n2. Escalations' })]),
    reply([toolUse('prepare_email', { to: 'Jane Doe', subject: 'Agenda for Thursday', body: 'Hi Jane,\n\n1. Rota\n2. Escalations\n\nNick' })]),
    // The SAME resolvable recipient again: only the one-email-per-run rule refuses it.
    reply([toolUse('prepare_email', { to: 'Jane Doe', subject: 'Agenda again', body: 'dup' })]),
    reply([toolUse('finish', { completed: ['Agenda drafted', 'Email prepared for approval'], remaining: ['Approve the email on Actions'] })]),
    reply([{ type: 'text', text: 'ok' }], 'end_turn'),
  ];
  await press(T.email.id);
  const run = await state(T.email.id);
  assert.equal(run.status, 'ready');
  assert.equal(run.handoffs.length, 1, 'one prepared email; the second attempt was refused');
  const pa = db.get('SELECT * FROM prepared_actions WHERE action_id = ?', [run.handoffs[0].actionId]);
  assert.equal(pa.action_type, 'compose_email');
  assert.equal(pa.status, 'prepared', 'waiting at the existing confirmation screen');
  assert.equal(pa.origin, 'task-agent');
  assert.equal(require('../services/intent-grants').initiatedByFor('task-agent'), 'neuro_autonomous', 'so it needs the approval code, not a click');
  assert.equal(run.handoffs[0].status, 'prepared');
  const after = snapshot();
  assert.deepEqual({ ...after, approved: before.approved }, before, 'no approval, attempt, ledger row, grant, intent or vault write');
  assert.equal(after.approved, 0);
  assert.equal(fetchCalls.length, 0, 'no network at all');
});

test('email: an address the sources never mentioned is refused (no invented recipients)', async () => {
  const t = taskStore.createTask({ text: 'Thank the supplier for the quick fix', source: 'test' });
  script = [reply([toolUse('prepare_email', { to: 'boss@elsewhere.example', subject: 'x', body: 'y' })]), reply([toolUse('finish', { completed: [], remaining: [] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];
  await press(t.id);
  const run = await state(t.id);
  assert.equal((run.handoffs || []).length, 0);
});

// ── 7: refresh / resume / repeated presses ──────────────────────────────────
test('repeated presses while running, awaiting or settled never duplicate work', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  script = [async () => { await gate; return reply([toolUse('save_output', { kind: 'draft', title: 'Checklist', markdown: '- step' })]); },
    reply([toolUse('ask_nick', { kind: 'missing', question: 'Which queue?', why: 'Two queues use this checklist.' })]),
    reply([{ type: 'text', text: 'w' }], 'end_turn')];
  const n0 = seen.length;
  const first = await call('POST', `/tasks/${T.idem.id}/start`, {});
  assert.equal(first.json.kicked, true);
  const second = await call('POST', `/tasks/${T.idem.id}/start`, {});
  const third = await call('POST', `/tasks/${T.idem.id}/start`, {});
  assert.equal(second.json.kicked, false);
  assert.equal(third.json.kicked, false);
  assert.equal(second.json.run.id, first.json.run.id, 'same attempt');
  release();
  await agent._internals.waitFor(T.idem.id);
  const n1 = seen.length;
  assert.equal(n1 - n0, 3, 'one run of the loop, not three');
  const awaiting = await call('POST', `/tasks/${T.idem.id}/start`, {});
  assert.equal(awaiting.json.kicked, false, 'awaiting an answer: the press resumes the same attempt and calls nothing');
  assert.equal(awaiting.json.run.status, 'needs-answer');
  assert.equal(awaiting.json.run.outputs.length, 1, 'one draft, not three');
  assert.equal(seen.length, n1);
  const ready = await call('POST', `/tasks/${T.plain.id}/start`, {});
  assert.equal(ready.json.kicked, false, 'a settled run is returned, not redone');
  assert.equal(ready.json.run.status, 'ready');
});

test('a run interrupted by a restart is shown as interrupted, and the press resumes it once', async () => {
  const t = taskStore.createTask({ text: 'Write the handover notes', source: 'test' });
  const stale = { contract: agent.CONTRACT, id: `ta-${t.id}-1`, taskId: t.id, taskText: t.task.text, status: 'running', startedAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:00:00.000Z', heartbeatAt: '2026-10-23T08:00:00.000Z', sensitive: { sensitive: false, why: [] }, sources: [], steps: [], outputs: [{ id: 'o1', kind: 'draft', title: 'Half done', markdown: 'x' }], handoffs: [], question: null, answers: [], summary: null, usage: null, error: null };
  db.setState(agent._internals.KEY(t.id), JSON.stringify(stale));
  const v = await state(t.id);
  assert.equal(v.status, 'interrupted');
  script = [reply([toolUse('finish', { completed: ['Finished the handover notes'], remaining: [] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];
  const r = await press(t.id);
  assert.equal(r.json.kicked, true);
  const run = await state(t.id);
  assert.equal(run.status, 'ready');
  assert.equal(run.outputs[0].title, 'Half done', 'earlier output kept');
});

test('fresh attempt only on an explicit press, and the old run is kept in history', async () => {
  const n0 = seen.length;
  script = [reply([toolUse('finish', { completed: ['Again'], remaining: [] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];
  const r = await press(T.plain.id, { fresh: true });
  assert.equal(r.json.kicked, true);
  assert.equal(seen.length - n0, 2);
  assert.ok(JSON.parse(db.getState(`task_agent_history:${T.plain.id}`)).length === 1);
});

test('a closed task cannot be started', async () => {
  const t = taskStore.createTask({ text: 'Already finished thing', source: 'test' });
  taskStore.updateTask(t.id, { status: 'done' });
  const r = await call('POST', `/tasks/${t.id}/start`, {});
  assert.equal(r.status, 409);
});

// ── 8: no control or output for kiosk, MCP, chat or automation ──────────────
for (const [who, headers] of Object.entries(LIMITED)) {
  test(`${who}: every task-agent route is refused and returns no output`, async () => {
    for (const [m, route, body] of [['GET', `/tasks/${T.plain.id}`], ['GET', '/active'], ['POST', `/tasks/${T.amb.id}/start`, {}], ['POST', `/tasks/${T.idem.id}/answer`, { questionId: 'x', text: 'y' }], ['POST', `/tasks/${T.plain.id}/stop`, {}]]) {
      const r = await call(m, route, body, headers);
      assert.equal(r.status, 403, `${who} ${m} ${route} → ${r.status}`);
      assert.doesNotMatch(r.raw, /Q4 rota|Week 47|Weekly risk|end date/i, 'no working output in the refusal');
    }
  });
}

test('Nick sees /active for Drafts', async () => {
  const r = await call('GET', '/active');
  assert.equal(r.status, 200);
  assert.ok(r.json.runs.some((x) => x.taskId === T.amb.id));
});

test('model refused budget: no call is made and the run says why', async () => {
  const t = taskStore.createTask({ text: 'Budget-blocked task', source: 'test' });
  process.env.AI_MODE = 'ollama-only';
  try {
    const n0 = seen.length;
    await press(t.id);
    const run = await state(t.id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /Nothing was sent to a model/);
    assert.equal(seen.length, n0);
  } finally { process.env.AI_MODE = 'hybrid'; }
});

// ── pure rules ──────────────────────────────────────────────────────────────
test('sourcesFrom: hard exclusions dropped entirely; restricted keeps only its excerpt and no path', () => {
  const s = agent.sourcesFrom({ pinned: [
    { id: 1, type: 'note', title: 'A', ref: 'a.md', restricted: false, preview: 'p', excerpt: null, provenance: 'x' },
    { id: 2, type: 'note', title: 'Sec', ref: null, hardExcluded: true, restricted: true, excerpt: { text: 'even with an excerpt' } },
    { id: 3, type: 'note', title: 'R', ref: 'r.md', restricted: true, excerpt: { text: 'line' }, provenance: 'y' },
    { id: 4, type: 'note', title: 'R2', ref: 'r2.md', restricted: true, excerpt: null },
  ] });
  assert.deepEqual(s.map((x) => x.key), ['ctx:1', 'ctx:3']);
  assert.equal(s[1].path, null);
  assert.equal(s[1].readable, false);
});
