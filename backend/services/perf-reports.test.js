'use strict';

/**
 * Sent reports as evidence (31 Oct 2026). Real scratch SQLite. Pins: only a
 * SENT record is an item; the send time is a fact with no hint and NO
 * deadline (Nick's Monday-midday target is his own, not a commitment); the detail carries the
 * headline / escalations / positives / actions and never the task or
 * management-log sections; a hand-recorded send with no text still counts.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-reports-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const reports = require('./perf-reports');

test.before(async () => { await db.init(); });

const BODY = [
  '# Weekly Risk & Anomaly Summary — w/c 19 Oct 2026',
  '## Headline', 'Tier 2 resolution compliance recovering: 45% to 56%.',
  '## To escalate to Chris', '- Development backlog 218 against 125.',
  '## 1. Week-on-week trend', '| KPI | x |',
  '## 6. My task position', 'SECRET-TASK-LINE',
  '## 7. Management actions & conversations', 'SECRET-MLOG-LINE',
  '## Positives (for balance)', '- FRT compliance 99%.',
  '## Actions this week', '- Run the aged-ticket review.',
].join('\n');

test('sent reports become items with the send time as a fact', () => {
  const set = (k, v) => db.setState(k, JSON.stringify(v));
  set('weekly_risk_sent_2026-10-19', { week: '2026-10-19', sentAt: '2026-10-20T12:56:04.026Z', recipients: [{ name: 'Chris Middleton' }], body: BODY });
  set('weekly_risk_sent_2026-10-26', { week: '2026-10-26', sentAt: '2026-10-26T10:15:00.000Z', recipients: [{ name: 'Chris Middleton' }], body: BODY });
  set('weekly_risk_sent_2026-08-31', { week: '2026-08-31', sentAt: '2026-09-01T09:00:00.000Z', reportedByNick: true, body: null });
  set('weekly_risk_queued_2026-10-19', { week: '2026-10-19' });
  set('soap_sent:2026-10-19', { weekFrom: '2026-10-19', kind: 'final', sentAt: '2026-10-26T08:00:00.000Z', recipients: ['Chris Middleton'], body: '## ✅ Success\nFixed the clock.\n## Agents\nNAMES' });

  const items = reports.itemsFor(db.getDb(), { from: '2026-08-01', to: '2026-10-31' });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(items.length, 4, 'queued and built-but-unsent reports are not items');

  const late = by['report:weekly-risk:2026-10-19'];
  assert.equal(late.hint, null);
  assert.match(late.detail, /^Sent Tue 20 Oct 13:56\. To Chris Middleton\./);
  for (const i of items) assert.doesNotMatch(i.detail, /(due|late|on time)/i, 'no self-set deadline is judged');
  assert.match(late.detail, /Tier 2 resolution compliance recovering/);
  assert.match(late.detail, /Run the aged-ticket review/);
  assert.doesNotMatch(late.detail, /SECRET-TASK-LINE|SECRET-MLOG-LINE/);

  assert.match(by['report:weekly-risk:2026-08-31'].detail, /sent by hand/);

  const soap = by['report:soap:2026-10-19'];
  assert.match(soap.detail, /Fixed the clock/);
  assert.doesNotMatch(soap.detail, /NAMES/);

  assert.equal(reports.itemsFor(db.getDb(), { from: '2026-10-27', to: '2026-10-31' }).length, 0, 'window by send day');
});
