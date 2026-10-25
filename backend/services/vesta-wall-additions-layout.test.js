'use strict';
/**
 * The family wall additions in a REAL BROWSER (Electron's Chromium), 25 Oct 2026.
 *
 * Layout: the cinema wall with every new piece showing at once (tea, two
 * countdowns, an overdue walk banner, the outlook, care in the jobs tile, the
 * dock) must fit the kitchen iPad (1024×748) and 1180×820 with NO scrolling and
 * nothing overlapping — on the iPad and in room-screen mode with SAiM's fusion
 * slots drawn.
 *
 * Behaviour (the live React app, hydrated): a shopping tick and an Undo call
 * NEURO with the right words and show "Saving…" first; a refused house press
 * says "Not saved — <the server's words>" and the light is NOT flipped locally.
 *
 * Skips (and says so) when no Electron binary is found — the layout is then
 * NOT verified. Screenshots: WALL_SHOTS=<dir> keeps them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VESTA = path.join(ROOT, 'vesta');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT);

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(MAIN_CHECKOUT, 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function vestaModules() {
  for (const b of [path.join(VESTA, 'node_modules'), path.join(MAIN_CHECKOUT, 'vesta', 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}

const ENTRY = (wallCinema) => `
import { createRoot } from 'react-dom/client';
import { createElement as h, useState } from 'react';
import { CinemaView } from ${JSON.stringify(wallCinema)};
const CASE = window.__CASE;
window.__calls = [];
const later = (v, ms = 400) => new Promise((r) => setTimeout(() => r(v), ms));
const act = {
  task: async () => ({ ok: true }), addTask: async () => ({ ok: true }),
  event: { add: async () => ({ ok: true }), update: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  tea: async (d, t) => { window.__calls.push(['tea', d, t]); return later({ ok: true }); },
  note: { add: async (t) => { window.__calls.push(['note', t]); return later({ ok: true }); }, clear: async (id) => { window.__calls.push(['clear', id]); return later({ ok: true }); } },
  countdown: async (b) => { window.__calls.push(['countdown', b]); return later({ ok: true }); },
  shopping: {
    add: async (n) => { window.__calls.push(['shop-add', n]); return later({ ok: true, already: false }); },
    bought: async (n, undo) => { window.__calls.push(['bought', n, undo]); return later({ ok: true }); },
  },
  home: {
    get: async () => { window.__calls.push(['home-get']); return CASE.home; },
    control: async (e, a) => { window.__calls.push(['home', e, a]); return later({ ok: false, verified: false, state: 'on', say: 'That light didn\\u2019t answer' }); },
  },
};
const fusion = CASE.screen ? { field: h('div', { id: 'saimfield', style: { position: 'absolute', inset: 0, background: 'rgba(240,164,58,0.05)' } }), line: 'It\\u2019s 17 in here. Want it warmed to 20?', card: h('div', { id: 'saimoffer', style: { width: 300, height: 60, background: '#222' } }, 'Warm it') } : null;
const now = new Date(2026, 9, 25, 14, 5);
createRoot(document.getElementById('root')).render(h(CinemaView, { data: CASE.data, now, act, fusion, cal: { view: 'today', offset: 0, range: { from: CASE.data.from, days: CASE.data.days }, onStep() {}, onToday() {}, onView() {} } }));
setTimeout(() => { window.__ready = true; }, 300);
`;

function busyData() {
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(2026, 9, 25 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: key, events: [], work: null, off: false });
  }
  days[0].events.push({ id: 'a', title: 'Half term', allDay: true, start: '2026-10-25T00:00:00', end: '2026-10-26T00:00:00' },
    { id: 'b', title: 'Isaac football', start: '2026-10-25T15:00:00', end: '2026-10-25T16:00:00', countdownKey: 'b@2026-10-25', countdown: false },
    { id: 'c', title: 'Dinner at Grandma’s', start: '2026-10-25T18:00:00', end: '2026-10-25T20:00:00' });
  days[1].events.push({ id: 'd', title: 'Isaac swimming', start: '2026-10-26T17:00:00', end: '2026-10-26T18:00:00' });
  days[1].work = { allDay: false, start: '2026-10-26T09:00:00', end: '2026-10-26T17:30:00' };
  return {
    scopes: ['tasks', 'calendar', 'house', 'kitchen', 'hike', 'home-control', 'energy'],
    today: '2026-10-25', from: '2026-10-25', days: 42, gaps: [], week: days,
    tasks: { total: 6, tasks: [
      { id: 1, text: 'Clean the gutters', short: 'Clean gutters', dueDate: '2026-10-20', overdue: true, dueToday: false, who: ['Nick'] },
      { id: 2, text: 'Book the boiler service', short: 'Book boiler service', dueDate: null, overdue: false, dueToday: false, who: [] }] },
    who: { known: true, people: [
      { id: 'nick', name: 'Nick', role: 'person', state: 'out' }, { id: 'helen', name: 'Helen', role: 'person', state: 'home' },
      { id: 'isaac', name: 'Isaac', role: 'person', state: 'home' }, { id: 'ember', name: 'Ember', role: 'companion', state: 'out' }] },
    station: { known: true, tempC: 11.4, humidityPct: 82, pressureHpa: 1009, tendency: 'falling slowly', condition: 'rainy', conditionLabel: 'Rainy' },
    energy: { connected: true, monthCostP: 7500, fuels: {
      electricity: { yesterday: { kwh: 9.4, costP: 260, complete: true }, month: { kwh: 150, costP: 4160 }, freshness: { state: 'usual' }, days: [] },
      gas: { yesterday: { kwh: 31.2, costP: 180, complete: true }, month: { kwh: 499, costP: 3340 }, freshness: { state: 'usual' }, days: [] } } },
    outlook: { known: true, today: { highC: 14, lowC: 7, rainChance: 60 }, tomorrow: { highC: 13, lowC: 6, rainChance: 40 }, rain: { state: 'arriving', say: 'Rain likely from about 15:20' } },
    tea: { today: 'Spaghetti bolognese', days: [{ date: '2026-10-25', text: 'Spaghetti bolognese' }], recent: ['Spaghetti bolognese', 'Fish pie'] },
    notes: [{ id: 'n1', text: 'Parcel is in the shed', by: 'Helen', at: '2026-10-25T09:30:00' }],
    countdowns: [{ key: 'h', title: 'Isaac’s birthday', date: '2026-10-30', days: 5, say: 'in 5 days' }, { key: 'x', title: 'Christmas', date: '2026-12-25', days: 61, say: 'in 61 days' }],
    walk: { active: true, state: 'overdue', name: 'Kinder Scout', start: '2026-10-25T10:00:00', due: '2026-10-25T13:30:00', alertAt: '2026-10-25T14:30:00', minutesLate: 35, route: [], trail: [], emberTrail: [], positions: [] },
    care: [{ id: 'c1', title: 'Worming', companion: 'Ember', dueDate: '2026-10-22', say: 'Worming 3 days overdue', overdue: true }],
    shopping: { exists: true, toBuy: [{ name: 'Milk', added: '2026-10-25' }, { name: 'Bread', added: '2026-10-25' }], bought: [{ name: 'Butter' }] },
  };
}
const HOME = { ok: true, known: true, lightsOn: 1, why: null, rooms: [
  { id: 'living', name: 'Living room', tempC: 19.5, targetC: 18, boost: { on: false, untilHHMM: null }, climate: 'climate.living_room_rad',
    lights: [{ entity: 'light.anwio_smart_light_3', name: 'Living room 1', state: 'on' }], sockets: [] }] };

const DRIVER = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const jobs = JSON.parse(fs.readFileSync(process.env.WALL_JOBS, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); app.exit(2); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = [];
  for (const j of jobs) {
    const win = new BrowserWindow({ width: j.w, height: j.h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
    win.setContentSize(j.w, j.h);
    const url = 'data:text/html;charset=utf-8;base64,' + fs.readFileSync(j.file).toString('base64');
    try { await win.loadURL(url); } catch { await sleep(400); await win.loadURL(url); }
    const js = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; i < 100 && !(await js('!!window.__ready')); i++) await sleep(100);
    await sleep(300);
    const m = await js(\`(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      const vw = document.documentElement.clientWidth, vh = innerHeight;
      const over = [...document.querySelectorAll('.cine__layout *')].filter((e) => !e.closest('.cine__sdays')).filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > vw + 1 || b.bottom > vh + 1); }).slice(0, 6).map((e) => e.className || e.tagName);
      const leftKids = [...document.querySelectorAll('.cine__left > *')].map((e) => e.getBoundingClientRect().bottom);
      return { vw, vh, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, over,
        leftBottom: Math.max(...leftKids), left: r('.cine__left'), right: r('.cine__right'), outside: r('.cine__outside'), dock: r('.cine__dock'),
        bits: r('.cine__bits'), chips: r('.cine__chipsr'), chipW: Math.min(...[...document.querySelectorAll('.cine__chipsr > *')].map((e) => e.getBoundingClientRect().width)), topR: r('.cine__top'), layoutR: r('.cine__layout'), walk: r('.cine__walkbanner'), walkClipped: (() => { const e = document.querySelector('.cine__walkbanner'); return e ? e.scrollWidth > e.clientWidth + 1 : null; })(), panels: r('.cine__panels'), strip: r('.cine__strip'), card: r('.cine__saimcard'),
        line: r('.cine__saimline'), field: !!document.getElementById('saimfield'), offer: !!document.getElementById('saimoffer'),
        dockBtns: [...document.querySelectorAll('.cine__dockbtn')].map((b) => Math.round(b.getBoundingClientRect().height)) };
    })()\`);
    if (process.env.WALL_SHOTS) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(process.env.WALL_SHOTS, j.name + '-' + j.w + 'x' + j.h + '.png'), img.toPNG()); }
    const res = { name: j.name, w: j.w, h: j.h, ...m };
    if (j.interact) {
      const click = (sel) => js(\`(() => { const e = document.querySelector(\${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()\`);
      const txt = () => js('document.querySelector(".cine__sheet") ? document.querySelector(".cine__sheet").innerText : ""');
      const steps = {};
      steps.openShop = await click('.cine__dockbtn[aria-label^="Shopping"]'); await sleep(150);
      steps.shopOpen = await txt();
      steps.tick = await click('[aria-label="Got Milk"]'); await sleep(80);
      steps.duringTick = await txt();
      await sleep(600); steps.afterTick = await txt();
      steps.undo = await click('[aria-label="Undo — Butter not bought"]'); await sleep(700); steps.afterUndo = await txt();
      if (process.env.WALL_SHOTS) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(process.env.WALL_SHOTS, j.name + '-shopping.png'), img.toPNG()); }
      await click('.cine__sheethead .cine__sheetbtn'); await sleep(150);
      steps.openHome = await click('.cine__dockbtn[aria-label="Home"]'); await sleep(500);
      steps.homeOpen = await txt();
      steps.press = await click('[aria-label="Living room 1 is on — turn it off"]'); await sleep(80);
      steps.duringPress = await txt();
      await sleep(900); steps.afterPress = await txt();
      steps.stillOn = await js('!!document.querySelector(\\'[aria-label="Living room 1 is on — turn it off"]\\')');
      if (process.env.WALL_SHOTS) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(process.env.WALL_SHOTS, j.name + '-home.png'), img.toPNG()); }
      steps.homeSheet = await js('(() => { const b = document.querySelector(".cine__sheet").getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; })()');
      steps.calls = await js('window.__calls');
      res.steps = steps;
    }
    out.push(res);
    win.destroy();
  }
  fs.writeFileSync(process.env.WALL_OUT, JSON.stringify(out));
  app.quit();
});
`;

let results = null;
let skipWhy = null;

test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — layout NOT verified'; return; }
  const mods = vestaModules();
  if (!mods) { skipWhy = 'VESTA’s node_modules (React) not installed — layout NOT verified'; return; }
  const esbuild = require('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-additions-'));
  const entry = path.join(dir, 'entry.jsx');
  fs.writeFileSync(entry, ENTRY(path.join(VESTA, 'src', 'views', 'WallCinema.jsx').replace(/\\/g, '/')));
  const out = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    nodePaths: [mods], loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  // App.css first, as in the app: it carries `* { box-sizing: border-box }`, without which the layout's padding overflows on its own.
  const css = [['src', 'App.css'], ['src', 'views', 'Wall.css'], ['src', 'views', 'WallCinema.css']].map((f) => fs.readFileSync(path.join(VESTA, ...f), 'utf8')).join('\n');
  const bundle = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const jobs = [];
  for (const screen of [false, true]) {
    const name = screen ? 'room-screen' : 'ipad';
    const file = path.join(dir, `${name}.html`);
    const data = busyData();
    if (process.env.WALL_PLAIN) { for (const k of ['outlook', 'tea', 'notes', 'countdowns', 'walk', 'care', 'shopping']) delete data[k]; data.scopes = ['tasks', 'calendar', 'house', 'energy']; }
    const CASE = { data, home: HOME, screen };
    fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#050608}*{transition:none!important;animation:none!important}${css}</style></head><body><div id="root"></div><script>window.__CASE=${JSON.stringify(CASE)};</script><script>${bundle}</script></body></html>`);
    for (const [w, h] of [[1024, 748], [1180, 820]]) jobs.push({ name, file, w, h, interact: !screen && w === 1024 && !process.env.WALL_PLAIN });
  }
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'wall-measure', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), DRIVER);
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(jobs));
  const env = { ...process.env, WALL_JOBS: path.join(dir, 'jobs.json'), WALL_OUT: path.join(dir, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (env.WALL_SHOTS) fs.mkdirSync(env.WALL_SHOTS, { recursive: true });
  const r = spawnSync(bin, [appDir], { env, timeout: 180000, encoding: 'utf8' });
  if (!fs.existsSync(env.WALL_OUT)) throw new Error(`Electron produced no measurements (status ${r.status}): ${(r.stderr || '').slice(0, 800)}`);
  results = JSON.parse(fs.readFileSync(env.WALL_OUT, 'utf8'));
  if (process.env.WALL_REPORT) for (const m of results) console.log(JSON.stringify({ n: m.name, w: m.w, top: m.topR, right: m.right, outside: m.outside, dock: m.dock, left: m.left, layout: m.layoutR, over: m.over }));
  if (process.env.WALL_REPORT) for (const m of results) console.log(`[wall] ${m.name} ${m.w}x${m.h}: left bottom ${Math.round(m.leftBottom)}, right ${m.right && Math.round(m.right.bottom)}, panels ${Math.round(m.panels.top)}–${Math.round(m.panels.bottom)}, strip ${Math.round(m.strip.bottom)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

const overlap = (a, b) => a && b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

test('every new piece fits 1024×748 and 1180×820 with no scrolling — iPad and room screen', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.equal(results.length, 4, 'positive control: all four screens measured');
  for (const m of results) {
    const at = `${m.name} @${m.w}x${m.h}`;
    assert.ok(m.sw <= m.vw && m.sh <= m.vh, `${at}: page scrolls (${m.sw}x${m.sh})`);
    assert.deepEqual(m.over, [], `${at}: something runs off the screen`);
    assert.ok(m.bits && m.walk && m.chips, `${at}: positive control — the walk, tea and countdowns drawn`);
    assert.ok(m.dock, `${at}: the dock is drawn`);
    assert.equal(m.walkClipped, false, `${at}: the walk banner is cut short`);
    assert.ok(m.leftBottom <= m.panels.top + 1, `${at}: the clock column (${Math.round(m.leftBottom)}) runs into the panels (${Math.round(m.panels.top)})`);
    assert.ok(m.right.bottom <= m.panels.top + 1, `${at}: Outside + dock run into the panels`);
    assert.ok(!overlap(m.dock, m.outside), `${at}: the dock overlaps the Outside tile`);
    assert.ok(!overlap(m.chips, m.dock) && !overlap(m.chips, m.outside), `${at}: tea/countdowns overlap the dock or Outside`);
    assert.ok(m.chipW >= 80, `${at}: a tea/countdown chip is squashed to ${Math.round(m.chipW)}px`);
    assert.ok(!overlap(m.left, m.right), `${at}: the clock column and the right column overlap`);
    assert.ok(m.strip.bottom <= m.vh + 1, `${at}: the strip is cut off`);
    for (const hgt of m.dockBtns) assert.ok(hgt >= 44, `${at}: a dock button is ${hgt}px tall (< 44)`);
  }
});

test('room screens keep SAiM’s fusion slots alongside the new pieces', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results.filter((x) => x.name === 'room-screen')) {
    assert.ok(m.field && m.offer && m.line, `@${m.w}: field, offer card and her line are all drawn`);
    assert.ok(m.line.bottom <= m.panels.top, `@${m.w}: her line sits in the clock column`);
  }
});

test('a shopping tick and an Undo go to NEURO and say Saving… first; a refused house press says Not saved and flips nothing', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const s = results.find((x) => x.steps).steps;
  assert.ok(s.openShop && s.shopOpen.includes('Milk') && s.shopOpen.includes('Butter'), 'the shopping sheet opens from the dock');
  assert.ok(s.tick && s.duringTick.includes('Saving…'), 'Saving… while NEURO answers');
  assert.ok(s.afterTick.includes('Got Milk.'), 'then what NEURO said');
  assert.ok(s.undo && s.afterUndo.includes('Butter is back on the list.'));
  const calls = s.calls.map((c) => JSON.stringify(c));
  assert.ok(calls.includes(JSON.stringify(['bought', 'Milk', false])), 'tick = bought, not undo');
  assert.ok(calls.includes(JSON.stringify(['bought', 'Butter', true])), 'Undo = undo:true');
  assert.ok(s.openHome && s.homeOpen.includes('Living room 1') && s.homeOpen.includes('Boost 1 hr'), 'the Home sheet reads the house on open');
  assert.ok(s.press && s.duringPress.includes('Saving…'));
  assert.ok(s.afterPress.includes('Not saved — That light didn’t answer'), 'the server’s own words');
  assert.ok(s.stillOn, 'the light still shows ON: nothing changed locally');
  assert.ok(calls.includes(JSON.stringify(['home', 'light.anwio_smart_light_3', 'off'])));
  assert.ok(s.calls.filter((c) => c[0] === 'home-get').length >= 2, 're-read after the press');
  assert.ok(s.homeSheet.bottom <= 748 + 1 && s.homeSheet.top >= -1, 'the Home sheet fits the iPad');
});
