'use strict';

/**
 * SAiM Alt "I'm not going" — over real HTTP, against a real calendar cache (16 Oct 2026).
 *
 * The whole chain the Alt button walks: cache row → neuro-candidates.gather/compose
 * (the meeting carries NEURO's attendance action and key) → POST
 * /api/attention/meeting/not-attending (NEURO's existing route) → gather again: the
 * meeting has left the candidates, so SAiM's next decision neither leads with it nor
 * names it Next. Resume brings it back.
 *
 *   run: node --test backend/routes/saim-alt-attendance-routing.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-saim-att-')), 'a.db');

const db = require('../db/database');
const NC = require('../services/neuro-candidates');
const POL = require('../../saim/policy/attention-policy.cjs');
const meetingFinish = require('../services/meeting-finish');
const router = require('./attention');

let server;
let base;
const p2 = (n) => String(n).padStart(2, '0');
/** Local wall clock, as Graph writes it into the cache. */
const wall = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00.0000000`; };

const START = Date.now() + 60 * 60000;
const sameDay = new Date(START + 30 * 60000).toDateString() === new Date().toDateString();

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  db.clearCalendarCache('graph');
  db.setState(meetingFinish.STATE_KEY, JSON.stringify({}));
  db.upsertCalendarEvent({ id: 'evt-later', subject: 'Support leadership', start: wall(START), end: wall(START + 30 * 60000), isAllDay: false, showAs: 'busy', attendeesOther: true });
});
test.after(() => server && server.close());

const read = () => {
  const g = NC.gather({ now: Date.now() });
  const payload = { poolAvailable: true, context: { activity: 'working', duty: { onDuty: true } }, primary: null, secondary: [], dropped: [], utterances: [], approvals: { known: true }, situation: { sections: { commitments: [] } }, home: { needsYou: [], exceptions: [] } };
  const candidates = NC.compose(payload, { rows: g.rows, session: g.session, block: g.block }, g.facts, { now: Date.now() });
  return { candidates, decision: POL.decide(candidates, { surface: 'work-desktop', now: Date.now() }) };
};
const post = (p, body) => fetch(`${base}/api/attention/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the next meeting carries "I’m not going"; pressing it through NEURO’s route takes it out of SAiM’s decision; resume restores it', { skip: !sameDay && 'too close to midnight for a later-today meeting' }, async () => {
  const before = read();
  const m = before.candidates.candidates.find((c) => c.kind === 'meeting' && c.title === 'Support leadership');
  assert.ok(m, 'positive control: the meeting is a candidate');
  const act = m.actions.find((a) => a.say === 'I’m not going');
  assert.ok(act, 'NEURO offers the attendance action');
  assert.equal(before.decision.next.ref, m.id, 'and SAiM names it Next');
  assert.deepEqual(before.decision.next.actions, [act]);

  const res = await post('meeting/not-attending', { key: act.intent.key });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);

  const after = read();
  assert.ok(!after.candidates.candidates.some((c) => c.title === 'Support leadership'), 'the skipped meeting has left the candidates');
  assert.notEqual(after.decision.next && after.decision.next.ref, m.id, 'and is no longer Next');
  assert.notEqual(after.decision.lead.ref, m.id);
  assert.equal(after.candidates.constraints.diaryReadable, true, 'the diary is still read — skipping is not blindness');

  const undo = await post('meeting/resume', { key: act.intent.key });
  assert.equal(undo.status, 200);
  assert.ok(read().candidates.candidates.some((c) => c.title === 'Support leadership'), 'resume brings it back');
});

test('a stale key is refused by NEURO and changes nothing', async () => {
  const res = await post('meeting/not-attending', { key: 'id:nope::2026-01-01T09:00:00' });
  assert.equal(res.status, 409);
  if (sameDay) assert.ok(read().candidates.candidates.some((c) => c.title === 'Support leadership'));
});
