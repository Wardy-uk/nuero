'use strict';

// Chris's weekly overtime sign-off (5 Nov 2026). The store and the prepared actions are REAL;
// NOVA, the mailbox read, the model, the push, approval/execution and the clock are faked at
// the deps boundary (the executor has its own suites).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'otsign-')), 'test.db');

const db = require('../db/database');
const so = require('./overtime-signoff');
const pa = require('./prepared-actions');

test.before(async () => { await db.init(); });

const NONE = new Set();
const S16 = { day: 16, overrides: {} };

test('the cut-off is the 16th, moved back to a working day; a period runs from the day after the last one', () => {
  assert.strictEqual(so.cutoffDate('2026-11', S16, NONE).date, '2026-11-16'); // a Monday
  assert.strictEqual(so.cutoffDate('2026-08', S16, NONE).date, '2026-08-14'); // Sun 16 Aug -> Fri 14
  assert.strictEqual(so.cutoffDate('2026-11', S16, new Set(['2026-11-16'])).date, '2026-11-13', 'a bank holiday moves it back');
  assert.strictEqual(so.cutoffDate('2026-11', { day: 16, overrides: { '2026-11': '2026-11-12' } }, NONE).date, '2026-11-12');
  assert.deepStrictEqual(so.periodFor('2026-11', S16, NONE), { month: '2026-11', from: '2026-10-17', to: '2026-11-16', overridden: false });
  assert.deepStrictEqual(so.periodFor('2026-09', S16, NONE).from, '2026-08-15', 'after an early cut-off the next period starts the day after it');
  assert.strictEqual(so.periodMonthOf('2026-11-16', S16, NONE), '2026-11');
  assert.strictEqual(so.periodMonthOf('2026-11-17', S16, NONE), '2026-12');
  assert.strictEqual(so.periodMonthOf('2026-12-20', S16, NONE), '2027-01');
});

test('cut-off settings are refused, never repaired', () => {
  assert.ok(so.validateCutoff({ day: 0 }).error);
  assert.ok(so.validateCutoff({ day: 31 }).error);
  assert.ok(so.validateCutoff({ day: 16, overrides: { '2026-11': '2026-12-01' } }).error, 'an override outside its month');
  assert.deepStrictEqual(so.validateCutoff({ day: 15, overrides: { '2026-11': null } }), { day: 15, overrides: {} });
});

test('which email is due: Monday weekly, the working day before the cut-off, the cut-off itself', () => {
  assert.deepStrictEqual(so.dueKinds('2026-11-09', S16, NONE).map((d) => d.kind), ['weekly']);
  assert.deepStrictEqual(so.dueKinds('2026-11-13', S16, NONE).map((d) => d.kind), ['reminder']);
  assert.deepStrictEqual(so.dueKinds('2026-11-16', S16, NONE).map((d) => d.kind), ['cutoff'], 'a cut-off Monday sends one email, not two');
  assert.deepStrictEqual(so.dueKinds('2026-11-14', S16, NONE), [], 'Saturday');
  assert.strictEqual(so.dueKinds('2026-11-09', S16, NONE)[0].coverTo, '2026-11-08');
});

test('reading a reply: only a short plain yes signs off; any doubt goes to Nick', () => {
  assert.strictEqual(so.quickVerdict('Signed off, thanks'), 'approve');
  assert.strictEqual(so.quickVerdict('Approved.\n\nChris'), 'approve');
  assert.strictEqual(so.quickVerdict('Approved except Abdi on Tuesday'), 'doubt');
  assert.strictEqual(so.quickVerdict('Why so much on Friday?'), 'doubt');
  assert.strictEqual(so.quickVerdict('No, hold these please'), 'doubt');
  assert.strictEqual(so.quickVerdict('I have looked through the list in detail and I am content with what the team did last week'), 'unsure');
  assert.strictEqual(so.quickVerdict(''), 'unsure');
  assert.strictEqual(so.replyText('Signed off\n\nFrom: Nick Ward\nSent: Monday\n> old'), 'Signed off');
  assert.strictEqual(so.parseVerdict('{"verdict":"all-approved"}'), 'all-approved');
  assert.strictEqual(so.parseVerdict('maybe'), null);
});

const claim = (id, o = {}) => ({
  id, agentName: 'Abdi Mohamed', agentEmail: 'abdi@nurtur.tech', date: '2026-11-03', start: '17:30', end: '19:30', minutes: 120,
  reason: 'Production incident [NT-1]', status: 'approved', exportedMonth: null, enteredBy: null, wtr: null, ...o,
});

test('the email: weeks grouped, earlier weeks flagged, own claims apart, and no [placeholder] the executor would refuse', () => {
  const m = so.composeEmail({
    kind: 'weekly', ref: 7, coverTo: '2026-11-08', reportWeek: '2026-11-02', chrisFirst: 'Chris',
    period: { month: '2026-11', from: '2026-10-17', to: '2026-11-16' },
    team: [claim(1), claim(2, { date: '2026-10-28', agentName: 'Zoe Rees', wtr: { warnings: [{ code: 'rest-11', message: 'only 9h rest' }] }, overrideReason: 'incident' })],
    own: [claim(3, { agentName: 'Nick Ward', date: '2026-11-04' })],
  });
  assert.match(m.subject, /ref OT-7\)/);
  assert.doesNotMatch(m.subject + m.body, /\[|\]/);
  assert.match(m.body, /Week 2 Nov to 8 Nov — 2 hours:\n- Abdi Mohamed: Tue 3 Nov 17:30–19:30, 2 hours/);
  assert.match(m.body, /Still waiting for your sign-off from earlier weeks/);
  assert.match(m.body, /only 9h rest \(approved because: incident\)/);
  assert.match(m.body, /My own overtime, for you to approve:\n- Wed 4 Nov/);
  assert.match(m.body, /reply "signed off"/);
  const done = so.composeEmail({ kind: 'cutoff', ref: 8, team: [], own: [], coverTo: '2026-11-16', period: { month: '2026-11', from: '2026-10-17', to: '2026-11-16' } });
  assert.match(done.body, /Everything for the period has been signed off/);
});

// ── the flow ────────────────────────────────────────────────────────────────

function harness({ autoOn = true, chris = { ok: true, name: 'Chris Middleton', email: 'chris.middleton@nurtur.tech' }, replies = [], judge = null } = {}) {
  const sent = new Set(); const pushes = []; const decided = [];
  const approved = [claim(11), claim(12, { date: '2026-11-05', agentName: 'Zoe Rees', agentEmail: 'zoe@nurtur.tech' })];
  const submitted = [claim(13, { agentName: 'Nick Ward', agentEmail: 'nickw@nurtur.tech', status: 'submitted' }), claim(14, { agentEmail: 'luke@nurtur.tech', status: 'submitted' })];
  let now = Date.parse('2026-11-09T09:05:00Z');
  const d = {
    now: () => now,
    holidays: () => NONE,
    nickEmail: () => 'nickw@nurtur.tech',
    chris: () => chris,
    nova: async (p, o = {}) => {
      if (p.startsWith('/api/neuro-bridge/overtime/claims?status=approved')) return approved;
      if (p.startsWith('/api/neuro-bridge/overtime/claims?status=submitted')) return submitted;
      if (p === '/api/neuro-bridge/overtime/export/file') return { filename: 'x.xlsx', xlsxBase64: Buffer.from('xlsx').toString('base64') };
      const m = p.match(/claims\/(\d+)\/decide$/);
      if (m) { decided.push({ id: Number(m[1]), ...o.body }); return { id: Number(m[1]), status: 'approved' }; }
      throw new Error(`unexpected ${p}`);
    },
    approve: () => ({ ok: true }),
    execute: async (id) => { sent.add(id); },
    getAction: (id) => { const a = pa.get(id); return a && sent.has(id) ? { ...a, status: 'executed' } : a; },
    autoOn: () => autoOn,
    replies: async () => ({ ok: true, messages: replies }),
    judge: async () => judge,
    push: (title, body) => { pushes.push({ title, body }); },
  };
  return { d, sent, pushes, decided, setNow: (iso) => { now = Date.parse(iso); } };
}

const reset = () => { so.ensureTables(); db.run('DELETE FROM overtime_signoff_requests'); db.run('DELETE FROM overtime_signoffs'); };

test('Monday 09:05: last week goes to Chris under the switch; a plain "signed off" signs it and approves Nick\'s own as Chris', async () => {
  reset();
  const h = harness({ replies: [{ id: 'm1', subject: 'RE: Overtime sign-off (ref OT-1)', receivedAt: '2026-11-09T10:00:00Z', text: 'Signed off. Thanks\n\nFrom: Nick' }] });
  await so.tick(h.d);
  const rows = db.all('SELECT * FROM overtime_signoff_requests');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].kind, 'weekly');
  assert.deepStrictEqual(JSON.parse(rows[0].team_ids), [11, 12]);
  assert.deepStrictEqual(JSON.parse(rows[0].own_ids), [13], 'only Nick\'s own submitted claim — never an agent\'s pending one');
  const action = pa.get(rows[0].action_id);
  assert.strictEqual(action.origin, 'overtime-signoff');
  assert.deepStrictEqual(action.draft.to.map((r) => r.email), ['chris.middleton@nurtur.tech']);
  assert.ok(h.sent.has(rows[0].action_id), 'sent under the switch');
  // The same tick read his reply (subject ref matched by the fake mailbox).
  const after = db.get('SELECT * FROM overtime_signoff_requests WHERE id = ?', [rows[0].id]);
  assert.strictEqual(after.status, 'signed');
  assert.deepStrictEqual(so.unsigned([11, 12, 13]), []);
  assert.deepStrictEqual(h.decided.map((x) => [x.id, x.decision, x.decidedBy.name]), [[13, 'approve', 'Chris Middleton']]);
  // Idempotent: a second tick the same day prepares nothing more.
  await so.tick(h.d);
  assert.strictEqual(db.all('SELECT * FROM overtime_signoff_requests').length, 1);
});

test('a reply with any doubt signs NOTHING and waits for Nick; his confirmation records what Chris said', async () => {
  reset();
  const h = harness({ replies: [{ id: 'm2', subject: 'RE: x (ref OT-1)', receivedAt: '2026-11-09T10:00:00Z', text: 'Fine except Zoe on Thursday — can you check?' }] });
  await so.tick(h.d);
  const row = db.get('SELECT * FROM overtime_signoff_requests');
  assert.strictEqual(row.status, 'needs-you');
  assert.deepStrictEqual(so.unsigned([11, 12]), [11, 12]);
  assert.strictEqual(h.decided.length, 0);
  assert.ok(h.pushes.some((p) => /replied about overtime/.test(p.title)));
  const r = await so.applyAnswer(row.id, { sign: [11], approveOwn: [13], by: 'nick' }, h.d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'partial');
  assert.deepStrictEqual(so.unsigned([11, 12, 13]), [12]);
  assert.strictEqual((await so.applyAnswer(row.id, { sign: [99], by: 'nick' }, h.d)).code, 400, 'a claim not in that email is refused');
});

test('a reply the rule cannot read goes to the model; a model that is down means Nick decides', async () => {
  reset();
  const h = harness({ judge: null, replies: [{ id: 'm3', subject: 'RE (ref OT-1)', receivedAt: '2026-11-09T10:00:00Z', text: 'I have gone through the whole list carefully this morning and I am content with all of it' }] });
  await so.tick(h.d);
  assert.strictEqual(db.get('SELECT status FROM overtime_signoff_requests').status, 'needs-you');
  reset();
  const h2 = harness({ judge: '{"verdict":"all-approved"}', replies: [{ id: 'm4', subject: 'RE (ref OT-1)', receivedAt: '2026-11-09T10:00:00Z', text: 'I have gone through the whole list carefully this morning and I am content with all of it' }] });
  await so.tick(h2.d);
  assert.strictEqual(db.get('SELECT status FROM overtime_signoff_requests').status, 'signed');
});

test('switch off: the email waits on Actions and Nick is told once; no Chris address: held, nothing prepared', async () => {
  reset();
  const h = harness({ autoOn: false });
  await so.tick(h.d);
  const row = db.get('SELECT * FROM overtime_signoff_requests');
  assert.strictEqual(row.status, 'prepared');
  assert.strictEqual(h.sent.size, 0);
  await so.tick(h.d);
  assert.strictEqual(h.pushes.filter((p) => /ready/.test(p.title)).length, 1);
  reset();
  const h2 = harness({ chris: { ok: false, error: 'no People note called Chris Middleton carries an email: line' } });
  await so.tick(h2.d);
  const held = db.get('SELECT * FROM overtime_signoff_requests');
  assert.strictEqual(held.status, 'held');
  assert.strictEqual(held.action_id, null);
});

test('before 09:00 nothing goes; nothing outstanding on a Monday sends nothing; a hand-recorded sign-off needs a how', async () => {
  reset();
  const h = harness();
  h.setNow('2026-11-09T08:40:00Z');
  await so.tick(h.d);
  assert.strictEqual(db.all('SELECT * FROM overtime_signoff_requests').length, 0);
  assert.strictEqual(so.recordByHand([11], '').code, 400);
  assert.strictEqual(so.recordByHand([11], 'in our 1-2-1').ok, true);
  assert.deepStrictEqual(so.unsigned([11]), []);
});

test('cut-off override: payroll goes with Chris copied, the unsigned claims named; his "approved" on that thread signs them off', async () => {
  reset();
  const ot = require('./overtime-claims');
  const exp = { month: '2026-11', from: '2026-10-17', to: '2026-11-16', totals: [{ agentName: 'Abdi Mohamed', claims: 1, hours: 2 }], totalHours: 2, rows: [] };
  const mail = ot.payrollEmail(exp, { unsigned: [{ claimId: 21, agentName: 'Abdi Mohamed', date: '2026-11-12', hours: 2 }], ref: 5, chrisFirst: 'Chris' });
  assert.match(mail.subject, /\(ref OT-5\)$/);
  assert.match(mail.body, /Chris — you're copied in because this claim hasn’t been signed off yet/);
  assert.match(mail.body, /- Abdi Mohamed: 2026-11-12, 2 hours/);
  assert.match(mail.body, /Please reply "approved"[\s\S]*Thanks,\nNick$/);
  assert.doesNotMatch(mail.subject + mail.body, /\[|\]/);
  assert.doesNotMatch(ot.payrollEmail(exp).subject, /ref OT/, 'an ordinary payroll email is unchanged');

  const h = harness({ replies: [{ id: 'm9', subject: 'RE: Overtime – November 2026 (ref OT-1)', receivedAt: '2026-11-16T11:00:00Z', text: 'Approved' }] });
  h.setNow('2026-11-16T10:30:00Z');
  const o = so.openOverride('2026-11', [{ claimId: 21, agentName: 'Abdi Mohamed', agentEmail: 'abdi@nurtur.tech', date: '2026-11-12', start: '18:00', end: '20:00', hours: 2, reason: 'x' }], h.d);
  assert.strictEqual(o.ok, true);
  const r = pa.prepareCompose({ from: 'work', to: ['payroll@nurtur.tech'], cc: [o.chrisEmail], subject: 'Overtime – November 2026 (ref OT-1)', body: 'b', origin: 'overtime-payroll' });
  so.attachOverrideAction(o.id, r.action.actionId);
  // Not pressed yet: the switch never sends a payroll email.
  await so.tick(h.d);
  assert.ok(!h.sent.has(r.action.actionId), 'the payroll email is never sent by the switch');
  assert.deepStrictEqual(so.unsigned([21]), [21]);
  // Nick presses it; the next tick sees it sent and reads Chris's reply.
  h.sent.add(r.action.actionId);
  await so.tick(h.d);
  assert.deepStrictEqual(so.unsigned([21]), []);
  assert.strictEqual(db.get('SELECT status FROM overtime_signoff_requests WHERE id = ?', [o.id]).status, 'signed');
});
