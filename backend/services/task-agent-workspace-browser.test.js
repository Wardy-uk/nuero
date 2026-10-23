'use strict';

/**
 * "Do this" — the CONCISE WORKSPACE on the REAL screens (23 Oct 2026, redesign).

 Desktop (1440), the NEURO phone PWA (the same TodoItem at 390) and the SAiM phone
 mount, over the real routes, auth, guard, service and provider (SDK scripted):
   - the Heidi employment task: Status / What NEURO has done / What I need from you,
     ONE specific question with choices + Other, the trace CLOSED with its summary,
     no numbered transcript above the fold, no generic "anything further";
   - answering it: the brief records the decision, the run is Ready, no new question;
   - a normal task that needs no question; a genuine ambiguity;
   - refresh/resume restores the same single question;
   - a repeated press: no duplicate run and no repeated question;
   - the kiosk: no workspace at all.
 Screenshots with TA_SHOTS=<dir>. (The earlier second-pass description follows.)

 ---
 *
 * The REAL expanded TodoItem (NEURO desktop and the NEURO phone PWA — one
 * component, at 1440×900 and 390×844) and the SAiM mount of the shared TaskAgent
 * — as the phone app, as the desktop Electron window (window.saimNative), and as
 * the kiosk (?surface=kiosk) — over the REAL /api/task-agent and
 * /api/prepared-moves routes behind the REAL api-auth and authority guard, the
 * REAL task-agent service and the REAL Anthropic provider with only the SDK
 * client scripted.
 *
 * Asserted (and screenshotted, TA_SHOTS=<dir>):
 *   - Nick presses Do this; NEURO completes several safe steps without asking;
 *   - "Save to vault…" opens the EXISTING prepared-move confirmation, its
 *     request is made and Confirm is shown — and never pressed; the vault is
 *     byte-identical afterwards;
 *   - the Claude handoff preview (why, included, excluded, statement, editable
 *     prompt), then the press records the handoff;
 *   - a genuine ambiguity: one question; a people matter: brief + decision stop;
 *   - a prepared email waits for Actions;
 *   - the Electron desktop shows Do this; the kiosk shows nothing;
 *   - no restricted body or Security review/ content on any screen;
 *   - nothing past the right edge at either width.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-ws-ui-'));
const VAULT = path.join(tmp, 'vault');
const SHOTS = process.env.TA_SHOTS || path.join(tmp, 'shots');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
delete process.env.ANTHROPIC_API_KEY;
process.env.AI_MODE = 'hybrid';
// The device lock open in THIS throwaway process only, so the real confirmation can be SHOWN.
process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
delete process.env.AI_GATE_MODE;
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS', 'OPENROUTER_ALLOWED_TASKS']) delete process.env[k];
const nodePaths = [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)];

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
function write(rel, text) { const p = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
function vaultHash() {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (!/NEURO Tasks \(export\)\.md$/.test(p)) out[path.relative(VAULT, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } };
  walk(VAULT);
  return out;
}

const PLAN = 'Projects/Support Rota/Q4 rota notes.md';
const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example leaver catch up.md';
const SEC = 'Security review/Service account passwords.md';
// The hard-excluded NOTE (its path, title, content) — not the words "Security review/",
// which the handoff preview names on purpose in its "Never included" list.
const LEAK = ['private family matter', 'hunter2', SEC, 'Service account passwords'];

const T = {};
let mode = 'owner';
let server; let base; let skipWhy = null; const results = {};
let vaultBefore = null; let outward = null;

const anthropic = require('./providers/anthropic-provider');
const taSettings = require('./task-agent-settings');
let script = []; let nid = 1;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use') => ({ model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage: { input_tokens: 1400, output_tokens: 350 } });
const end = () => reply([{ type: 'text', text: 'ok' }], 'end_turn');
anthropic._internals.setClient({ messages: { create: async () => script.shift() || end() } });
global.fetch = async () => { throw new Error('network blocked'); };

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector('.tagent');
  const vis = (e) => e && !e.closest('details:not([open])') && (typeof e.checkVisibility !== 'function' || e.checkVisibility());
  const trace = document.querySelector('[data-tagent-trace]');
  return {
    vw, sw: document.documentElement.scrollWidth,
    present: !!root,
    status: root ? root.getAttribute('data-tagent') : null,
    statusLine: (document.querySelector('.tagent__statusline') || {}).textContent || '',
    wont: (document.querySelector('.tagent__wont') || {}).textContent || '',
    done: [...document.querySelectorAll('[data-tagent-done] li')].map((e) => e.textContent.trim()),
    openBrief: [...document.querySelectorAll('[data-tagent-done] button')].map((b) => b.textContent.trim()),
    questions: [...document.querySelectorAll('.tagent__qtext')].filter(vis).length,
    question: (document.querySelector('.tagent__qtext') || {}).textContent || '',
    options: [...document.querySelectorAll('.tagent__opts button')].map((b) => b.textContent),
    traceOpen: trace ? trace.open : null,
    traceSummary: trace ? trace.querySelector('summary').textContent : '',
    stepsVisible: [...document.querySelectorAll('.tagent__steps li')].filter(vis).length,
    sectionsBeforeTrace: [...document.querySelectorAll('.tagent > *')].slice(0, 3).map((e) => e.className),
    draftsOpen: [...document.querySelectorAll('.tagent__out')].filter((d) => d.open).length,
    text: root ? root.textContent : '',
    html: document.body.innerHTML,
    agentHtml: root ? root.outerHTML : '',
    goButton: [...document.querySelectorAll('.tagent button')].some((b) => b.textContent.trim() === 'Do this'),
    over: [...document.querySelectorAll('.tagent *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName)),
  };
})()`;

let calls = 0;
anthropic._internals.setClient({ messages: { create: async () => { calls += 1; return script.shift() || end(); } } });

test.before(async () => {
  const db = require('../db/database');
  const taskStore = require('./task-store');
  const tc = require('./task-context');
  const agent = require('./task-agent');
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  taSettings.save({ apiKey: 'sk-ant-test-not-a-real-key-0000000000', enabled: true, dailyUsd: 50, dailyRuns: 200 });
  write(PLAN, '# Q4 rota notes\n\nCover gaps: weeks 44 and 47. Two people on leave in week 47.\n');
  write(HR, '---\nprivate: true\n---\n# Leaver catch up\n\nHeidi Example disclosed a private family matter which is confidential.\nAgreed to confirm Heidi Example end date once HR reply.\n');
  write(SEC, '# Passwords\n\nadmin password: hunter2\n');
  const mk = (text, extra = {}) => taskStore.createTask({ text, source: 'test', ...extra }).task;
  T.plain = mk('Plan the Q4 support rota cover');
  T.amb = mk('Sort out the report');
  T.hr = mk("Set and confirm Heidi Example's end date before September 30; consider short retention", { origin_path: HR });
  T.hr2 = mk("Confirm Heidi Example's last working day with HR", { origin_path: HR });
  tc.ensure();
  assert.equal(tc.link({ taskId: T.plain.id, type: 'note', ref: PLAN }).ok, true);
  const now = new Date().toISOString();
  const ins = (taskId, ref, title) => db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, origin, state, confidence, reasons_json, restricted, created_at, updated_at) VALUES (?, 'note', ?, ?, 'nightly-scan', 'pinned', 1, '[{"code":"origin","say":"This task was raised in this note."}]', 1, ?, ?)`, [taskId, ref, title, now, now]);
  for (const t of [T.hr, T.hr2]) { ins(t.id, HR, 'Leaver catch up'); ins(t.id, SEC, 'Service account passwords'); }

  const brief = '## Facts (from the linked note)\n- HR reply awaited before the end date is confirmed [ctx]\n## Options\n- 30 September 2026\n- 31 December 2026 (short retention)\n## Risks\n- Confirming before HR replies\n## Decision\nOpen — yours to decide.';
  const askDate = tu('ask_nick', { kind: 'authority', question: 'What end date should the brief record for Heidi Example?', why: 'The end date sets the notice letter and the handover plan.', after: 'NEURO will record it in the private brief and stop. It will not contact anyone or change anything.', options: ['30 September 2026', '31 December 2026'] });
  // The employment task: brief, a refused generic question, then the specific decision.
  for (const t of [T.hr, T.hr2]) {
    script = [reply([tu('save_output', { kind: 'brief', title: 'Heidi Example – End Date Decision Brief', markdown: brief })]),
      reply([tu('ask_nick', { kind: 'authority', question: 'This is an employment matter. What do you decide, and should NEURO prepare anything further?', why: 'x', after: 'y' })]),
      reply([askDate]), end()];
    await agent.start(t.id, { awaitTurn: true });
  }
  script = [reply([tu('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'They have different audiences and deadlines.', after: 'NEURO will draft that report’s outline from last week’s figures.', options: ['Weekly risk report', 'SOAP report'] })]), end()];
  await agent.start(T.amb.id, { awaitTurn: true });
  // Queued in order: T.hr2's answer turn (clicked in the browser), then the plain press.
  script = [
    reply([tu('save_output', { kind: 'brief', title: 'Heidi Example – End Date Decision Brief', markdown: brief.replace('Open — yours to decide.', 'Nick: 31 December 2026 (stated 23 Oct 2026).') })]),
    reply([tu('finish', { completed: ['Recorded your decision in the private brief'], remaining: ['Issue the letter yourself, when you are ready'] })]),
    reply([tu('read_note', { path: PLAN })]), reply([tu('save_output', { kind: 'plan', title: 'Q4 rota cover plan', markdown: '- Week 44: early/late split\n- Week 47: swap 2nd line', sources: ['ctx:1'] })]),
    reply([tu('finish', { completed: ['Drafted the cover plan'], remaining: ['Publish the rota — your step'] })]),
  ];
  results.callsBeforeBrowser = calls;
  const bin = electronBinary();
  const nm = reactDir();
  if (!bin || !nm) { skipWhy = !bin ? 'no Electron binary here (set ELECTRON_PATH) — the screens were NOT measured' : 'no react installed'; return; }

  const www = path.join(tmp, 'www'); fs.mkdirSync(www, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  const entry = path.join(tmp, 'entry.jsx');
  fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.css')))};
import { TodoItem } from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/TodoPanel.jsx')))};
import TaskAgent from ${JSON.stringify(slash(path.join(ROOT, 'saim/shared-ui/TaskAgent.jsx')))};
import PreparedMove from ${JSON.stringify(slash(path.join(ROOT, 'saim/app/src/components/PreparedMove.jsx')))};
import { platformNow } from ${JSON.stringify(slash(path.join(ROOT, 'saim/shared-ui/presentation/platform.mjs')))};
const q = new URLSearchParams(location.search);
if (q.get('native') === '1') window.saimNative = {}; // the desktop Electron window's preload bridge
const TASK = Number(q.get('task'));
const TODO = { id: 1, task_id: TASK, text: q.get('text') || 'task', priority: 'normal', moscow: 'should', source: 'NEURO', done: 0 };
const call = async (p, { method = 'GET', body } = {}) => { const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-NEURO-PIN': 'pin-1234' }, body: body === undefined ? undefined : JSON.stringify(body) }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
function Shell() {
  // #saim = the SAiM app's mount, exactly as Tasks.jsx writes it.
  const body = location.hash === '#saim'
    ? React.createElement('div', { className: 'tasks__panel', style: { padding: 12, color: '#e8eef5', background: '#0b1016', minHeight: '100vh' } },
        React.createElement('div', null, TODO.text),
        React.createElement(TaskAgent, { taskId: TASK, call, readOnly: platformNow() === 'kiosk', renderSave: (recordId, done) => React.createElement(PreparedMove, { call, recordId, embedded: true, onChanged: done }) }))
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
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>localStorage.setItem("neuro_pin","pin-1234");localStorage.setItem("saim_pin","pin-1234")</script><script type="module" src="/app.js"></script></body></html>');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { if (mode === 'kiosk') { delete req.headers['x-neuro-pin']; req.headers['x-neuro-kiosk-token'] = 'kiosk-9012'; } next(); });
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-agent', require('../routes/task-agent'));
  app.use('/api/task-context', require('../routes/task-context'));
  app.use('/api/prepared-moves', require('../routes/prepared-moves'));
  app.use('/api', (_req, res) => res.status(503).json({ ok: false }));
  app.use(express.static(www));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"task-agent-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, NW_URL: base, NW_JOB: path.join(tmp, 'job.json'), NW_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const D = [[1440, 900], [390, 844]]; const P = [[390, 844]]; const W = [[1440, 900]];
  const enc = encodeURIComponent;
  const save = [{ click: 'Save to vault…', wait: '.tagent__save .pmo__btn--yes', shot: 'save-opened' }, { clickIn: '.tagent__save', click: '*primary', waitText: ['.tagent__save', 'Confirm'], shot: 'save-confirmation' }];
  const claude = [{ click: 'Hand off to Claude on desktop…', wait: '[data-tagent-claude="preview"]', shot: 'claude-preview' }, { click: 'Continue this with Claude on desktop', wait: '[data-tagent-claude-handoff]', shot: 'claude-recorded' }];
  const JOBS = {
    'hr-desktop': { task: T.hr, sizes: [[1440, 900]], wait: '[data-tagent="needs-decision"]', steps: [{ click: 'Open brief', wait: '.tagent__out[open]', shot: 'brief-opened' }, { click: 'Activity and evidence', clickSummary: true, wait: '[data-tagent-trace][open]', shot: 'trace-opened' }] },
    'hr-neuro-phone': { task: T.hr, sizes: [[390, 844]], wait: '[data-tagent="needs-decision"]' },
    'hr-saim-phone': { task: T.hr, hash: '#saim', sizes: [[390, 844]], wait: '[data-tagent="needs-decision"]' },
    'hr-refresh': { task: T.hr, sizes: [[1440, 900]], wait: '[data-tagent="needs-decision"]', steps: [{ reload: true, wait: '[data-tagent="needs-decision"]', shot: 'after-refresh' }, { click: 'Do this', wait: '[data-tagent="needs-decision"]' }] },
    'hr-answer': { task: T.hr2, sizes: [[1440, 900]], wait: '[data-tagent="needs-decision"]', steps: [{ click: '31 December 2026', wait: '[data-tagent="ready"]', shot: 'answered' }] },
    'amb-desktop': { task: T.amb, sizes: [[1440, 900], [390, 844]], wait: '[data-tagent="needs-answer"]', steps: [{ click: 'Other — explain', wait: '.tagent__answer', shot: 'other' }] },
    'amb-saim-phone': { task: T.amb, hash: '#saim', sizes: [[390, 844]], wait: '[data-tagent="needs-answer"]' },
    'plain-press': { task: T.plain, sizes: [[1440, 900]], wait: '[data-tagent="idle"]', steps: [{ click: 'Do this', double: true, wait: '[data-tagent="ready"]', shot: 'ready' }] },
    'plain-neuro-phone': { task: T.plain, sizes: [[390, 844]], wait: '[data-tagent="ready"]' },
    'plain-saim-phone': { task: T.plain, hash: '#saim', sizes: [[390, 844]], wait: '[data-tagent="ready"]' },
    'kiosk': { task: T.hr, hash: '#saim', surface: 'kiosk', mode: 'kiosk', sizes: [[390, 844]], wait: '.tasks__panel' },
  };
  vaultBefore = vaultHash();
  const db2 = require('../db/database');
  const cnt = (sql) => { try { return db2.get(sql).n; } catch { return 'absent'; } };
  const outwardNow = () => ({ ledger: cnt('SELECT COUNT(*) n FROM external_write_ledger'), spent: cnt('SELECT COUNT(*) n FROM human_action_intents WHERE used_at IS NOT NULL'), approved: cnt("SELECT COUNT(*) n FROM prepared_actions WHERE status != 'prepared'"), tasks: JSON.stringify(db2.all('SELECT id, status, text FROM tasks ORDER BY id')) });
  const outwardBefore = outwardNow();
  for (const [name, j] of Object.entries(JOBS)) {
    mode = j.mode || 'owner';
    const qs = `?task=${j.task.id}&text=${enc(j.task.text)}${j.surface ? `&surface=${j.surface}` : ''}${j.native ? '&native=1' : ''}${j.hash || ''}`;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ name, path: qs, wait: j.wait, steps: j.steps || [], sizes: j.sizes, shots: SHOTS, measure: MEASURE }));
    try { fs.rmSync(env.NW_OUT); } catch { /* none yet */ }
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 150000);
      c.on('exit', () => { clearTimeout(t); try { results[name] = JSON.parse(fs.readFileSync(env.NW_OUT, 'utf8')); } catch { results[name] = { error: `no result: ${err.slice(0, 400)}` }; } resolve(); });
    });
  }
  outward = { before: outwardBefore, after: outwardNow() };
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.TA_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

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
    const until = async (cond) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js(cond))) await sleep(150); return js(cond); };
    const has = (sel) => '!!document.querySelector(' + JSON.stringify(sel) + ')';
    const hasText = (sel, t) => '[...document.querySelectorAll(' + JSON.stringify(sel + ' button') + ')].some((b) => b.textContent.trim() === ' + JSON.stringify(t) + ')';
    const shot = async (label) => {
      const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 4000)); await sleep(400);
      fs.writeFileSync(path.join(job.shots, job.name + (label ? '-' + label : '') + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
      win.setContentSize(w, h); await sleep(250);
    };
    const found = await until(has(job.wait));
    await sleep(500);
    const m0 = await js(job.measure);
    await shot('');
    const stepsOut = [];
    for (const s of job.steps) {
      if (s.reload) {
        win.webContents.reload(); await sleep(300);
        const ok = await until(has(s.wait)); await sleep(500);
        const m = await js(job.measure); if (s.shot) await shot(s.shot);
        stepsOut.push({ reload: true, ok, ...m }); continue;
      }
      const root = s.clickIn || '.tagent';
      const sel = s.clickSummary ? root + ' summary' : root + ' button';
      const clicked = s.double
        ? await js('(() => { const b = [...document.querySelectorAll(' + JSON.stringify(sel) + ')].find((x) => x.textContent.trim() === ' + JSON.stringify(s.click) + '); if (!b) return false; b.click(); b.click(); return true; })()')
        : s.clickSummary
        ? await js('(() => { const b = [...document.querySelectorAll(' + JSON.stringify(sel) + ')].find((x) => x.textContent.trim().startsWith(' + JSON.stringify(s.click) + ')); if (!b) return false; b.click(); return true; })()')
        : s.click === '*primary'
        ? await js('(() => { const b = document.querySelector(' + JSON.stringify(root + ' .pmo__btn--yes') + '); if (!b) return false; b.click(); return true; })()')
        : await js('(() => { const b = [...document.querySelectorAll(' + JSON.stringify(root + ' button') + ')].find((x) => x.textContent.trim() === ' + JSON.stringify(s.click) + '); if (!b) return false; b.click(); return true; })()');
      const ok = s.waitText ? await until(hasText(s.waitText[0], s.waitText[1])) : await until(has(s.wait));
      await sleep(500);
      const m = await js(job.measure);
      if (s.shot) await shot(s.shot);
      stepsOut.push({ click: s.click, clicked, ok, ...m });
    }
    out.sizes.push({ size: w + 'x' + h, found, ...m0, steps: stepsOut });
    win.destroy();
  }
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

const sizes = (name) => { const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); return r.sizes; };
const clean = (s, label) => {
  for (const bad of ['private family matter', 'hunter2']) assert.ok(!s.html.includes(bad), `${label} ${s.size}: "${bad}" must never reach the screen`);
  for (const bad of LEAK) assert.ok(!s.agentHtml.includes(bad), `${label} ${s.size}: "${bad}" must never reach the Do this workspace`);
  assert.equal(s.sw, s.vw, `${label} ${s.size}: no horizontal scroll`);
  assert.deepEqual(s.over, [], `${label} ${s.size}: nothing past the right edge`);
};

const STATUS_CLASS = 'tagent__statusblock';
function concise(s, label) {
  assert.equal(s.present, true, label);
  assert.equal(s.sectionsBeforeTrace[0], STATUS_CLASS, `${label}: Status first`);
  assert.equal(s.traceOpen, false, `${label}: trace closed by default`);
  assert.match(s.traceSummary, /^Activity and evidence · \d+ permitted sources? used · \d+ internal steps?$/, label);
  assert.equal(s.stepsVisible, 0, `${label}: no numbered transcript visible by default`);
  assert.equal(s.draftsOpen, 0, `${label}: drafts folded until opened`);
  assert.ok(s.done.length <= 3, `${label}: at most three done lines`);
  assert.ok(s.questions <= 1, `${label}: never more than one question`);
}

test('the Heidi employment task — desktop, NEURO phone, SAiM phone: three parts, one SPECIFIC question, safeguards stated', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const [name, s] of [['desktop', sizes('hr-desktop')[0]], ['neuro-phone', sizes('hr-neuro-phone')[0]], ['saim-phone', sizes('hr-saim-phone')[0]]]) {
    concise(s, name);
    assert.equal(s.status, 'needs-decision');
    assert.equal(s.statusLine, 'Waiting for your decision');
    assert.match(s.wont, /will not decide, contact anyone, promise anything or change anything/);
    assert.equal(s.questions, 1);
    assert.equal(s.question, 'What end date should the brief record for Heidi Example?');
    assert.deepEqual(s.options, ['30 September 2026', '31 December 2026', 'Other — explain']);
    assert.ok(s.done.some((d) => /Prepared a private brief: “Heidi Example – End Date Decision Brief”/.test(d)), name);
    assert.ok(s.done.some((d) => /No one has been contacted and nothing has been changed\./.test(d)), name);
    assert.ok(s.openBrief.includes('Open brief'), name);
    assert.doesNotMatch(s.text, /anything further/);
    assert.doesNotMatch(s.text, /Save to vault/);
    clean(s, name);
  }
});

test('Open brief opens the draft; the trace opens only when asked and holds the full record', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('hr-desktop');
  assert.equal(s.steps[0].draftsOpen, 1);
  const tr = s.steps[1];
  assert.equal(tr.traceOpen, true);
  assert.ok(tr.stepsVisible > 0, 'the steps are there for audit once opened');
  assert.match(tr.text, /Leaver catch up/);
  clean(tr, 'trace');
});

test('refresh restores the same single question; pressing again makes no new run or question', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('hr-refresh');
  const r = s.steps[0];
  assert.ok(r.ok);
  assert.equal(r.question, s.question);
  assert.equal(r.questions, 1);
  // there is no Do this button while waiting — the press finds nothing to click, and nothing changes
  assert.equal(s.steps[1].clicked, false);
  assert.equal(s.steps[1].questions, 1);
});

test('answering the decision: NEURO records it in the brief, is Ready, and asks nothing more', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('hr-answer');
  const a = s.steps[0];
  assert.ok(a.clicked && a.ok);
  assert.equal(a.status, 'ready');
  assert.equal(a.statusLine, 'Ready for you');
  assert.equal(a.questions, 0);
  concise(a, 'answered');
  assert.match(a.agentHtml, /31 December 2026 \(stated 23 Oct 2026\)/);
});

test('a genuine ambiguity: one question with choices and Other — explain, what happens next stated (desktop, phone, SAiM)', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of [...sizes('amb-desktop'), ...sizes('amb-saim-phone')]) {
    concise(s, 'ambiguity ' + s.size);
    assert.equal(s.statusLine, 'Waiting for your answer');
    assert.equal(s.questions, 1);
    assert.deepEqual(s.options, ['Weekly risk report', 'SOAP report', 'Other — explain']);
    assert.match(s.text, /NEURO will draft that report’s outline/);
    clean(s, 'ambiguity');
  }
  const o = sizes('amb-desktop')[0].steps[0];
  assert.ok(o.clicked && o.ok, 'Other opens an explain field');
});

test('a normal task with no question: a double press makes ONE run; Ready for you; nothing asked (desktop, NEURO phone, SAiM phone)', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [p] = sizes('plain-press');
  const r = p.steps[0];
  assert.ok(r.clicked && r.ok);
  for (const s of [r, sizes('plain-neuro-phone')[0], sizes('plain-saim-phone')[0]]) {
    concise(s, 'plain ' + s.size);
    assert.equal(s.statusLine, 'Ready for you');
    assert.equal(s.questions, 0);
    assert.match(s.done[0], /Checked the permitted evidence \(1 source\)/);
    assert.match(s.done[1], /Prepared a private plan: “Q4 rota cover plan”/);
    clean(s, 'plain');
  }
  // the plain press used exactly its 3 model calls (+ the hr2 answer turn's 2); nothing is sent after finish
  assert.equal(calls - results.callsBeforeBrowser, 5, 'answer turn (2) + one plain run (3): no duplicate run from the double press');
});

test('kiosk: no workspace at all', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('kiosk')) { assert.equal(s.present, false); assert.doesNotMatch(s.html, /Do this|decision brief|What I need from you/); }
});

test('nothing outward: vault byte-identical, no ledger write, no approved action, no task changed', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.deepEqual(vaultHash(), vaultBefore);
  assert.equal(outward.after.ledger, outward.before.ledger);
  assert.equal(outward.after.approved, outward.before.approved);
  assert.equal(outward.after.tasks, outward.before.tasks);
});
