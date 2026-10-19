'use strict';

// 16 Oct 2026: asked "what are the top things?", the standup said it had no
// backlog view. Its context held the 2 MUST tasks out of 38 open, and it had no
// tool that could read the rest. These pin that it can now read the WHOLE
// ranked list — the same list Focus ranks — and the inbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-standup-backlog-'));
process.env.NEURO_DB_PATH = path.join(root, 'standup.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const session = require('./standup-session');
const taskStore = require('./task-store');

test.before(async () => {
  await db.init();
  taskStore.createTask({ text: 'Backlog alpha must item', moscow: 'must', source: 'test' });
  taskStore.createTask({ text: 'Backlog bravo should item', moscow: 'should', source: 'test' });
  taskStore.createTask({ text: 'Backlog charlie unrated item', source: 'test' });
  require('./vault-cache').invalidate();
});

function fixture() {
  return session._emptySession('standup', { dateKey: '2026-10-16', accountability: { openCommitments: [] }, musts: [] });
}

test('the standup is offered the read tools, not only the writing ones', () => {
  const names = session.toolDefinitions().map(t => t.name);
  assert.ok(names.includes('list_tasks'));
  assert.ok(names.includes('get_urgent_emails'));
});

test('list_tasks reads the whole open list, not just the MUSTs', async () => {
  const res = await session.executeTool(fixture(), 'list_tasks', {});
  assert.equal(res.ok, true);
  assert.equal(res.filter, 'all');
  const texts = res.tasks.map(t => t.text);
  for (const t of ['Backlog alpha must item', 'Backlog bravo should item', 'Backlog charlie unrated item']) {
    assert.ok(texts.includes(t), `${t} missing from ${JSON.stringify(texts)}`);
  }
  // Every NEURO row carries the id block_time and complete_task need.
  assert.ok(res.tasks.every(t => Number.isInteger(t.id)));
  // His rating stays apart from what the classifier reads it as.
  assert.equal(res.tasks.find(t => t.text === 'Backlog charlie unrated item').moscow, null);
  assert.deepEqual(res.tasks.map(t => t.rank), res.tasks.map((_, i) => i + 1));
});

test('list_tasks is the SAME order Focus uses', async () => {
  const res = await session.executeTool(fixture(), 'list_tasks', { limit: 30 });
  const focus = require('./focus-ranking').rankedTodos('all');
  assert.deepEqual(res.tasks.map(t => t.text), focus.slice(0, 30).map(t => t.text));
});

test('an unknown filter is refused, not read as "all"', async () => {
  const res = await session.executeTool(fixture(), 'list_tasks', { filter: 'urgent' });
  assert.equal(res.ok, false);
});

test('the context says the MUST list is a slice and names the tool', () => {
  const text = session._renderContext({ dateKey: '2026-10-16', musts: [{ id: 1, text: 'x' }] });
  assert.match(text, /list_tasks/);
});

test('the prompt forbids "no backlog view"', () => {
  const src = fs.readFileSync(path.join(__dirname, 'standup-session.js'), 'utf8');
  assert.match(src, /never say you don't have a backlog view/);
});

test('the Focus route reads the shared ranker rather than its own copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'todos.js'), 'utf8');
  assert.match(src, /focus-ranking'\)\.rankedTodos\(filter\)/);
  assert.doesNotMatch(src, /vaultCache\.getScoredTasks/);
});
