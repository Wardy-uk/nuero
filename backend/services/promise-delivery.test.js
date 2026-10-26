'use strict';

/**
 * Promise-linked governed delivery → promise-score-v1, end to end (21 Oct 2026).
 *
 * Real scratch DB (real schema + Build 6–8 triggers), real temp vault, real
 * ledger, real prepared-actions, approval code and action-executor. The ONLY
 * fake is the mail transport (one fake mailbox); every real outbound door is
 * stubbed to THROW, so a flow that reaches one fails the suite.
 *
 * People are pseudonyms — the repo is public.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-promise-delivery-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'd.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'COMMITMENT_RISK_MODE', 'MEETING_INTELLIGENCE_MODE', 'SOURCE_BLIND_MODE', 'HA_TOKEN']) delete process.env[k];

const V = process.env.OBSIDIAN_VAULT_PATH;
const put = (rel, text) => { const f = path.join(V, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const PEOPLE = ['Alex Reed', 'Sam Patel', 'Robin Hale', 'Casey Lin', 'Drew Moss', 'Avery Nolan', 'Quinn Hart', 'Morgan Lee', 'Toby Vance', 'Jamie Ross', 'Kit Varga'];
put('People/Pat Gray.md', ['---', 'role: contractor', '---', '# Pat Gray', ''].join('\n')); // no address on file
for (const name of PEOPLE) put(`People/${name}.md`, `---\nemail: ${name.toLowerCase().replace(' ', '.')}@nurtur.tech\n---\n# ${name}\n`);
const NOTE = 'Meetings/2026/10/2026-10-14 - Ops sync.md';
const T = {
  kept: 'Nick to send Alex Reed the ticket type list',
  straddle: 'Nick to send Sam Patel the rota draft',
  late: 'Nick to send Robin Hale the backlog summary',
  ticked: 'Nick to share the dashboard notes with Casey Lin',
  chase: 'Nick to share the SLA figures with Drew Moss',
  executed: 'Nick to send Avery Nolan the survey results',
  early: 'Nick to send Quinn Hart the release notes',
  hr: 'Nick to confirm Morgan Lee phased return plan',
  retry: 'Nick to send Toby Vance the capacity model',
  offline: 'Nick to send Jamie Ross the cover rota',
  noaddr: 'Nick to send Pat Gray the meeting minutes',
  cache: 'Nick to send Kit Varga the escalation map',
};
put(NOTE, ['# Ops sync', '', '## Actions', ...Object.values(T).map((t) => `- ${t}`), ''].join('\n'));

// ── every real outbound door throws ──────────────────────────────────────────
const realDoors = [];
function stub(rel, exportsObj) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj }; }
const boom = (what) => async () => { realDoors.push(what); throw new Error(`${what} reached from a promise-delivery test`); };
stub('./webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('./email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('./teams', { getSendStatus: async () => ({ available: false }) });

const SELF = 'nickw@nurtur.tech';
let hideSent = false;
const sentItems = [];
const drafts = new Map();
let n = 0;
const mail = {
  createDraft: async ({ to, cc = [], subject, body }) => { n += 1; const id = `draft-${n}`; const imid = `<d${n}@nurtur.tech>`; drafts.set(id, { to, cc, subject, body, imid }); return { ok: true, id, internetMessageId: imid }; },
  patchDraft: async (id, { to, cc = [], subject }) => { const d = drafts.get(id); d.to = to; d.cc = cc; if (subject !== undefined) d.subject = subject; return { ok: true, to: d.to.map((x) => String(x.email || x).toLowerCase()), cc: [], bcc: [], subject: d.subject, internetMessageId: d.imid }; },
  sendDraft: async (id) => {
    const d = drafts.get(id);
    sentItems.push({ id: `sent-${id}`, internetMessageId: d.imid, subject: d.subject, to: d.to.map((x) => String(x.email || x).toLowerCase()), cc: [], bcc: [], from: SELF, sentAt: d.sentAt || new Date(clock).toISOString(), bodyText: d.body, conversationId: `conv-${id}` });
    drafts.delete(id); return { outcome: 'accepted', status: 202 };
  },
  findSent: async (imid) => ({ ok: true, messages: hideSent ? [] : sentItems.filter((m) => m.internetMessageId === imid) }),
  draftState: async (id) => (drafts.has(id) ? 'draft' : 'gone'),
  deleteDraft: async (id) => drafts.delete(id),
  readMessage: async () => ({ ok: true, exists: false }),
  readEvent: async () => ({ ok: false, category: 'unavailable' }),
  sentToSince: async () => ({ count: 0, subjects: [] }),
  sentInConversationSince: async () => ({ count: 0 }),
  signedInAddress: async () => SELF,
};
let clock = Date.parse('2026-10-21T09:00:00Z');
stub('./action-mail', { ...mail, DEFINITIVE_SEND_REFUSALS: new Set([400, 401, 403, 404, 409]) });
stub('./mail-read', { readMessage: mail.readMessage, signedInAddress: mail.signedInAddress });
stub('./microsoft', {
  getSignedInAddress: async () => SELF,
  getAccessToken: async () => { realDoors.push('microsoft.getAccessToken'); return null; },
  graphWrite: boom('microsoft.graphWrite'), sendMail: boom('microsoft.sendMail'), fetchSentMail: boom('microsoft.fetchSentMail'),
  createCalendarEvent: boom('microsoft.createCalendarEvent'), markEmailRead: async () => ({ ok: true }),
});

const db = require('../db/database');
const pa = require('./prepared-actions');
const ex = require('./action-executor');
const proofs = require('./approval-proof');
const taskStore = require('./task-store');
const flags = require('./feature-flags');
const score = require('./promise-score');
const delivery = require('./promise-delivery');
const matrix = require('./authority-matrix');

const CODE = 'promise delivery approval code';
const SCORE_AT = Date.parse('2026-10-22T12:00:00Z'); // Thursday 13:00 BST — every 21 Oct due point has passed
const ID = {};
const keyOf = (name) => `promise:${ID[name]}`;
const EXEC = { mail, enabled: () => true, reportLocked: () => false };

function task(name, due) {
  const r = taskStore.createTask({ text: T[name], source: 'meeting-promotion', origin_path: NOTE, due_date: due });
  ID[name] = (r.task || r).id;
  db.run('UPDATE tasks SET created_at = ? WHERE id = ?', ['2026-10-14 10:00:00', ID[name]]);
}

/** prepare → write the deliverable → approval code → execute (at `at`). */
async function deliver(name, at, { hidden = false } = {}) {
  clock = at - 3600000;
  const prep = delivery.prepare(keyOf(name), { now: clock });
  assert.equal(prep.ok, true, prep.error);
  let a = prep.action;
  const ed = pa.edit(a.actionId, { body: a.draft.body.replace('[details]', 'Here are the figures.'), payloadHash: a.payloadHash, now: clock });
  assert.equal(ed.ok, true, ed.error);
  a = ed.action;
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: clock });
  const ap = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: clock, sending: () => true });
  assert.equal(ap.ok, true, ap.error);
  clock = at;
  hideSent = hidden;
  await ex.execute(a.actionId, { now: at, deps: EXEC });
  hideSent = false;
  return pa.get(a.actionId);
}

test.before(async () => {
  await db.init();
  assert.equal(proofs.setCode(CODE).ok, true);
  for (const name of ['kept', 'straddle', 'late', 'ticked', 'chase', 'executed', 'hr', 'retry', 'offline', 'noaddr', 'cache']) task(name, '2026-10-21');
  task('early', '2026-10-20');
});

test('before any promise delivery exists the score is still measured — from ticks (Nick, 26 Oct 2026)', () => {
  const r = score.read({ now: SCORE_AT });
  assert.equal(r.proofSource.status, 'not-connected');
  assert.notEqual(r.ratio, null);
  assert.equal(r.why, null);
});

test('refusals: an employment matter gets the routing note; an unknown promise 404s; nothing is prepared', () => {
  const hr = delivery.prepare(keyOf('hr'), { now: clock });
  assert.equal(hr.ok, false);
  assert.equal(hr.routing, true);
  assert.match(hr.error, /employment/);
  assert.equal(delivery.prepare('promise:999999', { now: clock }).code, 404);
  assert.equal(db.all('SELECT COUNT(*) AS n FROM prepared_actions')[0].n, 0);
});

test('readiness (read-only): addressable or not, and the live draft once one exists — preparing nothing', async () => {
  const ledger = require('./promise-ledger').read({ now: clock });
  const before = db.all('SELECT COUNT(*) AS n FROM prepared_actions')[0].n;
  const r = delivery.readiness([keyOf('offline'), keyOf('noaddr'), 'promise:999999'], { ledger });
  assert.deepEqual(r.get(keyOf('offline')), { addressable: true, why: null, live: null });
  assert.equal(r.get(keyOf('noaddr')).addressable, false);
  assert.match(r.get(keyOf('noaddr')).why, /no address for Pat Gray/);
  assert.equal(r.get('promise:999999').addressable, false);
  assert.equal(db.all('SELECT COUNT(*) AS n FROM prepared_actions')[0].n, before, 'readiness prepares nothing');
});

test('“Send approved emails” OFF: the note can be DRAFTED, but cannot be approved to send', () => {
  assert.equal(flags.isEnabled('governed_execution'), false, 'off by default');
  clock = Date.parse('2026-10-21T08:30:00Z');
  const prep = delivery.prepare(keyOf('offline'), { now: clock });
  assert.equal(prep.ok, true, prep.error);
  const ed = pa.edit(prep.action.actionId, { body: prep.action.draft.body.replace('[details]', 'The rota.'), payloadHash: prep.action.payloadHash, now: clock });
  const a = ed.action;
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: clock });
  const ap = pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: clock });
  assert.equal(ap.ok, false, 'approval refused while sending is off');
  assert.equal(pa.get(a.actionId).status, 'prepared', 'still a draft for review');
  assert.equal(sentItems.length, 0);
  const live = delivery.readiness([keyOf('offline')], { ledger: require('./promise-ledger').read({ now: clock }) }).get(keyOf('offline')).live;
  assert.deepEqual(live, { actionId: a.actionId, status: 'prepared' }, 'the home sees the waiting draft');
});

test('the route over HTTP: prepares, repeats idempotently, refuses an employment matter — and sends nothing', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/promises', require('../routes/promise-delivery'));
  const server = await new Promise((ok) => { const sv = app.listen(0, () => ok(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/promises`;
  const post = async (key, body = {}) => { const r = await fetch(`${base}/${encodeURIComponent(key)}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const sentBefore = sentItems.length;
    const first = await post(keyOf('offline'));
    assert.equal(first.status, 200);
    assert.equal(first.body.already, true, 'the draft already waiting is handed back');
    const second = await post(keyOf('offline'));
    assert.equal(second.body.action.actionId, first.body.action.actionId, 'repeat press → the SAME draft');
    assert.equal(second.body.action.status, 'prepared');
    const hr = await post(keyOf('hr'));
    assert.equal(hr.status, 409);
    assert.equal(hr.body.routing, true);
    assert.match(hr.body.error, /employment/);
    const chase = await post(keyOf('offline'), { move: 'chase-email' });
    assert.equal(chase.status, 400, 'only deliver-email is prepared here');
    const noaddr = await post(keyOf('noaddr'));
    assert.equal(noaddr.status, 409);
    assert.equal(noaddr.body.recipientNeeded, true);
    assert.equal(sentItems.length, sentBefore, 'nothing was sent');
  } finally { server.close(); }
});

test('freshness: a successful prepare drops ONLY the Keep my word memo; the next read reports the draft; refusals change nothing', () => {
  const canonical = require('./canonical-read');
  const km = require('./keep-my-word');
  const key = keyOf('cache');
  const wb = () => ({ state: 'ok', items: [{ key, taskIds: [ID.cache], leadTaskId: ID.cache, title: T.cache, owedTo: 'Kit Varga',
    due: { date: '2026-10-21', say: 'due today', endsAt: '2026-10-21T23:00:00.000Z' }, preparation: { state: 'needs-a-draft', why: 'x' }, evidence: [], because: [] }], withheld: {} });
  const AT = Date.parse('2026-10-21T08:40:00Z');
  canonical.invalidateKeepMyWord();
  const first = canonical.keepWordBlock(AT, { workbench: wb });
  assert.equal(first.delivery.items[key].live, null);
  assert.equal(km.compose({ ...first, presentation: { mode: 'calm', needsYou: [] }, now: AT }).thread.draft.control, 'Draft the delivery note');
  // Within the minute the memo serves the same read.
  assert.equal(canonical.keepWordBlock(AT + 1000), first, 'memoised within the minute');
  // Refusals (employment matter, no address, unknown promise) leave it exactly as it was.
  assert.equal(delivery.prepare(keyOf('hr'), { now: AT }).ok, false);
  assert.equal(delivery.prepare(keyOf('noaddr'), { now: AT }).ok, false);
  assert.equal(delivery.prepare('promise:999999', { now: AT }).ok, false);
  assert.equal(canonical.keepWordBlock(AT + 2000), first, 'a refusal invalidates nothing');
  // Success: the very next read — same minute — sees the draft.
  const prep = delivery.prepare(key, { now: AT + 3000 });
  assert.equal(prep.ok, true, prep.error);
  const next = canonical.keepWordBlock(AT + 4000, { workbench: wb });
  assert.notEqual(next, first, 'the stale read is gone');
  assert.deepEqual(next.delivery.items[key].live, { actionId: prep.action.actionId, status: 'prepared' });
  const thread = km.compose({ ...next, presentation: { mode: 'calm', needsYou: [] }, now: AT }).thread;
  assert.equal(thread.draft.control, 'Show the delivery note', 'reports the existing draft, no stale “Draft” offer');
  assert.equal(thread.draft.say, 'A delivery note is already drafted and waiting for your approval.');
  // Repeat: the same draft, still ONE live draft, and the read stays truthful.
  const again = delivery.prepare(key, { now: AT + 5000 });
  assert.equal(again.already, true);
  assert.equal(again.action.actionId, prep.action.actionId);
  assert.equal(delivery.actionsFor(key).filter((r) => delivery.LIVE.includes(r.status)).length, 1);
  assert.equal(canonical.keepWordBlock(AT + 6000, { workbench: wb }).delivery.items[key].live.actionId, prep.action.actionId);
});

test('the invalidation scope is exactly the Keep my word memo — nothing else is touched', () => {
  const src = fs.readFileSync(path.join(__dirname, 'canonical-read.js'), 'utf-8');
  const body = /function invalidateKeepMyWord\(\) \{([^}]*)\}/.exec(src);
  assert.ok(body, 'invalidateKeepMyWord exists');
  assert.equal(body[1].trim(), '_keepWordMemo = null;', 'it clears ONLY the Keep my word memo');
  const calls = [...src.matchAll(/invalidateKeepMyWord\(/g)].length;
  assert.equal(calls, 1, 'canonical-read never calls it itself');
  const dsrc = fs.readFileSync(path.join(__dirname, 'promise-delivery.js'), 'utf-8');
  const requires = [...dsrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.ok(!requires.some((r) => /prepared-move|authority-budget|action-executor|intent-grants|email-sender|smtp-mail|action-mail/.test(r)), `no other cache or sender is reached: ${requires.join(', ')}`);
  assert.match(dsrc, /if \(r && r\.ok\) _fresh\(\);/, 'only a successful prepare invalidates');
});

test('a missing recipient is CHOSEN, never guessed', () => {
  const r = delivery.prepare(keyOf('kept'), { now: clock, deps: { contacts: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.recipientNeeded, true);
  const bad = delivery.prepare(keyOf('kept'), { now: clock, to: [{ name: 'x', email: 'not-an-address' }] });
  assert.equal(bad.code, 400);
});

test('the door is human-only: machine-refused in the authority matrix', () => {
  const d = matrix.machineDecision('POST', `/api/promises/${encodeURIComponent('promise:1')}/prepare`);
  assert.equal(d.allow, false);
  assert.equal(d.capability, 'email.send');
  const gw = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp-server', 'remote', 'api-policy.js'), 'utf-8');
  assert.ok(gw.includes('post_promises_by_key_prepare'), 'interactive in the MCP gateway');
});

test('a prepared delivery is governed: origin saim-promise, [details] placeholder, evidence names the promise, nothing sent', () => {
  clock = Date.parse('2026-10-21T09:00:00Z');
  const prep = delivery.prepare(keyOf('kept'), { now: clock });
  assert.equal(prep.ok, true, prep.error);
  const a = prep.action;
  assert.equal(a.origin, 'saim-promise');
  assert.equal(a.status, 'prepared');
  assert.deepEqual(a.evidence, { origin: 'saim-promise', from: 'work', promiseKey: keyOf('kept'), move: 'deliver-email', taskIds: [ID.kept] });
  assert.deepEqual(a.draft.to.map((r) => r.email), ['alex.reed@nurtur.tech']);
  assert.match(a.draft.body, /\[details\]/);
  assert.equal(sentItems.length, 0);
  // Idempotent: a second press returns the same live draft.
  const again = delivery.prepare(keyOf('kept'), { now: clock });
  assert.equal(again.already, true);
  assert.equal(again.action.actionId, a.actionId);
  // The placeholder blocks approval until Nick writes the deliverable.
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: clock });
  assert.equal(pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: clock, sending: () => true }).ok, false);
  // SAiM drafted it: the wrong approval code is refused.
  const ed = pa.edit(a.actionId, { body: a.draft.body.replace('[details]', 'Attached.'), payloadHash: a.payloadHash, now: clock });
  assert.equal(ed.ok, true, ed.error);
  assert.equal(ed.action.evidence.promiseKey, keyOf('kept'), 'an edit keeps the promise link');
  const ch2 = proofs.issue({ actionId: ed.action.actionId, version: ed.action.version, payloadHash: ed.action.payloadHash, now: clock });
  assert.equal(pa.approve(ed.action.actionId, { approver: 'nick', payloadHash: ed.action.payloadHash, challengeId: ch2.challengeId, approvalCode: 'wrong', now: clock, sending: () => true }).ok, false);
  // Leave it for the next test to approve and send; reject this edit's chain is not needed.
  T._keptAction = ed.action;
});

test('kept on time: approved, sent and read back BEFORE the due point', async () => {
  let a = T._keptAction;
  clock = Date.parse('2026-10-21T14:00:00Z');
  const ch = proofs.issue({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, now: clock });
  assert.equal(pa.approve(a.actionId, { approver: 'nick', payloadHash: a.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: clock, sending: () => true }).ok, true);
  clock = Date.parse('2026-10-21T15:00:00Z');
  await ex.execute(a.actionId, { now: clock, deps: EXEC });
  a = pa.get(a.actionId);
  assert.equal(a.status, 'verified');
  const again = await ex.execute(a.actionId, { now: clock + 1000, deps: EXEC });
  assert.equal(sentItems.length, 1, 'one attempt per approved version: a retry sends nothing');
  assert.ok(again);
  const p = score.readProofs(undefined, { executionOn: true }).proofs.get(keyOf('kept'));
  assert.equal(p.actionId, a.actionId);
  assert.equal(p.sentNotBefore, '2026-10-21T15:00:00.000Z');
  assert.equal(p.provenBy, '2026-10-21T15:00:00.000Z');
  assert.equal(delivery.prepare(keyOf('kept'), { now: clock }).delivered, true, 'already delivered: no second delivery');
});

test('straddling the due point: sent before it, read back after it → unverified for timing', async () => {
  const a = await deliver('straddle', Date.parse('2026-10-21T22:50:00Z'), { hidden: true });
  assert.notEqual(a.status, 'verified', 'not yet read back');
  const v = await ex.verify(a.actionId, { now: Date.parse('2026-10-21T23:10:00Z'), deps: EXEC });
  assert.equal(v.outcome, 'verified');
  const p = score.readProofs(undefined, { executionOn: true }).proofs.get(keyOf('straddle'));
  assert.equal(p.sentNotBefore, '2026-10-21T22:50:00.000Z');
  assert.equal(p.provenBy, '2026-10-21T23:10:00.000Z');
});

test('after the due point: sent and read back late → late', async () => {
  const a = await deliver('late', Date.parse('2026-10-22T09:00:00Z'));
  assert.equal(a.status, 'verified');
});

test('a chase email naming the promise is never delivery proof', async () => {
  clock = Date.parse('2026-10-21T12:00:00Z');
  const r = pa.prepareCompose({ from: 'work', to: [{ name: 'Drew Moss', email: 'drew.moss@nurtur.tech' }], subject: 'Checking in', body: 'Where has it got to?', origin: 'saim-promise',
    evidence: { promiseKey: keyOf('chase'), move: 'chase-email', taskIds: [ID.chase] }, now: clock });
  assert.equal(r.ok, true, r.error);
  const ch = proofs.issue({ actionId: r.action.actionId, version: r.action.version, payloadHash: r.action.payloadHash, now: clock });
  assert.equal(pa.approve(r.action.actionId, { approver: 'nick', payloadHash: r.action.payloadHash, challengeId: ch.challengeId, approvalCode: CODE, now: clock, sending: () => true }).ok, true);
  await ex.execute(r.action.actionId, { now: clock + 1000, deps: EXEC });
  assert.equal(pa.get(r.action.actionId).status, 'verified');
  assert.equal(score.readProofs(undefined, { executionOn: true }).proofs.has(keyOf('chase')), false);
});

test('a merely EXECUTED delivery (never read back) is not proof', async () => {
  const a = await deliver('executed', Date.parse('2026-10-21T16:00:00Z'), { hidden: true });
  assert.ok(['executed', 'execution_uncertain'].includes(a.status), a.status);
  assert.equal(score.readProofs(undefined, { executionOn: true }).proofs.has(keyOf('executed')), false);
});

test('retry after a rejected delivery prepares a fresh one; the rejected one is never proof', () => {
  clock = Date.parse('2026-10-21T11:00:00Z');
  const first = delivery.prepare(keyOf('retry'), { now: clock });
  assert.equal(first.ok, true, first.error);
  assert.equal(pa.reject(first.action.actionId, { note: 'not this wording', now: clock }).ok, true);
  const second = delivery.prepare(keyOf('retry'), { now: clock + 1000 });
  assert.equal(second.ok, true, second.error);
  assert.notEqual(second.action.actionId, first.action.actionId);
  assert.equal(score.readProofs(undefined, { executionOn: true }).proofs.has(keyOf('retry')), false);
});

test('a ticked task is never proof', () => {
  taskStore.updateTask(ID.ticked, { status: 'done' });
  assert.equal(score.readProofs(undefined, { executionOn: true }).proofs.has(keyOf('ticked')), false);
});

test('“Send approved emails” OFF: Sent Items proof is not read, but the score is still measured from ticks', () => {
  flags.setEnabled('governed_execution', false);
  const r = score.read({ now: SCORE_AT });
  assert.equal(r.proofSource.status, 'not-connected');
  assert.match(r.proofSource.why, /Send approved emails/);
  assert.notEqual(r.ratio, null);
});

test('END TO END: with the real proof source connected, the score moves from unmeasured to measured — truthfully', () => {
  flags.setEnabled('governed_execution', true);
  const r = score.read({ now: SCORE_AT });
  assert.equal(r.proofSource.status, 'connected');
  assert.equal(r.proofSource.connectedSince, '2026-10-21T08:30:00.000Z', 'the first promise delivery prepared (with sending off)');
  const out = Object.fromEntries(r.entries.map((e) => [e.key, e.outcome]));
  assert.equal(out[keyOf('kept')], 'kept-on-time');
  assert.equal(out[keyOf('straddle')], 'unverified');
  assert.equal(out[keyOf('late')], 'late');
  assert.equal(out[keyOf('chase')], 'late', 'a verified chase leaves it open and late');
  assert.equal(out[keyOf('executed')], 'late', 'an unread-back send leaves it open and late');
  assert.equal(out[keyOf('ticked')], 'late', 'a tick is delivery — ticked after its due day');
  assert.equal(out[keyOf('retry')], 'late');
  assert.equal(out[keyOf('early')], 'late', 'due before the proof source existed: still judged');
  assert.equal(r.counts.beforeProofSource, 0);
  const straddle = r.entries.find((e) => e.key === keyOf('straddle'));
  assert.match(straddle.rule, /cannot place it before the due point/);
  const hr = r.entries.find((e) => e.key === keyOf('hr'));
  assert.equal(hr.sensitive, true);
  assert.equal(hr.text, null);
  assert.deepEqual(r.ratio, { kept: 1, of: r.counts.due - r.counts.pending });
  assert.equal(r.counts.keptOnTime, 1);
});

test('missing or unreadable evidence still fails closed', () => {
  const broken = { all: () => { throw new Error('database is locked'); }, get: () => null };
  const p = score.readProofs(broken, { executionOn: true });
  assert.equal(p.source.status, 'unreadable');
  const r = score.scoreWeek({ promises: [], proofs: p.proofs, proofSource: p.source, now: SCORE_AT, gaps: [{ input: 'tasks', why: 'locked' }] });
  assert.equal(r.ratio, null);
  assert.match(r.why, /couldn’t read the task list/);
});

test('no real outbound door was reached', () => {
  assert.deepEqual(realDoors, []);
});
