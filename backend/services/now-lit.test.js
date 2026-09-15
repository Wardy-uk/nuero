'use strict';

/**
 * Now, lit by her — step 2 of the design build order.
 *
 * Now is a DESTINATION, not the ambient surface: he arrived wanting something
 * specific, so it stays quiet, scannable and utilitarian. What changed is that
 * it is lit by HER rather than by a flat border and the fixed system accent —
 * MANIFESTATION.md's own finding that "the secondary screens are not lit by her
 * at all ... so the app looks like two products".
 *
 * ⚠ THE SCENE DID NOT COME WITH IT. No corridor (depth is time, and a task list
 * has no hours) and no centrepiece, with ONE named exception: a screen that
 * genuinely has one answer, which an unclosed session is.
 *
 * Three live rule breaks were found on this screen while lighting it, and each
 * has a test below. They are the reason this is not only a stylesheet change.
 *
 * ⚠ These are SOURCE SCANS, and every one carries a positive control so a
 * wrong path fails loudly rather than passing by absence. The primitive itself
 * is exercised by a real esbuild render in `lit-primitives.test.js`; what is
 * asserted here is which tone each thing was given, which is a fact about the
 * source rather than about a rendered tree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src', 'views');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'Now.jsx'), 'utf8');

/**
 * ⚠ A NAME INSIDE A COMMENT IS NOT A USE — fourth time this repo has learned
 * it (the DOORS parser, the client-route scan, the mount reader), and it bit
 * immediately: the rule below failed on the comment EXPLAINING why
 * `var(--accent)` had gone. A test that punishes exactly the documentation
 * worth keeping is one that gets switched off, which costs the real catch.
 *
 * The reads are separated so a positive control can still see the whole file.
 */
const css = () => fs.readFileSync(path.join(VIEWS, 'Now.css'), 'utf8');
const cssCode = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ nothing on Now is a flat card any more', () => {
  const src = jsx();
  assert.match(src, /function Section\(/, 'could not read Now.jsx');   // positive control
  // `.card` is a flat border and the panel fill — the look this step replaces.
  const flat = src.match(/className="card\b[^"]*"/g) || [];
  assert.deepEqual(flat, [], `still flat: ${flat.join(', ')}`);
  assert.match(src, /from '\.\.\/\.\.\/\.\.\/shared-ui\/Lit\.jsx'/);
});

test('⚠ the lead is spent exactly ONCE', () => {
  const src = jsx();
  // MANIFESTATION.md: the centrepiece does not export to a list — a hero on a
  // list just makes one row arbitrarily loud. The exception is a screen that
  // genuinely has ONE answer, and an unclosed session is that: the cost of an
  // interruption is the failure to come back.
  //
  // ⚠ Spending it twice would mean spending it nowhere, which is why this
  // counts rather than merely checking it is present.
  const leads = src.match(/tone="lead"/g) || [];
  assert.equal(leads.length, 1, `the lead must be spent once, found ${leads.length}`);
  // And it is the return prompt that has it.
  assert.match(src, /tone="lead" className="now__focus now__return"/);
});

test('⚠ a statement is not a control', () => {
  const src = jsx();
  // "Nothing pending", "Nothing left in the diary", "I couldn't read this" —
  // facts, not things to act on, so they carry no glow and no affordance.
  // Anything that looks pressable and is not is worse than plain text.
  for (const line of ['now__calm', 'now__unread']) {
    const uses = src.match(new RegExp(`<Lit[^>]*className="[^"]*${line}[^"]*"`, 'g')) || [];
    assert.ok(uses.length > 0, `${line} is not rendered through Lit`);
    for (const use of uses) {
      assert.match(use, /tone="statement"/, `${line} must be a statement: ${use}`);
    }
  }
});

test('⚠ NAMED gaps, never counted — and never collapsed behind the count', () => {
  const src = jsx();
  assert.match(src, /s\.gaps/, 'could not find the gaps block');   // positive control

  // This screen was breaking an exported rule. It rendered
  // "{s.gaps.length} things I couldn't read" as a <details> SUMMARY, so the
  // number was the headline and the one useful part — WHICH source went dark —
  // took a tap to reach. "I couldn't read the diary" and "I couldn't read your
  // tasks" send him to different places; "3 gaps" sends him nowhere.
  assert.ok(!/<details className="now__gaps">/.test(src), 'gaps are collapsed again');
  assert.ok(!/\{s\.gaps\.length\}/.test(src), 'gaps are counted again');
  assert.match(src, /\{s\.gaps\.map\(/, 'each gap must be named');
  assert.match(src, /<strong>\{g\.input\}<\/strong>/);
});

test('⚠ the reason a tick is refused is SAID, not hidden in a title', () => {
  const src = jsx();
  assert.match(src, /completableOffline/, 'could not find the tick');   // positive control

  // A Microsoft-owned task cannot be ticked offline. That was a `disabled`
  // circle at 35% opacity with the reason in a `title` attribute — which a
  // phone cannot show, the exact trap `Whereabouts` already records. So the row
  // said nothing, greyed out, and reads as broken rather than as not-ours.
  assert.ok(!/title=\{t\.completableOffline/.test(src), 'the reason is back in a tooltip');
  assert.match(src, /Owned elsewhere — open it online to tick it/,
               'the reason must be rendered');

  // ⚠ AND IT MUST MATCH iOS WORD FOR WORD. `completableOffline` is
  // `Number.isInteger(task_id)`, so false means "no NEURO id" — a Microsoft
  // mirror OR a daily-note line. Naming Microsoft would be a plausible guess
  // that is wrong on the vault rows, and two surfaces phrasing one refusal two
  // ways is the drift the composed-server-side rule exists to stop.
  assert.ok(!/Microsoft owns this one/.test(src), 'the owner is being guessed');

  // ⚠ And unreachable renders DASHED rather than dead: a control NEURO would
  // refuse must not look as available as one that works, and must not be
  // missing either.
  assert.match(src, /tone=\{t\.completableOffline \? 'normal' : 'unreachable'\}/);
});

test('⚠ no screen-local palette — her colour or nothing', () => {
  assert.match(css(), /\.now__sec\b/, 'could not read Now.css');   // positive control
  const sheet = cssCode();
  assert.ok(sheet.length > 0 && sheet.length < css().length,
            'comment stripping removed nothing — the scan would pass by accident');

  // `var(--accent)` is the fixed system blue. On a day she has gone red, an
  // accent-blue edge on the most important card on the screen is the
  // two-products finding inside a single rule. Nine rules on this one screen
  // used it, each individually harmless.
  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `Now.css still picks the system accent: ${accents.join(', ')}`);
  assert.match(sheet, /rgb\(var\(--saim-rgb/, 'the return prompt must carry HER edge');
});

test('the section label is the shared one, not a local re-invention', () => {
  const src = jsx();
  const sheet = cssCode();
  assert.match(src, /<LitLabel as="h2" className="now__sech">/);
  // Size, tracking, case and weight live in Lit.css so every screen's section
  // labels are one thing. Only spacing is this screen's business.
  assert.ok(!/text-transform:\s*uppercase/.test(sheet), 'the label type is local again');
  assert.ok(!/\.now__sech\s*\{[^}]*color:/.test(sheet), 'the label picked its own colour again');
});
