'use strict';

/**
 * `Security review/` holds notes with credentials awaiting rotation (22 Oct 2026).
 * NEURO must not read, index, quote, list or write them by ANY route — each test
 * here drives a real reader against a temp vault holding a fake secret, and
 * asserts the secret never comes back. Positive controls prove each reader
 * would have returned it from an ordinary folder.
 *
 * ⚠ NEVER point this at the live agent.db or the live vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-secrev-'));
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-secrev-vault-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.VAULT_API_KEY = 'test-vault-key';

const SECRET = 'Zq9TestSecretValue1234567890';
function put(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
put('Security review/API Keys.md', `# API Keys\n\nThe NOVA router for [[NOVA]] uses x-issue-router-secret: ${SECRET}\npassword: ${SECRET}\n- [ ] Rotate the router secret for Ada Lovelace\n`);
put('Documents/Reference/Ordinary.md', `# Ordinary\n\nNOVA router notes mention widgetword ${SECRET.slice(0, 6)}plain\n`);
const SECRET2 = 'Kx7OtherSecretInOrdinary9876';
put('Documents/Reference/Router setup.md', `# Router setup

Ada Lovelace configured it with token=${SECRET2} last week.
`);
put('People/Ada Lovelace.md', '---\ntype: person\n---\n# Ada Lovelace\n');

const db = require('../db/database');
let server; let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api/vault', require('../routes/vault'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const get = async (p) => {
  const res = await fetch(base + p, { headers: { 'x-api-key': process.env.VAULT_API_KEY } });
  return { status: res.status, text: await res.text() };
};

test('the exclusion list treats the folder as excluded, case-insensitively', () => {
  const ex = require('./vault-exclusions');
  for (const p of ['Security review/API Keys.md', 'security review/API Keys.md', 'Security review']) {
    assert.equal(ex.isSecurityPath(p), true, p);
  }
  assert.equal(ex.isExcludedPath('Security review/API Keys.md'), true);
  assert.equal(ex.isExcludedPath('Security review/API Keys.md', { forEmbeddings: true }), true);
  assert.equal(ex.isExcludedDir('Security review', { forEmbeddings: true }), true);
  assert.equal(ex.isExcludedPath('security review/API Keys.md'), true, 'a case-changed folder name is excluded too');
  assert.equal(ex.isExcludedPath('Documents/Reference/Ordinary.md'), false, 'positive control');
});

test('/api/vault refuses to read, write or list it — and still reads an ordinary note', async () => {
  const read = await get('/api/vault/read?path=' + encodeURIComponent('Security review/API Keys.md'));
  assert.notEqual(read.status, 200);
  assert.ok(!read.text.includes(SECRET));
  const lower = await get('/api/vault/read?path=' + encodeURIComponent('security review/API Keys.md'));
  assert.ok(!lower.text.includes(SECRET), 'a case-changed path is refused too');
  const list = await get('/api/vault/list?dir=' + encodeURIComponent('Security review'));
  assert.notEqual(list.status, 200);
  const root = await get('/api/vault/list?dir=');
  assert.equal(root.status, 200);
  assert.ok(!/Security review/i.test(root.text), 'the folder is not even listed');
  const ok = await get('/api/vault/read?path=' + encodeURIComponent('Documents/Reference/Ordinary.md'));
  assert.equal(ok.status, 200, 'positive control: an ordinary note still reads');
  const { _safePath } = require('../routes/vault');
  assert.equal(_safePath('Security review/New.md'), null, 'no write path into it either');
});

test('vault search never returns it', async () => {
  const s = await get('/api/vault/search?query=' + encodeURIComponent('router'));
  assert.ok(!s.text.includes(SECRET));
  assert.ok(!/Security review/i.test(s.text));
  const legacy = require('./obsidian').searchVault('router', 10);
  assert.ok(!JSON.stringify(legacy).includes(SECRET));
  assert.ok(JSON.stringify(legacy).includes('Ordinary'), 'positive control: the ordinary note is found');
});

test('the chat read_note tool refuses it — and still reads an ordinary note', async () => {
  const tools = require('./chat-tools');
  const r = await tools.execute('read_note', { path: 'Security review/API Keys.md' });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const ok = await tools.execute('read_note', { path: 'Documents/Reference/Ordinary.md' });
  assert.equal(ok.ok, true, 'positive control');
});

test('embeddings never index it (the vault inventory skips it)', () => {
  const emb = require('./embeddings');
  const files = (emb.listVaultFiles ? emb.listVaultFiles() : []).map((f) => (typeof f === 'string' ? f : f.relativePath || f.rel || f.path || '')).join('\n');
  assert.ok(!/Security review/i.test(files), 'not in the embedding inventory');
  assert.ok(/Ordinary/.test(files), 'positive control: the ordinary note is');
});

test('commitment extraction and task-context never read it', () => {
  assert.equal(require('./action-candidates').shouldSkipPath('Security review/API Keys.md'), true);
  assert.equal(require('./action-candidates').shouldSkipPath('Meetings/2026/10/x.md'), false, 'positive control');
  const model = require('./task-context-model');
  const ex = require('./vault-exclusions');
  const s = model.screenNote({ rel: 'Security review/API Keys.md', fm: {}, body: 'x' }, { isSecurityPath: ex.isSecurityPath, isExcludedPath: ex.isExcludedPath });
  assert.equal(s.ok, false);
  assert.equal(s.reason, 'security');
  assert.equal(model.isHardExcluded('Security review/API Keys.md', { isSecurityPath: ex.isSecurityPath, isExcludedPath: ex.isExcludedPath }), true);
});

test('vault-hygiene never scans it, refuses it as a root, and masks any secret it quotes', () => {
  const vh = require('./vault-hygiene');
  const plan = vh.contextualLinkPlan(VAULT, { write: false });
  const text = JSON.stringify(plan);
  assert.ok(!text.includes(SECRET), 'no plan quotes the secret');
  assert.ok(!/Security review/i.test(text), 'no link is proposed into the folder');
  assert.throws(() => vh.contextualLinkPlan(VAULT, { roots: ['Security review'], write: false }), /refuses/);
  // A credential quoted from an ORDINARY note is masked in the plan.
  assert.match(text, /Ada Lovelace/, 'positive control: the ordinary note produced a proposal');
  assert.ok(!text.includes(SECRET2), 'the quoted context has the token masked');
  assert.match(text, /token=\[redacted\]/);
  const masked = vh.maskSecrets(`router-secret: ${SECRET} and token=${SECRET} sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAA risk-Register`);
  assert.ok(!masked.includes(SECRET));
  assert.ok(!masked.includes('sk-proj-AAAA'));
  assert.ok(masked.includes('risk-Register'), 'ordinary hyphenated words are not masked');
});
