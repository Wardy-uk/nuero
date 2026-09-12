'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-push-'));
process.env.NEURO_DB_PATH = path.join(root, 'push.db');
process.env.PUSH_QUIET_HOURS = 'off'; // tested explicitly below
process.env.PUSH_HOURLY_CAP = '3';

const db = require('../db/database');
const webpush = require('./webpush');

test.before(async () => { await db.init(); });

test.beforeEach(() => { db.setState('push_governor', '{}'); });

test('the hourly cap holds back ordinary notifications', () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(webpush._governor(`Nudge ${i}`, 'body', { type: 'todo' }).allowed, true);
  }
  const blocked = webpush._governor('Nudge 4', 'body', { type: 'todo' });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /hourly cap/);
});

test('critical alerts ignore the cap — an escalation is never rate-limited away', () => {
  for (let i = 0; i < 5; i++) webpush._governor(`Nudge ${i}`, 'body', { type: 'todo' });
  const critical = webpush._governor('New escalation', 'NT-123: something broke', { type: 'escalation_alert' });
  assert.equal(critical.allowed, true);
});

test('the same notification twice inside the window only fires once', () => {
  const first = webpush._governor('New escalation', 'NT-123: broke', { type: 'escalation_alert' });
  const second = webpush._governor('New escalation', 'NT-123: broke', { type: 'escalation_alert' });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.match(second.reason, /duplicate/);
});

test('quiet hours silence ordinary notifications but not critical ones', () => {
  // 22:00-07:00 with the clock forced into the small hours.
  process.env.PUSH_QUIET_HOURS = '22:00-07:00';
  const RealDate = Date;
  const at = (hour) => class extends RealDate {
    constructor(...args) {
      if (args.length) return new RealDate(...args);
      super(2026, 7, 14, hour, 30, 0);
    }
  };

  try {
    global.Date = at(3);
    assert.equal(webpush._isQuietNow(), true);
    assert.equal(webpush._governor('Todo nag', 'body', { type: 'todo' }).allowed, false);
    assert.equal(webpush._governor('Meeting', 'starts in 10', { type: 'meeting_alert' }).allowed, true);

    global.Date = at(14);
    assert.equal(webpush._isQuietNow(), false);
    assert.equal(webpush._governor('Todo nag', 'body', { type: 'todo' }).allowed, true);
  } finally {
    global.Date = RealDate;
    process.env.PUSH_QUIET_HOURS = 'off';
  }
});

test('governor state survives a restart — the budget is not reset by a redeploy', () => {
  for (let i = 0; i < 3; i++) webpush._governor(`Nudge ${i}`, 'body', { type: 'todo' });

  // Simulate a restart: drop the module cache and reload against the same DB.
  delete require.cache[require.resolve('./webpush')];
  const reloaded = require('./webpush');

  const afterRestart = reloaded._governor('Nudge 4', 'body', { type: 'todo' });
  assert.equal(afterRestart.allowed, false, 'a restart must not hand back a fresh quota');
});

// ── The VAPID contact is the CONFIGURED one ─────────────────────────────────
//
// ⚠ `VAPID_SUBJECT` was set in the Pi's .env and read by nothing: the subject was
// hardcoded to a different address from the configured one. Nothing broke, since
// no push service verifies it — which is exactly why it could be wrong for
// months. RFC 8292's `sub` is how a push service reaches the sender when their
// traffic causes a problem, so it is the one field whose only job is to be
// reachable.
//
// Source scan with a positive control, because the value is only observable
// inside `webpush.setVapidDetails` at init.

test('the VAPID subject comes from the environment, not a literal', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'webpush.js'), 'utf8');

  const call = src.match(/setVapidDetails\(([\s\S]*?)\)/);
  assert.ok(call, 'positive control: setVapidDetails must be findable');

  assert.match(call[1], /process\.env\.VAPID_SUBJECT/,
    'the subject is hardcoded again — the configured VAPID_SUBJECT does nothing');
});

test('and the fallback is not an email address in a public repo', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'webpush.js'), 'utf8');
  const call = src.match(/setVapidDetails\(([\s\S]*?)\)/)[1];

  // ⚠ This repo is public — that is how the PIN leaked in July. An `https:`
  // origin satisfies RFC 8292 just as well as a mailto: and leaks nothing.
  assert.doesNotMatch(call, /mailto:/,
    'a mailto: fallback puts a real address in a public repo');
  assert.doesNotMatch(call, /nurtur/,
    'the employer domain is back in the VAPID subject');
});

// ── A probe must be repeatable ──────────────────────────────────────────────
//
// ⚠ THE TEST BUTTON WAS SINGLE-USE. `_attentionFor` gives every push an
// attention record; a `test` push always carries the same title, so it always
// resolved to the same record, and its `notify_signature` (`critical|1`) could
// never change — so `shouldNotify` answered "already notified, nothing changed"
// for ever. The live push_log shows it exactly: sent 28 Aug, sent 10 Sep, and
// refused on every attempt after. It only became visible when the route started
// reporting its outcome truthfully on 11 Sep instead of an unconditional ok.
//
// Source scans, because the gates run inside `sendToAll` against a real
// subscription list and a database, and what must hold is the SHAPE of the
// exemption rather than one outcome.

test('a probe skips the attention gate', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'webpush.js'), 'utf8');

  assert.match(src, /const PROBE_TYPES = new Set\(\[\s*'test'\s*\]\)/,
    'PROBE_TYPES no longer names test');
  assert.match(src, /if \(!PROBE_TYPES\.has\(data\?\.type\)\) \{[\s\S]*_attentionFor/,
    'the attention gate no longer exempts a probe — the test button is single-use again');
});

test('a probe skips the 30-minute dedupe too', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'webpush.js'), 'utf8');
  // Without this the fix stops at a 30-minute wall one gate along.
  assert.match(src, /if \(!PROBE_TYPES\.has\(type\) && state\.recent\[fp\]\)/,
    'the dedupe no longer exempts a probe');
});

test('PROBE_TYPES is NOT a second ALWAYS_DELIVER — real work stays gated', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'webpush.js'), 'utf8');
  const probes = src.match(/const PROBE_TYPES = new Set\(\[([^\]]*)\]\)/)[1];

  // ⚠ The dangerous regression is someone "tidying" these two sets together.
  // ALWAYS_DELIVER means "must arrive even in quiet hours" and is full of real
  // work; an escalation that skipped the attention gate would notify on every
  // pass, which is the countdown-spam bug that gate was built to stop.
  for (const real of ['escalation_alert', 'meeting_alert', 'meeting_prep',
                      'system_alert', 'capture_failed', 'weekly_risk']) {
    assert.ok(!probes.includes(real),
      `${real} is in PROBE_TYPES — real work must never skip the attention gate`);
  }
});

// ── It must actually RUN, all the way to the payload ──────────────────
//
// ⚠ THE SOURCE SCANS PASSED OVER A REFERENCE ERROR. Exempting a probe from gate 1
// meant wrapping that block in an `if`, which scoped `const record` to it — and
// `_enrichData(data, record)` reads it much further down. The first REAL send
// answered `{"error":"record is not defined"}` with 3,124 tests green, because
// every one of them checked the SHAPE of the code rather than running it.
//
// ⚠ IT TOOK THREE GOES TO WRITE A TEST THAT CATCHES IT, and each failure is worth
// knowing, because all three were GREEN and useless:
//   1. No subscriptions — `sendToAll` returns at `no subscriptions`, which is
//      BEFORE the send loop where `_enrichData` lives.
//   2. A fake subscription — still returns at the very first check, because
//      `isConfigured()` is false in a test env: no VAPID keys.
//   3. This one: a REAL keypair from `generateVAPIDKeys()` plus a subscription
//      pointing at an unroutable host. Nothing is delivered and nothing needs to
//      be; the request fails at DNS and is handled. The point is that execution
//      reaches the payload, which is the only place the bug lived.
//
// The general lesson: a scan proves shape, `node --check` proves syntax, and
// NEITHER can see a scope error. One executing test is worth more here than any
// number of the other two.

test('sendToAll reaches the payload on both paths', async () => {
  const realWebPush = require('web-push');
  const keys = realWebPush.generateVAPIDKeys();
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  webpush.init();

  db.setState('push_governor', '{}');
  const endpoint = 'https://example.invalid/push/whatever';
  db.savePushSubscription({ endpoint, keys: { p256dh: keys.publicKey, auth: 'aaaaaaaaaaaaaaaaaaaaaa' } });

  try {
    await assert.doesNotReject(
      () => webpush.sendToAll('Test from NEURO', 'probe body', { type: 'test' }),
      'the PROBE path threw — this is exactly where `record is not defined` lived',
    );
    await assert.doesNotReject(
      () => webpush.sendToAll('An ordinary nudge', 'body', { type: 'todo' }),
      'the attention-gated path threw',
    );
  } finally {
    db.removePushSubscription(endpoint);
    if (prevPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = prevPriv;
  }
});
