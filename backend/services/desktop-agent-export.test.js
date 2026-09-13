'use strict';

/**
 * The macOS agent's copy in `nuero-ios` is GENERATED, and stays that way.
 *
 * ⚠ WHY THE COPY EXISTS AT ALL. The agent is written in THIS repo, beside its
 * PowerShell sibling and `desktop-activity.js`, which reads the samples it
 * posts. The Mac it installs on only has `nuero-ios` checked out. So it has to
 * be in both places.
 *
 * ⚠ WHICH IS THE `voiceUtils.js` DRIFT WITH A SHELL SCRIPT IN IT. Two copies
 * agree on the day they are written and never again — this repo carries that
 * scar four times (voiceUtils, PRICES_PER_MTOK, the 1-2-1 cadence rule, and
 * `Theme.swift`, whose exporter this one is modelled on). Nothing on the iOS
 * side can notice the source moving, so the drift is made visible HERE, on the
 * side that owns the truth.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const exporter = require('../scripts/export-desktop-agent');

/** Skip cleanly where the sibling checkout is absent — the Pi, CI. */
const hasIos = fs.existsSync(exporter.IOS);

test('positive control: the source scripts are really being read', () => {
  // Without this, a moved or renamed source would make every assertion below
  // pass by comparing nothing — the failure that makes a scan worse than none.
  for (const name of exporter.FILES) {
    const src = fs.readFileSync(path.join(exporter.SRC_DIR, name), 'utf8');
    assert.ok(src.length > 500, `${name} is suspiciously small`);
    assert.ok(src.startsWith('#!'), `${name} must keep its shebang`);
  }
  assert.equal(exporter.FILES.length, 2);
});

test('the shebang stays the FIRST line of the generated copy', () => {
  // ⚠ `#!/bin/bash` must be the first two bytes or the kernel does not treat
  // the file as a script at all — and the error is `Exec format error`, which
  // mentions nothing about a header. The note therefore goes UNDER it.
  for (const name of exporter.FILES) {
    const src = fs.readFileSync(path.join(exporter.SRC_DIR, name), 'utf8');
    const out = exporter.build(name, src);
    assert.ok(out.startsWith('#!/bin/bash\n'), `${name} lost its shebang`);
    assert.match(out, /GENERATED — DO NOT EDIT THIS COPY/);
    // The whole original survives underneath.
    assert.ok(out.includes(src.split('\n').slice(1).join('\n')),
      `${name}'s body was altered, not just prefixed`);
  }
});

test('a file with no shebang is not given one', () => {
  // Defensive: `build` must prefix, never invent. A header written above a
  // non-script would be harmless; a shebang invented for one would not.
  const out = exporter.build('x.txt', 'plain text\nsecond line\n');
  assert.ok(!out.startsWith('#!'));
  assert.ok(out.startsWith('#\n'));
  assert.match(out, /plain text/);
});

test('newlines are not drift', () => {
  // ⚠ Both checkouts are on Windows with git normalising the working tree, and
  // the exporter writes LF. A byte comparison would report the copy stale on
  // every run, for ever — and a check that fails for a reason unrelated to what
  // it checks gets switched off, taking the real catch with it.
  const lf = 'a\nb\nc\n';
  const crlf = 'a\r\nb\r\nc\r\n';
  assert.ok(exporter.sameIgnoringNewlines(lf, crlf));
  assert.ok(!exporter.sameIgnoringNewlines(lf, 'a\nb\nd\n'));
  // A missing file is not "the same as" anything.
  assert.ok(!exporter.sameIgnoringNewlines(null, lf));
});

test('the hash ignores newlines too', () => {
  // Or the header would change on every checkout and the copy would look stale
  // for the same reason the comparison would.
  assert.equal(exporter.sha('a\nb\n'), exporter.sha('a\r\nb\r\n'));
  assert.notEqual(exporter.sha('a\nb\n'), exporter.sha('a\nc\n'));
});

test('the iOS copy is current', { skip: hasIos ? false : 'no nuero-ios checkout' }, () => {
  // THE ONE THAT MATTERS. Edit the agent and forget the exporter, and this
  // fails — which is the only thing standing between two copies and silent
  // divergence, because the Mac never sees this repo.
  const generated = exporter.generate();
  for (const [name, text] of Object.entries(generated)) {
    const target = path.join(exporter.OUT_DIR, name);
    assert.ok(fs.existsSync(target), `${name} has never been exported`);
    const current = fs.readFileSync(target, 'utf8');
    assert.ok(exporter.sameIgnoringNewlines(current, text),
      `${name} in nuero-ios is BEHIND — run: node backend/scripts/export-desktop-agent.js`);
  }
});
