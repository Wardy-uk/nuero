'use strict';

/**
 * Prepared moves MVP — the proposal's VISIBLE STATES at the four target
 * viewports (21 Oct 2026): phone 390×844, Fire 7 landscape 1024×552, desktop
 * 1440×900 and 1920×1080. The REAL shared Situation (locked scene) with the
 * REAL PreparedMove component in its prepared slot and the real stylesheets,
 * measured in Chromium (Electron, offscreen). Skips — and says so — where no
 * Electron binary exists (the Pi); it never passes by absence.
 *
 * Checks: no sideways overflow; the outcome headline and the one confirm
 * button inside the width; on desktop both above the fold when the move
 * leads; in a meeting the move FOLDS behind its entry (never interrupts); on
 * the kiosk there is no button at all.
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
const { composePresentation } = require('./presentation-intent');
const { FIXTURES } = require('../../shared/presentation-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const UI = path.join(ROOT, 'saim', 'shared-ui');
const APP = path.join(ROOT, 'saim', 'app', 'src');
const NOW = Date.parse('2026-10-21T14:00:00Z');

function electronBinary() {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) return process.env.ELECTRON_PATH;
  for (const base of [path.join(ROOT, 'saim', 'desktop-electron'), ROOT]) {
    try { const p = require(require.resolve('electron', { paths: [base] })); if (typeof p === 'string' && fs.existsSync(p)) return p; } catch { /* not here */ }
  }
  return null;
}

const plugins = [{ name: 'stub', setup(b) {
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
  b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
  b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({});', loader: 'js' }));
} }];
async function bundle(entry) {
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], plugins, logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// ── The proposal states ──────────────────────────────────────────────────────
const MOVE = {
  version: 2, recordId: 'pm_0123456789abcdef0123', recordVersion: 1, kind: 'email-reply', plan: 'draft', title: 'Renewal question for the Acme account and both of its sites',
  prepared: { headline: 'I drafted the reply to Sam.', detail: 'The reply goes to Actions, where it waits for your approval code. Nothing is sent from here.' },
  outcome: { goal: 'Answer Sam Jones about “Renewal question for the Acme account and both of its sites”.' },
  why: { because: [], willNot: ['Send the reply — it waits in Actions for your approval code'] },
  evidence: [{ fact: 'Sam Jones wrote “Renewal question” on Wednesday 21 Oct.' }], freshness: [{ ref: 'email triage', ageHours: 1, maxHours: 26 }],
  deliverable: { kind: 'email-reply', title: 'Reply: Renewal question', to: { email: 'sam.jones.with.a.very.long.address@acme-renewals-department.example.test', name: 'Sam Jones' },
    sourceFacts: [{ text: 'could you confirm whether the renewal for Acme can go ahead this month?', cite: 'the email', kind: 'source' }],
    suggested: { label: 'Suggested wording — SAiM wrote this from the sources above; check it before you use it.', text: 'Hi Sam,\n\nThanks — I will confirm the renewal for Acme this month.\n\nNick' }, gaps: [] },
  options: [{ id: 'approve', label: 'As drafted', question: 'Put this reply in Actions for your approval?', writes: ['Put the reply to Sam Jones in Actions, waiting for your approval code. It is NOT sent.'] }],
  contacts: 'Nothing is sent: the reply waits in Actions until you approve it with your code.',
  respond: { defer: { days: [{ days: 1, label: 'Until tomorrow' }], reasons: [{ id: 'not-now', label: 'Not now' }] }, decline: { reasons: [{ id: 'not-mine', label: 'Not mine to do' }] } },
  moment: { headline: 'I drafted the reply to Sam.' },
};
const NOTE_MOVE = { ...MOVE, kind: 'project-note', title: 'Write the Support Hub triage notes', prepared: { headline: '“Write the Support Hub triage notes”: I drafted it.', detail: '' }, moment: { headline: 'I drafted “Write the Support Hub triage notes”.' },
  deliverable: { ...MOVE.deliverable, kind: 'project-note', to: null, title: 'Write the Support Hub triage notes (draft)', gaps: ['who owns the weekly review'], suggested: { label: 'Suggested wording', text: '## Scope\n- Support Hub triage notes need a single owner' } },
  options: [{ id: 'approve', date: '2026-10-22', start: '10:00', end: '10:30', label: 'Thursday 22 Oct 10:00–10:30', question: 'Save the draft and reserve 30 minutes?', writes: ['Save the draft as a new note: Projects/Support Hub/Write the Support Hub triage notes (draft).md', 'Add “Finish Write the Support Hub triage notes (draft)” to your calendar, Thursday 22 Oct 10:00–10:30. Just you — nobody is invited.'] }] };
const ASK_MOVE = { ...MOVE, kind: 'project-note', plan: 'ask', options: [], prepared: { headline: 'I can start this — I need one thing from you first.', detail: 'Your notes say nothing about it yet.' }, moment: { headline: 'I can start this — I need one thing from you first.' },
  deliverable: { ...MOVE.deliverable, suggested: null }, ask: { questions: [{ id: 'purpose', question: 'What should this cover? A sentence or two is enough.', why: 'Your notes say nothing about it yet beyond the task itself, so a draft would be invented.' }] } };
const RECEIPT = { complete: false, target: 'live', plain: 'The calendar block was not saved: HTTP 400. The note is saved and stays.', next: 'Confirm again to retry only what is missing — nothing that worked is repeated or undone.', steps: [{ step: 'note', status: 'done' }, { step: 'calendar', status: 'failed', provablyNotApplied: true, error: 'the calendar refused the block' }] };
const view = (move) => ({ ok: true, contract: 'prepared-move-view-v1', execution: { enabled: true }, authority: { canAct: true }, move });
const STATES = {
  'reply-ready': { state: { kind: 'ready', view: view(MOVE), option: 'approve' } },
  'note-with-block': { state: { kind: 'ready', view: view(NOTE_MOVE), option: 'approve' } },
  ask: { state: { kind: 'ready', view: view(ASK_MOVE), option: null } },
  offer: { state: { kind: 'offer', view: { move: null }, offer: { ref: 'held:email-urgent', title: 'Renewal question', kind: 'email-reply', label: 'Draft the reply' } } },
  'partial-receipt': { state: { kind: 'receipt', view: view(NOTE_MOVE), option: 'approve', receipt: RECEIPT } },
};
const SIZES = { phone: [[390, 844]], kiosk: [[1024, 552]], desktop: [[1440, 900], [1920, 1080]] };

const fixture = (id) => FIXTURES.find((f) => f.id === id);
function presentation({ meeting = false } = {}) {
  const f = fixture('many-next');
  const payload = meeting ? { ...f.payload, context: { ...f.payload.context, activity: 'in-meeting', quiet: true } } : f.payload;
  return composePresentation(payload, { now: f.at });
}

const CSS = ['AttentionSurface.css', 'presentation/Situation.css', 'presentation/KeepMyWord.css', 'Field.css'].map((f) => fs.readFileSync(path.join(UI, f), 'utf8')).join('\n')
  + '\n' + fs.readFileSync(path.join(APP, 'components', 'PreparedMove.css'), 'utf8');

function page({ Situation, PM }, { state, profile, meeting = false, readOnly = false }) {
  const noop = () => {};
  const prepared = React.createElement('div', { className: 'pmo-root' }, React.createElement(PM.PreparedMoveView, { state, now: NOW, readOnly, onChoose: noop, onAsk: noop, onConfirm: noop, onCancel: noop, onAgain: noop, onMakeReady: noop, onRespond: noop, onAnswer: noop }));
  const body = renderToString(React.createElement('div', { className: 'surface surface--situation surface--scene', style: { minHeight: '100vh', display: 'flex', flexDirection: 'column' } },
    React.createElement(Situation, { presentation: presentation({ meeting }), profile, scene: true, prepared, preparedMoment: PM.momentOf(state), onOpen: noop })));
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#06090d}*{animation:none!important;transition:none!important}${CSS}</style></head><body>${body}</body></html>`;
}

const MEASURE = `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync(process.env.PM_JOBS, 'utf8'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error(String(e && e.stack || e)); app.exit(2); });
app.whenReady().then(async () => {
  const out = [];
  for (const j of jobs) {
    const win = new BrowserWindow({ width: j.w, height: j.h, useContentSize: true, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
    win.setContentSize(j.w, j.h);
    const url = 'data:text/html;charset=utf-8;base64,' + fs.readFileSync(j.file).toString('base64');
    try { await win.loadURL(url); } catch { await new Promise((r) => setTimeout(r, 300)); await win.loadURL(url); }
    const m = await win.webContents.executeJavaScript(\`(() => {
      const box = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height }; };
      const vw = document.documentElement.clientWidth;
      const over = [...document.querySelectorAll('.pmo, .pmo *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > vw + 1; }).slice(0, 5).map((e) => e.className || e.tagName);
      const det = document.querySelector('details.sit__prepared');
      return { vw, vh: innerHeight, sw: document.documentElement.scrollWidth, say: box('.pmo2 .pmo__say, .pmo2--offer .pmo__sub'), yes: box('.pmo2 .pmo__btn--yes'), anyBtn: document.querySelectorAll('.pmo2 button').length, folded: det ? !det.open : null, over };
    })()\`);
    out.push({ name: j.name, w: j.w, h: j.h, ...m });
    win.destroy();
  }
  fs.writeFileSync(process.env.PM_OUT, JSON.stringify(out));
  app.quit();
});
`;

let results = null; let skipWhy = null;
test.before(async () => {
  const bin = electronBinary();
  if (!bin) { skipWhy = 'no Electron binary here (set ELECTRON_PATH) — layout NOT verified'; return; }
  const mods = { Situation: (await bundle(path.join(UI, 'presentation', 'Situation.jsx'))).default, PM: await bundle(path.join(APP, 'components', 'PreparedMove.jsx')) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-v2-layout-'));
  const jobs = [];
  for (const [name, { state }] of Object.entries(STATES)) {
    for (const [profile, sizes] of Object.entries(SIZES)) {
      const file = path.join(dir, `${name}-${profile}.html`);
      fs.writeFileSync(file, page(mods, { state, profile, readOnly: profile === 'kiosk' && name === 'reply-ready' }));
      for (const [w, h] of sizes) jobs.push({ name: `${name}/${profile}`, file, w, h });
    }
  }
  const meetFile = path.join(dir, 'meeting.html');
  fs.writeFileSync(meetFile, page(mods, { state: STATES['reply-ready'].state, profile: 'desktop', meeting: true }));
  jobs.push({ name: 'in-meeting/desktop', file: meetFile, w: 1440, h: 900 });
  const appDir = path.join(dir, 'app'); fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'pm-measure', main: 'main.js', private: true }));
  fs.writeFileSync(path.join(appDir, 'main.js'), MEASURE);
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(jobs));
  const env = { ...process.env, PM_JOBS: path.join(dir, 'jobs.json'), PM_OUT: path.join(dir, 'out.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(bin, [appDir], { env, timeout: 120000, encoding: 'utf8' });
  if (!fs.existsSync(env.PM_OUT)) throw new Error(`Electron produced no measurements (status ${r.status}): ${(r.stderr || '').slice(0, 800)}`);
  results = JSON.parse(fs.readFileSync(env.PM_OUT, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
});
const get = (name, w) => results.find((x) => x.name === name && x.w === w);

test('every proposal state at 390, Fire 7 landscape, 1440 and 1920: no sideways overflow', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const m of results) {
    assert.ok(m.sw <= m.vw, `${m.name} @${m.w}: page is ${m.sw}px wide in ${m.vw}px`);
    assert.deepEqual(m.over, [], `${m.name} @${m.w}: content past the right edge`);
  }
});

test('the outcome headline and the one confirm button sit inside the width; on desktop both are above the fold', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const name of ['reply-ready', 'note-with-block']) {
    for (const [profile, sizes] of Object.entries(SIZES)) {
      if (profile === 'kiosk' && name === 'reply-ready') continue;
      for (const [w] of sizes) {
        const m = get(`${name}/${profile}`, w);
        assert.ok(m.say && m.say.right <= m.vw + 1 && m.say.left >= -1, `${name}/${profile} @${w}: headline inside the width`);
        assert.ok(m.yes && m.yes.right <= m.vw + 1 && m.yes.w >= 44 && m.yes.h >= 30, `${name}/${profile} @${w}: confirm button present and tappable`);
        if (profile === 'desktop') assert.ok(m.yes.bottom <= m.vh, `${name}/${profile} @${w}: confirm above the fold (bottom ${Math.round(m.yes.bottom)} of ${m.vh})`);
      }
    }
  }
});

test('kiosk is read-only: the proposal shows with no button to press', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  const m = get('reply-ready/kiosk', 1024);
  assert.ok(m.say, 'shown'); assert.equal(m.anyBtn, 0, 'no confirm, defer or decline on the kiosk');
});

test('in a meeting the prepared move folds behind its entry — it never interrupts', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  assert.equal(get('in-meeting/desktop', 1440).folded, true);
});

test('the question and the offer render as themselves at every size', (t) => {
  if (skipWhy) return t.skip(skipWhy);
  for (const [profile, sizes] of Object.entries(SIZES)) for (const [w] of sizes) {
    assert.ok(get(`ask/${profile}`, w).say, `ask/${profile} @${w}`);
    assert.ok(get(`offer/${profile}`, w).say, `offer/${profile} @${w}`);
  }
});
