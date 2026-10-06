'use strict';

/**
 * Build 15A–G — the Activity timeline is semantic, honest and private.
 * Normalisers are tested on real row shapes; the privacy and ordering tests
 * read through the real `collect()` over a scratch DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-act-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'a.db');

const db = require('../db/database');
const tl = require('./activity-timeline');

test.before(async () => { await db.init(); });

const T = '2026-10-06T10:00:00.000Z';
const at = (min) => new Date(Date.parse(T) + min * 60000).toISOString();
const evs = (list) => list.map((e, i) => ({ id: i + 1, investigation_id: 'inv1', at: at(i), transition: e[0], detail_json: JSON.stringify(e[1] || {}) }));
const INV = { id: 'inv1', subject_ref: 'source:microsoft.calendar', trigger_ref: 'f1', hypotheses_json: '[]' };

test('1/2. an investigation becomes ONE conclusion entry; its plumbing (detected, gathering, evidence) is not activity', () => {
  const plumbing = evs([['detected'], ['gathering'], ['evidence']]);
  assert.equal(tl.fromInvestigations([INV], new Map([['inv1', plumbing]])).length, 0, 'a pass that concluded nothing writes nothing');
  const full = evs([['detected'], ['gathering'], ['evidence'], ['hypothesised', { top: 'auth-expired', level: 'high' }], ['decided', { decision: 'PREPARE', fix: { kind: 'reconnect-account', authority: 'A4' } }]]);
  const out = tl.fromInvestigations([INV], new Map([['inv1', full]]));
  const concluded = out.filter((e) => e.type === 'investigation.concluded');
  assert.equal(concluded.length, 1);
  assert.match(concluded[0].summary, /refusing NEURO's sign-in.*High/);
  assert.equal(concluded[0].investigationRef, 'inv1');
});

test('3. a recommendation is ONE entry, and a retry that self-heal ran is not shown as advice', () => {
  const e = evs([['hypothesised', { top: 'agent-not-running', level: 'high' }], ['decided', { decision: 'PREPARE', fix: { kind: 'open-app', authority: 'A1' } }]]);
  assert.equal(tl.fromInvestigations([INV], new Map([['inv1', e]])).filter((x) => x.type === 'investigation.recommended').length, 1);
  const r = evs([['hypothesised', { top: 'upstream-unavailable', level: 'high' }], ['decided', { decision: 'PREPARE', fix: { kind: 'retry-sync', authority: 'A1' } }]]);
  assert.equal(tl.fromInvestigations([INV], new Map([['inv1', r]]), { healedInvestigations: new Set(['inv1']) }).filter((x) => x.type === 'investigation.recommended').length, 0);
  assert.equal(tl.fromInvestigations([INV], new Map([['inv1', r]])).filter((x) => x.type === 'investigation.recommended').length, 1, 'positive control: un-run, it IS advice');
});

const PA = { action_id: 'pa1', action_type: 'reply_email', version: 1, origin: 'inbox', status: 'verified', created_at: at(0), approved_at: at(5), decided_at: at(5), executed_at: at(6), verified_at: at(9) };

test('4/5/7. prepared → you approved → sent → verified, one entry each, even with several verification checks', () => {
  const vs = new Map([['pa1', [{ id: 1, outcome: 'not_found', checked_at: at(7) }, { id: 2, outcome: 'verified', checked_at: at(9) }]]]);
  const out = tl.fromPreparedActions([PA], vs);
  assert.deepEqual(out.map((e) => e.type), ['action.prepared', 'action.approved', 'action.executed', 'action.verified']);
  const approved = out.find((e) => e.type === 'action.approved');
  assert.equal(approved.actor, 'nick');
  assert.equal(approved.headline, 'You approved an email reply');
  assert.equal(out.find((e) => e.type === 'action.executed').summary, 'Sent. Verification is separate.');
});

test('6. failure and uncertainty are said as such — never as success', () => {
  const unc = tl.fromPreparedActions([{ ...PA, status: 'execution_uncertain', verified_at: null }], new Map());
  const u = unc.find((e) => e.type === 'action.uncertain');
  assert.equal(u.status, 'uncertain');
  assert.match(u.headline, /unknown/);
  const ext = tl.fromExternalWrites([
    { id: 1, writer: 'nova.escalate', status: 'requested', authority: 'A3', initiated_by: 'nick', requested_at: at(0), target: 'NT-1' },
    { id: 2, writer: 'microsoft.task.complete', status: 'failed', authority: 'A3', initiated_by: 'nick', requested_at: at(1), target: 'x' },
    { id: 3, writer: 'microsoft.task.complete', status: 'confirmed', authority: 'A3', initiated_by: 'machine:mcp', requested_at: at(2), settled_at: at(2), target: 'y' },
  ]);
  assert.match(ext[0].headline, /outcome unknown/);
  assert.equal(ext[0].status, 'uncertain');
  assert.equal(ext[1].headline, 'NEURO could not complete a Microsoft task');
  assert.match(ext[2].headline, /read back/);
  assert.equal(ext[2].actor, 'external-system');
  const heal = tl.fromSelfHeal([{ attempt_id: 'h', source_id: 'microsoft.calendar', status: 'failed', started_at: at(0), executed_at: at(1), verified_at: at(12),
    op_outcome: 'ok', authority: 'A1', verification_json: JSON.stringify({ why: 'the retry ran and reported success, but no new delivery was recorded' }) }]);
  assert.equal(heal[1].status, 'failed');
  assert.match(heal[1].headline, /did not bring/);
  assert.ok(!heal.some((e) => /fixed|recovered after/i.test(e.headline)));
});

test('8. authority refusals are folded per machine, capability and day — a probing agent is one line with a count', () => {
  const row = (i, cap, day = '2026-10-06') => ({ id: i, event_type: 'authority_refused', date_key: day, created_at: `${day} 10:0${i}:00`,
    event_data: JSON.stringify({ machine: 'mcp-local', method: 'POST', path: '/api/prepared-actions/x/approve', capability: cap, status: 403 }) });
  const out = tl.fromRefusals([row(1, 'approval.decide'), row(2, 'approval.decide'), row(3, 'approval.decide'), row(4, 'jira.escalate'), row(5, 'approval.decide', '2026-10-05')]);
  assert.equal(out.length, 3);
  const folded = out.find((e) => e.metadata.capability === 'approval.decide' && e.occurredAt.startsWith('2026-10-06'));
  assert.equal(folded.metadata.count, 3);
  assert.equal(folded.category, 'blocked');
  assert.equal(folded.authority, 'A4');
});

test('9. nothing sensitive reaches an entry — no body, draft, address or payload, read through the real collect()', () => {
  db.run(`INSERT INTO prepared_actions (action_id, idempotency_key, finding_id, commitment_id, action_type, target_json, reason, evidence_json, draft_json, payload_hash, authority_class, status, created_at, history_json, updated_at)
          VALUES ('pa-priv', 'k-priv', 'f', 'c', 'chase_commitment', ?, 'SECRET-REASON', '[]', ?, 'h', 'A4', 'prepared', ?, '[]', ?)`,
  [JSON.stringify({ displayName: 'Naomi Wentworth', email: 'naomi@example.com' }), JSON.stringify({ subject: 'Re: PRIVATE SUBJECT', body: 'the private body text' }), at(0), at(0)]);
  db.logActivity('authority_refused', { machine: 'mcp', method: 'POST', path: '/api/x', capability: 'email.send', status: 403, body: 'leaked-body' }, '2026-10-06');
  const { entries } = tl.collect({ fromIso: at(-60), toIso: at(600) });
  const text = JSON.stringify(entries);
  assert.ok(entries.some((e) => e.actionRef === 'pa-priv'), 'positive control: the action IS in the timeline');
  for (const secret of ['naomi@example.com', 'Naomi', 'PRIVATE SUBJECT', 'private body', 'SECRET-REASON', 'leaked-body']) {
    assert.ok(!text.includes(secret), `"${secret}" must not appear`);
  }
});

test('10. "Today NEURO…" is counted off the entries, and an empty day says so instead of manufacturing anything', () => {
  assert.deepEqual(tl.summarise([]).lines, ['No autonomous actions today.']);
  const entries = [
    tl.entry({ id: 'a', occurredAt: at(0), category: 'investigated', type: 'investigation.concluded', headline: '', investigationRef: 'i1' }),
    tl.entry({ id: 'b', occurredAt: at(1), category: 'investigated', type: 'investigation.concluded', headline: '', investigationRef: 'i1' }),
    tl.entry({ id: 'c', occurredAt: at(2), category: 'acted', type: 'selfheal.executed', headline: '' }),
    tl.entry({ id: 'd', occurredAt: at(3), category: 'recovered', type: 'selfheal.recovered', headline: '', status: 'recovered' }),
  ];
  const s = tl.summarise(entries);
  assert.equal(s.counts.investigated, 1, 'two passes on one investigation is one issue');
  assert.equal(s.counts.fixed, 1);
  assert.deepEqual(s.lines.slice(0, 5), ['investigated 1 source issue', 'fixed 1 low-risk problem', 'verified 1 recovery or result', 'prepared 0 actions for approval', 'had 0 uncertain outcomes']);
  // An attempted-but-failed fix is not counted as fixed.
  const failed = tl.summarise([entries[2], tl.entry({ id: 'e', occurredAt: at(3), category: 'verified', type: 'selfheal.failed', headline: '', status: 'failed' })]);
  assert.equal(failed.counts.fixed, 0);
  // "Can't tell whether the hike happened" is not an uncertain outcome of NEURO's (caught live, 6 Oct).
  const hike = tl.entry({ id: 'g', occurredAt: at(4), category: 'sensed', type: 'goal.hike.uncertain', headline: '', status: 'uncertain' });
  const ext = tl.entry({ id: 'x', occurredAt: at(4), category: 'acted', type: 'external.nova.escalate', headline: '', status: 'uncertain' });
  assert.equal(tl.summarise([hike]).counts.uncertain, 0);
  assert.equal(tl.summarise([hike, ext]).counts.uncertain, 1, 'positive control');
  assert.match(failed.lines[1], /fixed 0 low-risk problems \(1 attempted\)/);
});

test('11. one lifecycle is not repeated — a recovery a self-heal verified is not also a second "recovered" line', () => {
  const f = { finding_id: 'f9', source_id: 'neuro.selftest', status: 'resolved', condition: 'failing', failure_count: 3, first_detected_at: at(0), resolved_at: at(10), resolution: 'recovered' };
  assert.equal(tl.fromFindings([f]).length, 2, 'positive control: alone, it is noticed + recovered');
  assert.deepEqual(tl.fromFindings([f], { healedOutages: new Set(['f9']) }).map((e) => e.type), ['source.stopped']);
});

test('12. ordering is stable — newest first, ties broken by id, identical on every read', () => {
  db.logActivity('feature_flag_changed', { key: 'self_heal', label: 'Let NEURO retry', from: true, to: false }, '2026-10-06');
  const a = tl.collect({ fromIso: at(-600), toIso: at(6000) }).entries.map((e) => e.id);
  const b = tl.collect({ fromIso: at(-600), toIso: at(6000) }).entries.map((e) => e.id);
  assert.deepEqual(a, b);
  const sorted = tl.collect({ fromIso: at(-600), toIso: at(6000) }).entries;
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i - 1].occurredAt > sorted[i].occurredAt || (sorted[i - 1].occurredAt === sorted[i].occurredAt && sorted[i - 1].id < sorted[i].id), 'newest first, then id');
  }
  const flag = tl.collect({ fromIso: '2026-10-01T00:00:00Z', toIso: '2099-01-01T00:00:00Z' }).entries.find((e) => e.type === 'switch.changed');
  assert.equal(flag.headline, 'You switched "Let NEURO retry" off');
  assert.equal(flag.actor, 'nick');
});

test('filters: problems / approvals / sources keep what they say and nothing else', () => {
  const nick = tl.entry({ id: 'n', occurredAt: at(0), category: 'decided', type: 'action.approved', headline: '', actor: 'nick', authority: 'A4' });
  const fail = tl.entry({ id: 'f', occurredAt: at(0), category: 'verified', type: 'selfheal.failed', headline: '', status: 'failed', sourceRefs: ['source:x'] });
  assert.ok(tl.matches(nick, 'approvals') && !tl.matches(fail, 'approvals'));
  assert.ok(tl.matches(fail, 'problems') && !tl.matches(nick, 'problems'));
  assert.ok(tl.matches(fail, 'sources') && !tl.matches(nick, 'sources'));
});
