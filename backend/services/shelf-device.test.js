'use strict';

/**
 * The mic is a card on the shelf, and the foot sits on the same line as them.
 *
 * ⚠ Nick, 14 Sep 2026: "talk to me should be part of the suggest cards, they
 * should all look the same, and the 1 held etc should line up centrally with
 * the action cards."
 *
 * The mic sat in the FOOT as a pill of its own, next to a row of cards it
 * shared nothing with — while MANIFESTATION.md already says what that corner
 * is: "the bottom-right corner is HARDWARE, not content — weather now-and-next,
 * the desk-intent apps where the laptop answered, the house doors where the
 * house answered." A microphone is exactly that, a capability of the device.
 *
 * ⚠ AND IT IS A SLOT, NOT A PAYLOAD FIELD, because whether a mic exists is a
 * fact about the DEVICE and the composer cannot know it. "Talk to me is on the
 * fire tablet, not the laptop" — Electron exposes `webkitSpeechRecognition`
 * with no service behind it, so the shell passes nothing there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SHARED = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');
const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');
const code = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ the mic is one of the cards, not something that resembles one', () => {
  const src = read(path.join(APP, 'views', 'Surface.jsx'));
  assert.match(src, /CAN_LISTEN/, 'could not read Surface.jsx');   // positive control

  // It carries the shelf's own class. A second definition of "a card on the
  // shelf" is how the row comes to have two looks.
  assert.match(src, /className=\{`shelf__btn\$\{listening \? ' shelf__btn--live' : ''\}`\}/);
  // And it is handed to the shelf, not left in the foot.
  assert.match(src, /deviceSlot=\{micCard\}/);
  assert.ok(!/surface__mic/.test(src), 'the mic has its own styling again');
});

test('⚠ offered only where it EXISTS', () => {
  const src = read(path.join(APP, 'views', 'Surface.jsx'));
  // A control that fails on the tap is worse than no control. On the laptop
  // `CAN_LISTEN` is false and the slot is empty rather than dead.
  assert.match(src, /const micCard = CAN_LISTEN \? \(/);
  assert.match(src, /\) : null;/);
});

test('⚠ the slot reaches the shelf, and leads the row', () => {
  const surface = read(path.join(SHARED, 'AttentionSurface.jsx'));
  assert.match(surface, /deviceSlot = null,/, 'the surface does not accept the slot');
  assert.match(surface, /device=\{deviceSlot\}/, 'the surface does not pass it on');

  const shelf = read(path.join(SHARED, 'Shelf.jsx'));
  assert.match(shelf, /\s+device = null,/, 'the shelf does not accept it');
  // ⚠ FIRST, because this row WRAPS — whatever is last is what falls off the
  // end, and the way to speak to a surface with no menu must not be the item
  // that wraps away.
  const row = shelf.slice(shelf.lastIndexOf('<div className="shelf__row">'));
  const devAt = row.indexOf('{device}');
  const wxAt = row.indexOf('{wx &&');
  assert.ok(devAt > -1 && wxAt > -1 && devAt < wxAt, 'the mic no longer leads the row');
});

test('⚠ the shelf still never goes empty — a device control survives it', () => {
  const shelf = read(path.join(SHARED, 'Shelf.jsx'));
  const empty = shelf.slice(shelf.indexOf('if (!wx && items.length === 0)'));
  assert.match(empty.slice(0, 600), /\{device\}/,
               'the empty shelf drops a control it can actually reach');
});

test('⚠ ONE number decides how tall a card is', () => {
  // The foot and the cards are SIBLINGS, so the metric cannot live on `.shelf`
  // — a custom property inherits down, not sideways. The first attempt defined
  // the literal in both places under a comment claiming it did not, which is
  // exactly the drift it was written to prevent.
  const defs = ['Lit.css', 'Shelf.css', 'Approach.css', 'AttentionSurface.css']
    .map((f) => [f, (code(read(path.join(SHARED, f))).match(/--shelf-pad-y:\s*clamp/g) || []).length]);
  const total = defs.reduce((n, [, c]) => n + c, 0);
  assert.equal(total, 1, `--shelf-pad-y is declared ${total} times: ${JSON.stringify(defs)}`);
  // And it is declared in the scope that wraps the whole app.
  assert.match(code(read(path.join(SHARED, 'Lit.css'))), /--shelf-pad-y:\s*clamp/);
});

test('⚠ the foot is padded to the card, so they share a middle', () => {
  const css = code(read(path.join(SHARED, 'Approach.css')));
  const foot = css.match(/\.surface--approach \.surface__foot \{([^}]*bottom: 4%[^}]*)\}/s);
  assert.ok(foot, 'the foot rule is gone');
  // They shared a `bottom` and nothing else, so a one-line aside and a padded
  // card met at their bottom EDGES and nowhere near their middles.
  assert.match(foot[1], /padding-block:\s*calc\(var\(--shelf-pad-y\)/);
  assert.match(foot[1], /justify-content:\s*center/);
});

test('⚠ listening is readable by shape as well as colour', () => {
  const css = code(read(path.join(SHARED, 'Shelf.css')));
  const live = css.match(/button\.shelf__btn--live \{([^}]*)\}/s);
  assert.ok(live, 'the listening state is gone');
  // The whole row is monospace caps at 13px; a fill alone at that size is a
  // smudge rather than a signal, so the border carries it too.
  assert.match(live[1], /border-color:/);
  assert.match(live[1], /background:/);
  // And it is HER colour, so it agrees with everything else on the screen.
  assert.match(live[1], /--saim-rgb/);
});
