'use strict';

/**
 * The shadow's tick cadence (19 Oct 2026): what a five-minute tick may read.
 *
 *   run: node --test backend/services/promise-shadow-cadence.test.js
 *
 * Every tick of whole simulated weekdays (07:00–18:55, every 5 minutes, as the
 * cron fires) through the REAL read-only canonical Now. The only network call
 * Now makes here is room presence on localhost:3005; it is answered by a stub
 * that COUNTS, and any other fetch is a failure. Proves:
 *   • a canonical Now read happens only at a bundle or a pre-meeting window
 *     with a promise owed — 3 on a plain weekday, 3 on a Monday (discovery
 *     shares the 07:30 read), 4 with one relevant meeting;
 *   • a meeting with no promise owed costs one ledger read and no Now read;
 *   • a changed meeting (same event, new marker) is re-read once, safely —
 *     no new row, no Now read; a restart costs at most one ledger read;
 *   • an already-logged moment is never logged again;
 *   • localhost:3005 calls === the Now-read counter;
 *   • nothing outside promise_shadow_log is written.
 * People are pseudonyms.
 */

// Pins the wall clock to each pass's simulated instant (see the helper).
const clock = require('./fixtures/promise-shadow/clock');
clock.install();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pcadence-'));
process.env.NEURO_DB_PATH = path.join(tmp, 's.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'HA_TOKEN', 'HA_URL', 'PROMISE_SHADOW_ENABLED', 'SAIM_BASE_URL']) delete process.env[k];

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n');
put('People/Robin Lee.md', '---\nemail: robin.lee@nurtur.tech\n---\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n');
put('People/Casey Moore.md', '---\nemail: casey.moore@nurtur.tech\n---\n');
put('Meetings/2026/09/2026-09-14 - Ops sync.md', [
  '- Nick to send Alex Reed the list of ticket types blocked by skill gaps',
  '- Nick to write the onboarding guide for Sam Patel',
  '- Nick to share the QA rubric with Casey Moore', '',
].join('\n'));

// Every network call is counted; only room presence is expected.
const calls = { presence: 0, other: [] };
global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('http://localhost:3005/api/presence/room')) {
    calls.presence += 1;
    return { ok: true, status: 200, json: async () => ({ confidence: 'unsure', room: null }) };
  }
  calls.other.push(u);
  throw new Error(`unexpected network call from the shadow: ${u}`);
};
const doors = [];
function stub(rel, ex) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: ex }; }
const boom = (w) => async () => { doors.push(w); throw new Error(`${w} reached from the shadow`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });
stub('./action-mail', { createDraft: boom('action-mail'), sendDraft: boom('action-mail'), DEFINITIVE_SEND_REFUSALS: new Set() });
stub('./microsoft', { getSignedInAddress: async () => 'nickw@nurtur.tech', getAccessToken: boom('graph'), graphWrite: boom('graphWrite'), sendMail: boom('ms.sendMail') });

const db = require('../db/database');
const taskStore = require('./task-store');
const shadow = require('./promise-shadow');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const lday = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
function london(day, hm) {
  for (const off of [0, 1]) {
    const ms = Date.parse(`${day}T${hm}:00Z`) - off * 3600000;
    if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16) === hm) return ms;
  }
  throw new Error('bad time');
}
let d0 = Date.now() + DAY;
while (new Date(`${lday(d0)}T12:00:00Z`).getUTCDay() !== 1) d0 += DAY;
const day = (n) => lday(d0 + n * DAY); // 0 Mon … 4 Fri, 7 next Mon
const CRON_TIMES = []; for (let h = 7; h <= 18; h += 1) for (let m = 0; m < 60; m += 5) CRON_TIMES.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);

function fingerprint({ except = [] } = {}) {
  const out = { __schema: crypto.createHash('sha1').update(JSON.stringify(db.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '%promise_shadow%' ORDER BY type, name"))).digest('hex') };
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    if (except.includes(name)) continue;
    out[name] = crypto.createHash('sha1').update(JSON.stringify(db.all(`SELECT * FROM "${name}"`))).digest('hex');
  }
  return out;
}
const rows = (where = '1=1', params = []) => db.all(`SELECT * FROM promise_shadow_log WHERE ${where} ORDER BY id`, params);
const decisions = () => rows("kind <> 'heartbeat'").length;

/** Run every cron tick of one day (optionally from/to), with hooks before chosen times. */
const KEYS = { ticks: 'ticks', skipped: 'skipped', snapshots: 'snapshots', nowReads: 'nowReads', bundle: 'nowReadsBundle',
  meeting: 'nowReadsMeeting', reinspect: 'meetingReinspections', noId: 'meetingsWithoutIdentity' };
async function runDay(d, { from = '07:00', to = '18:55', before = {} } = {}) {
  // Summed tick by tick, so a simulated restart (which zeroes the counters) is still counted.
  const sum = Object.fromEntries(Object.keys(KEYS).map((k) => [k, 0])); const presence0 = calls.presence; const readAt = [];
  for (const hm of CRON_TIMES) {
    if (hm < from || hm > to) continue;
    if (before[hm]) before[hm]();
    const s0 = shadow.stats();
    const t = london(d, hm);
    await clock.at(t, () => shadow.tick({ now: t }));
    const s1 = shadow.stats();
    for (const [k, c] of Object.entries(KEYS)) sum[k] += s1[c] - s0[c];
    if (s1.nowReads > s0.nowReads) readAt.push(hm);
  }
  return { ...sum, presence: calls.presence - presence0, readAt };
}
const cal = (eventId, subject, d, hm, extra = {}) => db.run(
  `INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, location, source) VALUES (?, ?, ?, ?, 0, 'busy', ?, ?, 'graph')`,
  [eventId, subject, `${d}T${hm}:00`, `${d}T${hm.slice(0, 2)}:45:00`, extra.attendeesOther ?? 1, extra.location ?? null]);

let before;
test.before(async () => {
  await db.init();
  // Before the write baseline: both simulated weeks' report to Chris recorded as sent (see the clock helper).
  clock.reportsSent([london(day(0), '12:30'), london(day(7), '12:30')]);
  // Three ordinary promises, so every bundle of a day has something left to offer (oldest first).
  for (const [text, daysAgo] of [['Nick to send Alex Reed the list of ticket types blocked by skill gaps', 34],
    ['Nick to write the onboarding guide for Sam Patel', 32], ['Nick to share the QA rubric with Casey Moore', 30]]) {
    const r = taskStore.createTask({ text, source: 'meeting-promotion', origin_path: 'Meetings/2026/09/2026-09-14 - Ops sync.md', due_date: ymd(Date.now() + 3 * DAY) });
    const id = (r.task || r).id;
    db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [new Date(Date.now() - daysAgo * DAY).toISOString().replace('T', ' ').slice(0, 19), id]);
    for (let i = 1; i <= 2; i += 1) taskStore.updateTask(id, { due_date: ymd(Date.now() + (3 + i) * DAY) });
  }
  shadow.registerPromiseShadow({ PROMISE_SHADOW_ENABLED: 'true' }, { schedule: () => ({ stop() {} }) });
  shadow._resetRuntime();
  before = fingerprint({ except: ['promise_shadow_log'] });
});
test.after(() => {
  assert.deepEqual(doors, [], `an outbound door was reached: ${doors.join(', ')}`);
  assert.deepEqual(calls.other, [], `an unexpected network call: ${calls.other.join(', ')}`);
});

test('Monday with discovery: 3 Now/presence reads — discovery shares the 07:30 read; 141 of 144 ticks never reach the ledger', async () => {
  const r = await runDay(day(0));
  assert.equal(r.ticks, 144);
  assert.deepEqual(r.readAt, ['07:10', '12:10', '17:10'], 'one read at the first tick of each bundle window');
  assert.equal(r.nowReads, 3); assert.equal(r.bundle, 3); assert.equal(r.meeting, 0);
  assert.equal(r.presence, 3, 'localhost:3005 calls equal Now reads');
  assert.equal(r.snapshots, 3, 'the ledger is read only on the bundle ticks');
  assert.equal(r.skipped, 141);
  assert.equal(rows('moment LIKE ?', ['discovery:%']).length, 1, 'discovery was evaluated (on the 07:30 read)');
});

test('plain weekday: exactly 3 Now/presence reads, one per bundle', async () => {
  const r = await runDay(day(1));
  assert.deepEqual(r.readAt, ['07:10', '12:10', '17:10']);
  assert.equal(r.nowReads, 3); assert.equal(r.presence, 3); assert.equal(r.snapshots, 3); assert.equal(r.skipped, 141);
});

test('a meeting with a promise still offerable: one read in its window — and the 17:30 bundle after the third offer needs none', async () => {
  cal('evt-casey', '1-2-1 Nick / Casey Moore', day(2), '14:00');
  const r = await runDay(day(2));
  assert.deepEqual(r.readAt, ['07:10', '12:10', '13:30'], 'Alex at 07:10, Sam at 12:10, Casey before her meeting; 17:10 is settled from history');
  assert.equal(r.nowReads, 3); assert.equal(r.meeting, 1); assert.equal(r.presence, 3);
  assert.equal(r.snapshots, 4, 'the meeting is inspected once — the next five ticks of its window are skipped');
  const m = rows('moment LIKE ?', [`meeting:%@${day(2)}T14:00`]);
  assert.equal(m.length, 1); assert.equal(m[0].kind, 'prompt');
  const w = rows('moment = ?', [`window:${day(2)}:2`])[0];
  assert.equal(w.reason, '3 promise prompts already today');
  assert.equal(JSON.parse(w.payload_json).canonicalNow, 'not_called');
});

test('a meeting with NO promise owed: one ledger read, no Now read', async () => {
  cal('evt-robin', 'Weekly catch-up with Robin Lee', day(3), '11:00');
  const r = await runDay(day(3));
  assert.deepEqual(r.readAt, ['07:10', '12:10', '17:10'], 'no read for the meeting');
  assert.equal(r.nowReads, 3); assert.equal(r.presence, 3);
  assert.equal(r.snapshots, 4, 'three bundles + one look at the meeting');
  assert.equal(rows('moment LIKE ?', [`meeting:%@${day(3)}T11:00`]).length, 0);
});

test('a solo block in the diary is not a meeting: no ledger read for it', async () => {
  cal('evt-solo', 'Focus: Alex Reed report', day(4), '10:00', { attendeesOther: 0 });
  const r = await runDay(day(4), { to: '11:55' });
  assert.equal(r.snapshots, 1, 'only the 07:30 bundle');
  assert.equal(r.nowReads, 1);
});

test('a CHANGED meeting is re-read once and safely: no duplicate moment, no Now read; restart costs one ledger read', async () => {
  const d = day(7);
  cal('evt-change', '1-2-1 Nick / Alex Reed', d, '15:00', { location: 'Room 1' });
  const r = await runDay(d, { from: '14:25', to: '14:55', before: {
    '14:40': () => db.run("UPDATE calendar_cache SET location = 'Room 2' WHERE event_id = 'evt-change'"),
    '14:50': () => shadow._resetRuntime(),
  } });
  assert.deepEqual(r.readAt, ['14:30'], 'one Now read — at the first tick of the window');
  assert.equal(r.presence, 1);
  assert.equal(rows('moment LIKE ?', [`meeting:%@${d}T15:00`]).length, 1, 'the moment is logged once, not again on change or restart');
  // 14:30 first look · 14:40 change → one re-read · 14:50 restart → one re-read · every other tick skipped.
  assert.equal(r.snapshots, 3);
  assert.equal(shadow.stats().meetingReinspections, 0, 'counters restart with the process');
  assert.equal(r.reinspect, 1, 'the change was recognised as a change to an inspected meeting');
});

test('a MOVED meeting is a new moment: logged, and settled from history without a Now read', async () => {
  const d = day(8);
  cal('evt-move', '1-2-1 Nick / Alex Reed', d, '10:00');
  const r = await runDay(d, { from: '09:25', to: '09:55', before: {
    '09:40': () => db.run("UPDATE calendar_cache SET start_time = ?, end_time = ? WHERE event_id = 'evt-move'", [`${d}T10:20:00`, `${d}T10:45:00`]),
  } });
  assert.deepEqual(r.readAt, ['09:30'], 'the new time is settled from history — Alex was offered at 09:30');
  assert.equal(r.presence, 1);
  assert.equal(rows('moment LIKE ?', [`meeting:%@${d}T10:00`]).length, 1);
  const moved = rows('moment LIKE ?', [`meeting:%@${d}T10:20`]);
  assert.equal(moved.length, 1); assert.equal(moved[0].reason, 'already offered earlier today');
  assert.equal(JSON.parse(moved[0].payload_json).canonicalNow, 'not_called');
});

test('an event with no source id is never remembered — inspected while due, still no duplicate moment or extra Now read', async () => {
  const d = day(9);
  db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other) VALUES (NULL, ?, ?, ?, 0, 'busy', 1)`,
    ['1-2-1 Nick / Alex Reed', `${d}T16:00:00`, `${d}T16:30:00`]);
  const r = await runDay(d, { from: '15:25', to: '15:55' });
  assert.equal(r.nowReads, 1); assert.equal(r.presence, 1);
  assert.equal(r.noId, 6, 'counted every time it was due');
  assert.equal(rows('moment LIKE ?', [`meeting:%@${d}T16:00`]).length, 1);
});

test('world-model meetings: identity is provider + event id + start; a participant change is a re-read', () => {
  const d = day(10);
  const ins = (id, ev) => db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, status, kind, provenance_kind,
    observed_at, received_at, evidence_json, fingerprint, updated_at) VALUES (?, 'graph', ?, 'Planning', ?, ?, 'scheduled', 'meeting', 'calendar', 'x', 'x', '{}', 'fp1', 'u1')`,
  [id, ev, `${d}T11:00`, `${d}T11:30`]);
  ins('graph:wm-1', 'wm-1');
  db.run(`INSERT INTO wm_meeting_participants (meeting_id, email, response) VALUES ('graph:wm-1', 'robin.lee@nurtur.tech', 'none')`);
  const now = london(d, '10:40');
  const a = shadow.dueMeetings(now).meetings.find((m) => m.source === 'world-model');
  assert.equal(a.key, `wm:graph:wm-1@${d}T11:00`, 'keyed by the source event id and start — not the title');
  db.run("UPDATE wm_meeting_participants SET response = 'accepted' WHERE meeting_id = 'graph:wm-1'");
  const b = shadow.dueMeetings(now).meetings.find((m) => m.source === 'world-model');
  assert.equal(b.key, a.key); assert.notEqual(b.marker, a.marker, 'a participant change changes the marker');
  db.run("UPDATE wm_meetings SET title = 'Planning (renamed)' WHERE meeting_id = 'graph:wm-1'");
  assert.equal(shadow.dueMeetings(now).meetings.find((m) => m.source === 'world-model').marker, b.marker, 'a title-only rename with no fingerprint change is not a re-read');
  db.run("DELETE FROM wm_meeting_participants"); db.run("DELETE FROM wm_meetings");
});

test('calendar events: identity is the source event id + start, NOT the title; a rename or another meeting with the same title and time are told apart', () => {
  const d = day(11);
  cal('evt-x1', 'Ops sync', d, '13:00');
  cal('evt-x2', 'Ops sync', d, '13:00');
  const now = london(d, '12:40');
  const ms = shadow.dueMeetings(now).meetings.filter((m) => m.source === 'calendar' && m.start === `${d}T13:00`);
  assert.deepEqual(ms.map((m) => m.key).sort(), [`cc:graph:evt-x1@${d}T13:00`, `cc:graph:evt-x2@${d}T13:00`], 'same title and time, two identities');
  db.run("UPDATE calendar_cache SET subject = 'Ops sync (moved room)' WHERE event_id = 'evt-x1'");
  const after = shadow.dueMeetings(now).meetings.find((m) => m.key === `cc:graph:evt-x1@${d}T13:00`);
  assert.ok(after, 'a rename keeps the identity');
  assert.notEqual(after.marker, ms.find((m) => m.key === after.key).marker, 'and changes the marker, so it is re-read');
  db.run("DELETE FROM calendar_cache WHERE event_id IN ('evt-x1', 'evt-x2')");
});

test('across every simulated day: nothing outside promise_shadow_log was written; presence calls === Now reads', () => {
  const after = fingerprint({ except: ['promise_shadow_log', 'calendar_cache', 'wm_meetings', 'wm_meeting_participants'] });
  const base = { ...before }; for (const t of ['calendar_cache', 'wm_meetings', 'wm_meeting_participants']) delete base[t];
  assert.deepEqual(after, base, 'no table but the shadow log (and the test’s own calendar fixtures) changed');
  for (const t of ['runtime_job_runs', 'event_log', 'prepared_actions', 'push_log', 'attention_records', 'attention_events']) {
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM "${t}"`).n, 0, `${t} untouched`);
  }
  assert.equal(db.getState('room_episode_state'), null);
  const hb = rows("kind = 'heartbeat'").filter((r) => JSON.parse(r.payload_json || '{}').counters);
  assert.ok(hb.length > 0, 'heartbeats carry the counters');
  assert.ok(shadow.report().counters, 'the report shows the counters');
});

test('the pre-check reads only the clock, the shadow log and the two calendar tables', () => {
  const src = fs.readFileSync(path.join(__dirname, 'promise-shadow.js'), 'utf8');
  // Each body runs from its declaration to the next top-level declaration or section rule.
  const body = (name) => {
    const i = src.indexOf(`function ${name}(`);
    const rest = src.slice(i + 1); const j = rest.search(/\n(?:async )?function |\nconst |\nlet |\n\/\/ ──/);
    return src.slice(i, i + 1 + j);
  };
  const pre = body('dueCheck') + body('dueMeetings') + body('_remember');
  assert.match(pre, /SELECT[\s\S]*calendar_cache/, 'positive control: the bodies were found');
  assert.doesNotMatch(pre, /observe\.|snapshot\(|readNow|canonical-read|room-presence|fetch\(|require\(/);
  const tables = [...pre.matchAll(/FROM\s+([A-Za-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ['calendar_cache', 'wm_meeting_participants', 'wm_meetings']);
  assert.match(pre, /_seen\(/, 'and the shadow log, through _seen');
});
