'use strict';

/**
 * "Do this" on the REAL screens, in a REAL BROWSER (23 Oct 2026, second pass).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-agent-ui-'));
const VAULT = path.join(tmp, 'vault');
const SHOTS = process.env.TA_SHOTS || path.join(tmp, 'shots');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.AI_MODE = 'hybrid';
// The device lock open in THIS throwaway process only, so the real confirmation can be SHOWN.
process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
delete process.env.TASK_AGENT_MODEL;
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
let script = []; let nid = 1;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use') => ({ model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage: { input_tokens: 1400, output_tokens: 350 } });
const end = () => reply([{ type: 'text', text: 'ok' }], 'end_turn');
anthropic._internals.setClient({ messages: { create: async () => script.shift() || end() } });
global.fetch = async () => { throw new Error('network blocked'); };

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector('.tagent');
  const btn = (t) => [...document.querySelectorAll('.tagent button')].some((b) => b.textContent.trim() === t);
  return {
    vw, sw: document.documentElement.scrollWidth,
    present: !!root,
    status: root ? root.getAttribute('data-tagent') : null,
    text: root ? root.textContent : '',
    html: document.body.innerHTML,
    agentHtml: root ? root.outerHTML : '',
    goButton: btn('Do this'),
    questions: document.querySelectorAll('.tagent__qtext').length,
    options: [...document.querySelectorAll('.tagent__opts button')].map((b) => b.textContent),
    outputs: [...document.querySelectorAll('[data-tagent-output]')].map((e) => e.getAttribute('data-tagent-output')),
    handoffs: document.querySelectorAll('[data-tagent-handoff]').length,
    saveButtons: [...document.querySelectorAll('[data-tagent-next] button')].map((b) => b.textContent),
    // VISIBLE, not merely in the DOM: a confirmation inside a collapsed fold is not shown to anyone.
    // ⚠ Chromium gives content inside a CLOSED <details> layout rects, so rects prove nothing:
    // checkVisibility() and "not inside a closed fold" are what make this mean "on screen".
    confirmShown: [...document.querySelectorAll('.tagent__save button')].some((b) => b.textContent.trim() === 'Confirm'
      && !b.closest('details:not([open])') && (typeof b.checkVisibility !== 'function' || b.checkVisibility())),
    saveText: (document.querySelector('.tagent__save') || {}).textContent || '',
    claudePreview: !!document.querySelector('[data-tagent-claude="preview"]'),
    claudeBrief: (document.querySelector('.tagent__prompt') || {}).value || '',
    claudeEnvelope: (document.querySelector('[data-tagent-envelope]') || {}).textContent || '',
    claudeEnvelopeEditable: !!document.querySelector('[data-tagent-envelope]') && document.querySelector('[data-tagent-envelope]').tagName !== 'PRE',
    claudeFixed: [...document.querySelectorAll('.tagent__claude .tagent__fixed')].map((e) => e.textContent).join(' | '),
    claudeRecorded: document.querySelectorAll('[data-tagent-claude-handoff]').length,
    over: [...document.querySelectorAll('.tagent *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName)),
  };
})()`;

test.before(async () => {
  const db = require('../db/database');
  const taskStore = require('./task-store');
  const tc = require('./task-context');
  const agent = require('./task-agent');
  require('./prepared-move').readDuty = async () => ({ onDuty: true, why: 'working' });
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  require('./authority-budget')._test.grantToday({ now: Date.now() }); // Nick's allowance for today, in the test DB
  write('People/Jane Doe.md', '---\ntype: person\nemail: jane.doe@example.com\n---\n# Jane Doe\n');
  write(PLAN, '# Q4 rota notes\n\nCover gaps: weeks 44 and 47. Two people on leave in week 47.\n');
  write(HR, '---\nprivate: true\n---\n# Leaver catch up\n\nHeidi Example disclosed a private family matter which is confidential.\nAgreed to confirm Heidi Example end date once HR reply.\n');
  write(SEC, '# Passwords\n\nadmin password: hunter2\n');
  const mk = (text, extra = {}) => taskStore.createTask({ text, source: 'test', ...extra }).task;
  T.plain = mk('Plan the Q4 support rota cover');
  T.amb = mk('Sort out the report');
  T.hr = mk("Set and confirm Heidi Example's end date", { origin_path: HR });
  T.email = mk('Send Jane Doe the agenda for Thursday');
  T.code = mk('Fix the flaky Jira sync test in the NEURO repo');
  tc.ensure();
  assert.equal(tc.link({ taskId: T.plain.id, type: 'note', ref: PLAN }).ok, true);
  const now = new Date().toISOString();
  const ins = (taskId, ref, title) => db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, origin, state, confidence, reasons_json, restricted, created_at, updated_at) VALUES (?, 'note', ?, ?, 'nightly-scan', 'pinned', 1, '[{"code":"origin","say":"This task was raised in this note."}]', 1, ?, ?)`, [taskId, ref, title, now, now]);
  ins(T.hr.id, HR, 'Leaver catch up');
  ins(T.hr.id, SEC, 'Service account passwords');

  script = [reply([tu('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'They have different audiences and deadlines.', options: ['Weekly risk report', 'SOAP report'] })]), end()];
  await agent.start(T.amb.id, { awaitTurn: true });
  script = [reply([tu('save_output', { kind: 'brief', title: 'End date decision brief', markdown: '## Facts\n- HR reply awaited\n## Options\n1. Confirm now\n2. Wait for HR\n## Risks\n- Confirming before HR replies' })]), reply([tu('finish', { understanding: "Confirm Heidi Example's end date.", completed: ['Prepared a decision brief'], remaining: ['Your decision'] })]), end()];
  await agent.start(T.hr.id, { awaitTurn: true });
  script = [reply([tu('save_output', { kind: 'agenda', title: 'Thursday agenda', markdown: '1. Rota\n2. Escalations' })]), reply([tu('prepare_email', { to: 'Jane Doe', subject: 'Agenda for Thursday', body: 'Hi Jane,\n\n1. Rota\n2. Escalations\n\nNick' })]), reply([tu('finish', { understanding: 'Send Jane the Thursday agenda.', completed: ['Agenda drafted', 'Email prepared for your approval'], remaining: ['Approve the email on Actions'] })]), end()];
  await agent.start(T.email.id, { awaitTurn: true });
  script = [reply([tu('save_output', { kind: 'investigation', title: 'Flaky sync test — what we know', markdown: 'Fails when the run crosses midnight; reproduce by pinning the clock.' })]), reply([tu('recommend_claude_desktop', { why: 'It needs a code change and the test suite run in the repo.', done_when: 'The test passes 20 times in a row and the fix is on a branch.' })]), reply([tu('finish', { understanding: 'Fix the flaky Jira sync test.', completed: ['Wrote what is known'], remaining: ['Fix and verify in the repo'] })]), end()];
  await agent.start(T.code.id, { awaitTurn: true });
  // Queued for the press Nick makes in the browser.
  script = [reply([tu('read_note', { path: PLAN })]), reply([tu('save_output', { kind: 'plan', title: 'Q4 rota cover plan', markdown: '- Week 44: early/late split\n- Week 47: swap 2nd line (two on leave)', sources: ['ctx:1'] }), tu('save_output', { kind: 'checklist', title: 'Rota checklist', markdown: '- [ ] Confirm leave\n- [ ] Publish rota' })]), reply([tu('finish', { understanding: 'Plan Q4 rota cover from the rota notes.', completed: ['Drafted the cover plan', 'Drafted a checklist'], remaining: ['Publish the rota — your step'] })]), end()];

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
    'desktop-press': { task: T.plain, sizes: W, wait: '[data-tagent="idle"]', steps: [{ click: 'Do this', wait: '[data-tagent="ready"]', shot: 'after-press' }] },
    'desktop-save': { task: T.plain, sizes: W, wait: '[data-tagent="ready"]', steps: save },
    'neuro-phone-save': { task: T.plain, sizes: P, wait: '[data-tagent="ready"]', steps: save },
    'desktop-question': { task: T.amb, sizes: D, wait: '[data-tagent="needs-answer"]' },
    'desktop-decision': { task: T.hr, sizes: D, wait: '[data-tagent="needs-decision"]' },
    'desktop-email': { task: T.email, sizes: W, wait: '[data-tagent="ready"]' },
    'desktop-claude': { task: T.code, sizes: W, wait: '[data-tagent="ready"]', steps: claude },
    'saim-phone-claude': { task: T.code, hash: '#saim', sizes: P, wait: '[data-tagent="ready"]', steps: [claude[0]] },
    'saim-phone-decision': { task: T.hr, hash: '#saim', sizes: P, wait: '[data-tagent="needs-decision"]' },
    'saim-phone-question': { task: T.amb, hash: '#saim', sizes: P, wait: '[data-tagent="needs-answer"]' },
    'saim-electron-desktop': { task: T.amb, hash: '#saim', native: true, sizes: W, wait: '[data-tagent="needs-answer"]' },
    'kiosk': { task: T.hr, hash: '#saim', surface: 'kiosk', mode: 'kiosk', sizes: P, wait: '.tasks__panel' },
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
      const root = s.clickIn || '.tagent';
      const clicked = s.click === '*primary'
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

test('desktop: Nick presses Do this; NEURO completes several safe steps without asking', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('desktop-press');
  assert.ok(s.goButton, 'the idle card shows the Do this button');
  const after = s.steps[0];
  assert.ok(after.clicked && after.ok);
  assert.equal(after.status, 'ready');
  assert.deepEqual(after.outputs, ['plan', 'checklist']);
  assert.equal(after.questions, 0);
  assert.match(after.text, /Plan Q4 rota cover from the rota notes\./);
  assert.match(after.text, /Recorded by the AI gate in shadow mode/);
  clean(after, 'press');
});

test('desktop + NEURO phone: Save to vault opens the EXISTING confirmation; Confirm is shown and never pressed; vault untouched', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of [...sizes('desktop-save'), ...sizes('neuro-phone-save')]) {
    assert.ok(s.saveButtons.includes('Save to vault…'), `${s.size}: offered`);
    const [opened, confirmation] = s.steps;
    assert.ok(opened.clicked && opened.ok, `${s.size}: the prepared move opened inside the card`);
    assert.ok(confirmation.clicked && confirmation.ok, `${s.size}: the request was made`);
    assert.ok(confirmation.confirmShown, `${s.size}: the real Confirm button is on screen`);
    assert.match(confirmation.saveText, /Projects\/Working\/Plan the Q4 support rota cover \(draft\)\.md/, `${s.size}: the exact note it would write`);
    clean(confirmation, 'save');
  }
  assert.deepEqual(vaultHash(), vaultBefore, 'no vault write — Confirm was never pressed');
  assert.equal(outward.after.ledger, outward.before.ledger, 'no external write ledger row');
  assert.equal(outward.after.spent, outward.before.spent, 'no confirmation spent');
  assert.equal(outward.after.approved, outward.before.approved, 'no governed action approved');
  assert.equal(outward.after.tasks, outward.before.tasks, 'no task changed');
});

test('Claude handoff: the preview shows why, what goes and what never goes, the statement, the editable prompt; the press records it', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('desktop-claude');
  const [preview, recorded] = s.steps;
  assert.ok(preview.claudePreview);
  assert.match(preview.text, /Why Claude:.*code change/);
  assert.match(preview.text, /Nothing is sent to Claude until you press the button/);
  assert.match(preview.text, /Never included:.*restricted notes/);
  assert.match(preview.claudeEnvelope, /NEURO handoff policy \(fixed by NEURO — not editable/);
  assert.equal(preview.claudeEnvelopeEditable, false, 'the policy is shown read-only, never in an editable box');
  assert.match(preview.claudeFixed, /NEURO task #\d+: Fix the flaky Jira sync test/);
  assert.match(preview.claudeFixed, /not included/);
  assert.match(preview.claudeBrief, /## Objective/, 'only the working brief is editable');
  assert.ok(!preview.claudeBrief.includes('NEURO handoff policy'));
  assert.ok(!`${preview.claudeFixed}${preview.claudeBrief}`.includes('crosses midnight'), 'draft text only if Nick ticks it');
  assert.ok(recorded.ok && recorded.claudeRecorded === 1, 'the handoff is recorded on the task attempt');
  clean(preview, 'claude');
  const [p] = sizes('saim-phone-claude');
  assert.ok(p.steps[0].claudePreview, 'the SAiM phone shows the same preview');
  clean(p.steps[0], 'claude-phone');
});

test('a genuine ambiguity: one question, its options (desktop, NEURO phone, SAiM phone, SAiM Electron desktop)', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of [...sizes('desktop-question'), ...sizes('saim-phone-question'), ...sizes('saim-electron-desktop')]) {
    assert.equal(s.questions, 1);
    assert.deepEqual(s.options, ['Weekly risk report', 'SOAP report']);
    clean(s, 'question');
  }
});

test('the SAiM desktop Electron window (window.saimNative) shows Do this — it is Nick’s own SAiM', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('saim-electron-desktop');
  assert.equal(s.present, true);
  assert.equal(s.status, 'needs-answer');
});

test('a people matter: the brief is there, save is not offered, and it stops at Nick’s decision', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of [...sizes('desktop-decision'), ...sizes('saim-phone-decision')]) {
    assert.equal(s.status, 'needs-decision');
    assert.deepEqual(s.outputs, ['brief']);
    assert.ok(!s.saveButtons.includes('Save to vault…'));
    assert.match(s.text, /never saves those as notes/);
    assert.equal(s.handoffs, 0);
    clean(s, 'decision');
  }
});

test('a prepared email: ready for confirmation on Actions; not sent', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const [s] = sizes('desktop-email');
  assert.equal(s.handoffs, 1);
  assert.match(s.text, /prepared, not sent/);
  assert.match(s.text, /Review on Actions/);
  clean(s, 'email');
});

test('kiosk: no Do this control and no working output at all', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('kiosk')) {
    assert.equal(s.present, false);
    assert.doesNotMatch(s.html, /Do this|decision brief|Ready for your confirmation/);
  }
});
