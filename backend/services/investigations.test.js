'use strict';

/**
 * Build 14Y — the bounded "a sense went blind" investigation.
 *
 * Real DB, real event spine, real source-health + source-blindness folds, real
 * probes reading them. The scenario: the SAiM iPhone app stops — all its senses
 * go quiet together — while the NEURO app keeps delivering.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-inv-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'i.db');
delete process.env.SOURCE_BLIND_MODE;

const db = require('../db/database');
const bus = require('./event-bus');
const sh = require('./source-health');
const sb = require('./source-blindness');
const inv = require('./investigations');
const sbi = require('./source-blind-investigation');
const matrix = require('./authority-matrix');
const webpush = require('./webpush');

test.before(async () => { await db.init(); });

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-01T08:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let k = 0;
function deliver(sourceId, observedMs, receivedMs = observedMs + 60000) {
  return bus.publishEvent({
    type: 'source.observation.received', occurredAt: iso(observedMs), source: { system: 'test' }, idempotencyKey: `inv-${++k}`,
    payload: { sourceId, deliveryId: `d${k}`, newestObservedAt: iso(observedMs), expectedIntervalMs: H, staleAfterMs: 12 * H },
  }, { now: receivedMs }).event;
}
const pump = (now) => bus.pumpAll({ now });
const SAIM = ['healthkit.saim-ios', 'eventkit.saim-ios', 'reminders.saim-ios'];
const NEURO = ['healthkit.neuro-ios', 'eventkit.neuro-ios', 'reminders.neuro-ios', 'device.neuro-ios', 'location.neuro-ios'];
const counts = () => ({ inv: db.get('SELECT COUNT(*) AS n FROM investigations').n, ev: db.get('SELECT COUNT(*) AS n FROM investigation_events').n });
const forSource = (s) => db.all('SELECT * FROM investigations WHERE subject_ref = ?', [`source:${s}`]);
// The uptime probe reads the real process; pin it so a test run's own start
// time can never land "near" the fixture's silence.
const probes = () => ({ ...inv.defaultProbes(), 'process-uptime': () => ({ uptimeMs: 1000 }) });
let pushed = 0;

test('setup: both apps deliver, then SAiM stops while NEURO carries on', async () => {
  webpush.sendToAll = async () => { pushed += 1; };
  for (const s of [...SAIM, ...NEURO]) deliver(s, T0);
  await pump(T0 + 2 * 60000);
  for (let h = 1; h <= 40; h += 1) for (const s of NEURO) deliver(s, T0 + h * H);
  await pump(T0 + 40 * H);
});

test('14Y.13 normal quiet (stale at 13h, under the 30h live bar) does NOT investigate', async () => {
  await sh.checkStaleness({ now: T0 + 13 * H });
  await pump(T0 + 13 * H);
  assert.ok(sb.getFindings({ status: 'active', now: T0 + 13 * H }).some((f) => f.source === 'eventkit.saim-ios'), 'positive control: a finding exists');
  const r = await inv.runSourceBlindInvestigations({ now: T0 + 13 * H, deps: { probes: probes() } });
  assert.equal(r.started, 0);
  assert.equal(counts().inv, 0);
});

test('14Y.1 one outage creates ONE investigation per blind source, gathered and decided', async () => {
  await sh.checkStaleness({ now: T0 + 31 * H });
  await pump(T0 + 31 * H);
  const r = await inv.runSourceBlindInvestigations({ now: T0 + 31 * H, deps: { probes: probes() } });
  assert.equal(r.started, SAIM.length);
  for (const s of SAIM) assert.equal(forSource(s).length, 1, s);
  const one = inv.byDedupe(`source_blindness:eventkit.saim-ios:${forSource('eventkit.saim-ios')[0].trigger_ref}`);
  assert.equal(one.hypotheses[0].type, 'agent-not-running');
  assert.equal(one.hypotheses[0].level, 'high', 'siblings stopped together + server ingestion alive: two independent probes');
  assert.equal(one.decision, 'PREPARE');
  assert.equal(one.state, 'prepared');
  assert.equal(one.preparedAction.kind, 'open-app');
  assert.equal(one.preparedAction.executes, false);
  assert.equal(one.stopReason, 'cause-identified');
});

test('14Y.2 polling does not duplicate it, and writes nothing while nothing changed', async () => {
  const before = counts();
  for (const h of [31.25, 31.5, 32]) {
    await sh.checkStaleness({ now: T0 + h * H });
    await pump(T0 + h * H);
    const r = await inv.runSourceBlindInvestigations({ now: T0 + h * H, deps: { probes: probes() } });
    assert.equal(r.started + r.regathered, 0);
  }
  assert.deepEqual(counts(), before);
});

test('14Y.18 evidence refs are preserved: every hypothesis ref names an evidence item; the audit carries refs', () => {
  const one = inv.list().find((i) => i.subjectRef === 'source:eventkit.saim-ios');
  const ids = new Set(one.evidence.map((e) => e.id));
  for (const h of one.hypotheses) for (const ref of [...h.supportingEvidenceRefs, ...h.contradictingEvidenceRefs]) assert.ok(ids.has(ref), ref);
  const ev = inv.events(one.id);
  assert.deepEqual(ev.map((e) => e.transition).slice(0, 5), ['detected', 'gathering', 'evidence', 'hypothesised', 'decided']);
  assert.ok(ev.find((e) => e.transition === 'evidence').detail.refs.length >= 4);
});

test('14Y.19/20 confidence is bounded and nothing stored is free prose', () => {
  for (const one of inv.list()) {
    for (const h of one.hypotheses) {
      assert.ok([sbi.LEVEL.low, sbi.LEVEL.medium, sbi.LEVEL.high].includes(h.confidence));
      assert.ok(h.confidence < 1);
      assert.deepEqual(Object.keys(h).sort(), ['confidence', 'contradictingEvidenceRefs', 'level', 'supportingEvidenceRefs', 'type']);
      assert.ok(sbi.HYPOTHESES.includes(h.type));
    }
    for (const e of one.evidence) assert.deepEqual(Object.keys(e).sort(), ['fact', 'id', 'probe', 'signal', 'status']);
    const raw = JSON.stringify(db.get('SELECT * FROM investigations WHERE id = ?', [one.id]));
    assert.doesNotMatch(raw, /reasoning|rationale|thought|because I/i);
  }
  assert.equal(sbi.confidenceFor(7, 0).value, sbi.LEVEL.high);
  assert.equal(sbi.confidenceFor(3, 1).level, 'low', 'any contradiction caps it');
});

test('14O the summary is evidence and a conclusion, and says no action was taken', () => {
  const one = inv.list().find((i) => i.subjectRef === 'source:eventkit.saim-ios');
  const s = inv.summaryFor(one);
  assert.equal(s.confidence, 'High');
  assert.ok(s.found.some((l) => /stopped at the same time/.test(l)));
  assert.ok(s.found.includes('server ingestion is healthy'));
  assert.equal(s.recommended, 'Open the app on the phone.');
  assert.equal(s.actionTaken, 'No action taken.');
});

test('14Y.17 attention remains separate: nothing was pushed; eligibility is a view, not a send', () => {
  assert.equal(pushed, 0);
  const one = inv.list().find((i) => i.subjectRef === 'source:eventkit.saim-ios');
  assert.equal(inv.attentionView(one).eligible, true, 'a manual step only Nick can take');
  assert.equal(inv.attentionView({ ...one, hypotheses: [{ level: 'low' }] }).eligible, false);
  const src = fs.readFileSync(path.join(__dirname, 'investigations.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'source-blind-investigation.js'), 'utf8');
  assert.doesNotMatch(src, /sendToAll|webpush|ambient-push/, 'the investigation layer has no route to a notification');
});

test('14Y.10 a pass interrupted mid-gather resumes the SAME investigation', async () => {
  const one = forSource('healthkit.saim-ios')[0];
  db.run("UPDATE investigations SET state = 'gathering' WHERE id = ?", [one.id]);
  const r = await inv.runSourceBlindInvestigations({ now: T0 + 33 * H, deps: { probes: probes() } });
  assert.equal(r.regathered, 1);
  assert.equal(forSource('healthkit.saim-ios').length, 1);
  const after = inv.get(one.id);
  assert.notEqual(after.state, 'gathering');
  assert.equal(after.version, one.version + 1);
});

test('14Y.3/16 recovery closes it silently and cancels the stale recommendation', async () => {
  const id = forSource('eventkit.saim-ios')[0].id;
  deliver('eventkit.saim-ios', T0 + 34 * H);
  await pump(T0 + 34 * H + 60000);
  const r = await inv.runSourceBlindInvestigations({ now: T0 + 34 * H + 120000, deps: { probes: probes() } });
  assert.ok(r.resolved >= 1);
  const done = inv.get(id);
  assert.equal(done.state, 'resolved');
  assert.equal(done.stopReason, 'recovered');
  assert.equal(done.preparedAction.status, 'cancelled');
  const ev = inv.events(id);
  assert.ok(ev.some((e) => e.transition === 'fix-cancelled'));
  assert.ok(ev.find((e) => e.transition === 'resolved').detail.recovery.resolvedAt);
  assert.equal(pushed, 0);
});

test('14Y.11 an investigation that outlives its expiry closes as inconclusive', async () => {
  const one = forSource('reminders.saim-ios')[0];
  const r = await inv.runSourceBlindInvestigations({ now: Date.parse(one.expires_at) + 1000, deps: { probes: probes() } });
  assert.ok(r.expired >= 1);
  const done = inv.get(one.id);
  assert.equal(done.state, 'inconclusive');
  assert.equal(done.stopReason, 'expired');
});

// ── the budget, the probes, the fixes ───────────────────────────────────────

test('14Y.4 the evidence budget is enforced: probe count, per-probe timeout, and refusals', async () => {
  const called = [];
  const fake = Object.fromEntries(sbi.PROBES.map((p) => [p, () => { called.push(p); return {}; }]));
  const g = await inv.gather('x.y', sbi.PROBES, { probes: fake, budget: { maxProbes: 2 } });
  assert.equal(g.calls, 2);
  assert.equal(called.length, 2);
  assert.equal(g.exhausted, true);
  assert.equal(g.results.filter((r) => r.status === 'skipped').length, sbi.PROBES.length - 2);
  const slow = await inv.gather('x.y', ['source-health'], { probes: { 'source-health': () => new Promise((r) => setTimeout(r, 200)) }, budget: { probeTimeoutMs: 20 } });
  assert.equal(slow.results[0].status, 'unavailable');
  assert.ok(sbi.plan('healthkit.saim-ios', require('./native-sources').describe).length <= sbi.MAX_PROBES);
});

test('14Y.6 no unrelated data: an unlisted probe is refused uncalled, and the modules import no personal-data service', async () => {
  let reached = false;
  const g = await inv.gather('x.y', ['vault-search', 'mail-read'], { probes: { 'vault-search': () => { reached = true; }, 'mail-read': () => { reached = true; } } });
  assert.equal(reached, false);
  assert.deepEqual(g.results.map((r) => r.status), ['refused', 'refused']);
  const src = fs.readFileSync(path.join(__dirname, 'investigations.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'source-blind-investigation.js'), 'utf8');
  for (const banned of ['obsidian', 'microsoft', 'email-triage', 'mail-read', 'health-daily', 'apple-health', 'retrieval', 'embeddings', 'waiting-on', 'fetch(']) {
    assert.ok(!src.includes(`require('./${banned}`) && !(banned === 'fetch(' && src.includes('fetch(')), banned);
  }
});

test('14K "stale" is the premise, not corroboration: one other probe is MEDIUM, not high', () => {
  const ev = [
    { id: 'ev:source-health:1', probe: 'source-health', status: 'ok', signal: 'stale', fact: {} },
    { id: 'ev:app-siblings:2', probe: 'app-siblings', status: 'ok', signal: 'siblings-fresh', fact: { fresh: ['x'] } },
  ];
  const top = sbi.hypothesise(ev, { push: true })[0];
  assert.equal(top.type, 'source-offline');
  assert.equal(top.level, 'medium');
  // Positive control: a genuinely independent second probe makes it high.
  const more = [...ev, { id: 'ev:ingest-alive:3', probe: 'ingest-alive', status: 'ok', signal: 'ingest-alive', fact: {} }];
  assert.equal(sbi.hypothesise(more, { push: true })[0].level, 'high');
});

test('14Y.5 unavailable evidence yields unknown and MONITOR, never a guess', async () => {
  const dead = Object.fromEntries(sbi.PROBES.map((p) => [p, () => { throw new Error('gone'); }]));
  const g = await inv.gather('healthkit.saim-ios', sbi.PROBES, { probes: dead });
  const ev = sbi.toEvidence('healthkit.saim-ios', { lastObservedOrSuccessAt: iso(T0) }, g.results, T0 + 31 * H);
  const hyp = sbi.hypothesise(ev, { push: true });
  assert.equal(hyp[0].type, 'unknown');
  const d = sbi.decide({ hypotheses: hyp, sourceId: 'healthkit.saim-ios', findingActive: true, evidenceAvailable: false });
  assert.equal(d.decision, 'MONITOR');
  assert.equal(d.stopReason, 'evidence-unavailable');
});

test('14Y.7/8/9 fixes come only from the allowlist, take authority from the matrix, never execute, and hold no command', () => {
  assert.equal(sbi.prepareFix('rm -rf /', { matrix, investigationId: 'i', version: 1 }).ok, false);
  for (const kind of Object.keys(sbi.FIXES)) {
    const p = sbi.prepareFix(kind, { matrix, investigationId: 'i', version: 1 });
    assert.ok(p.ok, kind);
    assert.equal(p.fix.authority, matrix.CAPABILITIES[sbi.FIXES[kind].capability].authority, kind);
    assert.equal(p.fix.executes, false);
    if (['A3', 'A4'].includes(p.fix.authority)) assert.equal(p.state, 'awaiting_approval', `${kind} needs approval`);
  }
  for (const f of Object.values(sbi.FIXES)) for (const v of Object.values(f)) assert.ok(typeof v !== 'string' || !/\s/.test(v), 'enum fields only');
  const src = fs.readFileSync(path.join(__dirname, 'investigations.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'source-blind-investigation.js'), 'utf8');
  assert.doesNotMatch(src, /child_process|execSync|spawn\(|\.exec\(|action-executor|graphWrite/);
});

// ── who is never investigated ───────────────────────────────────────────────

function stubFindings(findings) {
  return { getFindings: ({ status } = {}) => findings.filter((f) => !status || f.status === status), liveEligible: sb.liveEligible };
}
const f = (source, hoursSilent, nowMs, extra = {}) => ({
  findingId: `source-blind:${source}:${++k}`, source, status: 'active', condition: 'stale', confidence: 0.7,
  lastObservedOrSuccessAt: iso(nowMs - hoursSilent * H), ...extra,
});

test('14Y.14/15 a retired or optional source does not create an investigation, however long it is silent', async () => {
  const before = counts().inv;
  const now = T0 + 100 * H;
  const r = await inv.runSourceBlindInvestigations({ now, deps: { probes: probes(), sourceBlindness: stubFindings([
    f('eventkit.unknown', 90, now), f('reminders.unknown', 90, now), f('desktop.agent', 90, now), f('device.saim-ios', 90, now),
  ]) } });
  assert.equal(r.started, 0);
  assert.equal(counts().inv, before);
});

test('14Y.12/14S historical replay (the 12 findings of 2–6 Oct) stays quiet', async () => {
  // Shapes of the real history: 10 iOS findings that healed by themselves
  // within 24h (the longest 23.9h), and the two pre-identity buckets.
  const healed = [['healthkit.saim-ios', 23.9], ['eventkit.saim-ios', 20], ['reminders.saim-ios', 18], ['healthkit.neuro-ios', 14],
    ['eventkit.neuro-ios', 13], ['reminders.neuro-ios', 22], ['device.neuro-ios', 16], ['location.neuro-ios', 19],
    ['healthkit.saim-ios', 12.5], ['eventkit.neuro-ios', 21]];
  const before = counts().inv;
  const base = Date.parse('2026-10-02T06:00:00Z');
  // `silence` is the TOTAL gap before the source healed; a finding exists
  // from 12h of silence (stale) until it heals. Evaluate every hour of it.
  for (const [source, silence] of healed) {
    const opened = f(source, 0, base);
    const silentSince = base - 12 * H;
    for (let s = 12; s <= silence; s += 0.5) {
      const now = silentSince + s * H;
      await inv.runSourceBlindInvestigations({ now, deps: { probes: probes(), sourceBlindness: stubFindings([{ ...opened, lastObservedOrSuccessAt: iso(silentSince) }]) } });
    }
  }
  for (const source of ['eventkit.unknown', 'reminders.unknown']) {
    await inv.runSourceBlindInvestigations({ now: base + 96 * H, deps: { probes: probes(), sourceBlindness: stubFindings([f(source, 96, base + 96 * H)]) } });
  }
  assert.equal(counts().inv, before, 'zero investigations from the historical findings');
});

test('positive control for the replay: the same shape past 30h DOES investigate', async () => {
  const before = counts().inv;
  const now = T0 + 200 * H;
  const r = await inv.runSourceBlindInvestigations({ now, deps: { probes: probes(), sourceBlindness: stubFindings([f('location.neuro-ios', 31, now)]) } });
  assert.equal(r.started, 1);
  assert.equal(counts().inv, before + 1);
});
