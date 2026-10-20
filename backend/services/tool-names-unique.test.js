'use strict';

// 20 Oct 2026: a351a7f0 added list_tasks + get_urgent_emails to the standup
// TWICE. Gemini (via OpenRouter) refuses a tool list with a duplicate name
// ("Duplicate function declaration found: list_tasks"), so every standup turn
// fell back to the tool-less path — SAiM could talk but never call set_focus,
// and no daily note was written for four days. Nothing failed loudly: the
// degraded path is designed to carry on. These pin that every tool list sent to
// a provider has unique names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-tool-names-'));
process.env.NEURO_DB_PATH = path.join(root, 'tools.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

function duplicates(defs) {
  const seen = new Set();
  const dup = [];
  for (const d of defs) {
    if (seen.has(d.name)) dup.push(d.name);
    seen.add(d.name);
  }
  return dup;
}

test('standup tool names are unique', () => {
  const defs = require('./standup-session').toolDefinitions();
  assert.ok(defs.length > 5, 'positive control: the standup has tools');
  assert.deepEqual(duplicates(defs), []);
});

test('chat tool names are unique', () => {
  const defs = require('./chat-tools').toolDefinitions();
  assert.ok(defs.length > 5, 'positive control: chat has tools');
  assert.deepEqual(duplicates(defs), []);
});

test('the duplicate check catches a duplicate', () => {
  assert.deepEqual(duplicates([{ name: 'a' }, { name: 'b' }, { name: 'a' }]), ['a']);
});
