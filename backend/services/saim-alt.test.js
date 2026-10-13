/**
 * SAiM Alt — the A/B treatment shell (saim-alt.nickward.co.uk).
 *
 * Pins what the briefs made non-negotiable:
 *   1. NAVIGATION: a persistent bottom bar with exactly five destinations, the
 *      control's icons, SAiM selected by default, nothing else reachable.
 *   2. THE CALM STATE is described honestly (own project, work held, next step
 *      unknown), offers moves that queue NO desktop intent, recommends NO tool,
 *      never offers the app already in front, and drives the field BLUE through
 *      the existing drive — pressure still wins.
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

test('calm personal project: the situation is described, not dressed as a task', () => {
  const t = M.currentThread(live());
  assert.equal(t.state, 'context');
  assert.equal(t.item.title, 'You’re in your own project.');
  assert.equal(t.item.sub, 'I’m holding work while you’re here.');
  assert.equal(t.situation, 'VS Code is already open. I don’t yet know the next step.');
  assert.deepEqual(t.moves.map((m) => m.label), ['Keep working here', 'Name the next step', 'Return to work']);
  const h = text(render({ data: live(), onMove: () => {}, onDeskOpen: () => {} }));
  for (const s of ['You’re in your own project.', 'I’m holding work while you’re here.', 'VS Code is already open. I don’t yet know the next step.', 'Keep working here', 'Name the next step', 'Return to work']) {
    assert.ok(h.includes(s), s);
  }
});

test('calm, no step: NO recommendation, no Open button, and never the app already in front', () => {
  const t = M.toolHandoff(live(), M.currentThread(live()));
  assert.equal(t.mode, 'browse');
  assert.equal(t.top, null);
  assert.equal(t.already, null);
  assert.ok(!t.row.concat(t.more).some((a) => a.id === 'code'), 'VS Code is in front, so it is not offered');
  const html = strip(render({ data: live(), onDeskOpen: () => {}, onMove: () => {}, onToggleMore: () => {} }));
  assert.doesNotMatch(html, /alt-tool__primary/);
  assert.doesNotMatch(html, /Best next place/);
  assert.doesNotMatch(html, />Open /);
  assert.match(html, /Or open/);
});

test('"Keep working here" queues no desktop intent: the moves never reach onDeskOpen', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  const body = src.slice(src.indexOf('async function onMove'), src.indexOf('return (', src.indexOf('async function onMove')));
  assert.ok(body.length > 50, 'positive control: onMove was found');
  assert.doesNotMatch(body, /desktop\/intents|deskOpen/);
  assert.match(body, /signals\/life\/declare/);
  // And the view wires moves to onMove only.
  const calls = [];
  const html = render({ data: live(), onMove: (m) => calls.push(m.id), onDeskOpen: () => calls.push('DESK') });
  assert.match(html, /Keep working here/);
  assert.deepEqual(calls, [], 'rendering presses nothing');
  const keep = M.currentThread(live()).moves.find((m) => m.id === 'keep');
  assert.equal(keep.doing, 'hobby', 'it confirms what NEURO already reads, nothing invented');
});

test('the calm state drives the field BLUE through the existing drive; pressure still wins', async () => {
  const fd = await import(`file://${path.join(SHARED_UI, 'fieldDrive.mjs').replace(/\\/g, '/')}`);
  const calm = M.driveFrom(live(), fd.isPressing);
  assert.equal(calm.quiet, true);
  const [r, , b] = fd.colour(fd.drive(calm).intensity);
  assert.ok(b > r, `calm is blue (rgb ${fd.surfaceRgb(calm)})`);
  // The control's mapping for the same read is the orange this fixes.
  assert.equal(fd.surfaceRgb({ ...calm, quiet: false }), '240,134,60');
  // Real pressure is never calmed.
  const pressing = M.driveFrom(live({ primary: { kind: 'item', urgency: 'critical', title: 'x' } }), fd.isPressing);
  assert.equal(pressing.pressing, true);
  assert.equal(pressing.quiet, false);
  assert.equal(fd.surfaceRgb(pressing), fd.rgbText(fd.HOT));
  // Not calm by NEURO's word → the control's mapping, unchanged.
  assert.equal(M.driveFrom(live({ situation: { calm: false } }), fd.isPressing).quiet, false);
  assert.equal(M.driveFrom(live({ poolAvailable: false })).degraded, true);
});

test('held work is said as held, not failed or hidden', () => {
  const h = M.heldWork(live());
  assert.equal(h.line, '4 work items are held while you’re on your own project.');
  assert.equal(M.heldWork(live({ life: { doing: 'working', showWork: true } })).line, '4 items are held: not working — on a project of your own.');
  assert.equal(M.heldWork(live({ dropped: [live().dropped[0]] })).line, '1 work item is held while you’re on your own project.');
  assert.match(text(render({ data: live(), onToggleHeld: () => {} })), /4 work items are held while you’re on your own project\. Show held work/);
});

// ── 3. A known next step ────────────────────────────────────────────────────

test('known step, different available app: Next, Best next place, Open — and the lifecycle is reported', () => {
  const sess = STEP('Draft three refresher headings');
  const t = M.currentThread(live(), sess);
  assert.deepEqual(t.nextStep, { known: true, text: 'Draft three refresher headings' });
  assert.equal(t.situation, null);
  assert.ok(!t.moves.some((m) => m.id === 'name'), 'no "name the step" once it is named');
  const tools = M.toolHandoff(live(), t);
  assert.equal(tools.mode, 'step');
  assert.equal(tools.top.id, 'claude');
  assert.ok(!tools.row.some((a) => a.id === 'claude'), 'not offered twice');
  const html = text(render({ data: live(), session: sess, onDeskOpen: () => {} }));
  assert.match(html, /Next Draft three refresher headings/);
  assert.match(html, /Best next place Claude Open Claude/);
  for (const [state, said] of [['waiting', 'waiting for the laptop'], ['claimed', 'the laptop has taken it'], ['opened', 'opened'], ['failed', 'failed'], ['expired', 'expired']]) {
    const h = strip(render({ data: live(), session: sess, onDeskOpen: () => {}, deskStates: { claude: state } }));
    assert.ok(h.includes(said), state);
    if (state === 'waiting' || state === 'claimed') assert.match(h, /<button[^>]*disabled=""[^>]*>Open Claude<\/button>/, `${state} cannot be re-pressed`);
  }
  assert.equal(M.deskStateText('done'), null);
});

test('known step, the app it needs is ALREADY in front: said, no redundant Open', () => {
  const sess = STEP('Fix the failing test suite');
  const tools = M.toolHandoff(live(), M.currentThread(live(), sess));
  assert.equal(tools.top, null);
  assert.equal(tools.already.id, 'code');
  const html = strip(render({ data: live(), session: sess, onDeskOpen: () => {} }));
  assert.match(html, /You’re already in VS Code\./);
  assert.doesNotMatch(html, /alt-tool__primary/);
  assert.doesNotMatch(html, />Open VS Code</);
});

test('an item that points at a tool still gets NO recommendation until a step is named', () => {
  const d = live({ primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Reply to Chris' } });
  const none = M.toolHandoff(d, M.currentThread(d));
  assert.equal(none.mode, 'browse');
  assert.equal(none.top, null);
  const named = M.toolHandoff(d, M.currentThread(d, STEP('Send the reply')));
  assert.equal(named.top.id, 'outlook', 'once there is a step, the card kind can point the way');
});

test('known step that names no tool: no recommendation is invented', () => {
  const tools = M.toolHandoff(live(), M.currentThread(live(), STEP('Ring the garage')));
  assert.equal(tools.mode, 'step');
  assert.equal(tools.top, null);
  assert.equal(tools.already, null);
});

test('known step, recommended app not declared by the laptop: no Open button', () => {
  const d = live({ work: { ...live().work, deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'music', label: 'Music' }] } } });
  const tools = M.toolHandoff(d, M.currentThread(d, STEP('Draft three refresher headings')));
  assert.equal(tools.top, null, 'Claude is not declared, so it cannot be the top');
  const html = text(render({ data: d, session: STEP('Draft three refresher headings'), onDeskOpen: () => {} }));
  assert.match(html, /AI — no AI tool set up on the laptop/);
  assert.doesNotMatch(strip(render({ data: d, session: STEP('Draft three refresher headings'), onDeskOpen: () => {} })), /<button[^>]*>AI<\/button>/);
});

test('the row: one AI tool, Music, three more — the rest folded — no app twice', () => {
  const t = M.toolHandoff(live(), M.currentThread(live()));
  assert.equal(t.row[0].id, 'claude');
  assert.equal(t.row[1].id, 'music');
  assert.equal(t.row.length, 5);
  const all = [...t.row, ...t.more].map((a) => a.id);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...all, 'code'].sort(), APPS17.map((a) => a.id).sort(), 'every declared app except the one in front');
});

// ── 4. Unknown room, unseen desk, unavailable agent, no thread ──────────────

test('presence: Nick · Home from the life read; a room alone never places him', () => {
  assert.equal(M.presence(live()).line1, 'Nick · Home');
  assert.equal(M.presence(live({ life: null })).line1, 'Nick · location unknown');
  assert.equal(M.presence(live({ context: { ...live().context, place: { known: true, name: 'Office' } } })).line1, 'Nick · Office');
  const html = text(render({ data: live() }));
  assert.doesNotMatch(html, /Nick · [^.]*living room/i);
  assert.doesNotMatch(html, /living-room/, 'no raw sensor slug');
});

test('evidence trail keeps desk, watch, location and held apart', () => {
  assert.deepEqual(M.evidence(live()).lines.map((l) => l.text), ['Desk active · VS Code open', 'Watch heard in the living room', 'Work context held']);
  const unknown = M.evidence(live({ life: null, context: { ...live().context, place: { known: false } }, work: { deskKnown: false } }));
  assert.deepEqual(unknown.lines.map((l) => l.text), ['Laptop not seen', 'Location unknown']);
  assert.ok(unknown.lines.every((l) => l.unknown));
  assert.deepEqual(M.evidence(live({ work: { ...live().work, atDesk: false } })).lines[0].text, 'Away from the laptop');
  assert.equal(M.evidence(live({ context: { ...live().context, place: { known: true, room: 'study' } } })).lines[1].text, 'A device heard in the study');
  const gaps = M.evidence(live({ gaps: [{ input: 'calendar', why: 'Graph 401' }] }));
  assert.deepEqual(gaps.gaps, ['calendar — Graph 401']);
  assert.match(text(render({ data: live({ gaps: [{ input: 'calendar', why: 'Graph 401' }] }) })), /Can’t read: calendar — Graph 401/);
});

test('unseen desk: no app claimed, nothing to open', () => {
  const d = live({ work: { deskKnown: false } });
  const t = M.currentThread(d);
  assert.equal(t.situation, 'I don’t yet know the next step.');
  assert.equal(M.toolHandoff(d, t).blockedWhy, 'I can’t see your laptop');
  const html = strip(render({ data: d, onDeskOpen: () => {} }));
  assert.match(html, /Nothing to open — I can’t see your laptop\./);
  assert.doesNotMatch(html, /alt-tool__(primary|btn)/);
});

test('unavailable agent (never declared) and away from the laptop: nothing pressable, the server’s reason', () => {
  const silent = live({ work: { ...live().work, deskOffer: { known: false, host: 'H', apps: [], why: 'that machine hasn’t said what it can open' } } });
  assert.equal(M.toolHandoff(silent, M.currentThread(silent)).blockedWhy, 'that machine hasn’t said what it can open');
  const away = live({ work: { ...live().work, atDesk: false, deskOffer: { known: true, host: 'H', apps: [], why: 'you’re not at the laptop' } } });
  assert.equal(M.toolHandoff(away, M.currentThread(away, STEP('Draft headings'))).top, null);
  // A screen that cannot reach the queue shows names, not buttons.
  const html = strip(render({ data: live(), session: STEP('Draft three refresher headings'), onDeskOpen: null }));
  assert.doesNotMatch(html, /<button[^>]*alt-tool__/);
  assert.match(html, /can’t reach the laptop/);
});

test('no recoverable thread: the honest sentence, and nothing invented', () => {
  for (const d of [
    live({ context: { ...live().context, activity: 'unknown' }, primary: { kind: 'context', title: 'Can’t tell', say: 'Can’t tell · living-room' } }),
    live({ primary: null }),
  ]) {
    const t = M.currentThread(d);
    assert.equal(t.state, 'unknown');
    assert.equal(t.item, null);
    const html = text(render({ data: d, onMove: () => {} }));
    assert.match(html, /I can’t recover the thread from what I can see\./);
    assert.match(html, /Tell me what you were doing, or capture the next thing\./);
    assert.doesNotMatch(html, /Can’t tell/);
    assert.ok(!t.moves.some((m) => m.id === 'keep'), 'nothing to "keep" when the context is unknown');
  }
});

test('an attention item is the thread, verbatim, with the server’s lifecycle sentences', () => {
  const d = live({
    primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Chris is waiting on a reply', reason: 'Raised in the 1-2-1' },
    utterances: [{ say: 'That’s done', intent: { kind: 'act', action: 'complete', recordId: 7 } }, { say: 'Show me everything', intent: { kind: 'reveal' } }],
  });
  const t = M.currentThread(d);
  assert.deepEqual([t.state, t.item.title, t.item.sub, t.item.reason], ['item', 'Chris is waiting on a reply', 'Reply to Chris', 'Raised in the 1-2-1']);
  assert.deepEqual(t.moves, []);
  const html = text(render({ data: d, onAct: () => {} }));
  assert.match(html, /That’s done/);
  assert.doesNotMatch(html, /Show me everything/);
});

test('the three silences stay distinct; blind is never good news', () => {
  assert.equal(M.silence({ poolAvailable: false, primary: null }).kind, 'blind');
  assert.equal(M.silence({ poolAvailable: true, primary: null, quiet: true }).kind, 'quiet');
  assert.equal(M.silence({ poolAvailable: true, primary: null, quiet: false }).kind, 'clear');
  assert.match(text(render({ data: live({ poolAvailable: false, primary: null }) })), /isn’t an all-clear/);
});

test('no read at all says NEURO is unreachable, and the dock stays', () => {
  const html = strip(render({ data: null, error: 'Failed to fetch', dock: React.createElement('i', { id: 'dock' }) }));
  assert.match(html, /can’t reach NEURO — Failed to fetch/);
  assert.match(html, /id="dock"/);
});

// ── The rail ────────────────────────────────────────────────────────────────

test('judgement: a statement and a NEURO link — never an approve control', () => {
  const two = live({ approvals: { known: true, needsApproval: 2, needsReview: 0, say: '2 emails wait for your approval.' } });
  const html = strip(render({ data: two, neuroUrl: 'https://pi5.example' }));
  assert.match(html, /2 emails wait for your approval\./);
  assert.match(html, /href="https:\/\/pi5\.example\/\?view=actions"/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Approve|Send|Execute)\b/i);
  assert.match(text(render({ data: live() })), /Nothing waiting for your judgement\./);
  assert.match(text(render({ data: live({ approvals: null }) })), /couldn’t check what’s waiting/);
});

test('next transition only when relevant', () => {
  assert.equal(M.nextChange({}), null);
  assert.doesNotMatch(strip(render({ data: live() })), /aria-label="Next transition"/);
  assert.match(text(render({ data: live({ nextMeeting: { subject: 'KPI review', time: '15:30' } }) })), /“KPI review” at 15:30\./);
});

// ── Held work: non-destructive ──────────────────────────────────────────────

test('heldWork reads the server’s order, mutates nothing and never labels by raw id', () => {
  const d = deepFreeze(live());
  const before = JSON.stringify(d);
  const h = M.heldWork(d);
  assert.equal(JSON.stringify(d), before);
  assert.deepEqual(h.items.map((i) => i.type), ['todo', 'capacity', 'meeting', 'email']);
  assert.ok(h.items.every((i) => !/AAMk/.test(i.label)));
});

test('expanding held work adds the list and changes nothing else on the page', () => {
  const d = deepFreeze(live());
  const closed = strip(render({ data: d, onToggleHeld: () => {}, heldOpen: false }));
  const open = strip(render({ data: d, onToggleHeld: () => {}, heldOpen: true }));
  assert.doesNotMatch(closed, /alt-held__list/);
  assert.match(open, /alt-held__list/);
  const norm = (h) => h.replace(/<ul class="alt-held__list">[\s\S]*?<\/ul>/, '').replace(/aria-expanded="(true|false)"/g, '').replace(/(Show|Hide) held work/, '');
  assert.equal(norm(open), norm(closed));
});

test('the folds are local UI state: no write is wired to either', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  for (const name of ['onToggleHeld', 'onToggleMore']) {
    const m = src.match(new RegExp(`${name}=\\{([^}]*)\\}`));
    assert.ok(m, `${name} is wired`);
    assert.doesNotMatch(m[1], /apiFetch|fetch\(/);
  }
});

// ── The field is the control's, unchanged ───────────────────────────────────

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
