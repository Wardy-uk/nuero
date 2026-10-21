'use strict';

/**
 * The private-draft interview, driven in a REAL BROWSER (Electron's Chromium)
 * through BOTH real shells (26 Oct 2026). Not component rendering: the actual
 * NEURO desktop surface (`frontend/src/components/AdhdPanel.jsx`) and the actual
 * SAiM phone surface (`saim/app/src/views/Surface.jsx`) are bundled with their
 * own API clients and stylesheets and served next to the REAL prepared-moves
 * routes (real api-auth, authority guard, store, planner and a temp vault).
 * Canonical Now is composed per request from the real promise-moves +
 * keep-my-word code over that same DB, so the card shows exactly what the
 * server holds.
 *
 * For each shell: load it, press "Prepare a private working draft", see
 * "Decision 1 of 4", the exact first question, its field, "Tell SAiM" and
 * "Park this for now"; answer; see the next question and the answer kept as
 * Nick's words; park; see the third. The generic "Nothing more to prepare for
 * that right now" must never appear. Afterwards: no note, block, allowance,
 * confirmation, email or other outbound state exists. Screenshots of each
 * step are written (SHELL_SHOTS=<dir> keeps them).
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
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'real-shell-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'SAIM_PREPARED_MOVE_EXECUTION']) delete process.env[k];
for (const d of ['People', 'Meetings/2026/09', 'Projects/Support Hub']) fs.mkdirSync(path.join(VAULT, d), { recursive: true });
for (const n of ['Stephen Kerr', 'Heidi Ford']) fs.writeFileSync(path.join(VAULT, 'People', `${n}.md`), `---\ntype: person\n---\n# ${n}\n`);

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = 'Meetings/2026/09/2026-09-01 – Weekly Meeting Ticket Health, AI Integration, and Team Performance.md';
const TEXT = 'Define achievable targets for hybrid/WFH incentive; agree plan on 2026-09-02';
fs.writeFileSync(path.join(VAULT, SOURCE), `---\ntype: meeting\n---\n# Weekly Meeting\n\n### Return-to-Office Policy and Incentives\n- Consider hybrid model (e.g., two days WFH) as incentive tied to achievable targets, leveraging AI efficiency gains; stagger WFH to maintain coverage.\n\n## Actions\n- [ ] ${TEXT}.\n\n### Team Performance\n- Stephen Kerr’s performance on hybrid WFH targets has dipped this month.\n- Heidi Ford is on leave next week; her WFH incentive is on hold.\n`);
const vaultTree = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(VAULT, p) + ':' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } }; walk(VAULT); return out.sort().join('\n'); };

const db = require('../db/database');
const planner = require('./prepared-move-planner');
const ANSWER = 'Two days WFH a week for anyone at or above 90% of their FRT target for the month';

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}
/** The react the shell itself builds with: the desktop's from the repo root, the phone's from saim/app. */
function reactFor(appDir) {
  for (const base of [path.join(appDir, 'node_modules'), path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'nuero', path.relative(ROOT, appDir), 'node_modules'), path.join(ROOT, '..', 'nuero', 'node_modules')]) {
    if (fs.existsSync(path.join(base, 'react', 'package.json'))) return base;
  }
  return null;
}
async function bundleShell(name, entryCode, appDir) {
  const nm = reactFor(appDir);
  if (!nm) throw new Error(`no react for ${appDir}`);
  const entry = path.join(tmp, `${name}-entry.jsx`);
  fs.writeFileSync(entry, entryCode);
  const out = path.join(tmp, 'www');
  await esbuild.build({
    entryPoints: { [name]: entry }, bundle: true, outdir: out, format: 'esm', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', VITE_VAULT_API_KEY: '', DEV: false, PROD: true, MODE: 'production', VITE_BUILD_LABEL: 'test' }) },
    alias: { react: path.join(nm, 'react'), 'react-dom': path.join(nm, 'react-dom'), 'react/jsx-runtime': path.join(nm, 'react', 'jsx-runtime.js') },
    nodePaths: [nm, path.join(ROOT, 'node_modules'), path.join(ROOT, '..', 'nuero', 'node_modules')],
  });
  const css = fs.existsSync(path.join(out, `${name}.css`)) ? `<link rel="stylesheet" href="/${name}.css">` : '';
  fs.writeFileSync(path.join(out, `${name}.html`), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${css}<style>html,body{margin:0;background:#06080c;color:#e6edf3;font-family:system-ui}*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>try{localStorage.setItem('neuro_pin','pin-1234')}catch(e){}</script><script type="module" src="/${name}.js"></script></body></html>`);
}

// ── The real backend: prepared-moves routes + a canonical Now composed from the real code ──
let server; let base; let taskId; let skipWhy = null; let results = null;
const TASKS = {}; // shell → task id: each shell drives its OWN copy of the same promise from scratch
let promiseKey = 'promise:322';
const SHOTS = process.env.SHELL_SHOTS || path.join(tmp, 'shots');

function canonicalNow() {
  const { composePresentation } = require('./presentation-intent');
  const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');
  const f = FIXTURES.find((x) => x.id === 'empty');
  const p = composePresentation(f.payload, { now: f.at });
  const item = {
    key: promiseKey, taskIds: [taskId], leadTaskId: taskId, title: TEXT, owedTo: null,
    due: { date: '2026-10-16', basis: 'set', endsAt: '2026-10-16T23:00:00.000Z', tier: 'overdue', say: 'overdue' },
    booked: [], preparation: { state: 'waiting-for-Nick', missing: 'owed-to', why: 'Your notes don’t name who it is owed to.' },
    because: ['overdue (Friday 16 October)'], evidence: [{ kind: 'due', fact: 'Due Friday 16 October — the date set on the task.' }],
  };
  const moves = { [promiseKey]: require('./promise-moves').moveFor(item) };
  p.keepMyWord = require('./keep-my-word').compose({
    score: { ratio: { kept: 3, of: 4 }, counts: { reDated: 0, pending: 1 }, entries: [], mondayReport: null },
    workbench: { state: 'ok', items: [item], withheld: {} }, moves, presentation: p, now: Date.now(),
  });
  return { ...f.payload, presentation: p, poolAvailable: true };
}

test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — the real shells were NOT driven'; return; }
  await db.init();
  const ts = require('./task-store');
  for (const shell of ['desktop', 'phone']) {
    const r = ts.createTask({ text: TEXT, source: 'meeting-promotion', origin_path: SOURCE, distinct: true });
    TASKS[shell] = (r && (r.id || (r.task && r.task.id))) || db.get('SELECT id FROM tasks WHERE text LIKE ? ORDER BY id DESC LIMIT 1', [`${TEXT}%`]).id;
  }
  assert.notEqual(TASKS.desktop, TASKS.phone, 'two separate copies of the promise');
  const keyOf = (shell) => (shell === 'desktop' ? 'promise:322' : 'promise:323');
  Object.assign(planner.DEFAULT_DEPS, {
    promise: (key) => {
      const shell = key === 'promise:322' ? 'desktop' : key === 'promise:323' ? 'phone' : null;
      return shell ? { key, text: TEXT, open: true, taskIds: [TASKS[shell]], leadTaskId: TASKS[shell], owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } } : null;
    },
    promiseDelivered: () => false,
    diary: () => ({ known: true, events: [], fetchedAt: new Date(Date.now() - 60000).toISOString() }),
    holidays: () => new Set(), leaveState: () => 'working',
  });
  require('./prepared-move').readDuty = async () => ({ onDuty: true, why: 'working' });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(tmp, 'www')));
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/prepared-moves', require('../routes/prepared-moves'));
  // The desktop page's own read, as production mounts it (over the temp DB/vault): without it the page shows its error state.
  app.use('/api/adhd', require('../routes/adhd'));
  app.get('/api/canonical/now', (req, res) => { try { res.json(canonicalNow()); } catch (e) { res.status(500).json({ error: e.message }); } });
  // Everything else either shell asks for is unavailable — each surface must cope (it does in production when a feed is down).
  app.use('/api', (req, res) => res.status(503).json({ ok: false, error: 'not available in this test' }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await bundleShell('desktop', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport AdhdPanel from ${JSON.stringify(path.join(ROOT, 'frontend/src/components/AdhdPanel.jsx').replace(/\\/g, '/'))};\ncreateRoot(document.getElementById('root')).render(React.createElement(AdhdPanel, { onNavigate() {} }));\n`, path.join(ROOT, 'frontend'));
  await bundleShell('phone', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport Surface from ${JSON.stringify(path.join(ROOT, 'saim/app/src/views/Surface.jsx').replace(/\\/g, '/'))};\nimport ${JSON.stringify(path.join(ROOT, 'saim/app/src/App.css').replace(/\\/g, '/'))};\ncreateRoot(document.getElementById('root')).render(React.createElement(Surface, { onNavigate() {}, onShowAll() {} }));\n`, path.join(ROOT, 'saim/app'));

  // NEURO's own task export follows createTask (debounced): let it land before the baseline, so only what the shells do is compared.
  await new Promise((r) => setTimeout(r, 3000));
  const before = { vault: vaultTree(), ledger: count('external_write_ledger'), actions: count('prepared_actions'), grants: count('human_action_intents'), authority: count('saim_authority_grants'), reservations: count('saim_authority_reservations') };
  fs.mkdirSync(SHOTS, { recursive: true });
  const appDir = path.join(tmp, 'driver'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'shell-driver', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), DRIVER);
  const jobs = [{ shell: 'desktop', url: `${base}/desktop.html`, w: 1440, h: 900 }, { shell: 'phone', url: `${base}/phone.html`, w: 390, h: 844 }];
  fs.writeFileSync(path.join(tmp, 'jobs.json'), JSON.stringify({ jobs, answer: ANSWER, shots: SHOTS }));
  const env = { ...process.env, J: path.join(tmp, 'jobs.json'), O: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (job) => new Promise((resolve) => {
    // The driver runs ONE shell per process so each starts from the same server state.
    fs.writeFileSync(env.J, JSON.stringify({ jobs: [job], answer: ANSWER, shots: SHOTS }));
    const child = require('child_process').spawn(bin, [appDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 120000);
    child.on('exit', () => { clearTimeout(t); try { resolve(JSON.parse(fs.readFileSync(env.O, 'utf8'))[0]); } catch { resolve({ shell: job.shell, error: `no result: ${err.slice(0, 600)}` }); } });
  });
  results = {};
  for (const job of jobs) {
    // Each shell starts its own copy of the promise from scratch: nothing prepared.
    taskId = TASKS[job.shell]; promiseKey = keyOf(job.shell);
    require('./prepared-move-store').ensure();
    assert.equal(db.get('SELECT COUNT(*) n FROM prepared_moves WHERE move_key = ?', [planner.moveKeyFor('project-note', `task:${taskId}`)]).n, 0);
    results[job.shell] = await run(job);
  }
  results.after = { vault: vaultTree(), ledger: count('external_write_ledger'), actions: count('prepared_actions'), grants: count('human_action_intents'), authority: count('saim_authority_grants'), reservations: count('saim_authority_reservations') };
  results.before = before;
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.SHELL_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });
function count(table) { try { return db.get(`SELECT COUNT(*) n FROM ${table}`).n; } catch { return 0; } }

const DRIVER = String.raw`
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const cfg = JSON.parse(fs.readFileSync(process.env.J, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); app.exit(2); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = [];
  for (const j of cfg.jobs) {
    const win = new BrowserWindow({ width: j.w, height: j.h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
    win.setContentSize(j.w, j.h);
    const logs = []; win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) logs.push(msg); });
    const r = { shell: j.shell, steps: [], logs };
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => { const img = await win.webContents.capturePage(); const f = path.join(cfg.shots, j.shell + '-' + name + '.png'); fs.writeFileSync(f, img.toPNG()); r.steps.push({ shot: f }); };
    const waitFor = async (code, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await js(code); if (v) return v; } catch {} await sleep(150); } return null; };
    const body = () => js('document.body.innerText');
    const btn = (label) => '[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ' + JSON.stringify(label) + ' && !b.disabled)';
    const scrollTo = (sel) => js('(() => { const el = ' + sel + '; if (el) el.scrollIntoView({ block: "center" }); return !!el; })()');
    try {
      await win.loadURL(j.url);
      // Details wrappers (folded promise) are opened so the card is reachable as Nick would open it.
      r.offer = await waitFor('(() => { document.querySelectorAll("details").forEach((d) => { if (d.querySelector(".kmw__thread")) d.open = true; }); return !!(' + btn('Prepare a private working draft') + '); })()', 25000);
      await scrollTo(btn('Prepare a private working draft')); await shot('1-offer');
      r.offerText = await body();
      await js('(' + btn('Prepare a private working draft') + ').click()');
      r.q1 = await waitFor('(() => { const l = [...document.querySelectorAll("label")].find((x) => x.textContent.includes("What does ‘achievable’ mean here")); const f = l && document.getElementById(l.htmlFor); return l && f && f.tagName === "TEXTAREA" ? l.textContent : null; })()');
      r.afterPrepare = await body();
      r.tell1 = !!(await js('!!([...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Tell SAiM"))'));
      r.park1 = !!(await js('!!(' + btn('Park this for now') + ')'));
      await scrollTo('[...document.querySelectorAll("label")].find((x) => x.textContent.includes("What does ‘achievable’"))'); await shot('2-question-1');
      // Type the answer as a person would (React-controlled field), then Tell SAiM.
      await js('(() => { const l = [...document.querySelectorAll("label")].find((x) => x.textContent.includes("What does ‘achievable’")); const f = document.getElementById(l.htmlFor); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(f, ' + JSON.stringify(cfg.answer) + '); f.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
      await waitFor('!!(' + btn('Tell SAiM') + ')');
      await js('(' + btn('Tell SAiM') + ').click()');
      r.q2 = await waitFor('(() => { const l = [...document.querySelectorAll("label")].find((x) => x.textContent.includes("What is the incentive, and what earns it?")); return l ? l.textContent : null; })()');
      r.afterAnswer = await body();
      await scrollTo('[...document.querySelectorAll("label")].find((x) => x.textContent.includes("What is the incentive"))'); await shot('3-question-2');
      await waitFor('!!(' + btn('Park this for now') + ')');
      await js('(' + btn('Park this for now') + ').click()');
      r.q3 = await waitFor('(() => { const l = [...document.querySelectorAll("label")].find((x) => x.textContent.includes("Who does it apply to")); return l ? l.textContent : null; })()');
      r.afterPark = await body();
      r.width = await js('(() => { const vw = document.documentElement.clientWidth; const over = [...document.querySelectorAll("body *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 6).map((e) => (e.className && String(e.className)) || e.tagName); const kmw = [...document.querySelectorAll(".kmw__thread, .kmw__thread *")].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).map((e) => (e.className && String(e.className)) || e.tagName).slice(0, 6); return { vw, sw: document.documentElement.scrollWidth, over, kmw }; })()');
      await scrollTo('[...document.querySelectorAll("label")].find((x) => x.textContent.includes("Who does it apply to"))'); await shot('4-question-3');
    } catch (e) { r.error = String(e && e.stack || e); }
    out.push(r);
    win.destroy();
  }
  fs.writeFileSync(process.env.O, JSON.stringify(out));
  app.quit();
});
`;

const NO_OP = 'Nothing more to prepare for that right now';
for (const shell of ['desktop', 'phone']) {
  test(`${shell}: Prepare a private working draft → Decision 1 of 4, the exact question, its field, Tell SAiM and Park — in the real shell`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[shell];
    assert.ok(!r.error, `${r.error}
console: ${(r.logs || []).join(' | ').slice(0, 1500)}
state: ${JSON.stringify({ offer: r.offer, q1: r.q1, tell1: r.tell1, park1: r.park1, after: String(r.afterPrepare || r.offerText || '').slice(0, 1800) })}`);
    assert.ok(r.offer, `the offer renders (${shell}); console: ${(r.logs || []).slice(0, 3).join(' | ')}`);
    assert.match(r.offerText, /SAiM will prepare a private draft for you\. It will not make an employment decision, contact anyone, or send anything\./);
    assert.equal(r.q1, 'What does ‘achievable’ mean here, and how will you measure it?', 'the exact first question, with a field');
    assert.match(r.afterPrepare, /Decision 1 of 4/);
    assert.ok(r.tell1, 'Tell SAiM'); assert.ok(r.park1, 'Park this for now');
    assert.match(r.afterPrepare, /Private draft for Nick — no decision made, nothing sent\./);
    assert.match(r.afterPrepare, /Not saved yet\. When you choose to save it, this draft will go in Working drafts\./);
    assert.doesNotMatch(r.afterPrepare, /Meetings\//, 'no meeting path is shown');
    for (const step of [r.afterPrepare, r.afterAnswer, r.afterPark]) assert.ok(!String(step).includes(NO_OP), `the no-op sentence never appears (${shell})`);
  });
  test(`${shell}: answering shows the next question and keeps the answer as Nick's words; parking moves on — in the real shell`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[shell];
    assert.equal(r.q2, 'What is the incentive, and what earns it?');
    assert.match(r.afterAnswer, /Decision 2 of 4/);
    assert.match(r.afterAnswer, /You said/);
    assert.ok(r.afterAnswer.includes(ANSWER), 'his words, verbatim');
    assert.equal(r.q3, 'Who does it apply to, and how will the people it affects be heard before it is agreed?');
    assert.match(r.afterPark, /Decision 3 of 4/);
    assert.match(r.afterPark, /Parked — still unresolved: What the incentive is, and what earns it/);
    assert.ok(r.steps.filter((s) => s.shot).length >= 4, "screenshots of each step");
    assert.deepEqual(r.width.kmw, [], `the promise card and its interview stay inside the width (${shell}; ${JSON.stringify(r.width)})`);
  });
}

test('both shells: prepare / answer / park created no note, block, allowance, confirmation, email or other outbound state', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.deepEqual(results.after, results.before);
  for (const shell of ['desktop', 'phone']) {
    const rows = db.all('SELECT question_id q, text, by FROM prepared_move_answers WHERE move_key = ? ORDER BY id', [planner.moveKeyFor('project-note', `task:${TASKS[shell]}`)]);
    assert.deepEqual(rows.map((x) => [x.q, x.by]), [['achievable', 'nick'], ['park', 'nick']], `${shell}: one answer and one park, by Nick, against this promise’s move only`);
    assert.equal(rows[0].text, ANSWER);
  }
});
