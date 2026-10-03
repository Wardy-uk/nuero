'use strict';

/**
 * What SAiM's Review screen must keep doing.
 *
 * Split out of `saim-today-source.test.js` when SAiM's Today and Focus tabs
 * were retired (Build 10E): Review stays, so its rules stay pinned. Source
 * scans with a positive control, because `saim/app` has no runner reachable
 * from here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'saim', 'app', 'src', 'views');
const review = fs.readFileSync(path.join(VIEWS, 'Review.jsx'), 'utf8');

const REVIEW_MARKER = '// ── Setting the weekly target';

function sliceFrom(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `marker missing: ${marker}`);
  return src.slice(at);
}

const reviewSetter = sliceFrom(review, REVIEW_MARKER);

test('positive control: this is the Review view', () => {
  assert.match(review, /export default function Review/);
});

test('no scores, streaks or percentages in the weekly-target setter', () => {
  assert.doesNotMatch(reviewSetter, /streak/i);
  assert.doesNotMatch(reviewSetter, /score/i);
  assert.doesNotMatch(reviewSetter, /%/);
  assert.doesNotMatch(reviewSetter, /percent/i);
});

test('Review sets the weekly target on a press, never automatically', () => {
  assert.match(review, /<WeeklyTargetSetter /);
  assert.match(reviewSetter, /readJson\('\/api\/weekly-target'\)/);
  assert.match(reviewSetter, /method: 'POST'/);
  assert.equal(reviewSetter.split("method: 'POST'").length - 1, 1, 'exactly one POST, behind the Set press');
  assert.match(reviewSetter, /onSubmit=\{submit\}/);
  assert.match(reviewSetter, /setValue\(String\(suggestion\.value\)\)/);
  assert.match(reviewSetter, /suggestion\.basis/);
  assert.match(reviewSetter, /not a target of zero/);
  assert.match(reviewSetter, /if \(isSet && !editing\)/);
  assert.match(reviewSetter, /reason === 'not-a-door'/);
});

test('the device section is device-neutral and keeps its facts', () => {
  const device = sliceFrom(review, 'This device');
  assert.doesNotMatch(device, /\biOS\b|iPhone/);
  assert.doesNotMatch(review, /still on this phone/);
  assert.match(device, /not encrypted/);
  assert.match(device, /on this device only/);
  assert.match(device, /may clear it/);
});
