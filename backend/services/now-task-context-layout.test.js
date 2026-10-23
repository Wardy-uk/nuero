'use strict';

/**
 * Holding the week's four cards and task context, in a REAL BROWSER
 * (Electron's Chromium) at desktop and phone sizes (22 Oct 2026).
 *
 * The REAL AdhdPanel (Now) and the REAL expanded TodoItem (the task card) are
 * rendered over a stub NEURO that answers GETs from fixtures and RECORDS every
 * request; it writes nothing, so a press only shows which route it reaches.
 *
 * Asserted:
 *   - four distinct cards (Keeping my word · Monday report · Next · Needs your
 *     judgement), none overlapping, none past the viewport; side column on
 *     desktop, stacked full width on phone; readable text;
 *   - honest states when there is no data (unmeasured explains itself, a settled
 *     report shows its receipt, "nothing waiting");
 *   - the cards' buttons reach their routes (the Monday report, all commitments);
 *     each card's own record is covered by holding-week-cards.test.js;
 *   - Now shows context for the ONE task in focus, once, and none when no task
 *     is in focus; a restricted note shows no preview;
 *   - the task card shows the editable Context section with its suggestion;
 *   - loading writes nothing.
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
const k = require('./keep-my-word');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_CHECKOUT = require('./electron-driver-support').mainCheckout(ROOT); // read deps by path — never junction them in
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'now-task-context-'));
const SHOTS = process.env.TC_SHOTS || path.join(tmp, 'shots');
const NOW = Date.parse('2026-10-21T09:00:00Z');
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TASK = 31;
const KEY = `promise:${TASK}`;
const TITLE = 'Build the onboarding checklist for the new starter';
const item = () => ({
  key: KEY, taskIds: [TASK], leadTaskId: TASK, title: TITLE, owedTo: 'Kit Varga',
  due: { date: '2026-10-22', basis: 'set', endsAt: '2026-10-22T23:00:00.000Z', tier: 'soon', say: 'due within two days' },
  booked: [], preparation: { state: 'needs-a-block', why: 'Nothing is booked for it before it is due.' },
  because: [], evidence: [{ kind: 'due', fact: 'Due Thursday 22 October — the date set on the task.' }],
});
const bench = { state: 'ok', items: [item()], withheld: { sensitive: 0, ambiguous: 0, unreadable: 0, undated: 0 } };
const FULL_SCORE = {
  ratio: { kept: 3, of: 4 }, counts: { due: 4, keptOnTime: 3, late: 0, unverified: 2, pending: 0, dropped: 0, reDated: 2, undated: 0 },
  previous: { ratio: { kept: 2, of: 4 } },
  entries: [
    { key: 'promise:51', taskIds: [51], outcome: 'unverified', sensitive: false, text: 'Send Kit the onboarding pack' },
    { key: 'promise:52', taskIds: [52], outcome: 'unverified', sensitive: true, text: null },
  ],
  mondayReport: { state: 'late', dueLabel: 'Monday 19 October 2026, 12:00 (London)' },
};
const HONEST_SCORE = {
  ratio: null, why: 'Nothing records a delivery yet, so nothing is counted as kept.', counts: { due: 0, keptOnTime: 0, late: 0, unverified: 0, pending: 0, dropped: 0, reDated: 0, undated: 0 },
  previous: null, entries: [],
  mondayReport: { state: 'sent-verified-on-time', dueLabel: 'Monday 19 October 2026, 12:00 (London)', evidence: [{ kind: 'verified-send', actionId: 'a1', provenBy: '2026-10-19T10:42:00Z' }] },
};
const fixture = (id) => JSON.parse(JSON.stringify(FIXTURES.find((f) => f.id === id)));
function nowPayload(score, { workbench = bench } = {}) {
  const f = fixture('many-next');
  const p = composePresentation(f.payload, { now: f.at });
  p.keepMyWord = k.compose({ score, workbench, authority: { canAct: true, boundary: null }, delivery: null, moves: null, presentation: p, now: NOW });
  return { ...f.payload, presentation: p };
}
const SESSION = { id: 's1', taskId: TASK, text: TITLE, status: 'active', startedTime: '08:40', elapsedMinutes: 20, plannedMinutes: 45, plannedAssumed: false, overrun: false, nextStep: null, shrinks: 0 };
const ADHD = (session = null) => ({
  generatedAt: new Date(NOW).toISOString(), dateKey: '2026-10-21', shape: { mode: 'morning', line: 'Morning — your best focus window.' },
  rightNow: null, session, recovery: null, signals: null, blockNow: null,
  momentum: { doneToday: 0, doneThisWeek: 0, total: 0, typical: 0, rituals: { standup: false, eod: false }, last7: [] },
  winsToday: [], avoidance: { signals: [] }, quickWins: [], openTasks: 0, gaps: [],
});
const ctxItem = (id, over) => ({
  id, taskId: TASK, type: 'note', ref: `Projects/Onboarding/Note ${id}.md`, title: `Note ${id}`, preview: `Preview of note ${id}.`, restricted: false,
  origin: 'nightly-scan', originLabel: 'Found automatically', automatic: true, state: 'pinned', reasons: [], reason: 'Its title matches the task (onboarding, checklist).',
  scopeItems: null, open: { kind: 'note', path: `Projects/Onboarding/Note ${id}.md` }, ...over,
});
const CONTEXT = {
  ok: true, contract: 'task-context-v1', taskId: TASK, task: { id: TASK, text: TITLE, status: 'open' },
  pinned: [
    ctxItem(1, { title: 'Onboarding Checklist Draft', reason: 'Its title matches the task (onboarding, checklist).' }),
    ctxItem(2, { title: '2026-10-14 – 1-2-1 Kit Varga', restricted: true, preview: null, reason: 'This task was raised in this note.' }),
    ctxItem(3, { type: 'project', ref: 'Projects/Onboarding', title: 'Onboarding', origin: 'manual', originLabel: 'Linked by you', automatic: false, reason: 'Linked by you.', open: { kind: 'folder', path: 'Projects/Onboarding' }, scopeItems: [{ ref: 'Projects/Onboarding/Plan.md', title: 'Plan', reason: 'Mentions starter, checklist.' }] }),
  ],
  suggestions: [ctxItem(9, { state: 'suggested', title: 'New Starter IT Kit', reason: 'Its title matches the task (starter).' })],
  stale: [], question: null, lastScan: { ok: true, finishedAt: '2026-10-21T02:40:00Z' },
};

const STATES = {
  'cards-full': { page: 'now', now: nowPayload(FULL_SCORE), adhd: ADHD(SESSION) },
  'cards-honest': { page: 'now', now: nowPayload(HONEST_SCORE, { workbench: { state: 'ok', items: [], withheld: { sensitive: 0, ambiguous: 0, unreadable: 0, undated: 0 } } }), adhd: ADHD(null) },
  'task-card': { page: 'card', now: null, adhd: null },
};

const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const one = (s) => { const e = document.querySelector(s); return e ? box(e) : null; };
  const cards = [...document.querySelectorAll('.kmw__card')].map((e) => ({ ...box(e), title: (e.querySelector('.kmw__card-title') || {}).textContent, text: e.textContent }));
  const over = [...document.querySelectorAll('.sit *, .adhd *, .tctx *, .todo-item *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => String(e.className || e.tagName));
  const fonts = [...document.querySelectorAll('.kmw__card p, .kmw__card button, .tctx p, .tctx button')].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize));
  return {
    vw, sw: document.documentElement.scrollWidth, readout: one('.kmw__week'), main: one('.sit__body > .kmw__main') || one('.sit__body > .sit__primary') || one('.sit__body > .sit__situation'),
    cards, over, minFont: fonts.length ? Math.min(...fonts) : 0,
    contexts: document.querySelectorAll('.tctx').length,
    contextText: [...document.querySelectorAll('.tctx')].map((e) => e.textContent).join(' | '),
  };
})()`;

// ── Page + stub NEURO ────────────────────────────────────────────────────────

let current = 'cards-full';
const requests = [];
let server; let base; let skipWhy = null; const results = {};

test.before(async () => {
  const bin = electronBinary();
  const nm = reactDir();
  if (!bin || !nm) { skipWhy = !bin ? 'no Electron binary here (set ELECTRON_PATH) — the page was NOT measured' : 'no react installed'; return; }
  const www = path.join(tmp, 'www'); fs.mkdirSync(www, { recursive: true });
  const slash = (p) => p.replace(/\\/g, '/');
  const entry = path.join(tmp, 'entry.jsx');
  fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/index.css')))};
import ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/App.css')))};
import AdhdPanel from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/AdhdPanel.jsx')))};
import { TodoItem } from ${JSON.stringify(slash(path.join(ROOT, 'frontend/src/components/TodoPanel.jsx')))};
const TODO = { id: 1, task_id: ${TASK}, text: ${JSON.stringify(TITLE)}, priority: 'normal', moscow: 'should', source: 'NEURO', done: 0, due_date: '2026-10-22' };
function Shell() {
  const narrow = window.innerWidth < 768;
  const onNavigate = (view, context = null) => { window.__navs = (window.__navs || []).concat([{ view, context }]); };
  const card = location.hash === '#card';
  const body = card
    ? React.createElement('div', { className: 'todo-panel' }, React.createElement(TodoItem, { todo: TODO, toggling: {}, onToggle: () => {}, expanded: 'task:${TASK}', onExpand: () => {}, onPatch: async () => {}, onRefresh: () => {} }))
    : React.createElement(AdhdPanel, { onNavigate });
  return React.createElement('div', { className: 'app' + (narrow ? '' : ' app--with-sidebar') },
    narrow ? null : React.createElement('aside', { className: 'sidebar' }, 'sidebar'),
    React.createElement('main', { className: 'main-panel' }, React.createElement('div', { className: 'main-view' }, body)));
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
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script>localStorage.setItem("neuro_pin","x")</script><script type="module" src="/app.js"></script></body></html>');

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.startsWith('/api/')) {
        requests.push({ state: current, method: req.method, path: u, body });
        if (req.method !== 'GET') return send(503, { ok: false, error: 'stub: nothing is written in this test' });
        const st = STATES[current];
        if (u === '/api/canonical/now' && st.now) return send(200, st.now);
        if (u === '/api/adhd' && st.adhd) return send(200, st.adhd);
        if (u === '/api/prepared-moves/eligible') return send(200, { ok: true, items: [] });
        if (u === `/api/task-context/tasks/${TASK}`) return send(200, CONTEXT);
        return send(503, { ok: false });
      }
      const f = path.join(www, u === '/' ? 'index.html' : u.slice(1));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(fs.readFileSync(f));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;

  fs.mkdirSync(SHOTS, { recursive: true });
  const drv = path.join(tmp, 'driver'); fs.mkdirSync(drv);
  fs.writeFileSync(path.join(drv, 'package.json'), '{"name":"now-task-context-driver","main":"main.js","private":true}');
  fs.writeFileSync(path.join(drv, 'main.js'), DRIVER);
  const env = { ...process.env, NW_URL: base, NW_JOB: path.join(tmp, 'job.json'), NW_OUT: path.join(tmp, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [name, st] of Object.entries(STATES)) {
    current = name;
    fs.writeFileSync(env.NW_JOB, JSON.stringify({ name, hash: st.page === 'card' ? '#card' : '', wait: st.page === 'card' ? '.tctx:not(.tctx--loading)' : '.kmw__card', sizes: SIZES, shots: SHOTS, measure: MEASURE }));
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
    await loadWithRetry(win, process.env.NW_URL + job.hash);
    const js = (c) => win.webContents.executeJavaScript(c);
    const t0 = Date.now(); while (Date.now() - t0 < 20000 && !(await js('!!document.querySelector(' + JSON.stringify(job.wait) + ')'))) await sleep(150);
    await sleep(700);
    const m = await js(job.measure);
    const H = await js('document.documentElement.scrollHeight'); win.setContentSize(w, Math.min(H, 4000)); await sleep(400);
    fs.writeFileSync(path.join(job.shots, job.name + '-' + w + 'x' + h + '.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(w, h); await sleep(300);
    if (w === 1440 && !job.hash) {
      m.pressed = {};
      for (const sel of ['.kmw__card--monday .kmw__card-go', '.kmw__card--kept .kmw__card-link']) {
        m.pressed[sel] = await js('(() => { const b = document.querySelector(' + JSON.stringify(sel) + '); if (!b || b.tagName !== "BUTTON") return false; b.click(); return true; })()');
        await sleep(300);
      }
      m.navs = await js('window.__navs || []');
    }
    if (job.hash) {
      // The suggestion fold opens; Add context opens a search form.
      m.addForm = await js('(() => { const b = [...document.querySelectorAll(".tctx button")].find((x) => x.textContent.trim() === "Add context"); if (!b) return false; b.click(); return true; })()');
      await sleep(300);
      m.hasSearch = await js('!!document.querySelector(".tctx__add-form input")');
      m.stillExpanded = await js('!!document.querySelector(".todo-context")');
    }
    out.sizes.push({ size: w + 'x' + h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.NW_OUT, JSON.stringify(out));
  app.quit();
});`;

// ── Assertions ───────────────────────────────────────────────────────────────

const sizes = (name) => { const r = results[name]; assert.ok(r && !r.error, `${name}: ${r && r.error}`); return r.sizes; };
const overlaps = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

test('Holding the week: four distinct cards, no overlap, nothing past the edge, at desktop and phone', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of ['cards-full', 'cards-honest']) {
    for (const s of sizes(name)) {
      assert.deepEqual(s.cards.map((c) => c.title), ['Keeping my word', 'Monday report', 'Next', 'Needs your judgement'], `${name} ${s.size}`);
      for (let i = 0; i < 4; i += 1) for (let j = i + 1; j < 4; j += 1) assert.ok(!overlaps(s.cards[i], s.cards[j]), `${name} ${s.size}: cards ${i}/${j} overlap`);
      assert.equal(s.sw, s.vw, `${name} ${s.size}: no horizontal scroll`);
      assert.deepEqual(s.over, [], `${name} ${s.size}: nothing past the right edge`);
      assert.ok(s.minFont >= 10, `${name} ${s.size}: readable (${s.minFont}px)`);
      for (const c of s.cards) assert.ok(c.h >= 40 && c.w >= 150, `${name} ${s.size}: ${c.title} is a real card (${c.w}x${c.h})`);
      if (s.vw >= 1400) {
        assert.ok(s.main && s.main.x >= s.readout.x + s.readout.w - 4, `${name} ${s.size}: the readout is the left column`);
        for (const c of s.cards) assert.ok(c.x >= s.readout.x - 1 && c.x + c.w <= s.readout.x + s.readout.w + 1, `${name} ${s.size}: ${c.title} stays in the readout`);
      }
      if (s.vw < 500) {
        for (const c of s.cards) assert.ok(c.w >= s.vw * 0.75, `${name} ${s.size}: ${c.title} is full width on a phone (${c.w})`);
        for (let i = 1; i < 4; i += 1) assert.ok(s.cards[i].y >= s.cards[i - 1].y + s.cards[i - 1].h - 1, `${name} ${s.size}: stacked`);
      }
    }
  }
});

test('the cards carry real answers — and say so honestly when there is none', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const full = sizes('cards-full')[0].cards.map((c) => c.text);
  assert.match(full[0], /3 \/ 4/);
  assert.match(full[1], /Not written or sent, and the deadline has passed\./);
  assert.match(full[1], /Write and send it now/);
  assert.match(full[2], /No protected time is booked ahead/);
  assert.match(full[3], /Two promises/);
  assert.match(full[3], /Review them one at a time \(2\)/, 'the named promises open one at a time (holding-week-cards.test.js)');
  const honest = sizes('cards-honest')[0].cards.map((c) => c.text);
  assert.match(honest[0], /Not measured yet/);
  assert.match(honest[0], /Nothing records a delivery yet/);
  assert.match(honest[1], /Read back in Sent Items/);
  assert.match(honest[3], /Nothing is waiting on your judgement/);
});

test('the cards reach their routes: the Monday report, all commitments', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const s = sizes('cards-full')[0];
  assert.ok(Object.values(s.pressed).every(Boolean), JSON.stringify(s.pressed));
  assert.deepEqual(s.navs, [
    { view: 'weekly-risk', context: null },
    { view: 'commitments', context: null },
  ]);
});

test('Now shows context for the ONE task in focus, once; none when nothing is in focus', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('cards-full')) {
    assert.equal(s.contexts, 1, `${s.size}: exactly one context block`);
    assert.match(s.contextText, /Context for this task/);
    assert.match(s.contextText, /Onboarding Checklist Draft/);
    assert.match(s.contextText, /Restricted — preview withheld/);
    assert.doesNotMatch(s.contextText, /New Starter IT Kit/, 'a suggestion is not shown on Now');
  }
  for (const s of sizes('cards-honest')) assert.equal(s.contexts, 0, `${s.size}: no task in focus, no block`);
});

test('the task card shows the editable Context section; Add context opens a search without collapsing the card', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const s of sizes('task-card')) {
    assert.equal(s.contexts, 1, s.size);
    assert.match(s.contextText, /Found automatically/);
    assert.match(s.contextText, /Linked by you/);
    assert.match(s.contextText, /1 suggestion — not pinned/);
    assert.equal(s.addForm, true);
    assert.equal(s.hasSearch, true);
    assert.equal(s.stillExpanded, true, 'a press inside the block does not collapse the card');
    assert.equal(s.sw, s.vw, `${s.size}: no horizontal scroll`);
    assert.deepEqual(s.over, [], `${s.size}: nothing past the right edge`);
  }
});

test('loading and pressing wrote nothing', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.deepEqual(requests.filter((r) => r.method !== 'GET'), []);
  assert.ok(requests.some((r) => r.path === `/api/task-context/tasks/${TASK}`), 'positive control: context was read');
});
