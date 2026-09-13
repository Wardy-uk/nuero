'use strict';

/**
 * Does the "while you're in here" band obey its own rules when it renders?
 *
 * `desktop-render.test.js` proves AdhdPanel MOUNTS (verified by mutation — a
 * temporal-dead-zone reference genuinely fails it). It does not exercise this
 * band with data, because `renderToString` does not run effects and the cohort
 * arrives from a fetch. So this mounts the component directly with the payload
 * the route actually returns.
 *
 * The rule worth pinning is the quiet one: on the live store 56 of 93 tasks
 * have no cohort, so "renders nothing" is the COMMON case. A band that always
 * says something is a band nobody reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const PANEL = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'AdhdPanel.jsx');

const STUBS = {
  api: "export const apiFetch = async () => ({ ok: true, json: async () => ({}) });\nexport const apiUrl = p => p;\nexport default { apiFetch, apiUrl };",
  attention: "export default function () { return { loading: false, error: null, primary: null, secondary: [], dropped: [], gaps: [], contextCard: null, poolAvailable: true, act: async () => {}, refresh: () => {} }; }",
  card: 'export default function () { return null; }',
};

let WhileHere;

test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [PANEL],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onResolve({ filter: /useAttention$/ }, () => ({ path: 'attention', namespace: 'stub' }));
        build.onResolve({ filter: /(AttentionCard|FrictionSection)$/ }, () => ({ path: 'card', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  WhileHere = mod.exports.WhileHere;
  assert.ok(WhileHere, 'AdhdPanel exports WhileHere');
});

const PAYLOAD = {
  working: { known: true, kind: 'session', task: 'NT-24848: M&C Lead Source filter time out', taskIds: [242], why: 'you started a session on this' },
  best: {
    kind: 'jira', label: 'Jira tickets', count: 3, more: 0,
    tasks: [
      { id: 243, text: 'NT-27530: ESCALATION - no response since 7th' },
      { id: 244, text: 'NF-13740: Removal of Data Files' },
      { id: 267, text: 'NF-14121: CIA Envelope Report' },
    ],
  },
  cohorts: [], gaps: [],
};

// ⚠ React's server renderer puts `<!-- -->` between adjacent text nodes, so
// `{count} more` comes out as `3<!-- --> more` and a naive regex never matches.
// Stripping them is what makes these assertions about the WORDS on screen
// rather than about React's serialisation.
const render = props => renderToString(React.createElement(WhileHere, props)).split('<!-- -->').join('');

test('it names the cohort and lists the work', () => {
  const html = render({ data: PAYLOAD });
  assert.match(html, /Jira tickets/);
  assert.match(html, /3 more/);
  assert.match(html, /NF-13740/);
});

test('⚠ it SAYS what the suggestion is based on', () => {
  // A cohort with no premise is a fact from nowhere.
  assert.match(render({ data: PAYLOAD }), /you started a session on this/);
});

test('every row carries its task id, so he can quote it', () => {
  const html = render({ data: PAYLOAD });
  for (const id of ['#243', '#244', '#267']) assert.match(html, new RegExp(id));
});

test('⚠ NO COHORT RENDERS NOTHING — the common case, 56 of 93 live tasks', () => {
  assert.equal(render({ data: { working: { kind: 'app', why: 'at the laptop' }, best: null, cohorts: [], gaps: [] } }), '');
});

test('⚠ a failed read renders nothing rather than an error box', () => {
  assert.equal(render({ data: null }), '');
});

test('a truncated cohort says how many it did not list', () => {
  const big = { ...PAYLOAD, best: { ...PAYLOAD.best, count: 8, more: 4 } };
  assert.match(render({ data: big }), /and 4 more/);
});

// ── Opening the thing the task is about ──────────────────────────────────────

const WITH_LINKS = {
  working: { known: true, kind: 'session', why: 'you started a session on this' },
  best: {
    kind: 'jira', label: 'Jira tickets', count: 3, more: 0,
    tasks: [
      { id: 243, text: 'NT-27530: ESCALATION', links: [{ kind: 'jira', href: 'https://nurturtech.atlassian.net/browse/NT-27530', label: 'Open the ticket', desktopOnly: false }] },
      { id: 251, text: 'A meeting commitment', links: [{ kind: 'note', href: 'obsidian://open?vault=Nicks%20knowledge%20base&file=Meetings%2Fx', label: 'Open the note', desktopOnly: true }] },
      { id: 252, text: 'Something from an email', links: [], noLink: 'this came from an email, and the id Microsoft gave it cannot be turned into a link' },
    ],
  },
  cohorts: [], gaps: [],
};

test('a Jira row offers a link straight to the ticket', () => {
  const html = render({ data: WITH_LINKS });
  assert.match(html, /href="https:\/\/nurturtech\.atlassian\.net\/browse\/NT-27530"/);
  assert.match(html, />Ticket</);
});

test('the desktop panel DOES show the obsidian note link', () => {
  // This panel only renders on the machine Obsidian is installed on, so it
  // passes atDesktop: true. The phone renders a different surface.
  const html = render({ data: WITH_LINKS });
  assert.match(html, /obsidian:\/\/open/);
  assert.match(html, />Note</);
});

test('⚠ NEGATIVE: an email-sourced row gets NO button, not a dead one', () => {
  const html = render({ data: WITH_LINKS });
  // Three rows, exactly two openable.
  const opens = (html.match(/adhd__cohort-open/g) || []).length;
  assert.equal(opens, 2, 'the email row is not given something to click');
});

test('⚠ NEGATIVE: the opaque email id never reaches the page', () => {
  const html = render({ data: WITH_LINKS });
  assert.doesNotMatch(html, /AAMk/);
});

test('a row with no links at all still renders its text', () => {
  const bare = { ...WITH_LINKS, best: { ...WITH_LINKS.best, tasks: [{ id: 9, text: 'Plain task' }] } };
  const html = render({ data: bare });
  assert.match(html, /Plain task/);
  assert.doesNotMatch(html, /adhd__cohort-open/);
});

// ── Open on your desk ────────────────────────────────────────────────────────

let DeskLaunch;
test('the desk row is exported and mountable', async () => {
  const out = await esbuild.build({
    entryPoints: [PANEL], bundle: true, write: false, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, a => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onResolve({ filter: /useAttention$/ }, () => ({ path: 'attention', namespace: 'stub' }));
        build.onResolve({ filter: /(AttentionCard|FrictionSection)$/ }, () => ({ path: 'card', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  DeskLaunch = mod.exports.DeskLaunch;
  assert.ok(DeskLaunch);
});

const desk = props => renderToString(React.createElement(DeskLaunch, { onOpen: () => {}, states: {}, ...props })).split('<!-- -->').join('');

test('at the laptop, the four openable things are offered', () => {
  // ⚠ THE ROW IS NOW DEVICE-AWARE (13 Sep 2026): what it offers is what the
  //   TARGET MACHINE said it can open, composed server-side as `work.deskOffer`.
  //   These fixtures therefore carry one — a `work` without it is a machine that
  //   has not said, which correctly offers nothing, and is its own test below.
  const html = desk({ work: { atDesk: true, deskKnown: true, host: 'PC', deskOffer: { known: true, host: 'PC', why: null, apps: [{ id: 'music', label: 'Music' }, { id: 'code', label: 'VS Code' }, { id: 'terminal', label: 'Terminal' }, { id: 'browser', label: 'Browser' }] } } });
  for (const l of ['Music', 'VS Code', 'Terminal', 'Browser']) assert.match(html, new RegExp(l));
});

test('⚠ NOT at the laptop renders NOTHING — never a button that dies unclaimed', () => {
  // An intent expires in two minutes. Offering this when he is on the sofa
  // queues something that never fires and reads as broken.
  assert.equal(desk({ work: { atDesk: false, deskKnown: true } }), '');
});

test('⚠ a laptop that has not reported SAYS so — that is a different fact', () => {
  const html = desk({ work: { atDesk: false, deskKnown: false } });
  assert.match(html, /can.{0,8}t see your laptop/i);
});

test('no reading at all renders nothing', () => {
  assert.equal(desk({ work: null }), '');
});

test('⚠ the state shown is the real one, and "claimed" is not "opened"', () => {
  const html = desk({ work: { atDesk: true, deskKnown: true, deskOffer: { known: true, host: 'PC', why: null, apps: [{ id: 'music', label: 'Music' }, { id: 'code', label: 'VS Code' }] } }, states: { music: 'claimed', code: 'opened' } });
  assert.match(html, /claimed/);
  assert.match(html, /opened/);
  assert.doesNotMatch(html, /\bsent\b/i, 'never claims delivery it cannot confirm');
});

test('a request in flight disables its own button', () => {
  const html = desk({ work: { atDesk: true, deskKnown: true, deskOffer: { known: true, host: 'PC', why: null, apps: [{ id: 'music', label: 'Music' }, { id: 'code', label: 'VS Code' }] } }, states: { music: 'waiting' } });
  assert.match(html, /disabled/);
});
