'use strict';

/**
 * Does the room-offer block actually RENDER, and does it obey its own rules?
 *
 * `AttentionSurface` is shared by the phone and the Pi kiosk, and neither has a
 * test runner. A vite build proves the JSX compiles; it does not run it, and
 * the three most expensive frontend mistakes in this repo all compile
 * perfectly. So this bundles the real shared component with esbuild and mounts
 * it, the way `desktop-render.test.js` does for the desktop panels.
 *
 * The rule under test is not cosmetic. A surface that cannot reach
 * `/api/rooms` must render an offer as a STATEMENT, never as a button that
 * fails when tapped — the same call the action row already makes, and the same
 * reason the mic is gated on capability rather than on device.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SURFACE = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui', 'AttentionSurface.jsx');

// The field paints to a canvas and knows nothing about offers; stubbing it
// keeps this a test of the surface rather than of a renderer.
const FIELD_STUB = 'export default function Field() { return null; }\nexport const isPressing = () => false;\n';

function stubPlugin() {
  return {
    name: 'stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      build.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: FIELD_STUB, loader: 'js' }));
    },
  };
}

let Surface;

test.before(async () => {
  global.window = global.window || { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  const out = await esbuild.build({
    entryPoints: [SURFACE],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [stubPlugin()],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Surface = mod.exports.default;
  assert.ok(Surface, 'AttentionSurface has a default export');
});

// A minimal but realistic payload. `primary: null` is a legitimate answer the
// surface is built to render, so the room block is not hiding behind a card.
function payload(rooms) {
  return {
    context: { activity: 'steady', known: true },
    primary: null,
    secondary: [],
    dropped: [],
    quiet: false,
    rationale: [],
    poolAvailable: true,
    gaps: [],
    rooms,
  };
}

const OFFERS = {
  known: true,
  room: 'living-room',
  episode: 'living-room@1',
  offers: [
    {
      key: 'room:living-room:lights-on#living-room@1',
      kind: 'lights-on',
      area: 'Living Room',
      act: false,
      subject: 'watch',
      entities: ['light.living_room_2'],
      say: 'Want the living room lights on?',
      why: 'within 15 min of sunset',
    },
  ],
  decided: [],
  gaps: [],
  considered: [],
};

function render(props) {
  return renderToString(React.createElement(Surface, props));
}

test('the surface mounts with a room offer and shows what she is asking', () => {
  const html = render({ data: payload(OFFERS), onRoomAct: () => {} });
  assert.match(html, /Want the living room lights on\?/);
});

test('with a handler, the offer is answerable', () => {
  const html = render({ data: payload(OFFERS), onRoomAct: () => {} });
  assert.match(html, />Yes</);
  assert.match(html, />Not now</);
});

test('⚠ WITHOUT a handler, the offer is a STATEMENT — no button that would fail', () => {
  // The kiosk passed no `onAct` for exactly this reason before it could reach
  // NEURO. A control that answers every press with nothing is worse than none.
  const html = render({ data: payload(OFFERS) });
  assert.match(html, /Want the living room lights on\?/, 'still says what she would do');
  assert.doesNotMatch(html, />Yes</);
  assert.doesNotMatch(html, />Not now</);
});

test('⚠ an unreadable house SAYS so — it is not rendered as a calm room', () => {
  const html = render({ data: payload({ known: false, room: null, offers: [], decided: [], gaps: ['HA unreachable'] }) });
  assert.match(html, /can.{0,8}t see the house/i);
});

test('no offers renders nothing at all, not an empty box', () => {
  const html = render({ data: payload({ known: true, room: 'living-room', offers: [], decided: [], gaps: [] }) });
  assert.doesNotMatch(html, /surface__rooms/);
  assert.doesNotMatch(html, /can.{0,8}t see the house/i);
});

test('a payload with no rooms block at all still renders (older backend)', () => {
  const html = render({ data: payload(undefined) });
  assert.ok(html.length > 0);
  assert.doesNotMatch(html, /surface__rooms/);
});

test('⚠ every offer is rendered — a second one cannot be silently dropped', () => {
  const two = JSON.parse(JSON.stringify(OFFERS));
  two.offers.push({
    key: 'room:living-room:warm-room#living-room@1',
    kind: 'warm-room',
    area: 'Living Room',
    act: true,
    subject: 'watch',
    entities: ['climate.living_room_rad'],
    say: 'The living room is 17.2°C. Warm it up?',
    why: 'below 19°C',
  });
  const html = render({ data: payload(two), onRoomAct: () => {} });
  assert.match(html, /Want the living room lights on\?/);
  assert.match(html, /Warm it up\?/);
});

// ── Open on your desk, on SARA's own surface ─────────────────────────────────
//
// ⚠ This lives on the SHARED surface, so it renders on the phone, the kiosk and
// the desktop Electron window from one file. The kiosk reaches NEURO through an
// ALLOWLIST proxy and `desktop` is deliberately NOT a door — an unauthenticated
// touchscreen in a family room must not be able to start programs on a work
// laptop — so that shell hides the row rather than offering a 403.

// ⚠ THE ROW IS NOW DEVICE-AWARE (13 Sep 2026): what it offers is what the
//   TARGET MACHINE said it can open, composed server-side as `work.deskOffer`.
//   These fixtures therefore carry one — a `work` without it is a machine that
//   has not said, which correctly offers nothing, and is its own test below.
const AT_DESK = { atDesk: true, deskKnown: true, host: 'DESKTOP-8LGF9RR', deskOffer: { known: true, host: 'DESKTOP-8LGF9RR', why: null, apps: [{ id: 'music', label: 'Music' }, { id: 'code', label: 'VS Code' }, { id: 'terminal', label: 'Terminal' }, { id: 'browser', label: 'Browser' }] } };

test('at the laptop, SARA offers what THAT MACHINE said it can open', () => {
  const html = render({ data: { ...payload(null), work: AT_DESK }, onDeskOpen: () => {} });
  for (const l of ['Music', 'VS Code', 'Terminal', 'Browser']) assert.match(html, new RegExp(l));
  // ⚠ IT NAMES THE MACHINE. A press acts on one laptop, and a row reading
  //   "your desk" cannot say which — half the point of device awareness is not
  //   silently opening something on a machine in another room.
  assert.match(html, /DESKTOP-8LGF9RR/);
});

test('⚠ NEGATIVE: only what the machine OFFERED is rendered', () => {
  // The list used to be four hardcoded buttons shown to whatever was
  // listening, so a button could name a program the target machine lacks.
  const work = {
    ...AT_DESK,
    deskOffer: { known: true, host: 'MAC', why: null, apps: [{ id: 'browser', label: 'Browser' }] },
  };
  const html = render({ data: { ...payload(null), work }, onDeskOpen: () => {} });
  assert.match(html, /Browser/);
  for (const gone of ['Music', 'VS Code', 'Terminal']) {
    assert.doesNotMatch(html, new RegExp(gone), `${gone} was not offered by that machine`);
  }
});

test('⚠ a machine that has NOT SAID offers nothing, and says why', () => {
  // ⚠ `null` is "it has not told me" — NOT "offer everything and hope", which
  //   is what made this row untrustworthy in the first place.
  const work = {
    ...AT_DESK,
    deskOffer: { known: false, host: 'PC', apps: [], why: 'that machine hasn’t said what it can open' },
  };
  const html = render({ data: { ...payload(null), work }, onDeskOpen: () => {} });
  assert.doesNotMatch(html, /surface__deskbtn/, 'no buttons');
  assert.match(html, /hasn.t said what it can open/, 'but it says why');
});

test('⚠ NOT at the laptop offers nothing — an intent would expire unclaimed', () => {
  const html = render({ data: { ...payload(null), work: { atDesk: false, deskKnown: true } }, onDeskOpen: () => {} });
  assert.doesNotMatch(html, /surface__desk/);
});

test('⚠ a laptop that has not reported SAYS so, rather than going quiet', () => {
  const html = render({ data: { ...payload(null), work: { atDesk: false, deskKnown: false } }, onDeskOpen: () => {} });
  assert.match(html, /can.{0,8}t see your laptop/i);
});

test('⚠ a surface that cannot reach the route offers NOTHING', () => {
  // No handler passed — the kiosk's case once it has been refused.
  const html = render({ data: { ...payload(null), work: AT_DESK } });
  assert.doesNotMatch(html, /surface__deskbtn/);
});

test('⚠ it reports the real outcome, and never the word "sent"', () => {
  const html = render({
    data: { ...payload(null), work: AT_DESK },
    onDeskOpen: () => {},
    deskStates: { music: 'claimed', code: 'opened' },
  });
  assert.match(html, /claimed/);
  assert.match(html, /opened/);
  assert.doesNotMatch(html, /\bsent\b/i);
});

test('no work reading at all renders no desk row', () => {
  assert.doesNotMatch(render({ data: payload(null), onDeskOpen: () => {} }), /surface__desk/);
});
