'use strict';

/**
 * NEURO desktop Now — the room offer card (17 Oct 2026), rendered for real
 * (esbuild → renderToString). The container posts on a press, so the exported
 * VIEW is rendered, with a positive control that both exports exist, and a
 * source scan that Now actually MOUNTS it (a component written and never
 * mounted is the commonest failure in this codebase).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
let mod;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'components', 'RoomOfferCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
});

const render = (props) => renderToString(React.createElement(mod.RoomOfferView, { onAnswer: () => {}, ...props }));
const OFFER = { kind: 'warm-room', key: 'room:office:warm-room#office@1', say: 'The office is 15.9°C. Warm it to 20°C until you leave?', acceptLabel: 'Warm it', declineLabel: 'Not now' };

test('positive control: the view and the card are exported', () => {
  assert.equal(typeof mod.RoomOfferView, 'function');
  assert.equal(typeof mod.default, 'function');
});

test('a heating offer renders its own sentence and its two buttons', () => {
  const html = render({ rooms: { known: true, offers: [OFFER], decided: [], notes: [], heating: [] } });
  assert.match(html, /Warm it to 20°C until you leave\?/);
  assert.match(html, />Warm it</);
  assert.match(html, />Not now</);
});

test('an OFF radiator offer uses its own words ("Turn it on")', () => {
  const html = render({ rooms: { known: true, offers: [{ ...OFFER, say: 'The office is 15.9°C and its radiator is off. Turn it on to 20°C until you leave? It goes back off after.', acceptLabel: 'Turn it on' }] } });
  assert.match(html, /It goes back off after/);
  assert.match(html, />Turn it on</);
});

test('already warming / NEURO holding / a refused yes: said, with no button', () => {
  const html = render({ rooms: {
    known: true, offers: [],
    notes: [{ say: 'The living room is 17.5°C — it’s already warming to 24°C.' }],
    heating: [{ say: 'Warming the office to 20°C until you leave — then back to on its schedule.' }],
    decided: [{ decision: 'accepted', outcome: { ok: false, reason: 'Home Assistant refused the temperature' } }],
  } });
  assert.match(html, /already warming to 24°C/);
  assert.match(html, /Warming the office to 20°C until you leave/);
  assert.match(html, /Tried, but it didn’t take — Home Assistant refused the temperature/);
  assert.equal(/<button/.test(html), false);
});

test('nothing to say, or an unreadable house → renders nothing', () => {
  assert.equal(render({ rooms: { known: true, offers: [], decided: [], notes: [], heating: [] } }), '');
  assert.equal(render({ rooms: { known: false, offers: [] } }), '');
  assert.equal(render({ rooms: null }), '');
});

test('source scan: Now mounts the card on the canonical payload, and a press sends only the key', () => {
  const now = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'AdhdPanel.jsx'), 'utf8');
  assert.match(now, /<RoomOfferCard rooms=\{attention\.data\.rooms\}/);
  const card = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'RoomOfferCard.jsx'), 'utf8');
  assert.match(card, /\/api\/rooms\/\$\{encodeURIComponent\(key\)\}\/\$\{verb\}/);
  assert.match(card, /body: '\{\}'/);
});
