'use strict';

/**
 * Do the web and iOS hear the same words?
 *
 * `shared/heard.cjs` and `Heard.swift` are one rule in two languages, and the
 * two repos deploy separately and cannot share code — the `PRICES_PER_MTOK`
 * situation, and the same one `FieldDrive` and the operation vocabulary are in.
 *
 * ⚠ DRIFT HERE IS SILENT AND ASYMMETRIC. A stop phrase one side knows and the
 * other does not means "stop" works on the kiosk and is sent to chat on the
 * phone — no error, no log, just a command that works on some of his devices.
 * That is the worst kind of bug on a surface whose whole promise is that she
 * behaves the same wherever she is.
 *
 * ⚠ SKIPS honestly with no sibling checkout, the design-token precedent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { STOP_PHRASES, normaliseSaid } = require('../../shared/heard.cjs');

const { findIOSCheckout } = require('../../shared/ios-checkout.cjs');
// ⚠ BOTH SPELLINGS — the checkout is `neuro-ios`, the remote `nuero-ios`.
// Hard-coding either made this guard SKIP on the only machine that has
// the iOS app, which is the whole point of a cross-repo parity test.
const IOS = findIOSCheckout(path.resolve(__dirname, '..', '..'));
const SWIFT = IOS ? path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'Heard.swift') : null;

function swiftStopPhrases(src) {
  const block = src.match(/stopPhrases:\s*Set<String>\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return null;
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

test('both sides stop on the same words', (t) => {
  if (!(SWIFT && fs.existsSync(SWIFT))) {
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const found = swiftStopPhrases(fs.readFileSync(SWIFT, 'utf8'));
  assert.ok(found, 'parsed the Swift stop list');
  // Positive control before any comparison: an unparseable file must not pass
  // by yielding an empty set that happens to satisfy a loop over nothing.
  assert.ok(found.size >= 3, `parsed ${found.size} phrases`);
  assert.deepEqual([...found].sort(), [...STOP_PHRASES].sort());
});

test('⚠ the normaliser agrees about apostrophes, case and punctuation', (t) => {
  if (!(SWIFT && fs.existsSync(SWIFT))) {
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const src = fs.readFileSync(SWIFT, 'utf8');
  // The Swift side strips anything that is not an ASCII letter or a number and
  // collapses runs of spaces. This asserts the SHAPE of that rule rather than
  // re-running it, because a Swift expression cannot be evaluated from here.
  assert.match(src, /isLetter && ch\.isASCII\) \|\| ch\.isNumber/, 'keeps letters and digits only');
  assert.match(src, /split\(separator: " "\)\.joined\(separator: " "\)/, 'collapses whitespace');
  assert.match(src, /lowercased\(\)/, 'case-insensitive');

  // And the JS side really does behave that way, so the assertion above is
  // describing a rule that exists rather than a comment.
  assert.equal(normaliseSaid("That’s done."), 'thats done');
  assert.equal(normaliseSaid("That's  DONE"), 'thats done');
});

test('⚠ both sides refuse an ambiguous phrase rather than picking one', (t) => {
  if (!(SWIFT && fs.existsSync(SWIFT))) {
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const src = fs.readFileSync(SWIFT, 'utf8');
  assert.match(src, /hits\.count == 1 \? \.utterance\(hits\[0\]\) : nil/,
    'exactly one, or nothing — guessing would hide a composer bug while acting on a card');
});
