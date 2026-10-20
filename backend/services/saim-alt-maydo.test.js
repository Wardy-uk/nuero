'use strict';

/**
 * SAiM Alt (saim.nickward.co.uk) reaches "What SAiM may do" from Controls
 * (20 Oct 2026).
 *
 * The cause this pins: Alt has its OWN six-tab shell (alt-v2/App.jsx + Shell)
 * and never mounted the shared tab list, so the "May do" tab released for the
 * phone build (sara.nickward.co.uk) never appeared there — and a human using
 * Alt could not grant the allowance the prepared move needs.
 *
 * The fix: a "What SAiM may do" control on Controls opens the control's own
 * Authority screen as a view PUSHED under Controls — no seventh tab, nothing on
 * SAiM's page, the same human-only routes, the same read that writes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ALT = path.resolve(__dirname, '..', '..', 'saim', 'app', 'alt-v2');
const read = (f) => fs.readFileSync(path.join(ALT, f), 'utf8');

let Controls; let model;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ALT, 'ControlsPage.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
    plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Controls = mod.exports.ControlsPageView;
  model = await import(pathToFileURL(path.join(ALT, 'model.mjs')).href);
});

const SETTINGS = { settings: { enabled: true, interruptionLevel: 'normal', quietHours: '22:00-07:00', quietHoursSource: 'default', pausedUntil: null } };
const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Controls shows a clearly named "What SAiM may do" control — with settings read, and when they cannot be', () => {
  for (const resp of [SETTINGS, null]) {
    const h = renderToString(React.createElement(Controls, { resp, onPatch() {}, onOpenAuthority() {} }));
    assert.match(h, /<button[^>]*>What SAiM may do<\/button>/, resp ? 'settings read' : 'settings unreadable');
    assert.match(text(h), /The two locks, today’s allowance, receipts, and the stop\./);
  }
  // Not wired → not shown (never a button that does nothing).
  assert.doesNotMatch(renderToString(React.createElement(Controls, { resp: SETTINGS, onPatch() {} })), /What SAiM may do/);
});

test('it opens the control’s own Authority screen as a view pushed under Controls — Back and system back return there', () => {
  const app = read('App.jsx');
  assert.match(app, /import Authority from '\.\.\/src\/views\/Authority';/, 'the existing screen, not a copy');
  assert.match(app, /onOpenAuthority=\{openAuthority\}/);
  assert.match(app, /window\.history\.pushState\(\{ altSub: 'authority' \}, '', '\/\?tab=controls&view=authority'\)/, 'its own history entry');
  assert.match(app, /addEventListener\('popstate', onPop\)/, 'the browser / system back is handled');
  assert.match(app, /className="v2-link v2-back" onClick=\{backToControls\} aria-label="Back to Controls"/, 'a labelled way back');
  assert.match(app, /route\.tab === 'controls' && route\.sub === 'authority'/);
  assert.match(app, /setRoute\(\{ tab: r\.tab, focus: null, sub: null \}\)/, 'choosing a tab leaves the pushed view');
  // The deep link reads only under Controls.
  assert.equal(model.subFromSearch('?tab=controls&view=authority', 'controls'), 'authority');
  assert.equal(model.subFromSearch('?tab=now&view=authority', 'now'), null);
  assert.equal(model.subFromSearch('?tab=controls', 'controls'), null);
  assert.equal(model.subFromSearch('?view=authority', 'saim'), null);
});

test('one bar: Alt keeps its six destinations, SAiM’s page is untouched, nothing new reaches NEURO', () => {
  const shell = read('Shell.jsx');
  assert.doesNotMatch(shell, /authority|May do/i, 'no seventh tab in the bar');
  for (const f of ['SaimPage.jsx', 'WorkingFixture.jsx', 'NowPage.jsx', 'Dock.jsx']) assert.doesNotMatch(read(f), /authority|May do|What SAiM may do/i, `${f} is not cluttered`);
  // The only route it can reach is the human-only one the Authority screen already uses.
  const flow = fs.readFileSync(path.join(ALT, '..', 'src', 'authority.mjs'), 'utf8');
  assert.match(flow, /const BASE = '\/api\/saim-authority';/);
  assert.doesNotMatch(read('App.jsx') + read('ControlsPage.jsx'), /saim-authority|feature-flags|SAIM_PREPARED_MOVE_EXECUTION/, 'Alt adds no route, flag or lock access of its own');
});
