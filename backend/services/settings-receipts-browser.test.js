'use strict';

/**
 * Settings and receipts in a REAL BROWSER (Electron's Chromium), at desktop and
 * phone widths (22 Oct 2026).
 *
 *   settings   the REAL AdminPanel: "Automatic context linking" (On/Off, what it
 *              does, schedule, next run, last result; enabling needs the cleanup
 *              tick and is never pressed here) and "AI budget (shadow)" (today's
 *              shared spend, Radar's share, the refusal reasons, no cap)
 *   drafts     NEURO desktop's Drafts page and the SAiM phone's Drafts: Today —
 *              prepared / practice / verified told apart, exact times, a live
 *              note's place; the kiosk-equivalent read-only rendering has no buttons
 *   receipts   the REAL ReceiptBlock (SAiM's PreparedMove) for verified, practice,
 *              partial and unknown receipts
 *
 * The stub NEURO answers from fixtures and RECORDS every request; nothing is
 * written, the backfill is never run. Screenshots: SR_SHOTS=<dir> keeps them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT); // read deps by path — never junction them in
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-receipts-'));
const SHOTS = process.env.SR_SHOTS || path.join(tmp, 'shots');

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONTEXT_STATUS = {
  ok: true, enabled: false, enabledAt: null, enabledBy: null, disabledAt: null, backfill: null, schedule: 'Every night at 03:40',
  say: 'Automatic context linking is off until you enable it in NEURO → Settings. You can still link notes to a task by hand. The vault cleanup it was waiting for is done (22 Oct 2026). The first run after you enable it is the backfill.',
  enableSay: 'Enabling scans every open task against the whole vault NOW (the backfill), pins only high-confidence context, keeps lower-confidence matches as suggestions, and then runs every night at 03:40. Nothing is written to the vault.',
  whatItDoes: 'Each night NEURO compares every open task with the vault and pins only high-confidence notes, projects and areas to it; weaker matches stay as suggestions. It never writes the vault, and never touches a link you made or removed by hand.',
  nextRun: null, lastRun: null, lastResult: null, manageIn: 'settings',
};
const PROFILE = {
  ok: true, known: true, mode: 'shadow', dailyCapUsd: null, currency: 'USD', pricesCheckedOn: '2026-10-22',
  capSay: 'No daily cap — Nick has not chosen one. Shadow mode records what the gate would refuse; nothing is blocked.',
  day: '2026-10-22', spendUsd: 0.4123, openReservedUsd: 0, calls: 37, unknownCostCalls: 2, pessimisticCalls: 1,
  share: { callClass: 'radar', usd: 0.3, fraction: 0.7276 },
  byClass: [
    { app: 'vantage', callClass: 'radar', calls: 3, usd: 0.3, unknownCost: 0, pessimistic: 0, wouldRefuse: 0 },
    { app: 'neuro', callClass: 'chat_stream', calls: 12, usd: 0.1123, unknownCost: 0, pessimistic: 1, wouldRefuse: 0 },
    { app: 'neuro', callClass: 'tts_speak', calls: 2, usd: 0, unknownCost: 2, pessimistic: 0, wouldRefuse: 2 },
  ],
  byApp: [], wouldRefuse: 2,
  refusals: [{ reason: 'unknown-price', count: 2, classes: ['neuro:tts_speak'] }, { reason: 'unbounded-output', count: 2, classes: ['neuro:tts_speak'] }],
  events: {}, unpricedModels: ['openai/gpt-audio-mini'], history: [{ day: '2026-10-21', usd: 0.51 }, { day: '2026-10-22', usd: 0.41 }], degraded: null,
  config: { ok: true, path: '/mnt/data/ai-gate/ledger.db', problems: [] },
  ledger: { id: '0c9a3e1f-1111-4222-8333-444455556666', path: '/mnt/data/ai-gate/ledger.db', apps: [{ app: 'neuro' }, { app: 'vantage' }] },
  peer: { state: 'match', say: 'Both apps write the same shared ledger.' },
};
const NOTE = 'Projects/Working/Call metrics in Nova (private draft).md';
const DRAFTS = {
  ok: true, contract: 'prepared-drafts-v2', items: [], counts: {}, gaps: [],
  sections: { confirm: [], work: [], communication: [], history: [] },
  today: {
    contract: 'prepared-move-history-v1', day: '2026-10-22', known: true, gaps: [], counts: {},
    items: [
      { moveKey: 'saim-move:v2:project-note:task:350', title: 'Call metrics in Nova', stage: 'verified', stageSay: 'Done and read back', atSay: '14:05', when: { say: 'Friday 23 October, 10:30–11:00', practice: false }, note: { path: NOTE, findIt: 'Projects → Working → Call metrics in Nova (private draft)' }, reply: null },
      { moveKey: 'saim-move:v2:project-note:task:358', title: 'Publish the podcast', stage: 'practice', stageSay: 'Practice run — nothing real changed', atSay: '13:40', when: { say: 'Friday 23 October, 11:05–11:35', practice: true }, note: null, reply: null },
      { moveKey: 'saim-move:v2:email-reply:x', title: 'Reply to Sam about the rota', stage: 'prepared', stageSay: 'Prepared — waiting for you', atSay: '09:12', when: null, note: null, reply: null },
    ],
  },
};

const SHELLS = {
  'settings-desktop': { page: 'desktop.html#settings', w: 1440, h: 900, wait: '.ctxset' },
  'settings-phone': { page: 'desktop.html#settings', w: 390, h: 844, wait: '.ctxset' },
  'drafts-desktop': { page: 'desktop.html#drafts', w: 1440, h: 900, wait: '#drafts-today' },
  'drafts-phone': { page: 'phone.html#drafts', w: 390, h: 844, wait: '#drafts-today' },
  'receipts-phone': { page: 'phone.html#receipts', w: 390, h: 844, wait: '[data-receipt-kind]' },
  'receipts-desktop': { page: 'phone.html#receipts', w: 1440, h: 900, wait: '[data-receipt-kind]' },
};
let current = null;
const requests = [];
let server; let skipWhy = null; const results = {};

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

test.before(async () => {
  const bin = electronBinary();
  if (!bin || !reactFor(path.join(ROOT, 'frontend')) || !reactFor(path.join(ROOT, 'saim', 'app'))) { skipWhy = 'no Electron binary or react here (set ELECTRON_PATH) — nothing was driven'; return; }
  const slash = (p) => p.replace(/\\/g, '/');
  await bundle('desktop', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.css')))};\nimport AdminPanel from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/AdminPanel.jsx')))};\nimport DraftsPage from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/DraftsPage.jsx')))};\nconst view = location.hash.slice(1);\nconst body = view === 'drafts' ? React.createElement(DraftsPage, { onNavigate() {} }) : React.createElement(AdminPanel, {});\ncreateRoot(document.getElementById('root')).render(React.createElement('main', { className: 'main-panel' }, React.createElement('div', { className: 'main-view' }, body)));\n`, path.join(ROOT, 'frontend'));
  const R = JSON.stringify;
  const receiptGallery = `[
    { target: 'live', practice: false, verified: true, complete: true, plain: 'The note is saved and read back. The block is in your calendar, just you.', next: 'Nothing else will be done.', steps: [{ step: 'note', status: 'done', path: ${R(NOTE)}, findIt: 'Projects → Working → Call metrics in Nova (private draft)', verified: [{ what: 'read back', ok: true }] }, { step: 'calendar', status: 'done', when: { say: 'Friday 23 October, 10:30–11:00' }, verified: [{ what: 'read back', ok: true }] }] },
    { target: 'sandbox', practice: true, verified: false, complete: true, plain: 'Practice run — nothing real was changed. A sandbox note was saved and read back — not your vault.', next: 'Nothing else will be done.', steps: [{ step: 'note', status: 'done', path: null }, { step: 'calendar', status: 'done', when: { say: 'Friday 23 October, 11:05–11:35' } }] },
    { target: 'live', practice: false, verified: false, complete: false, plain: 'The calendar block was not saved: HTTP 409. The note is saved and stays.', next: 'Confirm again to retry only what is missing — nothing that worked is repeated or undone.', steps: [{ step: 'note', status: 'done', path: ${R(NOTE)} }, { step: 'calendar', status: 'failed', provablyNotApplied: true, when: { say: 'Friday 23 October, 10:30–11:00' } }] },
    { complete: true, plain: 'x', next: 'y', steps: [{ step: 'note', status: 'done' }] },
  ]`;
  await bundle('phone', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/App.css')))};\nimport Drafts from ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/views/Drafts.jsx')))};\nimport { ReceiptBlock } from ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/components/PreparedMove.jsx')))};\nconst view = location.hash.slice(1);\nconst gallery = ${receiptGallery};\nconst body = view === 'drafts' ? React.createElement(Drafts, {}) : React.createElement('div', { style: { padding: 16 } }, gallery.map((r, i) => React.createElement('div', { key: i, style: { marginBottom: 18 } }, React.createElement(ReceiptBlock, { receipt: r, onOpenNote: () => { window.__notes = (window.__notes || 0) + 1; }, onAgain: () => {} }))));\ncreateRoot(document.getElementById('root')).render(body);\n`, path.join(ROOT, 'saim/app'));

  const www = path.join(tmp, 'www');
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.startsWith('/api/')) {
        requests.push({ shell: current, method: req.method, path: u, body });
        if (req.method !== 'GET') return send(503, { ok: false, error: 'stub: nothing is written in this test' });
        if (u === '/api/status') return send(200, { status: 'ok', integrations: {}, microsoft: { authenticated: false } });
        if (u === '/api/task-context/status') return send(200, CONTEXT_STATUS);
        if (u === '/api/ai-gate/profile') return send(200, PROFILE);
        if (u === '/api/prepared-moves/drafts') return send(200, DRAFTS);
        return send(503, { ok: false });
      }
      const f = path.join(www, u === '/' ? 'index.html' : u.slice(1));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(fs.readFileSync(f));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"settings-receipts-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, SR_JOB: path.join(tmp, 'job.json'), SR_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [name, s] of Object.entries(SHELLS)) {
    current = name;
    fs.writeFileSync(env.SR_JOB, JSON.stringify({ name, url: base + s.page, w: s.w, h: s.h, wait: s.wait, shots: SHOTS }));
    try { fs.rmSync(env.SR_OUT); } catch { /* none yet */ }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 120000);
      c.on('exit', () => { clearTimeout(t); try { results[name] = JSON.parse(fs.readFileSync(env.SR_OUT, 'utf8')); } catch { results[name] = { error: `no result: ${err.slice(0, 500)}` }; } resolve(); });
    });
  }
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.SR_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const { LOAD_WITH_RETRY } = require('./electron-driver-support');
const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
${LOAD_WITH_RETRY}
const job = JSON.parse(fs.readFileSync(process.env.SR_JOB, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const fail = (e) => { fs.writeFileSync(process.env.SR_OUT, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: job.w, height: job.h, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  win.setContentSize(job.w, job.h);
  await loadWithRetry(win, job.url);
  const js = (c) => win.webContents.executeJavaScript(c);
  const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(' + JSON.stringify(job.wait) + ')'))) await sleep(150);
  await sleep(600);
  const shot = async (name) => { const H = await js('document.documentElement.scrollHeight'); win.setContentSize(job.w, Math.min(H, 4000)); await sleep(300); fs.writeFileSync(path.join(job.shots, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.setContentSize(job.w, job.h); await sleep(150); };
  const past = (sel) => '[...document.querySelectorAll(' + JSON.stringify(sel) + ')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > document.documentElement.clientWidth + 1; }).length';
  const out = { found: await js('!!document.querySelector(' + JSON.stringify(job.wait) + ')') };
  if (job.name.startsWith('settings')) {
    // Both sections are collapsible: open them by their titles so they are measured open.
    await js('[...document.querySelectorAll("button, summary")].filter((b) => /Automatic context linking|AI budget \\(shadow\\)/.test(b.textContent)).forEach((b) => { if (b.getAttribute("aria-expanded") === "false") b.click(); })');
    await sleep(300);
    out.ctx = await js('(() => { const s = document.querySelector(".ctxset"); return s ? s.textContent : null; })()');
    out.aib = await js('(() => { const s = document.querySelector(".aib"); return s ? s.textContent : null; })()');
    out.past = await js(past('.ctxset *, .aib *'));
    await shot(job.name);
    // Step 1 of enabling: the confirm appears with the backfill quoted; Run stays disabled until the tick.
    await js('(() => { const b = [...document.querySelectorAll(".ctxset button")].find((x) => /Enable automatic context linking/.test(x.textContent)); if (b) b.click(); })()'); await sleep(300);
    out.confirm = await js('(() => { const b = [...document.querySelectorAll(".ctxset button")].find((x) => /Run the backfill and enable/.test(x.textContent)); return b ? { disabled: b.disabled, text: document.querySelector(".ctxset__confirm").textContent } : null; })()');
    await js('(() => { const c = document.querySelector(".ctxset__tick input"); if (c) c.click(); })()'); await sleep(200);
    out.afterTick = await js('(() => { const b = [...document.querySelectorAll(".ctxset button")].find((x) => /Run the backfill and enable/.test(x.textContent)); return b ? b.disabled : null; })()');
    await shot(job.name + '-confirm');
    // Never pressed: Cancel.
    await js('(() => { const b = [...document.querySelectorAll(".ctxset button")].find((x) => x.textContent.trim() === "Cancel"); if (b) b.click(); })()'); await sleep(200);
  } else if (job.name.startsWith('drafts')) {
    out.today = await js('document.querySelector("#drafts-today").textContent');
    out.rows = await js('[...document.querySelectorAll(".drafts__today-row")].map((r) => ({ stage: r.dataset.stage, text: r.textContent, buttons: r.querySelectorAll("button").length }))');
    out.past = await js(past('#drafts-today *'));
    await shot(job.name);
  } else {
    out.receipts = await js('[...document.querySelectorAll("[data-receipt-kind]")].map((r) => ({ kind: r.dataset.receiptKind, text: r.textContent, view: !!r.querySelector(".pmo__view") }))');
    out.past = await js(past('[data-receipt-kind] *'));
    await shot(job.name);
  }
  fs.writeFileSync(process.env.SR_OUT, JSON.stringify(out));
  win.destroy(); app.quit();
});`;

const R = (name) => { const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); assert.ok(r.found, `${name}: the page rendered`); return r; };

test('Settings: automatic context linking — Off, what it does, schedule, no next run, last result; enabling needs the tick', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of ['settings-desktop', 'settings-phone']) {
    const r = R(name);
    assert.match(r.ctx, /^Off/, `${name}: Off first`);
    assert.match(r.ctx, /Each night NEURO compares every open task with the vault/);
    assert.match(r.ctx, /Every night at 03:40 — once enabled/);
    assert.match(r.ctx, /None — it is off/);
    assert.match(r.ctx, /No scan has run yet/);
    assert.match(r.ctx, /by hand works whether this is on or off/);
    assert.ok(r.confirm, `${name}: the confirm step appeared`);
    assert.equal(r.confirm.disabled, true, `${name}: Run the backfill is disabled until the cleanup tick`);
    assert.match(r.confirm.text, /\(the backfill\)/);
    assert.equal(r.afterTick, false, `${name}: the tick enables it`);
    assert.equal(r.past, 0, `${name}: nothing past the edge`);
  }
});

test('Settings: AI budget (shadow) — today’s shared spend, Radar’s share, refusal reasons, and no cap', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of ['settings-desktop', 'settings-phone']) {
    const r = R(name);
    assert.match(r.aib, /Shadow mode\.\s*No daily cap — Nick has not chosen one\./);
    assert.match(r.aib, /\$0\.41/);
    assert.match(r.aib, /Radar — 73% of today/);
    assert.match(r.aib, /the model has no known price/);
    assert.match(r.aib, /openai\/gpt-audio-mini/);
    assert.match(r.aib, /Shared ledger: \/mnt\/data\/ai-gate\/ledger\.db · id 0c9a3e1f · registered: neuro, vantage/);
    assert.match(r.aib, /VANTAGE writes the same ledger ✓/);
  }
});

test('Drafts → Today: prepared, practice and verified told apart, with exact times and a live note’s place — desktop and phone', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of ['drafts-desktop', 'drafts-phone']) {
    const r = R(name);
    assert.deepEqual(r.rows.map((x) => x.stage), ['verified', 'practice', 'prepared'], name);
    assert.match(r.rows[0].text, /Done and read back.*Friday 23 October, 10:30–11:00.*Projects\/Working\/Call metrics in Nova \(private draft\)\.md/);
    assert.match(r.rows[1].text, /Practice run — nothing real changed.*Sandbox block · Friday 23 October, 11:05–11:35/);
    assert.doesNotMatch(r.rows[1].text, /Note ·/, 'a practice run claims no note location');
    assert.equal(r.rows[1].buttons, 0);
    assert.equal(r.past, 0, `${name}: nothing past the edge`);
  }
  assert.equal(R('drafts-desktop').rows[0].buttons, 1, 'desktop: the live note opens in the Vault');
});

test('Receipts: Done only when verified; practice labelled first; partial says so; no target claims nothing — phone and desktop widths', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of ['receipts-phone', 'receipts-desktop']) {
    const rs = R(name).receipts;
    assert.deepEqual(rs.map((x) => x.kind), ['verified', 'practice', 'real', 'unknown'], name);
    assert.match(rs[0].text, /^\s*Done.*Calendar block: done and read back · Friday 23 October, 10:30–11:00/);
    assert.match(rs[0].text, /In Obsidian: Projects → Working → Call metrics in Nova \(private draft\)\./);
    assert.equal(rs[0].view, true);
    assert.match(rs[1].text, /^\s*Practice run — nothing real was changed\. This ran against a sandbox/);
    assert.equal(rs[1].view, false, 'a practice note has no View');
    assert.equal(rs[1].text.split('nothing real was changed').length - 1, 1, 'the practice warning is said once, not three times');
    assert.match(rs[2].text, /Partly done/);
    assert.match(rs[2].text, /Ask again to finish it/);
    assert.match(rs[3].text, /I can’t confirm what this changed/);
    assert.equal(R(name).past, 0, `${name}: nothing past the edge`);
  }
});

test('nothing was written: no POST, no backfill', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.deepEqual(requests.filter((q) => q.method !== 'GET'), []);
  assert.ok(requests.some((q) => q.path === '/api/task-context/status'), 'positive control: Settings read the status');
  assert.ok(requests.some((q) => q.path === '/api/ai-gate/profile'), 'positive control: Settings read the AI budget');
});
