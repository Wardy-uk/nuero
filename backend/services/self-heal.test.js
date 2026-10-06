'use strict';

/**
 * Build 15H–N — safe self-healing.
 *
 * Real DB, real event spine, real source-health + source-blindness folds, real
 * investigation runner and probes. Only the typed OP is injected (it stands in
 * for "re-run the sync"), and it proves itself the only way a real one can: by
 * publishing a delivery. Three outages on three retryable sources:
 *
 *   neuro.selftest          the retry works  → recovered, verified
 *   microsoft.calendar      the op says ok, nothing arrives → failed → manual
 *   homeassistant.presence  it recovers by itself first → the fix is cancelled
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-heal-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'h.db');
delete process.env.SOURCE_BLIND_MODE;
delete process.env.SELF_HEAL_ENABLED;

const db = require('../db/database');
const bus = require('./event-bus');
const sb = require('./source-blindness');
const inv = require('./investigations');
const heal = require('./self-heal');
const sbi = require('./source-blind-investigation');
const matrix = require('./authority-matrix');
const timeline = require('./activity-timeline');

test.before(async () => { await db.init(); });

const M = 60 * 1000;
const H = 60 * M;
const T0 = Date.parse('2026-10-06T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let k = 0;
function syncRun(sourceId, ms, ok, error = 'Graph answered HTTP 503 Service Unavailable') {
  const runId = `r${++k}`;
  bus.publishEvent({ type: 'source.sync.started', occurredAt: iso(ms), source: { system: 'test', recordId: runId }, subject: { entityType: 'source', entityId: sourceId },
    idempotencyKey: `t:${runId}:s`, payload: { sourceId, runId, expectedIntervalMs: H, staleAfterMs: 3 * H } }, { now: ms });
  bus.publishEvent({ type: ok ? 'source.sync.succeeded' : 'source.sync.failed', occurredAt: iso(ms + 1000), source: { system: 'test', recordId: runId },
    subject: { entityType: 'source', entityId: sourceId }, idempotencyKey: `t:${runId}:o`, payload: ok ? { sourceId, runId } : { sourceId, runId, error } }, { now: ms + 1000 });
}
const pump = (now) => bus.pumpAll({ now });
const probes = () => ({ ...inv.defaultProbes(), 'process-uptime': () => ({ uptimeMs: 1000 }) });
const calls = { 'neuro.selftest': 0, 'microsoft.calendar': 0, 'homeassistant.presence': 0 };
let clockMs = T0;
const ops = {
  // A retry that works: it produces a real delivery, after the attempt started.
  'neuro.selftest': async () => { calls['neuro.selftest'] += 1; syncRun('neuro.selftest', clockMs + 20 * 1000, true); return { ok: true }; },
  // A retry that SAYS it worked and produces nothing.
  'microsoft.calendar': async () => { calls['microsoft.calendar'] += 1; return { ok: true, result: { synced: 0 } }; },
  'homeassistant.presence': async () => { calls['homeassistant.presence'] += 1; return { ok: true }; },
};
const deps = () => ({ probes: probes(), selfHealDeps: { ops, bootId: () => 'boot-A', clock: () => clockMs + 30 * 1000 } });
const run = async (ms) => { clockMs = ms; await pump(ms); return inv.runSourceBlindInvestigations({ now: ms, deps: deps() }); };
const invFor = (s) => inv.list({ limit: 50 }).find((i) => i.subjectRef === `source:${s}`);
const attemptFor = (s) => heal.list().find((a) => a.sourceId === s);

test('setup: three healthy pull sources, then three failures each (upstream 503)', async () => {
  for (const s of Object.keys(ops)) syncRun(s, T0 - 2 * H, true);
  await pump(T0 - H);
  for (let i = 0; i < 3; i += 1) for (const s of Object.keys(ops)) syncRun(s, T0 + i * M, false);
  await pump(T0 + 10 * M);
  for (const s of Object.keys(ops)) {
    assert.ok(sb.getFindings({ status: 'active', now: T0 + 10 * M }).some((f) => f.source === s && f.condition === 'failing'), `positive control: ${s} has a live failing finding`);
  }
});

test('21. a recovery BEFORE the action cancels the fix (and is recorded once)', async () => {
  // presence comes back on its own before NEURO looks.
  syncRun('homeassistant.presence', T0 + 11 * M, true);
  await pump(T0 + 12 * M);
  // The finding closes on that success, so no investigation is even started for it.
  assert.ok(!sb.getFindings({ status: 'active', now: T0 + 12 * M }).some((f) => f.source === 'homeassistant.presence'));
  // Pure rule, with a still-open finding but a healthy source: refused, still-failing.
  const a = heal.assess({ isEnabled: true, inv: { preparedAction: { kind: 'retry-sync', status: 'prepared' }, hypotheses: [{ type: 'upstream-unavailable', level: 'high', contradictingEvidenceRefs: [] }], evidence: [] },
    sourceId: 'homeassistant.presence', sourceRow: { state: 'healthy', freshness: 'fresh' }, findingActive: true, existingAttempt: null, matrix });
  assert.equal(a.eligible, false);
  assert.equal(a.rule, 'still-failing');
});

test('13. a high-confidence, allowlisted A1 fix executes once; 18. recovery is VERIFIED from the source', async () => {
  const r = await run(T0 + 15 * M);
  assert.ok(r.started >= 2);
  const i = invFor('neuro.selftest');
  assert.equal(i.hypotheses[0].type, 'upstream-unavailable');
  assert.equal(i.hypotheses[0].level, 'high', 'source health + blind state, both failing-upstream');
  assert.equal(r.selfHeal.considered.executed, 2, 'selftest and calendar both qualify');
  assert.equal(calls['neuro.selftest'], 1);
  const a = attemptFor('neuro.selftest');
  assert.equal(a.status, 'verifying', 'executed is not verified');
  assert.equal(a.authority, 'A1');
  assert.equal(a.opOutcome, 'ok');
  assert.equal(invFor('neuro.selftest').state, 'fixing');
  // Next pass, after the delivery has been folded: verified recovered.
  await run(T0 + 18 * M);
  const v = heal.get(a.attemptId);
  assert.equal(v.status, 'recovered');
  assert.match(v.verification.why, /new successful delivery/);
  assert.equal(v.verification.basis.findingActive, false);
  assert.equal(invFor('neuro.selftest').preparedAction.status, 'verified');
  assert.equal(invFor('neuro.selftest').state, 'resolved', 'the investigation closed on the recovery');
});

test('19. command success WITHOUT source recovery is a failure, not a fix; 23. it becomes a manual step', async () => {
  const a0 = attemptFor('microsoft.calendar');
  assert.equal(a0.opOutcome, 'ok', 'the op reported success');
  await run(T0 + 18 * M);
  assert.equal(heal.get(a0.attemptId).status, 'verifying', 'inside the window it is still pending, never "fixed"');
  await run(T0 + 30 * M); // past the 10-minute window
  const a = heal.get(a0.attemptId);
  assert.equal(a.status, 'failed');
  assert.match(a.reason, /not recovery/);
  const i = invFor('microsoft.calendar');
  assert.equal(i.state, 'prepared');
  assert.equal(i.preparedAction.requiresHuman, true);
  assert.equal(i.preparedAction.autoAttempt.outcome, 'failed');
  assert.equal(inv.attentionView(i).eligible, true, 'the attention policy may now offer it to Nick');
  assert.match(inv.summaryFor(i).actionTaken, /did not recover/);
});

test('17/22. one attempt per outage — repeated passes never repeat the fix', async () => {
  for (let i = 1; i <= 4; i += 1) await run(T0 + (30 + i * 5) * M);
  assert.equal(calls['microsoft.calendar'], 1);
  assert.equal(calls['neuro.selftest'], 1);
  assert.throws(() => db.run(`INSERT INTO self_heal_attempts (attempt_id, outage_key, fix_kind, op, investigation_id, source_id, authority, capability, status, requested_at)
    VALUES ('x', ?, 'retry-sync', 'o', 'i', 's', 'A1', 'c', 'requested', 'now')`, [attemptFor('microsoft.calendar').outageKey]), /UNIQUE/);
  assert.throws(() => db.run(`UPDATE self_heal_attempts SET status = 'recovered' WHERE attempt_id = ?`, [attemptFor('microsoft.calendar').attemptId]), /immutable/);
});

test('14. medium confidence recommends only; 15. A4 never executes; 16. nothing off the list runs', () => {
  const base = { isEnabled: true, sourceId: 'neuro.selftest', sourceRow: { state: 'failing', freshness: 'fresh' }, findingActive: true, existingAttempt: null, matrix };
  const good = { preparedAction: { kind: 'retry-sync', status: 'prepared' }, hypotheses: [{ type: 'upstream-unavailable', level: 'high', contradictingEvidenceRefs: [] }], evidence: [] };
  assert.equal(heal.assess({ ...base, inv: good }).eligible, true, 'positive control');
  const medium = { ...good, hypotheses: [{ ...good.hypotheses[0], level: 'medium' }] };
  assert.equal(heal.assess({ ...base, inv: medium }).rule, 'confidence');
  const contra = { ...good, hypotheses: [{ ...good.hypotheses[0], contradictingEvidenceRefs: ['ev:x'] }] };
  assert.equal(heal.assess({ ...base, inv: contra }).rule, 'confidence');
  const unreadable = { ...good, evidence: [{ status: 'unavailable' }] };
  assert.equal(heal.assess({ ...base, inv: unreadable }).rule, 'evidence');
  // A4 — even if someone pointed the allowlist at an A4 capability.
  const a4 = { CAPABILITIES: { ...matrix.CAPABILITIES, 'source.retry-sync': { ...matrix.CAPABILITIES['source.retry-sync'], authority: 'A4' } } };
  assert.equal(heal.assess({ ...base, inv: good, matrix: a4 }).rule, 'authority');
  const a3 = { CAPABILITIES: { ...matrix.CAPABILITIES, 'source.retry-sync': { ...matrix.CAPABILITIES['source.retry-sync'], authority: 'A3' } } };
  assert.equal(heal.assess({ ...base, inv: good, matrix: a3 }).rule, 'authority', 'A3 needs an explicit selfHeal pre-authorisation');
  for (const kind of Object.keys(heal.ALLOWLIST)) assert.notEqual(matrix.CAPABILITIES[heal.ALLOWLIST[kind].capability].authority, 'A4');
  // Off the list: an arbitrary kind, and the allowed kind on an undeclared source.
  assert.equal(heal.assess({ ...base, inv: { ...good, preparedAction: { kind: 'run-shell', status: 'prepared' } } }).rule, 'allowlist');
  assert.equal(heal.assess({ ...base, sourceId: 'anything.else', inv: good }).rule, 'typed-op');
  assert.equal(heal.opFor('retry-sync', 'constructor'), null, 'no prototype key reaches an op');
  for (const ops of Object.values(heal.OPS)) for (const op of Object.values(ops)) assert.equal(op.run.length, 0, `${op.name} takes no arguments — there is nothing to inject`);
  assert.deepEqual(Object.keys(heal.OPS['retry-sync']).sort(), [...sbi.RETRYABLE_SOURCES].sort(), 'the investigation and the executor agree on what is retryable');
  // Off switch.
  assert.equal(heal.assess({ ...base, inv: good, isEnabled: false }).rule, 'switched-on');
});

test('20. a restart between the ledger write and the answer RESUMES verification, never repeats the op', async () => {
  const at = T0 + 60 * M;
  db.run(`INSERT INTO self_heal_attempts (attempt_id, outage_key, fix_kind, op, investigation_id, source_id, authority, capability, status, boot_id, requested_at, started_at)
          VALUES ('heal:crash', 'finding-crash', 'retry-sync', 'run-selftest-sync', 'inv-crash', 'neuro.selftest', 'A1', 'source.retry-sync', 'executing', 'boot-OLD', ?, ?)`, [iso(at), iso(at)]);
  const before = calls['neuro.selftest'];
  const r = heal.verifyPending({ nowMs: at + M, deps: { bootId: () => 'boot-NEW', sourceRow: () => ({ state: 'failing', freshness: 'fresh', last_success_at: null }), findingActive: () => true } });
  assert.equal(r.recoveredStuck, 1);
  const a = heal.get('heal:crash');
  assert.equal(a.status, 'verifying');
  assert.equal(a.opOutcome, 'unknown');
  assert.equal(calls['neuro.selftest'], before, 'the op was not run again');
  heal.verifyPending({ nowMs: at + 20 * M, deps: { bootId: () => 'boot-NEW', sourceRow: () => ({ state: 'failing', freshness: 'fresh', last_success_at: null }), findingActive: () => true } });
  assert.equal(heal.get('heal:crash').status, 'failed');
});

test('21b. end to end: the source is seen healthy at the moment of acting → the fix is CANCELLED, recorded once, the op never runs', async () => {
  const t = T0 + 70 * M;
  for (let i = 0; i < 3; i += 1) syncRun('homeassistant.presence', t + i * M, false);
  await pump(t + 5 * M);
  // Investigate with self-heal held back, so the fix is prepared and waiting.
  await inv.runSourceBlindInvestigations({ now: t + 5 * M, deps: { probes: probes(), selfHeal: false } });
  const i = invFor('homeassistant.presence');
  assert.equal(i.preparedAction.kind, 'retry-sync', 'positive control: a retry was prepared');
  const before = calls['homeassistant.presence'];
  const d = { ops, bootId: () => 'boot-A', sourceRow: () => ({ state: 'healthy', freshness: 'fresh', last_success_at: iso(t + 6 * M) }), findingActive: () => true };
  const r = await heal.pass({ now: t + 7 * M, deps: d });
  assert.equal(r.considered.cancelled, 1);
  await heal.pass({ now: t + 8 * M, deps: d });
  const rows = heal.list().filter((a) => a.sourceId === 'homeassistant.presence');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.match(rows[0].reason, /recovered before NEURO acted/);
  assert.equal(calls['homeassistant.presence'], before, 'nothing ran');
});

test('judge: unreadable past the window is UNCERTAIN; source health and the finding disagreeing is uncertain', () => {
  const attempt = { started_at: iso(T0), verify_by: iso(T0 + 10 * M), op_outcome: 'ok' };
  assert.equal(heal.judge({ attempt, sourceRow: null, findingActive: null, nowMs: T0 + 5 * M }).outcome, 'pending');
  assert.equal(heal.judge({ attempt, sourceRow: null, findingActive: null, nowMs: T0 + 11 * M }).outcome, 'uncertain');
  const healthy = { state: 'healthy', freshness: 'fresh', last_success_at: iso(T0 + M) };
  assert.equal(heal.judge({ attempt, sourceRow: healthy, findingActive: true, nowMs: T0 + 11 * M }).outcome, 'uncertain');
  assert.equal(heal.judge({ attempt, sourceRow: healthy, findingActive: false, nowMs: T0 + 2 * M }).outcome, 'recovered');
  // A success from BEFORE the attempt is not recovery.
  const old = { state: 'healthy', freshness: 'fresh', last_success_at: iso(T0 - M) };
  assert.equal(heal.judge({ attempt, sourceRow: old, findingActive: false, nowMs: T0 + 11 * M }).outcome, 'failed');
});

test('24. Activity shows the whole lifecycle — noticed, investigated, retried, recovered — once each', () => {
  const { entries } = timeline.collect({ fromIso: iso(T0 - 3 * H), toIso: iso(T0 + 2 * H) });
  // (test 20's synthetic crash row is its own outage — excluded by its key)
  const mine = entries.filter((e) => (e.sourceRefs || []).includes('source:neuro.selftest') && e.findingRef !== 'finding-crash').reverse();
  assert.deepEqual(mine.map((e) => e.type), ['source.stopped', 'investigation.concluded', 'selfheal.executed', 'selfheal.recovered']);
  assert.match(mine[1].summary, /provider is answering with errors.*High/);
  assert.equal(mine[2].authority, 'A1');
  assert.match(mine[3].headline, /recovered after the retry/);
  // The failed one is honest: attempted, did not come back, handed over.
  const cal = entries.filter((e) => (e.sourceRefs || []).includes('source:microsoft.calendar')).map((e) => e.type);
  assert.ok(cal.includes('selfheal.failed'));
  assert.ok(cal.includes('investigation.handed-over'));
  assert.ok(!entries.some((e) => /fixed/i.test(e.headline) && e.status !== 'recovered'), 'nothing says fixed without a verified recovery');
});
