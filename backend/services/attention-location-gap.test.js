'use strict';

// A location gap must mean "we do not know where he is" — not "no dwell yet".
//
// Nick, 12 Sep 2026: SARA reported "couldn't read location" while Home Assistant knew
// he was home. `gather()` pushed the gap as soon as the dwell list came back empty,
// and the HA fallback a few lines below then answered the question without withdrawing
// it. An empty dwell list is normal by construction: a dwell needs 20 minutes inside
// 200m, so a morning spent moving about produces none.
//
// `gather()` is heavy I/O (HA, calendar, Jira, email, the vault), so this pins the
// ORDER in the source — the thing that was wrong — with a positive control.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raw = fs.readFileSync(path.join(__dirname, 'attention.js'), 'utf8');
// Comments stripped: the comment explaining this fix quotes the old wording.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the location gap is pushed only after the Home Assistant fallback', () => {
  const fallback = src.indexOf("inputs.location = { known: true, place, source: 'home-assistant' }");
  assert.ok(fallback > 0, 'the HA fallback is still there — otherwise this scan proves nothing');

  const gapPushes = [...src.matchAll(/gaps\.push\(\{\s*input:\s*'location'/g)].map((m) => m.index);
  assert.ok(gapPushes.length > 0, 'a location gap is still raised somewhere');
  for (const at of gapPushes) {
    assert.ok(at > fallback,
      `a location gap is pushed at ${at}, before the fallback at ${fallback} — it would survive HA answering`);
  }
});

test('the gap is guarded on the location still being unknown', () => {
  const fallback = src.indexOf("inputs.location = { known: true, place, source: 'home-assistant' }");
  const after = src.slice(fallback);
  assert.match(after, /if\s*\(!inputs\.location\.known\)\s*\{\s*gaps\.push\(\{\s*input:\s*'location'/,
    'the gap must be conditional on not knowing');
});

test('an empty dwell list no longer blames OwnTracks for being unreadable', () => {
  assert.doesNotMatch(src, /OwnTracks recorded no dwell today/,
    'that wording rendered as "couldn\'t read location" on every surface');
  assert.match(src, /no stay of 20 minutes or more recorded yet today/);
});
