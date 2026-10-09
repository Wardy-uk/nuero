'use strict';

/**
 * Human-originated action provenance (9 Oct 2026) — the one-use intent grant.
 *
 * Real DB, real migration and triggers, real prepared-actions, executor,
 * routes, api-auth and authority guard over HTTP. Only the calendar TRANSPORT
 * (action-calendar / calendar-read) and Microsoft's read are faked, so every
 * governed check — preflight, single claim, ledger, read-back — really runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-intent-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'intent.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.OBSIDIAN_VAULT_PATH = path.join(tmp, 'vault');
process.env.NEURO_PIN = 'pin-1234';
process.env.NEURO_API_TOKEN = 'tok-5678';
process.env.NEURO_KIOSK_TOKEN = 'kiosk-9012';
for (const k of ['GOVERNED_EXECUTION_ENABLED', 'GOVERNED_CALENDAR_ENABLED']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'vault', 'People'), { recursive: true });

function stub(rel, exportsObj) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
stub('./webpush', { sendToAll: async () => {}, isConfigured: () => true });

// ── one fake calendar (the transport, never the executor) ───────────────────
const CAL = { events: new Map(), calls: { create: 0 }, mode: 'accept' };
const minute = (s) => String(s || '').slice(0, 16);
const calApi = {
  createEvent: async (draft, { marker }) => {
    CAL.calls.create += 1;
    const make = () => {
      const id = `EV-${CAL.events.size + 1}`;
      const ev = { id, subject: draft.subject, start: minute(draft.start), end: minute(draft.end), attendees: draft.to.map((r) => r.email.toLowerCase()).sort(),
        location: draft.location || null, isOnline: !!draft.isOnline, isCancelled: false, isOrganizer: true, marker };
      CAL.events.set(id, ev);
      return ev;
    };
    if (CAL.mode === 'accept') return { outcome: 'accepted', status: 201, event: make() };
    return { outcome: 'uncertain', status: null, category: 'timeout' };
  },
  findByMarker: async (marker) => ({ ok: true, events: [...CAL.events.values()].filter((e) => e.marker === marker) }),
  readEvent: async (id) => (CAL.events.has(id) ? { ok: true, exists: true, event: CAL.events.get(id) } : { ok: true, exists: false, event: null }),
  eventsAt: async (start) => ({ ok: true, events: [...CAL.events.values()].filter((e) => e.start === minute(start)) }),
  moveEvent: async () => ({ outcome: 'rejected', status: 404 }),
  cancelEvent: async () => ({ outcome: 'rejected', status: 404 }),
};
stub('./action-calendar', calApi);
stub('./calendar-read', { readEvent: calApi.readEvent, eventsAt: calApi.eventsAt, findByMarker: calApi.findByMarker, normaliseEvent: (e) => e, TIMEZONE: 'Europe/London', MARKER_PROP: 'x' });
stub('./microsoft', { fetchCalendarEvents: async () => [], getSignedInAddress: async () => 'nickw@nurtur.tech' });

const db = require('../db/database');
const pa = require('./prepared-actions');
const ex = require('./action-executor');
const grants = require('./intent-grants');
const proofs = require('./approval-proof');

// ── NEURO's real auth stack over HTTP ───────────────────────────────────────
let server;
let base;
test.before(async () => {
  await db.init();
  require('./feature-flags').setEnabled('governed_calendar', true);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('./api-auth'));
  app.use('/api', require('./authority-guard').guard);
  app.use('/api/1to1', require('../routes/one-to-one'));
  app.use('/api/prepared-actions', require('../routes/prepared-actions'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server && server.close());

const PIN = { 'x-neuro-pin': 'pin-1234' };
async function call(method, p, body, headers = PIN) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

let day = 0;
async function bookViaRoute(headers = PIN) {
  day += 1;
  const d = String(10 + day).padStart(2, '0');
  return call('POST', '/1to1/book', { person: 'Hope Goodall', start: `2026-11-${d}T14:00:00`, end: `2026-11-${d}T14:30:00`, email: 'hope.goodall@nurtur.tech' }, headers);
}
const SESSION = 'sess0123456789';
const mintFor = (a, headers = PIN, extra = {}) => call('POST', `/prepared-actions/${a.actionId}/intent-grant`,
  { version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: SESSION, ...extra }, headers);
const execWith = (a, grantId, headers = PIN) => call('POST', `/prepared-actions/${a.actionId}/execute-direct`, { grantId, payloadHash: a.payloadHash }, headers);
const row = (id) => db.get('SELECT * FROM prepared_actions WHERE action_id = ?', [id]);

// ═════════════════════════════════════════════════════════════════════════════

test('1. a Nick-direct 1-2-1 booking executes with NO approval code (none is even set)', async () => {
  assert.equal(proofs.codeStatus().set, false, 'positive control: no approval code exists in this database');
  const before = CAL.calls.create;
  const b = await bookViaRoute();
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.action.status, 'prepared');
  const g = await mintFor(b.body.action);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const x = await execWith(b.body.action, g.body.grantId);
  assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal(x.body.status, 'verified');
  assert.equal(CAL.calls.create, before + 1);
  const r = row(b.body.action.actionId);
  assert.equal(r.initiated_by, 'human_direct');
  assert.equal(r.authority_proof, 'intent_grant');
  assert.equal(r.intent_grant_id, g.body.grantId);
  assert.equal(r.approval_mechanism, 'intent-grant');
  assert.equal(grants.get(g.body.grantId).outcome, 'executed');
});

test('2. a grant cannot execute a different action, version or payload', async () => {
  const a = (await bookViaRoute()).body.action;
  const b = (await bookViaRoute()).body.action;
  // Minting against a hash that is not the stored one is refused outright.
  const stale = await mintFor(a, PIN, { payloadHash: 'f'.repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.needsConfirm, true);
  const staleV = await mintFor(a, PIN, { version: 2 });
  assert.equal(staleV.status, 409);
  // A grant for A spent on B: refused, and the grant is burned as a mismatch.
  const g = await mintFor(a);
  const x = await execWith(b, g.body.grantId);
  assert.equal(x.status, 409, JSON.stringify(x.body));
  assert.equal(x.body.needsConfirm, true);
  assert.equal(grants.get(g.body.grantId).outcome, 'mismatch');
  assert.equal(row(b.actionId).status, 'prepared');
  // Changing the action's stored payload after minting is caught too.
  const g2 = await mintFor(b);
  const altered = grants.consume({ grantId: g2.body.grantId, actionId: b.actionId, version: b.version, payloadHash: 'e'.repeat(64) });
  assert.equal(altered.ok, false);
  assert.equal(altered.reason, 'mismatch');
});

test('3. a second execution with the same grant is refused (double click sends once)', async () => {
  const a = (await bookViaRoute()).body.action;
  const g = await mintFor(a);
  const before = CAL.calls.create;
  const [one, two] = await Promise.all([execWith(a, g.body.grantId), execWith(a, g.body.grantId)]);
  const oks = [one, two].filter((r) => r.status === 200);
  assert.equal(oks.length, 1, JSON.stringify([one.body, two.body]));
  assert.equal(CAL.calls.create, before + 1);
  const again = await execWith(a, g.body.grantId);
  assert.notEqual(again.status, 200);
  // A refresh cannot mint a fresh grant for an action already done.
  assert.equal((await mintFor(a)).status, 409);
});

test('4. an expired grant is refused and says it needs confirming again', async () => {
  const a = (await bookViaRoute()).body.action;
  const old = grants.mint({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: SESSION, caller: {}, now: Date.now() - 2 * 60 * 1000 });
  assert.equal(old.ok, true);
  const x = await execWith(a, old.grantId);
  assert.equal(x.status, 403);
  assert.equal(x.body.needsConfirm, true);
  assert.match(x.body.error, /confirming again/);
  assert.equal(grants.get(old.grantId).outcome, 'expired');
  assert.equal(row(a.actionId).status, 'prepared');
});

test('5. API token, declared machines, schedulers and a fake kiosk cannot mint a grant', async () => {
  const a = (await bookViaRoute()).body.action;
  const viaToken = await mintFor(a, { 'x-neuro-api-token': 'tok-5678' });
  assert.equal(viaToken.status, 403);
  const declared = await mintFor(a, { ...PIN, 'x-neuro-machine-client': 'mcp-local' });
  assert.equal(declared.status, 403);
  const kioskClaim = await mintFor(a, PIN, { surface: 'saim-kiosk' });
  assert.equal(kioskClaim.status, 403, 'a PIN caller cannot claim to be the kiosk');
  // In-process callers (a scheduler, the agent loop) go through the same mint.
  assert.equal(grants.mint({ actionId: a.actionId, version: a.version, payloadHash: a.payloadHash, surface: 'neuro-web', sessionId: SESSION, caller: { machine: 'scheduler' } }).ok, false);
  assert.equal(db.get('SELECT COUNT(*) n FROM human_action_intents WHERE action_id = ?', [a.actionId]).n, 0);
  // Positive control: the real kiosk credential, as the kiosk, can.
  const kiosk = await mintFor(a, { 'x-neuro-kiosk-token': 'kiosk-9012' }, { surface: 'saim-kiosk' });
  assert.equal(kiosk.status, 200, JSON.stringify(kiosk.body));
});

test('6. machine A4 calendar actions stay prepare-only', async () => {
  const viaToken = await bookViaRoute({ 'x-neuro-api-token': 'tok-5678' });
  assert.equal(viaToken.status, 403);
  // Something NEURO drafted (chat) cannot be confirmed by a grant at all.
  const p = pa.prepareCalendarCreate({ title: 'Chat-proposed meeting', start: '2026-12-01T10:00', end: '2026-12-01T10:30',
    attendees: [{ email: 'hope.goodall@nurtur.tech', name: 'Hope Goodall' }], origin: 'chat' });
  assert.equal(p.ok, true, p.error);
  const g = await mintFor(p.action);
  assert.equal(g.status, 403);
  assert.equal(row(p.action.actionId).status, 'prepared');
  const viaExec = await call('POST', `/prepared-actions/${p.action.actionId}/execute-direct`, { grantId: 'ig_' + '0'.repeat(32), payloadHash: p.action.payloadHash });
  assert.equal(viaExec.status, 403);
  assert.equal(row(p.action.actionId).status, 'prepared');
});

test('7. a forged initiated_by / authority claim from a client is ignored', async () => {
  const a = (await bookViaRoute()).body.action;
  const forged = await call('POST', `/prepared-actions/${a.actionId}/execute-direct`,
    { payloadHash: a.payloadHash, initiated_by: 'human_direct', authority_proof: 'intent_grant', grantId: 'not-a-grant' },
    { ...PIN, 'x-neuro-initiated-by': 'human_direct' });
  assert.notEqual(forged.status, 200);
  assert.equal(row(a.actionId).status, 'prepared');
  assert.equal(row(a.actionId).initiated_by, null);
  const viaApprove = await call('POST', `/prepared-actions/${a.actionId}/approve`, { payloadHash: a.payloadHash, initiated_by: 'human_direct' });
  assert.notEqual(viaApprove.status, 200);
  assert.equal(row(a.actionId).status, 'prepared');
});

test('8. the approval-code path still works for an autonomous action, and records it as NEURO', async () => {
  assert.equal(proofs.setCode('long enough code').ok, true);
  const p = pa.prepareCalendarCreate({ title: 'NEURO-proposed meeting', start: '2026-12-02T10:00', end: '2026-12-02T10:30',
    attendees: [{ email: 'hope.goodall@nurtur.tech', name: 'Hope Goodall' }], origin: 'chat' });
  const ch = await call('POST', `/prepared-actions/${p.action.actionId}/approval-challenge`, {});
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const ok = await call('POST', `/prepared-actions/${p.action.actionId}/approve`, { payloadHash: p.action.payloadHash, challengeId: ch.body.challengeId, approvalCode: 'long enough code' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'verified');
  const r = row(p.action.actionId);
  assert.equal(r.initiated_by, 'neuro_autonomous');
  assert.equal(r.authority_proof, 'approval_code');
  assert.equal(r.intent_grant_id, null);
});

test('9. a direct action still runs preflight, single claim, ledger and read-back; duplicates fold', async () => {
  const b = (await bookViaRoute()).body;
  const g = await mintFor(b.action);
  const x = await execWith(b.action, g.body.grantId);
  assert.equal(x.body.status, 'verified');
  assert.equal(ex.attemptsFor(b.action.actionId).length, 1, 'one ledger attempt');
  assert.ok(ex.verificationsFor(b.action.actionId).length >= 1, 'verified by read-back');
  // Booking the same slot again does not make a second live invite.
  const again = await call('POST', '/1to1/book', { person: 'Hope Goodall', start: b.action ? `2026-11-${String(10 + day).padStart(2, '0')}T14:00:00` : '', end: `2026-11-${String(10 + day).padStart(2, '0')}T14:30:00`, email: 'hope.goodall@nurtur.tech' });
  if (again.status === 200) assert.equal(again.body.actionId, b.actionId, 'the same live action, not a second one');
  // Provenance is immutable once approved (database trigger).
  assert.throws(() => db.run(`UPDATE prepared_actions SET initiated_by = 'neuro_autonomous' WHERE action_id = ?`, [b.action.actionId]), /immutable/);
  // A spent grant cannot be revived (database trigger).
  assert.throws(() => db.run('UPDATE human_action_intents SET consumed_at = NULL WHERE id = ?', [g.body.grantId]), /spent intent grant/);
});

test('10. an uncertain provider outcome is never resent', async () => {
  const a = (await bookViaRoute()).body.action;
  CAL.mode = 'timeout';
  try {
    const before = CAL.calls.create;
    const g = await mintFor(a);
    const x = await execWith(a, g.body.grantId);
    assert.equal(x.body.status, 'execution_uncertain', JSON.stringify(x.body));
    assert.equal(CAL.calls.create, before + 1);
    await ex.execute(a.actionId);
    await ex.execute(a.actionId);
    assert.equal(CAL.calls.create, before + 1, 'no second create after an uncertain outcome');
    assert.equal((await mintFor(a)).status, 409, 'and no new grant can restart it');
  } finally {
    CAL.mode = 'accept';
  }
});

test('11. the UI confirms a direct booking inline, never through the Actions approval screen', () => {
  const ui = path.join(__dirname, '..', '..', 'frontend', 'src');
  const board = fs.readFileSync(path.join(ui, 'components', 'PeopleBoard.jsx'), 'utf8');
  const composer = fs.readFileSync(path.join(ui, 'components', 'EventComposer.jsx'), 'utf8');
  const helper = fs.readFileSync(path.join(ui, 'directAction.js'), 'utf8');
  assert.match(helper, /intent-grant/);
  assert.match(helper, /execute-direct/);
  for (const [name, src] of [['PeopleBoard', board], ['EventComposer', composer]]) {
    assert.match(src, /executeDirect\(/, `${name} confirms with a grant`);
    assert.doesNotMatch(src, /approval-challenge|approveWithCode|approvalCode|approve it in Actions/i, `${name} must not route via the code / Actions`);
  }
  // Positive control: the Actions approval path still exists for NEURO's drafts.
  assert.match(fs.readFileSync(path.join(ui, 'components', 'PreparedActions.jsx'), 'utf8'), /approval-challenge/);
});

test('grant origins agree between server and UI', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'PreparedActions.jsx'), 'utf8');
  const m = /DIRECT_ORIGINS = new Set\(\[([^\]]*)\]\)/.exec(ui);
  assert.ok(m, 'positive control: the UI list exists');
  const uiList = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();
  assert.deepEqual(uiList, Object.keys(grants.HUMAN_ORIGINS).sort());
});
