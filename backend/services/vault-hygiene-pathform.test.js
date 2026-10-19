'use strict';

// "I ran all the fixes but not everything is fixed" (15 Oct 2026).
//
// extractLinks() reduces a link to its basename, so the repair planned
// `[[X]]` → `[[Y]]` — and repointInFile then looked for the literal `[[X`.
// Most links here are PATH-FORM (`[[Meetings/2026/03/X|alias]]`), so 19 of 20
// planned repairs changed nothing while the changelog listed all 20 as done.
// Separately, fuzzy matching scored `2026-06-21` against `2026-06-29` at 0.875
// and offered it as a "moderate" repair — a link to a different day.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hygiene = require('./vault-hygiene');

function mkVault(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-path-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('a path-form link with an alias is repointed, and the alias survives', () => {
  const root = mkVault({
    'Decision Log/D.md': 'Source: [[Meetings/2026/03/2026-03-10 Performance Review Heidi Power Probation|the review]].',
    'Meetings/2026/03/2026-03-10 Performance Review Heidi Power Probationary.md': '# real',
  });
  const plan = hygiene.fixPlan(root, { write: false });
  assert.strictEqual(plan.linkFixes.length, 1, 'fixture must produce exactly one repair');
  const r = hygiene.fixApply(root, { links: 'aggressive' });
  assert.strictEqual(r.repointed, 1);
  assert.deepStrictEqual(r.notFound, []);
  assert.ok(read(root, 'Decision Log/D.md').includes('[[2026-03-10 Performance Review Heidi Power Probationary|the review]]'));
});

test('an escaped table pipe after a path-form link is kept', () => {
  const root = mkVault({
    'T.md': '| [[People/Abdi Mohamad\\|Abdi]] |',
    'People/Abdi Mohamed.md': '# real',
  });
  hygiene.fixApply(root, { links: 'aggressive' });
  assert.ok(read(root, 'T.md').includes('[[Abdi Mohamed\\|Abdi]]'), read(root, 'T.md'));
});

test('the changelog never lists a repair that did not happen', () => {
  const root = mkVault({
    'A.md': 'See [[2026-04-30 Meeting Financial Impact and Cost Saving]].',
    'Meetings/2026-04-30 Meeting Financial Impact and Cost Savings.md': '# real',
  });
  const plan = hygiene.fixPlan(root, { write: false });
  // Change the file between plan and apply: the link text is no longer there.
  fs.writeFileSync(path.join(root, 'A.md'), 'nothing to see');
  const r = hygiene.fixApply(root, { links: 'aggressive', only: plan.linkFixes.map((x) => x.key) });
  // fixApply re-plans, so the stale pick is reported unmatched and nothing is claimed.
  assert.strictEqual(r.repointed, 0);
});

test('fuzzy matching never repairs one date into a different date', () => {
  const root = mkVault({
    'Logs.md': '- [[Reports/2026-06-21|2026-06-21]]',
    'Reports/2026-06-29.md': '# a different day',
  });
  const plan = hygiene.fixPlan(root, { write: false });
  assert.strictEqual(plan.linkFixes.length, 0, JSON.stringify(plan.linkFixes));
  hygiene.fixApply(root, { links: 'aggressive' });
  assert.ok(read(root, 'Logs.md').includes('[[Reports/2026-06-21|'));
});

test('a dated name still matches the SAME date with different wording', () => {
  const root = mkVault({
    'A.md': '[[2026-03-10 Performance Review Heidi Power Probation]]',
    'M/2026-03-10 Performance Review Heidi Power Probationary.md': '# real',
  });
  assert.strictEqual(hygiene.fixPlan(root, { write: false }).linkFixes.length, 1);
});
