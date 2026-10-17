'use strict';

/**
 * SAiM Alt v3 — the policy-driven desktop A/B release (16 Oct 2026).
 *
 * The adapter's view (saim/app/alt-v2-manifest/ManifestView.jsx) in LIVE mode,
 * inside the Alt v2 shell (saim/app/alt-v3). What this pins:
 *   - a control works only for what the payload offers: SAiM's own intent of a
 *     kind the shell carries out, an app the laptop declared, a real link, an ask
 *     with a task id. Anything else renders inert — nothing is invented;
 *   - each press calls the right handler with SAiM's own data, and the activity
 *     answer is sent ONLY by Nick's press (no write happens at render);
 *   - the local preview (live = null) is still entirely inert;
 *   - isolation: the control never reaches alt-v3, no service worker or push
 *     subscription, only the treatment's hosts, no secret in the env.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'saim', 'app');
const ADAPTER_DIR = path.join(APP, 'alt-v2-manifest');
const V3 = path.join(APP, 'alt-v3');
const GOLDEN = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '__golden__', 'alt-manifest', `${n}.json`), 'utf8'));

let M; let View;

function cssStub() {
  return {
    name: 'css-stub',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    },
  };
}

test.before(async () => {
  M = await import(pathToFileURL(path.join(ADAPTER_DIR, 'manifest.mjs')).href);
  const out = await esbuild.build({
    entryPoints: [path.join(ADAPTER_DIR, 'ManifestView.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], plugins: [cssStub()], logLevel: 'silent',
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.default;
});

const noop = () => {};
const LIVE = (over = {}) => ({ onAct: noop, onDeskOpen: noop, deskStates: {}, onChoose: noop, linkFor: (h) => M.linkHref('https://neuro.example', h), busy: false, ...over });
const html = (vm, live) => renderToString(React.createElement(View, { v: vm, live }));
const buttonsNamed = (h, name) => (h.match(/<button[^>]*>[\s\S]*?<\/button>/g) || []).filter((b) => b.replace(/<[^>]+>/g, '').includes(name));
const enabled = (b) => !/\sdisabled(=|\s|>)/.test(b);

/** Expand the element tree (function components called with their props) and return every element with an onClick. */
function clickables(el, out = []) {
  if (el == null || typeof el !== 'object') return out;
  if (Array.isArray(el)) { el.forEach((e) => clickables(e, out)); return out; }
  if (typeof el.type === 'function') return clickables(el.type(el.props), out);
  if (el.props && typeof el.props.onClick === 'function') out.push(el);
  const kids = el.props && el.props.children;
  if (typeof kids === 'function') return out;
  clickables(kids, out);
  return out;
}
const label = (el) => {
  const t = (x) => (x == null || typeof x === 'boolean' ? '' : typeof x === 'string' || typeof x === 'number' ? String(x) : Array.isArray(x) ? x.map(t).join('') : t(x.props && x.props.children));
  return t(el.props.children);
};

// ── Pure guards ─────────────────────────────────────────────────────────────

test('linkHref: neuro: links open in NEURO’s web app; https as given; anything else is not a link', () => {
  assert.equal(M.linkHref('https://pi5.example/', 'neuro:?item=task%3A283'), 'https://pi5.example/?item=task%3A283');
  assert.equal(M.linkHref('https://pi5.example', 'neuro:?view=actions'), 'https://pi5.example/?view=actions');
  assert.equal(M.linkHref('https://pi5.example', 'https://teams.microsoft.com/l/meetup-join/x'), 'https://teams.microsoft.com/l/meetup-join/x');
  for (const bad of ['javascript:alert(1)', 'http://plain.example', 'neuro:', '', null, 'ms-teams://x']) assert.equal(M.linkHref('https://pi5.example', bad), null, String(bad));
  assert.equal(M.linkHref(null, 'neuro:?item=task%3A1'), null, 'no NEURO base: no link rather than a guessed host');
});

test('actable: only the intent kinds the shell carries out', () => {
  // `room` added 17 Oct 2026: App.onAct posts the offer key to /api/rooms/:key/accept|decline.
  assert.deepEqual([...M.ACTABLE].sort(), ['act', 'block-next', 'meeting', 'navigate', 'room', 'session', 'start-block']);
  assert.equal(M.actable({ say: 'x', intent: { kind: 'start-block' } }), true);
  assert.equal(M.actable({ say: 'x', intent: { kind: 'approve' } }), false);
  assert.equal(M.actable({ say: 'x', intent: null }), false);
});

// ── Live render: enabled exactly where the payload offers ───────────────────

test('active block (s05): “Start focus”, the desk app and its alternatives are live; nothing is disabled that SAiM offered', () => {
  const vm = GOLDEN('s05-protected-block');
  const h = html(vm, LIVE());
  assert.ok(enabled(buttonsNamed(h, 'Start focus')[0]), 'SAiM’s action is pressable');
  assert.ok(enabled(buttonsNamed(h, 'Open Claude')[0]), 'the declared desk app opens');
  for (const alt of ['Music', 'Word']) assert.ok(enabled(buttonsNamed(h, alt)[0]), `${alt} alternative opens`);
  assert.equal(/read-only preview/i.test(h), false, 'no preview wording in the live build');
});

test('a press calls the shell with SAiM’s own intent and app id — nothing re-derived', () => {
  const calls = [];
  const vm = GOLDEN('s05-protected-block');
  const tree = View({ v: vm, live: LIVE({ onAct: (a) => calls.push(['act', a]), onDeskOpen: (app) => calls.push(['desk', app]) }) });
  const els = clickables(tree);
  els.find((e) => label(e) === 'Start focus').props.onClick();
  els.find((e) => label(e) === 'Open Claude').props.onClick();
  els.find((e) => label(e).startsWith('Word')).props.onClick();
  assert.deepEqual(calls, [
    ['act', { say: 'Start focus', lead: true, intent: { kind: 'start-block', taskId: 600, text: 'Customer Care training plan and refreshers', blockId: 130, minutes: 70 } }],
    ['desk', 'claude'], ['desk', 'word'],
  ]);
});

test('an action whose intent the shell cannot carry out is shown inert', () => {
  const vm = { ...GOLDEN('s05-protected-block'), actions: [{ say: 'Approve it', intent: { kind: 'approve', id: 1 } }] };
  const b = buttonsNamed(html(vm, LIVE()), 'Approve it')[0];
  assert.ok(b && !enabled(b), 'unknown kind: disabled');
  assert.match(b, /can’t do that|can&#x27;t do that|can&#39;t do that|can’t/);
});

test('the laptop is unreachable: desk destinations stay inert rather than pretending to open', () => {
  const vm = GOLDEN('s05-protected-block');
  const h = html(vm, LIVE({ onDeskOpen: null }));
  assert.ok(!enabled(buttonsNamed(h, 'Open Claude')[0]));
  assert.equal(buttonsNamed(h, 'Music').length, 0, 'an alternative with no way to open is plain text, not a button');
});

test('a link destination is a real <a> to NEURO’s exact item; an unsafe href is not a link', () => {
  const base = GOLDEN('s05-protected-block');
  const linkVm = { ...base, handoff: { ...base.handoff, primary: { name: 'The task in NEURO', label: 'Open the task in NEURO', type: 'link', href: 'neuro:?item=task%3A600', app: null, where: 'opens in a new tab' }, alternatives: [] } };
  const h = html(linkVm, LIVE());
  assert.match(h, /<a class="wk__open" href="https:\/\/neuro\.example\/\?item=task%3A600" target="_blank" rel="noopener noreferrer">Open the task in NEURO<\/a>/);
  const bad = { ...linkVm, handoff: { ...linkVm.handoff, primary: { ...linkVm.handoff.primary, href: 'javascript:alert(1)' } } };
  const hb = html(bad, LIVE());
  assert.equal(/<a [^>]*href=/.test(hb), false, 'no link for an unsafe href');
  assert.ok(!enabled(buttonsNamed(hb, 'Open the task in NEURO')[0]));
});

test('“already in front” is a statement, never a launch', () => {
  const base = GOLDEN('s05-protected-block');
  const vm = { ...base, handoff: { ...base.handoff, primary: { ...base.handoff.primary, type: 'already' } } };
  const h = html(vm, LIVE());
  assert.match(h, /Already in front — no launch needed/);
  assert.equal(buttonsNamed(h, 'Open Claude').length, 0);
});

// ── An activity SAiM does not know: one route, choices behind "Choose a way in…" ──

// The view-model's own shape (manifest() drops "Not sure" and adds the task's link).
const ASK = { question: 'What will you use?', taskId: 600, neuroHref: 'neuro:?item=task%3A600', deviceSpecific: true, options: [
  { choice: 'draft', label: 'Claude', suggested: true, basis: 'from where it came from' },
  { choice: 'write', label: 'Word', suggested: false, basis: null },
] };
const askVm = () => ({ ...GOLDEN('s05-protected-block'), handoff: null, ask: ASK, handoffNote: 'NEURO doesn’t know what kind of work this is yet, so SAiM won’t guess an app.' });

test('unknown activity: “Open task in NEURO” is the one primary route, to that exact task', () => {
  const h = html(askVm(), LIVE());
  assert.match(h, /<a class="wk__open" href="https:\/\/neuro\.example\/\?item=task%3A600" target="_blank" rel="noopener noreferrer">Open task in NEURO<\/a>/);
  assert.equal((h.match(/class="wk__open"/g) || []).length, 1, 'exactly one primary control');
  assert.match(h, /NEURO doesn’t know what kind of work this is yet/);
  assert.equal(/Not sure/.test(h), false, '“Not sure” is not another decision');
});

test('unknown activity: the choices sit behind a CLOSED “Choose a way in…”, never as the main screen', () => {
  const h = html(askVm(), LIVE());
  const det = h.match(/<details class="mf__way"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(det, 'the options are inside the disclosure');
  assert.equal(/\bopen\b/.test(det[1]), false, 'closed until Nick opens it');
  assert.match(det[2], /<summary>Choose a way in…<\/summary>/);
  const outside = h.replace(det[0], '');
  assert.equal(buttonsNamed(outside, 'Claude').length + buttonsNamed(outside, 'Word').length, 0, 'no activity button outside the disclosure');
  assert.equal(/wk__act--lead/.test(det[2]), false, 'no option is styled as a lead action');
});

test('unknown activity: a choice is saved only when pressed, for THAT task', () => {
  const sent = [];
  const tree = View({ v: askVm(), live: LIVE({ onChoose: (t, c) => sent.push([t, c]) }) });
  assert.deepEqual(sent, [], 'rendering writes nothing');
  const els = clickables(tree);
  assert.equal(els.some((e) => label(e).startsWith('Open task')), false, 'the NEURO route is a link, not a write');
  els.find((e) => label(e).startsWith('Word')).props.onClick();
  assert.deepEqual(sent, [[600, 'write']]);
});

test('unknown activity: no link, no task id, or the preview — nothing is pressable that cannot work', () => {
  const noLink = { ...askVm(), ask: { ...ASK, neuroHref: null } };
  const hn = html(noLink, LIVE());
  assert.equal(/<a [^>]*href=/.test(hn), false);
  assert.ok(!enabled(buttonsNamed(hn, 'Open task in NEURO')[0]));
  const noTask = { ...askVm(), ask: { ...ASK, taskId: null } };
  for (const b of buttonsNamed(html(noTask, LIVE()), 'Claude')) assert.ok(!enabled(b));
  const hp = html(askVm(), null);
  assert.equal(/<a [^>]*href=/.test(hp), false, 'preview: no live link');
  for (const b of buttonsNamed(hp, 'Word')) assert.ok(!enabled(b), 'preview: inert');
});

test('view-model: the ask carries the task’s canonical NEURO link and drops “Not sure”', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'public', 'fixtures', 's05-protected-block.json'), 'utf8'));
  p.handoff = { ...p.handoff, handoff: null, reason: 'NEURO doesn’t know what kind of work this is yet, so SAiM won’t guess an app.', ask: { question: 'What will you use?', taskId: 600, deviceSpecific: true, options: [{ choice: 'draft', label: 'Claude', suggested: true, basis: 'source' }, { choice: 'unsure', label: 'Not sure — open the task in NEURO' }] } };
  const vm = M.manifest(p);
  assert.equal(vm.refused, null);
  assert.equal(vm.ask.taskId, 600);
  assert.equal(vm.ask.neuroHref, 'neuro:?item=task%3A600');
  assert.deepEqual(vm.ask.options.map((o) => o.choice), ['draft']);
  p.handoff.ask.taskId = null;
  const noId = M.manifest(p);
  assert.equal(noId.ask ? noId.ask.neuroHref : null, null, 'no task id: no link is invented (the contract may refuse the ask outright)');
});

test('known activity: the approved primary app + limited alternatives pattern is unchanged', () => {
  const h = html(GOLDEN('s05-protected-block'), LIVE());
  assert.ok(enabled(buttonsNamed(h, 'Open Claude')[0]));
  assert.equal(/Choose a way in/.test(h), false);
  assert.equal(/Open task in NEURO/.test(h), false);
});

test('copy: the overdue sentence and the unnamed held line', () => {
  assert.equal(M.leadSentence('still open, 3 days past its date'), 'Still open — three days overdue.');
  assert.equal(M.leadSentence('still open, 1 day past its date'), 'Still open — one day overdue.');
  assert.equal(M.leadSentence('still open, 40 days past its date'), 'Still open — 40 days overdue.');
  assert.equal(M.leadSentence('due today'), 'due today', 'anything else is untouched');
  assert.equal(M.unnamedLine(4), '4 other commitments held — details in NEURO.');
  assert.equal(M.unnamedLine(1), '1 other commitment held — details in NEURO.');
  const p = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'public', 'fixtures', 's05-protected-block.json'), 'utf8'));
  p.saim = { ...p.saim, display: { ...p.saim.display, lead: { ...p.saim.display.lead, sentence: 'still open, 3 days past its date' } } };
  assert.equal(M.manifest(p).sentence, 'Still open — three days overdue.', 'applied to the lead');
});

// ── The page and its one write ──────────────────────────────────────────────

test('LiveSaim: the only write it adds is POST /api/task-activity with via “saim”, inside onChoose', () => {
  const src = fs.readFileSync(path.join(ADAPTER_DIR, 'LiveSaim.jsx'), 'utf8');
  const posts = src.match(/apiFetch\([^)]*\)/g) || [];
  assert.equal(posts.length, 1, 'one call');
  assert.match(posts[0], /\/api\/task-activity\//);
  assert.match(src, /JSON\.stringify\(\{ choice, via: 'saim' \}\)/);
  const onChoose = src.slice(src.indexOf('const onChoose'), src.indexOf('return (', src.indexOf('const onChoose')));
  assert.match(onChoose, /apiFetch/, 'the write lives in the press handler');
  assert.equal(/useEffect/.test(src), false, 'nothing runs on render');
  assert.match(src, /utterances=\{canonical\.utterances\}/, 'Ask matches SAiM’s own phrases');
});

test('choiceError: saved only when NEURO says so', async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ADAPTER_DIR, 'LiveSaim.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [cssStub(), { name: 'stub', setup(b) { b.onResolve({ filter: /src\/api$|alt-v2\/Dock$/ }, (a) => ({ path: a.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { apiFetch: () => null, default: () => null };', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { choiceError } = mod.exports;
  assert.equal(choiceError({ ok: true, taskId: 600 }), null);
  assert.match(choiceError({ ok: false, error: 'unknown task' }), /^Not saved — unknown task\.$/);
  assert.match(choiceError(null), /nothing was saved/);
});

// ── Isolation ───────────────────────────────────────────────────────────────

test('the control never reaches alt-v3 or the adapter, and its config never mentions an alt build', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const sources = [...walk(path.join(APP, 'src')), ...walk(path.join(ROOT, 'saim', 'shared-ui'))].filter((f) => /\.(m?jsx?|cjs)$/.test(f));
  assert.ok(sources.length > 20, 'positive control');
  for (const f of sources) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /alt-v3|alt-v2-manifest/, f);
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.js'), 'utf8'), /alt/i);
});

test('v3 cannot push: no service worker, no subscription, no screen tracking, no PWA plugin', () => {
  const files = [...fs.readdirSync(V3).map((f) => path.join(V3, f)), path.join(ADAPTER_DIR, 'LiveSaim.jsx'), path.join(ADAPTER_DIR, 'ManifestView.jsx')].filter((f) => /\.(m?jsx?)$/.test(f));
  assert.ok(files.some((f) => f.endsWith('main.jsx')), 'positive control');
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /serviceWorker|registerSW|PushManager|usePushSubscription|useScreenTracking|requestPermission/, f);
  assert.doesNotMatch(fs.readFileSync(path.join(APP, 'vite.config.alt3.js'), 'utf8'), /VitePWA|vite-plugin-pwa/);
});

test('the v3 env carries no secret and only its own hosts — saim. since the 16 Oct 2026 swap', () => {
  const lines = fs.readFileSync(path.join(APP, '.env.alt3'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(lines.length >= 4, 'positive control');
  assert.ok(!lines.some((l) => /VAULT|TOKEN|SECRET|PIN|KEY/.test(l.split('=')[0])));
  const val = (k) => lines.find((l) => l.startsWith(`${k}=`)).split('=')[1];
  const hosts = val('VITE_ALLOWED_HOSTS').split(',');
  assert.ok(hosts.includes('saim.nickward.co.uk'));
  assert.ok(!hosts.some((x) => /^(sara|saim-alt|saim-alt-v1)\.nickward\.co\.uk$|^saim-nickward\.netlify\.app$/.test(x)), 'never the phone’s, the legacy’s or v1’s hosts');
  assert.equal(val('VITE_CANONICAL_URL'), 'https://saim.nickward.co.uk');
  assert.equal(val('VITE_CONTROL_URL'), 'https://saim-alt.nickward.co.uk', 'the comparison link goes to the legacy desktop');
});

test('the legacy desktop env runs only at saim-alt, and the phone build keeps its own hosts', () => {
  const env = (f) => Object.fromEntries(fs.readFileSync(path.join(APP, f), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
  const legacy = env('.env.legacy');
  assert.deepEqual(legacy.VITE_ALLOWED_HOSTS.split(','), ['saim-alt.nickward.co.uk', 'saim-legacy-nickward.netlify.app']);
  assert.equal(legacy.VITE_CANONICAL_URL, 'https://saim-alt.nickward.co.uk');
  assert.equal(legacy.VITE_API_URL, 'https://pi5.tailecb90f.ts.net');
  const prod = env('.env.production');
  assert.ok(prod.VITE_ALLOWED_HOSTS.split(',').includes('sara.nickward.co.uk'), 'the phone build is untouched');
  assert.equal(prod.VITE_CANONICAL_URL, 'https://sara.nickward.co.uk');
});

test('the v3 build ships a kill-switch sw.js (retires the control’s worker at saim.), never a real worker', () => {
  const cfg = fs.readFileSync(path.join(APP, 'vite.config.alt3.js'), 'utf8');
  assert.match(cfg, /fileName: 'sw\.js', source: KILL_SWITCH_SW/);
  const sw = cfg.slice(cfg.indexOf('const KILL_SWITCH_SW'), cfg.indexOf('`;', cfg.indexOf('const KILL_SWITCH_SW')));
  assert.match(sw, /registration\.unregister\(\)/);
  assert.match(sw, /caches\.delete/);
  assert.ok(!/addEventListener\('(fetch|push)'/.test(sw), 'it answers no requests and takes no pushes');
  assert.ok(!/VitePWA|vite-plugin-pwa/.test(cfg), 'no PWA plugin');
});

test('v2 is unchanged when no page is supplied: its entry passes no override', () => {
  const main = fs.readFileSync(path.join(APP, 'alt-v2', 'main.jsx'), 'utf8');
  assert.match(main, /<App \/>/);
  const app = fs.readFileSync(path.join(APP, 'alt-v2', 'App.jsx'), 'utf8');
  assert.match(app, /renderSaim = null/);
  assert.match(app, /driveFor \? driveFor\(day\.canonical\) : driveFrom\(day\.canonical, isPressing\)/);
});

// ── Display fixes from the first real-data inspection (16 Oct 2026) ─────────

const s05 = () => JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, 'public', 'fixtures', 's05-protected-block.json'), 'utf8'));
const FRESH_AT_DESK = { known: true, atDesk: true, deskKnown: true, host: 'MacBook Air' };

test('header: “desk active” only for a current report with an app in front; otherwise never presence', () => {
  assert.equal(M.deskWord(FRESH_AT_DESK), 'desk active');
  assert.equal(M.deskWord({ deskKnown: true, atDesk: false }), 'laptop not in use');
  for (const w of [null, undefined, {}, { deskKnown: false, atDesk: false }, { deskKnown: false, atDesk: true }, { known: false }]) {
    assert.equal(M.deskWord(w), 'desk state not current', JSON.stringify(w));
  }
  const p = s05();
  assert.equal(M.manifest({ ...p, work: FRESH_AT_DESK }).presence, 'SAiM · desk active · working');
  assert.equal(M.manifest({ ...p, work: { ...FRESH_AT_DESK, deskKnown: false } }).presence, 'SAiM · desk state not current · working');
  assert.equal(M.manifest(p).presence, 'SAiM · desk state not current · working', 'no work block: not current');
  assert.doesNotMatch(M.manifest({ ...p, candidates: null }).presence, /desk active/, 'the refusal claims no desk at all');
});

// The exact held shape the live payload carried at 18:42 on 15 Oct 2026 (types and the gate's status line).
const LIVE_HELD = [
  { title: 'capacity', why: 'not working — driving', returns: 'after this' },
  { title: 'capacity', why: 'not working — driving', returns: 'after this' },
  { title: 'todo', why: 'not working — driving', returns: 'after this' },
  { title: 'email', why: 'not working — driving', returns: 'after this' },
];
const withHeld = (held) => { const p = s05(); p.saim = { ...p.saim, display: { ...p.saim.display, held } }; return p; };

test('held: type words and the gate’s status line are never shown — unnamed items collapse into a count', () => {
  const vm = M.manifest(withHeld(LIVE_HELD));
  assert.equal(vm.refused, null);
  assert.deepEqual({ count: vm.rail.held.count, items: vm.rail.held.items, more: vm.rail.held.more, unnamed: vm.rail.held.unnamed }, { count: 4, items: [], more: [], unnamed: 4 });
  const h = html(vm, LIVE()).replace(/<[^>]+>/g, ' ');
  assert.match(h, /4 items held — back after this\./);
  assert.match(h, /4 other commitments held — details in NEURO\./);
  for (const raw of ['capacity', 'todo', 'not working', 'driving']) assert.equal(h.includes(raw), false, `“${raw}” never shown`);
});

test('held: a real label is listed with a human reason; the off-duty status line is reworded', () => {
  const vm = M.manifest(withHeld([
    { title: 'Survey West Hants responses not showing on CSV', why: 'Sized at 4h', returns: 'at 17:30' },
    { title: 'Reply to Simon', why: 'not working — driving', returns: 'at 17:30' },
    { title: 'todo', why: 'not working — driving', returns: 'at 17:30' },
  ]));
  assert.deepEqual(vm.rail.held.items.map((x) => [x.title, x.why]), [['Survey West Hants responses not showing on CSV', 'Sized at 4h'], ['Reply to Simon', 'held while you’re off duty']]);
  assert.equal(vm.rail.held.unnamed, 1);
  assert.match(html(vm, LIVE()), /1 other commitment held — details in NEURO\./);
  assert.equal(M.heldLabel('Held back'), null, 'the generic fallback is not a label');
  assert.equal(M.heldWhy('a focus session is running — held until it ends'), 'a focus session is running — held until it ends', 'a sentence is kept');
});

test('held: an unnamed POSSIBLE RISK is never collapsed away', () => {
  const vm = M.manifest(withHeld([{ title: 'email', why: 'possible risk — not yet classified', returns: 'after this' }]));
  assert.deepEqual(vm.rail.held.items.map((x) => [x.title, x.risky]), [['An item without a name', true]]);
  assert.equal(vm.rail.held.unnamed, 0);
});

test('leading structural punctuation is removed for display; a balanced quote or bracket is kept', () => {
  assert.equal(M.tidyText('"NT-24162: Survey West Hants Responses not showing on CSV and Being...'), 'NT-24162: Survey West Hants Responses not showing on CSV and Being...');
  assert.equal(M.tidyText('“Unclosed curly'), 'Unclosed curly');
  assert.equal(M.tidyText('- • : Reply to Simon'), 'Reply to Simon');
  assert.equal(M.tidyText('(no closing bracket'), 'no closing bracket');
  assert.equal(M.tidyText('"Quoted" project review'), '"Quoted" project review');
  assert.equal(M.tidyText('“Quoted” review'), '“Quoted” review');
  assert.equal(M.tidyText('(Draft) plan'), '(Draft) plan');
  assert.equal(M.tidyText('Book my car in for its MOT'), 'Book my car in for its MOT');
  const vm = M.manifest(withHeld([{ title: '"NT-24162: Survey West Hants Responses', why: 'Sized at 4h', returns: 'at 17:30' }]));
  assert.equal(vm.rail.held.items[0].title, 'NT-24162: Survey West Hants Responses', 'display only: the payload is untouched');
  const p = withHeld([{ title: '"NT-24162: Survey West Hants Responses', why: 'Sized at 4h', returns: 'at 17:30' }]);
  assert.equal(p.saim.display.held[0].title, '"NT-24162: Survey West Hants Responses', 'source data is not modified');
});

// ── Held vs waiting: “held” needs a boundary SAiM has set (16 Oct 2026) ─────

test('top of the list with nothing protected: the rail says the rest is WAITING — never held, never back after', () => {
  const p = withHeld(LIVE_HELD);
  p.saim = { ...p.saim, protected: null, display: { ...p.saim.display, protected: null } };
  const vm = M.manifest(p);
  assert.equal(vm.protecting, false);
  const h = html(vm, LIVE()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(h, /Also waiting 4 other commitments waiting/);
  for (const word of ['Holding the day', 'held', 'back after', 'back at', 'details in NEURO']) assert.equal(h.includes(word), false, `no “${word}” without a protected context`);
  assert.equal(M.waitingLine(1), '1 other commitment waiting');
});

test('a protected block or meeting keeps “Holding the day” and its back-at time', () => {
  const block = html(GOLDEN('s05-protected-block'), LIVE()).replace(/<[^>]+>/g, ' ');
  assert.equal(GOLDEN('s05-protected-block').protecting, true);
  assert.match(block, /Holding the day/);
  assert.match(block, /items? held — back /);
  const meeting = html(GOLDEN('s03-meeting'), LIVE()).replace(/<[^>]+>/g, ' ');
  assert.equal(GOLDEN('s03-meeting').protecting, true);
  assert.match(meeting, /Holding the day/);
});

test('Now is the control’s own Now view, styled only through selectors scoped to .v2-now', () => {
  const app = fs.readFileSync(path.join(APP, 'alt-v2', 'App.jsx'), 'utf8');
  assert.match(app, /import Now from '\.\.\/src\/views\/Now';/);
  assert.match(app, /route\.tab === 'now'\) \{[\s\S]*?<div className="v2-control v2-now"><Now onNavigate=\{go\} \/><\/div>/);
  const css = fs.readFileSync(path.join(APP, 'alt-v2', 'now-alt.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = css.split('}').map((r) => r.split('{')[0]).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  assert.ok(selectors.length > 10, 'positive control');
  for (const s of selectors) assert.ok(s.startsWith('.v2-now'), `unscoped selector would restyle the control: ${s}`);
  const control = fs.readFileSync(path.join(APP, 'src', 'main.jsx'), 'utf8') + fs.readFileSync(path.join(APP, 'src', 'App.jsx'), 'utf8');
  assert.ok(!control.includes('now-alt.css'), 'the control never loads it');
});
