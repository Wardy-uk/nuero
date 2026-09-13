'use strict';

/**
 * `Theme.swift` is GENERATED from the PWA's token block, and stays that way.
 *
 * ⚠ WHY THIS EXISTS. NEURO's look is twenty custom properties in
 * `frontend/src/index.css`, and iOS had none of them: measured 13 Sep 2026, 35 of
 * 40 SwiftUI view files used no colour or type of their own, which is why the
 * native app read as Settings while the PWA read as NEURO.
 *
 * ⚠ AND WHY IT IS A TEST RATHER THAN TRUST. The two repos are separate checkouts
 * and cannot share code — the `PRICES_PER_MTOK` situation — so nothing on the
 * iOS side can notice the CSS moving. The drift is therefore made visible HERE,
 * on the side that owns the truth: change a colour without re-running the
 * exporter and this fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const tokens = require('../scripts/export-design-tokens');

test('positive control: the CSS still declares the token block', () => {
  // Without this, a moved or renamed block would make every assertion below pass
  // by finding nothing — the failure mode that makes a scan worse than none.
  const css = fs.readFileSync(tokens.CSS, 'utf8');
  const parsed = tokens.readTokens(css);
  assert.ok(Object.keys(parsed).length >= 15,
    `expected the :root token block, found ${Object.keys(parsed).length} tokens`);
  assert.equal(parsed['bg-primary'], '#0d0f14');
  assert.equal(parsed['warning'], '#f0a040');
});

test('a viewport token is NOT exported', () => {
  // `env(safe-area-inset-*)` is a browser fact with no Swift equivalent, and
  // SwiftUI has its own safe area — exporting one would fight it.
  const parsed = tokens.readTokens(fs.readFileSync(tokens.CSS, 'utf8'));
  for (const name of ['sat', 'sab', 'sal', 'sar']) {
    assert.ok(!(name in parsed), `${name} must not reach Swift`);
  }
});

test('a hex becomes a Color with the right channels', () => {
  // #f0a040 -> 240, 160, 64
  const swift = tokens.swiftColour('#f0a040');
  assert.match(swift, /red: 0\.9412/);
  assert.match(swift, /green: 0\.6275/);
  assert.match(swift, /blue: 0\.2510/);
  // Anything that is not a six-digit hex is left alone rather than guessed at.
  assert.equal(tokens.swiftColour('rgba(0,0,0,0.25)'), null);
  assert.equal(tokens.swiftColour('10px'), null);
});

test('names become Swift, and px becomes a number', () => {
  assert.equal(tokens.camel('bg-primary'), 'bgPrimary');
  assert.equal(tokens.camel('radius-sm'), 'radiusSm');
  assert.equal(tokens.px('10px'), 10);
  assert.equal(tokens.px('0 2px 8px rgba(0,0,0,.25)'), null);
});

test('Theme.swift is CURRENT — re-run the exporter if this fails', (t) => {
  if (!fs.existsSync(tokens.OUT)) {
    // The iOS checkout is a developer's sibling directory: absent on the Pi and
    // on CI, which is not a failure.
    t.skip('no nuero-ios checkout beside this repo');
    return;
  }
  const { source } = tokens.generate();
  const onDisk = fs.readFileSync(tokens.OUT, 'utf8');
  // ⚠ NEWLINES ARE NOT DRIFT, and this test failed for that reason within an
  // hour of being written: the iOS checkout is on Windows with git normalising
  // to CRLF while the exporter writes LF, so a byte comparison reports the file
  // stale on EVERY run, for ever. A check that fails for a reason unrelated to
  // what it is checking is one that gets switched off — and it takes the real
  // catch with it. Same species as the email-triage wall-clock bomb.
  assert.ok(tokens.sameIgnoringNewlines(onDisk, source),
    'Theme.swift is behind index.css — run: node backend/scripts/export-design-tokens.js');
});

test('the generated file says it is generated', () => {
  const { source } = tokens.generate();
  assert.match(source, /DO NOT EDIT/);
  // The source hash is what makes a stale copy identifiable at a glance.
  assert.match(source, /sha256 [0-9a-f]{12}/);
  assert.match(source, /public enum Theme/);
});
