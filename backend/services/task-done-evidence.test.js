'use strict';

/**
 * "Looks done" (task-done-evidence.js).
 *
 *   run: node --test backend/services/task-done-evidence.test.js
 *
 * The rule this file holds: NEURO OFFERS to close a task on evidence and never
 * closes one itself, and every rule errs towards saying nothing — a wrong
 * "looks done" that Nick trusts loses a promise. So most tests are NEGATIVES:
 * one generic shared word, automated mail, mail sent before the task existed,
 * a task whose act is not a communication, a tick for a different task.
 *
 * Real DB + temp vault + a stubbed Sent Items reader, through the real pass
 * and the real routes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-tde-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'tde.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
fs.mkdirSync(path.join(VAULT, 'Daily'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = VAULT;
delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN; delete process.env.JIRA_BASE_URL;

const db = require('../db/database');
const taskStore = require('./task-store');
const tde = require('./task-done-evidence');

const NOW = Date.parse('2026-10-31T10:00:00Z');
const PEOPLE = [
  { name: 'Lucy Hart', emails: ['lucy.hart@nurtur.tech'] },
  { name: 'Suraj Patel', emails: ['suraj.patel@nurtur.tech'] },
  { name: 'Heidi Power', emails: ['heidi.power@nurtur.tech'] },
];
// A filler pool: the IDF needs a list for "team", "report", "review" to be common in.
const FILLER = [
  'Review the team report', 'Team meeting prep', 'Review support report for the team',
  'Plan team rota', 'Team report for Chris', 'Review queue report', 'Support team review',
  'Weekly team report', 'Review the support queue', 'Team review of escalations',
  'Build the dashboard in Nova', 'Update the team wiki', 'Book team lunch', 'Check the support rota',
  'Review report layout', 'Team survey review', 'Support review agenda', 'Report on queue health',
  'Team check-in', 'Prepare the support report',
];

function task(id, text, created = '2026-10-29 09:17:36', extra = {}) {
  return { id, text, status: 'open', created_at: created, ms_id: null, recurrence_json: null, ...extra };
}
function ctxWith(tasks) { return tde.buildContext([...tasks, ...FILLER.map((t, i) => task(900 + i, t))], PEOPLE); }
const SCREENSHOTS = task(485, 'Send Lucy and Suraj screenshots of the queues and links to their default views');
const mail = (over = {}) => ({ id: 'AAMkAGI1-msg-1', subject: 'Queue screenshots and default view links', to: ['lucy.hart@nurtur.tech'], cc: ['suraj.patel@nurtur.tech'], sentAt: '2026-10-29T14:02:00Z', ...over });

test.before(async () => { await db.init(); });

// ── Which tasks an email can satisfy ─────────────────────────────────────────

test('a communication task is one whose ACT is a communication, not one that mentions email', () => {
  const ctx = { firstNames: new Set(['lucy', 'heidi']) };
  assert.equal(tde.isCommunicationTask('Send Lucy and Suraj screenshots of the queues', ctx), true);
  assert.equal(tde.isCommunicationTask('Nick to reply formally to Stephen’s flexible working request', ctx), true);
  assert.equal(tde.isCommunicationTask('Set and confirm Heidi’s end date before September 30', ctx), true);
  assert.equal(tde.isCommunicationTask('Email Heidi the notes', ctx), true);
  // Live false positives this rule was tightened against (1 Nov 2026):
  assert.equal(tde.isCommunicationTask('NT-31244: TPFG AI Email Editor Feedback from TPFG', ctx), false);
  assert.equal(tde.isCommunicationTask('Email template QA checklist operational (Outlook, Gmail)', ctx), false);
  assert.equal(tde.isCommunicationTask('Build the escalation dashboard and share it later', ctx), false);
});

// ── Sent email ──────────────────────────────────────────────────────────────

test('sent email: the right mail, after the task, to the people it names, sharing distinctive words', () => {
  const ctx = ctxWith([SCREENSHOTS]);
  const r = tde.judgeSentEmail(SCREENSHOTS, mail(), ctx, { self: new Set(['nickw@nurtur.tech']) });
  assert.ok(r, 'expected evidence');
  assert.equal(r.kind, 'sent-email');
  assert.equal(r.rule, 'done-sent-email@1');
  assert.match(r.say, /^Sent “Queue screenshots and default view links” to Lucy Hart, Thu 29 Oct$/);
  assert.ok(!JSON.stringify(r).includes('AAMk'), 'a message id never leaves the module');
});

test('sent email NEGATIVE: one generic shared word is not a reference', () => {
  const ctx = ctxWith([SCREENSHOTS]);
  assert.equal(tde.judgeSentEmail(SCREENSHOTS, mail({ subject: 'Team queue' }), ctx, {}), null);
  assert.equal(tde.judgeSentEmail(SCREENSHOTS, mail({ subject: 'Screenshots' }), ctx, {}), null);
  // One rare word on a short task covers most of it — still one word.
  const onb = task(602, 'Send Heidi the onboarding spreadsheet');
  const c2 = ctxWith([onb]);
  assert.equal(tde.judgeSentEmail(onb, mail({ subject: 'Spreadsheet', to: ['heidi.power@nurtur.tech'], cc: [] }), c2, {}), null);
  assert.ok(tde.judgeSentEmail(onb, mail({ subject: 'Onboarding spreadsheet', to: ['heidi.power@nurtur.tech'], cc: [] }), c2, {}), 'positive control');
  // The verb itself is not a shared content word.
  assert.equal(tde.judgeSentEmail(onb, mail({ subject: 'Sending the spreadsheet', to: ['heidi.power@nurtur.tech'], cc: [] }), c2, {}), null);
});

test('sent email NEGATIVE: automated mail in his name does not count', () => {
  const ctx = ctxWith([SCREENSHOTS]);
  assert.equal(tde.judgeSentEmail(SCREENSHOTS, mail({ subject: 'Nicholas Ward has shared Queue screenshots default views with you' }), ctx, {}), null);
  assert.equal(tde.judgeSentEmail(SCREENSHOTS, mail({ subject: 'Accepted: Queue screenshots and default views' }), ctx, {}), null);
});

test('sent email NEGATIVE: mail sent before the task existed is about something else', () => {
  const ctx = ctxWith([SCREENSHOTS]);
  assert.equal(tde.judgeSentEmail(SCREENSHOTS, mail({ sentAt: '2026-10-29T09:00:00Z' }), ctx, {}), null);
});

test('sent email NEGATIVE: a task whose act is not a communication is not done by an email about it', () => {
  const build = task(600, 'Build queue screenshots default views dashboard');
  const ctx = ctxWith([build]);
  assert.equal(tde.judgeSentEmail(build, mail({ subject: 'Queue screenshots default views dashboard' }), ctx, {}), null);
});

test('sent email NEGATIVE: the task names who it is for, and the mail went to someone else', () => {
  const ctx = ctxWith([SCREENSHOTS]);
  assert.equal(tde.judgeSentEmail(SCREENSHOTS, mail({ to: ['someone.else@nurtur.tech'], cc: [] }), ctx, {}), null);
  // and a note to himself is not doing it
  assert.equal(tde.judgeSentEmail(task(601, 'Send the escalation screenshots and default views'), mail({ to: ['nickw@nurtur.tech'], cc: [] }), ctxWith([]), { self: new Set(['nickw@nurtur.tech']) }), null);
});

// ── Daily-note ticks ─────────────────────────────────────────────────────────

test('daily tick: the task marker, either form, and only for THAT task', () => {
  const t = task(443, 'Complete assigned Project Harbour three-way property checks', '2026-10-19 10:00:00');
  const ctx = ctxWith([t]);
  const line = (text) => ({ date: '2026-10-20', path: 'Daily/2026-10-20.md', lineNo: 9, text });
  const a = tde.judgeDailyTick(t, line('- [x] Harbour checks (task #443) — 09:00 block #focus'), ctx);
  assert.ok(a); assert.equal(a.detail.basis, 'marker');
  assert.equal(a.say, 'Ticked in your daily note, Tue 20 Oct: “Harbour checks”');
  assert.ok(tde.judgeDailyTick(t, line('- [x] Harbour checks <!--task:443-->'), ctx));
  assert.equal(tde.judgeDailyTick(t, line('- [x] Project Harbour three-way property checks (task #444)'), ctx), null, 'a marker naming another task');
  assert.equal(tde.judgeDailyTick(t, line('- [ ] Harbour checks (task #443)'), ctx), null, 'not ticked');
});

test('daily tick: wording at FOLD_SCORE; NEGATIVE before the task existed or a loose overlap', () => {
  const t = task(233, 'Set SFIA roles for each role in team', '2026-09-01 08:00:00');
  const ctx = ctxWith([t]);
  const l = (date, text) => ({ date, path: `Daily/${date}.md`, lineNo: 3, text });
  assert.ok(tde.judgeDailyTick(t, l('2026-09-02', '- [x] Set SFIA roles for each role in team (11-12) #focus'), ctx));
  assert.equal(tde.judgeDailyTick(t, l('2026-08-31', '- [x] Set SFIA roles for each role in team'), ctx), null, 'ticked before it was a task');
  assert.equal(tde.judgeDailyTick(t, l('2026-09-02', '- [x] Review team roles'), ctx), null, 'loose overlap');
});

// ── Microsoft and Jira ───────────────────────────────────────────────────────

test('linked Planner task complete is evidence; open or removed is not', () => {
  const t = task(58, 'Build succession plan', '2026-08-13 12:00:00', { ms_id: 'g2D7' });
  assert.ok(tde.judgeMsComplete(t, { system: 'ms-planner', status: 'completed', completed_at: '2026-10-30T09:00:00Z', removed: 0 }));
  assert.equal(tde.judgeMsComplete(t, { system: 'ms-planner', status: 'open', removed: 0 }), null);
  assert.equal(tde.judgeMsComplete(t, { system: 'ms-planner', status: 'completed', removed: 1 }), null);
});

test('a named Jira ticket resolved is evidence; unresolved is not', () => {
  const t = task(70, 'NT-1234: chase the feed fix');
  assert.equal(tde.judgeJira(t, { key: 'NT-1234', status: 'Done', resolved: true }).say, 'NT-1234 is Done in Jira');
  assert.equal(tde.judgeJira(t, { key: 'NT-1234', status: 'In Progress', resolved: false }), null);
});

// ── The pass, the store, the read ────────────────────────────────────────────

function seedTask(text, created) {
  const row = taskStore.createTask({ text, source: 'test' });
  db.run('UPDATE tasks SET created_at = ? WHERE id = ?', [created, row.id]);
  return row.id;
}

let IDS = {};
test('refresh: real DB + temp vault + stubbed Sent Items; reads write nothing', async () => {
  const at = new Date().toISOString();
  for (const p of PEOPLE) {
    const pid = `person:${p.name.toLowerCase().replace(/\s+/g, '-')}`;
    db.run(`INSERT INTO wm_people (person_id, display_name, provenance_kind, first_observed_at, last_observed_at, evidence_json, updated_at) VALUES (?,?,?,?,?,?,?)`, [pid, p.name, 'observation', at, at, '[]', at]);
    for (const e of p.emails) db.run(`INSERT INTO wm_person_identities (kind, value, person_id, method, evidence_event_id, observed_at) VALUES ('email',?,?,'vault-declared','ev',?)`, [e, pid, at]);
  }
  for (const f of FILLER) seedTask(f, '2026-10-01 09:00:00');
  IDS.screens = seedTask('Send Lucy and Suraj screenshots of the queues and links to their default views', '2026-10-29 09:17:36');
  IDS.sfia = seedTask('Set SFIA roles for each role in team', '2026-09-01 08:00:00');
  IDS.nothing = seedTask('Draft the escalation policy for tier two', '2026-10-20 09:00:00');
  fs.writeFileSync(path.join(VAULT, 'Daily', '2026-10-30.md'), `# Friday\n\n## Focus Today\n- [x] Set SFIA roles for each role in team #focus\n- [ ] Draft the escalation policy\n`);

  let fetched = 0;
  const deps = { now: NOW, vaultRoot: VAULT, selfEmails: async () => ['nickw@nurtur.tech'],
    fetchSent: async () => { fetched += 1; return { messages: [mail()], complete: true }; } };
  const r = await tde.refresh({ now: NOW, deps });
  assert.equal(r.ok, true);
  assert.equal(fetched, 1);

  const before = db.getState(tde.STORE_KEY);
  const out = tde.read();
  assert.equal(db.getState(tde.STORE_KEY), before, 'a read writes nothing');
  const byId = new Map(out.items.map((i) => [i.taskId, i]));
  assert.ok(byId.get(IDS.screens), 'the email offer');
  assert.match(byId.get(IDS.screens).say, /^Sent “Queue screenshots/);
  assert.ok(byId.get(IDS.sfia), 'the tick offer');
  assert.equal(byId.has(IDS.nothing), false, 'an unticked line is not evidence');
  assert.deepEqual(out.gaps, []);
  // NEURO never closed anything itself.
  assert.equal(taskStore.getTask(IDS.screens).status, 'open');
  assert.equal(taskStore.getTask(IDS.sfia).status, 'open');
});

test('an unreadable source is a NAMED GAP, and its last evidence is carried, never dropped', async () => {
  const r = await tde.refresh({ now: NOW, deps: { now: NOW, vaultRoot: path.join(tmp, 'missing'), selfEmails: async () => [], fetchSent: async () => null } });
  const sources = r.gaps.map((g) => g.source).sort();
  assert.deepEqual(sources, ['daily-notes', 'sent-mail']);
  const out = tde.read();
  const ids = out.items.map((i) => i.taskId);
  assert.ok(ids.includes(IDS.screens) && ids.includes(IDS.sfia), 'carried forward');
  assert.equal(out.gaps.length, 2);
});

test('"not yet" suppresses THAT evidence; a newer piece is offered again', async () => {
  const deps = { now: NOW, vaultRoot: VAULT, selfEmails: async () => ['nickw@nurtur.tech'], fetchSent: async () => ({ messages: [mail()], complete: true }) };
  await tde.refresh({ now: NOW, deps });
  assert.equal(tde.notYet(IDS.screens).ok, true);
  assert.equal(tde.read().items.some((i) => i.taskId === IDS.screens), false);
  await tde.refresh({ now: NOW, deps });
  assert.equal(tde.read().items.some((i) => i.taskId === IDS.screens), false, 'the same evidence stays suppressed');
  deps.fetchSent = async () => ({ messages: [mail(), mail({ id: 'AAMk-msg-2', sentAt: '2026-10-30T11:00:00Z', subject: 'RE: Queue screenshots and default view links' })], complete: true });
  await tde.refresh({ now: NOW, deps });
  const again = tde.read().items.find((i) => i.taskId === IDS.screens);
  assert.ok(again, 'newer evidence re-offers');
  assert.equal(again.evidence.length, 1);
  assert.match(again.say, /RE: Queue screenshots/);
});

// ── Routes ───────────────────────────────────────────────────────────────────

test('routes: GET, close = the normal completion, not-yet; machines refused by the matrix', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('../routes/task-done-evidence'));
  app.use('/api/tasks', require('../routes/tasks'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = await fetch(`${base}/api/tasks/done-evidence`).then((r) => r.json());
    assert.equal(g.ok, true);
    assert.ok(g.items.some((i) => i.taskId === IDS.sfia));

    const c = await fetch(`${base}/api/tasks/${IDS.sfia}/done-evidence/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(c.status, 200);
    assert.equal(taskStore.getTask(IDS.sfia).status, 'done');
    const act = db.all(`SELECT * FROM activity_log WHERE event_type = 'task_done'`);
    assert.ok(act.length >= 1, 'the ordinary completion logs a task_done (wins count it)');
    const again = await fetch(`${base}/api/tasks/${IDS.sfia}/done-evidence/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 409);
    assert.equal((await fetch(`${base}/api/tasks/done-evidence`).then((r) => r.json())).items.some((i) => i.taskId === IDS.sfia), false);

    const n = await fetch(`${base}/api/tasks/${IDS.nothing}/done-evidence/not-yet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(n.status, 404, 'nothing offered → nothing to suppress');
  } finally { server.close(); }

  const m = require('./authority-matrix');
  assert.equal(m.machineDecision('POST', `/api/tasks/${IDS.sfia}/done-evidence/close`).allow, false);
  assert.equal(m.machineDecision('POST', `/api/tasks/${IDS.sfia}/done-evidence/not-yet`).allow, false);
});
