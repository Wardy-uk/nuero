'use strict';

/**
 * The Escalations page as ONE ticket list (23 Oct 2026): escalated and watched
 * tickets merged, a ticket once. Rendered for real (esbuild → renderToString)
 * with the pure view `TicketsView`, plus `mergeTickets` (ordering + "needs
 * you") and a scan that the page's default export mounts the view.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'frontend', 'src', 'components', 'EscalationPanel.jsx');
let mod;
test.before(async () => {
  const out = await esbuild.build({
    entryPoints: [FILE],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = (p) => p;', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  mod = m.exports;
});

const noop = async () => true;
const render = (props) => renderToString(React.createElement(mod.TicketsView, {
  onOpen: noop, onWatch: noop, onRead: noop, onUnwatch: noop, onCommit: noop, onEscalate: noop, onRefresh: noop, ...props,
})).split('<!-- -->').join('');

const in90 = () => new Date(Date.now() + 90 * 60000).toISOString();
const ago20 = () => new Date(Date.now() - 20 * 60000).toISOString();
const esc = (over) => ({ key: 'NT-10', summary: 'Portal login loop', status: 'Open', created: '2026-10-20T10:00:00Z', updated: '2026-10-22T10:00:00Z', viaUrgency: true, url: '#', ...over });
const watched = (over) => ({ key: 'NT-20', summary: 'Forms not working', status: 'In Progress', phase: 'active', url: '#', baselineTaken: true, unread: 0, replies: [], commitments: [], ...over });

test('positive control: the view, the card and the merge are exported', () => {
  assert.equal(typeof mod.TicketsView, 'function');
  assert.equal(typeof mod.TicketCard, 'function');
  assert.equal(typeof mod.mergeTickets, 'function');
});

test('a ticket both escalated and watched appears ONCE, with both', () => {
  const items = mod.mergeTickets([esc({ key: 'NT-1' })], { active: [watched({ key: 'NT-1' })], listening: [] });
  assert.equal(items.length, 1);
  assert.ok(items[0].esc && items[0].watch);
});

test('order: needs you → promised updates → escalated → watching → resolved-listening', () => {
  const items = mod.mergeTickets(
    [esc({ key: 'NT-E' })],
    { active: [watched({ key: 'NT-W' }), watched({ key: 'NT-U', commitments: [{ id: 1, state: 'open', dueAt: in90() }] }), watched({ key: 'NT-N', unread: 1 })],
      listening: [watched({ key: 'NT-L', phase: 'background' })] },
  );
  assert.deepEqual(items.map((t) => t.key), ['NT-N', 'NT-U', 'NT-E', 'NT-W', 'NT-L']);
  assert.deepEqual(items[0].needs, ['1 new reply']);
});

test('collapsed, a row is ONE line: key, summary, what is due — the details wait for a click', () => {
  const html = render({ escalations: [], watched: { active: [watched({ key: 'NT-35291', replies: [{ author: 'A', created: '2026-10-23T12:00:00Z', excerpt: 'hidden until opened', flagged: true }], commitments: [{ id: 9, state: 'open', dueAt: in90() }] })], listening: [] } });
  assert.match(html, /Forms not working/);
  assert.match(html, /esc-tail esc-tail-warn">update \d\d:\d\d · in 1h (30|29)m/);
  assert.doesNotMatch(html, /hidden until opened/);
  assert.match(html, /aria-expanded="false"/);
});

test('one list on screen: filter counts, needs-you pills, escalation route, the reply, the commitment strip', () => {
  const html = render({
    escalations: [esc({ key: 'NT-35210', replyState: 'awaiting-you' })],
    watched: { active: [
      watched({ key: 'NT-35301', unread: 2, replies: [{ author: 'Anthony', created: '2026-10-23T12:00:00Z', excerpt: 'Still seeing the wrong branch', flagged: true }],
        commitments: [{ id: 1, state: 'proposed', dueAt: in90(), phrase: 'I will get back to you by 5pm today' }, { id: 2, state: 'open', dueAt: ago20(), missed: true }] }),
      watched({ key: 'NT-35291', commitments: [{ id: 3, state: 'open', dueAt: in90() }] }),
    ], listening: [] },
    initialExpanded: ['NT-35210', 'NT-35301', 'NT-35291'],
  });
  assert.match(html, /Needs you<span class="esc-filter-count esc-filter-count-alert">2</);
  assert.match(html, /no reply from you/);
  assert.match(html, /escalated · urgency/);
  assert.match(html, /2 new replies/);
  assert.match(html, /Still seeing the wrong branch/);
  assert.match(html, /Spotted in your reply/);
  assert.match(html, /Confirm/);
  assert.match(html, /Update promised by .*in 1h (30|29)m/);
  assert.match(html, /overdue by (20|19)m/);
  assert.match(html, /esc-commitment-missed/);
  assert.match(html, /\+ Add update commitment/);
  assert.match(html, /Escalate again/);
  assert.equal((html.match(/id="esc-ticket-/g) || []).length, 3);
});

test('a resolved ticket says it is still listening; a reply judged a thank-you says so', () => {
  const html = render({ escalations: [], watched: { active: [], listening: [watched({ key: 'NT-9', phase: 'background', listeningUntil: '2026-11-05T23:59:59Z',
    replies: [{ author: 'Sam', created: '2026-10-22T09:00:00Z', excerpt: 'Thanks!', flagged: false }] })] }, initialExpanded: ['NT-9'] });
  assert.match(html, /resolved · listening until/);
  assert.match(html, /judged a thank-you/);
});

test('empty, unreadable queue and a failed check are different things', () => {
  assert.match(render({ escalations: [], watched: { active: [], listening: [] } }), /Nothing escalated and nothing watched/);
  const unread = render({ escalations: null, escalationsError: 'Jira timed out', watched: { active: [], listening: [] } });
  assert.match(unread, /Couldn’t read the escalated queue: Jira timed out/);
  assert.match(unread, /this is not an empty queue/);
  assert.doesNotMatch(unread, /That is the good outcome/);
  assert.match(render({ escalations: [], watched: { active: [], listening: [], lastRun: { ok: false, why: 'Jira timed out' } } }), /last check didn’t complete — Jira timed out/);
});

test('the page mounts the one list', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.match(src, /<TicketsView\b/);
  assert.doesNotMatch(src, /function WatchedTickets\b/, 'the separate watched card is gone');
});

test('the reply composer opens on INTERNAL note, with a draft button and no post button until previewed', () => {
  const html = renderToString(React.createElement(mod.ReplyComposer, { ticketKey: 'NT-35291', onClose: () => {}, onPosted: () => {} })).split('<!-- -->').join('');
  assert.match(html, /aria-checked="true" class="esc-seg-on"[^>]*>Internal note/);
  assert.match(html, /aria-checked="false"[^>]*>Reply to customer/);
  assert.match(html, /Draft it/);
  assert.match(html, /Anything in \[square brackets\] is a gap to fill/);
  assert.doesNotMatch(html, /Post reply to customer|Post internal note/);
});

test('every expanded ticket offers Reply', () => {
  const html = renderToString(React.createElement(mod.TicketsView, {
    onOpen: async () => true, onWatch: async () => true, onRead: async () => true, onUnwatch: async () => true, onCommit: async () => true, onEscalate: () => {}, onRefresh: () => {},
    escalations: [{ key: 'NT-10', summary: 'x', created: '2026-10-20T10:00:00Z', updated: '2026-10-22T10:00:00Z', viaTier: true, url: '#' }],
    watched: { active: [], listening: [] }, initialExpanded: ['NT-10'],
  }));
  assert.match(html, />Reply</);
});
