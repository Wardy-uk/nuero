'use strict';

/**
 * Ritual, lit — step 7 of the design build order.
 *
 * ⚠ THE MEANINGS ON THIS SCREEN WERE ALREADY RIGHT. Unlike every screen before
 * it, nothing here was making the wrong claim: the failure branch is a failure,
 * the degraded banner is a degradation, and the send path is genuinely careful
 * (a message that did not reach the Pi is re-sent verbatim rather than answered
 * with "(continue)" — the 9 Sep fix, intact and commented).
 *
 * What was wrong is that every colour was HAND-MIXED. This screen predates the
 * primitives, so it carried its own red (`#3a1a1a` / `#6b2b2b`), its own amber
 * (`#3a2f14` / `#6b5520` / `#ffd98a`) and seven `var(--accent)` fills. Capture
 * and Review each had their own red too — and a reader cannot learn what red
 * means when every screen mixes a different one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'views');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'Standup.jsx'), 'utf8');
const css = () => fs.readFileSync(path.join(VIEWS, 'Standup.css'), 'utf8');
// ⚠ A name inside a comment is not a use — eighth time.
const code = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ no screen-local palette — the exchange is lit by her', () => {
  assert.match(css(), /\.su__toggle-btn/, 'could not read Standup.css');   // positive control
  const sheet = code();
  assert.ok(sheet.length < css().length, 'comment stripping removed nothing');

  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `Standup.css still picks the system accent: ${accents.join(', ')}`);

  // ⚠ HIS OWN MESSAGE BUBBLE IS HERS TOO, deliberately. It is chrome on a
  // CONVERSATION WITH HER — the one screen that is entirely her talking — so a
  // fixed blue bubble on a red day would be the last unlit thing on it.
  assert.match(sheet, /\.su__msg--user\s*\{[^}]*--saim-rgb/s);
});

test('⚠ ONE red, and it is the primitive\'s', () => {
  const sheet = code();
  assert.ok(!/#3a1a1a|#6b2b2b/.test(sheet), 'the hand-mixed red is back');
  const err = sheet.match(/\.su__error\s*\{([^}]*)\}/s);
  assert.ok(err, 'the failure treatment is gone');
  assert.match(err[1], /224, 84, 58/);
});

test('⚠ the degraded banner is a GAP, not a fault', () => {
  const sheet = code();
  // "Running without tools" means she can talk it through but cannot RECORD a
  // decision — part of her job unreachable, which is what amber means across
  // both apps. Nothing is broken and nothing was lost, so it must not share the
  // red beneath it.
  const banner = sheet.match(/\.su__banner\s*\{([^}]*)\}/s);
  assert.ok(banner, 'the degraded banner is gone');
  assert.match(banner[1], /240, 214, 166|#f0d6a6/, 'the banner lost the gap ink');
  assert.ok(!/224, 84, 58/.test(banner[1]), 'a degradation is wearing the fault colour');
});

test('⚠ a message that never reached the Pi is still re-sent verbatim', () => {
  // The rule none of the lighting may touch, and the reason this screen exists
  // in its current form: a 503 carries the server's transcript with his words
  // already on it; a transport failure carries no session at all and the words
  // exist nowhere but the phone. Treating the two alike is how Retry came to
  // answer "(continue)" and drop what he wrote.
  const src = jsx();
  assert.match(src, /const landed = e\.session\?\.messages\?\.at\(-1\)\?\.role === 'user';/);
  assert.match(src, /retryText: message, landed/);
  assert.match(src, /if \(pending && !landed\) \{[\s\S]{0,120}?send\(pending, \{ optimistic: false \}\)/);
  // And the note tells him which of the two happened.
  assert.match(src, /That message did not reach the Pi/);
});
