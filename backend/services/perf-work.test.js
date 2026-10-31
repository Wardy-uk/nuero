'use strict';

/**
 * The evidence audit's sources (31 Oct 2026). Real scratch SQLite + temp vault.
 * Pins: work mailbox only; replies, report sends, UAT invites and NEURO's own
 * proofs are not repeated as sends; 1-2-1 moves fold to one item per day;
 * ticket promises kept/missed; jira approvals; UAT rounds; people sources are
 * counts with no content; work notes come only from the allow-listed folders,
 * by frontmatter date — never Projects/PIP.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-work-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const work = require('./perf-work');

const W = { from: '2026-10-01', to: '2026-10-31' };
test.before(async () => { await db.init(); });

// prepared_actions is guarded by triggers (an action is born prepared), so the
// sends test runs against a bare table of the same columns.
const bare = new (require('better-sqlite3'))(':memory:');
bare.exec(`CREATE TABLE prepared_actions (action_id TEXT, idempotency_key TEXT, action_type TEXT, version INTEGER, target_json TEXT, reason TEXT, evidence_json TEXT, evidence_hash TEXT, draft_json TEXT, payload_hash TEXT, authority_class TEXT, approval_required INTEGER, status TEXT, created_at TEXT, expires_at TEXT, executed_at TEXT, verified_at TEXT, updated_at TEXT, origin TEXT)`);
function pa(id, type, origin, target, draft, evidence, at, status = 'verified') {
  bare.prepare(`INSERT INTO prepared_actions (action_id, idempotency_key, action_type, version, target_json, reason, evidence_json, evidence_hash, draft_json, payload_hash, authority_class, approval_required, status, created_at, expires_at, executed_at, verified_at, updated_at, origin)
    VALUES (?, ?, ?, 1, ?, 'r', ?, 'h', ?, 'p', 'A4', 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id, type, JSON.stringify(target), JSON.stringify(evidence), JSON.stringify(draft), status, at, at, at, at, at, origin);
}

test('sends: work mail, escalation emails, folded 1-2-1 moves; nothing repeated or personal', () => {
  pa('a1', 'compose_email', 'composer', { mailbox: 'work' }, { to: [{ name: 'Lucy' }], subject: 'Escalation NT-1', body: 'Please prioritise.' }, { ticket: 'NT-1' }, '2026-10-10T10:00:00Z');
  pa('a2', 'compose_email', 'composer', { mailbox: 'gmail' }, { to: [{ name: 'Mum' }], subject: 'Sunday', body: 'x' }, {}, '2026-10-10T11:00:00Z');
  pa('a3', 'reschedule_calendar_event', '1to1-move', { person: 'Luke Scaife' }, { to: [{ name: 'Luke Scaife' }], subject: '1-2-1' }, { context: { reason: 'CI - Project Harbour' } }, '2026-10-15T11:00:00Z');
  pa('a4', 'reschedule_calendar_event', '1to1-move', { person: 'Hope Goodall' }, { to: [{ name: 'Hope Goodall' }], subject: '1-2-1' }, { context: {} }, '2026-10-15T12:00:00Z');
  pa('a5', 'reply_email', 'composer', { mailbox: 'work' }, { to: [{ name: 'X' }], subject: 'Re: y' }, {}, '2026-10-10T12:00:00Z');
  pa('a6', 'compose_email', 'uat-volunteers', { mailbox: 'work' }, { to: [{ name: 'Abdi' }], subject: 'UAT' }, {}, '2026-10-10T12:00:00Z');
  pa('a7', 'create_calendar_event', 'event-composer', {}, { to: [], subject: 'NEURO governed calendar proof (Build 13) - safe to delete' }, {}, '2026-10-06T12:00:00Z');
  pa('a8', 'compose_email', 'composer', { mailbox: 'work' }, { to: [{ name: 'Z' }], subject: 'never sent' }, {}, '2026-10-10T12:00:00Z', 'rejected');
  const items = work.sends(bare, W);
  const titles = items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Escalated NT-1 by email to Lucy', 'Moved 2 1-2-1s with Luke Scaife, Hope Goodall']);
  assert.match(items.find((i) => /Moved/.test(i.title)).detail, /Luke Scaife: CI - Project Harbour/);
});

test('tickets, workforce and people', () => {
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS watched_ticket_commitments (id INTEGER PRIMARY KEY, ticket_key TEXT, due_at TEXT, source TEXT, state TEXT, phrase TEXT, comment_id TEXT, made_at TEXT, confirmed_at TEXT, reminded_at TEXT, missed_at TEXT, closed_at TEXT, closed_by TEXT, kept_late INTEGER)`);
  d.prepare(`INSERT INTO watched_ticket_commitments (source, ticket_key, due_at, state, made_at, closed_at, kept_late) VALUES ('detected','NT-35291','2026-10-23T16:00:00Z','kept','2026-10-23T14:00:00Z','2026-10-23T15:40:00Z',0)`).run();
  d.prepare(`INSERT INTO watched_ticket_commitments (source, ticket_key, due_at, state, made_at, missed_at) VALUES ('detected','NT-2','2026-10-24T16:00:00Z','missed','2026-10-24T10:00:00Z','2026-10-24T16:00:00Z')`).run();
  const led = d.prepare(`INSERT INTO external_write_ledger (writer, idempotency_key, target, authority, initiated_by, status, attempts, request_json, requested_at, settled_at)
    VALUES (?, ?, ?, 'A3', 'nick', 'confirmed', 1, ?, '2026-10-30T11:47:00Z', '2026-10-30T11:47:57Z')`);
  led.run('jira.approval', 'k1', 'NT-34482', JSON.stringify({ key: 'NT-34482', name: 'Pending Rejection Approval (to CC)', decision: 'decline' }));
  led.run('gmail.unsubscribe', 'k2', 'x', '{}');
  const t = work.tickets(d, W).map((i) => i.title).sort();
  assert.deepEqual(t, ['Declined "Pending Rejection Approval (to CC)" on NT-34482', 'Kept a promised update on NT-35291', 'Missed a promised update on NT-2']);

  d.exec(`CREATE TABLE IF NOT EXISTS uat_rounds (id INTEGER PRIMARY KEY, status TEXT, uat_date TEXT, feature TEXT, from_name TEXT, closed_at TEXT)`);
  d.exec(`CREATE TABLE IF NOT EXISTS uat_selections (id INTEGER PRIMARY KEY, round_id INTEGER, status TEXT)`);
  d.prepare(`INSERT INTO uat_rounds (status, uat_date, feature, from_name, closed_at) VALUES ('done','2026-10-28','AFE anniversaries','Dan','2026-10-27T09:40:00Z')`).run();
  d.prepare(`INSERT INTO uat_selections (round_id, status) VALUES (1,'accepted'),(1,'confirmed')`).run();
  const wf = work.workforce(d, W);
  assert.equal(wf.length, 1);
  assert.match(wf[0].detail, /2 people invited from the rota, 2 going/);

  d.prepare(`INSERT INTO waiting_on (key, person, text, status, asked_at, first_seen, last_seen) VALUES ('w1','Hope','SECRET-OWED','open','2026-10-12T10:00:00Z','2026-10-01','2026-10-12')`).run();
  const p = work.people(d, W);
  assert.equal(p.length, 1);
  assert.equal(p[0].title, 'Chased 1 thing people owed you');
  assert.doesNotMatch(JSON.stringify(p), /SECRET-OWED|Hope/, 'counts only');
});

test('work notes: allow-listed folders, frontmatter dates, never PIP', () => {
  const v = path.join(tmp, 'vault', 'Projects');
  const put = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(v, rel)), { recursive: true }); fs.writeFileSync(path.join(v, rel), txt); };
  put('Support Improvement Plan/SIP - Playbook.md', '---\ntype: playbook\ncreated: 2026-10-05\nupdated: 2026-10-20\n---\n# Playbook\nHow we run critical incidents.');
  put('Support Improvement Plan/Undated.md', '# Undated\nno dates');
  put('PIP/OH report.md', '---\ncreated: 2026-10-05\n---\nSECRET-OH');
  put('D&D/Session.md', '---\ncreated: 2026-10-05\n---\ndragons');
  put('Jira Support Unification/Brief.md', '---\ntype: claude-code-brief\ndate: 2026-10-16\n---\nbuild it');
  put('Fixes Log/2026-10-23 NOVA - Replies never linked KB (fx-e301958c72).md', '---\ntype: report-fix\nstatus: included\ncreated: 2026-10-23T12:56:42Z\n---\n## What was wrong\nNo links.');
  put('Fixes Log/2026-10-24 NOVA - Proposed (fx-aaaaaaaa).md', '---\ntype: report-fix\nstatus: proposed\ncreated: 2026-10-24\n---\nx');
  const items = work.workNotes(path.join(tmp, 'vault'), W);
  const titles = items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Recorded a fix: NOVA - Replies never linked KB', 'Updated "SIP - Playbook" (Support Improvement Plan)', 'Wrote "SIP - Playbook" (Support Improvement Plan)']);
  assert.doesNotMatch(JSON.stringify(items), /SECRET-OH|dragons/);
  assert.throws(() => work.workNotes('', W), /vault not configured/);
});
