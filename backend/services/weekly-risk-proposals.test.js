'use strict';

/**
 * Pre-filled answers for the weekly report's manual sections (1 Nov 2026).
 *
 * Pure rules first, then the whole path against a scratch DB with NOVA stubbed
 * at the client: build → stored suggestions → blockers → accept → publish.
 * The negatives are the point: an unread source proposes nothing, an accepted
 * section survives a rebuild, and publish stays blocked until each suggestion
 * is accepted or edited.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wrprop-'));
process.env.NEURO_DB_PATH = path.join(dir, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(dir, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const P = require('./weekly-risk-proposals');
const rf = require('./report-fixes');

const FROM = '2026-10-26';
const TO = '2026-11-01';
const readLog = { ok: true, rows: [] };

// ── Pure ─────────────────────────────────────────────────────────────────────

test('overtime: NOVA unread proposes nothing and names the gap', () => {
  const r = P.proposeOvertime({ claims: { ok: false, error: 'boom' }, log: readLog, from: FROM, to: TO });
  assert.ok(r.gap, 'expected a gap');
  assert.equal(r.gap.section, 'overtime');
  assert.match(r.gap.reason, /NOVA overtime claims could not be read \(boom\)/);
  assert.equal(r.value, undefined);
});

test('overtime: the older log unread also proposes nothing (a half total understates)', () => {
  const r = P.proposeOvertime({ claims: { ok: true, approved: [], submitted: [] }, log: { ok: false, error: 'no table' }, from: FROM, to: TO });
  assert.ok(r.gap);
});

test('overtime: both read and empty → an explicit nil, not unknown', () => {
  const r = P.proposeOvertime({ claims: { ok: true, approved: [], submitted: [] }, log: readLog, from: FROM, to: TO });
  assert.equal(r.value.hours, 0);
  assert.equal(r.value.approvalsOutstanding, 0);
  assert.equal(r.value.note, 'No overtime logged this period');
  assert.equal(r.none, true);
});

test('overtime: approved claims in the week sum; outside the week and waiting ones do not', () => {
  const r = P.proposeOvertime({
    claims: {
      ok: true,
      approved: [
        { date: '2026-10-27', minutes: 90, agentName: 'Jo Bloggs', reason: 'Starberry recovery' },
        { date: '2026-10-30', minutes: 60, agentName: 'Sam Smith', reason: '' },
        { date: '2026-11-02', minutes: 600, agentName: 'Later Week' },
      ],
      submitted: [{ date: '2026-10-28', minutes: 30 }],
    },
    log: { ok: true, rows: [{ work_date: '2026-10-29', outcome: 'approved', hours: 0.5 }, { work_date: '2026-10-29', outcome: 'pending', hours: 2 }] },
    from: FROM, to: TO,
  });
  assert.equal(r.value.hours, 3);
  assert.equal(r.value.approvalsOutstanding, 2);
  assert.match(r.value.note, /Jo Bloggs 1\.5h \(Starberry recovery\)/);
  assert.match(r.sources[0], /2 approved overtime claims in NOVA/);
  assert.equal(r.none, false);
});

test('escalations: my escalations unread → no proposal', () => {
  const r = P.proposeEscalations({ myEscalations: { total: null, jira: { count: null, error: 'NOVA down' }, email: { count: 0 } }, chrisAgenda: { known: true, open: [] }, findings: [] });
  assert.ok(r.gap);
  assert.match(r.gap.reason, /NOVA down/);
});

test('escalations: the "To discuss with Chris" list is never folded in — a question is not an escalation', () => {
  const r = P.proposeEscalations({ myEscalations: { total: 0, jira: { count: 0, tickets: [] }, email: { count: 0, tickets: [] } }, chrisAgenda: { known: true, open: [{ text: 'Adele FWR' }] }, findings: [] });
  assert.ok(!r.gap);
  assert.deepEqual(r.value, []);
});

test('escalations: nothing found while a report source failed is NOT "none"', () => {
  const r = P.proposeEscalations({ myEscalations: { total: 0, jira: { count: 0, tickets: [] }, email: { count: 0, tickets: [] } }, chrisAgenda: { known: true, open: [] }, findings: [], failedSources: ['kpi-trend'] });
  assert.ok(r.gap);
});

test('escalations: all read and empty → explicit None; items from findings and mine', () => {
  const zero = { total: 0, jira: { count: 0, tickets: [] }, email: { count: 0, tickets: [] } };
  const none = P.proposeEscalations({ myEscalations: zero, chrisAgenda: { known: true, open: [] }, findings: [] });
  assert.deepEqual(none.value, []);
  assert.equal(none.none, true);
  const r = P.proposeEscalations({
    myEscalations: { total: 3, jira: { count: 2, tickets: ['NT-1', 'NT-2'] }, email: { count: 1, tickets: ['NT-3'] } },
    chrisAgenda: { known: true, open: [{ text: 'Adele FWR' }] },
    findings: [{ severity: 'escalate', title: 'Tier 2 slide', detail: '3 weeks' }, { severity: 'warn', title: 'x', detail: 'y' }],
  });
  assert.deepEqual(r.value, [
    'Tier 2 slide — 3 weeks',
    'I escalated 3 tickets myself this week (2 raised in Jira, 1 by email): NT-1, NT-2, NT-3',
  ]);
});

test('actions: management log unread → no proposal; opened/closed/overdue in the week', () => {
  assert.ok(P.proposeActions({ management: null, from: FROM, to: TO }).gap);
  const r = P.proposeActions({
    management: {
      rows: [
        { id: 1, summary: 'Talk to Jo', status: 'open', entry_date: '2026-10-27', logged_at: '2026-10-27', due_date: '2026-11-03', person: 'Jo' },
        { id: 2, summary: 'RTW form', status: 'done', entry_date: '2026-10-01', logged_at: '2026-10-01', resolved_date: '2026-10-30' },
        { id: 3, summary: 'Old thing', status: 'open', entry_date: '2026-09-01', logged_at: '2026-09-01' },
      ],
      overdue: [{ id: 3, summary: 'Old thing', workingDaysOverdue: 12 }],
    },
    carried: [{ text: 'Carried one', done: false, carriedFrom: '2026-10-19' }],
    from: FROM, to: TO,
  });
  assert.deepEqual(r.value.map(a => [a.text, a.done]), [
    ['Carried one', false],
    ['Talk to Jo (Jo) — due 2026-11-03', false],
    ['RTW form', true],
    ['Old thing — overdue 12 working days', false],
  ]);
  assert.equal(r.value[0].carriedFrom, '2026-10-19');
});

test('data quality: fixes unread → no proposal; read → failed sources and fixes; empty → None', () => {
  assert.ok(P.proposeDataQuality({ sources: [], fixes: { unreadable: 'vault gone', fixed: [], corrections: [] }, rf }).gap);
  const none = P.proposeDataQuality({ sources: [{ name: 'kpi-trend', ok: true }], fixes: { fixed: [], corrections: [], unreadable: null }, rf });
  assert.deepEqual(none.value, []);
  const r = P.proposeDataQuality({ sources: [{ name: 'flow-signals', ok: false, error: 'timed out' }], fixes: { fixed: [], corrections: [], unreadable: null }, rf });
  assert.match(r.value[0], /NOVA flow-signals did not answer \(timed out\)/);
});

// ── Whole path ───────────────────────────────────────────────────────────────

const nova = require('./nova-client');
const state = { claimsFail: false, approved: [], agenda: [] };
nova.isConfigured = () => true;
nova.listEscalations = async () => [];
nova.call = async (p) => {
  if (p.startsWith('/api/neuro-bridge/overtime/claims')) {
    if (state.claimsFail) throw Object.assign(new Error('NOVA said no'), { status: 500 });
    const month = new URL(`http://x${p}`).searchParams.get('month');
    return p.includes('status=approved') ? state.approved.filter(c => !month || c.date.startsWith(month)) : [];
  }
  return {};
};

const db = require('../db/database');
const wr = require('./weekly-risk');
const WEEK = '2026-11-02';
const REPORT_WEEK = '2026-10-26';

test.before(async () => { await db.init(); });

function reset() {
  db.setState(`weekly_risk_manual_${WEEK}`, '');
  db.setState(P.KEY(WEEK), '');
  db.setState('chris_agenda', '[]');
  state.claimsFail = false;
  state.approved = [];
}

test('build pre-fills all four sections and publish is blocked until each is accepted', async () => {
  reset();
  const r = await wr.build({ week: WEEK });
  assert.deepEqual(Object.keys(r.proposals.sections).sort(), ['actions', 'dataQuality', 'escalateToChris', 'overtime'].filter(s => r.proposals.sections[s]).sort());
  assert.ok(r.proposals.sections.overtime, 'overtime suggested');
  assert.ok(r.proposals.sections.actions, 'actions suggested');
  assert.ok(r.proposals.sections.dataQuality, 'data quality suggested');
  assert.equal(r.proposals.pending, Object.keys(r.proposals.sections).length);
  assert.ok(r.blockers.some(b => /^Overtime: NEURO suggested/.test(b)));
  assert.match(r.markdown, /Suggested — check/);
  const pub = await wr.publish({ week: WEEK });
  assert.equal(pub.ok, false);
  assert.ok(pub.blockers.some(b => /accept it or edit it/.test(b)));
  // Nothing was written into the manual answers by the build.
  assert.equal(wr.getManual(WEEK).overtime.hours, null);
});

test('accept refuses a suggestion that changed since it was read', async () => {
  reset();
  await wr.build({ week: WEEK });
  const bad = wr.acceptProposal(WEEK, 'overtime', 'not-the-hash');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 409);
  assert.equal(wr.isAnswered(wr.getManual(WEEK), 'overtime'), false);
});

test('an accepted section survives a rebuild; an unanswered one refreshes', async () => {
  reset();
  state.approved = [{ date: '2026-10-27', minutes: 120, agentName: 'Jo' }];
  const first = await wr.build({ week: WEEK });
  const ot = first.proposals.sections.overtime;
  assert.equal(ot.value.hours, 2);
  assert.equal(wr.acceptProposal(WEEK, 'overtime', ot.hash).ok, true);
  const escHashBefore = first.proposals.sections.escalateToChris?.hash || null;

  // The week moves on: more overtime is approved, and an item goes on the Chris list.
  state.approved.push({ date: '2026-10-29', minutes: 180, agentName: 'Sam' });
  require('./chris-agenda').add('Raise the Dev backlog');
  const second = await wr.build({ week: WEEK });

  assert.equal(wr.getManual(WEEK).overtime.hours, 2, 'the accepted answer was not overwritten');
  assert.equal(second.proposals.sections.overtime.hash, ot.hash, 'the stored suggestion is the one Nick accepted');
  assert.equal(second.proposals.sections.overtime.answered, true);
  assert.ok(!second.proposals.sections.escalateToChris.value.includes('Raise the Dev backlog'), 'a Chris-list question is not an escalation');
  void escHashBefore;
});

test('an unread source proposes nothing — and withdraws its earlier suggestion', async () => {
  reset();
  await wr.build({ week: WEEK });
  assert.ok(P.read(WEEK).sections.overtime);
  state.claimsFail = true;
  const r = await wr.build({ week: WEEK });
  assert.equal(r.proposals.sections.overtime, undefined);
  assert.ok(r.proposals.gaps.some(g => g.section === 'overtime' && /NOVA said no/.test(g.reason)));
  assert.equal(P.read(WEEK).sections.overtime, undefined);
  assert.ok(!r.blockers.some(b => /^Overtime: NEURO suggested/.test(b)));
});

test('accept all answers every suggestion and lets publish through', async () => {
  reset();
  await wr.build({ week: WEEK });
  const all = wr.acceptAllProposals(WEEK);
  assert.equal(all.ok, true);
  assert.ok(all.accepted.includes('overtime'));
  const m = wr.getManual(WEEK);
  for (const s of all.accepted) assert.equal(m.answered[s].how, 'accepted');
  const pub = await wr.publish({ week: WEEK });
  assert.deepEqual(pub.blockers || [], []);
  assert.equal(pub.ok, true);
  assert.ok(!/Suggested — check/.test(pub.report.markdown));
});

test('editing a section answers it; a forged `answered` is ignored; legacy weeks count as answered', () => {
  reset();
  const m = wr.setManual(WEEK, { escalateToChris: ['Mine'], answered: { overtime: { how: 'accepted' } } });
  assert.equal(m.answered.escalateToChris.how, 'edited');
  assert.equal(m.answered.overtime, undefined);
  const cleared = wr.setManual(WEEK, { escalateToChris: null });
  assert.equal(cleared.answered.escalateToChris, undefined);
  db.setState(`weekly_risk_manual_${WEEK}`, JSON.stringify({ overtime: { hours: 1.5, approvalsOutstanding: 0, note: '' }, escalateToChris: [], dataQuality: null, actions: null }));
  const legacy = wr.getManual(WEEK);
  assert.equal(wr.isAnswered(legacy, 'overtime'), true);
  assert.equal(wr.isAnswered(legacy, 'escalateToChris'), true);
  assert.equal(wr.isAnswered(legacy, 'dataQuality'), false);
});

test('the Monday push leads with the suggestions to check', () => {
  assert.equal(wr.readyNotice({ proposals: { pending: 4 }, blockers: ['a', 'b', 'c', 'd'], sources: [] }), 'Weekly report ready — 4 suggestions to check.');
  assert.equal(
    wr.readyNotice({ proposals: { pending: 1 }, blockers: ['a', 'b'], escalateCount: 2, sources: [{ ok: false }] }),
    'Weekly report ready — 1 suggestion to check. 2 to escalate, 1 section still to fill in, 1 data source down.',
  );
});

test('accept routes over HTTP, and machines are refused by the matrix', async () => {
  reset();
  await wr.build({ week: WEEK });
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/weekly-risk', require('../routes/weekly-risk'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/weekly-risk`;
  try {
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const stored = P.read(WEEK);
    let res = await post('/proposals/accept', { week: WEEK, section: 'overtime', hash: 'stale' });
    assert.equal(res.status, 409);
    res = await post('/proposals/accept', { week: WEEK, section: 'overtime', hash: stored.sections.overtime.hash });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.manual.answered.overtime.how, 'accepted');
    res = await post('/proposals/accept-all', { week: WEEK });
    assert.equal(res.status, 200);
    const g = await (await fetch(`${base}/manual?week=${WEEK}`)).json();
    assert.equal(g.proposals.pending, 0);
  } finally { server.close(); }
  const matrix = require('./authority-matrix');
  for (const p of ['/api/weekly-risk/proposals/accept', '/api/weekly-risk/proposals/accept-all']) {
    const d = matrix.machineDecision('POST', p);
    assert.equal(d.allow, false, p);
    assert.equal(d.status, 403, p);
  }
});

test('the report week the overtime suggestion reads is the completed week before', async () => {
  reset();
  state.approved = [{ date: REPORT_WEEK, minutes: 60 }, { date: WEEK, minutes: 600 }];
  const r = await wr.build({ week: WEEK });
  assert.equal(r.proposals.sections.overtime.value.hours, 1);
});

test('the panel offers Accept / Edit / Accept all, and Save never answers a pending suggestion', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/components/WeeklyRiskPanel.jsx'), 'utf8');
  // Positive control: the file read is the panel.
  assert.match(src, /export default function WeeklyRiskPanel/);
  assert.match(src, /\/api\/weekly-risk\/proposals\/accept'/);
  assert.match(src, /\/api\/weekly-risk\/proposals\/accept-all'/);
  assert.match(src, /Suggested — check/);
  assert.match(src, /Accept all suggestions/);
  // A section with a pending suggestion is dropped from the Save patch unless
  // Nick chose Edit on it.
  assert.match(src, /if \(sug\[s\] && !sug\[s\]\.answered && !draft\.editing\[s\]\) delete patch\[s\];/);
});
