'use strict';

/**
 * Build 17R–U — meeting-prep convergence judged on INTERRUPTION value.
 * "Context belongs in prep. Risk/actionability earns interruption." (Nick,
 * 7 Oct 2026). Fixtures are the shapes of the real comparison rows of 5–7 Oct.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-b17m-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'm.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'People'), { recursive: true });
process.env.OBSIDIAN_VAULT_PATH = vault;
fs.writeFileSync(path.join(vault, 'People', 'Naomi Wentworth.md'), '---\nrole: Customer Service Agent (CSA)\nlast-1-2-1: 2026-08-25\nemail: naomi.wentworth@nurtur.tech\n---\nNaomi\n');

const db = require('../db/database');
const mi = require('./meeting-intelligence');
const prep = require('./meeting-prep');

test.before(async () => { await db.init(); });

const row = (start, title, old, neu) => ({ meeting_key: `graph:${title}@${start}`, title, start_local: start,
  old_json: old ? JSON.stringify(old) : null, new_json: neu ? JSON.stringify(neu) : null });
const NOTHING = { finding: false, why: 'nothing NEURO holds is specific to this meeting (or what it holds looks already done)', context: [] };
const BLOCK = { finding: false, why: 'not a meeting with other people (block)', context: [] };
// The live record, 5–7 Oct 2026 (abridged to the rows that decide).
const LIVE = [
  row('2026-10-05T09:00', 'Tech Leadership', { wouldNotify: false, why: 'no People note name part in the title' }, NOTHING),
  row('2026-10-05T10:30', 'Urgent - The London Office', { wouldNotify: false }, { finding: true, triggers: ['urgent-email-from-attendee'] }),
  row('2026-10-05T17:00', 'Plaud admin — Nick Catch Up', { wouldNotify: true, sent: true, matchedPeople: ['Nick Ward'] }, BLOCK),
  row('2026-10-06T10:30', 'Naomi Check In', { wouldNotify: true, sent: true, matchedPeople: ['Naomi Wentworth'] }, NOTHING),
  row('2026-10-06T10:55', 'Plaud admin — Naomi Check In', { wouldNotify: true, sent: true, matchedPeople: ['Naomi Wentworth'] }, BLOCK),
  row('2026-10-06T11:00', 'Task block: Nick to reply formally to Stephen', { wouldNotify: true, sent: true, matchedPeople: ['Nick Ward', 'Stephen Mitchell'] }, BLOCK),
  row('2026-10-06T16:30', 'Nick Catch Up', { wouldNotify: true, sent: true, matchedPeople: ['Nick Ward'] }, NOTHING),
  row('2026-10-07T09:00', 'Support Review', { wouldNotify: false }, { finding: true, triggers: ['urgent-email-from-attendee'] }),
  row('2026-10-07T12:00', 'Task block: Amend the NOVA Portal', { wouldNotify: false, why: 'solo block — nobody else is in it' }, BLOCK),
];

test('33. role-only context does not earn a push — it is context, and it lives in prep', () => {
  const r = row('2026-10-06T10:30', 'Naomi Check In', { wouldNotify: true, matchedPeople: ['Naomi Wentworth'], content: { role: true } }, NOTHING);
  assert.equal(mi.classifyComparison(r).pushValue, 'context-only');
});

test('34. last-1-2-1-only context does not earn a push either', () => {
  const r = row('2026-10-06T10:30', 'Naomi Check In', { wouldNotify: true, matchedPeople: ['Naomi Wentworth'], content: { last121: true } }, NOTHING);
  assert.equal(mi.classifyComparison(r).pushValue, 'context-only');
  // A legacy record from before the content field existed reads the same way.
  assert.equal(mi.classifyComparison(row('2026-10-06T10:30', 'Naomi Check In', { wouldNotify: true, matchedPeople: ['Naomi Wentworth'] }, NOTHING)).pushValue, 'context-only');
});

const meeting = { meetingId: 'graph:W', title: 'Weekly with Naomi', start: '2026-10-08T10:00', people: [] };
const noProgress = { risks: [], waitingIdOf: (k) => k, preparedOf: () => null, progressOf: () => ({ state: 'no_evidence', reasons: [] }) };

test('35. an open commitment from the last occurrence CAN earn an interruption', () => {
  const gathered = { evidence: { previous: { start: '2026-10-01T10:00' }, commitments: [{ taskId: 1, text: 'Nick to send the rota' }], owedFromPrevious: [], emails: [], attendeeOwed: [], otherEmails: 0 }, missing: [] };
  const c = mi.compose(meeting, gathered, noProgress);
  assert.deepEqual(c.triggers, ['open-commitments-from-previous']);
  const v = require('./ambient-push').worthInterrupting({ kind: 'meeting-context', text: mi.summarise(meeting, c) }, { known: true, onDuty: true, now: new Date() });
  assert.equal(v.push, true, 'the attention rule would let it through on duty');
});

test('36. a material meeting risk (a linked commitment-risk finding) CAN earn an interruption', () => {
  const gathered = { evidence: { previous: { start: '2026-10-01T10:00' }, commitments: [], owedFromPrevious: [], emails: [], attendeeOwed: [], otherEmails: 0 }, missing: [] };
  // A commitment-risk finding that matters BECAUSE this meeting is near (its real shape).
  const risks = [{ findingId: 'cr:1', commitmentId: 'c1', level: 'high', summary: 'Naomi owes the rota', relatedMeeting: { meetingId: 'graph:W' }, triggers: [{ kind: 'meeting-near' }] }];
  const c = mi.compose(meeting, gathered, { ...noProgress, risks });
  assert.deepEqual(c.triggers, ['linked-commitment-risk']);
  assert.equal(c.linked.here[0].findingId, 'cr:1');
  // A risk that matters on its own (a deadline) is raised there, not here — never twice.
  const own = mi.compose(meeting, gathered, { ...noProgress, risks: [{ ...risks[0], triggers: [{ kind: 'due-today' }] }] });
  assert.deepEqual(own.triggers, []); assert.equal(own.linked.elsewhere.length, 1);
  const plain = mi.compose(meeting, { ...gathered }, noProgress);
  assert.deepEqual(plain.triggers, [], 'positive control: no risk, no commitment, no trigger');
  const urgent = { evidence: { previous: null, commitments: [], owedFromPrevious: [], emails: [{ id: 'e1', subject: 'Weekly rota problem', from: 'naomi.wentworth@nurtur.tech' }], attendeeOwed: [], otherEmails: 0 }, missing: [] };
  assert.deepEqual(mi.compose(meeting, urgent, noProgress).triggers, ['urgent-email-from-attendee'], 'an unanswered urgent email from someone in the room is a trigger');
});

test('37. a solo block stays suppressed — even with the legacy push switched back on', async () => {
  const me = 'nickw@nurtur.tech';
  assert.equal(prep.soloBlock({ attendees: [{ email: me }] }, me), true);
  assert.equal(prep.soloBlock({ attendees: [{ email: me }, { email: 'naomi.wentworth@nurtur.tech' }] }, me), false);
  assert.equal(prep.soloBlock({ attendees: null }, me), false, 'undecidable is not "solo"');
  const v = mi.parityVerdict(LIVE, { contextAvailable: () => true });
  assert.equal(v.soloAfterFix, 0, 'no solo block pushed since the Build 16K fix (7 Oct)');
  const leak = mi.parityVerdict([...LIVE, row('2026-10-07T15:00', 'Task block: x', { wouldNotify: true, sent: true, matchedPeople: ['Nick Ward', 'Hope Goodall'] }, BLOCK)], { contextAvailable: () => true });
  assert.equal(leak.soloAfterFix, 1); assert.equal(leak.retireSafe, false, 'a solo block pushed after the fix would block retirement');
});

test('38. occurrence dedupe — one key per occurrence, the same occurrence is one key', () => {
  const a = prep.occurrenceKey({ id: 'AAA', start: '2026-10-06T10:30:00' });
  assert.notEqual(a, prep.occurrenceKey({ id: 'AAA', start: '2026-10-13T10:30:00' }));
  assert.equal(a, prep.occurrenceKey({ id: 'AAA', start: '2026-10-06T10:30:00.0000000' }));
});

test('39. retirement is decided on INTERRUPTION parity — the live record is retire-safe; an actionable or uncovered old push is not', () => {
  const ctx = (name) => { const c = mi.readPersonContext(name); return !!(c && (c.role || c.last121)); };
  const v = mi.parityVerdict(LIVE, { contextAvailable: ctx });
  assert.equal(v.retireSafe, true, v.reasons.join('; '));
  assert.equal(v.methodology, 'interruption-value');
  assert.deepEqual(v.pushValue, { actionable: 0, contextOnly: 1, noise: 4, duplicate: 0 });
  assert.equal(v.newOnlyMaterial.length, 2, 'the unified side raised two material risks the legacy path never could');
  // The context the old push carried must still be in prep, or retirement waits.
  const blind = mi.parityVerdict(LIVE, { contextAvailable: () => false });
  assert.equal(blind.retireSafe, false);
  assert.deepEqual(blind.missingContext.map((m) => m.person), ['Naomi Wentworth']);
  // An old push carrying anything beyond role / last 1-2-1 / notes is actionable and blocks.
  const act = mi.parityVerdict([...LIVE, row('2026-10-07T14:00', 'Hope 1-2-1', { wouldNotify: true, matchedPeople: ['Hope Goodall'], content: { role: true, overdueAction: true } }, NOTHING)], { contextAvailable: () => true });
  assert.equal(act.pushValue.actionable, 1); assert.equal(act.retireSafe, false);
  // Fewer than three days is not enough evidence.
  assert.equal(mi.parityVerdict(LIVE.filter((r) => r.start_local < '2026-10-07'), { contextAvailable: ctx }).retireSafe, false);
});

test('40. after retirement, prep still holds the useful context — and the legacy body can only ever carry context', () => {
  assert.equal(prep.prepMode(), 'retired');
  const c = mi.readPersonContext('Naomi Wentworth');
  assert.equal(c.role, 'Customer Service Agent (CSA)');
  assert.ok(c.last121);
  const att = mi.attendeeContext([{ displayName: 'Naomi Wentworth', personId: 'person:naomi-wentworth' }], mi.readPersonContext);
  assert.ok(att.length && att[0].role, JSON.stringify(att));
  // The prep view reads role and last 1-2-1 straight from the People note.
  const view = fs.readFileSync(path.join(__dirname, '..', 'routes', 'meeting-prep-view.js'), 'utf8');
  assert.match(view, /\^role:/); assert.match(view, /last-1-2-1:/);
  // The legacy push body is built from OLD_PUSH_FIELDS only.
  assert.deepEqual([...prep.OLD_PUSH_FIELDS], ['role', 'last121', 'notes']);
  assert.deepEqual([...mi.OLD_PUSH_FIELDS], [...prep.OLD_PUSH_FIELDS]);
  const src = fs.readFileSync(path.join(__dirname, 'meeting-prep.js'), 'utf8');
  const body = src.slice(src.indexOf('// Build notification'), src.indexOf('const title = `Meeting in'));
  assert.match(body, /person\.role/); assert.doesNotMatch(body, /commitment|risk|overdue|waiting/i);
  // Switching it back on is one setting, and env still wins.
  const ff = require('./feature-flags');
  assert.equal(ff.setEnabled('meeting_prep_legacy', true).ok, true);
  assert.equal(prep.prepMode(), 'live');
  process.env.MEETING_PREP_MODE = 'retired';
  assert.equal(prep.prepMode(), 'retired', 'MEETING_PREP_MODE wins');
  delete process.env.MEETING_PREP_MODE;
  ff.setEnabled('meeting_prep_legacy', false);
  assert.equal(prep.prepMode(), 'retired');
});

test('17W. Activity records the mode change once — not on every pass', () => {
  prep.noteModeChange(); prep.noteModeChange();
  const tl = require('./activity-timeline');
  const now = new Date();
  const { entries } = tl.collect({ fromIso: new Date(now.getTime() - 86400000).toISOString(), toIso: new Date(now.getTime() + 86400000).toISOString() });
  const mine = entries.filter((e) => e.type === 'meeting-prep.mode');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].headline, 'The old meeting-prep push is retired');
});
