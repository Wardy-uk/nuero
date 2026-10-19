'use strict';

// "Fix the orphans — and their cause" (15 Oct 2026). 45 orphans, four causes:
// Home Assistant's daily Estate-watchdog capture (fixed in HA, not here), the
// Notion pull mirror (orphans by construction → expected), and People notes /
// project sub-notes that NEURO created or nobody joined to their hub.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vh = require('./vault-hygiene');

function mkVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-orph-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}
const fm = (o) => '---\n' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n# x\n';

test('hubFor places a person only on what the note STATES', () => {
  assert.strictEqual(vh.hubFor('People/Helen.md', fm({ relationship: '"spouse_partner"', household: true })), vh.HOUSEHOLD_MOC);
  assert.strictEqual(vh.hubFor('People/Lizzy.md', fm({ relationship: '"child"' })), vh.HOUSEHOLD_MOC);
  assert.strictEqual(vh.hubFor('People/A.md', fm({ email: 'a.b@nurtur.tech' })), vh.PEOPLE_MOC);
  assert.strictEqual(vh.hubFor('People/M.md', fm({ relationship: '"colleague"', household: '"false"' })), vh.PEOPLE_MOC);
  assert.strictEqual(vh.hubFor('People/U.md', fm({ type: 'person' })), null, 'nothing stated → no link, never a guess');
  assert.strictEqual(vh.hubFor('Companions/Ember.md', fm({ type: 'pet' })), vh.HOUSEHOLD_MOC);
});

test('a project sub-note joins its folder hub only when the hub exists; NOVA is left to its own rule', () => {
  const yes = () => true, no = () => false;
  assert.strictEqual(vh.hubFor('Projects/Hill Bagging App/Hill Bagging App - Weather.md', '', { hubExists: yes }), 'Hill Bagging App');
  assert.strictEqual(vh.hubFor('Projects/Hill Bagging App/Hill Bagging App - Weather.md', '', { hubExists: no }), null);
  assert.strictEqual(vh.hubFor('Projects/Hill Bagging App/Hill Bagging App.md', '', { hubExists: yes }), null, 'the hub never links to itself');
  assert.strictEqual(vh.hubFor('Projects/NOVA/X.md', '', { hubExists: yes }), null);
});

test('connectOrphans links People, Companions and project orphans, creates the Household MOC, and is idempotent', () => {
  const root = mkVault({
    'People/Helen.md': fm({ relationship: '"spouse_partner"', household: true }),
    'People/Unknown Person.md': fm({ type: 'person' }),
    'Companions/Ember.md': fm({ type: 'pet' }),
    'Projects/App/App.md': '# hub\n[[Elsewhere]]\n',
    'Projects/App/App - Weather.md': '# orphan\n',
    'Elsewhere.md': '# x\n',
  });
  const dry = vh.connectOrphans(root, { daily: false, dryRun: true });
  assert.strictEqual(dry.hubs, 3);
  assert.ok(!fs.existsSync(path.join(root, 'MOCs', vh.HOUSEHOLD_MOC + '.md')), 'a preview writes nothing');

  const r = vh.connectOrphans(root, { daily: false });
  assert.strictEqual(r.hubs, 3);
  assert.ok(fs.readFileSync(path.join(root, 'People/Helen.md'), 'utf8').includes(`[[${vh.HOUSEHOLD_MOC}]]`));
  assert.ok(fs.readFileSync(path.join(root, 'Projects/App/App - Weather.md'), 'utf8').includes('[[App]]'));
  assert.ok(!fs.readFileSync(path.join(root, 'People/Unknown Person.md'), 'utf8').includes('[['));
  assert.ok(fs.existsSync(path.join(root, 'MOCs', vh.HOUSEHOLD_MOC + '.md')));

  assert.strictEqual(vh.connectOrphans(root, { daily: false }).hubs, 0, 'a second run adds nothing');
});

test('Notion mirror notes are expected orphans by default, and a hub-linked person is no longer an orphan', () => {
  const root = mkVault({
    'Notion/Hiking/Routes.md': '# mirror\n',
    'People/Helen.md': fm({ household: true }),
  });
  vh.connectOrphans(root, { daily: false });
  const res = vh.lint(root, { write: false });
  const orphans = res.orphans || (res.counts && res.orphanList) || [];
  const list = Array.isArray(orphans) ? orphans.map(String) : [];
  assert.ok(!list.some((o) => o.includes('Notion/')), JSON.stringify(list));
  assert.ok(!list.some((o) => o.includes('Helen')), JSON.stringify(list));
});
