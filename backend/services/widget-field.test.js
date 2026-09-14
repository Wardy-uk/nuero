'use strict';

/**
 * THE LOCK SCREEN TAKES HER COLOUR — the last item on the design build order.
 *
 * ⚠⚠ THE WIDGET TOOK NO COLOUR AT ALL. It draws the same nebulous field every
 * other SARA surface draws, and hard-coded it `#78aaeb` — so a day with a
 * breaching escalation and a quiet Sunday were THE SAME PICTURE, on the one
 * surface Nick sees without deciding to look at anything. Everywhere else the
 * field is her state channel; here it was decoration.
 *
 * ⚠ THE RAMP IS NOT PORTED INTO THE WIDGET, and that is the point. That file
 * reaches its runtime by being PASTED AS TEXT, so it cannot import anything —
 * a local copy of the drive would be a THIRD implementation of a rule that has
 * already been wrong once when there were two (`fieldDrive.mjs`'s own header
 * records the day the cards and the field disagreed two feet apart on one
 * screen). So the SERVER composes `field` from the web's own module, and the
 * widget reads it.
 *
 * ⚠ `isPressing` moved into `fieldDrive.mjs` for the same reason: it lived in
 * `useFieldDrive.js`, which imports React, so the backend could not read it —
 * and the alternative was a second definition of what makes her press.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const widget = () => fs.readFileSync(
  path.join(ROOT, 'sara', 'widget', 'neuro-attention.js'), 'utf8');

const loadDrive = () => import(
  'file://' + path.join(ROOT, 'sara', 'shared-ui', 'fieldDrive.mjs').replace(/\\/g, '/'));

test('⚠⚠ a quiet Sunday and a red day are different pictures', async () => {
  const fd = await loadDrive();
  const rgbFor = (state) => {
    const d = fd.drive(state);
    return fd.rgbText(fd.colour(d.intensity, d.unresolved));
  };

  const quiet = rgbFor({ activity: 'off', confidenceLevel: 'high', quiet: true });
  const firefighting = rgbFor({ activity: 'firefighting', confidenceLevel: 'high', pressing: true });
  const blind = rgbFor({ degraded: true, confidenceLevel: 'low' });

  assert.notEqual(quiet, firefighting, 'the whole point: these must not be one colour');
  // ⚠ Blind is GREY and never a point on the ramp — a dulled blue would read as
  // a calm afternoon, which is the opposite of "I cannot see your work".
  assert.equal(blind, '150,160,170');
  assert.notEqual(blind, quiet);
});

test('⚠⚠ the widget reads the brain\'s colour and never mixes its own', () => {
  const src = widget();
  assert.match(src, /function fieldDrive/, 'could not read the widget');   // positive control

  // It asks the payload.
  assert.match(src, /d\.field/, 'the widget stopped reading her colour');
  assert.match(src, /hexFromRgbText/);

  // And the two fixed blues are no longer what it paints with.
  assert.match(src, /new Color\(edgeHex,/);
  assert.match(src, /new Color\(nodeHex,/);

  // ⚠ There is no second ramp in here. The blues survive only as the fallback
  // for a server too old to send one, which is why they may still appear.
  assert.ok(!/240,\s*70,\s*60|#f04640/.test(src),
            'the widget has started mixing the ramp itself');
});

test('⚠ a server that does not say leaves the widget exactly as it was', () => {
  // Additive, like every other field on this payload. An older NEURO sends no
  // `field`, and the widget must render as it always did rather than blank.
  const src = widget();
  assert.match(src, /drive\.edge \|\| '#78aaeb'/);
  assert.match(src, /drive\.node \|\| '#96bef0'/);
});

test('⚠⚠ still not one backslash, anywhere', () => {
  // The file reaches Scriptable by being COPIED AS TEXT and a backslash does not
  // survive the trip — `replace(/\/+$/, '')` arrived on the phone as "invalid
  // escape in identifier" and the whole widget refused to parse. The colour work
  // added string handling, which is exactly where one would creep in.
  const src = widget();
  const at = src.indexOf(String.fromCharCode(92));
  assert.equal(at, -1,
    `a backslash at ${at}: ${JSON.stringify(src.slice(Math.max(0, at - 60), at + 40))}`);
});

test('⚠ the server composes it from the web\'s module, not a copy of it', () => {
  const attention = fs.readFileSync(path.join(__dirname, 'attention.js'), 'utf8');
  const code = attention.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => (l.trim().startsWith('//') ? '' : l)).join('\n');

  assert.match(code, /import\('\.\.\/\.\.\/sara\/shared-ui\/fieldDrive\.mjs'\)/,
               'the backend stopped sharing the drive and is deciding for itself');
  assert.match(code, /fd\.rgbText\(fd\.colour\(/);

  // ⚠ Never allowed to fail the feed: null means "render it the way you did
  // before this existed", the same contract `surface` has.
  assert.match(code, /field = null;/);

  // ⚠ `unresolved` travels on its own rather than being inferred from the rgb.
  assert.match(code, /unresolved: d\.unresolved === true/);
});

test('⚠ one definition of "pressing", now that the server needs it too', async () => {
  const fd = await loadDrive();
  assert.equal(typeof fd.isPressing, 'function',
               'the backend cannot read a rule that lives beside a React import');
  assert.equal(fd.isPressing({ kind: 'item', urgency: 'critical' }), true);
  assert.equal(fd.isPressing({ kind: 'context', urgency: 'critical' }), false,
               'a context card is not work pressing on him');
  assert.equal(fd.isPressing(null), false);

  // And the hook re-exports it rather than keeping a second copy.
  const hook = fs.readFileSync(
    path.join(ROOT, 'sara', 'shared-ui', 'useFieldDrive.js'), 'utf8');
  assert.match(hook, /export \{ isPressing \} from '\.\/fieldDrive\.mjs'/);
  assert.ok(!/export function isPressing/.test(hook),
            'a second definition of pressing is back');
});
