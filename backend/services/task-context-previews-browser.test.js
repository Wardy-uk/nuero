'use strict';

/**
 * Task-context previews on the REAL screens, in a REAL BROWSER (23 Oct 2026).
 *
 * The REAL expanded TodoItem (NEURO desktop and the NEURO phone PWA — one
 * component) and the shared ContextItem the SAiM phone renders in meeting prep
 * and prepared moves, over the REAL /api/task-context route behind the REAL
 * api-auth and authority guard, with a temp vault and DB and a real scan.
 *
 * The page always sends Nick's PIN (frontend/src/api.js). For the limited
 * screens a front proxy swaps the credential exactly as the other surfaces do:
 *   kiosk — the PIN is replaced by the kiosk's own token (saim/backend's proxy);
 *   mcp   — the PIN stays and X-Neuro-Machine-Client: mcp-local is added (mcp-server).
 *
 * Asserted at 1440 and 390: Nick's screen shows the task-bounded excerpt, the
 * provenance, the plain restriction reason and "Open source note" (which opens
 * the exact note); the kiosk and MCP screens show the title and nothing else of
 * the note; the Security review/ note is never on any screen.
 *
 * Skips, and says so, where there is no Electron binary.
 *   ELECTRON_PATH=<electron(.exe)>   overrides discovery
 *   TC_SHOTS=<dir>                   keeps the PNGs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-previews-ui-'));
const VAULT = path.join(tmp, 'vault');
const SHOTS = process.env.TC_SHOTS || path.join(tmp, 'shots');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
process.env.OBSIDIAN_VAULT_NAME = 'Nicks knowledge base';
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS']) delete process.env[k];
const SIZES = [[1440, 900], [390, 844]];
const nodePaths = [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)];

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(MAIN_CHECKOUT, 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactDir() {
  for (const b of [path.join(ROOT, 'frontend', 'node_modules'), path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}
function write(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example Catch Up.md';
const SEC = 'Security review/Service account passwords.md';
const TITLE = 'Prepare the escalation triage checklist handover pack';
const EXCERPT = 'The escalation triage checklist handover was discussed.';
const SICK = 'off sick since Monday';

let T; let T_SEC;
let mode = 'owner';
let server; let base; let skipWhy = null; const results = {};

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector('.tctx');
  const opens = [...document.querySelectorAll('.tctx .tctx__open')];
  return {
    vw, sw: document.documentElement.scrollWidth,
    text: root ? root.textContent : '',
    html: root ? root.outerHTML : '',
    excerpts: document.querySelectorAll('.tctx__excerpt').length,
    opens: opens.map((e) => ({ tag: e.tagName, href: e.getAttribute('href') })),
    titleButtons: [...document.querySelectorAll('.tctx__item--restricted button.tctx__title')].length,
    removes: document.querySelectorAll('.tctx .tctx__remove').length,
    over: [...document.querySelectorAll('.tctx *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName)),
  };
})()`;

test.before(async () => {
  const db = require('../db/database');
  const taskStore = require('./task-store');
  const tc = require('./task-context');
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  write('People/Heidi Example.md', '---\ntype: person\n---\n# Heidi Example\n');
  write('People/Sam Sample.md', '---\ntype: person\n---\n# Sam Sample\n');
  T = taskStore.createTask({ text: TITLE, source: 'test', origin_path: HR });
  T_SEC = taskStore.createTask({ text: 'Rotate the service account passwords', source: 'test', origin_path: SEC });
  write(HR, `# Catch up\n\nHeidi Example has been ${SICK} and her return to work is pending.\nSam Sample raised a grievance about the rota.\n\n## Actions\n- ${EXCERPT}\n`);
  write(SEC, '# Passwords\n\nadmin password: hunter2\nRotate the service account passwords monthly.\n');
  for (let i = 1; i <= 8; i += 1) write(`Meetings/2026/09/Filler ${i} – Weekly.md`, `# Weekly ${i}\n\nSupport team queue weekly update number ${i}.\n`);
  const on = tc.activate({ by: 'nick', confirm: true });
  assert.equal(on.ok, true);

  const bin = electronBinary();
  const nm = reactDir();
  if (!bin || !nm) { skipWhy = !bin ? 'no Electron binary here (set ELECTRON_PATH) — the screens were NOT measured' : 'no react installed'; return; }

  const www = path.join(tmp, 'www'); fs.mkdirSync(www, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  const entry = path.join(tmp, 'entry.jsx');
  fs.writeFileSync(entry, `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.css')))};
import { TodoItem } from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/TodoPanel.jsx')))};
import { registerVaultOpener } from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/openVault.js')))};
import { ContextItem } from ${JSON.stringify(slash(path.join(ROOT, 'saim/shared-ui/TaskContext.jsx')))};
registerVaultOpener((p) => { window.__opened = (window.__opened || []).concat([p]); });
const TASK = Number(new URLSearchParams(location.search).get('task'));
const TODO = { id: 1, task_id: TASK, text: 'task', priority: 'normal', moscow: 'should', source: 'NEURO', done: 0 };
function Prep() {
  // the SAiM phone: meeting prep / prepared move render ContextItem with no opener of their own
  const [items, setItems] = useState(null);
  useEffect(() => { fetch('/api/task-context/tasks/' + TASK).then((r) => r.json()).then((d) => setItems(d.pinned || [])); }, []);
  if (!items) return null;
  return React.createElement('section', { className: 'tctx tctx--compact' }, React.createElement('ul', { className: 'tctx__list' }, items.map((it) => React.createElement(ContextItem, { key: it.id, item: it, compact: true }))));
}
function Shell() {
  const body = location.hash === '#prep'
    ? React.createElement(Prep)
    : React.createElement('div', { className: 'todo-panel' }, React.createElement(TodoItem, { todo: TODO, toggling: {}, onToggle: () => {}, expanded: 'task:' + TASK, onExpand: () => {}, onPatch: async () => {}, onRefresh: () => {} }));
  return React.createElement('main', { className: 'main-panel' }, React.createElement('div', { className: 'main-view' }, body));
}
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`);
  await esbuild.build({
    entryPoints: { app: entry }, bundle: true, outdir: www, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', DEV: false, PROD: true, MODE: 'production', VITE_BUILD_LABEL: 'test' }) },
    alias: { react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), 'react/jsx-runtime': path.join(nm, 'react', 'jsx-runtime.js') },
    nodePaths: [nm, ...nodePaths],
  });
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>localStorage.setItem("neuro_pin","pin-1234")</script><script type="module" src="/app.js"></script></body></html>');

  const express = require('express');
  const app = express();
  app.use(express.json());
  // The other surfaces' credentials, swapped in where those surfaces swap them.
  app.use('/api', (req, _res, next) => {
    if (mode === 'kiosk') { delete req.headers['x-neuro-pin']; req.headers['x-neuro-kiosk-token'] = 'kiosk-9012'; }
    if (mode === 'mcp') req.headers['x-neuro-machine-client'] = 'mcp-local';
    next();
  });
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-context', require('../routes/task-context'));
  app.use('/api', (_req, res) => res.status(503).json({ ok: false }));
  app.use(express.static(www));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"tc-previews-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, NW_URL: base, NW_JOB: path.join(tmp, 'job.json'), NW_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const JOBS = {
    'owner-card': { mode: 'owner', task: T.id, hash: '' },
    'kiosk-card': { mode: 'kiosk', task: T.id, hash: '' },
    'mcp-card': { mode: 'mcp', task: T.id, hash: '' },
    'owner-phone-prep': { mode: 'owner', task: T.id, hash: '#prep' },
    'owner-security-task': { mode: 'owner', task: T_SEC.id, hash: '' },
  };
  for (const [name, j] of Object.entries(JOBS)) {
    mode = j.mode;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ name, path: `?task=${j.task}${j.hash}`, wait: j.hash === '#prep' ? '.tctx__item' : '.tctx:not(.tctx--loading)', sizes: SIZES, shots: SHOTS, measure: MEASURE }));
    try { fs.rmSync(env.NW_OUT); } catch { /* none yet */ }
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 120000);
      c.on('exit', () => { clearTimeout(t); try { results[name] = JSON.parse(fs.readFileSync(env.NW_OUT, 'utf8')); } catch { results[name] = { error: `no result: ${err.slice(0, 400)}` }; } resolve(); });
    });
  }
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.TC_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const { LOAD_WITH_RETRY } = require('./electron-driver-support');
const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
${LOAD_WITH_RETRY}
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
    await loadWithRetry(win, process.env.NW_URL + job.path);
    const js = (c) => win.webContents.executeJavaScript(c);
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(' + JSON.stringify(job.wait) + ')'))) await sleep(150);
    await sleep(700);
    const m = await js(job.measure);
    const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 4000)); await sleep(400);
    fs.writeFileSync(path.join(job.shots, job.name + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(w, h); await sleep(300);
    m.clicked = await js('(() => { const b = document.querySelector(".tctx button.tctx__open"); if (!b) return false; b.click(); return true; })()');
    await sleep(200);
    m.opened = await js('window.__opened || []');
    out.sizes.push({ size: w + 'x' + h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

const sizes = (name) => { const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); return r.sizes; };
const noLeak = (s, label) => {
  for (const bad of [SICK, 'grievance', 'hunter2', SEC]) assert.ok(!s.html.includes(bad), `${label} ${s.size}: "${bad}" must never reach the screen`);
  assert.equal(s.sw, s.vw, `${label} ${s.size}: no horizontal scroll`);
  assert.deepEqual(s.over, [], `${label} ${s.size}: nothing past the right edge`);
};

test("Nick's task card (desktop and phone): excerpt, provenance, reason, Open source note → the exact note, Remove", (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('owner-card')) {
    assert.match(s.text, /Heidi Example Catch Up/);
    assert.match(s.text, /Found automatically — this task was raised in this note\./);
    assert.match(s.text, /Contains personnel-sensitive material/);
    assert.ok(s.text.includes(EXCERPT), `${s.size}: the excerpt`);
    assert.equal(s.excerpts, 1);
    assert.deepEqual(s.opens.map((o) => o.tag), ['BUTTON'], `${s.size}: one Open source note`);
    assert.ok(s.clicked);
    assert.deepEqual(s.opened, [HR], `${s.size}: opens the exact vault note`);
    assert.ok(s.removes >= 1, 'Remove kept');
    assert.doesNotMatch(s.text, /preview withheld/);
    noLeak(s, 'owner');
  }
});

for (const who of ['kiosk', 'mcp']) {
  test(`${who}: the same link is title-only — no excerpt, reason detail or open route`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    for (const s of sizes(`${who}-card`)) {
      assert.match(s.text, /Heidi Example Catch Up/, 'the title is still there');
      assert.match(s.text, /Restricted — shown as a title only on this screen\./);
      assert.equal(s.excerpts, 0);
      assert.deepEqual(s.opens, [], 'no open route');
      assert.equal(s.titleButtons, 0, 'the title is not clickable');
      assert.ok(!s.text.includes(EXCERPT));
      assert.doesNotMatch(s.text, /personnel-sensitive/);
      assert.deepEqual(s.opened, []);
      assert.ok(!s.html.includes('Meetings/2026/10'), 'no path in the markup');
      noLeak(s, who);
    }
  });
}

test("the SAiM phone's compact item (no opener of its own) shows the excerpt and opens the note in Obsidian", (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('owner-phone-prep')) {
    assert.ok(s.text.includes(EXCERPT));
    assert.equal(s.opens.length, 1);
    assert.equal(s.opens[0].tag, 'A');
    assert.equal(s.opens[0].href, `obsidian://open?vault=Nicks%20knowledge%20base&file=${encodeURIComponent(HR.replace(/\.md$/, ''))}`);
    noLeak(s, 'prep');
  }
});

test('a task raised in a Security review/ note shows no context at all — not even for Nick', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('owner-security-task')) {
    assert.match(s.text, /No context pinned yet/);
    assert.deepEqual(s.opens, []);
    noLeak(s, 'security');
  }
});
