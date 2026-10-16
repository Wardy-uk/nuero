'use strict';
// The SOAP intro line (Nick's own opening words) and the retry of a timed-out
// source during a build. 16 Oct 2026.
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soap-intro-')), 'agent.db');
const test = require('node:test');
const assert = require('node:assert');
const soap = require('./soap-report');
const db = require('../db/database');
test.before(async () => { await db.init(); });

const report = (over = {}) => ({
  kind: 'final', from: '2026-10-05', to: '2026-10-11', upTo: '2026-10-11',
  verdicts: { success: [], star: null, ambers: [], reds: [] }, carried: [],
  gaps: [], gapsBySection: {}, ...over,
});

test('an intro is stored, rendered first under the title, and omitted when blank', () => {
  const m = soap.setManual('2026-10-05', { intro: "As I'm on annual leave today, please see below the Service Desk SOAP." });
  const md = soap.render(report(), m, { forEmail: true });
  const lines = md.split('\n').filter(Boolean);
  assert.match(lines[0], /^# SOAP/);
  assert.strictEqual(lines[1], "As I'm on annual leave today, please see below the Service Desk SOAP.");
  const cleared = soap.setManual('2026-10-05', { intro: '' });
  assert.ok(!soap.render(report(), cleared).includes('annual leave'));
  // Omitted leaves it alone.
  soap.setManual('2026-10-05', { intro: 'Hello' });
  assert.strictEqual(soap.setManual('2026-10-05', { notes: 'x' }).intro, 'Hello');
});

test('a source that times out once is retried; a non-timeout failure is not', async () => {
  let leadCalls = 0; let planCalls = 0;
  const overrides = {
    leading: async () => { leadCalls++; if (leadCalls === 1) throw new Error('The operation was aborted due to timeout'); return { available: true, indicators: [], quiet: [1, 2] }; },
    plan: async () => { planCalls++; throw new Error('VANTAGE answered 500'); },
  };
  for (const k of ['kpi', 'series', 'perQueue', 'sentiment', 'leaderboard', 'customers', 'winning', 'findings']) overrides[k] = async () => { throw new Error('VANTAGE answered 404'); };
  overrides.slm = async () => ({ known: false, why: 'none' });
  const r = await soap.gather({ kind: 'final', now: new Date('2026-10-12T08:00:00'), overrides });
  assert.strictEqual(leadCalls, 2);
  assert.ok(r.leading && r.leading.available, 'the retried source landed');
  assert.ok(!r.gaps.some((g) => /leading/.test(g.source)));
  assert.strictEqual(planCalls, 1);
});
