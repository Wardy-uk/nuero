'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-capture-hub-'));
process.env.NEURO_DB_PATH = path.join(ROOT, 'scratch.db');
const VAULT = path.join(ROOT, 'vault');
fs.mkdirSync(path.join(VAULT, 'People'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'People', 'Sam Smith.md'), '---\ntype: person\n---\n# Sam Smith\n');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');
const hub = require('./capture-hub');

test.before(async () => { await db.init(); });

test('a prefix is sure and is stripped; a phrase is likely; nothing matching is none', () => {
  const p = hub.classifyByRules('chris: the TOM timeline');
  assert.deepEqual([p.kind, p.confidence, p.text], ['chris', 'sure', 'the TOM timeline']);
  assert.equal(hub.classifyByRules('Ask Chris about the TOM timeline').kind, 'chris');
  assert.equal(hub.classifyByRules('nova: escalation chart').prefill.system, 'NOVA');
  assert.equal(hub.classifyByRules('a thought about Tuesday').confidence, 'none');
});

test('the rules lift what they can out of the words', () => {
  const f = hub.classifyByRules('filled up 42 litres at 31,250');
  assert.equal(f.kind, 'fuel');
  assert.deepEqual(f.prefill, { litres: 42, odometer: 31250 });
  const w = hub.classifyByRules('Sam owes me the rota');
  assert.equal(w.kind, 'waiting');
  assert.equal(w.prefill.person, 'Sam');
  assert.equal(hub.classifyByRules('we need milk').text, 'milk');
});

test('the model is never asked when ai is off, and an unsure guess falls to Note', async () => {
  const r = await hub.classify('a thought about Tuesday', { ai: false });
  assert.deepEqual([r.kind, r.by], ['note', 'default']);
});

test('every kind the client can pick is in the registry once, with a door', () => {
  const ids = hub.kinds().map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of hub.kinds()) assert.ok(k.door && k.label && k.group, k.id);
  assert.ok(ids.includes('done'), 'quick "done" chip');
});

test('memory and decision doors write into the vault; empty text is refused', () => {
  const m = hub.file('memory', 'I prefer tea to coffee');
  assert.equal(m.ok, true);
  const file = path.join(VAULT, m.saved);
  assert.match(fs.readFileSync(file, 'utf8'), /tea to coffee/);
  assert.equal(hub.file('decision', 'We keep the 10:00 standup').ok, true);
  assert.equal(hub.file('memory', '   ').ok, false);
  assert.equal(hub.file('task', 'x').ok, false, 'a kind with its own door is not filed here');
});

test('waiting needs a person', () => {
  assert.equal(hub.file('waiting', 'the rota', {}).ok, false);
});

test('options names people from the vault, and a list it could not read is null', () => {
  const o = hub.options();
  assert.deepEqual(o.people, ['Sam Smith']);
  assert.ok(o.dateEntities.some((e) => e.value === 'People/Sam Smith'));
});

test('real HTTP: kinds, classify and file answer through the router', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/capture-hub', require('../routes/capture-hub'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/capture-hub`;
  try {
    const kinds = await (await fetch(`${base}/kinds`)).json();
    assert.ok(kinds.kinds.length > 10);
    const c = await (await fetch(`${base}/classify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'done: sent the rota', ai: false }) })).json();
    assert.equal(c.kind, 'done');
    const bad = await fetch(`${base}/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'memory', text: '' }) });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});
