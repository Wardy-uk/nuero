'use strict';

/**
 * ONE card and ONE scene on every SAiM surface (Nick, 6 Nov 2026: "the desktop
 * version is the most useful — all others should follow this").
 *
 * The divergence this exists for: SAiM's phone/kiosk/Electron shell
 * (`AttentionSurface`) and NEURO desktop Now (`NowScene`) both mount the same
 * `Situation` renderer, but each passed it a DIFFERENT set of slots. A feature
 * wired into one shell as an optional prop simply did not exist on the other,
 * and nothing failed — the Needs-you buttons, the four readout cards and the
 * desktop's attention card all drifted that way. These tests make a new slot
 * on one shell fail until the other passes it too (or it is named below as a
 * deliberate difference).
 *
 * Also pins "Move due date" (6 Nov 2026): the card re-dates the ONE task it
 * names by id, through the task's own edit route, and is never offered where
 * the shell cannot write (the kiosk) or the card names no task.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** The prop names a file passes to its `<Situation …/>`. */
function situationProps(source) {
  const at = source.indexOf('<Situation');
  assert.ok(at > -1, 'positive control: the file mounts <Situation');
  // Walk to the self-closing end, skipping nested JSX/braces.
  let depth = 0; let i = at + 1; let end = -1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '/' && source[i + 1] === '>') { end = i; break; }
  }
  assert.ok(end > at, 'the <Situation …/> element should close');
  // JSX line comments between attributes are prose, not props.
  const body = source.slice(at, end).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const names = new Set();
  // Top-level attributes only: names at brace depth 0.
  depth = 0;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    const m = /^\s([A-Za-z][A-Za-z0-9]*)(=|\s|$)/.exec(body.slice(j, j + 40));
    if (m && body[j] !== '<') names.add(m[1]);
  }
  names.delete('Situation');
  return names;
}

// What the desktop deliberately does NOT take from the SAiM shell, and why.
const SAIM_ONLY = {
  field: 'the desktop page has no moving field behind it',
  scene: 'the locked amber Keep-my-word scene is SAiM’s look; NEURO’s Now opts out',
  step: 'desktop Now draws meeting controls (It’s over / I’m not attending) above the scene',
  lead: 'desktop Now draws the focus block and router question above the scene',
  ask: 'the desktop has its own chat; the mic is a device slot',
  note: 'a shell-local note (a voice error)',
  foot: 'the laptop launch row is about the desk you are sat at',
  prepared: 'desktop reaches prepared moves through Drafts',
  preparedMoment: 'pairs with prepared',
  onOffer: 'room offers are drawn by RoomOfferCard on desktop Now',
  correcting: 'pairs with onCorrect',
};
// What the desktop has that the SAiM shell deliberately does not.
const DESKTOP_ONLY = {
  omitNextIds: 'the running block’s tasks are drawn above the scene only on the desktop',
};

test('every slot the SAiM shell gives Situation, the desktop gives too (or it is a named difference)', () => {
  const saim = situationProps(read('saim/shared-ui/AttentionSurface.jsx'));
  const desk = situationProps(read('frontend/src/components/NowScene.jsx'));
  assert.ok(saim.has('renderPrimary') && desk.has('renderPrimary'), 'positive control: both pass renderPrimary');
  for (const p of saim) {
    if (SAIM_ONLY[p]) continue;
    assert.ok(desk.has(p), `AttentionSurface passes "${p}" to Situation and NowScene does not — wire it on the desktop or name it in SAIM_ONLY`);
  }
  for (const p of desk) {
    if (DESKTOP_ONLY[p]) continue;
    assert.ok(saim.has(p), `NowScene passes "${p}" to Situation and AttentionSurface does not — wire it on SAiM or name it in DESKTOP_ONLY`);
  }
});

test('both shells draw the SAME card and the SAME Needs-you answers', () => {
  const saim = read('saim/shared-ui/AttentionSurface.jsx');
  const desk = read('frontend/src/components/AttentionCard.jsx');
  assert.match(saim, /import AttentionCard, \{ NeedsYouActs \} from '\.\/AttentionCard\.jsx'/);
  assert.match(desk, /from '\.\.\/\.\.\/\.\.\/saim\/shared-ui\/AttentionCard\.jsx'/);
  assert.match(read('frontend/src/components/NowScene.jsx'), /renderNeedsYouActs=/);
  // The desktop's readout cards everywhere, and the promise joins its lead the same way.
  assert.match(saim, /\r?\n\s+workspace\r?\n/);
  assert.match(saim, /kmwJoinsLead=\{leadIsThePromise\(/);
  assert.match(read('frontend/src/components/NowScene.jsx'), /presentation\/kmwLead\.mjs/);
});

// ── Move due date ─────────────────────────────────────────────────────────────

let Card;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'saim/shared-ui/AttentionCard.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules')],
    plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Card = mod.exports;
});

const capacityCard = {
  kind: 'item', type: 'capacity', recordId: 'att_1', id: 'capacity-start-42-2026-10-29', urgency: 'high',
  title: '"Evaluate the creation of a business WhatsApp account" is overdue — 8h of work', say: 'Sized at 8h.',
  actions: ['open', 'acknowledge', 'complete', 'defer', 'dismiss'], meta: { taskId: 42, status: 'overdue', due: '2026-10-29' },
};

test('the due target is the ONE task the card names by id — never a summary card', () => {
  assert.deepEqual(Card.dueTargetOf(capacityCard), { kind: 'neuro', taskId: 42 });
  assert.deepEqual(Card.dueTargetOf({ type: 'todo', meta: { owner: { kind: 'neuro', taskId: 7 } } }), { kind: 'neuro', taskId: 7 });
  assert.deepEqual(Card.dueTargetOf({ type: 'todo', meta: { owner: { kind: 'microsoft', msId: 'AAMk1' } } }), { kind: 'microsoft', msId: 'AAMk1' });
  assert.equal(Card.dueTargetOf({ type: 'todo', meta: { undatedHighCount: 3 } }), null);
  assert.equal(Card.dueTargetOf({ type: 'capacity', meta: { by: '2026-11-06', shortMinutes: 7860 } }), null, 'the overload card names no task');
  assert.equal(Card.dueTargetOf({ type: 'file', meta: { owner: { kind: 'file' } } }), null);
});

test('moving it writes through the task’s own edit route, and says so when NEURO refuses', async () => {
  const calls = [];
  const call = async (p, o) => { calls.push([p, o]); return { status: 200, body: { ok: true } }; };
  assert.deepEqual(await Card.moveDue(call, { kind: 'neuro', taskId: 42 }, '2026-11-09'), { ok: true });
  assert.deepEqual(calls[0], ['/api/tasks/42', { method: 'PATCH', body: { due_date: '2026-11-09' } }]);
  await Card.moveDue(call, { kind: 'microsoft', msId: 'AA/k=' }, '2026-11-10');
  assert.deepEqual(calls[1], ['/api/todos/ms/AA%2Fk%3D', { method: 'PATCH', body: { dueDate: '2026-11-10' } }]);
  const refused = await Card.moveDue(async () => ({ status: 409, body: { error: 'Planner changed under you' } }), { kind: 'microsoft', msId: 'x' }, '2026-11-10');
  assert.deepEqual(refused, { ok: false, why: 'Planner changed under you' });
  const junk = await Card.moveDue(call, { kind: 'neuro', taskId: 42 }, 'next week');
  assert.equal(junk.ok, false);
  assert.equal(calls.length, 2, 'a junk date writes nothing');
  assert.equal((await Card.moveDue(null, { kind: 'neuro', taskId: 1 }, '2026-11-09')).ok, false, 'no call → nothing written');
});

const render = (props) => renderToString(React.createElement(Card.default, { card: capacityCard, onOpen: () => true, onAct: async () => ({ ok: true }), ...props }));

test('the card offers "Move due date" where it can write — not on the kiosk, not on a summary card', () => {
  const call = async () => ({ status: 200, body: {} });
  assert.match(render({ call }), /Move due date/);
  assert.match(render({ call }), /Not now/);
  assert.doesNotMatch(render({ call: null }), /Move due date/, 'the kiosk passes no call');
  assert.doesNotMatch(render({ call: null }), /Start this/);
  assert.doesNotMatch(render({ call, card: { ...capacityCard, meta: { by: '2026-11-06' } } }), /Move due date/);
  assert.doesNotMatch(render({ call, onAct: null }), /Not now|>Done</, 'no lifecycle → no lifecycle buttons');
});

test('a Needs-you row naming one task offers "Move due date" too — and both shells pass it a call', () => {
  const call = async () => ({ status: 200, body: {} });
  const row = (props) => renderToString(React.createElement(Card.NeedsYouActs, { card: capacityCard, onOpen: () => true, onAct: async () => ({ ok: true }), ...props }));
  assert.match(row({ call }), /Move due date/);
  assert.match(row({ call }), /Seen it/);
  assert.match(row({ call }), />Done</, 'a row about one task can be ticked off where it is shown');
  assert.match(row({ call: null }), />Done</, 'Done needs only the lifecycle — the kiosk-less shells still get it');
  assert.doesNotMatch(row({ call, onAct: null }), />Done</, 'no lifecycle → no Done');
  assert.doesNotMatch(row({ call, card: { ...capacityCard, meta: { by: '2026-11-06' } } }), />Done</, 'a summary card names no task to close');
  assert.doesNotMatch(row({ call: null }), /Move due date/, 'the kiosk passes no call');
  assert.doesNotMatch(row({ call, card: { ...capacityCard, meta: { by: '2026-11-06' } } }), /Move due date/, 'a summary card names no task');
  assert.match(read('frontend/src/components/AttentionCard.jsx'), /<NeedsYouActs[^>]*call=\{desktopCall\}/);
  assert.match(read('saim/shared-ui/AttentionSurface.jsx'), /<NeedsYouActs[^>]*call=\{prof === 'kiosk'/);
});

test('dueLabel slices the key, never shifting a day', () => {
  assert.match(Card.dueLabel('2026-11-09'), /9 Nov/);
});

test('the card shows what its task is, folded, when the server composed it', () => {
  const card = { ...capacityCard, meta: { ...capacityCard.meta, detail: [{ label: 'What it unlocks', text: 'NOVA can route tickets smarter' }, { label: 'Where it came from', text: 'Accepted from NEURO’s suggestions. Added 15 Oct 2026.' }] } };
  const html = renderToString(React.createElement(Card.default, { card, onOpen: () => true, onAct: async () => ({ ok: true }) }));
  assert.match(html, /What this is/);
  assert.match(html, /NOVA can route tickets smarter/);
  assert.match(html, /Accepted from NEURO/);
  assert.doesNotMatch(render({}), /What this is/, 'nothing composed → no empty fold');
});
