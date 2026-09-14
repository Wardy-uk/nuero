'use strict';

/**
 * Capture, lit — step 4 of the design build order.
 *
 * ⚠⚠ THE FINDING: THE MOST IMPORTANT MESSAGE THIS APP EVER SHOWS WAS CARRIED BY
 * TEXT COLOUR ALONE. "NOT saved — your words are still here; don't close the
 * app" sat in the same box, with the same border and no mark, as "Saved to
 * NEURO." — a slightly redder shade of the same thing. On BOTH surfaces.
 *
 * That sentence is the one the whole capture path exists to be able to say. The
 * contract is explicit that a failed capture LEAVES THE WORDS IN THE BOX,
 * because clearing them destroys the last copy — and a warning nobody notices
 * is the same outcome by a slower route.
 *
 * Three channels now, not one: a mark, a border and the weight. Colour alone
 * fails on a phone in sunlight and for anyone who cannot separate the hues —
 * the same reason iOS's queued-vs-lost task note gained an icon the day before.
 *
 * Source scans with positive controls; the primitive has a real render in
 * `lit-primitives.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.resolve(__dirname, '..', '..', 'sara', 'app', 'src', 'views');
const jsx = () => fs.readFileSync(path.join(VIEWS, 'Capture.jsx'), 'utf8');
const css = () => fs.readFileSync(path.join(VIEWS, 'Capture.css'), 'utf8');
// ⚠ A name inside a comment is not a use — fifth time.
const cssCode = () => css().replace(/\/\*[\s\S]*?\*\//g, '');

test('⚠ a failed capture is not a differently-coloured success', () => {
  const src = jsx();
  assert.match(src, /cap__flash/, 'could not read Capture.jsx');   // positive control

  // It was `className={`cap__flash${flash.ok ? '' : ' err'}`}` and `.err` sets
  // a text colour and nothing else.
  assert.match(src, /cap__flash--fault/, 'the failure has no shape of its own');
  assert.match(src, /cap__flash-mark/, 'the failure carries no mark');
  assert.match(src, /role=\{flash\.ok \? undefined : 'alert'\}/,
               'a lost capture must be announced, not only drawn');

  const sheet = cssCode();
  // Border AND ground AND weight — three channels, so none of them is load-bearing alone.
  const fault = sheet.match(/\.cap__flash--fault\s*\{([^}]*)\}/s);
  assert.ok(fault, 'the fault treatment is gone');
  assert.match(fault[1], /border-color:/);
  assert.match(fault[1], /background:/);
  assert.match(fault[1], /font-weight:/);
});

test('⚠ ONE red for one meaning', () => {
  const sheet = cssCode();
  // The stuck-item border was rgba(200, 70, 70, 0.45) while the primitive's
  // fault red is rgba(224, 84, 58) — two reds for one claim, on one screen.
  assert.ok(!/200,\s*70,\s*70/.test(sheet), 'a second red is back');
  const reds = sheet.match(/224,\s*84,\s*58/g) || [];
  assert.ok(reds.length >= 2, 'the stuck item and the flash must share the one red');
});

test('⚠ queued is a STATEMENT — the offline path working', () => {
  const src = jsx();
  // "Queued on this device — not in NEURO yet" means the words are safe and on
  // their way. Rendering it like the refusal beneath it is the conflation that
  // was fixed on iOS's task note: a queued capture and a lost one must not look
  // alike, because they call for opposite actions.
  assert.match(src, /<Lit tone="statement" className="cap__q"/);
  // And the refusal is the one fault treatment in the queue.
  assert.match(src, /<Lit className="cap__q cap__q--stuck"/);
});

test('⚠ no screen-local palette', () => {
  assert.match(css(), /\.cap__flash\b/, 'could not read Capture.css');   // positive control
  const sheet = cssCode();
  assert.ok(sheet.length < css().length, 'comment stripping removed nothing');
  const accents = sheet.match(/var\(--accent[^)]*\)/g) || [];
  assert.deepEqual(accents, [], `Capture.css still picks the system accent: ${accents.join(', ')}`);
  assert.match(sheet, /var\(--sara-rgb/);
});

test('⚠ the section labels are shared, and nothing overrides their colour', () => {
  const src = jsx();
  const sheet = cssCode();
  assert.match(src, /<LitLabel className="cap__queue-h">/);
  assert.match(src, /<LitLabel className="cap__recent-h">/);

  // ⚠ THE CASCADE IS THE TRAP. Capture.css is imported AFTER Lit.css, so a
  // `color:` left on either label's own rule wins and keeps it grey while every
  // other section label in the app moves with her. Caught by reading the
  // stylesheet, not by the build — it compiles perfectly either way.
  for (const cls of ['cap__queue-h', 'cap__recent-h']) {
    const rule = sheet.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`, 's'));
    assert.ok(rule, `${cls} rule is gone`);
    assert.ok(!/(^|;|\s)color:/.test(rule[1]), `${cls} overrides the shared label colour`);
  }
});

test('⚠ the words still survive a failure to store them', () => {
  const src = jsx();
  // The rule this whole screen exists for, and none of the lighting above may
  // touch it: when local persistence fails the draft is the ONLY copy, so it is
  // not cleared and the message says so.
  assert.match(src, /\/\/ Local persistence failed\. The draft is the ONLY copy/);
  assert.match(src, /Your words are still here; don.t close the app/);
  // ⚠ NO FAILURE PATH CLEARS THE BOX. Asserted over every `catch` rather than
  // by position: the first draft of this test compared the offsets of the first
  // `setText('')` and the first `await enqueue(`, and failed on the FEATURE
  // path, which is a direct write that correctly clears only after a successful
  // response. The test was wrong, not the screen — and an ordering check that
  // depends on which branch happens to come first in the file is a check that
  // will be wrong again the next time a branch moves.
  // ⚠ BRACE-MATCHED, not "up to the next `\n    }`". That shortcut overshot on
  // a single-line `catch { /* … */ }` and swallowed the rest of the file, so the
  // test reported a failure path clearing the box when the block it had read
  // was most of the component. A scan is only as honest as its parser.
  const catches = [];
  for (const m of src.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    catches.push(src.slice(m.index + m[0].length, i - 1));
  }
  assert.ok(catches.length >= 2, 'could not find the failure paths');   // positive control
  for (const block of catches) {
    assert.ok(!/setText\(''\)/.test(block), 'a failure path clears the box');
    assert.ok(!/setTitle\(''\)/.test(block), 'a failure path clears the title');
  }

  // ⚠ And every failure says NOT saved, in those letters. The emphasis is the
  // point: one of four saying it quietly is the one that gets missed.
  const quiet = src.match(/ok: false, msg: `Not saved/g) || [];
  assert.deepEqual(quiet, [], 'a failure understates itself');
});
