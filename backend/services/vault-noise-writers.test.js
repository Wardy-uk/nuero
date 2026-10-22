'use strict';

/**
 * The writers the 22 Oct 2026 vault cleanup removed noise from must not refill it.
 *
 * Approved manifest, phase 1:
 * - an import report with nothing to report writes NO file;
 * - nothing writes `## SAiM Actions` into a Daily note any more, but the same
 *   activity stays visible in NEURO (Activity → SAiM log);
 * - the nightly hygiene sweep keeps ONE rolling `Hygiene Sweep.md`, written only
 *   when something changed;
 * - generated reports stop linking `[[Logs]]`.
 *
 * Every test here runs the REAL writer against a temp vault and a scratch DB.
 * ⚠ NEVER point this at the live agent.db or the live vault.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-noise-'));
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-noise-vault-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');

test.before(async () => { await db.init(); });

/** Every file under the vault, relative, so "nothing was written" is checkable. */
function listVault(dir = VAULT, base = VAULT) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listVault(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function localKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('an import report with nothing to report writes NO file, and says so', () => {
  const km = require('./knowledge-memory');
  const before = listVault();
  const r = km.writeDailyImportReport('2026-01-05');
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'nothing-to-report');
  assert.equal(r.path, null);
  assert.deepEqual(listVault(), before, 'a no-op day must create no vault file or folder');
});

test('import routes alone do not earn a vault page (they stay in activity_log)', () => {
  const km = require('./knowledge-memory');
  db.logActivity('imports_sweep', { routed: 4, flagged: 0 }, '2026-01-06');
  const r = km.writeDailyImportReport('2026-01-06');
  assert.equal(r.status, 'skipped');
  assert.equal(r.counts.routed, 4, 'the routes are still counted — from the DB');
  assert.equal(fs.existsSync(path.join(VAULT, 'Documents', 'System', 'SAiM Import Reports', '2026-01-06.md')), false);
  // …and NEURO can still rebuild the report from activity_log on demand.
  assert.match(r.markdown, /Import routes: 4/);
});

test('a day with real activity still writes its report — without the [[Logs]] footer', () => {
  const km = require('./knowledge-memory');
  db.logActivity('import_ai_enriched', { targetPath: 'Meetings/x.md', provider: 'test' }, '2026-01-07');
  const r = km.writeDailyImportReport('2026-01-07');
  assert.equal(r.status, 'ok', 'positive control: meaningful days are kept');
  const text = fs.readFileSync(path.join(VAULT, r.path), 'utf-8');
  assert.match(text, /AI enrichments: 1/);
  assert.ok(!text.includes('[[Logs]]'), 'generated reports no longer link back to Documents/Vault/Logs.md');
});

test('reports that existed at the cleanup are kept 30 days FROM it: nothing moves before 21 Nov 2026', () => {
  const km = require('./knowledge-memory');
  const dir = path.join(VAULT, 'Documents', 'System', 'SAiM Import Reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-09-16.md'), 'a real report\n');
  assert.deepEqual(km.archiveOldImportReports({ now: new Date('2026-10-22T13:00:00') }), []);
  assert.deepEqual(km.archiveOldImportReports({ now: new Date('2026-11-20T23:00:00') }), []);
  assert.ok(fs.existsSync(path.join(dir, '2026-09-16.md')));
});

test('after that, reports older than 30 days are MOVED to Archive, never deleted; newer ones stay', () => {
  const km = require('./knowledge-memory');
  const dir = path.join(VAULT, 'Documents', 'System', 'SAiM Import Reports');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date('2026-12-20T12:00:00');
  const old = localKey(new Date(now.getTime() - 40 * 86400000));
  const recent = localKey(new Date(now.getTime() - 10 * 86400000));
  fs.writeFileSync(path.join(dir, `${old}.md`), 'old\n');
  fs.writeFileSync(path.join(dir, `${recent}.md`), 'recent\n');
  fs.writeFileSync(path.join(dir, 'Plaud Cleanup - 2025-01-01.md'), 'not a dated daily report\n');
  const moved = km.archiveOldImportReports({ now });
  assert.ok(moved.includes(`Archive/SAiM Import Reports/${old}.md`), moved.join(', '));
  assert.ok(!moved.includes(`Archive/SAiM Import Reports/${recent}.md`));
  assert.equal(fs.readFileSync(path.join(VAULT, 'Archive', 'SAiM Import Reports', `${old}.md`), 'utf-8'), 'old\n');
  assert.ok(fs.existsSync(path.join(dir, `${recent}.md`)));
  assert.ok(fs.existsSync(path.join(dir, 'Plaud Cleanup - 2025-01-01.md')), 'only YYYY-MM-DD daily reports are aged');
});

test('Vault Audit retention: the approved rules, and audit trails are never touched', () => {
  const vh = require('./vault-hygiene');
  const names = [
    'Hygiene Sweep 2026-10-07.md', 'Hygiene Sweep 2026-10-08.md', 'Hygiene Sweep.md',
    'Lint Report 2026-09-14.md', 'Lint Report 2026-09-22.md',
    'Fix Plan 2026-08-01.md',                       // the only one = the latest: kept however old
    'PLAUD Missing Reconciliation 2026-09-21.md', 'PLAUD Missing Reconciliation 2026-09-22.md',
    'Contextual Links Applied 2026-07-01.md', 'Connect Changelog 2026-07-08.md', 'Lint Fix Changelog 2026-09-14.md', 'People gaps.md',
  ];
  const plan = vh.planVaultAuditRetention(names, '2026-10-22').map((p) => p.name);
  assert.deepEqual(plan, ['Hygiene Sweep 2026-10-07.md', 'Lint Report 2026-09-14.md', 'PLAUD Missing Reconciliation 2026-09-21.md']);
});

test('Vault Audit retention moves to Archive/Vault Audit and never overwrites', () => {
  const vh = require('./vault-hygiene');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-retain-'));
  const dir = path.join(root, 'Documents', 'System', 'Vault Audit');
  const arch = path.join(root, 'Archive', 'Vault Audit');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(arch, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Hygiene Sweep 2026-09-01.md'), 'a\n');
  fs.writeFileSync(path.join(dir, 'Hygiene Sweep 2026-09-02.md'), 'b\n');
  fs.writeFileSync(path.join(arch, 'Hygiene Sweep 2026-09-02.md'), 'already archived\n');
  const r = vh.retainVaultAudit(root, { todayKey: '2026-10-22' });
  assert.deepEqual(r.moved.map((m) => m.to), ['Archive/Vault Audit/Hygiene Sweep 2026-09-01.md']);
  assert.equal(r.skipped.length, 1);
  assert.equal(fs.readFileSync(path.join(arch, 'Hygiene Sweep 2026-09-02.md'), 'utf-8'), 'already archived\n');
  assert.ok(fs.existsSync(path.join(dir, 'Hygiene Sweep 2026-09-02.md')), 'left in place rather than overwrite');
});

test('SAiM actions reach activity_log and NEVER a Daily note', () => {
  const nae = require('./next-action-engine');
  const se = require('./suggestion-engine');
  const before = listVault();
  nae.computeNextActions([{ id: 'cal-x', type: 'meeting', title: 'Team Standup', meta: { minutesAway: 5 } }], {});
  nae.logOutcome('open_task', 'Replied to Abdi');
  se.logActionExecution({ id: 77, type: 'complete_task', reason: 'Close the Sandford ticket' }, { ok: true, detail: 'done' });
  const after = listVault();
  assert.deepEqual(after, before, 'no Daily note created or changed');
  assert.ok(!after.some((p) => p.startsWith('Daily/')));

  const types = db.all(`SELECT event_type, event_data FROM activity_log WHERE event_type IN ('saim_auto_action','saim_outcome','saim_action')`);
  const text = types.map((r) => r.event_data).join(' ');
  assert.match(text, /Meeting prep: \\?"Team Standup\\?" in 5 min/);
  assert.match(text, /Replied to Abdi/);
  assert.match(text, /Close the Sandford ticket/, 'the reason the daily line carried is in the row');
});

test('NEURO renders that log on demand — under "SAiM log", never in "All"', () => {
  const at = require('./activity-timeline');
  const log = at.read({ filter: 'saim-log' });
  assert.ok(at.FILTERS.includes('saim-log'));
  const heads = log.entries.map((e) => e.headline);
  assert.ok(heads.some((h) => /Team Standup/.test(h)), heads.join(' | '));
  assert.ok(heads.some((h) => /Completed: Replied to Abdi/.test(h)));
  assert.ok(heads.some((h) => /Close the Sandford ticket/.test(h)));
  const all = at.read({ filter: 'all' });
  assert.ok(!all.entries.some((e) => e.type === 'saim.log'), 'the noise the cleanup removed does not move into All');
  assert.ok(!all.today.lines.some((l) => /failure/.test(l)));
});

test('identical SAiM lines on one day fold into ONE entry with a count', () => {
  const at = require('./activity-timeline');
  const rows = [1, 2, 3].map((i) => ({ id: i, event_type: 'saim_auto_action', event_data: JSON.stringify({ type: 'meeting_prep_log', detail: 'Meeting prep: "Sprint" in 5 min' }), date_key: '2026-10-21', created_at: `2026-10-21 09:0${i}:00` }));
  const out = at.fromSaimLog(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].metadata.count, 3);
  assert.equal(out[0].summary, '3 times that day.');
});

test('the hygiene sweep writes nothing on a no-change night, and never a dated file', () => {
  const vh = require('./vault-hygiene');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-sweep-'));
  const r1 = vh.nightlySweep(root, { apply: true });
  const r2 = vh.nightlySweep(root, { apply: true });
  assert.equal(r1.written, false);
  assert.equal(r2.written, false);
  assert.equal(fs.existsSync(path.join(root, 'Documents', 'System', 'Vault Audit')), false, 'no report folder on a no-op');
});

test('the rolling sweep file is rewritten only when its content would change', () => {
  const vh = require('./vault-hygiene');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-sweep2-'));
  const dir = path.join(root, 'Documents', 'System', 'Vault Audit');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Hygiene Sweep.md');
  // A rolling file left by an earlier night that kept nothing.
  fs.writeFileSync(file, '# Hygiene Sweep — last change 2026-10-01\r\n\r\n- Summary-N duplicates archived: **2**\r\n');
  const before = fs.readFileSync(file, 'utf-8');
  const r = vh.nightlySweep(root, { apply: true });
  assert.equal(r.written, false);
  assert.equal(fs.readFileSync(file, 'utf-8'), before, 'the last real change stays on the page');
  assert.equal(r.reportPath, 'Documents/System/Vault Audit/Hygiene Sweep.md');
  assert.deepEqual(fs.readdirSync(dir), ['Hygiene Sweep.md'], 'no dated sweep file appears beside it');
});

test('source: no generated report writes the [[Logs]] footer or a dated sweep name', () => {
  for (const f of ['imports.js', 'plaud-sync.js', 'knowledge-memory.js', 'vault-hygiene.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf-8')
      .split(String.fromCharCode(10)).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join(String.fromCharCode(10));
    assert.ok(!/_Part of \[\[Logs\]\]_/.test(src), `${f} still writes the Logs footer`);
  }
  const vh = fs.readFileSync(path.join(__dirname, 'vault-hygiene.js'), 'utf-8');
  assert.ok(!vh.includes('`Hygiene Sweep ${today}.md`'));
  // Positive control: the scan would see the footer if it were there.
  assert.ok(/_Part of \[\[Logs\]\]_/.test('x + "_Part of [[Logs]]_"'));
});

test('source: nothing appends a SAiM Actions section to the daily note', () => {
  for (const f of ['next-action-engine.js', 'suggestion-engine.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf-8');
    assert.ok(!src.includes('appendToDailyNote'), `${f} still writes to the daily note`);
    assert.ok(!src.includes('_appendToDailySection'), f);
  }
});
