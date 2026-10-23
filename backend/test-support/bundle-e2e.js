#!/usr/bin/env node
'use strict';

/**
 * "Do this" workspace — END TO END over the BUILT bundles (23 Oct 2026).
 *
 *   node backend/test-support/bundle-e2e.js <shotsDir>
 *
 * Boots the REAL backend/server.js in this process against a throwaway DB, vault
 * and AI-gate ledger, serving the REAL frontend/dist (the NEURO desktop and NEURO
 * phone app exactly as deployed), plus a SAiM app bundle built by the real
 * `vite build` with VITE_API_URL pointed here (saim/app/dist-e2e — build it first:
 * `cd saim/app && VITE_API_URL=http://127.0.0.1:3911 npx vite build --outDir dist-e2e`).
 * Electron then opens the apps like a person: the PIN, the task list, the task.
 *
 * Isolation: every outbound fetch except 127.0.0.1 is refused; the Anthropic SDK
 * client is scripted; the scheduler is not started (this is a UI-path test).
 * No .env is read (the clean checkout has none) and nothing touches production.
 * Prints a JSON report; exits 0 only when every assertion passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'bundle-e2e-shots'));
const PORT = 3911; const SPORT = 3912;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-e2e-'));
const VAULT = path.join(tmp, 'vault');
Object.assign(process.env, {
  NEURO_DB_PATH: path.join(tmp, 'agent.db'), OBSIDIAN_VAULT_PATH: VAULT, PORT: String(PORT),
  NEURO_PIN: 'pin-e2e-1234', NEURO_API_TOKEN: 'tok-e2e', NEURO_KIOSK_TOKEN: 'kiosk-e2e',
  AI_GATE_DB_PATH: path.join(tmp, 'gate', 'ledger.db'), AI_MODE: 'hybrid',
});
fs.mkdirSync(path.join(tmp, 'gate'), { recursive: true, mode: 0o700 });
for (const k of ['ANTHROPIC_API_KEY', 'AI_GATE_MODE', 'HA_TOKEN', 'HA_URL', 'OPENROUTER_API_KEY', 'VOYAGE_API_KEY']) delete process.env[k];
fs.mkdirSync(VAULT, { recursive: true });

// ── isolation ───────────────────────────────────────────────────────────────
const realFetch = global.fetch;
global.fetch = async (u, o) => {
  const s = String(u && u.url ? u.url : u);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s)) return realFetch(u, o);
  throw new Error(`network blocked in bundle-e2e: ${s.slice(0, 60)}`);
};
const anthropic = require('../services/providers/anthropic-provider');
let script = []; let calls = 0; let nid = 1;
const tu = (name, input) => ({ type: 'tool_use', id: `tu_${nid++}`, name, input });
const reply = (blocks, stop = 'tool_use') => ({ model: 'claude-sonnet-4-6', content: blocks, stop_reason: stop, usage: { input_tokens: 1400, output_tokens: 350 } });
const end = () => reply([{ type: 'text', text: 'ok' }], 'end_turn');
anthropic._internals.setClient({ messages: { create: async () => { calls += 1; return script.shift() || end(); } } });
require('../services/scheduler').start = () => {}; // UI-path test: no background jobs

function write(rel, text) { const p = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
const PLAN = 'Projects/Support Rota/Q4 rota notes.md';
const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example leaver catch up.md';

async function seed() {
  const db = require('../db/database');
  await db.init();
  const taskStore = require('../services/task-store');
  const tc = require('../services/task-context');
  const agent = require('../services/task-agent');
  require('../services/task-agent-settings').save({ apiKey: 'sk-ant-e2e-not-a-real-key-000000000000', enabled: true, dailyUsd: 50, dailyRuns: 200 });
  write(PLAN, '# Q4 rota notes\n\nCover gaps: weeks 44 and 47. Two people on leave in week 47.\n');
  write(HR, '---\nprivate: true\n---\n# Leaver catch up\n\nHeidi Example disclosed a private family matter which is confidential.\nAgreed to confirm Heidi Example end date once HR reply.\n');
  const mk = (text, extra = {}) => taskStore.createTask({ text, source: 'test', moscow: 'must', ...extra }).task;
  const T = {
    hr: mk("Set and confirm Heidi Example's end date before September 30", { origin_path: HR }),
    hr2: mk("Confirm Heidi Example's last working day with HR", { origin_path: HR }),
    amb: mk('Sort out the report'),
    plain: mk('Plan the Q4 support rota cover'),
  };
  tc.ensure();
  tc.link({ taskId: T.plain.id, type: 'note', ref: PLAN });
  const now = new Date().toISOString();
  for (const t of [T.hr, T.hr2]) db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, origin, state, confidence, reasons_json, restricted, created_at, updated_at) VALUES (?, 'note', ?, 'Leaver catch up', 'nightly-scan', 'pinned', 1, '[{"code":"origin","say":"This task was raised in this note."}]', 1, ?, ?)`, [t.id, HR, now, now]);
  const brief = '## Facts (from the linked note)\n- HR reply awaited\n## Options\n- 30 September 2026\n- 31 December 2026 (short retention)\n## Decision\nOpen — yours to decide.';
  const ask = tu('ask_nick', { kind: 'authority', question: 'What end date should the brief record for Heidi Example?', why: 'The end date sets the notice letter and the handover plan.', after: 'NEURO will record it in the private brief and stop. It will not contact anyone or change anything.', options: ['30 September 2026', '31 December 2026'] });
  for (const t of [T.hr, T.hr2]) {
    script = [reply([tu('save_output', { kind: 'brief', title: 'Heidi Example – End Date Decision Brief', markdown: brief })]),
      reply([tu('ask_nick', { kind: 'authority', question: 'This is an employment matter. What do you decide, and should NEURO prepare anything further?', why: 'x', after: 'y' })]),
      reply([{ ...ask, id: `tu_${nid++}` }]), end()];
    await agent.start(t.id, { awaitTurn: true });
  }
  script = [reply([tu('ask_nick', { kind: 'ambiguity', question: 'Which report — the weekly risk report or the SOAP report?', why: 'They have different audiences and deadlines.', after: 'NEURO will draft that report’s outline from last week’s figures.', options: ['Weekly risk report', 'SOAP report'] })]), end()];
  await agent.start(T.amb.id, { awaitTurn: true });
  // In the browser: T.hr2's answer turn, then the plain double press.
  script = [
    reply([tu('save_output', { kind: 'brief', title: 'Heidi Example – End Date Decision Brief', markdown: brief.replace('Open — yours to decide.', 'Nick: 31 December 2026.') })]),
    reply([tu('finish', { completed: ['Recorded your decision in the private brief'], remaining: ['Issue the letter yourself'] })]), end(),
    reply([tu('read_note', { path: PLAN })]), reply([tu('save_output', { kind: 'plan', title: 'Q4 rota cover plan', markdown: '- Week 44: early/late split\n- Week 47: swap 2nd line', sources: ['ctx:1'] })]),
    reply([tu('finish', { completed: ['Drafted the cover plan'], remaining: ['Publish the rota'] })]), end(),
  ];
  return T;
}

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector('.tagent');
  const vis = (e) => e && !e.closest('details:not([open])') && (typeof e.checkVisibility !== 'function' || e.checkVisibility());
  const trace = document.querySelector('[data-tagent-trace]');
  return {
    vw, sw: document.documentElement.scrollWidth, present: !!root,
    status: root ? root.getAttribute('data-tagent') : null,
    statusLine: (document.querySelector('.tagent__statusline') || {}).textContent || '',
    wont: (document.querySelector('.tagent__wont') || {}).textContent || '',
    done: [...document.querySelectorAll('[data-tagent-done] li')].map((e) => e.textContent.trim()),
    doneControls: [...document.querySelectorAll('[data-tagent-done] button')].map((b) => b.textContent.trim()),
    questions: [...document.querySelectorAll('.tagent__qtext')].filter(vis).length,
    question: (document.querySelector('.tagent__qtext') || {}).textContent || '',
    after: (document.querySelector('.tagent__qafter') || {}).textContent || '',
    options: [...document.querySelectorAll('.tagent__opts button')].map((b) => b.textContent),
    traceOpen: trace ? trace.open : null,
    traceSummary: trace ? trace.querySelector('summary').textContent : '',
    stepsVisible: [...document.querySelectorAll('.tagent__steps li')].filter(vis).length,
    firstSection: (document.querySelector('.tagent > *') || {}).className || '',
    draftsOpen: [...document.querySelectorAll('.tagent__out')].filter((d) => d.open).length,
    text: root ? root.textContent : '',
    leak: /private family matter/.test(document.body.innerHTML),
    over: [...document.querySelectorAll('.tagent *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).length,
  };
})()`;

const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const path = require('path');
const job = JSON.parse(fs.readFileSync(process.env.E2E_JOB, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const out = { sizes: [] };
const fail = (e) => { fs.writeFileSync(process.env.E2E_OUT, JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); };
process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  for (const [w, h] of job.sizes) {
    const win = new BrowserWindow({ width: w, height: h, useContentSize: true, show: false, webPreferences: { offscreen: true, partition: 'e2e-' + job.name + w } });
    win.setContentSize(w, h);
    const js = (c) => win.webContents.executeJavaScript(c);
    const until = async (cond, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !(await js(cond).catch(() => false))) await sleep(200); return js(cond).catch(() => false); };
    // Both apps scroll an inner panel, not the page: bring the workspace's top into view
    // (with a little of the task above it), on a taller canvas so the three parts and the
    // folded trace fit in one picture.
    const shot = async (label) => {
      win.setContentSize(w, w > 800 ? 1300 : 1700); await sleep(400);
      await js('(() => { const t = document.querySelector(".tagent__statusblock") || document.querySelector(".tagent"); if (t) t.scrollIntoView({ block: "start" }); const sc = (e) => { while (e && e !== document.body) { if (e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) return e; e = e.parentElement; } return document.scrollingElement; }; const c = t && sc(t.parentElement); if (c) c.scrollTop = Math.max(0, c.scrollTop - 140); return true; })()'); await sleep(500);
      fs.writeFileSync(path.join(job.shots, job.name + (label ? '-' + label : '') + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
      win.setContentSize(w, h); await sleep(300);
    };
    await win.loadURL(job.origin + '/');
    await js('localStorage.setItem("neuro_pin", ' + JSON.stringify(job.pin) + '); true');
    await win.loadURL(job.url);
    // open the task: NEURO = its row text; SAiM = the row's "More for:" button
    const opened = await until(job.open);
    await until('!!document.querySelector(' + JSON.stringify(job.wait) + ')');
    await sleep(700);
    const m0 = await js(job.measure);
    await shot('');
    const steps = [];
    for (const s of job.steps || []) {
      let clicked = true;
      if (s.reload) { win.webContents.reload(); await sleep(500); await until(job.open); }
      else if (s.summary) clicked = await js('(() => { const b = [...document.querySelectorAll(".tagent summary")].find((x) => x.textContent.trim().startsWith(' + JSON.stringify(s.summary) + ')); if (!b) return false; b.click(); return true; })()');
      else clicked = await js('(() => { const b = [...document.querySelectorAll(".tagent button")].find((x) => x.textContent.trim() === ' + JSON.stringify(s.click) + '); if (!b) return false; b.click(); ' + (s.double ? 'b.click(); ' : '') + 'return true; })()');
      const ok = await until('!!document.querySelector(' + JSON.stringify(s.wait) + ')');
      await sleep(700);
      const m = await js(job.measure);
      if (s.shot) await shot(s.shot);
      steps.push({ ...s, clicked, ok, ...m });
    }
    out.sizes.push({ size: w + 'x' + h, opened, ...m0, steps });
    win.destroy();
  }
  fs.writeFileSync(process.env.E2E_OUT, JSON.stringify(out));
  app.quit();
});`;

function electron() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  try { return require(require.resolve('electron', { paths: [path.join(ROOT, 'saim', 'desktop-electron')] })); } catch { return null; }
}

(async () => {
  const T = await seed();
  const callsAfterSeed = calls;
  require('../server.js'); // the real app: routes, auth, guard, SPA fallback over frontend/dist
  const express = require('express');
  const sapp = express();
  const sdist = path.join(ROOT, 'saim', 'app', 'dist-e2e');
  assert.ok(fs.existsSync(path.join(sdist, 'index.html')), 'build saim/app/dist-e2e first (see header)');
  sapp.use(express.static(sdist));
  sapp.get('*', (_q, r) => r.sendFile(path.join(sdist, 'index.html')));
  const ssrv = http.createServer(sapp); await new Promise((r) => ssrv.listen(SPORT, '127.0.0.1', r));
  for (let i = 0; i < 50; i += 1) { try { const r = await realFetch(`http://127.0.0.1:${PORT}/api/auth/check`); if (r) break; } catch { /* booting */ } await new Promise((r) => setTimeout(r, 200)); }

  fs.mkdirSync(SHOTS, { recursive: true });
  const bin = electron(); assert.ok(bin, 'no Electron binary (set ELECTRON_PATH)');
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"bundle-e2e-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const NEURO = `http://127.0.0.1:${PORT}`; const SAIM = `http://127.0.0.1:${SPORT}`;
  const neuroOpen = (t) => `(() => { const e = [...document.querySelectorAll('.todo-text-col')].find((x) => x.textContent.includes(${JSON.stringify(t.text.slice(0, 30))})); if (!e) return false; if (!document.querySelector('.tagent')) e.click(); return true; })()`;
  const saimOpen = (t) => `(() => { const all = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'All' && x.getAttribute('aria-pressed') !== 'true' && !x.dataset.e2eAll); if (all) { all.dataset.e2eAll = '1'; all.click(); return false; } const b = [...document.querySelectorAll('button.tasks__more')].find((x) => (x.getAttribute('aria-label') || '').includes(${JSON.stringify(t.text.slice(0, 30))})); if (!b) return false; if (!document.querySelector('.tagent')) b.click(); return true; })()`;
  const nj = (t, sizes, wait, steps) => ({ origin: NEURO, url: `${NEURO}/?view=todos`, open: neuroOpen(t), sizes, wait, steps });
  const sj = (t, wait, steps) => ({ origin: SAIM, url: `${SAIM}/?tab=tasks`, open: saimOpen(t), sizes: [[390, 844]], wait, steps });
  const JOBS = {
    'hr-desktop': nj(T.hr, [[1440, 900]], '[data-tagent="needs-decision"]', [{ click: 'Open brief', wait: '.tagent__out[open]', shot: 'brief-opened' }, { summary: 'Activity and evidence', wait: '[data-tagent-trace][open]', shot: 'trace-opened' }]),
    'hr-neuro-phone': nj(T.hr, [[390, 844]], '[data-tagent="needs-decision"]'),
    'hr-saim-phone': sj(T.hr, '[data-tagent="needs-decision"]'),
    'hr-refresh': nj(T.hr, [[1440, 900]], '[data-tagent="needs-decision"]', [{ reload: true, wait: '[data-tagent="needs-decision"]', shot: 'after-refresh' }]),
    'hr2-answer': nj(T.hr2, [[1440, 900]], '[data-tagent="needs-decision"]', [{ click: '31 December 2026', wait: '[data-tagent="ready"]', shot: 'answered' }]),
    'amb-saim-phone': sj(T.amb, '[data-tagent="needs-answer"]'),
    'amb-desktop': nj(T.amb, [[1440, 900]], '[data-tagent="needs-answer"]'),
    'plain-press': nj(T.plain, [[1440, 900]], '[data-tagent="idle"]', [{ click: 'Do this', double: true, wait: '[data-tagent="ready"]', shot: 'ready' }]),
    'plain-neuro-phone': nj(T.plain, [[390, 844]], '[data-tagent="ready"]'),
    'plain-saim-phone': sj(T.plain, '[data-tagent="ready"]'),
  };
  const R = {};
  for (const [name, j] of Object.entries(JOBS)) {
    const jf = path.join(tmp, 'job.json'); const of = path.join(tmp, 'out.json');
    fs.writeFileSync(jf, JSON.stringify({ name, pin: process.env.NEURO_PIN, shots: SHOTS, measure: MEASURE, ...j }));
    try { fs.rmSync(of); } catch { /* none */ }
    await new Promise((resolve) => {
      const env = { ...process.env, E2E_JOB: jf, E2E_OUT: of }; delete env.ELECTRON_RUN_AS_NODE;
      const c = require('child_process').spawn(bin, [drv], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += d; });
      const t = setTimeout(() => c.kill(), 180000);
      c.on('exit', () => { clearTimeout(t); try { R[name] = JSON.parse(fs.readFileSync(of, 'utf8')); } catch { R[name] = { error: err.slice(0, 500) }; } resolve(); });
    });
  }

  const fails = []; const check = (label, fn) => { try { fn(); } catch (e) { fails.push(`${label}: ${e.message}`); } };
  const S = (n, i = 0) => { const r = R[n]; if (!r || r.error) throw new Error(`${n}: ${r && r.error}`); return r.sizes[i]; };
  const concise = (s, label) => {
    assert.equal(s.present, true, `${label}: workspace present`);
    assert.equal(s.firstSection, 'tagent__statusblock', `${label}: status first`);
    assert.equal(s.traceOpen, false, `${label}: trace closed`);
    assert.match(s.traceSummary, /^Activity and evidence · \d+ permitted sources? used · \d+ internal steps?$/);
    assert.equal(s.stepsVisible, 0, `${label}: no transcript by default`);
    assert.equal(s.draftsOpen, 0, `${label}: drafts folded`);
    assert.ok(s.done.length <= 3); assert.ok(s.questions <= 1);
    assert.equal(s.leak, false, `${label}: restricted body never on screen`);
    assert.equal(s.sw, s.vw, `${label}: no horizontal scroll`); assert.equal(s.over, 0, `${label}: nothing past the edge`);
  };
  for (const n of ['hr-desktop', 'hr-neuro-phone', 'hr-saim-phone']) check(n, () => {
    const s = S(n); concise(s, n);
    assert.equal(s.statusLine, 'Waiting for your decision');
    assert.match(s.wont, /will not decide, contact anyone, promise anything or change anything/);
    assert.equal(s.questions, 1);
    assert.equal(s.question, 'What end date should the brief record for Heidi Example?');
    assert.match(s.after, /record it in the private brief and stop/);
    assert.deepEqual(s.options, ['30 September 2026', '31 December 2026', 'Other — explain']);
    assert.ok(s.doneControls.includes('Open brief'));
    assert.doesNotMatch(s.text, /anything further/);
  });
  check('open brief + trace', () => { const s = S('hr-desktop'); assert.equal(s.steps[0].draftsOpen, 1); assert.equal(s.steps[1].traceOpen, true); assert.ok(s.steps[1].stepsVisible > 0); });
  check('refresh', () => { const s = S('hr-refresh'); assert.equal(s.steps[0].question, s.question); assert.equal(s.steps[0].questions, 1); });
  check('answer', () => { const a = S('hr2-answer').steps[0]; assert.ok(a.clicked && a.ok); assert.equal(a.statusLine, 'Ready'); assert.equal(a.questions, 0); concise(a, 'answered'); });
  for (const n of ['amb-saim-phone', 'amb-desktop']) check(n, () => { const s = S(n); concise(s, n); assert.equal(s.statusLine, 'Waiting for your answer'); assert.equal(s.questions, 1); assert.deepEqual(s.options, ['Weekly risk report', 'SOAP report', 'Other — explain']); });
  check('plain press', () => { const r = S('plain-press').steps[0]; assert.ok(r.clicked && r.ok); concise(r, 'plain'); assert.equal(r.statusLine, 'Ready to save'); assert.equal(r.questions, 0); });
  for (const n of ['plain-neuro-phone', 'plain-saim-phone']) check(n, () => { const s = S(n); concise(s, n); assert.equal(s.statusLine, 'Ready to save'); });
  check('no duplicate run', () => assert.equal(calls - callsAfterSeed, 7, 'answer turn (3) + one plain run (4) — the double press made one run'));
  const db = require('../db/database');
  check('one attempt per task', () => { for (const t of Object.values(T)) { const raw = db.getState(`task_agent_run:${t.id}`); assert.ok(raw); } });

  const report = { shots: SHOTS, jobs: Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.error ? { error: v.error } : v.sizes.map((s) => ({ size: s.size, status: s.statusLine, questions: s.questions, done: s.done.length, traceOpen: s.traceOpen }))])), modelCallsInBrowser: calls - callsAfterSeed, fails };
  console.log(JSON.stringify(report, null, 2));
  try { ssrv.close(); } catch { /* */ }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
