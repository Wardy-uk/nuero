'use strict';

/**
 * Build Brief 003 — the SAiM workspace in the REAL NEURO Desktop app, in
 * Electron's Chromium, against a stub NEURO that records every request.
 *
 * The real `App` is bundled (auth, shell, Sidebar, routing, the flag hook,
 * lazy SaimWorkspace, the shared NowScene/Situation), so the launch rules are
 * observed, not asserted from source:
 *   off           flag off, plain launch          → Now
 *   unreadable    /api/feature-flags fails (500)   → Now
 *   on            flag on, plain launch            → SAiM, URL ?view=saim, SAiM first in the sidebar
 *   on-today      flag on, ?view=today             → Now
 *   rollback      flag on then switched off        → Now again on the next launch
 * Measured at 1440×900 and 1920×1080 (the SAiM state also at 1024×552):
 * scene and Why strip rendered, no sideways overflow. Writes made by the
 * workspace are counted; the shell's own telemetry (/api/activity/*) is the
 * app's existing behaviour and is reported separately.
 *
 * Skips, saying why, without an Electron binary (ELECTRON_PATH) or React.
 *   SAIM_WS_SHOTS=<dir>  keeps the PNGs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const support = require('./electron-driver-support');
const MAIN_CHECKOUT = support.mainCheckout(ROOT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-ws-'));
const SHOTS = process.env.SAIM_WS_SHOTS || path.join(tmp, 'shots');

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const b of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(MAIN_CHECKOUT, 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [b] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactDir() {
  for (const b of [path.join(ROOT, 'frontend', 'node_modules'), path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}

// ── The payload: the REAL pipeline, a working morning with urgent capacity held work beside it ──
const NOW = Date.now();
const CS = require('./context-state');
const AT = require('./attention');
const PI = require('./presentation-intent');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
function canonicalNow() {
  const ctx = CS.resolveContext({
    calendar: { known: true, events: [] }, focusSession: { known: true, session: null }, queue: { known: true, breaching: 0, escalations: 0 },
    location: { known: true, place: 'home' }, presence: { known: true, state: 'present' }, rituals: { known: true, standupDone: true, eodDone: false },
    workingDay: { known: true, isWorkingDay: true, reason: null },
  }, new Date(NOW));
  const pool = [
    { type: 'capacity', id: 'capacity-over-x', dedupeKey: 'capacity:over:x', recordId: 'rec-cap', title: 'More work due by the end of today than you have time for', say: '6h due, 2h free — 4h short.', score: 80, urgency: 'high', tier: 1, source: 'neuro', actions: ['acknowledge', 'defer'] },
    { type: 'email', id: 'email-1', title: 'Reply to Chris about the Q3 numbers', reason: 'Waiting 2 days', score: 60, urgency: 'medium', tier: 2 },
  ];
  const g = AT.gate(ctx, pool, new Date(NOW));
  const p = { context: ctx, life: { doing: 'working', label: 'Working', showWork: true, confidence: 'likely', place: { kind: 'home', label: 'study' } },
    poolAvailable: true, gaps: [{ input: 'radar', why: 'sabotaged for the test' }], approvals: { known: true, needsApproval: 0, needsReview: 0 },
    primary: g.primary, secondary: g.secondary, dropped: g.dropped, quiet: false, generatedAt: new Date(NOW).toISOString(), situation: null, contract: 'canonical-v1' };
  p.presentation = PI.composePresentation(p, { now: NOW });
  const facts = { calendar: [], calendarKnown: true, approvals: [], taskDomains: new Map(), workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: null, todayEnd: null, nextStart: null } };
  p.saim = POL.decide(NC.compose({ ...p, work: { atDesk: true, deskKnown: true }, utterances: [], situation: { sections: {} } }, { rows: [], block: null, session: null }, facts, { now: NOW }), { surface: 'work-desktop', now: NOW });
  return p;
}
const NOW_PAYLOAD = canonicalNow();
const ADHD = { generatedAt: new Date(NOW).toISOString(), shape: { mode: 'morning', line: 'Morning.' }, rightNow: null, session: null, recovery: null, signals: null, blockNow: null,
  momentum: { doneToday: 0, doneThisWeek: 0, total: 0, typical: 0, rituals: { standup: true, eod: false }, last7: [] }, winsToday: [], avoidance: { signals: [] }, quickWins: [], openTasks: 0, gaps: [] };

const SCENARIOS = [
  { name: 'off', flag: 'off', url: '/', sizes: [[1440, 900]] },
  { name: 'unreadable', flag: 'error', url: '/', sizes: [[1440, 900]] },
  { name: 'on', flag: 'on', url: '/', sizes: [[1440, 900], [1920, 1080], [1024, 552]] },
  { name: 'on-today', flag: 'on', url: '/?view=today', sizes: [[1440, 900]] },
  { name: 'rollback', flag: 'off', url: '/', sizes: [[1440, 900]] },
];

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const over = [...document.querySelectorAll('.saim-ws *, .adhd *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName));
  const primaryLabels = [...document.querySelectorAll('.sidebar-group-primary .sidebar-label')].map((e) => e.textContent.trim());
  return {
    vw, sw: document.documentElement.scrollWidth, search: location.search,
    ws: box('.saim-ws'), why: box('.saim-why'), sit: box('.sit'), now: !!document.querySelector('.adhd') && !document.querySelector('.saim-ws'),
    whyText: (document.querySelector('.saim-why') || {}).textContent || '',
    pageText: document.body.innerText,
    primaryLabels, over,
  };
})()`;

let flagMode = 'off';
let scenario = null;
const requests = [];
let server; let base; let skipWhy = null; const results = {};

test.before(async () => {
  const bin = electronBinary(); const nm = reactDir();
  if (!bin || !nm) { skipWhy = !bin ? 'no Electron binary here (set ELECTRON_PATH) — the app was NOT measured' : 'no react installed'; return; }
  const www = path.join(tmp, 'www'); fs.mkdirSync(www, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  const entry = path.join(tmp, 'entry.jsx');
  fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import App from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.jsx')))};
createRoot(document.getElementById('root')).render(React.createElement(App));
`);
  await esbuild.build({
    entryPoints: { app: entry }, bundle: true, outdir: www, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent', splitting: true,
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', DEV: false, PROD: true, MODE: 'production', VITE_BUILD_LABEL: 'test' }) },
    alias: { react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), 'react/jsx-runtime': path.join(nm, 'react', 'jsx-runtime.js') },
    nodePaths: [nm, path.join(ROOT, 'node_modules')],
  });
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>localStorage.setItem("neuro_pin","x")</script><script type="module" src="/app.js"></script></body></html>');

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.startsWith('/api/')) {
        requests.push({ scenario, method: req.method, path: u });
        if (u === '/api/auth/check') return send(200, { required: false, authenticated: true });
        if (u === '/api/feature-flags') {
          if (flagMode === 'error') return send(500, { ok: false, error: 'stub: flags unreadable' });
          return send(200, { ok: true, flags: [{ key: 'saim_desktop_workspace', enabled: flagMode === 'on' }] });
        }
        if (req.method !== 'GET') return send(503, { ok: false, error: 'stub: nothing is written in this test' });
        if (u === '/api/canonical/now') return send(200, NOW_PAYLOAD);
        if (u === '/api/adhd') return send(200, ADHD);
        if (u === '/api/prepared-moves/eligible') return send(200, { ok: true, items: [] });
        return send(503, { ok: false });
      }
      const f = path.join(www, u === '/' ? 'index.html' : u.slice(1));
      if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(www, 'index.html'))); }
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(fs.readFileSync(f));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"saim-ws-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, NW_JOB: path.join(tmp, 'job.json'), NW_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const s of SCENARIOS) {
    scenario = s.name; flagMode = s.flag;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ name: s.name, url: base + s.url, sizes: s.sizes, shots: SHOTS, measure: MEASURE }));
    try { fs.rmSync(env.NW_OUT); } catch { /* none yet */ }
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 120000);
      c.on('exit', () => { clearTimeout(t); try { results[s.name] = JSON.parse(fs.readFileSync(env.NW_OUT, 'utf8')); } catch { results[s.name] = { error: `no result: ${err.slice(0, 400)}` }; } resolve(); });
    });
  }
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.SAIM_WS_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
${support.LOAD_WITH_RETRY}
const job = JSON.parse(fs.readFileSync(process.env.NW_JOB, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const fail = (e) => { fs.writeFileSync(process.env.NW_OUT, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = { sizes: [] };
  for (const [w, h] of job.sizes) {
    const win = new BrowserWindow({ width: w, height: h, useContentSize: true, show: false, webPreferences: { offscreen: true } });
    win.setContentSize(w, h);
    await loadWithRetry(win, job.url);
    const js = (c) => win.webContents.executeJavaScript(c);
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(".sit") || !!document.querySelector(".saim-why")'))) await sleep(150);
    await sleep(1500); // the flag read and the lazy workspace chunk
    const m = await js(job.measure);
    const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 3000)); await sleep(400);
    fs.writeFileSync(path.join(job.shots, job.name + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
    out.sizes.push({ size: w + 'x' + h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

const ok = (t, name) => { if (skipWhy) { t.skip(skipWhy); return null; } const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); return r; };

test('flag off: the default launch is Now, and the sidebar has no SAiM item', (t) => {
  const r = ok(t, 'off'); if (!r) return;
  const s = r.sizes[0];
  assert.equal(s.now, true, 'Now rendered'); assert.equal(s.ws, null);
  assert.equal(s.primaryLabels[0], 'Now'); assert.ok(!s.primaryLabels.includes('SAiM'));
});

test('flag unreadable (500): falls back to Now', (t) => {
  const r = ok(t, 'unreadable'); if (!r) return;
  const s = r.sizes[0];
  assert.equal(s.now, true); assert.equal(s.ws, null); assert.ok(!s.primaryLabels.includes('SAiM'));
});

test('flag on: the default launch is SAiM, first in the sidebar, Now still beneath it', (t) => {
  const r = ok(t, 'on'); if (!r) return;
  for (const s of r.sizes) {
    assert.ok(s.ws, `${s.size}: SAiM workspace rendered`);
    assert.equal(s.search, '?view=saim', `${s.size}: URL says where we are`);
    assert.deepEqual(s.primaryLabels.slice(0, 2), ['SAiM', 'Now'], `${s.size}: ${JSON.stringify(s.primaryLabels)}`);
    assert.ok(s.sit, `${s.size}: the shared scene rendered`);
    assert.ok(s.why && s.why.h > 40, `${s.size}: the Why strip rendered`);
    assert.match(s.whyText, /Leading with/); assert.match(s.whyText, /S7 top item/);
    assert.match(s.whyText, /radar/, 'the failed read is named');
    assert.match(s.pageText, /More work due by the end of today/);
    assert.doesNotMatch(s.pageText, /Nothing pressing|You’re clear/i, 'no false all-clear');
    assert.equal(s.sw, s.vw, `${s.size}: no horizontal page scroll`);
    assert.deepEqual(s.over, [], `${s.size}: nothing past the right edge`);
  }
});

test('flag on + ?view=today: Now is shown (explicit fallback)', (t) => {
  const r = ok(t, 'on-today'); if (!r) return;
  const s = r.sizes[0];
  assert.equal(s.now, true); assert.equal(s.ws, null); assert.equal(s.search, '?view=today');
  assert.equal(s.primaryLabels[0], 'SAiM', 'the item is offered; the launch respected the explicit view');
});

test('rollback: switched off again, the next launch is Now', (t) => {
  const r = ok(t, 'rollback'); if (!r) return;
  assert.equal(r.sizes[0].now, true); assert.equal(r.sizes[0].ws, null);
});

test('the workspace made no write call; the only writes were the shell’s existing telemetry', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const writes = requests.filter((q) => q.method !== 'GET' && q.path !== '/api/auth/check');
  const telemetry = writes.filter((q) => q.path.startsWith('/api/activity/'));
  const other = writes.filter((q) => !q.path.startsWith('/api/activity/'));
  assert.deepEqual(other, [], JSON.stringify(other));
  assert.ok(requests.some((q) => q.scenario === 'on' && q.path === '/api/canonical/now'), 'positive control: the workspace read the canonical feed');
  t.diagnostic(`shell telemetry writes (existing behaviour): ${telemetry.length}`);
});
