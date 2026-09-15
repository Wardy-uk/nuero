'use strict';

/**
 * Prep, lit — step 8 of the design build order.
 *
 * ⚠ THE HONESTY ON THIS SCREEN WAS ALREADY GOOD: "Noted as outstanding" rather
 * than "Owes you", `awayUnknown` kept apart from `away`, every commitment
 * carrying its source, and the gaps block naming what could not be checked with
 * "Treat the sections above as incomplete, not clear." Nothing here was making
 * the wrong claim.
 *
 * Two things were wrong, and both are about a colour meaning one thing:
 *
 * ⚠ A FIFTH AMBER. `#e0c97e` here, `#f0d6a6` on Now and Review, `#ffd98a` on
 * Ritual — three values for one meaning, on the colour whose entire job is to be
 * RECOGNISED. Amber-means-unread only works if it is one amber.
 *
 * ⚠ AND THE LAST CELEBRATION EMOJI IN THE APP. `saim-voice` rejects the
 * "celebrate this small win" register outright, and CLAUDE.md records the two 🎉
 * empty states in this app being removed. This was a third — and it survived
 * because it is a FALLBACK, rendered only when the server sent no message, so it
 * is absent from the common case and from anyone reading the payload.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');
const VIEWS = path.join(APP, 'views');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'MeetingPrep.jsx'), 'utf8');

/**
 * ⚠⚠ A NAME INSIDE A COMMENT IS NOT A USE — and the first draft of this file
 * proved it twice in one run: the emoji test failed on the comment EXPLAINING
 * why the emoji went, and the "Owes you" test failed on the comment explaining
 * why the screen does not say "Owes you".
 *
 * That is the tenth time this repo has learned it, and the lesson has a sharper
 * edge each time: a scan that punishes its own documentation is a scan that
 * gets switched off, taking the real catch with it. Strip first, always.
 */
const strip = (t) => t
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')   // {/* JSX */}
  .replace(/\/\*[\s\S]*?\*\//g, '')                 // /* block */
  .replace(/^[ 	]*\/\/.*$/gm, '');   // // line
const jsxCode = () => strip(jsx());
const css = () => fs.readFileSync(path.join(VIEWS, 'MeetingPrep.css'), 'utf8');
// ⚠ A name inside a comment is not a use — ninth time.
const code = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ ONE amber across the app, because recognition is its whole job', () => {
  const sheet = code();
  assert.match(sheet, /\.mp__block--gaps/, 'could not read MeetingPrep.css');  // positive control
  assert.ok(!/#e0c97e/.test(sheet), 'the fifth amber is back');
  assert.match(sheet, /#f0d6a6/, 'the gap ink is gone');
});

test('⚠ SAiM does not celebrate', () => {
  // The last one in the app, and a fallback — which is why it outlived a
  // cleanup that recorded itself as finished.
  assert.match(jsx(), /mp__none/, 'could not read MeetingPrep.jsx');   // positive control
  const src = jsxCode();
  assert.ok(src.length < jsx().length, 'comment stripping removed nothing');
  for (const e of ['🎉', '🎊', '✨']) {
    assert.ok(!src.includes(e), `a celebration is back: ${e}`);
  }
  assert.match(src, /Nothing else in the diary\./);
});

test('⚠ no celebration anywhere else in SAiM either', () => {
  // ⚠ Scanned across the app, because the one that survived did so by being in
  // a branch nobody looks at. A per-screen check would have missed it too.
  const roots = [VIEWS, path.resolve(APP, '..', '..', 'shared-ui')];
  const hits = [];
  for (const dir of roots) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsx'))) {
      const body = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const e of ['🎉', '🎊']) if (body.includes(e)) hits.push(`${f}: ${e}`);
    }
  }
  assert.deepEqual(hits, [], `celebration register: ${hits.join(', ')}`);
});

test('⚠ the meeting he is walking into is the ONE lead', () => {
  const src = jsx();
  const leads = src.match(/tone="lead"/g) || [];
  assert.equal(leads.length, 1, `expected one lead, found ${leads.length}`);
  assert.match(src, /tone="lead" className="mp__meeting"/);
  // "Later today" is a scannable list, so no glow per line.
  assert.match(src, /tone="row" className="mp__later-item"/);
});

test('⚠ no screen-local palette, and the label is the shared one', () => {
  const sheet = code();
  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `still picks the system accent: ${accents.join(', ')}`);
  assert.match(jsx(), /<LitLabel className="mp__h">/);
  // ⚠ The cascade trap, fourth screen: this sheet loads after Lit.css, so a
  // `color:` left on the label's own rule wins and keeps it grey.
  const rule = sheet.match(/\.mp__h\s*\{([^}]*)\}/s);
  assert.ok(rule, 'the label rule is gone');
  assert.ok(!/(^|;|\s)color:/.test(rule[1]), 'the label overrides the shared colour');
});

test('⚠ the honesty that was already here is still here', () => {
  const src = jsxCode();
  // None of the lighting may cost these: a parse of a meeting note is not proof
  // a colleague failed, and an unchecked leave flag is not "nothing booked".
  assert.match(src, /Noted as outstanding/);
  assert.ok(!/Owes you/.test(src), 'the screen asserts a colleague failed again');
  assert.match(src, /awayUnknown/);
  assert.match(src, /Treat the sections above as incomplete, not clear\./);
});

test('⚠ iOS makes the same two distinctions', () => {
  // ⚠ SKIPPED, never failed, where the sibling checkout is absent — a test that
  // fails on a machine that simply does not have the other repo is one that gets
  // deleted, taking the drift check with it.
  // Their locator (better than the hardcoded sibling path this replaced), my
  // renamed target — the iOS folder and file are Saim/ as of 15 Sep 2026.
  const ios = path.resolve(require('./ios-checkout').findIOSCheckout() || '',
                           'Saim', 'SaimPrepView.swift');
  if (!fs.existsSync(ios)) return;
  const swift = fs.readFileSync(ios, 'utf8');

  assert.match(swift, /private func gaps\(/, 'could not read SaimPrepView.swift');  // positive control

  // The screen's whole register, on both surfaces.
  assert.match(swift, /Noted as outstanding/,
               'iOS started asserting a colleague failed');
  assert.match(swift, /Nothing else in the diary\./,
               'the two surfaces phrase an empty diary differently');

  // ⚠ One amber, and it is the shared one. iOS had TWO screen-local mixes —
  // worse than the web's single stray — which with #f0d6a6 here made four
  // values for one meaning.
  // The same comment stripping this file's own scans use.
  const code = strip(swift);
  assert.ok(!/Self\.(warm|flag)/.test(code), 'a screen-local amber is back on iOS');
  assert.ok(!/Color\.accentColor/.test(code), 'the system tint is back on iOS');
});
