'use strict';

/**
 * Holding the week — every card leads somewhere useful, in a REAL BROWSER
 * (Electron's Chromium), across the real shells (22 Oct 2026):
 *
 *   desktop   NEURO's Now (the real AdhdPanel) at 1440×900
 *   now-390   NEURO's Now at phone width (390×844)
 *   phone     the SAiM phone app (the real Surface) at 390×844
 *   kiosk     the same Surface declared as the kiosk (?surface=kiosk) at 1024×552
 *
 * …in five states composed by the REAL keep-my-word (+ cards) composer from
 * live-style data: calm · held · prepared · verified · no-data.
 *
 * For every visible card: exactly ONE primary affordance; pressing it opens the
 * card's exact record (a sheet with real content — never blank) or reaches its
 * exact target (a NEURO view, the task by id, or the guarded routes). Inside the
 * records: the promises with their next valid action; the Monday receipt and the
 * report that was sent (no send control); the block's exact time, draft and task
 * with "Start this block" ONLY when a session is possible; the judgement review one
 * promise at a time. The kiosk opens every record and performs nothing.
 *
 * The stub NEURO answers GETs from the fixtures and RECORDS every request; the two
 * guarded POSTs (start a session; prepare a delivery note) return a stub ok and
 * write nothing. Screenshots: HW_SHOTS=<dir> keeps them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');
const kmw = require('./keep-my-word');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT); // read deps by path — never junction them in
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holding-week-'));
const SHOTS = process.env.HW_SHOTS || path.join(tmp, 'shots');
const NOW = Date.parse('2026-10-21T09:00:00Z'); // Wednesday 21 October, 10:00 London

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(MAIN_CHECKOUT, 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactFor(appDir) {
  for (const b of [path.join(appDir, 'node_modules'), path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, path.relative(ROOT, appDir), 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}

// ── Live-style data, through the real composer ──────────────────────────────

const T = { metrics: 350, podcast: 358, pack: 51, hr: 52, rota: 61, answer: 62 };
const MONDAY_SENT = {
  state: 'sent-verified-on-time', dueLabel: 'Monday 19 October 2026, 12:00 (London)', rule: 'sent through NEURO and read back in Sent Items by the deadline',
  evidence: [{ kind: 'verified-send', actionId: 'pa_0123456789abcdef', provenBy: '2026-10-19T10:42:00Z' }],
  report: { subject: 'Weekly Team Risk & Anomaly Summary — w/c 12 Oct', sentAt: '2026-10-19T10:40:00Z', recipients: ['Chris Middleton'], excerpt: 'Three findings this week: Tier 2 FRT compliance below target for a third week; one escalation aged past its target; CSAT from four ratings.' },
};
const scoreMeasured = (over = {}) => ({
  week: { label: 'Week of Monday 19 October' }, ratio: { kept: 3, of: 4 }, measured: true, proofSource: { status: 'connected' },
  counts: { due: 4, keptOnTime: 3, late: 1, unverified: 0, pending: 0, dropped: 0, reDated: 1, undated: 2, beforeProofSource: 0 },
  previous: { ratio: { kept: 2, of: 4 } }, gaps: [],
  entries: [
    { key: 'promise:40', taskIds: [40], outcome: 'kept-on-time', sensitive: false, text: 'Send Chris the call metrics', due: { date: '2026-10-20' }, evidence: [{ kind: 'verified-delivery', provenBy: '2026-10-20T09:00:00Z' }] },
    { key: 'promise:41', taskIds: [41], outcome: 'late', sensitive: false, text: 'Share the rota with the team', due: { date: '2026-10-20' }, rule: 'its due point has passed with no delivery evidence', evidence: [] },
  ],
  mondayReport: MONDAY_SENT, ...over,
});
const scoreUnmeasured = () => ({
  week: { label: 'Week of Monday 19 October' }, ratio: null, measured: false, proofSource: { status: 'not-connected', why: 'no promise delivery has been prepared yet, so the score starts with the first one' },
  why: 'No promise delivery has been prepared yet — ticks are not delivery, so none is counted as kept.',
  counts: { due: 3, keptOnTime: 0, late: 0, unverified: 2, pending: 1, dropped: 0, reDated: 0, undated: 1, beforeProofSource: 0 }, previous: null, gaps: [],
  entries: [
    { key: `promise:${T.pack}`, taskIds: [T.pack], outcome: 'unverified', sensitive: false, text: 'Send Kit the onboarding pack', due: { date: '2026-10-20' }, rule: 'ticked, with no delivery evidence', evidence: [{ kind: 'ticked' }] },
    { key: `promise:${T.hr}`, taskIds: [T.hr], outcome: 'unverified', sensitive: true, text: null },
    { key: `promise:${T.rota}`, taskIds: [T.rota], outcome: 'pending', sensitive: false, text: 'Send the new rota to the team', due: { date: '2026-10-22' }, evidence: [] },
  ],
  mondayReport: { state: 'late', dueLabel: 'Monday 19 October 2026, 12:00 (London)', rule: 'its deadline has passed with nothing written or sent', evidence: [] },
});
const benchItem = (key, taskId, title, prep, extra = {}) => ({
  key, taskIds: [taskId], leadTaskId: taskId, title, owedTo: 'Kit Varga',
  due: { date: '2026-10-22', basis: 'set', endsAt: '2026-10-22T23:00:00.000Z', tier: 'soon', say: 'due within two days' },
  booked: [], preparation: prep, because: [], evidence: [{ kind: 'due', fact: 'Due Thursday 22 October — the date set on the task.' }], ...extra,
});
const workItem = (taskId, title, block) => ({
  moveKey: `saim-move:v2:project-note:task:${taskId}`, recordId: `pm_${taskId}`, title, kindLabel: 'Private working draft',
  path: `Projects/Working/${title} (private draft).md`, obsidianUrl: `obsidian://open?vault=Nicks%20knowledge%20base&file=${encodeURIComponent(`Projects/Working/${title} (private draft)`)}`,
  task: { id: taskId, text: title, status: 'open' }, block, outlookUrl: block ? 'https://outlook.office.com/calendar/item/AAMkAGI-test' : null,
});
const fixture = (id) => JSON.parse(JSON.stringify(FIXTURES.find((f) => f.id === id)));

function payload({ score = null, workbench = null, delivery = null, work = null, receipt = null, session = null }) {
  const f = fixture('empty');
  const p = composePresentation(f.payload, { now: f.at });
  p.keepMyWord = kmw.compose({ score, workbench, receipt, authority: { canAct: true, boundary: null }, delivery, moves: null, presentation: p, work, session, now: NOW });
  return { ...f.payload, presentation: p };
}
const VERIFIED_RECEIPT = kmw.receiptView({
  target: 'live', complete: true, at: new Date(NOW - 20 * 60000).toISOString(), title: 'Prepare the Support Improvement Plan meeting',
  steps: [
    { step: 'calendar', status: 'done', target: '2026-10-21 14:00–14:30 “Prep: Support Improvement Plan”' },
    { step: 'note', status: 'done', target: 'Projects/Support Improvement Plan/SIP prep (draft).md' },
  ],
});
assert.ok(VERIFIED_RECEIPT, 'positive control: the receipt fixture is a verified live receipt');

const STATES = {
  calm: payload({ score: scoreMeasured(), workbench: { state: 'ok', items: [] }, work: [workItem(T.podcast, 'Publish the podcast', { date: '2026-10-22', start: '10:30', end: '11:00', label: 'Thursday 22 October, 10:30–11:00' })] }),
  held: payload({
    score: scoreUnmeasured(),
    workbench: { state: 'ok', items: [benchItem(`promise:${T.rota}`, T.rota, 'Send the new rota to the team', { state: 'needs-a-draft', why: 'No delivery note is drafted yet.' }), benchItem(`promise:${T.answer}`, T.answer, 'Agree the hybrid incentive plan', { state: 'waiting-for-Nick', why: 'SAiM is waiting for your answer: who is this owed to?' })] },
    delivery: { sending: false, items: { [`promise:${T.rota}`]: { addressable: true, live: null } } },
  }),
  prepared: payload({ score: scoreMeasured(), workbench: { state: 'ok', items: [] }, work: [workItem(T.metrics, 'Call metrics in Nova', { date: '2026-10-21', start: '09:55', end: '10:25', label: 'Wednesday 21 October, 09:55–10:25' })] }),
  verified: payload({ score: scoreMeasured({ mondayReport: { ...MONDAY_SENT, state: 'sent-verified-late' } }), workbench: { state: 'ok', items: [] }, receipt: VERIFIED_RECEIPT, work: [] }),
  'no-data': payload({ score: null, workbench: null, work: [], session: null }),
};
for (const [n, p] of Object.entries(STATES)) assert.ok(p.presentation.keepMyWord.readout.cards, `positive control: ${n} carries the card contract`);

const ADHD = { generatedAt: new Date(NOW).toISOString(), dateKey: '2026-10-21', shape: { mode: 'morning', line: 'Morning.' }, rightNow: null, session: null, recovery: null, signals: null, blockNow: null, momentum: { doneToday: 0, doneThisWeek: 0, total: 0, typical: 0, rituals: { standup: false, eod: false }, last7: [] }, winsToday: [], avoidance: { signals: [] }, quickWins: [], openTasks: 0, gaps: [] };

// ── Page + stub NEURO ────────────────────────────────────────────────────────

const SHELLS = {
  desktop: { page: 'desktop.html', w: 1440, h: 900 },
  'now-390': { page: 'desktop.html', w: 390, h: 844 },
  phone: { page: 'phone.html', w: 390, h: 844 },
  // The kiosk shell's own stylesheets, at the bedroom Fire's viewport and the
  // 1280-wide desk panel KioskShell.css is written for.
  kiosk: { page: 'kiosk.html?surface=kiosk', w: 1024, h: 552 },
  'kiosk-1280': { page: 'kiosk.html?surface=kiosk', w: 1280, h: 720 },
};
const KIOSKS = ['kiosk', 'kiosk-1280'];
let current = { state: 'calm', shell: 'desktop' };
const requests = [];
let server; let base; let skipWhy = null; const results = {};

async function bundle(name, code, appDir) {
  const nm = reactFor(appDir);
  if (!nm) throw new Error(`no react for ${appDir}`);
  const entry = path.join(tmp, `${name}-entry.jsx`); fs.writeFileSync(entry, code);
  const out = path.join(tmp, 'www');
  await esbuild.build({
    entryPoints: { [name]: entry }, bundle: true, outdir: out, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', VITE_VAULT_API_KEY: '', DEV: false, PROD: true, MODE: 'production', VITE_BUILD_LABEL: 'test' }) },
    alias: { react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), 'react/jsx-runtime': path.join(nm, 'react', 'jsx-runtime.js') },
    nodePaths: [nm, path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules')],
  });
  const css = fs.existsSync(path.join(out, `${name}.css`)) ? `<link rel="stylesheet" href="/${name}.css">` : '';
  fs.writeFileSync(path.join(out, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}<style>html,body{margin:0;background:#06080c;color:#e6edf3;font-family:system-ui}*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>try{localStorage.setItem('neuro_pin','pin-1234')}catch(e){}</script><script type="module" src="/${name}.js"></script></body></html>`);
}

// Surface mounted the way BOTH real shells mount it: inside `.app > main.app__view`.
// Its `margin: -1rem` is the field bleeding over `.app__view`'s 1rem padding
// (Surface.css, KioskShell.css); mounted bare, that margin has nothing to cancel
// and the page measured 16px too wide, which no real screen does.
const SURFACE_IN_SHELL = `window.open = (href) => { window.__opened = (window.__opened || []).concat([href]); return null; };\nconst view = React.createElement(Surface, { onNavigate: (tab, ctx) => { window.__navs = (window.__navs || []).concat([{ view: tab, context: ctx || null }]); }, onShowAll() {} });\ncreateRoot(document.getElementById('root')).render(React.createElement('div', { className: 'app' }, React.createElement('main', { className: 'app__view' }, view)));\n`;

test.before(async () => {
  const bin = electronBinary();
  if (!bin || !reactFor(path.join(ROOT, 'frontend')) || !reactFor(path.join(ROOT, 'saim', 'app'))) { skipWhy = 'no Electron binary or react here (set ELECTRON_PATH) — the shells were NOT driven'; return; }
  const slash = (p) => p.replace(/\\/g, '/');
  await bundle('desktop', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.css')))};\nimport AdhdPanel from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/AdhdPanel.jsx')))};\nconst onNavigate = (view, context = null) => { window.__navs = (window.__navs || []).concat([{ view, context }]); };\nconst narrow = window.innerWidth < 768;\ncreateRoot(document.getElementById('root')).render(React.createElement('div', { className: 'app' + (narrow ? '' : ' app--with-sidebar') }, narrow ? null : React.createElement('aside', { className: 'sidebar' }, 'sidebar'), React.createElement('main', { className: 'main-panel' }, React.createElement('div', { className: 'main-view' }, React.createElement(AdhdPanel, { onNavigate })))));\n`, path.join(ROOT, 'frontend'));
  await bundle('phone', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport Surface from ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/views/Surface.jsx')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/App.css')))};\n${SURFACE_IN_SHELL}`, path.join(ROOT, 'saim/app'));
  // The kiosk shell's three sheets, in saim/frontend/src/App.jsx's order: its theme,
  // the phone's shell (which must win), then KioskShell.css.
  await bundle('kiosk', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport Surface from ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/views/Surface.jsx')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'saim/frontend/src/App.css')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/App.css')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'saim/frontend/src/KioskShell.css')))};\n${SURFACE_IN_SHELL}`, path.join(ROOT, 'saim/app'));

  const www = path.join(tmp, 'www');
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.startsWith('/api/')) {
        requests.push({ ...current, method: req.method, path: u, body });
        if (req.method === 'POST' && u === '/api/session/start') return send(200, { ok: true, stub: true });
        if (req.method === 'POST' && /^\/api\/promises\/[^/]+\/prepare$/.test(u)) return send(200, { ok: true, stub: true, action: { id: 'pa_stub' } });
        if (req.method !== 'GET') return send(503, { ok: false, error: 'stub: nothing is written in this test' });
        if (u === '/api/canonical/now') return send(200, STATES[current.state]);
        if (u === '/api/adhd') return send(200, ADHD);
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
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"holding-week-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, HW_JOB: path.join(tmp, 'job.json'), HW_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const state of Object.keys(STATES)) {
    for (const [shell, s] of Object.entries(SHELLS)) {
      current = { state, shell };
      fs.writeFileSync(env.HW_JOB, JSON.stringify({ name: `${state}-${shell}`, url: base + s.page, w: s.w, h: s.h, shots: SHOTS, workspace: s.page.startsWith('desktop') }));
      try { fs.rmSync(env.HW_OUT); } catch { /* none yet */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = ''; c.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => c.kill(), 120000);
        c.on('exit', () => { clearTimeout(t); try { results[`${state}-${shell}`] = JSON.parse(fs.readFileSync(env.HW_OUT, 'utf8')); } catch { results[`${state}-${shell}`] = { error: `no result: ${err.slice(0, 500)}` }; } resolve(); });
      });
    }
  }
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.HW_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const { LOAD_WITH_RETRY } = require('./electron-driver-support');
const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
${LOAD_WITH_RETRY}
const job = JSON.parse(fs.readFileSync(process.env.HW_JOB, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const fail = (e) => { fs.writeFileSync(process.env.HW_OUT, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDS = ['kept', 'monday', 'next', 'judgement'];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: job.w, height: job.h, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  win.setContentSize(job.w, job.h);
  await loadWithRetry(win, job.url);
  const js = (c) => win.webContents.executeJavaScript(c);
  const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(".kmw__week")'))) await sleep(150);
  await sleep(800);
  const shot = async (name) => { const H = await js('Math.max(document.documentElement.scrollHeight, ' + job.h + ')'); win.setContentSize(job.w, Math.min(H, 3000)); await sleep(250); fs.writeFileSync(path.join(job.shots, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.setContentSize(job.w, job.h); await sleep(150); };
  const out = { cards: [], sheets: {}, presses: {} };
  out.page = await js('(() => { const vw = document.documentElement.clientWidth; const past = (sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1; }).slice(0, 6).map((e) => String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || e.tagName)); return { vw, sw: document.documentElement.scrollWidth, week: !!document.querySelector(".kmw__week"), workspace: !!document.querySelector(".kmw__week--workspace"), kmwPast: past("[class*=kmw]"), anyPast: past("body *") }; })()');
  out.cards = await js('[...document.querySelectorAll(".kmw__card")].map((c) => ({ id: c.dataset.card, state: c.dataset.state, text: c.textContent, primaries: c.querySelectorAll(":scope > .kmw__card-go").length, secondaries: c.querySelectorAll(":scope > .kmw__card-link").length, buttons: [...c.querySelectorAll(":scope > button")].map((b) => ({ cls: b.className, target: b.dataset.target || null, label: b.textContent.trim() })), w: Math.round(c.getBoundingClientRect().width) }))');
  out.entries = await js('[...document.querySelectorAll(".kmw__entry-open")].map((b) => ({ id: b.dataset.card, label: b.textContent.trim() }))');
  await shot(job.name);
  for (const id of IDS) {
    // The card's primary (workspace) or the locked entry (phone, kiosk).
    const sel = job.workspace ? '.kmw__card[data-card="' + id + '"] > .kmw__card-go' : '.kmw__entry-open[data-card="' + id + '"]';
    const before = await js('(window.__navs || []).length');
    const pressed = await js('(() => { const b = document.querySelector(' + JSON.stringify(sel) + '); if (!b) return null; const t = b.dataset.target || "detail"; b.click(); return t; })()');
    await sleep(500);
    const sheet = await js('(() => { const s = document.querySelector(".kmw__sheet[data-card=\'' + id + '\']"); if (!s) return null; return { text: s.textContent, targets: [...s.querySelectorAll("button[data-target]")].map((b) => ({ target: b.dataset.target, label: b.textContent.trim() })), review: s.querySelector(".kmw__review") ? s.querySelector(".kmw__review").textContent : null, box: (() => { const r = s.querySelector(".kmw__sheet-body").getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }; })() }; })()');
    out.presses[id] = { pressed, sheet: Boolean(sheet), navs: (await js('window.__navs || []')).slice(before) };
    if (sheet) {
      out.sheets[id] = sheet;
      await shot(job.name + '-' + id);
      if (id === 'judgement' && sheet.review) {
        await js('(() => { const b = [...document.querySelectorAll(".kmw__sheet .kmw__card-link")].find((x) => /Next promise/.test(x.textContent)); if (b && !b.disabled) b.click(); })()'); await sleep(250);
        out.sheets[id].review2 = await js('(() => { const r = document.querySelector(".kmw__sheet .kmw__review"); return r ? r.textContent : null; })()');
      }
      // Press each guarded action the sheet offers (the stub records it; nothing is written).
      for (const t of ['session-start', 'prepare-delivery']) {
        const ok = await js('(() => { const b = document.querySelector(".kmw__sheet button[data-target=\'' + t + '\']"); if (!b) return false; b.click(); return true; })()');
        if (ok) { await sleep(500); out.sheets[id]['after-' + t] = await js('(() => { const s = document.querySelector(".kmw__sheet [role=status]"); return s ? s.textContent : null; })()'); }
      }
      await js('(() => { const b = [...document.querySelectorAll(".kmw__sheet .kmw__card-link")].find((x) => x.textContent.trim() === "Close"); if (b) b.click(); })()'); await sleep(250);
    }
  }
  out.opened = await js('window.__opened || []');
  fs.writeFileSync(process.env.HW_OUT, JSON.stringify(out));
  win.destroy(); app.quit();
});`;

// ── Assertions ───────────────────────────────────────────────────────────────

const R = (name) => { const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); return r; };
const posts = (state, shell) => requests.filter((q) => q.state === state && q.shell === shell && q.method !== 'GET');
const WORKSPACE = ['desktop', 'now-390'];

test('every shell, every state: the week renders, nothing runs off the screen, every card is reachable', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const state of Object.keys(STATES)) {
    for (const shell of Object.keys(SHELLS)) {
      const r = R(`${state}-${shell}`);
      assert.equal(r.page.week, true, `${state}-${shell}: Holding the week is on screen`);
      // Nothing of Holding the week runs past the screen, and the page as a whole
      // does not scroll sideways (offenders named if it ever does).
      assert.deepEqual(r.page.kmwPast, [], `${state}-${shell}: nothing of Holding the week past the edge`);
      assert.equal(r.page.sw, r.page.vw, `${state}-${shell}: no sideways scroll — ${r.page.anyPast.join(', ') || '(no element named)'}`);
      if (WORKSPACE.includes(shell)) {
        assert.deepEqual(r.cards.map((c) => c.id), ['kept', 'monday', 'next', 'judgement'], `${state}-${shell}: the four cards`);
        for (const c of r.cards) {
          assert.equal(c.primaries, 1, `${state}-${shell} ${c.id}: exactly ONE primary affordance`);
          assert.ok(c.secondaries <= 1, `${state}-${shell} ${c.id}: at most one quiet secondary`);
        }
      } else {
        assert.ok(r.entries.some((e) => e.id === 'kept'), `${state}-${shell}: Keeping my word opens`);
      }
    }
  }
});

test('every visible card leads somewhere useful: its record, or its exact target — never a blank card', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const state of Object.keys(STATES)) {
    for (const shell of Object.keys(SHELLS)) {
      const r = R(`${state}-${shell}`);
      for (const [id, p] of Object.entries(r.presses)) {
        if (p.pressed === null) continue; // not visible on this shell (a locked entry with nothing to say)
        const reached = p.sheet || p.navs.length > 0 || posts(state, shell).length > 0;
        assert.ok(reached, `${state}-${shell} ${id}: the primary led nowhere`);
        if (p.sheet) assert.ok(r.sheets[id].text.replace(/Close|Keeping my word|Monday report|Next|Needs your judgement/g, '').trim().length > 30, `${state}-${shell} ${id}: the record is not blank`);
      }
    }
  }
});

test('Keeping my word: measured shows the promises; "Not measured yet" says exactly what evidence is missing and lists the affected promises', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const calm = R('calm-desktop').sheets.kept;
  assert.match(calm.text, /3 \/ 4/);
  assert.match(calm.text, /Share the rota with the team.*At risk · Late/);
  assert.match(calm.text, /Send Chris the call metrics.*Kept — delivery read back/);
  assert.match(calm.text, /Two promises have no date — only the 10-day placeholder/);
  const held = R('held-desktop').sheets.kept;
  assert.match(held.text, /Not measured yet/);
  assert.match(held.text, /What evidence is missing.*No promise delivery has been prepared yet\. A promise counts as kept only when its delivery note goes through NEURO and is read back in Sent Items — a tick is not delivery\./);
  assert.match(held.text, /This affects \d promises below/);
  assert.match(held.text, /Send Kit the onboarding pack/);
  assert.match(held.text, /An employment matter — not named here/);
  assert.ok(held.targets.some((x) => x.target === 'prepare-delivery'), 'the next valid action: draft the delivery note');
  const prep = posts('held', 'desktop').filter((q) => /\/api\/promises\/promise%3A61\/prepare$/.test(q.path));
  assert.equal(prep.length, 1, 'the delivery note is prepared for THAT promise, by its key');
  assert.match(R('held-desktop').sheets.kept['after-prepare-delivery'], /nothing was sent/);
  const none = R('no-data-desktop').sheets.kept;
  assert.match(none.text, /NEURO couldn’t read your promises, so nothing is counted — this is not a clean week\./);
});

test('Monday report: sent → the receipt and the saved report, never a resend; still due → the governed preparation path', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const shell of ['desktop', 'phone', 'kiosk']) {
    const s = R(`calm-${shell}`).sheets.monday;
    assert.ok(s, `calm-${shell}: the receipt opens`);
    assert.match(s.text, /Read back in Sent Items Monday 19 October 2026, 11:42 \(London\)/);
    assert.match(s.text, /Weekly Team Risk & Anomaly Summary — w\/c 12 Oct/);
    assert.match(s.text, /to Chris Middleton/);
    assert.match(s.text, /Tier 2 FRT compliance/);
    assert.doesNotMatch(s.text, /\bSend it\b|\bResend\b|Write and send/, 'never a send control on a sent report');
  }
  assert.ok(R('calm-desktop').cards.find((c) => c.id === 'monday').buttons.every((b) => !/send/i.test(b.label)));
  // Still due (late): the card's primary is the governed path, on the desktop.
  const late = R('held-desktop');
  assert.equal(late.presses.monday.navs[0].view, 'weekly-risk');
  assert.match(late.cards.find((c) => c.id === 'monday').text, /Write and send it now/);
  // The phone cannot open NEURO's report screen: it says where, rather than pretending.
  assert.match(R('held-phone').sheets.monday.text, /Write and send it now — in NEURO on the desktop\./);
  // Unreadable: says why, and that it is not "not sent".
  assert.match(R('no-data-desktop').sheets.monday.text, /not the same as not sent/);
});

test('Next: the exact block, draft and task; "Start this block" only when a session is possible, and it starts THAT block', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const calm = R('calm-desktop');
  assert.match(calm.cards.find((c) => c.id === 'next').text, /Thursday 22 October, 10:30–11:00/);
  assert.match(calm.cards.find((c) => c.id === 'next').text, /Start this block becomes available at 10:30 on Thursday 22 October/);
  assert.match(calm.sheets.next.text, /Projects\/Working\/Publish the podcast \(private draft\)\.md/);
  assert.match(calm.sheets.next.text, /#358 · Publish the podcast/);
  assert.ok(!calm.sheets.next.targets.some((x) => x.target === 'session-start'), 'not startable yet: no Start button');
  // Prepared: the block is now.
  for (const shell of ['desktop', 'now-390', 'phone']) {
    const r = R(`prepared-${shell}`);
    const startPosts = posts('prepared', shell).filter((q) => q.path === '/api/session/start');
    assert.equal(startPosts.length, 1, `prepared-${shell}: Start this block starts exactly one session`);
    const b = JSON.parse(startPosts[0].body);
    assert.equal(b.taskId, T.metrics, `prepared-${shell}: on THAT block's task`);
    assert.equal(b.minutes, 25, `prepared-${shell}: for the block's remaining minutes`);
    if (WORKSPACE.includes(shell)) assert.equal(r.cards.find((c) => c.id === 'next').buttons[0].label, 'Start this block →');
  }
  assert.match(R('prepared-phone').sheets.next['after-session-start'] || '', /Focus session started — 25 minutes/);
  // Verified: the protected time from today's verified receipt, with its draft — and no task to start.
  const v = R('verified-desktop').sheets.next;
  assert.match(v.text, /Wednesday 21 October, 14:00–14:30/);
  assert.match(v.text, /Projects\/Support Improvement Plan\/SIP prep \(draft\)\.md/);
  assert.match(v.text, /This block has no task linked/);
  // No data: says so, never blank.
  assert.match(R('no-data-desktop').sheets.next.text, /No protected time is booked ahead\./);
});

test('Needs your judgement: a bounded review, one promise at a time, with evidence and the safe choices', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const s = R('held-desktop').sheets.judgement;
  assert.match(s.review, /^1 of 3/);
  assert.match(s.review, /Send Kit the onboarding pack.*Ticked, with no proof it was delivered\..*Rule: ticked, with no delivery evidence\./);
  assert.match(s.review2, /^2 of 3.*An employment matter — not named here/);
  assert.ok(R('held-desktop').presses.judgement.sheet);
  assert.match(R('calm-desktop').sheets.judgement.text, /Nothing is waiting on your judgement\. A promise lands here when/);
});

test('the kiosk opens every record and performs nothing — no Start, no Draft, no request', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const k of KIOSKS) {
    for (const state of Object.keys(STATES)) {
      const r = R(`${state}-${k}`);
      for (const sh of Object.values(r.sheets)) {
        assert.ok(!sh.targets.some((x) => x.target === 'session-start' || x.target === 'prepare-delivery'), `${state}-${k}: nothing that changes anything`);
        assert.match(sh.text, /This screen can show these records; it can’t act on them\./);
      }
      assert.deepEqual(posts(state, k), [], `${state}-${k}: no request that writes`);
    }
    assert.ok(R(`prepared-${k}`).sheets.next, `positive control: ${k} did open the startable block’s record`);
    assert.match(R(`prepared-${k}`).sheets.next.text, /Start this block — not from this screen\./);
  }
});

test('phone, desktop and NEURO Now use the same contract and entity ids', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const state of ['held', 'prepared']) {
    const d = R(`${state}-desktop`).sheets; const p = R(`${state}-phone`).sheets;
    for (const id of Object.keys(d)) {
      if (!p[id]) continue;
      const strip = (x) => x.replace(/ — in NEURO[^.]*\.| — in Obsidian\.| — not from this screen\./g, '').replace(/\s+/g, ' ');
      assert.ok(strip(p[id].text).includes(strip(d[id].text).slice(0, 60)), `${state} ${id}: the phone shows the same record`);
    }
  }
  // Nothing anywhere besides the two guarded routes was ever POSTed.
  assert.deepEqual([...new Set(requests.filter((q) => q.method !== 'GET').map((q) => q.path.replace(/promise%3A\d+/, ':key')))].sort(), ['/api/promises/:key/prepare', '/api/session/start']);
});
