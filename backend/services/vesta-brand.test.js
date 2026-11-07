'use strict';
/**
 * VESTA's lockup and the "Powered by NEURO" attribution (7 Nov 2026), rendered
 * for real (esbuild + React server render):
 *   - the NEURO mark is NEURO's own connected-node network — VESTA keeps a
 *     COPY (it builds on its own), pinned node for node to frontend/BrandMarks;
 *   - the attribution is one run of text with the build beneath, from the
 *     label it is given (never a hard-coded version);
 *   - the wall footer actually mounts it;
 *   - the app icons are generated from the same mark paths.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

async function load(file) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const React = require('react');
const { renderToString } = require('react-dom/server');

const BRAND = path.join(ROOT, 'vesta', 'src', 'components', 'Brand.jsx');

test('the NEURO mark is NEURO’s own network, node for node', async () => {
  const B = await load(BRAND);
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'BrandMarks.jsx'), 'utf8');
  const grab = (name) => JSON.parse(src.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1].replace(/,\s*\]$/, ']'));
  assert.ok(B.NEURO_NODES.length > 0, 'positive control: the copy exists');
  assert.deepEqual(B.NEURO_NODES, grab('NEURO_NODES'));
  assert.deepEqual(B.NEURO_LINKS, grab('NEURO_LINKS'));
  const html = renderToString(React.createElement(B.NeuroMark));
  assert.equal((html.match(/<circle /g) || []).length, B.NEURO_NODES.length);
  assert.ok(!/ellipse|orbit/i.test(html), 'not the orbit mark');
});

test('"Powered by NEURO": one line of one size, the build beneath, from the label given', async () => {
  const B = await load(BRAND);
  const html = renderToString(React.createElement(B.PoweredByNeuro, { build: 'abc1234' }));
  assert.ok(/<span class="vbrand__poweredline">Powered by <svg[^>]*class="vbrand__neuro"[\s\S]*<\/svg> NEURO<\/span>/.test(html), 'text, mark and NEURO in one run');
  assert.ok(!/<(b|strong)\b/.test(html), 'NEURO is not set heavier than the rest');
  assert.ok(html.includes('<span class="vbrand__build">v abc1234</span>'), 'the build it was given');
  assert.ok(!renderToString(React.createElement(B.PoweredByNeuro, {})).includes('vbrand__build'), 'no label: no invented version');
  const css = fs.readFileSync(path.join(ROOT, 'vesta', 'src', 'components', 'Brand.css'), 'utf8');
  assert.ok(/\.vbrand__poweredline \{[^}]*font-size: inherit;[^}]*font-weight: 400;/.test(css), 'same size and weight as the footer');
  assert.ok(/\.vbrand__neuro \{[^}]*height: 1em;/.test(css), 'the mark is the text’s height');
});

test('the lockup carries its name as text, and the wall footer mounts the attribution', async () => {
  const B = await load(BRAND);
  const html = renderToString(React.createElement(B.VestaLockup));
  assert.ok(html.includes('Versatile Everyday Space for Tasks &amp; Answers'));
  assert.ok(html.includes('class="vbrand__word"') && html.includes('class="vbrand__mark"'), 'SVG wordmark and the hearth mark, not a font');
  for (const d of Object.values(B.MARK_PATHS)) assert.ok(html.includes(`d="${d}"`), 'the lockup draws the hearth mark’s own paths');
  const wall = fs.readFileSync(path.join(ROOT, 'vesta', 'src', 'views', 'Wall.jsx'), 'utf8');
  assert.ok(wall.includes('<PoweredByNeuro build={api.BUILD_LABEL} />'), 'the footer shows the real build label');
  assert.ok(!/c8abb/.test(wall + fs.readFileSync(BRAND, 'utf8')), 'the mockup’s version is not hard-coded');
});

test('the app icons are the hearth mark: icon.svg is what build-icons.cjs makes from Brand.jsx', async () => {
  const B = await load(BRAND);
  const { iconSvg } = require(path.join(ROOT, 'vesta', 'scripts', 'build-icons.cjs'));
  const svg = fs.readFileSync(path.join(ROOT, 'vesta', 'public', 'icon.svg'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout may hold CRLF
  assert.equal(svg, iconSvg(), 'public/icon.svg is stale — run `node vesta/scripts/build-icons.cjs`');
  for (const d of Object.values(B.MARK_PATHS)) assert.ok(svg.includes(`d="${d}"`), 'the icon uses the mark’s own paths');
  const index = fs.readFileSync(path.join(ROOT, 'vesta', 'index.html'), 'utf8');
  assert.ok(index.includes('href="/icon.svg"') && index.includes('href="/apple-touch-icon.png"'), 'the page names the icons');
});
