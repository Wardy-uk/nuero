'use strict';

/**
 * NOVA asks, NEURO books, Nick taps. The rules that matter:
 *   - a 1-2-1 already in the diary is CONFIRMED to NOVA, never booked twice;
 *   - a booking already waiting for the tap is not prepared again;
 *   - a new booking is PREPARED (never sent) from the date NOVA asked for, and
 *     pushes Nick once — not once per sweep.
 *
 *   run: node --test backend/services/one-to-one-requests.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-121-req-'));
process.env.NEURO_DB_PATH = path.join(root, 'req.db');

// Stub the collaborators BEFORE the service lazily requires them.
const calls = { push: [], book: [], propose: [], pushes: 0, stamp: [] };
let diary = null;      // findOneToOne answer
let live = [];         // prepared-actions.listLive answer
function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('./one-to-one-detect', { getIndex: () => ({ people: [{ name: 'Luke Scaife', bookable: true }, { name: 'Off Cadence', bookable: false }] }) });
stub('./one-to-one-booking', {
  findOneToOne: async () => diary || { ok: false },
  propose: async (name, opts) => { calls.propose.push(opts); return { ok: true, person: name, start: '2026-10-20T14:00:00', end: '2026-10-20T14:30:00', subject: '1-2-1 — Nick / Luke', durationMinutes: 30, attendee: { email: 'luke@example.test' } }; },
  book: async (args) => { calls.book.push(args); return { ok: true, prepared: true, already: false, actionId: 'pa-1' }; },
});
stub('./nova-121-sync', { pushBooking: async (...a) => { calls.push.push(a); return { ok: true }; } });
stub('./prepared-actions', { listLive: () => live });
stub('./webpush', { sendToAll: async () => { calls.pushes++; } });
stub('./obsidian', { updatePersonNote: (n, f) => calls.stamp.push([n, f]) });

const req = require('./one-to-one-requests');
const tick = () => new Promise((r) => setImmediate(r));
test.before(async () => { await require('../db/database').init(); });

test('a 1-2-1 already in the diary is confirmed to NOVA, not booked again', async () => {
  diary = { ok: true, addressable: true, event: { id: 'evt-9', start: '2099-10-16T10:00:00' } };
  const r = await req.handleRequest({ agentName: 'Luke Scaife', date: '2099-10-15', sessionId: 7 });
  assert.equal(r.action, 'already-in-diary');
  assert.deepEqual(calls.push.at(-1), ['Luke Scaife', '2099-10-16', { outlookEventId: 'evt-9' }]);
  assert.equal(calls.book.length, 0);
  diary = null;
});

test('a booking waiting for the tap is not prepared again', async () => {
  live = [{ actionType: 'create_calendar_event', origin: '1to1-book', status: 'prepared', target: { person: 'Luke Scaife' }, actionId: 'pa-0', draft: { start: '2099-10-20T14:00:00' } }];
  const r = await req.handleRequest({ agentName: 'Luke Scaife', date: '2099-10-15', sessionId: 7 });
  assert.equal(r.action, 'already-prepared');
  assert.equal(calls.book.length, 0);
  live = [];
});

test('a new request PREPARES from the date NOVA asked for and pushes once', async () => {
  const r = await req.handleRequest({ agentName: 'Luke Scaife', date: '2099-10-15', sessionId: 8 });
  await tick();
  assert.equal(r.action, 'prepared');
  assert.equal(calls.propose.at(-1).notBefore, '2099-10-15');
  assert.equal(calls.book.length, 1);
  assert.equal(calls.pushes, 1);
  // The sweep asking again for the same session (book() folds to the same action) does not re-push.
  await req.handleRequest({ agentName: 'Luke Scaife', date: '2099-10-15', sessionId: 8 });
  await tick();
  assert.equal(calls.pushes, 1);
});

test('an agent off cadence or unknown is never booked', async () => {
  const before = calls.book.length;
  assert.equal((await req.handleRequest({ agentName: 'Off Cadence' })).action, 'off-cadence');
  assert.equal((await req.handleRequest({ agentName: 'Nobody Here' })).unknownAgent, true);
  assert.equal(calls.book.length, before);
});

test('pendingBookingFor ignores a sent booking whose date has passed', () => {
  const sent = { actionType: 'create_calendar_event', origin: '1to1-book', status: 'executed', target: { person: 'X' }, draft: { start: '2026-09-01T10:00:00' } };
  assert.equal(req.pendingBookingFor([sent], 'X', '2026-10-14'), null);
  assert.equal(req.pendingBookingFor([{ ...sent, draft: { start: '2026-10-20T10:00:00' } }], 'X', '2026-10-14') !== null, true);
});
