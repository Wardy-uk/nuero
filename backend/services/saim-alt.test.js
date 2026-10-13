/**
 * SAiM Alt — the A/B treatment shell (saim-alt.nickward.co.uk).
 *
 * Pins the four things the brief made non-negotiable:
 *   1. NAVIGATION is exactly five destinations; anything else hands off to NEURO.
 *   2. DESKTOP INTENTS are gated on the agent's declared capabilities — an app
 *      the laptop did not offer is never pressable, AI and Music always show.
 *   3. UNAVAILABLE states are said, never rendered as calm or as empty.
 *   4. HELD WORK expands without reranking or touching canonical state.
 * …plus that the control build cannot see any of it.
 *
 * The pure rules are tested on `saim/app/alt/model.mjs`; the page is bundled
 * with esbuild and REALLY rendered, so a rule that is right in the model but
 * not wired into the page fails here.
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

let M;            // the pure model
let View;         // SaimHomeView

function stubPlugin() {
  return {
    name: 'stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      // The page's live half talks to IndexedDB through the outbox; the view
      // under test never calls it, so it is stubbed rather than loaded.
      build.onResolve({ filter: /mobile\/outbox$/ }, () => ({ path: 'outbox', namespace: 'stub' }));
      build.onLoad({ filter: /^outbox$/, namespace: 'stub' }, () => ({
        contents: 'export const enqueue=()=>{throw new Error("x")};export const flush=async()=>({receipts:{}});export const outcomeFor=()=>({state:"queued"});',
        loader: 'js',
      }));
    },
  };
}

test.before(async () => {
  M = await import(`file://${path.join(ALT, 'model.mjs').replace(/\\/g, '/')}`);
  const out = await esbuild.build({
    entryPoints: [path.join(ALT, 'SaimHome.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom'],
    plugins: [stubPlugin()],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.SaimHomeView;
  assert.ok(View, 'SaimHome exports its presentational view');
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// Shaped like the live /api/canonical/now read of 13 Oct 2026 (in a meeting,
// at the laptop in Code, four apps declared, five items held back).
function live(over = {}) {
  return {
    poolAvailable: true,
    quiet: true,
    context: { activity: 'in-meeting', place: { known: true, name: 'Office', room: null }, confidence: { level: 'high' } },
    operation: { phase: 'quiet', label: 'QUIET', detail: null },
    primary: { kind: 'context', id: 'context-in-meeting', title: 'In a meeting', reason: 'You’re in "Nick Catch Up".', say: 'You’re in "Nick Catch Up".', actions: [] },
    work: {
      known: true, kind: 'app', task: null, app: 'Code', confidence: 'low', atDesk: true, deskKnown: true,
      host: 'DESKTOP-8LGF9RR', why: 'you are at the laptop in Code — which says nothing about which task',
      deskOffer: {
        known: true, host: 'DESKTOP-8LGF9RR', why: null,
        apps: [{ id: 'browser', label: 'Browser' }, { id: 'code', label: 'VS Code' }, { id: 'music', label: 'Music' }, { id: 'terminal', label: 'Terminal' }],
      },
    },
    dropped: [
      { id: 'todo-overdue-summary', type: 'todo', why: 'in a meeting — SAiM stays out of the way' },
      { id: 'capacity-start-345', type: 'capacity', why: 'in a meeting — SAiM stays out of the way' },
      { id: 'cal-AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTE4LWQyNmMzN2UyMTBmOQBGAAAAAAA7R6hC4', type: 'meeting', why: 'in a meeting — SAiM stays out of the way' },
      { id: 'email-urgent', type: 'email', why: 'unread email waits' },
    ],
    approvals: { known: true, needsApproval: 2, needsReview: 0, where: 'Actions, in NEURO on the desktop', say: '2 emails wait for your approval.' },
    transition: null,
    nextMeeting: { key: 'k', subject: 'KPI review', time: '15:30' },
    utterances: [
      { say: 'That’s finished', intent: { kind: 'meeting', action: 'finished', key: 'k1' } },
      { say: 'I’m not in it', intent: { kind: 'meeting', action: 'not-attending', key: 'k1' } },
      { say: 'Capture a thought', intent: { kind: 'navigate', tab: 'capture' } },
      { say: 'What am I missing?', intent: { kind: 'ask' } },
      { say: 'Show me everything', intent: { kind: 'reveal' } },
    ],
    ...over,
  };
}

const render = (props) => renderToString(React.createElement(View, props));

// ── 1. Navigation restriction ───────────────────────────────────────────────

test('exactly five destinations, in the brief’s order', () => {
  assert.deepEqual([...M.ALT_TAB_IDS], ['saim', 'now', 'review', 'capture', 'controls']);
  assert.deepEqual(M.ALT_TABS.map((t) => t.label), ['SAiM', 'Now', 'Review', 'Capture', 'Controls']);
  assert.equal(M.ALT_DEFAULT_TAB, 'saim');
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

test('the shell renders the five from the model and never the control registry', () => {
  const src = fs.readFileSync(path.join(ALT, 'AltApp.jsx'), 'utf8');
  assert.match(src, /ALT_TABS\.map/);
  assert.doesNotMatch(src, /shared-ui\/tabs/, 'the control’s tab registry (with its secondary row) must not be imported');
  assert.doesNotMatch(src, /views\/(Tasks|Chat|MeetingPrep|Standup|Household|Surface)/);
  // Every navigation goes through the resolver.
  assert.match(src, /resolveAltTab\(/);
});

test('neuroLink builds NEURO’s own ?view= deep link', () => {
  assert.equal(M.neuroLink('https://pi5.example/', 'actions'), 'https://pi5.example/?view=actions');
  assert.equal(M.neuroLink('https://pi5.example', null), 'https://pi5.example/');
  assert.equal(M.neuroLink('', 'actions'), null);
});

// ── 2. Desktop-intent capability gating ─────────────────────────────────────

test('the top candidate is the app he is already in, when the laptop offers it', () => {
  const t = M.toolHandoff(live());
  assert.equal(t.top.id, 'code');
  assert.equal(t.top.available, true);
  assert.equal(t.top.certain, true);
  assert.deepEqual(t.alternatives.map((a) => a.id), ['ai', 'music', 'browser', 'terminal']);
});

test('AI and Music always show; an app the agent did not declare is never pressable', () => {
  const d = live({ work: { ...live().work, app: 'explorer', deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'terminal', label: 'Terminal' }] } } });
  const t = M.toolHandoff(d);
  const ai = t.alternatives.find((a) => a.id === 'ai');
  const music = t.alternatives.find((a) => a.id === 'music');
  assert.equal(ai.available, false);
  assert.match(ai.why, /no AI tool is set up/);
  assert.equal(music.available, false);
  assert.match(music.why, /not set up on this laptop/);
  assert.ok(!t.alternatives.some((a) => a.id === 'browser' || a.id === 'code'), 'undeclared apps are not invented');
  // With no evidence it still offers its best guess — and says it is a guess.
  assert.equal(t.top.id, 'terminal');
  assert.equal(t.top.certain, false);
  assert.match(t.top.because, /not sure/);
});

test('top candidate can never be an app outside the offer, even with a strong hint', () => {
  const d = live({ work: { ...live().work, app: 'Code', deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'music', label: 'Music' }] } } });
  const t = M.toolHandoff(d);
  assert.equal(t.top.id, 'music');
  assert.equal(t.top.available, true);
});

test('not at the desk / desk unseen / undeclared: nothing pressable, and the reason is the server’s', () => {
  const away = M.toolHandoff(live({ work: { ...live().work, atDesk: false, deskOffer: { known: true, host: 'H', apps: [], why: 'you’re not at the laptop' } } }));
  assert.equal(away.top, null);
  assert.equal(away.blockedWhy, 'you’re not at the laptop');
  assert.ok(away.alternatives.every((a) => a.available === false && a.why === 'you’re not at the laptop'));

  const unseen = M.toolHandoff(live({ work: { deskKnown: false } }));
  assert.equal(unseen.top, null);
  assert.match(unseen.blockedWhy, /can’t see your laptop/);

  const silent = M.toolHandoff(live({ work: { ...live().work, deskOffer: { known: false, host: 'H', apps: [], why: 'that machine hasn’t said what it can open' } } }));
  assert.equal(silent.top, null);
  assert.ok(silent.alternatives.every((a) => !a.available));
});

test('rendered: unavailable tools are disabled buttons with their reason beside them', () => {
  const d = live({ work: { ...live().work, deskOffer: { known: true, host: 'H', why: null, apps: [{ id: 'code', label: 'VS Code' }] } } });
  const html = render({ data: d, onDeskOpen: () => {} });
  assert.match(html, /<button[^>]*class="alt-tools__primary"[^>]*>VS Code<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>AI assistant<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Music<\/button>/);
  assert.match(html, /no AI tool is set up on the desk agent/);
});

// The widened vocabulary (13 Oct 2026): Claude and ChatGPT fill the AI slot,
// and the work apps are ordered after Music.
const WIDE = [
  ['claude', 'Claude'], ['chatgpt', 'ChatGPT'], ['music', 'Music'], ['outlook', 'Outlook'], ['teams', 'Teams'],
  ['nova', 'NOVA'], ['browser', 'Browser'], ['code', 'VS Code'], ['terminal', 'Terminal'],
].map(([id, label]) => ({ id, label }));
const wide = (over = {}) => live({ work: { ...live().work, app: 'explorer', ...over, deskOffer: { known: true, host: 'H', why: null, apps: WIDE } } });

test('offered AI tools fill the AI slot, pressable, ahead of Music and the work apps', () => {
  const t = M.toolHandoff(wide({ app: 'code' }));
  assert.equal(t.top.id, 'code');
  assert.deepEqual(t.alternatives.map((a) => a.id), ['claude', 'chatgpt', 'music', 'outlook', 'teams', 'nova', 'browser', 'terminal']);
  assert.ok(t.alternatives.every((a) => a.available), 'everything listed was offered');
  assert.ok(!t.alternatives.some((a) => a.id === 'ai'), 'no disabled placeholder once a real AI tool is offered');
});

test('the app in front wins; the kind of card and the work’s words are only guesses', () => {
  assert.deepEqual(
    (({ id, certain }) => ({ id, certain }))(M.toolHandoff(wide({ app: 'claude' })).top),
    { id: 'claude', certain: true },
  );
  const email = M.toolHandoff(wide(), M.currentThread(live({ primary: { kind: 'item', type: 'email', title: 'Reply needed', say: 'Reply needed' } })));
  assert.equal(M.toolHandoff(live({ ...wide(), primary: { kind: 'item', type: 'email', title: 'x' } })).top.id, 'outlook');
  assert.equal(email.top.certain, false);
  const nova = M.toolHandoff(wide(), { item: { title: 'Check the NOVA escalation list' } });
  assert.equal(nova.top.id, 'nova');
  assert.equal(nova.top.certain, false);
  // No evidence: the first offered tool, said to be a guess.
  const guess = M.toolHandoff(wide());
  assert.equal(guess.top.id, 'claude');
  assert.match(guess.top.because, /not sure/);
});

test('rendered: a surface that cannot reach the desk queue offers nothing pressable', () => {
  const html = render({ data: live(), onDeskOpen: null });
  assert.match(html, /<button[^>]*disabled=""[^>]*class="alt-tools__primary"|<button[^>]*class="alt-tools__primary"[^>]*disabled=""/);
  assert.match(html, /can’t reach the desk queue/);
});

test('rendered: the desk lifecycle is the server’s word, never "done"', () => {
  for (const [state, text] of [['waiting', 'waiting for the laptop'], ['claimed', 'the laptop has taken it'], ['opened', 'opened'], ['failed', 'failed'], ['expired', 'expired']]) {
    const html = render({ data: live(), onDeskOpen: () => {}, deskStates: { code: state } });
    assert.ok(html.includes(text), `${state} renders "${text}"`);
  }
  assert.equal(M.deskStateText('done'), null);
  assert.ok(M.deskStateSettled('expired') && !M.deskStateSettled('claimed'));
  // A request in flight cannot be pressed again.
  const inFlight = render({ data: live(), onDeskOpen: () => {}, deskStates: { code: 'claimed' } });
  assert.match(inFlight, /<button[^>]*class="alt-tools__primary"[^>]*disabled=""|<button[^>]*disabled=""[^>]*class="alt-tools__primary"/);
});

// ── 3. Honest unavailable states ────────────────────────────────────────────

test('presence says what it cannot tell, field by field', () => {
  const p = M.presence({ context: { place: { known: false } }, work: { deskKnown: false }, operation: null });
  assert.equal(p.where.known, false);
  assert.match(p.where.text, /can’t tell where you are/);
  assert.equal(p.desk.known, false);
  assert.match(p.desk.text, /can’t see your laptop/);
  assert.equal(p.operation.known, false);
  // 'unknown' as a place name is not a place.
  assert.equal(M.presence({ context: { place: { known: true, name: 'unknown', room: null } } }).where.known, false);
});

test('the three silences stay distinct, and blind is never good news', () => {
  assert.equal(M.silence({ poolAvailable: false, primary: null }).kind, 'blind');
  assert.match(M.silence({ poolAvailable: false }).text, /isn’t an all-clear/);
  assert.equal(M.silence({ poolAvailable: true, primary: null, quiet: true }).kind, 'quiet');
  assert.equal(M.silence({ poolAvailable: true, primary: null, quiet: false }).kind, 'clear');
});

test('the next step is never invented', () => {
  assert.deepEqual(M.currentThread(live(), null).nextStep, { known: false, text: null });
  assert.deepEqual(M.currentThread(live(), { session: { active: true, nextStep: 'Open the risk register' } }).nextStep,
    { known: true, text: 'Open the risk register' });
  const html = render({ data: live() });
  assert.match(html, /No next step named\./);
});

test('lifecycle actions are the server’s utterances verbatim, minus navigation/ask/reveal', () => {
  const t = M.currentThread(live());
  assert.deepEqual(t.actions.map((u) => u.say), ['That’s finished', 'I’m not in it']);
  const html = render({ data: live(), onAct: () => {} });
  assert.match(html, />That’s finished</);
  assert.doesNotMatch(html, />Show me everything</);
});

test('approvals: a statement and a NEURO link — never an approve control', () => {
  const html = render({ data: live(), neuroUrl: 'https://pi5.example' });
  assert.match(html, /2 emails wait for your approval\./);
  assert.match(html, /href="https:\/\/pi5\.example\/\?view=actions"/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Approve|Send)\b/i);
  const unknown = M.judgement({ approvals: { known: false } });
  assert.equal(unknown.known, false);
  assert.match(unknown.text, /couldn’t check/);
  assert.match(render({ data: live({ approvals: null }) }), /couldn’t check what’s waiting/);
});

test('no read at all says NEURO is unreachable rather than drawing a calm page', () => {
  const html = render({ data: null, error: 'Failed to fetch' });
  assert.match(html, /can’t reach NEURO — Failed to fetch/);
  assert.doesNotMatch(html, /Nothing pressing/);
  const blind = render({ data: live({ poolAvailable: false, primary: null, quiet: false }) });
  assert.match(blind, /isn’t an all-clear/);
});

test('next context change only when relevant, and the transition wins', () => {
  assert.equal(M.nextChange({}), null);
  assert.match(M.nextChange({ nextMeeting: { subject: 'KPI review', time: '15:30' } }).text, /“KPI review” at 15:30/);
  const tr = M.nextChange({ transition: { kind: 'leave-now', prompt: '"X" starts in 5 minutes.', question: 'Leave now?' }, nextMeeting: { subject: 'Y', time: '9:00' } });
  assert.equal(tr.kind, 'leave-now');
});

// ── 4. Non-destructive held-work expansion ─────────────────────────────────

test('heldWork reads the server’s order, mutates nothing and never labels by raw id', () => {
  const d = deepFreeze(live());
  const before = JSON.stringify(d);
  const h = M.heldWork(d);
  assert.equal(JSON.stringify(d), before);
  assert.equal(h.count, 4);
  assert.deepEqual(h.items.map((i) => i.type), ['todo', 'capacity', 'meeting', 'email']);
  assert.ok(h.items.every((i) => !/AAMk/.test(i.label)), 'a Graph id is never a label');
  assert.deepEqual(h.reasons, ['in a meeting — SAiM stays out of the way', 'unread email waits']);
});

test('expanding held work adds the list and changes nothing else on the page', () => {
  const d = deepFreeze(live());
  const closed = render({ data: d, onToggleHeld: () => {}, heldOpen: false });
  const open = render({ data: d, onToggleHeld: () => {}, heldOpen: true });
  assert.match(closed, /Holding 4 back/);
  assert.match(closed, /Show held work/);
  assert.doesNotMatch(closed, /alt-held__list/);
  assert.match(open, /alt-held__list/);
  // Strip the disclosure (button text + list) and the two renders are identical:
  // nothing above or below it was reranked or re-phrased.
  const strip = (h) => h.replace(/<ul class="alt-held__list">[\s\S]*?<\/ul>/, '').replace(/aria-expanded="(true|false)"/, '').replace(/(Show|Hide) held work/, '');
  assert.equal(strip(open), strip(closed));
});

test('expansion is local UI state: the page issues no write for it', () => {
  const src = fs.readFileSync(path.join(ALT, 'SaimHome.jsx'), 'utf8');
  const toggle = src.match(/onToggleHeld=\{([^}]*)\}/);
  assert.ok(toggle, 'the toggle is wired');
  assert.doesNotMatch(toggle[1], /apiFetch|fetch\(/);
});

// ── Isolation from the control ──────────────────────────────────────────────

test('nothing the control builds can reach the alt code', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const sources = [...walk(path.join(APP, 'src')), ...walk(path.resolve(APP, '..', 'shared-ui'))]
    .filter((f) => /\.(m?jsx?|cjs)$/.test(f));
  assert.ok(sources.length > 20, 'positive control: the scan saw the control sources');
  for (const f of sources) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from ['"][^'"]*\/alt\//, `${f} must not import the alt shell`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt/i);
});

test('the alt env carries no secret and only its own hosts', () => {
  const env = fs.readFileSync(path.join(APP, '.env.alt'), 'utf8');
  const lines = env.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length >= 4, 'positive control: the env file was read');
  assert.ok(!lines.some((l) => /VAULT|TOKEN|SECRET|PIN|KEY/.test(l.split('=')[0])), 'no credential keys');
  const hosts = lines.find((l) => l.startsWith('VITE_ALLOWED_HOSTS=')).split('=')[1].split(',');
  assert.ok(hosts.includes('saim-alt.nickward.co.uk'));
  assert.ok(!hosts.some((h) => /^(saim|sara)\.nickward\.co\.uk$|^saim-nickward\.netlify\.app$/.test(h)), 'never the control’s hosts');
});
