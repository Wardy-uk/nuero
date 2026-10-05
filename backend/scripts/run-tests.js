#!/usr/bin/env node
// `npm test` — `node --test` with ONE temp directory per run, removed afterwards.
//
// 170 of the ~200 test files that mkdtemp a scratch vault or DB never remove it,
// and on pi5 /tmp is a RAM-backed tmpfs: 51 deploys' worth of leftovers reached
// 7.2GB / ~12,000 directories, filled swap and raised "Memory 96%" (5 Oct 2026).
// Fixing teardown in 170 files is not surgical; giving the run its own TMPDIR is
// one place, and it catches every future test that forgets too.
//
// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows, and the `node --test`
// child processes inherit this environment, so every mkdtemp lands inside RUN_DIR.
// The directory is removed whatever the outcome; the exit code is passed through.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-testrun-'));
const env = { ...process.env, TMPDIR: RUN_DIR, TEMP: RUN_DIR, TMP: RUN_DIR };

let status = 1;
try {
  const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });
  if (r.error) console.error('[run-tests] could not start node --test:', r.error.message);
  status = r.status ?? (r.signal ? 1 : 0);
} finally {
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  } catch (err) {
    // Never let cleanup mask the test result — but say what was left behind.
    console.error(`[run-tests] could not remove ${RUN_DIR}: ${err.message}`);
  }
}
process.exit(status);
