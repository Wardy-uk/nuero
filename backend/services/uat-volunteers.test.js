'use strict';

// UAT volunteers (26 Oct 2026). The store, the prepared actions and the routes
// are REAL; the mailbox read, the model, the roster, People HR, the push and
// the clock are faked at the deps boundary. Sending is simulated by reporting
// the prepared action as executed (the executor has its own suites).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uat-')), 'test.db');

const db = require('../db/database');
const model = require('./uat-volunteers-model');
const uat = require('./uat-volunteers');
const pa = require('./prepared-actions');

test.before(async () => { await db.init(); });

const PEOPLE = [
  { name: 'Abdi Mohamed', group: '2nd Line Technical Support', email: 'abdi@nurtur.tech', directReport: true },
  { name: 'Luke Scaife', group: '2nd Line Technical Support', email: 'luke@nurtur.tech', directReport: true },
  { name: 'Isabel Busk', group: 'Digital Design', email: 'isabel@nurtur.tech', directReport: true },
  { name: 'Heidi Power', group: '1st Line Customer Care', email: 'heidi@nurtur.tech', directReport: true },
  { name: 'Zoe Rees', group: '1st Line Customer Care', email: 'zoe@nurtur.tech', directReport: true },
  { name: 'Arman Shazad', group: '2nd Line Technical Support', email: 'arman@nurtur.tech', directReport: false, archived: true },
];

const DAN_ENTRY = (id) => ({
  id, subject: "UAT Request - AFE 'Anniversary' functionality - October 28th 2026 - Team Leads - Action Required",
  fromEmail: 'dan.short@nurtur.tech', preview: 'We had a fantastic UAT session last week…',
});

const EXTRACT_OK = JSON.stringify({
  asksForVolunteers: true, feature: "'Anniversary' functionality in the new AFE", date: '2026-10-28', start: '09:00', end: '10:00',
  location: 'Scrum room, Derby office', online: 'Teams meeting',
});

function world({ off = {}, extractText = EXTRACT_OK } = {}) {
  const w = {
    now: Date.parse('2026-10-26T09:00:00Z'),
    pushes: [], extracts: 0, replies: [], executed: new Set(),
  };
  w.deps = {
    people: () => PEOPLE,
    leaveSnapshot: () => ({ known: true, rosterCount: PEOPLE.length }),
    daysOffFor: (name) => ({ known: true, dates: new Set(off[name] || []) }),
    holidays: () => new Set(),
    storedTriage: () => w.inbox || [],
    fetchEmail: async (id) => ({ id, from: 'Dan Short', fromEmail: 'dan.short@nurtur.tech', subject: DAN_ENTRY(id).subject, body: 'volunteers please' }),
    selfAddress: async () => 'nickw@nurtur.tech',
    extract: async () => { w.extracts += 1; return extractText; },
    push: async (title, body, data) => { w.pushes.push({ title, body, data }); },
    prepareReply: async (a) => { w.replies.push(a); return pa.prepareReply({ ...a, deps: { mail: { readMessage: async () => ({ ok: true, exists: true, from: 'dan.short@nurtur.tech', fromName: 'Dan Short', subject: 'UAT Request', conversationId: 'c1', internetMessageId: '<m1>', to: [], cc: [] }), signedInAddress: async () => 'nickw@nurtur.tech' } } }); },
    getAction: (id) => { const a = pa.get(id); return a && w.executed.has(id) ? { ...a, status: 'executed', executedAt: new Date(w.now).toISOString() } : a; },
    now: () => w.now,
    publicBase: () => 'https://neuro.example',
  };
  return w;
}

const sels = (roundId) => db.all('SELECT * FROM uat_selections WHERE round_id = ? ORDER BY id', [roundId]);
const round = (id) => db.get('SELECT * FROM uat_rounds WHERE id = ?', [id]);
const tokenIn = (body) => (String(body).match(/\/api\/u\/([A-Za-z0-9_-]+)/) || [])[1];

// ── Pure ─────────────────────────────────────────────────────────────────────

test('the cheap rule lets Dan\'s request through and not a recap or Nick\'s own mail', () => {
  assert.equal(model.quickMatch(DAN_ENTRY('x')), true);
  assert.equal(model.quickMatch({ subject: 'UAT notes from last week', preview: 'thanks all' }), false);
  assert.equal(model.quickMatch({ ...DAN_ENTRY('x'), fromEmail: 'nickw@nurtur.tech' }, 'nickw@nurtur.tech'), false);
  // Marking the request Done in the Inbox is not the same as putting people forward.
  assert.equal(model.quickMatch({ ...DAN_ENTRY('x'), dismissed: true }), true);
});

test('an extraction missing the date or time refuses; a past date refuses', () => {
  assert.equal(model.parseExtraction(EXTRACT_OK, { todayKey: '2026-10-26' }).ok, true);
  assert.equal(model.parseExtraction(JSON.stringify({ asksForVolunteers: true, date: '2026-10-28' })).ok, false);
  assert.equal(model.parseExtraction(JSON.stringify({ asksForVolunteers: true, date: '2026-02-31', start: '09:00' })).ok, false);
  assert.equal(model.parseExtraction(EXTRACT_OK, { todayKey: '2026-10-29' }).ok, false);
  const no = model.parseExtraction('{"asksForVolunteers": false}');
  assert.deepEqual(no, { ok: true, request: { asksForVolunteers: false } });
  assert.equal(model.parseExtraction('not json').ok, false);
});

test('a display name that is really an address becomes a name', () => {
  assert.equal(model.displayName('dan.short@nurtur.tech', 'dan.short@nurtur.tech'), 'Dan Short');
  assert.equal(model.displayName('Dan Short', 'dan.short@nurtur.tech'), 'Dan Short');
  assert.equal(model.displayName(null, 'dshort@nurtur.tech'), 'Dshort');
  assert.equal(model.displayName(null, null), null);
});

test('picking: off that day is out, never-asked first, then oldest, ties alphabetical', () => {
  const members = model.poolMembers('tier2dd', PEOPLE);
  assert.deepEqual(members.map((m) => m.name), ['Abdi Mohamed', 'Isabel Busk', 'Luke Scaife']); // archived left out
  const leave = (n) => ({ known: true, dates: new Set(n === 'Abdi Mohamed' ? ['2026-10-28'] : []) });
  assert.equal(model.pickNext({ members, leave, date: '2026-10-28' }).pick.name, 'Isabel Busk');
  const hist = new Map([['Isabel Busk', '2026-10-01T09:00:00Z'], ['Luke Scaife', '2026-09-01T09:00:00Z']]);
  assert.equal(model.pickNext({ members, history: hist, leave, date: '2026-10-28' }).pick.name, 'Luke Scaife');
  const allIn = () => ({ known: true, dates: new Set() });
  assert.equal(model.pickNext({ members, history: new Map([['Abdi Mohamed', '2026-01-01']]), leave: allIn, date: '2026-10-28' }).pick.name, 'Isabel Busk');
  // Live case, 26 Oct 2026: Adele is on maternity leave and not in People HR.
  // Someone People HR cannot see is SKIPPED, never picked with a warning.
  const notInHR = (n) => (n === 'Abdi Mohamed' ? { known: false, reason: 'Abdi Mohamed is not in the NOVA roster' } : { known: true, dates: new Set() });
  const r1 = model.pickNext({ members, leave: notInHR, date: '2026-10-28' });
  assert.equal(r1.pick.name, 'Isabel Busk');
  assert.ok(r1.skipped.some((s) => s.name === 'Abdi Mohamed' && /not in the NOVA roster/.test(s.why)));
  // Only when the whole feed is unreadable does a pick go ahead, saying so.
  const unknown = model.pickNext({ members, leave: () => ({ known: false, feedDown: true, reason: 'People HR not readable' }), date: '2026-10-28' });
  assert.equal(unknown.pick.name, 'Abdi Mohamed');
  assert.match(unknown.why, /leave not checked/);
});

test('the window: today 17:30 before 15:00, next working day after, never past the day before', () => {
  const s = { date: '2026-10-28', start: '09:00' };
  const at = (iso) => new Date(model.deadlineFor(Date.parse(iso), s)).toISOString();
  assert.equal(at('2026-10-26T10:00:00Z'), '2026-10-26T17:30:00.000Z'); // Mon morning → Mon 17:30 (GMT)
  assert.equal(at('2026-10-26T16:00:00Z'), '2026-10-27T17:30:00.000Z'); // Mon 16:00 → Tue 17:30
  assert.equal(at('2026-10-27T16:00:00Z'), '2026-10-27T17:30:00.000Z'); // capped at the day before
  assert.equal(at('2026-10-27T18:00:00Z'), '2026-10-28T09:00:00.000Z'); // too late → session start
  assert.equal(at('2026-10-24T10:00:00Z'), '2026-10-26T17:30:00.000Z'); // Saturday → Monday
});

// ── The flow ─────────────────────────────────────────────────────────────────

test('a request becomes a round with one pick per team; invites carry a one-use link', async () => {
  const w = world({ off: { 'Abdi Mohamed': ['2026-10-28'] } });
  const out = await uat.scanTriage([DAN_ENTRY('mail-1'), { id: 'other', subject: 'Lunch?' }], w.deps);
  assert.equal(out.rounds.length, 1);
  const id = out.rounds[0];
  // Picked AND drafted at once, so the invites already wait in Actions and Drafts.
  assert.equal(round(id).status, 'inviting');
  assert.deepEqual(sels(id).map((s) => [s.pool, s.person, s.status]), [['tier2dd', 'Isabel Busk', 'invited'], ['cc', 'Heidi Power', 'invited']]);
  assert.ok(sels(id).every((s) => pa.get(s.action_id).status === 'prepared'));
  assert.equal(w.pushes.length, 1);
  const rows = uat.draftRows(w.deps).filter((r) => r.moveKey.startsWith(`uat:${id}:`));
  assert.deepEqual(rows.map((r) => r.title), ['Ask Isabel Busk to the UAT on Wednesday 28 October', 'Ask Heidi Power to the UAT on Wednesday 28 October']);
  const card = uat.nowCards(w.now).find((c) => c.meta.roundId === id);
  assert.ok(card.score >= 80, 'tier 1, so the top-five cut cannot drop it');

  // Seen once: a second pass buys no second model call and opens no second round.
  await uat.scanTriage([DAN_ENTRY('mail-1')], w.deps);
  assert.equal(w.extracts, 1);

  const prep = uat.prepareInvites(id, w.deps);
  assert.equal(prep.ok, true);
  assert.equal(prep.actions.length, 2);
  const a = prep.actions[0];
  assert.equal(a.actionType, 'compose_email');
  assert.equal(a.status, 'prepared');
  assert.equal(a.draft.to[0].email, 'isabel@nurtur.tech');
  const token = tokenIn(a.draft.body);
  assert.ok(token && token.length >= 30);
  assert.match(a.draft.body, /17:30 on Monday 26 October/);
  const row = sels(id)[0];
  assert.equal(row.status, 'invited');
  assert.notEqual(row.token_hash, token); // stored hashed
  assert.equal(round(id).status, 'inviting');
});

test('one round per session date: a second request for the same date opens nothing', async () => {
  const w = world();
  const out = await uat.scanTriage([DAN_ENTRY('mail-dup')], w.deps);
  assert.equal(out.rounds.length, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM uat_rounds WHERE uat_date = ?', ['2026-10-28']).n, 1);
});

test('answers: confirm, decline → replacement, timeout counts as yes, then Dan\'s reply', async () => {
  const w = world();
  const id = db.get('SELECT id FROM uat_rounds WHERE uat_date = ?', ['2026-10-28']).id;
  const [isabel, heidi] = sels(id);
  const tokens = {};
  for (const s of [isabel, heidi]) {
    const a = pa.get(s.action_id);
    tokens[s.person] = tokenIn(a.draft.body);
    w.executed.add(a.actionId);
  }
  // GET-style lookup records nothing.
  const look = uat.lookup(tokens['Isabel Busk'], w.deps);
  assert.equal(look.state, 'sent');
  assert.equal(look.canAnswer, true);
  assert.equal(sels(id)[0].status, 'sent');

  const conf = await uat.respond(tokens['Isabel Busk'], 'confirm', w.deps);
  assert.equal(conf.recorded, 'confirmed');
  const dec = await uat.respond(tokens['Heidi Power'], 'decline', w.deps);
  assert.equal(dec.recorded, 'declined');
  assert.equal(dec.state, 'declined-replaced');
  const zoe = sels(id).find((s) => s.person === 'Zoe Rees');
  assert.equal(zoe.status, 'invited'); // drafted straight away, waiting for Nick's press
  assert.ok(w.pushes.some((p) => /Heidi Power can't make it/.test(p.title)));
  // A declined person cannot flip back once someone else has been asked.
  const again = await uat.respond(tokens['Heidi Power'], 'confirm', w.deps);
  assert.equal(again.ok, false);

  // Zoe is invited (Nick's press) and sent; she never answers.
  const p2 = uat.prepareInvites(id, w.deps);
  assert.equal(p2.actions.length, 1);
  w.executed.add(p2.actions[0].actionId);
  await uat.tick(w.deps);
  assert.equal(sels(id).find((s) => s.person === 'Zoe Rees').status, 'sent');
  assert.equal(round(id).reply_action_id, null); // still waiting on Zoe

  w.now = Date.parse('2026-10-26T17:31:00Z');
  await uat.tick(w.deps);
  assert.equal(sels(id).find((s) => s.person === 'Zoe Rees').status, 'accepted');
  assert.equal(round(id).status, 'ready');
  assert.equal(w.replies.length, 1);
  assert.match(w.replies[0].body, /Isabel Busk and Zoe Rees/);
  assert.equal(w.replies[0].origin, 'uat-volunteers');
  const reply = pa.get(round(id).reply_action_id);
  assert.equal(reply.actionType, 'reply_email');
  assert.equal(reply.status, 'prepared'); // waits for Nick's press
  assert.ok(w.pushes.some((p) => /ready to tell Dan Short/.test(p.title)));

  // Answers after the window are refused.
  const late = await uat.respond(tokens['Isabel Busk'], 'decline', w.deps);
  assert.equal(late.ok, false);
  assert.equal(late.state, 'closed');

  // The reply goes → done. The rota: Isabel and Zoe have had a turn; Heidi (declined) has not.
  w.executed.add(reply.actionId);
  await uat.tick(w.deps);
  assert.equal(round(id).status, 'done');
  const hist = uat.history();
  assert.ok(hist.get('Isabel Busk'));
  assert.ok(hist.get('Zoe Rees'));
  assert.equal(hist.get('Heidi Power'), undefined);
});

test('the next round picks from the rota: those already put forward go to the back', async () => {
  const w = world({ extractText: EXTRACT_OK.replace('2026-10-28', '2026-11-04') });
  const { rounds: [id] } = await uat.scanTriage([DAN_ENTRY('mail-next')], w.deps);
  assert.deepEqual(sels(id).map((s) => s.person), ['Abdi Mohamed', 'Heidi Power']);
});

test('swap before sending: a named person, or the next in the rota; not someone already asked', async () => {
  const w = world();
  const id = db.get('SELECT id FROM uat_rounds WHERE uat_date = ?', ['2026-11-04']).id;
  const abdi = sels(id).find((s) => s.person === 'Abdi Mohamed');
  const r = uat.swap(id, abdi.id, 'Luke Scaife', w.deps);
  assert.equal(r.ok, true);
  assert.equal(sels(id).find((s) => s.id === abdi.id).status, 'replaced');
  const luke = sels(id).find((s) => s.person === 'Luke Scaife');
  assert.equal(uat.swap(id, luke.id, 'Heidi Power', w.deps).code, 400); // wrong team
  const next = uat.swap(id, luke.id, null, w.deps);
  assert.equal(next.picked, 'Isabel Busk'); // Abdi and Luke already asked this round
});

test('not a request: remembered, no round; an unreadable answer → an unclear round', async () => {
  const w = world({ extractText: '{"asksForVolunteers": false}' });
  const out = await uat.scanTriage([DAN_ENTRY('mail-recap')], w.deps);
  assert.equal(out.notRequests, 1);
  assert.equal(db.get('SELECT id FROM uat_rounds WHERE source_email_id = ?', ['mail-recap']), null);
  await uat.scanTriage([DAN_ENTRY('mail-recap')], w.deps);
  assert.equal(w.extracts, 1);

  const w2 = world({ extractText: '{"asksForVolunteers": true, "date": "2026-11-11"}' });
  const out2 = await uat.scanTriage([DAN_ENTRY('mail-garbled')], w2.deps);
  assert.equal(round(out2.rounds[0]).status, 'unclear');
  assert.match(round(out2.rounds[0]).unclear_why, /start time/);
  assert.equal(uat.nowCards(w2.now).some((c) => c.title === 'A UAT email NEURO could not read'), true);

  // Last week's request (live case, 26 Oct 2026): over, so remembered — never a card.
  const wPast = world({ extractText: EXTRACT_OK.replace('2026-10-28', '2026-10-21') });
  const outPast = await uat.scanTriage([DAN_ENTRY('mail-last-week')], wPast.deps);
  assert.equal(outPast.rounds.length, 0);
  assert.equal(db.get('SELECT id FROM uat_rounds WHERE source_email_id = ?', ['mail-last-week']), null);
  await uat.scanTriage([DAN_ENTRY('mail-last-week')], wPast.deps);
  assert.equal(wPast.extracts, 1);

  const w3 = world({ extractText: null });
  const out3 = await uat.scanTriage([DAN_ENTRY('mail-model-down')], w3.deps);
  assert.equal(out3.retry, 1); // model unavailable: no round, asked again next pass
  assert.equal(db.get('SELECT id FROM uat_rounds WHERE source_email_id = ?', ['mail-model-down']), null);
});

test('an invite drafted in the morning is redrafted at 15:00 with the next day as its reply-by', async () => {
  const w = world({ extractText: EXTRACT_OK.replace('2026-10-28', '2026-12-09') });
  const { rounds: [id] } = await uat.scanTriage([DAN_ENTRY('mail-redraft')], w.deps);
  const before = sels(id)[0];
  assert.equal(before.deadline_at, '2026-10-26T17:30:00.000Z');
  w.now = Date.parse('2026-10-26T15:05:00Z');
  await uat.tick(w.deps);
  assert.equal(pa.get(before.action_id).status, 'rejected');
  const after = sels(id)[0];
  assert.equal(after.status, 'invited');
  assert.notEqual(after.action_id, before.action_id);
  assert.equal(after.deadline_at, '2026-10-27T17:30:00.000Z');
  assert.match(pa.get(after.action_id).draft.body, /17:30 on Tuesday 27 October/);
  await uat.tick(w.deps); // stable: no second redraft
  assert.equal(sels(id)[0].action_id, after.action_id);
});

test('the timer finds a request already in the stored inbox, even one marked Done', async () => {
  const w = world({ extractText: EXTRACT_OK.replace('2026-10-28', '2026-11-25') });
  w.inbox = [{ ...DAN_ENTRY('mail-stored'), dismissed: true }];
  await uat.tick(w.deps);
  const r = db.get('SELECT * FROM uat_rounds WHERE source_email_id = ?', ['mail-stored']);
  assert.ok(r);
  assert.equal(r.status, 'inviting'); // picked and drafted
  await uat.tick(w.deps); // a second tick reads nothing again
  assert.equal(w.extracts, 1);
});

test('a request UAT has taken over is not also offered as "Draft a reply"', async () => {
  const w = world();
  const id = db.get('SELECT source_email_id FROM uat_rounds WHERE uat_date = ?', ['2026-11-04']).source_email_id;
  assert.ok(uat.ownedEmailIds().has(id));
  const r = db.run(`INSERT INTO saim_actions (type, payload, status) VALUES ('draft_reply', ?, 'pending')`, [JSON.stringify({ emailId: id })]);
  const other = db.run(`INSERT INTO saim_actions (type, payload, status) VALUES ('draft_reply', ?, 'pending')`, [JSON.stringify({ emailId: 'someone-else' })]);
  await uat.tick(w.deps);
  assert.equal(db.get('SELECT status FROM saim_actions WHERE id = ?', [r.lastInsertRowid]).status, 'superseded');
  assert.equal(db.get('SELECT status FROM saim_actions WHERE id = ?', [other.lastInsertRowid]).status, 'pending');
});

test('Now: a card while picks wait to be sent', () => {
  const cards = uat.nowCards(Date.parse('2026-10-27T09:00:00Z'));
  const c = cards.find((x) => x.meta && x.meta.uatDate === '2026-11-04');
  assert.ok(c);
  assert.equal(c.type, 'uat_volunteers');
  assert.match(c.title, /invite/);
});

// ── The public link ──────────────────────────────────────────────────────────

test('auth: /api/u/<token> needs no PIN; /api/uat still does', () => {
  const apiAuth = require('./api-auth');
  const saved = process.env.NEURO_PIN;
  process.env.NEURO_PIN = 'test-pin';
  try {
    const call = (p) => {
      let passed = false; let status = null;
      apiAuth({ path: p, headers: {}, query: {} }, { status: (s) => { status = s; return { json: () => {} }; } }, () => { passed = true; });
      return passed ? 'open' : status;
    };
    assert.equal(call('/u/abcdefghijklmnopqrstuvwxyz'), 'open');
    assert.equal(call('/uat'), 401);
    assert.equal(call('/uat/rounds/1/invites'), 401);
    assert.equal(call('/u'), 401);
  } finally { if (saved === undefined) delete process.env.NEURO_PIN; else process.env.NEURO_PIN = saved; }
});

test('the answer page: GET shows buttons and records nothing; POST records; unknown is 404', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/u', require('../routes/uat-respond'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/u`;
  // The route uses the service's default deps; pin their clock and send state
  // to this world so the test does not depend on the wall clock.
  const D = uat._internals.DEFAULT_DEPS;
  const saved = { now: D.now, getAction: D.getAction };
  try {
    const w = world({ extractText: EXTRACT_OK.replace('2026-10-28', '2026-11-18') });
    D.now = w.deps.now;
    D.getAction = w.deps.getAction;
    const { rounds: [id] } = await uat.scanTriage([DAN_ENTRY('mail-page')], w.deps);
    const prep = uat.prepareInvites(id, w.deps);
    const token = tokenIn(prep.actions[0].draft.body);
    // Not yet sent: the person can still answer (the email may arrive before the next tick).
    const get = await fetch(`${base}/${token}`);
    assert.equal(get.status, 200);
    const html = await get.text();
    assert.match(html, /Confirm — I'll be there|Confirm — I&#39;ll be there/);
    const [mine, other] = sels(id);
    assert.ok(html.includes(`Hi ${mine.person.split(' ')[0]}`));
    assert.equal(html.includes(other.person.split(' ')[0]), false); // nobody else's name
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(sels(id)[0].responded_at, null);

    const post = await fetch(`${base}/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'answer=confirm' });
    assert.equal(post.status, 200);
    assert.match(await post.text(), /confirmed/);
    assert.equal(sels(id)[0].status, 'confirmed');

    const bad = await fetch(`${base}/not-a-real-token-abcdefghijklmnop`);
    assert.equal(bad.status, 404);
  } finally { server.close(); D.now = saved.now; D.getAction = saved.getAction; }
});
