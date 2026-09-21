'use strict';

/**
 * Where the iOS repo is checked out beside this one.
 *
 * ⚠⚠ WHY THIS IS SHARED RATHER THAN RE-DERIVED. The GitHub repo is
 * `nuero-ios` (the historical typo) and the checkout on the Mac is
 * `neuro-ios` — so every tool that hard-codes one spelling finds nothing on
 * the one machine that HAS the iOS app, and every cross-repo guard built on it
 * skips in silence. Measured on 20-21 Sep 2026: FOUR tools, three of them
 * inert — `design-tokens`, `heard-parity` and `operation-phase-parity` all
 * skipping with "no nuero-ios checkout beside this repo" while
 * `export-desktop-agent` (which happened to try both names) worked fine.
 *
 * Those guards are the only thing standing between two palettes, two phrase
 * matchers and two phase vocabularies diverging in silence, and CLAUDE.md
 * describes all three as mutation-checked. They were neither, here.
 *
 * ⚠ ONE PLACE DECIDES. Two cross-repo tools in one repo disagreeing about
 * where the sibling lives is exactly how one of them ends up dead while the
 * other looks like proof the mechanism works.
 */

const fs = require('fs');
const path = require('path');

/**
 * ⚠ BOTH SPELLINGS. The remote's and the working copy's — and a future third
 * belongs here rather than in a caller.
 */
const NAMES = ['neuro-ios', 'nuero-ios'];

/**
 * ⚠ A MARKER IS REQUIRED, never a bare name match. An empty folder left beside
 * the repo must not be mistaken for the checkout and silently become the thing
 * a guard compares against — that fails OPEN, which is the failure this whole
 * module exists to stop.
 */
const MARKERS = ['.git', 'NeuroKit', 'desktop-agent'];

/** The checkout, or null. `repoRoot` is this repo's root. */
function findIOSCheckout(repoRoot) {
  for (const name of NAMES) {
    const dir = path.resolve(repoRoot, '..', name);
    if (!fs.existsSync(dir)) continue;
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
  }
  return null;
}

module.exports = { findIOSCheckout, NAMES, MARKERS };
