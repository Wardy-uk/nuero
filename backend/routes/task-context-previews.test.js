'use strict';

/**
 * Task-context previews for Nick, title-only for everyone else (23 Oct 2026).
 *
 * The live problem: every automatically linked meeting note read "Restricted —
 * preview withheld" on Nick's own screens. The fix separates the link's
 * CLASSIFICATION (restricted or not — the scan's, stored, unchanged) from the
 * VIEWER (decided per request from the authenticated surface):
 *   - Nick's PIN session ('owner'): a task-bounded excerpt read from the note,
 *     the exact provenance, the restriction reason in words, the open route.
 *   - the kiosk token, the API token, a declared machine (the local MCP sends
 *     X-Neuro-Machine-Client): restricted notes are title-only — no path, no
 *     preview, no excerpt, no open route.
 *   - Security review/, Archive and other hard exclusions: never pinned, never
 *     linked, never searched, never shown — even a legacy row pointing at one.
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

test('model: restriction reasons in words; hard exclusions are hard; Personal/ is restricted, not hard', () => {
  const ex = require('../services/vault-exclusions');
  const deps = { isSecurityPath: ex.isSecurityPath, isSensitivePath: ex.isSensitivePath, isExcludedPath: (r) => ex.isExcludedPath(r),
    employmentScreen: () => ({ sensitive: true, categories: ['employee-cases-note'] }) };
  assert.equal(model.isHardExcluded(SEC, deps), true);
  assert.equal(model.isHardExcluded(ARCH, deps), true);
  assert.equal(model.isHardExcluded('Personal/Prep.md', deps), false);
  assert.equal(model.isHardExcluded(HR, deps), false);
  const r = model.restrictionOf({ rel: HR, fm: {}, body: 'x' }, deps);
  assert.equal(r.hard, false); assert.deepEqual(r.codes, ['employee-cases-note']);
  assert.match(r.say, /personnel-sensitive/);
  assert.equal(model.restrictionOf({ rel: SEC }, deps).hard, true);
  assert.equal(model.restrictionOf({ rel: 'Projects/X.md', fm: { neuro_context: 'exclude' } }, deps).hard, true);
  const broken = { ...deps, employmentScreen: () => { throw new Error('no roster'); } };
  assert.deepEqual(model.restrictionOf({ rel: HR, body: 'x' }, broken).codes, ['employee-cases-note'], 'a screen that cannot run is never LESS restricted');
  assert.equal(model.provenanceLine({ origin: 'nightly-scan', reasons: [{ code: 'origin', say: 'This task was raised in this note.' }] }), 'Found automatically — this task was raised in this note.');
});

test('model: the scan never takes Security review/ or an opted-out note, not even as restricted', () => {
  const ex = require('../services/vault-exclusions');
  const deps = { isSecurityPath: ex.isSecurityPath, isSensitivePath: ex.isSensitivePath, isExcludedPath: (r) => ex.isExcludedPath(r) };
  const s = model.screenNote({ rel: SEC, fm: {}, body: 'x y z' }, deps);
  assert.equal(s.reason, 'security'); assert.ok(!s.restricted);
  const o = model.screenNote({ rel: OPTOUT, fm: { neuro_context: 'exclude' }, body: 'x y z' }, deps);
  assert.equal(o.reason, 'opted-out'); assert.ok(!o.restricted);
});

// ── the scan: what was linked ───────────────────────────────────────────────

test('scan: the two personnel-sensitive meeting notes are pinned to their own tasks, restricted; hard exclusions are not', () => {
  const rows = linkRows();
  const hr = rows.find((r) => r.task_id === T_HR.id && r.source_ref === HR);
  const mk = rows.find((r) => r.task_id === T_MARK.id && r.source_ref === MARKED);
  assert.ok(hr && mk, 'both origin notes pinned');
  for (const r of [hr, mk]) { assert.equal(r.restricted, 1); assert.equal(r.preview, null, 'no preview stored'); assert.equal(r.state, 'pinned'); }
  for (const bad of [SEC, ARCH, OPTOUT]) assert.ok(!rows.some((r) => r.source_ref === bad), `${bad} never linked`);
  // (the opted-out note's project folder may be linked as a PROJECT — the note itself never is)
  const other = rows.filter((r) => r.source_type === 'note' && [T_SEC.id, T_ARCH.id, T_OPT.id].includes(r.task_id));
  assert.equal(other.length, 0, JSON.stringify(other.map((r) => [r.task_id, r.source_ref, r.state, r.reasons_json])));
});

// ── Nick's screen ───────────────────────────────────────────────────────────

test('owner (Nick, PIN): excerpt, provenance, plain restriction reason and the open route — no write', async () => {
  const before = { rows: JSON.stringify(linkRows()), vault: JSON.stringify(snapshotVault()) };
  const a = await call('GET', `/tasks/${T_HR.id}`, undefined, NICK);
  assert.equal(a.status, 200);
  assert.equal(a.json.viewer, 'owner');
  const it = a.json.pinned.find((p) => p.title.includes('Heidi Example Catch Up'));
  assert.ok(it);
  assert.equal(it.restricted, true);
  assert.equal(it.provenance, 'Found automatically — this task was raised in this note.');
  assert.match(it.restrictedSay, /^Contains personnel-sensitive material/);
  assert.deepEqual(it.restrictedCodes, ['employee-cases-note']);
  assert.equal(it.excerpt.basis, 'task-wording');
  assert.equal(it.excerpt.text, 'The escalation triage checklist handover was discussed.');
  assert.equal(it.excerpt.heading, 'Actions');
  assert.ok(!a.raw.includes(OFF_SICK), 'the excerpt is bounded to the task — the sick-leave line is never sent');
  assert.equal(it.preview, null, 'no general preview of a restricted note');
  assert.equal(it.ref, HR);
  assert.deepEqual(it.open, { kind: 'note', path: HR, obsidianUrl: `obsidian://open?vault=Test%20Vault&file=${encodeURIComponent(HR.replace(/\.md$/, ''))}` });

  const b = await call('GET', `/tasks/${T_MARK.id}`, undefined, NICK);
  const m = b.json.pinned.find((p) => p.ref === MARKED);
  assert.equal(m.excerpt.basis, 'task-marker');
  assert.equal(m.excerpt.text, 'Nick to book the planning session');
  assert.ok(!b.raw.includes('performance plan'), 'only the task line, never the rest');

  assert.equal(JSON.stringify(linkRows()), before.rows, 'reading changes no link');
  assert.equal(JSON.stringify(snapshotVault()), before.vault, 'reading writes nothing to the vault');
});

// ── everyone else ───────────────────────────────────────────────────────────

for (const [who, headers] of Object.entries(LIMITED)) {
  test(`limited (${who}): the same restricted link is title-only — no path, preview, excerpt or open route`, async () => {
    for (const [taskId, rel] of [[T_HR.id, HR], [T_MARK.id, MARKED]]) {
      const r = await call('GET', `/tasks/${taskId}`, undefined, headers);
      assert.equal(r.status, 200, `${who} may read: ${r.raw.slice(0, 200)}`);
      assert.equal(r.json.viewer, 'limited');
      const it = r.json.pinned.find((p) => p.restricted);
      assert.ok(it, 'the link is still there, by title');
      assert.ok(it.title.length > 0);
      assert.equal(it.ref, null); assert.equal(it.open, null); assert.equal(it.preview, null);
      assert.equal(it.excerpt, undefined); assert.equal(it.restrictedCodes, undefined);
      assert.equal(it.restrictedSay, 'Restricted — shown as a title only on this screen.');
      assert.ok(!r.raw.includes(rel), 'the path appears nowhere in the response');
      assert.ok(!r.raw.includes('obsidian://'), 'no open route');
      assert.ok(!/handover was discussed|book the planning session|off sick|performance plan/.test(r.raw), 'no note content at all');
    }
  });
}

test('limited: an ordinary (unrestricted) note still opens and previews — only restricted notes are trimmed', async () => {
  const id = tc.link({ taskId: T_PLAIN.id, type: 'note', ref: 'Meetings/2026/09/Filler 1 – Weekly.md' });
  assert.equal(id.ok, true);
  const r = await call('GET', `/tasks/${T_PLAIN.id}`, undefined, LIMITED.kiosk);
  const it = r.json.pinned[0];
  assert.equal(it.restricted, false);
  assert.equal(it.ref, 'Meetings/2026/09/Filler 1 – Weekly.md');
  assert.ok(it.preview);
  tc.remove({ taskId: T_PLAIN.id, linkId: it.id });
});

test('the viewer is decided by the credential, never by anything the client says about its surface', () => {
  assert.equal(tc.viewerOf({ headers: {} }), 'owner');
  assert.equal(tc.viewerOf({ headers: {}, apiClient: 'n8n' }), 'limited');
  assert.equal(tc.viewerOf({ headers: {}, attendedSurface: 'kiosk' }), 'limited');
  assert.equal(tc.viewerOf({ headers: { 'x-neuro-machine-client': 'mcp-local' } }), 'limited');
  assert.equal(tc.viewerOf(null), 'limited');
  assert.equal(tc.forTask(T_HR.id).viewer, 'limited', 'an in-process caller gets the limited view by default');
  assert.equal(tc.pinnedFor([T_HR.id]).get(T_HR.id)[0].ref, null, 'pinnedFor defaults to limited too');
});

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

test('the meeting-prep route passes the viewer through to every prep it builds', () => {
  const src = fs.readFileSync(path.join(__dirname, 'meeting-prep-view.js'), 'utf8');
  const calls = src.match(/_buildPrep\([^)]*\)/g).filter((c) => !c.startsWith('_buildPrep(meeting'));
  assert.ok(calls.length >= 5, 'positive control: the call sites were found');
  for (const c of calls) assert.match(c, /viewer: _viewer\(req\)/, c);
  assert.match(src, /pinnedFor\(ids, \{ limit: 3, viewer \}\)/);
});
