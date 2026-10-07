'use strict';

/**
 * Meeting intelligence — one semantic finding per meeting (Build 5A).
 *
 *   run: node --test backend/services/meeting-intelligence.test.js
 *
 * Real projection, real commitment-risk, real old meeting-prep beside the new
 * pipeline. Web push is stubbed to COUNT: the old path is still live and is
 * allowed exactly its one send; the new path is allowed none.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mi-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'mi.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
delete process.env.MEETING_PREP_MODE;
delete process.env.COMMITMENT_RISK_MODE;
fs.mkdirSync(path.join(VAULT, 'People'), { recursive: true });

const pushes = [];
const webpushId = require.resolve('./webpush');
require.cache[webpushId] = { id: webpushId, filename: webpushId, loaded: true,
  exports: { sendToAll: async (...a) => { pushes.push(a); }, isConfigured: () => true } };
let calendarToday = [];
const msId = require.resolve('./microsoft');
require.cache[msId] = { id: msId, filename: msId, loaded: true, exports: {
  fetchCalendarEvents: async () => calendarToday, getSignedInAddress: async () => 'nickw@nurtur.tech',
  getAccessToken: async () => null, fetchSentMail: async () => ({ messages: [], complete: true }) } };

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const cr = require('./commitment-risk');
const mi = require('./meeting-intelligence');
const prep = require('./meeting-prep');

test.before(async () => { await db.init(); });

// Monday 5 Oct 2026, 08:40 London (07:40Z). Tech Leadership at 09:00 — 20 min.
const NOW = Date.parse('2026-10-05T07:40:00Z');
let seq = NOW;
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
async function reconcile() { seq += 1000; src.reconcile({ now: seq }); await pump(); }

const NOTE = 'Meetings/2026/09/2026-09-28 – Tech leadership.md';
const moment = { now: new Date(NOW), known: true, inMeeting: false, quiet: false, onDuty: true, focusMode: false,
  moving: false, driving: false, atLaptop: true, atDesk: true, inFocusSession: false, muted: [] };
const asks = [];
const MI_DEPS = {
  self: ['nickw@nurtur.tech'],
  flaggedEmails: () => ({ lastScan: '2026-10-05T07:00:00Z', items: [] }),
  readMoment: async () => ({ moment }),
};
const CR_DEPS = { calendarFreshness: () => 'fresh', laneDeferral: () => null, refreshProgress: null, readMoment: async () => ({ moment }) };
const EVENT = { id: 'TL-1005', subject: 'Tech Leadership with Hope', start: '2026-10-05T09:00:00', end: '2026-10-05T10:00:00', showAs: 'busy',
  responseStatus: 'accepted', organizerEmail: 'chris.middleton@nurtur.tech', organizer: 'Chris Middleton', attendeesOther: true,
  attendees: [{ name: 'Hope Goodall', email: 'hope.goodall@nurtur.tech', status: 'accepted' }] };

function declare(name, email) {
  const p = ws.personPayload(name, `People/${name}.md`, email ? { email } : {});
  bus.publishEvent({ type: 'observation.person.declared', occurredAt: new Date(NOW).toISOString(), source: { system: 'vault' },
    idempotencyKey: `pd:${p.personId}:${p.fingerprint}`, payload: p });
}

let MINE; let DEADLINE;
test.before(async () => {
  declare('Nick Ward');
  declare('Hope Goodall', 'hope.goodall@nurtur.tech');
  declare('Chris Middleton', 'chris.middleton@nurtur.tech');
  // People notes, for the OLD path's name-substring match.
  fs.writeFileSync(path.join(VAULT, 'People', 'Hope Goodall.md'), '---\nrole: Team Lead\nlast-1-2-1: 2026-09-30\n---\nRuns QA.\n');
  db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, source, first_seen)
          VALUES ('TL-0928', '2026-09-28T09:00:00', '2026-09-28T10:00:00', 'Tech Leadership with Hope', 0, 'busy', 1, 'graph', 'x')`);
  fs.mkdirSync(path.join(VAULT, 'Meetings', '2026', '09'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, NOTE), '---\nstart_at: "2026-09-28T08:03:00"\n---\n');
  MINE = 9500;
  db.run(`INSERT INTO tasks (id, text, status, source, dedupe_key, created_at, origin_path) VALUES (?, 'Nick to send the support figures', 'open', 'meeting-promotion', 'kmine', '2026-09-28 11:00:00', ?)`, [MINE, NOTE]);
  // A commitment from the same write-up that ALSO has a stated deadline today: it matters on its own.
  DEADLINE = 9501;
  db.run(`INSERT INTO tasks (id, text, status, source, dedupe_key, created_at, origin_path, due_date) VALUES (?, 'Nick to confirm the rota by 2026-10-05', 'open', 'meeting-promotion', 'kdl', '2026-09-28 11:00:00', ?, '2026-10-05')`, [DEADLINE, NOTE]);
  ws.publishCalendarWindow({ provider: 'graph', now: NOW, events: [EVENT], window: { fromLocal: '2026-10-05T00:00', toLocal: '2026-10-06T23:59' } });
  await pump();
  await reconcile();
});

test('2/3/4. one meeting → ONE finding; the meeting-only risk is LINKED (not restated) and asks attention once, here', async () => {
  const r1 = await cr.evaluate({ now: NOW, deps: CR_DEPS });
  assert.ok(r1.created >= 1);
  const mineRisk = db.get(`SELECT * FROM commitment_risk_findings WHERE commitment_id = ? AND status = 'active'`, [`commitment:task:${MINE}`]);
  const dlRisk = db.get(`SELECT * FROM commitment_risk_findings WHERE commitment_id = ? AND status = 'active'`, [`commitment:task:${DEADLINE}`]);
  assert.ok(mineRisk && dlRisk, 'positive control: both commitments are at risk');
  assert.ok(JSON.parse(mineRisk.triggers_json).every((t) => t.kind === 'meeting-near'));

  const r = await mi.evaluate({ now: NOW, deps: MI_DEPS });
  assert.equal(r.created, 1);
  const rows = db.all('SELECT * FROM meeting_intelligence_findings');
  assert.equal(rows.length, 1, 'one meeting, one finding');
  assert.equal(db.get('SELECT COUNT(*) n FROM meeting_context_findings').n, 0, 'the superseded meeting-context path wrote nothing');
  const f = mi.findings()[0];
  // 3. the meeting-only risk is linked on its item, not listed a second time
  const mine = f.sections.yourActions.find((x) => x.taskId === MINE);
  assert.equal(mine.atRiskFindingId, mineRisk.finding_id);
  assert.deepEqual(f.sections.atRiskOther, []);
  assert.deepEqual(f.linked.here.map((l) => l.findingId), [mineRisk.finding_id]);
  // The deadline risk matters on its own: linked elsewhere, never counted here.
  assert.deepEqual(f.linked.elsewhere.map((l) => l.findingId), [dlRisk.finding_id]);
  assert.ok(f.triggers.includes('linked-commitment-risk'));
  // 4. attention: the meeting finding was asked; commitment-risk DEFERRED its meeting-only question.
  assert.equal(f.attention.shadow, true);
  assert.equal(f.attention.sent, false);
  const deferred = JSON.parse(db.get('SELECT attention_json FROM commitment_risk_findings WHERE finding_id = ?', [mineRisk.finding_id]).attention_json);
  assert.equal(deferred.deferredTo, 'meeting-intelligence');
  assert.equal(deferred.push, false);
  const own = JSON.parse(db.get('SELECT attention_json FROM commitment_risk_findings WHERE finding_id = ?', [dlRisk.finding_id]).attention_json);
  assert.equal(own.deferredTo, undefined, 'a deadline risk is still asked on its own');
  // A re-pass changes nothing and asks nothing again.
  const again = await mi.evaluate({ now: NOW + 60000, deps: MI_DEPS });
  assert.equal(again.created + again.decided, 0);
  assert.equal(pushes.length, 0, 'the new pipeline sent nothing');
});

test('a prior action that progress evidence says is LIKELY DONE does not make a finding on its own', () => {
  const meeting = { meetingId: 'graph:X', title: 'Weekly', start: '2026-10-05T09:00', people: [] };
  const gathered = { evidence: { previous: null, commitments: [{ taskId: 1, text: 'Nick to send X' }], owedFromPrevious: [], emails: [], attendeeOwed: [], otherEmails: 0 }, missing: [] };
  const deps = { risks: [], waitingIdOf: (k) => k, preparedOf: () => null };
  const open = mi.compose(meeting, gathered, { ...deps, progressOf: () => ({ state: 'no_evidence', reasons: [] }) });
  assert.deepEqual(open.triggers, ['open-commitments-from-previous'], 'positive control');
  const done = mi.compose(meeting, gathered, { ...deps, progressOf: () => ({ state: 'likely_fulfilled', reasons: ['sent'] }) });
  assert.deepEqual(done.triggers, []);
  assert.equal(done.sections.yourActions[0].progress.state, 'likely_fulfilled', 'still listed, marked');
});

test('1/5. the old live push and the new pipeline are COMPARED for the same meeting — and only the old one sends', async () => {
  // Build 17U: legacy prep is RETIRED by default; MEETING_PREP_MODE=live is the way back, and is what this test exercises.
  assert.equal(prep.prepMode(), 'retired', 'retired by default');
  process.env.MEETING_PREP_MODE = 'live';
  calendarToday = [EVENT];
  try { await prep.checkUpcomingMeetings({ now: new Date(NOW) }); } finally { delete process.env.MEETING_PREP_MODE; }
  assert.equal(pushes.length, 1, 'old meeting-prep is still LIVE: exactly its one push');
  assert.equal(pushes[0][2].type, 'meeting_prep');
  // The new side records its answer for the same occurrence.
  await mi.evaluate({ now: NOW + 120000, deps: MI_DEPS });
  const row = db.get(`SELECT * FROM meeting_prep_comparisons WHERE meeting_key = 'graph:TL-1005@2026-10-05T09:00'`);
  assert.ok(row && row.old_json && row.new_json, 'both sides recorded against ONE key');
  const c = mi.classifyComparison(row);
  assert.equal(c.kind, 'both');
  assert.equal(JSON.parse(row.old_json).sent, true);
  assert.equal(pushes.length, 1, 'still one push: the new pipeline never sends');
  // 5. one day of comparisons does not prove parity, so the old path stays live.
  const v = mi.parity({ now: NOW });
  assert.equal(v.retireSafe, false);
  assert.match(v.reasons.join(' '), /day/);
});

test('6. parity CAN be proven — and when retired, meeting-prep records but never sends', async () => {
  const row = (day, oldSaid, newSaid, people = ['Hope Goodall']) => ({ meeting_key: `k${day}`, title: 'T', start_local: `2026-10-0${day}T09:00`,
    old_json: JSON.stringify({ wouldNotify: oldSaid, matchedPeople: people }), new_json: JSON.stringify({ finding: newSaid }) });
  const good = [row(5, true, true), row(6, false, false), row(7, true, false, ['Nick Ward']), row(8, false, true), row(9, true, true)];
  const ok = mi.parityVerdict(good);
  assert.equal(ok.retireSafe, true, ok.reasons.join('; '));
  assert.equal(ok.counts.oldOnlySelfMatch, 1, 'the old path matching Nick\'s own name is not a lost capability');
  const lost = mi.parityVerdict([...good, row(9, true, false)]);
  assert.equal(lost.retireSafe, false, 'one meeting where only the old push said something blocks retirement');
  // Retired: the comparison is still written; the push is not.
  process.env.MEETING_PREP_MODE = 'retired';
  try {
    const before = pushes.length;
    calendarToday = [{ ...EVENT, id: 'TL-1005b' }];
    await prep.checkUpcomingMeetings({ now: new Date(NOW) });
    assert.equal(pushes.length, before, 'retired: nothing sent');
    const r = db.get(`SELECT old_json FROM meeting_prep_comparisons WHERE meeting_key = 'graph:TL-1005b@2026-10-05T09:00'`);
    const o = JSON.parse(r.old_json);
    assert.equal(o.wouldNotify, true);
    assert.equal(o.sent, false);
    assert.equal(o.mode, 'retired');
  } finally { delete process.env.MEETING_PREP_MODE; }
});

test('MEETING_INTELLIGENCE_MODE=off does nothing; "live" reads as shadow; the module has no route to a send', async () => {
  process.env.MEETING_INTELLIGENCE_MODE = 'off';
  assert.equal((await mi.evaluate({ now: NOW, deps: MI_DEPS })).considered, 0);
  process.env.MEETING_INTELLIGENCE_MODE = 'live';
  assert.equal(mi.mode(), 'shadow');
  delete process.env.MEETING_INTELLIGENCE_MODE;
  const s = fs.readFileSync(path.join(__dirname, 'meeting-intelligence.js'), 'utf8');
  assert.doesNotMatch(s, /\b(sendToAll|queueAction|graphWrite|sendMail|sendDm)\s*\(/, 'no call to a sender');
  assert.doesNotMatch(s, /require\(['"]\.\/(webpush|email-sender|teams|microsoft)['"]\)/, 'no sender imported');
  assert.match(s, /worthInterrupting/, 'positive control: it does ask the policy');
});
