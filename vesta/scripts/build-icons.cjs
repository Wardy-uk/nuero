#!/usr/bin/env node
// Builds VESTA's app icons from the ONE set of mark paths in
// src/components/Brand.jsx (Nick's hearth logo, 7 Nov 2026):
//   public/icon.svg               — the favicon (and the source for the PNGs)
//   public/icon-192.png, -512.png — the PWA icons (maskable: the mark sits
//                                   inside the central safe zone)
//   public/apple-touch-icon.png   — 180×180
// The PNGs are rendered by Electron (borrowed from saim/desktop-electron), so
// run this on a machine that has it: `node scripts/build-icons.cjs`.
// vesta-brand.test.js fails if icon.svg stops matching Brand.jsx.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VESTA = path.join(__dirname, '..');
const BG = '#1a1512';        // the manifest's theme/background colour
const RING = '#f6efe7';      // ivory on the dark ground

function markParts() {
  const src = fs.readFileSync(path.join(VESTA, 'src', 'components', 'Brand.jsx'), 'utf8');
  const get = (re) => { const m = src.match(re); if (!m) throw new Error(`Brand.jsx: ${re} not found`); return m[1]; };
  return {
    viewBox: get(/MARK_VIEWBOX = '([^']+)'/),
    flame: get(/MARK_FLAME = '([^']+)'/),
    ring: get(/ring: '([^']+)'/),
    tall: get(/tall: '([^']+)'/),
    short: get(/short: '([^']+)'/),
  };
}

/** The square icon: the mark ~64% wide, centred on the theme colour. */
function iconSvg(p = markParts()) {
  const [, , vw, vh] = p.viewBox.split(/\s+/).map(Number);
  const w = 512 * 0.64; const h = w * (vh / vw);
  const x = (512 - w) / 2; const y = (512 - h) / 2 + 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BG}"/>
  <svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="${p.viewBox}">
    <path d="${p.ring}" fill="${RING}"/>
    <path d="${p.tall}" fill="${p.flame}"/>
    <path d="${p.short}" fill="${p.flame}"/>
  </svg>
</svg>
`;
}

function main() {
  const svg = iconSvg();
  fs.writeFileSync(path.join(VESTA, 'public', 'icon.svg'), svg);
  let bin;
  try { bin = require(require.resolve('electron', { paths: [path.join(VESTA, '..', 'saim', 'desktop-electron')] })); } catch { bin = null; }
  if (!bin || typeof bin !== 'string') { console.log('icon.svg written; no Electron here, PNGs NOT rebuilt'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesta-icons-'));
  const jobs = [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png']]
    .map(([size, name]) => ({ size, out: path.join(VESTA, 'public', name) }));
  fs.writeFileSync(path.join(dir, 'icon.svg'), svg);
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(jobs));
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), '{"name":"vesta-icons","main":"main.js"}');
  fs.writeFileSync(path.join(dir, 'app', 'main.js'), `
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
const dir = ${JSON.stringify(dir)};
const jobs = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8'));
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const j of jobs) {
    const w = new BrowserWindow({ width: j.size, height: j.size, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true, zoomFactor: 1 } });
    w.setContentSize(j.size, j.size);
    const html = '<!doctype html><body style="margin:0;overflow:hidden">' + svg.replace('<svg ', '<svg width="' + j.size + '" height="' + j.size + '" style="display:block" ') + '</body>';
    await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html).toString('base64'));
    await new Promise((r) => setTimeout(r, 300));
    let img = await w.webContents.capturePage();
    if (img.getSize().width !== j.size) img = img.resize({ width: j.size, height: j.size, quality: 'best' });
    fs.writeFileSync(j.out, img.toPNG()); w.destroy();
  }
  app.quit();
});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(bin, [path.join(dir, 'app')], { env, timeout: 60000, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`Electron failed: ${(r.stderr || '').slice(0, 500)}`);
  console.log('icon.svg, icon-192.png, icon-512.png, apple-touch-icon.png written');
}

module.exports = { iconSvg, markParts };
if (require.main === module) main();
