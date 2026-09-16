'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { canonicalPlaudId, unknownPrefix, samePlaudRecording } = require('../../shared/plaud-id.cjs');

// The live pair that cost 111 duplicate notes on 15 Sep 2026. Copied off the vault, not
// invented: the whole finding is that these two strings name ONE recording.
const BARE = 'f15f43b4c66c3a6e4b16d07c0e94268b';
const PREFIXED = 'of_f15f43b4c66c3a6e4b16d07c0e94268b';

test('the two spellings PLAUD used name the same recording', () => {
  assert.equal(canonicalPlaudId(PREFIXED), BARE);
  assert.equal(canonicalPlaudId(BARE), BARE);
  assert.ok(samePlaudRecording(PREFIXED, BARE));
});

test('quotes off frontmatter are stripped, both spellings', () => {
  assert.equal(canonicalPlaudId(`"${PREFIXED}"`), BARE);
  assert.equal(canonicalPlaudId(`"${BARE}"`), BARE);
});

test('nothing usable is EMPTY STRING, never undefined', () => {
  // `plaud_id: "undefined"` reached the vault once already. A key of undefined is how.
  for (const value of [null, undefined, '', '   ', '""']) {
    assert.equal(canonicalPlaudId(value), '', `for ${JSON.stringify(value)}`);
  }
});

test('an UNKNOWN prefix is left alone, never guessed off', () => {
  // The asymmetry: an unstripped prefix duplicates a note (visible, recoverable);
  // wrongly stripping one merges two recordings and LOSES a meeting, silently.
  const other = 'ab_f15f43b4c66c3a6e4b16d07c0e94268b';
  assert.equal(canonicalPlaudId(other), other);
  assert.ok(!samePlaudRecording(other, BARE));
});

test('an unknown prefix is REPORTED so the next format change is loud', () => {
  assert.equal(unknownPrefix('ab_f15f43b4c66c3a6e4b16d07c0e94268b'), 'ab_');
  assert.equal(unknownPrefix(PREFIXED), null, 'a known prefix is not a surprise');
  assert.equal(unknownPrefix(BARE), null, 'a bare id has no prefix');
});

test('a prefix is only stripped when a plausible id is left behind', () => {
  // `of_` on something short is likelier to BE the id than to decorate one.
  assert.equal(canonicalPlaudId('of_short'), 'of_short');
  assert.equal(canonicalPlaudId('of_'), 'of_');
});

test('two DIFFERENT recordings never collapse together', () => {
  const a = 'of_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'of_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.notEqual(canonicalPlaudId(a), canonicalPlaudId(b));
});

// ---------------------------------------------------------------------------
// The two guards that were keyed on the raw id, and both broke the same way.
// ---------------------------------------------------------------------------

test('the sync ledger cannot hold one recording under two spellings', () => {
  const { _internal } = require('./plaud-sync');
  const key = _internal && _internal.recordingKey;
  assert.ok(typeof key === 'function', 'recordingKey must be exported to be pinned');

  const ledger = {};
  ledger[key({ id: BARE })] = { note: 'july' };
  // The same recording coming back under the new spelling must find its own entry.
  assert.ok(ledger[key({ id: PREFIXED })], 'a re-pull must recognise what it already has');
  assert.equal(Object.keys(ledger).length, 1);
});

test('the NOVA claim filter matches a note whichever spelling it carries', () => {
  const { _novaInternals } = require('./action-candidates');
  const claimed = _novaInternals && _novaInternals.novaClaimedNote;
  assert.ok(typeof claimed === 'function', 'novaClaimedNote must be exported to be pinned');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-id-'));
  const write = (name, id) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `---\nplaud_id: "${id}"\ntype: meeting\n---\n\n# Meeting\n`);
    return file;
  };

  // NOVA records the claim under ONE spelling; the note may carry either.
  const claim = new Set([BARE]);
  assert.ok(claimed(write('bare.md', BARE), claim), 'bare note, bare claim');
  assert.ok(claimed(write('prefixed.md', PREFIXED), claim),
    'a prefixed note must still be recognised as NOVA-owned — this is the check that ' +
    'failed open and put NOVA 1-2-1s in the review queue');

  const otherClaim = new Set(['0123456789abcdef0123456789abcdef']);
  assert.ok(!claimed(write('unrelated.md', BARE), otherClaim),
    'a note NOVA has not claimed must still come back false');

  fs.rmSync(dir, { recursive: true, force: true });
});
