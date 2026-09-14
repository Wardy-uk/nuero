'use strict';

/**
 * The centrepiece must not clip her own opening line.
 *
 * ⚠⚠ PHOTOGRAPHED ON THE DESKTOP WINDOW, 14 Sep 2026. "Team Standup just
 * finished." was sliced through the middle of its own letters by the top edge of
 * its box, and the utterance row was cut off the bottom. Three things combined,
 * and each was individually reasonable:
 *
 *   1. `Approach.css` caps the centrepiece — `max-height: 40%; overflow: hidden`
 *      — so a long sentence cannot grow down into the facts. Deliberate, and
 *      tuned when the box held ONE sentence and its buttons.
 *   2. `AttentionSurface.css` makes `.surface__say` a flex column with
 *      `justify-content: center`.
 *   3. The TRANSITION renders inside that same box, adding a second headline, a
 *      second sub-line and two more buttons. Roughly double.
 *
 * A CENTRED column that overflows spills EQUALLY AT BOTH ENDS, and
 * `overflow: hidden` clips both. So the cap did not trim the tail — it ate the
 * first line and the last at once.
 *
 * ⚠ WHY IT IS NOT A COSMETIC BUG. The line it cut is HER OPENING SENTENCE, which
 * is the product. And the row it cut off the bottom ends in "Show me
 * everything" — the escape hatch MANIFESTATION.md calls "always last and never
 * dropped", because it is the only way off a surface with no menu. The clip was
 * hiding the way back.
 *
 * ⚠ AND IT IS NOT RARE: it happens after every meeting. It looked like a one-off
 * only because the transition expires and the content shrinks back under the cap
 * on its own — which is also why it "fixed itself" before it could be inspected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SHARED = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui');
const read = (f) => fs.readFileSync(path.join(SHARED, f), 'utf8');
const code = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ the centrepiece is TOP-anchored, so an overflow can only cost the tail', () => {
  const css = code(read('Approach.css'));
  assert.match(css, /\.surface--approach \.surface__say\b/, 'could not read Approach.css'); // positive control

  // The base component centres it, which is right when the content fits and
  // catastrophic when it does not.
  assert.match(code(read('AttentionSurface.css')), /\.surface__say\s*\{[^}]*justify-content:\s*center/s,
               'the base rule changed — re-check this whole test');

  const capped = css.match(/\.surface--approach \.surface__say \{([^}]*overflow:\s*hidden[^}]*)\}/s);
  assert.ok(capped, 'the capped rule is gone');
  assert.match(capped[1], /justify-content:\s*flex-start/,
               'the centrepiece is centred again — an overflow will eat her first line');
});

test('⚠ the stacked state gets the room it actually needs', () => {
  const css = code(read('Approach.css'));
  const stacked = css.match(/\.surface--approach \.surface__say--stacked \{([^}]*)\}/s);
  assert.ok(stacked, 'the stacked cap is gone');

  // The cap's PURPOSE stands — she must not grow down into the facts — so it is
  // raised for the one state that genuinely holds two things, not removed.
  const base = css.match(/max-height:\s*40%/);
  assert.ok(base, 'the one-sentence cap is gone');
  const raised = Number((stacked[1].match(/max-height:\s*(\d+)%/) || [])[1]);
  assert.ok(raised > 40, `the stacked cap must exceed the base one, got ${raised}`);
  // `top` comes up with it, so the extra height is taken from the empty upper
  // third rather than from the corridor.
  const top = Number((stacked[1].match(/top:\s*(\d+)%/) || [])[1]);
  assert.ok(top < 15, `the stacked box must start higher, got ${top}`);
  // And it must still end above the band below it.
  assert.ok(top + raised <= 62, `the stacked box would reach the facts (${top} + ${raised})`);
});

test('⚠ the class is actually applied, and only when the transition is showing', () => {
  const src = read('AttentionSurface.jsx');
  assert.match(src, /transitionShown/, 'could not read AttentionSurface.jsx');   // positive control
  assert.match(src, /surface__say\$\{transitionShown \? ' surface__say--stacked' : ''\}/,
               'the stacked state is declared in CSS and never reached');
});

test('⚠ the escape hatch is the last utterance and must not be clipped away', () => {
  // "Show me everything" is capped last and never dropped — the only way off a
  // surface with no menu. This does not test the layout; it pins the reason the
  // layout matters, so a future cap change has the argument in front of it.
  const composer = fs.readFileSync(
    path.resolve(__dirname, 'sara-surface.js'), 'utf8');
  assert.match(composer, /Show me everything/, 'the escape hatch is gone from the composer');
});
