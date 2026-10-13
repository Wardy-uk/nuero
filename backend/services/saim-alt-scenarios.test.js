/**
 * SAiM Alt — development scenarios (saim/app/alt/scenarios.mjs).
 *
 * Pins:
 *   1. Scenarios are SAiM-Alt-only: the control never sees them, and only an
 *      exact `?scenario=<id>` activates one (as a separate chunk).
 *   2. Activating one performs NO writes or side effects.
 *   3. Each of the seven renders ONE coherent state through the real renderer.
 *   4. Contradictions (calm + EOD outstanding) cannot render together.
 *   5. An app already in front never gets a redundant Open.
 *   6. Conflict never claims Nick is away while the desk is in use.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app');
const ALT = path.join(APP, 'alt');
const SHARED_UI = path.resolve(APP, '..', 'shared-ui');
const url = (f) => `file://${f.replace(/\\/g, '/')}`;

let M; let S; let FD; let View;

function stubPlugin() {
  return {
    name: 'stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      build.onResolve({ filter: /mobile\/outbox$/ }, () => ({ path: 'outbox', namespace: 'stub' }));
      build.onLoad({ filter: /^outbox$/, namespace: 'stub' }, () => ({
        contents: 'export const enqueue=()=>{throw new Error("x")};export const flush=async()=>({receipts:{}});export const outcomeFor=()=>({state:"queued"});',
        loader: 'js',
      }));
    },
  };
}

test.before(async () => {
  M = await import(url(path.join(ALT, 'model.mjs')));
  S = await import(url(path.join(ALT, 'scenarios.mjs')));
  FD = await import(url(path.join(SHARED_UI, 'fieldDrive.mjs')));
  const out = await esbuild.build({
    entryPoints: [path.join(ALT, 'SaimHome.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], plugins: [stubPlugin()], logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.SaimHomeView;
});

const NOW = Date.parse('2026-10-14T10:21:00.000Z');
const strip = (h) => h.replace(/<!-- -->/g, '');
const text = (h) => strip(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
function show(id, extra = {}) {
  const s = S.getScenario(id);
  const html = strip(renderToString(React.createElement(View, {
    data: s.data, session: s.session, localActiveAt: s.localActive ? NOW - 5000 : null, now: NOW,
    neuroUrl: 'https://pi5.example', onDeskOpen: () => {}, onAct: () => {}, onToggleHeld: () => {},
    onToggleHelp: () => {}, onToggleMore: () => {}, onBringWork: () => {},
    dock: React.createElement('i', { id: 'dock' }), ...extra,
  })));
  return { s, html, tx: text(html) };
}
const fieldOf = (s) => FD.surfaceRgb(M.driveFrom(s.data, FD.isPressing));
const BLUE = '114,150,211';
const ORANGE = '240,134,60';

// ── 1. Alt-only ─────────────────────────────────────────────────────────────

test('only an exact known ?scenario= activates; anything else is live', () => {
  assert.equal(M.scenarioFromUrl('?scenario=working'), 'working');
  for (const q of ['', '?', '?scenario=', '?scenario=Working', '?scenario=nope', '?scenario=constructor', '?other=working', null]) {
    assert.equal(M.scenarioFromUrl(q), null, String(q));
  }
  assert.deepEqual([...S.SCENARIO_LIST].sort(), [...M.SCENARIO_IDS].sort());
});

test('the control never sees scenarios; Alt loads them only as a dynamic chunk', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const control = [...walk(path.join(APP, 'src')), ...walk(SHARED_UI)].filter((f) => /\.(m?jsx?|cjs)$/.test(f));
  assert.ok(control.length > 20, 'positive control: scanned the control sources');
  for (const f of control) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /scenarios\.mjs|scenarioFromUrl|Customer Care training plan/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt|scenario/i);
  // Inside Alt: one importer, dynamically.
  const importers = fs.readdirSync(ALT).filter((f) => /\.(jsx|mjs)$/.test(f) && f !== 'scenarios.mjs')
    .filter((f) => /import[^;\n]*scenarios\.mjs/.test(fs.readFileSync(path.join(ALT, f), 'utf8')));
  assert.deepEqual(importers, ['AltApp.jsx']);
  const app = fs.readFileSync(path.join(ALT, 'AltApp.jsx'), 'utf8');
  assert.match(app, /import\('\.\/scenarios\.mjs'\)/);
  assert.doesNotMatch(app, /^import[^\n]*scenarios\.mjs/m, 'never a static import');
});

// ── 2. No writes ────────────────────────────────────────────────────────────

test('fixtures are pure data', () => {
  const src = fs.readFileSync(path.join(ALT, 'scenarios.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.includes('Customer Care training plan'), 'positive control: code survived the comment strip');
  assert.doesNotMatch(src, /fetch\(|apiFetch|localStorage|sessionStorage|indexedDB|\bimport\b/);
  const a = S.getScenario('working'); const b = S.getScenario('working');
  a.data.work.task = 'changed';
  assert.notEqual(b.data.work.task, 'changed', 'each call is a fresh copy');
});

test('in scenario mode every write path returns before touching the network', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  for (const fn of ['async function deskOpen(app) {', 'async function onSay(u) {', 'async function bringWork() {', 'async function capture() {', 'async function ask() {']) {
    const i = src.indexOf(fn);
    assert.ok(i > 0, `${fn} found`);
    const firstLine = src.slice(i + fn.length).trimStart().split('\n')[0];
    assert.match(firstLine, /^if \(scenario\) \{ set(ActNote|Note)\(/, `${fn} is guarded first`);
  }
  const load = src.slice(src.indexOf('const load = useCallback'));
  assert.ok(load.indexOf('if (scenario)') < load.indexOf('apiFetch('), 'the read short-circuits before any fetch');
  assert.match(src, /if \(scenario\) return \(\) => \{ alive\.current = false; \};\s+\/\/ a fixture is never polled/);
});

// ── 3. Each scenario is one coherent state ──────────────────────────────────

test('every fixture passes the coherence check, with page activity as declared', () => {
  for (const id of S.SCENARIO_LIST) {
    const s = S.getScenario(id);
    const problems = M.checkCoherence(s.data, s.session, { localActiveAt: s.localActive ? NOW - 5000 : null, now: NOW });
    assert.deepEqual(problems, [], `${id}: ${problems.join('; ')}`);
  }
});

test('working: the thread, the named step, one recommendation, two alternatives, held + meeting, blue', () => {
  const { s, html, tx } = show('working');
  assert.match(tx, /Customer Care training plan and refreshers Next Draft the refresher headings Best next place Claude Open Claude/);
  assert.match(tx, /Other ways in Music Word/);
  assert.equal((html.match(/alt-tool__primary/g) || []).length, 1);
  assert.match(tx, /2 items are held: in a focus session — held until you surface\./);
  assert.match(tx, /Next “Support leads catch-up” at 14:30\./);
  assert.match(tx, /Nick · Office desk active · Outlook open/);
  assert.doesNotMatch(tx, /Signals disagree|EOD|Nothing needs you/);
  assert.equal(fieldOf(s), BLUE, 'active, non-urgent work is calm blue');
});

test('stuck: the task and the honest block, reducing actions, no invented step, no chooser', () => {
  const { s, html, tx } = show('stuck');
  assert.match(tx, /Rewrite the escalation runbook Blocked: the new SLA tiers aren’t agreed yet/);
  for (const a of ['Make it smaller', 'Waiting on someone', 'Not now']) assert.ok(tx.includes(a), a);
  assert.doesNotMatch(tx, /Next [A-Z]|Best next place/);
  assert.doesNotMatch(html, /alt-ways|alt-tool__/);
  assert.match(tx, /Help me move this forward/);
  assert.equal(fieldOf(s), BLUE);
});

test('transition: the meeting leads, prep is a handoff, work is held below, no dashboard', () => {
  const { s, html, tx } = show('transition');
  assert.match(tx, /Coming up “Support leads catch-up” starts in 10 minutes\. Leave now, or open the prep\?/);
  assert.match(html, /href="https:\/\/pi5\.example\/\?view=meeting-prep"/);
  assert.match(tx, /Holding Customer Care training plan and refreshers/);
  assert.doesNotMatch(html, /alt-tool__|alt-ways|Best next place/, 'no tools compete with the transition');
  assert.doesNotMatch(html, /aria-label="Next transition"/, 'not repeated in the rail');
  assert.equal(fieldOf(s), ORANGE, 'an approaching demand');
});

test('judgement: one specific item, a NEURO handoff, nothing approvable here', () => {
  const { s, html, tx } = show('judgement');
  assert.match(tx, /Needs your judgement Your reply to Chris Middleton about the SLA review is drafted and waiting for your approval\. Review in NEURO →/);
  assert.match(html, /href="https:\/\/pi5\.example\/\?view=actions"/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Approve|Send|Execute)\b/i);
  assert.equal((tx.match(/Needs your judgement/g) || []).length, 1, 'not repeated in the rail');
  assert.equal(fieldOf(s), ORANGE);
});

test('calm: compact, field-forward, Ask/Capture there — no chooser, no empty panels', () => {
  const { s, html, tx } = show('calm');
  assert.match(html, /alt-thread__title alt-thread__title--small[^>]*>Nothing needs you right now\./);
  assert.match(html, /id="dock"/);
  assert.doesNotMatch(html, /alt-ways|alt-tool__|alt-rail|Help me move this forward/);
  assert.doesNotMatch(tx, /Nothing waiting for your judgement|Nothing held back|I can’t tell/);
  assert.equal(fieldOf(s), BLUE);
});

test('home: home presence, work held not listed, no EOD, no work tools, calm', () => {
  const { s, html, tx } = show('home');
  assert.match(tx, /Nick · Home/);
  assert.match(tx, /Evening at home/);
  assert.match(tx, /3 items are held: off duty — held until tomorrow\. Show held work/);
  assert.doesNotMatch(html, /alt-held__list/, 'held, not presented as a list');
  assert.doesNotMatch(html, /alt-tool__|alt-ways|Help me move this forward|Best next place/);
  assert.doesNotMatch(tx, /EOD|I don’t know the next step/);
  assert.equal(fieldOf(s), BLUE);
});

test('conflict: desk active, the watch heard elsewhere, one compact qualifier, never "away"', () => {
  const { tx } = show('conflict');
  assert.match(tx, /desk active/);
  assert.equal((tx.match(/Signals disagree — desk active; watch last heard in the living room\./g) || []).length, 1);
  assert.doesNotMatch(tx, /away from the laptop/i);
  assert.doesNotMatch(tx, /You’re in the living room/);
});

// ── 4. Contradictions cannot render together ────────────────────────────────

test('calm + EOD outstanding: EOD leads, "Nothing needs you" never appears', () => {
  const s = S.getScenario('calm');
  const d = { ...s.data, primary: { kind: 'item', type: 'ritual', recordId: 9, title: 'EOD outstanding', say: 'EOD outstanding', reason: 'You haven’t closed the day.' } };
  assert.deepEqual(M.checkCoherence(d, null), ['calm while an item needs him'], 'the checker names it');
  const html = strip(renderToString(React.createElement(View, { data: d, localActiveAt: NOW - 5000, now: NOW })));
  assert.match(text(html), /EOD outstanding/);
  assert.doesNotMatch(text(html), /Nothing needs you right now/);
  assert.equal(M.leadOf(d, M.currentThread(d)), 'thread');
});

test('calm with a waiting approval or a transition is never "calm"', () => {
  const s = S.getScenario('calm');
  const j = { ...s.data, approvals: { known: true, needsApproval: 1, say: 'One draft waits.' } };
  assert.equal(M.leadOf(j, M.currentThread(j)), 'judgement');
  assert.ok(M.checkCoherence(j).includes('calm while something waits on his judgement'));
  const t = { ...s.data, transition: { prompt: '“X” starts in 5 minutes.' } };
  assert.equal(M.leadOf(t, M.currentThread(t)), 'transition');
});

// ── 5. Already-open apps ────────────────────────────────────────────────────

test('working with Claude already in front: said, no redundant Open', () => {
  const s = S.getScenario('working');
  s.data.work.app = 'claude';
  const html = strip(renderToString(React.createElement(View, {
    data: s.data, session: s.session, localActiveAt: NOW - 5000, now: NOW, onDeskOpen: () => {}, onToggleHelp: () => {},
  })));
  assert.match(text(html), /You’re already in Claude\. Carry on there\./);
  assert.doesNotMatch(html, /alt-tool__primary|>Open Claude</);
  assert.ok(!M.checkCoherence(s.data, s.session).includes('recommends opening the app already in front'));
});

// ── 6. Activation needs nothing from NEURO ──────────────────────────────────

test('scenario rendering needs no network: the view is pure over the fixture', () => {
  for (const id of S.SCENARIO_LIST) {
    const { html } = show(id);
    assert.match(html, /class="alt-thread/, `${id} renders the work surface`);
  }
});
