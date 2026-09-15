'use strict';

/**
 * Where the iOS checkout actually is, for the guards that read its source.
 *
 * ⚠ THE FOLDER IS NOT ALWAYS NAMED AFTER THE REMOTE. The GitHub repo is
 * `nuero-ios`; the Mac checkout is `neuro-ios`. Four test files each hardcoded
 * the remote's spelling, found nothing, and reported "only found 0 Swift files"
 * — which reads as a broken guard rather than as a wrong path, and would have
 * read as PASSING if any of them had been written to skip on an absent
 * checkout. A guard that cannot find what it guards is worse than no guard,
 * because it is silent in exactly the same way as a clean run.
 *
 * ⚠ AND A CANDIDATE HAS TO LOOK LIKE THE CHECKOUT. An unrelated `nuero-ios`
 * directory sits beside the real one on this Mac, so existence alone is not
 * enough — the same trap that sent `export-desktop-agent.js` writing into a
 * folder no repo was tracking.
 */

const fs = require('fs');
const path = require('path');

/** Repo root of `nuero`, two up from `backend/services`. */
const REPO = path.resolve(__dirname, '..', '..');

function findIOSCheckout() {
  for (const name of ['neuro-ios', 'nuero-ios']) {
    const dir = path.resolve(REPO, '..', name);
    if (!fs.existsSync(dir)) continue;
    // A `.git` or the NeuroKit package — either proves it is the real thing.
    if (fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, 'NeuroKit'))) return dir;
  }
  return null;
}

module.exports = { findIOSCheckout };
