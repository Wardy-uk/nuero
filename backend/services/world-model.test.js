'use strict';

/**
 * The world model (Build 3C) — Person and Meeting, from the event log.
 *
 *   run: node --test backend/services/world-model.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-world-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'wm.db');
process.env.NEURO_TIMEZONE = 'Europe/London';

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');

test.before(async () => { await db.init(); });

const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
// 2026-10-20 09:30 UTC = 10:30 in London (BST).
const NOW = Date.parse('2026-10-20T09:30:00Z');

function declare(name, fm) {
  const p = ws.personPayload(name, `People/${name}.md`, fm);
  return bus.publishEvent({
    type: 'observation.person.declared', occurredAt: new Date(NOW).toISOString(), source: { system: 'vault' },
    subject: { entityType: 'person', entityId: p.personId },
    idempotencyKey: `person-declared:${p.personId}:${p.fingerprint}`, payload: p,
  });
}

const graphEvent = (id, extra = {}) => ({
  id, subject: 'Tech Leadership', start: '2026-10-20T10:00:00.0000000', end: '2026-10-20T11:00:00.0000000',
  isAllDay: false, showAs: 'busy', responseStatus: 'accepted', isOrganizer: false,
  organizer: 'Chris Middleton', organizerEmail: 'Chris.Middleton@nurtur.tech',
  attendees: [
    { name: 'Naomi Wentworth', email: 'NAOMI.wentworth@nurtur.tech', status: 'accepted' },
    { name: 'Somebody External', email: 'someone@customer.example', status: 'none' },
  ],
  attendeesOther: true, seriesMasterId: 'series-tl', type: 'occurrence', ...extra,
});

const window = { fromLocal: '2026-10-20T00:00', toLocal: '2026-11-03T23:59' };

// ── people ──────────────────────────────────────────────────────────────────

test('frontmatter: block lists, CRLF and wikilinks read correctly; nothing is inferred', () => {
  const fm = ws.parseFrontmatter(['---', 'type: person', 'aliases:', '  - Naomi', '  - Naomi Winkworth',
    'email: naomi.wentworth@nurtur.tech', 'direct-report: true', 'manager: "[[People/Nick Ward|Nick Ward]]"', '---', 'body'].join('\r\n'));
  assert.deepEqual(fm.aliases, ['Naomi', 'Naomi Winkworth']);
  const p = ws.personPayload('Naomi Wentworth', 'People/Naomi Wentworth.md', fm);
  assert.equal(p.personId, 'person:naomi-wentworth');
  assert.deepEqual(p.emails, ['naomi.wentworth@nurtur.tech']);
  assert.equal(p.directReport, true);
  assert.equal(p.manager, 'Nick Ward');
  assert.equal(p.role, null, 'an unstated role stays absent');
  const q = ws.personPayload('Ricky', 'People/Ricky.md', {});
  assert.equal(q.directReport, null, 'an unstated relationship is null, never false');
});

test('a declared person owns their address by EXACT, case-insensitive match', async () => {
  declare('Naomi Wentworth', { email: 'naomi.wentworth@nurtur.tech', team: 'Support', 'direct-report': 'true' });
  await pump();
  const p = wm.personByEmail('Naomi.Wentworth@NURTUR.tech');
  assert.equal(p.personId, 'person:naomi-wentworth');
  assert.equal(p.provenance.kind, 'fact');
  assert.equal(wm.personByEmail('naomi@nurtur.tech'), null, 'no fuzzy match on a near address');
});

test('a meeting maps attendees to declared people and leaves unknown addresses UNKNOWN', async () => {
  ws.publishCalendarWindow({ provider: 'graph', events: [graphEvent('g1')], window, now: NOW });
  await pump();
  const [m] = wm.currentMeetings({ now: NOW });
  assert.equal(m.meetingId, 'graph:g1');
  assert.equal(m.start, '2026-10-20T10:00');
  assert.equal(m.kind, 'meeting');
  const naomi = m.participants.find((x) => x.email === 'naomi.wentworth@nurtur.tech');
  assert.equal(naomi.personId, 'person:naomi-wentworth');
  assert.equal(naomi.linkMethod, 'exact-email');
  const ext = m.participants.find((x) => x.email === 'someone@customer.example');
  assert.equal(ext.personId, null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM wm_people').n, 1, 'no person invented for an unknown address');
  assert.ok(m.provenance.evidence.length >= 1);
  assert.ok(m.freshness, 'freshness travels with the answer');
});

test('a person declared AFTER the meeting links its participant rows, and the log says so', async () => {
  declare('Chris Middleton', { email: 'chris.middleton@nurtur.tech' });
  await pump();
  const [m] = wm.currentMeetings({ now: NOW });
  const chris = m.participants.find((x) => x.email === 'chris.middleton@nurtur.tech');
  assert.equal(chris.personId, 'person:chris-middleton');
  assert.equal(chris.organizer, true);
  const log = wm.identityLog().filter((l) => l.value === 'chris.middleton@nurtur.tech');
  assert.ok(log.some((l) => l.action === 'bound' && l.rule === 'vault-declared'));
  assert.ok(log.some((l) => l.action === 'participants-linked'));
});

test('two notes claiming one address is a CONFLICT, bound to neither', async () => {
  declare('Chris Smith', { email: 'chris.middleton@nurtur.tech' });
  await pump();
  assert.equal(wm.personByEmail('chris.middleton@nurtur.tech'), null);
  const c = wm.identityConflicts().find((x) => x.email === 'chris.middleton@nurtur.tech');
  assert.deepEqual(c.claimants, ['person:chris-middleton', 'person:chris-smith']);
  const [m] = wm.currentMeetings({ now: NOW });
  assert.equal(m.participants.find((x) => x.email === 'chris.middleton@nurtur.tech').personId, null);
  // The mistaken note is corrected → the address goes back to its one owner.
  declare('Chris Smith', { email: 'chris.smith@nurtur.tech' });
  await pump();
  assert.equal(wm.personByEmail('chris.middleton@nurtur.tech').personId, 'person:chris-middleton');
});

// ── meetings ────────────────────────────────────────────────────────────────

test('an unchanged meeting re-observed FOLDS — the log records change, not polling', () => {
  const before = db.get('SELECT COUNT(*) AS n FROM event_log').n;
  const r = ws.publishCalendarWindow({ provider: 'graph', events: [graphEvent('g1')], window, now: NOW + 60000 });
  assert.equal(r.changed, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM event_log').n, before);
});

test('the phone\'s copy of a Graph meeting is a SUPPORTING source, not a second meeting', async () => {
  ws.publishCalendarWindow({ provider: 'apple', now: NOW, window: { fromLocal: '2026-10-20T00:00', toLocal: '2026-10-21T00:00' },
    events: [{ id: 'apple:x:2026-10-20T10:00', subject: 'tech leadership', start: '2026-10-20T10:00', end: '2026-10-20T11:00', showAs: 'busy' }] });
  await pump();
  const cur = wm.currentMeetings({ now: NOW });
  assert.equal(cur.length, 1);
  const roles = cur[0].sources.map((s) => `${s.provider}:${s.role}:${s.matchRule}`).sort();
  assert.deepEqual(roles, ['apple:supporting:start+title', 'graph:authoritative:provider-id']);
});

test('a phone entry that arrived FIRST is absorbed when Graph reports the same meeting', async () => {
  ws.publishCalendarWindow({ provider: 'apple', now: NOW, window: null,
    events: [{ id: 'apple:y:2026-10-20T14:00', subject: 'Budget review', start: '2026-10-20T14:00', end: '2026-10-20T15:00', showAs: 'busy' }] });
  await pump();
  assert.equal(db.get(`SELECT status FROM wm_meetings WHERE meeting_id = 'apple:apple:y:2026-10-20T14:00'`).status, 'scheduled');
  ws.publishCalendarWindow({ provider: 'graph', now: NOW, window: null,
    events: [graphEvent('g2', { subject: 'Budget Review', start: '2026-10-20T14:00:00', end: '2026-10-20T15:00:00' })] });
  await pump();
  const apple = db.get(`SELECT * FROM wm_meetings WHERE meeting_id = 'apple:apple:y:2026-10-20T14:00'`);
  assert.equal(apple.status, 'merged');
  assert.equal(apple.merged_into, 'graph:g2');
  const next = wm.nextMeetings({ now: NOW, limit: 5 }).filter((m) => m.start === '2026-10-20T14:00');
  assert.equal(next.length, 1, 'one meeting at 14:00, not two');
  assert.equal(next[0].sources.length, 2);
});

test('next meeting, and what is NOT a current meeting (all-day, free, cancelled)', async () => {
  ws.publishCalendarWindow({ provider: 'graph', now: NOW, window: null, events: [
    graphEvent('allday', { subject: 'Bank holiday', start: '2026-10-20T00:00:00', end: '2026-10-21T00:00:00', isAllDay: true, attendees: [] }),
    graphEvent('free', { subject: 'Optional drop-in', showAs: 'free' }),
    graphEvent('cxl', { subject: 'Cancelled sync', showAs: 'cancelled' }),
    graphEvent('solo', { subject: 'Focus block', start: '2026-10-20T12:00:00', end: '2026-10-20T12:30:00', attendees: [], attendeesOther: false, organizerEmail: null, organizer: null }),
  ] });
  await pump();
  const cur = wm.currentMeetings({ now: NOW });
  assert.deepEqual(cur.map((m) => m.meetingId), ['graph:g1']);
  const st = wm.meetingState({ now: NOW });
  assert.equal(st.next[0].meetingId, 'graph:solo');
  assert.equal(st.next[0].kind, 'block', 'a solo block is labelled as one');
  assert.equal(st.nextMeeting.meetingId, 'graph:g2', 'the next REAL meeting skips the block');
});

test('a meeting that leaves the window is REMOVED; a stale removal changes nothing; reappearing restores it', async () => {
  // A window that no longer shows g1 → removed.
  const r = ws.publishCalendarWindow({ provider: 'graph', events: [graphEvent('g2', { subject: 'Budget Review', start: '2026-10-20T14:00:00', end: '2026-10-20T15:00:00' })], window, now: NOW });
  assert.ok(r.removed >= 1);
  await pump();
  assert.equal(db.get(`SELECT status FROM wm_meetings WHERE meeting_id = 'graph:g1'`).status, 'removed');
  assert.ok(!wm.currentMeetings({ now: NOW }).some((m) => m.meetingId === 'graph:g1'));
  // It comes back (moved back into the window) → scheduled again.
  ws.publishCalendarWindow({ provider: 'graph', events: [graphEvent('g1', { subject: 'Tech Leadership (moved back)' })], window: null, now: NOW });
  await pump();
  assert.equal(db.get(`SELECT status FROM wm_meetings WHERE meeting_id = 'graph:g1'`).status, 'scheduled');
  // A removal about the OLD fingerprint arriving late changes nothing.
  const old = ws.calendarPayload('graph', graphEvent('g1')).fingerprint;
  bus.publishEvent({ type: 'observation.calendar.event_removed', occurredAt: new Date(NOW).toISOString(), source: { system: 'test' },
    idempotencyKey: 'late-removal-g1', payload: { provider: 'graph', providerEventId: 'g1', lastFingerprint: old } });
  await pump();
  assert.equal(db.get(`SELECT status FROM wm_meetings WHERE meeting_id = 'graph:g1'`).status, 'scheduled');
});

test('no window, no removals — a truncated sync is not a list of cancellations', () => {
  const r = ws.publishCalendarWindow({ provider: 'graph', events: [], window: null, now: NOW });
  assert.equal(r.removed, 0);
});

test('people are published from a real People folder; an unreadable vault publishes nothing', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-world-vault-'));
  fs.mkdirSync(path.join(vault, 'People'));
  fs.writeFileSync(path.join(vault, 'People', 'Hope Goodall.md'), '---\ntype: person\nemail: hope.goodall@nurtur.tech\n---\n');
  fs.writeFileSync(path.join(vault, 'People', '_about.md'), 'not a person');
  const r = ws.publishPeople({ vaultRoot: vault, now: NOW });
  assert.equal(r.notes, 1);
  assert.equal(r.changed, 1);
  assert.equal(ws.publishPeople({ vaultRoot: vault, now: NOW }).changed, 0, 'an unchanged note folds');
  assert.ok(ws.publishPeople({ vaultRoot: path.join(vault, 'nope') }).error);
});

test('replay rebuilds the whole world model identically', async () => {
  await pump();
  const snap = () => JSON.stringify(['wm_people', 'wm_person_identities', 'wm_meetings', 'wm_meeting_sources', 'wm_meeting_participants']
    .map((t) => db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)));
  const before = snap();
  const logBefore = db.all('SELECT kind, value, person_id, action, rule, evidence_event_id FROM wm_identity_log ORDER BY id');
  await bus.replayConsumer(wm.CONSUMER);
  assert.equal(snap(), before);
  assert.deepEqual(db.all('SELECT kind, value, person_id, action, rule, evidence_event_id FROM wm_identity_log ORDER BY id'), logBefore);
});
