'use strict';

// 30 Oct 2026, from the 08:00 brief: "2 urgent emails" — a colleague's
// follow-up on a ticket titled "Forms not working" (needs attention, not
// urgent) and a Rab marketing email (noise). One keyword used to force urgent,
// keywords matched as substrings ('down' in "down jacket", 'sla' in
// "translate"), and the rules overrode the model's IGNORE.

const test = require('node:test');
const assert = require('node:assert');
const { evaluateEmail, _internals } = require('./email-priority');

const annabel = {
  id: 'a1', from: 'Annabel Goulden', fromEmail: 'Annabel.Goulden@nurtur.tech',
  subject: 'Re: NT-35291 - Forms not working',
  preview: 'So nothing he asked for is outstanding?\r\n\r\nAnnabel Goulden\r\n\r\nHead of Customer Success and Onboarding',
  isRead: true, importance: 'normal', received: new Date().toISOString(),
};
const rab = {
  id: 'r1', from: 'Rab®', fromEmail: 'hello@email.rab.equipment',
  subject: 'You asked, we delivered.',
  preview: 'Our lightest down jacket is back in stock. Cancel your weekend plans.',
  isRead: false, importance: 'normal', received: new Date().toISOString(),
};

test('keywords match whole words, not substrings', () => {
  const { includesAny } = _internals;
  assert.strictEqual(includesAny('please translate this', ['sla']), false);
  assert.strictEqual(includesAny('an sla breach', ['sla']), true);
  assert.strictEqual(includesAny('illegal parking', ['legal']), false);
  assert.strictEqual(includesAny('our new down jacket', ['is down', 'went down']), false);
  assert.strictEqual(includesAny('the portal is down', ['is down']), true);
  // Needles that start/end on punctuation keep their old meaning.
  assert.strictEqual(includesAny('from no-reply@x.com', ['no-reply']), true);
});

test('one urgency signal needs attention, it is not urgent', () => {
  const r = evaluateEmail(annabel);
  assert.strictEqual(r.lane, 'reply');
  assert.strictEqual(r.category, 'ACTION');
});

test('two independent signals are still urgent', () => {
  const r = evaluateEmail({ ...annabel, subject: 'URGENT: portal is down for all customers', importance: 'high' });
  assert.strictEqual(r.lane, 'urgent');
});

test('the model\'s IGNORE wins for an unknown outside sender, never for a colleague', async (t) => {
  const aiProvider = require('./ai-provider');
  const orig = aiProvider.triageEmails;
  t.after(() => { aiProvider.triageEmails = orig; });
  aiProvider.triageEmails = async () => ({
    provider: 'stub',
    text: JSON.stringify([{ index: 0, category: 'IGNORE', reason: 'marketing' }, { index: 1, category: 'IGNORE', reason: 'x' }]),
  });
  const { classifyEmails } = require('./email-triage')._internals;
  const out = await classifyEmails([rab, annabel]);
  const byId = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.strictEqual(byId.r1.lane, 'ignore');
  assert.notStrictEqual(byId.a1.lane, 'ignore');
  assert.notStrictEqual(byId.a1.lane, 'urgent');
});
