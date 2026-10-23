'use strict';

/**
 * "Do this" on the REAL screens, in a REAL BROWSER (23 Oct 2026).
 *
 * The REAL expanded TodoItem (NEURO desktop and the NEURO phone PWA — one
 * component, at 1440×900 and 390×844) and the SAiM phone's mount of the shared
 * TaskAgent (390×844, and with ?surface=kiosk), over the REAL /api/task-agent
 * route behind the REAL api-auth and authority guard, the REAL task-agent
 * service and the REAL Anthropic provider with only the SDK client scripted.
 *
 * Asserted:
 *   - Nick presses Do this on the card and the run completes several safe steps
 *     without asking (plan + checklist, sources shown with provenance);
 *   - a genuine ambiguity shows ONE question with options and an answer box;
 *   - a people matter shows the brief and stops at Nick's decision;
 *   - a prepared email shows "Ready for your confirmation" and Review on Actions;
 *   - the kiosk renders no Do this control and no output at all;
 *   - no restricted body or Security review/ content is ever on a screen;
 *   - nothing past the right edge at either width.
 *
 * Skips, and says so, where there is no Electron binary.
 *   ELECTRON_PATH=<electron(.exe)>   overrides discovery
 *   TA_SHOTS=<dir>                   keeps the PNGs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-ui-'));
const VAULT = path.join(tmp, 'vault');
const SHOTS = process.env.TA_SHOTS || path.join(tmp, 'shots');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.AI_MODE = 'hybrid';
process.env.TASK_AGENT_MODEL = 'claude-sonnet-5';
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
function write(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const PLAN = 'Projects/Support Rota/Q4 rota notes.md';
const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example leaver catch up.md';
const SEC = 'Security review/Service account passwords.md';
const LEAK = ['private family matter', 'hunter2', 'Security review', 'Service account passwords'];

const T = {};
let mode = 'owner';
let server; let base; let skipWhy = null; const results = {};

// ── scripted Anthropic SDK client (the provider, gate and tool loop are real) ─
const anthropic = require('./providers/anthropic-provider');
let script = []; let nid = 1;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use') => ({ model: 'claude-sonnet-5', content: blocks, stop_reason: stop, usage: { input_tokens: 1400, output_tokens: 350 } });
anthropic._internals.setClient({ messages: { create: async () => script.shift() || reply([{ type: 'text', text: 'ok' }], 'end_turn') } });
global.fetch = async () => { throw new Error('network blocked'); };

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector('.tagent');
  return {
    vw, sw: document.documentElement.scrollWidth,
    present: !!root,
    status: root ? root.getAttribute('data-tagent') : null,
    text: root ? root.textContent : '',
    html: document.body.innerHTML,
    agentHtml: root ? root.outerHTML : '',
    goButton: !!document.querySelector('.tagent__go'),
    questions: document.querySelectorAll('.tagent__qtext').length,
    options: [...document.querySelectorAll('.tagent__opts button')].map((b) => b.textContent),
    outputs: [...document.querySelectorAll('[data-tagent-output]')].map((e) => e.getAttribute('data-tagent-output')),
    handoffs: document.querySelectorAll('[data-tagent-handoff]').length,
    over: [...document.querySelectorAll('.tagent *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName)),
  };
})()`;

test.before(async () => {
  const db = require('../db/database');
  const taskStore = require('./task-store');
  const tc = require('./task-context');
  const agent = require('./task-agent');
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  write('People/Jane Doe.md', '---\ntype: person\nemail: jane.doe@example.com\n---\n# Jane Doe\n');
  write(PLAN, '# Q4 rota notes\n\nCover gaps: weeks 44 and 47. Two people on leave in week 47.\n');
  write(HR, '---\nprivate: true\n---\n# Leaver catch up\n\nHeidi Example disclosed a private family matter which is confidential.\nAgreed to confirm Heidi Example end date once HR reply.\n');
  write(SEC, '# Passwords\n\nadmin password: hunter2\n');
  T.plain = taskStore.createTask({ text: 'Plan the Q4 support rota cover', source: 'test' });
  T.amb = taskStore.createTask({ text: 'Sort out the report', source: 'test' });
  T.hr = taskStore.createTask({ text: "Set and confirm Heidi Example's end date", source: 'test', origin_path: HR });
  T.email = taskStore.createTask({ text: 'Send Jane Doe the agenda for Thursday', source: 'test' });
  tc.ensure();
  assert.equal(tc.link({ taskId: T.plain.id, type: 'note', ref: PLAN }).ok, true);
  const now = new Date().toISOString();
  const ins = (taskId, ref, title) => db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, origin, state, confidence, reasons_json, restricted, created_at, updated_at) VALUES (?, 'note', ?, ?, 'nightly-scan', 'pinned', 1, '[{"code":"origin","say":"This task was raised in this note."}]', 1, ?, ?)`, [taskId, ref, title, now, now]);
  ins(T.hr.id, HR, 'Leaver catch up');
  ins(T.hr.id, SEC, 'Service account passwords');

  // Pre-run the three states the screens show (the press itself is driven in the browser for T.plain).
  script = [reply([tu('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'They have different audiences and deadlines.', options: ['Weekly risk report', 'SOAP report'] })]), reply([{ type: 'text', text: 'w' }], 'end_turn')];
  await agent.start(T.amb.id, { awaitTurn: true });
  script = [reply([tu('save_output', { kind: 'brief', title: 'End date decision brief', markdown: '## Facts\n- HR reply awaited\n## Options\n1. Confirm now\n2. Wait for HR\n## Risks\n- Confirming before HR replies' })]), reply([tu('finish', { understanding: "Confirm Heidi Example's end date.", completed: ['Prepared a decision brief'], remaining: ['Your decision'] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];
  await agent.start(T.hr.id, { awaitTurn: true });
  script = [reply([tu('save_output', { kind: 'agenda', title: 'Thursday agenda', markdown: '1. Rota\n2. Escalations' })]), reply([tu('prepare_email', { to: 'Jane Doe', subject: 'Agenda for Thursday', body: 'Hi Jane,\n\n1. Rota\n2. Escalations\n\nNick' })]), reply([tu('finish', { understanding: 'Send Jane the Thursday agenda.', completed: ['Agenda drafted', 'Email prepared for your approval'], remaining: ['Approve the email on Actions'] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];
  await agent.start(T.email.id, { awaitTurn: true });
  // Queued for the press Nick makes in the browser.
  script = [reply([tu('read_note', { path: PLAN })]), reply([tu('save_output', { kind: 'plan', title: 'Q4 rota cover plan', markdown: '- Week 44: early/late split\n- Week 47: swap 2nd line (two on leave)', sources: ['ctx:1'] }), tu('save_output', { kind: 'checklist', title: 'Rota checklist', markdown: '- [ ] Confirm leave\n- [ ] Publish rota' })]), reply([tu('finish', { understanding: 'Plan Q4 rota cover from the rota notes.', completed: ['Drafted the cover plan', 'Drafted a checklist'], remaining: ['Publish the rota — your step'] })]), reply([{ type: 'text', text: 'ok' }], 'end_turn')];

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
import { platformNow } from ${JSON.stringify(slash(path.join(ROOT, 'saim/shared-ui/presentation/platform.mjs')))};
const q = new URLSearchParams(location.search);
const TASK = Number(q.get('task'));
const TODO = { id: 1, task_id: TASK, text: q.get('text') || 'task', priority: 'normal', moscow: 'should', source: 'NEURO', done: 0 };
const call = async (p, { method = 'GET', body } = {}) => { const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-NEURO-PIN': 'pin-1234' }, body: body === undefined ? undefined : JSON.stringify(body) }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
function Shell() {
  // #saim = the SAiM phone app's mount, exactly as Tasks.jsx writes it.
  const body = location.hash === '#saim'
    ? React.createElement('div', { className: 'tasks__panel', style: { padding: 12, color: '#e8eef5', background: '#0b1016', minHeight: '100vh' } },
        React.createElement('div', null, TODO.text),
        React.createElement(TaskAgent, { taskId: TASK, call, readOnly: platformNow() !== 'phone-app' }))
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
  app.use('/api', (req, _res, next) => { if (mode === 'kiosk') { delete req.headers['x-neuro-pin']; req.headers['x-neuro-kiosk-token'] = 'kiosk-9012'; } next(); });
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-agent', require('../routes/task-agent'));
  app.use('/api/task-context', require('../routes/task-context'));
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
  const D = [[1440, 900], [390, 844]]; const P = [[390, 844]];
  const enc = encodeURIComponent;
  const JOBS = {
    // The press: idle card, click Do this, wait until the run settles.
    'desktop-press': { task: T.plain.id, text: T.plain.task.text, hash: '', sizes: [[1440, 900]], wait: '.tagent__go', click: '.tagent__go', waitAfter: '[data-tagent="ready"]' },
    'desktop-ready': { task: T.plain.id, text: T.plain.task.text, hash: '', sizes: D, wait: '[data-tagent="ready"]' },
    'desktop-question': { task: T.amb.id, text: T.amb.task.text, hash: '', sizes: D, wait: '[data-tagent="needs-answer"]' },
    'desktop-decision': { task: T.hr.id, text: T.hr.task.text, hash: '', sizes: D, wait: '[data-tagent="needs-decision"]' },
    'desktop-email': { task: T.email.id, text: T.email.task.text, hash: '', sizes: D, wait: '[data-tagent="ready"]' },
    'saim-phone-decision': { task: T.hr.id, text: T.hr.task.text, hash: '#saim', sizes: P, wait: '[data-tagent="needs-decision"]' },
    'saim-phone-question': { task: T.amb.id, text: T.amb.task.text, hash: '#saim', sizes: P, wait: '[data-tagent="needs-answer"]' },
    'kiosk': { task: T.hr.id, text: T.hr.task.text, hash: '#saim', surface: 'kiosk', mode: 'kiosk', sizes: P, wait: '.tasks__panel' },
  };
  for (const [name, j] of Object.entries(JOBS)) {
    mode = j.mode || 'owner';
    const qs = `?task=${j.task}&text=${enc(j.text)}${j.surface ? `&surface=${j.surface}` : ''}${j.hash}`;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ name, path: qs, wait: j.wait, click: j.click || null, waitAfter: j.waitAfter || null, sizes: j.sizes, shots: SHOTS, measure: MEASURE }));
    try { fs.rmSync(env.NW_OUT); } catch { /* none yet */ }
    await new Promise((resolve) => {
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 120000);
      c.on('exit', () => { clearTimeout(t); try { results[name] = JSON.parse(fs.readFileSync(env.NW_OUT, 'utf8')); } catch { results[name] = { error: `no result: ${err.slice(0, 400)}` }; } resolve(); });
    });
  }
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
    const until = async (sel) => { const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(' + JSON.stringify(sel) + ')'))) await sleep(150); return js('!!document.querySelector(' + JSON.stringify(sel) + ')'); };
    const found = await until(job.wait);
    let before = null;
    if (job.click) {
      before = await js(job.measure);
      fs.writeFileSync(path.join(job.shots, job.name + '-before-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
      await js('document.querySelector(' + JSON.stringify(job.click) + ').click()');
      await until(job.waitAfter);
    }
    await sleep(600);
    const m = await js(job.measure);
    m.found = found; m.before = before;
    const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 4000)); await sleep(400);
    fs.writeFileSync(path.join(job.shots, job.name + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
    out.sizes.push({ size: w + 'x' + h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

const sizes = (name) => { const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); return r.sizes; };
const clean = (s, label) => {
  // The secret and the private line must be nowhere on the page; the Security review/
  // note must not appear in the Do this workspace (task-context's own panel shows a
  // legacy row's TITLE only, by its existing rule).
  for (const bad of ['private family matter', 'hunter2']) assert.ok(!s.html.includes(bad), `${label} ${s.size}: "${bad}" must never reach the screen`);
  for (const bad of LEAK) assert.ok(!s.agentHtml.includes(bad), `${label} ${s.size}: "${bad}" must never reach the Do this workspace`);
  assert.equal(s.sw, s.vw, `${label} ${s.size}: no horizontal scroll`);
  assert.deepEqual(s.over, [], `${label} ${s.size}: nothing past the right edge`);
};

test('desktop: Nick presses Do this on the card; NEURO completes several safe steps without asking', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('desktop-press');
  assert.ok(s.before && s.before.goButton, 'the idle card shows one Do this button');
  assert.match(s.before.text, /asks you only when it must/);
  assert.equal(s.status, 'ready');
  assert.deepEqual(s.outputs, ['plan', 'checklist']);
  assert.equal(s.questions, 0, 'no question asked');
  assert.match(s.text, /Plan Q4 rota cover from the rota notes\./);
  assert.match(s.text, /Q4 rota notes/);
  assert.match(s.text, /Publish the rota — your step/);
  clean(s, 'press');
});

test('desktop + NEURO phone: the finished run reloads as the same attempt', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('desktop-ready')) { assert.equal(s.status, 'ready'); assert.deepEqual(s.outputs, ['plan', 'checklist']); clean(s, 'ready'); }
});

test('a genuine ambiguity: one question, its options, an answer box (desktop, NEURO phone, SAiM phone)', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of [...sizes('desktop-question'), ...sizes('saim-phone-question')]) {
    assert.equal(s.questions, 1);
    assert.deepEqual(s.options, ['Weekly risk report', 'SOAP report']);
    assert.match(s.text, /Why it matters/);
    assert.doesNotMatch(s.text, /Understood as/, 'no understanding was stated, so none is shown');
    clean(s, 'question');
  }
});

test('a people matter: the brief is there, and it stops at Nick’s decision; nothing private on screen', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of [...sizes('desktop-decision'), ...sizes('saim-phone-decision')]) {
    assert.equal(s.status, 'needs-decision');
    assert.deepEqual(s.outputs, ['brief']);
    assert.match(s.text, /stops at your decision/);
    assert.equal(s.handoffs, 0);
    clean(s, 'decision');
  }
});

test('a prepared email: shown as ready for confirmation, with the way to Actions; not sent', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('desktop-email')) {
    assert.equal(s.handoffs, 1);
    assert.match(s.text, /Ready for your confirmation/);
    assert.match(s.text, /prepared, not sent/);
    assert.match(s.text, /Review on Actions/);
    assert.match(s.text, /Status: prepared/);
    clean(s, 'email');
  }
});

test('kiosk: no Do this control and no working output at all', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('kiosk')) {
    assert.equal(s.present, false, 'nothing rendered');
    assert.doesNotMatch(s.html, /Do this|decision brief|Ready for your confirmation/);
    clean(s, 'kiosk');
  }
});
