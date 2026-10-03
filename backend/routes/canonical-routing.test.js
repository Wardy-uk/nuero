'use strict';

/**
 * Build 10 — the canonical read contract through REAL routes over a real
 * scratch database. The pure suite (services/canonical-read.test.js) proves the
 * shapers; this proves the screens' endpoints read the PROJECTIONS — and not
 * the source tables beside them — and that the two health truths agree.
 *
 * Numbering follows the Build 10S list in the build record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b10-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');

let server;
let base;
const NOW = '2026-10-03T10:00:00.000Z';

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/canonical', require('./canonical'));
  app.use('/api/focus', require('./focus'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  const json = await res.json();
  return { status: res.status, json };
};
const post = async (p, body) => {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

function seedPerson(id, name, { team = 'Support', directReport = 1 } = {}) {
  db.run(`INSERT OR REPLACE INTO wm_people (person_id, display_name, team, direct_report, aliases_json, provenance_kind, first_observed_at, last_observed_at, evidence_json, updated_at)
          VALUES (?, ?, ?, ?, '[]', 'fact', ?, ?, '[]', ?)`, [id, name, team, directReport, NOW, NOW, NOW]);
}

function seedCommitment(id, { direction = 'to-nick', description = 'Send the figures', promisorId = null, promisorRaw = null, why = null,
  due = null, basis = 'none', meetingId = null, meetingJson = null, status = 'open', sourceKind = 'meeting-waiting-on' } = {}) {
  db.run(`INSERT OR REPLACE INTO wm_commitments (commitment_id, description, direction, promisor_person_id, promisor_raw, promisor_why,
            beneficiary_kind, status, due_date, due_basis, source_kind, source_ref, meeting_id, meeting_json, provenance_kind, confidence,
            observed_at, received_at, evidence_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, 'observation', 0.8, ?, ?, '["ev-1"]', ?, ?)`,
  [id, description, direction, promisorId, promisorRaw, why, status, due, basis, sourceKind, `ref:${id}`, meetingId, meetingJson, NOW, NOW, NOW, NOW]);
}

test('1. the Commitments endpoint reads the PROJECTION, not the waiting_on table', async () => {
  seedPerson('person:abdi-mohamed', 'Abdi Mohamed');
  seedCommitment('commitment:waiting:one', { promisorId: 'person:abdi-mohamed', promisorRaw: 'Abdi', description: 'Confirm the marketing fix' });
  // A raw waiting_on row with NO projection counterpart. If the screen ever
  // reads the source table again, this row appears.
  db.run(`INSERT INTO waiting_on (key, person, text, first_seen, last_seen) VALUES ('raw-only', 'Zed', 'ONLY-IN-THE-SOURCE-TABLE', ?, ?)`, [NOW, NOW]);
  const { status, json } = await get('/api/canonical/commitments?direction=owed-to-me');
  assert.equal(status, 200);
  assert.equal(json.contract, 'canonical-v1');
  const ids = json.items.map((i) => i.id);
  assert.ok(ids.includes('commitment:waiting:one'), 'positive control: the projection row is read');
  assert.ok(!JSON.stringify(json).includes('ONLY-IN-THE-SOURCE-TABLE'), 'the screen read the raw waiting_on table');
  const abdi = json.items.find((i) => i.id === 'commitment:waiting:one');
  assert.equal(abdi.counterpart.name, 'Abdi Mohamed');
  assert.deepEqual(abdi.domains.domains.map((d) => d.domain), ['work'], 'a direct report is evidence of work');
});

test('2+3. meeting links render from the world model, and unresolved identity stays visible', async () => {
  seedCommitment('commitment:waiting:two', { promisorRaw: 'Chris', why: 'the first name "Chris" belongs to 2 declared people',
    meetingId: 'graph:m1', meetingJson: JSON.stringify({ notePath: 'Meetings/2026/09/2026-09-18 – Ops Review.md', occurrence: { start: '2026-09-18T16:00', meetingId: 'graph:m1' } }) });
  const { json } = await get('/api/canonical/commitments?direction=owed-to-me');
  const two = json.items.find((i) => i.id === 'commitment:waiting:two');
  assert.equal(two.counterpart.status, 'unresolved');
  assert.equal(two.counterpart.name, 'Chris');
  assert.match(two.counterpart.why, /belongs to 2/);
  assert.equal(two.meeting.linked, true);
  assert.equal(two.meeting.title, 'Ops Review');
  assert.ok(json.counts.unresolved >= 1);
  // Drill-down carries the evidence trail.
  const detail = await get(`/api/canonical/commitments/${encodeURIComponent('commitment:waiting:two')}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.evidence.provenance.kind, 'observation');
  assert.deepEqual(detail.json.evidence.provenance.eventIds, ['ev-1']);
  assert.equal((await get('/api/canonical/commitments/nope')).status, 404);
});

test('4. a replayed projection renders identically', async () => {
  const before = (await get('/api/canonical/commitments?status=all')).json;
  // Rebuild the projection rows exactly as a replay would — delete and re-apply.
  const rows = db.all('SELECT * FROM wm_commitments');
  db.run('DELETE FROM wm_commitments');
  for (const r of rows) {
    const cols = Object.keys(r);
    db.run(`INSERT INTO wm_commitments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((k) => r[k]));
  }
  const after = (await get('/api/canonical/commitments?status=all')).json;
  const strip = (j) => { const { asOf, freshness, ...rest } = j; return rest; };
  assert.deepEqual(strip(after), strip(before));
});

test('5. SourceHealth is the sole source for the Sources screen; quiet/stale/failing/retired stay distinct', async () => {
  const row = (id, state, freshness, extra = '') => db.run(
    `INSERT OR REPLACE INTO source_health (source_id, state, freshness, consecutive_failures, updated_at${extra ? ', lifecycle' : ''}) VALUES (?, ?, ?, ?, ?${extra ? ', ?' : ''})`,
    extra ? [id, state, freshness, state === 'failing' ? 4 : 0, NOW, extra] : [id, state, freshness, state === 'failing' ? 4 : 0, NOW]);
  row('healthkit.neuro-ios', 'healthy', 'quiet');
  row('eventkit.neuro-ios', 'healthy', 'stale');
  row('device.neuro-ios', 'failing', 'stale');
  row('healthkit.freereps-ios', 'healthy', 'stale', 'retired');
  const { json } = await get('/api/canonical/sources');
  assert.equal(json.truth, 'source-health');
  const v = Object.fromEntries(json.spine.map((s) => [s.sourceId, s.verdict]));
  assert.equal(v['healthkit.neuro-ios'], 'quiet');
  assert.equal(v['eventkit.neuro-ios'], 'stale');
  assert.equal(v['device.neuro-ios'], 'failing');
  assert.equal(v['healthkit.freereps-ios'], 'retired');
  // A declared source never heard from is UNKNOWN, not healthy and not absent.
  assert.equal(v['location.neuro-ios'], 'unknown');
  // Off-spine senses are named with NO verdict — no second health truth.
  for (const o of json.offSpine) assert.equal(Object.prototype.hasOwnProperty.call(o, 'verdict') || Object.prototype.hasOwnProperty.call(o, 'state'), false);
});

test('24. /api/signals does not contradict SourceHealth for a spine sense', () => {
  const signals = require('../services/signals');
  // healthkit.neuro-ios quiet + healthkit.saim-ios unknown → the group's best is quiet → live.
  const health = signals.spineVerdict(['healthkit.neuro-ios', 'healthkit.saim-ios']);
  assert.equal(health.basis, 'source-health');
  assert.equal(health.state, 'live', 'quiet is not a fault');
  // eventkit pair: neuro-ios stale, saim-ios unknown → stale, same as the Sources screen.
  const apple = signals.spineVerdict(['eventkit.neuro-ios', 'eventkit.saim-ios']);
  assert.equal(apple.state, 'stale');
  // No member ever heard from → null, so the caller's legacy check answers and SAYS it is the fallback.
  assert.equal(signals.spineVerdict(['nothing.here']), null);
  // And the snapshot rows carry which truth answered.
  const snap = signals.snapshot(new Date());
  const row = snap.signals.find((s) => s.id === 'health');
  assert.equal(row.basis, 'source-health');
  assert.equal(row.state, 'live');
});

test('annotations: declared domains and personal importance; unknown values refused; omitted ≠ null', async () => {
  const id = 'commitment:waiting:one';
  const bad = await post('/api/canonical/annotations', { entityId: id, domains: ['wrk'] });
  assert.equal(bad.status, 400);
  const badImp = await post('/api/canonical/annotations', { entityId: id, importance: 'very' });
  assert.equal(badImp.status, 400);
  // Build 10's word is still accepted on input (Build 11G alias).
  const ok = await post('/api/canonical/annotations', { entityId: id, domains: ['ember', 'fitness'], importance: 'personally-important' });
  assert.equal(ok.status, 200);
  // Omitting importance leaves it; null clears domains.
  await post('/api/canonical/annotations', { entityId: id, domains: null });
  const row = db.get('SELECT * FROM life_annotations WHERE entity_id = ?', [id]);
  assert.equal(row.importance, 'important-to-me', 'stored under the Build 11 name');
  assert.equal(row.domains_json, null);
  await post('/api/canonical/annotations', { entityId: id, domains: ['ember'] });
  const { json } = await get('/api/canonical/commitments?direction=owed-to-me');
  const one = json.items.find((i) => i.id === id);
  assert.deepEqual(one.domains.domains.map((d) => [d.domain, d.basis]), [['ember', 'declared']], 'declared replaces the work inference');
  assert.equal(one.importance, 'important-to-me');
  assert.equal(one.importanceBasis, 'declared');
});

test('goals: only what was stored is shown; nothing invented', async () => {
  const empty = await get('/api/canonical/goals');
  assert.deepEqual(empty.json.goals, []);
  assert.equal((await post('/api/canonical/goals', { title: '  ' })).status, 400);
  const made = await post('/api/canonical/goals', { title: 'Hike once a fortnight', domains: ['fitness'] });
  assert.equal(made.status, 200);
  const list = await get('/api/canonical/goals');
  assert.equal(list.json.goals.length, 1);
  assert.equal(list.json.goals[0].domains[0].basis, 'declared');
  const paused = await post(`/api/canonical/goals/${encodeURIComponent(made.json.goal.id)}`, { status: 'paused' });
  assert.equal(paused.json.goal.status, 'paused');
  assert.equal((await get('/api/canonical/goals')).json.goals.length, 0, 'a paused goal is not active');
  assert.equal((await post(`/api/canonical/goals/${encodeURIComponent(made.json.goal.id)}`, { status: 'abandoned' })).status, 400);
});

test('18+19+20. findings through the route: shadow state, suppression reason, no reasoning text', async () => {
  db.run(`INSERT INTO commitment_risk_findings (finding_id, commitment_id, episode, status, level, triggers_json, summary, why, evidence_json,
            unavailable_json, checked_json, confidence, novelty, first_created_at, updated_at, attention_mode, attention_decided_at, attention_json, decisions)
          VALUES ('commitment-risk:x:1', 'commitment:waiting:one', 1, 'active', 'high', '[{"kind":"overdue"}]', 'You committed to X', 'overdue: 3 days',
            '{"commitment":{"id":"commitment:waiting:one"}}', '[]', '[]', 0.75, 'new', ?, ?, 'shadow', ?, '{"push":false,"why":"Focus mode is on","shadow":true,"sent":false,"reasoning":"SECRET"}', 1)`, [NOW, NOW, NOW]);
  const { json } = await get('/api/canonical/findings');
  const f = json.findings.find((x) => x.id === 'commitment-risk:x:1');
  assert.ok(f, 'positive control: the seeded finding is read');
  assert.equal(f.shadow, true);
  assert.equal(f.attention.suppressedBecause, 'Focus mode is on');
  assert.ok(!JSON.stringify(json).includes('SECRET'), 'raw reasoning leaked through the findings route');
  const ev = json.evaluators.find((e) => e.name === 'commitment-risk');
  assert.equal(ev.shadow, true, '32. evaluators remain shadow');
});

test('32. every evaluator reports shadow (or off) — none is live by default', async () => {
  const saved = { ...process.env };
  for (const k of ['SOURCE_BLIND_MODE', 'COMMITMENT_RISK_MODE', 'MEETING_INTELLIGENCE_MODE', 'MEETING_CONTEXT_MODE']) delete process.env[k];
  try {
    const { json } = await get('/api/canonical/findings?status=all');
    for (const e of json.evaluators) assert.notEqual(e.mode, 'live', `${e.name} is live by default`);
  } finally { Object.assign(process.env, saved); }
});

test('26. the retired /api/focus fails safely with a 410 that names the replacement', async () => {
  for (const [method, p] of [['GET', '/api/focus'], ['GET', '/api/focus?noai=true'], ['POST', '/api/focus/dismiss'], ['POST', '/api/focus/action-done']]) {
    const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 410, `${method} ${p}`);
    const body = await res.json();
    assert.equal(body.retired, true);
    assert.equal(body.use.now, '/api/attention');
    assert.equal(body.use.pinCheck, '/api/auth/check');
  }
});

test('Now composition over real projection rows: cross-domain, decision verbatim, calm when nothing matters', async () => {
  const canonical = require('../services/canonical-read');
  // A stated deadline tomorrow, declared personal (Ember), and a work one the same day.
  seedCommitment('commitment:task:ember', { direction: 'by-nick', description: 'Book Ember into the vet', due: '2026-10-04', basis: 'stated', sourceKind: 'declared-commitment' });
  await post('/api/canonical/annotations', { entityId: 'commitment:task:ember', domains: ['ember'], importance: 'personally-important' });
  seedCommitment('commitment:task:figs', { direction: 'by-nick', description: 'Send Chris the figures', due: '2026-10-04', basis: 'stated', sourceKind: 'management-log' });
  const decision = { primary: null, secondary: [], context: { label: 'Steady', summary: 's' }, poolAvailable: true, gaps: [], life: { showWork: true } };
  const out = await canonical.now({ now: Date.parse('2026-10-03T09:00:00'), decision });
  assert.equal(out.context.label, 'Steady', 'the decision is carried verbatim');
  const due = out.situation.sections.commitments.map((x) => x.id);
  assert.deepEqual(due.slice(0, 2), ['commitment:task:ember', 'commitment:task:figs'], 'the personal item is not out-ranked by being personal');
  const offDuty = await canonical.now({ now: Date.parse('2026-10-03T09:00:00'), decision: { ...decision, life: { showWork: false } } });
  const offIds = (offDuty.situation.sections.commitments || []).map((x) => x.id);
  assert.ok(offIds.includes('commitment:task:ember'), 'off duty still shows a personal commitment');
  assert.ok(!offIds.includes('commitment:task:figs'), 'off duty holds the management-log (work) one');
});
