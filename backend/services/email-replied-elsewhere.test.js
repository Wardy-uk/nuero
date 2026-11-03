'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { closeRepliedElsewhere } = require('./email-triage');
const { evaluateEmail } = require('./email-priority');

test('an email Nick answered from Outlook is closed; one he has not, kept', () => {
  const entries = [
    { id: 'a', lane: 'reply', conversationId: 'c1', received: '2026-11-03T08:00:00Z' },
    { id: 'b', lane: 'urgent', conversationId: 'c2', received: '2026-11-03T09:00:00Z' },
    { id: 'c', lane: 'reply', conversationId: 'c3', received: '2026-11-03T09:00:00Z' },
    { id: 'd', lane: 'fyi', conversationId: 'c1', received: '2026-11-03T07:00:00Z' },
  ];
  const sent = [
    { conversationId: 'c1', sentAt: '2026-11-03T08:30:00Z' },
    { conversationId: 'c2', sentAt: '2026-11-03T08:30:00Z' }, // BEFORE b arrived: b is a new ask
  ];
  const r = closeRepliedElsewhere(entries, sent, 'now');
  assert.strictEqual(r.closed, 1);
  assert.strictEqual(r.entries[0].dismissReason, 'replied-elsewhere');
  assert.ok(!r.entries[1].dismissed);
  assert.ok(!r.entries[2].dismissed);
  assert.ok(!r.entries[3].dismissed, 'an FYI is not touched');
});

test('no conversation id, or no sent mail, closes nothing', () => {
  const r = closeRepliedElsewhere([{ id: 'a', lane: 'reply', received: '2026-11-03T08:00:00Z' }], [{ conversationId: null, sentAt: '2026-11-03T09:00:00Z' }]);
  assert.strictEqual(r.closed, 0);
});

test('own mail, out-of-office and cancellations never ask for a reply', () => {
  for (const e of [
    { from: 'Nick Ward', fromEmail: 'NickW@nurtur.tech', subject: 'Weekly briefing — week to 1 Nov', preview: 'urgent', importance: 'high' },
    { from: 'Isabel Busk', fromEmail: 'isabel.busk@nurtur.tech', subject: 'Automatic reply: UAT Wednesday', preview: 'urgent please' },
    { from: 'Abigail Brown', fromEmail: 'abigail.brown@nurtur.tech', subject: 'Canceled: EweMove Onboarding', preview: 'can you' },
  ]) {
    const j = evaluateEmail(e);
    assert.strictEqual(j.lane, 'fyi', e.subject);
    assert.strictEqual(j.forced, true);
  }
});
