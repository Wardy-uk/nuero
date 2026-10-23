'use strict';

/**
 * Drafts' SECTIONS in a REAL BROWSER (Electron's Chromium), through BOTH real
 * shells, over REAL records (22 Oct 2026).
 *
 * Why: two real private-draft flows (tasks 350 and 358, 22 Oct) saved a vault
 * draft and booked a solo block, and then vanished from Drafts — traced on the
 * live DB to three rules each enough alone (a complete receipt, a booked block,
 * the 2h evidence age). "Executor completed" is not "Nick's work completed".
 *
 * Records are made SERVER-SIDE before any page loads, through the REAL routes,
 * planner, store and executor — the live executor against a fake Graph (the
 * only fake besides the email source and the duty read):
 *   scheduled  private draft, every decision answered, SAVED with a booked block
 *   nobook     private draft SAVED unfinished — no block
 *   unsaved    private draft prepared, NOT saved
 *   abandoned  saved, then abandoned by Nick
 *   ticked     saved; its task is ticked from the Drafts page itself
 *   reply      a reply draft
 *
 * Asserted, at 1440×900 (NEURO desktop) and 390×844 (SAiM phone):
 *   - four sections in order; each record in exactly its own section;
 *   - a saved draft shows its exact vault path, task, booked time and status;
 *   - the page survives a reload (it is read from NEURO, not the page);
 *   - "Open the draft" opens THAT file (desktop → Vault view; phone → Obsidian
 *     link), "Open the task" lands on THAT task, the block link names THAT event;
 *   - "Work’s done — tick the task" moves it to History, still with its path;
 *   - loading and opening write nothing to the vault.
 *
 * Skips, and says so, where no Electron binary exists (set ELECTRON_PATH).
 *   SHELL_SHOTS=<dir> keeps the PNGs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-sections-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
// The generated task export goes OUTSIDE the vault, so the vault snapshot can cover
// every file with nothing left out; the tick's export is then proven separately.
const EXPORT = path.join(tmp, 'export', 'NEURO Tasks (export).md');
process.env.NEURO_TASK_EXPORT_PATH = EXPORT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION', 'SAIM_PREPARED_MOVE_SCAN']) delete process.env[k];
for (const d of ['People', 'Meetings/2026/09', 'Projects']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
for (const n of ['Stephen Kerr', 'Heidi Ford']) fs.writeFileSync(path.join(VAULT, 'People', `${n}.md`), `---\ntype: person\n---\n# ${n}\n`);

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT); // read deps by path — never junction them in
const SOURCE = 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md';
const BASE_TEXT = 'Define achievable targets for hybrid/WFH incentive';
fs.writeFileSync(path.join(VAULT, SOURCE), `---\ntype: meeting\n---\n# Weekly Meeting\n\n### Return-to-Office Policy and Incentives\n- Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets.\n\n## Actions\n- [ ] ${BASE_TEXT}.\n\n### Team Performance\n- Stephen Kerr’s performance on hybrid WFH targets has dipped this month.\n- Heidi Ford is on leave next week; her WFH incentive is on hold.\n`);
const vaultTree = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(VAULT, p) + ':' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } }; walk(VAULT); return out.sort().join('\n'); };

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const store = require('./prepared-move-store');
const exec = require('./prepared-move-exec');
const budget = require('./authority-budget');

const COPIES = ['scheduled', 'nobook', 'unsaved', 'abandoned', 'ticked'];
const TASKS = {};
// The copy's name FIRST: a note title is cut short, and five copies must be five files.
const TEXT = (c) => `${c[0].toUpperCase()}${c.slice(1)} — ${BASE_TEXT.toLowerCase()}`;
const keyOf = (c) => `promise:${901 + COPIES.indexOf(c)}`;
const moveKeyOf = (c) => planner.moveKeyFor('project-note', `task:${TASKS[c]}`);
const emailCand = (id) => ({ ref: `held:email-${id}`, role: 'held', title: 'Renewal question', item: { type: 'email', id: 'email-urgent', title: 'Renewal question', meta: { emailId: id } } });
Object.assign(planner.DEFAULT_DEPS, {
  promise: (key) => {
    const c = COPIES.find((x) => keyOf(x) === key);
    return c ? { key, text: TEXT(c), open: true, taskIds: [TASKS[c]], leadTaskId: TASKS[c], owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } } : null;
  },
  promiseDelivered: () => false,
  prepareV1: async () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(Date.now() - 60000).toISOString() }, duty: { onDuty: true, why: 'working' }, selected: null, withheld: [], candidates: [emailCand('m1')] }),
  triageEntry: (id) => ({ id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(Date.now() - 3600000).toISOString() }),
  emailBody: async () => 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month?',
  liveReply: () => null,
  draft: async () => ({ ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick', gaps: [] }),
  diary: () => ({ known: true, events: [], fetchedAt: new Date(Date.now() - 60000).toISOString() }),
  holidays: () => new Set(), leaveState: () => 'working',
});
const working = async () => ({ onDuty: true, why: 'working' });
require('./prepared-move').readDuty = working;
exec._setDeps({ readDuty: working });

// The live executor against a fake Graph (as routes/prepared-moves-private-draft.test.js).
const EVENTS = new Map();
function fakeGraph() {
  const MARKER = require('./calendar-read').MARKER_PROP;
  return async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (u.hostname !== 'graph.microsoft.com') throw new Error(`unexpected host ${u.hostname}`);
    if (method === 'POST' && u.pathname === '/v1.0/me/events') { const id = `evt-${EVENTS.size + 1}`; EVENTS.set(id, { id, ...JSON.parse(opts.body) }); return json(201, EVENTS.get(id)); }
    if (method === 'GET' && u.pathname === '/v1.0/me/events') {
      const want = /ep\/value eq '([^']+)'/.exec(decodeURIComponent(u.search))[1];
      return json(200, { value: [...EVENTS.values()].filter((e) => (e.singleValueExtendedProperties || []).some((p) => p.id === MARKER && p.value === want)) });
    }
    const one = /^\/v1\.0\/me\/events\/([^/]+)$/.exec(u.pathname);
    if (method === 'GET' && one) return EVENTS.has(decodeURIComponent(one[1])) ? json(200, EVENTS.get(decodeURIComponent(one[1]))) : json(404, {});
    return json(500, {});
  };
}
async function confirmLive(rec, option) {
  const ms = require('./microsoft'); const realToken = ms.getAccessToken; ms.getAccessToken = async () => 'fake-token';
  const realFetch = global.fetch; global.fetch = fakeGraph();
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  budget._test.reset(); budget._test.grantToday();
  try {
    const c = exec.requestConfirmation({ recordId: rec.id, option, sessionId: 'session_drafts_0001' });
    assert.equal(c.ok, true, JSON.stringify(c));
    const live = exec.liveAdapters();
    const checks = { diary: async () => ({ known: true, clashes: [] }), availability: async () => ({ known: true, off: false, working: true }), candidate: async (pk) => planner.recheck(pk), noteState: exec.defaultChecks({ adapters: live }).noteState };
    const r = await exec.execute({ recordId: rec.id, option, grantId: c.grantId, adapters: live, checks });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.receipt.complete, true, JSON.stringify(r.receipt.steps));
    return r.receipt;
  } finally { delete process.env.SAIM_PREPARED_MOVE_EXECUTION; ms.getAccessToken = realToken; global.fetch = realFetch; }
}

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const b of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT, path.join(MAIN_CHECKOUT, 'saim', 'desktop-electron')]) {
    try { const p = require(require.resolve('electron', { paths: [b] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactFor(appDir) {
  for (const b of [path.join(appDir, 'node_modules'), path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, path.relative(ROOT, appDir), 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules')]) {
    if (fs.existsSync(path.join(b, 'react', 'package.json'))) return b;
  }
  return null;
}
async function bundleShell(name, entryCode, appDir, env = {}) {
  const nm = reactFor(appDir);
  if (!nm) throw new Error(`no react for ${appDir}`);
  const entry = path.join(tmp, `${name}-entry.jsx`);
  fs.writeFileSync(entry, entryCode);
  const out = path.join(tmp, 'www');
  await esbuild.build({
    entryPoints: { [name]: entry }, bundle: true, outdir: out, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', VITE_VAULT_API_KEY: '', DEV: false, PROD: true, MODE: 'production', VITE_BUILD_LABEL: 'test', ...env }) },
    alias: { react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), 'react/jsx-runtime': path.join(nm, 'react', 'jsx-runtime.js') },
    nodePaths: [nm, path.join(ROOT, 'node_modules'), path.join(MAIN_CHECKOUT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
  });
  const css = fs.existsSync(path.join(out, `${name}.css`)) ? `<link rel="stylesheet" href="/${name}.css">` : '';
  fs.writeFileSync(path.join(out, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${css}<style>html,body{margin:0;background:#06080c;color:#e6edf3;font-family:system-ui}*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>try{localStorage.setItem('neuro_pin','pin-1234')}catch(e){}</script><script type="module" src="/${name}.js"></script></body></html>`);
}
const slash = (p) => p.replace(/\\/g, '/');
// NEURO desktop: the real DraftsPage, with App's navigation contract and its vault opener.
const DESKTOP_ENTRY = () => `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import DraftsPage from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/DraftsPage.jsx')))};
import { registerVaultOpener } from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/openVault.js')))};
registerVaultOpener((p) => { window.__opened = (window.__opened || []).concat([p]); });
const onNavigate = (view, context = null) => { window.__navs = (window.__navs || []).concat([{ view, context }]); };
createRoot(document.getElementById('root')).render(React.createElement(DraftsPage, { context: null, onNavigate }));
`;

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const secs = [...document.querySelectorAll('.drafts__section')].map((h) => {
    const keys = []; let n = h.nextElementSibling;
    while (n && !n.classList.contains('drafts__section') && !n.classList.contains('drafts__history')) { n.querySelectorAll('[data-move-key]').forEach((e) => keys.push(e.getAttribute('data-move-key'))); n = n.nextElementSibling; }
    return { title: h.textContent.trim(), keys };
  });
  const hist = [...document.querySelectorAll('.drafts__history [data-move-key]')].map((e) => e.getAttribute('data-move-key'));
  const row = (k) => { const e = document.querySelector('[data-move-key="' + k + '"]'); return e ? e.textContent : null; };
  const link = (k, text) => { const e = document.querySelector('[data-move-key="' + k + '"]'); if (!e) return null; const a = [...e.querySelectorAll('a')].find((x) => x.textContent.trim() === text); return a ? a.getAttribute('href') : null; };
  const over = [...document.querySelectorAll('.drafts *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).length;
  return { vw, sw: document.documentElement.scrollWidth, over, secs, hist, rows: Object.fromEntries(JSON.parse(KEYS).map((k) => [k, row(k)])), links: Object.fromEntries(JSON.parse(KEYS).map((k) => [k, { draft: link(k, 'Open the draft'), block: link(k, 'View the calendar block') }])) };
})()`;

const { LOAD_WITH_RETRY } = require('./electron-driver-support');
const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
${LOAD_WITH_RETRY}
const job = JSON.parse(fs.readFileSync(process.env.J, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const fail = (e) => { fs.writeFileSync(process.env.O, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: job.w, height: job.h, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  win.setContentSize(job.w, job.h);
  const js = (c) => win.webContents.executeJavaScript(c);
  const ready = async () => { const t0 = Date.now(); while (Date.now() - t0 < 25000 && !(await js('document.querySelectorAll(".drafts__section").length >= 3'))) await sleep(150); await sleep(500); };
  const measure = () => js(job.measure.split('KEYS').join(JSON.stringify(JSON.stringify(job.keys))));
  const shot = async (n) => { const H = await js('document.documentElement.scrollHeight'); win.setContentSize(job.w, Math.min(H, 4000)); await sleep(400); fs.writeFileSync(path.join(job.shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); win.setContentSize(job.w, job.h); await sleep(200); };
  const out = {};
  await loadWithRetry(win, job.url); await ready();
  out.first = await measure(); await shot(job.name);
  // A refresh: everything is read from NEURO again.
  // (The phone consumes ?tab= on launch, so its refresh is a fresh load of Drafts.)
  if (job.freshLoad) await loadWithRetry(win, job.url); else await win.webContents.reload();
  await ready();
  out.reloaded = await measure();
  if (job.press) {
    const click = (k, label) => js('(() => { const r = document.querySelector(' + JSON.stringify('[data-move-key="' + k + '"]') + '); const b = r && [...r.querySelectorAll("button")].find((x) => x.textContent.trim() === ' + JSON.stringify(label) + '); if (!b) return false; b.click(); return true; })()');
    out.pressed = { draft: await click(job.keys[0], 'Open the draft'), task: await click(job.keys[0], 'Open the task') };
    await sleep(300);
    out.opened = await js('window.__opened || []'); out.navs = await js('window.__navs || []');
    out.pressed.tick = await click(job.tickKey, 'Work’s done — tick the task');
    await sleep(1500);
    out.afterTick = await measure(); await shot(job.name + '-after-tick');
  }
  fs.writeFileSync(process.env.O, JSON.stringify(out));
  app.quit();
});`;

let server; let base; let skipWhy = null; const results = {}; const PATHS = {};
const SHOTS = process.env.SHELL_SHOTS || path.join(tmp, 'shots');
let replyKey = null;
async function api(p, body) {
  const res = await fetch(`${base}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-NEURO-PIN': 'pin-1234' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — the real shells were NOT driven'; return; }
  await db.init();
  store.ensure();
  const ts = require('./task-store');
  for (const c of COPIES) { ts.createTask({ text: TEXT(c), source: 'meeting-promotion', origin_path: SOURCE }); TASKS[c] = db.get('SELECT id FROM tasks WHERE text = ?', [TEXT(c)]).id; }

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(tmp, 'www')));
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/prepared-moves', require('../routes/prepared-moves'));
  app.use('/api/tasks', require('../routes/tasks'));
  app.use('/api', (req, res) => res.status(503).json({ ok: false, error: 'not available in this test' }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await bundleShell('desktop', DESKTOP_ENTRY(), path.join(ROOT, 'frontend'));
  await bundleShell('phone', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/App.jsx')))};\nimport ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/App.css')))};\ncreateRoot(document.getElementById('root')).render(React.createElement(App));\n`, path.join(ROOT, 'saim/app'), { VITE_API_URL: base });

  // ── REAL records, through the real routes and the live executor ──
  const walk = async (m, n) => {
    const plan = [['t', 'Two days WFH a week at or above 90% of FRT target'], ['p'], ['t', 'Everyone on the service desk'], ['p']].slice(0, n);
    for (const [k, text] of plan) {
      if (!m || !m.question) break; // SAiM is not asking anything more
      const r = await api('/api/prepared-moves/answer', { recordId: m.recordId, version: m.version, questionId: m.question.id, ...(k === 'p' ? { park: true } : { text }) });
      assert.equal(r.status, 200, JSON.stringify(r.body)); m = r.body.promiseMove;
    }
    return m;
  };
  for (const c of COPIES) {
    const p = await api('/api/prepared-moves/prepare', { ref: `promise:${keyOf(c)}` });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    await walk(p.body.promiseMove, c === 'scheduled' ? 4 : 1);
  }
  for (const c of ['scheduled', 'nobook', 'abandoned', 'ticked']) {
    const rec = store.latest(moveKeyOf(c));
    const receipt = await confirmLive(rec, c === 'scheduled' ? 'approve' : 'unfinished');
    PATHS[c] = receipt.steps.find((x) => x.step === 'note').target;
  }
  assert.equal((await api('/api/prepared-moves/drafts/outcome', { moveKey: moveKeyOf('abandoned'), outcome: 'abandoned' })).status, 200);
  const g = await api('/api/prepared-moves/prepare', { ref: 'held:email-m1' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const rid = g.body.move && g.body.move.recordId;
  replyKey = rid ? store.get(rid).moveKey : null;
  assert.ok(replyKey, 'a reply draft was prepared');

  require('./task-store').flushExport();
  results.exportBefore = fs.existsSync(EXPORT) ? fs.readFileSync(EXPORT, 'utf8') : null;
  results.vaultBefore = vaultTree();
  fs.mkdirSync(SHOTS, { recursive: true });
  const appDir = path.join(tmp, 'driver'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'drafts-sections-driver', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), DRIVER);
  const env = { ...process.env, J: path.join(tmp, 'job.json'), O: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const keys = [moveKeyOf('scheduled'), moveKeyOf('nobook'), moveKeyOf('unsaved'), moveKeyOf('abandoned'), moveKeyOf('ticked'), replyKey];
  const run = (job) => new Promise((resolve) => {
    fs.writeFileSync(env.J, JSON.stringify({ ...job, keys, shots: SHOTS, measure: MEASURE, tickKey: moveKeyOf('ticked') }));
    try { fs.rmSync(env.O); } catch { /* none yet */ }
    const child = require('child_process').spawn(bin, [appDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 150000);
    child.on('exit', () => { clearTimeout(t); try { resolve(JSON.parse(fs.readFileSync(env.O, 'utf8'))); } catch { resolve({ error: `no result: ${err.slice(0, 600)}` }); } });
  });
  results.phone = await run({ name: 'drafts-phone-390x844', url: `${base}/phone.html?tab=drafts`, w: 390, h: 844, freshLoad: true });
  results.desktop = await run({ name: 'drafts-desktop-1440x900', url: `${base}/desktop.html`, w: 1440, h: 900, press: true });
  require('./task-store').flushExport();
  results.vaultAfter = vaultTree();
  results.exportAfter = fs.existsSync(EXPORT) ? fs.readFileSync(EXPORT, 'utf8') : null;
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.SHELL_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const SECTIONS = ['Needs your confirmation', 'Ready for you to work on', 'Communication drafts'];
function placed(m) {
  const where = {};
  for (const s of m.secs) for (const k of s.keys) where[k] = (where[k] || []).concat([s.title]);
  for (const k of m.hist) where[k] = (where[k] || []).concat(['History']);
  return where;
}

test('both shells: four sections; each real record in exactly its own section — before and after a reload', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const shell of ['desktop', 'phone']) {
    const r = results[shell];
    assert.ok(!r.error, `${shell}: ${r.error}`);
    for (const m of [r.first, r.reloaded]) {
      assert.deepEqual(m.secs.map((s) => s.title), SECTIONS, shell);
      const w = placed(m);
      assert.deepEqual(w[moveKeyOf('scheduled')], ['Ready for you to work on'], `${shell}: saved + scheduled`);
      assert.deepEqual(w[moveKeyOf('nobook')], ['Ready for you to work on'], `${shell}: saved, no block`);
      assert.deepEqual(w[moveKeyOf('unsaved')], ['Needs your confirmation'], `${shell}: prepared, not saved`);
      assert.deepEqual(w[moveKeyOf('abandoned')], ['History'], `${shell}: abandoned`);
      assert.deepEqual(w[replyKey], ['Needs your confirmation'], `${shell}: the reply draft`);
      assert.equal(m.sw, m.vw, `${shell}: no sideways scroll`);
      assert.equal(m.over, 0, `${shell}: nothing past the edge`);
    }
    assert.deepEqual(r.first.secs, r.reloaded.secs, `${shell}: identical after a reload`);
  }
});

test('a saved draft says exactly where it is, its task and its booked time', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const shell of ['desktop', 'phone']) {
    const s = results[shell].first.rows[moveKeyOf('scheduled')];
    assert.ok(s.includes(PATHS.scheduled), `${shell}: exact path — ${s}`);
    assert.ok(s.includes(`#${TASKS.scheduled}`), `${shell}: the linked task`);
    assert.match(s, /Draft saved · scheduled for \w+day \d+ \w+, \d{2}:\d{2}/);
    assert.match(s, /Booked ?\w+day \d+ \w+, \d{2}:\d{2}–\d{2}:\d{2}/);
    assert.match(s, /Private working draft/);
    const n = results[shell].first.rows[moveKeyOf('nobook')];
    assert.match(n, /Unfinished draft saved · no time booked/);
    assert.ok(n.includes(PATHS.nobook));
    assert.match(results[shell].first.rows[replyKey], /Reply draft/);
    assert.match(results[shell].first.rows[moveKeyOf('abandoned')], /You abandoned this draft/);
  }
  assert.ok(fs.existsSync(path.join(VAULT, PATHS.scheduled)) && fs.existsSync(path.join(VAULT, PATHS.nobook)), 'the files really exist');
});

test('opening: THAT file, THAT task, THAT calendar event', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const d = results.desktop;
  assert.deepEqual(d.pressed, { draft: true, task: true, tick: true });
  assert.deepEqual(d.opened, [PATHS.scheduled], 'the Vault view opens the exact saved file');
  assert.deepEqual(d.navs, [{ view: 'todos', context: { taskId: TASKS.scheduled, fromFocus: true } }]);
  const ev = [...EVENTS.values()].find((e) => /Finish/.test(e.subject || ''));
  assert.ok(ev, 'the block was really booked');
  const blockHref = d.first.links[moveKeyOf('scheduled')].block;
  assert.match(blockHref, /^https:\/\/outlook\.office\.com\/calendar\/item\/evt-\d+$/);
  assert.ok(EVENTS.has(decodeURIComponent(blockHref.split('/').pop())), 'the link names an event that exists');
  assert.equal(d.first.links[moveKeyOf('nobook')].block, null, 'no block, no block link');
  // The phone has no Vault view: the draft opens in Obsidian, at the exact path.
  const href = results.phone.first.links[moveKeyOf('scheduled')].draft;
  assert.ok(href && href.startsWith('obsidian://open?vault='), href);
  assert.ok(decodeURIComponent(href.split('&file=')[1]) === PATHS.scheduled.replace(/\.md$/, ''), href);
});

test('"Work’s done — tick the task" moves the draft to History, still saying where it lives', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const before = placed(results.desktop.first);
  assert.deepEqual(before[moveKeyOf('ticked')], ['Ready for you to work on']);
  const after = placed(results.desktop.afterTick);
  assert.deepEqual(after[moveKeyOf('ticked')], ['History']);
  assert.match(results.desktop.afterTick.rows[moveKeyOf('ticked')], /Done — you ticked the task/);
  assert.ok(results.desktop.afterTick.rows[moveKeyOf('ticked')].includes(PATHS.ticked));
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', [TASKS.ticked]).status, 'done', 'the real task was ticked');
});

test('loading, reloading and opening wrote nothing to the vault', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  // EVERY vault file is compared — nothing is stripped. The task export (which the tick
  // legitimately regenerates) is written outside the vault in this test, and both
  // snapshots are taken after task-store's debounced writer has been settled.
  assert.equal(results.vaultAfter, results.vaultBefore);
  assert.ok(results.vaultAfter.includes('Projects'), 'positive control: the saved drafts are in the snapshot');
  assert.ok(!results.vaultAfter.includes('NEURO Tasks (export)'), 'the export never landed in the vault');
});

test('the tick did reach the generated task export (written outside the vault, so it is checked here)', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.ok(results.exportBefore && results.exportBefore.includes(TEXT('ticked')), 'before: the ticked task is listed as open');
  assert.ok(results.exportAfter && !results.exportAfter.includes(TEXT('ticked')), 'after: the export no longer lists it as open');
  assert.ok(results.exportAfter.includes(TEXT('scheduled')), 'positive control: other open tasks are still listed');
});
