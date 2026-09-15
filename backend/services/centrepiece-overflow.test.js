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

const SHARED = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');
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
  //
  // ⚠ THE BASE CAP IS READ, NOT HARDCODED. This asserted a literal `40%` and
  // went red the moment 96aba23 took the height out of the empty bands instead
  // of out of her sentence — a deliberate change, correctly made, failing a
  // test that had pinned the NUMBER rather than the RULE. The rule is that the
  // stacked cap exceeds whatever the one-sentence cap currently is, so that is
  // what is compared. A cap of 40 pinned here again would only re-break on the
  // next tune.
  const sayRules = [...css.matchAll(/\.surface--approach \.surface__say \{([^}]*)\}/gs)];
  const caps = sayRules
    .map(r => [...r[1].matchAll(/max-height:\s*(\d+)%/g)].pop())
    .filter(Boolean)
    .map(m => Number(m[1]));
  assert.ok(caps.length, 'the one-sentence cap is gone');
  // Later declarations win, so the cap in force is the last one declared.
  const base = caps[caps.length - 1];
  const raised = Number((stacked[1].match(/max-height:\s*(\d+)%/) || [])[1]);
  assert.ok(raised > base, `the stacked cap must exceed the one-sentence cap ${base}%, got ${raised}`);

  // ⚠⚠ A FLOOR, NOT JUST A CEILING. This test had only an upper bound — and the
  // failure that bit TWICE was the cap being too SMALL: 52% when the state was
  // introduced, retuned to 44% by another session rebalancing the bands, while
  // in between the way-out gained a line of its own. Each change defensible
  // alone; nobody re-measured the box they shared, and the answers ended up
  // sliced through the middle of their letters.
  //
  // ⚠ EXPRESSED AS A RELATIONSHIP, not a number — pinning "56" here would be the
  // mistake 4cd42ff already corrected in this file. The stacked box holds a
  // transition prompt AND its own buttons AND the answers AND the way out, so
  // it needs MEANINGFULLY more than the one-sentence cap, not four points more.
  assert.ok(raised >= base * 1.35,
            `the stacked cap must be meaningfully larger than ${base}%, got ${raised}%`);
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
    path.resolve(__dirname, 'saim-surface.js'), 'utf8');
  assert.match(composer, /Show me everything/, 'the escape hatch is gone from the composer');
});

test('⚠⚠ PROSE YIELDS BEFORE CONTROLS — the row of answers never gives up height', () => {
  const css = code(read('Approach.css'));

  // Top-anchoring decides WHICH end an overflow costs. It cannot decide that
  // nothing is cut. This decides what is cut FIRST, and that question went
  // unasked until the utterance row was photographed sliced through the middle
  // of its own letters (14 Sep 2026) — the answers, with "Show me everything"
  // under them: the only way off a surface with no menu.
  const says = css.match(/\.surface--approach \.surface__say \.surface__says \{([^}]*)\}/s);
  assert.ok(says, 'the utterance row rule is gone');
  assert.match(says[1], /flex:\s*0 0 auto/,
               'the answers can shrink again — they must be the one thing that cannot');

  // ⚠ THE WRAPPER IS WHY IT BROKE. `saylead` and `saysub` could already shrink,
  // but in the stacked state they sit inside `surface__transition`, and a flex
  // item's `min-height: auto` refuses to go under its content size — so the
  // column overflowed and the LAST child fell past the clip line.
  const trans = css.match(/\.surface--approach \.surface__say \.surface__transition \{([^}]*)\}/s);
  assert.ok(trans, 'the transition cannot shrink — it will push the answers out again');
  assert.match(trans[1], /min-height:\s*0/);
  assert.match(trans[1], /flex:\s*0 1 auto/);
});
