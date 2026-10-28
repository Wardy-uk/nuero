'use strict';

// Nick's escalations per week, for the SOAP and Weekly Risk reports (28 Oct 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const me = require('./my-escalations');

test('raised in Jira: only manual escalations by Nick, inside the London week', () => {
  const rows = [
    { ticket_key: 'NT-1', escalation_type: 'manual', escalated_by: 'Nick Ward', created_at: '2026-10-20T09:00:00Z' },
    { ticket_key: 'NT-1', escalation_type: 'manual', escalated_by: 'Nick Ward', created_at: '2026-10-21T09:00:00Z' },
    { ticket_key: 'NT-2', escalation_type: 'manual', escalated_by: 'Chris Middleton', created_at: '2026-10-20T09:00:00Z' },
    { ticket_key: 'NT-3', escalation_type: 'jira_transition', escalated_by: 'Nick Ward', created_at: '2026-10-20T09:00:00Z' },
    // 23:30 UTC Sunday 25 Oct is Sunday in London (GMT after the clocks change) — in.
    { ticket_key: 'NT-4', escalation_type: 'manual', escalated_by: 'Nick Ward', created_at: '2026-10-25T23:30:00Z' },
    // 23:30 UTC on Sunday 18 Oct is Monday 00:30 in London (BST) — in.
    { ticket_key: 'NT-5', escalation_type: 'manual', escalated_by: 'Nick Ward', created_at: '2026-10-18T23:30:00Z' },
    { ticket_key: 'NT-6', escalation_type: 'manual', escalated_by: 'Nick Ward', created_at: '2026-10-26T09:00:00Z' },
  ];
  const r = me.jiraIn(rows, '2026-10-19', '2026-10-25');
  assert.equal(r.count, 4);
  assert.deepEqual(r.tickets.sort(), ['NT-1', 'NT-4', 'NT-5']);
});

test('by email: sent escalation emails only, dated by the send', () => {
  const ev = (t) => JSON.stringify({ origin: 'composer', ticket: t });
  const rows = [
    { status: 'verified', created_at: '2026-10-17T10:00:00Z', executed_at: '2026-10-20T10:00:00Z', evidence_json: ev('NT-1') },
    { status: 'prepared', created_at: '2026-10-20T10:00:00Z', evidence_json: ev('NT-2') },
    { status: 'rejected', created_at: '2026-10-20T10:00:00Z', evidence_json: ev('NT-3') },
    { status: 'verified', created_at: '2026-10-20T10:00:00Z', executed_at: '2026-10-20T10:01:00Z', evidence_json: JSON.stringify({ origin: 'composer' }) },
    { status: 'executed', created_at: '2026-10-27T10:00:00Z', executed_at: '2026-10-27T10:00:00Z', evidence_json: ev('NT-4') },
  ];
  assert.deepEqual(me.emailIn(rows, '2026-10-19', '2026-10-25'), { count: 1, tickets: ['NT-1'] });
});

test('an unread half is null, never 0, and the line says so', () => {
  const ok = me.combine({ count: 2, tickets: ['NT-1', 'NT-2'] }, { count: 1, tickets: ['NT-1'] });
  assert.equal(ok.total, 3);
  assert.equal(ok.tickets, 2);
  assert.match(me.line(ok), /\*\*3\*\* escalations raised by me: 2 raised in Jira, 1 by email \(2 tickets\)/);
  const half = me.combine({ count: null, tickets: [], error: 'NOVA down' }, { count: 1, tickets: ['NT-1'] });
  assert.equal(half.total, null);
  assert.match(me.line(half), /raised in Jira — could not be read \(NOVA down\), 1 by email/);
  assert.doesNotMatch(me.line(half), /\b0 raised/);
});

test('weekCounts reads NOVA and the email table, and survives both failing', async () => {
  const nova = { isConfigured: () => true, listEscalations: async () => [{ ticket_key: 'NT-9', escalation_type: 'manual', escalated_by: 'Nick Ward', created_at: '2026-10-20T09:00:00Z' }] };
  const db = { prepare: () => ({ all: () => [] }) };
  const r = await me.weekCounts({ from: '2026-10-19', to: '2026-10-25', deps: { nova, db } });
  assert.equal(r.total, 1);
  const bad = await me.weekCounts({ from: '2026-10-19', to: '2026-10-25', deps: { nova: { isConfigured: () => { throw new Error('x'); } }, db: { prepare: () => { throw new Error('y'); } } } });
  assert.equal(bad.total, null);
  assert.equal(bad.jira.count, null);
  assert.equal(bad.email.count, null);
});

test('both reports carry the count', () => {
  const wr = fs.readFileSync(path.join(__dirname, 'weekly-risk.js'), 'utf8');
  assert.match(wr, /myEscalations = await require\('\.\/my-escalations'\)\.weekCounts\(\{ from: reportWeek/);
  assert.match(wr, /myEscalations: snap\.myEscalations/);
  assert.match(wr, /require\('\.\/my-escalations'\)\.line\(a\.myEscalations\)/);
  const soap = fs.readFileSync(path.join(__dirname, 'soap-report.js'), 'utf8');
  assert.match(soap, /volumes, myEscalations,/);
  assert.match(soap, /require\('\.\/my-escalations'\)\.line\(report\.myEscalations\)/);
});
