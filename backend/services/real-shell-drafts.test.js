'use strict';

/**
 * Drafts, "make ready" from Now, the in-meeting callout and "I'm not attending" —
 * driven in a REAL BROWSER (Electron's Chromium) through BOTH real shells
 * (22 Oct 2026). NEURO desktop: the real AdhdPanel (Now) and DraftsPage under a
 * router with the SAME (view, context) contract as App.handleNavigate. SAiM
 * phone: the REAL App — its tab bar, Review, Drafts, Now and Surface.
 *
 * Over the real prepared-moves, authority, adhd and attention routes on a temp
 * DB and vault, with records created SERVER-SIDE before any page loads:
 *   - Drafts lists them with one status each, from the store (no second list);
 *   - opening an entry reaches THAT item: the exact question; the boundary and
 *     "What SAiM may do" in place; with an allowance, "Save it and protect the
 *     time" → the real confirmation (never confirmed); a held item has no button;
 *   - Review's first item is Drafts (phone);
 *   - an eligible Now row's "Draft the reply" prepares THAT email and lands on
 *     its Drafts entry (both shells);
 *   - in a meeting, "See what SAiM can make ready" is a control that opens the
 *     exact item; pressing it lands on its Drafts entry (phone);
 *   - "I'm not attending" posts the CURRENT meeting's key — never the next one —
 *     says what was recorded, and nothing is declined, sent or written;
 *   - throughout: vault, calendar, email, tasks, allowance and confirmations
 *     untouched until Nick confirms (he never does here).
 *
 * Skips — and says so — where no Electron binary exists.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'real-shell-drafts-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION', 'SAIM_PREPARED_MOVE_SCAN']) delete process.env[k];
for (const d of ['People', 'Meetings/2026/09', 'Projects/Support Hub']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
for (const n of ['Stephen Kerr', 'Heidi Ford']) fs.writeFileSync(path.join(VAULT, 'People', `${n}.md`), `---\ntype: person\n---\n# ${n}\n`);

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md';
const TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
fs.writeFileSync(path.join(VAULT, SOURCE), `---\ntype: meeting\n---\n# Weekly Meeting\n\n### Return-to-Office Policy and Incentives\n- Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets, leveraging AI efficiency gains; stagger WFH to maintain coverage.\n\n## Actions\n- [ ] ${TEXT}.\n\n### Team Performance\n- Stephen Kerr’s performance on hybrid WFH targets has dipped this month.\n- Heidi Ford is on leave next week; her WFH incentive is on hold.\n`);
const vaultTree = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(VAULT, p) + ':' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } }; walk(VAULT); return out.sort().join('\n'); };

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const exec = require('./prepared-move-exec');
const view = require('./prepared-move-view');
const mf = require('./meeting-finish');

// ── Fixtures: two private promise drafts, three emails (one gone), a meeting now and one later ──
const COPIES = ['ask', 'done'];
const TASKS = {};
const keyOf = (c) => `promise:${801 + COPIES.indexOf(c)}`;
const BODY = 'Hi Nick, could you confirm whether the renewal for Acme can go ahead this month? We need your answer.';
let CURRENT_EMAIL = 'gone';
const DISMISSED = new Set();
const emailCand = (id) => ({ ref: `held:email-${id}`, role: 'held', title: 'Renewal question', item: { type: 'email', id: 'email-urgent', title: 'Renewal question', meta: { emailId: id } } });
const v1Packet = () => ({ contract: 'prepared-move-v1', decision: { decidedAt: new Date(Date.now() - 60000).toISOString() }, duty: { onDuty: true, why: 'working' }, selected: null, withheld: [], candidates: [emailCand(CURRENT_EMAIL)] });
Object.assign(planner.DEFAULT_DEPS, {
  promise: (key) => {
    const c = COPIES.find((x) => keyOf(x) === key);
    return c ? { key, text: TEXT, open: true, taskIds: [TASKS[c]], leadTaskId: TASKS[c], owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } } : null;
  },
  promiseDelivered: () => false,
  prepareV1: async () => v1Packet(),
  triageEntry: (id) => (DISMISSED.has(id) ? { id, dismissed: true } : { id, subject: 'Renewal question', from: 'Sam Jones', fromEmail: 'sam@acme.test', triagedAt: new Date(Date.now() - 3600000).toISOString() }),
  emailBody: async () => BODY,
  liveReply: () => null,
  draft: async () => ({ ok: true, text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick', gaps: [] }),
  // No diary override: the planner reads the SAME calendar the fresh checks do (a meeting is seeded today).
  holidays: () => new Set(), leaveState: () => 'working',
});
const working = async () => ({ onDuty: true, why: 'working' });
require('./prepared-move').readDuty = working;
exec._setDeps({ readDuty: working });
require('./team-availability').selfAbsenceOn = () => ({ known: true, off: false });

const london = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).replace(' ', 'T');
const NOW0 = Date.now();
const CUR = { id: 'evt-current', subject: 'Weekly Ops', start: london(NOW0 - 15 * 60000), end: london(NOW0 + 40 * 60000) };
const NEXT_MS = NOW0 + 50 * 60000;
const NEXT = london(NEXT_MS).slice(0, 10) === london(NOW0).slice(0, 10) ? { id: 'evt-next', subject: 'Planning', start: london(NEXT_MS), end: london(NEXT_MS + 30 * 60000) } : null;
const curKey = mf.keyFor(CUR);
const nextKey = NEXT ? mf.keyFor(NEXT) : null;
let MEETING = false;

function attentionPayload() {
  const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');
  const base = JSON.parse(JSON.stringify(FIXTURES.find((x) => x.id === 'working-busy').payload));
  base.primary = { kind: 'item', id: 'email-urgent', recordId: 'rec-email', type: 'email', title: 'Renewal question', say: 'Sam Jones asked whether the Acme renewal can go ahead.', urgency: 'high', tab: 'inbox', actions: ['acknowledge', 'defer', 'dismiss'] };
  base.secondary = [];
  if (!MEETING) return base;
  // The meeting leaves SAiM's view of the day the moment Nick says he is not attending — the REAL override.
  const still = mf.applyTo({ known: true, events: [{ ...CUR }] }, mf.list()).events.length === 1;
  if (!still) return base;
  base.context = { ...base.context, activity: 'in-meeting', quiet: true };
  base.primary = { kind: 'context', id: 'context-in-meeting', title: 'In a meeting', say: 'You’re in “Weekly Ops”.' };
  base.meeting = { key: curKey, subject: CUR.subject, scheduledEnd: CUR.end };
  base.nextMeeting = NEXT ? { key: nextKey, subject: NEXT.subject, time: NEXT.start.slice(11, 16) } : null;
  base.handoff = { rule: 'S3 meeting', handoff: { primary: { label: 'Join in Teams', target: { type: 'link', href: 'https://teams.microsoft.com/l/meetup-join/test' } }, alternatives: [{ label: 'Open meeting prep', target: { type: 'link', role: 'prep', href: 'neuro:?item=meeting-prep:evt-current' } }] }, why: null };
  return base;
}
function canonicalNow() {
  const p = attentionPayload();
  return { ...p, presentation: require('./presentation-intent').composePresentation(p, { now: new Date().toISOString() }) };
}

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
function reactFor(appDir) {
  for (const base of [path.join(appDir, 'node_modules'), path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'nuero', path.relative(ROOT, appDir), 'node_modules'), path.join(ROOT, '..', 'nuero', 'node_modules')]) {
    if (fs.existsSync(path.join(base, 'react', 'package.json'))) return base;
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
    nodePaths: [nm, path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'nuero', 'node_modules')],
  });
  const css = fs.existsSync(path.join(out, `${name}.css`)) ? `<link rel="stylesheet" href="/${name}.css">` : '';
  fs.writeFileSync(path.join(out, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${css}<style>html,body{margin:0;background:#06080c;color:#e6edf3;font-family:system-ui}*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>try{localStorage.setItem('neuro_pin','pin-1234')}catch(e){}</script><script type="module" src="/${name}.js"></script></body></html>`);
}

// The desktop: the real Now and Drafts under a router with App.handleNavigate's contract (view, context).
const DESKTOP_ENTRY = (adhd, drafts) => `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import AdhdPanel from ${JSON.stringify(adhd)};
import DraftsPage from ${JSON.stringify(drafts)};
function Shell() {
  const start = (location.hash || '#today').slice(1);
  const [nav, setNav] = useState({ view: start, context: null });
  const onNavigate = (view, context = null) => { window.__navs = (window.__navs || []).concat([{ view, context }]); setNav({ view, context }); };
  return nav.view === 'drafts' ? React.createElement(DraftsPage, { context: nav.context }) : React.createElement(AdhdPanel, { onNavigate });
}
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`;

let server; let base; let skipWhy = null; const results = {}; const MEETING_POSTS = [];
const SHOTS = process.env.SHELL_SHOTS || path.join(tmp, 'shots');
const count = (t) => { try { return db.get(`SELECT COUNT(*) n FROM ${t}`).n; } catch { return 0; } };
const counts = () => ({
  vault: vaultTree(), ledger: count('external_write_ledger'), actions: count('prepared_actions'), reservations: count('saim_authority_reservations'),
  calendar: count('calendar_cache'), tasks: count('tasks'), receipts: count("agent_state WHERE key LIKE 'saim_move_receipt:%'"),
});
async function api(p, body) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NEURO-PIN': 'pin-1234' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — the real shells were NOT driven'; return; }
  await db.init();
  require('./prepared-move-store').ensure();
  const ts = require('./task-store');
  for (const c of COPIES) {
    const r = ts.createTask({ text: TEXT, source: 'meeting-promotion', origin_path: SOURCE, distinct: true });
    TASKS[c] = (r && (r.id || (r.task && r.task.id))) || db.get('SELECT id FROM tasks WHERE text LIKE ? ORDER BY id DESC LIMIT 1', [`${TEXT}%`]).id;
  }
  const insertCal = (ev, fresh = true) => db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, show_as, attendees_other, is_organizer, source, fetched_at) VALUES (?, ?, ?, ?, 'busy', 1, 0, 'graph', ${fresh ? 'CURRENT_TIMESTAMP' : "'2020-01-01 00:00:00'"})`, [ev.id, ev.subject, ev.start, ev.end]);
  insertCal(CUR); if (NEXT) insertCal(NEXT);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(tmp, 'www')));
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/attention/meeting', (req, res, next) => { MEETING_POSTS.push({ path: req.path, body: req.body }); next(); });
  app.use('/api/attention', require('../routes/attention'));
  app.use('/api/prepared-moves', require('../routes/prepared-moves'));
  app.use('/api/saim-authority', require('../routes/saim-authority'));
  app.use('/api/adhd', require('../routes/adhd'));
  app.get('/api/canonical/now', (req, res) => { try { res.json(canonicalNow()); } catch (e) { res.status(500).json({ error: e.message }); } });
  // The phone's Now: the REAL snapshot builder over the same attention payload.
  require('./attention').build = async () => attentionPayload();
  app.get('/api/mobile/v1/nick-now', async (req, res) => { try { res.json(await require('./mobile-snapshot').build({ now: new Date() })); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.use('/api', (req, res) => res.status(503).json({ ok: false, error: 'not available in this test' }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await bundleShell('desktop', DESKTOP_ENTRY(path.join(ROOT, 'frontend/src/components/AdhdPanel.jsx').replace(/\\/g, '/'), path.join(ROOT, 'frontend/src/components/DraftsPage.jsx').replace(/\\/g, '/')), path.join(ROOT, 'frontend'));
  await bundleShell('phone', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from ${JSON.stringify(path.join(ROOT, 'saim/app/src/App.jsx').replace(/\\/g, '/'))};\nimport ${JSON.stringify(path.join(ROOT, 'saim/app/src/App.css').replace(/\\/g, '/'))};\ncreateRoot(document.getElementById('root')).render(React.createElement(App));\n`, path.join(ROOT, 'saim/app'), { VITE_API_URL: base }); // configured like production, or the real App refuses to run

  // ── Records, made SERVER-SIDE before any page loads ──
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  const walk = async (m, n) => {
    const plan = [['t', 'Two days WFH a week at or above 90% of FRT target'], ['p'], ['t', 'Everyone on the service desk, heard in their 1-2-1s'], ['p']].slice(0, n);
    for (const [k, text] of plan) { const r = await api('/api/prepared-moves/answer', { recordId: m.recordId, version: m.version, questionId: m.question.id, ...(k === 'p' ? { park: true } : { text }) }); assert.equal(r.status, 200, `${JSON.stringify(r.body)} — asked: ${JSON.stringify({ state: m.state, q: m.question, priv: !!m.privateDraft })}`); m = r.body.promiseMove; }
    return m;
  };
  for (const [c, n] of [['ask', 1], ['done', 4]]) {
    const p = await api('/api/prepared-moves/prepare', { ref: `promise:${keyOf(c)}` });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    results[`seed-${c}`] = await walk(p.body.promiseMove, n);
  }
  CURRENT_EMAIL = 'gone';
  const g = await api('/api/prepared-moves/prepare', { ref: 'held:email-gone' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  DISMISSED.add('gone'); // answered elsewhere since — the draft can no longer be offered
  results.seedGone = g.body.move && g.body.move.recordId;
  await new Promise((r) => setTimeout(r, 3000)); // NEURO's debounced task export lands before the baseline
  results.before = counts();
  results.grantsBefore = count('human_action_intents');

  fs.mkdirSync(SHOTS, { recursive: true });
  const appDir = path.join(tmp, 'driver'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'shell-driver-drafts', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), DRIVER);
  const env = { ...process.env, J: path.join(tmp, 'job.json'), O: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (job) => new Promise((resolve) => {
    fs.writeFileSync(env.J, JSON.stringify({ job, shots: SHOTS, curKey, nextKey }));
    const child = require('child_process').spawn(bin, [appDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 150000);
    child.on('exit', () => { clearTimeout(t); try { resolve(JSON.parse(fs.readFileSync(env.O, 'utf8'))); } catch { resolve({ error: `no result: ${err.slice(0, 600)}` }); } });
  });
  const D = (name, mode, hash = '#drafts') => ({ name, mode, shell: 'desktop', url: `${base}/desktop.html${hash}`, w: 1440, h: 900 });
  const P = (name, mode, q = '?tab=review') => ({ name, mode, shell: 'phone', url: `${base}/phone.html${q}`, w: 390, h: 844 });
  const budget = require('./authority-budget');
  budget._test.reset();
  // 1. No allowance today.
  results['d-list'] = await run(D('d-list', 'list'));
  results['p-list'] = await run(P('p-list', 'list'));
  // 2. Allowance granted (as Nick would, in "What SAiM may do").
  budget._test.grantToday();
  results['d-save'] = await run(D('d-save', 'save'));
  results['p-save'] = await run(P('p-save', 'save', '?tab=drafts'));
  // 3. Now rows: each shell prepares ITS OWN eligible email.
  CURRENT_EMAIL = 'm-desk'; results['d-now'] = await run(D('d-now', 'now', '#today'));
  CURRENT_EMAIL = 'm-phone'; results['p-now'] = await run(P('p-now', 'now', '?tab=now'));
  // 4. In a meeting.
  MEETING = true; CURRENT_EMAIL = 'm-meet';
  const restore = view._setDeps({ prepare: async () => v1Packet() }); // Home's offer, from the SAME candidates
  try {
    results['p-meet'] = await run(P('p-meet', 'meet', ''));
    results['d-skip'] = await run(D('d-skip', 'skip-desktop', '#today'));
    results['p-skip'] = await run(P('p-skip', 'skip-phone', ''));
  } finally { restore(); }
  delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
  results.after = counts();
  results.posts = MEETING_POSTS.slice();
  try { fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 1)); } catch { /* evidence only */ }
});
test.after(() => { try { server && server.close(); } catch { /* */ } delete process.env.SAIM_PREPARED_MOVE_EXECUTION; if (!process.env.SHELL_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

const { LOAD_WITH_RETRY } = require('./electron-driver-support');
const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron');
${LOAD_WITH_RETRY}
const fs = require('fs'); const path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.env.J, 'utf8'));
const j = cfg.job;
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); app.exit(2); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: j.w, height: j.h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
  win.setContentSize(j.w, j.h);
  const logs = []; win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) logs.push(msg); });
  const r = { name: j.name, shots: [], logs };
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (n) => { const img = await win.webContents.capturePage(); const f = path.join(cfg.shots, j.name + '-' + n + '.png'); fs.writeFileSync(f, img.toPNG()); r.shots.push(f); };
  const waitFor = async (code, ms = 45000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await js(code); if (v) return v; } catch {} await sleep(150); } return null; };
  const btn = (label, scope = 'document') => '[...((' + scope + ') || document.createElement("div")).querySelectorAll("button")].find((b) => b.textContent.trim() === ' + JSON.stringify(label) + ' && !b.disabled)';
  const press = async (sel) => { await mustWait(js, '!!(' + sel + ')', sel); await js('(' + sel + ').click()'); };
  const row = (status) => '[...document.querySelectorAll(".drafts__row")].find((x) => x.querySelector(".drafts__status") && x.querySelector(".drafts__status").textContent.trim() === ' + JSON.stringify(status) + ')';
  const scrollTo = (sel) => js('(() => { const el = ' + sel + '; if (el) el.scrollIntoView({ block: "center" }); return !!el; })()');
  const text = () => js('document.body.innerText');
  const rows = () => js('[...document.querySelectorAll(".drafts__row")].map((x) => ({ status: x.querySelector(".drafts__status").textContent.trim(), kind: x.querySelector(".drafts__kind").textContent.trim(), say: x.querySelector(".drafts__say").textContent.trim(), buttons: [...x.querySelectorAll("button")].map((b) => b.textContent.trim()), recordId: x.dataset.recordId, open: x.classList.contains("drafts__row--open") }))');
  try {
    await loadWithRetry(win, j.url); // a clean page load every time
    if (j.mode === 'list') {
      if (j.shell === 'phone') {
        // Review's FIRST item is Drafts — reached without re-expanding the tab bar.
        r.reviewFirst = await waitFor('(() => { const t = document.querySelector(".view__title"); const n = t && t.nextElementSibling; return n && n.dataset.testid === "review-drafts" ? n.innerText : null; })()');
        await shot('0-review');
        await js('document.querySelector("[data-testid=review-drafts]").click()');
      }
      r.loaded = await waitFor('document.querySelectorAll(".drafts__row").length >= 3');
      r.rows = await rows();
      await shot('1-drafts-list');
      // Waiting for allowance → the boundary, and "What SAiM may do" IN place.
      await press(btn('Open what SAiM may do', row('Waiting for allowance')));
      r.boundary = await waitFor('(() => { const b = document.querySelector(".drafts__row--open .pmo__boundary"); return b ? b.innerText : null; })()');
      r.route = !!(await waitFor('!!(' + btn('Open what SAiM may do', 'document.querySelector(".drafts__row--open")') + ')'));
      await press(btn('Open what SAiM may do', 'document.querySelector(".drafts__row--open")'));
      r.authority = await waitFor('(() => { const a = document.querySelector(".drafts__row--open .promise-save__authority .auth"); return a ? a.innerText.slice(0, 200) : null; })()');
      await scrollTo('document.querySelector(".drafts__row--open")'); await shot('2-allowance-in-place');
      await press(btn('Close'));
      // Needs your answer → the exact question.
      await waitFor('!!(' + btn('Answer the question', row('Needs your answer')) + ')');
      await press(btn('Answer the question', row('Needs your answer')));
      r.question = await waitFor('(() => { const q = [...document.querySelectorAll(".drafts__row--open label, .drafts__row--open .pmo2__ivq, .drafts__row--open .pmo__ask")].map((x) => x.textContent).find((t) => /What is the incentive/.test(t)); return q || null; })()');
      await scrollTo('document.querySelector(".drafts__row--open")'); await shot('3-question');
      r.text = await text();
    } else if (j.mode === 'save') {
      r.loaded = await waitFor('!!(' + btn('Open the draft', row('Ready to save')) + ')', 25000);
      r.rows = await rows();
      await shot('4-ready-to-save');
      await press(btn('Open the draft', row('Ready to save')));
      r.saveBtn = !!(await waitFor('!!(' + btn('Save it and protect the time') + ')'));
      r.writes = await js('(() => [...document.querySelectorAll(".drafts__row--open .pmo__writes li")].map((x) => x.textContent))()');
      await scrollTo(btn('Save it and protect the time')); await shot('5-save-step');
      await press(btn('Save it and protect the time'));
      r.confirm = !!(await waitFor('!!(' + btn('Confirm') + ')'));
      r.confirmWrites = await js('(() => [...document.querySelectorAll(".drafts__row--open .pmo__writes li")].map((x) => x.textContent))()');
      await scrollTo(btn('Confirm')); await shot('6-confirmation');
      r.text = await text();
    } else if (j.mode === 'now') {
      r.rowBtn = !!(await waitFor('!!(' + btn('Draft the reply') + ')', 25000));
      r.textBefore = await text();
      await scrollTo(btn('Draft the reply')); await shot('7-now-row');
      await press(btn('Draft the reply'));
      r.landed = await waitFor('(() => { const o = document.querySelector(".drafts__row--open"); return o ? o.dataset.recordId : null; })()', 30000);
      r.rows = await rows();
      r.navs = await js('window.__navs || null');
      await scrollTo('document.querySelector(".drafts__row--open")'); await shot('8-landed-in-drafts');
      r.text = await text();
      // "Ready to confirm" → "Open the confirmation": the press requests the REAL confirmation (and nothing on load did).
      await press(btn('Close'));
      await waitFor('!!(' + btn('Open the confirmation', '[...document.querySelectorAll(".drafts__row")].find((x) => x.dataset.recordId === ' + JSON.stringify(r.landed) + ')') + ')');
      await press(btn('Open the confirmation', '[...document.querySelectorAll(".drafts__row")].find((x) => x.dataset.recordId === ' + JSON.stringify(r.landed) + ')'));
      r.confirm = !!(await waitFor('!!(' + btn('Confirm') + ')'));
      r.confirmWrites = await js('(() => [...document.querySelectorAll(".drafts__row--open .pmo__writes li")].map((x) => x.textContent))()');
      await scrollTo(btn('Confirm')); await shot('8b-reply-confirmation');
    } else if (j.mode === 'meet') {
      r.control = await waitFor('(() => { const s = [...document.querySelectorAll("summary")].find((x) => x.textContent.trim() === "See what SAiM can make ready"); return s ? s.className : null; })()', 25000);
      r.step = await js('(() => { const g = document.querySelector(".sit__step"); return g ? [...g.querySelectorAll("button")].map((b) => b.textContent.trim()) : null; })()');
      r.skipKey = await js('(() => { const b = document.querySelector(".sit__step-skip"); return b ? b.dataset.meetingKey : null; })()');
      await scrollTo('[...document.querySelectorAll("summary")].find((x) => x.textContent.trim() === "See what SAiM can make ready")'); await shot('9-in-meeting-callout');
      await js('[...document.querySelectorAll("summary")].find((x) => x.textContent.trim() === "See what SAiM can make ready").click()');
      r.offer = !!(await waitFor('!!(' + btn('Draft the reply') + ')'));
      await scrollTo(btn('Draft the reply')); await shot('10-callout-open');
      await press(btn('Draft the reply'));
      r.landed = await waitFor('(() => { const o = document.querySelector(".drafts__row--open"); return o ? o.dataset.recordId : null; })()', 30000);
      r.rows = await rows();
      await shot('11-callout-landed');
    } else if (j.mode === 'skip-desktop') {
      r.ctl = await waitFor('(() => { const c = document.querySelector("[data-testid=meeting-controls]"); return c ? c.innerText : null; })()', 25000);
      await scrollTo('document.querySelector("[data-testid=meeting-controls]")'); await shot('12-desktop-meeting-controls');
      await press(btn('I’m not attending'));
      r.recorded = await waitFor('(() => { const c = document.querySelector("[data-testid=meeting-controls]"); return c && /Recorded/.test(c.innerText) ? c.innerText : null; })()');
      await shot('13-desktop-recorded');
      await press(btn('Undo'));
      r.undone = await waitFor('(() => { const c = document.querySelector("[data-testid=meeting-controls]"); return c && /I’m not attending/.test(c.innerText) ? true : null; })()');
    } else if (j.mode === 'skip-phone') {
      r.before = await waitFor('(() => { const g = document.querySelector(".sit__step"); return g ? [...g.querySelectorAll("button")].map((b) => b.textContent.trim()) : null; })()', 25000);
      // The REAL phone App on its Surface: the page never scrolls sideways.
      r.width = await js('({ vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, surface: !!document.querySelector(".app__view .surface") })');
      await scrollTo('document.querySelector(".sit__step")'); await shot('14-phone-step');
      await js('document.querySelector(".sit__step-skip").click()');
      r.recorded = await waitFor('(() => { const c = document.querySelector(".surface__recorded"); return c ? c.innerText : null; })()');
      r.after = await waitFor('(() => { const g = document.querySelector(".sit__step"); return g ? null : "gone"; })()');
      await shot('15-phone-recorded');
      r.text = await text();
    }
  } catch (e) { r.error = String(e && e.stack || e); }
  fs.writeFileSync(process.env.O, JSON.stringify(r));
  win.destroy();
  app.quit();
});
`;

const HOME = /SAiM home/i;
const okRun = (r) => assert.ok(r && !r.error, `${r && r.error} | ${(r && r.logs || []).slice(0, 4).join(' | ')}`);
for (const [s, shell] of [['d', 'desktop'], ['p', 'phone']]) {
  test(`${shell}: Drafts loads every server record with one status each; a held one has its reason and no button`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-list`]; okRun(r);
    if (s === 'p') assert.match(String(r.reviewFirst), /^Drafts/, 'Review’s first item is Drafts');
    const by = Object.fromEntries(r.rows.map((x) => [x.status, x]));
    assert.deepEqual(r.rows.map((x) => x.status), ['Needs your answer', 'Waiting for allowance', 'Held'], JSON.stringify(r.rows));
    assert.equal(by['Needs your answer'].kind, 'Private working draft');
    assert.match(by['Needs your answer'].say, /^Decision 2 of 4: What is the incentive/);
    assert.equal(by.Held.kind, 'Reply draft');
    assert.match(by.Held.say, /no longer waiting in triage/);
    assert.deepEqual(by.Held.buttons, [], 'a held item has no button');
  });
  test(`${shell}: Waiting for allowance opens the boundary, and "What SAiM may do" opens in place`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-list`]; okRun(r);
    assert.match(String(r.boundary), /You haven’t allowed me to carry out prepared moves today/);
    assert.ok(r.route);
    assert.match(String(r.authority), /What SAiM may do/);
  });
  test(`${shell}: Needs your answer opens the exact question`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-list`]; okRun(r);
    assert.match(String(r.question), /What is the incentive, and what earns it\?/);
    assert.doesNotMatch(r.text, HOME);
  });
  test(`${shell}: with an allowance, Ready to save → the save step → the real confirmation (note + solo block) — never confirmed`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-save`]; okRun(r);
    assert.ok(r.loaded && r.saveBtn, JSON.stringify(r.rows));
    assert.ok(r.writes.some((w) => /Working drafts: Projects\/Working\//.test(w)), JSON.stringify(r.writes));
    assert.ok(r.confirm, 'the confirmation');
    assert.ok(r.confirmWrites.some((w) => /to your calendar, .* Just you — nobody is invited\./.test(w)), JSON.stringify(r.confirmWrites));
    assert.doesNotMatch(r.text, HOME);
  });
  test(`${shell}: an eligible Now row's "Draft the reply" prepares THAT email and lands on its Drafts entry`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-now`]; okRun(r);
    assert.ok(r.rowBtn, 'the row-level control, from the server’s label');
    const email = s === 'd' ? 'm-desk' : 'm-phone';
    const rec = db.get(`SELECT id, json_extract(packet_json, '$.selected.source.emailId') e, json_extract(packet_json, '$.firstOrigin') o FROM prepared_moves WHERE move_key LIKE ? ORDER BY version DESC LIMIT 1`, [`%email:${email}`]);
    assert.ok(rec, `a proposal for ${email} exists`);
    assert.equal(rec.e, email, 'the exact item, not a generic one');
    assert.equal(rec.o, 'manual', 'Nick’s press');
    assert.equal(r.landed, rec.id, 'Drafts opened on THAT record');
    assert.equal(r.rows.find((x) => x.recordId === rec.id).status, 'Ready to confirm');
    if (s === 'd') assert.deepEqual(r.navs, [{ view: 'drafts', context: { recordId: rec.id } }], 'the desktop navigates with App.handleNavigate’s (view, context)');
    assert.ok(r.confirm, '"Open the confirmation" reaches the real confirmation');
    assert.ok(r.confirmWrites.some((w) => /Put the reply to .* in Actions, waiting for your approval code\. It is NOT sent\./.test(w)), JSON.stringify(r.confirmWrites));
  });
}
test('phone, in a meeting: "See what SAiM can make ready" is a control that opens the exact item; pressing it lands on its Drafts entry', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const r = results['p-meet']; okRun(r);
  assert.match(String(r.control), /sit__prepared-entry--control/);
  assert.deepEqual(r.step, ['Join in Teams', 'Open meeting prep', 'Capture from this meeting', 'I’m not attending'], 'Join, Prep and Capture unchanged; "I’m not attending" quietly beside them');
  assert.equal(r.skipKey, curKey, 'it names the CURRENT meeting, not the next');
  assert.ok(r.offer);
  const rec = db.get(`SELECT id FROM prepared_moves WHERE move_key LIKE '%email:m-meet' ORDER BY version DESC LIMIT 1`);
  assert.equal(r.landed, rec && rec.id);
});
test('"I’m not attending" posts the CURRENT meeting only, says what was recorded, and the meeting stops driving Join/Prep/Capture', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const d = results['d-skip']; okRun(d);
  const p = results['p-skip']; okRun(p);
  assert.match(String(d.ctl), /In Weekly Ops/);
  assert.match(String(d.recorded), /Recorded: you’re not attending “Weekly Ops”\. SAiM won’t treat it as a meeting you’re in\. Nothing was declined or sent, and no one’s calendar was changed\./);
  assert.ok(d.undone, 'Undo resumes it');
  assert.ok(p.before.includes('I’m not attending'));
  assert.ok(p.width.surface, 'positive control: the real phone App drew its Surface inside .app__view');
  assert.equal(p.width.sw, p.width.vw, 'the real phone App on its Surface does not scroll sideways at 390px');
  assert.match(String(p.recorded), /Recorded: you’re not attending “Weekly Ops”/);
  assert.equal(p.after, 'gone', 'the meeting no longer drives Join/Prep/Capture on this device');
  const posts = results.posts.map((x) => `${x.path} ${x.body && x.body.key}`);
  assert.deepEqual(posts, [`/not-attending ${curKey}`, `/resume ${curKey}`, `/not-attending ${curKey}`], 'only the current meeting, by its key — never the next one');
  if (nextKey) assert.ok(!posts.some((x) => x.includes(nextKey)));
});
test('throughout: no vault, calendar, email, task, allowance or execution write — nothing was confirmed', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const k of ['vault', 'ledger', 'actions', 'reservations', 'calendar', 'tasks', 'receipts']) assert.deepEqual(results.after[k], results.before[k], k);
  const minted = db.get('SELECT COUNT(*) n FROM human_action_intents').n;
  assert.ok(minted >= 1, 'the presses did mint confirmations (positive control)');
  assert.equal(db.get('SELECT COUNT(*) n FROM human_action_intents WHERE consumed_at IS NOT NULL').n, 0, 'none was ever spent — nothing was confirmed');
});
