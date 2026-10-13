/**
 * SAiM Alt — the A/B treatment shell (saim-alt.nickward.co.uk).
 *
 * Pins what the brief made non-negotiable:
 *   1. NAVIGATION: a persistent bottom bar with exactly five destinations, the
 *      control's icons, SAiM selected by default, nothing else reachable.
 *   2. PRESENCE: a human line from real signals; unknown place, unseen desk and
 *      an unrecoverable thread are each SAID; a room is never claimed for Nick.
 *   3. TOOLS: one recommended app inside the thread card, then one AI tool,
 *      Music, up to three context apps and the rest folded — only declared apps
 *      are buttons, and the desk lifecycle is the server's word.
 *   4. HELD WORK expands without reranking or touching canonical state.
 *   5. THE FIELD is the control's, unchanged.
 * …plus that the control build cannot see any of it.
 *
 * The pure rules are tested on `saim/app/alt/model.mjs`; the page and the shell
 * are bundled with esbuild and REALLY rendered.
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

// Shaped like the live /api/canonical/now read of 13 Oct 2026, 19:03: an
// evening at home, watch heard in the living room, VS Code in front.
function live(over = {}) {
  return {
    generatedAt: '2026-10-13T18:03:39.000Z',
    poolAvailable: true,
    quiet: false,
    context: {
      activity: 'off',
      place: { known: true, name: 'unknown', source: 'owntracks', room: 'living-room', roomSubject: 'watch', roomWhy: null },
      confidence: { level: 'high', rationale: 'Every input answered and they agree.' },
      unknowns: [], cannotSee: null,
    },
    life: { place: { kind: 'home', label: 'living-room' }, evidence: ['VS Code is in front of you outside working hours, with no work app'] },
    operation: { phase: 'standing_by', label: 'STANDING BY', detail: null },
    primary: { kind: 'context', id: 'context-off', title: 'On a project of your own', reason: 'On a project of your own · living-room', say: 'On a project of your own · living-room', actions: [] },
    work: {
      known: true, kind: 'app', task: null, app: 'Code', atDesk: true, deskKnown: true, host: 'DESKTOP-8LGF9RR',
      why: 'you are at the laptop in Code — which says nothing about which task',
      deskOffer: { known: true, host: 'DESKTOP-8LGF9RR', why: null, apps: APPS17 },
    },
    dropped: [
      { id: 'todo-overdue-summary', type: 'todo', why: 'not a working day' },
      { id: 'cal-AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWQyNmMzN2UyMTBmOQBGAAAAAAA7R6hC4', type: 'meeting', why: 'not a working day' },
      { id: 'email-urgent', type: 'email', why: 'unread email waits' },
    ],
    approvals: { known: true, needsApproval: 2, needsReview: 0, where: 'Actions, in NEURO on the desktop', say: '2 emails wait for your approval.' },
    transition: null,
    nextMeeting: null,
    gaps: [],
    utterances: [
      { say: 'That’s done', intent: { kind: 'act', action: 'complete', recordId: 7 } },
      { say: 'Not now', intent: { kind: 'act', action: 'defer', recordId: 7, minutes: 60, reason: 'not-now' } },
      { say: 'Capture a thought', intent: { kind: 'navigate', tab: 'capture' } },
      { say: 'Show me everything', intent: { kind: 'reveal' } },
    ],
    ...over,
  };
}

const render = (props) => renderToString(React.createElement(View, props));
const strip = (h) => h.replace(/<!-- -->/g, '');

// ── 1. Bottom navigation ────────────────────────────────────────────────────

test('exactly five destinations, in order, with the control’s icons', () => {
  assert.deepEqual([...M.ALT_TAB_IDS], ['saim', 'now', 'review', 'capture', 'controls']);
  assert.deepEqual(M.ALT_TABS.map((t) => t.label), ['SAiM', 'Now', 'Review', 'Capture', 'Controls']);
  // The icons are the control registry's own, read from its source.
  const reg = fs.readFileSync(path.join(SHARED_UI, 'tabs.jsx'), 'utf8');
  const iconOf = (id) => (reg.match(new RegExp(`id: '${id}', label: '[^']*', icon: '([^']+)'`)) || [])[1];
  assert.equal(M.ALT_TABS[0].icon, iconOf('surface'));
  for (const id of ['now', 'review', 'capture', 'controls']) assert.equal(M.ALT_TABS.find((t) => t.id === id).icon, iconOf(id), id);
  assert.equal(M.ALT_DEFAULT_TAB, 'saim');
});

test('the bar: tagline left, five icon buttons centre, updated time right — and nothing else to navigate to', () => {
  const html = strip(renderToString(React.createElement(Shell, { active: 'saim', drive: { degraded: false }, updatedAt: '2026-10-13T18:03:00.000Z', onGo: () => {} })));
  const bar = html.slice(html.indexOf('<footer class="alt-bar"'));
  assert.match(bar, /SAiM stays with the thread\. NEURO holds the detail\./);
  const tabs = [...bar.matchAll(/<button[^>]*class="alt-bar__tab[^"]*"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(tabs.length, 5, 'exactly five buttons');
  assert.deepEqual(tabs.map((m) => m[1].replace(/<[^>]+>/g, '')), ['✦SAiM', '◉Now', '◐Review', '➕Capture', '⚙Controls']);
  assert.match(tabs[0][0], /is-on/);
  assert.match(tabs[0][0], /aria-current="page"/);
  assert.equal((bar.match(/is-on/g) || []).length, 1);
  assert.match(bar, /class="alt-bar__updated"[^>]*>Updated \d\d:\d\d</);
  // No top-centred nav, and no other <nav> anywhere.
  assert.equal((html.match(/<nav/g) || []).length, 1);
  assert.doesNotMatch(html, /alt-app__nav|alt-app__tab/);
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
});

test('the shell never imports the control’s tab registry or its other screens', () => {
  for (const f of ['AltApp.jsx', 'AltShell.jsx', 'SaimHome.jsx']) {
    const src = fs.readFileSync(path.join(ALT, f), 'utf8');
    assert.doesNotMatch(src, /shared-ui\/tabs/, `${f}`);
    assert.doesNotMatch(src, /views\/(Tasks|Chat|MeetingPrep|Standup|Household|Surface)/, `${f}`);
  }
  assert.match(fs.readFileSync(path.join(ALT, 'AltApp.jsx'), 'utf8'), /resolveAltTab\(/);
});

test('updated time: local HH:MM, or said to be unread', () => {
  assert.match(M.updatedLabel('2026-10-13T18:03:39.000Z'), /^Updated \d\d:\d\d$/);
  assert.equal(M.updatedLabel(null), null);
  assert.equal(M.updatedLabel('nonsense'), null);
  const html = renderToString(React.createElement(Shell, { active: 'saim', drive: {}, updatedAt: null }));
  assert.match(html, /Not read yet/);
});

// ── 2. Presence and the unknown states ─────────────────────────────────────

test('presence is a human line, and a room is the WATCH’s, never Nick’s', () => {
  const p = M.presence(live());
  assert.equal(p.line1, 'Nick · Home');
  assert.equal(p.line2, 'desk seen · VS Code open · standing by');
  assert.equal(p.device, 'watch heard in the living room');
  const html = strip(render({ data: live() }));
  assert.doesNotMatch(html, /living-room/, 'no raw sensor slug on screen');
  assert.doesNotMatch(html, /DESKTOP-8LGF9RR · /, 'no raw host as a presence fact');
  assert.doesNotMatch(html, /Nick · [^<]*living room/i, 'never "Nick · living room"');
  // Only a room is known: Nick's location is still UNKNOWN; the room is the watch's.
  const roomOnly = M.presence(live({ life: null }));
  assert.equal(roomOnly.line1, 'Nick · location unknown');
  assert.equal(roomOnly.device, 'watch heard in the living room');
  // A room with no named device is "a device", never Nick.
  assert.equal(M.presence({ context: { place: { known: true, name: 'unknown', room: 'study' } } }).device, 'a device heard in the study');
  // A named place wins over the home/work read.
  assert.equal(M.presence(live({ context: { ...live().context, place: { known: true, name: 'Office' } } })).line1, 'Nick · Office');
});

test('unknown location and unseen desk are said, not guessed', () => {
  const p = M.presence({ context: { place: { known: false } }, work: { deskKnown: false }, operation: null });
  assert.equal(p.line1, 'Nick · location unknown');
  assert.equal(p.whereKnown, false);
  assert.equal(p.line2, 'desk not seen');
  assert.equal(p.device, null);
  const away = M.presence({ work: { deskKnown: true, atDesk: false }, operation: { label: 'QUIET' } });
  assert.equal(away.line2, 'away from the desk · quiet');
  const html = strip(render({ data: live({ context: { activity: 'unknown', place: { known: false } }, life: null, work: { deskKnown: false } }) }));
  assert.match(html, /Nick · location unknown/);
  assert.match(html, /desk not seen/);
});

test('no recoverable thread: the honest sentence, and nothing invented', () => {
  for (const d of [
    live({ context: { ...live().context, activity: 'unknown' }, primary: { kind: 'context', title: 'Can’t tell', say: 'Can’t tell · living-room' } }),
    live({ primary: null }),
  ]) {
    const t = M.currentThread(d);
    assert.equal(t.state, 'unknown');
    assert.equal(t.item, null);
    const html = strip(render({ data: d }));
    assert.match(html, /I can’t recover the thread from what I can see\./);
    assert.match(html, /Tell me what you were doing, or capture the next thing\./);
    assert.doesNotMatch(html, /Can’t tell/);
    assert.doesNotMatch(html, /Next step/, 'no step row for a thread that does not exist');
  }
});

test('a context thread uses NEURO’s title, not its place-suffixed say', () => {
  const t = M.currentThread(live());
  assert.equal(t.state, 'context');
  assert.equal(t.item.title, 'On a project of your own');
  const item = M.currentThread(live({ primary: { kind: 'item', type: 'email', title: 'Reply to Chris', say: 'Chris is waiting on a reply', reason: 'Raised in the 1-2-1' } }));
  assert.deepEqual([item.state, item.item.title, item.item.sub, item.item.reason], ['item', 'Chris is waiting on a reply', 'Reply to Chris', 'Raised in the 1-2-1']);
});

test('the three silences stay distinct, and blind is never good news', () => {
  assert.equal(M.silence({ poolAvailable: false, primary: null }).kind, 'blind');
  assert.equal(M.silence({ poolAvailable: true, primary: null, quiet: true }).kind, 'quiet');
  assert.equal(M.silence({ poolAvailable: true, primary: null, quiet: false }).kind, 'clear');
  assert.match(strip(render({ data: live({ poolAvailable: false, primary: null }) })), /isn’t an all-clear/);
});

test('the next step is never invented; lifecycle actions are the server’s, verbatim', () => {
  assert.deepEqual(M.currentThread(live()).nextStep, { known: false, text: null });
  assert.equal(M.currentThread(live(), { session: { active: true, nextStep: 'Open the risk register' } }).nextStep.text, 'Open the risk register');
  const html = strip(render({ data: live(), onAct: () => {} }));
  assert.match(html, /No next step named\./);
  assert.match(html, />That’s done</);
  assert.match(html, />Not now</);
  assert.doesNotMatch(html, />Show me everything</);
});

test('no read at all says NEURO is unreachable, and the dock stays', () => {
  const html = strip(render({ data: null, error: 'Failed to fetch', dock: React.createElement('i', { id: 'dock' }) }));
  assert.match(html, /can’t reach NEURO — Failed to fetch/);
  assert.match(html, /id="dock"/);
});

// ── 3. Tools: recommendation, gating, intent states ────────────────────────

test('one top tool, then one AI, Music, three context apps — the rest folded', () => {
  const t = M.toolHandoff(live(), M.currentThread(live()));
  assert.equal(t.top.id, 'code');
  assert.equal(t.top.certain, true);
  assert.equal(t.ai.id, 'claude');
  assert.equal(t.music.id, 'music');
  assert.equal(t.context.length, 3);
  assert.equal(t.more.length, 17 - 1 - 1 - 1 - 3);
  const all = [t.top, t.ai, t.music, ...t.context, ...t.more].map((a) => a.id);
  assert.equal(new Set(all).size, all.length, 'no app twice');
  assert.deepEqual([...all].sort(), APPS17.map((a) => a.id).sort(), 'every declared app is reachable');
});

test('context apps are the ones the work points at first', () => {
  const d = live({ work: { ...live().work, app: 'explorer' } });
  const t = M.toolHandoff(d, { item: { title: 'Pull the SQL for the NOVA escalation spreadsheet' } });
  assert.equal(t.top.id, 'nova', 'first hint wins the top slot');
  assert.equal(t.top.certain, false);
  assert.deepEqual(t.context.map((a) => a.id), ['ssms', 'excel', 'outlook'], 'the other hinted apps lead, then the fixed order');
  // With no hints, context is work apps — the second AI tool is folded, not context.
  const plain = M.toolHandoff(live());
  assert.deepEqual(plain.context.map((a) => a.id), ['outlook', 'teams', 'obsidian']);
  assert.ok(plain.more.some((a) => a.id === 'chatgpt'));
  // An email card points at Outlook.
  assert.equal(M.toolHandoff(live({ work: { ...live().work, app: 'explorer' }, primary: { kind: 'item', type: 'email', title: 'x' } })).top.id, 'outlook');
  // No evidence: a stated guess.
  const g = M.toolHandoff(live({ work: { ...live().work, app: 'explorer' } }));
  assert.equal(g.top.id, 'claude');
  assert.match(g.top.because, /not sure/);
});

test('if the top IS an AI tool, the AI slot offers the other one', () => {
  const t = M.toolHandoff(live({ work: { ...live().work, app: 'claude' } }));
  assert.equal(t.top.id, 'claude');
  assert.equal(t.ai.id, 'chatgpt');
});

test('undeclared AI or Music are reasons, never buttons', () => {
  const d = live({ work: { ...live().work, app: 'Code', deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'code', label: 'VS Code' }] } } });
  const t = M.toolHandoff(d);
  assert.equal(t.ai.available, false);
  assert.equal(t.music.available, false);
  assert.deepEqual(t.context, []);
  const html = strip(render({ data: d, onDeskOpen: () => {} }));
  assert.match(html, /<button[^>]*class="alt-tool__primary"[^>]*>Open VS Code<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>(AI|Music)<\/button>/);
  const text = html.replace(/<[^>]+>/g, '');
  assert.match(text, /AI — no AI tool set up on the laptop/);
  assert.match(text, /Music — not set up on the laptop/);
});

test('the top can never be an app the laptop did not declare', () => {
  const t = M.toolHandoff(live({ work: { ...live().work, app: 'Code', deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'music', label: 'Music' }] } } }));
  assert.equal(t.top.id, 'music');
  assert.equal(t.music, null, 'Music is not offered twice');
});

test('not at the desk / unseen / undeclared: nothing pressable, the server’s reason said', () => {
  const away = M.toolHandoff(live({ work: { ...live().work, atDesk: false, deskOffer: { known: true, host: 'H', apps: [], why: 'you’re not at the laptop' } } }));
  assert.equal(away.top, null);
  assert.equal(away.blockedWhy, 'you’re not at the laptop');
  assert.deepEqual([away.ai, away.music, away.context, away.more], [null, null, [], []]);
  assert.match(M.toolHandoff(live({ work: { deskKnown: false } })).blockedWhy, /can’t see your laptop/);
  const html = strip(render({ data: live({ work: { deskKnown: false } }), onDeskOpen: () => {} }));
  assert.match(html, /Nothing to open — I can’t see your laptop\./);
  assert.doesNotMatch(html, /alt-tool__primary|alt-tool__btn/);
});

test('a screen that cannot reach the desk queue shows names, not buttons', () => {
  const html = strip(render({ data: live(), onDeskOpen: null }));
  assert.doesNotMatch(html, /<button[^>]*alt-tool__/);
  assert.match(html, /can’t reach the desk queue/);
});

test('the recommendation sits INSIDE the thread card, primary over the alternatives', () => {
  const html = strip(render({ data: live(), onDeskOpen: () => {}, onToggleMore: () => {} }));
  const card = html.slice(html.indexOf('class="alt-thread"'), html.indexOf('class="alt-rail"'));
  assert.match(card, /Best next place/);
  assert.match(card, /class="alt-tool__primary"[^>]*>Open VS Code</);
  assert.match(card, /Other ways in/);
  assert.equal((card.match(/alt-tool__primary/g) || []).length, 1, 'one primary');
  assert.match(card, /More available apps \(11\)/);
  assert.equal((html.match(/class="alt-thread"/g) || []).length, 1, 'one thread card only');
});

test('the desk lifecycle is the server’s word, never "done", and in-flight cannot be re-pressed', () => {
  for (const [state, text] of [['waiting', 'waiting for the laptop'], ['claimed', 'the laptop has taken it'], ['opened', 'opened'], ['failed', 'failed'], ['expired', 'expired']]) {
    const html = strip(render({ data: live(), onDeskOpen: () => {}, deskStates: { code: state } }));
    assert.ok(html.includes(text), `${state} renders "${text}"`);
  }
  assert.equal(M.deskStateText('done'), null);
  assert.ok(M.deskStateSettled('expired') && !M.deskStateSettled('claimed'));
  assert.ok(M.deskStateBusy('waiting') && M.deskStateBusy('claimed') && !M.deskStateBusy('opened'));
  const busy = strip(render({ data: live(), onDeskOpen: () => {}, deskStates: { code: 'claimed' } }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Open VS Code<\/button>/);
});

// ── 4. The rail and held work ───────────────────────────────────────────────

test('judgement: a statement and a NEURO link — never an approve control', () => {
  const html = strip(render({ data: live(), neuroUrl: 'https://pi5.example' }));
  assert.match(html, /2 emails wait for your approval\./);
  assert.match(html, /href="https:\/\/pi5\.example\/\?view=actions"/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Approve|Send|Execute)\b/i);
  assert.match(strip(render({ data: live({ approvals: { known: true, needsApproval: 0, needsReview: 0 } }) })), /Nothing waiting for your judgement\./);
  assert.match(strip(render({ data: live({ approvals: null }) })), /couldn’t check what’s waiting/);
});

test('next transition only when relevant', () => {
  assert.equal(M.nextChange({}), null);
  assert.doesNotMatch(strip(render({ data: live() })), /aria-label="Next transition"/);
  assert.match(strip(render({ data: live({ nextMeeting: { subject: 'KPI review', time: '15:30' } }) })), /“KPI review” at 15:30\./);
  assert.equal(M.nextChange({ transition: { kind: 'leave-now', prompt: 'p' }, nextMeeting: { subject: 'Y' } }).kind, 'leave-now');
});

test('what SAiM can see: NEURO’s own evidence, and named gaps', () => {
  const e = M.evidence(live({ gaps: [{ input: 'calendar', why: 'Graph 401' }], context: { ...live().context, unknowns: ['presence'] } }));
  assert.deepEqual(e.seen, ['Every input answered and they agree.', 'VS Code is in front of you outside working hours, with no work app']);
  assert.deepEqual(e.gaps, ['presence', 'calendar — Graph 401']);
  assert.match(strip(render({ data: live({ gaps: [{ input: 'calendar', why: 'Graph 401' }] }) })), /Can’t read: calendar — Graph 401\./);
});

test('heldWork reads the server’s order, mutates nothing and never labels by raw id', () => {
  const d = deepFreeze(live());
  const before = JSON.stringify(d);
  const h = M.heldWork(d);
  assert.equal(JSON.stringify(d), before);
  assert.deepEqual(h.items.map((i) => i.type), ['todo', 'meeting', 'email']);
  assert.ok(h.items.every((i) => !/AAMk/.test(i.label)));
  assert.deepEqual(h.reasons, ['not a working day', 'unread email waits']);
});

test('expanding held work adds the list and changes nothing else on the page', () => {
  const d = deepFreeze(live());
  const closed = strip(render({ data: d, onToggleHeld: () => {}, heldOpen: false }));
  const open = strip(render({ data: d, onToggleHeld: () => {}, heldOpen: true }));
  assert.match(closed, /Holding 3 back: not a working day; unread email waits\./);
  assert.match(closed, /Show held work/);
  assert.doesNotMatch(closed, /alt-held__list/);
  assert.match(open, /alt-held__list/);
  const norm = (h) => h.replace(/<ul class="alt-held__list">[\s\S]*?<\/ul>/, '').replace(/aria-expanded="(true|false)"/, '').replace(/(Show|Hide) held work/, '');
  assert.equal(norm(open), norm(closed));
});

test('expansion is local UI state: no write is wired to either fold', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  for (const name of ['onToggleHeld', 'onToggleMore']) {
    const m = src.match(new RegExp(`${name}=\\{([^}]*)\\}`));
    assert.ok(m, `${name} is wired`);
    assert.doesNotMatch(m[1], /apiFetch|fetch\(/);
  }
});

// ── 5. The field is the control's, unchanged ────────────────────────────────

test('the shell mounts the control’s Field, full-screen, with the drive passed through untouched', () => {
  const drive = { activity: 'off', confidenceLevel: 'high', quiet: false, degraded: false, pressing: false };
  const html = renderToString(React.createElement(Shell, { active: 'saim', drive }));
  const m = html.match(/data-field="([^"]*)"/);
  assert.ok(m, 'Field rendered');
  assert.deepEqual(JSON.parse(m[1].replace(/&quot;/g, '"')), drive);
  assert.match(html, /class="app__field alt-app__field"/);
  const src = fs.readFileSync(path.join(ALT, 'AltShell.jsx'), 'utf8');
  assert.match(src, /import Field from '\.\.\/\.\.\/shared-ui\/Field'/);
  assert.match(src, /import \{ surfaceRgb \} from '\.\.\/\.\.\/shared-ui\/fieldDrive\.mjs'/);
});

test('driveFrom produces exactly the shape useFieldDrive produces', () => {
  const hook = fs.readFileSync(path.join(SHARED_UI, 'useFieldDrive.js'), 'utf8');
  const keys = [...hook.match(/setDrive\(\{([\s\S]*?)\}\);/)[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]).sort();
  assert.ok(keys.length >= 5, 'positive control: the hook’s keys were read');
  assert.deepEqual(Object.keys(M.driveFrom(live(), () => false)).sort(), keys);
  assert.equal(M.driveFrom(null).degraded, true, 'no read is unresolved, never calm');
});

test('no alt file restyles or re-implements the field', () => {
  for (const f of fs.readdirSync(ALT).filter((x) => /\.(css|jsx|mjs)$/.test(x))) {
    const src = fs.readFileSync(path.join(ALT, f), 'utf8');
    assert.doesNotMatch(src, /<canvas|getContext\(|\.field\b[^-_]/, `${f} must not draw a field of its own`);
  }
});

// ── Isolation from the control ──────────────────────────────────────────────

test('nothing the control builds can reach the alt code', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const sources = [...walk(path.join(APP, 'src')), ...walk(SHARED_UI)].filter((f) => /\.(m?jsx?|cjs)$/.test(f));
  assert.ok(sources.length > 20, 'positive control: the scan saw the control sources');
  for (const f of sources) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from ['"][^'"]*\/alt\//, `${f} must not import the alt shell`);
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt/i);
});

test('the alt env carries no secret and only its own hosts', () => {
  const lines = fs.readFileSync(path.join(APP, '.env.alt'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length >= 4, 'positive control: the env file was read');
  assert.ok(!lines.some((l) => /VAULT|TOKEN|SECRET|PIN|KEY/.test(l.split('=')[0])));
  const hosts = lines.find((l) => l.startsWith('VITE_ALLOWED_HOSTS=')).split('=')[1].split(',');
  assert.ok(hosts.includes('saim-alt.nickward.co.uk'));
  assert.ok(!hosts.some((h) => /^(saim|sara)\.nickward\.co\.uk$|^saim-nickward\.netlify\.app$/.test(h)));
});
