'use strict';

/**
 * Vault cleanup pass 2 (22 Oct 2026).
 *
 * 1. Dated Vault Audit reports do not come back: every vault-hygiene capability
 *    and the PLAUD reconciliation store their report in NEURO's database
 *    (`vault_audit_reports`) and write NOTHING into Documents/System/Vault Audit.
 * 2. An archived task-block outcome note is the block's history and is never
 *    written to, recreated or substituted — the shape of the 85 real block rows
 *    the cleanup repointed (closed blocks, note_path under Archive/).
 * 3. The database migration repoints task_blocks and drops derived index rows,
 *    and refuses to touch a block that is still open.
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
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pass2-'));
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pass2-vault-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

function put(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
put('People/Ada Lovelace.md', '---\ntype: person\n---\n# Ada Lovelace\n');
put('People/Alan Turing.md', '---\ntype: person\n---\n# Alan Turing\n');
put('Meetings/2026/10/2026-10-20 – Planning.md', '# Planning\n\nAda Lovelace and Alan Turing agreed the plan. See [[Missing Note]].\n');
put('Ideas/Lonely.md', '# Lonely\n\nNothing links here and it links nowhere.\n');
put('Meetings/2026/10/2026-10-21 – Review.md', '# Review\n\nAda Lovelase raised it again.\n');

const db = require('../db/database');
let server; let base;
test.before(async () => {
  await db.init();
  const app = express();
  app.use('/api/vault-hygiene', require('../routes/vault-hygiene'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const VA = path.join(VAULT, 'Documents', 'System', 'Vault Audit');
const vaFiles = () => (fs.existsSync(VA) ? fs.readdirSync(VA) : []);

test('every vault-hygiene capability stores its report in NEURO and writes no Vault Audit note', () => {
  const vh = require('./vault-hygiene');
  const results = [
    vh.lint(VAULT),
    vh.contextualLinkPlan(VAULT, { roots: ['Meetings'] }),
    vh.contextualLinkApply(VAULT, { roots: ['Meetings'] }),
    vh.aliasSuggest(VAULT),
    vh.fixPlan(VAULT),
    vh.connectOrphans(VAULT, { dryRun: false }),
    vh.renamePlaudSummaryNotes(VAULT, { apply: false }),
  ];
  assert.deepEqual(vaFiles(), [], 'Documents/System/Vault Audit stays empty — not even created');
  const refs = results.map((r) => (typeof r === 'string' ? r : (r && (r.reportPath || r.changelogPath)))).filter(Boolean);
  assert.ok(refs.length >= 5, `reports were stored: ${refs.join(', ')}`);
  for (const ref of refs) assert.match(ref, /^neuro:vault-audit\/\d+$/);
  const kinds = new Set(require('./audit-reports').list({ limit: 200 }).map((r) => r.kind));
  for (const k of ['lint', 'contextual-linking-plan', 'alias-suggestions', 'fix-plan', 'plaud-summary-rename']) assert.ok(kinds.has(k), `kind ${k} stored`);
});

test('the nightly sweep stores a report only when something changed — never a vault page', () => {
  const vh = require('./vault-hygiene');
  const ar = require('./audit-reports');
  const before = ar.list({ kind: 'hygiene-sweep' }).length;
  const r1 = vh.nightlySweep(VAULT, { apply: true });
  const r2 = vh.nightlySweep(VAULT, { apply: true });
  assert.equal(r1.written, false); assert.equal(r2.written, false);
  assert.equal(ar.list({ kind: 'hygiene-sweep' }).length, before, 'a no-change night stores nothing');
  assert.deepEqual(vaFiles(), []);
});

test('the same report on the same day replaces the earlier row (Brain Health scans on every open)', () => {
  const vh = require('./vault-hygiene');
  const ar = require('./audit-reports');
  const n = ar.list({ kind: 'lint' }).length;
  vh.lint(VAULT); vh.lint(VAULT); vh.lint(VAULT);
  assert.equal(ar.list({ kind: 'lint' }).length, n);
});

test('PLAUD reconciliation stores its report in NEURO (source pinned: the network half needs PLAUD)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'plaud-sync.js'), 'utf-8');
  assert.match(src, /require\('\.\/audit-reports'\)\.record\(\{\s*kind: 'plaud-missing-reconciliation'/);
  assert.ok(!/PLAUD Missing Reconciliation \$\{[^}]*\}\.md/.test(src), 'no dated vault file name left');
});

test('source: vault-hygiene writes nothing into the Vault Audit folder any more', () => {
  const src = fs.readFileSync(path.join(__dirname, 'vault-hygiene.js'), 'latin1');
  // The only remaining use of the folder is the retention mover (rename, never write).
  const writes = src.split('\n').filter((l) => /writeFileSync\(/.test(l) && /REPORT_REL|outPath|changelogPath/.test(l));
  assert.deepEqual(writes, []);
  assert.ok(/storeReport\('lint'/.test(src), 'positive control: the scan is reading the right file');
});

test('the reports are readable over HTTP, newest first, and a bad id is refused', async () => {
  const list = await (await fetch(`${base}/api/vault-hygiene/reports`)).json();
  assert.equal(list.ok, true);
  assert.ok(list.reports.length > 0);
  assert.ok(!('markdown' in list.reports[0]), 'the list carries no bodies');
  const one = await (await fetch(`${base}/api/vault-hygiene/reports/${list.reports[0].id}`)).json();
  assert.equal(one.ok, true);
  assert.match(one.report.markdown, /\S/);
  assert.equal((await fetch(`${base}/api/vault-hygiene/reports/abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/vault-hygiene/reports/999999`)).status, 404);
});

// ── archived outcome notes ──────────────────────────────────────────────────

function archivedBlock(status) {
  const taskStore = require('./task-store');
  const { id } = taskStore.createTask({ text: `Pass two fixture ${status} ${Math.random().toString(36).slice(2, 8)}`, source: 'manual', skipExport: true });
  const t = db.listTaskRows({ status: 'all' }).find((r) => r.id === id) || { id, text: 'x' };
  const notePath = `Archive/Task outcome stubs (vault cleanup 2026-10-22, pass 2)/Tasks/Outcomes/2026/09/2026-09-01 Focus block ${status}.md`;
  const slot = status === 'released' ? ['10:00', '10:30'] : ['11:00', '11:30'];
  const blockId = db.createTaskBlockRow({ date_key: '2026-09-01', start_time: slot[0], end_time: slot[1], minutes: 30, note_path: notePath, status });
  db.addTaskBlockItem(blockId, id, null);
  const other = taskStore.createTask({ text: `Pass two second ${status} ${Math.random().toString(36).slice(2, 8)}`, source: 'manual', skipExport: true });
  db.addTaskBlockItem(blockId, other.id, null);
  const full = path.join(VAULT, ...notePath.split('/'));
  const stub = require('./task-blocks').renderStub([{ id, text: t.text }, { id: other.id, text: 'second' }], db.getTaskBlockRow(blockId));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, stub);
  return { blockId, notePath, full, stub, taskId: id };
}

test('an archived outcome note is never written to, recreated, or substituted by a search', () => {
  const tb = require('./task-blocks');
  for (const status of ['released', 'dropped']) {
    const b = archivedBlock(status);
    // A real stub of another block sits in Tasks/Outcomes carrying the same task id:
    // the old fallback search would have adopted it.
    put(`Tasks/Outcomes/2026/09/2026-09-01 Other ${status}.md`, `---\ntype: task-outcome\ntask_ids: [${b.taskId}]\ndate: 2026-09-01\n---\n# Other\n`);
    fs.unlinkSync(b.full);
    const note = tb.readOutcomeNote(db.getTaskBlockRow(b.blockId));
    assert.equal(note.raw, null, 'no other note is adopted in its place');
    assert.equal(note.archived, true);
    const created = tb.createNote(b.blockId);
    assert.equal(created.ok, false);
    assert.equal(created.reason, 'archived');
    assert.equal(fs.existsSync(b.full), false, 'nothing recreated in Archive/');
    // Restore the archived file and tick a task: the checklist sync must not rewrite it.
    fs.writeFileSync(b.full, b.stub);
    tb.writeChecklistToNote(b.blockId);
    assert.equal(fs.readFileSync(b.full, 'utf8'), b.stub, 'the archived file is unchanged');
  }
  // Positive control: an ordinary stub is still found and readable.
  assert.equal(tb.isArchivedNote('Tasks/Outcomes/2026/09/x.md'), false);
});

test('the migration repoints closed blocks, drops derived rows, and refuses an open block', () => {
  const plan = { ops: [
    { group: 'stubs', op: 'archive', path: 'Tasks/Outcomes/2026/08/a.md', to: 'Archive/T/Tasks/Outcomes/2026/08/a.md', blocks: [1] },
    { group: 'prompts', op: 'archive', path: 'Projects/NOVA/Claude Code - x.md', to: 'Archive/Projects/NOVA/Claude Code - x.md' },
  ] };
  const Database = require('better-sqlite3');
  const file = path.join(tmp, 'migrate.db');
  const m = new Database(file);
  m.exec(`CREATE TABLE task_blocks (id INTEGER PRIMARY KEY, note_path TEXT NOT NULL, status TEXT NOT NULL);
          CREATE TABLE vault_embeddings (id INTEGER PRIMARY KEY, relative_path TEXT);
          CREATE TABLE extracted_entities (id INTEGER PRIMARY KEY, source_path TEXT);
          CREATE TABLE note_links (id INTEGER PRIMARY KEY, source_path TEXT, target_path TEXT);
          CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT);
          INSERT INTO task_blocks VALUES (1, 'Tasks/Outcomes/2026/08/a.md', 'released');
          INSERT INTO vault_embeddings (relative_path) VALUES ('Projects/NOVA/Claude Code - x.md'), ('Meetings/keep.md');
          INSERT INTO extracted_entities (source_path) VALUES ('Projects/NOVA/Claude Code - x.md');
          INSERT INTO note_links (source_path, target_path) VALUES ('Projects/NOVA/Claude Code - x.md', 'People/A.md'), ('Meetings/keep.md', 'Projects/NOVA/Claude Code - x.md');
          INSERT INTO agent_state VALUES ('note_action_review:abc:Projects/NOVA/Claude Code - x.md', '{}'), ('note_action_review:def:Meetings/keep.md', '{}');`);
  m.close();
  const planFile = path.join(tmp, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const script = path.join(__dirname, '..', 'scripts', 'vault-cleanup-pass2-db.js');
  const out = JSON.parse(execFileSync(process.execPath, [script, planFile, file, '--apply'], { encoding: 'utf8', env: process.env }));
  assert.equal(out.committed, true);
  const c = new Database(file, { readonly: true });
  assert.equal(c.prepare('SELECT note_path FROM task_blocks WHERE id = 1').get().note_path, 'Archive/T/Tasks/Outcomes/2026/08/a.md');
  assert.deepEqual(c.prepare('SELECT relative_path FROM vault_embeddings').all().map((r) => r.relative_path), ['Meetings/keep.md']);
  assert.equal(c.prepare('SELECT count(*) n FROM extracted_entities').get().n, 0);
  assert.deepEqual(c.prepare('SELECT source_path, target_path FROM note_links').all(), [{ source_path: 'Meetings/keep.md', target_path: 'Archive/Projects/NOVA/Claude Code - x.md' }]);
  assert.deepEqual(c.prepare('SELECT key FROM agent_state').all().map((r) => r.key), ['note_action_review:def:Meetings/keep.md']);
  c.close();
  // An OPEN block is refused and the whole run rolls back.
  const m2 = new Database(file);
  m2.exec("INSERT INTO task_blocks VALUES (2, 'Tasks/Outcomes/2026/10/open.md', 'scheduled')");
  m2.close();
  const plan2 = { ops: [{ group: 'stubs', op: 'archive', path: 'Tasks/Outcomes/2026/10/open.md', to: 'Archive/T/open.md', blocks: [2] }] };
  fs.writeFileSync(planFile, JSON.stringify(plan2));
  let failed = null;
  try { execFileSync(process.execPath, [script, planFile, file, '--apply'], { encoding: 'utf8', env: process.env }); } catch (e) { failed = JSON.parse(e.stdout); }
  assert.ok(failed && failed.committed === false && failed.problems.length > 0, 'an open block stops the run');
  const c2 = new Database(file, { readonly: true });
  assert.equal(c2.prepare('SELECT note_path FROM task_blocks WHERE id = 2').get().note_path, 'Tasks/Outcomes/2026/10/open.md');
  c2.close();
});
