'use strict';

// Gmail clean-up (12 Oct 2026). What must hold: archive removes ONLY the Inbox
// label and only for the EXACT sender; an unsubscribe URL from a stranger's
// header is never fetched unless it is https to a public host; a one-click POST
// is ledgered; the web/mailto kinds hand Nick the link and fetch nothing; and
// every unsubscribe also sets the archive rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-gclean-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'g.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');

const db = require('../db/database');
const pm = require('./personal-mail');
const gc = require('./gmail-cleanup');

test.before(async () => {
  await db.init();
  pm.setCredential('gmail', { address: 'n.example@gmail.com', password: 'abcd efgh ijkl mnop' });
});

const LIST = (url, oneClick = true) => ({ listUnsubscribe: `<mailto:u@list.example>, <${url}>`, listUnsubscribePost: oneClick ? 'List-Unsubscribe=One-Click' : '' });

test('unsubscribe headers: one-click needs BOTH an https URL and the RFC 8058 Post header', () => {
  assert.deepEqual(gc.parseUnsubscribe('<mailto:a@b.co>, <https://x.example/u>', 'List-Unsubscribe=One-Click'), { oneClick: 'https://x.example/u', link: 'https://x.example/u', kind: 'one-click' });
  assert.equal(gc.parseUnsubscribe('<https://x.example/u>', '').kind, 'web');
  assert.equal(gc.parseUnsubscribe('<mailto:a@b.co>', 'List-Unsubscribe=One-Click').kind, 'mailto', 'one-click over mailto is not a thing');
  assert.equal(gc.parseUnsubscribe('<http://x.example/u>', 'List-Unsubscribe=One-Click').kind, null, 'plain http is never used');
  assert.equal(gc.parseUnsubscribe('', '').kind, null);
});

test('senders are grouped by exact address, busiest first, with opened counts and the best unsubscribe any mail offered', () => {
  const rows = gc.groupSenders([
    { fromEmail: 'News@Shop.example', fromName: 'Shop', subject: 'Old', date: '2026-10-01T00:00:00Z', seen: false, ...LIST('https://shop.example/u', false) },
    { fromEmail: 'news@shop.example', fromName: 'Shop', subject: 'New', date: '2026-10-05T00:00:00Z', seen: true, ...LIST('https://shop.example/u') },
    { fromEmail: 'friend@example.com', fromName: 'Pal', subject: 'Hi', date: '2026-10-03T00:00:00Z', seen: true },
    { fromEmail: 'not an address', subject: 'x' },
  ]);
  assert.deepEqual(rows.map((r) => [r.sender, r.count, r.opened, r.lastSubject]), [['news@shop.example', 2, 1, 'New'], ['friend@example.com', 1, 1, 'Hi']]);
  assert.equal(rows[0].unsubscribe.kind, 'one-click', 'a later one-click offer beats an earlier web link');
  assert.equal(rows[1].unsubscribe, null);
});

test('a stranger\'s URL is only called when it is https to a PUBLIC host', async () => {
  const pub = async () => [{ address: '93.184.216.34' }];
  assert.equal((await gc.safeTarget('https://lists.example/u', { lookup: pub })).ok, true);
  for (const [url, lookup] of [
    ['http://lists.example/u', pub],
    ['https://user:pw@lists.example/u', pub],
    ['https://192.168.1.1/u', pub],
    ['https://127.0.0.1/u', pub],
    ['https://pi5.tailecb90f.ts.net/api', pub],
    ['https://localhost/x', pub],
    ['https://rebind.example/u', async () => [{ address: '10.0.0.5' }]],
    ['https://cgnat.example/u', async () => [{ address: '100.100.28.58' }]],
    ['https://nx.example/u', async () => { throw new Error('ENOTFOUND'); }],
  ]) assert.equal((await gc.safeTarget(url, { lookup })).ok, false, url);
});

function gmail(messages) {
  const s = { messages, removed: [], searches: [] };
  s.imap = () => ({
    on() {}, async connect() {}, async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search(q) { s.searches.push(q); return s.messages.filter((m) => !q.from || m.from.includes(q.from)).map((m) => m.uid); },
    async *fetch(range) { const want = String(range).split(',').map(Number); for (const m of s.messages) if (want.includes(m.uid)) yield { uid: m.uid, envelope: { from: [{ address: m.from }] } }; },
    async messageFlagsRemove(uids, flags, opts) { s.removed.push({ uids, flags, opts }); },
  });
  return s;
}

test('archive removes ONLY the Inbox label, only for the exact sender, and runs from the rule on every pass', async () => {
  const srv = gmail([{ uid: 1, from: 'news@shop.example' }, { uid: 2, from: 'news@shop.example.evil' }, { uid: 3, from: 'friend@example.com' }, { uid: 4, from: 'news@shop.example' }]);
  const r = await gc.decide('News@Shop.example', 'archive', { deps: { imap: srv.imap } });
  assert.deepEqual([r.ok, r.archived], [true, 2]);
  assert.deepEqual(srv.removed, [{ uids: '1,4', flags: ['\\Inbox'], opts: { uid: true, useLabels: true } }], 'a label change, never a delete or move');
  assert.equal(gc.readRules().senders['news@shop.example'].action, 'archive');
  srv.removed.length = 0;
  const pass = await gc.applyRules({ deps: { imap: srv.imap } });
  assert.equal(pass.archived, 2, 'the rule keeps working on later passes');
  assert.equal((await gc.decide('news@shop.example', 'clear')).ok, true);
  srv.removed.length = 0;
  assert.deepEqual(await gc.applyRules({ deps: { imap: srv.imap } }), { ok: true, archived: 0, senders: 0 }, 'undo stops future archiving and touches nothing');
  assert.equal(srv.removed.length, 0);
  assert.equal((await gc.decide('nonsense', 'archive')).ok, false);
});

test('unsubscribe: one-click is POSTed once and ledgered; web/mailto hand Nick the link and fetch nothing; both set the archive rule', async () => {
  db.setState(gc.SCAN_KEY, JSON.stringify({ at: 'x', days: 30, total: 3, senders: [
    { sender: 'deals@shop.example', count: 9, opened: 0, unsubscribe: { kind: 'one-click', oneClick: 'https://shop.example/u?t=1', link: 'https://shop.example/u?t=1' } },
    { sender: 'promo@web.example', count: 4, opened: 0, unsubscribe: { kind: 'web', oneClick: null, link: 'https://web.example/unsub' } },
    { sender: 'nolist@x.example', count: 2, opened: 0, unsubscribe: null },
  ] }));
  const srv = gmail([{ uid: 9, from: 'deals@shop.example' }]);
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push({ url, method: init.method, body: init.body, redirect: init.redirect }); return { status: 200 }; };
  const lookup = async () => [{ address: '93.184.216.34' }];
  let r = await gc.decide('deals@shop.example', 'unsubscribe', { deps: { imap: srv.imap }, fetchImpl, lookup });
  assert.deepEqual([r.ok, r.status, r.archived], [true, 'sent', 1]);
  assert.deepEqual(posts, [{ url: 'https://shop.example/u?t=1', method: 'POST', body: 'List-Unsubscribe=One-Click', redirect: 'manual' }]);
  assert.equal(require('./external-writes').byKey('gmail-unsub:deals@shop.example').status, 'confirmed');
  assert.equal(gc.readRules().senders['deals@shop.example'].action, 'unsubscribed');
  r = await gc.decide('deals@shop.example', 'unsubscribe', { deps: { imap: srv.imap }, fetchImpl, lookup });
  assert.equal(r.status, 'already'); assert.equal(posts.length, 1, 'never POSTed twice');

  r = await gc.decide('promo@web.example', 'unsubscribe', { deps: { imap: gmail([]).imap }, fetchImpl, lookup });
  assert.deepEqual([r.ok, r.method, r.link], [true, 'web', 'https://web.example/unsub']);
  assert.equal(posts.length, 1, 'a web link is NOT called by NEURO');
  assert.equal(gc.readRules().senders['promo@web.example'].action, 'unsubscribed');
  const inst = await gc.decide('nolist@x.example', 'unsubscribe', { deps: { imap: gmail([]).imap } });
  assert.deepEqual([inst.ok, inst.method], [true, 'archived-instead'], 'no unsubscribe offered → archived instead, and said');
  assert.equal(gc.readRules().senders['nolist@x.example'].action, 'archive');

  const view = gc.view();
  assert.deepEqual(view.senders.map((x) => x.sender), [], 'decided senders leave the list');
  assert.deepEqual(view.decided.map((x) => x.sender).sort(), ['deals@shop.example', 'nolist@x.example', 'promo@web.example']);
});

test('a one-click URL that resolves privately is never called — Nick gets the link', async () => {
  db.setState(gc.SCAN_KEY, JSON.stringify({ at: 'x', days: 30, total: 1, senders: [
    { sender: 'odd@lan.example', count: 1, opened: 0, unsubscribe: { kind: 'one-click', oneClick: 'https://lan.example/u', link: 'https://lan.example/u' } },
  ] }));
  let called = 0;
  const r = await gc.decide('odd@lan.example', 'unsubscribe', { deps: { imap: gmail([]).imap }, fetchImpl: async () => { called += 1; return { status: 200 }; }, lookup: async () => [{ address: '192.168.1.20' }] });
  assert.deepEqual([r.ok, r.method, r.link, called], [true, 'web', 'https://lan.example/u', 0]);
});

test('bulk: each sender decided as one would be, then ONE archive pass; a sender with no unsubscribe is ARCHIVED INSTEAD and named as such', async () => {
  db.setState(gc.RULES_KEY, '');
  db.setState(gc.SCAN_KEY, JSON.stringify({ at: 'x', days: 30, total: 4, senders: [
    { sender: 'a@one.example', count: 5, opened: 0, unsubscribe: { kind: 'one-click', oneClick: 'https://one.example/u', link: 'https://one.example/u' } },
    { sender: 'b@web.example', count: 3, opened: 0, unsubscribe: { kind: 'web', oneClick: null, link: 'https://web.example/u' } },
    { sender: 'c@none.example', count: 2, opened: 0, unsubscribe: null },
  ] }));
  let connects = 0;
  const srv = gmail([{ uid: 1, from: 'a@one.example' }, { uid: 2, from: 'b@web.example' }, { uid: 3, from: 'c@none.example' }]);
  const imap = () => { connects += 1; return srv.imap(); };
  const posts = [];
  const r = await gc.decideMany(['A@one.example', 'b@web.example', 'c@none.example', 'a@one.example'], 'unsubscribe', { deps: { imap }, fetchImpl: async (u) => { posts.push(u); return { status: 202 }; }, lookup: async () => [{ address: '93.184.216.34' }] });
  assert.deepEqual(r.done, ['a@one.example', 'b@web.example', 'c@none.example'], 'a repeated sender counts once');
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.archivedInstead, ['c@none.example'], 'named as archived, never counted as unsubscribed');
  assert.deepEqual(r.links.map((l) => l.sender), ['b@web.example']);
  assert.deepEqual(posts, ['https://one.example/u']);
  assert.equal(connects, 1, 'ONE Gmail connection for the whole batch');
  assert.deepEqual(srv.removed.map((x) => x.uids).sort(), ['1', '2', '3'], 'all three leave the inbox, in the one pass');
  assert.equal(gc.readRules().senders['c@none.example'].action, 'archive');
  assert.equal(posts.length, 1, 'nothing was POSTed for the sender with no unsubscribe');

  connects = 0; srv.removed.length = 0;
  const k = await gc.decideMany(['c@none.example'], 'archive', { deps: { imap } });
  assert.deepEqual([k.ok, connects], [true, 1]);
  const keep = await gc.decideMany(['x@keep.example', 'not-an-address'], 'keep');
  assert.deepEqual([keep.done, keep.failed.map((f) => f.sender)], [['x@keep.example'], ['not-an-address']]);
  assert.equal((await gc.decideMany([], 'keep')).ok, false);
  assert.equal((await gc.decideMany(['a@b.co'], 'delete')).ok, false);
  assert.equal((await gc.decideMany(Array.from({ length: gc.BULK_MAX + 1 }, (_, i) => `s${i}@x.co`), 'keep')).ok, false, 'over the cap is refused, not clamped');
});

test('the screen, really rendered: rows by volume with opened counts, the right unsubscribe wording, decided with Undo', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'GmailCleanup.jsx')], bundle: true, write: false,
    format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiUrl = p => p;', loader: 'js' }));
    } }],
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { CleanupView } = mod.exports;
  assert.ok(CleanupView, 'positive control: the view is exported');
  const data = { scannedAt: '2026-10-12T15:00:00Z', days: 30, total: 300, note: 'Archive skips the inbox.', senders: [
    { sender: 'alerts@hc.example', name: 'Healthchecks', count: 139, opened: 0, lastSubject: 'UP | Pi 5', unsubscribe: { kind: 'one-click' } },
    { sender: 'promo@web.example', name: 'Promo', count: 20, opened: 2, lastSubject: 'Sale', unsubscribe: { kind: 'web' } },
    { sender: 'pal@example.com', name: 'Pal', count: 3, opened: 3, lastSubject: 'Hi', unsubscribe: null },
  ], decided: [{ sender: 'deals@shop.example', action: 'unsubscribed', unsubscribe: { status: 'sent' } }] };
  const html = renderToString(React.createElement(CleanupView, { data, onDecide() {}, onRescan() {}, busy: false, outcome: { tone: 'ok', text: 'x', link: 'https://web.example/unsub' } })).replace(/<!-- -->/g, '');
  assert.ok(html.indexOf('Healthchecks') < html.indexOf('Promo') && html.indexOf('Promo') < html.indexOf('Pal'), 'in the order given — busiest first');
  assert.match(html, /<strong>139<\/strong> · opened 0/);
  assert.match(html, />Unsubscribe</); assert.match(html, /Unsubscribe \(opens page\)/);
  assert.equal((html.match(/>Archive</g) || []).length, 3); assert.equal((html.match(/>Keep</g) || []).length, 3);
  assert.equal((html.match(/Unsubscribe/g) || []).length, 2, 'no unsubscribe offered where the sender gives none');
  assert.match(html, /Show decided \(1\)/);
  assert.match(html, /data-testid="gc-unsub-link"/, 'an unsubscribe Nick must finish is a link, not a blocked popup');
  assert.match(html, /300 emails in the last 30 days/);
  const picked = renderToString(React.createElement(CleanupView, { data, onDecide() {}, onRescan() {}, busy: false, selected: new Set(['promo@web.example']), onToggle() {}, onSelectAll() {}, onBulk() {}, outcome: { tone: 'warn', text: 'y', links: [{ sender: 'promo@web.example', link: 'https://web.example/unsub' }] } })).replace(/<!-- -->/g, '');
  assert.equal((picked.match(/class="pi-pick gc-pick"/g) || []).length, 3);
  assert.match(picked, /gc-row gc-pickable gc-selected/);
  assert.match(picked, /1 selected/);
  assert.match(picked, /data-testid="gc-bulk"/);
  assert.match(picked, /href="https:\/\/web\.example\/unsub"[^>]*>promo@web\.example<\/a> — finish unsubscribing/);
  assert.doesNotMatch(html, /gc-pick/, 'no tickboxes without the multi-select wiring');
});
