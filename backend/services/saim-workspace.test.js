'use strict';

/**
 * Build Brief 003 — the SAiM workspace in NEURO Desktop (Option B, 23 Oct 2026).
 *
 * 1. The gate (frontend/src/saimWorkspace.js, PURE): unreadable/error = OFF;
 *    flag on + default launch = SAiM; an explicit ?view=today = Now.
 * 2. The server switch exists, defaults off, and is listed for Settings.
 * 3. Source boundaries: ONE shared scene (NowScene) renders Situation; Now and
 *    the workspace both use it; the workspace makes no write call; App and the
 *    Sidebar fall back to Now when the switch is off.
 * 4. A REAL render (esbuild + renderToString) of the workspace over fixture
 *    payloads composed by the REAL pipeline: the Why strip carries the lead,
 *    held, can't-see, freshness and blind/degraded wording, and never a false
 *    all-clear.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b003-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.SAIM_DESKTOP_WORKSPACE;

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'frontend', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\{\/\*)/.test(l)).join('\n');

let gate;
test.before(async () => {
  gate = await import(pathToFileURL(path.join(SRC, 'saimWorkspace.js')).href);
});

// ── 1. The gate ─────────────────────────────────────────────────────────────

test('1a. flagEnabled: only a readable `enabled: true` is on; everything else is off', () => {
  const on = { ok: true, flags: [{ key: 'saim_desktop_workspace', enabled: true }] };
  assert.equal(gate.flagEnabled(on), true);
  for (const bad of [null, undefined, 'x', {}, { ok: false, flags: on.flags }, { ok: true }, { ok: true, flags: [] },
    { ok: true, flags: [{ key: 'saim_desktop_workspace', enabled: 'true' }] },
    { ok: true, flags: [{ key: 'saim_desktop_workspace', enabled: false }] },
    { ok: true, flags: [{ key: 'other', enabled: true }] }]) {
    assert.equal(gate.flagEnabled(bad), false, JSON.stringify(bad));
  }
});

test('1b. launch: flag off → Now; flag on + default launch → SAiM; explicit ?view=today stays on Now', () => {
  assert.equal(gate.homeView(false), 'today');
  assert.equal(gate.homeView(undefined), 'today');
  assert.equal(gate.homeView(true), 'saim');
  assert.equal(gate.isDefaultLaunch(''), true);
  assert.equal(gate.isDefaultLaunch('?view=today'), false);
  assert.equal(gate.isDefaultLaunch('?item=task:1'), false);
  assert.equal(gate.shouldOpenSaim({ defaultLaunch: true, activeView: 'today', flagOn: true }), true);
  assert.equal(gate.shouldOpenSaim({ defaultLaunch: false, activeView: 'today', flagOn: true }), false, 'explicit ?view=today');
  assert.equal(gate.shouldOpenSaim({ defaultLaunch: true, activeView: 'today', flagOn: false }), false, 'flag off');
  assert.equal(gate.shouldOpenSaim({ defaultLaunch: true, activeView: 'todos', flagOn: true }), false, 'already moved on');
});

// ── 2. The server switch ────────────────────────────────────────────────────

test('2. the saim_desktop_workspace switch exists, defaults OFF and is listed for Settings', async () => {
  const db = require('../db/database');
  await db.init();
  const flags = require('./feature-flags');
  const f = flags.list().find((x) => x.key === 'saim_desktop_workspace');
  assert.ok(f, 'listed for Settings → Switches');
  assert.equal(f.default, false);
  assert.equal(f.enabled, false);
  assert.equal(flags.isEnabled('saim_desktop_workspace'), false);
  flags.setEnabled('saim_desktop_workspace', true);
  assert.equal(flags.isEnabled('saim_desktop_workspace'), true, 'Settings can turn it on');
  flags.setEnabled('saim_desktop_workspace', false);
  assert.equal(flags.isEnabled('saim_desktop_workspace'), false, 'rollback: Settings turns it off again');
});

// ── 3. Source boundaries ────────────────────────────────────────────────────

test('3a. ONE shared scene: only NowScene imports Situation; Now and the workspace both render NowScene', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const importers = walk(SRC).filter((f) => /\.jsx?$/.test(f) && /from ['"][^'"]*presentation\/Situation\.jsx['"]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(importers.map((f) => path.relative(SRC, f).replace(/\\/g, '/')), ['components/NowScene.jsx']);
  assert.match(code(read('components/AdhdPanel.jsx')), /<NowScene\b/);
  assert.match(code(read('components/SaimWorkspace.jsx')), /<NowScene\b/);
});

test('3b. the shared scene carries the existing governed callbacks, each to its existing route', () => {
  const scene = code(read('components/NowScene.jsx'));
  for (const p of ['onPrepareDelivery', 'onPromiseMove', 'renderPromiseSave', 'onCardOpen', 'renderPrimary', 'onCorrect', 'onNotNow']) {
    assert.ok(scene.includes(p), `NowScene passes ${p}`);
  }
  assert.match(scene, /\/api\/promises\/\$\{encodeURIComponent\(key\)\}\/prepare/, 'delivery note only PREPARES');
  assert.match(scene, /promiseMoveRequest\(op\)/, 'prepared-move requests are built by the shared builder');
  assert.match(scene, /<PromiseSave recordId=/, 'saving goes through PromiseSave → /prepared-moves/request + /confirm');
  assert.match(scene, /onAct=\{attention\.act\}/, 'card acts go through useAttention.act → /api/attention/records/:id/act');
});

test('3c. the workspace itself makes NO write call', () => {
  const ws = code(read('components/SaimWorkspace.jsx'));
  assert.doesNotMatch(ws, /method:\s*['"](POST|PATCH|PUT|DELETE)/i);
  assert.doesNotMatch(ws, /\/api\/(attention\/records|prepared-moves|prepared-actions|promises|session)\b/);
  const fetches = [...ws.matchAll(/apiFetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ['/api/adhd'], 'its only own request is the read of the running block');
  assert.match(ws, /useAttention\(/, 'reads the same canonical feed as Now');
});

test('3d. App: case saim falls back to Now when off; ?view=today stays Now; Sidebar shows SAiM only when on', () => {
  const app = code(read('App.jsx'));
  assert.match(app, /case 'saim': return saimOn \? <SaimWorkspace onNavigate=\{handleNavigate\} \/> : <AdhdPanel onNavigate=\{handleNavigate\} \/>;/);
  assert.match(app, /case 'today': return <AdhdPanel onNavigate=\{handleNavigate\} \/>;/, 'Now is unchanged');
  assert.match(app, /shouldOpenSaim\(\{ defaultLaunch: defaultLaunchRef\.current, activeView, flagOn: saimOn \}\)/);
  assert.match(app, /saimWorkspace=\{saimOn\}/);
  const sidebar = code(read('components/Sidebar.jsx'));
  assert.match(sidebar, /\[\.\.\.\(saimWorkspace \? \[SAIM_ITEM\] : \[\]\), \.\.\.PRIMARY_ITEMS\]/);
  assert.match(sidebar, /saimWorkspace = false/, 'off by default');
});

// ── 4. Real render over fixture payloads ────────────────────────────────────

const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const STUB_API = [
  'export const apiUrl = (p) => p;',
  'export const authHeaders = () => ({});',
  "export const apiFetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) });",
  'export const setPin = () => {}; export const getPin = () => null;',
  'export default { apiUrl, apiFetch, setPin, getPin };',
].join('\n');

let View;
let SaimWhy;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, 'components', 'SaimWorkspace.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'idb'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_API, loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.SaimWorkspaceView;
  SaimWhy = mod.exports.SaimWhy;
  global.window = global.window || { location: { search: '' }, addEventListener() {}, removeEventListener() {}, open() {} };
  global.localStorage = global.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
});

// Fixtures from the REAL pipeline (context-state → gate → presentation → candidates → SAiM policy).
const CS = require('./context-state');
const AT = require('./attention');
const PI = require('./presentation-intent');
const NC = require('./neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const NOW = Date.parse('2026-10-23T10:00:00Z'); // Fri 11:00 BST
const capacity = { type: 'capacity', id: 'capacity-over-2026-10-23', dedupeKey: 'capacity:over:2026-10-23', title: 'More work due by the end of today than you have time for', reason: '4h short.', score: 80, urgency: 'high', tier: 1, source: 'neuro' };
const email = { type: 'email', id: 'email-1', title: 'Reply to Chris', reason: 'Waiting 2 days', score: 60, urgency: 'medium', tier: 2 };
const steady = () => CS.resolveContext({
  calendar: { known: true, events: [] }, focusSession: { known: true, session: null }, queue: { known: true, breaching: 0, escalations: 0 },
  location: { known: true, place: 'home' }, presence: { known: true, state: 'present' }, rituals: { known: true, standupDone: true, eodDone: false },
  workingDay: { known: true, isWorkingDay: true, reason: null },
}, new Date(NOW));
const workLife = { doing: 'working', label: 'Working', showWork: true, confidence: 'likely', place: { kind: 'home', label: 'study' } };
const offLife = { doing: 'relaxing', label: 'Relaxing', showWork: false, confidence: 'likely', place: { kind: 'home', label: 'living room' } };

function fixture(context, life, pool, over = {}) {
  const g = AT.gate(AT.gateContextFor(context, life), pool, new Date(NOW));
  const p = { context, life, poolAvailable: true, gaps: [], approvals: { known: true, needsApproval: 0, needsReview: 0 },
    primary: g.primary, secondary: g.secondary, dropped: g.dropped, quiet: g.quiet,
    generatedAt: new Date(NOW - 10000).toISOString(), situation: null, ...over };
  p.presentation = PI.composePresentation(p, { now: NOW });
  const facts = { calendar: [], calendarKnown: true, approvals: [], taskDomains: new Map(), workingWindow: { hours: '08:00-18:00', todayIsWorking: true, todayStart: null, todayEnd: null, nextStart: null } };
  p.saim = POL.decide(NC.compose({ ...p, work: { atDesk: true, deskKnown: true }, utterances: [], situation: { sections: {} } }, { rows: [], block: null, session: null }, facts, { now: NOW }), { surface: 'work-desktop', now: NOW });
  return p;
}
const attentionFor = (data, over = {}) => ({ data, loading: false, error: null, primary: data && data.primary && data.primary.kind === 'item' ? data.primary : null,
  secondary: [], dropped: [], gaps: [], act: async () => {}, refresh: () => {}, ...over });
const renderView = (data, over = {}) => renderToString(React.createElement(View, { attention: attentionFor(data, over), onNavigate() {}, onStarted() {}, now: NOW }));
const whyOf = (html) => html.slice(html.indexOf('class="saim-why"'));
const FALSE_CLEAR = /nothing pressing|you(?:&#x27;|’|')re clear|all clear|everything(?:&#x27;|’|')s where it should be/i;

test('4a. working + urgent capacity: the shared scene renders and the Why strip says why it leads', () => {
  const html = renderView(fixture(steady(), workLife, [capacity, email]));
  assert.match(html, /class="[^"]*\bsit\b/, 'the shared Situation scene rendered');
  assert.match(html, /More work due by the end of today/);
  const why = whyOf(html);
  assert.match(why, /Why this · what I can’t see/);
  assert.match(why, /S7 top item/);
  // 25 Oct 2026: the server's freshness sentence, verbatim (no longer the overclaiming
  // "every source answered" whatever the sources' state).
  assert.match(why, /data-freshness="current">Every read answered, and the sources behind it are up to date\./);
  assert.match(why, /Read 10 seconds ago\./);
  assert.doesNotMatch(html, FALSE_CLEAR);
});

test('4b. off duty with urgent work held: the lead and the held list both carry the count', () => {
  const ctx = { activity: 'off', label: 'Not a working day', summary: "It's the weekend.", quiet: true, duty: { onDuty: false, known: true, reason: 'weekend' }, confidence: { level: 'high' } };
  const html = renderView(fixture(ctx, offLife, [capacity, email]));
  const why = whyOf(html);
  assert.match(why, /Nothing needs you right now — 2 work items held back while you(?:&#x27;|')re off duty, 1 of them urgent\./);
  // 25 Oct 2026: a human label for the kind, never the raw type id.
  assert.match(why, /Capacity warning(<!-- -->)? — not a working day/);
  assert.doesNotMatch(why, />capacity(<!-- -->)? —/);
  assert.doesNotMatch(why, /Nothing held back/);
  assert.doesNotMatch(html, FALSE_CLEAR);
});

test('4c. blind (pool unreadable): says so, never an all-clear', () => {
  const data = fixture(steady(), workLife, [], { poolAvailable: false });
  const html = renderView(data);
  assert.match(whyOf(html), /I can’t see your work right now\. This is not an all-clear\./);
  assert.doesNotMatch(html, FALSE_CLEAR);
});

test('4d. a failed read: Can’t see names it; stale + refresh error are said', () => {
  const data = fixture(steady(), workLife, [capacity], { gaps: [{ input: 'radar', why: 'down' }], generatedAt: new Date(NOW - 10 * 60000).toISOString() });
  const why = whyOf(renderView(data, { error: 'timeout' }));
  assert.match(why, /radar/);
  assert.match(why, /Couldn’t refresh — this is the last read\./);
  assert.match(why, /Read 10 min ago — it may be out of date\./);
});

test('4e. no read at all: "I can’t reach NEURO right now. This is not an all-clear."', () => {
  const html = renderToString(React.createElement(View, { attention: attentionFor(null), onNavigate() {}, now: NOW }));
  assert.match(html, /I can’t reach NEURO right now\. This is not an all-clear\./);
  assert.match(html, /Open Now/, 'Now is one click away');
});

test('4f. degraded presentation: the server’s degraded summary is shown verbatim', () => {
  const data = fixture({ ...steady(), activity: 'unknown' }, workLife, []);
  assert.equal(data.presentation.mode, 'degraded');
  const why = whyOf(renderView(data));
  assert.ok(why.includes(data.presentation.situation.summary.replace(/’/g, '’')), 'degraded line rendered');
});
