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
  for (const [name, file] of Object.entries(shells)) {
    const src = fs.readFileSync(file, 'utf8');
    // Positive control: a wrong path must fail here, not pass by absence.
    assert.match(src, /navOpen/, `could not read the ${name} shell`);

    assert.match(src, /useEffect\(\(\) => \{\s*if \(!revealsSecondary\(active\)\) setNavOpen\(false\);\s*\}, \[active\]\);/s,
                 `the ${name} shell leaves the strip open under her`);
  }
});

test('⚠ it keys on `active` alone — the More button must still work', () => {
  for (const [name, file] of Object.entries(shells)) {
    const src = fs.readFileSync(file, 'utf8');
    const effect = src.match(/if \(!revealsSecondary\(active\)\) setNavOpen\(false\);\s*\}, \[([^\]]*)\]\)/s);
    assert.ok(effect, `${name}: the effect is gone`);
    // ⚠ A dependency on `navOpen` would close the menu the instant it opened,
    // because opening it does not change the tab. The toggle would appear dead.
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

test('⚠ ONE persistent navigation per viewport on the phone shell (20 Oct 2026) — and the way back survives', () => {
  // On a phone the strip is a transient MENU; a secondary screen is PUSHED with
  // its own Back. On a wide screen the strip is part of the one bar while he is
  // off the Surface. Either way he can always get back.
  const src = fs.readFileSync(shells.phone, 'utf8');
  assert.match(src, /const moreVisible = navOpen \|\| \(wide && isSecondary\);/, 'phone: the strip must not persist as a second bar on a phone');
  assert.match(src, /const pushed = !wide && isSecondary;/);
  assert.match(src, /\{pushed && \(/, 'a pushed screen draws its own way back');
  assert.match(src, /className="app__backbtn" onClick=\{\(\) => goTab\(backTo \|\| DEFAULT_TAB\)\} aria-label=\{`Back to \$\{labelOf\(backTo \|\| DEFAULT_TAB\)\}`\}/, 'Back is a real, labelled button');
  assert.match(src, /aria-controls="saim-more"/, 'More says what it controls');
  assert.match(src, /id="saim-more"/);
  assert.match(src, /e\.key === 'Escape' && navOpen\) setNavOpen\(false\)/, 'Escape closes the menu');
  assert.match(src, /window\.history\.pushState\(\{ saimTab: tab \}/, 'the phone’s own Back gesture returns through the same path');
  assert.match(src, /addEventListener\('popstate'/);
  // Choosing any screen puts the menu away (it is a menu, not a bar).
  assert.match(src, /function goTab\(tab[^)]*\) \{[\s\S]*?setNavOpen\(false\);/);
  // The wide breakpoint is the one App.css uses for the one bar.
  assert.match(src, /const WIDE_QUERY = '\(min-width: 900px\)';/);
  assert.match(fs.readFileSync(path.join(ROOT, 'app', 'src', 'App.css'), 'utf8'), /@media \(min-width: 900px\)[\s\S]*ONE NAVIGATION BAR ON A WIDE SCREEN/);
});
