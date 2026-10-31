'use strict';
/**
 * The shared family Google calendar (18 Oct 2026): sign-in, sync, and the
 * wall's add / edit / delete — against a FAKE Google at the fetch layer, a real
 * database and the real /api/v routes. Every write must be read back from
 * "Google" before it answers ok.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-gcal-'));
process.env.NEURO_DB_PATH = path.join(root, 'g.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';
delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
delete process.env.GOOGLE_CALENDAR_TARGET;

const db = require('../db/database');
const gcal = require('./google-calendar');
const capture = require('./capture-links');

const pad = (n) => String(n).padStart(2, '0');
const keyOffset = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };

/** A tiny Google: events by id in one calendar. */
function fakeGoogle() {
  const g = { personal: [], personalDown: false, events: new Map(), calls: [], failNextPost: null, dropOnPost: false, refreshFails: false, ignorePatch: false };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    g.calls.push(`${method} ${u.pathname}`);
    const reply = (status, body) => ({ status, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(init.body);
      if (p.get('grant_type') === 'authorization_code') {
        return p.get('code') === 'good-code' && p.get('code_verifier')
          ? reply(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: gcal.SCOPE })
          : reply(400, { error: 'invalid_grant' });
      }
      if (g.refreshFails) return reply(400, { error: 'invalid_grant' });
      return reply(200, { access_token: 'at2', expires_in: 3600 });
    }
    if (init.headers && init.headers.Authorization !== 'Bearer at1' && init.headers.Authorization !== 'Bearer at2') return reply(401, {});
    const m = /\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return reply(404, {});
    if (decodeURIComponent(m[1]) === 'ward.nickj@gmail.com' && !m[2] && method === 'GET') {
      return g.personalDown ? reply(403, { error: { message: 'Forbidden' } }) : reply(200, { items: g.personal });
    }
    if (decodeURIComponent(m[1]) !== 'ward.calander@gmail.com') return reply(404, { error: { message: 'Not Found' } });
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    if (!id && method === 'GET') return reply(200, { items: [...g.events.values()].filter((e) => e.status !== 'cancelled') });
    if (!id && method === 'POST') {
      const body = JSON.parse(init.body);
      if (g.failNextPost) { const s = g.failNextPost; g.failNextPost = null; return reply(s, { error: { message: 'nope' } }); }
      if (g.events.has(body.id)) return reply(409, { error: { message: 'The requested identifier already exists.' } });
      const ev = { id: body.id, status: 'confirmed', etag: '"1"', summary: body.summary, location: body.location, start: body.start, end: body.end };
      // Google answers dateTime in the requested zone with an offset.
      if (ev.start.dateTime) { ev.start = { dateTime: `${ev.start.dateTime}+01:00` }; ev.end = { dateTime: `${ev.end.dateTime}+01:00` }; }
      g.events.set(body.id, ev);
      if (g.dropOnPost) throw new Error('socket hang up');
      return reply(200, ev);
    }
    const ev = g.events.get(id);
    if (method === 'GET') return ev ? reply(200, ev) : reply(404, {});
    if (method === 'PATCH') {
      if (!ev) return reply(404, {});
      if (g.ignorePatch) return reply(200, ev); // says yes, changes nothing
      const body = JSON.parse(init.body);
      if (body.summary) ev.summary = body.summary;
      if (body.start) { ev.start = body.start.dateTime ? { dateTime: `${body.start.dateTime}+01:00` } : body.start; ev.end = body.end.dateTime ? { dateTime: `${body.end.dateTime}+01:00` } : body.end; }
      return reply(200, ev);
    }
    if (method === 'DELETE') { if (!ev) return reply(410, {}); ev.status = 'cancelled'; return reply(204, null); }
    return reply(405, {});
  };
  return g;
}

test('pure: pasted address, drafts, Google shapes', () => {
  assert.deepEqual(gcal.parsePasted('http://127.0.0.1:8765/?state=abc&code=4/xyz&scope=x'), { code: '4/xyz', state: 'abc', error: null });
  assert.equal(gcal.parsePasted('127.0.0.1:8765/?code=c1&state=s').code, 'c1');
  assert.equal(gcal.parsePasted('  rawcode ').code, 'rawcode');
  assert.equal(gcal.validateDraft({ title: '', date: '2026-10-20', start: '10:00' }).ok, false);
  assert.equal(gcal.validateDraft({ title: 'X', date: '2026-02-30', start: '10:00' }).ok, false, 'an impossible day is refused');
  assert.equal(gcal.validateDraft({ title: 'X', date: '2026-10-20', start: '10:00', end: '09:00' }).ok, false);
  const allDay = gcal.toGoogle(gcal.validateDraft({ title: 'Trip', date: '2026-10-20', allDay: true, endDate: '2026-10-22' }).draft);
  assert.deepEqual(allDay.end, { date: '2026-10-23' }, 'Google’s all-day end is exclusive');
  const timed = gcal.toGoogle(gcal.validateDraft({ title: 'Dentist', date: '2026-10-20', start: '10:00' }).draft);
  assert.equal(timed.start.dateTime, '2026-10-20T10:00:00');
  assert.equal(timed.end.dateTime, '2026-10-20T11:00:00', 'no end → an hour');
  assert.equal(timed.start.timeZone, 'Europe/London');
  const row = gcal.fromGoogle({ id: 'abc12', summary: 'Dentist', start: { dateTime: '2026-10-20T10:00:00+01:00' }, end: { dateTime: '2026-10-20T11:00:00+01:00' } });
  assert.equal(row.start_time, '2026-10-20T10:00:00', 'sliced, never re-parsed into another zone');
  assert.equal(gcal.fromGoogle({ id: 'abc12', status: 'cancelled', start: { date: '2026-10-20' } }), null);
  assert.match(gcal.newEventId(), /^[a-v0-9]{5,}$/, 'a valid Google event id');
});

test('sign-in, sync, then the wall adds, edits and deletes — each read back from Google', async () => {
  await db.init();
  const g = fakeGoogle();
  gcal._setFetch(g.fetch);

  // Setup refusals before anything works.
  assert.equal(gcal.setClient({ clientId: 'nonsense', clientSecret: 'x' }).ok, false);
  assert.equal(gcal.authUrl().ok, false, 'no client, no sign-in');
  assert.equal(gcal.setClient({ clientId: '123456-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret-value' }).ok, true);
  const start = gcal.authUrl();
  assert.ok(start.ok && start.url.includes('code_challenge_method=S256') && start.url.includes('access_type=offline'));
  const state = new URL(start.url).searchParams.get('state');
  assert.equal((await gcal.finish(`http://127.0.0.1:8765/?state=wrong&code=good-code`)).ok, false, 'a different sign-in is refused');
  const done = await gcal.finish(`http://127.0.0.1:8765/?state=${state}&code=good-code`);
  assert.equal(done.ok, true, done.error);
  const st = gcal.status();
  assert.equal(st.connected, true);
  assert.ok(!JSON.stringify(st).includes('GOCSPX') && !JSON.stringify(st).includes('rt1'), 'status never carries a secret or token');

  // The wall account.
  capture.create({ label: 'Wall', username: 'wall', pin: '246813', scopes: ['tasks', 'calendar', 'family-calendar'] });
  capture.create({ label: 'Reader', username: 'reader', pin: '246813', scopes: ['tasks', 'calendar'] });
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('../routes/vesta'));
  const server = app.listen(0); const port = server.address().port;
  const call = async (p, { token, body, method } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v${p}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  try {
    const wall = (await call('/login', { body: { username: 'wall', pin: '246813' } })).json.token;
    const reader = (await call('/login', { body: { username: 'reader', pin: '246813' } })).json.token;
    const day = keyOffset(2);

    const w0 = (await call('/wall', { token: wall })).json;
    assert.equal(w0.familyCalendar.canEdit, true);
    assert.equal((await call('/wall', { token: reader })).json.familyCalendar.canEdit, false);

    // A reader cannot write.
    assert.equal((await call('/family-calendar/events', { token: reader, body: { title: 'X', date: day, start: '10:00' } })).status, 403);

    // Add, with the wall's own id; a retry with the same id makes no second event.
    const id = gcal.newEventId();
    const add = await call('/family-calendar/events', { token: wall, body: { id, title: 'Dentist — Isaac', date: day, start: '10:00', end: '10:30', location: 'Coalville' } });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    assert.equal(add.json.created, true);
    assert.ok(g.calls.includes(`GET /calendar/v3/calendars/ward.calander%40gmail.com/events/${id}`.replace('%40', '@')) || g.calls.some((c) => c.startsWith('GET') && c.endsWith(id)), 'read back from Google');
    const again = await call('/family-calendar/events', { token: wall, body: { id, title: 'Dentist — Isaac', date: day, start: '10:00' } });
    assert.equal(again.status, 200);
    assert.equal(g.events.size, 1, 'one event in Google');

    // It is on the wall, editable, as family.
    const w1 = (await call('/wall', { token: wall })).json;
    const ev = w1.week.find((d) => d.date === day).events.find((e) => e.title === 'Dentist — Isaac');
    assert.ok(ev && ev.editable === true && ev.calendarId === id && ev.location === 'Coalville');

    // The phone's copy of the same event is not shown twice.
    db.upsertCalendarEvent({ id: `apple:X:${day}T10:00:00`, subject: 'Dentist — Isaac', start: `${day}T10:00:00`, end: `${day}T10:30:00`, isAllDay: false, showAs: 'busy', source: 'apple' });
    db.upsertCalendarEvent({ id: `apple:Y:${day}T15:00:00`, subject: 'Football', start: `${day}T15:00:00`, end: `${day}T16:00:00`, isAllDay: false, showAs: 'busy', source: 'apple' });
    const w2 = (await call('/wall', { token: wall })).json.week.find((d) => d.date === day).events;
    assert.equal(w2.filter((e) => e.title === 'Dentist — Isaac').length, 1, 'phone copy folded into Google’s');
    assert.ok(w2.find((e) => e.title === 'Football' && !e.editable), 'other calendars stay, view-only');

    // Edit.
    const ed = await call(`/family-calendar/events/${id}`, { token: wall, method: 'PATCH', body: { title: 'Dentist — Isaac', date: day, start: '11:00', end: '11:30' } });
    assert.equal(ed.status, 200, JSON.stringify(ed.json));
    assert.equal(g.events.get(id).start.dateTime.slice(11, 16), '11:00');
    assert.equal(db.get('SELECT start_time FROM google_calendar_events WHERE google_id = ?', [id]).start_time, `${day}T11:00:00`);
    // Google says 200 but holds the old time: NOT reported as saved.
    g.ignorePatch = true;
    const lie = await call(`/family-calendar/events/${id}`, { token: wall, method: 'PATCH', body: { date: day, start: '13:00' } });
    assert.equal(lie.status, 502, 'a change Google did not keep is not "saved"');
    g.ignorePatch = false;
    // A phone-only event cannot be edited through here.
    assert.equal((await call('/family-calendar/events/Yphoneonly', { token: wall, method: 'PATCH', body: { title: 'x' } })).status, 404);

    // A refused add answers not-saved, and Google holds nothing new.
    g.failNextPost = 403;
    const bad = await call('/family-calendar/events', { token: wall, body: { title: 'Nope', date: day, start: '12:00' } });
    assert.equal(bad.status, 502); assert.equal(g.events.size, 1);
    // A lost answer: Google kept it; the retry with the same id finds it (409) and confirms.
    g.dropOnPost = true;
    const id2 = gcal.newEventId();
    const lost = await call('/family-calendar/events', { token: wall, body: { id: id2, title: 'Swim', date: day, start: '17:00' } });
    assert.equal(lost.status, 502, 'unknown outcome: not reported as saved');
    g.dropOnPost = false;
    const retry = await call('/family-calendar/events', { token: wall, body: { id: id2, title: 'Swim', date: day, start: '17:00' } });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal([...g.events.values()].filter((e) => e.summary === 'Swim').length, 1, 'still one Swim');

    // Delete, read back as gone.
    const del = await call(`/family-calendar/events/${id}`, { token: wall, method: 'DELETE' });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.equal(g.events.get(id).status, 'cancelled');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM google_calendar_events WHERE google_id = ?', [id]).n, 0);
    // The phone copy shows again until the phone catches up — nothing invents a deletion.
    const w3 = (await call('/wall', { token: wall })).json.week.find((d) => d.date === day).events;
    assert.ok(w3.find((e) => e.title === 'Dentist — Isaac' && !e.editable));

    // A failed sync keeps the last good copy.
    g.refreshFails = true;
    const tok = JSON.parse(db.getState('google_cal_token')); tok.expiresAt = new Date(0).toISOString(); db.setState('google_cal_token', JSON.stringify(tok));
    const s2 = await gcal.syncNow();
    assert.equal(s2.ok, false);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM google_calendar_events').n, 1, 'Swim kept');
    assert.equal(gcal.status().connected, false, 'an expired sign-in is said, not hidden');
    assert.equal((await call('/wall', { token: wall })).json.familyCalendar.canEdit, false);
  } finally {
    server.close();
    gcal._setFetch(null);
  }
});

test('the personal calendar is read beside the family one, view-only, and fails on its own', async () => {
  const g = fakeGoogle();
  gcal._setFetch(g.fetch);
  // The previous test ends with an expired sign-in; start this one signed in.
  db.setState('google_cal_token', JSON.stringify({ refreshToken: 'rt1', accessToken: 'at1', expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  try {
    assert.deepEqual(gcal.readCalendars(), ['ward.calander@gmail.com', 'ward.nickj@gmail.com']);
    assert.equal(gcal.setExtraCalendars(['bad id']).ok, false, 'refused, not trimmed');
    assert.equal(gcal.setExtraCalendars('x').ok, false);
    const day = keyOffset(3);
    g.personal = [{ id: 'pers1abc', status: 'confirmed', summary: 'Haircut', start: { dateTime: `${day}T09:00:00+00:00` }, end: { dateTime: `${day}T09:30:00+00:00` } }];
    const s = await gcal.syncNow();
    assert.equal(s.ok, true, s.error);
    assert.equal(s.calendars['ward.nickj@gmail.com'].count, 1);
    const rows = gcal.rowsBetween(`${day}T00:00:00`, `${day}T23:59:59`);
    const hc = rows.find((r) => r.subject === 'Haircut');
    assert.ok(hc && hc.editable === false && hc.calendar === 'ward.nickj@gmail.com', 'personal rows are read-only');
    // The wall's redaction never makes it editable.
    const red = require('./vesta').redactDay([{ ...hc }]);
    assert.ok(red.length && !red[0].editable, 'not editable on the wall');

    // The personal calendar failing keeps the family one, and its own last good copy.
    g.personalDown = true;
    const s2 = await gcal.syncNow();
    assert.equal(s2.ok, false);
    assert.equal(s2.calendars['ward.calander@gmail.com'].ok, true, 'family still synced');
    assert.ok(gcal.rowsBetween(`${day}T00:00:00`, `${day}T23:59:59`).some((r) => r.subject === 'Haircut'), 'last good personal copy kept while fresh');
    // Stale beyond six hours → it stops standing in for the phone, family stays.
    const later = Date.now() + 7 * 3600 * 1000;
    assert.deepEqual(gcal.freshCalendars(later), [], 'nothing fresh 7h on');
    gcal.setExtraCalendars([]);
    assert.deepEqual(gcal.readCalendars(), ['ward.calander@gmail.com']);
  } finally {
    gcal._setFetch(null);
  }
});
