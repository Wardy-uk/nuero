'use strict';

/**
 * "Capture from this meeting" and "Open meeting prep" (21 Oct 2026).
 *
 *  - The capture is Nick's words and ONE kind he picked, saved as an ordinary
 *    `capture.note` through the outbox. The meeting is linked ONLY when the
 *    canonical key matches a meeting the diary says was running when he
 *    captured it — never guessed — and the receipt says which happened.
 *  - Prep opens THE meeting SAiM's hand-off named, including one already
 *    running; before, it showed the next meeting to start.
 *
 * Real SQLite, a real temp vault, the real outbox applier, the real prep route
 * over HTTP, and the real Capture view rendered via esbuild.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-mcap-'));
process.env.NEURO_DB_PATH = path.join(TMP, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(TMP, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const express = require('express');
const React = require('react');
const { renderToString } = require('react-dom/server');
const esbuild = require('esbuild');
const db = require('../db/database');
const attention = require('./attention');
const meetingFinish = require('./meeting-finish');
const mobileSync = require('./mobile-sync');
// ⚠ HERMETIC: the prep route reads the LIVE calendar first (obsidian.fetchCalendarEvents)
// and only falls back to the cache this test seeds. On the Pi that live read reaches
// Nick's real diary, so the seeded meeting was never consulted and the test failed there
// while passing on a laptop with no credentials. Pin the live read to "nothing".
require('./obsidian').fetchCalendarEvents = async () => null;

const ROOT = path.resolve(__dirname, '..', '..');
const iso = (ms) => new Date(ms).toISOString();
const SUBJECT = 'Sprint Planning Discussion';

function seedRunningMeeting(over = {}) {
  const now = Date.now();
  db.upsertCalendarEvent(Object.assign({
    id: 'evt-sprint', subject: SUBJECT, start: iso(now - 10 * 60000), end: iso(now + 20 * 60000),
    isAllDay: false, location: 'Microsoft Teams Meeting', organizer: 'someone@nurtur.tech', showAs: 'busy', attendeesOther: true,
  }, over));
}
const runningKey = () => meetingFinish.keyFor(attention.currentMeetingEvent());
let n = 0;
const op = (payload, over = {}) => ({ operationId: `op-${++n}`, kind: 'capture.note', createdAt: new Date().toISOString(), payload, ...over });
const readNote = (receipt) => fs.readFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, receipt.canonicalId.replace(/^capture:/, '')), 'utf8');

let MC;
let server;
let base;
test.before(async () => {
  await db.init();
  MC = await import(pathToFileURL(path.join(ROOT, 'saim/app/src/meetingCapture.mjs')).href);
  const app = express();
  app.use('/api/meeting-prep', require('../routes/meeting-prep-view'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => { db.clearCalendarCache('graph'); });

// ── Saving: the shape on disk and in the receipt ─────────────────────────────

test('active meeting: the note carries the kind and the DIARY’s meeting; the receipt names both and the file', () => {
  seedRunningMeeting();
  const key = runningKey();
  assert.ok(key, 'positive control: the fixture reads as a running meeting');
  const r = mobileSync.applyOperation('dev-1', op(MC.meetingPayload({ text: 'We ship the escalation map on Friday.', kind: 'decision', meeting: { key, subject: 'anything the device says' } })));
  assert.equal(r.status, 'applied');
  const note = readNote(r);
  assert.match(note, /^---\ndate: .+\nsource: neuro-mobile\nstatus: unprocessed\ncapture_kind: decision\nmeeting: "Sprint Planning Discussion"\nmeeting_start: .+\nmeeting_event_id: "evt-sprint"\n---\n\nDecision — from the meeting “Sprint Planning Discussion” \(\d{2}:\d{2}\)\.\n\nWe ship the escalation map on Friday\.\n$/);
  assert.doesNotMatch(note, /anything the device says/, 'the subject is the DIARY’s, never the device’s');
  const d = JSON.parse(r.detail);
  assert.equal(d.captureKind, 'decision');
  assert.equal(d.meeting.subject, SUBJECT);
  assert.equal(d.meetingWhy, null);
  const said = MC.receiptLine({ state: 'confirmed' }, r, { kind: 'decision', meeting: { key, subject: SUBJECT } });
  assert.equal(said.msg, `Saved to NEURO — your decision from “${SUBJECT}”, in ${d.path}.`);
  assert.match(d.path, /^Imports\/.+\.md$/);
});

test('missing / unconfirmable meeting context: saved, NOT linked, and the receipt says why', () => {
  // A key NEURO cannot match (meeting gone, or never real): no meeting in the note.
  seedRunningMeeting();
  const r = mobileSync.applyOperation('dev-1', op(MC.meetingPayload({ text: 'Risk: the vendor date slips.', kind: 'risk', meeting: { key: 'id:not-a-meeting::2026-10-21T09:00:00', subject: 'X' } })));
  assert.equal(r.status, 'applied');
  const note = readNote(r);
  assert.match(note, /capture_kind: risk\n/);
  assert.doesNotMatch(note, /^meeting/m);
  assert.equal(MC.receiptLine({ state: 'confirmed' }, r, { kind: 'risk' }).msg,
    `Saved to NEURO — your risk, in ${JSON.parse(r.detail).path}. NEURO couldn’t confirm the meeting from the diary, so it isn’t linked to it.`);
  // A solo block is not a meeting: the same key test refuses it.
  db.clearCalendarCache('graph');
  seedRunningMeeting({ id: 'evt-solo', attendeesOther: false });
  const solo = mobileSync.applyOperation('dev-1', op(MC.meetingPayload({ text: 'x', kind: 'risk', meeting: { key: meetingFinish.keyFor({ id: 'evt-solo', start: iso(Date.now()) }), subject: 'Focus' } })));
  assert.equal(JSON.parse(solo.detail).meeting, null);
  // NEURO named no meeting at all: no key travels, and the receipt says no meeting was named.
  const p = MC.meetingPayload({ text: 'Follow up with Kit.', kind: 'follow-up', meeting: null });
  assert.equal(p.meetingKey, undefined);
  const none = mobileSync.applyOperation('dev-1', op(p));
  assert.equal(MC.receiptLine({ state: 'confirmed' }, none, { kind: 'follow-up' }).msg, `Saved to NEURO — your follow-up, in ${JSON.parse(none.detail).path}. No meeting was named, so it isn’t linked to one.`);
  assert.equal(MC.meetingLine(null), 'In a meeting — NEURO didn’t say which one, so this won’t be linked to a meeting.');
});

test('a capture made OFFLINE mid-meeting is linked by when it was made, not when it arrived', () => {
  const now = Date.now();
  seedRunningMeeting({ start: iso(now - 90 * 60000), end: iso(now - 30 * 60000) }); // ended half an hour ago
  const ev = { id: 'evt-sprint', start: iso(now - 90 * 60000) };
  const r = mobileSync.applyOperation('dev-1', op(MC.meetingPayload({ text: 'Commitment: Kit owns the map.', kind: 'commitment', meeting: { key: null } }), { createdAt: iso(now - 60 * 60000) }));
  assert.equal(JSON.parse(r.detail).meeting, undefined, 'no key, no lookup');
  // With the key it was captured under — the diary confirms it was running THEN.
  const cal = attention.meetingEventByKey(meetingFinish.keyFor({ ...ev, start: db.getCalendarEvents(iso(now - 86400000).slice(0, 10), iso(now + 86400000).slice(0, 10) + 'T23:59:59').find((e) => e.event_id === 'evt-sprint').start_time }), new Date(now - 60 * 60000));
  assert.ok(cal, 'positive control: the key resolves at capture time');
  const key = meetingFinish.keyFor(cal);
  const later = mobileSync.applyOperation('dev-1', op(MC.meetingPayload({ text: 'Commitment: Kit owns the map.', kind: 'commitment', meeting: { key } }), { createdAt: iso(now - 60 * 60000) }));
  assert.equal(JSON.parse(later.detail).meeting.subject, SUBJECT);
});

test('offline queue: the receipt says queued on this device, names the meeting, and claims nothing in NEURO', () => {
  const q = MC.receiptLine({ state: 'pending' }, null, { kind: 'decision', meeting: { key: 'k', subject: SUBJECT } });
  assert.equal(q.msg, `Queued on this device — not in NEURO yet. It names “${SUBJECT}”; NEURO checks that against the diary when it arrives.`);
  assert.equal(MC.receiptLine({ state: 'pending' }, null, { kind: 'decision', meeting: null }).msg, 'Queued on this device — not in NEURO yet.');
});

test('refusal: an unknown kind is REFUSED by NEURO (not saved as a plain note), and the receipt says NOT saved', () => {
  const bad = mobileSync.applyOperation('dev-1', op({ content: 'x', captureKind: 'summary' }));
  assert.equal(bad.status, 'rejected');
  assert.match(bad.detail, /captureKind must be one of decision, commitment, risk, follow-up/);
  const said = MC.receiptLine({ state: 'refused', message: `NOT saved — ${bad.detail}.` }, bad, { kind: 'decision' });
  assert.equal(said.ok, false);
  assert.match(said.msg, /^NOT saved — .+ Your words are kept in Waiting below\.$/);
});

test('generic capture outside a meeting is unchanged: no kind, no meeting, the same note', () => {
  seedRunningMeeting();
  const r = mobileSync.applyOperation('dev-1', op({ content: 'Buy milk', title: 'Shop' }));
  const note = readNote(r);
  assert.match(note, /^---\ndate: .+\nsource: neuro-mobile\nstatus: unprocessed\ntitle: "Shop"\n---\n\n# Shop\n\nBuy milk\n$/);
  const d = JSON.parse(r.detail);
  assert.equal(d.captureKind, undefined);
  assert.equal(d.meeting, undefined);
});

test('nothing becomes a task, a promise or an outbound action', () => {
  const before = db.get('SELECT COUNT(*) AS n FROM tasks').n;
  seedRunningMeeting();
  mobileSync.applyOperation('dev-1', op(MC.meetingPayload({ text: 'Commitment: I send Kit the map.', kind: 'commitment', meeting: { key: runningKey() } })));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, before);
  let pa = 0;
  try { pa = db.get('SELECT COUNT(*) AS n FROM prepared_actions').n; } catch { pa = 0; }
  assert.equal(pa, 0);
});

// ── Prep: THIS meeting ───────────────────────────────────────────────────────

test('Open meeting prep: ?event= returns THAT meeting, even while it runs; unknown is said, never swapped', async () => {
  seedRunningMeeting();
  const later = Date.now() + 60 * 60000;
  db.upsertCalendarEvent({ id: 'evt-next', subject: '1-2-1 — Nick / Sebastian', start: iso(later), end: iso(later + 30 * 60000), isAllDay: false, showAs: 'busy', attendeesOther: true });
  const generic = await (await fetch(`${base}/api/meeting-prep`)).json();
  assert.equal(generic.meeting.event_id, 'evt-next', 'the old answer: the NEXT meeting — wrong during a meeting');
  const exact = await (await fetch(`${base}/api/meeting-prep?event=evt-sprint`)).json();
  assert.equal(exact.meeting.event_id, 'evt-sprint');
  assert.equal(exact.meeting.subject, SUBJECT);
  assert.equal(exact.meeting.inProgress, true);
  assert.ok(exact.meeting.prep, 'with its prep');
  const missing = await (await fetch(`${base}/api/meeting-prep?event=evt-gone`)).json();
  assert.equal(missing.meeting, null);
  assert.match(missing.message, /can’t find that meeting/);
  assert.equal((await fetch(`${base}/api/meeting-prep?event=`)).status, 400);
});

test('the hand-off’s prep link carries the exact event id to the Prep view', async () => {
  const S = await import(pathToFileURL(path.join(ROOT, 'saim/shared-ui/presentation/nextStep.mjs')).href);
  assert.equal(S.prepEventId('neuro:?item=meeting-prep%3AAAMk%2Fx%3D'), 'AAMk/x=');
  assert.equal(S.prepEventId('neuro:?item=task%3A5'), null);
  const outB = await esbuild.build({ entryPoints: [path.join(ROOT, 'saim/app/src/views/MeetingPrep.jsx')], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], plugins: [stub()], logLevel: 'silent' });
  assert.ok(outB.outputFiles[0].text.includes('/api/meeting-prep?event='));
});

// ── The Capture view ─────────────────────────────────────────────────────────

function stub() {
  return { name: 'stub', setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
    b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
    b.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
    b.onResolve({ filter: /mobile\/outbox$/ }, () => ({ path: 'outbox', namespace: 'stub' }));
    b.onLoad({ filter: /^api$/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({});', loader: 'js' }));
    b.onLoad({ filter: /^outbox$/, namespace: 'stub' }, () => ({ contents: 'export const enqueue=async()=>({});export const flush=async()=>({receipts:{}});export const discard=async()=>{};export const retry=async()=>{};export const outcomeFor=()=>({state:"pending"});export const pending=async()=>[];export const subscribe=()=>()=>{};', loader: 'js' }));
  } };
}
let Capture;
async function loadCapture() {
  if (Capture) return Capture;
  global.window = global.window || { addEventListener() {}, removeEventListener() {}, location: { search: '' } };
  const out = await esbuild.build({ entryPoints: [path.join(ROOT, 'saim/app/src/views/Capture.jsx')], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], plugins: [stub()], logLevel: 'silent' });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  Capture = mod.exports.default;
  return Capture;
}
const html = async (props) => renderToString(React.createElement(await loadCapture(), props)).split('<!-- -->').join('');
const btns = (h) => [...h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

test('render: meeting-aware Capture names the meeting, offers the four kinds, and no Todo/Feature', async () => {
  const h = await html({ context: { meeting: { key: 'k', subject: SUBJECT, scheduledEnd: '2026-10-21T12:30:00' } } });
  assert.ok(h.includes(`From “${SUBJECT}” · until 12:30`));
  const b = btns(h);
  for (const k of ['Decision', 'Commitment', 'Risk', 'Follow-up', 'Plain capture instead', 'Save decision']) assert.ok(b.includes(k), k);
  assert.ok(!b.includes('Todo') && !b.includes('Feature'), JSON.stringify(b));
  assert.ok(h.includes('The decision, in your words'));
});

test('render: meeting context missing → says it won’t be linked; no context → normal generic Capture', async () => {
  const none = await html({ context: { meeting: null } });
  assert.ok(none.includes('NEURO didn’t say which one'));
  const plain = await html({});
  const b = btns(plain);
  for (const k of ['Note', 'Todo', 'Feature', 'Save note']) assert.ok(b.includes(k), k);
  assert.ok(!plain.includes('cap__meeting'));
});

test('kiosk / wall: the home offers NO capture step — the wall keeps its read-only home', async () => {
  const S = await import(pathToFileURL(path.join(ROOT, 'saim/shared-ui/presentation/nextStep.mjs')).href);
  const kiosk = { external: false, tab: (id) => id === 'prep', desk: false, neuro: false };
  assert.equal(S.nextStep({ handoff: null, presentation: { mode: 'in-meeting' }, context: { activity: 'in-meeting' }, meeting: { key: 'k', subject: SUBJECT }, can: kiosk }), null);
  const src = fs.readFileSync(path.join(ROOT, 'saim/shared-ui/AttentionSurface.jsx'), 'utf8');
  assert.match(src, /id === 'capture' && prof !== 'kiosk' && prof !== 'watch'/);
});
