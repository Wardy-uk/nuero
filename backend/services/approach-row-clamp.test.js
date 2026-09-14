'use strict';

/**
 * One ceiling on the flat row, not two that have to agree.
 *
 * ⚠⚠ PHOTOGRAPHED ON THE FIRE TABLET, 14 Sep 2026: "the bottom of the cards are
 * missing." The flat row had BOTH a `-webkit-line-clamp` on each card's title
 * and sub, AND a `max-height: 23%; overflow: hidden` on the row itself.
 *
 * A fully clamped card is three title lines at line-height 1.2, plus two sub
 * lines at 1.4, plus its own padding — taller than 23% of the stage. So the row
 * cap fired on cards that were already obeying their clamp, and sliced their
 * bottoms off.
 *
 * ⚠ THE COMMENT ABOVE THE RULE PREDICTED THE FAILURE AND THE NUMBER UNDER IT
 * CAUSED IT: "`overflow: hidden` alone would cut the bottom row of cards through
 * the middle of their letters."
 *
 * So the clamps are the ONLY bound now. They fix each card's height
 * deterministically, which fixes the row's — that is what stops it growing into
 * her sentence, and it was already doing the work. A second ceiling could only
 * be redundant (loose) or destructive (tight), and it was tight.
 *
 * ⚠ WHICH MAKES THE CLAMPS LOAD-BEARING, so removing them is what must fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui', 'Approach.css');
const css = () => fs.readFileSync(CSS, 'utf8');
const code = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ the flat row has no second ceiling', () => {
  const sheet = code();
  assert.match(sheet, /\.approach--quiet \.approach__row/, 'could not read Approach.css'); // positive control

  for (const m of sheet.matchAll(/\.approach--quiet \.approach__row\s*\{([^}]*)\}/gs)) {
    assert.ok(!/max-height/.test(m[1]),
              'the row has a height cap again — it must agree with the clamp or it slices');
    assert.ok(!/overflow:\s*hidden/.test(m[1]),
              'the row clips again — that cuts cards through the middle of their letters');
  }
});

test('⚠ the clamps ARE the bound, so they are load-bearing', () => {
  const sheet = code();
  // Three lines is a name you can read; the live offender was a 170-character
  // title that wanted eight.
  // ⚠ EVERY rule with that selector, not the first. The first draft of this test
  // matched `.approach__fact .approach__val` and found the FONT-SIZE rule two
  // hundred lines above the clamp, then reported the clamp missing. A scan is
  // only as good as its matcher — second time today.
  // ⚠ Built with `RegExp` and NO template literal. The first version of this
  // line went through a shell heredoc, which ate a backslash level: `\.` became
  // `.` and `\s` became `s`, so the pattern silently required a literal "s"
  // after the selector and matched nothing. The test then reported the clamp
  // missing when it was there. Same trap as the Scriptable widget's
  // no-backslashes rule — a pipeline that rewrites source is a pipeline that
  // can rewrite a guard into a lie.
  const bodies = (sel) => [...sheet.matchAll(
    new RegExp('\\.approach__fact \\.' + sel + '\\s*\\{([^}]*)\\}', 'gs'))].map((m) => m[1]);

  const val = bodies('approach__val');
  assert.ok(val.length, 'the title rule is gone');   // positive control
  const valClamp = val.find((b) => /-webkit-line-clamp/.test(b));
  assert.ok(valClamp, 'the title clamp is gone — the row is unbounded again');
  assert.match(valClamp, /-webkit-line-clamp:\s*3/);
  assert.match(valClamp, /overflow:\s*hidden/, 'a clamp without overflow:hidden does not clamp');

  const subClamp = bodies('approach__sub').find((b) => /-webkit-line-clamp/.test(b));
  assert.ok(subClamp, 'the sub clamp is gone');
  assert.match(subClamp, /-webkit-line-clamp:\s*2/);
});

test('⚠ the row still keeps its distance from her sentence', () => {
  // The reason the cap was added in the first place, which must not be lost:
  // the flat row is anchored at the BOTTOM and grew upwards as its cards got
  // wordier until it reached her. The clamp is what stops that now.
  const sheet = code();
  assert.match(sheet, /\.approach--quiet \.approach__row \{[^}]*bottom:/s,
               'the row is no longer bottom-anchored');
});
