'use strict';

/**
 * `momentum.knownGaps` has a READER, and it does not read as a fault.
 *
 * The class of bug, which has now bitten three times in one day: a value
 * computed FOR honesty, carried onto a payload, and read by nothing. There is
 * no error, no empty screen and no failing test — the honesty is simply absent
 * from every surface, and the explanation itself then rots unobserved. This
 * list is the worst instance: by 12 Sep its middle entry named
 * `dismissInboxItem`, deleted with the `inbox_items` table on 26 Aug, and
 * described a limitation lifted on 16 Aug. A wrong explanation, protected from
 * correction by having no reader.
 *
 * ⚠ TWO FACTS THAT MUST NOT READ ALIKE. `data.gaps` is a source that FAILED
 * (amber, "Couldn't read"); `momentum.knownGaps` is a source nobody has wired
 * up, each for a stated reason. Painting a considered omission in the warning
 * colour is how a permanent caveat comes to read as a fault and gets ignored
 * along with the real one — so this asserts the wiring AND the distinction.
 *
 * Deliberately regex-free (the `keepalive.test.js` rule: a scan written through
 * a shell heredoc can lose its backslashes and then pass for the wrong reason).
 *
 * Lives in backend/services because `node --test` is only run from backend/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'AdhdPanel.jsx');
const CSS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'AdhdPanel.css');

const panel = fs.readFileSync(PANEL, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

test('positive control: the backend still emits knownGaps on momentum', () => {
  // Without this, deleting the field from the payload would make every
  // assertion below pass by absence — which is the failure mode that makes a
  // scan worse than no scan.
  const dash = fs.readFileSync(path.join(__dirname, 'adhd-dashboard.js'), 'utf8');
  assert.ok(dash.includes('knownGaps: summary.knownGaps'),
    'adhd-dashboard no longer carries knownGaps — if that was deliberate, delete this file');

  // And the list itself is non-empty, or "it has a reader" is a claim about
  // nothing. Read as utf8 deliberately: wins.js contains a literal NUL byte as
  // a dedup separator, so `file` calls it binary.
  const wins = fs.readFileSync(path.join(__dirname, 'wins.js'), 'utf8');
  assert.ok(wins.includes('const KNOWN_GAPS = Object.freeze(['), 'KNOWN_GAPS has moved or gone');
});

test('the desktop card READS momentum.knownGaps', () => {
  assert.ok(panel.includes('momentum.knownGaps'),
    'knownGaps is computed, carried onto /api/adhd and rendered by nothing — the bug this pins');
});

test('a deliberate omission is NOT painted as a read failure', () => {
  // The amber class belongs to `data.gaps` alone. One class for both facts is
  // the conflation, whichever direction it is introduced from.
  // String.fromCharCode(10), never a backslash escape: this file was first
  // written through a shell heredoc, which ate the backslash and left a raw
  // newline inside the literal — a syntax error, and the lucky version of
  // that mistake. The widget's no-backslashes rule, one pipeline along.
  const lines = panel.split(String.fromCharCode(10));
  const knownGapLines = lines.filter((l) => l.includes('knownGaps'));
  assert.ok(knownGapLines.length > 0, 'positive control: no knownGaps lines to check');
  for (const line of knownGapLines) {
    assert.ok(!line.includes('adhd__gap'),
      'knownGaps must not render through the warning class used for a failed read: ' + line.trim());
  }

  assert.ok(css.includes('.adhd__known-gaps {'), 'the omission list has no style of its own');
});

test('the two lines say different things in words, not only in colour', () => {
  // Colour is not available to a screen reader and is not available to Nick at
  // a glance either — the wording has to carry it.
  assert.ok(panel.includes("Couldn't read"), 'positive control: the failed-read wording has moved');
  assert.ok(panel.includes('doesn&rsquo;t count') || panel.includes("doesn't count"),
    'the omission list must say it is an omission rather than a failure');
});
