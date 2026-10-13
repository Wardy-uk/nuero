'use strict';

// One email card, two inboxes (13 Oct 2026). Nick: the personal inbox "is not
// the same as work inbox — both how it looks and functionally". The fix is ONE
// component: both panels import EmailCard, neither defines its own, and the
// personal lanes really render it (esbuild + renderToString) with the work
// card's buttons — plus its own extras — against the personal API.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const DIR = path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

async function bundle(file) {
  const out = await esbuild.build({
    entryPoints: [path.join(DIR, file)], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
        build.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
        build.onResolve({ filter: /(^|\/)(api|directAction)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p; export const executeDirect = async () => ({}); export const directOutcome = () => null;', loader: 'js' }));
      },
    }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  return m.exports;
}
const clean = (html) => html.replace(/<!-- -->/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

test('both inboxes import the ONE EmailCard and neither defines its own', () => {
  const card = strip(fs.readFileSync(path.join(DIR, 'EmailCard.jsx'), 'utf8'));
  assert.match(card, /export function EmailCard\(/, 'positive control: the shared card is defined there');
  for (const f of ['InboxPanel.jsx', 'PersonalInboxPanel.jsx']) {
    const src = strip(fs.readFileSync(path.join(DIR, f), 'utf8'));
    assert.match(src, /import EmailCard[^;]*from '\.\/EmailCard'/, `${f} imports the shared card`);
    assert.match(src, /<EmailCard\b/, `${f} renders it`);
    assert.doesNotMatch(src, /function EmailCard\b/, `${f} has no card of its own`);
  }
});

const email = (over = {}) => ({
  id: 'pmail:nick:5:7', mailbox: 'nick', from: 'Sam', fromEmail: 'sam@example.com', subject: 'Lunch Friday?',
  preview: 'Are you free on Friday?', received: new Date(Date.now() - 3 * 3600000).toISOString(),
  category: 'FYI', lane: 'fyi', reason: 'asks about lunch', why: null, ...over,
});
const SHARED_BUTTONS = ['Done', 'Read & dismiss', 'Subject not relevant', 'Mute sender', 'Needs action', 'Summary', 'Full email', 'Reply'];

test('the personal lanes render the shared card with the work buttons, the personal extras, the mailbox chip and the sections in the work order', async () => {
  const mod = await bundle('PersonalInboxPanel.jsx');
  const triage = {
    action: [email({ id: 'pmail:nick:5:1', category: 'ACTION', lane: 'reply', subject: 'Car insurance renewal' })],
    unsorted: [email({ id: 'pmail:contact:5:2', mailbox: 'contact', category: null, lane: 'unsorted', subject: 'Hello from the website' })],
    delegate: [],
    fyi: [email({ id: 'gmail:9', mailbox: 'gmail', why: 'Starred in Gmail', subject: 'Parcel delivered' })],
    ignore: [], lastRun: String(Date.now()), fyiAgeOutDays: 7,
  };
  const html = clean(renderToString(React.createElement(mod.PersonalLanes, {
    triage, showBox: true, selected: new Set(['pmail:nick:5:1']), onSelect() {}, onDismiss() {}, onPromote() {}, onReplied() {},
    dismissing: null, onDelete() {}, onSender() {}, busy: false, fyiOpen: true, onToggleFyi() {},
  })));
  const cards = html.match(/data-testid="email-card"/g) || [];
  assert.equal(cards.length, 3, 'every row is the shared card');
  for (const b of SHARED_BUTTONS) assert.ok(html.includes(`>${b}<`), `the "${b}" button`);
  assert.ok(html.indexOf('ACTION (1)') < html.indexOf('NOT SORTED YET (1)') && html.indexOf('NOT SORTED YET') < html.indexOf('FYI (1)'), 'Action, then not-yet-sorted, then FYI');
  assert.match(html, /Nothing here has been filed as FYI/);
  assert.match(html, />nick@</); assert.match(html, />contact@</); assert.match(html, /Gmail · Starred in Gmail/);
  assert.match(html, />Delete</, 'Delete to the Bin');
  assert.match(html, /data-testid="pi-keep"/, 'Gmail rules on the Gmail card');
  assert.equal((html.match(/data-testid="pi-keep"/g) || []).length, 1, 'only on the Gmail card');
  assert.match(html, /Marks it read in the mailbox/);
  assert.match(html, /type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/, 'the selected card is ticked');
  assert.match(html, /Cleared automatically after 7 days/);
});

test('the work card renders the same buttons by default, says Outlook, and has no personal extras', async () => {
  const { EmailCard } = await bundle('EmailCard.jsx');
  const html = clean(renderToString(React.createElement(EmailCard, { email: email({ id: 'AAMk-1', mailbox: undefined }), borderClass: 'urgency-low', onDismiss() {}, onPromote() {}, onReplied() {}, dismissing: null })));
  for (const b of SHARED_BUTTONS) assert.ok(html.includes(`>${b}<`), `the "${b}" button`);
  assert.match(html, /Marks it read in Outlook/);
  assert.doesNotMatch(html, />Delete<|pi-keep|type="checkbox"/);
  const personal = clean(renderToString(React.createElement(EmailCard, { email: email(), borderClass: 'urgency-low', onDismiss() {}, onPromote() {}, onReplied() {}, dismissing: null, readWhere: 'the mailbox' })));
  const buttons = (h) => (h.match(/<button[^>]*>([^<]+)<\/button>/g) || []).map((b) => b.replace(/<[^>]+>/g, ''));
  assert.deepEqual(buttons(personal), buttons(html), 'the same card, the same buttons, in the same order');
});

test('an empty personal inbox says which empty it is', async () => {
  const mod = await bundle('PersonalInboxPanel.jsx');
  const r = (lastRun) => clean(renderToString(React.createElement(mod.PersonalLanes, { triage: { action: [], unsorted: [], delegate: [], fyi: [], ignore: [], lastRun } })));
  assert.match(r(String(Date.now())), /personal inbox is clear/);
  assert.match(r(null), /Not sorted yet/);
});
