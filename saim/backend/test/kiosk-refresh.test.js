// The tablets can fetch the current build, and refreshing must not cost a capture.
//
// Nick, 14 Sep 2026: "all tablet sessions need a refresh button - fire tablet is
// still on the old deploy." The cause was structural rather than broken: the PWA
// registers `autoUpdate`, which checks for a new service worker ON PAGE LOAD, and
// a kiosk page is opened once and left open for days.
//
// ⚠ The rule worth a test is not that the button exists but WHAT IT MAY CLEAR.
// Service workers and Cache Storage are disposable copies of the server's own
// files. IndexedDB is not: it holds the offline outbox, whose entries are
// captures that have not yet reached NEURO and whose only copy is on that
// device. `caches.delete()` cannot see IndexedDB, which is what makes the button
// safe today — so the failure to guard against is a future hand adding
// `indexedDB.deleteDatabase()` "to be thorough" and quietly making a refresh
// destroy the thing capture exists to protect.
//
// `saim/frontend` has no test runner, so this is a source scan with a positive
// control, following `kiosk-overlay-privacy.test.js`.
//
//   run: npm test   (from saim/backend)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.join(__dirname, '..', '..', 'frontend', 'src');
const refreshSrc = fs.readFileSync(path.join(frontend, 'components', 'RefreshButton.jsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(frontend, 'App.jsx'), 'utf8');

// Comments stripped first: the header explains the rule by naming the very call
// it forbids, and a scan that reads its own documentation as a violation is one
// that gets deleted rather than fixed.
const code = refreshSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('positive control — the scan is reading the real component', () => {
  assert.match(code, /serviceWorker/, 'stripped the file to nothing; every assertion below would pass by absence');
  assert.match(code, /caches\.keys\(\)/);
});

test('it clears the disposable copies: service workers and Cache Storage', () => {
  assert.match(code, /getRegistrations\(\)/);
  assert.match(code, /\.unregister\(\)/);
  assert.match(code, /caches\.delete\(/);
});

// ⚠ The one that matters.
test('it NEVER touches IndexedDB — the outbox holds unsent captures', () => {
  assert.doesNotMatch(code, /indexedDB/i, 'a refresh must never be able to destroy a capture that has not reached NEURO');
  assert.doesNotMatch(code, /deleteDatabase/i);
  assert.doesNotMatch(code, /localStorage/, 'the PIN and the voice toggle are not this button’s to clear either');
});

// ⚠ The kiosks are started on `…/?room=study`. Navigating to the bare root would
// strip the room and the screen would stop knowing where it is — silently, since
// a roomless kiosk renders perfectly well.
test('it reloads the current URL, so the ?room= it was started with survives', () => {
  assert.match(code, /location\.reload\(\)/);
  assert.doesNotMatch(code, /location\.(href|assign|replace)\s*[=(]/);
});

// The label is the evidence the press did anything: without it a reload onto the
// same build and a button that did nothing look identical.
test('the panel names the build, and says so when there is no label rather than rendering blank', () => {
  assert.match(code, /buildLabel/);
  assert.match(refreshSrc, /unlabelled/i);
});

test('it is mounted on the kiosk shell and fed the build label', () => {
  const app = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.match(app, /<RefreshButton\s+buildLabel=\{import\.meta\.env\.VITE_BUILD_LABEL\}/);
});

// A label identical on every build cannot answer "is this the new deploy?" —
// which is the entire question the button is pressed to settle.
test('the build label is derived per build, not a constant', () => {
  const cfg = fs.readFileSync(path.join(frontend, '..', 'vite.config.js'), 'utf8');
  assert.match(cfg, /VITE_BUILD_LABEL/);
  assert.match(cfg, /rev-parse --short HEAD/);
});
