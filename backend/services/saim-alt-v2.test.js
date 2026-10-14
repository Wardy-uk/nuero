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
  assert.match(out, /SAiM Alt/, 'the treatment is marked');
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
