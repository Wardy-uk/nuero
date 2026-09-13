#!/usr/bin/env node
'use strict';

/**
 * The macOS desktop agent, copied into the iOS checkout the Mac actually pulls.
 *
 * ⚠ THE MAC SESSION PULLS `nuero-ios`, NOT `nuero`. The agent is written here,
 * beside its PowerShell sibling and the service that consumes its samples, and
 * that is where it belongs — but the machine it installs on only has the other
 * repo checked out. So it has to exist in both.
 *
 * ⚠ WHICH MAKES IT THE `voiceUtils.js` DRIFT WITH A SHELL SCRIPT IN IT, unless
 * something notices. Two copies agree on the day they are written and never
 * again; this repo has the scar four times over (voiceUtils, PRICES_PER_MTOK,
 * the cadence rule, `Theme.swift`). So the copy is GENERATED, carries the source
 * hash, and `desktop-agent-export.test.js` fails when it is behind — the
 * `export-design-tokens.js` idiom exactly, for the same reason: the drift is
 * made visible on the side that OWNS the truth, because the other side cannot
 * see it.
 *
 * ⚠ THE HEADER GOES AFTER THE SHEBANG, never before it. `#!/bin/bash` must be
 * the first two bytes of the file or the kernel does not recognise it as a
 * script at all, and the failure is `Exec format error` rather than anything
 * mentioning line 1.
 *
 *   node backend/scripts/export-desktop-agent.js           # write it
 *   node backend/scripts/export-desktop-agent.js --check   # is it current?
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO, 'desktop-agent');
// Sibling checkout. Absent on the Pi and on CI, which is not an error.
const IOS = path.resolve(REPO, '..', 'nuero-ios');
const OUT_DIR = path.join(IOS, 'desktop-agent');

/** The files that cross. Windows' agent stays put — it installs from here. */
const FILES = ['neuro-desktop-agent.sh', 'install.sh'];

/**
 * Same text, whatever git did to the newlines on the way through.
 *
 * ⚠ NEWLINES ARE NOT DRIFT. Both checkouts are on Windows with git normalising
 * the working tree, and this writes LF — a byte comparison would report the file
 * stale on EVERY run, for ever. A check that fails for a reason unrelated to
 * what it is checking gets switched off, and takes the real catch with it.
 * (Built with split/join rather than a regex literal: this function's twin in
 * `export-design-tokens.js` was first written through a shell heredoc that ate
 * the backslashes and left raw newlines inside the pattern.)
 */
function sameIgnoringNewlines(a, b) {
  if (a == null || b == null) return false;
  const lf = (s) => s.split(String.fromCharCode(13) + String.fromCharCode(10))
    .join(String.fromCharCode(10));
  return lf(a) === lf(b);
}

function sha(text) {
  return crypto.createHash('sha256')
    .update(text.split(String.fromCharCode(13) + String.fromCharCode(10))
      .join(String.fromCharCode(10)))
    .digest('hex');
}

/** The source, with a generated-from note inserted under the shebang. */
function build(name, source) {
  const lines = source.split(String.fromCharCode(10));
  const shebang = lines[0].startsWith('#!') ? lines.shift() : null;
  const note = [
    '#',
    '# ⚠ GENERATED — DO NOT EDIT THIS COPY.',
    '#',
    `# Source: Wardy-uk/nuero  desktop-agent/${name}  (sha256 ${sha(source).slice(0, 12)})`,
    '#',
    '# It lives here because the Mac session pulls THIS repo, and the agent it',
    '# installs is written in the other one beside the service that reads its',
    '# samples. Edit it there and re-run:',
    '#',
    '#     node backend/scripts/export-desktop-agent.js',
    '#',
    '# `desktop-agent-export.test.js` over in nuero fails when this copy is',
    '# behind, so an edit made here alone is lost rather than merged.',
    '#',
  ];
  const out = (shebang ? [shebang] : []).concat(note, lines);
  return out.join(String.fromCharCode(10));
}

function generate() {
  const out = {};
  for (const name of FILES) {
    const src = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
    out[name] = build(name, src);
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const generated = generate();

  if (!fs.existsSync(IOS)) {
    console.log('[desktop-agent] no nuero-ios checkout beside this repo — nothing to write');
    return;
  }

  let behind = [];
  for (const [name, text] of Object.entries(generated)) {
    const target = path.join(OUT_DIR, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (sameIgnoringNewlines(current, text)) continue;
    behind.push(name);
    if (!check) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    }
  }

  if (!behind.length) {
    console.log('[desktop-agent] the iOS copy is current');
    return;
  }
  if (check) {
    console.error(`[desktop-agent] BEHIND: ${behind.join(', ')} — re-run the exporter`);
    process.exitCode = 1;
    return;
  }
  console.log(`[desktop-agent] wrote ${behind.join(', ')} to ${path.relative(REPO, OUT_DIR)}`);
}

if (require.main === module) main();

module.exports = { FILES, SRC_DIR, OUT_DIR, IOS, build, generate, sameIgnoringNewlines, sha };
