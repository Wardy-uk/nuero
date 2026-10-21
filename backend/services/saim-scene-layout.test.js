'use strict';

/**
 * The SAiM home scene's GEOMETRY on wide screens (21 Oct 2026, Nick's first use
 * of the canonical desktop): no sideways overflow down to 1024px, the readout
 * and the main surface held together (no void between them), one screen with
 * no page scroll at 1440×900 and 1920×1080 in the representative states, and
 * a single stacked column below the two-column width.
 *
 * ⚠ Layout cannot be judged from HTML strings, so this renders the REAL shared
 * Situation component with the REAL stylesheets and measures it in Chromium
 * (Electron, hidden window). Where no Electron binary is available (the Pi) it
 * SKIPS and says so — it never passes by absence.
 *   ELECTRON_PATH=<path to electron(.exe)>   overrides discovery
 *   SCENE_SHOTS=<dir>                        also writes a PNG per case
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const k = require('./keep-my-word');
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const UI = path.join(ROOT, 'saim', 'shared-ui');
const NOW = Date.parse('2026-10-21T14:00:00Z');

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT]) {
    try {
      const p = require(require.resolve('electron', { paths: [base] }));
      if (typeof p === 'string' && fs.existsSync(p)) return p;
    } catch { /* not installed here */ }
  }
  return null;
}

// ── Fixtures: real composed presentations + keep-my-word states ─────────────

const SCORE = {
  ratio: { kept: 7, of: 9 }, counts: { due: 10, keptOnTime: 7, late: 1, unverified: 1, pending: 1, dropped: 0, reDated: 2, undated: 0 },
  previous: { ratio: { kept: 6, of: 8 } }, entries: [{ key: 'promise:9', outcome: 'unverified' }],
  mondayReport: { state: 'sent-verified-on-time', dueLabel: 'Monday 19 October 2026, 12:00 (London)' },
};
const ITEM = {
  key: 'promise:31', taskIds: [31], leadTaskId: 31, title: 'Build the onboarding checklist for the new starter', owedTo: 'Kit Varga',
  due: { date: '2026-10-22', basis: 'set', endsAt: '2026-10-22T23:00:00.000Z', tier: 'soon', say: 'due within two days' },
  booked: [], preparation: { state: 'needs-a-block', why: 'Nothing is booked for it before it is due.' },
  because: [], evidence: [{ kind: 'due', fact: 'Due Thursday 22 October — the date set on the task.' }],
};
const BENCH = { state: 'ok', items: [ITEM], withheld: { sensitive: 0, ambiguous: 0, unreadable: 0, undated: 0 } };
const OPEN = { canAct: true, boundary: null };
const RECEIPT = k.receiptView({
  at: '2026-10-21T13:04:27.000Z', title: 'SIP T1 — triage and escalation acceptance criteria', target: 'live', complete: true,
  steps: [
    { step: 'calendar', status: 'done', target: '2026-10-21 15:30–16:00 “Support Improvement Plan review”' },
    { step: 'note', status: 'done', target: 'Projects/Support Improvement Plan/SIP - T1 Acceptance Criteria (draft).md' },
  ],
});

const fixture = (id) => FIXTURES.find((f) => f.id === id);
function scene(fixtureId, { receipt = null, unmeasured = false } = {}) {
  const f = fixture(fixtureId);
  const p = composePresentation(f.payload, { now: f.at });
  p.keepMyWord = k.compose({ score: unmeasured ? null : SCORE, workbench: BENCH, receipt, authority: OPEN, presentation: p, now: NOW });
  return p;
}

const CASES = {
  'calm-thread': () => scene('many-next'),
  'needs-you-folded': () => scene('approval'),
  'working-busy': () => scene('working-busy'),
  'receipt': () => scene('calm-saturday', { receipt: RECEIPT }),
  'degraded': () => scene('degraded'),
  'unmeasured-week': () => scene('empty', { unmeasured: true }),
};
// States that must fit one screen at 1440×900 and 1920×1080 with no page scroll.
const ONE_SCREEN = ['calm-thread', 'needs-you-folded', 'working-busy', 'receipt', 'degraded', 'unmeasured-week'];
const SIZES = [[1024, 768], [1280, 800], [1440, 900], [1920, 1080]];  // desktop profile, landscape

// The one next step (21 Oct 2026): in a meeting, the step must be above the
// fold — measured with the app's own chrome allowed for (top bar ~52px, bottom
// nav ~64px), on the desktop scene and on the phone.
function inMeeting() {
  const f = fixture('many-next');
  const payload = { ...f.payload, context: { ...f.payload.context, activity: 'in-meeting', quiet: true } };
  const p = composePresentation(payload, { now: f.at });
  p.keepMyWord = k.compose({ score: SCORE, workbench: BENCH, authority: OPEN, presentation: p, now: NOW });
  return p;
}
// In a meeting, with the step, on every target device (21 Oct 2026). `chrome`
// is what the shell itself takes: the PWA's top bar and bottom nav; the kiosk
// in ambient mode hides its nav (corner buttons overlay, no reserved space).
const STEP_CASES = [
  { name: 'meeting-desktop', profile: 'desktop', sizes: [[1440, 900], [1920, 1080]], chrome: { top: 52, bottom: 64 }, twoCol: true, oneScreen: true },
  { name: 'meeting-tablet-landscape', profile: 'kiosk', sizes: [[1280, 800]], chrome: { top: 0, bottom: 0 }, twoCol: true, oneScreen: true },
  { name: 'meeting-fire7-landscape', profile: 'kiosk', sizes: [[1024, 552]], chrome: { top: 0, bottom: 0 }, twoCol: true, oneScreen: true },
  { name: 'meeting-tablet-portrait', profile: 'kiosk', sizes: [[800, 1280]], chrome: { top: 0, bottom: 0 }, twoCol: false, oneScreen: false },
  { name: 'meeting-phone', profile: 'phone', sizes: [[390, 844]], chrome: { top: 52, bottom: 64 }, twoCol: false, oneScreen: false },
];

// ── Build the pages ──────────────────────────────────────────────────────────

function cssStub() {
  return { name: 'css-stub', setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
    b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  } };
}
async function loadSituation() {
  const out = await esbuild.build({ entryPoints: [path.join(UI, 'presentation', 'Situation.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], plugins: [cssStub()], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports.default;
}

const CSS = ['AttentionSurface.css', 'presentation/Situation.css', 'presentation/KeepMyWord.css', 'Field.css']
  .map((f) => fs.readFileSync(path.join(UI, f), 'utf8')).join('\n');

function page(Situation, presentation, { profile = 'desktop', step = false } = {}) {
  // The shell's real wrappers: a flex-column surface root, an ask dock and a
  // RELEVANT desk row (three chips — the cap), so the measured screen is the
  // one Nick sees, not a bare component.
  const ask = React.createElement('div', { className: 'sit-dock' },
    React.createElement('input', { className: 'sit-dock__input', placeholder: 'Ask SAiM…' }),
    React.createElement('button', { className: 'sit-dock__btn', type: 'button' }, '🎤'));
  const foot = React.createElement('p', { className: 'sit__desk' },
    React.createElement('span', { className: 'sit__label' }, 'On the laptop'),
    ['VS Code', 'Teams', 'Outlook'].map((l) => React.createElement('button', { key: l, type: 'button', className: 'sit__chip sit__chip--quiet' }, l)));
  const field = React.createElement('div', { style: { position: 'absolute', inset: 0, background: '#0b1310' } });
  const body = renderToString(React.createElement('div', { className: 'surface surface--situation surface--scene', style: { minHeight: '100vh', display: 'flex', flexDirection: 'column' } },
    React.createElement(Situation, { presentation, profile, scene: true, field, ask: profile === 'kiosk' ? null : ask, foot: profile === 'phone' ? null : foot,
      step: step ? React.createElement('div', { className: 'sit__step' },
        React.createElement('button', { type: 'button', className: 'sit__chip sit__chip--yes sit__step-go' }, 'Join in Teams'),
        React.createElement('button', { type: 'button', className: 'sit__chip sit__chip--quiet sit__step-alt' }, 'Open meeting prep'),
        ...(profile === 'kiosk' ? [] : [React.createElement('button', { key: 'c', type: 'button', className: 'sit__chip sit__chip--quiet sit__step-alt' }, 'Capture from this meeting')])) : null, onOpen: () => {}, onPrepareDelivery: () => {}, onOpenActions: () => {} })));
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#06090d}*{animation:none!important;transition:none!important}${CSS}</style></head><body>${body}</body></html>`;
}

// The measurement, run inside Electron's main process.
const MEASURE = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const jobs = JSON.parse(fs.readFileSync(process.env.SCENE_JOBS, 'utf8'));
app.disableHardwareAcceleration();
// Each case closes its window; without this the app quits after the first.
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); app.exit(2); });
app.whenReady().then(async () => {
  const out = [];
  for (const j of jobs) {
    const win = new BrowserWindow({ width: j.w, height: j.h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
    // offscreen: a real window is clamped to the display (1920×1080 became 1904×993 under the taskbar).
    win.setContentSize(j.w, j.h);
    // A data: URL, not loadFile: file:// loads in a hidden window failed with
    // ERR_FAILED intermittently on Windows. One retry, then the error stands.
    const url = 'data:text/html;charset=utf-8;base64,' + fs.readFileSync(j.file).toString('base64');
    try { await win.loadURL(url); } catch { await new Promise((r) => setTimeout(r, 300)); await win.loadURL(url); }
    const m = await win.webContents.executeJavaScript(\`(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      const vw = document.documentElement.clientWidth;
      const over = [...document.querySelectorAll('.sit__body *')].filter((e) => e.getBoundingClientRect().right > vw + 1).slice(0, 5).map((e) => e.className || e.tagName);
      return { vw, vh: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
        week: r('.kmw__week'), main: r('.sit__situation'), body: r('.sit__body'), step: r('.sit__step'), over };
    })()\`);
    if (process.env.SCENE_SHOTS) { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(process.env.SCENE_SHOTS, j.name + '-' + j.w + 'x' + j.h + '.png'), img.toPNG()); }
    out.push({ name: j.name, w: j.w, h: j.h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.SCENE_OUT, JSON.stringify(out));
  app.quit();
});
`;

let results = null;
let skipWhy = null;

test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — layout NOT verified'; return; }
  const Situation = await loadSituation();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saim-scene-'));
  const jobs = [];
  for (const [name, make] of Object.entries(CASES)) {
    const file = path.join(dir, `${name}.html`);
    fs.writeFileSync(file, page(Situation, make()));
    for (const [w, h] of SIZES) jobs.push({ name, file, w, h });
  }
  for (const c of STEP_CASES) {
    const file = path.join(dir, `${c.name}.html`);
    fs.writeFileSync(file, page(Situation, inMeeting(), { profile: c.profile, step: true }));
    for (const [w, h] of c.sizes) jobs.push({ name: c.name, file, w, h });
  }
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'scene-measure', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), MEASURE);
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(jobs));
  const env = { ...process.env, SCENE_JOBS: path.join(dir, 'jobs.json'), SCENE_OUT: path.join(dir, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(bin, [appDir], { env, timeout: 120000, encoding: 'utf8' });
  if (!fs.existsSync(env.SCENE_OUT)) throw new Error(`Electron produced no measurements (status ${r.status}): ${(r.stderr || '').slice(0, 800)}`);
  results = JSON.parse(fs.readFileSync(env.SCENE_OUT, 'utf8'));
  if (process.env.SCENE_REPORT) for (const m of results) console.log(`[scene] ${m.name} ${m.w}x${m.h}: page ${m.sw}x${m.sh}, gap ${m.week && m.main ? Math.round(m.main.left - m.week.right) : '-'}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (name, w) => results.find((x) => x.name === name && x.w === w);

test('no horizontal overflow or clipping at any width from 1024px up', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results) {
    assert.ok(m.sw <= m.vw, `${m.name} @${m.w}: page is ${m.sw}px wide in a ${m.vw}px window`);
    assert.deepEqual(m.over, [], `${m.name} @${m.w}: content past the right edge`);
  }
});

test('desktop: a wide composition — readout beside the main surface, moderate gap, NOT a narrow central cluster', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const w of [1280, 1440, 1920]) {
    for (const name of Object.keys(CASES)) {
      const m = get(name, w);
      assert.ok(m.week && m.main, `${name} @${w}: readout and main surface both render`);
      const gap = m.main.left - m.week.right;
      assert.ok(gap >= 30 && gap <= 100, `${name} @${w}: gap ${Math.round(gap)}px`);
      assert.ok(Math.abs(m.week.top - m.main.top) < 40, `${name} @${w}: side by side`);
      assert.ok(m.body.right - m.body.left <= 1480 + 1, `${name} @${w}: bounded`);
      // The composition (readout's left edge to the main column's right edge)
      // spans most of the screen: ≥ 70% at 1440, ≥ 65% at 1920.
      const span = m.main.right - m.week.left;
      const min = w === 1920 ? 0.65 : 0.7;
      if (w !== 1280) assert.ok(span >= w * min, `${name} @${w}: composition is ${Math.round(span)}px of ${w} — bunched`);
      // Centred: left and right margins within 2px of each other.
      assert.ok(Math.abs(m.week.left - (m.vw - m.main.right)) <= 2 || w === 1280, `${name} @${w}: centred`);
    }
  }
});

test('one screen: no page scroll at 1440×900 and 1920×1080 in the representative states', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const w of [1440, 1920]) {
    for (const name of ONE_SCREEN) {
      const m = get(name, w);
      assert.ok(m.sh <= m.vh, `${name} @${w}×${m.vh}: page is ${m.sh}px tall`);
    }
  }
});

test('landscape 1024×768 is two columns too — layout follows orientation, not a raw max-width', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of Object.keys(CASES)) {
    const m = get(name, 1024);
    assert.ok(m.week.right <= m.main.left, `${name} @1024×768: readout beside the main surface`);
  }
});

test('in a meeting, on every device: the right columns, no sideways overflow, and the step ABOVE THE FOLD where it must be', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const c of STEP_CASES) {
    for (const [w, h] of c.sizes) {
      const m = results.find((x) => x.name === c.name && x.w === w);
      const at = `${c.name} @${w}×${h}`;
      assert.ok(m.step, `${at}: the step renders`);
      assert.ok(m.sw <= m.vw, `${at}: ${m.sw}px wide in ${m.vw}`);
      assert.ok(m.step.right <= m.vw, `${at}: step not clipped sideways`);
      if (c.twoCol) {
        assert.ok(m.week.right <= m.main.left && Math.abs(m.week.top - m.main.top) < 40, `${at}: readout BESIDE the meeting`);
        assert.ok(m.step.bottom + c.chrome.top <= h - c.chrome.bottom, `${at}: step ends at ${Math.round(m.step.bottom + c.chrome.top)} of ${h - c.chrome.bottom}`);
      } else {
        assert.ok(m.week.bottom <= m.main.top + 1, `${at}: one column, readout first`);
      }
      if (c.name === 'meeting-phone') assert.ok(m.step.bottom + c.chrome.top <= h - c.chrome.bottom, `${at}: step above the fold`);
      if (c.oneScreen) assert.ok(m.sh <= h + 1, `${at}: page is ${m.sh}px tall — scrolls`);
    }
  }
});
