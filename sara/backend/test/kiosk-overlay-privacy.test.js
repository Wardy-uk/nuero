// The kiosk overlays must BLOCK the live shell underneath them, not just cover it.
//
// Nick, 11 Sep 2026: "lock the tablet down so no one can access it if I'm not
// there." The clock overlay (home, but not in this room) was `pointer-events:
// none`, so SARA stayed fully usable underneath it — invisible, but tappable. The
// lock overlay was always opaque to input. sara/frontend has no test runner, so the
// guard lives here, as a source scan with a positive control.
//
//   run: npm test   (from sara/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const components = path.join(__dirname, '..', '..', 'frontend', 'src', 'components');

// Comments stripped first: the comment explaining the fix quotes the old value.
function ruleBody(rawCss, selector) {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} rule not found — the scan would pass by absence`);
  return css.slice(at, css.indexOf('}', at));
}

test('the clock overlay swallows taps instead of passing them to SARA underneath', () => {
  const body = ruleBody(fs.readFileSync(path.join(components, 'ClockScreen.css'), 'utf8'), '.clockscreen');
  assert.doesNotMatch(body, /pointer-events:\s*none/);
  assert.match(body, /pointer-events:\s*auto/);
  assert.match(body, /position:\s*fixed/);
  assert.match(body, /inset:\s*0/);
});

test('the lock overlay is opaque to input too', () => {
  const body = ruleBody(fs.readFileSync(path.join(components, 'LockScreen.css'), 'utf8'), '.lock');
  assert.doesNotMatch(body, /pointer-events:\s*none/);
  assert.match(body, /position:\s*fixed/);
  assert.match(body, /inset:\s*0/);
});
