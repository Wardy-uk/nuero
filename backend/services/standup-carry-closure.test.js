'use strict';

/**
 * A commitment Nick has confirmed finished must STAY finished.
 *
 * On 16 Sep 2026 the morning standup carried four items forward — the NOVA AI
 * messaging changes, Naomi's metrics for HR, the NDC team split, the full
 * podcast — that he had confirmed done on 11 Sep, AGAIN on 14 Sep, and again at
 * the EOD on 15 Sep. The stored sessions show why, three faults deep:
 *
 *   1. resolve_commitment lived only in the SESSION. The morning note rendered
 *      it as a `## Decided` line, and nothing ever read that section back.
 *      Carry-forwards are rebuilt from unticked lines over 14 days, so the
 *      newest READABLE mention of each item was still an unticked line from
 *      9–11 Sep.
 *   2. The EOD renderer ignored decisions entirely, and the EOD prompt never
 *      asked for one — the 15 Sep session holds `commitments: []` beside a
 *      conversation that told him they were cleared.
 *   3. An EOD `**Done:**` bullet was deliberately "evidence, never a tick".
 *
 * These run the REAL tool executor, renderers, ledger, task store and parser
 * against a scratch DB and vault. The only thing arranged by hand is which day
 * each note belongs to.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-carry-closure-'));
process.env.NEURO_DB_PATH = path.join(root, 'carry.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
const DAILY = path.join(process.env.OBSIDIAN_VAULT_PATH, 'Daily');
fs.mkdirSync(DAILY, { recursive: true });
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });

const db = require('../db/database');
const acc = require('./standup-accountability');
const session = require('./standup-session');
const ledger = require('./commitment-ledger');
const taskStore = require('./task-store');

test.before(async () => { await db.init(); });

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const file = (offset) => path.join(DAILY, `${dayKey(offset)}.md`);
const write = (offset, body) => fs.writeFileSync(file(offset), body);
const append = (offset, body) => fs.appendFileSync(file(offset), body);

// Stock vocabulary so IDF weighting behaves as it does on the live notes (33
// keys), rather than as it does over a pool of two. Distinct from every item
// under test.
const FILLER = [
  'Review QA scores with the team leads',
  'Update the support rota for next month',
  'Chase development on the reporting issue',
  'Prepare the monthly support KPI pack',
  'Plan the team meeting agenda',
  'Check overtime claims and approve',
];

function reset() {
  for (const f of fs.readdirSync(DAILY)) fs.unlinkSync(path.join(DAILY, f));
  db.setState(ledger.STATE_KEY, '');
}

const focus = (...lines) => ['## Focus Today', ...lines.map(l => `- [ ] ${l}`), ...FILLER.map(l => `- [ ] ${l}`)].join('\n') + '\n';
const openTexts = (a) => a.openCommitments.map(c => c.text);
const closedBy = (a, re) => a.closedCommitments.find(c => re.test(c.text));

const PODCAST = 'Record full podcast';
const METRICS = "Provide Naomi's in-office vs WFH ticket metrics to HR";

// ── 1 → 4: the whole day, end to end ────────────────────────────────────────

test('confirmed done in the morning: the EOD sees it closed and the next morning does not carry it', async () => {
  reset();
  // 1. Committed three days ago, so it is carried into yesterday's standup.
  write(-3, focus(PODCAST, METRICS));
  const morningCtx = { dateKey: dayKey(-1), accountability: acc.buildAccountability() };
  const carried = morningCtx.accountability.openCommitments.find(c => c.text === PODCAST);
  assert.ok(carried, '1: the commitment is not offered in the morning standup');

  // 2. Nick confirms it is done — through the real tool executor.
  const morning = session._emptySession('standup', morningCtx);
  const res = await session.executeTool(morning, 'resolve_commitment', { key: carried.key, decision: 'done' });
  assert.equal(res.ok, true);
  assert.ok(ledger.list().some(e => e.key === carried.key && e.decision === 'done'), '2: the decision was not persisted');
  write(-1, session._renderDailyNote(morning));
  assert.match(fs.readFileSync(file(-1), 'utf8'), /~~Record full podcast~~ \(already done\)/,
    'the morning note lost its Decided line once the ledger closed the item');

  // 3. That evening's EOD, holding the morning's (now stale) context.
  const eod = session._emptySession('eod', { dateKey: dayKey(-1), accountability: acc.buildAccountability() });
  assert.ok(!openTexts(eod.context.accountability).includes(PODCAST), '3: EOD context still carries it');
  assert.equal(closedBy(eod.context.accountability, /full podcast/).decision, 'done');

  // 4. The following morning.
  const next = acc.buildAccountability();
  assert.ok(!openTexts(next).includes(PODCAST), '4: the next standup resurrected it');
  assert.ok(openTexts(next).includes(METRICS), 'an UNRESOLVED commitment must still carry');
});

test('confirmed done at the EOD: the decision is written down, and the next morning does not carry it', async () => {
  reset();
  write(-3, focus(METRICS));
  const eod = session._emptySession('eod', { dateKey: dayKey(-1), accountability: acc.buildAccountability() });
  const c = eod.context.accountability.openCommitments.find(x => x.text === METRICS);
  const res = await session.executeTool(eod, 'resolve_commitment', { key: c.key, decision: 'done' });
  assert.equal(res.ok, true);

  // The EOD section itself now carries the decision — it used to write nothing.
  const section = session._renderEodSection(eod);
  assert.match(section, /## Decided[\s\S]*~~Provide Naomi's in-office vs WFH ticket metrics to HR~~ \(already done\)/);
  write(-1, section);

  const next = acc.buildAccountability();
  assert.ok(!openTexts(next).includes(METRICS), 'EOD confirmation did not survive to the next morning');
});

test('an EOD Done bullet in his own words closes the matching commitment', () => {
  reset();
  write(-3, focus(PODCAST));
  write(-1, ['## EOD', '', '**Done:**', `- ${PODCAST}`, "**Didn't go to plan:** Nothing"].join('\n'));
  const a = acc.buildAccountability({ ledger: [] });
  assert.ok(!openTexts(a).includes(PODCAST));
  assert.equal(closedBy(a, /full podcast/).source, 'eod');
});

// ── 5: history cannot resurrect ─────────────────────────────────────────────

test('the existing `## Decided` lines close history — the 16 Sep data repairs itself with an empty ledger', () => {
  reset();
  // The real shape: unticked lines on older days, decided "already done" later.
  write(-6, focus(PODCAST, METRICS));
  write(-5, focus(PODCAST, METRICS));
  write(-2, ['## Focus Today', '- [ ] Weekly report to Chris #focus', '', '## Decided',
    `- ~~${PODCAST}~~ (already done)`, `- ~~${METRICS}~~ (already done)`].join('\n'));
  const a = acc.buildAccountability({ ledger: [] });
  assert.ok(!openTexts(a).includes(PODCAST));
  assert.ok(!openTexts(a).includes(METRICS));
  assert.equal(closedBy(a, /full podcast/).source, 'decided');
  assert.ok(openTexts(a).includes('Weekly report to Chris'), 'a live commitment on the same note was closed too');
});

test('a line linked to a FINISHED task is not carried, whatever the note says', () => {
  reset();
  const t = taskStore.createTask({ text: 'Transcribe the leadership meeting fixture', source: 'manual', skipExport: true });
  taskStore.updateTask(t.id, { status: 'done' });
  write(-2, `## Focus Today\n- [ ] Transcribe the leadership meeting fixture #focus <!--task:${t.id}-->\n`);
  const a = acc.buildAccountability({ ledger: [] });
  assert.ok(!openTexts(a).includes('Transcribe the leadership meeting fixture'));
  assert.equal(closedBy(a, /leadership meeting fixture/).source, 'task');
});

test('committing to it AGAIN after it was closed makes it live again — that is the way back', () => {
  reset();
  write(-4, focus(PODCAST));
  ledger.record({ key: acc.commitmentKey(PODCAST), text: PODCAST, decision: 'done', date: dayKey(-3) });
  write(-1, focus(PODCAST)); // picked back up after the closure
  assert.ok(openTexts(acc.buildAccountability()).includes(PODCAST));
});

// ── 6: duplicates ───────────────────────────────────────────────────────────

test('a reworded duplicate of a closed commitment does not bring it back', async () => {
  reset();
  write(-4, focus("Verify and compile Phillipa's email response"));
  write(-3, focus('Verify and compile her response'));
  const before = acc.buildAccountability();
  assert.ok(openTexts(before).includes("Verify and compile Phillipa's email response"));
  assert.ok(openTexts(before).includes('Verify and compile her response'), 'fixture: two keys for one job');

  const s = session._emptySession('standup', { dateKey: dayKey(-1), accountability: before });
  const key = acc.commitmentKey("Verify and compile Phillipa's email response");
  assert.equal((await session.executeTool(s, 'resolve_commitment', { key, decision: 'done' })).ok, true);

  const after = acc.buildAccountability();
  assert.ok(!openTexts(after).some(t => /verify and compile/i.test(t)), 'the duplicate record resurfaced the closed job');
});

test('a merely RELATED commitment is not closed by a duplicate match — the measured false positives stay live', () => {
  reset();
  // Both of these scored 1.00 on containment against the closed item on the
  // live notes, and both are different work.
  write(-3, focus('Produce support podcast script with Ricky, ideally full podcast recording', 'NDC data fixes'));
  ledger.record({ key: acc.commitmentKey(PODCAST), text: PODCAST, decision: 'done', date: dayKey(-1) });
  ledger.record({
    key: acc.commitmentKey('NOVA changes to split NDC team in dev review queue and data fixes'),
    text: 'NOVA changes to split NDC team in dev review queue and data fixes', decision: 'done', date: dayKey(-1),
  });
  const a = acc.buildAccountability();
  assert.ok(openTexts(a).some(t => /podcast script/i.test(t)), 'recording the podcast closed the SCRIPT commitment');
  assert.ok(openTexts(a).includes('NDC data fixes'), 'closing the whole NDC change closed a part of it by wording alone');
});

// ── 7: a stored session cannot serve a stale list ───────────────────────────

test('a session started before a closure is reconciled when it is resumed, and when it is finished', async () => {
  reset();
  write(-3, focus(PODCAST, METRICS));
  // Today's session, stored with the list as it was when it was started.
  const stale = session._emptySession('standup', { dateKey: dayKey(0), accountability: acc.buildAccountability() });
  session.save(stale);
  assert.ok(openTexts(stale.context.accountability).includes(PODCAST), 'fixture: the stored context carries it');

  // Closed somewhere else afterwards — another surface, an EOD, a task tick.
  ledger.record({ key: acc.commitmentKey(PODCAST), text: PODCAST, decision: 'done', date: dayKey(0) });

  const resumed = await session.start('standup'); // existing, unfinished → returned without a model call
  assert.ok(!openTexts(resumed.context.accountability).includes(PODCAST), 'resume served the pre-closure list');
  // Only the CARRIED block — the scoreboard of what that note held may name it.
  const carriedBlock = (session._renderContext(resumed.context).split('CARRIED')[1] || '').split('\n\n')[0];
  assert.ok(carriedBlock.includes(METRICS.slice(0, 30)), 'fixture: the carried block is where this reads');
  assert.ok(!carriedBlock.includes(PODCAST), 'the model would still be told to chase it');
  assert.ok(openTexts(session.load('standup').context.accountability).includes(METRICS), 'reconcile threw away live work');
  assert.ok(!openTexts(session.load('standup').context.accountability).includes(PODCAST), 'the reconciled context was not saved');
});

test('the prompts tell both rituals to record a confirmation, and never to claim one that did not save', () => {
  const src = fs.readFileSync(path.join(__dirname, 'standup-session.js'), 'utf8');
  const eodPrompt = src.split('const EOD_PROMPT')[1].split('`;')[0];
  assert.match(eodPrompt, /resolve_commitment/, 'the EOD is never asked to record a decision');
  assert.equal((src.match(/Never tell him something is\s+"?cleared"?\s+unless\s+resolve_commitment\s+came back ok/g) || []).length, 2);
});
