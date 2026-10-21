'use strict';

/**
 * The menu SAiM does not have must not stay open under her.
 *
 * ⚠⚠ PHOTOGRAPHED ON THE DESK TABLET, 14 Sep 2026: TWO FULL ROWS of navigation
 * under the ambient surface — the secondary strip (SAiM / Today / Focus / Tasks
 * / Voice / Chat / Prep / Ritual / Controls) sitting permanently above the
 * primary one.
 *
 * `navOpen` was only ever cleared by `goTab` when the chosen tab was in
 * PRIMARY — and the Surface is NOT in PRIMARY. So tapping SAiM left the whole
 * strip open underneath her, for good.
 *
 * ⚠ THAT IS THE MENU SAiM DOES NOT HAVE, RESTORED BY ACCIDENT. The 25 Aug rule
 * is that the strip stays revealed while he is OFF the Surface — because the
 * one screen with no menu must not also be the only way back. This is the other
 * half of that sentence, which was never written down: it comes back DOWN when
 * she is back on screen.
 *
 * ⚠ It keys on `active`, so it fires on ARRIVING somewhere and never on the More
 * button itself — opening the menu does not change the tab, so the menu opens
 * and stays until a screen is chosen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'saim');
const shells = {
  phone: path.join(ROOT, 'app', 'src', 'App.jsx'),
  kiosk: path.join(ROOT, 'frontend', 'src', 'App.jsx'),
};

test('⚠ BOTH shells minimise the strip when she is back on screen', () => {
  // Kiosk: closes when he is back on her screen. Phone (22 Oct 2026): closes on
  // ANY arrival — the menu is a menu, and More is always in the bar.
  const kiosk = fs.readFileSync(shells.kiosk, 'utf8');
  assert.match(kiosk, /navOpen/, 'could not read the kiosk shell');
  assert.match(kiosk, /useEffect\(\(\) => \{\s*if \(!revealsSecondary\(active\)\) setNavOpen\(false\);\s*\}, \[active\]\);/s, 'the kiosk shell leaves the strip open under her');
  const phone = fs.readFileSync(shells.phone, 'utf8');
  assert.match(phone, /navOpen/, 'could not read the phone shell');
  assert.match(phone, /useEffect\(\(\) => \{ setNavOpen\(false\); \}, \[active\]\);/, 'the phone shell leaves the menu open after a screen is chosen');
});

test('⚠ it keys on `active` alone — the More button must still work', () => {
  const kiosk = fs.readFileSync(shells.kiosk, 'utf8').match(/if \(!revealsSecondary\(active\)\) setNavOpen\(false\);\s*\}, \[([^\]]*)\]\)/s);
  const phone = fs.readFileSync(shells.phone, 'utf8').match(/useEffect\(\(\) => \{ setNavOpen\(false\); \}, \[([^\]]*)\]\)/);
  for (const [name, effect] of [['kiosk', kiosk], ['phone', phone]]) {
    assert.ok(effect, `${name}: the effect is gone`);
    // ⚠ A dependency on `navOpen` would close the menu the instant it opened.
    assert.equal(effect[1].trim(), 'active', `${name} watches more than the tab`);
  }
});

test('⚠ the way back is still there — the strip is hidden, never deleted', () => {
  // The rule this must not break: "Show me everything" reveals it, and it stays
  // revealed while he is off the Surface.
  for (const [name, file] of Object.entries(shells)) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /onShowAll=\{\(\) => setNavOpen\(true\)\}/, `${name}: the escape hatch is gone`);
  }
  // The kiosk (a wall, one viewport) keeps the strip up while off the Surface.
  assert.match(fs.readFileSync(shells.kiosk, 'utf8'), /const moreVisible = navOpen \|\| isSecondary;/,
               'kiosk: the strip no longer stays up while he is off the Surface');
});

test('⚠ the PWA navigation is exactly Capture · Now · Review · More, on every width (22 Oct 2026)', () => {
  // Nick photographed a long bottom bar: on a wide window every secondary screen
  // joined the bar and More was hidden. Now the bar is four items, always; the
  // other screens live ONLY in the More menu; a secondary screen is pushed with
  // its own Back on every width.
  const tabs = fs.readFileSync(path.join(ROOT, 'shared-ui', 'tabs.jsx'), 'utf8');
  const primary = tabs.slice(tabs.indexOf('export const PRIMARY'), tabs.indexOf('export const SECONDARY'));
  assert.deepEqual([...primary.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]), ['capture', 'now', 'review']);
  const secondary = tabs.slice(tabs.indexOf('export const SECONDARY'), tabs.indexOf('export const TABS'));
  assert.match(secondary, /\{ id: 'authority', label: 'What SAiM may do'/, '“What SAiM may do” lives within More');
  const src = fs.readFileSync(shells.phone, 'utf8');
  const bar = src.slice(src.indexOf('<nav className="app__nav" aria-label="Neuro Mobile">'));
  assert.match(bar, /\{PRIMARY\.map\(/, 'the bar draws the three modes');
  assert.equal((bar.slice(0, bar.indexOf('</nav>')).match(/<button/g) || []).length, 2, 'one mapped mode button and More — nothing else in the bar');
  assert.match(bar, /<span className="navbtn__label">More<\/span>/);
  assert.doesNotMatch(bar.slice(0, bar.indexOf('</nav>')), /SECONDARY/, 'no secondary screen joins the bar');
  assert.match(src, /const moreVisible = navOpen;/, 'the menu shows only when More is pressed');
  assert.match(src, /const pushed = isSecondary;/, 'a secondary screen is pushed with Back on every width');
  assert.doesNotMatch(src, /WIDE_QUERY|useWide|wide && isSecondary/, 'no wide-only navigation any more');
  assert.match(src, /className="app__nav app__nav--more app__nav--menu"/, 'the other screens are a menu, never a bar');
  assert.match(src, /hidden=\{!moreVisible\}/);
  const css = fs.readFileSync(path.join(ROOT, 'app', 'src', 'App.css'), 'utf8');
  assert.doesNotMatch(css, /navbtn\[aria-expanded\] \{ display: none; \}/, 'More is never hidden');
  assert.doesNotMatch(css, /ONE NAVIGATION BAR ON A WIDE SCREEN/);
  // The way back survives.
  assert.match(src, /\{pushed && \(/, 'a pushed screen draws its own way back');
  assert.match(src, /className="app__backbtn" onClick=\{\(\) => goTab\(backTo \|\| DEFAULT_TAB\)\} aria-label=\{`Back to \$\{labelOf\(backTo \|\| DEFAULT_TAB\)\}`\}/, 'Back is a real, labelled button');
  assert.match(src, /aria-controls="saim-more"/, 'More says what it controls');
  assert.match(src, /e\.key === 'Escape' && navOpen\) setNavOpen\(false\)/, 'Escape closes the menu');
  assert.match(src, /window\.history\.pushState\(\{ saimTab: tab \}/, 'the phone’s own Back gesture returns through the same path');
  assert.match(src, /addEventListener\('popstate'/);
});
