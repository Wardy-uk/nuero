'use strict';

/**
 * One card per ROOM, not one per fact.
 *
 * ⚠⚠ PHOTOGRAPHED 14 Sep 2026: the bottom-right corner wrapped, with "3 off"
 * orphaned onto a line of its own under "office 21°". Nick: "the adaptive tasks
 * are wrapping round to a second line in the bottom right hand corner."
 *
 * The cause was in the ASSEMBLY, not the box. `Shelf` pushed a separate card for
 * a room's temperature and another for its lights — two readings of ONE ROOM as
 * two slots — so the row grew by TWO for every area she is considering.
 * Grouping them is what they already are, and it is the fix that survives a
 * third room being added: widening the box only moves the wrap to whenever the
 * house gets busier.
 *
 * ⚠ "N AT THE WALL" STAYS ITS OWN CARD, AND STAYS DASHED. Off at the wall means
 * she CANNOT REACH IT — the third light state — and folding it in beside a
 * reading she can act on would make an unreachable bulb look like a live one,
 * with the dash the only thing saying otherwise.
 *
 * A REAL render via esbuild, like `surface-rooms-render.test.js` — the previous
 * suite passed throughout, because it asserted the facts were present and never
 * how many cards carried them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SHELF = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui', 'Shelf.jsx');

let Shelf;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [SHELF],
    bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'css',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Shelf = mod.exports.default;
  assert.ok(Shelf, 'Shelf has a default export');
});

const render = (props) => renderToString(React.createElement(Shelf, props));
/** How many cards the row actually holds. */
const cards = (html) => (html.match(/class="shelf__(btn|wx)[^"]*"/g) || []).length;

const office = (over = {}) => ({
  considered: [{
    area: 'office',
    temperature: { reading: { currentC: 21 } },
    lights: { total: 3, on: [], off: ['a', 'b', 'c'], unreachable: [] },
    ...over,
  }],
});

test('⚠ a room is ONE card, carrying both of its readings', () => {
  const html = render({ rooms: office() });
  assert.match(html, /office 21/, 'the temperature is gone');   // positive control
  assert.match(html, /3 off/, 'the lights are gone');
  // The two used to be separate cards. That is the wrap.
  assert.equal(cards(html), 1, `expected one room card, got ${cards(html)}`);
});

test('⚠ the row grows by ONE per room, not two', () => {
  const two = {
    considered: [
      office().considered[0],
      { area: 'kitchen', temperature: { reading: { currentC: 19 } },
        lights: { total: 2, on: ['x'], off: [], unreachable: [] } },
    ],
  };
  const html = render({ rooms: two });
  assert.equal(cards(html), 2, `expected two room cards, got ${cards(html)}`);
  assert.match(html, /kitchen 19/);
  assert.match(html, /1 on/);
});

test('⚠ "at the wall" is still its OWN card, and still dashed', () => {
  const html = render({
    rooms: office({ lights: { total: 4, on: [], off: ['a'], unreachable: ['b', 'c'] } }),
  });
  // She cannot reach those — the third light state. Folding them in beside a
  // reading she CAN act on would make an unreachable bulb look live.
  assert.match(html, /2 at the wall/);
  assert.match(html, /shelf__btn--off/, 'the unreachable card lost its dash');
  assert.equal(cards(html), 2, 'the unreachable card was folded into the reading');
});

test('⚠ a room with nothing readable adds no card at all', () => {
  // Never a card of nothing — an empty pill is a fact she does not have,
  // rendered as one she does.
  const html = render({ rooms: { considered: [{ area: 'hall' }] } });
  assert.ok(!/hall/.test(html), 'an unread room got a card anyway');
});

test('⚠ the shelf still never goes empty', () => {
  const html = render({});
  assert.match(html, /Nothing I can reach from here\./);
});
