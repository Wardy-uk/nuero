'use strict';

/**
 * Meeting context (Build 3D) — a SHADOW semantic evaluator.
 *
 *   run: node --test backend/services/meeting-context.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mc-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'mc.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
delete process.env.MEETING_CONTEXT_MODE;

// ⚠ Anything reaching a phone fails the suite: shadow means nothing is sent.
const sent = [];
require.cache[require.resolve('./webpush')] = {
  id: require.resolve('./webpush'), filename: require.resolve('./webpush'), loaded: true,
  exports: { sendToAll: async (...a) => { sent.push(a); throw new Error('a shadow evaluator tried to send'); }, isConfigured: () => true },
};

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const mc = require('./meeting-context');

test.before(async () => { await db.init(); });

// 08:30 UTC = 09:30 London. The meeting is at 10:00 — 30 minutes away.
const NOW = Date.parse('2026-10-20T08:30:00Z');
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });

function declare(name, email) {
  const p = ws.personPayload(name, `People/${name}.md`, { email });
  bus.publishEvent({ type: 'observation.person.declared', occurredAt: new Date(NOW).toISOString(), source: { system: 'vault' },
    idempotencyKey: `pd:${p.personId}:${p.fingerprint}`, payload: p });
}

function meeting(id, extra = {}) {
  return {
    id, subject: 'Tech Leadership', start: '2026-10-20T10:00:00', end: '2026-10-20T11:00:00', showAs: 'busy',
    responseStatus: 'accepted', organizer: 'Chris Middleton', organizerEmail: 'chris.middleton@nurtur.tech',
    attendees: [{ name: 'Naomi Wentworth', email: 'naomi.wentworth@nurtur.tech', status: 'accepted' },
      { name: 'Nick Ward', email: 'nick.ward@nurtur.tech', status: 'accepted' }],
    attendeesOther: true, seriesMasterId: 'tl', ...extra,
  };
}

const OPEN_MOMENT = { now: new Date(NOW), known: true, inMeeting: false, quiet: false, onDuty: true, focusMode: false,
  moving: false, driving: false, atLaptop: true, atDesk: true, inFocusSession: false, muted: [] };

function deps(over = {}) {
  return {
    previousOccurrence: () => ({ start_time: '2026-10-13T10:00:00', end_time: '2026-10-13T11:00:00', subject: 'Tech Leadership' }),
    noteFor: () => ({ note: 'Meetings/2026/10/2026-10-13 – Tech Leadership.md', why: null }),
    tasksFromNote: () => [{ id: 41, text: 'Send the SLA breakdown to Chris', status: 'open', due_date: null }],
    waitingOn: () => [],
    flaggedEmails: () => ({ lastScan: '2026-10-20T08:00:00Z', items: [] }),
    uniqueFirstName: (n) => String(n).split(' ')[0],
    selfEmails: () => ['nick.ward@nurtur.tech'],
    readMoment: async () => ({ moment: OPEN_MOMENT }),
    ...over,
  };
}

const row = (id) => db.get('SELECT * FROM meeting_context_findings WHERE meeting_id = ?', [id]);

test.before(async () => {
  declare('Naomi Wentworth', 'naomi.wentworth@nurtur.tech');
  declare('Nick Ward', 'nick.ward@nurtur.tech');
  ws.publishCalendarWindow({ provider: 'graph', now: NOW, window: null, events: [
    meeting('tl'),
    meeting('solo', { subject: 'Focus block', start: '2026-10-20T10:15:00', end: '2026-10-20T10:45:00', attendees: [], attendeesOther: false }),
    meeting('unknown', { subject: 'Phone thing', start: '2026-10-20T10:20:00', end: '2026-10-20T10:30:00', attendees: null, attendeesOther: null }),
    meeting('far', { subject: 'Afternoon thing', start: '2026-10-20T15:00:00', end: '2026-10-20T16:00:00' }),
  ] });
  await pump();
});

test('evidence from the previous occurrence makes a finding — with evidence, timing and confidence', async () => {
  const r = await mc.evaluate({ now: NOW, deps: deps() });
  assert.equal(r.mode, 'shadow');
  const f = row('graph:tl');
  assert.ok(f, 'finding created');
  assert.equal(f.status, 'active');
  assert.equal(f.recommended_at_local, '2026-10-20T09:40');
  assert.match(f.summary, /^Tech Leadership starts at 10:00\. 1 action you took from the last one \(2026-10-13\) is still open\.$/);
  const ev = JSON.parse(f.evidence_json);
  assert.equal(ev.commitments[0].taskId, 41);
  assert.ok(ev.meetingEvidence.length >= 1, 'the world model evidence travels with it');
  assert.deepEqual(JSON.parse(f.trigger_json).triggers, ['open-commitments-from-previous']);
  assert.equal(f.confidence, 0.6);
  // Not before the recommended time: no attention verdict yet.
  assert.equal(f.attention_decided_at, null);
  // Only the real meeting in range: the solo block, the unknown and the 15:00 are not findings.
  assert.equal(db.get('SELECT COUNT(*) AS n FROM meeting_context_findings').n, 1);
  assert.ok(r.skipped.some((s) => s.meetingId === 'graph:solo' && /block/.test(s.why)));
  assert.ok(r.skipped.some((s) => s.meetingId === 'graph:unknown' && /unknown/.test(s.why)), 'unknown is not enough to be a meeting');
});

test('at the recommended time the EXISTING policy is asked — recorded in shadow, never sent', async () => {
  const at = Date.parse('2026-10-20T08:41:00Z'); // 09:41 London
  await mc.evaluate({ now: at, deps: deps() });
  const f = row('graph:tl');
  const a = JSON.parse(f.attention_json);
  assert.equal(a.shadow, true);
  assert.equal(a.sent, false);
  assert.equal(a.push, true, 'an open moment: the policy would have pushed');
  assert.match(a.wouldSay.body, /Tech Leadership starts at 10:00/);
  assert.equal(sent.length, 0, 'nothing reached webpush');
  // Once per finding.
  await mc.evaluate({ now: at + 60000, deps: deps() });
  assert.equal(row('graph:tl').decisions, 1);
});

test('the policy\'s own vetoes apply: in a meeting at the moment it would have said nothing', async () => {
  db.run('UPDATE meeting_context_findings SET attention_decided_at = NULL, attention_json = NULL');
  await mc.evaluate({ now: Date.parse('2026-10-20T08:42:00Z'), deps: deps({ readMoment: async () => ({ moment: { ...OPEN_MOMENT, inMeeting: true } }) }) });
  const a = JSON.parse(row('graph:tl').attention_json);
  assert.equal(a.push, false);
  assert.equal(a.why, 'in a meeting');
});

test('an unreadable moment is recorded as a refusal, not a guess', async () => {
  db.run('UPDATE meeting_context_findings SET attention_decided_at = NULL, attention_json = NULL');
  await mc.evaluate({ now: Date.parse('2026-10-20T08:43:00Z'), deps: deps({ readMoment: async () => { throw new Error('HA down'); } }) });
  const a = JSON.parse(row('graph:tl').attention_json);
  assert.equal(a.push, false);
  assert.match(a.why, /could not read the moment: HA down/);
});

test('no specific evidence, no finding — and an existing one is WITHDRAWN', async () => {
  await mc.evaluate({ now: Date.parse('2026-10-20T08:44:00Z'), deps: deps({ tasksFromNote: () => [] }) });
  assert.equal(row('graph:tl').status, 'withdrawn');
});

test('attendees owing things in general do NOT trigger alone (prefer false negatives)', async () => {
  const r = await mc.evaluate({ now: Date.parse('2026-10-20T08:45:00Z'), deps: deps({
    tasksFromNote: () => [],
    waitingOn: () => [{ key: 'w1', person: 'Naomi', text: 'Send rota', sourcePath: 'Meetings/elsewhere.md' }],
  }) });
  assert.equal(row('graph:tl').status, 'withdrawn');
  assert.ok(r.skipped.some((s) => s.meetingId === 'graph:tl'));
});

test('an item owed FROM the previous write-up does trigger, and names who', async () => {
  await mc.evaluate({ now: Date.parse('2026-10-20T08:36:00Z'), deps: deps({
    tasksFromNote: () => [],
    waitingOn: () => [{ key: 'w2', person: 'Naomi', text: 'Share the escalation list', sourcePath: 'Meetings/2026/10/2026-10-13 – Tech Leadership.md' }],
  }) });
  const f = row('graph:tl');
  assert.equal(f.status, 'active');
  assert.match(f.summary, /Naomi still owes you 1 item from it\./);
});

test('only HIGH-urgency email from someone else in the meeting counts; his own does not', async () => {
  const items = [
    { emailId: 'e1', fromEmail: 'nick.ward@nurtur.tech', urgency: 'high', subject: 'note to self' },
    { emailId: 'e2', fromEmail: 'naomi.wentworth@nurtur.tech', urgency: 'medium', subject: 'fyi' },
  ];
  const g = mc.gather(wm.nextMeetings({ now: NOW, limit: 5 }).find((m) => m.meetingId === 'graph:tl'),
    deps({ flaggedEmails: () => ({ lastScan: 'x', items }) }));
  assert.equal(g.evidence.emails.length, 0);
  items.push({ emailId: 'e3', fromEmail: 'Naomi.Wentworth@nurtur.tech', urgency: 'high', subject: 'Before Tech Leadership' });
  const g2 = mc.gather(wm.nextMeetings({ now: NOW, limit: 5 }).find((m) => m.meetingId === 'graph:tl'),
    deps({ flaggedEmails: () => ({ lastScan: 'x', items }) }));
  assert.deepEqual(g2.evidence.emails.map((e) => e.emailId), ['e3']);
});

test('missing evidence is NAMED: never-run triage and an unreadable store are not "nothing there"', () => {
  const m = wm.nextMeetings({ now: NOW, limit: 5 }).find((x) => x.meetingId === 'graph:tl');
  const g = mc.gather(m, deps({ flaggedEmails: () => ({ lastScan: null, items: [] }), waitingOn: () => { throw new Error('locked'); } }));
  const inputs = g.missing.map((x) => x.input);
  assert.ok(inputs.includes('email'));
  assert.ok(inputs.includes('waiting-on'));
  const a = mc.assess(m, { ...g, evidence: { ...g.evidence, commitments: [{ taskId: 1 }] } });
  assert.ok(a.confidence < 0.6, 'a thinner read is less confident');
});

test('declined and broadcast meetings are never findings', () => {
  const base = wm.nextMeetings({ now: NOW, limit: 5 }).find((x) => x.meetingId === 'graph:tl');
  const g = { evidence: { commitments: [{ taskId: 1 }], owedFromPrevious: [], emails: [], attendeeOwed: [] }, missing: [] };
  assert.equal(mc.assess({ ...base, responseStatus: 'declined' }, g).finding, false);
  const many = Array.from({ length: 13 }, (_, i) => ({ email: `p${i}@x.com` }));
  assert.equal(mc.assess({ ...base, participants: many }, g).finding, false);
});

test('a finding EXPIRES once the meeting has started (a withdrawn one stays withdrawn)', async () => {
  await mc.evaluate({ now: Date.parse('2026-10-20T08:37:00Z'), deps: deps() });
  assert.equal(row('graph:tl').status, 'active');
  await mc.evaluate({ now: Date.parse('2026-10-20T09:01:00Z'), deps: deps() });
  assert.equal(row('graph:tl').status, 'expired');
});

test('MEETING_CONTEXT_MODE=off does nothing; "live" is read as shadow — there is no live path', async () => {
  process.env.MEETING_CONTEXT_MODE = 'off';
  const r = await mc.evaluate({ now: NOW, deps: deps() });
  assert.equal(r.considered, 0);
  process.env.MEETING_CONTEXT_MODE = 'live';
  assert.equal(mc.mode(), 'shadow');
  delete process.env.MEETING_CONTEXT_MODE;
  const src = fs.readFileSync(path.join(__dirname, 'meeting-context.js'), 'utf8');
  assert.doesNotMatch(src, /sendToAll|queueAction|graphWrite/, 'the evaluator has no route to a send');
  // ambient-push only knows meeting-context as a RULE to be asked; deliver() never offers one.
  const ap = fs.readFileSync(path.join(__dirname, 'ambient-push.js'), 'utf8');
  assert.equal(ap.split("'meeting-context'").length - 1, 1);
});

test('the previous write-up is found by TIME — PLAUD start_at is UTC — and ambiguity is refused', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mc-vault-'));
  const dir = path.join(vault, 'Meetings', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  // 17 Sep 2026, BST: the 12:00 1-2-1 was recorded with start_at 10:57 UTC.
  fs.writeFileSync(path.join(dir, '2026-09-17 – 1-2-1 Meeting Tier 2.md'), '---\nstart_at: "2026-09-17T10:57:18"\n---\n');
  fs.writeFileSync(path.join(dir, '2026-09-17 – Weekly Meeting AI.md'), '---\nstart_at: "2026-09-17T10:02:31"\n---\n');
  const occ = { start_time: '2026-09-17T12:00:00.0000000', end_time: '2026-09-17T12:30:00.0000000', subject: '1-2-1 — Nick / Hope' };
  assert.equal(mc._noteFor(occ, vault).note, 'Meetings/2026/09/2026-09-17 – 1-2-1 Meeting Tier 2.md');
  // Read as local instead, 10:57 would sit outside 11:40–12:50 — the UTC reading is the one that matches.
  fs.writeFileSync(path.join(dir, '2026-09-17 – Another recording.md'), '---\nstart_at: "2026-09-17T11:05:00"\n---\n');
  const amb = mc._noteFor(occ, vault);
  assert.equal(amb.note, null);
  assert.match(amb.why, /2 write-ups match/);
  assert.match(mc._noteFor(null, vault).why, /no earlier occurrence/);
});
