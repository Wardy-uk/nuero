'use strict';

/**
 * Build 17E–K — repeated source degradation, the second bounded investigation.
 * Fixtures copy REAL producer payloads off the live spine (2–7 Oct 2026):
 * HA presence timeouts ("The operation was aborted due to timeout",
 * reason "unreachable"), calendar's empty Graph answer (reason "no-events"),
 * the Build 13 deploy bug ("fetchStates is not a function"), the staged
 * canary ("selftest-fault"), and the iPhone apps' overnight stale episodes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-degr-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'd.db');
process.env.NEURO_TIMEZONE = 'Europe/London';

const db = require('../db/database');
const sd = require('./source-degradation');
const di = require('./degradation-investigations');
const invs = require('./investigations');

test.before(async () => { await db.init(); });

const localMinute = (ms) => require('./world-model').localMinute(ms);
const NOW = Date.parse('2026-10-07T12:00:00Z');
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();

// One failure episode for a pull source: N failed runs then a success.
function failEp(sourceId, startMs, { reason = 'unreachable', error = 'The operation was aborted due to timeout', runs = 1, recoverAfterMin = 2 } = {}) {
  const evs = [];
  for (let i = 0; i < runs; i += 1) evs.push({ type: 'source.sync.failed', occurredAt: iso(startMs + i * 60000), reason, error });
  evs.push({ type: 'source.sync.succeeded', occurredAt: iso(startMs + recoverAfterMin * 60000) });
  return evs;
}
const annotate = (eps, boots = []) => sd.annotate(eps, { boots, localMinute });

test('13. one transient failure does not investigate', () => {
  const eps = annotate(sd.failureEpisodes('homeassistant.presence', failEp('homeassistant.presence', NOW - 20 * H)));
  assert.equal(eps.length, 1);
  assert.equal(eps[0].excluded, null);
  const cl = sd.cluster(eps, NOW);
  assert.equal(cl.triggered, false);
  // Even two (the live replay: HA's two timeouts on 6 and 7 Oct) do not.
  const two = annotate(sd.failureEpisodes('homeassistant.presence', [...failEp('homeassistant.presence', NOW - 40 * H), ...failEp('homeassistant.presence', NOW - 20 * H)]));
  assert.equal(sd.cluster(two, NOW).triggered, false);
});

test('14. recurring episodes form ONE cluster that triggers', () => {
  const evs = [0, 1, 2, 3].flatMap((d) => failEp('homeassistant.presence', NOW - (4 - d) * 24 * H));
  const eps = annotate(sd.failureEpisodes('homeassistant.presence', evs));
  const cl = sd.cluster(eps, NOW);
  assert.equal(cl.triggered, true);
  assert.equal(cl.counted, 4);
  assert.equal(cl.episodes[0].recovery, 'sync-succeeded');
  // Three spread over three weeks is not the pattern.
  const spread = annotate(sd.failureEpisodes('homeassistant.presence', [0, 9, 18].flatMap((d) => failEp('homeassistant.presence', NOW - (20 - d) * 24 * H))));
  assert.equal(sd.cluster(spread, NOW).triggered, false, 'too far apart to be one cluster');
  // One cluster (each gap 5 days) whose last three span 10 days: still not the pattern.
  const slow = annotate(sd.failureEpisodes('homeassistant.presence', [0, 5, 10].flatMap((d) => failEp('homeassistant.presence', NOW - (11 - d) * 24 * H))));
  const sc = sd.cluster(slow, NOW);
  assert.equal(sc.counted, 3, 'positive control: one cluster of three');
  assert.equal(sc.triggered, false, 'the last three must fall within 7 days');
});

test('15. normal iOS overnight quiet is excluded — evening to morning, recovered before 14:00', () => {
  // Live: reminders.saim-ios, silent from 20:12 BST, back at 13:26 BST next day.
  const stale = sd.staleEpisodes('reminders.saim-ios', [
    { condition: 'stale', basisAt: '2026-10-03T19:12:32.892Z', firstDetectedAt: '2026-10-04T07:15:05.928Z', resolvedAt: '2026-10-04T12:26:45.802Z', resolution: 'recovered' },
    { condition: 'stale', basisAt: '2026-10-04T19:00:00.000Z', firstDetectedAt: '2026-10-05T07:00:00.000Z', resolvedAt: '2026-10-05T07:30:00.000Z', resolution: 'recovered' },
    { condition: 'stale', basisAt: '2026-10-05T19:30:00.000Z', firstDetectedAt: '2026-10-06T07:30:00.000Z', resolvedAt: '2026-10-06T06:45:00.000Z', resolution: 'recovered' },
    { condition: 'stale', basisAt: '2026-10-06T20:30:00.000Z', firstDetectedAt: '2026-10-07T08:30:00.000Z', resolvedAt: '2026-10-07T07:15:00.000Z', resolution: 'recovered' },
  ]);
  const eps = annotate(stale);
  assert.deepEqual(eps.map((e) => e.excluded), ['expected-overnight', 'expected-overnight', 'expected-overnight', 'expected-overnight']);
  assert.equal(sd.cluster(eps, NOW).triggered, false, 'four nights of normal iPhone sleep raise nothing');
  // Positive control: the same app silent through the DAY counts.
  const day = annotate(sd.staleEpisodes('reminders.saim-ios', [{ condition: 'stale', basisAt: '2026-10-04T11:26:00Z', firstDetectedAt: '2026-10-04T23:30:00Z', resolvedAt: '2026-10-05T10:00:00Z', resolution: 'recovered' }]));
  assert.equal(day[0].excluded, null);
  // A desktop agent is not an iPhone: its overnight silence is not excused.
  const agent = annotate(sd.staleEpisodes('desktop.agent', [{ condition: 'stale', basisAt: '2026-10-04T19:00:00Z', firstDetectedAt: '2026-10-05T07:00:00Z', resolvedAt: '2026-10-05T07:30:00Z', resolution: 'recovered' }]));
  assert.equal(agent[0].excluded, null);
  // Quiet-by-transport (location) is never degradation.
  const quiet = annotate(sd.staleEpisodes('location.neuro-ios', [{ condition: 'stale', basisAt: '2026-10-02T19:27:40Z', firstDetectedAt: '2026-10-03T07:35:00Z', resolvedAt: '2026-10-03T09:20:05Z', resolution: 'transport-alive' }]));
  assert.equal(quiet[0].excluded, 'quiet');
});

test('16. a deploy/restart episode is excluded — and so are NEURO\'s own bug and the staged canary', () => {
  const boot = Date.parse('2026-10-06T12:24:30Z');
  const deploy = annotate(sd.failureEpisodes('homeassistant.presence', failEp('homeassistant.presence', Date.parse('2026-10-06T12:26:00Z'), { error: 'The operation was aborted due to timeout' })), [boot]);
  assert.equal(deploy[0].excluded, 'deploy-restart');
  assert.match(deploy[0].nearBootAt, /2026-10-06T12:24/);
  const bug = annotate(sd.failureEpisodes('homeassistant.presence', failEp('homeassistant.presence', Date.parse('2026-10-06T15:00:00Z'), { error: 'fetchStates is not a function' })));
  assert.equal(bug[0].excluded, 'neuro-code');
  const canary = annotate(sd.failureEpisodes('neuro.selftest', failEp('neuro.selftest', NOW - H, { reason: 'selftest-fault', error: 'simulated upstream outage: HTTP 503', runs: 3 })));
  assert.equal(canary[0].excluded, 'staged-canary');
  const open = annotate(sd.failureEpisodes('microsoft.calendar', [{ type: 'source.sync.failed', occurredAt: iso(NOW - H), reason: 'no-events', error: 'no events returned' }]));
  assert.equal(open[0].excluded, 'still-unhealthy', 'not recovered = blindness, not degradation');
  // Positive control: the same timeout away from any boot counts.
  const ordinary = annotate(sd.failureEpisodes('homeassistant.presence', failEp('homeassistant.presence', Date.parse('2026-10-07T08:40:00Z'))), [boot]);
  assert.equal(ordinary[0].excluded, null);
});

// ── the runner, against a real DB ─────────────────────────────────────────

function seedHaEpisodes(n, { startDaysAgo = 4, everyHours = 20 } = {}) {
  for (let i = 0; i < n; i += 1) {
    const t = NOW - startDaysAgo * 24 * H + i * everyHours * H;
    for (const [type, at, p] of [['source.sync.failed', t, { reason: 'unreachable', error: 'The operation was aborted due to timeout', sourceId: 'homeassistant.presence' }],
      ['source.sync.succeeded', t + 120000, { sourceId: 'homeassistant.presence' }]]) {
      db.run(`INSERT INTO event_log (event_id, schema_version, type, occurred_at, received_at, source_system, source_json, subject_type, subject_id, correlation_id, idempotency_key, payload, payload_hash, provenance_kind)
              VALUES (?, 1, ?, ?, ?, 'neuro', '{}', 'source', 'homeassistant.presence', ?, ?, ?, 'x', 'fact')`,
      [`e-${type}-${at}`, type, iso(at), iso(at), `c-${at}`, `k-${type}-${at}`, JSON.stringify(p)]);
    }
  }
}
const quietProbes = () => {
  const base = di.defaultProbes();
  return { ...base, 'provider-check': () => ({ answering: true, auth: null, status: 200 }) };
};
const deps = (extra = {}) => ({ boots: [], sources: ['homeassistant.presence'], probes: quietProbes(), readMoment: async () => ({ moment: { known: true, onDuty: true, now: new Date(NOW) } }), ...extra });

test('17. the runner dedupes by CLUSTER — a second pass writes nothing; a new episode re-gathers the SAME investigation', async () => {
  seedHaEpisodes(3);
  const r1 = await di.run({ now: NOW, deps: deps() });
  assert.equal(r1.started, 1, JSON.stringify(r1));
  const all = invs.list({ limit: 50 }).filter((i) => i.type === sd.TYPE);
  assert.equal(all.length, 1);
  const before = invs.events(all[0].id).length;
  const r2 = await di.run({ now: NOW + 60000, deps: deps() });
  assert.equal(r2.started, 0); assert.equal(r2.regathered, 0);
  assert.equal(invs.events(all[0].id).length, before, 'unchanged cluster → nothing written');
  seedHaEpisodes(1, { startDaysAgo: 0.5 });
  const r3 = await di.run({ now: NOW + 2 * H, deps: deps() });
  assert.equal(r3.regathered, 1);
  assert.equal(invs.list({ limit: 50 }).filter((i) => i.type === sd.TYPE).length, 1, 'still one investigation for the cluster');
});

test('18/19/21. evidence budget enforced; only the fixed hypotheses; MONITOR an intermittent provider — no fix, no execution', async () => {
  const inv = invs.list({ limit: 50 }).find((i) => i.type === sd.TYPE);
  assert.ok(inv.budget.calls <= sd.MAX_PROBES);
  assert.equal(inv.budget.maxProbes, sd.MAX_PROBES);
  for (const h of inv.hypotheses) assert.ok(sd.HYPOTHESES.includes(h.type), h.type);
  for (const e of inv.evidence) assert.ok(sd.PROBES.includes(e.probe), e.probe);
  assert.equal(inv.hypotheses[0].type, 'upstream-intermittent');
  assert.equal(inv.decision, 'MONITOR');
  assert.equal(inv.preparedAction, null);
  // The budget is a hard stop: with room for two probes the rest are skipped.
  const g = await invs.gather('homeassistant.presence', sd.plan('homeassistant.presence', require('./native-sources').describe),
    { probes: quietProbes(), budget: { maxProbes: 2 }, allowed: sd.PROBES, context: { cluster: inv.budget.cluster, boots: [] } });
  assert.equal(g.calls, 2); assert.equal(g.exhausted, true);
  // A probe outside this type's closed list is refused, not run.
  const r = await invs.gather('homeassistant.presence', ['source-health'], { probes: { 'source-health': () => ({}) }, allowed: sd.PROBES });
  assert.equal(r.results[0].status, 'refused');
  // No fix this type prepares can execute, and none is a retry.
  for (const kind of ['open-app', 'relaunch-agent', 'reconnect-account']) {
    const p = require('./source-blind-investigation').prepareFix(kind, { matrix: require('./authority-matrix'), investigationId: 'x', version: 1 });
    assert.equal(p.fix.executes, false); assert.equal(p.fix.requiresHuman, true);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'degradation-investigations.js'), 'utf8'), /self-heal'\)\.|runNow\(|child_process|sendToAll/);
  // Self-heal still reads only source-blindness investigations.
  assert.match(fs.readFileSync(path.join(__dirname, 'self-heal.js'), 'utf8'), /if \(inv\.type !== TYPE\) continue;/);
});

test('21b. an app that keeps stopping PREPARES a manual step — and only that', () => {
  const items = sd.toEvidence('desktop.agent', { episodes: [{ durationMs: 3 * H }, { durationMs: 4 * H }, { durationMs: 2 * H }], excludedInPeriod: [] }, [
    { probe: 'episode-history', status: 'ok', data: {} },
    { probe: 'app-heartbeat', status: 'ok', data: { perEpisode: [{ siblingsDelivered: false }, { siblingsDelivered: false }, { siblingsDelivered: false }] } },
    { probe: 'queue-reports', status: 'ok', data: { degraded: 0 } },
    { probe: 'investigation-history', status: 'ok', data: { blindness: 1 } },
  ]);
  const h = sd.hypothesise(items, { push: true });
  assert.equal(h[0].type, 'app-repeatedly-stopping');
  assert.equal(h[0].level, 'high');
  const d = sd.decide({ hypotheses: h, sourceId: 'desktop.agent', cl: { triggered: true, stableAgain: false } });
  assert.equal(d.decision, 'PREPARE'); assert.equal(d.fixKind, 'relaunch-agent');
  // The same pattern on an iPhone app is the platform, not a fault → IGNORE.
  const ios = sd.toEvidence('reminders.neuro-ios', { episodes: [{}, {}, {}], excludedInPeriod: [] }, [
    { probe: 'episode-history', status: 'ok', data: {} },
    { probe: 'app-heartbeat', status: 'ok', data: { perEpisode: [{ siblingsDelivered: false }, { siblingsDelivered: false }, { siblingsDelivered: false }] } },
  ]);
  const hi = sd.hypothesise(ios, { push: true });
  assert.equal(hi[0].type, 'expected-platform-background');
  assert.equal(sd.decide({ hypotheses: hi, sourceId: 'reminders.neuro-ios', cl: { triggered: true, stableAgain: false } }).decision, 'IGNORE');
});

test('20. recovery does not create a notification — and a MONITOR is never offered to Nick', async () => {
  const inv = invs.list({ limit: 50 }).find((i) => i.type === sd.TYPE);
  const s = di.summaryFor(inv);
  assert.equal(s.attention.eligible, false);
  assert.match(s.attention.why, /nothing for Nick to do/);
  assert.ok(!invs.events(inv.id).some((e) => e.transition === 'attention'), 'nothing was even asked');
  // A week later with no new episode: closed as stable again, silently.
  const r = await di.run({ now: NOW + 9 * 24 * H, deps: deps() });
  assert.equal(r.resolved, 1);
  const closed = invs.get(inv.id);
  assert.equal(closed.state, 'resolved'); assert.equal(closed.stopReason, 'stable-again');
  // Eligibility needs consequence: a prepared manual step at only 3 episodes is still not offered.
  const prepared = { state: 'prepared', preparedAction: { status: 'prepared', requiresHuman: true }, hypotheses: [{ type: 'app-repeatedly-stopping', level: 'high' }] };
  assert.equal(sd.attentionView(prepared, { inWindow: 3, unhealthyMsInWindow: 2 * H }).eligible, false);
  assert.equal(sd.attentionView(prepared, { inWindow: 5, unhealthyMsInWindow: 2 * H }).eligible, true, 'positive control at the consequential threshold');
  assert.equal(sd.attentionView({ ...prepared, hypotheses: [{ type: 'unknown', level: 'low' }] }, { inWindow: 9 }).eligible, false);
});

test('22. unknown remains a valid answer — nothing said without evidence', () => {
  const h = sd.hypothesise([{ id: 'ev:episode-history:1', probe: 'episode-history', status: 'ok', signal: 'client-not-mobile' }], { push: false });
  assert.equal(h[0].type, 'unknown');
  const d = sd.decide({ hypotheses: h, sourceId: 'microsoft.calendar', cl: { triggered: true, stableAgain: false } });
  assert.equal(d.decision, 'MONITOR'); assert.equal(d.stopReason, 'inconclusive');
  // A tie at the top is not an answer either.
  // Two causes, one probe each (auth reasons; an unstable job) — medium vs medium.
  const tie = sd.hypothesise([
    { id: 'a', probe: 'failure-reasons', status: 'ok', signal: 'reasons-auth' },
    { id: 'b', probe: 'sync-job', status: 'ok', signal: 'job-unstable' },
  ], { push: false });
  assert.equal(tie[0].type, 'unknown');
  assert.deepEqual(tie.slice(1).map((h) => h.level), ['medium', 'medium'], 'positive control: both were real candidates');
  // Network errors at the SAME moments as other senses → connectivity, high.
  const net = sd.hypothesise([
    { id: 'a', probe: 'failure-reasons', status: 'ok', signal: 'reasons-network' },
    { id: 'b', probe: 'co-occurrence', status: 'ok', signal: 'cross-source' },
  ], { push: false });
  assert.equal(net[0].type, 'connectivity-intermittent'); assert.equal(net[0].level, 'high');
});

test('Activity shows the conclusion and the close — never the episodes', () => {
  const tl = require('./activity-timeline');
  const { entries } = tl.collect({ fromIso: iso(NOW - 10 * 24 * H), toIso: iso(NOW + 10 * 24 * H) });
  const mine = entries.filter((e) => e.type.startsWith('investigation.degradation'));
  assert.ok(mine.some((e) => e.type === 'investigation.degradation' && /keeps dropping out/.test(e.headline)));
  assert.ok(mine.some((e) => e.type === 'investigation.degradation-closed'));
  assert.ok(mine.length <= 4, `concise: ${mine.length}`);
});
