'use strict';

/**
 * Task context (22 Oct 2026) — the real scan, store, manual links and routes,
 * over a TEMP vault and a TEMP database. Through NEURO's real api-auth and
 * authority guard for the HTTP half. Nothing touches the real vault.
 *
 * What is pinned here, because each is the failure the feature must not have:
 *  - explicit evidence pins; a title needs support; a vague overlap gives NOTHING
 *  - generated, daily, duplicate and untitled notes are never pulled in;
 *    Personal/ and people notes are ordinary material (31 Oct 2026)
 *  - a rerun changes no row; a scan, a read and an empty run write no vault file
 *  - a vanished/changed note goes stale, and comes back when restored
 *  - manual note/project/area links; removal is remembered by the scan
 *  - two plausible projects → one question, never a guess
 *  - machines may link ONE thing; they may not run the scan; no bulk bodies
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-context-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['HA_TOKEN', 'HA_URL', 'VAULT_SENSITIVE_DIRS', 'VAULT_PERSONAL_DIRS']) delete process.env[k];

function write(rel, text) {
  const p = path.join(VAULT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const db = require('../db/database');
const taskStore = require('./task-store');
const tc = require('./task-context');
const model = require('./task-context-model');

const MEETING = 'Meetings/2026/10/2026-10-14 – Escalation Workflow Review.md';
const DRAFT = 'Projects/Escalation Triage/Triage Checklist Draft.md';
const OWNER = 'Projects/Escalation Triage/Owner Notes.md';
const IDEAS = 'Ideas/Checklist Ideas.md';
const HR = 'Meetings/2026/10/2026-10-15 – Heidi Example Catch Up.md';
const DUP = 'Projects/Escalation Triage/Triage Checklist Draft 2.md';

function seedVault() {
  write('People/Heidi Example.md', '---\ntype: person\n---\n# Heidi Example\n');
  write('People/Sam Sample.md', '---\ntype: person\n---\n# Sam Sample\n');
  write(MEETING, '---\ntype: meeting\n---\n# Escalation workflow review\n\nWe agreed the Tier 2 escalation triage checklist needs rebuilding before the queue review.\n');
  write('Projects/Escalation Triage/Escalation Triage.md', '---\ntype: project\n---\n# Escalation Triage\n\nThe project to make every escalation arrive with what the next tier needs.\n');
  write(DRAFT, '# Triage checklist draft\n\nA first cut of the triage checklist: customer ask, steps tried, escalation reason, Tier 2 owner.\n');
  write(DUP, '# Triage checklist draft\n\nA first cut of the triage checklist: customer ask, steps tried, escalation reason.\n');
  write(OWNER, '# Owner notes\n\nWho holds what on this project. Follow-up for TASK_A_REF.\n');
  write(IDEAS, '# Checklist ideas\n\nAssorted checklist thoughts for the support team and the weekly queue.\n');
  write('Areas/Support Operations.md', '# Support Operations\n\nRotas, coverage and the running of the desk.\n');
  write('Areas/Team Management.md', '# Team Management\n\nHow the team is run.\n');
  write('Projects/NOVA/NOVA.md', '# NOVA\n\nThe KPI dashboard.\n');
  write('Projects/VANTAGE/VANTAGE.md', '# VANTAGE\n\nService desk findings.\n');
  // Material that must NEVER become context, even though it names the same things.
  write('Daily/2026-10-21.md', '## Focus Today\n- [ ] TASK_A_REF escalation triage checklist\n\n## SAiM Actions\n- 09:45 — Meeting prep: "Escalation triage checklist"\n');
  write('Documents/System/SAiM Import Reports/2026-10-21.md', '# SAiM Import Activity\n\n- Created [[Escalation triage checklist]]\n');
  write('Personal/Disciplinary Prep.md', '# Prep\n\nEscalation triage checklist was raised in the hearing.\n');
  write(HR, '# Catch up\n\nHeidi Example has been off sick since Monday and her return to work is pending.\nSam Sample raised a grievance about the rota.\nThe escalation triage checklist handover was discussed.\n');
  write('Untitled.md', '# Untitled\n\nescalation triage checklist tier 2\n');
  // Filler, so "support", "team", "weekly" are COMMON and carry no evidence.
  for (let i = 1; i <= 24; i += 1) write(`Meetings/2026/09/Filler ${i} – Weekly Meeting.md`, `# Weekly meeting ${i}\n\nSupport team ticket customer queue weekly update number ${i}, rota and coverage chatter.\n`);
}

function snapshotVault() {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out[path.relative(VAULT, p)] = `${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}@${st.mtimeMs}`; } };
  walk(VAULT);
  return out;
}
const linkRows = () => db.all(`SELECT * FROM task_context_links ORDER BY id`);

let A; let B; let C; let D; let E;
let server; let base;

test.before(async () => {
  fs.mkdirSync(VAULT, { recursive: true });
  await db.init();
  A = taskStore.createTask({ text: 'Finalise the escalation triage checklist for Tier 2', source: 'test', origin_path: MEETING });
  B = taskStore.createTask({ text: 'Review Support Operations rota coverage for December', source: 'test' });
  C = taskStore.createTask({ text: 'Prepare the escalation triage checklist handover pack', source: 'test', origin_path: HR });
  D = taskStore.createTask({ text: 'Move the leaderboard view from NOVA into VANTAGE', source: 'test' });
  E = taskStore.createTask({ text: 'Buy a birthday present for the weekend', source: 'test' });
  seedVault();
  // the explicit marker needs the real id
  write(OWNER, fs.readFileSync(path.join(VAULT, ...OWNER.split('/')), 'utf8').replace('TASK_A_REF', `task #${A.id}`));
  write('Daily/2026-10-21.md', fs.readFileSync(path.join(VAULT, 'Daily', '2026-10-21.md'), 'utf8').replace('TASK_A_REF', `<!--task:${A.id}-->`));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/task-context', require('../routes/task-context'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

function call(method, route, body, headers = { 'X-NEURO-PIN': 'pin-1234' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/task-context${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const MACHINE = { 'X-NEURO-API-TOKEN': 'tok-5678' };

// ── the pure rules ───────────────────────────────────────────────────────────

test('screen: machine output, daily notes and generic notes are never scan material; Personal/ and private notes are', () => {
  const deps = { isExcludedPath: () => false, exists: (r) => r === 'Projects/X/Note.md' };
  const s = (rel, extra = {}) => model.screenNote({ rel, fm: {}, body: 'something real here', ...extra }, deps).reason;
  assert.equal(s('Documents/System/SAiM Import Reports/2026-10-21.md'), 'generated');
  assert.equal(s('Daily/2026-10-21.md'), 'daily-note');
  assert.equal(s('Plaud/Transcripts/x.md'), 'raw-transcript');
  assert.equal(s('Personal/Prep.md'), null);
  assert.equal(s('Projects/X/Note 2.md'), 'duplicate');
  assert.equal(s('Projects/D&D/Session 2.md'), null, 'a real "Session 2" is not a duplicate');
  assert.equal(s('Untitled.md'), 'ambiguous');
  assert.equal(s('Projects/X/Plan.md', { fm: { private: 'true' } }), null);
  assert.equal(s('Projects/X/Plan.md', { body: '  ' }), 'empty');
  assert.equal(s('Projects/X/Plan.md', { readable: false }), 'unreadable');
});

test('score: a vague overlap gives nothing; a lone title is a suggestion; explicit evidence pins', () => {
  const tok = (s) => require('./task-dedupe').tokenize(s);
  const notes = [
    model.indexNote({ rel: 'Projects/P/Rota Planning.md', text: '# Rota planning\n\nDecember coverage.' }, tok),
    model.indexNote({ rel: 'Ideas/Misc.md', text: 'rota coverage december review thoughts' }, tok),
    model.indexNote({ rel: 'Ideas/Other.md', text: 'unrelated' }, tok),
  ];
  const stats = model.corpusStats(notes);
  const task = model.indexTask({ id: 7, text: 'Rota planning for the December coverage review', origin_path: null }, tok);
  assert.equal(model.scoreNote(task, notes[0], stats).level, 'pin', 'title + body support pins');
  assert.equal(model.scoreNote(task, notes[1], stats), null, 'body overlap alone is never enough');
  const lone = model.indexTask({ id: 8, text: 'Rota planning', origin_path: null }, tok);
  const bare = model.indexNote({ rel: 'Projects/Q/Rota Planning.md', text: 'nothing about it' }, tok);
  assert.equal(model.scoreNote(lone, bare, model.corpusStats([bare, ...notes])).level, 'suggest', 'a title alone only suggests');
  const ref = model.indexNote({ rel: 'X/Y.md', text: 'see task #9' }, tok);
  assert.equal(model.scoreNote(model.indexTask({ id: 9, text: 'zzz qqq' }, tok), ref, stats).reasons[0].code, 'task-ref');
});

// ── the scan ─────────────────────────────────────────────────────────────────

test('reads before any scan create no table and answer empty', () => {
  const r = tc.forTask(A.id);
  assert.equal(r.ok, true);
  assert.deepEqual([r.pinned, r.suggestions], [[], []]);
  assert.equal(tc._internals._exists(), false, 'a read must not create the tables');
});

// ── The activation boundary: deploying must not perform the backfill ─────────

test('DEFAULT after deployment: the 03:40 job and every scan door do NOTHING — no table, no link, no receipt, no vault write', async () => {
  const before = snapshotVault();
  const st = tc.status();
  assert.equal(st.enabled, false);
  assert.match(st.say, /off until you enable it in NEURO → Settings/);
  assert.match(st.enableSay, /backfill/);
  tc.registerJob();
  const job = require('./runtime-jobs')._jobs.get('task-context-scan');
  assert.equal(job.cron, '40 3 * * *', 'registered and visible');
  assert.deepEqual(await job.run(), { skipped: 'not-enabled', say: tc.WAITING_SAY }, 'the scheduled run is a recorded no-op, not a failure');
  const direct = tc.runScan({ trigger: 'nightly' });
  assert.equal(direct.ok, false);
  assert.equal(direct.disabled, true);
  assert.equal(tc._internals._exists(), false, 'not even a table');
  const http1 = await call('POST', '/scan', {});
  assert.equal(http1.status, 409, 'Nick pressing scan before enabling is refused too — the backfill has ONE door');
  assert.equal((await call('GET', '/status')).json.enabled, false);
  // the switch: never by a machine, never without the confirmation
  assert.equal(tc.activate({ by: 'machine:mcp-local', confirm: true }).status, 403);
  assert.equal(tc.activate({ by: 'nick' }).status, 400);
  assert.equal((await call('POST', '/activate', { confirm: true }, MACHINE)).status, 403);
  assert.equal((await call('POST', '/activate', { confirm: true }, { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' })).status, 403);
  assert.equal((await call('POST', '/activate', { confirm: true, now: 1 })).status, 400, 'an unnamed field is refused');
  assert.equal(tc.status().enabled, false);
  assert.equal(tc._internals._exists(), false);
  assert.deepEqual(snapshotVault(), before);
});

let G;
test('manual linking works before activation; a removal made then is kept', () => {
  G = taskStore.createTask({ text: 'Review the triage checklist draft wording', source: 'test', origin_path: DRAFT });
  let r = tc.link({ taskId: E.id, type: 'note', ref: IDEAS });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.link.origin, 'manual');
  // G was raised in DRAFT, so the scan WOULD pin it; Nick links and then removes it first.
  r = tc.link({ taskId: G.id, type: 'note', ref: DRAFT });
  assert.equal(tc.remove({ taskId: G.id, linkId: r.link.id }).ok, true);
  assert.equal(tc.forTask(E.id).automatic.enabled, false);
  assert.match(tc.forTask(E.id).automatic.say, /off until you enable it in NEURO → Settings/);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM task_context_runs`).n, 0, 'manual linking writes no run receipt');
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM task_context_links WHERE origin = 'nightly-scan'`).n, 0, 'nothing automatic yet');
});

test('Nick enables it: the backfill runs once, then the job runs at 03:40; manual links and removals survive', () => {
  const before = snapshotVault();
  const on = tc.activate({ by: 'nick', confirm: true });
  assert.equal(on.ok, true, on.error);
  assert.deepEqual(snapshotVault(), before, 'the backfill wrote nothing to the vault');
  const st = tc.status();
  assert.equal(st.enabled, true);
  assert.equal(st.backfill.runId, on.runId);
  assert.equal(db.get(`SELECT trigger FROM task_context_runs WHERE id = ?`, [on.runId]).trigger, 'backfill');
  assert.equal(tc.activate({ by: 'nick', confirm: true }).already, true, 'a second press does not run a second backfill');
  // preserved
  const e = tc.forTask(E.id).pinned.find((p) => p.ref === IDEAS);
  assert.equal(e && e.origin, 'manual');
  assert.ok(![...tc.forTask(G.id).pinned, ...tc.forTask(G.id).suggestions].some((p) => p.ref === DRAFT), 'the removal made before activation is kept');
  // remove E's manual link again so the later manual-link tests start where they did
  tc.remove({ taskId: E.id, linkId: e.id });
});

test('the backfill: explicit evidence and supported titles pin; vague matches and excluded material never appear', () => {
  // What the first ENABLED run (the backfill, above) did — its own receipt.
  const r = { ok: true, receipt: tc.status().backfill.receipt };

  const a = tc.forTask(A.id);
  const pinned = new Map(a.pinned.map((p) => [p.ref, p]));
  assert.ok(pinned.has(MEETING), 'the note the task was raised in');
  assert.equal(pinned.get(MEETING).reasons[0].code, 'origin');
  assert.ok(pinned.has(OWNER), 'the note that names task #A');
  assert.ok(pinned.has(DRAFT), 'a title match with body support');
  assert.ok(a.pinned.every((p) => p.automatic && p.origin === 'nightly-scan' && p.originLabel === 'Found automatically'));
  const every = [...tc.forTask(A.id, { viewer: 'owner' }).pinned, ...a.suggestions].map((p) => p.ref);
  for (const bad of [IDEAS, DUP, 'Daily/2026-10-21.md', 'Documents/System/SAiM Import Reports/2026-10-21.md', 'Personal/Disciplinary Prep.md', HR, 'Untitled.md']) {
    assert.ok(!every.includes(bad), `${bad} must not be context for task A`);
  }
  assert.ok(a.suggestions.some((s) => s.type === 'project' && s.ref === 'Projects/Escalation Triage'), 'a project the wording names is suggested, not pinned');
  const proj = a.suggestions.find((s) => s.ref === 'Projects/Escalation Triage');
  assert.ok(proj.scopeItems.length >= 1 && proj.scopeItems.length <= 3, 'a scope shows a few relevant notes, not the folder');

  // the receipt says what was skipped and why
  const rc = r.receipt;
  for (const k of ['daily-note', 'generated', 'duplicate', 'ambiguous', 'person-note']) assert.ok(rc.skipped[k] >= 1, `skipped.${k}`);
  assert.ok(rc.pinned >= 3 && rc.suggested >= 1 && rc.questions === 1);
});

test('a people-meeting origin note is pinned to its own task in full — every viewer sees the same row (31 Oct 2026)', () => {
  const c = tc.forTask(C.id, { viewer: 'owner' });
  const hr = c.pinned.find((p) => p.ref === HR);
  assert.ok(hr, 'the catch-up the task came from is its context');
  assert.equal(hr.restricted, undefined);
  assert.ok(hr.preview, 'its preview is shown');
  const lim = tc.forTask(C.id).pinned.find((p) => p.id === hr.id);
  assert.equal(lim.ref, HR); assert.ok(lim.open, 'it opens for any viewer'); assert.equal(lim.title, hr.title);
  // …and never reaches the unrelated task with the same words
  assert.ok(![...tc.forTask(A.id, { viewer: 'owner' }).pinned, ...tc.forTask(A.id, { viewer: 'owner' }).suggestions].some((p) => p.ref === HR));
});

test('two plausible projects: one question, neither pinned', () => {
  const d = tc.forTask(D.id);
  assert.ok(d.question, 'asks');
  assert.deepEqual(d.question.options.map((o) => o.ref).sort(), ['Projects/NOVA', 'Projects/VANTAGE']);
  assert.ok(![...d.pinned, ...d.suggestions].some((p) => p.type === 'project'));
  assert.equal(tc.forTask(E.id).pinned.length + tc.forTask(E.id).suggestions.length, 0, 'an unrelated task gets nothing');
  assert.ok(tc.forTask(B.id).suggestions.some((s) => s.type === 'area' && s.ref === 'Areas/Support Operations'));
});

test('a rerun is idempotent: no row changes, nothing new counted', () => {
  const rows = JSON.stringify(linkRows());
  const r = tc.runScan({ trigger: 'test' });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(linkRows()), rows);
  assert.equal(r.receipt.pinned + r.receipt.suggested + r.receipt.refreshed + r.receipt.stale + r.receipt.questions, 0);
  assert.ok(r.receipt.unchanged > 0);
});

test('a changed note is refreshed; a deleted one goes stale and comes back when restored', () => {
  const full = path.join(VAULT, ...DRAFT.split('/'));
  const orig = fs.readFileSync(full, 'utf8');
  fs.writeFileSync(full, orig.replace('A first cut', 'The second cut'));
  let r = tc.runScan({ trigger: 'test' });
  assert.equal(r.receipt.refreshed >= 1, true);
  assert.match(tc.forTask(A.id).pinned.find((p) => p.ref === DRAFT).preview, /second cut/);

  fs.renameSync(full, `${full}.gone`);
  r = tc.runScan({ trigger: 'test' });
  const a = tc.forTask(A.id);
  assert.ok(!a.pinned.some((p) => p.ref === DRAFT), 'no longer shown as pinned');
  const st = a.stale.find((p) => p.ref === DRAFT);
  assert.equal(st.staleReason, 'gone');
  assert.match(st.staleSay, /no longer in the vault/);

  fs.renameSync(`${full}.gone`, full);
  r = tc.runScan({ trigger: 'test' });
  assert.equal(r.receipt.restored >= 1, true);
  assert.ok(tc.forTask(A.id).pinned.some((p) => p.ref === DRAFT), 'restored');

  // a change that makes it unrelated → stale "no longer matches", never silently kept
  fs.writeFileSync(full.replace('Triage Checklist Draft', 'Owner Notes'), '# Owner notes\n\nNothing to do with any task now.\n');
  tc.runScan({ trigger: 'test' });
  assert.equal(tc.forTask(A.id).stale.find((p) => p.ref === OWNER).staleReason, 'no-longer-matches');
});

// ── manual links ─────────────────────────────────────────────────────────────

test('manual note / project / area links, and removal the scan remembers', () => {
  const before = snapshotVault();
  let r = tc.link({ taskId: E.id, type: 'note', ref: IDEAS });
  assert.equal(r.ok, true);
  assert.equal(r.link.origin, 'manual');
  assert.equal(r.link.originLabel, 'Linked by you');
  r = tc.link({ taskId: E.id, type: 'project', ref: 'NOVA' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.link.ref, 'Projects/NOVA');
  r = tc.link({ taskId: E.id, type: 'area', ref: 'Team Management' });
  assert.equal(r.link.ref, 'Areas/Team Management');
  assert.equal(tc.link({ taskId: E.id, type: 'note', ref: IDEAS }).already, true, 'linking twice folds');

  // remove an AUTO pin: the scan must not put it back
  const auto = tc.forTask(A.id).pinned.find((p) => p.ref === MEETING);
  assert.equal(tc.remove({ taskId: A.id, linkId: auto.id }).ok, true);
  tc.runScan({ trigger: 'test' });
  assert.ok(!tc.forTask(A.id).pinned.some((p) => p.ref === MEETING), 'a removal is a decision the scan keeps');
  // …and a manual re-link revives it as Nick's
  r = tc.link({ taskId: A.id, type: 'note', ref: MEETING });
  assert.equal(r.link.state, 'pinned');
  assert.equal(r.link.origin, 'manual');
  assert.deepEqual(snapshotVault(), before, 'links never write the vault');
});

test('ambiguity asks: a name that fits several notes or projects comes back as a question', () => {
  write('Ideas/Rota.md', '# Rota\n\nideas');
  write('Projects/NOVA/Rota.md', '# Rota\n\nnova rota');
  const r = tc.link({ taskId: B.id, type: 'note', ref: 'Rota' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.needsChoice.question, /Which note/);
  assert.equal(r.needsChoice.options.length, 2);
  const p = tc.link({ taskId: B.id, type: 'area', ref: 'Management' });
  assert.equal(p.ok, true, 'one loose match is not ambiguous');
  assert.equal(tc.link({ taskId: B.id, type: 'note', ref: 'Documents/System/SAiM Import Reports/2026-10-21.md' }).status, 400, 'machine output is not linkable');
  assert.equal(tc.link({ taskId: B.id, type: 'note', ref: '../outside.md' }).status, 400, 'outside the vault');
  // linking a project answers the scan's question
  tc.link({ taskId: D.id, type: 'project', ref: 'Projects/NOVA' });
  assert.equal(tc.forTask(D.id).question, null);
});

test('a Personal/ note linked by hand is an ordinary link — with its preview', () => {
  const r = tc.link({ taskId: E.id, type: 'note', ref: 'Personal/Disciplinary Prep.md' });
  assert.equal(r.ok, true);
  assert.equal(r.link.restricted, undefined);
  assert.ok(r.link.preview);
});

test('the nightly job is registered at 03:40 and an empty vault run writes nothing to it', () => {
  const rt = require('./runtime-jobs');
  tc.registerJob();
  const job = rt._jobs.get('task-context-scan');
  assert.equal(job.cron, '40 3 * * *');
  assert.equal(job.catchUp, 'latest', 'a missed night runs once on the next boot, never a backlog');
  const sched = fs.readFileSync(path.join(__dirname, 'scheduler.js'), 'utf8');
  assert.match(sched, /require\('\.\/task-context'\)\.registerJob\(\)/, 'scheduler.start() registers it');

  // A second vault with no tasks to match: the run is recorded in NEURO only.
  const empty = path.join(tmp, 'empty-vault');
  fs.mkdirSync(empty);
  const saved = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = empty;
  const rows = JSON.stringify(linkRows());
  try {
    const r = tc.runScan({ trigger: 'test' });
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readdirSync(empty), [], 'an empty run writes no daily note or report into the vault');
    assert.equal(tc.lastRun().receipt.notesScanned, 0);
    // ⚠ Found by this test: a vault that reads EMPTY (unmounted, mid-sync) once marked every link "gone".
    assert.equal(r.receipt.shrunk, true);
    assert.equal(r.receipt.stale, 0);
    assert.equal(JSON.stringify(linkRows()), rows, 'an empty-looking vault changes no link');
  } finally { process.env.OBSIDIAN_VAULT_PATH = saved; }
});

// ── HTTP: the routes, the guard, the gateway's view of them ──────────────────

test('routes: read, search, link, remove, pin over real auth; machine origin is recorded', async () => {
  const before = snapshotVault();
  let r = await call('GET', `/tasks/${A.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.contract, 'task-context-v1');
  r = await call('GET', `/search?q=${encodeURIComponent('triage checklist')}&taskId=${A.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.notes.some((n) => n.ref === DRAFT && n.linked), JSON.stringify(r.json));
  assert.ok(!r.json.notes.some((n) => n.ref.startsWith('Documents/System/')), 'machine output is never offered');
  assert.equal((await call('GET', '/search?q=a')).status, 400);

  r = await call('POST', `/tasks/${B.id}/links`, { type: 'note', ref: IDEAS }, MACHINE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.link.origin, 'mcp');
  assert.equal(r.json.link.originLabel, 'Linked from a chat');
  // no bulk: a list, or any extra field, is refused
  assert.equal((await call('POST', `/tasks/${B.id}/links`, { type: 'note', ref: [IDEAS, DRAFT] }, MACHINE)).status, 400);
  assert.equal((await call('POST', `/tasks/${B.id}/links`, { type: 'note', ref: IDEAS, items: [1, 2] }, MACHINE)).status, 400);
  r = await call('POST', `/tasks/${B.id}/links`, { type: 'note', ref: 'Rota' });
  assert.equal(r.status, 409);
  assert.ok(r.json.needsChoice.options.length === 2);

  const sugg = (await call('GET', '/suggestions')).json.suggestions[0];
  assert.ok(sugg, 'there is a suggestion to accept');
  r = await call('POST', `/tasks/${sugg.taskId}/links/${sugg.id}/pin`, {});
  assert.equal(r.json.link.state, 'pinned');
  r = await call('POST', `/tasks/${sugg.taskId}/links/${sugg.id}/remove`, {}, MACHINE);
  assert.equal(r.json.link.state, 'removed');
  assert.equal((await call('GET', '/runs')).json.runs.length >= 1, true);
  assert.deepEqual(snapshotVault(), before, 'no route wrote the vault');
});

test('the scan is Nick’s alone: a machine is refused by the guard, Nick may run it', async () => {
  const m = await call('POST', '/scan', {}, MACHINE);
  assert.equal(m.status, 403);
  const h = await call('POST', '/scan', {}, { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' });
  assert.equal(h.status, 403, 'a PIN client that declares itself a machine is a machine');
  const n = await call('POST', '/scan', {});
  assert.equal(n.status, 200);
  assert.equal(n.json.ok, true);
});

test('gateway policy: reads are read, one-item links are actions, the scan is interactive', async () => {
  const { classify } = await import('../../mcp-server/remote/api-policy.js');
  const inv = require('../../mcp-server/remote/api-inventory.json');
  const ops = (inv.operations || inv).filter((o) => o.route.startsWith('/api/task-context'));
  const kind = Object.fromEntries(ops.map((o) => [o.id, classify(o)]));
  assert.equal(kind.get_task_context_tasks_by_taskId, 'read');
  assert.equal(kind.get_task_context_search, 'read');
  assert.equal(kind.get_task_context_suggestions, 'read');
  assert.equal(kind.post_task_context_tasks_by_taskId_links, 'action');
  assert.equal(kind.post_task_context_tasks_by_taskId_links_by_linkId_remove, 'action');
  assert.equal(kind.post_task_context_scan, 'admin');
  const matrix = require('./authority-matrix');
  assert.equal(matrix.machineDecision('POST', '/api/task-context/scan').allow, false);
  assert.equal(matrix.machineDecision('POST', '/api/task-context/tasks/1/links').allow, true);
});

// ── Meeting prep, and the scope-naming rule found on the live vault ──────────

test('meeting prep: a task naming an attendee in full brings its pinned context — not what prep already shows', async () => {
  const F = taskStore.createTask({ text: 'Agree the rota swap with Sam Sample before December', source: 'test' });
  assert.equal(tc.link({ taskId: F.id, type: 'note', ref: IDEAS }).ok, true);
  const { _buildPrep } = require('../routes/meeting-prep-view');
  const prep = await _buildPrep({ subject: 'Catch-up', attendees: [{ name: 'Sam Sample', email: 'sam@example.test' }] });
  const row = prep.taskContext.find((t) => t.taskId === F.id);
  assert.ok(row, JSON.stringify(prep.taskContext));
  assert.deepEqual(row.items.map((i) => i.ref), [IDEAS]);
  assert.equal(row.items[0].origin, 'manual');
  assert.ok(!prep.gaps.some((g) => g.input === 'task-context'), JSON.stringify(prep.gaps));
  // a first name alone is never evidence
  const model2 = require('./task-context-model');
  assert.deepEqual(model2.tasksForMeeting([{ id: 1, text: 'Ask Sam about it' }], { people: ['Sam Sample'] }), []);
  assert.deepEqual(model2.tasksForMeeting([{ id: 2, text: 'x', origin_path: 'Meetings/a.md' }], { people: [], notePaths: new Set(['Meetings/a.md']) }), [2]);
});

test('scope naming: one ordinary word is not a project; an acronym or a Capitalised name is', () => {
  const S = [{ name: 'Working', ref: 'Projects/Working' }, { name: 'NOVA', ref: 'Projects/NOVA' }, { name: 'Tally', ref: 'Projects/Tally' }, { name: 'Support Operations', ref: 'Areas/Support Operations' }];
  const n = (t) => model.namedScopes(t, S).map((s) => s.name);
  assert.deepEqual(n('reply to a flexible working request'), [], 'measured on the live vault: this named Projects/Working');
  assert.deepEqual(n('build metrics in Nova'), ['NOVA']);
  assert.deepEqual(n('payments in Tally'), ['Tally']);
  assert.deepEqual(n('tally the totals'), []);
  assert.deepEqual(n('review support operations rota'), ['Support Operations']);
});

test('turning it off stops the nightly job and keeps every link exactly as it is', async () => {
  const rows = JSON.stringify(linkRows());
  assert.equal((await call('POST', '/deactivate', {}, MACHINE)).status, 403, 'not a machine’s decision');
  const off = await call('POST', '/deactivate', {});
  assert.equal(off.status, 200);
  assert.equal(tc.status().enabled, false);
  const job = require('./runtime-jobs')._jobs.get('task-context-scan');
  assert.equal((await job.run()).skipped, 'not-enabled');
  assert.equal(JSON.stringify(linkRows()), rows, 'switching off touches no link');
  const gw = await import('../../mcp-server/remote/api-policy.js');
  assert.ok(gw.interactive.post_task_context_activate && gw.interactive.post_task_context_deactivate, 'interactive in the gateway');
  const matrix = require('./authority-matrix');
  for (const p of ['/api/task-context/activate', '/api/task-context/deactivate', '/api/task-context/scan']) assert.equal(matrix.machineDecision('POST', p).allow, false, p);
});
