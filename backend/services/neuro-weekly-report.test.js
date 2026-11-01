'use strict';

/**
 * "What NEURO did for you" — over a REAL scratch database seeded with every
 * source, the real waiting-on reopen, the real route over HTTP and the real
 * weekly briefing composer. Pins:
 *   - a table that does not exist yet is "not used yet", never a gap or a zero
 *   - a source that cannot be read is a NAMED gap and the rest still answer
 *   - misfires are ranked (uncertain/failed writes first, suppression spikes last)
 *   - counts are exact and bounded to the London week
 *   - the briefing push carries the headline; the work email never does
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-weekly-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.OBSIDIAN_VAULT_PATH;
delete process.env.NOVA_BRIDGE_URL;
delete process.env.NOVA_BRIDGE_SECRET;

const db = require('../db/database');
const rep = require('./neuro-weekly-report');

const WEEK = '2026-10-26';                       // GMT week (clocks went back 25 Oct)
const NOW = Date.parse('2026-11-04T12:00:00Z');  // the week is complete
const IN = (h) => `2026-10-28T${String(h).padStart(2, '0')}:00:00.000Z`;
const OUT = '2026-10-25T22:00:00.000Z';          // Sunday before — not this week

let server; let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use('/api/activity/weekly-report', require('../routes/neuro-weekly-report'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) { server.closeAllConnections?.(); server.close(); } });

// ── pure ─────────────────────────────────────────────────────────────────────

test('London week arithmetic across the clock change', () => {
  assert.equal(rep.londonMidnight('2026-10-19'), Date.parse('2026-10-18T23:00:00Z')); // BST
  assert.equal(rep.londonMidnight('2026-10-26'), Date.parse('2026-10-26T00:00:00Z')); // GMT
  const w = rep.weekWindow('2026-10-19');
  assert.equal(w.toIso, '2026-10-26T00:00:00.000Z');  // a 169-hour week, correctly
  assert.equal(rep.lastCompleteWeek(NOW), '2026-10-26');
  assert.equal(rep.lastCompleteWeek(Date.parse('2026-11-02T00:30:00Z')), '2026-10-26');
  assert.ok(rep.isMonday('2026-10-26'));
  assert.ok(!rep.isMonday('2026-10-27'));
  assert.ok(!rep.isMonday('2026-02-31'));
  const opts = rep.weekOptions(NOW);
  assert.equal(opts.length, 9);
  assert.equal(opts[0].monday, '2026-11-02');
  assert.ok(opts[0].partial);
});

test('suppression spike needs size AND a jump over the usual week', () => {
  assert.ok(rep.isSpike(30, 0));
  assert.ok(!rep.isSpike(19, 0));          // small is never a spike
  assert.ok(!rep.isSpike(100, 40));        // big but usual
  assert.ok(rep.isSpike(130, 40));
});

// ── absent tables: the fresh DB (these features keep side tables made on first write) ──

test('a table that does not exist yet is "not used yet", never a gap or zero', () => {
  const r = rep.compose({ week: WEEK, now: NOW });
  assert.equal(r.known, true);
  const nu = r.notUsedYet.map((x) => x.area);
  assert.ok(nu.includes('focus-blocks'), JSON.stringify(r.notUsedYet));
  // tickets' tables are in schema.sql, so a fresh DB reads them and finds 0 — a real zero.
  assert.equal(r.areas.find((a) => a.id === 'tickets').acted, 0);
  assert.equal(r.gaps.length, 0, JSON.stringify(r.gaps));
  assert.ok(!r.areas.some((a) => a.id === 'focus-blocks'));
  assert.equal(r.acted, 0);
  assert.match(r.headline, /did nothing on its own last week — nothing to check/);
});

// ── seed every source ────────────────────────────────────────────────────────

function seed() {
  // Side tables the features create on first write (live DDL).
  const ddl = (`CREATE TABLE IF NOT EXISTS watched_ticket_replies (comment_id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT, created TEXT, excerpt TEXT,
      phase TEXT NOT NULL, verdict TEXT NOT NULL, judged_by TEXT, flagged INTEGER NOT NULL DEFAULT 0, read_at TEXT, detected_at TEXT NOT NULL,
      draft_text TEXT, draft_visibility TEXT, draft_model TEXT, draft_state TEXT, drafted_at TEXT);
    CREATE TABLE IF NOT EXISTS watched_ticket_commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_key TEXT NOT NULL, due_at TEXT NOT NULL, source TEXT NOT NULL,
      state TEXT NOT NULL, phrase TEXT, comment_id TEXT UNIQUE, made_at TEXT NOT NULL, confirmed_at TEXT, reminded_at TEXT, missed_at TEXT, closed_at TEXT,
      closed_by TEXT, kept_late INTEGER, confirmed_by TEXT);
    CREATE TABLE IF NOT EXISTS focus_block_state (block_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, chosen_task_id INTEGER, chosen_at TEXT, session_id TEXT,
      offered_json TEXT, ready_json TEXT, two_min_until TEXT, two_min_answer TEXT, wind_note TEXT, end_answer TEXT, user_moved INTEGER NOT NULL DEFAULT 0,
      slides INTEGER NOT NULL DEFAULT 0, basis_json TEXT, notice TEXT, notice_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS focus_block_passes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, block_id INTEGER, reason TEXT NOT NULL, step TEXT, at TEXT NOT NULL);`);
  for (const stmt of ddl.split(';').map((x) => x.trim()).filter(Boolean)) db.run(stmt);
  // Seeding only: the governed-action triggers guard the write path, which this
  // read-only report never takes.
  for (const t of db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'prepared_actions'")) db.run(`DROP TRIGGER "${t.name}"`);

  let n = 0;
  const pa = (o) => {
    n += 1;
    db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json, reason, evidence_json, draft_json,
      payload_hash, authority_class, status, created_at, executed_at, history_json, updated_at, origin, authority_proof)
      VALUES (?, ?, 'f', ?, ?, ?, 'r', '{}', ?, 'h', 'A4', ?, ?, ?, '[]', ?, ?, ?)`,
    [o.id, `k${n}`, o.commitment || 'c', o.type, JSON.stringify(o.target || {}), JSON.stringify(o.draft || {}), o.status, o.at, o.executedAt ?? o.at, o.at, o.origin || null, o.proof || null]);
  };
  pa({ id: 'auto1', type: 'create_calendar_event', origin: '1to1-auto', proof: 'standing_switch', status: 'verified', at: IN(9), target: { person: 'Hope Goodall' }, draft: { start: '2026-11-03T14:00:00' } });
  pa({ id: 'auto2', type: 'create_calendar_event', origin: '1to1-auto', proof: 'standing_switch', status: 'verified', at: IN(10), target: { person: 'Zoe Rees' }, draft: { start: '2026-11-04T10:00:00' } });
  pa({ id: 'auto3', type: 'create_calendar_event', origin: '1to1-auto', proof: 'standing_switch', status: 'failed', at: IN(11), executedAt: null, target: { person: 'Adele' } });
  pa({ id: 'autoOld', type: 'create_calendar_event', origin: '1to1-auto', proof: 'standing_switch', status: 'verified', at: OUT, target: { person: 'Old' } });
  pa({ id: 'cancel1', type: 'cancel_calendar_event', commitment: 'calendar-event:ev1', origin: '1to1-cancel', status: 'executed', at: IN(12) });
  pa({ id: 'sw1', type: 'reply_email', origin: 'some-switch', proof: 'standing_switch', status: 'executed', at: IN(13) });
  db.run(`INSERT INTO action_attempts (attempt_id, action_id, attempt, execution_key, boot_id, started_at, draft_id) VALUES ('auto1#1','auto1',1,'e1','b',?, 'ev1')`, [IN(9)]);
  db.setState('one_to_one_auto_undone', JSON.stringify({ 'Hope Goodall': { at: IN(15), eventId: 'ev1', actionId: 'auto1', start: '2026-11-03T14:00:00' } }));

  let k = 0;
  const led = (writer, target, status, at) => {
    k += 1;
    db.run(`INSERT INTO external_write_ledger (writer, idempotency_key, target, authority, initiated_by, status, request_json, requested_at) VALUES (?, ?, ?, 'A2', 'neuro', ?, '{}', ?)`,
      [writer, `w${k}`, target, status, at]);
  };
  for (let i = 0; i < 3; i += 1) led('microsoft.mail.archive', 'news@golf.example', 'confirmed', IN(8));
  for (let i = 0; i < 10; i += 1) led('microsoft.mail.archive', `s${i}@x.example`, 'confirmed', IN(8));
  led('microsoft.mail.archive', 'old@x.example', 'confirmed', OUT);
  led('microsoft.mail.archive', 'late@x.example', 'confirmed', '2026-11-02T09:00:00.000Z'); // the Monday after — next week
  led('microsoft.calendar.leave-decline', 'Team sync', 'confirmed', IN(7));
  led('router.restart', 'router', 'confirmed', IN(3));
  led('microsoft.task.complete', 'task 9', 'uncertain', IN(14));
  led('nova.escalate', 'NT-1', 'failed', IN(13));
  led('jira.comment', 'NT-2', 'requested', IN(12));

  db.run(`INSERT INTO waiting_on (key, person, text, status, first_seen, last_seen, resolved_at) VALUES ('wo1','Naomi','send the rota','lapsed','2026-06-01','2026-06-01',?)`, [IN(2)]);
  db.run(`INSERT INTO waiting_on (key, person, text, status, first_seen, last_seen, resolved_at) VALUES ('wo2','Chris','sign off budget','lapsed','2026-06-01','2026-06-01',?)`, [IN(2)]);
  db.run(`INSERT INTO personal_ops_events (kind, subject_id, actor, dedupe_key, at, detail_json) VALUES ('waiting-on-lapsed', null, 'neuro', 'l1', ?, '{"count":3,"days":90}')`, [IN(2)]);

  db.run(`INSERT INTO saim_actions (type, payload, status, created_at, resolved_at) VALUES ('capture_todo', '{"text":"Pull CSV export"}', 'expired', '2026-10-15 09:00:00', '2026-10-28 03:00:00')`);
  db.run(`INSERT INTO saim_actions (type, payload, status, created_at, resolved_at) VALUES ('capture_todo', '{"text":"old one"}', 'expired', '2026-10-01 09:00:00', '2026-10-20 03:00:00')`);
  db.run(`INSERT INTO saim_actions (type, payload, status, created_at, resolved_at) VALUES ('capture_todo', '{"text":"rejected"}', 'rejected', '2026-10-15 09:00:00', '2026-10-28 03:00:00')`);

  db.run(`INSERT INTO watched_ticket_replies (comment_id, ticket_key, phase, verdict, detected_at, draft_state, drafted_at) VALUES ('c1','NT-10','watching','reply',?, 'ready', ?)`, [IN(9), IN(9)]);
  db.run(`INSERT INTO watched_ticket_replies (comment_id, ticket_key, phase, verdict, detected_at, draft_state, drafted_at) VALUES ('c2','NT-11','watching','reply',?, 'used', ?)`, [IN(9), IN(9)]);
  db.run(`INSERT INTO watched_ticket_replies (comment_id, ticket_key, phase, verdict, detected_at, draft_state, drafted_at) VALUES ('c3','NT-12','watching','reply',?, 'unavailable', ?)`, [IN(9), IN(9)]);
  db.run(`INSERT INTO watched_ticket_commitments (ticket_key, due_at, source, state, made_at, confirmed_at, confirmed_by) VALUES ('NT-10', ?, 'detected', 'kept', ?, ?, 'auto')`, [IN(17), IN(9), IN(9)]);
  db.run(`INSERT INTO watched_ticket_commitments (ticket_key, due_at, source, state, made_at, confirmed_at, confirmed_by, closed_at) VALUES ('NT-13', ?, 'detected', 'dismissed', ?, ?, 'auto', ?)`, [IN(17), IN(9), IN(9), IN(10)]);
  db.run(`INSERT INTO watched_ticket_commitments (ticket_key, due_at, source, state, made_at, confirmed_at, confirmed_by) VALUES ('NT-14', ?, 'detected', 'dismissed', ?, ?, 'nick')`, [IN(17), IN(9), IN(9)]);

  db.run(`INSERT INTO task_blocks (id, date_key, start_time, end_time, minutes, note_path, status, created_at, updated_at) VALUES (501,'2026-10-28','10:00','10:30',30,'x','complete',?,?)`, [IN(6), IN(11)]);
  db.run(`INSERT INTO task_blocks (id, date_key, start_time, end_time, minutes, note_path, status, created_at, updated_at) VALUES (502,'2026-10-29','10:00','10:30',30,'x','dropped',?,?)`, [IN(6), IN(11)]);
  db.run(`INSERT INTO focus_block_state (block_id, kind, chosen_task_id, chosen_at, end_answer, slides, created_at, updated_at) VALUES (501,'open',7,?,'done',1,?,?)`, [IN(10), IN(6), IN(11)]);
  db.run(`INSERT INTO focus_block_state (block_id, kind, created_at, updated_at) VALUES (502,'open',?,?)`, [IN(6), IN(11)]);
  db.run(`INSERT INTO focus_block_passes (task_id, block_id, reason, at) VALUES (7, 502, 'not-now', ?)`, [IN(10)]);

  db.run(`INSERT INTO self_heal_attempts (attempt_id, outage_key, fix_kind, op, investigation_id, source_id, authority, capability, status, requested_at)
    VALUES ('h1','o','retry-sync','op','i','microsoft.calendar','A1','source.retry-sync','failed',?)`, [IN(5)]);

  const push = (type, outcome, at, times = 1) => { for (let i = 0; i < times; i += 1) db.run(`INSERT INTO push_log (created_at, type, title, outcome) VALUES (?, ?, 't', ?)`, [at, type, outcome]); };
  push('router_health', 'suppressed', '2026-10-28 08:00:00', 30);   // spike: none the 4 weeks before
  push('meeting_alert', 'sent', '2026-10-28 08:00:00', 5);
  push('email', 'suppressed', '2026-10-28 08:00:00', 25);           // usual: 40/week before
  push('email', 'suppressed', '2026-10-10 08:00:00', 160);
  push('brief', 'held', '2026-10-28 10:15:00', 2);
}

test('every source counted, exact and bounded to the week; misfires ranked', () => {
  seed();
  // The real reopen writes the event the report reads.
  const wo = require('./waiting-on');
  const re = wo.reopen('wo2', { now: Date.parse(IN(16)) });
  assert.equal(re.ok, true, JSON.stringify(re));

  const r = rep.compose({ week: WEEK, now: NOW });
  assert.equal(r.gaps.length, 0, JSON.stringify(r.gaps));
  const area = (id) => r.areas.find((a) => a.id === id);

  assert.equal(area('one-to-ones').acted, 2);
  assert.ok(area('one-to-ones').items.some((i) => /Hope Goodall — Tue 3 Nov 14:00 \(since cancelled\)/.test(i.text)), JSON.stringify(area('one-to-ones').items));
  assert.equal(area('outlook-archive').acted, 13);
  assert.equal(area('outlook-archive').items[0].text, '3 from news@golf.example');
  assert.equal(area('outlook-archive').items.length, rep.ITEMS_MAX);
  assert.equal(area('outlook-archive').more, 11 - rep.ITEMS_MAX);
  assert.equal(area('waiting-on').acted, 3);           // the event's count beats the 1 still lapsed
  assert.equal(area('spotted').acted, 1);
  assert.equal(area('spotted').items[0].text, 'Pull CSV export');
  assert.equal(area('tickets').acted, 4);               // 2 drafts + 2 auto-confirmed (nick's excluded)
  assert.equal(area('focus-blocks').acted, 2);
  assert.ok(area('focus-blocks').stats.includes('1 finished'));
  assert.ok(area('focus-blocks').stats.includes('1 dropped'));
  assert.ok(area('focus-blocks').stats.includes('2 notifications held during a block'));
  assert.equal(area('leave-declines').acted, 1);
  assert.equal(area('router').acted, 1);
  assert.equal(area('self-heal').acted, 1);
  assert.equal(area('standing-switch').acted, 1);       // the 1-2-1s are not counted twice
  assert.equal(r.acted, 2 + 13 + 3 + 1 + 4 + 2 + 1 + 1 + 1 + 1);
  assert.equal(r.notificationsSent, 5);

  const kinds = r.misfires.map((m) => m.kind);
  assert.deepEqual(kinds, ['write-uncertain', 'write-failed', 'write-stuck', 'auto-121-failed', 'auto-121-undone',
    'promise-dismissed', 'lapsed-reopened', 'self-heal-failed', 'suppression-spike'].slice(0, rep.ITEMS_MAX));
  assert.equal(r.toCheck, 9);
  assert.equal(r.misfiresMore, 1);
  assert.ok(r.misfires.every((m) => m.view));
  assert.ok(!r.misfires.some((m) => /email/.test(m.text) && m.kind === 'suppression-spike'));
  assert.equal(r.headline, `NEURO acted ${r.acted} times last week — 9 to check`);
  assert.equal(r.notUsedYet.length, 0);
});

test('the suppression spike is the last misfire (all of them, uncapped)', () => {
  const all = rep.rankMisfires([
    { kind: 'suppression-spike', at: 'z' }, { kind: 'write-uncertain', at: 'a' }, { kind: 'lapsed-reopened', at: 'b' }, { kind: 'write-uncertain', at: 'c' },
  ]);
  assert.deepEqual(all.map((m) => `${m.kind}:${m.at}`), ['write-uncertain:c', 'write-uncertain:a', 'lapsed-reopened:b', 'suppression-spike:z']);
});

test('a source that cannot be read is a named gap; the rest still answer', () => {
  const broken = new Proxy(db, {
    get(t, p) {
      if (p === 'all') return (sql, args) => { if (/FROM waiting_on/.test(sql)) throw new Error('database disk image is malformed'); return t.all(sql, args); };
      return t[p];
    },
  });
  const r = rep.compose({ week: WEEK, now: NOW, d: broken });
  assert.deepEqual(r.gaps.map((g) => g.area), ['waiting-on']);
  assert.match(r.gaps[0].why, /malformed/);
  assert.ok(!r.areas.some((a) => a.id === 'waiting-on'));
  assert.ok(r.areas.some((a) => a.id === 'outlook-archive'));
  assert.match(r.headline, /\(1 source could not be read\)/);
});

test('ticket drafts with neither half recorded yet are "not used yet", not a zero', () => {
  const older = new Proxy(db, {
    get(t, p) {
      if (p === 'all') return (sql, args) => {
        if (/sqlite_master/.test(sql)) return t.all(sql, args).filter((r) => r.name !== 'watched_ticket_commitments');
        if (/PRAGMA table_info\(watched_ticket_replies\)/.test(sql)) return t.all(sql, args).filter((c) => !/^draft/.test(c.name));
        return t.all(sql, args);
      };
      return t[p];
    },
  });
  const r = rep.compose({ week: WEEK, now: NOW, d: older });
  assert.ok(r.notUsedYet.some((x) => x.area === 'tickets'));
  assert.ok(!r.areas.some((a) => a.id === 'tickets'));
  assert.equal(r.gaps.length, 0);
});

test('an unreadable undo record is a gap, not "nothing undone"', () => {
  db.setState('one_to_one_auto_undone', '{not json');
  const r = rep.compose({ week: WEEK, now: NOW });
  assert.ok(r.gaps.some((g) => g.area === 'one-to-ones'));
  db.setState('one_to_one_auto_undone', '{}');
});

test('route: a real HTTP read, refuses a non-Monday, defaults to last week', async () => {
  const ok = await (await fetch(`${base}/api/activity/weekly-report?week=${WEEK}`)).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.week.monday, WEEK);
  assert.ok(ok.acted > 0);
  const bad = await fetch(`${base}/api/activity/weekly-report?week=2026-10-27`);
  assert.equal(bad.status, 400);
  const def = await (await fetch(`${base}/api/activity/weekly-report`)).json();
  assert.equal(def.week.monday, rep.lastCompleteWeek(Date.now()));
});

test('briefing: the push carries the headline; the work email never does', async () => {
  const briefings = require('./briefings');
  const fail = () => { throw new Error('offline in test'); };
  const neuroDid = rep.compose({ week: WEEK, now: NOW });
  const p = await briefings.composeWeekly({
    now: new Date('2026-11-02T08:00:00Z'),
    overrides: { kpi: fail, volumes: fail, leaderboard: fail, bp: fail, weekAhead: fail, goals: fail,
      slm: async () => ({ known: false, why: 'test' }), neuroDid: () => neuroDid },
  });
  assert.equal(p.neuroDid.headline, neuroDid.headline);
  assert.ok(p.push.body.includes(neuroDid.headline), p.push.body);
  assert.ok(p.push.body.includes('Could not read the week’s KPIs'), 'the KPI fallback still shows');
  const html = briefings.weeklyEmailHtml(p);
  assert.ok(!html.includes('NEURO acted'), 'never in the work email');
  assert.ok(!html.includes('golf'), 'no misfire / item text in the work email');
});

test('briefing: a failed report is known:false, not a gap in the email footer', async () => {
  const w = require('./briefing-weekly');
  const fail = () => { throw new Error('offline in test'); };
  const r = await w.gatherWeekly({ now: new Date('2026-11-02T08:00:00Z'),
    overrides: { kpi: fail, volumes: fail, leaderboard: fail, bp: fail, weekAhead: fail, goals: fail, slm: async () => ({ known: false, why: 't' }), neuroDid: () => { throw new Error('boom'); } } });
  assert.equal(r.neuroDid.known, false);
  assert.ok(!r.gaps.some((g) => /NEURO did/.test(g.source)));
  // and without an override it reads the real report for the briefing's own last week
  const real = await w.gatherWeekly({ now: new Date('2026-11-02T08:00:00Z'),
    overrides: { kpi: fail, volumes: fail, leaderboard: fail, bp: fail, weekAhead: fail, goals: fail, slm: async () => ({ known: false, why: 't' }) } });
  assert.equal(real.neuroDid.week.monday, WEEK);
});
