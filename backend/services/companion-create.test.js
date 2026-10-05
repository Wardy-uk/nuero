'use strict';
// Life → Companions → Create writes the vault note the companion pass already
// reads, and never overwrites one (5 Oct 2026).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('./personal-world');

const vault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));

test('writes Companions/<name>.md with type: pet', () => {
  const root = vault();
  const r = pw.createCompanion({ name: 'Ember', species: 'dog', household: true, vaultRoot: root, now: Date.parse('2026-10-05T10:00:00Z'), publish: false });
  assert.equal(r.ok, true);
  const text = fs.readFileSync(path.join(root, 'Companions', 'Ember.md'), 'utf8');
  assert.match(text, /^---\ntype: pet\nspecies: "dog"\nhousehold: true\n/);
  // and it reads back as a companion by the same parser publishCompanions uses
  const fm = require('./world-sources').parseFrontmatter(text);
  assert.equal(fm.type, 'pet');
  assert.equal(pw.companionPayload('Ember', 'Companions/Ember.md', fm).household, true);
});

test('never overwrites an existing note', () => {
  const root = vault();
  fs.mkdirSync(path.join(root, 'Companions'));
  fs.writeFileSync(path.join(root, 'Companions', 'Ember.md'), 'mine');
  const r = pw.createCompanion({ name: 'Ember', vaultRoot: root, publish: false });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(root, 'Companions', 'Ember.md'), 'utf8'), 'mine');
});

test('refuses a name that is not a safe note title, and an unreachable vault', () => {
  const root = vault();
  for (const name of ['', '../x', 'a/b', '_hidden', '.dot']) assert.equal(pw.createCompanion({ name, vaultRoot: root }).ok, false, name);
  assert.equal(pw.createCompanion({ name: 'Ember', vaultRoot: path.join(root, 'missing') }).status, 503);
  assert.equal(pw.createCompanion({ name: 'Ember', vaultRoot: 'relative' }).status, 503);
});
