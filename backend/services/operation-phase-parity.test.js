'use strict';

/**
 * Do the web and iOS agree about what SAiM can be DOING?
 *
 * `shared/operation-phase.cjs` is the vocabulary; `Operation.swift` is its
 * Swift half. The two repos deploy separately and cannot share code — the
 * `PRICES_PER_MTOK` situation, and the same one `FieldDrive.swift` and the
 * design tokens are in — so the only thing that stops them drifting is a guard
 * that reads both and says when they have.
 *
 * ⚠ A DRIFTED PHASE IS SILENT. A phase iOS does not know renders as nothing,
 * which looks exactly like a calm resting state; a label it spells differently
 * puts two words for one fact on two screens Nick reads side by side. Neither
 * throws, neither fails a build, and neither is visible from either app.
 *
 * ⚠ It SKIPS honestly with no sibling checkout, the design-token precedent:
 * a guard that fails for an absent repo is one that gets switched off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PHASES, LABELS } = require('../../shared/operation-phase.cjs');

const { findIOSCheckout } = require('../../shared/ios-checkout.cjs');
// ⚠ BOTH SPELLINGS — the checkout is `neuro-ios`, the remote `nuero-ios`.
// Hard-coding either made this guard SKIP on the only machine that has
// the iOS app, which is the whole point of a cross-repo parity test.
const IOS = findIOSCheckout(path.resolve(__dirname, '..', '..'));
const SWIFT = IOS ? path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'Operation.swift') : null;

/** The raw phase strings the Swift enum declares, in declaration order. */
function swiftPhases(src) {
  const out = [];
  // `case awaitingAuthorisation = "awaiting_authorisation"` or bare `case quiet`.
  for (const m of src.matchAll(/^\s*case\s+([A-Za-z]+)(?:\s*=\s*"([^"]+)")?\s*$/gm)) {
    out.push(m[2] || m[1]);
  }
  return out;
}

/** The labels the Swift `label` switch returns. */
function swiftLabels(src) {
  const body = src.slice(src.indexOf('public var label: String'));
  const out = new Set();
  for (const m of body.matchAll(/return\s+"([A-Z][A-Z ]+)"/g)) out.add(m[1]);
  return out;
}

test('the Swift half declares exactly the phases the vocabulary does', (t) => {
  if (!(SWIFT && fs.existsSync(SWIFT))) {
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const src = fs.readFileSync(SWIFT, 'utf8');
  const declared = swiftPhases(src);

  // A positive control first. Without it an unparseable file would pass every
  // set comparison below by yielding nothing — the absence-of-evidence trap
  // this repo keeps finding in its own scans.
  assert.ok(declared.length >= PHASES.length, `parsed ${declared.length} cases from Operation.swift`);

  assert.deepEqual(
    [...declared].sort(),
    [...PHASES].sort(),
    'shared/operation-phase.cjs and Operation.swift name the same phases',
  );
});

test('the Swift half spells every label the same way', (t) => {
  if (!(SWIFT && fs.existsSync(SWIFT))) {
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const src = fs.readFileSync(SWIFT, 'utf8');
  const found = swiftLabels(src);
  assert.ok(found.size >= Object.keys(LABELS).length, `parsed ${found.size} labels`);
  for (const label of Object.values(LABELS)) {
    assert.ok(found.has(label), `Operation.swift returns "${label}"`);
  }
});

test('the Swift half agrees about which phases are ACTIVE', (t) => {
  if (!(SWIFT && fs.existsSync(SWIFT))) {
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const src = fs.readFileSync(SWIFT, 'utf8');
  const { ACTIVE } = require('../../shared/operation-phase.cjs');
  // The Swift side lists the active cases on one line of its `isActive` switch.
  const m = src.match(/case ([^:]+): return true\s*\n\s*case ([^:]+): return false/);
  assert.ok(m, 'isActive is a two-arm switch, as written');
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const activeOnIOS = new Set(m[1].split(',').map((x) => x.trim().replace(/^\./, '')));
  for (const phase of ACTIVE) {
    assert.ok(activeOnIOS.has(camel(phase)), `${phase} is active on iOS too`);
  }
  assert.equal(activeOnIOS.size, ACTIVE.size, 'and iOS calls nothing else active');
});
