/**
 * SAiM Alt — the A/B treatment shell (saim-alt.nickward.co.uk).
 *
 * Pins what the briefs made non-negotiable:
 *   1. NAVIGATION: a persistent bottom bar with exactly five destinations, the
 *      control's icons, SAiM selected by default, nothing else reachable.
 *   2. THE WORK SURFACE is always present; uncertainty changes its wording,
 *      never removes it. PRESENCE follows an evidence priority: recent use of
 *      this page > desk agent > watch, and never says "away" while he uses it.
 *   3. A KNOWN STEP gets one recommendation (a different, declared app) with its
 *      real desk lifecycle; an app already in front is said, never re-opened.
 *   4. UNKNOWN room / unseen desk / unavailable agent / no thread are each SAID.
 *   5. HELD WORK is said as held and expands without touching canonical state.
 *   6. THE FIELD is the control's, unchanged; the control cannot see alt code.
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

let M;            // the pure model
let View;         // SaimHomeView
let Shell;        // AltShell

// The field paints to a canvas; the stub records what it was handed so the
// test can prove the shell passes the drive through untouched.
const FIELD_STUB = 'export default function Field(p) { return require("react").createElement("i", { "data-field": JSON.stringify(p) }); }';

function stubPlugin() {
  return {
    name: 'stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      build.onResolve({ filter: /mobile\/outbox$/ }, () => ({ path: 'outbox', namespace: 'stub' }));
      build.onResolve({ filter: /(^|\/)Field$/ }, () => ({ path: 'field', namespace: 'stub' }));
      build.onLoad({ filter: /^outbox$/, namespace: 'stub' }, () => ({
        contents: 'export const enqueue=()=>{throw new Error("x")};export const flush=async()=>({receipts:{}});export const outcomeFor=()=>({state:"queued"});',
        loader: 'js',
      }));
      build.onLoad({ filter: /^field$/, namespace: 'stub' }, () => ({ contents: FIELD_STUB, loader: 'js' }));
    },
  };
}

async function bundle(file) {
  const out = await esbuild.build({
    entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], plugins: [stubPlugin()], logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

test.before(async () => {
  M = await import(`file://${path.join(ALT, 'model.mjs').replace(/\\/g, '/')}`);
  View = (await bundle(path.join(ALT, 'SaimHome.jsx'))).SaimHomeView;
  Shell = (await bundle(path.join(ALT, 'AltShell.jsx'))).default;
  assert.ok(View && Shell, 'both views export');
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const APPS17 = [
  ['browser', 'Browser'], ['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['code', 'VS Code'], ['excel', 'Excel'],
  ['music', 'Music'], ['neuro', 'NEURO'], ['nova', 'NOVA'], ['obsidian', 'Obsidian'], ['outlook', 'Outlook'],
  ['plaud', 'Plaud'], ['postman', 'Postman'], ['ssms', 'SSMS'], ['teams', 'Teams'], ['terminal', 'Terminal'],
  ['vantage', 'VANTAGE'], ['word', 'Word'],
].map(([id, label]) => ({ id, label }));

// The calm personal-project state, shaped like the live /api/canonical/now
// read of 13 Oct 2026: an evening at home on his own project, VS Code in
// front, watch heard in the living room, work held, nothing waiting.
function live(over = {}) {
  return {
    generatedAt: '2026-10-13T18:03:39.000Z',
    poolAvailable: true,
    quiet: false,
    situation: { calm: true, calmSay: 'Nothing needs you right now.' },
    context: {
      activity: 'ritual',
      place: { known: true, name: 'unknown', source: 'owntracks', room: 'living-room', roomSubject: 'watch', roomWhy: null },
      confidence: { level: 'high', rationale: 'Every input answered and they agree.' },
      unknowns: [], cannotSee: null,
    },
    life: { doing: 'hobby', label: 'On a project of your own', showWork: false, place: { kind: 'home', label: 'living-room' } },
    operation: { phase: 'standing_by', label: 'STANDING BY', detail: null },
    primary: { kind: 'context', id: 'context-off', title: 'On a project of your own', reason: 'On a project of your own · living-room', say: 'On a project of your own · living-room', actions: [] },
    work: {
      known: true, kind: 'app', task: null, app: 'Code', atDesk: true, deskKnown: true, host: 'DESKTOP-8LGF9RR',
      why: 'you are at the laptop in Code — which says nothing about which task',
      deskOffer: { known: true, host: 'DESKTOP-8LGF9RR', why: null, apps: APPS17 },
    },
    dropped: [
      { id: 'todo-overdue-summary', type: 'todo', why: 'not working — on a project of your own' },
      { id: 'capacity-start-345', type: 'capacity', why: 'not working — on a project of your own' },
      { id: 'cal-AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWQyNmMzN2UyMTBmOQBGAAAAAAA7R6hC4', type: 'meeting', why: 'not working — on a project of your own' },
      { id: 'email-urgent', type: 'email', why: 'not working — on a project of your own' },
    ],
    approvals: { known: true, needsApproval: 0, needsReview: 0, where: 'Actions, in NEURO on the desktop', say: null },
    transition: null,
    nextMeeting: null,
    gaps: [],
    utterances: [
      { say: 'What did I actually finish?', intent: { kind: 'ask' } },
      { say: 'Show me everything', intent: { kind: 'reveal' } },
    ],
    ...over,
  };
}
const STEP = (nextStep) => ({ session: { active: true, nextStep } });

const render = (props) => renderToString(React.createElement(View, props));
const strip = (h) => h.replace(/<!-- -->/g, '');
const text = (h) => strip(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ── 1. Bottom navigation ────────────────────────────────────────────────────

test('exactly five destinations, in order, with the control’s icons', () => {
  assert.deepEqual([...M.ALT_TAB_IDS], ['saim', 'now', 'review', 'capture', 'controls']);
  assert.deepEqual(M.ALT_TABS.map((t) => t.label), ['SAiM', 'Now', 'Review', 'Capture', 'Controls']);
  const reg = fs.readFileSync(path.join(SHARED_UI, 'tabs.jsx'), 'utf8');
  const iconOf = (id) => (reg.match(new RegExp(`id: '${id}', label: '[^']*', icon: '([^']+)'`)) || [])[1];
  assert.equal(M.ALT_TABS[0].icon, iconOf('surface'));
  for (const id of ['now', 'review', 'capture', 'controls']) assert.equal(M.ALT_TABS.find((t) => t.id === id).icon, iconOf(id), id);
  assert.equal(M.ALT_DEFAULT_TAB, 'saim');
});

test('the bar: tagline left, five icon buttons centre, updated time right — nothing else to navigate to', () => {
  const html = strip(renderToString(React.createElement(Shell, { active: 'saim', drive: { degraded: false }, updatedAt: '2026-10-13T18:03:00.000Z', onGo: () => {} })));
  const bar = html.slice(html.indexOf('<footer class="alt-bar"'));
  assert.match(bar, /SAiM stays with the thread\. NEURO holds the detail\./);
  const tabs = [...bar.matchAll(/<button[^>]*class="alt-bar__tab[^"]*"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(tabs.length, 5);
  assert.deepEqual(tabs.map((m) => m[1].replace(/<[^>]+>/g, '')), ['✦SAiM', '◉Now', '◐Review', '➕Capture', '⚙Controls']);
  assert.match(tabs[0][0], /is-on/);
  assert.equal((bar.match(/is-on/g) || []).length, 1);
  assert.match(bar, /class="alt-bar__updated"[^>]*>Updated \d\d:\d\d</);
  assert.equal((html.match(/<nav/g) || []).length, 1);
  assert.doesNotMatch(html, /alt-app__nav|alt-app__tab/);
  // The tagline column can shrink and wrap, so it is never clipped.
  const css = fs.readFileSync(path.join(ALT, 'AltApp.css'), 'utf8');
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(css, /\.alt-bar__tagline \{[^}]*overflow-wrap: anywhere/);
});

test('every other control destination is handed off to NEURO, never rendered', () => {
  for (const id of ['tasks', 'chat', 'prep', 'standup', 'household', 'today', 'focus', 'brain', '', null, 'constructor']) {
    const r = M.resolveAltTab(id);
    assert.equal(r.tab, null, `${id} must not resolve to a screen`);
    assert.equal(r.handoff, true);
  }
  for (const id of M.ALT_TAB_IDS) assert.deepEqual(M.resolveAltTab(id), { tab: id, handoff: false });
  assert.equal(M.resolveAltTab('surface').tab, 'saim');
  assert.equal(M.resolveAltTab('voice').tab, 'capture');
  for (const f of ['AltApp.jsx', 'AltShell.jsx', 'SaimHome.jsx']) {
    const src = fs.readFileSync(path.join(ALT, f), 'utf8');
    assert.doesNotMatch(src, /shared-ui\/tabs/, f);
    assert.doesNotMatch(src, /views\/(Tasks|Chat|MeetingPrep|Standup|Household|Surface)/, f);
  }
});

test('updated time: local HH:MM, or said to be unread', () => {
  assert.match(M.updatedLabel('2026-10-13T18:03:39.000Z'), /^Updated \d\d:\d\d$/);
  assert.equal(M.updatedLabel(null), null);
  assert.match(renderToString(React.createElement(Shell, { active: 'saim', drive: {}, updatedAt: null })), /Not read yet/);
});

// ── 2. The calm personal-project state ──────────────────────────────────────

// ── 2. The work surface is always present ───────────────────────────────────

const NOW = Date.parse('2026-10-13T18:05:00.000Z');
const ACTIVE = { localActiveAt: NOW - 20_000, now: NOW };   // page touched 20s ago
const IDLE = { localActiveAt: null, now: NOW };

test('the work surface is always rendered — known, context and unknown threads alike', () => {
  for (const d of [
    live(),
    live({ context: { ...live().context, activity: 'unknown' }, life: null, primary: { kind: 'context', title: 'Can’t tell' } }),
    live({ primary: null, life: null }),
    live({ primary: { kind: 'item', type: 'todo', title: 'Finish the KPI pack', say: 'Finish the KPI pack' } }),
  ]) {
    const html = strip(render({ data: d, ...IDLE, dock: React.createElement('i', { id: 'dock' }) }));
    assert.match(html, /class="alt-thread[^"]*"/, 'the main work area');
    assert.match(html, /id="dock"/, 'the contextual Ask/Capture route');
    assert.match(html, /class="alt-presence"/);
  }
  // Not a hero sentence on a bare field: no quiet-mode markup anywhere.
  for (const f of ['SaimHome.jsx', 'SaimHome.css']) assert.doesNotMatch(fs.readFileSync(path.join(ALT, f), 'utf8'), /alt-quiet\b|alt-home--quiet/);
});

test('calm context: NEURO’s title, one compact uncertainty line, no tool chooser, no filler', () => {
  const t = M.currentThread(live(), null, ACTIVE);
  assert.equal(t.state, 'context');
  assert.equal(t.item.title, 'On a project of your own');
  assert.equal(t.uncertain, 'VS Code is open — I don’t know the next step yet.');
  const html = strip(render({ data: live(), ...ACTIVE, onDeskOpen: () => {}, onToggleHelp: () => {}, onBringWork: () => {}, onToggleHeld: () => {} }));
  const tx = text(html);
  assert.match(tx, /On a project of your own VS Code is open — I don’t know the next step yet\./);
  assert.doesNotMatch(html, /alt-ways|alt-tool__/, 'no app grid by default');
  for (const s of ['Nothing waiting for your judgement', 'Name the next step', 'Keep working here', 'Nothing held back', 'Best next place']) assert.ok(!tx.includes(s), `no "${s}"`);
  assert.match(tx, /Help me move this forward/);
  assert.match(tx, /Bring work back/);
});

test('unknown thread: one compact line inside the surface, never a hero, nothing invented', () => {
  const d = live({ context: { ...live().context, activity: 'unknown' }, life: null, primary: { kind: 'context', title: 'Can’t tell', say: 'Can’t tell · living-room' } });
  const t = M.currentThread(d, null, ACTIVE);
  assert.equal(t.state, 'unknown');
  assert.equal(t.item.title, 'I can’t tell what you’re working on from what I can see.');
  assert.equal(t.nextStep.known, false);
  assert.equal(t.canBringWork, false);
  const html = strip(render({ data: d, ...ACTIVE }));
  assert.match(html, /alt-thread__title alt-thread__title--small/);
  assert.doesNotMatch(text(html), /Can’t tell/);
});

// ── 3. Presence truth ───────────────────────────────────────────────────────

test('active desktop use beats the desk agent and the watch: never "away from the laptop"', () => {
  // The live disagreement: the agent says not at the desk, the watch was heard
  // in the living room, NEURO reads him as watching TV — and he is using this page.
  const d = live({
    life: { doing: 'watching-tv', showWork: false, place: { kind: 'home' } },
    primary: { kind: 'context', title: 'Watching TV' },
    work: { ...live().work, atDesk: false, app: null },
  });
  const p = M.presence(d, ACTIVE);
  assert.equal(p.desk, 'desk active');
  // NEURO's contradicted read is not presented as the thread; it is named as a read.
  const t = M.currentThread(d, null, ACTIVE);
  assert.equal(t.state, 'unknown');
  assert.equal(t.item.reason, 'NEURO last read you as “Watching TV”.');
  assert.equal(M.currentThread(d, null, IDLE).state, 'context', 'without page use, NEURO’s read stands');
  assert.doesNotMatch(strip(render({ data: d, ...ACTIVE })), /alt-thread__title[^>]*>Watching TV</);
  assert.equal(p.disagree, 'Signals disagree — desk active; watch last heard in the living room.');
  const html = text(render({ data: d, ...ACTIVE }));
  assert.doesNotMatch(html, /away from the laptop/i);
  assert.match(html, /Signals disagree — desk active; watch last heard in the living room\./);
  assert.doesNotMatch(html, /You’re in the living room/i, 'the watch never places him');
  assert.match(strip(render({ data: d, ...ACTIVE })), /<p class="alt-presence__who">Nick · Home<\/p>/);
});

test('without recent page use, the agent decides; with neither, "away" is said', () => {
  const away = live({ work: { ...live().work, atDesk: false, app: null } });
  assert.equal(M.presence(away, IDLE).desk, 'away from the laptop');
  assert.equal(M.presence(away, IDLE).disagree, null);
  assert.equal(M.presence(live(), IDLE).desk, 'desk active · VS Code open');
  // Page use lapses after the window.
  assert.equal(M.presence(away, { localActiveAt: NOW - M.LOCAL_ACTIVE_MS - 1, now: NOW }).desk, 'away from the laptop');
  assert.equal(M.isLocallyActive(NOW - 1000, NOW), true);
  assert.equal(M.isLocallyActive(null, NOW), false);
  assert.equal(M.isLocallyActive(NOW + 5000, NOW), false, 'a future stamp is not evidence');
});

test('agreeing signals are not called a disagreement; unseen laptop is said', () => {
  assert.equal(M.presence(live(), ACTIVE).disagree, null, 'agent and page agree');
  const unseen = live({ work: { deskKnown: false } });
  assert.equal(M.presence(unseen, IDLE).desk, 'laptop not seen');
  assert.equal(M.presence(unseen, ACTIVE).desk, 'desk active');
  assert.match(M.presence(unseen, { ...ACTIVE }).disagree, /^Signals disagree — desk active; /);
  const noRoom = live({ context: { ...live().context, place: { known: false } }, work: { deskKnown: false } });
  assert.equal(M.presence(noRoom, ACTIVE).disagree, 'Signals disagree — desk active; the laptop agent can’t be seen.');
  assert.equal(M.presence(live({ life: null, context: { ...live().context, place: { known: false } } }), IDLE).line1, 'Nick · location unknown');
});

test('the page-activity signal is memory-only and not a state engine', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  const hook = src.slice(src.indexOf('function useLocalActivity'), src.indexOf('export default function SaimHome'));
  assert.ok(hook.length > 200, 'positive control: the hook was found');
  assert.doesNotMatch(hook, /localStorage|sessionStorage|indexedDB|apiFetch|fetch\(/);
});

// ── 4. Known thread, tools ──────────────────────────────────────────────────

test('known step, a different declared app: Next, Best next place, Open — lifecycle reported', () => {
  const sess = STEP('Draft three refresher headings');
  const t = M.currentThread(live(), sess, ACTIVE);
  assert.equal(t.uncertain, null);
  const tools = M.toolHandoff(live(), t);
  assert.equal(tools.top.id, 'claude');
  const html = text(render({ data: live(), session: sess, ...ACTIVE, onDeskOpen: () => {}, onToggleMore: () => {} }));
  assert.match(html, /Next Draft three refresher headings/);
  assert.match(html, /Best next place Claude Open Claude/);
  assert.match(html, /Other ways in ChatGPT Music Outlook Teams Obsidian More available apps \(10\)/, 'AI, Music, three more, the rest folded');
  for (const [state, said] of [['waiting', 'waiting for the laptop'], ['claimed', 'the laptop has taken it'], ['opened', 'opened'], ['failed', 'failed'], ['expired', 'expired']]) {
    const h = strip(render({ data: live(), session: sess, ...ACTIVE, onDeskOpen: () => {}, deskStates: { claude: state } }));
    assert.ok(h.includes(said), state);
    if (state === 'waiting' || state === 'claimed') assert.match(h, /<button[^>]*disabled=""[^>]*>Open Claude<\/button>/);
  }
});

test('known step, the app it needs is already open: said, a continuation, no redundant Open, no grid', () => {
  const sess = STEP('Fix the failing test suite');
  const tools = M.toolHandoff(live(), M.currentThread(live(), sess, ACTIVE));
  assert.equal(tools.top, null);
  assert.equal(tools.already.id, 'code');
  const html = strip(render({ data: live(), session: sess, ...ACTIVE, onDeskOpen: () => {}, onToggleHelp: () => {} }));
  assert.match(text(html), /You’re already in VS Code\. Carry on there\./);
  assert.doesNotMatch(html, /alt-tool__primary|>Open VS Code</);
  assert.doesNotMatch(html, /alt-ways/);
});

test('alternatives only after a recommendation or an explicit request', () => {
  const d = live({ primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Reply to Chris' } });
  assert.equal(M.toolHandoff(d, M.currentThread(d)).top, null, 'no step, no recommendation');
  assert.doesNotMatch(strip(render({ data: d, ...ACTIVE, onDeskOpen: () => {}, onToggleHelp: () => {} })), /alt-ways/);
  const asked = strip(render({ data: d, ...ACTIVE, onDeskOpen: () => {}, onToggleHelp: () => {}, helpOpen: true }));
  assert.match(asked, /Ways in/);
  assert.ok(!asked.includes('>VS Code<'), 'never the app already in front');
  assert.equal(M.toolHandoff(d, M.currentThread(d, STEP('Send the reply'))).top.id, 'outlook');
});

test('no recommendation is invented: step names no tool, tool not declared, laptop unseen', () => {
  assert.equal(M.toolHandoff(live(), M.currentThread(live(), STEP('Ring the garage'))).top, null);
  const one = live({ work: { ...live().work, deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'music', label: 'Music' }] } } });
  assert.equal(M.toolHandoff(one, M.currentThread(one, STEP('Draft three refresher headings'))).top, null);
  const unseen = live({ work: { deskKnown: false } });
  const html = strip(render({ data: unseen, session: STEP('Draft headings'), ...ACTIVE, onDeskOpen: () => {} }));
  assert.match(html, /Nothing to open — I can’t see your laptop\./);
  assert.doesNotMatch(html, /alt-tool__(primary|btn)/);
  const silent = live({ work: { ...live().work, deskOffer: { known: false, host: 'H', apps: [], why: 'that machine hasn’t said what it can open' } } });
  assert.equal(M.toolHandoff(silent, M.currentThread(silent, STEP('x'))).blockedWhy, 'that machine hasn’t said what it can open');
  assert.doesNotMatch(strip(render({ data: live(), session: STEP('Draft three refresher headings'), ...ACTIVE, onDeskOpen: null })), /<button[^>]*alt-tool__/);
});

test('an attention item is the thread, verbatim, with the server’s lifecycle sentences', () => {
  const d = live({
    primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Chris is waiting on a reply', reason: 'Raised in the 1-2-1' },
    utterances: [{ say: 'That’s done', intent: { kind: 'act', action: 'complete', recordId: 7 } }, { say: 'Show me everything', intent: { kind: 'reveal' } }],
  });
  const t = M.currentThread(d);
  assert.deepEqual([t.state, t.item.title, t.item.sub, t.item.reason, t.uncertain], ['item', 'Chris is waiting on a reply', 'Reply to Chris', 'Raised in the 1-2-1', null]);
  const html = text(render({ data: d, onAct: () => {} }));
  assert.match(html, /That’s done/);
  assert.doesNotMatch(html, /Show me everything/);
});

test('"Bring work back" asks NEURO via life-declare and never queues a desktop intent', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  const start = src.indexOf('async function bringWork');
  const body = src.slice(start, src.indexOf('\n  return (', start));
  assert.ok(start > 0 && body.length > 100);
  assert.doesNotMatch(body, /desktop\/intents|deskOpen|session\/(start|next-step)/);
  assert.match(body, /signals\/life\/declare/);
});

// ── 5. The rail: only what holds something ──────────────────────────────────

test('settled thread with nothing waiting: no rail at all', () => {
  const d = live({ primary: { kind: 'item', type: 'todo', title: 'Finish the KPI pack', say: 'Finish the KPI pack' }, dropped: [], life: { doing: 'working', showWork: true, place: { kind: 'home' } } });
  const html = strip(render({ data: d, ...ACTIVE }));
  assert.doesNotMatch(html, /alt-rail/);
  assert.match(html, /alt-grid alt-grid--solo/);
});

test('rail sections appear only with content; evidence only when it helps', () => {
  const two = text(render({ data: live({ approvals: { known: true, needsApproval: 2, needsReview: 0, say: '2 emails wait for your approval.' } }), ...ACTIVE, neuroUrl: 'https://pi5.example' }));
  assert.match(two, /Needs your judgement 2 emails wait for your approval\. Review in NEURO →/);
  assert.doesNotMatch(strip(render({ data: live({ approvals: { known: true, needsApproval: 2 } }) })), /<button[^>]*>\s*(Approve|Send|Execute)\b/i);
  assert.doesNotMatch(text(render({ data: live(), ...ACTIVE })), /Needs your judgement/);
  assert.match(text(render({ data: live({ nextMeeting: { subject: 'KPI review', time: '15:30' } }), ...ACTIVE })), /Next “KPI review” at 15:30\./);
  // Uncertain context → evidence helps; it is concise and kind-separated.
  const ev = M.evidence(live(), M.currentThread(live(), null, ACTIVE), M.presence(live(), ACTIVE));
  assert.deepEqual(ev.lines, ['Desk active · VS Code open.', 'Watch last heard in the living room.', 'Work context held.']);
  const known = live({ primary: { kind: 'item', type: 'todo', title: 'x', say: 'x' } });
  assert.equal(M.evidence(known, M.currentThread(known), M.presence(known, ACTIVE)), null, 'a known thread needs no evidence');
  const gaps = live({ primary: { kind: 'item', type: 'todo', title: 'x', say: 'x' }, gaps: [{ input: 'calendar', why: 'Graph 401' }] });
  assert.deepEqual(M.evidence(gaps, M.currentThread(gaps), M.presence(gaps, ACTIVE)).gaps, ['calendar — Graph 401']);
});

test('the calm state drives the field BLUE through the existing drive; pressure still wins', async () => {
  const fd = await import(`file://${path.join(SHARED_UI, 'fieldDrive.mjs').replace(/\\/g, '/')}`);
  const calm = M.driveFrom(live(), fd.isPressing);
  assert.equal(calm.quiet, true);
  const [r, , b] = fd.colour(fd.drive(calm).intensity);
  assert.ok(b > r);
  const pressing = M.driveFrom(live({ primary: { kind: 'item', urgency: 'critical', title: 'x' } }), fd.isPressing);
  assert.equal(fd.surfaceRgb(pressing), fd.rgbText(fd.HOT));
});

// ── 6. Held work ────────────────────────────────────────────────────────────

test('held work: compact line + Show; expanding changes nothing else', () => {
  assert.equal(M.heldWork(live()).line, '4 work items are held while you’re on your own project.');
  const d = deepFreeze(live());
  const before = JSON.stringify(d);
  const closed = strip(render({ data: d, ...ACTIVE, onToggleHeld: () => {}, heldOpen: false }));
  const open = strip(render({ data: d, ...ACTIVE, onToggleHeld: () => {}, heldOpen: true }));
  assert.equal(JSON.stringify(d), before, 'canonical payload untouched');
  assert.match(closed, />Show held work</);
  assert.doesNotMatch(closed, /alt-held__list/);
  assert.match(open, /alt-held__list/);
  const norm = (h) => h.replace(/<ul class="alt-held__list">[\s\S]*?<\/ul>/, '').replace(/aria-expanded="(true|false)"/g, '').replace(/(Show|Hide) held work/, '');
  assert.equal(norm(open), norm(closed));
  assert.deepEqual(M.heldWork(d).items.map((i) => i.type), ['todo', 'capacity', 'meeting', 'email']);
  assert.ok(M.heldWork(d).items.every((i) => !/AAMk/.test(i.label)));
});

test('the folds are local UI state: no write is wired to any of them', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  for (const name of ['onToggleHeld', 'onToggleHelp', 'onToggleMore']) {
    const m = src.match(new RegExp(`${name}=\\{([^}]*)\\}`));
    assert.ok(m, `${name} is wired`);
    assert.doesNotMatch(m[1], /apiFetch|fetch\(/);
  }
});

// ── 5. Bottom navigation still works ────────────────────────────────────────

test('all five bar buttons call the navigator with their own id', () => {
  const src = fs.readFileSync(path.join(ALT, 'AltShell.jsx'), 'utf8');
  assert.match(src, /ALT_TABS\.map\(\(t\) =>/);
  assert.match(src, /onClick=\{\(\) => onGo && onGo\(t\.id\)\}/);
  for (const id of M.ALT_TAB_IDS) assert.equal(M.resolveAltTab(id).tab, id);
});

test('the shell mounts the control’s Field, full-screen, with the drive passed through untouched', () => {
  const drive = { activity: 'off', confidenceLevel: 'high', quiet: true, degraded: false, pressing: false };
  const html = renderToString(React.createElement(Shell, { active: 'saim', drive }));
  const m = html.match(/data-field="([^"]*)"/);
  assert.deepEqual(JSON.parse(m[1].replace(/&quot;/g, '"')), drive);
  assert.match(html, /class="app__field alt-app__field"/);
  const src = fs.readFileSync(path.join(ALT, 'AltShell.jsx'), 'utf8');
  assert.match(src, /import Field from '\.\.\/\.\.\/shared-ui\/Field'/);
  assert.match(src, /import \{ surfaceRgb \} from '\.\.\/\.\.\/shared-ui\/fieldDrive\.mjs'/);
});

test('driveFrom produces exactly the shape useFieldDrive produces', () => {
  const hook = fs.readFileSync(path.join(SHARED_UI, 'useFieldDrive.js'), 'utf8');
  const keys = [...hook.match(/setDrive\(\{([\s\S]*?)\}\);/)[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]).sort();
  assert.ok(keys.length >= 5);
  assert.deepEqual(Object.keys(M.driveFrom(live(), () => false)).sort(), keys);
  assert.equal(M.driveFrom(null).degraded, true);
});

test('no alt file defines a colour system or draws a field of its own', () => {
  for (const f of fs.readdirSync(ALT).filter((x) => /\.(css|jsx|mjs)$/.test(x))) {
    const src = fs.readFileSync(path.join(ALT, f), 'utf8');
    assert.doesNotMatch(src, /<canvas|getContext\(/, f);
    if (f.endsWith('.mjs')) assert.doesNotMatch(src, /\b(COLD|MID|HOT)\s*=|rgbText|colour\(/, `${f} must not define colours`);
  }
});

// ── Isolation from the control ──────────────────────────────────────────────

test('nothing the control builds can reach the alt code', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const sources = [...walk(path.join(APP, 'src')), ...walk(SHARED_UI)].filter((f) => /\.(m?jsx?|cjs)$/.test(f));
  assert.ok(sources.length > 20);
  for (const f of sources) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from ['"][^'"]*\/alt\//, f);
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt/i);
});

test('the alt env carries no secret and only its own hosts', () => {
  const lines = fs.readFileSync(path.join(APP, '.env.alt'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length >= 4);
  assert.ok(!lines.some((l) => /VAULT|TOKEN|SECRET|PIN|KEY/.test(l.split('=')[0])));
  const hosts = lines.find((l) => l.startsWith('VITE_ALLOWED_HOSTS=')).split('=')[1].split(',');
  assert.ok(hosts.includes('saim-alt.nickward.co.uk'));
  assert.ok(!hosts.some((h) => /^(saim|sara)\.nickward\.co\.uk$|^saim-nickward\.netlify\.app$/.test(h)));
});
