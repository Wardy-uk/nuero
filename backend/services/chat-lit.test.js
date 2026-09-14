'use strict';

/**
 * SARA's Chat, against the rules — step 9 of the design build order.
 *
 * ⚠⚠ THE FINDING IS A PAYLOAD FIELD WITH NO READER, and it is the fifth this
 * week. `_toolsAvailable()` has been computed on BOTH chat paths since tools
 * shipped, has shaped the system prompt every turn, and was RETURNED TO NOBODY.
 * So the one screen where the tools actually live could not say when she has no
 * hands — while the standup, which has fewer of them, has shown a banner saying
 * exactly that since the session shipped.
 *
 * There is no error, no empty screen and nothing to fail: she simply answers
 * without mentioning that the task he just asked for was never created. The
 * `mode` chip beside it says "local", which is a fact about a SETTING and
 * teaches nobody that she cannot act.
 *
 * ⚠ AND A DEAD PI WAS WEARING HER VOICE. "Couldn't reach the brain" was pushed
 * into an ASSISTANT bubble — on the one screen that IS a conversation, so a
 * transport failure rendered as something she said, in her colour, in the
 * thread, scrolled back through later as though it were an answer. iOS had
 * already got this right (`.failed` is its own role); the PWA had not.
 *
 * ⚠ AND LISTENING LOOKED LIKE BREAKING. A live mic wore the app's alarm red and
 * pulsed — so the most ordinary thing this screen does read as a fault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'sara', 'app', 'src');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const jsx = () => read(APP, 'views', 'Chat.jsx');
const css = () => read(APP, 'views', 'Chat.css');
const service = () => read(__dirname, 'claude.js');

/**
 * ⚠ A NAME INSIDE A COMMENT IS NOT A USE. Every scan in this file strips first —
 * the tenth time this repo has learned it, and the edge is sharper each time: a
 * scan that fails on its own documentation gets switched off, and the real catch
 * goes with it.
 */
const strip = (t) => t
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

test('⚠⚠ the brain SAYS whether she can act, on both paths', () => {
  const src = strip(service());
  assert.match(src, /_toolsAvailable/, 'could not read claude.js');   // positive control

  // The stream: it rides the mode event, so no client can get one without the
  // other and render a confident "local" over a turn that silently could not act.
  assert.match(src, /type: 'mode', mode: chatMode, canAct: useTools/,
               'the stream stopped reporting whether she can act');

  // The sync path, both returns — a tool turn demonstrably has hands, and the
  // plain path reports the CAPABILITY rather than whether one loop happened to run.
  assert.match(src, /canAct: true/);
  assert.match(src, /canAct: useTools/);
});

test('⚠ unknown is never an accusation', () => {
  // Three-valued on every surface: absent means a server older than this, which
  // renders nothing. A banner that fires on a missing field is one nobody reads
  // by week two, which costs the real warning too.
  const view = strip(jsx());
  assert.match(view, /canAct === false/,
               'the banner stopped testing for an explicit false');
  assert.ok(!/!canAct|canAct !== true/.test(view),
            'the banner fires on unknown — an old server would accuse her of having no hands');

  const api = strip(read(APP, 'api.js'));
  assert.match(api, /onMode\?\.\(evt\.mode, evt\.canAct\)/,
               'the stream parser stopped passing canAct through');
});

test('⚠ she says it in WORDS, the same words the standup uses', () => {
  assert.match(jsx(), /Running without tools/,
               'the banner is gone — a coloured chip teaches nobody that she cannot act');

  // ⚠ The two screens must not drift into two different claims about one fact.
  assert.match(read(APP, 'views', 'Standup.jsx'), /Running without tools/,
               'could not read Standup.jsx');   // positive control
});

test('⚠⚠ a transport failure is not something she said', () => {
  const view = strip(jsx());
  // It is its own row, outside the thread.
  assert.match(view, /chat__fault/, 'the fault row is gone');
  assert.match(view, /setFault\(/, 'the failure stopped being reported as a fault');

  // And it is never written into a turn.
  assert.ok(!/content: `⚠️ Couldn/.test(view),
            'a transport failure is being rendered as an assistant message again');
  assert.ok(!/appendToLast\(got \? '' :/.test(view),
            'a stream error is being appended to her sentence again');

  // ⚠ And the empty placeholder goes with it — a blank assistant bubble above a
  // fault reads as her having answered with nothing.
  assert.match(view, /dropEmptyTurn/);
});

test('⚠⚠ listening is not a fault, and a missing mic is not one either', () => {
  const sheet = strip(css());
  assert.match(sheet, /\.chat__mic--on/, 'could not read Chat.css');   // positive control

  const micOn = sheet.match(/\.chat__mic--on \{([^}]*)\}/);
  assert.ok(micOn, 'the live-mic rule is gone');
  assert.ok(!/#5a1f1f|#ff8a8a/.test(micOn[1]),
            'a live microphone wears the alarm red again');
  assert.match(micOn[1], /--sara-rgb/, 'she is not the one attending any more');

  // ⚠ "This browser has no speech recognition" was painted AMBER here on step 9
  // and that was wrong: the kiosk and the Electron window both mount this
  // screen, so it would have sat lit for ever over a device working exactly as
  // it always will. It is a STATEMENT — see the vocabulary in Lit.css, and the
  // fuller note in controls-lit.test.js, which is where it was caught.
  assert.ok(!/chat__voice-note--gap/.test(sheet), 'the dead gap style is back');
  assert.ok(!/chat__voice-note--gap/.test(strip(jsx())),
            'the unsupported-mic line is amber again — it would never go out');
  // A mic that was ASKED FOR and failed is still a fault.
  assert.match(strip(jsx()), /chat__voice-note--err/);
});

test('⚠ the light on this screen is hers', () => {
  const sheet = strip(css());
  // His own bubble, the send button and the voice chip — the same call Ritual
  // made, because this screen IS a conversation with her.
  assert.ok(!/var\(--accent\)/.test(sheet),
            'a screen-local accent is back — it does not move when she does');
  assert.match(sheet, /--sara-rgb/);

  // ⚠ And the mode chip is a STATEMENT, not a state: its hand-mixed blue was the
  // only lit-looking thing on the page and meant nothing.
  assert.ok(!/#14324a|#8ad0ff/.test(sheet), 'the mode chip mixed its own blue again');
});

test('⚠ the tools line still says RAN, never done', () => {
  // NEURO reports WHICH tools ran and not whether each one worked. Saying "done"
  // would be a claim about an outcome nothing here measured.
  const view = jsx();
  assert.match(view, />ran</);
  assert.ok(!/>done</.test(strip(view)), 'the tool line claims an outcome again');
});

test('⚠ iOS makes the same distinctions', () => {
  // ⚠ SKIPPED, never failed, where the sibling checkout is absent — a test that
  // fails on a machine without the other repo is one that gets deleted, taking
  // the drift check with it.
  const ios = path.resolve(ROOT, '..', 'nuero-ios');
  if (!fs.existsSync(ios)) return;

  const ask = read(ios, 'Sara', 'AskView.swift');
  const code = strip(ask);
  assert.match(ask, /private var transcript/, 'could not read AskView.swift');  // positive control

  assert.match(ask, /Running without tools/, 'iOS still cannot say when she has no hands');
  assert.match(code, /state\.chatCanAct == false/, 'iOS fires the banner on unknown');
  assert.ok(!/\.orange/.test(code), 'a raw orange is back on iOS');
  assert.ok(!/Color\.accentColor|\.background\(\.tint/.test(code),
            'the system tint is back on iOS');

  // The model has to carry it at all.
  assert.match(read(ios, 'NeuroKit', 'Sources', 'NeuroKit', 'Chat.swift'),
               /public let canAct: Bool\?/,
               'iOS stopped decoding whether she can act');
});
