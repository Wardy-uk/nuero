'use strict';

/**
 * SAiM Alt, 16 Oct 2026 — the join link and "Do now" over a real DB and real routes.
 *
 *   1. A Graph-mapped event with a Teams join link → db.upsertCalendarEvent (the
 *      sync's writer) → neuro-candidates.gather → the meeting's join target →
 *      SAiM's resolver offers "Join in Teams". A non-https link is not stored.
 *   2. "Do now" on a waiting commitment → POST /api/session/start (NEURO's route,
 *      the body the Alt shell sends) → gather sees the live session → the policy
 *      leads with THAT item as S5f chosen focus.
 *
 *   run: node --test backend/routes/saim-alt-rail-join-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-saim-rail-')), 'a.db');

const db = require('../db/database');
const NC = require('../services/neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const H = require('../../saim/policy/handoff.cjs');
const J = require('../../shared/meeting-join.cjs');

let server; let base;
const p2 = (n) => String(n).padStart(2, '0');
const wall = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00.0000000`; };
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz%40thread.v2/0';
const START = Date.now() + 5 * 60000;
const sameDay = new Date(START + 30 * 60000).toDateString() === new Date().toDateString();

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/session', require('./focus-session'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.clearCalendarCache('graph');
  // As microsoft.fetchCalendarEvents maps a Graph online meeting (shared/meeting-join).
  const j = J.joinFrom({ isOnlineMeeting: true, joinUrl: TEAMS, onlineMeetingProvider: 'teamsForBusiness' });
  db.upsertCalendarEvent({ id: 'evt-online', subject: 'Support leadership', start: wall(START), end: wall(START + 30 * 60000), isAllDay: false, showAs: 'busy', attendeesOther: true, joinUrl: j.url, joinProvider: j.provider });
  db.upsertCalendarEvent({ id: 'evt-bad', subject: 'Odd link', start: wall(START + 60 * 60000), end: wall(START + 90 * 60000), isAllDay: false, showAs: 'busy', attendeesOther: true, joinUrl: 'http://example.com/x', joinProvider: 'teams' });
});
test.after(() => server && server.close());

const PAYLOAD = (commitments = []) => ({ poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, primary: null, secondary: [], dropped: [], utterances: [], approvals: { known: true }, situation: { sections: { commitments } }, home: { needsYou: [], exceptions: [] } });
const read = (commitments) => {
  const now = Date.now();
  const g = NC.gather({ now });
  const candidates = NC.compose(PAYLOAD(commitments), { rows: g.rows, session: g.session, block: g.block }, g.facts, { now });
  const decision = POL.decide(candidates, { surface: 'work-desktop', now });
  const device = { contract: 'saim-device-v1', known: true, observedAt: new Date(now - 60000).toISOString(), apps: [] };
  return { candidates, decision, handoff: H.resolveHandoff({ decision, candidates, device, now }) };
};

test('the cache keeps the https join link and its provider; a non-https one is not stored', () => {
  const rows = db.all('SELECT event_id, join_url, join_provider FROM calendar_cache ORDER BY event_id');
  assert.deepEqual(rows.map((r) => [r.event_id, r.join_url, r.join_provider]), [['evt-bad', null, 'teams'], ['evt-online', TEAMS, 'teams']]);
});

test('gather → the meeting candidate carries the join target; imminent, SAiM offers "Join in Teams" first', { skip: !sameDay && 'too close to midnight' }, () => {
  const { candidates, decision, handoff } = read();
  const m = candidates.candidates.find((c) => c.title === 'Support leadership');
  assert.ok(m.targets.some((t) => t.role === 'join' && t.href === TEAMS && t.provider === 'teams'));
  const bad = candidates.candidates.find((c) => c.title === 'Odd link');
  assert.ok(!bad.targets.some((t) => t.role === 'join'), 'a stored non-link never becomes a join target');
  assert.equal(decision.lead.rule, 'S3a imminent meeting transition');
  assert.equal(handoff.handoff.primary.label, 'Join in Teams');
  assert.equal(handoff.handoff.primary.target.href, TEAMS);
});

test('the suggested "Do now" (S11c) through NEURO’s session route refreshes SAiM into In focus · your choice (S5f)', async () => {
  db.clearCalendarCache('graph'); // nothing protected or imminent
  const taskId = require('../services/task-store').createTask({ text: 'Build call/productivity metrics in Nova', source: 'test' }).id;
  const commitments = [{ id: `commitment:task:${taskId}`, direction: 'i-owe', state: 'open', description: 'Build call/productivity metrics in Nova', taskId: `task:neuro:${taskId}`, due: { date: new Date().toLocaleDateString('en-CA'), kind: 'set' }, domains: { known: true, domains: [{ domain: 'work', basis: 'set' }], sphere: 'work', basis: 'set' } }];
  const before = read(commitments);
  // Nothing urgent and one startable item: SAiM offers it as the choice (S11c), never "Nothing needs you".
  assert.equal(before.decision.lead.rule, 'S11c choose');
  assert.equal(before.decision.lead.choice.ref, `commitment:task:${taskId}`);
  const doNow = before.decision.recommended;
  assert.equal(doNow, before.decision.lead.choice.action);
  assert.equal(doNow.say, 'Do now');
  // Exactly the body App.jsx sends for a session start.
  const res = await fetch(`${base}/api/session/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: doNow.intent.text, source: 'attention', taskId: doNow.intent.taskId }) });
  assert.equal(res.status, 200, await res.text());
  const after = read(commitments);
  assert.equal(after.decision.lead.rule, 'S5f chosen focus');
  assert.equal(after.decision.lead.ref, `commitment:task:${taskId}`);
  assert.equal(after.decision.display.lead.clock.state, 'running');
  await fetch(`${base}/api/session/abandon`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
});
