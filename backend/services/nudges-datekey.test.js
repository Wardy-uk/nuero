'use strict';

// ⚠ TZ IS SET BEFORE ANYTHING IS REQUIRED. Node reads it once, at first use of
// Date — setting it lower down in the file would silently test the runner's own
// timezone instead, which is the failure mode this whole test exists to catch.
process.env.TZ = 'Europe/London';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-datekey-'));
process.env.NEURO_DB_PATH = path.join(root, 'datekey.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const { todayKey } = require('../services/nudges');

// The date every nudge is keyed on, and the hour it used to get wrong.
//
// `todayKey` was `new Date().toISOString().split('T')[0]`. That is UTC, while
// `isPastStandupCutoff` reads `getHours()` and all 25 `cron.schedule` calls run
// in the system timezone with no `timezone` option. The three agreed only
// because the Pi runs on UTC — so the fix that moves it to Europe/London, which
// is a change we actually intend to make, is exactly what would have broken it.

test('midnight to 1am BST keys to TODAY, not yesterday', () => {
  // 2026-09-11T23:30Z is 00:30 on the 12th in London (BST, UTC+1).
  // toISOString() answered '2026-09-11'. Every nudge created in that hour would
  // be filed under yesterday: getActiveNudgeByTypeAndDate would miss it, the
  // trigger would create a duplicate on every run, and clearStaleNudges —
  // which retires anything with date_key < todayKey() — would bin them all an
  // hour later.
  assert.equal(todayKey(new Date('2026-09-11T23:30:00Z')), '2026-09-12');
});

test('late evening BST still keys to the current day', () => {
  // 22:30Z is 23:30 in London — same date both ways. The paired positive, so a
  // "fix" that simply shifted the bug an hour would fail here.
  assert.equal(todayKey(new Date('2026-09-11T22:30:00Z')), '2026-09-11');
});

test('outside BST, UTC and local agree and the key is unchanged', () => {
  // January is GMT, so this is the case that was never broken. Pinned so the
  // local-components rewrite cannot regress the ordinary half of the year.
  assert.equal(todayKey(new Date('2026-01-15T23:30:00Z')), '2026-01-15');
  assert.equal(todayKey(new Date('2026-01-15T00:30:00Z')), '2026-01-15');
});

test('month and day are zero-padded, so keys sort and compare', () => {
  // clearStaleNudges compares with `<` on the raw string, so '2026-9-1' would
  // sort before '2026-10-01' and retire live nudges.
  assert.equal(todayKey(new Date('2026-01-05T12:00:00Z')), '2026-01-05');
  assert.match(todayKey(new Date('2026-11-30T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

test('the string comparison clearStaleNudges relies on holds across a month end', () => {
  // The retirement rule is `nudge.date_key < todayKey()`, a lexicographic
  // compare on these strings rather than a date compare.
  const sep30 = todayKey(new Date('2026-09-30T12:00:00Z'));
  const oct01 = todayKey(new Date('2026-10-01T12:00:00Z'));
  assert.ok(sep30 < oct01, `${sep30} should sort before ${oct01}`);
});
