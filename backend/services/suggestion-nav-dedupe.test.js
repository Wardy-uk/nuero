'use strict';
// A shortcut to the same screen is ONE pending card, whatever focus item raised it.
// Live, 29 Oct 2026: `todo-overdue-summary` at 08:00 and `todo-overdue-top` at 09:00
// both queued "Jump to tasks (overdue)" because the dedupe keyed on the focus item.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NEURO_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-navdedupe-')), 'scratch.db');

const db = require('../db/database');
const engine = require('./suggestion-engine');

test.before(async () => { await db.init(); });

const NAV = { navigate: 'todos', filter: 'overdue' };

test('two focus items sending to the same screen share one key', () => {
  assert.equal(
    engine.pendingKey('open_task', NAV, 'todo-overdue-summary'),
    engine.pendingKey('open_task', { filter: 'overdue', navigate: 'todos' }, 'todo-overdue-top'));
  // A different destination is a different card.
  assert.notEqual(
    engine.pendingKey('open_task', NAV, 'x'),
    engine.pendingKey('open_task', { navigate: 'todos', filter: 'today' }, 'x'));
});

test('an actuator still keys on its focus item', () => {
  assert.equal(engine.pendingKey('draft_reply', { emailId: 'a' }, 'email-urgent'), 'draft_reply:email-urgent');
});

test('persisting the renamed card while the first is pending creates nothing', () => {
  const first = engine.persistSuggestions([{ type: 'open_task', payload: NAV, confidence: 0.8,
    reason: 'Start with your top overdue task', focusItemId: 'todo-overdue-summary' }]);
  assert.equal(first.length, 1);
  const second = engine.persistSuggestions([{ type: 'open_task', payload: NAV, confidence: 0.8,
    reason: 'Start with your top overdue task', focusItemId: 'todo-overdue-top' }]);
  assert.equal(second.length, 0);
  const pending = db.getPendingSaimActions(100).filter((a) => a.type === 'open_task');
  assert.equal(pending.length, 1);
});
