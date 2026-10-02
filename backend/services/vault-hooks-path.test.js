'use strict';

// The Pi's OBSIDIAN_VAULT_PATH is a symlink and routes/vault.js resolves writes
// against the REAL root, so the hook received a path the symlink could not
// relativise: `../../../mnt/data/nuero-vault/Projects/...`. Every `Projects/`
// exclusion missed it and 127 project checkboxes became task suggestions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { toVaultRelative } = require('./vault-hooks');
const { shouldSkipPath } = require('./action-candidates');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-path-'));
const real = path.join(base, 'real-vault');
fs.mkdirSync(path.join(real, 'Projects'), { recursive: true });
const link = path.join(base, 'link-vault');
let linked = true;
try { fs.symlinkSync(real, link, 'junction'); } catch { linked = false; }

test('a path under the symlinked root is relative to the vault', () => {
  assert.equal(toVaultRelative(path.join(real, 'Projects', 'A.md'), real), 'Projects/A.md');
});

test('a path resolved against the REAL root still comes out vault-relative', { skip: !linked && 'cannot create a symlink here' }, () => {
  const fromApi = path.join(fs.realpathSync(link), 'Projects', 'Hilo.md');
  assert.equal(toVaultRelative(fromApi, link), 'Projects/Hilo.md');
});

test('a path genuinely outside the vault is refused, never relativised', () => {
  assert.equal(toVaultRelative(path.join(base, 'elsewhere', 'X.md'), real), null);
  assert.equal(toVaultRelative('../escape/X.md', real), null);
});

test('shouldSkipPath refuses an escaping path whatever folder it names', () => {
  // Positive control: the normal form of the same note is skipped by the Projects rule.
  assert.equal(shouldSkipPath('Projects/Hilo/Hilo.md'), true);
  assert.equal(shouldSkipPath('Meetings/2026/10/Standup.md'), false);
  // The exact shape seen live, and a meeting note in the same shape.
  assert.equal(shouldSkipPath('../../../mnt/data/nuero-vault/Projects/Hilo/Hilo.md'), true);
  assert.equal(shouldSkipPath('../../../mnt/data/nuero-vault/Meetings/2026/10/Standup.md'), true);
  assert.equal(shouldSkipPath('/mnt/data/nuero-vault/Meetings/x.md'), true);
});
