'use strict';

/**
 * Progress evidence (Build 5D).
 *
 *   run: node --test backend/services/progress-evidence.test.js
 *
 * The rule this file exists to hold: a sent email nearby, or a ticked line in
 * a later note, is EVIDENCE — an observation — and the most it can ever become
 * is the inference `likely_fulfilled`. It never completes a commitment. Only
 * the owning source does that, and when that source says "open" after the
 * evidence, the source wins.
 *
 * Driven through the real producers (scanSentMail with a stubbed Graph answer,
 * scanLaterNotes over a real temp vault) into the real fold.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-pe-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'pe.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const VAULT = path.join(tmp, 'vault');
process.env.OBSIDIAN_VAULT_PATH = VAULT;

const db = require('../db/database');
const bus = require('./event-bus');
const wm = require('./world-model');
const ws = require('./world-sources');
const src = require('./obligation-sources');
const wo = require('./world-obligations');
const pe = require('./progress-evidence');

test.before(async () => { await db.init(); });

const NOW = Date.parse('2026-10-03T09:00:00Z');
let seq = NOW;
const pump = () => bus.pumpConsumer(wm.CONSUMER, { now: Date.now() });
async function reconcile() { seq += 1000; src.reconcile({ now: seq }); await pump(); }

let n = 0;
function addTask(fields) {
  const id = 700 + (++n);
  const row = { id, text: `task ${id}`, status: 'open', source: 'meeting-promotion', dedupe_key: `k${id}`, created_at: '2026-09-28 11:00:00', ...fields };
  const cols = Object.keys(row);
  db.run(`INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
  return id;
}
const setTask = (id, f) => db.run(`UPDATE tasks SET ${Object.keys(f).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), id]);

function declare(name, email) {
  const p = ws.personPayload(name, `People/${name}.md`, email ? { email } : {});
  bus.publishEvent({ type: 'observation.person.declared', occurredAt: new Date(NOW).toISOString(), source: { system: 'vault' },
    idempotencyKey: `pd:${p.personId}:${p.fingerprint}`, payload: p });
}
function write(rel, body) {
  fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true });
  fs.writeFileSync(path.join(VAULT, rel), body);
}

const SRC_NOTE = 'Meetings/2026/09/2026-09-28 – Support leadership.md';
const msg = (id, subject, to, sentAt, extra = {}) => ({ id, subject, to, cc: [], sentAt, hasAttachments: false, ...extra });
const scanMail = (messages) => pe.scanSentMail({ now: NOW, deps: { selfEmails: async () => ['nickw@nurtur.tech'], fetchSent: async () => (messages === null ? null : { messages, complete: true }) } });
const okCoverage = { sentMail: 'ok', laterNotes: 'ok', scannedAt: 'x' };
const prog = (cid) => pe.progressFor(cid, { cov: okCoverage });

test.before(async () => {
  declare('Nick Ward');
  declare('Chris Middleton', 'chris.middleton@nurtur.tech');
  declare('Hope Goodall', 'hope.goodall@nurtur.tech');
  write(SRC_NOTE, '---\nplaud_id: "f15f43b4c99245b470ae064a1cfd2c01"\nstart_at: "2026-09-28T08:00:00"\n---\n- [ ] Nick to send the support figures to Chris Middleton\n');
  await pump();
});

// ── pure matching rules ─────────────────────────────────────────────────────

test('a sent email is only evidence when it goes to the counterparty AND shares content words — "sent Chris an email" is nothing', () => {
  const c = { description: 'Nick to send the support figures to Chris Middleton', direction: 'by-nick', createdAt: '2026-09-28 11:00:00' };
  const targets = new Set(['chris.middleton@nurtur.tech']);
  const names = ['Chris Middleton', 'Nick Ward'];
  assert.equal(pe.matchSentEmail(c, msg('1', 'Lunch on Friday?', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z'), { targets, names }), null);
  assert.equal(pe.matchSentEmail(c, msg('2', 'Support figures', ['someone@else.test'], '2026-09-29T10:00:00Z'), { targets, names }), null, 'right subject, wrong person');
  assert.equal(pe.matchSentEmail(c, msg('3', 'Support figures', ['chris.middleton@nurtur.tech'], '2026-09-27T10:00:00Z'), { targets, names }), null, 'before the commitment was made');
  assert.equal(pe.matchSentEmail(c, msg('4', 'Re: Chris', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z'), { targets, names }), null, 'a name in the subject is not a content word');
  const strong = pe.matchSentEmail(c, msg('5', 'September support figures', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z'), { targets, names });
  assert.equal(strong.polarity, 'done');
  assert.equal(strong.strength, 'strong');
  const one = pe.matchSentEmail(c, msg('6', 'Figures', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z'), { targets, names });
  assert.equal(one.polarity, 'progress', 'one shared word is progress, never done');
});

test('an email about a commitment that is NOT a communication is progress at most', () => {
  const c = { description: 'Nick to build the escalation dashboard', direction: 'by-nick', createdAt: '2026-09-28 11:00:00' };
  const r = pe.matchSentEmail(c, msg('7', 'Escalation dashboard draft', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z'),
    { targets: new Set(['chris.middleton@nurtur.tech']), names: ['Chris Middleton'] });
  assert.equal(r.polarity, 'progress');
  assert.match(r.reason, /not a communication/);
});

test('note lines: a tick is done, an unticked box or "still outstanding" is open, a plain re-listing is nothing', () => {
  assert.equal(pe.classifyLine('- [x] Nick to send the figures').polarity, 'done');
  assert.equal(pe.classifyLine('- [ ] Nick to send the figures').polarity, 'not-done');
  assert.equal(pe.classifyLine('- Nick to send the figures'), null, 'a plain restatement says nothing about whether it happened');
  assert.equal(pe.classifyLine('- Figures still outstanding from Nick').polarity, 'not-done');
  assert.equal(pe.classifyLine('- Nick sent the figures to Chris').polarity, 'done');
  assert.equal(pe.classifyLine('- Nick will have sent the figures by Friday'), null, 'future tense is not done — and not evidence either way');
  assert.equal(pe.classifyLine('Some prose that is not a bullet'), null);
});

// ── 15–21 through the real fold ─────────────────────────────────────────────

test('15. an authoritative completion is a FACT: fulfilled, with its authority', async () => {
  const id = addTask({ text: 'Nick to send the rota to Chris Middleton', origin_path: SRC_NOTE });
  await reconcile();
  setTask(id, { status: 'done' });
  await reconcile();
  const p = prog(`commitment:task:${id}`);
  assert.equal(p.state, 'fulfilled');
  assert.equal(p.basis, 'fact');
});

let FIG;
test('16/19. a relevant sent email creates evidence → likely_fulfilled (an INFERENCE); the commitment stays OPEN', async () => {
  FIG = addTask({ text: 'Nick to send the support figures to Chris Middleton', origin_path: SRC_NOTE });
  await reconcile();
  const cid = `commitment:task:${FIG}`;
  assert.equal(prog(cid).state, 'no_evidence');
  const r = await scanMail([msg('M-1', 'September support figures', ['chris.middleton@nurtur.tech'], '2026-09-30T14:00:00Z', { hasAttachments: true })]);
  assert.ok(r.ok);
  await pump();
  const p = prog(cid);
  assert.equal(p.state, 'likely_fulfilled');
  assert.equal(p.basis, 'inference');
  assert.equal(p.evidence.length, 1);
  assert.equal(p.evidence[0].provenance, 'observation');
  assert.match(p.note, /not a completion/);
  // 19. inference alone does not complete it — nowhere.
  const c = wo.getCommitment(cid);
  assert.equal(c.status, 'open');
  assert.equal(wo.getTask(`task:neuro:${FIG}`).status, 'open');
  assert.equal(db.get(`SELECT COUNT(*) n FROM wm_obligation_history WHERE entity_id = ? AND change = 'completed'`, [cid]).n, 0);
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', [FIG]).status, 'open', 'the NEURO task row is never touched');
  // A re-scan of the same mail publishes nothing.
  const again = await scanMail([msg('M-1', 'September support figures', ['chris.middleton@nurtur.tech'], '2026-09-30T14:00:00Z', { hasAttachments: true })]);
  assert.equal(again.published, 0);
});

test('17. an unrelated sent email to the same person does not create evidence', async () => {
  const id = addTask({ text: 'Nick to share the QA rubric with Hope Goodall', origin_path: SRC_NOTE });
  await reconcile();
  await scanMail([msg('M-2', 'Lunch on Friday?', ['hope.goodall@nurtur.tech'], '2026-09-30T14:00:00Z')]);
  await pump();
  assert.equal(pe.evidenceFor(`commitment:task:${id}`).length, 0);
  assert.equal(prog(`commitment:task:${id}`).state, 'no_evidence');
});

test('18. a later meeting note can create bounded evidence; the same recording\'s other variant and the source note cannot', async () => {
  const id = addTask({ text: 'Nick to circulate the call routing proposal to the team', origin_path: SRC_NOTE });
  await reconcile();
  // Same recording (same plaud_id), written as a second variant: restates it by
  // construction. Dated LATER on purpose — re-pulls have been filed under the
  // sync date before (27 Aug 2026), so the date rule alone cannot be relied on.
  write('Meetings/2026/09/2026-09-30 – Support leadership 2.md', '---\nplaud_id: "of_f15f43b4c99245b470ae064a1cfd2c01"\n---\n- [x] Nick to circulate the call routing proposal to the team\n');
  let r = pe.scanLaterNotes({ now: NOW });
  await pump();
  assert.ok(r.ok);
  assert.equal(pe.evidenceFor(`commitment:task:${id}`).length, 0, 'a variant of the same recording is not "later"');
  // A genuinely later meeting ticks it.
  write('Meetings/2026/10/2026-10-02 – Support leadership.md', '---\nplaud_id: "f15f43b4c99245b470ae064a1cfd2c02"\n---\n## Actions\n- [x] Nick to circulate the call routing proposal to the team\n');
  r = pe.scanLaterNotes({ now: NOW });
  await pump();
  const ev = pe.evidenceFor(`commitment:task:${id}`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'later-note');
  assert.equal(ev[0].polarity, 'done');
  assert.equal(prog(`commitment:task:${id}`).state, 'likely_fulfilled');
  assert.equal(wo.getCommitment(`commitment:task:${id}`).status, 'open');
});

test('the two failures the live dry run found: a names-only line, and NEURO\'s own log line in a daily note, are not evidence', async () => {
  const id = addTask({ text: 'Nick to document the ticket types blocked by skill gaps for Nick Ward and Chris Middleton', origin_path: SRC_NOTE });
  await reconcile();
  // Exact shapes from the 3 Oct dry run on the live vault.
  write('Meetings/2026/10/2026-10-02 – Team standup.md', '---\nplaud_id: "f15f43b4c99245b470ae064a1cfd2c09"\n---\n## Attendees\n- [[Nick Ward]]\n- [[Chris Middleton]]\n- Nick Ward:\n');
  write('Daily/2026-10-02.md', '## SAiM Actions\n- 14:20 — Meeting prep: "Task block: Nick to document the ticket types blocked by skill gaps" in 15 min\n- [x] Nick to document the ticket types blocked by skill gaps\n');
  pe.scanLaterNotes({ now: NOW });
  await pump();
  const ev = pe.evidenceFor(`commitment:task:${id}`);
  assert.ok(!ev.some((e) => /Nick Ward|Chris Middleton\]\]/.test(e.detail.text)), 'a line of names is about nobody\'s commitment');
  assert.ok(!ev.some((e) => /Meeting prep/.test(e.detail.text)), 'NEURO\'s own log line is not Nick reporting');
  assert.equal(pe.lineCoverage(new Set(['nick', 'ward', 'document', 'ticket']), new Set(['nick', 'ward']), new Map(), new Set(['nick', 'ward'])).score, 0);
});

test('a daily note TICK under the SAiM Actions heading is still NEURO\'s section and ignored; under Focus Today it counts', async () => {
  const id = addTask({ text: 'Nick to circulate the weekend rota proposal', origin_path: SRC_NOTE });
  await reconcile();
  write('Daily/2026-10-01.md', '## SAiM Actions\n- [x] Nick to circulate the weekend rota proposal\n');
  pe.scanLaterNotes({ now: NOW }); await pump();
  assert.equal(pe.evidenceFor(`commitment:task:${id}`).length, 0);
  // A plain bullet in a daily note is never read, whatever its heading: NEURO
  // writes more sections than can be listed, and only a tick is unmistakably his.
  write('Daily/2026-10-01.md', '## Notes\n- Done: circulate the weekend rota proposal\n');
  assert.equal(pe.classifyLine('- Done: circulate the weekend rota proposal').polarity, 'done', 'control: the line itself reads as done');
  pe.scanLaterNotes({ now: NOW }); await pump();
  assert.equal(pe.evidenceFor(`commitment:task:${id}`).length, 0);
  write('Daily/2026-10-01.md', '## Focus Today\n- [x] Nick to circulate the weekend rota proposal\n');
  pe.scanLaterNotes({ now: NOW }); await pump();
  assert.equal(pe.evidenceFor(`commitment:task:${id}`)[0].polarity, 'done', 'positive control: his own tick counts');
});

test('20. a contradictory AUTHORITATIVE source beats inferred fulfilment', async () => {
  // (a) the evidence says done, then a NEWER note lists it as still open.
  const a = addTask({ text: 'Nick to send the escalation matrix to Chris Middleton', origin_path: SRC_NOTE });
  await reconcile();
  await scanMail([msg('M-3', 'Escalation matrix', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z')]);
  await pump();
  assert.equal(prog(`commitment:task:${a}`).state, 'likely_fulfilled', 'positive control: the email alone reads as likely done');
  write('Meetings/2026/10/2026-10-01 – Support leadership.md', '---\nplaud_id: "f15f43b4c99245b470ae064a1cfd2c03"\n---\n- Nick to send the escalation matrix to Chris Middleton (still outstanding)\n');
  pe.scanLaterNotes({ now: NOW });
  await pump();
  const pa = prog(`commitment:task:${a}`);
  assert.equal(pa.state, 'contradicted');
  assert.equal(pa.basis, 'fact');
  // (b) the evidence says done, then the owning source REOPENS it after the evidence.
  const b = addTask({ text: 'Nick to send the overtime report to Chris Middleton', origin_path: SRC_NOTE });
  await reconcile();
  await scanMail([msg('M-4', 'Overtime report', ['chris.middleton@nurtur.tech'], '2026-09-29T10:00:00Z')]);
  await pump();
  assert.equal(prog(`commitment:task:${b}`).state, 'likely_fulfilled');
  setTask(b, { status: 'done' }); await reconcile();
  setTask(b, { status: 'open' }); await reconcile();
  const pb = prog(`commitment:task:${b}`);
  assert.equal(pb.state, 'contradicted', 'reopened by its own source after the evidence: it is open, whatever the email suggested');
  assert.match(pb.reasons.join(' '), /reopened/);
});

test('commitment-risk HOLDS a likely-done commitment (recorded, with why) and never completes it', async () => {
  const cr = require('./commitment-risk');
  const id = addTask({ text: 'Nick to send the holiday cover plan to Chris Middleton', origin_path: SRC_NOTE,
    due_date: '2026-10-03', created_at: '2026-09-28 11:00:00' });
  // A STATED deadline today: without evidence this is a high finding.
  await reconcile();
  const cid = `commitment:task:${id}`;
  const deps = { calendarFreshness: () => 'fresh', laneDeferral: () => null, refreshProgress: null, prepareActions: null,
    progress: (x) => prog(x), readMoment: async () => ({ moment: { onDuty: true, known: true, muted: [] } }) };
  const before = cr.assess(wo.getCommitment(cid), { nowLocal: '2026-10-03T10:00', nowMs: NOW, deps: { ...deps, task: (t) => wo.getTask(t),
    waitingSnoozedUntil: () => null, plannedBlocks: () => [], projection: () => ({ lag: 0, retrying: 0 }), nextOccurrence: () => null, previousOccurrence: () => null } });
  assert.equal(before.finding, true, 'positive control: the deadline alone raises it');
  await scanMail([msg('M-9', 'Holiday cover plan', ['chris.middleton@nurtur.tech'], '2026-10-01T09:00:00Z')]);
  await pump();
  const after = cr.assess(wo.getCommitment(cid), { nowLocal: '2026-10-03T10:00', nowMs: NOW, deps: { ...deps, task: (t) => wo.getTask(t),
    waitingSnoozedUntil: () => null, plannedBlocks: () => [], projection: () => ({ lag: 0, retrying: 0 }), nextOccurrence: () => null, previousOccurrence: () => null } });
  assert.equal(after.finding, false);
  assert.equal(after.held, true);
  assert.match(after.why, /NOT marked complete/);
  assert.equal(wo.getCommitment(cid).status, 'open');
});

test('could not look is UNKNOWN, never no_evidence', async () => {
  const id = addTask({ text: 'Nick to forward the PIP pack to Chris Middleton', origin_path: SRC_NOTE });
  await reconcile();
  const r = await scanMail(null);
  assert.equal(r.ok, false);
  const p = pe.progressFor(`commitment:task:${id}`, { cov: { sentMail: 'unavailable', laterNotes: 'ok' } });
  assert.equal(p.state, 'unknown');
  assert.match(p.reasons[0], /could not look/);
});

test('21. replay reproduces every progress state', async () => {
  const ids = db.all('SELECT DISTINCT commitment_id FROM wm_progress_evidence').map((r) => r.commitment_id)
    .concat(db.all('SELECT commitment_id FROM wm_commitments').map((r) => r.commitment_id));
  const before = Object.fromEntries([...new Set(ids)].map((id) => [id, prog(id).state]));
  assert.ok(Object.values(before).includes('likely_fulfilled'));
  assert.ok(Object.values(before).includes('contradicted'));
  db.run('DELETE FROM wm_progress_evidence');
  const r = await bus.replayConsumer(wm.CONSUMER, { now: Date.now() });
  assert.equal(r.deadLettered, 0);
  const after = Object.fromEntries(Object.keys(before).map((id) => [id, prog(id).state]));
  assert.deepEqual(after, before);
});

test('nothing in this module can change a status: no writes to tasks, wm_commitments or wm_tasks', () => {
  const s = fs.readFileSync(path.join(__dirname, 'progress-evidence.js'), 'utf8');
  assert.doesNotMatch(s, /UPDATE\s+(tasks|wm_commitments|wm_tasks)\b/i);
  assert.doesNotMatch(s, /INSERT\s+INTO\s+(tasks|wm_commitments|wm_tasks)\b/i);
  assert.match(s, /INSERT INTO wm_progress_evidence/, 'positive control: the scan is looking at the right file');
});
