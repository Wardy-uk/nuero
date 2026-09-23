'use strict';

/**
 * The chosen MoSCoW / priority / due date reach the TASK, and an unchosen one
 * still gets the default.
 *
 * The routing test proves the payload is written; this proves the payload is
 * READ — by the real `capture_todo` executor, into a real task row. That join is
 * the whole feature, and neither suite can see it alone.
 *
 * ⚠ The defaults are asserted by BEHAVIOUR, not restated: `commitment-due`
 * gives ten days when the sentence names none, and nothing here re-implements
 * that. If that rule changes, this test should follow it rather than pin a copy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-sugg-promote-'));
process.env.NEURO_DB_PATH = path.join(root, 'promote.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const suggestionEngine = require('./suggestion-engine');
const taskStore = require('./task-store');

const raise = (text, metadata = {}) =>
  db.createSaimAction('capture_todo', { text, metadata }, 0.8, 'spotted in a meeting note');

const taskFor = (id) => db.get('SELECT * FROM tasks WHERE id = ?', [id]);

test.before(async () => { await db.init(); });

test('an explicit MoSCoW, priority and due date land on the task', async () => {
  const action = db.getSaimAction(raise('Nick to present the squad resourcing plan',
    { moscow: 'must', priority: 3, dueDate: '2026-10-09' }));

  const res = await suggestionEngine.executeAction(action);
  assert.equal(res.ok, true, res.detail);

  const id = Number(String(res.detail).match(/#(\d+)/)[1]);
  const row = taskFor(id);
  assert.equal(row.moscow, 'must');
  assert.equal(row.priority, 3);
  assert.equal(row.due_date, '2026-10-09');
});

test('an explicit MoSCoW is a DECISION, never a proposal', async () => {
  // `moscow_proposed` exists for a GUESS. Nick picking it on the card is a call
  // he made, and stamping it proposed would show it with a '?' and invite NEURO
  // to overwrite it later.
  const action = db.getSaimAction(raise('Nick to agree the KPI targets with Chris', { moscow: 'should' }));
  const res = await suggestionEngine.executeAction(action);
  const id = Number(String(res.detail).match(/#(\d+)/)[1]);
  assert.equal(taskFor(id).moscow_proposed, 0);
});

test('choosing nothing still gets the default due date, not a null one', async () => {
  // The complaint this whole area exists for: a promoted commitment used to
  // arrive with NO date at all. Unchosen must mean "the default", never "none".
  const action = db.getSaimAction(raise('Nick to reconcile the overtime figures'));
  const res = await suggestionEngine.executeAction(action);
  const id = Number(String(res.detail).match(/#(\d+)/)[1]);
  const row = taskFor(id);

  assert.ok(row.due_date, 'an unchosen due date must still be defaulted');
  const days = Math.round((new Date(row.due_date) - new Date()) / 86400000);
  assert.ok(days > 0 && days <= 11, `expected the ~10 day default, got ${row.due_date} (${days}d)`);
});

test('a stated deadline in the sentence still beats the ten-day default', async () => {
  // Unchanged behaviour, pinned so this feature cannot quietly flatten it.
  const action = db.getSaimAction(raise('Nick to publish the charter by 2026-11-20'));
  const res = await suggestionEngine.executeAction(action);
  const id = Number(String(res.detail).match(/#(\d+)/)[1]);
  assert.equal(taskFor(id).due_date, '2026-11-20');
});

test('an explicit due date beats the date stated in the sentence', async () => {
  // Nick overruling the extractor on the card is the newer, more deliberate fact.
  const action = db.getSaimAction(raise('Nick to circulate the pack by 2026-11-20', { dueDate: '2026-10-02' }));
  const res = await suggestionEngine.executeAction(action);
  const id = Number(String(res.detail).match(/#(\d+)/)[1]);
  assert.equal(taskFor(id).due_date, '2026-10-02');
});
