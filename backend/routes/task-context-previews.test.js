'use strict';

/**
 * Task-context previews (23 Oct 2026; restrictions removed 31 Oct 2026): the
 * task-bounded excerpt, and the hard exclusions — Security review/, Archive and
 * opted-out notes are never pinned, linked, searched or shown, even a legacy row.
 *
 * Real HTTP, real api-auth, real authority guard, real scan over a temp vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-previews-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
process.env.OBSIDIAN_VAULT_NAME = 'Test Vault';
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS', 'VAULT_SECURITY_DIRS']) delete process.env[k];

function write(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const db = require('../db/database');
const taskStore = require('../services/task-store');
const tc = require('../services/task-context');
const model = require('../services/task-context-model');

const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example Catch Up.md';
const MARKED = 'Meetings/2026/10/2026-10-16 – Sam Sample 1-2-1.md';
const SEC = 'Security review/Service account passwords.md';
const ARCH = 'Archive/Old plan/Escalation rota archive.md';
const OPTOUT = 'Projects/Rota/Rota private working.md';

const OFF_SICK = 'Heidi Example has been off sick since Monday and her return to work is pending.';

let T_HR; let T_MARK; let T_SEC; let T_ARCH; let T_OPT; let T_PLAIN;
let server; let base;

function snapshotVault() {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out[path.relative(VAULT, p)] = `${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}@${st.mtimeMs}`; } };
  walk(VAULT);
  return out;
}
const linkRows = () => db.all(`SELECT * FROM task_context_links ORDER BY id`);

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  write('People/Heidi Example.md', '---\ntype: person\n---\n# Heidi Example\n');
  write('People/Sam Sample.md', '---\ntype: person\n---\n# Sam Sample\n');
  T_HR = taskStore.createTask({ text: 'Prepare the escalation triage checklist handover pack', source: 'test', origin_path: HR });
  T_MARK = taskStore.createTask({ text: 'Book the quarterly rota planning session', source: 'test', origin_path: MARKED });
  T_SEC = taskStore.createTask({ text: 'Rotate the service account passwords', source: 'test', origin_path: SEC });
  T_ARCH = taskStore.createTask({ text: 'Retire the old escalation rota', source: 'test', origin_path: ARCH });
  T_OPT = taskStore.createTask({ text: 'Rework the rota private working notes', source: 'test', origin_path: OPTOUT });
  T_PLAIN = taskStore.createTask({ text: 'Water the office plants on Friday', source: 'test' });
  write(HR, `# Catch up\n\n${OFF_SICK}\nSam Sample raised a grievance about the rota.\n\n## Actions\n- The escalation triage checklist handover was discussed.\n`);
  write(MARKED, `# 1-2-1\n\nSam Sample is on a performance plan and has been absent twice this month.\nHeidi Example raised a conduct concern.\n\n## Actions\n- [ ] Nick to book the planning session <!--task:${T_MARK.id}-->\n`);
  write(SEC, '# Passwords\n\nadmin password: hunter2\nRotate the service account passwords monthly.\n');
  write(ARCH, '# Archived\n\nRetire the old escalation rota when the new one lands.\n');
  write(OPTOUT, '---\nneuro_context: exclude\n---\n# Rota private working\n\nRework the rota private working notes here.\n');
  for (let i = 1; i <= 12; i += 1) write(`Meetings/2026/09/Filler ${i} – Weekly.md`, `# Weekly ${i}\n\nSupport team queue weekly update number ${i}.\n`);
  const on = tc.activate({ by: 'nick', confirm: true });
  assert.equal(on.ok, true, `activation ran the backfill: ${JSON.stringify(on).slice(0, 200)}`);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/task-context', require('./task-context'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

function call(method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/task-context${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}'), raw: s }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const NICK = { 'X-NEURO-PIN': 'pin-1234' };
const LIMITED = {
  kiosk: { 'X-NEURO-KIOSK-TOKEN': 'kiosk-9012' },
  'api-token': { 'X-NEURO-API-TOKEN': 'tok-5678' },
  'mcp (PIN + declared machine)': { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' },
  'api-token claiming a pin too': { 'X-NEURO-API-TOKEN': 'tok-5678', 'X-NEURO-PIN': 'pin-1234' },
};

// ── the pure rules ───────────────────────────────────────────────────────────

test('model: an excerpt is ONE line of the note tied to the task — marker first, else its wording, else nothing', () => {
  const tok = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const body = '## Notes\nGeneral chat about the weather.\n## Actions\n- [ ] Nick to book it <!--task:7-->\n- Book the quarterly rota planning session soon\n';
  const m = model.taskExcerpt(body, { id: 7, text: 'Book the quarterly rota planning session' }, tok);
  assert.equal(m.basis, 'task-marker');
  assert.equal(m.text, 'Nick to book it', 'markup, checkbox and the marker comment stripped');
  assert.equal(m.heading, 'Actions');
  const w = model.taskExcerpt(body, { id: 8, text: 'Book the quarterly rota planning session' }, tok);
  assert.equal(w.basis, 'task-wording');
  assert.match(w.text, /quarterly rota planning/);
  assert.equal(model.taskExcerpt(body, { id: 9, text: 'Renew the car insurance' }, tok), null, 'nothing matches → null, never a guess');
  const long = `- ${'rota planning session '.repeat(40)}`;
  const c = model.taskExcerpt(long, { id: 1, text: 'rota planning session' }, tok);
  assert.ok(c.text.length <= model.EXCERPT_MAX, 'bounded');
});

test('model: the scan never takes Security review/ or an opted-out note', () => {
  const ex = require('../services/vault-exclusions');
  const deps = { isSecurityPath: ex.isSecurityPath, isExcludedPath: (r) => ex.isExcludedPath(r) };
  const s = model.screenNote({ rel: SEC, fm: {}, body: 'x y z' }, deps);
  assert.equal(s.reason, 'security'); assert.ok(!s.restricted);
  const o = model.screenNote({ rel: OPTOUT, fm: { neuro_context: 'exclude' }, body: 'x y z' }, deps);
  assert.equal(o.reason, 'opted-out'); assert.ok(!o.restricted);
});

// ── the scan: what was linked ───────────────────────────────────────────────

// ── Nick's screen ───────────────────────────────────────────────────────────

// ── everyone else ───────────────────────────────────────────────────────────

// ── hard exclusions, through every path ─────────────────────────────────────

test('Security review/, Archive and an opted-out note: refused by manual link (Nick and MCP alike)', async () => {
  for (const rel of [SEC, ARCH, OPTOUT]) {
    for (const h of [NICK, LIMITED['mcp (PIN + declared machine)']]) {
      const r = await call('POST', `/tasks/${T_PLAIN.id}/links`, { type: 'note', ref: rel }, h);
      assert.equal(r.status, 400, `${rel}: ${r.raw}`);
    }
    assert.equal(tc.link({ taskId: T_PLAIN.id, type: 'note', ref: rel }).status, 400);
  }
  assert.ok(!linkRows().some((r) => [SEC, ARCH, OPTOUT].includes(r.source_ref)));
});

test('Security review/ and Archive never appear in search, for anyone', async () => {
  for (const q of ['passwords', 'escalation rota archive', 'service account']) {
    for (const h of [NICK, LIMITED.kiosk, LIMITED['api-token']]) {
      const r = await call('GET', `/search?q=${encodeURIComponent(q)}`, undefined, h);
      if (r.status !== 200) continue; // the kiosk may be refused search outright; either way it sees nothing
      const refs = (r.json.notes || []).map((n) => n.ref);
      assert.ok(!refs.includes(SEC) && !refs.includes(ARCH), `${q}: ${refs.join(', ')}`);
      assert.ok(!r.raw.includes('hunter2'));
    }
  }
});

test('a legacy row pointing at Security review/ or Archive is title-only even for Nick — never read, never opened', async () => {
  const now = new Date().toISOString();
  for (const [rel, title] of [[SEC, 'Service account passwords'], [ARCH, 'Escalation rota archive']]) {
    db.run(`INSERT INTO task_context_links (task_id, source_type, source_ref, title, preview, restricted, origin, state, reasons_json, created_at, updated_at)
            VALUES (?, 'note', ?, ?, NULL, 1, 'nightly-scan', 'pinned', ?, ?, ?)`,
    [T_SEC.id, rel, title, JSON.stringify([{ code: 'origin', say: 'This task was raised in this note.' }]), now, now]);
  }
  const r = await call('GET', `/tasks/${T_SEC.id}`, undefined, NICK);
  assert.equal(r.status, 200);
  assert.equal(r.json.pinned.length, 2);
  for (const it of r.json.pinned) {
    assert.equal(it.hardExcluded, true);
    assert.equal(it.ref, null); assert.equal(it.open, null); assert.equal(it.excerpt, null);
  }
  for (const bad of ['hunter2', SEC, ARCH, 'Old plan', 'obsidian://']) assert.ok(!r.raw.includes(bad), `${bad} in ${r.raw}`);
  db.run(`DELETE FROM task_context_links WHERE task_id = ?`, [T_SEC.id]);
});
