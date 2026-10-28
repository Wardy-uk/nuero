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
  assert.match(html, /Raise in Jira again/);
  assert.match(html, /Escalate by email…/);
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

// ── Escalate to… (27 Oct 2026): pick a person or type any address ──────────
test('parseRecipient: a picked person, a typed address, a People name — and nothing guessed', () => {
  const people = [{ name: 'Chris Middleton', email: 'chris.m@nurtur.tech' }, { name: 'Chris Smith', email: 'chris.s@nurtur.tech' }];
  assert.deepEqual(mod.parseRecipient('Chris Middleton <chris.m@nurtur.tech>', people), { name: 'Chris Middleton', email: 'chris.m@nurtur.tech' });
  assert.deepEqual(mod.parseRecipient('Someone@Example.com', people), { name: null, email: 'someone@example.com' });
  assert.deepEqual(mod.parseRecipient('CHRIS.S@nurtur.tech', people), { name: 'Chris Smith', email: 'chris.s@nurtur.tech' });
  assert.deepEqual(mod.parseRecipient('chris smith', people), { name: 'Chris Smith', email: 'chris.s@nurtur.tech' });
  assert.equal(mod.parseRecipient('Chris', people), null, 'a first name is not an address');
  assert.equal(mod.parseRecipient('not an email', people), null);
  assert.equal(mod.parseRecipient('Bad <nope>', people), null);
  assert.equal(mod.parseRecipient('', people), null);
});

test('escalationEmailDraft: facts off the card and a gap that blocks Send', () => {
  const d = mod.escalationEmailDraft({ key: 'NT-1', summary: 'Login broken', url: 'https://x/NT-1', status: 'Open', esc: { priority: 'Critical', assignee: null } });
  assert.match(d.subject, /^Escalation: NT-1 — Login broken$/);
  assert.match(d.body, /Link: https:\/\/x\/NT-1/);
  assert.match(d.body, /Assignee: Unassigned/);
  assert.match(d.body, /\[What you need from them, and by when\]/);
  assert.doesNotMatch(d.body, /Reason:/);
});

// ── Rejected by Tier 2 — awaiting approval (28 Oct 2026) ────────────────────
const rej = (over) => ({ key: 'NT-30', summary: 'Logo wrong on brochure', status: 'Pending Rejection Approval (to CC)', updated: '2026-10-27T10:00:00Z', url: '#', seen: false, ...over });

test('rejections render as their own section; an unopened one says "new"', () => {
  const html = render({ escalations: [esc({ key: 'NT-1' })], watched: { active: [], listening: [] }, rejections: [rej(), rej({ key: 'NT-31', seen: true })] });
  assert.match(html, /Rejected by Tier 2 — awaiting approval/);
  assert.match(html, /NT-30/); assert.match(html, /NT-31/);
  assert.match(html, /1 not opened/);
  const items = mod.rejectionItems([rej(), rej({ key: 'NT-31', seen: true })]);
  assert.deepEqual(items.map((i) => i.needs), [['new'], []]);
});

test('an unreadable rejections list says so — never an empty one', () => {
  const html = render({ escalations: [], watched: { active: [], listening: [] }, rejections: null, rejectionsError: 'Could not read X: 502' });
  assert.match(html, /This is not an empty list/);
  assert.doesNotMatch(html, /No tickets are waiting on a rejection approval/);
});

test('rejections never enter the escalated/watched merge', () => {
  const html = render({ escalations: [], watched: { active: [], listening: [] }, rejections: [rej()] });
  assert.match(html, /NT-30/);
  assert.equal(mod.mergeTickets([], { active: [], listening: [] }).length, 0);
});

const angry = (over) => ({ key: 'NT-40', summary: '360 Tour Links', status: 'Waiting on Development', score: -0.82, why: 'Customer says this is the third time of asking', organisation: 'Regan & Hallworth', seen: false, url: '#', ...over });

test('sentiment escalations render as their own section with a filter, score and reason', () => {
  const html = render({ escalations: [], watched: { active: [], listening: [] }, sentiment: [angry(), angry({ key: 'NT-41', seen: true })], initialExpanded: ['sent-NT-40'] });
  assert.match(html, /Sentiment escalations — customer is angry/);
  assert.match(html, /Sentiment escalations<span[^>]*>2</);
  assert.match(html, /1 not opened/);
  assert.match(html, /angry -0.82/);
  assert.match(html, /Why NOVA scored it Angry/);
  assert.match(html, /third time of asking/);
  assert.deepEqual(mod.sentimentItems([angry(), angry({ seen: true })]).map((i) => i.needs), [['new'], []]);
});

test('an unreadable angry list says so; the sentiment filter shows only that section', () => {
  const err = render({ escalations: [], watched: { active: [], listening: [] }, sentiment: null, sentimentError: 'Could not read angry tickets from NOVA: 502' });
  assert.match(err, /Could not read angry tickets[^<]*This is not an empty list/);
  assert.doesNotMatch(err, /No open ticket has an angry customer/);
  const only = render({ escalations: [esc({ key: 'NT-1' })], watched: { active: [], listening: [] }, sentiment: [angry()], initialFilter: 'sentiment' });
  assert.match(only, /NT-40/);
  assert.doesNotMatch(only, /NT-1</);
});

test('with no Tier 2 rejections, the main list still gets its own heading under the sentiment section', () => {
  const html = renderToString(React.createElement(mod.TicketsView, {
    escalations: [{ key: 'NT-1', summary: 'Escalated one', created: new Date().toISOString(), updated: new Date().toISOString(), viaTier: true }],
    watched: { active: [], listening: [] },
    sentiment: [{ key: 'NT-2', summary: 'Angry one', score: -0.8, seen: false }],
    rejections: [],
    reasons: [], busy: false, loading: false,
    onWatch: noop, onRead: noop, onUnwatch: noop, onCommit: noop, onEscalate: noop, onCloseEscalate: noop, onEscalated: noop, onPosted: noop,
  }));
  const sent = html.indexOf('Sentiment escalations — customer is angry');
  const main = html.indexOf('Escalated and watched');
  assert.ok(sent >= 0, 'sentiment section renders');
  assert.ok(main > sent, 'the main list has its own heading after the sentiment section');
  assert.ok(html.indexOf('NT-1') > main, 'the escalated ticket sits under its own heading');
});

test('the email draft is Nick’s wording and asks for an open linked dev item by name', () => {
  const item = { key: 'NT-14705', summary: 'Let Agreed properties not showing', url: 'https://x/NT-14705', status: 'Waiting on Development',
    sent: { priority: 'Normal', assignee: 'Naomi Wentworth', score: -0.8, why: 'very unhappy' } };
  const d = mod.escalationEmailDraft(item, [{ key: 'TPJ-2504', status: 'New', done: false }]);
  assert.match(d.body, /^Hi,\n\nAnother one I need to escalate, please: NT-14705\./);
  assert.match(d.body, /Customer sentiment: Angry \(NOVA score -0\.8\) — very unhappy/);
  assert.match(d.body, /Can we get TPJ-2504 prioritised please$/);
  assert.doesNotMatch(d.body, /\[/);
  // A done dev item is not asked for; the gap stays and blocks Send.
  assert.match(mod.escalationEmailDraft(item, [{ key: 'TPJ-1', done: true }]).body, /\[What you need from them, and by when\]$/);
  assert.equal(mod.devAsk([{ key: 'TPJ-1' }, { key: 'TPJ-2' }, { key: 'TPJ-3', done: true }]), 'TPJ-1 and TPJ-2');
  assert.equal(mod.devAsk([]), null);
});

test('a ticket already escalated by email says so on its row, and a sentiment row says it is raised in Jira', () => {
  const html = renderToString(React.createElement(mod.TicketsView, {
    escalations: [{ key: 'NT-9', summary: 'Raised one', created: new Date().toISOString(), updated: new Date().toISOString(), viaTier: true }],
    watched: { active: [], listening: [] },
    sentiment: [
      { key: 'NT-31647', summary: 'Angry and emailed', score: -0.82, seen: true },
      { key: 'NT-9', summary: 'Raised one', score: -0.7, seen: true },
    ],
    emailed: { 'NT-31647': [{ at: '2026-10-28T12:41:00Z', to: ['Chris Middleton'], status: 'verified' }] },
    rejections: [], reasons: [], busy: false,
    initialExpanded: ['sent-NT-31647'],
    onWatch: noop, onRead: noop, onUnwatch: noop, onCommit: noop, onEscalate: noop, onCloseEscalate: noop, onEscalated: noop, onPosted: noop,
  }));
  assert.match(html, /esc-pill-mail/);
  assert.match(html, /escalated by email to Chris Middleton · 28 Oct/);
  assert.match(html, /raised in Jira/);
  assert.equal((html.match(/esc-pill-mail/g) || []).length, 1, 'only the emailed ticket carries the pill');
});
