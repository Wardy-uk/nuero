'use strict';

/**
 * The Monday briefing's pure parts (12 Oct 2026): which week it reports, how
 * volumes are summed, who the leaderboard says, which Friday note it reads,
 * and that an unreadable summary is never an empty one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('./briefing-weekly');

test('reportWeeks: on a Monday it reports the completed Monday–Sunday before', () => {
  const r = w.reportWeeks('2026-10-12'); // Monday
  assert.deepEqual(r.report, { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(r.prior, { from: '2026-09-28', to: '2026-10-04' });
  assert.equal(r.thisMonday, '2026-10-12');
});

test('reportWeeks: a late run on Sunday still reports the week before this one', () => {
  const r = w.reportWeeks('2026-10-18'); // Sunday
  assert.deepEqual(r.report, { from: '2026-10-05', to: '2026-10-11' });
});

const weeks = w.reportWeeks('2026-10-12');
const series = (key, pts) => ({ key, label: key, points: pts.map(([day, value]) => ({ day, value })) });

test('volumes: raised/closed SUM over the week; backlog is the last day captured', () => {
  const data = { series: [
    series('nt_legacy_new_tickets', [['2026-10-04', 99], ['2026-10-05', 10], ['2026-10-06', 12], ['2026-10-11', 3]]),
    series('nt_open_support_owned', [['2026-10-05', 140], ['2026-10-10', 120], ['2026-10-04', 150]]),
  ] };
  const rows = Object.fromEntries(w.volumesFor(data, weeks).map((r) => [r.name, r]));
  assert.equal(rows.raised.now, 25);
  assert.equal(rows.raised.nowDays, 3);
  assert.equal(rows.raised.was, 99);
  assert.equal(rows.backlogSupport.now, 120);
  assert.equal(rows.backlogSupport.asOf, '2026-10-10');
  assert.equal(rows.backlogSupport.was, 150);
});

test('volumes: a KPI with no series is UNKNOWN (null), never zero', () => {
  const rows = Object.fromEntries(w.volumesFor({ series: [] }, weeks).map((r) => [r.name, r]));
  assert.equal(rows.closed.now, null);
  assert.equal(rows.closed.known, false);
  assert.equal(rows.closed.delta, null);
});

test('Support compliance is POOLED by tickets across CC + T2 + Prod, never an average of percentages', () => {
  const data = { series: [
    // Customer Care: 380 of 400 met (95%). Tier 2: 5 of 20 met (25%).
    series('nt_sla_res_customer_care_met', [['2026-10-06', 380]]),
    series('nt_sla_res_customer_care_breached', [['2026-10-06', 20]]),
    series('nt_sla_res_tier_2_met', [['2026-10-06', 5]]),
    series('nt_sla_res_tier_2_breached', [['2026-10-06', 15]]),
    // Tier 3 is a hand-off and must NOT count, however bad.
    series('nt_sla_res_tier_3_met', [['2026-10-06', 0]]),
    series('nt_sla_res_tier_3_breached', [['2026-10-06', 500]]),
  ] };
  const r = w.supportCompliance(data, weeks);
  assert.equal(r.res.now.pct, 91.7); // 385 / 420 — the average of 95 and 25 would be 60
  assert.equal(r.res.now.met, 385);
  assert.equal(r.res.now.breached, 35);
  assert.deepEqual(r.res.now.queues, ['Customer Care', 'Tier 2']);
  assert.equal(r.res.now.days, 1);
});

test('Support compliance: a week with no counts is null, never 0% or 100%', () => {
  const r = w.supportCompliance({ series: [] }, weeks);
  assert.equal(r.frt.now.pct, null);
  assert.equal(r.frt.was.pct, null);
  assert.equal(r.frt.delta, null);
});

test('Support compliance asks NOVA for exactly the three queues, both metrics', () => {
  const keys = w.supportSlaKeys();
  assert.equal(keys.length, 12);
  assert.ok(keys.includes('nt_sla_frt_production_breached'));
  assert.ok(!keys.some((k) => /tier_3|development/.test(k)));
});

test('leaderboard: top is rank 1, weakest is last; one ranked agent has no weakest', () => {
  const two = w.leaderboardSummary({ ranked: [{ rank: 1, agentName: 'A' }, { rank: 2, agentName: 'B' }, { rank: 3, agentName: 'C' }] });
  assert.equal(two.top.agentName, 'A');
  assert.equal(two.weakest.agentName, 'C');
  const one = w.leaderboardSummary({ ranked: [{ rank: 1, agentName: 'A' }] });
  assert.equal(one.weakest, null);
  assert.equal(one.enough, false);
});

test('parseSlmPoints: reads JSON even with prose around it, refuses junk', () => {
  const ok = w.parseSlmPoints('Here you go:\n{"highlights":["Tier 2 SLA up"],"lowlights":[],"blockers":["Dev ack slow"]}\nThanks');
  assert.deepEqual(ok, { highlights: ['Tier 2 SLA up'], lowlights: [], blockers: ['Dev ack slow'] });
  assert.equal(w.parseSlmPoints('no json here'), null);
  assert.equal(w.parseSlmPoints('{"highlights":["x"]}'), null); // a missing list is not an empty one
});

test('findSlmNote: the week\'s note, the original over a Plaud " 2" twin, never another week', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-'));
  const dir = path.join(root, 'Meetings', '2026', '10');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-09 – Weekly Support Leadership Meeting Tooling 2.md'), 'twin');
  fs.writeFileSync(path.join(dir, '2026-10-09 – Weekly Support Leadership Meeting Tooling.md'), 'original');
  fs.writeFileSync(path.join(dir, '2026-10-02 – Support Leadership Meeting Older.md'), 'last week');
  fs.writeFileSync(path.join(dir, '2026-10-07 – Support Teams Consolidation Meeting.md'), 'not the SLM');
  const hit = w.findSlmNote(root, weeks.report);
  assert.equal(hit.found, true);
  assert.equal(hit.name, '2026-10-09 – Weekly Support Leadership Meeting Tooling');
  assert.equal(w.findSlmNote(root, { from: '2026-10-12', to: '2026-10-18' }).found, false);
  assert.equal(w.findSlmNote(null, weeks.report).found, false);
});

test('slmPoints: an unreadable summary is a named gap, never an empty meeting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-'));
  const dir = path.join(root, 'Meetings', '2026', '10');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-10-09 – Support Leadership Meeting.md'), '---\nx: 1\n---\nNotes');
  const bad = await w.slmPoints(root, weeks.report, { extract: async () => 'I could not do that' });
  assert.equal(bad.known, false);
  let seen = null;
  const good = await w.slmPoints(root, weeks.report, { extract: async (p) => { seen = p; return '{"highlights":[],"lowlights":["CSAT dipped"],"blockers":[]}'; } });
  assert.equal(good.known, true);
  assert.deepEqual(good.lowlights, ['CSAT dipped']);
  assert.ok(!seen.includes('x: 1'), 'frontmatter is stripped before the model sees it');
});

test('bpWeek: medians per week; a week with no paired reading is null, not zero', () => {
  const rows = [
    { day: '2026-10-05', bpSystolic: 150, bpDiastolic: 92 },
    { day: '2026-10-07', bpSystolic: 146, bpDiastolic: 88 },
    { day: '2026-10-08', bpSystolic: 160, bpDiastolic: null },
  ];
  const r = w.bpWeek(rows, weeks);
  assert.deepEqual(r.now, { days: 2, systolic: 148, diastolic: 90 });
  assert.deepEqual(r.was, { days: 0, systolic: null, diastolic: null });
});
