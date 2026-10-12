'use strict';

// Which Gmail mail reaches NEURO's Gmail tab (12 Oct 2026). Fixtures are the
// shapes measured in Nick's real month: a Zilch payment reminder Gmail did NOT
// mark Important, a LinkedIn job alert, a sign-in code Gmail DID mark Important.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-gmailrule-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'r.db');

const db = require('../db/database');
const gr = require('./gmail-rule');

test.before(async () => { await db.init(); });

const BULK = 'List-Unsubscribe: <https://x.example/u>\r\nList-Id: <news.x.example>\r\n';
const msg = (over = {}) => ({ fromEmail: 'someone@example.com', labels: new Set(), flags: new Set(), headers: '', primary: false, ...over });
const ctx = (over = {}) => ({ keep: [], hide: [], correspondents: new Set(), own: 'me@gmail.com', ...over });

test('a mailing list is not shown unless something explicit or Gmail\'s Important lets it in', () => {
  const alert = msg({ fromEmail: 'jobalerts-noreply@linkedin.com', headers: BULK, primary: false });
  assert.deepEqual(gr.judge(alert, ctx()), { show: false, reason: 'bulk' });
  assert.deepEqual(gr.judge({ ...alert, primary: true }, ctx()), { show: false, reason: 'bulk' }, 'Primary is not enough for a mailing list');
  assert.equal(gr.judge({ ...alert, labels: new Set(['\\Important']) }, ctx()).reason, 'important');
});

test('the rescues Gmail misses: a person you write to, a starred message, an always-show sender, personal Primary mail', () => {
  const zilch = msg({ fromEmail: 'support@payzilch.com', headers: BULK });
  assert.equal(gr.judge(zilch, ctx()).show, false, 'positive control: it would be missed');
  assert.deepEqual(gr.judge(zilch, ctx({ keep: ['@payzilch.com'] })), { show: true, reason: 'keep' });
  assert.deepEqual(gr.judge(zilch, ctx({ keep: ['support@payzilch.com'] })), { show: true, reason: 'keep' });
  assert.equal(gr.judge(zilch, ctx({ keep: ['@zilch.com'] })).show, false, '@domain is the exact domain, not a suffix of it');
  assert.deepEqual(gr.judge(msg({ fromEmail: 'lizzy@example.com' }), ctx({ correspondents: new Set(['lizzy@example.com']) })), { show: true, reason: 'wrote' });
  assert.deepEqual(gr.judge(msg({ flags: new Set(['\\Flagged']), headers: BULK }), ctx()), { show: true, reason: 'starred' });
  assert.deepEqual(gr.judge(msg({ primary: true }), ctx()), { show: true, reason: 'personal' });
  assert.deepEqual(gr.judge(msg({ primary: true, headers: 'Auto-Submitted: auto-generated\r\n' }), ctx()), { show: false, reason: 'not-matched' }, 'a machine in Primary is not personal mail');
  assert.equal(gr.judge(msg({ primary: true, headers: 'Auto-Submitted: no\r\n' }), ctx()).reason, 'personal', '"Auto-Submitted: no" is a person');
});

test('a hidden sender beats every reason, Gmail\'s Important and his own star included; his own mail never shows', () => {
  const code = msg({ fromEmail: 'info@account.netflix.com', labels: new Set(['\\Important']), flags: new Set(['\\Flagged']) });
  assert.equal(gr.judge(code, ctx()).show, true);
  assert.deepEqual(gr.judge(code, ctx({ hide: ['@account.netflix.com'], keep: ['info@account.netflix.com'] })), { show: false, reason: 'hidden' });
  assert.deepEqual(gr.judge(msg({ fromEmail: 'ME@gmail.com', primary: true }), ctx()), { show: false, reason: 'own' });
});

test('sender rules: an address or @domain only, on one list at a time, clearable — stored, never guessed', () => {
  assert.equal(gr.normSender('Support@PayZilch.com '), 'support@payzilch.com');
  assert.equal(gr.normSender('@payzilch.com'), '@payzilch.com');
  for (const bad of ['payzilch', 'payzilch.com', '@', 'a@b', '', null]) assert.equal(gr.normSender(bad), null, String(bad));
  assert.equal(gr.setRule('nonsense', 'keep').ok, false);
  assert.equal(gr.setRule('@x.com', 'maybe').ok, false);
  assert.deepEqual(gr.readRules(), { keep: [], hide: [] }, 'a refused rule writes nothing');
  gr.setRule('@payzilch.com', 'keep');
  gr.setRule('@payzilch.com', 'hide');
  assert.deepEqual(gr.readRules(), { keep: [], hide: ['@payzilch.com'] }, 'moving lists, never on both');
  gr.setRule('@payzilch.com', null);
  assert.deepEqual(gr.readRules(), { keep: [], hide: [] });
});

test('correspondents are cached a day; a missing or old cache is stale', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  assert.equal(gr.correspondentsStale(null, now), true);
  gr.writeCorrespondents(['A@x.com'.toLowerCase(), 'a@x.com', 'b@y.com'], new Date(now - 3600000).toISOString());
  const c = gr.readCorrespondents();
  assert.deepEqual(c.addresses, ['a@x.com', 'b@y.com']);
  assert.equal(gr.correspondentsStale(c, now), false);
  assert.equal(gr.correspondentsStale(c, now + 24 * 3600000), true);
});
