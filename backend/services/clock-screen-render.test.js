'use strict';

/**
 * The office tablet's idle screen: does the MESSAGE lead, and does the clock
 * still lead when there is no message?
 *
 * Nick, 24 Sep 2026, of the Fire tablet in the office: the screen showed a
 * wall-height clock with "Away from the desk — back at 17:00." whispered under
 * it at 0.4 opacity. The one fact only SAiM has was the smallest thing on a
 * panel otherwise dedicated to the one fact every wall in the building already
 * carries. The message is the hero now and the time supports it.
 *
 * ⚠ TWO RULES, AND THE SECOND IS THE ONE A TIDY-UP WOULD BREAK.
 *
 *  1. `say` is legitimately NULL on several of the states that land here
 *     ('not-at-this-desk', an unreadable sensor), and a hero-sized blank above
 *     a small clock is worse than the screen this replaced. No message means
 *     the clock keeps the panel.
 *
 *  2. The swap moves SIZE AND BRIGHTNESS TOGETHER. Promote the message on size
 *     alone and it sits at 0.4 opacity beside a clock rendered in the brightest
 *     ink on the panel — the eye reads the bright thing first, so a half-swap
 *     is not a swap. This is exactly the shape of change someone simplifies
 *     later ("the font-size already says which is the hero"), so it is pinned.
 *
 * `saim/frontend` has no test runner of its own, hence the esbuild render here,
 * the way `surface-rooms-render.test.js` and `desktop-render.test.js` do. A
 * vite build proves the JSX compiles; it does not run it.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const KIOSK = path.resolve(__dirname, '..', '..', 'saim', 'frontend', 'src', 'components');
const CLOCK_JSX = path.join(KIOSK, 'ClockScreen.jsx');
const CLOCK_CSS = path.join(KIOSK, 'ClockScreen.css');

// The field paints to a canvas and knows nothing about the clock; stubbing it
// keeps this a test of the screen rather than of a renderer.
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

let ClockScreen;
let css;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [CLOCK_JSX],
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
  ClockScreen = mod.exports.default;
  css = fs.readFileSync(CLOCK_CSS, 'utf8');
  assert.ok(ClockScreen, 'ClockScreen has a default export');
});

// A fixed instant so the assertions below are about layout, not about the hour
// the suite happened to run at. 17:42 on a Thursday.
const NOW = new Date(2026, 8, 24, 17, 42, 0);

// The real line the office tablet renders — `dueBackLine()` in
// saim/backend/src/presence/rooms.js. An invented short string would wrap
// differently and would agree with a layout sized for a clock.
const REAL_SAY = 'Away from the desk — back at 17:00.';

function render(props) {
  return renderToString(React.createElement(ClockScreen, { now: NOW, ...props }));
}

test('the message renders, and it comes before the time', () => {
  const html = render({ say: REAL_SAY });
  assert.ok(html.includes(REAL_SAY), 'the message SAiM sent is on the screen');
  const sayAt = html.indexOf('clockscreen__say');
  const timeAt = html.indexOf('clockscreen__time');
  assert.ok(sayAt >= 0, 'the say element is rendered');
  assert.ok(timeAt >= 0, 'the time element is rendered');
  assert.ok(sayAt < timeAt, 'reading order puts the message above the clock');
});

test('a message puts the screen in its message-led mode', () => {
  assert.match(render({ say: REAL_SAY }), /clockscreen--message/,
    'the modifier that swaps the type scale is applied');
});

test('⚠ no message means the CLOCK keeps the panel, not a hero-sized blank', () => {
  const html = render({ say: null });
  assert.ok(!html.includes('clockscreen__say'), 'no empty hero element is rendered');
  assert.ok(!/clockscreen--message/.test(html),
    'the message-led scale is not applied to a screen with no message');
  assert.ok(html.includes('clockscreen__time'), 'the clock is still there');
});

test('⚠ a whitespace-only message is NO message', () => {
  // `say` comes off a payload; a blank string is not something to lead with.
  for (const blank of ['', '   ', '\n']) {
    const html = render({ say: blank });
    assert.ok(!/clockscreen--message/.test(html),
      `a say of ${JSON.stringify(blank)} must not promote an empty line to hero`);
  }
});

test('the time and date are still rendered under the message', () => {
  const html = render({ say: REAL_SAY });
  assert.ok(html.includes('17:42'), 'the clock still reads');
  assert.match(html, /Thursday/, 'the date is still there');
});

// ── The CSS half ───────────────────────────────────────────────────────────
// Rendering proves the elements exist in the right order; only the stylesheet
// says which one the eye lands on.

// ⚠ COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The first cut of
// this scan read the comment INSIDE the rule — which says "NOT the clock's
// 18vw" — as a declaration, and failed the very rule it was explaining. Fourth
// instance of that species in this repo (the kiosk DOORS parser, the client
// route scan, the mount reader): a name inside a comment counts unless you take
// the comments out. Punishing the documentation is also how a scan gets deleted.
function blockFor(selector) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = bare.indexOf(selector);
  assert.ok(at >= 0, `${selector} exists in ClockScreen.css`);
  const open = bare.indexOf('{', at);
  const close = bare.indexOf('}', open);
  return bare.slice(open + 1, close);
}

test('⚠ the message-led swap moves BRIGHTNESS, not only size', () => {
  const say = blockFor('.clockscreen--message .clockscreen__say');
  const time = blockFor('.clockscreen--message .clockscreen__time');

  assert.match(say, /font-size/, 'the hero is resized');
  assert.match(say, /color\s*:/, 'the hero sets its own colour');
  assert.match(say, /opacity\s*:\s*1/,
    'the hero drops the 0.4 opacity it was whispered at — resizing alone is not a swap');
  assert.match(time, /(color|opacity)\s*:/,
    'the clock is stepped back as well, or it is still the brightest thing on the panel');
});

test('⚠ the hero is NOT sized on the viewport scale written for the clock', () => {
  // "Away from the desk — back at 17:00." is ~35 characters against the clock's
  // 5. Reusing 18vw overflows the panel, and doing so is the obvious tidy-up.
  const say = blockFor('.clockscreen--message .clockscreen__say');
  assert.ok(!/1[0-9]vw/.test(say),
    'a sentence must not be sized on the scale written for a four-digit clock');
  assert.match(say, /max-width/, 'the hero wraps rather than running off the panel');
});

test('⚠ the no-message layout is untouched by the swap', () => {
  // Every message rule is scoped to the modifier, so the fallback screen is
  // exactly the screen that shipped before this change.
  const base = blockFor('.clockscreen__time');
  assert.match(base, /clamp\(4rem, 18vw, 11rem\)/,
    'the unmodified clock keeps its wall-height scale');
});
