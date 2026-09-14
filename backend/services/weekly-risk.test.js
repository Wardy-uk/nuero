'use strict';

/**
 * Pins the judgement, not the numbers.
 *
 * `assess()` decides what gets flagged to Chris and in what order, and the
 * failure modes worth guarding are the quiet ones: a source that did not answer
 * rendering as a healthy zero, a manual section left blank reading as "nil",
 * and a compliance slide that has already recovered still reading as ongoing.
 */

const test = require('node:test');
const assert = require('node:assert');

const weeklyRisk = require('./weekly-risk');

function kpiRow(KPI, Count, over = {}) {
  return { KPI, KPIGroup: 'Compliance', Count, KPITarget: 95, KPIDirection: 'higher is better', RAG: 'Red', ...over };
}

function baseSnapshot(over = {}) {
  return {
    week: '2026-08-17',
    generatedAt: '2026-08-17T07:30:00.000Z',
    sources: [
      { name: 'kpi-snapshot', ok: true, error: null },
      { name: 'kpi-trend', ok: true, error: null },
      { name: 'escalation-stats', ok: true, error: null },
    ],
    kpi: { date: '2026-08-17', ageDays: 0, rows: [] },
    trend: { weeks: 6, rows: [] },
    escalationStats: null,
    jiraEscalations: null,
    management: null,
    manual: weeklyRisk.emptyManual(),
    ...over,
  };
}

// ── The load-bearing honesty rules ───────────────────────────────────────────

test('a source that did not answer is reported, and ranked above every finding', () => {
  const snap = baseSnapshot({
    sources: [
      { name: 'kpi-snapshot', ok: false, error: 'NOVA bridge not configured' },
      { name: 'kpi-trend', ok: true, error: null },
      { name: 'escalation-stats', ok: true, error: null },
    ],
  });
  const a = weeklyRisk.assess(snap);
  assert.equal(a.findings[0].severity, 'blocked');
  assert.equal(a.findings[0].kind, 'source-unavailable');
  assert.match(a.findings[0].detail, /absent, not zero/);
});

test('no KPI data yields null percentages, never 0% — 0% green reads as a crisis', () => {
  const a = weeklyRisk.assess(baseSnapshot());
  assert.equal(a.rag.greenPct, null);
  assert.equal(a.rag.redPct, null);
  assert.equal(a.rag.rated, 0);
});

test('an unanswered manual section blocks publication and names what the silence would claim', () => {
  const a = weeklyRisk.assess(baseSnapshot());
  assert.equal(a.blockers.length, 3);
  assert.ok(a.blockers.some(b => /nil overtime/.test(b)));
  assert.ok(a.blockers.some(b => /nothing to escalate/.test(b)));
});

test('a working overtime log removes the manual overtime blocker', () => {
  // The whole reason the overtime log was built: this section blocked
  // publication every week because nothing measured it.
  const a = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 12, totalClaims: 3, approved: 3, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 0, checklistOutstanding: 0, overLimit: [] },
  }));
  assert.ok(!a.blockers.some(b => /Overtime hours not entered/.test(b)),
    'a measured figure is not a missing one');
});

test('an unavailable overtime log still blocks — absent is not nil', () => {
  const a = weeklyRisk.assess(baseSnapshot({ overtime: { available: false, reason: 'unreadable' } }));
  assert.ok(a.blockers.some(b => /Overtime hours not entered/.test(b)));
});

test('an approval recorded without the full checklist escalates', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 40, totalClaims: 5, approved: 5, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 2, checklistOutstanding: 0, overLimit: [] },
  }));
  const f = a.findings.find(x => x.kind === 'overtime-checklist-gap');
  assert.equal(f.severity, 'escalate', 'this is the exact behaviour competency 1 was written about');
});

test('over the 48h average escalates without an opt-out, warns with one', () => {
  const without = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 90, totalClaims: 9, approved: 9, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 0, checklistOutstanding: 0,
      overLimit: [{ person: 'Sam', averageHours: 51.2, optoutSigned: false }] },
  })).findings.find(x => x.kind === 'wtr-limit');
  assert.equal(without.severity, 'escalate');
  assert.match(without.detail, /HR involvement now/);

  const with_ = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 90, totalClaims: 9, approved: 9, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 0, checklistOutstanding: 0,
      overLimit: [{ person: 'Sam', averageHours: 51.2, optoutSigned: true }] },
  })).findings.find(x => x.kind === 'wtr-limit');
  assert.equal(with_.severity, 'warn');
});

test('an answered-as-zero manual section does NOT block — nil is a claim once stated', () => {
  const manual = weeklyRisk.emptyManual();
  manual.overtime.hours = 0;
  manual.escalateToChris = [];
  manual.dataQuality = [];
  const a = weeklyRisk.assess(baseSnapshot({ manual }));
  assert.deepEqual(a.blockers, []);
});

// ── Trend and slides (Chris's 12 Aug ask) ────────────────────────────────────

test('a sustained slide escalates; a recovered one does not', () => {
  const falling = [88, 54, 45, 45, 24, 47].map((v, i) => ({ period: `2026-07-0${i + 1}`, value: v }));
  assert.equal(weeklyRisk.consecutiveBelowTarget(falling, 95), 6);

  const recovered = [40, 50, 60, 97].map((v, i) => ({ period: `2026-07-0${i + 1}`, value: v }));
  assert.equal(
    weeklyRisk.consecutiveBelowTarget(recovered, 95), 0,
    'counting from the latest week backwards is what stops a fixed problem reading as ongoing',
  );
});

test('week-on-week delta is computed per KPI from the trend rows', () => {
  const snap = baseSnapshot({
    trend: {
      rows: [
        { period: '2026-08-03', KPI: 'Resolution Compliance % (Tier 2)', avgValue: 24, samples: 5 },
        { period: '2026-08-10', KPI: 'Resolution Compliance % (Tier 2)', avgValue: 47, samples: 5 },
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  const t = a.trend.find(x => x.kpi.includes('Tier 2'));
  assert.equal(t.delta, 23);
  // The two columns are the reporting week (w/c 10 Aug) and the one before it,
  // looked up BY WEEK — never "the last two samples, whenever they happened".
  assert.equal(t.reported.value, 47);
  assert.equal(t.compare.value, 24);
  assert.equal(t.measured, true);
});

test('a compliance KPI below target for 3+ consecutive weeks is an escalation', () => {
  // Three consecutive WEEK buckets ending in the reporting week (w/c 10 Aug).
  const rows = ['2026-07-27', '2026-08-03', '2026-08-10'].map((period, i) => ({
    period, KPI: 'Resolution Compliance % (Tier 2)', avgValue: [30, 40, 45][i], samples: 5,
    targetMin: 95, targetMax: 95,
  }));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows } }));
  const f = a.findings.find(x => x.kind === 'compliance-slide');
  assert.ok(f, 'expected a compliance-slide finding');
  assert.equal(f.severity, 'escalate');
  assert.equal(f.weeks, 3);
});

// ── Anomaly rules ────────────────────────────────────────────────────────────

test('a broken reason-code vocabulary escalates on share, not on raw count', () => {
  const snap = baseSnapshot({
    escalationStats: {
      by_reason: [
        { reason_code: 'unknown', count: 1285 },
        { reason_code: 'nova_stranded', count: 52 },
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  const f = a.findings.find(x => x.kind === 'reason-capture-broken');
  assert.ok(f);
  assert.equal(f.severity, 'escalate');
  assert.equal(a.reasons.unknown, 1285);
  assert.equal(a.reasons.total, 1337);
  assert.equal(a.reasons.share, 96.1);
});

test('a mostly-coded vocabulary does not escalate', () => {
  const snap = baseSnapshot({
    escalationStats: { by_reason: [{ reason_code: 'unknown', count: 10 }, { reason_code: 'nova_stranded', count: 90 }] },
  });
  const a = weeklyRisk.assess(snap);
  assert.equal(a.findings.find(x => x.kind === 'reason-capture-broken'), undefined);
  assert.equal(a.reasons.share, 10);
});

test('a stale KPI snapshot escalates rather than being reported as today', () => {
  const a = weeklyRisk.assess(baseSnapshot({ kpi: { date: '2026-08-05', ageDays: 12, rows: [] } }));
  const f = a.findings.find(x => x.kind === 'stale-snapshot');
  assert.ok(f);
  assert.equal(f.severity, 'escalate');
  assert.match(f.detail, /not today/);
});

test('a zero against a live higher-is-better target is flagged as a possible stalled pipeline', () => {
  const snap = baseSnapshot({
    kpi: {
      date: '2026-08-17', ageDays: 0,
      rows: [
        kpiRow('AI Resolution Rate', 0, { KPITarget: 50 }),
        kpiRow('CSAT', 0, { KPITarget: 0, KPIDirection: 'higher is better' }),  // no real target — not a finding
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  const f = a.findings.find(x => x.kind === 'zero-against-target');
  assert.ok(f);
  assert.equal(f.items.length, 1, 'a zero target is not a target');
  assert.equal(f.items[0].kpi, 'AI Resolution Rate');
});

test('ageing is ranked by ratio to target, not by raw days', () => {
  const snap = baseSnapshot({
    kpi: {
      date: '2026-08-17', ageDays: 0,
      rows: [
        { KPI: 'Development oldest actionable', KPIGroup: 'Age', Count: 249, KPITarget: 31, RAG: 'Red' },
        { KPI: 'Tier 2 oldest actionable', KPIGroup: 'Age', Count: 162, KPITarget: 2, RAG: 'Red' },
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  assert.equal(a.ageing[0].kpi, 'Tier 2 oldest actionable', '81× beats 8× even though 162 < 249');
  assert.equal(a.ageing[0].ratio, 81);
});

// ── Flow signals ─────────────────────────────────────────────────────────────
//
// These exist because the Support Review was written from measures NOVA was
// already computing and nobody was reading. The rules below are what stops that
// recurring, so they are pinned rather than trusted.

/** A flow payload in the shape the NOVA bridge returns. */
function flowPayload(over = {}) {
  const sig = data => ({ ok: true, error: null, data });
  return {
    build: '2026-08-18-classifier-b',
    window: { days: 30, from: '2026-07-18' },
    handbacks: sig({ total: 40, previous: 38, changePct: 5.3, routes: [{ from_tier: 'Tier 2', to_tier: 'Customer Care', count: 40 }], unclassified: 0, returnsAfterFix: 0, reasons: { top: [{ reason: 'Insufficient investigation', count: 22 }], withoutReason: 5, classified: 27 } }),
    pingPong: sig({ threshold: 3, ticketsAffected: 0, worst: [] }),
    breachesByQueue: sig({ total: 0, withSlaField: 12, byTier: [], coverage: { cachedTickets: 100, lastSync: '2026-08-17T06:00:00Z' } }),
    unowned: sig({ total: 0, byTier: [] }),
    stalled: sig({ staleDays: 14, total: 0, byTier: [], worst: [] }),
    unavailable: [],
    ...over,
  };
}

test('a handback rise past the threshold escalates; a flat one only warns', () => {
  const rising = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: true, error: null, data: { total: 60, previous: 40, changePct: 50, routes: [{ from_tier: 'T2', to_tier: 'T1', count: 60 }] } },
    }),
  })).findings.find(f => f.kind === 'handbacks');
  assert.equal(rising.severity, 'escalate', '50% rise is news, not background');

  const flat = weeklyRisk.assess(baseSnapshot({ flow: flowPayload() }))
    .findings.find(f => f.kind === 'handbacks');
  assert.equal(flat.severity, 'warn', '5% is the operating model, not this fortnight');
});

test('ping-pong is off by default, and ticking it in shows the table', () => {
  const pp = { ok: true, error: null, data: { threshold: 3, ticketsAffected: 12, worst: [{ ticket_key: 'NT-16112', moves: 16, returns: 13 }] } };

  const off = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow: flowPayload({ pingPong: pp }) })));
  assert.doesNotMatch(off, /Ping-pong/, 'off by default — a table nobody asked for is one nobody reads');
  assert.doesNotMatch(off, /Queue moves/, 'and the table itself is gone, not merely retitled');

  const manual = { ...weeklyRisk.emptyManual(), showPingPong: true };
  const on = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow: flowPayload({ pingPong: pp }), manual })));
  assert.match(on, /Ping-pong/);
  assert.match(on, /Queue moves/);
  assert.match(on, /NT-16112/);
});

test('hiding the ping-pong table never hides the escalation it raises', () => {
  // ⚠ It is a DISPLAY choice. A formatting preference that could suppress an
  // item from "To escalate to Chris" would be the report deciding what Chris
  // gets to see, which is exactly what this section exists to prevent.
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      pingPong: { ok: true, error: null, data: { threshold: 3, ticketsAffected: 12, worst: [{ ticket_key: 'NT-16112', moves: 16, returns: 13 }] } },
    }),
  }));
  assert.equal(a.manual.showPingPong, false, 'the fixture has it hidden');
  const f = a.findings.find(x => x.kind === 'ping-pong');
  assert.equal(f.severity, 'escalate');
  assert.match(weeklyRisk.render(a), /NT-16112/, 'named in the escalation list even with the table off');
});

test('the escalations lead — straight after the headline, before the numbered sections', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot()));
  const headline = md.indexOf('## Headline');
  const escalate = md.indexOf('## To escalate to Chris');
  const trend = md.indexOf('## 1. Week-on-week trend');
  assert.ok(headline >= 0 && escalate >= 0 && trend >= 0, 'all three sections present');
  assert.ok(headline < escalate, 'the headline still opens the report');
  assert.ok(escalate < trend, 'escalations come before the numbered sections, not after them');
  // The two-working-day rule is stated once, in the preamble, not repeated in
  // the heading — Nick's call, 7 Sep 2026.
  assert.doesNotMatch(md, /To escalate to Chris \(within 2 working days\)/);
});

test('a ticket past the nameable move count escalates', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      pingPong: { ok: true, error: null, data: { threshold: 3, ticketsAffected: 12, worst: [{ ticket_key: 'NT-16112', moves: 16, returns: 13 }] } },
    }),
  }));
  const f = a.findings.find(x => x.kind === 'ping-pong');
  assert.equal(f.severity, 'escalate');
  assert.match(f.detail, /NT-16112/, 'the worst ticket is named so it can be picked up');
});

test('breach concentration is framed as routing, never as the queue underperforming', () => {
  const f = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: {
          total: 1439,
          byTier: [{ tier: 'Customer Care', breaches: 1302, sharePct: 90.5 }],
          coverage: { cachedTickets: 16511, lastSync: '2026-08-17T06:00:00Z' },
        },
      },
    }),
  })).findings.find(x => x.kind === 'breach-concentration');
  // The available misreading sends the whole improvement effort into the wrong
  // team. If this wording ever drifts, the report starts blaming Customer Care.
  assert.match(f.detail, /not a Customer Care performance finding/);
  assert.equal(f.severity, 'warn');
});

test('an unreadable SLA field escalates — it is not a clean month', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: { total: 0, withSlaField: 0, byTier: [], coverage: { cachedTickets: 5602, lastSync: '2026-08-18T11:00:00Z' } },
      },
    }),
  }));
  const f = a.findings.find(x => x.kind === 'breach-data-missing');
  assert.equal(f.severity, 'escalate', 'the wallboards show breaches; zero here means the mapping is broken');

  const md = weeklyRisk.render(a);
  assert.match(md, /not reportable/i);
  assert.doesNotMatch(md, /\*\*0\*\*, by the queue holding them now/, 'a hollow zero must never render as a measured total');
  // The claim that cost a correction: NOVA holding no breach data does not mean
  // the business holds none. The wallboards read the same field live from Jira.
  assert.match(md, /wallboards read the same field live/);
});

test('the breach section never claims to be the review\'s at-time-of-breach figure', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: {
          total: 210, withSlaField: 5602, basis: 'stock',
          byTier: [{ tier: 'Customer Care', breaches: 190, sharePct: 90.5 }],
          coverage: { cachedTickets: 5602, lastSync: '2026-08-18T11:00:00Z' },
        },
      },
    }),
  })));
  // Presenting a current snapshot as the Support Review's historical measure is
  // the easiest and most damaging error available in this report.
  assert.match(md, /not\*\* the Support Review/);
  assert.match(md, /queue holding them now/);
});

test('a genuine zero in the window still reads as a measurement, not a gap', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: { total: 0, withSlaField: 400, byTier: [], coverage: { cachedTickets: 5602, lastSync: '2026-08-18T11:00:00Z' } },
      },
    }),
  }));
  assert.equal(a.findings.find(x => x.kind === 'breach-data-missing'), undefined,
    'breaches exist in the table, so a quiet window is a real result');
});

test('no reasons captured yet reads as "not started", not as reasons being skipped', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: true, error: null, data: {
        total: 217, previous: 289, changePct: -24.9,
        routes: [{ from_tier: 'Tier 3', to_tier: 'Tier 2', count: 106 }],
        unclassified: 154, returnsAfterFix: 80,
        reasons: { top: [], withoutReason: 217, classified: 217 },
      } },
    }),
  })));
  // The field is mandatory in Jira. An empty list means NOVA only just started
  // capturing it — reporting that as "reasons are being skipped" would accuse
  // the team of something the tooling caused.
  assert.match(md, /not evidence that reasons are being skipped/);
});

test('captured reasons are rendered as written, not bucketed', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow: flowPayload() })));
  assert.match(md, /Why they came back/);
  assert.match(md, /Insufficient investigation/);
  assert.match(md, /recorded before NOVA began capturing/, 'unreasoned rows are explained, not hidden');
});

test('a return after a released fix is never presented as friction', () => {
  // The correction that mattered most: Development → Customer Care is usually a
  // released fix coming back to be tested. Folding those into a "handbacks"
  // total reported successful delivery as failure.
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: true, error: null, data: {
        total: 19, previous: 22, changePct: -13.6,
        routes: [{ from_tier: 'Tier 2', to_tier: 'Customer Care', count: 19 }],
        unclassified: 154, returnsAfterFix: 80,
        reasons: { top: [{ reason: 'Insufficient investigation', count: 12 }], withoutReason: 7, classified: 19 },
      } },
    }),
  })));
  assert.match(md, /\*\*Rejections:\*\* \*\*19\*\*/, 'only evidenced rejections carry the rejection label');
  assert.match(md, /80\*\* returned after a released fix/);
  assert.match(md, /that is the flow working/);
  assert.doesNotMatch(md, /\*\*99\*\*/, 'the two counts must never be summed');
});

test('an older NOVA build has its flow figures withheld, not rendered', () => {
  // This happened: NOVA served a stale dist, the response looked fine, and the
  // fields added since came back undefined. Undefined renders as blanks and
  // zeroes, not as an error — and the old logic counted every downward move as a
  // rejection, so its numbers overstate friction in a specific direction.
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({ build: '2026-08-18-pre-classifier' }),
  }));
  const f = a.findings.find(x => x.kind === 'flow-build-mismatch');
  assert.equal(f.severity, 'blocked');

  const md = weeklyRisk.render(a);
  assert.match(md, /figures withheld/i);
  assert.doesNotMatch(md, /\*\*Rejections:\*\*/, 'no numbers may be shown from a build we cannot read');
});

test('a response with no build field at all is treated as stale', () => {
  const flow = flowPayload();
  delete flow.build;
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow })));
  assert.match(md, /unknown \(pre-versioning\)/);
});

test('a failed sub-signal renders as absent, never as a healthy zero', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: false, error: 'Query failed', data: null },
      unavailable: [{ name: 'handbacks', error: 'Query failed' }],
    }),
  }));
  assert.ok(a.findings.some(f => f.kind === 'flow-signal-unavailable' && f.severity === 'blocked'));

  const md = weeklyRisk.render(a);
  assert.match(md, /Handbacks:.*unavailable/, 'the section says it could not measure');
  assert.doesNotMatch(md, /\*\*Handbacks:\*\* \*\*0\*\*/, 'a failed query must never read as nil handbacks');
});

test('no flow data at all renders as absent rather than omitting the section', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow: null })));
  assert.match(md, /## 3\. Ticket flow & ownership/, 'the section is still there');
  assert.match(md, /absent, not zero/i);
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test('findings rank blocked → escalate → warn', () => {
  const snap = baseSnapshot({
    sources: [{ name: 'kpi-trend', ok: false, error: 'down' }],
    kpi: { date: '2026-08-01', ageDays: 16, rows: [kpiRow('AI Resolution Rate', 0, { KPITarget: 50 })] },
  });
  const a = weeklyRisk.assess(snap);
  const severities = a.findings.map(f => f.severity);
  assert.deepEqual([...severities].sort((x, y) => severities.indexOf(x) - severities.indexOf(y)), severities);
  assert.equal(severities[0], 'blocked');
  assert.ok(severities.indexOf('escalate') < severities.indexOf('warn'));
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('weekCommencing returns the Monday, and is local rather than UTC', () => {
  assert.equal(weeklyRisk.weekCommencing('2026-08-17'), '2026-08-17', 'Monday is its own week start');
  assert.equal(weeklyRisk.weekCommencing('2026-08-21'), '2026-08-17', 'Friday');
  assert.equal(weeklyRisk.weekCommencing('2026-08-23'), '2026-08-17', 'Sunday belongs to the week just ending');
  assert.equal(weeklyRisk.previousWeek('2026-08-17'), '2026-08-10');
});

// ── Rendering ────────────────────────────────────────────────────────────────

test('the rendered note marks unanswered sections rather than quietly omitting them', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot()));
  assert.match(md, /## 4\. Overtime/);
  assert.match(md, /NOT ENTERED/);
  assert.match(md, /NOT CONFIRMED/);
  assert.match(md, /week_commencing: 2026-08-17/);
  assert.match(md, /## Data sources/, 'the format agreed on 12 Aug includes data sources');
  assert.match(md, /## 1\. Week-on-week trend/, "Chris's 12 Aug ask is its own section, not a sentence");
});

test('a nil-overtime week renders the claim, not the warning', () => {
  const manual = weeklyRisk.emptyManual();
  manual.overtime.hours = 0;
  manual.overtime.approvalsOutstanding = 0;
  manual.escalateToChris = [];
  manual.dataQuality = [];
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ manual })));
  assert.match(md, /\*\*0 overtime hours\*\*/);
  assert.doesNotMatch(md, /NOT ENTERED/);
  assert.match(md, /Nothing to escalate this week/);
});

// ── The send gate ────────────────────────────────────────────────────────────

test('the send action is classified outbound and shows the report in full', () => {
  const { describe: present } = require('./action-presenter');
  const p = present({
    type: 'send_weekly_risk_report',
    payload: {
      week: '2026-08-17',
      to: [{ name: 'Chris Middleton', email: 'chrism@nurtur.tech' }],
      subject: 'Weekly Risk & Anomaly Summary — w/c 17 Aug 2026',
      body: '# The whole report\n\nEvery word of it.',
      escalateCount: 2,
      snapshotDate: '2026-08-17',
      vaultPath: 'Projects/PIP/Weekly Risk Summaries/x.md',
    },
  });
  assert.equal(p.kind, 'outbound');
  assert.deepEqual(p.blockers, []);
  assert.match(p.body, /Every word of it/, 'the body is verbatim, never a summary');
  assert.ok(p.fields.some(f => f.value === 'chrism@nurtur.tech'));
});

test('no recipient blocks the send rather than failing after approval', () => {
  const { describe: present } = require('./action-presenter');
  const p = present({
    type: 'send_weekly_risk_report',
    payload: { week: '2026-08-17', to: [], body: 'report' },
  });
  assert.equal(p.blockers.length, 1);
  assert.match(p.blockers[0], /nowhere to send/);
});

test('a clean week warns before approval — it reports an all-clear to Chris', () => {
  const { describe: present } = require('./action-presenter');
  const p = present({
    type: 'send_weekly_risk_report',
    payload: {
      week: '2026-08-17',
      to: [{ email: 'chrism@nurtur.tech' }],
      body: 'report', escalateCount: 0, vaultPath: 'x.md',
    },
  });
  assert.ok(p.warnings.some(w => /clean week/.test(w)));
});

// ── RAG mapping (measured against the live snapshot, 17 Aug 2026) ────────────

test('RAG is numeric in jira_kpi_daily — 1 green, 2 amber, 3 red', () => {
  assert.equal(weeklyRisk.ragBucket(1), 'green');
  assert.equal(weeklyRisk.ragBucket(2), 'amber');
  assert.equal(weeklyRisk.ragBucket(3), 'red');
  assert.equal(weeklyRisk.ragBucket('1'), 'green', 'JSON may hand it back as a string');
});

test('letter RAG still maps, so a column type change cannot break this silently', () => {
  assert.equal(weeklyRisk.ragBucket('Green'), 'green');
  assert.equal(weeklyRisk.ragBucket('RED'), 'red');
  assert.equal(weeklyRisk.ragBucket('Amber'), 'amber');
});

test('an absent RAG is unrated, and unrated is excluded from the percentages', () => {
  assert.equal(weeklyRisk.ragBucket(null), 'unrated');
  assert.equal(weeklyRisk.ragBucket(''), 'unrated');
  assert.equal(weeklyRisk.ragBucket(0), 'unrated');
  const a = weeklyRisk.assess(baseSnapshot({
    kpi: {
      date: '2026-08-17', ageDays: 0,
      rows: [
        { KPI: 'a', RAG: 1 }, { KPI: 'b', RAG: 1 }, { KPI: 'c', RAG: 3 }, { KPI: 'd', RAG: null },
      ],
    },
  }));
  assert.equal(a.rag.green, 2);
  assert.equal(a.rag.red, 1);
  assert.equal(a.rag.unrated, 1);
  assert.equal(a.rag.rated, 3);
  assert.equal(a.rag.greenPct, 67, 'percentages are of RATED rows, not of all rows');
});

test('the live 17 Aug shape produces a real headline, not a dash', () => {
  // 47 green / 1 amber / 63 red — the actual counts from the live snapshot.
  const rows = [
    ...Array.from({ length: 47 }, (_, i) => ({ KPI: `g${i}`, RAG: 1 })),
    { KPI: 'a0', RAG: 2 },
    ...Array.from({ length: 63 }, (_, i) => ({ KPI: `r${i}`, RAG: 3 })),
  ];
  const a = weeklyRisk.assess(baseSnapshot({ kpi: { date: '2026-08-17', ageDays: 0, rows } }));
  assert.equal(a.rag.rated, 111);
  assert.equal(a.rag.greenPct, 42);
  assert.equal(a.rag.redPct, 57);
});

// ── Test send ────────────────────────────────────────────────────────────────

test('testSend takes no recipient — it cannot be aimed at anyone but Nick', () => {
  // The safety property is structural, not a runtime check: there is no
  // parameter to pass an address through, which is why this needs no approval
  // gate. If a `to` is ever added, this test should be the thing that objects.
  // 0 rather than 1: Function.length stops counting at the first defaulted
  // parameter, and the single options bag is defaulted. What matters is that
  // nothing positional follows it.
  assert.equal(weeklyRisk.testSend.length, 0, 'a single defaulted options bag, nothing else');
  const src = weeklyRisk.testSend.toString();
  assert.match(src, /OWN_ADDRESS/, 'destination comes from the shared constant');
  assert.doesNotMatch(src, /\bto\s*=|opts\.to|options\.to/, 'no caller-supplied recipient');
});

test('the address constant is the one email-sender already owns', () => {
  const emailSender = require('./email-sender');
  assert.equal(typeof emailSender.OWN_ADDRESS, 'string');
  assert.match(emailSender.OWN_ADDRESS, /@/);
});

test('a test send is marked as one in the subject and the body', () => {
  const src = weeklyRisk.testSend.toString();
  assert.match(src, /\[TEST\]/, 'subject is prefixed, so it cannot be forwarded on as the real thing');
  assert.match(src, /did not go to Chris/, 'the body says who it did not go to');
  assert.match(src, /not finished/i, 'an unfinished report names what is missing');
  assert.match(src, /blockers\.map/, 'and lists each unanswered section by name');
});

// ── Email HTML ───────────────────────────────────────────────────────────────

const SAMPLE_MD = [
  '---',
  'type: risk-summary',
  'updated: 2026-08-17',
  '---',
  '',
  '# Weekly Risk & Anomaly Summary',
  '',
  '> Standing agenda item. Flagged **ESCALATE**. See [[Nick Ward - PIP Reference]].',
  '',
  '## Headline',
  '',
  '**41%** of rated KPIs green, **53%** red.',
  '',
  '| KPI | This week | Last week |',
  '|---|---|---|',
  '| FRT Compliance % (Tier 2) | 40% | 61% |',
  '| FRT Compliance % (Production) | 100% | 96% |',
  '',
  '- Reason capture: 1054 of 1076 as `unknown`',
  '- [ ] Root-cause the Tier 2 slide',
  '- [x] Add week-on-week trend',
  '',
  '1. First escalation',
  '2. Second escalation',
].join('\n');

test('vault frontmatter never reaches the mail', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.doesNotMatch(html, /type: risk-summary/);
  assert.doesNotMatch(html, /updated: 2026-08-17/);
});

test('tables become real tables — this is the whole reason plain text failed', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.match(html, /<table/);
  assert.equal((html.match(/<th /g) || []).length, 3);
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'header plus two body rows');
  assert.doesNotMatch(html, /\|\s*FRT Compliance/, 'no pipe soup left');
});

test('every style is inline — Outlook strips <style> blocks', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.doesNotMatch(html, /<style/i);
  assert.match(html, /<table style="/);
  assert.match(html, /<th style="/);
});

test('inline emphasis, code, checkboxes and lists all convert', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.match(html, /<strong>41%<\/strong>/);
  assert.match(html, /<code[^>]*>unknown<\/code>/);
  assert.match(html, /&#9744;/, 'unchecked box');
  assert.match(html, /&#9745;/, 'checked box');
  assert.match(html, /<ol/);
  assert.match(html, /<blockquote/);
  assert.doesNotMatch(html, /\*\*/, 'no raw markdown markers survive');
});

test('a vault wikilink is not shown as one — it means nothing in a mail client', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.doesNotMatch(html, /\[\[/);
  assert.match(html, /<em>Nick Ward - PIP Reference<\/em>/);
});

test('markup in the report content is escaped, not rendered', () => {
  const html = weeklyRisk.toEmailHtml('# T\n\nA <script>alert(1)</script> and 5 < 6.');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /5 &lt; 6/);
});

test('the real send and the test send render through the same function', () => {
  const engine = require('./suggestion-engine').executeAction.toString();
  assert.match(engine, /toEmailHtml/, 'the executor converts rather than sending raw markdown');
  assert.match(engine, /html:\s*true/);
  assert.match(weeklyRisk.testSend.toString(), /toEmailHtml/);
});

// ── Task position: commitments vs continual improvement ─────────────────────
//
// The split exists because counting the two together made the improvement
// backlog PENALISE Nick: thirty of his own ideas, optimistically dated, read in
// a compliance report exactly like thirty broken promises. Overdue counts
// commitments only (Nick, 1 Sep 2026), and the third bucket — the rows nobody
// has classified — is named rather than folded into either, because folding it
// one way manufactures a broken promise and the other way hides one.

function group(over = {}) {
  return { available: true, open: 0, overdue: 0, undated: 0, closedLastWeek: 0, ...over };
}

function taskSnap(tasks) {
  const t = {
    available: true,
    lastWeek: { from: '2026-08-10', to: '2026-08-16' },
    open: 0, overdue: 0, undated: 0, closedLastWeek: 0, droppedLastWeek: 0,
    proposedCount: 0,
    commitments: group(), improvement: group(), unclassified: group(),
    ...tasks,
  };
  return baseSnapshot({ tasks: t });
}

test('commitments and improvement work are reported as separate sections', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 92, overdue: 14, closedLastWeek: 23,
    commitments: group({ open: 40, overdue: 6, undated: 12, closedLastWeek: 15 }),
    improvement: group({ open: 52, overdue: 8, undated: 28, closedLastWeek: 8 }),
  })));
  assert.match(md, /## 6\. My task position/);
  assert.match(md, /### Commitments — work others asked for or are waiting on/);
  assert.match(md, /\| Open commitments \| \*\*40\*\* \|/);
  assert.match(md, /\| \*\*Overdue\*\* \| \*\*6\*\* \(15%\) \|/);
  assert.match(md, /### Continual improvement — work I set myself/);
  assert.match(md, /\| Open improvement tasks \| 52 \|/);
});

test('improvement dates are never called overdue — they are self-set and nobody is waiting', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 30, overdue: 20,
    improvement: group({ open: 30, overdue: 20 }),
  })));
  // The wording is doing real work: "overdue" in a compliance report invites
  // these to be read as missed promises, which is exactly what they are not.
  assert.match(md, /\| Past their target date \| 20/);
  assert.match(md, /self-set target dates on work nobody is waiting for/);
  assert.match(md, /not as a compliance measure/);
});

test('the overdue FINDING counts commitments only', () => {
  // A backlog that is entirely Nick's own ideas must not be flagged to Chris.
  const own = weeklyRisk.assess(taskSnap({
    open: 100, overdue: 40,
    improvement: group({ open: 100, overdue: 40 }),
  }));
  assert.equal(own.findings.find(x => x.kind === 'commitment-backlog'), undefined,
    'his own improvement backlog is not a compliance finding');

  const owed = weeklyRisk.assess(taskSnap({
    open: 100, overdue: 40,
    commitments: group({ open: 100, overdue: 40, closedLastWeek: 3 }),
  }));
  const f = owed.findings.find(x => x.kind === 'commitment-backlog');
  assert.ok(f, 'expected a finding when 40% of the work others are waiting on is late');
  assert.equal(f.severity, 'warn');
  assert.match(f.title, /40 of 100 open commitments are overdue/);

  const light = weeklyRisk.assess(taskSnap({ commitments: group({ open: 100, overdue: 5 }) }));
  assert.equal(light.findings.find(x => x.kind === 'commitment-backlog'), undefined,
    'flagging a small number every week trains him to skip the section');
});

test('NEGATIVE: unclassified overdue work is neither counted as a commitment nor written off', () => {
  const a = weeklyRisk.assess(taskSnap({
    open: 50, overdue: 9,
    commitments: group({ open: 10, overdue: 0 }),
    unclassified: group({ open: 40, overdue: 9 }),
  }));
  // Not folded into the commitment finding...
  assert.equal(a.findings.find(x => x.kind === 'commitment-backlog'), undefined);
  // ...and not silently dropped either. It gets its own finding.
  const f = a.findings.find(x => x.kind === 'task-unclassified');
  assert.ok(f, 'nine overdue unclassified tasks must be surfaced, not absorbed');
  assert.match(f.title, /9 overdue tasks are not classified/);

  const md = weeklyRisk.render(a);
  assert.match(md, /### Not yet classified/);
  assert.match(md, /\*\*40\*\* open tasks/);
  assert.match(md, /\*\*9\*\* are past their due date/, 'plural agreement — this document is read by Chris');
  assert.match(md, /Treat the commitment figure as a floor/);
});

test('the closed figure names its own unclassified remainder', () => {
  // A reader seeing 25 closed commitments beside a whole-list 43 is otherwise
  // left to wonder where eighteen went, in the one section meant to show output.
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 40, closedLastWeek: 43,
    commitments: group({ open: 29, closedLastWeek: 25 }),
    unclassified: group({ open: 11, closedLastWeek: 18 }),
  })));
  assert.match(md, /A further \*\*18\*\* tasks were closed last week without being classified/);
});

test('a fully classified list SAYS so — the absence of a caveat is itself a fact', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 20, commitments: group({ open: 12 }), improvement: group({ open: 8 }),
  })));
  assert.match(md, /### Not yet classified/);
  assert.match(md, /every open task is marked/);
  assert.doesNotMatch(md, /Treat the commitment figure as a floor/);
});

test("a proposed classification is declared as a guess, not as Nick's call", () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 20, commitments: group({ open: 20, overdue: 1 }), proposedCount: 14,
  })));
  assert.match(md, /14 of the classifications above were proposed automatically/);
  assert.match(md, /have not yet been confirmed/);
});

test('closed is the previous FULL week, not a rolling seven days', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({ open: 10, closedLastWeek: 5 })));
  assert.match(md, /10 Aug 2026 to 16 Aug 2026/);
  assert.match(md, /rather than a rolling seven days/);
});

test('dropped is reported separately from done — a clear-out is not a productive week', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({ open: 10, closedLastWeek: 4, droppedLastWeek: 30 })));
  assert.match(md, /30 dropped/);
  assert.match(md, /Dropped is counted separately from done/);
});

test('unavailable task counts say so rather than rendering zeros', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ tasks: { available: false } })));
  assert.match(md, /Task counts unavailable/);
  assert.doesNotMatch(md, /Open commitments/);
});

test('no divide-by-zero on an empty task list', () => {
  assert.doesNotThrow(() => weeklyRisk.render(weeklyRisk.assess(taskSnap({}))));
  const a = weeklyRisk.assess(taskSnap({}));
  assert.equal(a.findings.find(x => x.kind === 'commitment-backlog'), undefined);
  assert.equal(a.findings.find(x => x.kind === 'task-unclassified'), undefined);
});

test('the underscore italic form converts — render() uses it for every aside', () => {
  const html = weeklyRisk.toEmailHtml('# T\n\n_None recorded._\n\n_Added at Chris\'s request, 12 Aug 2026._');
  assert.match(html, /<em>None recorded\.<\/em>/);
  assert.doesNotMatch(html, /_None recorded/);
  assert.doesNotMatch(html, /request, 12 Aug 2026\._/);
});

test('snake_case identifiers are not italicised — the report is full of them', () => {
  const html = weeklyRisk.toEmailHtml('# T\n\n- `management_log` — NEURO, 19 rows\n- NOVA `jira_kpi_daily` as at today\n- weekly_risk and kpi_snapshot in prose');
  assert.match(html, /management_log/);
  assert.match(html, /jira_kpi_daily/);
  assert.match(html, /weekly_risk and kpi_snapshot/, 'a bare identifier in prose keeps its underscores');
  assert.doesNotMatch(html, /management<em>/);
});

test('no stray underscore markers survive anywhere in a rendered report', () => {
  const a = weeklyRisk.assess(taskSnap({ open: 10, overdue: 1, closedLastWeek: 2 }));
  const html = weeklyRisk.toEmailHtml(weeklyRisk.render(a));
  // Any underscore left must have a word character on both sides (an identifier).
  const strays = (html.match(/(^|[\s>(])_|_([\s<).,;:]|$)/g) || []);
  assert.deepEqual(strays, [], `stray italic markers: ${strays.join(' ')}`);
});

test('the footer timestamp is readable, not an ISO string', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot()));
  assert.doesNotMatch(md, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'no raw ISO stamp in a document going to Chris');
  assert.match(md, /Generated by NEURO, \w{3}/);
});

test('an unmeasured People HR state never reaches the report', () => {
  const mgmt = {
    totals: { rows: 4, open: 4, closed: 0 },
    baseline: { date: '2026-07-27', count: 0, stillOpen: 0, targetDate: '2026-09-11', items: [] },
    overdue: [], overdueCount: 0, breachesFiveDay: [], lateLogged: [],
    missingOwner: [], missingDue: [],
    hrGap: [],
    hrUnknown: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
  const a = weeklyRisk.assess(baseSnapshot({ management: mgmt }));
  assert.equal(a.findings.find(f => f.kind === 'people-hr-gap'), undefined,
    'three unknowns must not become an accusation in a report to the person who spot-checks People HR');
  const md = weeklyRisk.render(a);
  assert.doesNotMatch(md, /People HR/);
});

test('a CONFIRMED People HR gap does reach the report, and says it is confirmed', () => {
  const mgmt = {
    totals: { rows: 1, open: 1, closed: 0 },
    baseline: { date: '2026-07-27', count: 0, stillOpen: 0, targetDate: '2026-09-11', items: [] },
    overdue: [], overdueCount: 0, breachesFiveDay: [], lateLogged: [],
    missingOwner: [], missingDue: [],
    hrGap: [{ id: 1 }], hrUnknown: [],
  };
  const f = weeklyRisk.assess(baseSnapshot({ management: mgmt })).findings.find(x => x.kind === 'people-hr-gap');
  assert.ok(f);
  assert.match(f.title, /confirmed NOT logged/);
});

/**
 * Behaviour, not source text.
 *
 * The first version of this test asserted that queueSend's SOURCE contained
 * `getPendingSaraActionsByType` and `alreadyQueued`. It did — and the dedupe was
 * broken anyway, because the payload was double-parsed and a defensive catch
 * swallowed the throw. A test that reads the code cannot catch the code being
 * wrong, so this one drives the real thing against a scratch DB.
 */
test('queueSend dedupes on the week — a second press returns the SAME action', async (t) => {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-dedupe-'));
  process.env.NEURO_DB_PATH = path.join(dir, 'scratch.db');

  // Fresh module registry so the DB path is picked up.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const db = require('../db/database');
  await db.init();
  const wr = require('./weekly-risk');
  const engine = require('./suggestion-engine');

  const week = '2026-08-17';
  const payload = { week, to: [{ email: 'chris@nurtur.tech' }], subject: 's', body: 'b' };
  const first = engine.queueAction('send_weekly_risk_report', payload, 'test');

  const pending = db.getPendingSaraActionsByType('send_weekly_risk_report', 50);
  assert.equal(pending.length, 1);
  assert.equal(typeof pending[0].payload, 'object',
    'the db helper parses payload — re-parsing it is what broke the dedupe');
  assert.equal(pending[0].payload.week, week);

  // The matching logic itself, against exactly what the helper hands back.
  const match = pending.find(a => (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload)?.week === week);
  assert.ok(match, 'an existing pending send for this week must be found');
  assert.equal(match.id, first);

  // A different week must NOT match, or every week would reuse one card.
  const other = pending.find(a => (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload)?.week === '2026-08-10');
  assert.equal(other, undefined);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

// ── Compliance table ordering (Nick, 14 Sep 2026) ────────────────────────────
// The table used to sort alphabetically, which is an order nobody chose and
// which read Customer Care > Development > Open Queue > Production > Resolved
// Today > Tier 2 > Tier 3 — Development, the queue furthest from Nick's team,
// second. His order follows the escalation path a ticket actually takes.

test('compliance rows follow the escalation path, cross-queue KPIs first', () => {
  const names = [
    'FRT Compliance % (Tier 3)',
    'FRT Compliance % (Development)',
    'FRT Compliance % (Customer Care)',
    'FRT Compliance % (Open Queue)',
    'FRT Compliance % (Production)',
    'FRT Compliance % (Resolved Today)',
    'FRT Compliance % (Tier 2)',
  ];
  const sorted = [...names].sort(weeklyRisk.byComplianceOrder).map(weeklyRisk.queueOf);
  assert.deepStrictEqual(sorted, [
    'Open Queue', 'Resolved Today', 'Customer Care', 'Production', 'Tier 2', 'Tier 3', 'Development',
  ]);
});

test('FRT stays above Resolution — the metric block is the outer sort', () => {
  const sorted = [
    'Resolution Compliance % (Customer Care)',
    'FRT Compliance % (Development)',
    'Resolution Compliance % (Open Queue)',
    'FRT Compliance % (Open Queue)',
  ].sort(weeklyRisk.byComplianceOrder);
  assert.deepStrictEqual(sorted, [
    'FRT Compliance % (Open Queue)',
    'FRT Compliance % (Development)',
    'Resolution Compliance % (Open Queue)',
    'Resolution Compliance % (Customer Care)',
  ]);
});

test('a queue the order does not know sorts LAST, never out of the report', () => {
  // The failure this guards is silent: a KPI added in NOVA that this list has
  // never heard of must arrive on the page unannounced rather than be dropped
  // from a compliance report Chris reads.
  const names = ['FRT Compliance % (Tier 4)', 'FRT Compliance % (Open Queue)', 'FRT Compliance % (Tier 2)'];
  const sorted = [...names].sort(weeklyRisk.byComplianceOrder);
  assert.strictEqual(sorted.length, 3, 'nothing is dropped');
  assert.strictEqual(weeklyRisk.queueOf(sorted[2]), 'Tier 4', 'the unknown queue is last');
});

test('a KPI carrying no bracketed queue is still ordered, not crashed on', () => {
  assert.strictEqual(weeklyRisk.queueOf('SLA Breached'), null);
  const sorted = ['Resolution Compliance %', 'FRT Compliance % (Open Queue)'].sort(weeklyRisk.byComplianceOrder);
  assert.strictEqual(sorted[0], 'FRT Compliance % (Open Queue)');
});

test('the rendered table carries the rows in Nicks order', () => {
  const rows = [];
  for (const q of ['Tier 3', 'Development', 'Customer Care', 'Open Queue', 'Production', 'Tier 2']) {
    for (const p of ['2026-09-01', '2026-09-08']) {
      rows.push({ period: p, KPI: `FRT Compliance % (${q})`, avgValue: 80, samples: 5 });
    }
  }
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ trend: { rows } })));
  const order = ['Open Queue', 'Customer Care', 'Production', 'Tier 2', 'Tier 3', 'Development']
    .map(q => md.indexOf(`| FRT Compliance % (${q}) |`));
  assert.ok(order.every(i => i >= 0), 'every row rendered');
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], `row ${i} is below row ${i - 1}`);
  }
});

// ── CSAT rows (Nick, 14 Sep 2026) ────────────────────────────────────────────
// These exist because `jira_kpi_daily."CSAT %"` cannot answer either question.
// kpi-pipeline.ts writes `csatCount > 0 ? avg*20 : 0`, so a day nobody rated is
// stored as 0 — and a rating is 1-5, so a genuine 0 is impossible. Measured on
// the live bridge over the 28 days to 14 Sep 2026: THREE days carried a rating
// and twenty-five were stored as 0, dragging the weekly average to 14.3%. That
// reads to Chris as customers loathing the desk; it means three ratings a month
// averaging about 4.2 out of 5.

function csatSnapshot(now, prior) {
  return baseSnapshot({ csat: { now, prior } });
}

const RATED = { ratings: 2, avgScore: 4.5, daysWithRating: 2, jiraDatedByProxy: 0, complete: true, jiraError: null };
const UNRATED = { ratings: 0, avgScore: null, daysWithRating: 0, jiraDatedByProxy: 0, complete: true, jiraError: null };

test('a week nobody rated says so — it is NEVER a score of zero', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(UNRATED, UNRATED)));
  assert.match(md, /\| CSAT average score \| no ratings \|/);
  assert.doesNotMatch(md, /CSAT average score \|\s*0/, 'no zero score');
  assert.doesNotMatch(md, /0\.0 \/ 5/, 'no 0.0 out of 5 anywhere');
});

test('an unread week is "not read", which is a different fact from "no ratings"', () => {
  // "I could not look" and "nobody rated us" license opposite conclusions, and
  // the column this replaces could express neither.
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(null, null)));
  assert.match(md, /\| CSAT average score \| not read \| not read \|/);
  assert.doesNotMatch(md, /CSAT average score \| no ratings/, 'unread is not reported as unrated');
});

test('the average renders out of 5, with the day count beside it', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, UNRATED)));
  assert.match(md, /\| CSAT average score \| 4\.5 \/ 5 \| no ratings \|/);
  assert.match(md, /\| CSAT days receiving a rating \| 2 of 7 days \| 0 of 7 days \| ▲ \+2 \|/);
});

test('neither CSAT row is RAGged against 95% — they are not percentages', () => {
  // Painting an average out of 5 and a count of days against a compliance
  // target would invent a standard neither has, and NOVA's own two definitions
  // of the CSAT target disagree (registry 95%, jira_kpi_daily 80%).
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, RATED)));
  for (const line of md.split('\n').filter(l => l.startsWith('| CSAT'))) {
    assert.doesNotMatch(line, /🟢|🟠|🔴/, `no RAG on: ${line}`);
    assert.match(line, /\| — \|$/, 'the vs-95% cell is empty, not coloured');
  }
});

test('a delta needs both weeks — it is never computed against a blank', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, null)));
  const row = md.split('\n').find(l => l.startsWith('| CSAT average score'));
  assert.match(row, /\| — \| — \|$/, 'no delta against a week that was not read');
});

test('the note states the sample size — the number is worthless without it', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, UNRATED)));
  assert.match(md, /\*\*2\*\* ratings this week/);
  assert.match(md, /portal survey and Jira's own Satisfaction field/, 'says both surveys are pooled');
});

test('a Jira-dated rating is declared a PROXY, not passed off as measured', () => {
  // The native survey records no rating timestamp at all, so those ratings can
  // only be dated by the ticket's last update. Mixing an exact and an estimated
  // basis into one integer without saying so is the thing being avoided.
  const proxied = { ...RATED, jiraDatedByProxy: 1 };
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(proxied, UNRATED)));
  assert.match(md, /records no rating timestamp/);
  assert.match(md, /close estimate rather than an exact one/);
  // And it is absent when nothing was proxy-dated, rather than a standing hedge.
  const clean = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, UNRATED)));
  assert.doesNotMatch(clean, /records no rating timestamp/);
});

test('an unreachable Jira makes the figures a FLOOR, and says so', () => {
  const partial = { ...RATED, jiraError: 'Jira lookup failed.', complete: false };
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(partial, UNRATED)));
  assert.match(md, /Jira ratings could not be included/);
  assert.match(md, /floor/);
});

test('a thin sample is named as noise rather than reported as a score', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, UNRATED)));
  assert.match(md, /noise rather than a score/);
  // A healthy week does not carry the caveat.
  const healthy = { ratings: 20, avgScore: 4.4, daysWithRating: 5, jiraDatedByProxy: 0, complete: true, jiraError: null };
  assert.doesNotMatch(weeklyRisk.render(weeklyRisk.assess(csatSnapshot(healthy, RATED))), /noise rather than a score/);
});

test('buildCsat keeps unread and unrated apart at the data level too', () => {
  const built = weeklyRisk.buildCsat({ now: UNRATED, prior: null });
  assert.strictEqual(built.now.known, true);
  assert.strictEqual(built.now.avgScore, null, 'unrated is null, never 0');
  assert.strictEqual(built.prior.known, false);
  assert.strictEqual(built.prior.avgScore, undefined, 'an unread week asserts no score at all');
});

test('a CSAT source that failed is reported at the top like any other', () => {
  const snap = baseSnapshot({ csat: { now: null, prior: null } });
  snap.sources = [...snap.sources, { name: 'csat-reported', ok: false, error: 'bridge down' }];
  const a = weeklyRisk.assess(snap);
  assert.ok(a.findings.some(f => f.kind === 'source-unavailable' && f.title.includes('csat-reported')));
});

test('the CSAT rows survive the markdown-to-email conversion', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(csatSnapshot(RATED, UNRATED)));
  const html = weeklyRisk.markdownToEmailHtml(md);
  assert.match(html, /CSAT average score/);
  assert.match(html, /4\.5 \/ 5/);
  assert.doesNotMatch(html, /\|\s*CSAT/, 'no pipe soup left');
});

// ── The reporting period is a COMPLETE week (Nick, 14 Sep 2026) ──────────────
// The table read "This week / Last week" off `series[last]` and `series[last-1]`,
// which is wrong twice. On a Monday 07:30 build the first column held a SINGLE
// DAY against a seven-day average; and a positional read cannot tell a current
// sample from a stale one, so the 39 KPIs that stopped landing on 5 Sep 2026
// went on rendering a fortnight-old value under the word "week". The report's
// own task section already had the rule: the previous Monday-to-Sunday, never a
// rolling window.
//
// baseSnapshot is filed under w/c 2026-08-17 (a Monday), so it COVERS
// w/c 2026-08-10 and compares against w/c 2026-08-03.

function trendRow(period, KPI, avgValue, samples = 5, target = 95) {
  // ⚠ A target is part of a trend row now. NOVA states it per KPI (cross-queue
  // KPIs 90, per-tier 95) and a row without one is deliberately unjudgeable.
  return { period, KPI, avgValue, samples, targetMin: target, targetMax: target };
}

test('the reporting week is the COMPLETE week before the one the report is filed under', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 88)] },
  }));
  assert.strictEqual(a.reportWeek, '2026-08-10');
  // Same rule taskCounts uses for "closed last week" — the two sections of one
  // document must not disagree about their own reporting period.
  assert.strictEqual(a.reportWeek, weeklyRisk.previousWeek('2026-08-17'));
});

test('⚠ a PARTIAL current week is never shown — that was the Monday-morning bug', () => {
  // w/c 17 Aug is the week the report is FILED under, and on a Monday build it
  // holds one day. It must not reach the table.
  const a = weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [
        trendRow('2026-08-03', 'FRT Compliance % (Open Queue)', 70),
        trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 80),
        trendRow('2026-08-18', 'FRT Compliance % (Open Queue)', 99, 1), // the partial week
      ],
    },
  }));
  const t = a.trend.find(x => x.kpi.includes('Open Queue'));
  assert.strictEqual(t.reported.value, 80, 'the completed week, not the partial one');
  assert.strictEqual(t.compare.value, 70);
  const md = weeklyRisk.render(a);
  assert.doesNotMatch(md, /\| 99% \|/, 'the one-day figure must not appear in the table');
});

test('⚠ a KPI the pipeline STOPPED writing reads "not measured", never its last value', () => {
  // Tier 2 last landed w/c 3 Aug. The old positional read printed 44% under
  // "This week" for a fortnight.
  const a = weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [
        trendRow('2026-07-27', 'FRT Compliance % (Tier 2)', 61),
        trendRow('2026-08-03', 'FRT Compliance % (Tier 2)', 44),
      ],
    },
  }));
  const t = a.trend.find(x => x.kpi.includes('Tier 2'));
  assert.strictEqual(t.measured, false);
  assert.strictEqual(t.reported, null);
  const md = weeklyRisk.render(a);
  assert.match(md, /\| FRT Compliance % \(Tier 2\) \| not measured/);
  assert.doesNotMatch(md, /\| FRT Compliance % \(Tier 2\) \| 44%/, 'the stale value must not render as current');
});

test('an unmeasured row is SHOWN and says when it was last seen', () => {
  // Dropping it hides that the KPI exists, which reads as a queue with nothing
  // to report rather than a measurement that stopped.
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-03', 'FRT Compliance % (Tier 2)', 44)] },
  })));
  assert.match(md, /FRT Compliance % \(Tier 2\)/, 'the row is still there');
  assert.match(md, /last 3 Aug/, 'and it dates its last sighting');
});

test('⚠ compliance KPIs that stopped being produced are ONE escalation, naming them', () => {
  const rows = ['Tier 2', 'Tier 3', 'Production'].map(q =>
    trendRow('2026-08-03', `FRT Compliance % (${q})`, 40));
  rows.push(trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 88));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows } }));
  const f = a.findings.filter(x => x.kind === 'kpi-unmeasured');
  assert.strictEqual(f.length, 1, 'one finding, not one per KPI');
  assert.strictEqual(f[0].severity, 'escalate');
  assert.match(f[0].title, /3 compliance KPIs not measured/);
  assert.match(f[0].detail, /ABSENT, not passing/);
  for (const q of ['Tier 2', 'Tier 3', 'Production']) assert.match(f[0].detail, new RegExp(q));
  assert.doesNotMatch(f[0].detail, /Open Queue/, 'a measured KPI is not accused');
});

test('⚠ a SLIDE is never claimed from a series that stopped', () => {
  // "below target for 3 straight weeks" is a claim about NOW. Read off data that
  // ends a fortnight ago it is a stale fact asserted as a current one.
  const stopped = ['2026-07-20', '2026-07-27', '2026-08-03'].map((p, i) =>
    trendRow(p, 'Resolution Compliance % (Tier 2)', [30, 40, 45][i]));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows: stopped } }));
  assert.strictEqual(a.findings.find(x => x.kind === 'compliance-slide'), undefined,
                     'no slide from an unmeasured KPI');
  assert.ok(a.findings.some(x => x.kind === 'kpi-unmeasured'), 'it is reported as unmeasured instead');
});

test('a slide still fires when the KPI IS current, and counts back from the reporting week', () => {
  const rows = ['2026-07-27', '2026-08-03', '2026-08-10'].map((p, i) =>
    trendRow(p, 'Resolution Compliance % (Tier 2)', [30, 40, 45][i]));
  // A later, partial week that happens to look fine must not end the count.
  rows.push(trendRow('2026-08-18', 'Resolution Compliance % (Tier 2)', 99, 1));
  const f = weeklyRisk.assess(baseSnapshot({ trend: { rows } }))
    .findings.find(x => x.kind === 'compliance-slide');
  assert.ok(f, 'expected a slide');
  assert.strictEqual(f.weeks, 3);
  assert.doesNotMatch(f.detail, /99%/, 'the partial week is not in the history either');
});

test('the column headers are DATED, so they cannot come to mean something else', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 88)] },
  })));
  assert.match(md, /\| Week to 16 Aug \| Week to 9 Aug \|/, 'both columns name the Sunday they end on');
  assert.doesNotMatch(md, /\| This week \| Last week \|/, 'the ambiguous headers are gone');
  assert.match(md, /Complete Monday-to-Sunday weeks/);
});

test('the bucket label is matched by SPAN, not by reconstructing NOVA\'s arithmetic', () => {
  // Measured 14 Sep 2026: kpi-trend labels each bucket on the MONDAY PLUS ONE
  // DAY. Matching the whole Mon-Sun span means the label may sit anywhere inside
  // its own week; one that moved outside would match nothing and read "not
  // measured" — absent rather than wrong.
  assert.strictEqual(weeklyRisk.periodInWeek('2026-08-11', '2026-08-10'), true, 'Monday+1, the live shape');
  assert.strictEqual(weeklyRisk.periodInWeek('2026-08-10', '2026-08-10'), true, 'the Monday itself');
  assert.strictEqual(weeklyRisk.periodInWeek('2026-08-16', '2026-08-10'), true, 'the Sunday');
  assert.strictEqual(weeklyRisk.periodInWeek('2026-08-09', '2026-08-10'), false, 'the week before');
  assert.strictEqual(weeklyRisk.periodInWeek('2026-08-17', '2026-08-10'), false, 'the week after');
});

test('with no anchor NOTHING is measured — it never falls back to the positional read', () => {
  // That fallback IS the bug, so it must not survive as a default.
  const built = weeklyRisk.buildTrend({ rows: [
    trendRow('2026-08-03', 'FRT Compliance % (Tier 2)', 44),
    trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 47),
  ] });
  assert.strictEqual(built[0].measured, false);
  assert.strictEqual(built[0].reported, null);
  assert.strictEqual(built[0].delta, null);
});

test('the panel and the document read the SAME fields, so they cannot disagree', () => {
  // WeeklyRiskPanel is what Nick reads before pressing send; it renders
  // t.reported / t.compare / t.measured off this exact payload.
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../frontend/src/components/WeeklyRiskPanel.jsx'), 'utf8');
  assert.match(src, /t\.reported\?\.value/, 'the panel reads the anchored week');
  assert.match(src, /t\.compare\?\.value/);
  assert.match(src, /!t\.measured \? 'not measured'/, 'and renders an unmeasured KPI as such');
  assert.doesNotMatch(src, /t\.latest\?\.value/, 'the positional read is gone from the panel too');
  assert.doesNotMatch(src, /<th>This week<\/th>/, 'and so is the misleading header');
});

test('⚠ the CSAT rows ask for the SAME weeks the compliance rows are anchored to', () => {
  // The first cut asked for `week` — the week the report is filed under, which
  // on a Monday build is a single day — and so reproduced, inside the rows
  // added to fix a measurement bug, the bug that made the rows above them
  // wrong. A CSAT row and a compliance row on one line must describe one week.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'weekly-risk.js'), 'utf8');
  assert.match(src, /pull\('csat-reported', \(\) => nova\.call\(csatQuery\(reportWeek\)\)\)/);
  assert.match(src, /pull\('csat-compare', \(\) => nova\.call\(csatQuery\(previousWeek\(reportWeek\)\)\)\)/);
  // Anchored to the CALL, not the bare text — `function csatQuery(week)` is the
  // declaration and matching it would fail for the wrong reason.
  assert.doesNotMatch(src, /nova\.call\(csatQuery\(week\)\)/, 'never the filed-under week');
});

// ── Each KPI is judged against its OWN target (Nick, 14 Sep 2026) ────────────
// The column read "vs 95%" and every row was measured against it. Measured on
// the live snapshot for 2 Sep 2026, compliance targets are NOT uniform: the two
// cross-queue KPIs (Open Queue, Resolved Today) are 90 and the five per-tier
// ones 95. So 95 miscoloured four of fourteen rows and 90 would miscolour ten —
// no single header could have been right.

test('⚠ a mixed-target table judges each row against its own number', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [
        // 91% — passing against 90, failing against the old flat 95.
        trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 91, 7, 90),
        trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 91, 5, 95),
      ],
    },
  }));
  const md = weeklyRisk.render(a);
  assert.match(md, /\| FRT Compliance % \(Open Queue\) \| 91% \|.*\| 🟢 90% \|/, 'passes against 90');
  assert.match(md, /\| FRT Compliance % \(Tier 2\) \| 91% \|.*\| 🟠 95% \|/, 'and is amber against 95');
  assert.doesNotMatch(md, /vs 95%/, 'the fixed header is gone');
  assert.match(md, /\| vs target \|/);
});

test('the table says once that its targets differ, so a mixed column needs no key', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [
        trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 91, 7, 90),
        trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 91, 5, 95),
      ],
    },
  })));
  assert.match(md, /Targets differ by queue \(90% and 95%\)/);
  // A uniform table does not carry the explanation.
  const uniform = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 91, 7, 90)] },
  })));
  assert.doesNotMatch(uniform, /Targets differ by queue/);
});

test('⚠ NO TARGET STATED means NO COLOUR — never a fallback to 95', () => {
  // Judging a queue against a number nobody set is the same invention as
  // reading a stale figure as current.
  const a = weeklyRisk.assess(baseSnapshot({
    trend: { rows: [{ period: '2026-08-10', KPI: 'FRT Compliance % (Tier 2)', avgValue: 40, samples: 5 }] },
  }));
  const t = a.trend[0];
  assert.strictEqual(t.target, null);
  const md = weeklyRisk.render(a);
  assert.match(md, /no target set/);
  assert.doesNotMatch(md, /🔴|🟠|🟢/, 'no colour is asserted');
});

test('⚠ a target that MOVED inside the week is reported, not flattened to one end', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [{ period: '2026-08-10', KPI: 'FRT Compliance % (Tier 2)', avgValue: 92, samples: 5,
               targetMin: 90, targetMax: 95 }],
    },
  }));
  assert.strictEqual(a.trend[0].targetMoved, true);
  assert.strictEqual(a.trend[0].target, null, 'no single target can be stated');
  // 92 passes 90 and fails 95, so picking either end would assert a colour the
  // week does not support.
  const md = weeklyRisk.render(a);
  assert.match(md, /target moved 90–95%/);
  assert.doesNotMatch(md, /🔴|🟠|🟢/);
});

test('⚠ a SLIDE is measured against the KPI\'s own target', () => {
  // Against a flat 95 these three weeks at 91-93 would escalate to Chris as a
  // three-week slide — over a KPI that was passing all three weeks.
  const passing = ['2026-07-27', '2026-08-03', '2026-08-10'].map((p, i) =>
    trendRow(p, 'FRT Compliance % (Open Queue)', [91, 92, 93][i], 7, 90));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows: passing } }));
  assert.strictEqual(a.findings.find(x => x.kind === 'compliance-slide'), undefined,
                     'passing its own target is not a slide');

  // The same shape against a 95 target IS one, and the title names 95.
  const failing = ['2026-07-27', '2026-08-03', '2026-08-10'].map((p, i) =>
    trendRow(p, 'FRT Compliance % (Tier 2)', [91, 92, 93][i], 5, 95));
  const f = weeklyRisk.assess(baseSnapshot({ trend: { rows: failing } }))
    .findings.find(x => x.kind === 'compliance-slide');
  assert.ok(f, 'expected a slide against 95');
  assert.match(f.title, /below 95% for 3 straight weeks/);
});

test('a KPI with no target raises no slide either', () => {
  const rows = ['2026-07-27', '2026-08-03', '2026-08-10'].map((period, i) => ({
    period, KPI: 'FRT Compliance % (Tier 2)', avgValue: [10, 11, 12][i], samples: 5,
  }));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows } }));
  assert.strictEqual(a.findings.find(x => x.kind === 'compliance-slide'), undefined);
});

test('targetOf is pure and keeps its three answers apart', () => {
  assert.deepStrictEqual(weeklyRisk.targetOf({ targetMin: 90, targetMax: 90 }),
                         { target: 90, targetMoved: false });
  assert.deepStrictEqual(weeklyRisk.targetOf({ targetMin: null, targetMax: null }),
                         { target: null, targetMoved: false }, 'an older bridge states nothing');
  const moved = weeklyRisk.targetOf({ targetMin: 90, targetMax: 95 });
  assert.strictEqual(moved.target, null);
  assert.strictEqual(moved.targetMoved, true);
  assert.deepStrictEqual(moved.targetRange, [90, 95]);
  assert.deepStrictEqual(weeklyRisk.targetOf(null), { target: null, targetMoved: false });
});

test('the amber band is relative to the target, and is NEURO\'s rule not NOVA\'s', () => {
  // NOVA's own amberMin is not exposed over the bridge, so this must not claim
  // to agree with it — but it must at least scale with the target rather than
  // sitting at a fixed 75.
  const at90 = weeklyRisk.ragCell({ measured: true, reported: { value: 71 }, target: 90, targetMoved: false });
  const at95 = weeklyRisk.ragCell({ measured: true, reported: { value: 71 }, target: 95, targetMoved: false });
  assert.match(at90, /🟠/, '71 is within 20 of 90');
  assert.match(at95, /🔴/, 'and outside 20 of 95');
  assert.strictEqual(weeklyRisk.AMBER_BAND, 20);
});

test('the panel judges against the same per-KPI target the document does', () => {
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../frontend/src/components/WeeklyRiskPanel.jsx'), 'utf8');
  assert.match(src, /t\.reported\?\.value < t\.target/, 'the panel uses the KPI target');
  assert.doesNotMatch(src, /t\.reported\?\.value < 95/, 'the flat 95 is gone from the panel');
  assert.match(src, /no target set/, 'and it renders an unstated target as such');
  assert.match(src, /<th>vs target<\/th>/);
});

// ── The ORDER and the CSAT ROWS live on the PAYLOAD (14 Sep 2026) ────────────
// Both were built inside complianceTable(), so the markdown Chris reads had
// them and `assess().trend` did not — and WeeklyRiskPanel, which renders the
// same array, went on showing Customer Care, Development, Open Queue… with no
// CSAT at all. Two surfaces disagreeing about one decision.

test('⚠ assess().trend is ALREADY in Nicks order — not just the markdown', () => {
  const rows = ['Tier 3', 'Development', 'Customer Care', 'Open Queue', 'Production', 'Tier 2', 'Resolved Today']
    .map(q => trendRow('2026-08-10', `FRT Compliance % (${q})`, 80));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows } }));
  assert.deepStrictEqual(a.trend.map(t => weeklyRisk.queueOf(t.kpi)), [
    'Open Queue', 'Resolved Today', 'Customer Care', 'Production', 'Tier 2', 'Tier 3', 'Development',
  ]);
});

test('compliance KPIs sort ABOVE everything else on the payload', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [
        trendRow('2026-08-10', 'Open Tickets', 391),
        trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 80),
        trendRow('2026-08-10', 'AI Resolution Rate %', 0),
        trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 85),
      ],
    },
  }));
  assert.deepStrictEqual(a.trend.map(t => t.kpi), [
    'FRT Compliance % (Open Queue)',
    'FRT Compliance % (Tier 2)',
    'AI Resolution Rate %',
    'Open Tickets',
  ]);
});

test('⚠ the CSAT rows are on the payload, so BOTH surfaces can render them', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    csat: {
      now:   { ratings: 5, avgScore: 4.2, daysWithRating: 4, jiraDatedByProxy: 0, complete: true, jiraError: null },
      prior: { ratings: 1, avgScore: 5,   daysWithRating: 1, jiraDatedByProxy: 0, complete: true, jiraError: null },
    },
  }));
  assert.strictEqual(a.csatRows.length, 2);
  assert.deepStrictEqual(a.csatRows.map(r => r.label),
                         ['CSAT average score', 'CSAT days receiving a rating']);
  assert.strictEqual(a.csatRows[0].now, '4.2 / 5');
  assert.strictEqual(a.csatRows[1].now, '4 of 7 days');
  assert.strictEqual(a.csatRows[0].delta, '▼ -0.8');
});

test('one composer, two renderers — the markdown is built from the same rows', () => {
  const csat = {
    now:   { known: true, ratings: 5, avgScore: 4.2, daysWithRating: 4, jiraDatedByProxy: 0, complete: true, error: null },
    prior: { known: true, ratings: 1, avgScore: 5,   daysWithRating: 1, jiraDatedByProxy: 0, complete: true, error: null },
  };
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    csat: { now: { ...csat.now }, prior: { ...csat.prior } },
  })));
  for (const r of weeklyRisk.csatSummaryRows(csat)) {
    assert.ok(md.includes(`| ${r.label} | ${r.now} | ${r.was} |`),
              `the document must carry the composed row: ${r.label}`);
  }
});

test('the panel renders the payload rows rather than composing its own', () => {
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../frontend/src/components/WeeklyRiskPanel.jsx'), 'utf8');
  assert.match(src, /report\.csatRows \|\| \[\]/, 'the panel reads the composed rows');
  assert.match(src, /\{r\.label\}/, 'and renders them verbatim');
  // It must not re-derive the order either — filter preserves the payload's.
  assert.doesNotMatch(src, /\.sort\(/, 'the panel never re-sorts the trend');
});

// ── The LIVE table wins, per KPI (14 Sep 2026) ───────────────────────────────
// `kpi-trend` reads jira_kpi_daily, the legacy n8n table, which stopped
// producing 39 KPIs on 5 Sep. NOVA's screens never noticed because they read
// kpi_org_daily. So the report rendered "not measured" over data NOVA had.

test('⚠ a KPI the LIVE table knows is read from the live table', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 44)] },
    orgTrend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 88)] },
  }));
  const t = a.trend[0];
  assert.strictEqual(t.reported.value, 88, 'the live value, not the legacy one');
  assert.strictEqual(t.source, 'kpi_org_daily');
});

test('⚠ preference is PER KPI, never per week — the tables disagree on value', () => {
  // NOVA's own backfill.ts says the legacy figures "were inflated 2-3x", so
  // taking one week from each would manufacture a trend out of a source change.
  const a = weeklyRisk.assess(baseSnapshot({
    trend: {
      rows: [
        trendRow('2026-08-03', 'FRT Compliance % (Tier 2)', 90),
        trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 44),
      ],
    },
    // The live table has only the reporting week for this KPI.
    orgTrend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 88)] },
  }));
  const t = a.trend[0];
  assert.strictEqual(t.reported.value, 88);
  assert.strictEqual(t.compare, null, 'the legacy week is NOT borrowed to fill the gap');
  assert.strictEqual(t.delta, null, 'and no delta is invented across the two tables');
});

test('a KPI the live table does not carry falls back to legacy, and says so', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Tier 3)', 70)] },
    orgTrend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Open Queue)', 88)] },
  }));
  const t3 = a.trend.find(x => x.kpi.includes('Tier 3'));
  assert.strictEqual(t3.reported.value, 70);
  assert.strictEqual(t3.source, 'jira_kpi_daily');
  assert.match(weeklyRisk.render(a), /legacy `jira_kpi_daily`/);
});

test('an unreachable live table degrades to legacy and NAMES the degradation', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    trend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 44)] },
    orgTrend: null,
  })));
  assert.match(md, /\| FRT Compliance % \(Tier 2\) \| 44% \|/, 'the legacy figure still shows');
  assert.match(md, /could not be reached/);
});

test('a healthy live-only read carries no source caveat, and declares the right table', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    trend: { rows: [] },
    orgTrend: { rows: [trendRow('2026-08-10', 'FRT Compliance % (Tier 2)', 88)] },
  })));
  const table = md.slice(md.indexOf('## 1.'), md.indexOf('## 2.'));
  assert.doesNotMatch(table, /jira_kpi_daily/, 'no standing hedge on a clean read');
  // ⚠ And the frontmatter names the table that ANSWERED. It said
  // `jira_kpi_daily` unconditionally, so the document's own provenance line was
  // wrong the moment the live table started answering — and provenance is the
  // first thing a reader checks when a figure looks off.
  assert.match(md, /data_source: NOVA kpi_org_daily as at/);
  assert.doesNotMatch(md, /data_source: NOVA jira_kpi_daily/);
});

// ── The Δ column is coloured in the mail too (Nick, 14 Sep 2026) ─────────────
// The desktop panel colours a rise green and a fall red (wr-delta-up /
// wr-delta-down) and the email rendered both in plain black — so one table said
// two different things depending on where it was read, and the mail is the copy
// that reaches Chris.

test('a rise is green and a fall is red in the email', () => {
  const md = '| KPI | Week | Δ |\n|---|---|---|\n| Up | 85% | ▲ +3 |\n| Down | 70% | ▼ -14.3 |\n';
  const html = weeklyRisk.markdownToEmailHtml(md);
  assert.match(html, /color:#1a7f37[^"]*">▲ \+3</, 'a rise is green');
  assert.match(html, /color:#b42318[^"]*">▼ -14\.3</, 'a fall is red');
});

test('a flat delta and an ordinary cell are NOT coloured', () => {
  const html = weeklyRisk.markdownToEmailHtml(
    '| KPI | Week | Δ |\n|---|---|---|\n| Flat | 50% | – 0 |\n| None | 60% | — |\n');
  assert.doesNotMatch(html, /color:#1a7f37/, 'nothing green');
  assert.doesNotMatch(html, /color:#b42318/, 'nothing red');
});

test('⚠ the ARROW still carries the meaning — colour is only ever added on top', () => {
  // A client that strips inline styles, a printed copy and a colour-blind
  // reader all lose the hue; none of them may lose the fact.
  const html = weeklyRisk.markdownToEmailHtml(
    '| KPI | Week | Δ |\n|---|---|---|\n| Up | 85% | ▲ +3 |\n| Down | 70% | ▼ -14.3 |\n');
  const stripped = html.replace(/ style="[^"]*"/g, '');
  assert.match(stripped, /▲ \+3/, 'the rise survives with no styling at all');
  assert.match(stripped, /▼ -14\.3/, 'and so does the fall');
});

test('⚠ ONLY an arrow-led cell is coloured — a stray sign colours nothing', () => {
  // Guards the tempting substring implementation (`includes('+')` /
  // `includes('-')`), which would paint a negative VALUE or a hyphenated KPI
  // name as though it were a trend.
  const html = weeklyRisk.markdownToEmailHtml(
    '| KPI | Week | Δ |\n|---|---|---|\n'
    + '| Re-opened rate | -5% | — |\n'
    + '| Net change | +12% | — |\n');
  assert.doesNotMatch(html, /color:#1a7f37/, 'a bare + is not a rise');
  assert.doesNotMatch(html, /color:#b42318/, 'a bare - is not a fall');
});

test('the Δ cell is found by its ARROW, not by a column index', () => {
  // A column index would be silently wrong the day a column is added — which is
  // exactly the change this table has just had (vs target).
  const html = weeklyRisk.markdownToEmailHtml(
    '| KPI | A | B | C | D | Δ |\n|---|---|---|---|---|---|\n| x | 1 | 2 | 3 | 4 | ▲ +9 |\n');
  assert.match(html, /color:#1a7f37[^"]*">▲ \+9</);
});

test('the real report colours its deltas end to end', () => {
  const rows = ['2026-08-03', '2026-08-10'].map((p, i) =>
    trendRow(p, 'FRT Compliance % (Open Queue)', [80, 85][i], 7, 90));
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ trend: { rows } })));
  const html = weeklyRisk.markdownToEmailHtml(md);
  assert.match(html, /color:#1a7f37/, 'the rendered report reaches the mail coloured');
});
