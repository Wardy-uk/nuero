'use strict';

/**
 * Receipt truth, rendered for real (22 Oct 2026) — the SAME components every shell
 * mounts (esbuild + renderToString):
 *
 *  - ReceiptBlock: "Done" only for a VERIFIED live receipt; a practice run says so
 *    first and claims no calendar or vault; a receipt with no target claims nothing;
 *    each step shows its exact time; a live note says where to find it, and offers
 *    "View the draft" only when the shell can open notes.
 *  - TodayHistory (Drafts → #drafts-today): prepared / confirmed / verified / practice
 *    told apart; a vault location only for a live note; an unreadable store is said,
 *    never an empty day; the kiosk shows it with no buttons.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const APP = path.resolve(__dirname, '..', '..', 'saim', 'app', 'src');

async function bundle(entry) {
  const out = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p; export const authHeaders = () => ({}); export const apiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });', loader: 'js' }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const text = (h) => h.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

let PM; let DR;
test.before(async () => {
  PM = await bundle(path.join(APP, 'components', 'PreparedMove.jsx'));
  DR = await bundle(path.join(APP, 'views', 'Drafts.jsx'));
  assert.ok(PM.ReceiptBlock && DR.TodayHistory, 'positive control: the real exports');
});

const NOTE = 'Projects/Working/Call metrics in Nova (private draft).md';
const live = (over = {}) => ({
  target: 'live', practice: false, verified: true, complete: true, plain: 'The note is saved and read back. The block is in your calendar, just you.', next: 'Nothing else will be done.',
  steps: [
    { step: 'note', status: 'done', path: NOTE, findIt: 'Projects → Working → Call metrics in Nova (private draft)', verified: [{ what: 'read back', ok: true }] },
    { step: 'calendar', status: 'done', when: { say: 'Friday 23 October, 10:30–11:00' }, verified: [{ what: 'read back', ok: true }] },
  ],
  ...over,
});

test('a verified live receipt: Done, the exact time, and exactly where the note is', () => {
  const h = renderToString(React.createElement(PM.ReceiptBlock, { receipt: live(), onOpenNote: () => {} }));
  const t = text(h);
  assert.match(t, /^ ?Done /);
  assert.match(t, /Calendar block : done and read back · Friday 23 October, 10:30–11:00/);
  assert.match(t, /In Obsidian: Projects → Working → Call metrics in Nova \(private draft\)\./);
  assert.match(h, />View the draft</);
  assert.match(h, /data-receipt-kind="verified"/);
  // Without a shell that can open notes, the location is still stated — no dead button.
  assert.doesNotMatch(renderToString(React.createElement(PM.ReceiptBlock, { receipt: live() })), />View the draft</);
});

test('live but a read-back did not hold, or not complete: never "Done" alone', () => {
  const unverified = text(renderToString(React.createElement(PM.ReceiptBlock, { receipt: live({ verified: false }) })));
  assert.match(unverified, /Done — but a read-back didn’t hold/);
  const partial = text(renderToString(React.createElement(PM.ReceiptBlock, { receipt: live({ verified: false, complete: false, steps: [{ step: 'note', status: 'done', path: NOTE }, { step: 'calendar', status: 'failed', provablyNotApplied: true }] }) })));
  assert.match(partial, /^ ?Partly done/);
  const nothing = text(renderToString(React.createElement(PM.ReceiptBlock, { receipt: live({ verified: false, complete: false, steps: [{ step: 'note', status: 'failed', provablyNotApplied: true }] }) })));
  assert.match(nothing, /Nothing was saved/);
});

test('a practice receipt says so first, claims no calendar or vault, and is never "Done"', () => {
  const h = renderToString(React.createElement(PM.ReceiptBlock, { receipt: live({ target: 'sandbox', practice: true, verified: false, steps: [{ step: 'note', status: 'done', path: NOTE }, { step: 'calendar', status: 'done', when: { say: 'Friday 23 October, 10:30–11:00' } }] }), onOpenNote: () => {} }));
  const t = text(h);
  assert.match(t, /^ ?Practice run — nothing real was changed\. This ran against a sandbox/);
  assert.match(t, /Sandbox calendar block : done and read back · Friday 23 October, 10:30–11:00/);
  assert.doesNotMatch(t, /In Obsidian|View the draft/, 'a sandbox note claims no place in the vault');
  assert.doesNotMatch(h, /pmo__actlead">Done</);
});

test('a receipt that does not say where it ran claims nothing', () => {
  const t = text(renderToString(React.createElement(PM.ReceiptBlock, { receipt: live({ target: undefined }) })));
  assert.match(t, /I can’t confirm what this changed/);
  assert.doesNotMatch(t, /^ ?Done /);
});

const today = (over = {}) => ({
  contract: 'prepared-move-history-v1', day: '2026-10-22', known: true, gaps: [],
  items: [
    { moveKey: 'm1', title: 'Call metrics in Nova', stage: 'verified', stageSay: 'Done and read back', atSay: '14:05', when: { say: 'Friday 23 October, 10:30–11:00', practice: false }, note: { path: NOTE }, reply: null },
    { moveKey: 'm2', title: 'Podcast plan', stage: 'practice', stageSay: 'Practice run — nothing real changed', atSay: '13:40', when: { say: 'Friday 23 October, 11:05–11:35', practice: true }, note: null, reply: null },
    { moveKey: 'm3', title: 'Reply to Sam', stage: 'prepared', stageSay: 'Prepared — waiting for you', atSay: '09:12', when: null, note: null, reply: null },
  ],
  ...over,
});

test('Today: prepared, practice and verified told apart, with exact times and a live note’s place', () => {
  const h = renderToString(React.createElement(DR.TodayHistory, { today: today(), onOpenNote: () => {} }));
  const t = text(h);
  assert.match(h, /id="drafts-today"/, 'findable');
  assert.match(t, /14:05 Done and read back Call metrics in Nova Calendar · Friday 23 October, 10:30–11:00 Note · Projects\/Working\/Call metrics in Nova \(private draft\)\.md Open the note/);
  assert.match(t, /13:40 Practice run — nothing real changed Podcast plan Sandbox block · Friday 23 October, 11:05–11:35/);
  assert.match(t, /09:12 Prepared — waiting for you Reply to Sam/);
  assert.equal((h.match(/>Open the note</g) || []).length, 1, 'only the live, verified note opens');
});

test('Today: an unreadable store is said; an empty day is said; the kiosk has no buttons', () => {
  const gap = text(renderToString(React.createElement(DR.TodayHistory, { today: today({ known: false, gaps: [{ source: 'receipts', why: 'x' }], items: [] }) })));
  assert.match(gap, /couldn’t read all of today’s records \(receipts\) — this list may be short/);
  assert.match(text(renderToString(React.createElement(DR.TodayHistory, { today: today({ items: [] }) }))), /Nothing prepared or confirmed today\./);
  const kiosk = renderToString(React.createElement(DR.TodayHistory, { today: today(), readOnly: true, onOpenNote: () => {} }));
  assert.doesNotMatch(kiosk, /<button/);
  assert.match(text(kiosk), /Call metrics in Nova/, 'the kiosk can still inspect the record');
});
