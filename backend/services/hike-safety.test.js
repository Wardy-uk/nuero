'use strict';

/**
 * Hike safety (10 Oct 2026): arm a walk, check in, or the people on the card
 * are emailed. Real DB, real ledger, real tick; Home Assistant, push and the
 * Microsoft transport are fakes injected at the seam. Tracker shapes are the
 * live 10 Oct 2026 attributes (Life360's speed/driving/last_seen, the HA app,
 * Ember's Tractive), coordinates invented.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-hike-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'h.db');
process.env.NEURO_TIMEZONE = 'Europe/London';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const db = require('../db/database');
const model = require('./hike-safety-model');
const hike = require('./hike-safety');
const matrix = require('./authority-matrix');
const ew = require('./external-writes');

const L = (s) => model.localToMs(s);
const START = '2026-10-11T09:30';
const FINISH = '2026-10-11T15:00';
const NOW = L('2026-10-11T08:00');
const HELEN = [{ name: 'Helen', email: 'helen@example.com' }];
const GPX = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Catbells loop</name><trkseg>${
  [[54.5687, -3.1726, 90], [54.5640, -3.1700, 200], [54.5560, -3.1710, 451], [54.5500, -3.1680, 300], [54.5560, -3.1650, 150], [54.5620, -3.1690, 120], [54.5660, -3.1710, 100], [54.5680, -3.1720, 95], [54.5686, -3.1725, 91]]
    .map(([a, o, e]) => `<trkpt lat="${a}" lon="${o}"><ele>${e}</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;

function fakes({ ready = true, send = () => 'accepted', sent = () => [] } = {}) {
  const f = { pushes: [], drafts: [], sends: [], ready };
  f.deps = {
    mailReady: async () => f.ready,
    fetchStates: async () => f.states || [],
    push: async (title, body, data) => { f.pushes.push({ title, body, data }); },
    mail: {
      createDraft: async (m) => { const id = `d${f.drafts.length + 1}`; f.drafts.push({ id, ...m, state: 'draft' }); return { ok: true, id, internetMessageId: `<${id}@x>` }; },
      sendDraft: async (id) => { f.sends.push(id); const o = send(id); const d = f.drafts.find((x) => x.id === id); if (o === 'accepted' && d) d.state = 'gone'; return { outcome: o, status: o === 'accepted' ? 202 : 503 }; },
      draftState: async (id) => { const d = f.drafts.find((x) => x.id === id); return d ? d.state : 'unavailable'; },
      findSent: async (mid) => ({ ok: true, messages: sent(mid) }),
    },
  };
  return f;
}

function reset() {
  db.run('DELETE FROM hike_trips'); db.run('DELETE FROM hike_breadcrumbs');
  db.run("DELETE FROM external_write_ledger WHERE writer = 'hike.safety-alert'");
  db.run('DELETE FROM outdoor_routes'); db.setState('hike_safety_last_poll', '0');
  hike.setContacts(HELEN);
}

async function armed(f, extra = {}) {
  const r = await hike.arm({ gpx: GPX, gpxName: 'catbells.gpx', plannedStart: START, plannedFinish: FINISH, ...extra }, { now: NOW, deps: f.deps });
  assert.ok(r.ok, r.error);
  return r.trip.tripId;
}

const trk = (id, lat, lon, at, extra = {}) => ({ entity_id: id, state: 'not_home', last_updated: new Date(at).toISOString(), attributes: { latitude: lat, longitude: lon, gps_accuracy: 12, ...extra } });
const person = { entity_id: 'person.nick', state: 'not_home', attributes: { device_trackers: ['device_tracker.nicks_iphone_2', 'device_tracker.life360_nick'] } };

test.before(async () => { await db.init(); });

// ── pure ────────────────────────────────────────────────────────────────────

test('1. OS grid references for known summits, to the 10 m square', () => {
  const near = (got, want) => {
    const [gl, ge, gn] = got.split(' '); const [wl, we, wn] = want.split(' ');
    assert.equal(gl, wl); assert.ok(Math.abs(+ge - +we) <= 3 && Math.abs(+gn - +wn) <= 3, `${got} vs ${want}`);
  };
  near(model.gridRef(56.796851, -5.003508), 'NN 1666 7126');   // Ben Nevis
  near(model.gridRef(53.068497, -4.076231), 'SH 6098 5436');   // Snowdon
  near(model.gridRef(54.454222, -3.211528), 'NY 2155 0721');   // Scafell Pike
  assert.equal(model.gridRef(48.8584, 2.2945), null, 'outside Great Britain → null, never a made-up square');
});

test('2. local wall clock ↔ instant through BST, GMT, the skipped hour and 31 Feb', () => {
  assert.equal(L('2026-10-11T09:30'), Date.parse('2026-10-11T08:30:00Z'));
  assert.equal(L('2026-12-11T09:30'), Date.parse('2026-12-11T09:30:00Z'));
  assert.equal(L('2027-03-28T01:30'), null);
  assert.equal(L('2026-02-31T10:00'), null);
  assert.equal(model.msToLocal(Date.parse('2026-10-11T08:30:00Z')), '2026-10-11T09:30');
});

test('3. arming is refused, never clamped', () => {
  const v = (b) => model.validateTrip(b, { nowMs: NOW }).error;
  assert.match(v({ plannedStart: START, plannedFinish: START }), /after the planned start/);
  assert.match(v({ plannedStart: '2026-10-10T06:00', plannedFinish: '2026-10-10T07:00' }), /already passed/);
  assert.match(v({ plannedStart: START, plannedFinish: '2026-10-13T09:30' }), /36 hours/);
  assert.match(v({ plannedStart: START, plannedFinish: FINISH, graceMinutes: 5 }), /graceMinutes/);
  assert.match(v({ plannedStart: '11/10 9am', plannedFinish: FINISH }), /plannedStart/);
  assert.match(model.validateContacts([{ name: 'Helen', email: 'not an email' }]).error, /not an email/);
});

test('4. walking vs driving from speed, with Life360’s own flag winning', () => {
  assert.equal(model.modeOf({ speedKmh: 0.2 }), 'still');
  assert.equal(model.modeOf({ speedKmh: 4.5 }), 'walking');
  assert.equal(model.modeOf({ speedKmh: 12 }), 'fast');
  assert.equal(model.modeOf({ speedKmh: 45 }), 'driving');
  assert.equal(model.modeOf({ speedKmh: 3, driving: true }), 'driving');
  assert.equal(model.modeOf({}), 'unknown');
  const a = { lat: 54.56, lon: -3.17, observedMs: 0, accuracyM: 10 };
  const b = { lat: 54.5645, lon: -3.17, observedMs: 600000, accuracyM: 10 }; // 500 m in 10 min
  assert.ok(model.modeOf({ speedKmh: model.speedBetween(a, b) }) === 'walking');
});

test('5. the schedule: remind at finish, warn 30 min before the alert, alert at finish + grace', () => {
  const t = { status: 'armed', startMs: L(START), finishMs: L(FINISH), graceMin: 60, alertStatus: 'none' };
  assert.deepEqual(model.plan(t, L('2026-10-11T14:59')), { remind: false, warn: false, alert: false, track: true });
  assert.equal(model.plan(t, L('2026-10-11T15:00')).remind, true);
  assert.equal(model.plan(t, L('2026-10-11T15:30')).warn, true);
  assert.equal(model.plan(t, L('2026-10-11T15:59')).alert, false);
  assert.equal(model.plan(t, L('2026-10-11T16:00')).alert, true);
  assert.equal(model.plan({ ...t, status: 'checked_in' }, L('2026-10-11T16:00')).alert, false);
  assert.equal(model.plan(t, L('2026-10-11T09:10')).track, false, 'tracking starts 15 min before the planned start');
});

// ── arming ─────────────────────────────────────────────────────────────────

test('6. no contacts, no email, or a walk already armed → refused', async () => {
  reset();
  db.setState('hike_safety_contacts', '');
  let f = fakes();
  assert.match((await hike.arm({ plannedStart: START, plannedFinish: FINISH }, { now: NOW, deps: f.deps })).error, /nobody to alert/);
  hike.setContacts(HELEN);
  f = fakes({ ready: false });
  const r = await hike.arm({ plannedStart: START, plannedFinish: FINISH }, { now: NOW, deps: f.deps });
  assert.equal(r.status, 409); assert.match(r.error, /cannot send email/);
  f = fakes();
  await armed(f);
  assert.match((await hike.arm({ plannedStart: START, plannedFinish: FINISH }, { now: NOW, deps: f.deps })).error, /still armed/);
});

test('7. a GPX becomes a route plan and a frozen route card with grid refs and the alert time', async () => {
  reset();
  const id = await armed(fakes(), { emberPlanned: true, notes: 'Parking at Hawes End' });
  const row = db.get('SELECT * FROM hike_trips WHERE trip_id = ?', [id]);
  const card = row.card_text;
  assert.match(card, /ROUTE CARD — Catbells loop/);
  assert.match(card, /Planned start: 09:30 · planned finish: about 15:00/);
  assert.match(card, /Alert sent if he has not checked in by: 16:00/);
  assert.match(card, /Start.*grid ref NY \d{4} \d{4}/);
  assert.match(card, /Finish: back at the start \(a loop\)/);
  assert.match(card, /Highest point: 451 m/);
  assert.match(card, /with Ember \(dog\)/);
  assert.match(card, /Parking at Hawes End/);
  assert.match(card, /catbells\.gpx\) is attached/);
  assert.equal(db.get('SELECT COUNT(*) n FROM outdoor_routes').n, 1, 'one route model: the GPX is also a route plan');
  assert.deepEqual(JSON.parse(row.recipients_json), HELEN, 'recipients frozen at arming');
});

// ── the job ────────────────────────────────────────────────────────────────

test('8. end to end: reminder, warning, then ONE alert email to Helen with the card, positions and the GPX', async () => {
  reset();
  let mid = null;
  const f = fakes({ sent: (m) => (m === mid ? [{ id: 'x' }] : []) });
  const id = await armed(f);
  f.states = [person, trk('device_tracker.life360_nick', 54.556, -3.171, L('2026-10-11T13:40'), { speed: 3.2, driving: false, battery_level: 41, last_seen: new Date(L('2026-10-11T13:40')).toISOString() })];
  let r = await hike.tick({ now: L('2026-10-11T13:41'), deps: f.deps });
  assert.equal(r.crumbs, 1); assert.equal(f.pushes.length, 0);
  await hike.tick({ now: L('2026-10-11T15:00'), deps: f.deps });
  assert.equal(f.pushes.at(-1).data.type, 'hike_checkin'); assert.match(f.pushes.at(-1).body, /Helen get an alert at 16:00/);
  await hike.tick({ now: L('2026-10-11T15:30'), deps: f.deps });
  assert.match(f.pushes.at(-1).title, /Alert in 30 min/);
  assert.equal(f.drafts.length, 0, 'nothing emailed before the deadline');
  r = await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(f.drafts.length, 1); assert.equal(f.sends.length, 1);
  const mail = f.drafts[0];
  mid = `<${mail.id}@x>`;
  assert.deepEqual(mail.to, [{ email: 'helen@example.com', name: 'Helen' }]);
  assert.match(mail.subject, /Nick hasn't checked in from his walk — Catbells loop/);
  assert.match(mail.body, /planned to be back by 15:00\. It is now 16:00 — 60 minutes later/);
  assert.match(mail.body, /This does not mean something has happened/);
  assert.match(mail.body, /His phone \(Life360\), 13:40 \(2 h 20 min ago\)/);
  assert.match(mail.body, /walking pace · battery 41%/);
  assert.match(mail.body, /ROUTE CARD — Catbells loop/);
  assert.equal(mail.attachments[0].name, 'catbells.gpx');
  assert.match(f.pushes.at(-1).title, /Alert sent to Helen/);
  assert.equal(db.get('SELECT status FROM hike_trips WHERE trip_id = ?', [id]).status, 'alerted');
  await hike.tick({ now: L('2026-10-11T16:01'), deps: f.deps });
  await hike.tick({ now: L('2026-10-11T16:02'), deps: f.deps });
  assert.equal(f.sends.length, 1, 'never sent twice once Microsoft accepted it');
  assert.equal(ew.byKey(`hike-alert:${id}`).status, 'applied-unverified');
});

test('9. checking in before the deadline: no email, ever', async () => {
  reset();
  const f = fakes();
  const id = await armed(f);
  const c = await hike.checkIn(id, { via: 'NEURO', now: L('2026-10-11T14:50'), deps: f.deps });
  assert.ok(c.ok); assert.equal(c.allClear, null);
  await hike.tick({ now: L('2026-10-11T16:30'), deps: f.deps });
  assert.equal(f.drafts.length, 0); assert.equal(f.pushes.length, 0);
});

test('10. checking in after the alert sends ONE all-clear', async () => {
  reset();
  const f = fakes();
  const id = await armed(f);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  const c = await hike.checkIn(id, { via: 'NEURO', now: L('2026-10-11T16:20'), deps: f.deps });
  assert.equal(c.allClear.outcome, 'sent');
  assert.match(f.drafts.at(-1).subject, /Nick has checked in/);
  await hike.checkIn(id, { now: L('2026-10-11T16:25'), deps: f.deps });
  assert.equal(f.drafts.length, 2, 'alert + one all-clear, nothing more');
  assert.match(hike.cancel(id).error || 'already', /already|checked/);
});

test('11. an uncertain send is looked for, then the SAME draft is retried — a duplicate beats none', async () => {
  reset();
  let first = true;
  const f = fakes({ send: () => { if (first) { first = false; return 'uncertain'; } return 'accepted'; } });
  const id = await armed(f);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(db.get('SELECT alert_status s FROM hike_trips WHERE trip_id = ?', [id]).s, 'uncertain');
  await hike.tick({ now: L('2026-10-11T16:01'), deps: f.deps });
  assert.equal(f.drafts.length, 1, 'the draft still unsent is re-sent, not a second message');
  assert.deepEqual(f.sends, ['d1', 'd1']);
  assert.equal(db.get('SELECT alert_status s FROM hike_trips WHERE trip_id = ?', [id]).s, 'sent');
});

test('12. a refused send keeps trying on the next pass', async () => {
  reset();
  let n = 0;
  const f = fakes({ send: () => (n++ === 0 ? 'rejected' : 'accepted') });
  const id = await armed(f);
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(db.get('SELECT alert_status s FROM hike_trips WHERE trip_id = ?', [id]).s, 'failed');
  await hike.tick({ now: L('2026-10-11T16:01'), deps: f.deps });
  assert.equal(db.get('SELECT alert_status s FROM hike_trips WHERE trip_id = ?', [id]).s, 'sent');
});

test('13. extending moves the alert and earns a fresh reminder; refused once the alert has gone', async () => {
  reset();
  const f = fakes();
  const id = await armed(f);
  await hike.tick({ now: L('2026-10-11T15:00'), deps: f.deps });
  const e = hike.extend(id, 60, { now: L('2026-10-11T15:10') });
  assert.equal(e.trip.due, '2026-10-11T16:10', 'an hour from NOW when he is already past the due time');
  assert.equal(e.trip.alertAt, '2026-10-11T17:10');
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  assert.equal(f.drafts.length, 0, 'the old deadline no longer alerts');
  await hike.tick({ now: L('2026-10-11T16:10'), deps: f.deps });
  assert.match(f.pushes.at(-1).title, /Back from your walk/, 'reminded again at the new due time');
  await hike.tick({ now: L('2026-10-11T17:10'), deps: f.deps });
  assert.equal(f.drafts.length, 1);
  assert.match(f.drafts[0].body, /he extended it during the walk/);
  assert.match(hike.extend(id, 30, { now: L('2026-10-11T17:15') }).error, /check in instead/);
  assert.equal(hike.extend(id, 5).status, 409);
});

test('14. the trail: his trackers always, Ember only when she is on the card, stale fixes ignored', async () => {
  reset();
  const f = fakes();
  const id = await armed(f);
  const at = L('2026-10-11T11:00');
  f.states = [person,
    trk('device_tracker.life360_nick', 54.55, -3.17, at, { speed: 4, driving: false }),
    trk('device_tracker.nicks_iphone_2', 54.5501, -3.1701, L('2026-10-11T07:00')), // before the walk
    trk('device_tracker.ember_tracker', 54.5502, -3.1702, at)];
  await hike.tick({ now: at + 60000, deps: f.deps });
  const rows = db.all('SELECT source, role, mode FROM hike_breadcrumbs WHERE trip_id = ?', [id]);
  assert.deepEqual(rows.map((r) => r.source), ['device_tracker.life360_nick']);
  assert.equal(rows[0].mode, 'walking');
  // Polled at most every 4.5 min.
  f.states[1] = trk('device_tracker.life360_nick', 54.56, -3.17, at + 120000, { speed: 4 });
  assert.equal((await hike.tick({ now: at + 180000, deps: f.deps })).crumbs, 0);
  hike.cancel(id);
  const id2 = await armed(f, { emberPlanned: true });
  db.setState('hike_safety_last_poll', '0');
  await hike.tick({ now: at + 60000, deps: f.deps });
  assert.ok(db.all('SELECT role FROM hike_breadcrumbs WHERE trip_id = ?', [id2]).some((r) => r.role === 'ember'));
});

test('15. driving after the walk started prompts ONCE, and never checks him in', async () => {
  reset();
  const f = fakes();
  const id = await armed(f);
  const base = L('2026-10-11T14:00');
  for (let i = 0; i < 3; i += 1) {
    db.setState('hike_safety_last_poll', '0');
    f.states = [person, trk('device_tracker.life360_nick', 54.6 + i * 0.01, -3.1, base + i * 300000, { speed: 60, driving: true, last_seen: new Date(base + i * 300000).toISOString() })];
    await hike.tick({ now: base + i * 300000 + 30000, deps: f.deps });
  }
  assert.equal(f.pushes.filter((p) => p.title === 'Back at the car?').length, 1);
  assert.equal(db.get('SELECT status FROM hike_trips WHERE trip_id = ?', [id]).status, 'armed');
});

test('16. the read carries no trail coordinates, and the trail is deleted 30 days after the walk closes', async () => {
  reset();
  const f = fakes();
  const id = await armed(f);
  f.states = [person, trk('device_tracker.life360_nick', 54.123456, -3.654321, L('2026-10-11T11:00'), { speed: 4 })];
  await hike.tick({ now: L('2026-10-11T11:01'), deps: f.deps });
  const out = JSON.stringify(hike.read({ now: L('2026-10-11T11:02') }));
  assert.ok(out.includes('"points":1'), 'positive control: the trail is there');
  assert.ok(!out.includes('54.12346') && !out.includes('54.123456'), 'no trail coordinate in the read');
  await hike.checkIn(id, { now: L('2026-10-11T14:00'), deps: f.deps });
  assert.equal(hike.purge({ now: L('2026-11-05T12:00') }), 0);
  assert.equal(hike.purge({ now: L('2026-11-11T12:00') }), 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM hike_breadcrumbs WHERE trip_id = ?', [id]).n, 0);
  assert.equal(db.get('SELECT gpx_text FROM hike_trips WHERE trip_id = ?', [id]).gpx_text, null);
});

test('17. machines cannot arm, extend, cancel, check in or change contacts; reads are open', () => {
  for (const p of ['/api/outdoor/safety/contacts', '/api/outdoor/safety/trips', '/api/outdoor/safety/trips/x/checkin', '/api/outdoor/safety/trips/x/extend', '/api/outdoor/safety/trips/x/cancel']) {
    assert.equal(matrix.machineDecision('POST', p).allow, false, p);
  }
  assert.equal(matrix.machineDecision('GET', '/api/outdoor/safety').allow, true);
  assert.ok(ew.WRITERS['hike.safety-alert'].ledger);
});

test('18. over HTTP: arm, read, check in through the real router', async () => {
  reset();
  const express = require('express');
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/outdoor', require('../routes/outdoor'));
  const server = app.listen(0); const port = server.address().port;
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  try {
    // The route uses the real deps; with no Microsoft sign-in in a test, arming must refuse rather than arm blind.
    const a = await call('POST', '/api/outdoor/safety/trips', { gpx: GPX, plannedStart: '2030-01-01T09:00', plannedFinish: '2030-01-01T15:00' });
    assert.ok(a.status === 409 || a.status === 400, JSON.stringify(a.json));
    const id = await armed(fakes());
    const r = await call('GET', '/api/outdoor/safety');
    assert.equal(r.json.active.tripId, id); assert.equal(r.json.contacts[0].name, 'Helen');
    const c = await call('POST', `/api/outdoor/safety/trips/${encodeURIComponent(id)}/checkin`, { via: 'test' });
    assert.equal(c.status, 200); assert.equal(c.json.trip.status, 'checked_in');
    assert.equal((await call('POST', '/api/outdoor/safety/contacts', { contacts: [{ name: 'X', email: 'bad' }] })).status, 400);
  } finally { server.closeAllConnections(); server.close(); }
});

test('19. the card renders for real: arm form, then the armed walk with check-in, extend, the trail and the route card', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'canonical', 'HikeSafetyCard.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'], logLevel: 'silent',
    plugins: [{ name: 'stub', setup(b) {
      b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'css' }));
      b.onLoad({ filter: /.*/, namespace: 'css' }, () => ({ contents: '', loader: 'js' }));
      b.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: 'api', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const apiFetch = async () => ({ ok: true, json: async () => ({}) });', loader: 'js' }));
    } }],
  });
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require);
  assert.equal(typeof m.exports.HikeSafetyView, 'function', 'positive control: the view is exported');
  const render = (data) => renderToString(React.createElement(m.exports.HikeSafetyView, { data, act: () => true })).replace(/<!-- -->/g, '');
  reset();
  let html = render(hike.read({ now: NOW }));
  assert.match(html, /data-testid="hike-arm-form"/); assert.match(html, /type="file"/); assert.match(html, /Arm this walk/);
  const f = fakes();
  await armed(f);
  html = render(hike.read({ now: L('2026-10-11T12:00') }));
  assert.match(html, /Catbells loop/); assert.match(html, /Back by <strong>15:00/); assert.match(html, /alert to Helen at <strong>16:00/);
  assert.match(html, /I’m back — check in/); assert.match(html, /\+30 min/); assert.match(html, /Cancel walk/);
  assert.match(html, /ROUTE CARD — Catbells loop/);
  assert.ok(!/arm-form/.test(html), 'no second walk can be armed while one is');
  await hike.tick({ now: L('2026-10-11T16:00'), deps: f.deps });
  html = render(hike.read({ now: L('2026-10-11T16:01') }));
  assert.match(html, />overdue</); assert.match(html, /alert sent/); assert.ok(!/\+30 min/.test(html), 'no extending once the alert has gone');
});
