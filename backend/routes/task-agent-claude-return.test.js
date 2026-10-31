'use strict';

/**
 * Claude's finished work coming back to NEURO (31 Oct 2026). Real HTTP, real
 * api-auth, real authority guard, real task store, a temp vault.
 *
 *   - a first return creates the task's draft note (frontmatter + the result);
 *   - a second appends a "From Claude — <time>" section, losing nothing;
 *   - identical work re-sent within 10 minutes appends nothing (already: true);
 *   - a project task's note lands in its project folder;
 *   - the LOCAL MCP (PIN + X-Neuro-Machine-Client: mcp-local) may call it, but is
 *     still refused on the other Do this routes;
 *   - empty, unknown and closed tasks are refused, and nothing is written;
 *   - the card's read carries the returned work;
 *   - the handoff prompt tells Claude to call return_task_result with the task id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-claude-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
delete process.env.ANTHROPIC_API_KEY;
for (const k of ['HA_TOKEN', 'HA_URL']) delete process.env[k];
global.fetch = async () => { throw new Error('network blocked in claude-return test'); };

fs.mkdirSync(path.join(VAULT, 'Projects', 'Support Rota'), { recursive: true });

const db = require('../db/database');
const taskStore = require('../services/task-store');
const agent = require('../services/task-agent');

const NICK = { 'X-NEURO-PIN': 'pin-1234' };
const MCP = { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' };
let server; let base;
const T = {};

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  T.plain = taskStore.createTask({ text: 'Plan the Q4 support rota cover', source: 'test' });
  T.proj = taskStore.createTask({ text: 'Write the rota escalation guide', source: 'test', origin_path: 'Projects/Support Rota/Rota.md' });
  T.closed = taskStore.createTask({ text: 'An old finished job', source: 'test' });
  db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [T.closed.id]);
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
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
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const note = (rel) => fs.readFileSync(path.join(VAULT, ...rel.split('/')), 'utf8');

test('a first return creates the task’s draft note in Projects/Working; a second appends without losing anything', async () => {
  const r1 = await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: '# Cover plan\n\nWeek 47: early/late split.' });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.already, false);
  assert.equal(r1.json.notePath, 'Projects/Working/Plan the Q4 support rota cover (draft).md');
  const first = note(r1.json.notePath);
  assert.match(first, /^---\ntype: draft\ntask: \d+\nsource: claude-desktop\ncreated: /);
  assert.match(first, /## From Claude — /);
  assert.match(first, /Week 47: early\/late split\./);

  // Nick edits the note in Obsidian between returns; his words must survive.
  fs.appendFileSync(path.join(VAULT, 'Projects', 'Working', 'Plan the Q4 support rota cover (draft).md'), '\nNick’s own line.\n');
  const r2 = await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: 'Revised: week 44 also covered.' });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.notePath, r1.json.notePath);
  const second = note(r2.json.notePath);
  assert.ok(second.startsWith(first), 'the existing content is untouched');
  assert.match(second, /Nick’s own line\./);
  assert.match(second, /Revised: week 44 also covered\./);
  assert.equal((second.match(/## From Claude — /g) || []).length, 2);
});

test('identical work re-sent within 10 minutes is the same return — nothing appended', async () => {
  const before = note('Projects/Working/Plan the Q4 support rota cover (draft).md');
  const r = await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: 'Revised: week 44 also covered.' });
  assert.equal(r.status, 200);
  assert.equal(r.json.already, true);
  assert.equal(note('Projects/Working/Plan the Q4 support rota cover (draft).md'), before);
});

test('a project task’s note goes in its project folder', async () => {
  const r = await call('POST', `/tasks/${T.proj.id}/claude-result`, { markdown: 'Guide draft.' }, MCP);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.notePath, 'Projects/Support Rota/Write the rota escalation guide (draft).md');
  assert.equal(r.json.output.by, 'machine:mcp-local', 'who returned it is recorded');
});

test('the local MCP may return a result but is still refused on the rest of Do this', async () => {
  const ok = await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: 'From the MCP tool.' }, MCP);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const start = await call('POST', `/tasks/${T.plain.id}/start`, {}, MCP);
  assert.equal(start.status, 403);
  const read = await call('GET', `/tasks/${T.plain.id}`, undefined, MCP);
  assert.equal(read.status, 403);
  const kiosk = await call('POST', `/tasks/${T.plain.id}/start`, {}, { 'X-NEURO-KIOSK-TOKEN': 'kiosk-9012' });
  assert.equal(kiosk.status, 403);
});

test('empty, oversized, unknown, closed and extra-field requests are refused and write nothing', async () => {
  const listing = () => JSON.stringify(fs.readdirSync(path.join(VAULT, 'Projects', 'Working')));
  const before = listing();
  assert.equal((await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: '   ' })).status, 400);
  assert.equal((await call('POST', `/tasks/${T.plain.id}/claude-result`, {})).status, 400);
  assert.equal((await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: 'x'.repeat(200001) })).status, 400);
  assert.equal((await call('POST', `/tasks/${T.plain.id}/claude-result`, { markdown: 'hi', notePath: 'People/Someone.md' })).status, 400);
  assert.equal((await call('POST', '/tasks/999999/claude-result', { markdown: 'hi' })).status, 404);
  assert.equal((await call('POST', `/tasks/${T.closed.id}/claude-result`, { markdown: 'hi' })).status, 404);
  assert.equal(listing(), before);
  assert.ok(!fs.existsSync(path.join(VAULT, 'Projects', 'Working', 'An old finished job (draft).md')));
});

test('the card’s read carries the returned work, newest first, with where it was saved', async () => {
  const r = await call('GET', `/tasks/${T.plain.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.run, null, 'no Do this run was needed');
  const list = r.json.claudeResults;
  assert.ok(Array.isArray(list) && list.length === 3, JSON.stringify(list).slice(0, 300));
  assert.equal(list[0].markdown, 'From the MCP tool.');
  assert.equal(list[0].notePath, 'Projects/Working/Plan the Q4 support rota cover (draft).md');
  assert.equal(list[0].hash, undefined);
  const act = db.all("SELECT event_data FROM activity_log WHERE event_type = 'task_agent_claude_return'").map((x) => x.event_data).join('\n');
  assert.match(act, /\(draft\)\.md/);
  assert.doesNotMatch(act, /Week 47|From the MCP tool/, 'activity carries no content');
});

test('the handoff prompt tells Claude to call return_task_result with this task id', () => {
  const run = { sources: [], outputs: [], summary: null };
  const task = { id: T.plain.id, text: T.plain.text };
  const prompt = agent.composeFinal(run, task, '## Objective\nDo it.', {});
  assert.match(prompt, new RegExp(`return_task_result with task_id ${T.plain.id}\\b`));
  assert.match(prompt, /give the full result here in the chat so Nick can paste it back/);
  assert.deepEqual(agent.screenBrief(agent.defaultBrief(run, task), run), [], 'the default brief still passes the screen');
});
