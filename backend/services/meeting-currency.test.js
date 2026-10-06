'use strict';

/**
 * Build 15P–R — a commitment from an old meeting does not produce risk for
 * ever, and free/busy does not decide which meeting a write-up records.
 *
 * Fixture shapes are the LIVE ones measured on 6 Oct: a daily weekday Team
 * Standup held on every weekday from 21 Sep to 5 Oct with no write-up after
 * 21 Sep, and the series re-saved as `free` from 6 Oct.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mc-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'mc.db');
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');
const mc = require('./meeting-currency');
const cr = require('./commitment-risk');
const src = require('./obligation-sources');

test.before(async () => { await db.init(); });

const WEEKDAYS = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'];
test.before(() => {
  for (const d of WEEKDAYS) {
    db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, source, first_seen)
            VALUES (?, ?, ?, 'Team Standup', 0, 'busy', 1, 'graph', 'x')`, [`SU-${d}`, `${d}T10:00:00`, `${d}T10:15:00`]);
  }
  // A cancelled occurrence never counts as held.
  db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, source, first_seen)
          VALUES ('SU-x', '2026-10-05T14:00:00', '2026-10-05T14:15:00', 'Team Standup', 0, 'cancelled', 1, 'graph', 'x')`);
});

const NOW_LOCAL = '2026-10-06T09:00';
const occ = (day) => ({ meetingId: `graph:SU-${day}`, start: `${day}T10:00`, end: `${day}T10:15`, seriesKey: 'team standup', subject: 'Team Standup' });
function commitment(day, extra = {}) {
  return {
    commitmentId: `commitment:task:${day}`, description: 'Nick to send the support figures', direction: 'by-nick', status: 'open',
    promisor: { personId: 'person:nick-ward', displayName: 'Nick Ward' }, provenance: { evidence: [] }, source: { ref: 'neuro-task:1' },
    meeting: { occurrence: occ(day), notePath: `Meetings/2026/09/${day} – Standup.md` }, meetingId: `graph:SU-${day}`, meetingSeriesKey: 'team standup',
    relatedTaskId: null, due: null, ...extra,
  };
}
const next = { meetingId: 'graph:SU-2026-10-06', title: 'Team Standup', start: '2026-10-06T10:00', kind: 'meeting', responseStatus: 'accepted', participants: [] };
function deps(c) {
  return {
    task: () => null, waitingSnoozedUntil: () => null, laneDeferral: () => null, calendarFreshness: () => 'fresh',
    nextOccurrence: () => next,
    previousOccurrence: () => ({ occurrence: c.meeting.occurrence }), // it IS the latest written-up one
    projection: () => ({ lag: 0, retrying: 0 }), plannedBlocks: () => [], progress: () => null,
    meetingCurrency: (x, nowLocal) => mc.currencyFor(x, { nowLocal }),
  };
}
const assess = (c) => cr.assess(c, { nowLocal: NOW_LOCAL, nowMs: Date.parse('2026-10-06T08:00:00Z'), deps: deps(c) });

test('25. an old meeting alone does not produce perpetual risk — measured in occurrences of the series, not days', () => {
  const old = assess(commitment('2026-09-21'));
  assert.equal(old.finding, false);
  assert.equal(old.why, 'no stated deadline and no imminent related meeting');
  const c = mc.currencyFor(commitment('2026-09-21'), { nowLocal: NOW_LOCAL });
  assert.equal(c.state, 'no-newer-evidence');
  assert.equal(c.intervening, 10, 'ten standups held since, the cancelled one not counted');
  // Positive control: from the LAST held occurrence it is current and does fire.
  const fresh = assess(commitment('2026-10-05'));
  assert.equal(fresh.finding, true);
  assert.equal(fresh.triggers[0].kind, 'meeting-near');
  // One unwritten occurrence in between is tolerated (a write-up landing a day late).
  assert.equal(mc.currencyFor(commitment('2026-10-02'), { nowLocal: NOW_LOCAL }).state, 'current');
});

test('26. an explicit carry-forward keeps it live: a daily-note standup carried its task after the last meeting', () => {
  fs.mkdirSync(path.join(VAULT, 'Daily'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'Daily', '2026-10-05.md'), '## Carry-Overs\n- [ ] Send the support figures <!--task:77-->\n');
  const withTask = commitment('2026-09-21', { relatedTaskId: 'task:neuro:77' });
  const r = mc.assess({ sourceStart: '2026-09-21T10:00', held: WEEKDAYS.slice(1).map((d) => `${d}T10:00`), carried: mc.carriedDays(77, '2026-10-05', '2026-10-06') });
  assert.equal(r.state, 'carried-forward');
  assert.equal(r.riskProducing, true);
  // A carry from BEFORE the newest meeting is not "still carried".
  const stale = mc.assess({ sourceStart: '2026-09-21T10:00', held: WEEKDAYS.slice(1).map((d) => `${d}T10:00`), carried: ['2026-09-23'] });
  assert.equal(stale.state, 'no-newer-evidence');
  assert.ok(withTask, 'fixture');
  // Progress recorded since the newest meeting also keeps it live.
  assert.equal(mc.assess({ sourceStart: '2026-09-21T10:00', held: ['2026-09-22T10:00', '2026-10-05T10:00'], progressSince: ['2026-10-05T16:00:00Z'] }).state, 'carried-forward');
});

test('27. newer evidence supersedes the old meeting: restated later, the old sighting stops carrying the risk', () => {
  const r = mc.assess({ sourceStart: '2026-09-21T10:00', held: ['2026-09-22T10:00', '2026-09-23T10:00'], restatedBy: [{ commitmentId: 'c2', start: '2026-10-05T10:00' }] });
  assert.equal(r.state, 'superseded');
  assert.equal(r.riskProducing, false);
  // An unlinked later write-up is ORPHANED, not "no evidence" — and still not raised.
  const o = mc.assess({ sourceStart: '2026-09-21T10:00', held: ['2026-09-22T10:00', '2026-09-23T10:00'], orphanDays: ['2026-09-23'] });
  assert.equal(o.state, 'orphaned');
  assert.equal(o.riskProducing, false);
});

test('28. free/busy does not decide meeting identity: a lone FREE standup links; a free placeholder beside a real meeting still loses', () => {
  const free = [{ event_id: 'SU', start_time: '2026-10-06T10:00:00', end_time: '2026-10-06T10:15:00', subject: 'Team Standup', source: 'graph', show_as: 'free', first_seen: 'x' }];
  const r = src.linkOccurrence('Meetings/2026/10/s.md', '2026-10-06T09:01:00', free);
  assert.equal(r.occurrence && r.occurrence.meetingId, 'graph:SU', 'UTC 09:01 is 10:01 BST, the free standup');
  const mixed = [
    { event_id: 'TL', start_time: '2026-09-14T09:00:00', end_time: '2026-09-14T10:00:00', subject: 'Tech Leadership', source: 'graph', show_as: 'tentative', first_seen: 'x' },
    { event_id: 'KPI', start_time: '2026-09-14T09:15:00', end_time: '2026-09-14T09:45:00', subject: 'KPI Meet', source: 'graph', show_as: 'free', first_seen: 'x' },
  ];
  assert.equal(src.linkOccurrence('n.md', '2026-09-14T08:03:00', mixed).occurrence.meetingId, 'graph:TL');
  // Two FREE candidates is still ambiguity, refused.
  const twoFree = [free[0], { ...free[0], event_id: 'OTHER', subject: 'Other' }];
  assert.equal(src.linkOccurrence('n.md', '2026-10-06T09:01:00', twoFree).occurrence, null);
  // And a cancelled one never links.
  assert.equal(src.linkOccurrence('n.md', '2026-10-06T09:01:00', [{ ...free[0], show_as: 'cancelled' }]).occurrence, null);
});

test('29. unknown never becomes completed: an unreadable calendar is UNKNOWN, not raised, and the commitment stays open', () => {
  const u = mc.assess({ sourceStart: '2026-09-21T10:00', calendarReadable: false });
  assert.equal(u.state, 'unknown');
  assert.equal(u.riskProducing, false);
  const c = commitment('2026-09-21');
  const a = cr.assess(c, { nowLocal: NOW_LOCAL, nowMs: Date.parse('2026-10-06T08:00:00Z'), deps: { ...deps(c), meetingCurrency: () => { throw new Error('calendar_history locked'); } } });
  assert.equal(a.finding, false);
  assert.equal(c.status, 'open', 'nothing here completes or closes a commitment');
  assert.ok(!('completedAt' in u) && !('status' in u));
});
