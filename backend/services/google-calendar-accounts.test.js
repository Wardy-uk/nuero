'use strict';

/** More than one Google sign-in (3 Nov 2026): each calendar goes through the account that owns it. */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gacc-')), 'agent.db');
delete process.env.GOOGLE_CALENDAR_CLIENT_ID; delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
delete process.env.GOOGLE_CALENDAR_TARGET; delete process.env.GOOGLE_CALENDAR_EXTRA;
const db = require('../db/database');
const gcal = require('./google-calendar');

const future = new Date(Date.now() + 3600e3).toISOString();

test.before(async () => {
  if (db.init) await db.init();
  db.setState('google_cal_client', JSON.stringify({ clientId: '1-a.apps.googleusercontent.com', clientSecret: 'secretsecret' }));
  db.setState('google_cal_token', JSON.stringify({ refreshToken: 'r-main', accessToken: 'tok-main', expiresAt: future }));
  db.setState('google_cal_accounts', JSON.stringify({ 'ward.nickj@gmail.com': { refreshToken: 'r-nick', accessToken: 'tok-nick', expiresAt: future } }));
});

test('a calendar an added account owns is read with THAT account; the rest with the main one', async () => {
  const seen = [];
  gcal._setFetch(async (url, opts) => {
    const cal = decodeURIComponent(String(url).split('/calendars/')[1].split('/')[0]);
    seen.push([cal, opts.headers.Authorization]);
    return { status: 200, text: async () => JSON.stringify({ items: [] }), json: async () => ({ items: [] }) };
  });
  const r = await gcal.syncNow();
  gcal._setFetch(null);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(Object.fromEntries(seen), {
    'ward.calander@gmail.com': 'Bearer tok-main',
    'ward.nickj@gmail.com': 'Bearer tok-nick',
  });
  assert.strictEqual(gcal.accountFor('WARD.NICKJ@gmail.com'), 'ward.nickj@gmail.com');
  assert.strictEqual(gcal.accountFor('ward.calander@gmail.com'), null);
});

test('status lists added accounts and never a token; removing one sends its calendar back to the main sign-in', () => {
  const st = gcal.status();
  assert.deepStrictEqual(st.accounts.map((a) => a.email), ['ward.nickj@gmail.com']);
  assert.doesNotMatch(JSON.stringify(st), /tok-|r-nick|r-main/);
  assert.ok(gcal.removeAccount('ward.nickj@gmail.com').ok);
  assert.strictEqual(gcal.accountFor('ward.nickj@gmail.com'), null);
  assert.strictEqual(gcal.removeAccount('ward.nickj@gmail.com').ok, false);
});
