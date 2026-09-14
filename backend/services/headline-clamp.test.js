'use strict';

/**
 * Her headline is cut on a line boundary, or not at all.
 *
 * ⚠⚠ IT IS A HEIGHT PROBLEM, NOT A LENGTH ONE. The type scales with WIDTH
 * (`cqw`), so the desktop and the Fire tablet render nearly the same
 * line-length — but `max-height: 40%` of an 1186px-tall desktop is ~436px and of
 * an 800px-tall tablet is ~276px. Same words, same size, half the room.
 *
 * On the phone the squeeze lands exactly on a line boundary, so WebKit draws its
 * ellipsis and it reads cleanly, with the corridor card below carrying the whole
 * thing. On the tablet it lands MID-LINE — the last partial line is drawn and
 * then clipped, so the headline is cut horizontally through its own letters.
 *
 * ⚠ THIS IS NOT A CONTENT CHANGE, AND THAT IS THE POINT. The proposal it
 * replaced was to compose a bounded sentence instead of the record's title —
 * "the escalation for NT-24162 has gone 67 days without a reply". Nick, looking
 * at the desktop: "see, on the PC it's useful lol." He was right: the key AND
 * what is actually wrong, in two clean lines, is the most useful thing on that
 * screen, and the sentence would have said less. A fix aimed at the worst case
 * that degrades the best case is the wrong fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui', 'Approach.css');
const css = () => fs.readFileSync(CSS, 'utf8');
const code = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ a short LANDSCAPE screen clamps the headline to two lines', () => {
  const sheet = code();
  assert.match(sheet, /surface__saylead/, 'could not read Approach.css');   // positive control

  const q = sheet.match(
    /@media \(max-height: 900px\) and \(min-aspect-ratio: 1\/1\) \{([\s\S]*?)\n\}/);
  assert.ok(q, 'the short-landscape rule is gone');
  assert.match(q[1], /surface__saylead/);
  assert.match(q[1], /-webkit-line-clamp:\s*2/);
  // ⚠ Both properties, or Safari clamps and Chromium does not.
  assert.match(q[1], /[^-]line-clamp:\s*2/);
});

test('⚠ it must come AFTER the default clamp, or it never applies', () => {
  // Same specificity, so source order decides. A rule written above the one it
  // overrides is a rule that does nothing — and it would look correct.
  const sheet = css();
  const dflt = sheet.lastIndexOf('-webkit-line-clamp: 4');
  const short = sheet.indexOf('@media (max-height: 900px)');
  assert.ok(dflt > -1, 'the default headline clamp is gone');
  assert.ok(short > dflt, 'the short-screen rule is declared before the default it overrides');
});

test('⚠ portrait is left alone — it already reads correctly', () => {
  const sheet = code();
  // `min-aspect-ratio: 1/1` keeps the phone out of it. The phone was the
  // surface that showed what right looks like; changing it would be changing
  // the reference.
  assert.match(sheet, /@media \(max-height: 900px\) and \(min-aspect-ratio: 1\/1\)/);
});

test('⚠ the title itself is unchanged — the record still names itself', () => {
  // The composer still builds `${key} — ${summary}`. If a later change replaces
  // that with a composed sentence, this fails and the argument above has to be
  // had again rather than lost.
  const engine = fs.readFileSync(path.resolve(__dirname, 'decision-engine.js'), 'utf8');
  assert.match(engine, /\$\{single\.key\} — \$\{single\.summary\}/,
               'the escalation headline stopped naming the ticket and what is wrong with it');
});
