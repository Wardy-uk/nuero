'use strict';

/**
 * Change-keyed producer events (Build 5B).
 *
 *   run: node --test backend/services/change-key.test.js
 *
 * Driven through the REAL producers (world-sources, obligation-sources) into
 * the REAL projector, because the bug was never in a helper: a state-keyed
 * producer folded a move back into the first event and the projection was left
 * showing the slot the meeting had left.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-ck-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'ck.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
fs.mkdirSync(path.join(VAULT, 'People'), { recursive: true });

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const ck = require('./change-key');

test.before(async () => { await db.init(); });

let clock = Date.parse('2026-10-05T08:00:00Z');
const tick = () => { clock += 60000; return clock; };
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
const countType = (type, subjectId) => db.get('SELECT COUNT(*) n FROM event_log WHERE type = ? AND subject_id = ?', [type, subjectId]).n;

const WINDOW = { fromLocal: '2026-10-05T00:00', toLocal: '2026-10-06T23:59' };
function meet(start, extra = {}) {
  return { id: 'EVT1', subject: 'Tech Leadership', start: `2026-10-05T${start}:00`, end: `2026-10-05T${start.slice(0, 2)}:59:00`,
    showAs: 'busy', attendeesOther: true, attendees: [{ name: 'Chris Middleton', email: 'chris@x.test', status: 'accepted' }], ...extra };
}
const syncCal = (events) => ws.publishCalendarWindow({ provider: 'graph', events, window: WINDOW, now: tick() });
const startOf = () => db.get(`SELECT start_local FROM wm_meetings WHERE meeting_id = 'graph:EVT1'`).start_local;

test('7–10: a meeting moved A→B is one change, B→A a second, a retry of B→A folds, and replay reproduces both', async () => {
  syncCal([meet('09:00')]); pump();
  assert.equal(startOf(), '2026-10-05T09:00');

  const ab = syncCal([meet('10:00')]); pump();             // 7. A→B
  assert.equal(ab.changed, 1);
  assert.equal(startOf(), '2026-10-05T10:00');

  const ba = syncCal([meet('09:00')]); pump();             // 8. B→A, a distinct event
  assert.equal(ba.changed, 1, 'the move back must be published, not folded into the first A');
  assert.equal(startOf(), '2026-10-05T09:00', 'the projection follows the move back');
  assert.equal(countType('observation.calendar.event_observed', 'graph:EVT1'), 3);

  const retry = syncCal([meet('09:00')]); pump();          // 9. retry of B→A
  assert.equal(retry.changed, 0);
  assert.equal(countType('observation.calendar.event_observed', 'graph:EVT1'), 3, 'an unchanged re-poll adds no event at all');

  // The same transition computed twice (a lagging second producer) folds on its key.
  const held = ck.latest('calendar-entry', 'graph:EVT1', ['observation.calendar.event_observed']);
  const p = ws.calendarPayload('graph', meet('09:00'));
  const again = bus.publishEvent({ type: 'observation.calendar.event_observed', occurredAt: new Date(tick()).toISOString(),
    source: { system: 'microsoft-graph', recordId: 'EVT1' }, subject: { entityType: 'calendar-entry', entityId: 'graph:EVT1' },
    idempotencyKey: db.get('SELECT idempotency_key k FROM event_log WHERE event_id = ?', [held.eventId]).k, payload: p });
  assert.equal(again.duplicate, true);

  // 10. replay: a rebuild from the log alone passes through 09→10→09 and ends at 09.
  db.run(`UPDATE wm_meetings SET start_local = 'corrupted' WHERE meeting_id = 'graph:EVT1'`);
  const r = await bus.replayConsumer(wm.CONSUMER, { now: Date.now() });
  assert.equal(r.deadLettered, 0);
  assert.equal(startOf(), '2026-10-05T09:00', 'replay ends where the live fold ended');
});

test('depth two: A→B→A→B ends at B (the Build 4 held-fingerprint key folded the second A→B)', () => {
  const ev = (s) => ({ ...meet(s), id: 'EVT2' });
  const start2 = () => db.get(`SELECT start_local FROM wm_meetings WHERE meeting_id = 'graph:EVT2'`).start_local;
  for (const s of ['11:00', '12:00', '11:00', '12:00']) { syncCal([meet('09:00'), ev(s)]); pump(); }
  assert.equal(start2(), '2026-10-05T12:00');
  assert.equal(countType('observation.calendar.event_observed', 'graph:EVT2'), 4);
});

test('removal: one per presence — gone, back, gone again is two removals', () => {
  const ev = { ...meet('14:00'), id: 'EVT3' };
  const status = () => db.get(`SELECT status FROM wm_meetings WHERE meeting_id = 'graph:EVT3'`).status;
  syncCal([meet('09:00'), ev]); pump();
  syncCal([meet('09:00')]); pump();
  assert.equal(status(), 'removed');
  syncCal([meet('09:00')]); pump();                       // re-poll while gone: nothing new
  assert.equal(countType('observation.calendar.event_removed', 'graph:EVT3'), 1);
  syncCal([meet('09:00'), ev]); pump();                    // back, same content as before
  assert.equal(status(), 'scheduled', 'reappearing with its old content is a new presence, not a fold into the first');
  syncCal([meet('09:00')]); pump();
  assert.equal(status(), 'removed');
  assert.equal(countType('observation.calendar.event_removed', 'graph:EVT3'), 2);
});

test('person: an address added and removed again is two facts; the projection ends without it', () => {
  const note = path.join(VAULT, 'People', 'Alex Carr.md');
  const write = (email) => fs.writeFileSync(note, `---\ntype: person\nrole: Engineer\n${email ? `email: ${email}\n` : ''}---\n`);
  const bound = () => db.get(`SELECT person_id FROM wm_person_identities WHERE value = 'alexc@x.test'`);
  write(null); ws.publishPeople({ now: tick() }); pump();
  write('alexc@x.test'); ws.publishPeople({ now: tick() }); pump();
  assert.ok(bound());
  write(null); ws.publishPeople({ now: tick() }); pump();
  assert.ok(!bound(), 'the removal of the address must reach the projection');
  write('alexc@x.test'); ws.publishPeople({ now: tick() }); pump();
  assert.ok(bound(), 'and adding it back is a fourth fact, not a fold into the second');
  assert.equal(countType('observation.person.declared', 'person:alex-carr'), 4);
  const unchanged = ws.publishPeople({ now: tick() });
  assert.equal(unchanged.changed, 0);
});

test('tasks (Build 4 producer): open→done→open→done ends done', () => {
  db.run(`INSERT INTO tasks (id, text, status, source, dedupe_key, created_at) VALUES (9001, 'Send the figures', 'open', 'manual', 'k9001', '2026-09-21 10:00:00')`);
  const set = (s) => db.run('UPDATE tasks SET status = ? WHERE id = 9001', [s]);
  const status = () => db.get(`SELECT status FROM wm_tasks WHERE task_id = 'task:neuro:9001'`).status;
  for (const s of ['open', 'done', 'open', 'done']) { set(s); src.publishNeuroTasks({ now: tick() }); pump(); }
  assert.equal(status(), 'completed');
  assert.equal(countType('observation.task.observed', 'neuro:9001'), 4);
});
