'use strict';

/**
 * SARA's Controls, against the rules — step 10 of the design build order, and
 * the last numbered screen.
 *
 * ⚠⚠ THE FINDING IS ONE COLOUR CARRYING FOUR DIFFERENT CLAIMS. iOS had EIGHT raw
 * `.orange`s on this screen — worse than Prep's two — and by the vocabulary they
 * were four separate facts:
 *
 *   a dead backend and a save that did not land        (BROKEN)
 *   three sections that could not be read              (UNREAD)
 *   notifications posted, accepted and never shown     (UNREACHABLE, fixable)
 *   "ritual nudges: suppressed"                        (SARA DOING AS TOLD)
 *
 * The last one is the one that matters most: painting an instruction being
 * obeyed as a warning is exactly how a screen teaches Nick to ignore its
 * warnings — and the two genuine faults were wearing the gap colour, so a dead
 * Pi looked the same as a list that had not loaded.
 *
 * The web had the same shape in one mix (#ff9d9d, a fifth red) across a dead
 * backend, a failed save, an unreadable section AND a notification permission
 * Nick had DECLINED — his own answer rendered back at him as an alarm.
 *
 * ⚠ THE RULE IS NOW WRITTEN DOWN, in `Lit.css`, because this judgement has been
 * made on seven screens and recorded on none: fault = broke, gap = a hole in an
 * answer otherwise being given, statement = a permanent fact about this device
 * or a decision he made.
 *
 * ⚠ AND IT CAUGHT A MISTAKE MADE YESTERDAY. Chat's "this browser has no speech
 * recognition" was painted amber on step 9 — and the kiosk and the Electron
 * window both mount Chat, so it would have sat lit for ever over a device
 * working exactly as it always will. Corrected here to a plain statement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'sara', 'app', 'src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/** ⚠ A name inside a comment is not a use — every scan here strips first. */
const strip = (t) => t
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const jsx = () => read(APP, 'views', 'Controls.jsx');
const css = () => read(APP, 'views', 'Controls.css');

test('⚠⚠ the three meanings are written down, once, where every screen can read it', () => {
  // Seven screens made this call and none of them recorded it. The vocabulary
  // lives with the primitives, not in one screen's comments.
  const lit = read(ROOT, 'sara', 'shared-ui', 'Lit.css');
  assert.match(lit, /lit-chip--gap/, 'could not read Lit.css');   // positive control
  for (const word of ['FAULT', 'GAP', 'STATEMENT']) {
    assert.ok(lit.includes(word), `the ${word} rule is gone from Lit.css`);
  }
});

test('⚠⚠ a broken thing and an unread thing are different colours', () => {
  const view = strip(jsx());
  const sheet = strip(css());
  assert.match(view, /controls__record/, 'could not read Controls.jsx');   // positive control

  // The fifth red is gone, and the two classes exist as separate things.
  assert.ok(!/#ff9d9d/.test(sheet), 'the screen mixed its own red again');
  assert.match(sheet, /\.controls__fault/);
  assert.match(sheet, /\.controls__gap/);

  // Nothing loaded at all, and a write that did not land: both FAULTS.
  assert.match(view, /controls__fault">I couldn't reach NEURO/);
  assert.match(view, /controls__fault">Last change didn't save/);

  // One section unreadable while the rest answers: a GAP, and the only one.
  assert.match(view, /controls__gap">I couldn't read what's muted/);
});

test('⚠⚠ his own decision is not an alarm', () => {
  // The browser will not ask twice, so painting "no" in red is the screen
  // telling him off for answering the question it asked.
  const view = strip(jsx());
  assert.match(view, /permissionNote && <p className="controls__muted"/,
               'a declined permission is being rendered as a failure again');
});

test('⚠ a permanent fact about the device stays quiet', () => {
  // Push is genuinely unavailable in the Electron window and on the kiosk. That
  // is a statement about where he is standing, and colouring it would light a
  // warning for ever on two of the four surfaces.
  const view = strip(jsx());
  assert.match(view, /pushUnsupportedReason\(\)/);
  assert.ok(!/controls__gap">\{pushUnsupportedReason|controls__fault">\{pushUnsupportedReason/.test(view),
            'a permanent device fact is being coloured');
});

test('⚠⚠ Chat: an absent capability is a statement, not a gap (corrected from step 9)', () => {
  const chat = strip(read(APP, 'views', 'Chat.jsx'));
  const chatCss = read(APP, 'views', 'Chat.css');
  assert.match(chat, /SpeechRecognition/, 'could not read Chat.jsx');   // positive control

  // ⚠ The kiosk and the Electron window both mount Chat, so amber here sits lit
  // for ever over a device that is working exactly as it always will.
  assert.ok(!/chat__voice-note--gap/.test(chat),
            'the unsupported-mic line is amber again — it would never go out');
  assert.ok(!/chat__voice-note--gap/.test(chatCss), 'the dead gap style is back');

  // But a mic that was asked for and FAILED is still a fault.
  assert.match(chat, /chat__voice-note--err/);
});

test('⚠ the light on this screen is hers', () => {
  const sheet = strip(css());
  assert.ok(!/var\(--accent\)|var\(--accent-dim\)/.test(sheet),
            'a screen-local accent is back — it does not move when she does');
  assert.match(sheet, /--sara-rgb/);
  // Including the radio ticks, which are the most-touched control here.
  assert.match(sheet, /accent-color: rgb\(var\(--sara-rgb/);
});

test('⚠ the honesty that was already here is still here', () => {
  const view = jsx();
  // This screen was written carefully and none of it should be lost to a
  // colour pass.
  assert.match(view, /No source to cite, so this will not interrupt you/);
  assert.match(view, /That is a real answer, not a blank screen/);
  assert.match(view, /so this is not a clean list/);
  // An opaque Graph id is never a label.
  assert.match(view, /function readableRef/);
});

test('⚠ iOS makes the same four distinctions', () => {
  // ⚠ SKIPPED, never failed, where the sibling checkout is absent.
  const ios = require('./ios-checkout').findIOSCheckout();
  if (!fs.existsSync(ios)) return;

  const src = read(ios, 'Sara', 'SaraControlsView.swift');
  const code = src.split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');
  assert.match(src, /SaraControlsView/, 'could not read SaraControlsView.swift');  // positive control

  assert.ok(!/\.orange/.test(code), 'a raw orange is back on iOS');
  assert.ok(!/AnyShapeStyle\(\.tint\)|foregroundStyle\(\.tint\)/.test(code),
            'the system tint is back on iOS');

  assert.match(code, /palette\.danger/, 'nothing on this screen is a fault any more');
  assert.match(code, /palette\.gap/, 'nothing on this screen is a gap any more');

  // ⚠ The one that matters: suppressed means she is doing as she was told.
  const suppressed = code.split('\n')
    .findIndex((l) => l.includes('Ritual nudges: suppressed'));
  assert.ok(suppressed > 0, 'the suppression line is gone');
  assert.match(code.split('\n').slice(suppressed, suppressed + 3).join('\n'),
               /foregroundStyle\(\.secondary\)/,
               'an instruction being obeyed is painted as a warning again');
});
