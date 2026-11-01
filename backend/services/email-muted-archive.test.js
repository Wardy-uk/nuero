'use strict';

// Muted senders archived in Outlook (1 Nov 2026). What must hold: an Inbox
// message from an EXACT muted address is moved to Archive and marked read;
// a flagged one, a non-muted one, and Nick's own address are left; the switch
// off does nothing; a Graph 5xx is no crash and is retried next pass after a
// read-back; a move Graph answers 2xx to but the read-back disagrees is
// REPORTED and not counted; a message Nick moved back is left alone.
// Graph is faked at global.fetch; the DB and the external-write ledger are real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mutearch-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'm.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
delete process.env.EMAIL_MUTED_ARCHIVE;

const db = require('../db/database');
const ma = require('./email-muted-archive');
const ext = require('./external-writes');
const flags = require('./feature-flags');

test.before(async () => { await db.init(); });

const MUTED = 'news@golf.example';
const RULES = { [MUTED]: { address: MUTED } };

function fakeGraph(messages, opts = {}) {
  const calls = [];
  const box = new Map(messages.map((m) => [m.id, { folder: 'INBOX', isRead: false, flag: 'notFlagged', ...m }]));
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    calls.push(`${method} ${p}`);
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
    if (opts.inboxStatus && p === '/me/mailFolders/inbox/messages') return reply(opts.inboxStatus, { error: 'x' });
    if (p === '/me/mailFolders/archive') return reply(200, { id: 'ARCH' });
    if (p === '/me/mailFolders/inbox/messages') {
      // Like a loose server: hands back everything in the Inbox; the archiver
      // must do the exact-address check itself.
      return reply(200, { value: [...box.entries()].filter(([, m]) => m.folder === 'INBOX').map(([id, m]) => ({ id, from: { emailAddress: { address: m.from } }, flag: { flagStatus: m.flag }, isRead: m.isRead, parentFolderId: m.folder })) });
    }
    let mm = p.match(/^\/me\/messages\/([^/]+)\/move$/);
    if (mm && method === 'POST') {
      if (opts.moveStatus) return reply(opts.moveStatus, { error: 'server' });
      const m = box.get(mm[1]);
      if (!opts.moveLies) m.folder = JSON.parse(init.body).destinationId === 'archive' ? 'ARCH' : 'X';
      return reply(201, { id: mm[1], parentFolderId: 'ARCH' });
    }
    mm = p.match(/^\/me\/messages\/([^/]+)$/);
    if (mm && method === 'GET') { const m = box.get(mm[1]); return m ? reply(200, { parentFolderId: m.folder, isRead: m.isRead }) : reply(404, {}); }
    if (mm && method === 'PATCH') { box.get(mm[1]).isRead = JSON.parse(init.body).isRead; return reply(200, {}); }
    return reply(404, { error: 'unexpected ' + p });
  };
  return { box, calls };
}

const deps = (over = {}) => ({ getToken: async () => 'tok', selfAddress: 'nick@nurtur.example', rules: RULES, ...over });

function reset() {
  db.run('DELETE FROM external_write_ledger', []);
  db.setState(ma._internals.COUNTS_KEY, '{}');
  flags.setEnabled('email_muted_archive', true);
}

test('kick() never runs from a test process (real mail must never be touched by a test)', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'positive control: the runner marks its child');
  let touched = false;
  const real = global.fetch;
  global.fetch = async () => { touched = true; throw new Error('no'); };
  try { assert.equal(await ma.kick(deps()), null); } finally { global.fetch = real; }
  assert.equal(touched, false);
});

test('muted mail is moved to Archive and marked read; flagged, non-muted and own mail are left', async () => {
  reset();
  const { box } = fakeGraph([
    { id: 'a1', from: 'News@Golf.example' },
    { id: 'a2', from: MUTED, flag: 'flagged' },
    { id: 'a3', from: 'colleague@nurtur.example' },
    { id: 'a4', from: 'news@golf.example.evil' },
    { id: 'a5', from: MUTED, flag: 'complete' },
  ]);
  const r = await ma.run(deps());
  assert.equal(r.ok, true);
  assert.equal(r.moved, 1);
  assert.equal(box.get('a1').folder, 'ARCH');
  assert.equal(box.get('a1').isRead, true);
  for (const id of ['a2', 'a3', 'a4', 'a5']) assert.equal(box.get(id).folder, 'INBOX', id);
  assert.equal(box.get('a2').isRead, false);
  assert.equal(r.flaggedLeft, 2);
  const led = ext.byKey('mail-archive:a1');
  assert.equal(led.status, 'confirmed');
  assert.match(led.readback, /in Archive; marked read/);
  assert.equal(ma.archivedCounts()[MUTED].archived, 1);
  // The muted list carries the count.
  db.setState('email_triage_muted_senders', JSON.stringify(RULES));
  const listed = require('./email-triage').listMutedSenders();
  assert.equal(listed[0].archivedInOutlook, 1);
});

test("Nick's own address is never archived even if a rule names it", async () => {
  reset();
  const { box } = fakeGraph([{ id: 's1', from: 'nick@nurtur.example' }]);
  const r = await ma.run(deps({ rules: { 'nick@nurtur.example': {} } }));
  assert.equal(r.moved, 0);
  assert.equal(box.get('s1').folder, 'INBOX');
});

test('switch off: nothing is read or moved', async () => {
  reset();
  flags.setEnabled('email_muted_archive', false);
  const { box, calls } = fakeGraph([{ id: 'o1', from: MUTED }]);
  const r = await ma.run(deps());
  assert.equal(r.ok, false);
  assert.match(r.reason, /switched off/);
  assert.equal(calls.length, 0);
  assert.equal(box.get('o1').folder, 'INBOX');
  flags.setEnabled('email_muted_archive', true);
});

test('Graph 5xx on the move: no crash, uncertain; next pass reads back and retries', async () => {
  reset();
  let g = fakeGraph([{ id: 'f1', from: MUTED }], { moveStatus: 503 });
  const r1 = await ma.run(deps());
  assert.equal(r1.moved, 0);
  assert.equal(r1.errors.length, 1);
  assert.equal(ext.byKey('mail-archive:f1').status, 'uncertain');
  const box = g.box;
  // Next pass: Graph is back.
  g = fakeGraph([{ id: 'f1', from: MUTED }]);
  const r2 = await ma.run(deps());
  assert.equal(r2.moved, 1);
  assert.ok(g.calls.indexOf('GET /me/messages/f1') < g.calls.indexOf('POST /me/messages/f1/move'), 'read back BEFORE the retry');
  assert.equal(g.box.get('f1').folder, 'ARCH');
  assert.equal(ext.byKey('mail-archive:f1').status, 'confirmed');
  assert.ok(box);
});

test('an inbox read that fails (5xx) skips quietly and retries next pass', async () => {
  reset();
  fakeGraph([{ id: 'i1', from: MUTED }], { inboxStatus: 500 });
  const r = await ma.run(deps());
  assert.equal(r.moved, 0);
  assert.equal(r.errors[0].stage, 'inbox-read');
});

test('not signed in: skipped with a reason, no Graph call', async () => {
  reset();
  const { calls } = fakeGraph([{ id: 'n1', from: MUTED }]);
  const r = await ma.run(deps({ getToken: async () => null }));
  assert.match(r.reason, /not signed in/);
  assert.equal(calls.length, 0);
});

test('read-back mismatch: a 2xx move whose message is still in the Inbox is REPORTED, not counted', async () => {
  reset();
  const { box } = fakeGraph([{ id: 'm1', from: MUTED }], { moveLies: true });
  const r = await ma.run(deps());
  assert.equal(r.moved, 0);
  assert.equal(r.mismatches.length, 1);
  assert.match(r.mismatches[0].why, /not Archive/);
  assert.equal(ext.byKey('mail-archive:m1').status, 'uncertain');
  assert.equal(box.get('m1').isRead, false, 'not marked read when the move did not land');
  assert.equal((ma.archivedCounts()[MUTED] || { archived: 0 }).archived, 0);
  assert.equal(ma.lastPass().mismatches.length, 1);
});

test('a message archived once and moved back by Nick is left in the Inbox', async () => {
  reset();
  const g = fakeGraph([{ id: 'b1', from: MUTED }]);
  await ma.run(deps());
  g.box.get('b1').folder = 'INBOX';
  const r = await ma.run(deps());
  assert.equal(r.movedBackLeft, 1);
  assert.equal(g.box.get('b1').folder, 'INBOX');
});

test('the per-pass cap leaves the rest for next pass', async () => {
  reset();
  const msgs = Array.from({ length: ma.PER_PASS_CAP + 5 }, (_, i) => ({ id: `c${i}`, from: MUTED }));
  const g = fakeGraph(msgs);
  const r = await ma.run(deps());
  assert.equal(r.moved, ma.PER_PASS_CAP);
  assert.equal(r.capped, true);
  const r2 = await ma.run(deps());
  assert.equal(r2.moved, 5);
  assert.equal([...g.box.values()].filter((m) => m.folder === 'INBOX').length, 0);
});

test('inbox queries are chunked and quote-escaped', () => {
  const qs = ma._internals.inboxQueries(Array.from({ length: 23 }, (_, i) => `a${i}@x.example`));
  assert.equal(qs.length, 3);
  assert.equal(ma._internals.odataString("o'neil@x"), "'o''neil@x'");
});
