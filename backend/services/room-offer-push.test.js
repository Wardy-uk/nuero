'use strict';

/**
 * The cold-room push (17 Oct 2026): once per VISIT, through every existing
 * veto, never on the 40-minute ambient pass. Real scratch DB for the ledger;
 * the room snapshot and the moment are injected, the sender is stubbed at
 * `webpush.sendToAll` (the governor and lifecycle behind it are not under test).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-room-push-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const push = require('./ambient-push');
const webpush = require('./webpush');

let sent = [];
webpush.sendToAll = async (title, body, data) => { sent.push({ title, body, data }); };

const NOW = new Date('2026-10-17T18:00:00Z');
const OFFER = { kind: 'warm-room', key: 'room:living-room:warm-room#living-room@1', say: 'The living room is 16.0°C. Warm it to 20°C until you leave?' };
const snap = (offers = [OFFER]) => async () => ({ known: true, offers });
const moment = (over = {}) => async () => ({ moment: push.momentFrom({
  context: { confidence: { level: 'high' }, activity: 'steady', quiet: false, duty: { onDuty: false } },
  phone: { activity: 'Still', focusMode: false }, desktop: null, now: NOW, ...over,
}) });

test.before(async () => { await db.init(); });
function reset() { sent = []; db.setState(push.ROOM_PUSH_KEY, ''); }

test('⚠ a cold room is pushed ONCE per visit', async () => {
  reset();
  const first = await push.deliverRoomOffer({ now: NOW, snapshotFn: snap(), readMomentFn: moment() });
  assert.equal(first.sent, 1);
  assert.equal(sent[0].body, OFFER.say, 'the push says exactly what accepting does');
  assert.equal(sent[0].data.key, 'ambient:warm-room:' + OFFER.key, 'identity is the visit-scoped offer key');
  const again = await push.deliverRoomOffer({ now: new Date(NOW.getTime() + 60000), snapshotFn: snap(), readMomentFn: moment() });
  assert.equal(again.sent, 0);
  assert.equal(sent.length, 1, 'same visit — never twice');
  const nextVisit = { ...OFFER, key: 'room:living-room:warm-room#living-room@2' };
  const next = await push.deliverRoomOffer({ now: new Date(NOW.getTime() + 3600000), snapshotFn: snap([nextVisit]), readMomentFn: moment() });
  assert.equal(next.sent, 1, 'a new visit is a fair question again');
});

test('⚠ every existing veto applies: in a meeting nothing is sent, and it is re-judged later, not every minute', async () => {
  reset();
  const ctx = { context: { confidence: { level: 'high' }, activity: 'in-meeting', quiet: true, duty: { onDuty: true } } };
  const r = await push.deliverRoomOffer({ now: NOW, snapshotFn: snap(), readMomentFn: moment(ctx) });
  assert.equal(r.sent, 0);
  assert.match(r.why, /meeting/);
  let reads = 0;
  const counting = async (a) => { reads++; return moment()(a); };
  await push.deliverRoomOffer({ now: new Date(NOW.getTime() + 5 * 60000), snapshotFn: snap(), readMomentFn: counting });
  assert.equal(reads, 0, 'judged 5 min ago — not read again yet');
  const later = await push.deliverRoomOffer({ now: new Date(NOW.getTime() + 11 * 60000), snapshotFn: snap(), readMomentFn: counting });
  assert.equal(reads, 1);
  assert.equal(later.sent, 1, 'the meeting is over — asked once now');
});

test('Focus mode and driving veto it; an unconfident read never pushes', async () => {
  reset();
  assert.equal((await push.deliverRoomOffer({ now: NOW, snapshotFn: snap(), readMomentFn: moment({ phone: { activity: 'Still', focusMode: true } }) })).sent, 0);
  reset();
  assert.equal((await push.deliverRoomOffer({ now: NOW, snapshotFn: snap(), readMomentFn: moment({ phone: { activity: 'Automotive' } }) })).sent, 0);
  reset();
  assert.equal((await push.deliverRoomOffer({ now: NOW, snapshotFn: snap(), readMomentFn: moment({ context: { confidence: { level: 'low' } } }) })).sent, 0);
  assert.equal(sent.length, 0);
});

test('no heating offer (lights only, already warming, unreadable house) → nothing read, nothing sent', async () => {
  reset();
  let reads = 0;
  const counting = async (a) => { reads++; return moment()(a); };
  await push.deliverRoomOffer({ now: NOW, snapshotFn: snap([{ kind: 'lights-on', key: 'room:x:lights-on#1', say: 'Want the lights on?' }]), readMomentFn: counting });
  await push.deliverRoomOffer({ now: NOW, snapshotFn: async () => ({ known: false, offers: [] }), readMomentFn: counting });
  assert.equal(reads, 0);
  assert.equal(sent.length, 0);
});

test('the 40-minute ambient pass never offers a room (deliver() has no room observation)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'ambient-push.js'), 'utf8');
  const deliverBody = src.slice(src.indexOf('async function deliver('), src.indexOf('// ── The cold-room push'));
  assert.ok(deliverBody.includes('worthInterrupting'), 'positive control: the scan reads deliver()');
  assert.equal(deliverBody.includes("require('./rooms')"), false, 'no room snapshot on the ambient pass');
  assert.equal(deliverBody.includes('warm-room'), false);
});
