'use strict';
// A vault-hygiene write (ctx-links, fix, connect-orphans) changes only LINKS, but it
// changes the body, so it used to slip past the content-hash gate and re-extract every
// old checkbox in the touched notes: 108 Spotted candidates from one "Apply links" on
// 15 Oct 2026. These pin that the hook skips candidate extraction for those sources,
// and that every hygiene route still tags its writes with the guarded prefix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const hooks = fs.readFileSync(path.join(__dirname, 'vault-hooks.js'), 'utf-8');
const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'vault-hygiene.js'), 'utf-8');

test('the hook guards vault-hygiene sources out of candidate extraction', () => {
  assert.match(hooks, /syncNoteActionCandidatesUnlessNova/, 'positive control: the call still exists');
  const guardIdx = hooks.indexOf("startsWith('vault-hygiene-')");
  const callIdx = hooks.indexOf('syncNoteActionCandidatesUnlessNova(relativePath)');
  assert.ok(guardIdx > 0 && callIdx > guardIdx, 'the guard sits before the extraction call');
  const activityIdx = hooks.indexOf('trackVaultWrite');
  assert.ok(activityIdx > guardIdx, 'a guard, not an early return: the write is still logged');
});

test('every hygiene route writes under the guarded prefix', () => {
  const sources = routes.match(/['"]vault-hygiene-[a-z-]+['"]/g) || [];
  assert.ok(sources.length >= 3, `positive control: found ${sources.length} hygiene sources`);
  for (const s of sources) assert.match(s, /^['"]vault-hygiene-/);
});
