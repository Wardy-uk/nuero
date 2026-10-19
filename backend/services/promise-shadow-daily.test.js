'use strict';

/**
 * Once per promise per London day — the shadow against production (19 Oct 2026).
 *
 *   run: node --test backend/services/promise-shadow-daily.test.js
 *
 * The shadow reconstructs what it has offered from its own append-only log
 * (never memory), and the policy refuses a promise already offered on the same
 * London calendar day at ANY moment. Every shadow decision here is checked
 * against an INDEPENDENT reconstruction of what production would decide: the
 * production selector (observe.feedFor + the policy) fed a history read from
 * the log by this file's own code. Cases: bundle → pre-meeting, pre-meeting →
 * moved meeting (+ a rename), restart mid-day, two distinct promises, next-day
 * eligibility, the London date boundary, and the employment matter untouched.
 * People are pseudonyms.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pdaily-'));
process.env.NEURO_DB_PATH = path.join(tmp, 's.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'HA_TOKEN', 'HA_URL', 'PROMISE_SHADOW_ENABLED', 'SAIM_BASE_URL']) delete process.env[k];

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Alex Reed.md', '---\nemail: alex.reed@nurtur.tech\n---\n');
put('People/Sam Patel.md', '---\nemail: sam.patel@nurtur.tech\n---\n');
put('People/Jordan Kay.md', '---\nemail: jordan.kay@nurtur.tech\n---\n');
put('Meetings/2026/09/2026-09-14 - Ops sync.md', '- Nick to send Alex Reed the list of ticket types blocked by skill gaps\n- Nick to write the onboarding guide for Sam Patel\n');
put('Meetings/2026/09/2026-09-22 - Jordan Kay 1-2-1.md', '- Nick to agree the outcome of Jordan Kay\'s flexible working request\n');

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
const observe = require('./promise-observe');
const policy = require('../../saim/policy/promises.cjs');
const SC = require('./saim-policy-scenarios');
let shadow = require('./promise-shadow');

const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const lday = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
function london(d, hm) {
  for (const off of [0, 1]) {
    const ms = Date.parse(`${d}T${hm}:00Z`) - off * 3600000;
    if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16) === hm) return ms;
  }
  throw new Error('bad time');
}
let d0 = Date.now() + DAY;
while (new Date(`${lday(d0)}T12:00:00Z`).getUTCDay() !== 1) d0 += DAY;
const day = (n) => lday(d0 + n * DAY); // 1 Tue … 4 Fri
const STEADY = async () => { const { decision, candidates, payload } = SC.build({ now: SC.at(12, 30), surface: 'work-desktop' }); return { ...payload, saim: decision, candidates }; };

const P = {};
function task(text, daysAgo, note = 'Meetings/2026/09/2026-09-14 - Ops sync.md') {
  const r = taskStore.createTask({ text, source: 'meeting-promotion', origin_path: note, due_date: ymd(Date.now() + 3 * DAY) });
  const id = (r.task || r).id;
  db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [new Date(Date.now() - daysAgo * DAY).toISOString().replace('T', ' ').slice(0, 19), id]);
  for (let i = 1; i <= 2; i += 1) taskStore.updateTask(id, { due_date: ymd(Date.now() + (3 + i) * DAY) });
  return `promise:${id}`;
}
const rows = (where = '1=1', params = []) => db.all(`SELECT * FROM promise_shadow_log WHERE ${where} ORDER BY id`, params);
const cal = (id, subject, d, hm) => db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, attendees_other, source) VALUES (?, ?, ?, ?, 0, 'busy', 1, 'graph')`,
  [id, subject, `${d}T${hm}:00`, `${d}T${hm.slice(0, 2)}:59:00`]);

/** What production would decide now — history read from the log by THIS file's code, not the shadow's. */
async function production(nowMs) {
  const prompted = db.all("SELECT at, moment, promise_key FROM promise_shadow_log WHERE kind = 'prompt' AND decision = 'would-prompt' ORDER BY id")
    .map((r) => ({ key: r.promise_key, at: r.at /* the instant, UTC — the policy dates it in London */, meetingKey: r.moment.startsWith('meeting:') ? r.moment.slice(8) : null }));
  const payload = await STEADY();
  const ctx = observe.promiseFeedContext(payload, { now: nowMs });
  const feed = observe.feedFor({ ctx, promises: observe.snapshot({ now: nowMs }).promises, now: nowMs, prompted, goalAccepted: true });
  return feed.promise ? feed.promise.key : null;
}
/** One shadow tick, checked against production: the promise it would show must be the one production would show. */
async function tickParity(d, hm) {
  const nowMs = london(d, hm);
  const expected = await production(nowMs);
  const id0 = (db.get('SELECT COALESCE(MAX(id), 0) AS m FROM promise_shadow_log') || {}).m || 0; const s0 = shadow.stats();
  const res = await shadow.tick({ now: nowMs, readNow: STEADY });
  const added = rows('id > ?', [id0]).filter((r) => r.kind !== 'heartbeat');
  const shown = added.filter((r) => r.kind === 'prompt').map((r) => r.promise_key);
  if (res.read !== 'failed') assert.deepEqual(shown, expected ? [expected] : [], `${d} ${hm}: the shadow showed ${JSON.stringify(shown)}, production would show ${expected}`);
  return { added, shown, expected, nowRead: shadow.stats().nowReads - s0.nowReads };
}

test.before(async () => {
  await db.init();
  P.alex = task('Nick to send Alex Reed the list of ticket types blocked by skill gaps', 34);
  P.sam = task('Nick to write the onboarding guide for Sam Patel', 30);
  P.hr = task('Nick to agree the outcome of Jordan Kay\'s flexible working request', 26, 'Meetings/2026/09/2026-09-22 - Jordan Kay 1-2-1.md');
  shadow.registerPromiseShadow({ PROMISE_SHADOW_ENABLED: 'true' }, { schedule: () => ({ stop() {} }) });
  shadow._resetRuntime();
});
test.after(() => assert.deepEqual(doors, [], `an outbound door was reached: ${doors.join(', ')}`));

test('the policy: once per promise per LONDON day, at any moment — and a different promise is still allowed', () => {
  const alex = { key: 'promise:1', owedTo: { resolved: 'Alex Reed' }, nextMeeting: { start: '2026-10-21T10:00', title: '1-2-1' } };
  const at0930 = Date.parse('2026-10-21T08:30:00Z'); // 09:30 BST, 30 min before the meeting
  assert.equal(policy.mayPromptPromise({ now: at0930, promise: alex }).ok, true, 'positive control: the meeting window is open');
  // Offered at 00:30 BST on the 21st — a UTC stamp that still reads the 20th.
  const r = policy.mayPromptPromise({ now: at0930, promise: alex, prompted: [{ key: 'promise:1', at: '2026-10-20T23:30:00Z' }] });
  assert.equal(r.ok, false); assert.equal(r.why, 'already offered earlier today');
  // 23:30 BST on the 20th is yesterday in London: eligible again.
  assert.equal(policy.mayPromptPromise({ now: at0930, promise: alex, prompted: [{ key: 'promise:1', at: '2026-10-20T22:30:00Z' }] }).ok, true);
  // A wall-clock stamp is read as written.
  assert.equal(policy.mayPromptPromise({ now: at0930, promise: alex, prompted: [{ key: 'promise:1', at: '2026-10-21T07:30' }] }).why, 'already offered earlier today');
  // Another promise was offered today: this one is still allowed.
  assert.equal(policy.mayPromptPromise({ now: at0930, promise: alex, prompted: [{ key: 'promise:2', at: '2026-10-21T07:30' }] }).ok, true);
  assert.equal(policy.localDateOf('2026-10-20T23:30:00Z'), '2026-10-21');
  assert.equal(policy.localDateOf('2026-12-20T23:30:00Z'), '2026-12-20', 'GMT: no shift');
});

test('the selector takes the next promise not yet offered — no rotation that skips one nobody has seen', () => {
  const mk = (n) => ({ key: `promise:${n}`, firstSeen: `2026-09-0${n}`, sensitive: false, closed: false, owedTo: { resolved: null }, judgement: { state: 'slipped', moves: 2 } });
  const ps = [mk(1), mk(2), mk(3)];
  const at = (hm) => london('2026-10-20', hm);
  const shown = [];
  for (const hm of ['07:30', '12:30', '17:30']) {
    const s = observe.selectPrompt({ promises: ps, ctx: {}, now: at(hm), prompted: shown.map((k) => ({ key: k, at: `2026-10-20T${hm}` })) });
    shown.push(s.pick.p.key);
  }
  assert.deepEqual(shown, ['promise:1', 'promise:2', 'promise:3'], 'three bundles, three different promises, none skipped');
});

test('bundle → pre-meeting, and two distinct promises: Alex at 07:30, Sam at 12:30, Alex’s 14:00 meeting suppressed', async () => {
  const d = day(1);
  cal('evt-a1', '1-2-1 Nick / Alex Reed', d, '14:00');
  const b1 = await tickParity(d, '07:30');
  assert.deepEqual(b1.shown, [P.alex], 'the older promise first');
  const b2 = await tickParity(d, '12:30');
  assert.deepEqual(b2.shown, [P.sam], 'a different promise may still be shown the same day');
  const m = await tickParity(d, '13:30');
  assert.equal(m.nowRead, 0, 'settled from history — no context could make it offerable');
  assert.equal(JSON.parse(m.added[0].payload_json).canonicalNow, 'not_called');
  assert.equal(m.added.length, 1); assert.equal(m.added[0].kind, 'suppression');
  assert.equal(m.added[0].reason, 'already offered earlier today');
  assert.equal(m.added[0].promise_key, P.alex);
  assert.equal(JSON.parse(m.added[0].payload_json).offeredAtMoment, 'bundle');
  const b3 = await tickParity(d, '17:30');
  assert.deepEqual(b3.shown, [], 'both offered: nothing left for 17:30');
  assert.match(b3.added.find((r) => r.moment.startsWith('window:')).reason, /already offered earlier today/);
});

test('next London day: Alex is eligible again — here at a pre-meeting moment; then the MOVED meeting is logged and suppressed; a rename adds nothing', async () => {
  const d = day(2);
  cal('evt-a2', '1-2-1 Nick / Alex Reed', d, '10:00');
  const m1 = await tickParity(d, '09:30');
  assert.deepEqual(m1.shown, [P.alex], 'yesterday’s offer does not count today');
  assert.equal(m1.added.find((r) => r.kind === 'prompt').moment, `meeting:Alex Reed@${d}T10:00`);
  db.run("UPDATE calendar_cache SET start_time = ?, end_time = ? WHERE event_id = 'evt-a2'", [`${d}T10:30:00`, `${d}T10:59:00`]);
  const m2 = await tickParity(d, '10:00');
  assert.equal(m2.nowRead, 0, 'the moved meeting is a new moment, settled from history');
  assert.equal(m2.added.length, 1);
  assert.equal(m2.added[0].moment, `meeting:Alex Reed@${d}T10:30`);
  assert.equal(m2.added[0].kind, 'suppression'); assert.equal(m2.added[0].reason, 'already offered earlier today');
  assert.equal(JSON.parse(m2.added[0].payload_json).offeredAtMoment, `meeting:Alex Reed@${d}T10:00`);
  db.run("UPDATE calendar_cache SET subject = '1-2-1 Nick / Alex Reed (moved)' WHERE event_id = 'evt-a2'");
  const m3 = await tickParity(d, '10:05');
  assert.equal(m3.added.length, 0, 'a renamed meeting at the same time is the same moment — nothing new');
  assert.equal(m3.nowRead, 0);
  assert.equal(rows("kind = 'prompt' AND promise_key = ? AND at >= ?", [P.alex, new Date(london(d, '00:00')).toISOString()]).length, 1, 'Alex shown exactly once today');
});

test('restart mid-day: a fresh process reads the day’s offers back from the log', async () => {
  const d = day(3);
  cal('evt-a3', '1-2-1 Nick / Alex Reed', d, '15:00');
  const b1 = await tickParity(d, '07:30');
  assert.deepEqual(b1.shown, [P.alex]);
  // A new process: every module that could hold memory is loaded afresh.
  for (const m of ['./promise-shadow', './promise-observe', './promise-ledger', '../../saim/policy/promises.cjs']) delete require.cache[require.resolve(m)];
  shadow = require('./promise-shadow');
  assert.equal(shadow.stats().ticks, 0, 'positive control: this is a fresh module');
  const b2 = await tickParity(d, '12:30');
  assert.deepEqual(b2.shown, [P.sam], 'not Alex again after the restart');
  const m = await tickParity(d, '14:30');
  assert.equal(m.added[0].reason, 'already offered earlier today');
  assert.equal(m.added[0].promise_key, P.alex);
});

test('two moments in ONE tick (a 12:45 meeting inside the 12:30 bundle): the promise is offered once, the second moment sees the first', async () => {
  const d = day(4);
  cal('evt-a4', '1-2-1 Nick / Alex Reed', d, '12:45');
  const t = await tickParity(d, '12:20');
  assert.equal(t.nowRead, 1, 'one read serves both moments');
  assert.deepEqual(t.shown, [P.alex], 'Alex once — not once per moment');
  const meet = t.added.find((r) => r.moment === `meeting:Alex Reed@${d}T12:45`);
  assert.equal(meet.kind, 'suppression'); assert.equal(meet.reason, 'already offered earlier today');
});

test('the employment matter is routed (task ids + rule only) once a day and never offered, unchanged by any of this', () => {
  const routed = rows("kind = 'routing'");
  assert.equal(routed.length, 4, 'one routing row per day the pass ran');
  for (const r of routed) assert.deepEqual(JSON.parse(r.payload_json), { taskIds: [Number(P.hr.split(':')[1])], rule: 'hr-wording' });
  assert.equal(rows("kind IN ('prompt','suppression') AND promise_key = ?", [P.hr]).length, 0);
  assert.doesNotMatch(rows().map((r) => `${r.moment} ${r.reason} ${r.payload_json}`).join('\n'), /flexible|Jordan|Kay/i);
});

test('no moment is logged twice, and the counters record each suppression for an earlier offer', () => {
  const dup = db.all("SELECT moment, COUNT(*) n FROM promise_shadow_log WHERE kind IN ('prompt','suppression','proposal') GROUP BY moment HAVING n > 1");
  assert.deepEqual(dup, []);
  // Four meeting moments, plus day 1's 17:30 bundle — settled from history, so it carries the policy's own words.
  assert.equal(rows("reason = 'already offered earlier today'").length, 5);
  assert.equal(shadow.stats().alreadyOffered >= 1, true, 'counted (this process: since the simulated restart)');
});
