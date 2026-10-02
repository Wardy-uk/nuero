'use strict';

/**
 * A REAL render of the two controls, via esbuild.
 *
 * ⚠ A vite build proves the file COMPILES and nothing more. The rules worth
 * pinning here are all about what the screen SAYS, and every one of them is a
 * plausible-looking wrong answer rather than a crash:
 *
 *   - a gap must not render as calm
 *   - an empty queue must render NOTHING, not a permanent empty panel
 *   - a note trusted by its FOLDER must not offer an un-trust button that will
 *     answer 400
 *   - a refusal must be shown in the server's words
 *
 * ⚠ Both components are tested as their NAMED exports. `renderToString` never
 * runs effects, so a test over the default panel could only ever assert the
 * loading state — the trap `knowledge-window-source.test.js` records.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const COMPONENTS = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');

const STUBS = {
  api: "export const apiFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });\nexport const apiUrl = p => p;\nexport default { apiFetch, apiUrl };",
  inert: 'export default function () { return null; }',
};

async function load(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(COMPONENTS, file)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'],
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        build.onResolve({ filter: /react-markdown|remark-|rehype-/ }, () => ({ path: 'inert', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let OwnNotesQueue;
let TrustControl;

test.before(async () => {
  ({ OwnNotesQueue } = await load('InsightsPanel.jsx'));
  ({ TrustControl } = await load('VaultBrowser.jsx'));
  // Positive controls: a scan that has stopped finding the export cannot pass
  // by absence.
  assert.ok(OwnNotesQueue, 'InsightsPanel exports OwnNotesQueue');
  assert.ok(TrustControl, 'VaultBrowser exports TrustControl');
});

const payload = (over = {}) => ({
  known: true,
  trustKnown: true,
  reasons: [],
  scanned: 1417,
  considered: 451,
  matched: 71,
  shown: 1,
  withheld: { trusted: 4, dismissed: 2, stub: 49, belowBar: 380 },
  folders: ['Projects', 'Areas'],
  minScore: 8,
  candidates: [{
    path: 'Projects/Support Hub/SOP.md',
    title: 'SOP - Nurtur Technical Support',
    folder: 'Projects/Support Hub',
    score: 9,
    why: ['substantial', '6 notes link to it', 'structured'],
    wordCount: 4984,
    inbound: 6,
    outbound: 8,
    headings: 12,
    tags: ['support'],
    modified: '2026-09-20T10:00:00.000Z',
    excerpt: 'How support runs.',
    suggestedDomain: 'Projects',
  }],
  ...over,
});

// ── The queue ────────────────────────────────────────────────────────────────

test('it renders the candidate, and says WHY it is being offered', () => {
  const html = renderToString(React.createElement(OwnNotesQueue, { data: payload() }));
  assert.match(html, /SOP - Nurtur Technical Support/);
  // A suggestion with no premise is a fact from nowhere.
  assert.match(html, /6 notes link to it/);
  assert.match(html, /Projects\/Support Hub/);
});

test('⚠ it states that nothing is copied — the whole difference from promotion', () => {
  const html = renderToString(React.createElement(OwnNotesQueue, { data: payload() }));
  assert.match(html, /nothing is copied or moved/i);
});

test('⚠ everything withheld is on the screen, not just in the payload', () => {
  const html = renderToString(React.createElement(OwnNotesQueue, { data: payload() }));
  assert.match(html, /451/);
  assert.match(html, /4 already marked/);
  assert.match(html, /380 below the bar/);
});

test('⚠ an empty-but-read queue renders NOTHING at all', () => {
  // A permanent panel saying the queue is empty is furniture on a screen Nick
  // opens to think with.
  const html = renderToString(React.createElement(OwnNotesQueue, {
    data: payload({ candidates: [], matched: 0, shown: 0, reasons: [] }),
  }));
  assert.equal(html, '');
});

test('⚠⚠ an UNREAD vault renders the gap, and never as calm', () => {
  const html = renderToString(React.createElement(OwnNotesQueue, {
    data: payload({ known: false, candidates: [], matched: 0, reasons: ['the vault walk was partial'] }),
  }));
  // "I could not look" and "you have written nothing worth trusting" are
  // opposite claims, and only one of them is an answer.
  assert.notEqual(html, '');
  assert.match(html, /could not read all of the vault/i);
  assert.match(html, /the vault walk was partial/);
});

test('a gap on an otherwise good read is still named', () => {
  const html = renderToString(React.createElement(OwnNotesQueue, {
    data: payload({ reasons: ['already-trusted notes could not be excluded'] }),
  }));
  assert.match(html, /already-trusted notes could not be excluded/);
});

test('it renders nothing when handed nothing', () => {
  assert.equal(renderToString(React.createElement(OwnNotesQueue, { data: null })), '');
});

// ── The note control ─────────────────────────────────────────────────────────

test('an unmarked note offers the mark, and says the note is not moved', () => {
  const html = renderToString(React.createElement(TrustControl, {
    notePath: 'Projects/NEURO/Design.md',
    content: '---\ntitle: Design\n---\n\nBody.',
  }));
  assert.match(html, /Mark as knowledge/);
  assert.match(html, /not moved or copied/i);
});

test('a marked note offers the way back', () => {
  const html = renderToString(React.createElement(TrustControl, {
    notePath: 'Projects/NEURO/Design.md',
    content: '---\nknowledge_state: "trusted"\n---\n\nBody.',
  }));
  assert.match(html, /Knowledge ✓/);
  assert.equal(/Mark as knowledge/.test(html), false);
});

test('⚠⚠ a note trusted by its FOLDER offers no un-trust button', () => {
  const html = renderToString(React.createElement(TrustControl, {
    notePath: 'Knowledge/Nurtur/Promoted.md',
    content: '---\nknowledge_state: distilled\n---\n\nBody.',
  }));
  // Un-marking it would need the file MOVED — the server answers 400 — so the
  // screen says what it is rather than offering a control that fails on press.
  assert.match(html, /Knowledge/);
  assert.equal(/untrust|Knowledge ✓/.test(html), false);
  assert.match(html, /move it out of that folder/i);
});

test('the promotion queue now says what it actually reads', async () => {
  // The whole confusion this change came from: one word meaning two things on
  // one screen. Scanned rather than rendered, because the queue lives inside
  // the panel's fetch-driven body.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(COMPONENTS, 'InsightsPanel.jsx'), 'utf-8');
  assert.match(src, /Promotion Queue/, 'positive control: the section has gone');
  assert.match(src, /reads Plaud and Meetings only/,
    'the promotion queue must say what it reads, or "Knowledge" means two things on one screen');
});
