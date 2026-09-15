'use strict';

/**
 * THE SAME VOCABULARY, ON THE OTHER SIDE OF THE FENCE.
 *
 * ⚠⚠ THE WEB SWEEP FOUND EIGHT AMBERS AND THIRTEEN REDS; THE iOS ONE FOUND 24
 * RAW SYSTEM COLOURS across nine files — and by the vocabulary they were four
 * different claims, exactly as Controls had been in miniature:
 *
 *   "couldn't read it", "showing the last good read", "I can't see the house"
 *                                                     → GAP
 *   "couldn't note that", "I can't reach the brain",
 *   "NEURO returned nothing readable", a mic that refused,
 *   captures that never landed                        → FAULT
 *   a focus session RUNNING                           → statement
 *   "in 9 min" on the next meeting                    → a duration
 *
 * The last two are the ones worth remembering. A session running is the most
 * ordinary state that screen has, and it was painted as a warning; and amber on
 * every countdown made each next meeting look like a problem.
 *
 * ⚠ SAiM-ONLY SCREENS TAKE `Palette.saim.*`, THE STATIC. They are never hosted
 * by NEURO, and a static needs no `@Environment` declaration — which matters
 * because there is no Swift toolchain on this machine to catch a missing one.
 * The two NeuroKit views that render in BOTH apps take the ENVIRONMENT instead,
 * because hard-coding either app's palette makes one of them look borrowed.
 *
 * ⚠ Cross-repo, so it SKIPS where the sibling checkout is absent rather than
 * failing on a machine that simply does not have it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const IOS = path.resolve(__dirname, '..', '..', '..', 'nuero-ios');
const present = () => fs.existsSync(IOS);

/** Every Swift file under the SAiM app, its widgets and the shared kit. */
function swiftFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.swift')) out.push(p);
    }
  };
  ['Saim', 'SaimWidgets', 'SaimWatchComplication',
   path.join('NeuroKit', 'Sources', 'NeuroKit')].forEach((d) => walk(path.join(IOS, d)));
  return out;
}

/** ⚠ A name inside a comment is not a use — every scan here strips first. */
const strip = (t) => t.split('\n')
  .map((l) => (l.trim().startsWith('//') ? '' : l))
  .join('\n');

test('⚠⚠ no screen paints a state in a raw system colour', () => {
  if (!present()) return;
  const files = swiftFiles();
  assert.ok(files.length > 20, `only found ${files.length} Swift files`);  // positive control

  const offenders = [];
  for (const file of files) {
    const body = strip(fs.readFileSync(file, 'utf8'));
    for (const m of body.matchAll(/foregroundStyle\(\.(orange|red)\)|\.background\(\.(orange|red)/g)) {
      offenders.push(`${path.basename(file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'A raw system colour is a state wearing a token that means nothing here.\n' +
    'Use palette.gap (unread), palette.danger (broken) or .secondary (a fact):\n' +
    `  ${offenders.join('\n  ')}`);
});

test('⚠ a running session is a fact, not a warning', () => {
  if (!present()) return;
  const src = fs.readFileSync(path.join(IOS, 'Saim', 'AttentionSurfaceView.swift'), 'utf8');
  assert.match(src, /summaryLine\(\)/, 'could not read AttentionSurfaceView');  // positive control

  const lines = strip(src).split('\n');
  const i = lines.findIndex((l) => l.includes('session.summaryLine()'));
  assert.ok(i > 0, 'the session line is gone');
  // ⚠ A window of SIX with the blanks dropped: stripping comments leaves empty
  // lines behind, so a three-line window lands on the gap where this rule's own
  // explanation used to be — the scan tripping over its own documentation, one
  // more time.
  const near = lines.slice(i, i + 6).filter((l) => l.trim()).join('\n');
  assert.match(near, /foregroundStyle\(\.secondary\)/,
               'the most ordinary state that screen has is painted as a warning again');
});

test('⚠ a countdown is a duration, and its row carries the urgency', () => {
  if (!present()) return;
  const src = strip(fs.readFileSync(path.join(IOS, 'Saim', 'DashboardView.swift'), 'utf8'));
  assert.match(src, /row\.countdown/, 'could not read DashboardView');   // positive control
  assert.ok(!/foregroundStyle\(Palette\.saim\.gap\)[\s\S]{0,80}row\.when/.test(src),
            'the countdown is amber again — every next meeting looks like a problem');
});

test('⚠ a view that renders in BOTH apps asks its host', () => {
  if (!present()) return;
  // Hard-coding either palette makes one of the two apps look borrowed — and
  // `Palette.saim.*` inside NeuroKit would put her material on NEURO's desk.
  const shared = path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit');
  const offenders = [];
  for (const file of swiftFiles().filter((f) => f.startsWith(shared))) {
    const body = strip(fs.readFileSync(file, 'utf8'));
    if (/Palette\.saim\b|Palette\.neuro\b/.test(body)) offenders.push(path.basename(file));
  }
  assert.deepEqual(offenders, [],
    `a shared view picked a palette instead of asking its host: ${offenders.join(', ')}`);

  // And the one that needed it gained the declaration rather than a static.
  const weather = fs.readFileSync(path.join(shared, 'WeatherView.swift'), 'utf8');
  assert.match(weather, /@Environment\(\\\.palette\) private var palette/);
  assert.match(weather, /foregroundStyle\(palette\.gap\)/);
});

test('⚠ a widget takes the static, because it cannot read an environment', () => {
  if (!present()) return;
  // Widgets render outside the app's view tree, so there is no host to ask.
  const w = fs.readFileSync(path.join(IOS, 'SaimWidgets', 'SaimWidgets.swift'), 'utf8');
  assert.match(w, /Palette\.saim\.gap/,
               'the lock-screen widget mixes its own amber again');
});
