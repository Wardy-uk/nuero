'use strict';

/**
 * SARA screens that must keep telling the truth about three things.
 *
 *   Controls              — what SARA has quietened, and the way to turn it back on.
 *                           A mute nobody can see is a feature switched off unseen.
 *   MeetingPrep           — who is OFF, and where leave could not be checked. An
 *                           absent flag must never read as "they will be in".
 *   NotificationActionCard — no navigation to a 'brain' tab. It was removed on
 *                           31 Aug 2026 and the tap silently landed on the Surface.
 *
 * Source scans with positive controls: none of these regressions throws, so there is
 * no runtime assertion that can see them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'sara', 'app', 'src');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const controls = read('views/Controls.jsx');
const prep = read('views/MeetingPrep.jsx');
const card = read('components/NotificationActionCard.jsx');

test('positive control: these are the screens under test', () => {
  assert.match(controls, /export default function Controls/);
  assert.match(prep, /export default function MeetingPrep/);
  assert.match(card, /export default function NotificationActionCard/);
  // The notification-test work from earlier the same day survives.
  assert.match(controls, /pushUnsupportedReason/);
  assert.match(controls, /\/api\/push\/test/);
});

test('Controls lists muted prompts and can turn one back on', () => {
  assert.match(controls, /apiFetch\('\/api\/attention\/muted'\)/, 'the muted list must be read');
  assert.match(controls, /\/api\/attention\/muted\/\$\{encodeURIComponent\(kind\)\}/, 'unmute must target one kind');
  assert.match(controls, /method: 'DELETE'/);
  // "I couldn't look" and "nothing is muted" are different facts and both must render.
  assert.match(controls, /mutedError/);
  assert.match(controls, /Nothing is muted/);
});

test('MeetingPrep shows who is off, and says where leave could not be checked', () => {
  assert.match(prep, /a\.away\b/, 'booked leave must render per attendee');
  assert.match(prep, /a\.awayUnknown\b/, 'an unchecked attendee must be named as unchecked');
  assert.match(prep, /someoneAway/);
  assert.match(prep, /leave not checked/);
});

test('the notification card never navigates to the retired Brain tab', () => {
  assert.doesNotMatch(card, /onNavigate\(\s*['"]brain['"]\s*\)/, 'there is no brain tab to land on');
  assert.match(card, /NEURO → Brain Health/, 'it must say where vault maintenance lives');
  // Positive control that the scan can see navigation at all.
  assert.match(card, /onNavigate\(\s*'capture'\s*\)/);
});

test('a closed kiosk door reads as not available here, never as an error', () => {
  assert.match(card, /not-a-door/);
  assert.match(card, /closed: true/);
  // Journal is still supported where the door is open (the phone).
  assert.match(card, /\/api\/journal\/prompts/);
  assert.match(card, /\/api\/journal\/save/);
});
