'use strict';

/**
 * Which way round does the body dial run, and when does it earn a slot?
 *
 * ⚠ THIS EXISTS BECAUSE BOTH IMPLEMENTATIONS STATED THE SAME WRONG PREMISE.
 * `Readiness.jsx` and `Readiness.swift` each carried a comment reading "`score`
 * IS RECOVERY, NOT STRESS" and each inverted the number on the strength of it.
 * `stress-score.js` returns `50 - 18z` on the HRV z-score — higher HRV gives a
 * LOWER number — and labels it High / Elevated / Balanced / Low / Very low. Two
 * files agreeing is not two witnesses; it is one mistake copied.
 *
 * What it cost, in both directions:
 *   • the live 13 Sep reading, score 62 / "Elevated" STRESS, drew "62 ready";
 *   • a genuinely recovered day at 20 would have drawn 80, red, critical —
 *     the best morning of the month painted as the worst.
 *
 * A vite build proves the JSX compiles, and the inverted version compiled
 * perfectly for months. So this bundles the real shared component with esbuild
 * and mounts it, like `surface-rooms-render.test.js`.
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENT = path.resolve(__dirname, '..', '..', 'sara', 'shared-ui', 'Readiness.jsx');

function stubCss() {
  return {
    name: 'stub-css',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    },
  };
}

let Readiness;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [COMPONENT],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [stubCss()],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Readiness = mod.exports.default;
  assert.ok(Readiness, 'Readiness has a default export');
});

/** The live 13 Sep payload, copied off `/api/attention` rather than invented. */
function live(over = {}) {
  return {
    known: true,
    status: 'ok',
    score: 62,
    label: 'Elevated',
    hrv: 13.7,
    baselineMs: 19,
    deviation: -0.7,
    restingHr: 73,
    currentHr: 84,
    baselineDays: 15,
    caveats: [],
    hrvWeek: [18, 21, 17, 20, 16, 15, 13.7],
    notable: true,
    ...over,
  };
}

const html = (props) => renderToString(require('react').createElement(Readiness, props));

test('the dial shows the brain\'s number, not its inverse', () => {
  const out = html({ readiness: live() });
  assert.match(out, />62</, 'the working dial must read 62 — the score itself');
  assert.doesNotMatch(out, />38</, 'a reading of 38 is 100 - score, the bug');
});

test('at work it is called stress, and off duty recovered — never "ready"', () => {
  const working = html({ readiness: live() });
  assert.match(working, /stress/);
  // ⚠ "ready" over a stress score is the wording that made the inversion
  // invisible: the number looked plausible because the unit agreed with it.
  assert.doesNotMatch(working, /\bready\b/);

  const off = html({ readiness: live(), offDuty: true });
  assert.match(off, />38</, 'off duty asks what is in the tank: 100 - stress');
  assert.match(off, /recovered/);
  assert.doesNotMatch(off, /\bready\b/);
});

test('a genuinely recovered morning is NOT painted as a crisis', () => {
  // The other direction, and the expensive one. Under the old inversion a
  // score of 20 became stress 80, band critical, red, "Take it gently".
  const out = html({ readiness: live({ score: 20, label: 'Very low' }) });
  assert.match(out, /rdy--calm/, 'very low stress is the calm band');
  assert.doesNotMatch(out, /rdy--critical/);
  assert.match(out, />20</);
});

test('the band is read off the brand\'s own label, not a second ladder', () => {
  const cases = [['High', 'critical'], ['Elevated', 'high'], ['Balanced', 'elevated'], ['Low', 'calm']];
  for (const [label, tone] of cases) {
    // The score is deliberately held at a value the OLD numeric ladder would
    // have banded differently, so a fallback to it fails this.
    const out = html({ readiness: live({ label, score: 50 }) });
    assert.match(out, new RegExp(`rdy--${tone}`), `${label} should render ${tone}`);
  }
});

test('no advice — the verdict ladder is gone', () => {
  for (const score of [10, 30, 50, 62, 85]) {
    const out = html({ readiness: live({ score }) });
    for (const banned of ['Enough for a hard one', 'Enough for an easy one', 'Take it gently']) {
      assert.ok(!out.includes(banned), `${banned} must not appear (score ${score})`);
    }
  }
});

test('it still refuses to draw a number it does not have', () => {
  const out = html({ readiness: { known: false, why: 'no HRV in 6h', notable: false } });
  assert.doesNotMatch(out, /rdy__dial/, 'a dial resting at zero is the calm-day lie');
  // ⚠ renderToString escapes the apostrophe, so match either form.
  assert.match(out, /Couldn(&#x27;|')t read your readiness/);
});

test('the comparison needs both numbers or neither', () => {
  const out = html({ readiness: live({ baselineMs: null }) });
  assert.doesNotMatch(out, /baseline/);
});
