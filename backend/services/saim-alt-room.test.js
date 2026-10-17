'use strict';

/**
 * SAiM Alt v3 — the room box (17 Oct 2026). Nick: "when I'm in a room that is
 * below comfort — give me a mechanism to turn the heating on in that room".
 * The brain had been producing the offer for a month; v3 (his main SAiM) never
 * read `rooms`. These pin that it does, with NEURO's words verbatim, a KEY-only
 * intent, and nothing on screen when there is nothing to say about the room.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const { STATES } = require('./alt-manifest-fixtures');
const DISPLAY = require('../../shared/display-text.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_DIR = path.join(ROOT, 'saim', 'app', 'alt-v2-manifest');
let M; let View;

test.before(async () => {
  M = await import(pathToFileURL(path.join(ADAPTER_DIR, 'manifest.mjs')).href);
  const out = await esbuild.build({
    entryPoints: [path.join(ADAPTER_DIR, 'ManifestView.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'css', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  View = mod.exports.default;
});

const KEY = 'room:living-room:warm-room#living-room@1760724000000';
const ROOMS = {
  known: true,
  offers: [{ kind: 'warm-room', key: KEY, area: 'Living Room', say: 'The living room is 16.0°C. Warm it to 20°C until you leave?', acceptLabel: 'Warm it', declineLabel: 'Not now' }],
  decided: [],
  notes: [],
  heating: [],
};
const withRooms = (rooms) => ({ ...STATES['s05-protected-block'](), rooms });

test('positive control: the adapter and view load', () => {
  assert.equal(typeof M.roomView, 'function');
  assert.equal(typeof View, 'function');
});

test('a heating offer becomes a room box with NEURO\'s words and KEY-only intents', () => {
  const v = M.manifest(withRooms(ROOMS));
  assert.ok(v.room);
  assert.equal(v.room.offers[0].say, ROOMS.offers[0].say);
  assert.deepEqual(v.room.offers[0].actions.map((a) => a.say), ['Warm it', 'Not now']);
  assert.deepEqual(v.room.offers[0].actions[0].intent, { kind: 'room', action: 'accept', key: KEY }, 'the key and nothing else — no entity, no temperature');
  assert.deepEqual(v.room.offers[0].actions[1].intent, { kind: 'room', action: 'decline', key: KEY });
  assert.equal(M.actable(v.room.offers[0].actions[0]), true, 'the shell can carry it out');
});

test('⚠ no room to speak of → no `room` key at all (the golden view-models are unchanged)', () => {
  for (const build of Object.values(STATES)) assert.equal('room' in M.manifest(build()), false);
  assert.equal('room' in M.manifest(withRooms({ known: true, offers: [], decided: [], notes: [], heating: [] })), false);
  assert.equal('room' in M.manifest(withRooms({ known: false, offers: [] })), false);
});

test('already warming / NEURO holding it / a refused yes are said, with NO button', () => {
  const v = M.manifest(withRooms({
    known: true, offers: [],
    notes: [{ say: 'The living room is 17.5°C — it’s already warming to 24°C.' }],
    heating: [{ say: 'Warming the kitchen to 20°C until you leave — then back to on its schedule.' }],
    decided: [{ key: 'k', decision: 'accepted', outcome: { ok: false, reason: 'Home Assistant refused to switch it to heat' } }],
  }));
  assert.equal(v.room.offers.length, 0);
  assert.deepEqual(v.room.lines, [
    'Warming the kitchen to 20°C until you leave — then back to on its schedule.',
    'The living room is 17.5°C — it’s already warming to 24°C.',
    'Tried, but it didn’t take — Home Assistant refused to switch it to heat.',
  ]);
  const html = renderToString(React.createElement(View, { v, live: { onAct: () => {}, linkFor: () => null } }));
  assert.match(html, /already warming to 24°C/);
  assert.equal(/Warm it/.test(html), false);
});

test('rendered live: the buttons are pressable; in the read-only preview they are inert', () => {
  const v = M.manifest(withRooms(ROOMS));
  const live = renderToString(React.createElement(View, { v, live: { onAct: () => {}, linkFor: () => null } }));
  assert.match(live, /This room/);
  assert.match(live, /Warm it to 20°C until you leave\?/);
  const warmBtn = live.match(/<button[^>]*>Warm it<\/button>/);
  assert.ok(warmBtn);
  assert.equal(/disabled/.test(warmBtn[0]), false, 'live: pressable');
  const preview = renderToString(React.createElement(View, { v }));
  assert.match(preview.match(/<button[^>]*>Warm it<\/button>/)[0], /disabled/);
});

test('every room string is safe display text', () => {
  const v = M.manifest(withRooms(ROOMS));
  assert.deepEqual(M.visibleStrings(v.room).filter((s) => !DISPLAY.isSafeDisplay(s)), []);
});

test('source scan: App.onAct posts the KEY to /api/rooms/:key/accept|decline with an empty body', () => {
  const src = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'alt-v2', 'App.jsx'), 'utf8');
  const block = src.slice(src.indexOf("intent.kind === 'room'"), src.indexOf("intent.kind === 'navigate'"));
  assert.ok(block.length > 50, 'positive control: the room branch exists');
  assert.match(block, /\/api\/rooms\/\$\{encodeURIComponent\(intent\.key\)\}\/\$\{verb\}/);
  assert.match(block, /body: JSON\.stringify\(\{\}\)/, 'nothing but the key reaches NEURO');
  assert.match(block, /res\.say/, 'NEURO\'s own sentence for what happened is shown');
});
