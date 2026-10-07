'use strict';

/**
 * Build 16 (7 Oct 2026) — native reliability, meeting convergence, hiking
 * evidence, Activity quality. Fixtures are the shapes measured on the live Pi
 * that day: Nick's Team Standup flipped to `free` on 6 Oct (he organises it,
 * 14 people), KPI Meet (someone else's broadcast, marked free by its organiser),
 * "Take a break" (solo, free), 0-step days with distance present, the 19 Sep
 * 18,122-step Saturday, and overnight phone-quiet episodes in pairs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b16-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'b16.db');
process.env.NEURO_TIMEZONE = 'Europe/London';

const db = require('../db/database');
const cs = require('./context-state');
const ne = require('./native-events');
const tl = require('./activity-timeline');
const mi = require('./meeting-intelligence');
const mp = require('./meeting-prep');
const loop = require('./hiking-loop');
const wm = require('./world-model');

test.before(async () => { await db.init(); });

// ── 16I: free is availability, not absence ───────────────────────────────────

const standup = { showAs: 'free', attendeesOther: true, isOrganizer: true, start: '2026-10-07T09:15:00', end: '2026-10-07T09:30:00', subject: 'Team Standup' };
const kpi = { ...standup, subject: 'KPI Meet', isOrganizer: false };
const brk = { ...standup, subject: 'Take a break', attendeesOther: false };

test('13. a free meeting Nick organises with other people in it is still a meeting', () => {
  assert.equal(cs.heldDespiteFree(standup), true);
  assert.equal(cs.isRealMeeting(standup), true);
  const ctx = cs.resolveContext({ calendar: { known: true, events: [standup] } }, new Date('2026-10-07T08:20:00Z'));
  assert.equal(ctx.activity, 'in-meeting', 'SAiM goes quiet in the standup again');
});

test('14. a truly ignorable free entry stays ignored — someone else\'s broadcast, a solo break, an unknown organiser', () => {
  for (const ev of [kpi, brk, { ...standup, isOrganizer: null }, { ...standup, attendeesOther: null }]) {
    assert.equal(cs.heldDespiteFree(ev), false, ev.subject);
    assert.equal(cs.isRealMeeting(ev), false, ev.subject);
  }
  // Positive control: a BUSY meeting is unaffected by the new rule.
  assert.equal(cs.isRealMeeting({ ...kpi, showAs: 'busy' }), true);
});

test('the world model admits the free standup and still drops the free broadcast', () => {
  const now = Date.parse('2026-10-07T07:00:00Z');
  const row = (id, title, organiser, kind) => db.run(`INSERT OR REPLACE INTO wm_meetings (meeting_id, provider, provider_event_id, title, start_local, end_local, is_all_day, show_as, status,
      is_organizer, kind, provenance_kind, observed_at, received_at, evidence_json, updated_at) VALUES (?, 'graph', ?, ?, '2026-10-07T09:15', '2026-10-07T09:30', 0, 'free', 'scheduled', ?, ?, 'observation', 'x', 'x', '[]', 'x')`,
  [id, id, title, organiser, kind]);
  row('graph:standup', 'Team Standup', 1, 'meeting');
  row('graph:kpi', 'KPI Meet', 0, 'meeting');
  row('graph:break', 'Take a break', 1, 'block');
  const titles = wm.nextMeetings({ now, limit: 10 }).map((m) => m.title);
  assert.ok(titles.includes('Team Standup'));
  assert.ok(!titles.includes('KPI Meet'));
  assert.ok(!titles.includes('Take a break'));
});

test('the day planner and the agenda ask the SAME predicate (no third copy of the rule)', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert.match(src('day-planner.js'), /heldDespiteFree\(/);
  assert.match(src('attention.js'), /heldDespiteFree\(e\)/);
  assert.match(src('world-model.js'), /kind = 'meeting' AND is_organizer = 1/);
});

// ── 16H/K: parity and the still-live legacy path ─────────────────────────────

test('parity: an old-side "no" on a meeting the new side never evaluated is agreement, not a gap', () => {
  const c = mi.classifyComparison({ meeting_key: 'k', title: 'KPI Meet', start_local: '2026-10-07T09:15', old_json: JSON.stringify({ wouldNotify: false }), new_json: null });
  assert.equal(c.kind, 'neither');
  // Positive control: an old-side YES with no new record still blocks.
  const d = mi.classifyComparison({ meeting_key: 'k', title: 'X', start_local: '2026-10-07T09:15', old_json: JSON.stringify({ wouldNotify: true, matchedPeople: ['Naomi Wentworth'] }), new_json: null });
  assert.equal(d.kind, 'new-not-recorded');
});

test('19. retirement only after the parity threshold — four clean days are not enough', () => {
  const rows = ['01', '02', '03', '04'].map((d) => ({ meeting_key: `k${d}`, title: 't', start_local: `2026-10-${d}T10:00`,
    old_json: JSON.stringify({ wouldNotify: false }), new_json: JSON.stringify({ finding: null }) }));
  const v = mi.parityVerdict(rows);
  assert.equal(v.retireSafe, false);
  assert.ok(v.reasons.some((r) => /4 day/.test(r)));
  assert.equal(mi.parityVerdict([...rows, { ...rows[0], meeting_key: 'k5', start_local: '2026-10-05T10:00' }]).retireSafe, true, 'positive control');
});

test('18. legacy prep is keyed per OCCURRENCE — a weekly 1-2-1 is not "already notified" for ever, and one occurrence stays one', () => {
  const a = mp.occurrenceKey({ id: 'AAA', start: '2026-10-06T10:30:00' });
  const b = mp.occurrenceKey({ id: 'AAA', start: '2026-10-13T10:30:00' });
  assert.notEqual(a, b);
  assert.equal(a, mp.occurrenceKey({ id: 'AAA', start: '2026-10-06T10:30:00.0000000' }));
  const lifecycle = require('./attention-lifecycle');
  assert.notEqual(lifecycle.dedupeKeyForPush('meeting_prep', a), lifecycle.dedupeKeyForPush('meeting_prep', b));
});

test('legacy prep skips a block only when it is POSITIVELY solo', () => {
  const me = 'nickw@nurtur.tech';
  const solo = { attendees: [{ email: me }] };
  const real = { attendees: [{ email: me }, { email: 'naomi@nurtur.tech' }] };
  assert.equal(mp.soloBlock(solo, me), true);
  assert.equal(mp.soloBlock(real, me), false);
  assert.equal(mp.soloBlock({ attendees: undefined }, me), false, 'undecidable keeps the old behaviour');
  assert.equal(mp.soloBlock(solo, null), false, 'no signed-in address: cannot tell');
});

// ── 16C/G: native queue reports ──────────────────────────────────────────────

test('a queue report is counts only — a coordinate or anything else is dropped', () => {
  const r = ne.sanitiseQueueReport({ pending: 3, quarantined: 1, evicted: 0, oldestPendingAgeSeconds: 7200, lat: 52.9, place: 'Home' });
  assert.deepEqual(r, { pending: 3, quarantined: 1, evicted: 0, oldestPendingAgeSeconds: 7200 });
  assert.equal(ne.sanitiseQueueReport({ pending: 'x' }), null, 'unreadable is null, not an empty queue');
  assert.equal(ne.sanitiseQueueReport(undefined), null);
});

test('9/10. delayed delivery: a backlog that landed is ONE replay; a resend of what NEURO had is not', () => {
  const nowMs = Date.parse('2026-10-07T08:00:00Z');
  const old = [nowMs / 1000 - 5 * 3600, nowMs / 1000 - 4 * 3600];
  assert.deepEqual(ne.queueSignals({ acceptedTsts: old, stored: 2, nowMs }).replayed, { delivered: 2, oldestAgeMinutes: 300 });
  assert.equal(ne.queueSignals({ acceptedTsts: old, stored: 0, nowMs }).replayed, null, 'nothing new stored: a duplicate, not a replay');
  assert.equal(ne.queueSignals({ acceptedTsts: [nowMs / 1000 - 60], stored: 1, nowMs }).replayed, null, 'a fresh fix is not a replay');
});

test('a quarantine or eviction on the phone is reported once, and the first report only sets the baseline', () => {
  const prev = { pending: 0, quarantined: 0, evicted: 0 };
  const now = { pending: 0, quarantined: 1, evicted: 0, oldestPendingAgeSeconds: null };
  assert.deepEqual(ne.queueSignals({ prev, report: now, nowMs: 0 }).degraded, { quarantinedAdded: 1, evictedAdded: 0, quarantinedTotal: 1, evictedTotal: 0 });
  assert.equal(ne.queueSignals({ prev: null, report: now, nowMs: 0 }).degraded, null);
  assert.equal(ne.queueSignals({ prev: now, report: now, nowMs: 0 }).degraded, null, 'unchanged: nothing to say');
});

test('11. replay idempotency on the server: the same backlog published twice is one event', () => {
  const nowMs = Date.parse('2026-10-07T08:00:00Z');
  const args = { headers: { 'x-neuro-client': 'neuro-ios' }, deviceId: 'b16-phone', report: { pending: 2, quarantined: 0, evicted: 0, oldestPendingAgeSeconds: 18000 },
    acceptedTsts: [nowMs / 1000 - 18000, nowMs / 1000 - 17000], stored: 2, now: nowMs };
  ne.recordQueueReport(args);
  ne.recordQueueReport({ ...args, now: nowMs + 60000 });
  const n = db.get(`SELECT COUNT(*) n FROM event_log WHERE type = 'native.queue.replayed' AND json_extract(payload,'$.deviceId') = 'b16-phone'`).n;
  assert.equal(n, 1);
  const p = JSON.parse(db.get(`SELECT payload FROM event_log WHERE type = 'native.queue.replayed'`).payload);
  assert.ok(!('lat' in p) && !('lon' in p), 'no coordinate in the immutable log');
});

test('Activity says a replay and a quarantine in one line each', () => {
  const rows = [
    { event_id: 'e1', type: 'native.queue.replayed', occurred_at: '2026-10-07T08:00:00Z', payload: JSON.stringify({ sourceId: 'location.neuro-ios', deviceId: 'd', delivered: 12, oldestAgeMinutes: 300 }) },
    { event_id: 'e2', type: 'native.queue.degraded', occurred_at: '2026-10-07T08:01:00Z', payload: JSON.stringify({ sourceId: 'location.neuro-ios', deviceId: 'd', quarantinedAdded: 1, evictedAdded: 0 }) },
  ];
  const [a, b] = tl.fromEventLog(rows);
  assert.match(a.headline, /12 queued events replayed after reconnect \(oldest 5h\)/);
  assert.match(b.headline, /1 unreadable event was quarantined/);
  assert.match(b.summary, /not lost/);
});

// ── 16Y: Activity quality ────────────────────────────────────────────────────

const finding = (id, src, from, to, extra = {}) => ({ finding_id: id, source_id: src, condition: 'stale', status: 'resolved', first_detected_at: from, resolved_at: to, resolution: 'delivered', failure_count: 0, ...extra });

test('a quiet episode that came back on its own is ONE line, and two apps on one phone wake are merged', () => {
  const out = tl.fromFindings([
    finding('f1', 'healthkit.neuro-ios', '2026-10-06T19:35:00Z', '2026-10-07T06:35:00Z'),
    finding('f2', 'healthkit.saim-ios', '2026-10-06T19:35:30Z', '2026-10-07T06:35:40Z'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'source.quiet-episode');
  assert.match(out[0].headline, /were quiet 20:35–07:35 and came back on their own/);
  assert.equal(tl.summarise(out).counts.noticed, 2, 'still two things noticed');
});

test('a FAILING source stays two loud lines — failures are not folded', () => {
  const out = tl.fromFindings([finding('f3', 'microsoft.calendar', '2026-10-07T01:00:00Z', '2026-10-07T01:10:00Z', { condition: 'failing', failure_count: 3 })]);
  assert.deepEqual(out.map((e) => e.type).sort(), ['source.recovered', 'source.stopped']);
});

test('16Z. autonomy today: counts from entries, and an unreadable part is null, never zero', () => {
  const a = tl.autonomy({ investigated: 1, fixAttempts: 1, fixed: 1, failed: 0, uncertain: 0 });
  assert.equal(a.investigations, 1);
  assert.equal(a.automaticFixes, 1);
  assert.equal(a.verifiedRecoveries, 1);
  assert.ok(a.awaitingNick === null || Number.isInteger(a.awaitingNick));
  assert.ok(Array.isArray(a.switchesOff));
  // governed_execution defaults OFF and nothing is stored here, so it is listed.
  assert.ok(a.switchesOff.some((s) => s.key === 'governed_execution'));
});

// ── 16L–P: hiking evidence ───────────────────────────────────────────────────

const rel = { level: 'unreliable' };
const SAT = '2026-09-19';
const base = { start: '2026-09-14', today: '2026-10-07', rel };

test('20/23. steps alone cannot confirm a hike — 18,122 steps stays LIKELY, with distance as corroboration only', () => {
  const w = loop.weekState({ ...base, steps: { [SAT]: 18122 }, distance: { [SAT]: 8.3 } });
  assert.equal(w.recording, 'likely');
  assert.equal(w.confirmed.length, 0);
  assert.match(w.line, /18,122 steps \(8.3 km\)/);
  assert.equal(w.needsNick.evidence.distanceKm, 8.3);
});

test('distance alone cannot even make a day likely', () => {
  const w = loop.weekState({ ...base, steps: { [SAT]: 9000 }, distance: { [SAT]: 25 } });
  assert.notEqual(w.recording, 'likely');
  assert.notEqual(w.recording, 'confirmed');
});

test('21/22. an explicit confirmation or a Hiking workout confirms', () => {
  assert.equal(loop.weekState({ ...base, confirms: [{ day: SAT, id: 1 }] }).recording, 'confirmed');
  assert.equal(loop.weekState({ ...base, workouts: [{ day: SAT, type: 'Hiking', mins: 290 }] }).recording, 'confirmed');
});

test('24. a 0-step planned day is a RECORDING GAP, not an ordinary day', () => {
  const w = loop.weekState({ ...base, plans: [{ day: SAT, source: 'calendar' }], steps: { [SAT]: 0 }, distance: { [SAT]: 3.1 } });
  assert.equal(w.recording, 'recording-gap');
  const ok = loop.weekState({ ...base, plans: [{ day: SAT, source: 'calendar' }], steps: { [SAT]: 5010 }, distance: { [SAT]: 2.4 } });
  assert.notEqual(ok.recording, 'recording-gap', 'positive control: a real 5,010-step day is measured');
  assert.match(ok.line, /phone: 5,010 steps, 2.4 km/);
});

test('25. the weekly state is stable — the same evidence gives the same answer', () => {
  const i = { ...base, plans: [{ day: SAT, source: 'calendar' }], steps: { [SAT]: 18122 } };
  assert.deepEqual(loop.weekState(i), loop.weekState(i));
});

test('16M. a past hike can be confirmed ~4 months back; 26. and taken back; 27. Activity logs no sensor noise', () => {
  db.run('DELETE FROM goals');
  db.run(`INSERT INTO goals (goal_id, title, domains_json, status, created_at, updated_at) VALUES ('goal:hike', 'Hike weekly', '["health"]', 'active', 'x', 'x')`);
  const now = Date.parse('2026-10-07T09:00:00Z');
  const r = loop.addEntry('confirm', { day: '2026-08-29', now });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(loop.addEntry('confirm', { day: '2026-05-01', now }).ok, false, 'beyond the window is refused, not clamped');
  const read = loop.read({ now, weeks: 7 });
  const wk = read.weeks.find((w) => w.start === '2026-08-24');
  assert.equal(wk.recording, 'confirmed');
  assert.equal(loop.withdraw(r.id, { now }).ok, true);
  const after = loop.read({ now, weeks: 7 }).weeks.find((w) => w.start === '2026-08-24');
  assert.notEqual(after.recording, 'confirmed', 'reversal works');
  // Activity: only goal-loop transitions, never a line per step count.
  for (let d = 1; d <= 6; d += 1) db.run('INSERT OR REPLACE INTO health_daily (day, steps, complete, computed_at) VALUES (?, ?, 1, ?)', [`2026-10-0${d}`, 4000 + d, 'x']);
  loop.refresh({ now });
  assert.equal(loop.refresh({ now }).written, 0, 'a rerun writes nothing');
  const kinds = new Set(db.all('SELECT kind FROM goal_loop_events').map((x) => x.kind));
  for (const k of kinds) assert.ok(['planned', 'achieved', 'likely', 'recording-uncertain', 'reminder-prepared', 'withdrawn'].includes(k), k);
});

// ── 16Q–S: no second self-heal without evidence ──────────────────────────────

test('28–31. still ONE self-heal kind, with typed per-source operations and no generic command', () => {
  const sh = require('./self-heal');
  assert.deepEqual(Object.keys(sh.ALLOWLIST), ['retry-sync'], 'Build 16 measured no candidate that justifies a second kind');
  assert.deepEqual(Object.keys(sh.OPS['retry-sync']).sort(), ['homeassistant.presence', 'microsoft.calendar', 'neuro.selftest']);
  const src = fs.readFileSync(path.join(__dirname, 'self-heal.js'), 'utf8');
  assert.doesNotMatch(src, /child_process|execSync|spawn\(/);
});
