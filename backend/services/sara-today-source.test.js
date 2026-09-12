'use strict';

/**
 * What SARA's Today and Review screens must keep doing.
 *
 * These views are mounted by the phone, the laptop (Electron loads the phone
 * build) and the Pi kiosk, and `sara/app` has no runner that reaches them from
 * here — so the rules are pinned as source scans, each with a positive control,
 * because there is no runtime assertion that can see an empty-state line that
 * was quietly added or a refusal branch that was quietly removed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'views');
const today = fs.readFileSync(path.join(VIEWS, 'Today.jsx'), 'utf8');
const review = fs.readFileSync(path.join(VIEWS, 'Review.jsx'), 'utf8');

const TODAY_MARKER = '// ── Sections added for parity';
const REVIEW_MARKER = '// ── Setting the weekly target';

function sliceFrom(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `marker missing: ${marker}`);
  return src.slice(at);
}

function between(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `start missing: ${start}`);
  const b = src.indexOf(end, a + start.length);
  return src.slice(a, b < 0 ? undefined : b);
}

const todaySections = sliceFrom(today, TODAY_MARKER);
const reviewSetter = sliceFrom(review, REVIEW_MARKER);

test('positive control: these are the Today and Review views', () => {
  assert.match(today, /export default function Today/);
  assert.match(review, /export default function Review/);
  // The existing momentum card really does use the word this file bans from the
  // new sections — proof the ban below is scoped, not vacuous.
  assert.match(today, /today__streak/);
});

test('Today mounts all three new sections', () => {
  assert.match(today, /<InitiationSection signals=\{signals\}/);
  assert.match(today, /<FrictionSection /);
  assert.match(today, /<HealthChangedSection /);
});

test('initiation signals ride on /api/adhd rather than a second fetch', () => {
  assert.match(today, /apiFetch\('\/api\/adhd'\)/);
  assert.match(today, /quickWins, signals \} = data/);
  assert.doesNotMatch(todaySections, /\/api\/session\/signals/, 'no second round trip for what /api/adhd carries');
});

test('friction and health read their routes, and health can be acked and un-acked', () => {
  assert.match(todaySections, /readJson\('\/api\/friction'\)/);
  assert.match(todaySections, /readJson\('\/api\/health\/signals'\)/);
  assert.match(todaySections, /\/api\/health\/signals\/\$\{encodeURIComponent\(finding\.id\)\}\/ack/);
  assert.match(todaySections, /read \? 'POST' : 'DELETE'/);
  // The read-but-still-true list, with its way back.
  assert.match(todaySections, /acknowledged/);
  assert.match(todaySections, /Bring it back/);
  // The caveat travels with the finding.
  assert.match(todaySections, /f\.caveat/);
});

test('the kiosk refusal renders as a decision about the screen, not an error', () => {
  assert.match(todaySections, /reason === 'not-a-door'/);
  assert.match(todaySections, /r\.status === 403/);
  const health = between(todaySections, 'function HealthChangedSection', '\n}\n');
  assert.match(health, /isNotADoor\(r\)/);
  assert.match(health, /Not shown on this screen/);
  // The not-here branch must come before the error branch and must not reuse it.
  const notHere = health.indexOf('if (notHere)');
  const errored = health.indexOf('if (error)');
  assert.ok(notHere > 0 && errored > notHere, 'not-a-door is handled before, and apart from, a failure');
  const notHereBranch = health.slice(notHere, errored);
  assert.doesNotMatch(notHereBranch, /Couldn|error|nothing (has )?changed|Nothing stood out/i);
});

test('friction with no evidence renders nothing — no consolation line', () => {
  const friction = between(todaySections, 'function FrictionSection', '\n}\n');
  assert.match(friction, /if \(insights\.length === 0 && gaps\.length === 0\) return null;/);
  assert.doesNotMatch(friction, /Nothing recorded|nothing (is |has )?in your way\.|all clear|you're doing|well done|no friction/i);
});

test('unreadable is a named gap, never a zero', () => {
  assert.match(todaySections, /this is not a count of zero/);
  assert.match(todaySections, /not the same as nothing being in your way/);
  assert.match(todaySections, /not the same as nothing having changed/);
});

test('no scores, streaks or percentages in the new sections', () => {
  for (const [name, src] of [['Today sections', todaySections], ['Review setter', reviewSetter]]) {
    assert.doesNotMatch(src, /streak/i, `${name}: no streaks`);
    assert.doesNotMatch(src, /score/i, `${name}: no scores`);
    assert.doesNotMatch(src, /%/, `${name}: no percentages`);
    assert.doesNotMatch(src, /percent/i, `${name}: no percentages`);
  }
});

test('Review sets the weekly target on a press, never automatically', () => {
  assert.match(review, /<WeeklyTargetSetter /);
  assert.match(reviewSetter, /readJson\('\/api\/weekly-target'\)/);
  assert.match(reviewSetter, /method: 'POST'/);
  // The proposal only fills the box; the POST lives in submit and nowhere else.
  assert.equal(reviewSetter.split("method: 'POST'").length - 1, 1, 'exactly one POST, behind the Set press');
  assert.match(reviewSetter, /onSubmit=\{submit\}/);
  assert.match(reviewSetter, /setValue\(String\(suggestion\.value\)\)/);
  assert.match(reviewSetter, /suggestion\.basis/);
  // Unset is not zero, and a set target is not asked for again.
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

// ── Both estimate exclusions are said, not just one ──────────────────────────
//
// `initiation-signals` returns `assumedExcluded` AND `lateExcluded` on both its
// branches. Today rendered only the first, so the line claimed "across N
// sessions you set" while silently dropping the ones he DID set more than
// ESTIMATE_GRACE_MINUTES in — the exclusion most likely to make him doubt the
// number, because he remembers setting those. The comment above it even said
// "the exclusion is said", singular, while only one of the two was.

test('Today names BOTH estimate exclusions', () => {
  assert.match(today, /estimates\.assumedExcluded/,
    'positive control: the assumed exclusion must still be rendered');
  assert.match(today, /estimates\.lateExcluded/,
    'the late exclusion is unreported again — "N sessions you set" is then not the whole set');
});

test('a late estimate is not phrased as a failure', () => {
  // ⚠ It is not one. A number given partway through already knows part of the
  // answer, so it runs the clock without counting as a forecast — the same
  // words the session card uses. `initiation-signals` is pinned against
  // scoring language and this line must not reintroduce it.
  const line = today.match(/lateExcluded[^`]*`([^`]*)`/);
  assert.ok(line, 'positive control: the late-exclusion sentence must be findable');
  for (const banned of ['failed', 'failure', 'too late', 'missed', 'wrong']) {
    assert.ok(!line[1].toLowerCase().includes(banned),
      `the late-exclusion line calls it "${banned}" — it is a measurement, not a mark against him`);
  }
});
