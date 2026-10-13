'use strict';

/**
 * Personal tasks out of personal mail (12 Oct 2026). The SAME review-only
 * extractor the work inbox uses; what these tests pin is what differs:
 * mail Nick sent himself is never asked about, the personal inbox keeps its OWN
 * seen-ledger (so neither inbox prunes the other's answers), and approving a
 * personal candidate makes a PERSONAL task — end to end through the real
 * executor, because a domain written on a payload and never read is nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-personal-ea-'));
process.env.NEURO_DB_PATH = path.join(root, 'p.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const aiRouting = require('./ai-routing');
const ea = require('./email-actions');
const suggestionEngine = require('./suggestion-engine');

test.before(async () => { await db.init(); });

const row = (id, over = {}) => ({
  id, mailbox: 'gmail', from_name: 'Fasthosts', from_email: 'billing@fasthosts.co.uk',
  subject: 'IMPORTANT - Credit Card Expired', preview: 'Your card on file has expired. Please update it to avoid interruption.',
  received: '2026-10-01T09:00:00Z', ...over,
});

let prompts = [];
function stubModel(answer) {
  prompts = [];
  aiRouting.runTask = async (task, { prompt }) => { prompts.push(prompt); return { text: answer(prompt), provider: 'stub' }; };
}

test('only mail from other people is read, with the personal prompt; a quiet email is answered once', async () => {
  stubModel(() => '[{"index":0,"action":"Update the expired card on the Fasthosts account"},{"index":1,"action":null}]');
  const rows = [
    row('gmail:1'),
    row('gmail:2', { from_name: 'Zilch', from_email: 'support@payzilch.com', subject: 'Thanks for your payment', preview: 'Payment received.' }),
    row('pmail:nick:5:7', { mailbox: 'nick', from_email: 'nick@nickward.co.uk', subject: 'NEURO test', preview: 'me' }),
    row('gmail:3', { subject: 'Invitation: hiking @ Sat 7 Nov 2026', from_email: 'lizzy@example.com' }),
  ];
  const r = await ea.extractFromPersonal(rows, { own: ['nick@nickward.co.uk'] });
  assert.equal(r.considered, 2, 'his own mail and a calendar notice are never asks');
  assert.equal(r.created, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /PERSONAL email/);
  assert.doesNotMatch(prompts[0], /NEURO test|Invitation: hiking/);

  const ledger = JSON.parse(db.getState(ea.PERSONAL_LEDGER_KEY));
  assert.deepEqual(Object.keys(ledger).sort(), ['gmail:1', 'gmail:2']);
  assert.equal(ledger['gmail:2'].obligation, false, 'nothing owed is RECORDED, so it is never re-bought');
  assert.equal(db.getState('email_actions_seen') || null, null, 'the work ledger is untouched');

  prompts = [];
  const again = await ea.extractFromPersonal(rows, { own: ['nick@nickward.co.uk'] });
  assert.deepEqual([again.asked, prompts.length], [0, 0], 'a second pass with no new mail costs nothing');
});

test('the work ledger and the personal ledger never prune each other', async () => {
  db.setState('email_actions_seen', JSON.stringify({ 'AAMk-work': { at: 'x', obligation: false } }));
  stubModel(() => '[]');
  await ea.extractFromPersonal([row('gmail:1')], { own: [] });
  assert.ok(JSON.parse(db.getState('email_actions_seen'))['AAMk-work'], 'a personal pass must not forget work answers');
});

test('approving a personal candidate makes a PERSONAL task, carrying who it came from; a work one keeps the default', async () => {
  const pending = db.all("SELECT * FROM saim_actions WHERE type = 'capture_todo' AND status = 'pending'");
  assert.equal(pending.length, 1);
  const action = db.getSaimAction(pending[0].id);
  assert.equal(action.payload.domain, 'personal');
  assert.equal(action.payload.email.mailbox, 'gmail');
  assert.match(action.reason, /^Personal email: asked of you by Fasthosts/);

  const res = await suggestionEngine.executeAction(action);
  assert.equal(res.ok, true, res.detail);
  const id = Number(String(res.detail).match(/#(\d+)/)[1]);
  const task = db.get('SELECT * FROM tasks WHERE id = ?', [id]);
  assert.equal(task.domain, 'personal');
  assert.equal(task.source, 'personal-email-promotion');

  const work = ea.buildCandidate({ id: 'AAMk-1', from: 'Chris', subject: 'Headcount' }, 'Send Chris the headcount numbers');
  assert.equal('domain' in work.payload, false, 'a work candidate names no domain');
  const wid = db.createSaimAction('capture_todo', work.payload, 0.6, work.reason, work.focusItemId);
  const wres = await suggestionEngine.executeAction(db.getSaimAction(wid));
  const wtask = db.get('SELECT * FROM tasks WHERE id = ?', [Number(String(wres.detail).match(/#(\d+)/)[1])]);
  assert.equal(wtask.domain, 'work');
});

test('the personal-inbox refresh runs the scan and never fails because of it', async () => {
  const inbox = require('./personal-inbox');
  const seen = [];
  let s = await inbox.refresh({ only: ['nick'], deps: { classifyBatch: async () => [], extractTasks: async (rows, opts) => { seen.push(opts.own); return { created: 2, asked: 3 }; } } });
  assert.deepEqual(s.tasks, { created: 2, asked: 3 });
  assert.ok(seen[0].includes('nickw@nurtur.tech'), 'his work address counts as his own');
  s = await inbox.refresh({ only: ['nick'], deps: { classifyBatch: async () => [], extractTasks: async () => { throw new Error('model down'); } } });
  assert.deepEqual(s.tasks, { error: 'model down' });
  s = await inbox.refresh({ only: ['saim'], deps: { extractTasks: async () => { throw new Error('should not run'); } } });
  assert.equal(s.tasks, undefined, 'a saim@-only pass does not scan');
});
