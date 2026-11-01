'use strict';

/**
 * The focus block, rendered for real (esbuild + renderToString) from the ONE
 * shared component desktop Now and SAiM's Surface both mount (1 Nov 2026).
 * Every phase draws the server's words; the kiosk (no onAct) draws NO button.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..', '..');

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    nodePaths: [path.join(ROOT, 'node_modules'), ...String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)],
    plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' })); b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' })); } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let FB;
test.before(async () => { FB = await load('saim/shared-ui/FocusBlock.jsx'); });
const noop = async () => ({ ok: true });
const NOW = Date.UTC(2026, 10, 2, 10, 30);

const base = {
  contract: 'focus-block-v1', blockId: 7, kind: 'open', dateKey: '2026-11-02', startTime: '10:30', endTime: '11:15',
  minutes: 45, minutesAssumed: true, minutesBasis: 'no finished sessions yet — using the 2.5x default', lengthLearned: false,
  tooBigSay: 'Is this too big? Make it smaller.', chosen: null, windNote: null, moreTime: [], held: 0, notice: null,
  clock: { blockId: 7, phase: 'start', startsAt: '2026-11-02T10:30:00.000Z', endsAt: '2026-11-02T11:15:00.000Z', startsInSeconds: 0, remainingSeconds: 2700, running: true, task: null },
};
const cands = [
  { taskId: 1, text: 'Write the rota cover plan', estimateMinutes: null, tooBig: false, smallerStep: null, context: { jira: 'NT-123', notes: [{ title: 'Rota 2026' }], draft: null, microsoft: null } },
  { taskId: 2, text: 'Rewrite the onboarding guide', estimateMinutes: 60, tooBig: true, smallerStep: null, context: null },
];
const render = (block, props = {}) => renderToString(React.createElement(FB.FocusBlockView, { block, now: NOW, onAct: noop, onSomethingElse: () => {}, ...props }));

test('start: the say, two candidates with Start / 2 minutes, context, too-big, Something else, Not now', () => {
  const h = render({ ...base, phase: 'start', say: "It's 10:30 — your focus block.", candidates: cands });
  assert.match(h, /It&#x27;s 10:30 — your focus block\./);
  assert.match(h, /Write the rota cover plan/);
  assert.match(h, /NT-123 · Rota 2026/);
  assert.match(h, />Start</);
  assert.match(h, /Just open it for 2 minutes/);
  assert.match(h, /Is this too big\? Make it smaller\./);
  assert.match(h, /Start with that/);
  assert.match(h, />Something else</);
  assert.match(h, />Not now</);
  assert.match(h, /45 min left · until 11:15/);
  assert.match(h, /length is the default for now/);
});

test('the kiosk (no onAct): the block and candidates, NO buttons', () => {
  const h = render({ ...base, phase: 'start', say: "It's 10:30 — your focus block.", candidates: cands }, { onAct: null, onSomethingElse: null });
  assert.match(h, /Write the rota cover plan/);
  assert.doesNotMatch(h, /<button/);
  assert.doesNotMatch(h, /<input/);
});

test('ready: a quiet "Up next" with a countdown and no buttons', () => {
  const h = render({ ...base, phase: 'ready', say: 'Up next at 10:30 — your focus block.', candidates: cands, clock: { ...base.clock, startsAt: '2026-11-02T10:34:00.000Z', startsInSeconds: 240, running: false } });
  assert.match(h, /Up next at 10:30/);
  assert.match(h, /starts in 4 min/);
  assert.doesNotMatch(h, /<button/);
});

test('two-minute, wind-down and end each offer their own answers', () => {
  const chosen = { id: 1, text: 'Write the rota cover plan' };
  const two = render({ ...base, phase: 'two-minute', say: 'Two minutes in. Carry on, or stop there?', candidates: [], chosen, held: 2 });
  assert.match(two, />Carry on</);
  assert.match(two, />Stop there</);
  assert.match(two, /2 notifications held for the end\./);
  const wind = render({ ...base, phase: 'wind-down', say: '5 minutes left — note where you got to.', candidates: [], chosen });
  assert.match(wind, /Where you got to \(optional\)/);
  const end = render({ ...base, phase: 'end', say: 'Your 10:30 block is over. How did it go?', candidates: [], chosen, moreTime: [15, 30] });
  for (const label of ['Done', '15 more min', '30 more min', 'Stuck']) assert.match(end, new RegExp(`>${label}<`));
});

test('a notice (a block moved or dropped) is said, and nothing else', () => {
  const h = render({ contract: 'focus-block-v1', phase: 'notice', notice: { say: 'Ops review at 14:10 — moved your 14:00 focus block to 14:50.' } });
  assert.match(h, /moved your 14:00 focus block to 14:50/);
  assert.doesNotMatch(h, /<button/);
});

test('both shells mount the shared component', () => {
  const fs = require('fs');
  const surface = fs.readFileSync(path.join(ROOT, 'saim', 'shared-ui', 'AttentionSurface.jsx'), 'utf8');
  const adhd = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'components', 'AdhdPanel.jsx'), 'utf8');
  assert.match(surface, /import FocusBlockView from '\.\/FocusBlock\.jsx'/);
  assert.match(adhd, /import FocusBlockView from '\.\.\/\.\.\/\.\.\/saim\/shared-ui\/FocusBlock\.jsx'/);
  assert.match(adhd, /<FocusBlockView/);
  const phone = fs.readFileSync(path.join(ROOT, 'saim', 'app', 'src', 'views', 'Surface.jsx'), 'utf8');
  assert.match(phone, /onFocusBlock=\{platformNow\(\) === 'kiosk' \? null : focusBlockAct\}/, 'read-only on the kiosk');
});

test('the laptop line: links opening, why not, and its Do Not Disturb — words from the server, no buttons', () => {
  const chosen = { id: 1, text: 'Write the rota cover plan' };
  const h = render({ ...base, phase: 'running', say: null, candidates: [], chosen, laptop: {
    opens: [{ kind: 'jira', label: 'NT-123 in Jira', state: 'waiting', say: 'Opening NT-123 in Jira on your laptop' }],
    unreachable: null, dnd: { state: 'on' }, dndSay: 'Laptop: Do not disturb is on',
  } }, { onAct: null, onSomethingElse: null });
  assert.match(h, /Opening NT-123 in Jira on your laptop/);
  assert.match(h, /Laptop: Do not disturb is on/);
  assert.doesNotMatch(h, /<button/);
  const away = render({ ...base, phase: 'running', say: null, candidates: [], chosen, laptop: { opens: [], unreachable: 'the laptop isn’t reachable', dnd: null, dndSay: null } });
  assert.match(away, /Not opened on your laptop — the laptop isn’t reachable\./);
});
