'use strict';

/**
 * Meeting follow-ups and earned auto-filing of meeting actions (1 Nov 2026).
 * Real HTTP, real api-auth + authority guard, real DB, real task store, real
 * prepared-actions + intent grants + executor, a scratch vault with People notes
 * and meeting write-ups. Faked: the model (ai-routing.runTask), the push, and
 * the mail transport (one fake mailbox). Every other outbound door throws.
 *
 * B — follow-ups:
 *   - a team meeting (a 1-2-1 with a direct report) is drafted automatically,
 *     to the other attendees only (never Nick, never a room), with one push;
 *   - the daily 10:00 Team Standup (live subject, pinned) gets nothing;
 *   - a meeting with outsiders gets an OFFER — no draft, no model call, no push —
 *     until Draft is pressed;
 *   - one draft per occurrence: a second sweep and a second press buy nothing;
 *   - an unknown becomes a [details: …] gap and the send is refused; a gap-free
 *     draft sends with one press (intent grant → execute-direct);
 *   - the model unavailable = no draft, named; machines are refused.
 * A — the gate:
 *   - review below 20 decided or under 80%; auto at >=80% of the last 20;
 *   - an auto-filed action is the SAME approve path (task, origin_detail,
 *     "Filed automatically from …"); Undo within 7 days drops the task and
 *     counts as a rejection, which can switch the gate back to review.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-followups-'));
const VAULT = path.join(tmp, 'vault');
process.env.NEURO_DB_PATH = path.join(tmp, 'agent.db');
process.env.OBSIDIAN_VAULT_PATH = VAULT;
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
for (const k of ['ANTHROPIC_API_KEY', 'HA_TOKEN', 'HA_URL', 'GOVERNED_EXECUTION_ENABLED', 'MEETING_FOLLOWUP_DRAFTS']) delete process.env[k];
global.fetch = async () => { throw new Error('network blocked in meeting-followups test'); };

const put = (rel, text) => { const f = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put('People/Heidi Power.md', '---\ndirect-report: true\nteam: 2nd Line\nemail: heidi.power@nurtur.tech\n---\n# Heidi Power\n');
put('People/Nathan Rutland.md', '---\ndirect-report: true\nteam: 1st Line\nemail: nathan.rutland@nurtur.tech\n---\n# Nathan Rutland\n');
put('People/Ola Vendor.md', '---\nemail: ola@vendor.example\n---\n# Ola Vendor\n');

// ── every real outbound door throws; one fake mailbox ────────────────────────
const doors = [];
function stub(rel, exportsObj) { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj }; }
const boom = (what) => async () => { doors.push(what); throw new Error(`${what} reached from a meeting-followups test`); };
stub('../services/webpush', { sendToAll: boom('webpush.sendToAll'), isConfigured: () => true });
stub('../services/email-sender', { sendMail: boom('email-sender.sendMail'), sendBriefEmail: boom('email-sender.sendBriefEmail'), OWN_ADDRESS: 'nickw@nurtur.tech' });
stub('../services/teams', { getSendStatus: async () => ({ available: false }) });
const SELF = 'nickw@nurtur.tech';
const sentItems = []; const drafts = new Map(); let n = 0;
const mail = {
  createDraft: async ({ to, cc = [], subject, body }) => { n += 1; const id = `draft-${n}`; const imid = `<d${n}@nurtur.tech>`; drafts.set(id, { to, cc, subject, body, imid, files: [] }); return { ok: true, id, internetMessageId: imid }; },
  addAttachments: async () => ({ ok: true }),
  listAttachments: async () => ({ ok: true, names: [] }),
  patchDraft: async () => ({ ok: false }),
  sendDraft: async (id) => {
    const d = drafts.get(id);
    sentItems.push({ id: `sent-${id}`, internetMessageId: d.imid, subject: d.subject, to: d.to.map((x) => String(x.email || x).toLowerCase()), cc: (d.cc || []).map((x) => String(x.email || x).toLowerCase()), bcc: [], from: SELF, sentAt: new Date().toISOString(), bodyText: d.body, conversationId: `conv-${id}`, files: [] });
    drafts.delete(id); return { outcome: 'accepted', status: 202 };
  },
  findSent: async (imid) => ({ ok: true, messages: sentItems.filter((m) => m.internetMessageId === imid) }),
  draftState: async (id) => (drafts.has(id) ? 'draft' : 'gone'),
  deleteDraft: async (id) => drafts.delete(id),
  readMessage: async () => ({ ok: true, exists: false }),
  readEvent: async () => ({ ok: false, category: 'unavailable' }),
  sentToSince: async () => ({ count: 0, subjects: [] }),
  sentInConversationSince: async () => ({ count: 0 }),
  signedInAddress: async () => SELF,
};
stub('../services/action-mail', { ...mail, DEFINITIVE_SEND_REFUSALS: new Set([400, 401, 403, 404, 409]) });
stub('../services/mail-read', { readMessage: mail.readMessage, signedInAddress: mail.signedInAddress });
stub('../services/microsoft', {
  getSignedInAddress: async () => SELF, getAccessToken: async () => null,
  graphWrite: boom('microsoft.graphWrite'), sendMail: boom('microsoft.sendMail'), fetchSentMail: boom('microsoft.fetchSentMail'),
  createCalendarEvent: boom('microsoft.createCalendarEvent'), markEmailRead: async () => ({ ok: true }),
  completeMicrosoftTask: boom('microsoft.completeMicrosoftTask'),
});

const db = require('../db/database');
const mf = require('../services/meeting-followups');
const gate = require('../services/meeting-actions-gate');
const { describeTaskProvenance } = require('../../shared/task-provenance.cjs');

// ── the model, scripted ──────────────────────────────────────────────────────
const modelCalls = [];
let answer = null; // string | Error
require('../services/ai-routing').runTask = async (taskType, payload) => {
  modelCalls.push({ taskType, prompt: payload.prompt });
  if (answer instanceof Error) throw answer;
  return { text: answer, provider: 'test' };
};
const pushes = [];
const push = async (title, body, data) => { pushes.push({ title, body, data }); };

const NICK = { 'X-NEURO-PIN': 'pin-1234' };
const MCP = { 'X-NEURO-PIN': 'pin-1234', 'X-Neuro-Machine-Client': 'mcp-local' };
let server; let base;

// Fixtures dated off the clock: yesterday, wall clock = London.
const DAY_MS = 86400000;
const NOW = Date.now();
const YDAY = new Date(NOW - DAY_MS);
const london = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
// A UTC instant whose London wall clock is `hh:mm` yesterday.
function instantAt(hhmm) {
  const day = london(YDAY.getTime()).slice(0, 10);
  let ms = Date.parse(`${day}T${hhmm}:00Z`);
  for (let i = 0; i < 3; i++) { const wall = london(ms); ms += Date.parse(`${day}T${hhmm}:00Z`) - Date.parse(`${wall}:00Z`); }
  return ms;
}
const DAY = london(YDAY.getTime()).slice(0, 10);
const ym = DAY.slice(0, 7).replace('-', '/');

function meeting({ id, subject, hhmm, people, series = 'S1' }) {
  const startMs = instantAt(hhmm);
  const start = london(startMs);
  const end = london(startMs + 30 * 60000);
  db.run(`INSERT INTO calendar_history (event_id, start_time, end_time, subject, is_all_day, show_as, attendees_other, organizer, source, first_seen)
          VALUES (?, ?, ?, ?, 0, 'busy', 1, 'Nick Ward', 'graph', ?)`, [id, start, end, subject, new Date().toISOString()]);
  const mid = `graph:${id}`;
  db.run(`INSERT INTO wm_meetings (meeting_id, provider, provider_event_id, series_id, title, start_local, end_local, is_all_day, status, kind, provenance_kind, confidence,
            observed_at, received_at, evidence_json, fingerprint, updated_at)
          VALUES (?, 'graph', ?, ?, ?, ?, ?, 0, 'scheduled', 'meeting', 'observation', 1, 'x', 'x', '[]', ?, 'x')`, [mid, id, series, subject, start, end, id]);
  for (const p of [{ email: SELF, name: 'Nick Ward' }, ...people]) {
    db.run('INSERT INTO wm_meeting_participants (meeting_id, email, name, is_organizer) VALUES (?, ?, ?, 0)', [mid, p.email, p.name]);
  }
  // The PLAUD write-up: UTC, unmarked, starting a couple of minutes in.
  const startAt = new Date(startMs + 2 * 60000).toISOString().replace('Z', '');
  const slug = subject.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  const tPath = `Plaud/Transcripts/${DAY} ${slug.replace(/ /g, '-')}.md`;
  put(`Meetings/${ym}/${DAY} – ${slug}.md`, `---\nplaud_id: "f_${id}"\ntitle: "${subject}"\nstart_at: "${startAt}"\ntype: meeting\ntranscript_path: ${tPath}\n---\n# ${subject}\n\n## Summary\n\nThe team reviewed the Tier Two queue and agreed to move the DNS tickets to the partner board. Heidi will collate the DNS list. Nick will send the escalation chart to Stephen by Friday.\n`);
  return { mid, start, tPath, notePath: `Meetings/${ym}/${DAY} – ${slug}.md` };
}

const M = {};

test.before(async () => {
  await db.init();
  require('../services/feature-flags').setEnabled('governed_execution', true);
  M.team = meeting({ id: 'EV-121', subject: '1-2-1 — Nick / Heidi', hhmm: '11:00', people: [{ email: 'heidi.power@nurtur.tech', name: 'Heidi Power' }] });
  // The live standup, as it is in Nick's diary (pinned 1 Nov 2026 off calendar_history).
  M.standup = meeting({ id: 'EV-STAND', subject: 'Team Standup', hhmm: '10:00', people: [{ email: 'heidi.power@nurtur.tech', name: 'Heidi Power' }, { email: 'nathan.rutland@nurtur.tech', name: 'Nathan Rutland' }] });
  M.ext = meeting({ id: 'EV-EXT', subject: 'Vendor DNS review', hhmm: '14:00', series: null, people: [
    { email: 'ola@vendor.example', name: 'Ola Vendor' }, { email: 'scrum@nurtur.tech', name: 'The Scrum Room' }, { email: '', name: 'Guest Without Address' },
  ] });
  // The transcript read for the 1-2-1 and the vendor meeting (owners from the transcript).
  db.setState(`transcript_${path.basename(M.team.tPath, '.md')}`, JSON.stringify({ actions: [
    { owner: 'Heidi Power', task: 'Collate the DNS ticket list', due: null },
    { owner: 'Nick Ward', task: 'Send the escalation chart to Stephen', due: null },
  ] }));
  db.setState(`transcript_${path.basename(M.ext.tPath, '.md')}`, JSON.stringify({ actions: [
    { owner: 'unknown', task: 'Confirm the cut-over date', due: null },
  ] }));
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require('../services/api-auth'));
  app.use('/api', require('../services/authority-guard').guard);
  app.use('/api/meeting-followups', require('./meeting-followups'));
  app.use('/api/meeting-actions', require('./meeting-actions'));
  app.use('/api/prepared-actions', require('./prepared-actions'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

function call(method, route, body, headers = NICK) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s || '{}') }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const rowFor = (mid) => db.get('SELECT * FROM meeting_followups WHERE meeting_id = ?', [mid]);

// ── B: pure rules ────────────────────────────────────────────────────────────

test('the standup rule matches the live series and nothing like it', () => {
  assert.equal(mf.isTeamStandup({ subject: 'Team Standup', start: '2026-10-29T10:00', seriesKnown: true, seriesId: 'S' }), true);
  assert.equal(mf.isTeamStandup({ subject: 'Support Stand-up', start: '2026-10-29T10:00' }), true);
  assert.equal(mf.isTeamStandup({ subject: 'Team Standup', start: '2026-10-29T14:00' }), false, 'not at 10:00 = not the daily one');
  assert.equal(mf.isTeamStandup({ subject: 'Team Standup', start: '2026-10-29T10:00', seriesKnown: true, seriesId: null }), false, 'a one-off is not the series');
  assert.equal(mf.isTeamStandup({ subject: 'Standards review', start: '2026-10-29T10:00' }), false);
});

test('a standup write-up linked to another 10:00 meeting is still the standup; broadcasts are not team meetings', () => {
  const reports = [{ name: 'Heidi Power', email: 'heidi.power@nurtur.tech' }];
  const crowd = (k) => Array.from({ length: k }, (_, i) => ({ email: `p${i}@x.com`, name: `P ${i}` }));
  // Live 22 and 29 Oct: the standup recording linked to the 19-person delivery call (free tie-breaker).
  // The diary's own standup, whatever PLAUD titled the recording.
  assert.equal(mf.classify({ subject: 'Team Standup', start: '2026-10-30T10:00', participants: [reports[0]], reports, noteTitle: '2026-10-30 – Operations Meeting Urgent DNS Access' }).kind, 'skip');
  const c = mf.classify({ subject: 'DELIVERY CALL - MANDATORY ATTENDANCE!', start: '2026-10-29T10:00', participants: crowd(19), reports, noteTitle: '2026-10-29 – Stand-Up Meeting Support Operations' });
  assert.equal(c.kind, 'skip');
  // The Fortnightly SMT update: 199 people, one report among them — nothing at all.
  assert.equal(mf.classify({ subject: 'SMT update', start: '2026-10-28T10:30', participants: [...crowd(198), reports[0]], reports }).kind, 'skip');
  // Nine others with a report: asked, never drafted on its own.
  assert.equal(mf.classify({ subject: 'Ops', start: '2026-10-28T14:00', participants: [...crowd(8), reports[0]], reports }).kind, 'prompt');
  assert.equal(mf.classify({ subject: 'Ops', start: '2026-10-28T14:00', participants: [...crowd(7), reports[0]], reports }).kind, 'auto');
});

test('recipients: never Nick, never a room, an address-less attendee named', () => {
  const r = mf.recipientsFor([
    { email: SELF, name: 'Nick Ward' }, { email: 'NICKW@nurtur.tech', name: 'N' }, { email: 'x@y.com', name: 'Nick Ward' },
    { email: 'scrum@nurtur.tech', name: 'The Scrum Room' }, { email: '', name: 'No Address' }, { email: 'ola@vendor.example', name: 'Ola' },
  ], { selfAddresses: [SELF] });
  assert.deepEqual(r.to.map((x) => x.email), ['ola@vendor.example']);
  assert.deepEqual(r.excluded.map((x) => x.why), ['room or resource', 'no email address']);
});

test('gaps: a bracketed unknown becomes a [details: …] gap; PLAUD links are stripped', () => {
  assert.equal(mf.gapify('Due [date to confirm] per [[People/Heidi Power|Heidi]]'), 'Due [details: date to confirm] per Heidi');
  assert.equal(require('../services/action-registry').hasUnfilledPlaceholder('x [details: owner] y'), true);
});

test('a commitment for Nick the write-up does not carry is a gap, never his words', () => {
  const body = mf.composeBody({
    to: [{ name: 'Heidi Power', email: 'h@x' }],
    model: { summary: 'I will rebuild the whole queue by Monday.', decisions: [], actions: [{ owner: 'Nick Ward', task: 'Rewrite the billing system' }], gaps: [] },
    record: { title: 'X', day: null, actions: null, source: 'The team reviewed the queue.' },
  });
  assert.doesNotMatch(body, /^I will rebuild/m);
  assert.match(body, /\[details: confirm before sending/);
  assert.match(body, /\[details: confirm — "Rewrite the billing system" for Nick/);
});

// ── B: the sweep, drafts and offers ──────────────────────────────────────────

test('sweep: team meeting drafted + pushed; standup skipped; outside meeting offered with no model call', async () => {
  answer = JSON.stringify({ summary: 'Heidi and Nick reviewed the Tier Two queue and agreed to move the DNS tickets to the partner board.', decisions: ['DNS tickets move to the partner board'], gaps: [] });
  const r = await mf.sweep({ push });
  assert.equal(r.linked, 3, JSON.stringify(r));
  assert.equal(r.skipped, 1, 'the standup');
  assert.equal(r.auto, 1); assert.equal(r.prompted, 1); assert.equal(r.drafted, 1);
  assert.equal(modelCalls.length, 1, 'one model call — the team meeting only');
  assert.equal(modelCalls[0].taskType, 'meeting_followup_draft');
  assert.ok(!rowFor(M.standup.mid), 'the standup leaves no row');

  const team = rowFor(M.team.mid);
  assert.equal(team.kind, 'auto'); assert.equal(team.status, 'drafted'); assert.ok(team.action_id);
  const a = require('../services/prepared-actions').get(team.action_id);
  assert.equal(a.actionType, 'compose_email'); assert.equal(a.origin, 'meeting-followup');
  assert.deepEqual(a.draft.to.map((x) => x.email), ['heidi.power@nurtur.tech']);
  assert.ok(!JSON.stringify(a.draft.to).includes(SELF), 'Nick is never a recipient');
  assert.equal(a.draft.subject, 'Follow-up: 1-2-1 — Nick / Heidi');
  assert.match(a.draft.body, /- Heidi Power: Collate the DNS ticket list/);
  assert.match(a.draft.body, /- Nick Ward: Send the escalation chart to Stephen/);
  assert.deepEqual(a.draft.placeholders, []);
  assert.equal(pushes.length, 1); assert.equal(pushes[0].data.type, 'meeting_followup'); assert.match(pushes[0].title, /Follow-up ready for 1-2-1/);

  const ext = rowFor(M.ext.mid);
  assert.equal(ext.kind, 'prompt'); assert.equal(ext.status, 'prompted'); assert.equal(ext.action_id, null);
  assert.deepEqual(JSON.parse(ext.recipients_json).map((x) => x.email), ['ola@vendor.example']);
  assert.deepEqual(JSON.parse(ext.excluded_json).map((x) => x.name).sort(), ['Guest Without Address', 'The Scrum Room']);
});

test('one per occurrence: a second sweep buys nothing', async () => {
  const before = modelCalls.length;
  const r = await mf.sweep({ push });
  assert.equal(r.auto + r.prompted + r.drafted, 0);
  assert.equal(modelCalls.length, before);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM meeting_followups').c, 2);
});

test('the list shows the draft and the offer; machines may not press Draft', async () => {
  const l = await call('GET', '/meeting-followups');
  assert.equal(l.status, 200);
  assert.equal(l.json.items.length, 2);
  const ext = rowFor(M.ext.mid);
  const m = await call('POST', `/meeting-followups/${ext.id}/draft`, {}, MCP);
  assert.equal(m.status, 403);
  assert.equal(rowFor(M.ext.mid).status, 'prompted');
  const rows = require('../services/prepared-drafts').savedWork().communication.filter((c) => /meeting-followup:/.test(c.moveKey));
  assert.equal(rows.length, 2, 'both in Drafts → Communication drafts');
});

test('the model unavailable = no draft, named; Draft press creates it; an unknown owner is a gap that blocks Send', async () => {
  const ext = rowFor(M.ext.mid);
  answer = new Error('provider down');
  const f = await call('POST', `/meeting-followups/${ext.id}/draft`);
  assert.equal(f.status, 409);
  assert.match(f.json.error, /model was not available/);
  assert.equal(rowFor(M.ext.mid).status, 'failed'); assert.equal(rowFor(M.ext.mid).action_id, null);

  answer = JSON.stringify({ summary: 'Ola and Nick reviewed the vendor DNS cut-over.', decisions: [], gaps: [] });
  const d = await call('POST', `/meeting-followups/${ext.id}/draft`);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const a = d.json.action;
  assert.match(a.draft.body, /\[details: who owns this\]: Confirm the cut-over date/);
  assert.ok(a.draft.placeholders.length > 0);
  assert.equal(pushes.length, 1, 'an offer drafted on a press is not pushed');
  // One per meeting, ever: pressing again returns it, buys nothing.
  const calls = modelCalls.length;
  const again = await call('POST', `/meeting-followups/${ext.id}/draft`);
  assert.equal(again.json.already, true); assert.equal(modelCalls.length, calls);
  // The gap blocks the one-press send.
  const g = await call('POST', `/prepared-actions/${a.actionId}/intent-grant`, { version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: 'testsession0001' });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const x = await call('POST', `/prepared-actions/${a.actionId}/execute-direct`, { grantId: g.json.grantId, payloadHash: a.payloadHash });
  assert.notEqual(x.json.status, 'verified'); assert.notEqual(x.json.status, 'executed');
  assert.equal(sentItems.length, 0, 'nothing sent while a gap remains');
});

test('the gap-free team draft sends with one press, to the attendee only', async () => {
  const a = require('../services/prepared-actions').get(rowFor(M.team.mid).action_id);
  const g = await call('POST', `/prepared-actions/${a.actionId}/intent-grant`, { version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: 'testsession0001' });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const x = await call('POST', `/prepared-actions/${a.actionId}/execute-direct`, { grantId: g.json.grantId, payloadHash: a.payloadHash });
  assert.equal(x.status, 200, JSON.stringify(x.json));
  assert.equal(sentItems.length, 1);
  assert.deepEqual(sentItems[0].to, ['heidi.power@nurtur.tech']);
  assert.deepEqual(doors, []);
});

// ── A: the gate ──────────────────────────────────────────────────────────────

function decided(statuses, base) {
  // Oldest first, so the LAST in the list is the newest decision.
  statuses.forEach((st, i) => {
    db.run(`INSERT INTO saim_actions (type, payload, status, resolved_at) VALUES ('capture_todo', ?, ?, datetime('now', ?))`,
      [JSON.stringify({ text: `Old action ${base} ${i} ${st}`, extractedFrom: 'transcript-action' }), st, `-${base - i} minutes`]);
  });
}

test('gate (pure): review below 20 decided, review under 80%, auto at 80% of the last 20', () => {
  const v = (a, r) => [...Array(a).fill({ verdict: 'approved' }), ...Array(r).fill({ verdict: 'rejected' })];
  assert.equal(gate.assessGate(v(4, 6)).mode, 'review');
  assert.match(gate.assessGate(v(4, 6)).line, /4\/10 approved — filed for review until 80% of the last 20/);
  assert.equal(gate.assessGate(v(19, 0)).mode, 'review', 'fewer than 20 decided');
  assert.equal(gate.assessGate(v(15, 5)).mode, 'review', '75%');
  assert.equal(gate.assessGate(v(16, 4)).mode, 'auto', '80%');
  assert.equal(gate.assessGate([...v(16, 4), ...v(0, 10)]).mode, 'auto', 'only the last 20 count');
});

test('gate (live): superseded/expired never count; review keeps candidates pending', async () => {
  decided(['executed', 'executed', 'executed', 'executed', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected'], 300);
  db.run(`INSERT INTO saim_actions (type, payload, status, resolved_at) VALUES ('capture_todo', ?, 'superseded', datetime('now'))`, [JSON.stringify({ text: 's', extractedFrom: 'transcript-action' })]);
  const s = gate.state();
  assert.equal(s.mode, 'review'); assert.equal(s.decided, 10); assert.equal(s.approved, 4);
  const ac = require('../services/action-candidates');
  const q = ac.syncTranscriptActions(`Meetings/${ym}/Review meeting.md`, '---\ntitle: x\n---\n', [{ owner: 'Nick Ward', task: 'Draft the queue routing proposal for the board' }]);
  assert.equal(q.created, 1);
  const r = await gate.afterTranscript(q);
  assert.equal(r.mode, 'review'); assert.equal(r.filed.length, 0);
  assert.equal(db.getSaimAction(q.createdIds[0]).status, 'pending');
});

test('gate (live): at >=80% new candidates are filed through the approve path, marked, and Undo counts against it', async () => {
  // Newest 20 = these 16 approvals + the 4 newest of the earlier block (all rejections) = 80%.
  decided(Array(16).fill('executed'), 100);
  let s = gate.state();
  assert.equal(s.decided, 20); assert.equal(s.approved, 16); assert.equal(s.mode, 'auto', JSON.stringify(s));

  const ac = require('../services/action-candidates');
  const q = ac.syncTranscriptActions(`Meetings/${ym}/Ops meeting.md`, '---\ntitle: x\n---\n', [{ owner: 'Nick Ward', task: 'Publish the partner escalation chart to the wiki' }]);
  const r = await gate.afterTranscript(q);
  assert.equal(r.filed.length, 1, JSON.stringify(r));
  const { taskId } = r.filed[0];
  assert.ok(taskId);
  const action = db.getSaimAction(q.createdIds[0]);
  assert.equal(action.status, 'executed');
  const task = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task.source, 'meeting-promotion', 'same executor path — the source every reader keys on');
  const p = describeTaskProvenance(task);
  assert.equal(p.how, 'Filed automatically from Ops meeting');
  assert.ok(p.autoFiled);

  // Machines may not Undo.
  assert.equal((await call('POST', `/meeting-actions/auto-filed/${taskId}/undo`, {}, MCP)).status, 403);
  s = gate.state();
  assert.equal(s.approved, 17, 'the auto-filed one counts as approved until he drops it');
  const before = s.approved;
  const u = await call('POST', `/meeting-actions/auto-filed/${taskId}/undo`);
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal(u.json.countedAgainst, true);
  assert.equal(db.get('SELECT status FROM tasks WHERE id = ?', [taskId]).status, 'dropped');
  assert.equal(db.getSaimAction(q.createdIds[0]).status, 'rejected');
  assert.equal(u.json.gate.approved, before - 1);
});

test('gate (live): dropping auto-filed tasks within 7 days flips it back to review', async () => {
  let s = gate.state();
  assert.equal(s.mode, 'auto', JSON.stringify(s));
  const ac = require('../services/action-candidates');
  const q = ac.syncTranscriptActions(`Meetings/${ym}/Planning meeting.md`, '---\ntitle: x\n---\n', [
    { owner: 'Nick Ward', task: 'Write the SIBS routing handover note for customer care' },
    { owner: 'Nick Ward', task: 'Book the Starberry migration rehearsal with the partner' },
    { owner: 'Nick Ward', task: 'Order replacement headsets for the Tier Two desk' },
    { owner: 'Nick Ward', task: 'Arrange Jira permission audit with security' },
    { owner: 'Nick Ward', task: 'Prepare quarterly CSAT slides for leadership' },
  ]);
  const r = await gate.afterTranscript(q);
  assert.equal(r.filed.length, 5, JSON.stringify(r));
  // Dropped on the task list, not via Undo — still a rejection within 7 days.
  const ts = require('../services/task-store');
  for (const f of r.filed) ts.updateTask(f.taskId, { status: 'dropped' });
  s = gate.state();
  assert.equal(s.mode, 'review', JSON.stringify(s));
  // And the next candidate stays pending.
  const q2 = ac.syncTranscriptActions(`Meetings/${ym}/Later meeting.md`, '---\ntitle: x\n---\n', [{ owner: 'Nick Ward', task: 'Review the Loki logging dashboard alerts' }]);
  const r2 = await gate.afterTranscript(q2);
  assert.equal(r2.filed.length, 0);
  assert.equal(db.getSaimAction(q2.createdIds[0]).status, 'pending');
});
