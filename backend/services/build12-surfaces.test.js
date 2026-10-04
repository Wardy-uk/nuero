'use strict';

/**
 * Build 12 wiring: the shared AttentionSurface draws the adaptive composition
 * when (and only when) the payload carries a presentation, every shell reads
 * the canonical Now, the kiosk door is exact, the kiosk declares itself, and
 * the desktop renders the same composition in its own profile.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const FIELD_STUB = 'export default function Field() { return null; }\nexport const isPressing = () => false;\n';

let Surface;
test.before(async () => {
  global.window = global.window || { location: { search: '' }, innerWidth: 390, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'saim', 'shared-ui', 'AttentionSurface.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)Field(\.jsx)?$/ }, () => ({ path: 'field', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: FIELD_STUB, loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Surface = mod.exports.default;
});

function payloadFor(id) {
  const f = FIXTURES.find((x) => x.id === id);
  return { ...f.payload, presentation: composePresentation(f.payload, { now: f.at }) };
}

test('situation layout renders the presentation, in the profile it is given', () => {
  const html = renderToString(React.createElement(Surface, { data: payloadFor('calm-saturday'), layout: 'situation', profile: 'kiosk' }));
  assert.match(html, /surface--situation/);
  assert.match(html, /data-profile="kiosk"/);
  assert.match(html, /Quiet Saturday/);
});

test('positive control: without a presentation the same call falls back to the old composition', () => {
  const data = { ...payloadFor('calm-saturday'), presentation: null };
  const html = renderToString(React.createElement(Surface, { data, layout: 'situation', profile: 'phone' }));
  assert.doesNotMatch(html, /surface--situation/);
  assert.match(html, /surface__content/);
});

test('the primary keeps its five verbs on the phone, through the shell’s onAct', () => {
  const html = renderToString(React.createElement(Surface, {
    data: payloadFor('working-busy'), layout: 'situation', profile: 'phone', onAct: async () => ({}), onOpen() {},
  }));
  assert.match(html, /Reply to Simon about renewals/);
  assert.match(html, /That&#x27;s done|That’s done/);
  assert.match(html, /Not now/);
});

test('the mic slot is a PROP and reaches the phone composition', () => {
  const mic = React.createElement('button', { className: 'mic-probe' }, 'TALK TO ME');
  const html = renderToString(React.createElement(Surface, { data: payloadFor('calm-saturday'), layout: 'situation', profile: 'phone', deviceSlot: mic }));
  assert.match(html, /mic-probe/);
  const src = read('saim', 'shared-ui', 'AttentionSurface.jsx');
  const dataBlock = src.slice(src.indexOf('const {\n    context, primary'), src.indexOf('} = data;'));
  assert.doesNotMatch(dataBlock, /deviceSlot/, 'never read off the payload again');
});

test('every SAiM shell reads the canonical Now, and the kiosk door for it is EXACT', () => {
  assert.match(read('saim', 'app', 'src', 'views', 'Surface.jsx'), /apiFetch\(`\/api\/canonical\/now/);
  const proxy = read('saim', 'backend', 'src', 'routes', 'neuroProxy.js');
  assert.match(proxy, /'\/canonical\/now',/);
  const doors = proxy.slice(proxy.indexOf('const DOORS'), proxy.indexOf(']);'));
  assert.doesNotMatch(doors.replace(/\/\/.*$/gm, ''), /'canonical'/, 'the canonical segment holds life-model writes and stays closed');
  const { isAllowed } = require(path.join(ROOT, 'saim', 'backend', 'src', 'routes', 'neuroProxy.js'))._internals || {};
  if (isAllowed) {
    assert.equal(isAllowed('/canonical/now'), true);
    assert.equal(isAllowed('/canonical/goals'), false);
  }
});

test('the kiosk build declares itself; Electron is never ambient', () => {
  assert.match(read('saim', 'frontend', 'src', 'main.jsx'), /declarePlatform\('kiosk'\)/);
  const plat = read('saim', 'shared-ui', 'presentation', 'platform.mjs');
  assert.ok(plat.indexOf("window.saimNative) return 'electron'") < plat.indexOf('if (declared) return declared'), 'Electron outranks the kiosk declaration');
});

test('situation is the default look; the corridor and the list stay reachable on the URL', () => {
  const src = read('saim', 'app', 'src', 'views', 'Surface.jsx');
  assert.match(src, /lookParam === 'list' \|\| lookParam === 'approach' \? lookParam : 'situation'/);
});

test('the desktop Now draws the shared composition in the desktop profile and does not draw NowSituation beside it', () => {
  const src = read('frontend', 'src', 'components', 'AdhdPanel.jsx');
  assert.match(src, /<Situation[\s\S]*profile="desktop"/);
  assert.match(src, /!\(attention\.data\?\.presentation[^)]*\) && \(\s*<NowSituation/);
});

test('the kiosk hides its thumb-sized nav on the ambient surface, behind a deliberate reveal', () => {
  const src = read('saim', 'frontend', 'src', 'App.jsx');
  assert.match(src, /const ambientChrome = active === 'surface' && platformNow\(\) === 'kiosk'/);
  assert.match(src, /<nav className="app__nav" aria-label="SAiM" hidden=\{hideChrome\}>/);
  assert.match(src, /className="app__reveal"/);
});

test('native iOS reads the same presentation and its budget only cuts (cross-repo guard)', (t) => {
  const IOS = path.resolve(ROOT, '..', 'nuero-ios');
  if (!fs.existsSync(IOS)) { t.skip('nuero-ios not checked out beside this repo'); return; }
  const model = fs.readFileSync(path.join(IOS, 'NeuroKit', 'Sources', 'NeuroKit', 'Presentation.swift'), 'utf8');
  assert.match(model, /\/api\/canonical\/presentation/);
  assert.doesNotMatch(model, /\.sorted|\.sort\(/);
  const surface = fs.readFileSync(path.join(IOS, 'Saim', 'SurfaceView.swift'), 'utf8');
  assert.match(surface, /SituationView\(/);
  assert.match(surface, /Show me everything/, 'the classic surface stays one tap away');
});

test('a wall gets no mic from capability alone; the phone does', () => {
  const mic = React.createElement('button', { className: 'mic-probe' }, 'TALK TO ME');
  const wall = renderToString(React.createElement(Surface, { data: payloadFor('calm-saturday'), layout: 'situation', profile: 'kiosk', deviceSlot: mic }));
  assert.doesNotMatch(wall, /mic-probe/);
  const phone = renderToString(React.createElement(Surface, { data: payloadFor('calm-saturday'), layout: 'situation', profile: 'phone', deviceSlot: mic }));
  assert.match(phone, /mic-probe/);
});
