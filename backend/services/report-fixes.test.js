'use strict';

/**
 * The fixes log (23 Oct 2026) — services/report-fixes.js, its routes, and the
 * two reports that carry it. The vault is the master: every case runs against a
 * real temp vault, one note per fix.
 *
 *   1. Validation refuses, never repairs.
 *   2. A session's post is PROPOSED; Nick's manual entry is INCLUDED at once.
 *   3. A machine re-post never changes a fix Nick decided on.
 *   4. Only INCLUDED fixes reach a report; the week rule; figure overlap.
 *   5. SOAP: a "Fixed:" line in Success, a Data corrections section, marked rows.
 *   6. Weekly Risk: correction lines in section 5 and marked compliance rows.
 *   7. Routes over real HTTP + the real authority guard: a machine may propose,
 *      never include, edit or enter one manually.
 *   8. The note: editing status in Obsidian is a decision; Nick's own sections
 *      survive NEURO's writes; a broken note is reported, never dropped.
 *   9. An unreadable vault is a named gap in the report, never "no fixes".
 *
 *   run: node --test backend/services/report-fixes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-report-fixes-'));
process.env.NEURO_DB_PATH = path.join(TMP, 'a.db');
const VAULT = path.join(TMP, 'vault');
fs.mkdirSync(VAULT);
process.env.OBSIDIAN_VAULT_PATH = VAULT;
const LOG_DIR = path.join(VAULT, 'Projects', 'Fixes Log');

const db = require('../db/database');
const RF = require('./report-fixes');
const soap = require('./soap-report');
const wr = require('./weekly-risk');
const guard = require('./authority-guard');

const NOW = new Date(2026, 9, 23, 12, 0, 0); // Fri 23 Oct 2026, local

const base = (over = {}) => ({
  system: 'nova', title: 'Tier 2 FRT counted resolved tickets twice', problem: 'FRT compliance for Tier 2 was over-stated.',
  impact: ['figures'], affects: [{ measure: 'Tier 2 — FRT compliance', from: '2026-10-05', to: '2026-10-16' }],
  fixedIn: 'v1.1.740', deployedOn: '2026-10-21', ...over,
});

let server; let baseUrl;
test.before(async () => {
  await db.init();
  const app = express();
  app.use(express.json());
  app.use('/api', guard.guard);
  app.use('/api/report-fixes', require('../routes/report-fixes'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

async function call(method, p, body, headers = {}) {
  const res = await fetch(baseUrl + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('1. validation refuses bad input rather than repairing it', () => {
  assert.throws(() => RF.validate(base({ system: 'jira' }), { now: NOW }), /system must be/);
  assert.throws(() => RF.validate(base({ deployedOn: '2026-02-31' }), { now: NOW }), /real date/);
  assert.throws(() => RF.validate(base({ deployedOn: '2026-10-24' }), { now: NOW }), /future/);
  assert.throws(() => RF.validate(base({ affects: [] }), { now: NOW }), /say which figures/);
  assert.throws(() => RF.validate(base({ impact: ['team'] }), { now: NOW }), /add "figures"/);
  assert.throws(() => RF.validate(base({ impact: ['vibes'] }), { now: NOW }), /unknown impact/);
  assert.throws(() => RF.validate(base({ affects: [{ measure: 'x', from: '2026-10-10', to: '2026-10-01' }] }), { now: NOW }), /from is after to/);
  const ok = RF.validate(base({ impact: ['team'], affects: undefined }), { now: NOW });
  assert.deepEqual(ok.affects, []);
});

test('2/3. a session proposes, Nick includes; a machine re-post never undoes his decision', () => {
  const a = RF.post(base(), { manual: false, postedBy: 'machine:claude-code', now: NOW });
  assert.equal(a.created, true);
  assert.equal(a.fix.status, 'proposed');
  assert.equal(a.fix.source, 'session');
  // Re-post with new wording while still proposed: folds and takes the wording.
  const b = RF.post(base({ problem: 'Reworded.' }), { postedBy: 'machine:claude-code', now: NOW });
  assert.equal(b.created, false);
  assert.equal(b.fix.id, a.fix.id);
  assert.equal(b.fix.problem, 'Reworded.');
  RF.decide(a.fix.id, 'dismiss');
  const c = RF.post(base({ problem: 'Try again.' }), { postedBy: 'machine:claude-code', now: NOW });
  assert.equal(c.already, true);
  assert.equal(RF.get(a.fix.id).status, 'dismissed');
  assert.equal(RF.get(a.fix.id).problem, 'Reworded.');
  // Nick's manual entry is included at once.
  const m = RF.post(base({ title: 'Portal login loop', impact: ['customers'], affects: [], system: 'neuro', fixedIn: null }), { manual: true, now: NOW });
  assert.equal(m.fix.status, 'included');
  assert.equal(m.fix.source, 'manual');
  RF.decide(a.fix.id, 'include');
});

test('4. only included fixes reach a report; week and overlap rules', () => {
  const mk = (id, over) => ({ id, status: 'included', impact: ['figures'], affects: [{ measure: 'M', from: '2026-10-05', to: '2026-10-09' }], systemLabel: 'NOVA', title: `t${id}`, problem: 'p', deployedOn: '2026-10-21', ...over });
  const week = { from: '2026-10-19', to: '2026-10-25', shownFrom: '2026-10-12' };
  const r = RF.forReport([
    mk(1),                                                     // deployed this week → fixed + corrected (whatever its dates)
    mk(2, { status: 'proposed' }),                             // never
    mk(3, { deployedOn: '2026-10-26' }),                       // after the week → not yet
    mk(4, { deployedOn: '2026-10-01', affects: [{ measure: 'N', from: '2026-10-13', to: '2026-10-14' }] }), // older fix, overlaps shown figures
    mk(5, { deployedOn: '2026-10-01', affects: [{ measure: 'O', from: '2026-09-01', to: '2026-09-05' }] }), // older, no overlap
    mk(6, { impact: ['team'], affects: [] }),                  // fixed, no figures
  ], week);
  assert.deepEqual(r.fixed.map((f) => f.id), [1, 6]);
  assert.deepEqual(r.corrections.map((f) => f.id), [4, 1]);
  assert.deepEqual(r.rowNotes, { n: [1], m: [2] });
  assert.equal(RF.markLabel('M', r.rowNotes), 'M [2]');
  assert.equal(RF.markLabel('Other', r.rowNotes), 'Other');
});

const soapReport = () => ({
  kind: 'final', from: '2026-10-19', to: '2026-10-25', upTo: '2026-10-25',
  verdicts: { success: [], star: null, ambers: [], reds: [] }, carried: [], gaps: [], gapsBySection: {},
  perQueue: [{ key: 'k', label: 'Tier 2 — FRT compliance', value: 90, was: 92, target: 95, rag: 'amber' }],
});

test('5. SOAP: Fixed line in Success, a corrections section, the affected row marked; nothing without a fix', () => {
  const report = soapReport();
  const fixes = soap.fixesFor(report);
  const md = soap.render(report, soap.emptyManual(), { fixes });
  assert.match(md, /## ✅ Success\n\n- Fixed: /);
  assert.ok(md.includes('- Fixed: Tier 2 FRT counted resolved tickets twice — Reworded. (NOVA v1.1.740, 21 Oct)'));
  assert.match(md, /- Fixed: Portal login loop/);
  assert.match(md, /## Data corrections\n\n- \[1\] Tier 2 — FRT compliance \(5 Oct–16 Oct\) — affected by: Reworded\. Fixed in NOVA v1\.1\.740 on 21 Oct\. Figures for those dates are shown as originally reported\./);
  assert.match(md, /\| Tier 2 — FRT compliance \[1\] \| 🟠 90%/);
  const bare = soap.render(report, soap.emptyManual());
  assert.doesNotMatch(bare, /Data corrections|Fixed:/);
  assert.match(bare, /Nothing met its mark/);
  // Excluding the section drops it whole.
  const ex = soap.render(report, { ...soap.emptyManual(), excluded: ['corrections'] }, { fixes });
  assert.doesNotMatch(ex, /Data corrections/);
});

test('6. Weekly Risk: correction and fix lines in section 5, the compliance row marked', () => {
  const a = wr.assess({
    week: '2026-10-26', trend: [], orgTrend: null, kpi: null, manual: wr.getManual ? wr.getManual('2026-10-26') : undefined,
    sources: [], fixes: RF.logForReports(),
  });
  assert.equal(a.fixes.corrections.length, 1);
  a.trend = [{ kpi: 'Tier 2 — FRT compliance', measured: true, reported: { value: 90 }, compare: { value: 92 }, delta: -2, target: 95 }];
  const md = wr.render(a);
  assert.match(md, /\| Tier 2 — FRT compliance \[1\] \| 90% \| 92% \|/);
  assert.match(md, /- \*\*Data correction \[1\]:\*\* Tier 2 — FRT compliance \(5 Oct–16 Oct\)/);
  assert.match(md, /- \*\*Fixed: Portal login loop/);
});

test('7. routes: a machine may propose, never include, edit or enter one by hand', async () => {
  const MACHINE = { 'X-Neuro-Machine-Client': 'claude-code' };
  const p = await call('POST', '/api/report-fixes', base({ title: 'Escalation count missed reopened tickets', fixedIn: 'v1.1.741', deployedOn: '2026-10-22', affects: [{ measure: 'Escalations', from: '2026-10-01', to: '2026-10-20' }] }), MACHINE);
  assert.equal(p.status, 201);
  assert.equal(p.body.fix.status, 'proposed');
  assert.equal(p.body.fix.postedBy, 'machine:claude-code');
  const id = p.body.fix.id;
  for (const [m, url, body] of [
    ['POST', `/api/report-fixes/${id}/decide`, { decision: 'include' }],
    ['POST', `/api/report-fixes/${id}/edit`, { title: 'x' }],
    ['POST', '/api/report-fixes/manual', base({ title: 'sneaky' })],
  ]) {
    const r = await call(m, url, body, MACHINE);
    assert.equal(r.status, 403, url);
  }
  assert.equal(RF.get(id).status, 'proposed');
  const bad = await call('POST', '/api/report-fixes', base({ system: 'jira' }), MACHINE);
  assert.equal(bad.status, 400);
  // Nick (no machine header) includes it.
  const inc = await call('POST', `/api/report-fixes/${id}/decide`, { decision: 'include' });
  assert.equal(inc.status, 200);
  assert.equal(inc.body.fix.status, 'included');
  const ls = await call('GET', '/api/report-fixes?status=included');
  assert.ok(ls.body.fixes.some((f) => f.id === id));
});

test('8. the note: status edited in Obsidian is a decision; added sections survive; a broken note is reported', () => {
  const r = RF.post(base({ title: 'Ageing used created date', affects: [{ measure: 'Oldest actionable', from: '2026-10-01', to: '2026-10-02' }] }), { postedBy: 'machine:x', now: NOW });
  const abs = path.join(VAULT, r.fix.path);
  let note = fs.readFileSync(abs, 'utf-8');
  assert.match(note, /^---\ntype: report-fix\nfix_id: fx-[0-9a-f]{10}\nsystem: nova\nstatus: proposed/);
  assert.match(note, /\| Oldest actionable \| 2026-10-01 \| 2026-10-02 \|/);
  // Nick edits in Obsidian (CRLF, as Windows writes it): includes it and adds his own section.
  note = note.replace('status: proposed', 'status: included') + '\n## My notes\n\nChris asked about this on Tuesday.\n';
  fs.writeFileSync(abs, note.replace(/\n/g, '\r\n'));
  assert.equal(RF.get(r.fix.id).status, 'included');
  // A NEURO write (edit) keeps his section and his decision.
  RF.edit(r.fix.id, { problem: 'Ageing counted from the created date, not the due date.' }, { now: NOW });
  const after = fs.readFileSync(abs, 'utf-8');
  assert.match(after, /## My notes\n\nChris asked about this on Tuesday\./);
  assert.match(after, /status: included/);
  assert.match(after, /Ageing counted from the created date/);
  // A note he breaks is named and left out — never silently dropped.
  fs.writeFileSync(path.join(LOG_DIR, 'broken.md'), '---\ntype: report-fix\nfix_id: fx-broken\nsystem: jira\nstatus: included\n---\n# x\n');
  const ls = RF.list();
  assert.ok(ls.unreadable.some((u) => u.path.endsWith('broken.md') && /system must be/.test(u.why)));
  assert.ok(!ls.fixes.some((f) => f.id === 'fx-broken'));
  fs.unlinkSync(path.join(LOG_DIR, 'broken.md'));
  // An unrelated note in the folder is not a fix and not an error.
  fs.writeFileSync(path.join(LOG_DIR, '_about.md'), '# About\n');
  assert.equal(RF.list().unreadable.length, 0);
});

test('9. an unreadable vault is a named gap in the SOAP report, never "no fixes"', () => {
  const keep = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = path.join(TMP, 'missing');
  try {
    const report = soapReport();
    const fx = soap.fixesFor(report);
    assert.ok(fx.unreadable);
    const md = soap.render(report, soap.emptyManual(), { fixes: fx });
    assert.match(md, /## Data corrections\n\n- Not available — the fixes log could not be read/);
    assert.throws(() => RF.post(base({ title: 'x' }), { now: NOW }), /could not be read|could not be written/);
  } finally { process.env.OBSIDIAN_VAULT_PATH = keep; }
});
