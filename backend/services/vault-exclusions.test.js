'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ex = require('./vault-exclusions');

test('the retrieval index does not read the bin', () => {
  // 709 Archive files and 43 _toDelete were 24% of the index.
  assert.equal(ex.isExcludedPath('Archive/2026/old meeting.md'), true);
  assert.equal(ex.isExcludedPath('_toDelete/whatever.md'), true);
  assert.equal(ex.isExcludedPath('Meetings/2026/08/2026-08-14 standup.md'), false);
});

test('NEURO does not index its own reports', () => {
  // The system citing its own hygiene logs as a source is a loop, not a search.
  assert.equal(ex.isExcludedPath('Documents/System/Vault Audit/lint-2026-08-14.md'), true);
  assert.equal(ex.isExcludedPath('Documents/System/SAiM Import Reports/2026-08-14.md'), true);
});

test('generated task lists are excluded by FILENAME, wherever they sit', () => {
  // These are why Hope's person page ranked a MoSCoW worksheet and a .backup-
  // copy of it above her actual meetings: they name everyone, so they match
  // every person query while saying nothing about anyone.
  assert.equal(ex.isExcludedPath('Tasks/NEURO Tasks (export).md'), true);
  assert.equal(ex.isExcludedPath('Tasks/Master Todo.md'), true);
  assert.equal(ex.isExcludedPath('Tasks/MoSCoW - Open Actions 2026-08-12.md'), true);
  assert.equal(ex.isExcludedPath('Tasks/Master Todo.backup-2026-08-12.md'), true);
  assert.equal(ex.isExcludedPath('Tasks/Microsoft Tasks.sync-conflict-20260812.md'), true);
  // A real note that merely lives in Tasks/ is still a note.
  assert.equal(ex.isExcludedPath('Tasks/Task System Boundary.md'), false);
});

test('Daily/ is excluded from embeddings and kept for entity extraction', () => {
  // "Who did I mention on Tuesday" is exactly what daily notes answer, and
  // exactly what a semantic index of hundreds of scratchpads ruins.
  assert.equal(ex.isExcludedPath('Daily/2026-08-14.md', { forEmbeddings: true }), true);
  assert.equal(ex.isExcludedPath('Daily/2026-08-14.md'), false);
});

test('a lint backup is never content', () => {
  assert.equal(ex.isExcludedPath('Scripts/.lint-backups/2026-08-14/People/Hope.md'), true);
});

// ── Sensitive ────────────────────────────────────────────────────────────────

test('Personal/ and Private/ are ordinary work notes: indexed, extracted, never excluded (31 Oct 2026)', () => {
  for (const p of ['Personal/Occupational Health Debrief.md', 'Private/Investigation Prep.md']) {
    assert.equal(ex.isExcludedPath(p), false, p);
    assert.equal(ex.isExcludedPath(p, { forEmbeddings: true }), false, p);
  }
  assert.equal(ex.ENTITY_EXCLUDED_DIRS.has('Personal'), false);
  assert.equal(ex.EMBEDDING_EXCLUDED_DIRS.has('Daily'), true);
  assert.equal(ex.ENTITY_EXCLUDED_DIRS.has('Daily'), false);
  assert.equal('isSensitivePath' in ex, false, 'the sensitive-folder guard is gone');
  assert.equal(ex.noteDomain('Personal/Investigation Prep.md'), 'work');
  assert.equal(ex.isPersonalPath('Personal/Investigation Prep.md'), false);
});

test('personal life is empty by default and must be declared', () => {
  // No folder in this vault is unambiguously home life.
  assert.deepEqual(ex.PERSONAL_DIRS, []);
  assert.equal(ex.noteDomain('Meetings/2026/08/standup.md'), 'work');
});

test('frontmatter beats the path, and unmarked is work', () => {
  // A single note can legitimately sit in the wrong folder, and frontmatter is
  // the only way to mark one before a folder exists. Unmarked is work, the same
  // asymmetry shared/task-domain.cjs argues: a personal note read as work is
  // visible, the reverse is silent.
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', { domain: 'personal' }), 'personal');
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', { domain: 'PERSONAL' }), 'personal');
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', {}), 'work');
  assert.equal(ex.noteDomain('Meetings/2026/08/x.md', { domain: 'nonsense' }), 'work');
});
