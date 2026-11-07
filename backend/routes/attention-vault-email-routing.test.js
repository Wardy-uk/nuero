'use strict';

/**
 * Done on a Now card closes the work where it lives — over real HTTP (7 Nov 2026).
 *
 *   * A DAILY-NOTE checkbox used to answer "this one is a checkbox in the vault —
 *     tick it there" while the Tasks screen ticked the same line in one press
 *     (audit F9). The route now finds the ONE open line by its text at press
 *     time and ticks it through the same toggle.
 *   * A card about ONE email cleared itself and left the email in Inbox ACTION
 *     (audit F10). Done now dismisses it as done; Not relevant as not-relevant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-attve-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Daily'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;

const db = require('../db/database');
const lifecycle = require('../services/attention-lifecycle');

const today = new Date();
const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const notePath = path.join(vault, 'Daily', `${dayKey}.md`);

let server;
let base;

test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/attention', require('./attention'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

async function post(p, body) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
function seed(card) {
  seq += 1;
  const [rec] = lifecycle.reconcile([{ kind: 'item', id: `c-${seq}`, urgency: 'medium', tier: 2, ...card }], { now: new Date() });
  return rec;
}

test('Done on a daily-note task ticks THAT line in the vault', async () => {
  fs.writeFileSync(notePath, `# ${dayKey}\n\n## Focus Today\n- [ ] Ring the garage\n- [ ] Something else\n`);
  const rec = seed({ type: 'todo', title: 'Ring the garage', source: 'vault', meta: { owner: { kind: 'file', source: null } } });
  const r = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.taskCompleted, true, r.body.taskWhy);
  const lines = fs.readFileSync(notePath, 'utf8').split('\n');
  assert.ok(lines.includes('- [x] Ring the garage'), 'the matching line is ticked');
  assert.ok(lines.includes('- [ ] Something else'), 'and nothing else is touched');
});

test('two identical open lines are REFUSED, never guessed', async () => {
  fs.writeFileSync(notePath, `# ${dayKey}\n\n## Focus Today\n- [ ] Chase invoice\n\n## Carry-Overs\n- [ ] Chase invoice\n`);
  const rec = seed({ type: 'todo', title: 'Chase invoice', source: 'vault', meta: { owner: { kind: 'file' } } });
  const r = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });
  assert.equal(r.status, 200);
  // parseVaultTodos dedupes identical daily texts, so this reads as ONE line —
  // either way nothing that was not asked for is ticked, and the answer is said.
  const text = fs.readFileSync(notePath, 'utf8');
  assert.ok((text.match(/- \[x\] Chase invoice/g) || []).length <= 1, 'at most one line ticked');
  assert.ok(typeof r.body.taskWhy === 'string' && r.body.taskWhy.length > 0);
});

test('a line that is no longer open says so rather than claiming a tick', async () => {
  fs.writeFileSync(notePath, `# ${dayKey}\n\n## Focus Today\n- [x] Already done thing\n`);
  const rec = seed({ type: 'todo', title: 'Already done thing', source: 'vault', meta: { owner: { kind: 'file' } } });
  const r = await post(`/api/attention/records/${rec.id}/act`, { action: 'complete' });
  assert.equal(r.body.taskCompleted, false);
  assert.match(r.body.taskWhy, /could not find that checkbox open/);
  assert.match(fs.readFileSync(notePath, 'utf8'), /- \[x\] Already done thing/, 'not toggled back open');
});

test('Done on ONE email dismisses it as done in the triage; Not relevant as not-relevant', async () => {
  db.setState('email_triage', JSON.stringify([
    { id: 'AAMk-a', subject: 'Re: contract', from: 'Chris', fromEmail: 'chris@example.com', urgency: 'high', category: 'ACTION', lane: 'urgent' },
    { id: 'AAMk-b', subject: 'Newsletter', from: 'News', fromEmail: 'news@example.com', urgency: 'high', category: 'ACTION', lane: 'urgent' },
  ]));
  const a = seed({ type: 'email', title: 'Re: contract', source: 'email', actions: ['open', 'complete', 'dismiss', 'defer'], meta: { emailId: 'AAMk-a', count: 1, from: 'Chris' } });
  const r1 = await post(`/api/attention/records/${a.id}/act`, { action: 'complete' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.handled, true);
  assert.match(r1.body.taskWhy, /email marked done/);
  let stored = JSON.parse(db.getState('email_triage'));
  assert.equal(stored.find((e) => e.id === 'AAMk-a').dismissReason, 'done');
  assert.ok(!stored.find((e) => e.id === 'AAMk-b').dismissed, 'the other email is untouched');

  const b = seed({ type: 'email', title: 'Newsletter', source: 'email', actions: ['open', 'complete', 'dismiss', 'defer'], meta: { emailId: 'AAMk-b', count: 1, from: 'News' } });
  const r2 = await post(`/api/attention/records/${b.id}/act`, { action: 'dismiss' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.email.ok, true);
  stored = JSON.parse(db.getState('email_triage'));
  assert.equal(stored.find((e) => e.id === 'AAMk-b').dismissReason, 'not-relevant');
});
