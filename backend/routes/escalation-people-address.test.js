'use strict';

// Filing an address Nick has just emailed into a People note (28 Oct 2026).
// Real router, real temp vault; set env BEFORE any require (entities fixes its
// vault path on first load).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-addr-'));
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_DB_PATH = path.join(VAULT, 'test.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

fs.mkdirSync(path.join(VAULT, 'People'));
fs.writeFileSync(path.join(VAULT, 'People', 'Liam Sims.md'), '---\nrole: Lead\n---\n\n# Liam Sims\n');
fs.writeFileSync(path.join(VAULT, 'People', 'Chris Middleton.md'), '---\nemail: chris@nurtur.tech\n---\n\n# Chris Middleton\n');

let base, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-machine']) req.apiClient = { name: 'm' }; next(); });
  app.use('/api/escalation', require('./escalation'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/escalation`;
});
test.after(() => { server?.close(); fs.rmSync(VAULT, { recursive: true, force: true }); });

const post = async (body, headers = {}) => {
  const r = await fetch(`${base}/people/address`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('an existing note with no address gets it; one that has an address is never overwritten', async () => {
  const ok = await post({ email: 'Liam@Nurtur.tech', person: 'Liam Sims', create: false, ticket: 'NT-1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const note = fs.readFileSync(path.join(VAULT, 'People', 'Liam Sims.md'), 'utf8');
  assert.match(note, /^email: liam@nurtur\.tech$/m);
  assert.match(note, /email-source: "typed by Nick when escalating NT-1/);
  const no = await post({ email: 'other@x.com', person: 'Chris Middleton', create: false });
  assert.equal(no.status, 409);
  assert.match(fs.readFileSync(path.join(VAULT, 'People', 'Chris Middleton.md'), 'utf8'), /email: chris@nurtur\.tech/);
});

test('a new note is created with the address; an address already filed, a bad one and a machine are refused', async () => {
  const made = await post({ email: 'jo@x.com', person: 'Jo Bloggs', create: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match(fs.readFileSync(path.join(VAULT, 'People', 'Jo Bloggs.md'), 'utf8'), /email: jo@x\.com/);
  assert.equal((await post({ email: 'jo@x.com', person: 'Jo Again', create: true })).status, 409);
  assert.equal((await post({ email: 'nope', person: 'X Y', create: true })).status, 400);
  assert.equal((await post({ email: 'a@b.co', person: '../evil', create: true })).status, 400);
  assert.equal((await post({ email: 'nickw@nurtur.tech', person: 'Nick Ward', create: true })).status, 400);
  assert.equal((await post({ email: 'z@b.co', person: 'Z Z', create: true }, { 'x-machine': '1' })).status, 403);
  assert.equal(fs.existsSync(path.join(VAULT, 'People', 'Z Z.md')), false);
});
