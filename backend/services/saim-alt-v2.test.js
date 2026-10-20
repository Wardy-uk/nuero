/**
 * SAiM Alt v2 — the actionable daily front door (saim-alt.nickward.co.uk).
 *
 * Pins the brief's rules:
 *   NAVIGATION   exactly six destinations; anything else is a hand-off to NEURO.
 *   DEEP LINKS   a link names a canonical record or block, and says when it has gone.
 *   ROUTING      a notification lands where it can be acted on — SAiM or NEURO —
 *                and names the canonical destination, or says it cannot.
 *   CAPTURE      "Saved" only on NEURO's acknowledgement; a failure keeps the words.
 *   TOOLS        only for a named step; recommended first, then AI, then Music,
 *                then at most one more; never an undeclared app; never an inventory.
 *   HONESTY      unknown is said; a request is not a result.
 *   FIELD        the control's Field, unchanged; the drive mapping is the control's.
 *   ISOLATION    the control can never reach this code, and this build cannot push.
 *
 * Pure rules are tested on `saim/app/alt-v2/model.mjs` against the fixtures the
 * screenshots use; the pages are bundled with esbuild and REALLY rendered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app');
const V2 = path.join(APP, 'alt-v2');
const SHARED = path.resolve(APP, '..', 'shared-ui');
const NEURO = 'https://neuro.example';

let M; let F; let UI;

test.before(async () => {
  const url = (f) => `file://${path.join(V2, f).replace(/\\/g, '/')}`;
  M = await import(url('model.mjs'));
  F = await import(url('fixtures.mjs'));
  const entry = [
    "export { SaimPageView } from './SaimPage.jsx';",
    "export { NowPageView } from './NowPage.jsx';",
    "export { BriefingPageView } from './BriefingPage.jsx';",
    "export { ControlsPageView } from './ControlsPage.jsx';",
    "export { default as Shell } from './Shell.jsx';",
    "export { WorkingView, default as WorkingFixture } from './WorkingFixture.jsx';",
    "export { runCapture, captureNote } from './Dock.jsx';",
  ].join('\n');
  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: V2, loader: 'js' },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /mobile\/outbox$/ }, () => ({ path: 'outbox', namespace: 'stub' }));
        b.onLoad({ filter: /^outbox$/, namespace: 'stub' }, () => ({ contents: 'export const enqueue=0,flush=0,outcomeFor=0;', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  UI = mod.exports;
});

const h = React.createElement;
const html = (el) => renderToString(el).split('<!-- -->').join('');
const sc = (id) => F.scenario(id);
const saimHtml = (s, extra = {}) => html(h(UI.SaimPageView, { ...s, onAct: () => {}, onDeskOpen: () => {}, ...extra }));

// ── Navigation ──────────────────────────────────────────────────────────────

test('exactly six destinations, in the brief’s order, SAiM first', () => {
  assert.deepEqual(M.TAB_IDS, ['saim', 'now', 'briefing', 'review', 'capture', 'controls']);
  assert.equal(M.DEFAULT_TAB, 'saim');
});

test('control ids with an obvious home resolve; anything else is a hand-off, never a seventh screen', () => {
  assert.deepEqual(M.resolveTab('surface'), { tab: 'saim', handoff: false });
  assert.deepEqual(M.resolveTab('today'), { tab: 'now', handoff: false });
  assert.deepEqual(M.resolveTab('standup'), { tab: 'review', handoff: false });
  for (const id of ['tasks', 'chat', 'prep', 'actions', 'inbox', 'household', '', null, 'constructor', '__proto__']) {
    const r = M.resolveTab(id);
    assert.equal(r.tab, null, `${id} is not a SAiM destination`);
    assert.equal(r.handoff, true);
  }
});

test('rendered: the bottom bar is the six from the model, with the active one marked', () => {
  const out = html(h(UI.Shell, { active: 'now', drive: M.driveFrom(null), onGo: () => {} }, h('p', null, 'page')));
  const labels = [...out.matchAll(/v2__tablabel">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ['SAiM', 'Now', 'Briefing', 'Review', 'Capture', 'Controls']);
  assert.match(out, /aria-current="page"[^>]*>(?:(?!<\/button>).)*Now/);
  // 20 Oct 2026 (Nick): the treatment badge is debug-only; the selected tab is identity enough.
  assert.doesNotMatch(out, /SAiM Alt/, 'no badge in normal view');
  assert.match(html(h(UI.Shell, { active: 'now', drive: M.driveFrom(null), onGo: () => {}, debug: true }, h('p', null, 'page'))), /SAiM Alt/, 'debug keeps the treatment marked');
  assert.match(out, /Not read yet/, 'no read is said, not shown as a time');
});

// ── Deep links ──────────────────────────────────────────────────────────────

test('deep links name a tab, an attention record and a block — in safe shapes only', () => {
  assert.deepEqual(M.parseDeepLink('?tab=now'), { tab: 'now', recordId: null, blockId: null });
  assert.deepEqual(M.parseDeepLink('?record=att_mv830vj2_5'), { tab: 'saim', recordId: 'att_mv830vj2_5', blockId: null });
  assert.deepEqual(M.parseDeepLink('?tab=bogus&block=201'), { tab: 'saim', recordId: null, blockId: 201 });
  assert.equal(M.parseDeepLink('?record=<script>'), null, 'an unsafe id names nothing');
  assert.equal(M.parseDeepLink('?block=-3'), null);
  assert.equal(M.parseDeepLink(''), null);
  assert.equal(M.altHref({ tab: 'saim', recordId: 'att_x', blockId: 7 }), '/?tab=saim&record=att_x&block=7');
  assert.deepEqual(M.parseDeepLink(M.altHref({ tab: 'saim', blockId: 7 }).slice(1)), { tab: 'saim', recordId: null, blockId: 7 });
});

test('rendered: a deep link to the current block highlights it; a stale one says it has moved on', () => {
  const s = sc('active-block');
  assert.match(saimHtml(s, { focus: { blockId: 201 } }), /v2-card is-focus/);
  const stale = saimHtml(s, { focus: { blockId: 999 } });
  assert.match(stale, /isn’t the current one any more/);
  assert.doesNotMatch(stale, /is-focus/);
  assert.match(saimHtml(s, { focus: { recordId: 'att_gone' } }), /isn’t current any more/);
});

// ── Notification routing ────────────────────────────────────────────────────

test('fixture: a block notification lands on SAiM, on that exact block', () => {
  const s = sc('notify-saim');
  const r = M.routeNotification(s.notification, { neuroBase: NEURO });
  assert.equal(r.surface, 'saim');
  assert.equal(r.blockId, 201);
  assert.equal(r.exact, true);
  assert.equal(r.href, '/?tab=saim&block=201');
});

test('fixture: an email notification lands in NEURO’s inbox, never on SAiM', () => {
  const r = M.routeNotification(sc('notify-neuro').notification, { neuroBase: NEURO });
  assert.equal(r.surface, 'neuro');
  assert.equal(r.view, 'inbox');
  assert.ok(r.href.startsWith(`${NEURO}/?view=inbox`));
});

test('approval, sending, detail and admin always route to NEURO', () => {
  const cases = { approval: 'actions', prepared_action: 'actions', weekly_risk: 'weekly-risk', escalation_alert: 'dashboard', 121: 'people', sense_alert: 'pi-health', vault_hygiene: 'brain-health' };
  for (const [type, view] of Object.entries(cases)) {
    const r = M.routeNotification({ type, attentionRecordId: 'att_1' }, { neuroBase: NEURO });
    assert.equal(r.surface, 'neuro', type);
    assert.equal(r.view, view, type);
  }
});

test('block, lifecycle, meeting, capture, ritual and briefing route to SAiM tabs', () => {
  const cases = [
    [{ type: 'meeting_alert', attentionRecordId: 'att_m' }, 'saim', 'att_m'],
    [{ type: 'nudge', attentionRecordId: 'att_n' }, 'saim', 'att_n'],
    [{ type: 'capture_failed' }, 'capture', null],
    [{ type: 'standup' }, 'review', null],
    [{ type: 'brief', key: 'briefing:daily:2026-10-14', url: '/?view=briefings&kind=daily' }, 'briefing', null],
  ];
  for (const [data, tab, rec] of cases) {
    const r = M.routeNotification(data, { neuroBase: NEURO });
    assert.equal(r.surface, 'saim', data.type);
    assert.equal(r.tab, tab, data.type);
    assert.equal(r.recordId, rec, data.type);
  }
});

test('a notification naming no destination says so rather than pretending to be exact', () => {
  const r = M.routeNotification({ type: 'mystery' }, { neuroBase: NEURO });
  assert.equal(r.exact, false);
  assert.match(r.why, /no canonical destination/);
  const n = M.routeNotification({ type: 'whatever', url: '/?view=insights' }, { neuroBase: NEURO });
  assert.equal(n.surface, 'neuro');
  assert.equal(n.href, `${NEURO}/?view=insights`);
});

// ── Capture ─────────────────────────────────────────────────────────────────

const io = (over) => ({ enqueue: async () => ({ operationId: 'op1' }), flush: async () => ({ receipts: { op1: { status: 'applied' } } }), outcomeFor: (r) => (!r ? { state: 'pending' } : r.status === 'applied' ? { state: 'confirmed' } : { state: 'refused', message: 'NOT saved — bad.' }), ...over });

test('capture: "Saved to NEURO" only when NEURO acknowledged it', async () => {
  const ok = await UI.runCapture('a thought', io());
  assert.equal(ok.clear, true);
  assert.equal(ok.note.msg, 'Saved to NEURO.');
  const refused = await UI.runCapture('a thought', io({ flush: async () => ({ receipts: { op1: { status: 'rejected' } } }) }));
  assert.equal(refused.note.ok, false);
  assert.doesNotMatch(refused.note.msg, /Saved to NEURO/);
  const offline = await UI.runCapture('a thought', io({ flush: async () => { throw new Error('offline'); } }));
  assert.match(offline.note.msg, /not in NEURO yet/);
  const noReceipt = await UI.runCapture('a thought', io({ flush: async () => ({ receipts: {} }) }));
  assert.match(noReceipt.note.msg, /not in NEURO yet/);
});

test('capture: a failure to store keeps the words in the box and says so', async () => {
  const r = await UI.runCapture('do not lose me', io({ enqueue: async () => { throw new Error('quota'); } }));
  assert.equal(r.clear, false);
  assert.match(r.note.msg, /NOT saved/);
  assert.match(r.note.msg, /still here/);
});

// ── Tools ───────────────────────────────────────────────────────────────────

test('no named step → no tools at all', () => {
  for (const id of ['upcoming-meeting', 'protected-block', 'out-of-hours']) {
    const s = sc(id);
    const t = M.tools(s.canonical, M.saimView(s));
    assert.equal(t.recommended, null, id);
    assert.deepEqual(t.others, [], id);
    assert.doesNotMatch(saimHtml(s), /Tools for this step|Best place/, id);
  }
});

test('with a named step: recommended first, then AI, then Music, at most one more — all declared', () => {
  const s = sc('active-block');
  const t = M.tools(s.canonical, M.saimView(s));
  assert.equal(t.recommended.id, 'excel');
  assert.deepEqual(t.others.map((o) => o.id), ['claude', 'music']);
  const declared = new Set(s.canonical.work.deskOffer.apps.map((a) => a.id));
  for (const a of [t.recommended, ...t.others]) assert.ok(declared.has(a.id));
  assert.ok(t.others.length <= 3);
  const out = saimHtml(s);
  const order = ['Open Excel', '>Claude<', '>Music<'].map((x) => out.indexOf(x));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'rendered in that order');
});

test('an undeclared app is never offered; a pick already in front is said, not re-opened', () => {
  const s = sc('active-block');
  const noExcel = { ...s.canonical, work: { ...s.canonical.work, deskOffer: { ...s.canonical.work.deskOffer, apps: s.canonical.work.deskOffer.apps.filter((a) => a.id !== 'excel' && a.id !== 'music') } } };
  const t = M.tools(noExcel, M.saimView({ ...s, canonical: noExcel }));
  assert.notEqual(t.recommended && t.recommended.id, 'excel');
  assert.ok(!t.others.some((o) => o.id === 'excel' || o.id === 'music'));
  const inExcel = { ...s.canonical, work: { ...s.canonical.work, app: 'EXCEL.EXE' } };
  const v = M.saimView({ ...s, canonical: inExcel });
  const t2 = M.tools(inExcel, v);
  assert.equal(t2.recommended, null);
  assert.equal(t2.already.id, 'excel');
  const out = saimHtml({ ...s, canonical: inExcel });
  assert.match(out, /Excel is already open/);
  assert.doesNotMatch(out, /Open Excel/);
});

test('rendered: a screen that cannot reach the laptop offers nothing pressable, and says why', () => {
  const out = saimHtml(sc('active-block'), { onDeskOpen: null });
  assert.doesNotMatch(out, /<button[^>]*>Open Excel/);
  assert.match(out, /can’t reach the laptop/);
});

test('a desk request is reported in the server’s lifecycle words — never "done"', () => {
  for (const st of ['waiting', 'claimed', 'opened', 'failed', 'expired']) assert.doesNotMatch(M.deskStateText(st), /\bdone\b|complete/i);
  const out = saimHtml(sc('active-block'), { deskStates: { excel: 'claimed' } });
  assert.match(out, /the laptop has taken it/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Open Excel/);
});

// ── The SAiM page: block, action, transition, honesty ───────────────────────

test('active block: state, times, the named task and NEURO’s step and sentences verbatim', () => {
  const s = sc('active-block');
  const v = M.saimView(s);
  assert.equal(v.block.state, 'active');
  assert.equal(v.block.task.text, 'Build the Q4 cover rota spreadsheet');
  assert.equal(v.step, 'Fill in the week-1 shift breakdown');
  assert.deepEqual(v.actions.map((u) => u.say), ['That’s done', 'I got pulled away']);
  const out = saimHtml(s);
  assert.match(out, /Active/);
  assert.match(out, /09:30–10:30/);
});

test('upcoming meeting: shown once, as the transition, with its own sentences', () => {
  const s = sc('upcoming-meeting');
  const v = M.saimView(s);
  assert.equal(v.item, null, 'the meeting is not also the main item');
  assert.match(v.transition.text, /Weekly support leads.*11:00/);
  assert.deepEqual(v.transitionActions.map((u) => u.say), ['Seen it', 'Not now — an hour']);
  assert.deepEqual(v.actions, []);
  assert.equal((saimHtml(s).match(/Weekly support leads/g) || []).length, 1);
});

test('protected time, off duty and blind each say what is true — none pretends to know the task', () => {
  assert.match(M.saimView(sc('protected-block')).uncertain, /protects this time.*no task block names/);
  assert.match(M.saimView(sc('out-of-hours')).uncertain, /^Off duty/);
  const blind = sc('active-block');
  const b = M.saimView({ ...blind, adhd: { blockNow: null }, canonical: { ...blind.canonical, poolAvailable: false } });
  assert.match(b.uncertain, /isn’t an all-clear/);
});

test('block state comes from NEURO: paused session = interrupted, all ticked = complete, two tasks = no guess', () => {
  const s = sc('active-block');
  assert.equal(M.blockNow(s.adhd, { session: { status: 'paused' } }).state, 'interrupted');
  assert.equal(M.blockNow({ blockNow: { ...s.adhd.blockNow, allTicked: true } }).state, 'complete');
  const two = { blockNow: { ...s.adhd.blockNow, tasks: [{ taskId: 1, text: 'A' }, { taskId: 2, text: 'B' }] } };
  const v = M.saimView({ ...s, adhd: two });
  assert.equal(v.block.task, null);
  assert.match(v.uncertain, /2 tasks share this block/);
});

test('no read at all says NEURO is unreachable rather than drawing a calm page', () => {
  const out = html(h(UI.SaimPageView, { canonical: null, adhd: null, error: 'timeout' }));
  assert.match(out, /can’t reach NEURO — timeout/);
});

// ── Now ─────────────────────────────────────────────────────────────────────

test('Now: today’s remaining open blocks, meetings and protected time, in clock order — labelled honestly', () => {
  const s = sc('active-block');
  const line = M.dayLine(s.canonical, s.taskBlocks, { now: s.now, currentId: 201 });
  assert.deepEqual(line.items.map((i) => `${i.start} ${i.kind}`), ['09:30 block', '11:00 meeting', '12:00 block', '14:00 protected']);
  assert.equal(line.items[0].current, true);
  const out = html(h(UI.NowPageView, s));
  assert.match(out, /Today’s remaining open blocks/);
  assert.match(out, /Finished blocks aren’t listed/);
});

test('Now: a passed block is not listed; an unread diary and a rolled-forward diary are different facts', () => {
  const s = sc('active-block');
  const passed = { ...s.taskBlocks, blocks: s.taskBlocks.blocks.map((b) => (b.blockId === 202 ? { ...b, passed: true } : b)) };
  assert.ok(!M.todaysOpenBlocks(passed, { now: s.now }).some((b) => b.blockId === 202));
  const unread = html(h(UI.NowPageView, { ...s, canonical: { ...s.canonical, agenda: { known: false } } }));
  assert.match(unread, /couldn’t read the diary/);
  const rolled = html(h(UI.NowPageView, sc('out-of-hours')));
  assert.match(rolled, /nothing more today/);
  assert.doesNotMatch(rolled, /couldn’t read the diary/);
});

// ── Briefing ────────────────────────────────────────────────────────────────

test('Briefing: NEURO’s stored briefing verbatim, with a route to NEURO’s Briefings page', () => {
  const s = sc('active-block');
  const out = html(h(UI.BriefingPageView, { resp: s.briefing, now: s.now, neuroUrl: NEURO }));
  for (const sec of s.briefing.briefing.payload.sections) for (const i of sec.items) assert.ok(out.includes(i.title.replace(/’/g, '&#x27;')) || out.includes(i.title), i.title);
  assert.ok(out.includes('Two things need you before lunch'));
  assert.match(out, /view=briefings&amp;kind=daily/);
  assert.doesNotMatch(out, /hasn’t been written yet/);
  const old = html(h(UI.BriefingPageView, { resp: s.briefing, now: F.at(9, 0) + 86_400_000, neuroUrl: NEURO }));
  assert.match(old, /hasn’t been written yet/);
  const none = html(h(UI.BriefingPageView, { resp: { ok: true, briefing: null }, neuroUrl: NEURO }));
  assert.match(none, /No briefing to show/);
});

// ── Controls ────────────────────────────────────────────────────────────────

test('Controls render NEURO’s settings, including work/personal scope, and offer no push subscription', () => {
  const resp = { settings: { enabled: true, quietHours: 'off', quietHoursSource: 'setting', interruptionLevel: 'normal', pausedUntil: null, domains: { work: true, personal: false } } };
  const out = html(h(UI.ControlsPageView, { resp, onPatch: () => {} }));
  assert.match(out, /aria-pressed="true"[^>]*>Normal/);
  assert.match(out, /aria-pressed="true"[^>]*>None/);
  assert.match(out, /Not paused/);
  assert.match(out, /type="checkbox" checked=""[^>]*\/><span>Work/);
  assert.doesNotMatch(out, /type="checkbox" checked=""[^>]*\/><span>Personal/);
  assert.doesNotMatch(out, /Turn notifications on/);
  const unread = html(h(UI.ControlsPageView, { resp: null, error: 'down' }));
  assert.match(unread, /can’t read SAiM’s settings/);
  assert.equal(M.pauseMinutesToEndOfDay(F.at(23, 30)), 30);
});

// ── Field ───────────────────────────────────────────────────────────────────

test('the field is the control’s, unchanged: imported from shared-ui, never copied or redrawn', () => {
  const shell = fs.readFileSync(path.join(V2, 'Shell.jsx'), 'utf8');
  assert.match(shell, /from '\.\.\/\.\.\/shared-ui\/Field'/);
  assert.match(shell, /from '\.\.\/\.\.\/shared-ui\/fieldDrive\.mjs'/);
  for (const f of fs.readdirSync(V2)) {
    assert.doesNotMatch(fs.readFileSync(path.join(V2, f), 'utf8'), /getContext\(|<canvas/, `${f} draws nothing of its own`);
  }
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'Field.jsx', 'Field.css', 'fieldDrive.mjs', 'useFieldDrive.js'], { cwd: SHARED });
  } catch (e) {
    if (e.status === 1) assert.fail('shared-ui field files differ from HEAD');
  }
});

test('the drive is useFieldDrive’s mapping: a missing read is degraded, never calm', () => {
  assert.deepEqual(M.driveFrom(null), { activity: undefined, confidenceLevel: 'low', quiet: false, degraded: true, pressing: false });
  const d = M.driveFrom({ context: { activity: 'working', confidence: { level: 'high' } }, quiet: true, poolAvailable: true, primary: { urgency: 'critical' } }, (p) => p.urgency === 'critical');
  assert.deepEqual(d, { activity: 'working', confidenceLevel: 'high', quiet: true, degraded: false, pressing: true });
  const src = fs.readFileSync(path.join(SHARED, 'useFieldDrive.js'), 'utf8');
  for (const k of ['activity', 'confidenceLevel', 'quiet', 'degraded', 'pressing']) assert.match(src, new RegExp(`${k}:`), `useFieldDrive still drives ${k}`);
});

// ── Isolation ───────────────────────────────────────────────────────────────

test('nothing the control builds can reach v2, and the control config never mentions it', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const sources = [...walk(path.join(APP, 'src')), ...walk(SHARED)].filter((f) => /\.(m?jsx?|cjs)$/.test(f));
  assert.ok(sources.length > 20, 'positive control: the scan saw the control sources');
  for (const f of sources) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /alt-v2/, `${f} must not reach alt-v2`);
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt/i);
});

test('v2 cannot push or count itself as the control: no service worker, no subscription, no screen tracking', () => {
  const files = fs.readdirSync(V2).filter((f) => /\.(m?jsx?)$/.test(f));
  assert.ok(files.includes('App.jsx'), 'positive control');
  for (const f of files) {
    const t = fs.readFileSync(path.join(V2, f), 'utf8');
    assert.doesNotMatch(t, /serviceWorker|registerSW|PushManager|usePushSubscription|useScreenTracking|src\/views\/Controls/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.alt2.js'), 'utf8'), /VitePWA|vite-plugin-pwa/);
});

test('the v2 env carries no secret and only the treatment’s hosts', () => {
  const lines = fs.readFileSync(path.join(APP, '.env.alt2'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length >= 4, 'positive control');
  assert.ok(!lines.some((l) => /VAULT|TOKEN|SECRET|PIN|KEY/.test(l.split('=')[0])));
  const hosts = lines.find((l) => l.startsWith('VITE_ALLOWED_HOSTS=')).split('=')[1].split(',');
  assert.ok(hosts.includes('saim-alt.nickward.co.uk'));
  assert.ok(!hosts.some((x) => /^(saim|sara|saim-alt-v1)\.nickward\.co\.uk$|^saim-nickward\.netlify\.app$/.test(x)), 'never the control’s or v1’s hosts');
});

// ── The `working` composition, wired (14 Oct 2026) ──────────────────────────

test('working: an active block with a named step carries the block, NEURO’s actions, tools and the rail', () => {
  const s = sc('active-block');
  const v = M.workingView(s);
  assert.equal(v.current.kind, 'block');
  assert.equal(v.current.title, 'Build the Q4 cover rota spreadsheet');
  assert.equal(v.step, 'Fill in the week-1 shift breakdown');
  assert.deepEqual(v.actions.map((a) => a.say), ['That’s done', 'I got pulled away'], 'a live session: no second "I’m on it"');
  assert.equal(v.tools.recommended.id, 'excel');
  assert.equal(v.next.title, 'Weekly support leads');
  assert.equal(v.next.inText, 'In 1 h 8 min');
});

test('working: a running meeting is the current slot, with its own sentences, and no tools without a step', () => {
  const s = sc('active-block');
  const meetingNow = F.at(11, 10);
  const v = M.workingView({ ...s, now: meetingNow, canonical: { ...s.canonical, agenda: { ...s.canonical.agenda, events: s.canonical.agenda.events.map((e) => ({ ...e, running: e.subject === 'Weekly support leads' })) } }, session: { session: null }, adhd: { blockNow: null } });
  assert.equal(v.current.kind, 'meeting');
  assert.equal(v.current.label, 'In a meeting');
  assert.equal(v.tools, null);
  assert.ok(!v.actions.some((a) => a.intent && a.intent.kind === 'start-block'));
});

test('working: a block with no session offers "I’m on it" as a real session start', () => {
  const s = sc('active-block');
  const v = M.workingView({ ...s, session: { session: null } });
  assert.equal(v.actions[0].say, 'I’m on it');
  assert.equal(v.actions[0].intent.kind, 'start-block');
  assert.equal(v.actions[0].intent.taskId, s.adhd.blockNow.tasks[0].taskId);
  assert.equal(v.tools, null, 'no named step yet → no tools');
});

test('working: an absent part is hidden, never invented — and nothing replaces the surface', () => {
  const v = M.workingView({ canonical: { context: { activity: 'steady' }, agenda: { known: false } }, adhd: { blockNow: null }, taskBlocks: null, session: null });
  assert.equal(v.current, null);
  assert.ok(v.note, 'one honest line instead');
  assert.equal(v.next, null);
  assert.equal(v.held, null, 'no held list read → no held card');
  assert.equal(v.judgement, null, 'approvals not read → no judgement card');
  const out = html(h(UI.WorkingView, { v }));
  assert.doesNotMatch(out, /Holding the day|Needs your judgement|Best next place|>Next</);
  assert.match(out, /wk__main/);
});

test('working: an unknown approvals read hides the card; a known zero says nothing is waiting', () => {
  const s = sc('active-block');
  assert.equal(M.workingView({ ...s, canonical: { ...s.canonical, approvals: { known: false } } }).judgement, null);
  const v = M.workingView({ ...s, canonical: { ...s.canonical, approvals: { known: true, needsApproval: 0, needsReview: 0 } } });
  assert.equal(v.judgement.count, 0);
  assert.match(html(h(UI.WorkingView, { v })), /Nothing waiting for your judgement/);
});

test('working: the approved fixture still renders the approved layout', () => {
  const out = html(h(UI.WorkingFixture));
  for (const s of ['ACTIVE · 14:00–15:00', 'Customer Care training plan and refreshers', 'Best next place', 'Open Claude', 'Holding the day', 'Needs your judgement']) assert.ok(out.includes(s), s);
});

// ── In a meeting: holding the moment ────────────────────────────────────────

function inMeeting({ writeUp = true } = {}) {
  const now = F.at(15, 9);
  const ev = (sh, sm, eh, em, subject, attendeesOther) => ({
    start: `2026-10-14T${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00.0000000`,
    end: `2026-10-14T${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00.0000000`,
    subject, attendeesOther, allDay: false, running: F.at(sh, sm) <= now && now < F.at(eh, em),
  });
  const events = [ev(15, 0, 15, 30, 'Weekly support leads', true)];
  if (writeUp) events.push(ev(15, 30, 15, 35, 'Plaud admin — Weekly support leads', false));
  events.push(ev(15, 35, 15, 55, 'Task block: Reply to the supplier', false));
  const s = sc('upcoming-meeting');
  return {
    now,
    adhd: { blockNow: null },
    session: { session: null },
    taskBlocks: { ok: true, blocks: [{ blockId: 9, tasks: [{ taskId: 90, text: 'Reply to the supplier' }], dateKey: '2026-10-14', startTime: '15:35', endTime: '15:55', status: 'scheduled', passed: false }] },
    canonical: {
      ...s.canonical, primary: { kind: 'context', title: 'In a meeting' }, context: { activity: 'in-meeting' },
      agenda: { known: true, scope: 'today', events },
      utterances: [
        { say: 'That’s finished', intent: { kind: 'meeting', action: 'finished', key: 'k' } },
        { say: 'I’m not in it', intent: { kind: 'meeting', action: 'not-attending', key: 'k' } },
      ],
      dropped: [{ id: 'a', type: 'todo' }, { id: 'b', type: 'capacity' }, { id: 'c', type: 'capacity' }, { id: 'd', type: 'meeting' }],
      approvals: { known: true, needsApproval: 0, needsReview: 0 },
    },
  };
}

test('in a meeting: time left, the transition after it, the write-up cue, and the rail moves on to what follows', () => {
  const v = M.workingView(inMeeting());
  assert.equal(v.current.kind, 'meeting');
  assert.equal(v.meeting.remaining, '21 minutes left');
  assert.equal(v.meeting.after.start, '15:30');
  assert.equal(v.meeting.after.title, 'Write-up time for this meeting');
  assert.ok(v.meeting.cue);
  assert.equal(v.next.label, 'Then');
  assert.equal(v.next.title, 'Reply to the supplier', 'the rail does not repeat the transition');
  assert.equal(v.held.summary, 'Held until you’re out: overdue tasks, 2 capacity checks and a diary reminder.');
  assert.deepEqual(v.actions.map((a) => a.say), ['That’s finished', 'I’m not in it']);
  const out = html(h(UI.WorkingView, { v, onAct: () => {} }));
  for (const s2 of ['21 minutes left', 'SAiM is holding everything else.', 'After this', 'Write-up time for this meeting', 'Held until you’re out']) assert.ok(out.includes(s2.replace(/’/g, '’')), s2);
  assert.match(out, /wk__railtitle">Reply to the supplier<\/p><p class="wk__railmeta">15:35 · In 26 minutes/, 'title and time on separate lines');
});

test('in a meeting: no write-up booked means no continuity cue — never an invented one', () => {
  const v = M.workingView(inMeeting({ writeUp: false }));
  assert.equal(v.meeting.cue, null);
  assert.equal(v.meeting.after.title, 'Reply to the supplier');
  assert.equal(v.next, null, 'nothing after the transition → no rail card');
});

test('in a meeting: a write-up block for a DIFFERENT meeting is not this one’s', () => {
  const s = inMeeting();
  s.canonical.agenda.events[1].subject = 'Plaud admin — Some other meeting';
  assert.equal(M.workingView(s).meeting.cue, null);
});

// ── Task titles for a time-labelled slot (display only) ─────────────────────

test('display title: the scheduling talk of the moment it was said is dropped, the task is kept', () => {
  // The real title from Nick's diary, 14 Oct 2026.
  assert.equal(
    M.displayTaskTitle('West Hants Tennis Club: resolve the outstanding ticket tomorrow (8 October 2026). Must do tomorrow.'),
    'West Hants Tennis Club: resolve the outstanding ticket',
  );
  assert.equal(M.displayTaskTitle('Nick to reply formally to Stephen’s flexible working request. Due Friday.'), 'Nick to reply formally to Stephen’s flexible working request');
  assert.equal(M.displayTaskTitle('Send the report (2026-10-20) to Chris'), 'Send the report to Chris');
  assert.equal(M.displayTaskTitle('Call Bob today'), 'Call Bob');
});

test('display title: a bracket that is not a date, a plain title and a title that would be gutted are left alone', () => {
  assert.equal(M.displayTaskTitle('Review phase plan (phase 2)'), 'Review phase plan (phase 2)');
  assert.equal(M.displayTaskTitle('NT-24162: Survey West Hants Responses not showing on CSV and Being recorded'), 'NT-24162: Survey West Hants Responses not showing on CSV and Being recorded');
  assert.equal(M.displayTaskTitle('Tidy today'), 'Tidy today');
  assert.equal(M.displayTaskTitle(''), '');
});

test('display title: the rail and the current block show the tidy title, with the full wording kept for hover', () => {
  const s = inMeeting();
  s.taskBlocks.blocks[0].tasks[0].text = 'Reply to the supplier tomorrow (15 October 2026). Must do tomorrow.';
  const v = M.workingView(s);
  assert.equal(v.next.title, 'Reply to the supplier');
  assert.equal(v.next.fullTitle, 'Reply to the supplier tomorrow (15 October 2026). Must do tomorrow.');
  const out = html(h(UI.WorkingView, { v }));
  assert.match(out, /title="Reply to the supplier tomorrow \(15 October 2026\)\. Must do tomorrow\.">Reply to the supplier</);
});

// ── Precedence: a running block holds the moment (Nick, 14 Oct 2026) ───────
// Fixture shaped on the live 16:10 read: block 115 running, the EOD ritual as
// NEURO's primary, five tasks due today (one is the block's own).

function blockOverRitual({ blockText = 'NT-24162: Survey West Hants Responses not showing on CSV and Being recorded', taskBlocks = undefined } = {}) {
  const now = F.at(16, 10);
  const commit = (id, description, date) => ({ id: `commitment:task:${id}`, kind: 'commitment', direction: 'i-owe', state: 'open', description, taskId: `task:neuro:${id}`, due: { date, kind: 'set', label: 'today · planned date' } });
  return {
    now,
    session: { session: null },
    adhd: { blockNow: { blockId: 115, running: true, startTime: '16:00', endTime: '17:30', tasks: [{ taskId: 345, text: blockText }] } },
    taskBlocks: taskBlocks !== undefined ? taskBlocks : { ok: true, blocks: [
      { blockId: 115, dateKey: '2026-10-14', startTime: '16:00', endTime: '17:30', status: 'scheduled', passed: false, tasks: [{ taskId: 345, text: blockText }] },
      { blockId: 118, dateKey: '2026-10-14', startTime: '17:30', endTime: '17:45', status: 'scheduled', passed: false, tasks: [{ taskId: 400, text: 'File the expenses' }] },
    ] },
    canonical: {
      context: { activity: 'ritual' },
      work: { atDesk: true, deskKnown: true },
      primary: { kind: 'context', id: 'context-ritual', title: 'EOD outstanding', reason: 'The end-of-day wrap hasn’t been done yet.' },
      agenda: { known: true, scope: 'today', events: [
        { start: '2026-10-14T16:00:00.0000000', end: '2026-10-14T17:30:00.0000000', subject: `Task block: ${blockText}`, attendeesOther: false, allDay: false, running: true },
        { start: '2026-10-14T17:30:00.0000000', end: '2026-10-14T17:45:00.0000000', subject: 'Task block: File the expenses', attendeesOther: false, allDay: false, running: false },
      ] },
      dropped: [],
      utterances: [],
      approvals: { known: true, needsApproval: 0, needsReview: 0 },
      situation: { sections: { commitments: [
        commit(283, 'Nick Ward to send breakdown of Parsons contacts', '2026-10-14'),
        commit(345, blockText, '2026-10-14'),
        commit(344, 'Set and confirm Heidi’s end date before September 30; consider short retention into the Christmas period', '2026-10-14'),
        commit(375, 'West Hants Tennis Club: resolve the outstanding ticket tomorrow (8 October 2026). Must do tomorrow.', '2026-10-14'),
        commit(200, 'Old overdue thing', '2026-10-10'),
        commit(500, 'Not yet due', '2026-10-20'),
      ] } },
    },
  };
}

test('precedence 1: a running block wins over the EOD ritual for the headline and the presence line', () => {
  const v = M.workingView(blockOverRitual());
  assert.equal(v.current.kind, 'block');
  assert.equal(v.current.label, 'Active');
  assert.equal(v.current.title, 'NT-24162: Survey West Hants Responses not showing on CSV and Being recorded');
  assert.equal(v.presence, 'SAiM · desk active · in a task block');
  assert.ok(!/ritual/.test(v.presence));
  assert.equal(v.actions[0].say, 'I’m on it');
});

test('precedence 1: a focus session or a meeting still says so beside a running block', () => {
  const s = blockOverRitual();
  assert.match(M.workingView({ ...s, canonical: { ...s.canonical, context: { activity: 'in-focus-session' } } }).presence, /focused$/);
  assert.match(M.presenceLine({ context: { activity: 'ritual' } }), /ritual time$/, 'no block → the ritual is what is happening');
});

test('precedence 2: the ritual and overdue/due-today work are held, never the main situation; the block’s own task is not', () => {
  const v = M.workingView(blockOverRitual());
  const titles = v.held.items.map((i) => i.title);
  assert.equal(titles[0], 'End-of-day wrap');
  assert.ok(titles.includes('Nick Ward to send breakdown of Parsons contacts'));
  assert.ok(titles.includes('Old overdue thing'));
  assert.ok(!titles.some((t) => /NT-24162/.test(t)), 'the block’s own task is the slot, not held');
  assert.ok(!titles.includes('Not yet due'));
  assert.equal(v.held.count, 5);
  assert.equal(v.held.summary, 'Held while this block runs: the end-of-day wrap, 1 overdue task and 3 tasks due today.');
});

test('precedence 3: a solo task block is the next transition — and still is when the block list was not read', () => {
  const v = M.workingView(blockOverRitual());
  assert.equal(v.next.title, 'File the expenses');
  assert.equal(v.next.time, '17:30');
  assert.equal(v.next.kind, 'block');
  const unread = M.workingView(blockOverRitual({ taskBlocks: null }));
  assert.equal(unread.next && unread.next.title, 'File the expenses', 'no attendees never removes a transition');
  assert.equal(unread.next.kind, 'block');
});

test('precedence 4: wording that contradicts the planned date is flagged and shown neutrally', () => {
  const v = M.workingView(blockOverRitual());
  const wh = v.held.items.find((i) => /West Hants Tennis/.test(i.title));
  assert.equal(wh.title, 'West Hants Tennis Club: resolve the outstanding ticket');
  assert.equal(wh.stale.taskId, 375);
  assert.match(wh.stale.reason, /“tomorrow” but it’s planned for today/);
  const heidi = v.held.items.find((i) => /Heidi/.test(i.title));
  assert.equal(heidi.stale, null, 'a bare deadline with no year is not judged');
  assert.equal(M.staleWording('Do it on 14 October 2026', '2026-10-14', F.at(16, 10)), null);
  assert.match(M.staleWording('Send it (2026-10-08)', '2026-10-14', F.at(16, 10)), /names 8 October 2026/);
  assert.equal(M.staleWording('Do it tomorrow', '2026-10-15', F.at(16, 10)), null);
});

test('precedence 4: a stale CURRENT block is flagged under its neutral title, with a route to fix it in NEURO', () => {
  const v = M.workingView(blockOverRitual({ blockText: 'West Hants Tennis Club: resolve the outstanding ticket tomorrow (8 October 2026). Must do tomorrow.' }));
  assert.equal(v.current.title, 'West Hants Tennis Club: resolve the outstanding ticket');
  assert.equal(v.current.stale.taskId, 345);
  const out = html(h(UI.WorkingView, { v, neuroUrl: 'https://neuro.example' }));
  assert.match(out, /wording is out of date/);
  assert.match(out, /\?view=todos/);
  assert.doesNotMatch(out.split('wk__title')[1].split('</h1>')[0], /tomorrow/);
});

test('precedence 2: rendered — Holding the day names what it holds and counts out-of-date wording', () => {
  const v = M.workingView(blockOverRitual());
  const out = html(h(UI.WorkingView, { v, neuroUrl: 'https://neuro.example', onToggleHeld: () => {}, heldOpen: true }));
  assert.match(out, /Held while this block runs: the end-of-day wrap/);
  assert.match(out, /1 held task has out-of-date wording/);
  assert.match(out, /wording out of date/);
});
