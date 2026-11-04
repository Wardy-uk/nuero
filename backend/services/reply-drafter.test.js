'use strict';
// The 30 Oct 2026 failure: Stephen wrote to Rich (COO), Nick on Cc, and the
// draft answered Stephen as if Nick had been asked — promising to chase Dezrez
// and report back. These pin that a reply knows who it is to, and asks first.
const test = require('node:test');
const assert = require('node:assert/strict');
const rd = require('./reply-drafter');

const SELF = ['nickw@nurtur.tech'];
const dezrez = {
  from: 'Stephen Mitchell', fromEmail: 'stephen.mitchell@nurtur.tech',
  subject: 'Dezrez Escalation Contact',
  recipients: {
    to: [{ name: 'Richard Combellack', email: 'richard.combellack@nurtur.tech' }],
    cc: [{ name: 'Nick Ward', email: 'nickw@nurtur.tech' }, { name: 'Chris Middleton', email: 'chris.middleton@nurtur.tech' }],
  },
  body: 'Good morning, Richard, ... Could you give me an escalation contact at Dezrez?',
};
const stub = (text) => async () => ({ text, provider: 'stub' });

test('position: to / cc / none / unknown, by address, never by first name', () => {
  assert.equal(rd.positionOf(dezrez, { selfAddresses: SELF }), 'cc');
  assert.equal(rd.positionOf({ recipients: { to: [{ name: 'Nick Ward', email: 'NickW@nurtur.tech' }], cc: [] } }, { selfAddresses: SELF }), 'to');
  assert.equal(rd.positionOf({ recipients: { to: [{ name: 'Nick Smith', email: 'nick.smith@x.com' }], cc: [] } }, { selfAddresses: SELF }), 'none');
  assert.equal(rd.positionOf({ to: [], cc: [] }, { selfAddresses: SELF }), 'unknown');
  // A name-only entry (Graph `to` without recipients) matches the FULL name.
  assert.equal(rd.positionOf({ to: ['Richard Combellack'], cc: ['Nick Ward'] }, { selfAddresses: SELF }), 'cc');
});

test('the prompt carries To, Cc and where Nick sits', () => {
  const p = rd.buildPrompt({ message: dezrez, position: 'cc', steer: '' });
  assert.match(p, /To: Richard Combellack/);
  assert.match(p, /Cc: Nick Ward/);
  assert.match(p, /only COPIED/);
  assert.match(p, /MUST output QUESTIONS/);
  assert.match(p, /Never commit Nick/);
});

test('Cc and no steer: a draft from the model is NEVER returned — it asks', async () => {
  const out = await rd.draft({ message: dezrez, selfAddresses: SELF,
    runTask: stub("Hi Stephen,\n\nI'll chase Dezrez and get back to you by end of day tomorrow.\n\nNick") });
  assert.equal(out.kind, 'questions');
  assert.match(out.questions[0], /addressed to Richard Combellack/);
  assert.match(out.questions[0], /only copied/);
});

test('Cc and no steer: the model\'s own questions are kept', async () => {
  const out = await rd.draft({ message: dezrez, selfAddresses: SELF,
    runTask: stub('QUESTIONS\n- Do you want to reply, or leave it to Rich?\n- Do you have a Dezrez contact to share?') });
  assert.deepEqual(out.questions, ['Do you want to reply, or leave it to Rich?', 'Do you have a Dezrez contact to share?']);
});

test('Cc with a steer: drafts', async () => {
  const out = await rd.draft({ message: dezrez, selfAddresses: SELF, steer: 'reply all: I can call Dezrez Monday',
    runTask: stub('Hi Stephen,\n\nI can call Dezrez on Monday.\n\nNick') });
  assert.equal(out.kind, 'draft');
});

test('model down and Nick is not the addressee: still asks', async () => {
  const out = await rd.draft({ message: dezrez, selfAddresses: SELF, runTask: async () => { throw new Error('down'); } });
  assert.equal(out.kind, 'questions');
});

test('addressee: model down returns null (caller keeps its fallback); questions pass through', async () => {
  const toNick = { ...dezrez, recipients: { to: [{ name: 'Nick Ward', email: 'nickw@nurtur.tech' }], cc: [] } };
  assert.equal(await rd.draft({ message: toNick, selfAddresses: SELF, runTask: async () => ({ text: '' }) }), null);
  const q = await rd.draft({ message: toNick, selfAddresses: SELF, runTask: stub('QUESTIONS\n1. Which date can you commit to?') });
  assert.deepEqual(q.questions, ['Which date can you commit to?']);
});

test('parseAnswer: a QUESTIONS header with nothing under it is unreadable', () => {
  assert.equal(rd.parseAnswer('QUESTIONS\n'), null);
  assert.equal(rd.parseAnswer('**QUESTIONS**\n- a\n- b\n- c\n- d').questions.length, rd.MAX_QUESTIONS);
});

// 4 Nov 2026: Nick typed his whole reply and pressed Draft with AI. The route
// cut it at 1000 chars and the model asked whether he had finished, with the
// only answer box being the one holding his reply.
const ownReply = 'All,\n\nI was on annual leave Monday, so apologies for the delay. ' + 'There are 7 tickets open across the teams. '.repeat(30) + '\n\nNick';

test('a written reply is his draft, whole, not a truncated steer', () => {
  const inp = rd.inputsFrom({ instruction: ownReply, answers: '' });
  assert.equal(inp.ownDraft, ownReply.trim());
  assert.ok(ownReply.length > 1000);
  assert.equal(inp.steer, '');
  const short = rd.inputsFrom({ instruction: 'say I can call Monday', answers: 'yes' });
  assert.equal(short.ownDraft, '');
  assert.match(short.steer, /call Monday[\s\S]*yes/);
});

test('his own draft is tidied, never questioned — even on Cc', async () => {
  let prompt = '';
  const out = await rd.draft({ message: dezrez, selfAddresses: SELF, ownDraft: ownReply,
    runTask: async (_t, p) => { prompt = p.prompt; return { text: 'QUESTIONS\n- Has Nick finished?', provider: 'stub' }; } });
  assert.equal(out.kind, 'draft');
  assert.equal(out.text, ownReply.trim());
  assert.match(prompt, /Do NOT ask questions/);
  assert.ok(prompt.includes(ownReply.trim()));
});

test('his own draft with the model down comes back unchanged', async () => {
  const out = await rd.draft({ message: dezrez, selfAddresses: SELF, ownDraft: ownReply, runTask: async () => { throw new Error('down'); } });
  assert.equal(out.kind, 'draft');
  assert.equal(out.provider, 'unchanged');
});
