'use strict';

/**
 * NEURO's Now page with the SAiM scene in it, measured in a REAL BROWSER
 * (Electron's Chromium) at Nick's four sizes (22 Oct 2026). Before this the
 * scene sat in a ~950px centred card inside a 1440px workspace and was
 * unreadable at phone width.
 *
 * The REAL AdhdPanel renders inside the app's own main column (App.css) over a
 * stub NEURO that answers GETs from composed fixtures and RECORDS every
 * request. The stub cannot write anything, so a press can only show which route
 * it would reach. Six states: calm, in a meeting, a running focus block, an
 * active prepared draft, a held promise, and capacity pressure about the
 * promise SAiM is holding.
 *
 * Asserted:
 *   - desktop: the scene fills the workspace (no 960px cap);
 *   - phone: nothing wider than the viewport, and the readout stacks;
 *   - never sideways overflow;
 *   - the running block's task is NOT repeated in Next (cut by id);
 *   - capacity about the held promise shows the promise as "Why it matters"
 *     under the lead, not as a second titled card;
 *   - the controls reach their exact routes: "I'm not attending" posts the
 *     meeting's key, and the private-draft offer posts /api/prepared-moves/prepare
 *     for that promise;
 *   - loading the page makes no POST at all.
 *
 * Skips, and says so, where there is no Electron binary.
 *   ELECTRON_PATH=<electron(.exe)>   overrides discovery
 *   NOW_SHOTS=<dir>                  keeps the PNGs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');
const k = require('./keep-my-word');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'now-workspace-'));
const SHOTS = process.env.NOW_SHOTS || path.join(tmp, 'shots');
const NOW = Date.parse('2026-10-21T09:00:00Z');
const SIZES = [[1440, 900], [1920, 1080], [1024, 552], [390, 844]];

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(ROOT, '..', 'nuero', 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactDir() {
  for (const b of [path.join(ROOT, 'frontend', 'node_modules'), path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'nuero', 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}

// ── States ───────────────────────────────────────────────────────────────────

const TASK = 31;
const KEY = `promise:${TASK}`;
const SCORE = {
  ratio: null, counts: { due: 0, keptOnTime: 0, late: 0, unverified: 0, pending: 0, dropped: 0, reDated: 2, undated: 0 },
  previous: null, entries: [], mondayReport: { state: 'sent-verified-on-time', dueLabel: 'Monday 19 October 2026, 12:00 (London)' },
};
const item = (prep) => ({
  key: KEY, taskIds: [TASK], leadTaskId: TASK, title: 'Build the onboarding checklist for the new starter', owedTo: 'Kit Varga',
  due: { date: '2026-10-22', basis: 'set', endsAt: '2026-10-22T23:00:00.000Z', tier: 'soon', say: 'due within two days' },
  booked: [], preparation: { state: prep, why: 'Nothing is booked for it before it is due.' },
  because: [], evidence: [{ kind: 'due', fact: 'Due Thursday 22 October — the date set on the task.' }],
});
const bench = (prep) => ({ state: 'ok', items: [item(prep)], withheld: { sensitive: 0, ambiguous: 0, unreadable: 0, undated: 0 } });
const OPEN = { canAct: true, boundary: null };
const PRIVATE_OFFER = { [KEY]: { state: 'offer', ref: `promise:${KEY}`, moveKey: `m-${TASK}`, control: 'Prepare a private working draft', question: null, say: 'SAiM will prepare a private draft for you.', privateDraft: { cannot: 'SAiM can’t carry out an employment action for this.', can: 'SAiM can prepare a private draft for you.' } } };
const DRAFTED = { [KEY]: { state: 'ready', ref: `promise:${KEY}`, moveKey: `m-${TASK}`, recordId: 'pm-test-1', version: 1, headline: 'A checklist draft is ready.', say: 'A checklist draft is ready. Ready for you to confirm.' } };
const BLOCK_TASK = 189;
const BLOCK_NEXT = { id: `commitment:task:${BLOCK_TASK}`, kind: 'commitment', priority: 'P2', title: 'Document the ticket types that get blocked', when: 'today · planned date' };

const fixture = (id) => JSON.parse(JSON.stringify(FIXTURES.find((f) => f.id === id)));
function nowPayload({ base = 'many-next', edit = null, prep = 'needs-a-block', moves = null, delivery = null, extraNext = null } = {}) {
  const f = fixture(base);
  if (edit) edit(f.payload);
  const p = composePresentation(f.payload, { now: f.at });
  if (extraNext) p.next = [extraNext, ...(p.next || [])];
  p.keepMyWord = k.compose({ score: SCORE, workbench: bench(prep), authority: OPEN, delivery, moves, presentation: p, now: NOW });
  return { ...f.payload, presentation: p };
}
const ADHD = (blockNow = null) => ({
  generatedAt: new Date(NOW).toISOString(), dateKey: '2026-10-21', shape: { mode: 'morning', line: 'Morning — your best focus window.' },
  rightNow: null, session: null, recovery: null, signals: null, blockNow,
  momentum: { doneToday: 0, doneThisWeek: 0, total: 0, typical: 0, rituals: { standup: false, eod: false }, last7: [] },
  winsToday: [], avoidance: { signals: [] }, quickWins: [], openTasks: 0, gaps: [],
});
const STATES = {
  calm: { now: nowPayload(), adhd: ADHD() },
  meeting: {
    now: (() => {
      const n = nowPayload({ edit: (pl) => { pl.context = { ...pl.context, activity: 'in-meeting', quiet: true }; } });
      n.meeting = { key: 'meeting:evt-ops@2026-10-21T10:00', subject: 'Weekly Ops', scheduledEnd: '2026-10-21T10:45:00' };
      return n;
    })(),
    adhd: ADHD(),
  },
  'focus-block': {
    now: nowPayload({ extraNext: BLOCK_NEXT }),
    adhd: ADHD({ blockId: 7, startTime: '10:50', endTime: '11:55', minutes: 65, minutesAssumed: false, startsInMinutes: -9, running: true, tasks: [{ taskId: BLOCK_TASK, text: BLOCK_NEXT.title, done: false }] }),
  },
  'active-draft': { now: nowPayload({ moves: DRAFTED }), adhd: ADHD() },
  'held-promise': { now: nowPayload({ prep: 'needs-a-draft', delivery: { sending: true, items: { [KEY]: { addressable: false } } } }), adhd: ADHD() },
  capacity: {
    now: nowPayload({
      moves: PRIVATE_OFFER,
      edit: (pl) => {
        pl.primary = { kind: 'item', id: `capacity-start-${TASK}`, recordId: 'rec-cap', type: 'capacity', title: `“${item().title}” is overdue — 8h of work`, say: 'Sized at 8h.', urgency: 'high', tab: 'tasks', actions: ['acknowledge', 'complete', 'defer', 'dismiss'], meta: { taskId: TASK } };
        pl.secondary = [];
      },
    }),
    adhd: ADHD(),
  },
};


// Measured in the page. A plain string, handed to the driver through the job file.
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const over = [...document.querySelectorAll('.sit *, .adhd *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName));
  const txt = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
  const fonts = [...document.querySelectorAll('.sit p, .sit li, .sit button')].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize));
  return {
    vw, sw: document.documentElement.scrollWidth, sit: box('.sit'), view: box('.main-view'), readout: box('.kmw__week'),
    main: box('.sit__body > .kmw__main') || box('.sit__body > .sit__primary'),
    over, next: txt('.sit__nextlist li'), why: txt('.kmw__thread--why .kmw__label'), threadTitles: txt('.kmw__thread h2'),
    buttons: txt('.adhd button'), minFont: fonts.length ? Math.min(...fonts) : 0,
  };
})()`;

// ── Page + stub NEURO ────────────────────────────────────────────────────────

let current = 'calm';
const requests = [];
let server; let base; let skipWhy = null; const results = {};

test.before(async () => {
  const bin = electronBinary();
  const nm = reactDir();
  if (!bin || !nm) { skipWhy = !bin ? 'no Electron binary here (set ELECTRON_PATH) — the page was NOT measured' : 'no react installed'; return; }
  const www = path.join(tmp, 'www'); fs.mkdirSync(www, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  const entry = path.join(tmp, 'entry.jsx');
  fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.css')))};
import AdhdPanel from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/AdhdPanel.jsx')))};
function Shell() {
  const narrow = window.innerWidth < 768;
  const onNavigate = (view, context = null) => { window.__navs = (window.__navs || []).concat([{ view, context }]); };
  return React.createElement('div', { className: 'app' + (narrow ? '' : ' app--with-sidebar') },
    narrow ? null : React.createElement('aside', { className: 'sidebar' }, 'sidebar'),
    React.createElement('main', { className: 'main-panel' }, React.createElement('div', { className: 'main-view' }, React.createElement(AdhdPanel, { onNavigate }))));
}
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`);
  await esbuild.build({
    entryPoints: { app: entry }, bundle: true, outdir: www, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
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
        requests.push({ state: current, method: req.method, path: u, body });
        if (req.method !== 'GET') return send(503, { ok: false, error: 'stub: nothing is written in this test' });
        if (u === '/api/canonical/now') return send(200, STATES[current].now);
        if (u === '/api/adhd') return send(200, STATES[current].adhd);
        if (u === '/api/prepared-moves/eligible') return send(200, { ok: true, items: [] });
        return send(503, { ok: false });
      }
      const f = path.join(www, u === '/' ? 'index.html' : u.slice(1));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(fs.readFileSync(f));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"now-workspace-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, NW_URL: base, NW_JOB: path.join(tmp, 'job.json'), NW_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE; // ⚠ set in some shells; Electron would then run as plain node
  for (const name of Object.keys(STATES)) {
    current = name;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ name, sizes: SIZES, shots: SHOTS, measure: MEASURE }));
    try { fs.rmSync(env.NW_OUT); } catch { /* none yet */ }
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 120000);
      c.on('exit', () => { clearTimeout(t); try { results[name] = JSON.parse(fs.readFileSync(env.NW_OUT, 'utf8')); } catch { results[name] = { error: `no result: ${err.slice(0, 400)}` }; } resolve(); });
    });
  }
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.NOW_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
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
    await win.loadURL(process.env.NW_URL);
    const js = (c) => win.webContents.executeJavaScript(c);
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(".sit")'))) await sleep(150);
    await sleep(500);
    const m = await js(job.measure);
    const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 4000)); await sleep(400);
    fs.writeFileSync(path.join(job.shots, job.name + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(w, h); await sleep(300);
    if (w === 1440) {
      // The controls' routes. The stub records the request and answers 503, so nothing happens.
      m.pressed = {};
      for (const label of ['I’m not attending', 'Prepare a private working draft']) {
        m.pressed[label] = await js('(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ' + JSON.stringify(label) + ' && !x.disabled); if (!b) return false; b.click(); return true; })()');
        await sleep(600);
      }
    }
    out.sizes.push({ size: w + 'x' + h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

// ── Assertions ───────────────────────────────────────────────────────────────

const each = (fn) => async (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const [name, r] of Object.entries(results)) {
    assert.ok(!r.error, `${name}: ${r.error}`);
    for (const s of r.sizes) fn(name, s);
  }
};

test('the scene uses the workspace on desktop and the viewport on phone, with no sideways overflow', each((name, s) => {
  assert.ok(s.sit, `${name} ${s.size}: the scene rendered`);
  assert.equal(s.sw, s.vw, `${name} ${s.size}: no horizontal page scroll`);
  assert.deepEqual(s.over, [], `${name} ${s.size}: nothing past the right edge`);
  assert.ok(s.sit.w >= s.view.w * 0.9, `${name} ${s.size}: the scene fills the workspace (${s.sit.w} of ${s.view.w})`);
  if (s.vw >= 1400) assert.ok(s.sit.w > 1200, `${name} ${s.size}: no 960px cap (${s.sit.w})`);
  assert.ok(s.minFont >= 10, `${name} ${s.size}: readable text (${s.minFont}px)`);
}));

test('the readout sits beside the main area on desktop and stacks above it on phone', each((name, s) => {
  if (!s.readout || !s.main) return;
  if (s.vw >= 1400) assert.ok(s.main.x > s.readout.x + s.readout.w - 4, `${name} ${s.size}: readout is a side column`);
  if (s.vw < 500) assert.ok(s.main.y >= s.readout.y + s.readout.h - 4, `${name} ${s.size}: readout stacks above`);
}));

test('the running block’s task is not repeated in Next', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of results['focus-block'].sizes) {
    assert.ok(s.buttons.length, 'page rendered');
    assert.ok(!s.next.some((x) => x.includes(BLOCK_NEXT.title)), `${s.size}: ${JSON.stringify(s.next)}`);
  }
  // Positive control: the same row IS drawn when no block holds it.
  const fx = nowPayload({ extraNext: BLOCK_NEXT });
  assert.ok(fx.presentation.next.some((x) => x.id === BLOCK_NEXT.id));
});

test('capacity about the held promise shows it as "Why it matters", not a second titled card', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of results.capacity.sizes) {
    assert.equal(s.why.length, 1, `${s.size}: one why line`);
    assert.match(s.why[0], /Why it matters/);
    assert.ok(!s.threadTitles.some((x) => x.includes(item().title)), `${s.size}: the promise title is not repeated`);
  }
  for (const s of results.calm.sizes) assert.equal(s.why.length, 0, 'calm: no lead, no why');
});

test('controls reach their exact routes, and loading writes nothing', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const posts = requests.filter((r) => r.method !== 'GET');
  const meeting = posts.filter((r) => r.state === 'meeting');
  assert.equal(results.meeting.sizes[0].pressed['I’m not attending'], true);
  assert.deepEqual(meeting.map((r) => [r.path, JSON.parse(r.body || '{}').key]), [['/api/attention/meeting/not-attending', STATES.meeting.now.meeting.key]]);
  assert.equal(results.capacity.sizes[0].pressed['Prepare a private working draft'], true);
  const prep = posts.filter((r) => r.state === 'capacity');
  assert.equal(prep.length, 1, JSON.stringify(prep));
  assert.equal(prep[0].path, '/api/prepared-moves/prepare');
  assert.match(prep[0].body, new RegExp(KEY));
  // No other state wrote anything, and only the two presses above wrote at all.
  assert.deepEqual(posts.filter((r) => r.state !== 'meeting' && r.state !== 'capacity'), []);
});
