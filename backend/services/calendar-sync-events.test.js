'use strict';

/**
 * Calendar sync, the first source wired into the nervous system.
 *
 * Two halves, and the first matters more: (1) the sync behaves EXACTLY as it
 * did — same return values, same cache, same "leave a good cache alone on an
 * empty answer" — and (2) each run now leaves started / succeeded|failed and a
 * window observation in the event log.
 *
 * Nothing had ever tested `calendar-sync.sync()` itself, so (1) pins its
 * behaviour for the first time rather than comparing against an old test.
 * Graph and the hooks hanging off a sync are stubbed; the database is real.
 *
 *   run: node --test backend/services/calendar-sync-events.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-calsync-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'cs.db');

// ── stubs, installed before calendar-sync can require the real modules ──────
let graph = { events: [], throws: null };
const calls = { triage: [], plaud: 0 };
function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('./microsoft', {
  fetchCalendarEvents: async () => { if (graph.throws) throw graph.throws; return graph.events; },
  getSignedInAddress: async () => 'nick@nurtur.tech',
});
stub('./plaud-admin-blocks', {
  attendeesOther: (event, me) => (event.attendees || []).filter(a => a !== me),
  syncHook: async () => { calls.plaud++; },
});
stub('./meeting-triage', { checkEvents: async (ids) => { calls.triage.push(ids); } });
stub('./working-memory', { invalidate: () => {} });

const db = require('../db/database');
const bus = require('./event-bus');
const sh = require('./source-health');
const calendarSync = require('./calendar-sync');

test.before(async () => { await db.init(); });

const day = (offset, hh) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd}T${hh}:00:00`;
};
const meeting = (id, offset, subject, attendees = ['nick@nurtur.tech', 'chris@nurtur.tech']) => ({
  id, subject, start: day(offset, '10'), end: day(offset, '11'), isAllDay: false,
  showAs: 'busy', organizer: 'chris@nurtur.tech', attendees,
});

const eventsOfType = (type) => db.all('SELECT * FROM event_log WHERE type = ? ORDER BY seq', [type]);
const graphRows = () => db.all(`SELECT * FROM calendar_cache WHERE source = 'graph' ORDER BY event_id`);

test('11a. a first sync caches the window, treats it as a cold-start baseline, and returns what it always did', async () => {
  graph = { events: [meeting('m1', 1, 'Standup'), meeting('m2', 2, 'Focus', ['nick@nurtur.tech'])], throws: null };
  const res = await calendarSync.sync({ days: 14 });
  assert.equal(res.synced, 2);
  assert.equal(res.coldStart, true);
  assert.deepEqual(res.newEventIds, []);
  assert.ok(res.from && res.to);
  assert.deepEqual(graphRows().map(r => r.event_id), ['m1', 'm2']);
  assert.equal(graphRows().find(r => r.event_id === 'm2').attendees_other, 0, 'solo block still judged as before');
  assert.equal(calls.plaud, 1, 'the Plaud hook still runs on every sync');
  assert.deepEqual(calls.triage, [], 'no arrival check on a cold start');
});

test('a successful run publishes started → window_synced → succeeded, as one correlated story', async () => {
  const started = eventsOfType('source.sync.started');
  const obs = eventsOfType('observation.calendar.window_synced');
  const ok = eventsOfType('source.sync.succeeded');
  assert.equal(started.length, 1);
  assert.equal(obs.length, 1);
  assert.equal(ok.length, 1);
  const s = bus.getEvent(started[0].seq);
  const o = bus.getEvent(obs[0].seq);
  const done = bus.getEvent(ok[0].seq);
  assert.ok(s.seq < o.seq && o.seq < done.seq);
  assert.equal(o.correlationId, s.correlationId);
  assert.equal(done.correlationId, s.correlationId);
  assert.equal(o.causationId, s.eventId);
  assert.equal(done.causationId, s.eventId);
  assert.equal(s.payload.sourceId, 'microsoft.calendar');
  assert.equal(s.payload.staleAfterMs, 60 * 60 * 1000);
  assert.equal(o.payload.count, 2);
  assert.match(o.payload.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(o.payload), /Standup/, 'meeting titles stay out of an unpruned log');
  assert.deepEqual(done.payload.detail, { synced: 2, from: o.payload.window.from, to: o.payload.window.to, newCount: 0, coldStart: true });
  await bus.pumpConsumer(sh.CONSUMER);
  const h = sh.getSource('microsoft.calendar');
  assert.equal(h.state, 'healthy');
  assert.equal(h.freshness, 'fresh');
});

test('⚠ an UNCHANGED diary re-synced is a new run but NOT a new observation — the log records change', async () => {
  const res = await calendarSync.sync({ days: 14 });
  assert.equal(res.synced, 2);
  assert.equal(res.coldStart, false);
  assert.deepEqual(res.newEventIds, []);
  assert.equal(eventsOfType('source.sync.succeeded').length, 2, 'each run is its own attempt');
  assert.equal(eventsOfType('observation.calendar.window_synced').length, 1, 'same window, same content: folded');
});

test('11b. a changed diary reports the new arrival exactly as before, and is a new observation', async () => {
  graph.events = [...graph.events, meeting('m3', 3, 'New invite')];
  const res = await calendarSync.sync({ days: 14 });
  assert.equal(res.synced, 3);
  assert.deepEqual(res.newEventIds, ['m3']);
  assert.deepEqual(calls.triage[calls.triage.length - 1], ['m3'], 'the arrival check still fires on a new invite');
  assert.equal(eventsOfType('observation.calendar.window_synced').length, 2);
});

test('11c. an EMPTY answer leaves the cache alone, as before — and is recorded as an ambiguous failure', async () => {
  graph.events = [];
  const res = await calendarSync.sync({ days: 14 });
  assert.equal(res.synced, 0);
  assert.equal(res.reason, 'empty response');
  assert.equal(graphRows().length, 3, 'a stale calendar beats an empty one');
  const fails = eventsOfType('source.sync.failed');
  const f = bus.getEvent(fails[fails.length - 1].seq);
  assert.equal(f.payload.reason, 'empty-response');
  assert.equal(f.payload.ambiguous, true);
  await bus.pumpConsumer(sh.CONSUMER);
  const h = sh.getSource('microsoft.calendar');
  assert.equal(h.state, 'failing');
  assert.equal(h.freshness, 'fresh', 'the cache it holds is still recent');
  assert.equal(h.failure.ambiguous, true);
});

test('11d. a Graph exception returns what it always did and is recorded as a failure', async () => {
  graph = { events: [], throws: new Error('Graph 503') };
  const res = await calendarSync.sync({ days: 14 });
  assert.deepEqual(res, { synced: 0, reason: 'Graph 503' });
  const fails = eventsOfType('source.sync.failed');
  assert.equal(bus.getEvent(fails[fails.length - 1].seq).payload.error, 'Graph 503');
  assert.equal(graphRows().length, 3);
});

test('11e. a non-array answer returns what it always did and is recorded as a failure', async () => {
  graph = { events: null, throws: null };
  const res = await calendarSync.sync({ days: 14 });
  assert.deepEqual(res, { synced: 0, reason: 'no events returned' });
  const fails = eventsOfType('source.sync.failed');
  assert.equal(bus.getEvent(fails[fails.length - 1].seq).payload.reason, 'no-events');
});

test('⚠ the sync still works when the event layer is BROKEN — it is additive, never load-bearing', async () => {
  db.run('CREATE TRIGGER sabotage BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, \'spine down\'); END;');
  try {
    const before = db.get('SELECT COUNT(*) AS n FROM event_log').n;
    graph = { events: [meeting('m9', 1, 'Survives')], throws: null };
    const res = await calendarSync.sync({ days: 14 });
    assert.equal(res.synced, 1);
    assert.deepEqual(graphRows().map(r => r.event_id), ['m9']);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM event_log').n, before, 'nothing could be published, and that cost the calendar nothing');
  } finally {
    db.run('DROP TRIGGER sabotage');
  }
});

test('the calendar source goes stale an hour after its last success, and is told by an event', async () => {
  await bus.pumpConsumer(sh.CONSUMER);
  const h = sh.getSource('microsoft.calendar');
  const marked = await sh.checkStaleness({ now: Date.parse(h.lastSuccessAt) + 61 * 60 * 1000 });
  assert.deepEqual(marked, ['microsoft.calendar']);
  assert.equal(sh.getSource('microsoft.calendar').freshness, 'stale');
});
