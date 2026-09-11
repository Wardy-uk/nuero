'use strict';

/**
 * SARA's presence: colour carries her state, visibility does not.
 *
 * Nick, 6 Sep 2026: "she should always be visible — it should be the colour of
 * her presence that changes, not the visibility." The iOS app (Wardy-uk/nuero-ios,
 * `NeuroKit/FieldDrive.swift`) pins that with 151 tests; the web Field had the
 * same change written on 6 Sep and NOTHING pinning it, and it sat off `main`
 * for five days while the laptop's Electron window, the phone PWA and the Pi
 * kiosk went on fading her out (quiet 0.78, blind 0.9) in one fixed blue. These
 * mirror the Swift suite's assertions, plus a source scan so a pure module
 * nothing renders cannot pass for a shipped one.
 *
 * `sara/shared-ui` is ESM and this suite is CommonJS, so the module is pulled in
 * with a dynamic import (the vault-browser-health pattern).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SHARED = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui');
const MODULE_URL = pathToFileURL(path.join(SHARED, 'fieldDrive.mjs')).href;

let m;
test.before(async () => { m = await import(MODULE_URL); });

const quietDay = { degraded: false, confidenceLevel: 'high', quiet: true, activity: 'in-meeting', pressing: false };

test('⚠ presence is CONSTANT — no state fades her out', () => {
  const states = [
    { degraded: true },
    quietDay,
    { ...quietDay, pressing: true },
    { confidenceLevel: 'low' },
    { confidenceLevel: 'high' },
    { confidenceLevel: 'moderate', activity: 'firefighting' },
    { confidenceLevel: 'high', pressing: true },
  ];
  for (const s of states) assert.equal(m.drive(s).dim, 1, JSON.stringify(s));
});

test('⚠ blind is GREY and never settles — an outage must not share quiet\'s blue', () => {
  const d = m.drive({ degraded: true, pressing: true });
  assert.equal(d.unresolved, true);
  assert.equal(d.depth, 0);
  assert.equal(d.period, 0);
  assert.equal(d.pulse, 0, 'blind never pulses — she cannot know whether anything is pressing');
  assert.deepEqual(m.colour(d.intensity, d.unresolved), m.UNRESOLVED);
  assert.notDeepEqual(m.colour(m.drive(quietDay).intensity), m.UNRESOLVED);
});

test('quiet is blue and low, but still breathes red for something pressing', () => {
  const q = m.drive(quietDay);
  assert.ok(q.intensity < 0.2);
  const c = m.colour(q.intensity, q.unresolved);
  assert.ok(c[2] > c[0], 'quiet must read blue');
  assert.equal(q.depth, 0.35);
  assert.equal(q.period, 16);

  const qp = m.drive({ ...quietDay, pressing: true });
  assert.equal(qp.intensity, 1, 'quiet means she will not speak, never that she may hide an escalation');
  assert.equal(qp.pulse, m.PULSE_AMP);
});

test('confidence sets settle depth and a warmer hue; the low floor stays legible', () => {
  const depth = (lvl) => m.drive({ confidenceLevel: lvl }).depth;
  assert.equal(depth('high'), 1);
  assert.equal(depth('moderate'), 0.7);
  assert.equal(depth('low'), 0.45);
  assert.equal(depth(undefined), 0.45);
  assert.ok(m.drive({ confidenceLevel: 'high' }).intensity > m.drive({ confidenceLevel: 'low' }).intensity);
});

test('pressing is the top of the ramp, and is never averaged down by a weak read', () => {
  assert.equal(m.drive({ confidenceLevel: 'low', pressing: true }).intensity, 1);
  assert.deepEqual(m.colour(1), m.HOT);
});

test('firefighting sits high without being maximal, and does not also shorten the settle', () => {
  const fire = m.drive({ confidenceLevel: 'high', activity: 'firefighting' });
  const calm = m.drive({ confidenceLevel: 'high', activity: 'steady' });
  assert.equal(fire.intensity, 0.75);
  assert.equal(fire.period, calm.period);
  assert.equal(m.drive({ activity: 'pre-meeting' }).period, 7);
});

test('the ramp: exact blue, orange and red stops, and orange really is the middle', () => {
  assert.deepEqual(m.colour(0), m.COLD);
  assert.deepEqual(m.colour(0.5), m.MID);
  assert.deepEqual(m.colour(1), m.HOT);
  assert.deepEqual(m.colour(-3), m.COLD, 'clamped');
  assert.deepEqual(m.colour(9), m.HOT, 'clamped');
  assert.deepEqual(m.colour(NaN), m.COLD, 'a bad value cannot leave the stops');
  const mid = m.colour(0.5);
  assert.ok(mid[0] > mid[1] && mid[1] > mid[2], 'orange, not a muddy purple');
});

test('nodes sit slightly lighter than their edges, capped at full scale', () => {
  const n = m.nodeColour(m.HOT);
  assert.ok(n[1] > m.HOT[1]);
  assert.ok(n.every((c) => c <= 255));
});

test('⚠ Field.jsx actually DRAWS with it — no hardcoded blue, no local fading drive', () => {
  const src = fs.readFileSync(path.join(SHARED, 'Field.jsx'), 'utf8');
  // positive control: the file we think we are scanning
  assert.match(src, /export default function Field\(/);
  assert.match(src, /from '\.\/fieldDrive\.mjs'/);
  assert.match(src, /colour\(d0\.intensity, d0\.unresolved\)/);
  assert.doesNotMatch(src, /rgba\(120,170,235/, 'the fixed blue edge colour is back');
  assert.doesNotMatch(src, /rgba\(150,190,240/, 'the fixed blue node colour is back');
  assert.doesNotMatch(src, /function drive\(/, 'a second, local drive() would be free to fade her again');
});

test('⚠ the resting substrate is drawn bright enough to SEE on the desk screen', () => {
  // 0.14 / 0.03 were rendered side by side with these in the laptop's Electron
  // window on 11 Sep 2026 and blind/steady were close to black. Colour carries
  // her state now, so a faint substrate hides the state as well as her.
  const src = fs.readFileSync(path.join(SHARED, 'Field.jsx'), 'utf8');
  const num = (name) => Number((src.match(new RegExp('const ' + name + ' = ([0-9.]+)')) || [])[1]);
  assert.ok(num('NODE_REST_ALPHA') >= 0.42, 'node rest alpha lowered again');
  assert.ok(num('EDGE_REST_ALPHA') >= 0.24, 'edge rest alpha lowered again');
});
