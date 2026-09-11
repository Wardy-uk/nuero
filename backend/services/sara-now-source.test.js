'use strict';

/**
 * What SARA's Now screen must keep doing with focus sessions.
 *
 * `sara/app/src/views/Now.jsx` is mounted by the phone, the laptop (Electron loads the
 * phone build) and the Pi kiosk, and none of those has a test runner of its own. Every
 * rule below regresses silently: a Start button that fills in a length Nick never gave,
 * a return prompt that stops rendering, a close-out that is thrown away. None of them
 * throws — each just quietly says less, or says something untrue.
 *
 * Source scans, with a positive control, because there is no runtime assertion that can
 * see the absence of a call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NOW = path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'views', 'Now.jsx');
const src = fs.readFileSync(NOW, 'utf8');

/** The body of one top-level function in the file, up to the next top-level function. */
function body(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in Now.jsx`);
  const next = src.indexOf('\nfunction ', start + 1);
  const nextExport = src.indexOf('\nexport default function ', start + 1);
  const ends = [next, nextExport].filter((i) => i > start);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('positive control: this is the SARA Now screen, and it already runs sessions', () => {
  assert.match(src, /export default function Now/);
  assert.match(src, /api\/session\/shrink/, 'the existing shrink control is the anchor');
});

test('a session can be started, paused and resumed from Now', () => {
  assert.match(src, /'\/api\/session\/start'/);
  assert.match(src, /'\/api\/session\/pause'/);
  assert.match(src, /'\/api\/session\/resume'/);
  // The live read is where the recovery prompt and the "is anything running" answer
  // come from — the cached snapshot carries neither.
  assert.match(src, /apiFetch\('\/api\/session'\)/);
});

test('the return prompt is rendered from the server, with make-it-smaller first', () => {
  assert.match(src, /live\.data\?\.recovery/, 'recovery must be read off GET /api/session');
  assert.match(src, /<ReturnCard\b/, 'the return prompt must actually be mounted');

  const card = body('ReturnCard');
  assert.match(card, /recovery\.prompt/, 'the prompt is the server\'s words, not a rephrasing');
  // "Make it smaller" must be the first action button in the default row.
  const row = card.slice(card.lastIndexOf('<div className="now__sess-acts">'));
  const firstButton = row.indexOf('<button');
  assert.ok(firstButton >= 0);
  assert.match(row.slice(firstButton, firstButton + 300), /Make it smaller/, 'shrinking leads every return prompt');
});

test('the close-out is shown verbatim from the finish response', () => {
  assert.match(src, /api\/session\/finish/);
  assert.match(src, /closeout\?\.say/, 'the server-composed line must be read, not recomposed');
  assert.match(src, /closeout\.say/, 'and rendered');
});

test('no length is sent when none was chosen', () => {
  const start = body('StartCard');
  // Positive control on the scan itself: the start call is in this function.
  assert.match(start, /sessionPost\('\/api\/session\/start', body\)/);
  // The only way `minutes` reaches the body is behind the guard.
  assert.match(start, /if \(minutes != null\) body\.minutes = minutes;/);
  assert.doesNotMatch(start, /minutes:\s*minutes/, 'minutes must never be put into the body unconditionally');
  assert.doesNotMatch(start, /\{[^}]*\bminutes\b[^}]*\}\s*;?\s*\n\s*if \(minutes/, 'the body literal must not already carry minutes');
  // The default is "not saying", never a number dressed up as his choice.
  assert.match(start, /useState\(null\);\s*\n\s*const \[busy/);
  // A restart from the return prompt is not a new statement about length either.
  const card = body('ReturnCard');
  assert.doesNotMatch(card, /\bminutes\b\s*:/, 'the return prompt must not send a length');
});

test('a running session is named and replaced only on an explicit force', () => {
  const start = body('StartCard');
  assert.match(start, /409/, 'the conflict must be recognised');
  assert.match(start, /if \(force\) body\.force = true;/, 'force is sent only when asked');
  assert.match(start, /begin\(true\)/, 'and only from the explicit switch button');
  assert.match(start, /begin\(false\)/);
});
