'use strict';

/**
 * One press, finished in place (7 Nov 2026) — Nick's rule since 24 Oct 2026:
 * a press on ANY attended screen approves and sends there and then. These pin
 * the shared pieces that replaced the "approve at the desk" dead ends:
 *
 *  • PreparedSend — the exact draft with Send / Edit / Reject (SAiM home's
 *    waiting drafts, Drafts' communication rows, chases).
 *  • ChatProposal — SAiM's prepared reply/invite under her chat reply, shared by
 *    the desktop and the phone.
 *  • SimilarTask — "Same as #N? Merge / Keep both" at capture.
 *  • OwedActions — Chase · Done · Drop · Snooze, the same on People, Commitments
 *    and Meeting prep.
 *  • turnOnAndSend — "Turn on and send" flips only this kind's switch, then sends.
 *
 * REAL renders via esbuild (a vite build proves it compiles, not that the
 * button is there). `call` null (the kiosk) must render no control at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const SHARED = path.resolve(__dirname, '..', '..', 'saim', 'shared-ui');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(SHARED, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'css',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let PreparedSend; let ChatProposal; let SimilarTask; let OwedActions; let send;
test.before(async () => {
  PreparedSend = (await load('PreparedSend.jsx')).default;
  ChatProposal = (await load('ChatProposal.jsx')).default;
  SimilarTask = (await load('SimilarTask.jsx')).default;
  OwedActions = (await load('OwedActions.jsx')).default;
  send = await load('turnOnAndSend.mjs');
  for (const [n, c] of Object.entries({ PreparedSend, ChatProposal, SimilarTask, OwedActions })) {
    assert.equal(typeof c, 'function', `positive control: ${n} must load, or every test passes by absence`);
  }
});

const call = async () => ({ status: 200, body: { ok: true } });
const REPLY = {
  actionId: 'pa_reply1', actionType: 'reply_email', version: 2, status: 'prepared', executes: true, payloadHash: 'h2',
  createdAt: new Date().toISOString(), origin: 'chat-attended',
  draft: { to: [{ name: 'Chris Middleton', email: 'chris.middleton@nurtur.tech' }], subject: 'Re: the rota', body: 'Hi Chris,\n\nYes — Friday works.\n\nNick' },
};
const INVITE = {
  actionId: 'pa_inv1', actionType: 'create_calendar_event', version: 1, status: 'prepared', executes: true, payloadHash: 'h1',
  draft: { to: [{ name: 'Zoe Rees', email: 'zoe@nurtur.tech' }], subject: '1-2-1', start: '2026-11-10T14:00:00', end: '2026-11-10T14:30:00' },
};
const h = (C, props) => renderToString(React.createElement(C, props)).split('<!-- -->').join('');

// ── PreparedSend ────────────────────────────────────────────────────────────

test('PreparedSend shows exactly what leaves, with Send / Edit / Reject in place', () => {
  const html = h(PreparedSend, { action: REPLY, call });
  assert.match(html, /chris\.middleton@nurtur\.tech|Chris Middleton/);
  assert.match(html, /Re: the rota/);
  assert.match(html, /Friday works/);
  assert.match(html, />Send</);
  assert.match(html, />Edit</);
  assert.match(html, />Reject</);
  assert.doesNotMatch(html, /approval code|on the desktop|in NEURO/i, 'no desk hand-off on the card');
});

test('PreparedSend with no call (the kiosk) is a statement — no button', () => {
  const html = h(PreparedSend, { action: REPLY, call: null });
  assert.match(html, /Re: the rota/, 'positive control: the draft is still shown');
  assert.doesNotMatch(html, /<button/);
});

test('a send blocked only by its switch offers "Turn on … and send" for THAT switch', () => {
  const email = h(PreparedSend, { action: REPLY, call, sending: { enabled: false, calendar: true } });
  assert.match(email, /Turn on “Send approved emails” and send/);
  assert.match(email, /data-turn-on="governed_execution"/);
  const cal = h(PreparedSend, { action: INVITE, call, sending: { enabled: true, calendar: false } });
  assert.match(cal, /Turn on “Send approved calendar changes” and send/);
  const on = h(PreparedSend, { action: REPLY, call, sending: { enabled: true, calendar: true } });
  assert.doesNotMatch(on, /Turn on/, 'positive control: switch on → plain Send');
});

test('PreparedSend never offers Send on a draft that is no longer waiting', () => {
  const html = h(PreparedSend, { action: { ...REPLY, status: 'verified' }, call });
  assert.doesNotMatch(html, />Send</);
  assert.match(html, /Already sent/);
});

// ── ChatProposal ────────────────────────────────────────────────────────────

test('ChatProposal: the reply SAiM prepared, with Send reply under it', () => {
  const html = h(ChatProposal, { action: REPLY, call });
  assert.match(html, /Reply — Re: the rota/);
  assert.match(html, /To Chris Middleton/);
  assert.match(html, /Send reply/);
  const inv = h(ChatProposal, { action: INVITE, call });
  assert.match(inv, /Invite — 1-2-1/);
  assert.match(inv, /2026-11-10 14:00–14:30/);
  assert.match(inv, /Book &amp; send invite|Book & send invite/);
});

test('ChatProposal with no call (the kiosk) shows the proposal and no button', () => {
  const html = h(ChatProposal, { action: REPLY, call: null });
  assert.match(html, /Re: the rota/);
  assert.doesNotMatch(html, /<button/);
});

// ── SimilarTask ─────────────────────────────────────────────────────────────

test('"Same as #N?" asks in place with Merge and Keep both', () => {
  const html = h(SimilarTask, { newId: 412, similar: { id: 58, text: 'Succession plan', why: 'words' }, call });
  assert.match(html, /Same as #58 “Succession plan”\?/);
  assert.match(html, />Merge</);
  assert.match(html, />Keep both</);
  assert.doesNotMatch(html, /desktop/i, 'no "merge them on the desktop"');
  assert.equal(h(SimilarTask, { newId: 58, similar: { id: 58, text: 'x' }, call }), '', 'the same task is not a duplicate of itself');
});

// ── OwedActions ─────────────────────────────────────────────────────────────

test('OwedActions: Chase · Done · Drop · Snooze — one word for drop', () => {
  const html = h(OwedActions, { call, waitingKey: 'k1' });
  for (const w of ['Chase', 'Done', 'Drop', 'Snooze']) assert.match(html, new RegExp(`>${w}<`));
  assert.doesNotMatch(html, /Not owed/);
  const prep = h(OwedActions, { call, waitingKey: 'k1', only: ['chase', 'done'] });
  assert.match(prep, />Chase</);
  assert.doesNotMatch(prep, />Snooze</);
  assert.equal(h(OwedActions, { call: null, waitingKey: 'k1' }), '', 'no call (the kiosk) → nothing offered');
});

// ── turnOnAndSend (pure + the call sequence) ────────────────────────────────

test('switchFor / gateOf / isSwitchedOff', () => {
  assert.equal(send.switchFor(REPLY), 'governed_execution');
  assert.equal(send.switchFor(INVITE), 'governed_calendar');
  assert.equal(send.gateOf(null, REPLY), null, 'unknown is never a block');
  assert.equal(send.gateOf({ enabled: true }, REPLY), null);
  assert.deepEqual(send.gateOf({ enabled: false }, REPLY), { key: 'governed_execution', label: 'Send approved emails' });
  assert.equal(send.gateOf({ enabled: false }, { ...REPLY, executes: false }), null, 'a prepare-only type is not gated');
  assert.equal(send.isSwitchedOff({ ok: false, error: '"Send approved emails" is switched off (Settings → Switches), so approving would change nothing.' }), true);
  assert.equal(send.isSwitchedOff({ ok: false, error: 'it has expired' }), false);
});

test('Turn on and send: flips ONLY this kind’s switch, then grants and sends', async () => {
  const seen = [];
  const fake = async (p, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${p}`);
    if (p.startsWith('/api/feature-flags/')) return { status: 200, body: { ok: true } };
    if (p.endsWith('/intent-grant')) return { status: 200, body: { ok: true, grantId: 'ig_1' } };
    if (p.endsWith('/execute-direct')) return { status: 200, body: { ok: true, executed: true, status: 'executed', action: REPLY } };
    return { status: 404, body: {} };
  };
  const r = await send.turnOnAndSend(fake, REPLY, { surface: 'neuro-web' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [
    'POST /api/feature-flags/governed_execution',
    'POST /api/prepared-actions/pa_reply1/intent-grant',
    'POST /api/prepared-actions/pa_reply1/execute-direct',
  ]);
});

test('a switch that cannot be turned on sends NOTHING', async () => {
  const seen = [];
  const fake = async (p) => { seen.push(p); return p.startsWith('/api/feature-flags/') ? { status: 400, body: { ok: false, error: 'GOVERNED_EXECUTION_ENABLED is set in the environment' } } : { status: 200, body: { ok: true } }; };
  const r = await send.turnOnAndSend(fake, REPLY);
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing was sent/);
  assert.deepEqual(seen, ['/api/feature-flags/governed_execution'], 'no grant, no send');
});
