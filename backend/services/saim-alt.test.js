/**
 * SAiM Alt — the A/B treatment shell (saim-alt.nickward.co.uk).
 *
 * Pins what the briefs made non-negotiable:
 *   1. NAVIGATION: a persistent bottom bar with exactly five destinations, the
 *      control's icons, SAiM selected by default, nothing else reachable.
 *   2. THE CALM, UNCERTAIN STATE is QUIET: a small statement over the field,
 *      two quiet links, no card, no tool chooser, no empty rail, no form, no
 *      prompts to decide; neither link queues a desktop intent; the field is
 *      BLUE through the existing drive and pressure still wins.
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

// ── 2. The calm, uncertain state: quiet ─────────────────────────────────────

test('calm uncertain state is QUIET: a small statement, two quiet links, nothing else', () => {
  const t = M.currentThread(live());
  assert.equal(t.mode, 'quiet');
  const st = M.statement(live());
  assert.deepEqual(st.lines, ['You’re home. VS Code is open.', 'I’m holding work for now.']);
  assert.deepEqual(st.qualifiers, ['Watch heard in the living room.']);
  assert.deepEqual(st.actions.map((a) => a.label), ['Tell me what you’re doing', 'Bring work back']);
  const html = strip(render({ data: live(), onQuiet: () => {}, onDeskOpen: () => {}, onToggleHeld: () => {}, onToggleHelp: () => {}, dock: React.createElement('i', { id: 'dock' }) }));
  const t2 = text(html);
  for (const s of ['You’re home. VS Code is open.', 'I’m holding work for now.', 'Watch heard in the living room.', 'Tell me what you’re doing', 'Bring work back']) assert.ok(t2.includes(s), s);
});

test('calm state shows NO card, NO tool chooser, NO empty rail, NO form, NO prompts to decide', () => {
  const html = strip(render({ data: live(), onQuiet: () => {}, onDeskOpen: () => {}, onToggleHeld: () => {}, onToggleHelp: () => {}, dock: React.createElement('i', { id: 'dock' }) }));
  for (const cls of ['alt-thread', 'alt-rail', 'alt-ways', 'alt-tool__', 'alt-place', 'alt-pill', 'alt-dock']) assert.ok(!html.includes(cls), `no ${cls}`);
  assert.doesNotMatch(html, /id="dock"/, 'the input is not open by default');
  for (const s of ['You’re in your own project', 'Name the next step', 'Keep working here', 'Return to work', 'Nothing waiting for your judgement', 'Best next place', 'Or open', 'Other ways in', 'What I can see', 'Going on', 'Nothing held back']) {
    assert.ok(!text(html).includes(s), `no "${s}"`);
  }
  // No VS Code button anywhere, and nothing about it except that it is open.
  assert.doesNotMatch(html, /<button[^>]*>[^<]*(VS Code|Claude|Music)/);
});

test('"Tell me what you’re doing" opens a compact contextual input — and only then', () => {
  const dock = React.createElement('i', { id: 'dock' });
  assert.doesNotMatch(render({ data: live(), onQuiet: () => {}, dock }), /id="dock"/);
  assert.match(render({ data: live(), onQuiet: () => {}, dock, askOpen: true }), /id="dock"/);
});

test('neither quiet action can queue a desktop intent; "Bring work back" asks NEURO and invents no step', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  const start = src.indexOf('async function onQuiet');
  const body = src.slice(start, src.indexOf('\n  return (', start));
  assert.ok(start > 0 && body.length > 100, 'positive control: onQuiet found');
  assert.doesNotMatch(body, /desktop\/intents|deskOpen|session\/(start|next-step)/);
  assert.match(body, /signals\/life\/declare/);
  assert.match(body, /doing: 'working'/);
  // After it, the page re-reads and the thread is whatever NEURO surfaces.
  const back = live({
    life: { doing: 'working', showWork: true, place: { kind: 'home' } },
    primary: { kind: 'item', type: 'todo', title: 'Finish the KPI pack', say: 'Finish the KPI pack' },
  });
  const t = M.currentThread(back);
  assert.equal(t.mode, 'thread');
  assert.equal(t.nextStep.known, false, 'no step invented');
  assert.equal(M.toolHandoff(back, t).top, null, 'and so no tool recommended');
  assert.ok(!M.statement(back).actions.some((a) => a.id === 'bring'), 'nothing to bring back once work is shown');
});

test('rail items appear only when they hold something', () => {
  const quiet = strip(render({ data: live() }));
  assert.doesNotMatch(quiet, /alt-notices/, 'no approvals, no transition → nothing');
  const waiting = text(render({ data: live({ approvals: { known: true, needsApproval: 2, needsReview: 0, say: '2 emails wait for your approval.' } }), neuroUrl: 'https://pi5.example' }));
  assert.match(waiting, /2 emails wait for your approval\. Review in NEURO →/);
  assert.doesNotMatch(strip(render({ data: live({ approvals: { known: true, needsApproval: 2, needsReview: 0 } }) })), /<button[^>]*>\s*(Approve|Send|Execute)\b/i);
  assert.match(text(render({ data: live({ nextMeeting: { subject: 'KPI review', time: '15:30' } }) })), /Next “KPI review” at 15:30\./);
  // Held is a compact link, the list only on request.
  const held = strip(render({ data: live(), onToggleHeld: () => {} }));
  assert.match(held, />Show what’s held \(4\)</);
  assert.doesNotMatch(held, /alt-held__list/);
});

test('the calm state drives the field BLUE through the existing drive; pressure still wins', async () => {
  const fd = await import(`file://${path.join(SHARED_UI, 'fieldDrive.mjs').replace(/\\/g, '/')}`);
  const calm = M.driveFrom(live(), fd.isPressing);
  assert.equal(calm.quiet, true);
  const [r, , b] = fd.colour(fd.drive(calm).intensity);
  assert.ok(b > r, `calm is blue (rgb ${fd.surfaceRgb(calm)})`);
  assert.equal(fd.surfaceRgb({ ...calm, quiet: false }), '240,134,60', 'the control’s mapping for the same read');
  const pressing = M.driveFrom(live({ primary: { kind: 'item', urgency: 'critical', title: 'x' } }), fd.isPressing);
  assert.equal(pressing.quiet, false);
  assert.equal(fd.surfaceRgb(pressing), fd.rgbText(fd.HOT));
  assert.equal(M.driveFrom(live({ situation: { calm: false } }), fd.isPressing).quiet, false);
});

test('held work is said as held, not failed or hidden', () => {
  assert.equal(M.heldWork(live()).line, '4 work items are held while you’re on your own project.');
  assert.equal(M.heldWork(live({ dropped: [live().dropped[0]] })).line, '1 work item is held while you’re on your own project.');
  assert.equal(M.heldWork(live({ life: { doing: 'working', showWork: true } })).line, '4 items are held: not working — on a project of your own.');
});

// ── 3. A known thread with a real next step ─────────────────────────────────

test('known step, different available app: Next, Best next place, Open — lifecycle reported', () => {
  const sess = STEP('Draft three refresher headings');
  const t = M.currentThread(live(), sess);
  assert.equal(t.mode, 'thread');
  assert.equal(t.item.title, 'On a project of your own', 'the context title, verbatim');
  const tools = M.toolHandoff(live(), t);
  assert.equal(tools.top.id, 'claude');
  const html = text(render({ data: live(), session: sess, onDeskOpen: () => {} }));
  assert.match(html, /Next Draft three refresher headings/);
  assert.match(html, /Best next place Claude Open Claude/);
  assert.match(html, /Other ways in/, 'alternatives follow a genuine recommendation');
  for (const [state, said] of [['waiting', 'waiting for the laptop'], ['claimed', 'the laptop has taken it'], ['opened', 'opened'], ['failed', 'failed'], ['expired', 'expired']]) {
    const h = strip(render({ data: live(), session: sess, onDeskOpen: () => {}, deskStates: { claude: state } }));
    assert.ok(h.includes(said), state);
    if (state === 'waiting' || state === 'claimed') assert.match(h, /<button[^>]*disabled=""[^>]*>Open Claude<\/button>/);
  }
  assert.equal(M.deskStateText('done'), null);
});

test('known step, the app it needs is ALREADY in front: said, no redundant Open, no chooser', () => {
  const sess = STEP('Fix the failing test suite');
  const tools = M.toolHandoff(live(), M.currentThread(live(), sess));
  assert.equal(tools.top, null);
  assert.equal(tools.already.id, 'code');
  const html = strip(render({ data: live(), session: sess, onDeskOpen: () => {}, onToggleHelp: () => {} }));
  assert.match(html, /You’re already in VS Code\./);
  assert.doesNotMatch(html, /alt-tool__primary|>Open VS Code</);
  assert.doesNotMatch(html, /alt-ways/, 'no default grid');
});

test('a thread without a step shows no tools until he asks for help', () => {
  const d = live({ primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Reply to Chris' } });
  const none = M.toolHandoff(d, M.currentThread(d));
  assert.equal(none.mode, 'browse');
  assert.equal(none.top, null);
  const closed = strip(render({ data: d, onDeskOpen: () => {}, onToggleHelp: () => {} }));
  assert.doesNotMatch(closed, /alt-ways|alt-tool__/);
  assert.match(closed, />Help me move this forward</);
  const asked = strip(render({ data: d, onDeskOpen: () => {}, onToggleHelp: () => {}, helpOpen: true }));
  assert.match(asked, /Other ways in/);
  assert.ok(!asked.includes('>VS Code<'), 'never the app already in front');
  assert.equal(M.toolHandoff(d, M.currentThread(d, STEP('Send the reply'))).top.id, 'outlook');
});

test('known step that names no tool, or a tool the laptop lacks: no recommendation invented', () => {
  assert.equal(M.toolHandoff(live(), M.currentThread(live(), STEP('Ring the garage'))).top, null);
  const d = live({ work: { ...live().work, deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'music', label: 'Music' }] } } });
  assert.equal(M.toolHandoff(d, M.currentThread(d, STEP('Draft three refresher headings'))).top, null);
});

test('the row: one AI tool, Music, three more — no app twice, never the one in front', () => {
  const t = M.toolHandoff(live(), M.currentThread(live(), STEP('Draft three refresher headings')));
  assert.deepEqual(t.row.slice(0, 2).map((a) => a.id), ['chatgpt', 'music']);
  assert.equal(t.row.length, 5);
  const all = [t.top, ...t.row, ...t.more].map((a) => a.id);
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.includes('code'));
});

// ── 4. Unknown room, unseen desk, unavailable agent, no thread ──────────────

test('a room alone never places Nick; unknown location is said', () => {
  assert.deepEqual(M.statement(live({ life: null })).lines[0], 'I can’t place you right now. VS Code is open.');
  assert.deepEqual(M.statement(live({ life: null })).qualifiers, ['Watch heard in the living room.']);
  assert.equal(M.statement(live({ context: { ...live().context, place: { known: true, name: 'unknown', room: 'study' } }, life: null })).qualifiers[0], 'A device heard in the study.');
  assert.equal(M.statement(live({ context: { ...live().context, place: { known: true, name: 'Office' } } })).lines[0], 'You’re at Office. VS Code is open.');
  const t = text(render({ data: live() }));
  assert.doesNotMatch(t, /You’re in the living room|living-room/);
});

test('unseen desk and away from the laptop are said, never an app', () => {
  assert.equal(M.statement(live({ work: { deskKnown: false } })).lines[0], 'You’re home. I can’t see the laptop.');
  assert.equal(M.statement(live({ work: { ...live().work, atDesk: false } })).lines[0], 'You’re home. You’re away from the laptop.');
  const d = live({ work: { deskKnown: false } });
  assert.equal(M.toolHandoff(d, M.currentThread(d, STEP('Draft headings'))).blockedWhy, 'I can’t see your laptop');
  const html = strip(render({ data: d, session: STEP('Draft headings'), onDeskOpen: () => {} }));
  assert.match(html, /Nothing to open — I can’t see your laptop\./);
  assert.doesNotMatch(html, /alt-tool__(primary|btn)/);
});

test('unavailable agent: nothing pressable, the server’s reason; an unreachable queue shows names only', () => {
  const silent = live({ work: { ...live().work, deskOffer: { known: false, host: 'H', apps: [], why: 'that machine hasn’t said what it can open' } } });
  assert.equal(M.toolHandoff(silent, M.currentThread(silent, STEP('Draft headings'))).blockedWhy, 'that machine hasn’t said what it can open');
  const html = strip(render({ data: live(), session: STEP('Draft three refresher headings'), onDeskOpen: null }));
  assert.doesNotMatch(html, /<button[^>]*alt-tool__/);
  assert.match(html, /can’t reach the laptop/);
});

test('NEURO cannot read the context: quiet and honest, no thread invented', () => {
  const d = live({ context: { ...live().context, activity: 'unknown' }, life: null, primary: { kind: 'context', title: 'Can’t tell', say: 'Can’t tell · living-room' } });
  assert.equal(M.currentThread(d).mode, 'quiet');
  const st = M.statement(d);
  assert.deepEqual(st.lines, ['I can’t place you right now. VS Code is open.', 'I’m not sure what you’re doing.']);
  assert.ok(!st.actions.some((a) => a.id === 'bring'), 'no work is held, so nothing to bring back');
  assert.doesNotMatch(text(render({ data: d })), /Can’t tell/);
  const gaps = M.statement(live({ gaps: [{ input: 'calendar', why: 'Graph 401' }] }));
  assert.ok(gaps.qualifiers.includes('Can’t read: calendar — Graph 401.'));
});

test('blind: never good news, even when quiet', () => {
  const st = M.statement(live({ poolAvailable: false, primary: null }));
  assert.match(st.lines[1], /isn’t an all-clear/);
});

test('an attention item is the thread, verbatim, with the server’s lifecycle sentences', () => {
  const d = live({
    primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Chris is waiting on a reply', reason: 'Raised in the 1-2-1' },
    utterances: [{ say: 'That’s done', intent: { kind: 'act', action: 'complete', recordId: 7 } }, { say: 'Show me everything', intent: { kind: 'reveal' } }],
  });
  const t = M.currentThread(d);
  assert.deepEqual([t.mode, t.item.title, t.item.sub, t.item.reason], ['thread', 'Chris is waiting on a reply', 'Reply to Chris', 'Raised in the 1-2-1']);
  const html = text(render({ data: d, onAct: () => {} }));
  assert.match(html, /That’s done/);
  assert.doesNotMatch(html, /Show me everything/);
});

test('no read at all says NEURO is unreachable, quietly', () => {
  assert.match(text(render({ data: null, error: 'Failed to fetch' })), /I can’t reach NEURO — Failed to fetch\./);
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
  const closed = strip(render({ data: d, onToggleHeld: () => {}, onQuiet: () => {}, heldOpen: false }));
  const open = strip(render({ data: d, onToggleHeld: () => {}, onQuiet: () => {}, heldOpen: true }));
  assert.doesNotMatch(closed, /alt-held__list/);
  assert.match(open, /alt-held__list/);
  const norm = (h) => h.replace(/<ul class="alt-held__list">[\s\S]*?<\/ul>/, '').replace(/aria-expanded="(true|false)"/g, '').replace(/(Show what’s held \(\d+\)|Hide what’s held)/, '');
  assert.equal(norm(open), norm(closed));
});

test('the folds are local UI state: no write is wired to any of them', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  for (const name of ['onToggleHeld', 'onToggleHelp']) {
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
