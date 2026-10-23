'use strict';

/**
 * The private draft's governed SAVE, on a CLEAN PAGE LOAD, in a REAL BROWSER,
 * through BOTH real shells (26 Oct 2026). The live failure this pins: promise 322
 * had all four answers recorded (state `needs-decision`, destination
 * Projects/Working, a Thursday solo slot) and the screen showed only the preview
 * and "I’ve prepared this for your next working morning" — no save control —
 * because it was 20:29 and every prepared move is HELD off duty, in the view,
 * /request, /confirm and the executor alike; and on the phone the save was only
 * ever opened by the answer to the last press, so a refresh lost it.
 *
 * Here Nick is OFF DUTY throughout (the live condition). For each shell
 * (NEURO desktop AdhdPanel, SAiM phone Surface), with records created
 * SERVER-SIDE before the page ever loads:
 *   - a needs-decision draft, switch on, no allowance → the boundary, and
 *     "What SAiM may do" opening IN the card;
 *   - the same draft, allowance granted → "Save it and protect the time" →
 *     the real confirmation (note + solo calendar writes) — NOT confirmed;
 *   - a mid-interview draft → only "Save this unfinished draft instead";
 *   - the click-through: prepare → answer/park all four → RELOAD → the save
 *     control is there.
 * Never "next working morning" standing alone; never "SAiM home"; and the vault,
 * calendar, ledger and allowance are untouched throughout.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'real-shell-load-'));
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
const A1 = 'Two days WFH a week for anyone at or above 90% of their FRT target for the month';
const A3 = 'Everyone on the service desk; each team lead gathers views in their 1-2-1s before it is agreed';
const HELD = 'I’ve prepared this for your next working morning.';

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

// ── The real backend; each job points canonical Now at ONE promise copy ──
let server; let base; let skipWhy = null; const results = {};
const TASKS = {};
let current = null; // the promise copy canonical Now shows: { key, taskId }
const SHOTS = process.env.SHELL_SHOTS || path.join(tmp, 'shots');
const COPIES = ['d-main', 'd-mid', 'd-click', 'p-main', 'p-mid', 'p-click'];
const keyFor = (c) => `promise:${401 + COPIES.indexOf(c)}`;

function canonicalNow() {
  const { composePresentation } = require('./presentation-intent');
  const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');
  const f = FIXTURES.find((x) => x.id === 'empty');
  const p = composePresentation(f.payload, { now: f.at });
  const item = {
    key: current.key, taskIds: [current.taskId], leadTaskId: current.taskId, title: TEXT, owedTo: null,
    due: { date: '2026-10-16', basis: 'set', endsAt: '2026-10-16T23:00:00.000Z', tier: 'overdue', say: 'overdue' },
    booked: [], preparation: { state: 'waiting-for-Nick', missing: 'owed-to', why: 'Your notes don’t name who it is owed to.' },
    because: ['overdue (Friday 16 October)'], evidence: [{ kind: 'due', fact: 'Due Friday 16 October — the date set on the task.' }],
  };
  const moves = { [current.key]: require('./promise-moves').moveFor(item) };
  p.keepMyWord = require('./keep-my-word').compose({
    score: { ratio: { kept: 3, of: 4 }, counts: { reDated: 0, pending: 1 }, entries: [], mondayReport: null },
    workbench: { state: 'ok', items: [item], withheld: {} }, moves, presentation: p, now: Date.now(),
  });
  return { ...f.payload, presentation: p, poolAvailable: true };
}

async function api(pathname, body) {
  const res = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NEURO-PIN': 'pin-1234' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
/** Server-side only — no page involved: prepare, then answer/park `steps` in order. */
async function seed(copy, steps) {
  current = { key: keyFor(copy), taskId: TASKS[copy] };
  let r = await api('/api/prepared-moves/prepare', { ref: `promise:${keyFor(copy)}` }); // the card's ref: promise:<item key>
  assert.ok(r.body.ok, `prepare ${copy}: ${JSON.stringify(r.body)}`);
  for (const [, text] of steps) {
    const m = r.body.promiseMove;
    const questionId = m && m.question && m.question.id; // the question the server is asking now, in its order
    assert.ok(questionId, `${copy}: a question to answer (${JSON.stringify(m)})`);
    r = await api('/api/prepared-moves/answer', text === null ? { recordId: m.recordId, version: m.version, questionId, park: true } : { recordId: m.recordId, version: m.version, questionId, text });
    assert.ok(r.body.ok, `answer ${copy}/${questionId}: ${JSON.stringify(r.body)}`);
  }
  return r.body.promiseMove;
}
const ALL_FOUR = [['achievable', A1], ['incentive', null], ['applies', A3], ['agree', null]];
const counts = () => ({ vault: vaultTree(), ledger: count('external_write_ledger'), actions: count('prepared_actions'), reservations: count('saim_authority_reservations'), calendar: count('calendar_cache') });
function count(table) { try { return db.get(`SELECT COUNT(*) n FROM ${table}`).n; } catch { return 0; } }

test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — the real shells were NOT driven'; return; }
  await db.init();
  const ts = require('./task-store');
  for (const c of COPIES) {
    const r = ts.createTask({ text: TEXT, source: 'meeting-promotion', origin_path: SOURCE, distinct: true });
    TASKS[c] = (r && (r.id || (r.task && r.task.id))) || db.get('SELECT id FROM tasks WHERE text LIKE ? ORDER BY id DESC LIMIT 1', [`${TEXT}%`]).id;
  }
  assert.equal(new Set(Object.values(TASKS)).size, COPIES.length, 'six separate copies of the promise');
  Object.assign(planner.DEFAULT_DEPS, {
    promise: (key) => {
      const c = COPIES.find((x) => keyFor(x) === key);
      return c ? { key, text: TEXT, open: true, taskIds: [TASKS[c]], leadTaskId: TASKS[c], owedTo: { people: [], ambiguous: [], fromNote: null, resolved: null }, sensitivity: { sensitive: false }, source: { path: SOURCE, title: 'Weekly Meeting' } } : null;
    },
    promiseDelivered: () => false,
    diary: () => ({ known: true, events: [], fetchedAt: new Date(Date.now() - 60000).toISOString() }),
    holidays: () => new Set(), leaveState: () => 'working',
  });
  // ⚠ THE LIVE CONDITION: the evening — Nick is off duty, not on leave.
  require('./prepared-move').readDuty = async () => ({ onDuty: false, why: 'off-duty' });
  // His leave, read (no People HR feed offline), and a diary that has just synced.
  require('./team-availability').selfAbsenceOn = () => ({ known: true, off: false });
  require('./prepared-move-store').ensure();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(tmp, 'www')));
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/prepared-moves', require('../routes/prepared-moves'));
  app.use('/api/saim-authority', require('../routes/saim-authority'));
  app.use('/api/adhd', require('../routes/adhd'));
  app.get('/api/canonical/now', (req, res) => { try { res.json(canonicalNow()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.use('/api', (req, res) => res.status(503).json({ ok: false, error: 'not available in this test' }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await bundleShell('desktop', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport AdhdPanel from ${JSON.stringify(path.join(ROOT, 'frontend/src/components/AdhdPanel.jsx').replace(/\\/g, '/'))};\ncreateRoot(document.getElementById('root')).render(React.createElement(AdhdPanel, { onNavigate() {} }));\n`, path.join(ROOT, 'frontend'));
  await bundleShell('phone', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport Surface from ${JSON.stringify(path.join(ROOT, 'saim/app/src/views/Surface.jsx').replace(/\\/g, '/'))};\nimport ${JSON.stringify(path.join(ROOT, 'saim/app/src/App.css').replace(/\\/g, '/'))};\ncreateRoot(document.getElementById('root')).render(React.createElement(Surface, { onNavigate() {}, onShowAll() {} }));\n`, path.join(ROOT, 'saim/app'));

  // Server-side records, made BEFORE any page loads (no press, no response to rely on).
  process.env.SAIM_PREPARED_MOVE_EXECUTION = 'true';
  db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, show_as, source, fetched_at) VALUES ('sync-marker', 'Sync marker', '2020-01-01T09:00:00', '2020-01-01T09:30:00', 'busy', 'graph', CURRENT_TIMESTAMP)`);
  for (const s of ['d', 'p']) {
    results[`${s}-seed`] = await seed(`${s}-main`, ALL_FOUR);
    await seed(`${s}-mid`, [['achievable', A1]]);
  }
  await new Promise((r) => setTimeout(r, 3000)); // NEURO's debounced task export lands before the baseline
  results.before = counts();

  fs.mkdirSync(SHOTS, { recursive: true });
  const appDir = path.join(tmp, 'driver'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'shell-driver-load', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), DRIVER);
  const env = { ...process.env, J: path.join(tmp, 'job.json'), O: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (job) => new Promise((resolve) => {
    fs.writeFileSync(env.J, JSON.stringify({ job, a1: A1, a3: A3, shots: SHOTS }));
    const child = require('child_process').spawn(bin, [appDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 120000);
    child.on('exit', () => { clearTimeout(t); try { resolve(JSON.parse(fs.readFileSync(env.O, 'utf8'))); } catch { resolve({ error: `no result: ${err.slice(0, 600)}` }); } });
  });
  const SHELL = { d: { shell: 'desktop', url: `${base}/desktop.html`, w: 1440, h: 900 }, p: { shell: 'phone', url: `${base}/phone.html`, w: 390, h: 844 } };
  const on = (copy) => { current = { key: keyFor(copy), taskId: TASKS[copy] }; };
  // 1. No allowance: the real boundary, and its route in place.
  for (const s of ['d', 'p']) { on(`${s}-main`); results[`${s}-allow`] = await run({ ...SHELL[s], name: `${s}-allow`, mode: 'allow' }); }
  require('./authority-budget')._test.grantToday();
  results.afterGrant = counts();
  // 2. Allowance granted: save → the confirmation, never confirmed. 3. Mid-interview. 4. Click through, then RELOAD.
  for (const s of ['d', 'p']) {
    on(`${s}-main`); results[`${s}-save`] = await run({ ...SHELL[s], name: `${s}-save`, mode: 'save' });
    on(`${s}-mid`); results[`${s}-mid`] = await run({ ...SHELL[s], name: `${s}-mid`, mode: 'mid' });
    on(`${s}-click`); results[`${s}-click`] = await run({ ...SHELL[s], name: `${s}-click`, mode: 'click' });
  }
  delete process.env.SAIM_PREPARED_MOVE_EXECUTION;
  results.after = counts();
});
test.after(() => { try { server && server.close(); } catch { /* */ } if (!process.env.SHELL_SHOTS) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } } });

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
  const openCard = 'document.querySelectorAll("details").forEach((d) => { if (d.querySelector(".kmw__thread")) d.open = true; })';
  const btn = (label) => '[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ' + JSON.stringify(label) + ' && !b.disabled)';
  const press = async (sel) => { await mustWait(js, '!!(' + sel + ')', sel); await js('(' + sel + ').click()'); };
  const scrollTo = (sel) => js('(() => { const el = ' + sel + '; if (el) el.scrollIntoView({ block: "center" }); return !!el; })()');
  const saveBox = () => js('(() => { const b = document.querySelector(".kmw__save"); return b ? { text: b.innerText, buttons: [...b.querySelectorAll("button")].map((x) => ({ t: x.textContent.trim(), disabled: x.disabled })) } : null; })()');
  const page = () => js('({ text: document.body.innerText, buttons: [...document.querySelectorAll("button")].map((x) => x.textContent.trim()) })');
  const setField = (prefix, value) => js('(() => { const l = [...document.querySelectorAll("label")].find((x) => x.textContent.includes(' + JSON.stringify(prefix) + ')); const f = document.getElementById(l.htmlFor); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(f, ' + JSON.stringify(value) + '); f.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  const label = (prefix) => '[...document.querySelectorAll("label")].find((x) => x.textContent.includes(' + JSON.stringify(prefix) + '))';
  const answer = async (prefix, text) => { await waitFor('!!(' + label(prefix) + ')'); await setField(prefix, text); await waitFor('!!(' + btn('Tell SAiM') + ')'); await press(btn('Tell SAiM')); };
  const park = async (prefix) => { await waitFor('!!(' + label(prefix) + ')'); await waitFor('!!(' + btn('Park this for now') + ')'); await press(btn('Park this for now')); };
  try {
    await loadWithRetry(win, j.url); // a clean page load: nothing pressed in this session
    if (j.mode === 'allow') {
      r.box = await waitFor('(() => { ' + openCard + '; const b = document.querySelector(".kmw__save"); return b && /allowed me/.test(b.innerText) ? b.innerText : null; })()');
      r.page = await page();
      await scrollTo('document.querySelector(".kmw__save")'); await shot('1-boundary');
      r.route = !!(await js('!!(' + btn('Open what SAiM may do') + ')'));
      if (r.route) await press(btn('Open what SAiM may do'));
      r.authority = await waitFor('(() => { const a = document.querySelector(".promise-save__authority .auth"); return a ? a.innerText : null; })()');
      await scrollTo('document.querySelector(".promise-save__authority")'); await shot('2-what-saim-may-do');
    } else if (j.mode === 'save') {
      r.ready = await waitFor('(() => { ' + openCard + '; return !!(' + btn('Save it and protect the time') + '); })()');
      r.page = await page(); r.box = await saveBox();
      if (!r.ready) throw new Error('no save button on a clean load; card shows: ' + JSON.stringify(r.box));
      await scrollTo(btn('Save it and protect the time')); await shot('3-save-it');
      await press(btn('Save it and protect the time'));
      r.confirmReady = await waitFor('!!(' + btn('Confirm') + ')');
      r.confirmBox = await saveBox();
      await scrollTo(btn('Confirm')); await shot('4-confirmation');
    } else if (j.mode === 'mid') {
      r.ready = await waitFor('(() => { ' + openCard + '; return !!(' + btn('Save this unfinished draft instead') + '); })()');
      r.page = await page(); r.box = await saveBox();
      await scrollTo('document.querySelector(".kmw__save")'); await shot('5-unfinished');
    } else if (j.mode === 'click') {
      await waitFor('(() => { ' + openCard + '; return !!(' + btn('Prepare a private working draft') + '); })()');
      await press(btn('Prepare a private working draft'));
      await answer('What does ‘achievable’', cfg.a1);
      await park('What is the incentive');
      await answer('Who does it apply to', cfg.a3);
      await park('Who will you agree the plan with');
      r.beforeReload = await waitFor('(() => /Every decision is answered or parked/.test(document.body.innerText) ? document.body.innerText : null)()');
      await win.webContents.reloadIgnoringCache(); // refresh: the press's answer is gone
      r.ready = await waitFor('(() => { ' + openCard + '; return !!(' + btn('Save it and protect the time') + '); })()');
      r.page = await page(); r.box = await saveBox();
      await scrollTo('document.querySelector(".kmw__save")'); await shot('6-after-reload');
    }
  } catch (e) { r.error = String(e && e.stack || e); }
  fs.writeFileSync(process.env.O, JSON.stringify(r));
  win.destroy();
  app.quit();
});
`;

const HOME = /SAiM home/i;
const SWITCH = /switch to|open (it )?(in|on) (the )?(SAiM|NEURO|your phone|the desktop)|on your phone or desktop/i;
function noStrandedHold(r) {
  const text = r.page ? r.page.text : '';
  assert.doesNotMatch(text, HOME, `${r.name}: never "SAiM home"`);
  assert.doesNotMatch(text, SWITCH, `${r.name}: no instruction to switch app or hunt for another screen`);
  assert.ok(!text.includes(HELD), `${r.name}: "${HELD}" never stands in for an action that exists`);
}

test('server-side: the seeded draft is needs-decision with Working drafts, and Nick is off duty (the live condition)', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of ['d', 'p']) {
    assert.equal(results[`${s}-seed`].state, 'needs-decision');
    assert.match(results[`${s}-seed`].destinationSay, /Working drafts/);
  }
});
for (const [s, shell] of [['d', 'desktop'], ['p', 'phone']]) {
  test(`${shell}, clean load, off duty, no allowance → the boundary and "What SAiM may do" IN the card`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-allow`];
    assert.ok(!r.error, `${r.error} | ${(r.logs || []).slice(0, 3).join(' | ')}`);
    assert.match(String(r.box), /You haven’t allowed me to carry out prepared moves today/);
    assert.ok(r.route, 'the in-place route to the allowance');
    assert.ok(!r.page.buttons.includes('Save it and protect the time'), 'no save button the allowance would refuse');
    assert.match(String(r.authority), /What SAiM may do/);
    noStrandedHold(r);
  });
  test(`${shell}, clean load, off duty, allowance → "Save it and protect the time" → the real confirmation (note + solo block) — NOT confirmed`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-save`];
    assert.ok(!r.error, r.error);
    assert.match(r.page.text, /When you choose to save it, this draft will go in Working drafts/);
    assert.match(r.box.text, /Save your private draft as a new note — Working drafts: Projects\/Working\//);
    assert.equal(r.page.buttons.filter((b) => b === 'Save it and protect the time').length, 1, 'ONE save step for the record — never a second copy on Home');
    assert.ok(r.confirmReady, `the confirmation (${JSON.stringify(r.confirmBox)})`);
    assert.match(r.confirmBox.text, /Save your private draft as a new note — Working drafts: Projects\/Working\//);
    assert.match(r.confirmBox.text, /to your calendar, .* Just you — nobody is invited\./);
    assert.ok(r.confirmBox.buttons.some((b) => b.t === 'Confirm' && !b.disabled), 'Confirm is live, and was not pressed');
    noStrandedHold(r);
  });
  test(`${shell}, clean load, mid-interview → only "Save this unfinished draft instead", no time booking`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-mid`];
    assert.ok(!r.error, r.error);
    assert.ok(r.ready, `offered (${JSON.stringify(r.box)})`);
    assert.match(r.box.text, /no time will be booked/);
    assert.ok(!r.page.buttons.includes('Save it and protect the time'));
    noStrandedHold(r);
  });
  test(`${shell}: prepare → answer/park all four → RELOAD → the save control is there`, (t) => {
    if (skipWhy) return t.skip(skipWhy);
    const r = results[`${s}-click`];
    assert.ok(!r.error, r.error);
    assert.ok(r.beforeReload, 'all four decided by pressing');
    assert.ok(r.ready, `after a reload the save is offered again (${JSON.stringify(r.box)})`);
    noStrandedHold(r);
  });
}
test('throughout: vault, calendar, ledger and allowance untouched — only the test’s own allowance grant', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const k of ['vault', 'ledger', 'actions', 'reservations', 'calendar']) assert.deepEqual(results.after[k], results.before[k], k);
  assert.equal(db.get('SELECT COUNT(*) n FROM saim_authority_grants').n, 1, 'exactly the one grant this test made — nothing in the UI granted any');
  for (const f of fs.readdirSync(path.join(VAULT))) assert.notEqual(f, 'Working', 'no Projects/Working was created'); // eslint-disable-line
  assert.ok(!fs.existsSync(path.join(VAULT, 'Projects', 'Working')), 'no private draft note was written');
});
