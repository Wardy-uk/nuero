'use strict';

/**
 * The family wall (15 Oct 2026): GET /api/v/wall — a week of the diary, the top
 * family tasks, who is in, and the weather station, for an always-on iPad.
 *
 * The rule the tests hold: a work subject or location never reaches the wall
 * (paired with a positive — a personal title DOES), and a block the account
 * has no scope for is ABSENT. Route fixtures are dated off the real clock,
 * because the route reads "today" itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-wall-'));
process.env.NEURO_DB_PATH = path.join(root, 'w.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });
process.env.NEURO_API_TOKEN = process.env.NEURO_API_TOKEN || 'test-token-for-signing';
process.env.HA_TOKEN = '';
process.env.HA_URL = 'http://127.0.0.1:9';

const db = require('../db/database');
const vesta = require('./vesta');
const capture = require('./capture-links');

const pad = (n) => String(n).padStart(2, '0');
const keyOffset = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };

// ── Pure ───────────────────────────────────────────────────────────────────

test('1. dayKeys crosses a month end and the October clock change without moving a day', () => {
  assert.deepEqual(vesta.dayKeys('2026-10-24', 4), ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual(vesta.dayKeys('2026-12-30', 3), ['2026-12-30', '2026-12-31', '2027-01-01']);
});

test('2. daysOf: an all-day end is exclusive, a midnight end stays on its day, a long event is clipped to the window', () => {
  const keys = vesta.dayKeys('2026-10-19', 7); // Mon..Sun
  assert.deepEqual(vesta.daysOf({ start: '2026-10-20T00:00:00', end: '2026-10-22T00:00:00', allDay: true }, keys), ['2026-10-20', '2026-10-21']);
  assert.deepEqual(vesta.daysOf({ start: '2026-10-21T19:00:00', end: '2026-10-22T00:00:00', allDay: false }, keys), ['2026-10-21']);
  assert.deepEqual(vesta.daysOf({ start: '2026-10-21T22:00:00', end: '2026-10-22T01:00:00', allDay: false }, keys), ['2026-10-21', '2026-10-22']);
  // Started last week, ends mid-week.
  assert.deepEqual(vesta.daysOf({ start: '2026-10-16T00:00:00', end: '2026-10-21T00:00:00', allDay: true }, keys), ['2026-10-19', '2026-10-20']);
  // Runs past the window.
  assert.deepEqual(vesta.daysOf({ start: '2026-10-24T00:00:00', end: '2026-10-29T00:00:00', allDay: true }, keys), ['2026-10-24', '2026-10-25']);
  // Ended before the window.
  assert.deepEqual(vesta.daysOf({ start: '2026-10-16T00:00:00', end: '2026-10-19T00:00:00', allDay: true }, keys), []);
});

test('3. redactWeek: work collapses to ONE at-work span per day — no events, no titles, no count; family keeps its titles', () => {
  const rows = [
    { event_id: 'w1', subject: 'Chancellors renewal', location: 'Coalville', start_time: '2026-10-19T10:00:00', end_time: '2026-10-19T11:00:00', source: 'graph', show_as: 'busy' },
    { event_id: 'w2', subject: 'Standup', start_time: '2026-10-19T09:15:00', end_time: '2026-10-19T09:30:00', source: 'graph', show_as: 'busy' },
    { event_id: 'w3', subject: 'Late call', start_time: '2026-10-19T15:00:00', end_time: '2026-10-19T16:30:00', source: 'graph', show_as: 'tentative' },
    { event_id: 'w4', subject: 'Offsite', start_time: '2026-10-21T00:00:00', end_time: '2026-10-22T00:00:00', is_all_day: 1, source: 'graph', show_as: 'busy' },
    { event_id: 'p1', subject: 'Isaac swimming', location: 'Leisure centre', start_time: '2026-10-19T17:00:00', end_time: '2026-10-19T18:00:00', source: 'apple', show_as: 'busy' },
    { event_id: 'p2', subject: 'Half term', start_time: '2026-10-19T00:00:00', end_time: '2026-10-24T00:00:00', is_all_day: 1, source: 'apple' },
    { event_id: 'f1', subject: 'Hold', start_time: '2026-10-20T09:00:00', end_time: '2026-10-20T10:00:00', source: 'graph', show_as: 'free' },
  ];
  const week = vesta.redactWeek(rows, '2026-10-19', 7);
  assert.equal(week.length, 7);
  const mon = week[0];
  assert.deepEqual(mon.events.map((e) => e.title), ['Half term', 'Isaac swimming'], 'family only in events');
  assert.deepEqual(mon.work, { allDay: false, start: '2026-10-19T09:15:00', end: '2026-10-19T16:30:00' }, 'first in, last out');
  assert.equal(week[1].work, null, 'a day with only a free-marked hold is not a work day');
  assert.deepEqual(week[2].work, { allDay: true, start: null, end: null });
  const json = JSON.stringify(week);
  assert.ok(!/Chancellors|Coalville|Standup|Late call|Offsite|Busy/.test(json), 'no work subject, location or event row anywhere');
  assert.ok(/Isaac swimming/.test(json) && /Leisure centre/.test(json), 'positive control: personal detail does arrive');
  assert.ok(!/Hold/.test(json), 'a free-marked event is not on the wall');
  assert.equal(week.filter((d) => d.events.some((e) => e.title === 'Half term')).length, 5, 'Mon–Fri, end exclusive');
});

test('4. topTasks: open only, dated soonest first then newest undated, overdue flagged', () => {
  const t = vesta.topTasks([
    { id: 1, text: 'Bins', status: 'to do', dueDate: null, addedAt: '2026-10-10' },
    { id: 2, text: 'Dentist', status: 'to do', dueDate: '2026-10-20', addedAt: '2026-10-01' },
    { id: 3, text: 'Car tax', status: 'in progress', dueDate: '2026-10-12', addedAt: '2026-10-01' },
    { id: 4, text: 'Done thing', status: 'done', dueDate: '2026-10-11', addedAt: '2026-10-01' },
    { id: 5, text: 'Paint', status: 'to do', dueDate: null, addedAt: '2026-10-14', assigneeLabels: ['Helen'] },
    { id: 6, text: 'Declined', status: 'not doing', dueDate: null, addedAt: '2026-10-14' },
  ], '2026-10-15', 4);
  assert.equal(t.total, 4);
  assert.deepEqual(t.tasks.map((x) => x.text), ['Car tax', 'Dentist', 'Paint', 'Bins']);
  assert.equal(t.tasks[0].overdue, true);
  assert.equal(t.tasks[1].overdue, false);
  assert.deepEqual(t.tasks[2].who, ['Helen']);
});

test('5. whoIsIn: names and a state only; visitors only while home; an untracked pet is dropped; unknown is not out', () => {
  const w = vesta.whoIsIn({
    known: true,
    members: [
      { id: 'nick', name: 'Nick', role: 'self', state: 'away', detail: 'At work', photo: { version: 1 } },
      { id: 'helen', name: 'Helen', role: 'resident', state: 'home' },
      { id: 'isaac', name: 'Isaac', role: 'resident', state: 'unknown' },
      { id: 'lizzy', name: 'Lizzy', role: 'visitor', state: 'away' },
      { id: 'daniel', name: 'Daniel', role: 'visitor', state: 'home' },
      { id: 'ember', name: 'Ember', role: 'companion', state: 'home', detail: 'Garden' },
      { id: 'cat', name: 'Cat', role: 'companion', state: 'untracked' },
    ],
  });
  assert.equal(w.known, true);
  assert.deepEqual(w.people.map((p) => `${p.name}:${p.state}`), ['Nick:out', 'Helen:home', 'Isaac:unknown', 'Daniel:home', 'Ember:home']);
  assert.equal(w.homeCount, 2, 'people only — a dog at home is not someone home');
  assert.ok(!/At work|Garden|photo/.test(JSON.stringify(w)), 'no detail or photo reaches the wall');
  assert.equal(vesta.whoIsIn(null).known, false);
});

test('6. the `house` scope is not a default and nothing else carries it', () => {
  assert.ok(capture.SCOPES.includes('house'));
  assert.ok(!capture.normaliseScopes(undefined).includes('house'));
  for (const s of ['calendar', 'kitchen', 'presence', 'hike', 'shared-tasks']) {
    assert.ok(!capture.normaliseScopes([s]).includes('house'), `${s} must not carry house`);
  }
});

// ── Real HTTP ──────────────────────────────────────────────────────────────

test('7. /api/v/wall over HTTP: scoped blocks absent without the scope; the week redacted end to end', async () => {
  await db.init();
  capture.create({ label: 'Wall', username: 'wall-all', pin: '246813', scopes: ['tasks', 'shared-tasks', 'calendar', 'house'] });
  capture.create({ label: 'Min', username: 'wall-min', pin: '246813', scopes: ['tasks'] });

  const today = keyOffset(0);
  const tomorrow = keyOffset(1);
  const yesterday = keyOffset(-1);
  db.upsertCalendarEvent({ id: 'g1', subject: 'Chancellors renewal', location: 'Coalville', start: `${today}T10:00:00`, end: `${today}T11:00:00`, showAs: 'busy', source: 'graph' });
  db.upsertCalendarEvent({ id: 'a1', subject: 'Isaac swimming', start: `${tomorrow}T17:00:00`, end: `${tomorrow}T18:00:00`, showAs: 'busy', source: 'apple' });
  db.upsertCalendarEvent({ id: 'a2', subject: 'Grandma visiting', start: `${yesterday}T00:00:00`, end: `${keyOffset(2)}T00:00:00`, isAllDay: true, source: 'apple' });

  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('../routes/vesta'));
  const server = app.listen(0); const port = server.address().port;
  const call = async (p, { token, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/v${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json(), text: null };
  };
  try {
    const all = (await call('/login', { body: { username: 'wall-all', pin: '246813' } })).json.token;
    const min = (await call('/login', { body: { username: 'wall-min', pin: '246813' } })).json.token;
    assert.ok(all && min, 'positive control: both signed in');
    await call('/tasks', { token: all, body: { text: 'Book the dentist', dueDate: tomorrow } });

    assert.equal((await call('/wall')).status, 401, 'no session, no wall');
    assert.equal((await call('/wall?from=next-week', { token: all })).status, 400, 'a junk date is refused, not guessed');

    const m = await call('/wall', { token: min });
    assert.equal(m.status, 200);
    assert.ok(Array.isArray(m.json.tasks.tasks));
    for (const k of ['week', 'who', 'station']) assert.ok(!(k in m.json), `${k} absent, not hidden`);

    const a = await call('/wall', { token: all });
    assert.equal(a.status, 200);
    assert.equal(a.json.week.length, 7);
    assert.equal(a.json.week[0].date, today);
    const body = JSON.stringify(a.json);
    assert.ok(!/Chancellors|Coalville/.test(body), 'no work subject or location on the wire');
    assert.deepEqual(a.json.week[0].work, { allDay: false, start: `${today}T10:00:00`, end: `${today}T11:00:00` }, 'the work day is there, as a span only');
    assert.ok(!a.json.week[0].events.some((e) => !e.personal), 'no work event row on the wire');
    assert.ok(a.json.week[1].events.some((e) => e.title === 'Isaac swimming'), 'positive control: personal title arrives');
    assert.ok(a.json.week[0].events.some((e) => e.title === 'Grandma visiting'), 'an all-day event that began yesterday is still on today');
    assert.ok(a.json.tasks.tasks.some((t) => t.text === 'Book the dentist'), 'the household task is on the wall');
    assert.equal(typeof a.json.who.known, 'boolean');
    assert.equal(a.json.station.known, false, 'a station that never reported says so');
  } finally { server.closeAllConnections(); server.close(); }
});

// ── Real render ────────────────────────────────────────────────────────────

test('8. the wall renders for real: week columns, Nick at work without detail, a half-term bar, tasks, who, station, and the gap states', async () => {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', '..', 'vesta', 'src', 'views', 'Wall.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'nosleep.js/*'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  const { WallView, isNight, allDaySpans } = mod.exports;
  assert.equal(typeof WallView, 'function', 'positive control: the export exists');

  const week = vesta.redactWeek([
    { event_id: 'w', subject: 'Chancellors renewal', start_time: '2026-10-19T10:00:00', end_time: '2026-10-19T11:00:00', source: 'graph' },
    { event_id: 'p', subject: 'Isaac swimming', start_time: '2026-10-20T17:00:00', end_time: '2026-10-20T18:00:00', source: 'apple' },
    { event_id: 'h', subject: 'Half term', start_time: '2026-10-19T00:00:00', end_time: '2026-10-24T00:00:00', is_all_day: 1, source: 'apple' },
  ], '2026-10-19', 7);
  const data = {
    scopes: ['tasks', 'calendar', 'house'], today: '2026-10-19', gaps: [], week,
    tasks: { total: 9, tasks: [{ id: 1, text: 'Car tax', dueDate: '2026-10-12', overdue: true, dueToday: false, who: ['Helen'] }] },
    who: { known: true, homeCount: 1, people: [{ name: 'Helen', role: 'person', state: 'home' }, { name: 'Nick', role: 'person', state: 'out' }] },
    station: { known: true, tempC: 11.4, humidityPct: 82, pressureHpa: 1009, tendency: 'falling slowly', verdict: 'Pressure falling slowly — possibly turning less settled.' },
  };
  const now = new Date(2026, 9, 19, 14, 5);
  const html = renderToString(React.createElement(WallView, { data, now }));
  assert.ok(html.includes('14:05') && html.includes('Monday 19 October'));
  assert.equal((html.match(/class="wall__day[ "]/g) || []).length, 7, 'seven day columns');
  assert.ok(html.includes('Nick at work') && html.includes('10:00–11:00') && !html.includes('Chancellors') && !html.includes('Busy'));
  assert.equal((html.match(/class="wall__span"/g) || []).length, 1, 'half term is ONE bar');
  assert.ok(html.includes('grid-column:1 / 6'), 'spanning Mon to Fri');
  assert.ok(html.includes('Isaac swimming') && html.includes('17:00'));
  assert.ok(html.includes('Car tax') && html.includes('Overdue') && html.includes('+8 more'));
  assert.ok(html.includes('Helen') && html.includes('11.4°') && html.includes('↓ falling slowly'));

  // Scopes decide what is drawn at all.
  const bare = renderToString(React.createElement(WallView, { data: { ...data, scopes: ['tasks'] }, now }));
  assert.ok(!bare.includes('Who&#x27;s in') && !bare.includes('wall__week') && !bare.includes('Outside'), 'unscoped blocks absent');
  assert.ok(bare.includes('Car tax'), 'positive control: tasks still drawn');

  // An unreadable diary and an unreadable house say so, never empty/out.
  const gaps = renderToString(React.createElement(WallView, { data: { ...data, week: null, gaps: [{ block: 'week', why: 'x' }], who: { known: false, why: "can't see the house just now", people: [] } }, now }));
  assert.ok(gaps.includes('couldn&rsquo;t read the diary') || gaps.includes('couldn’t read the diary'));
  assert.ok(/isn.{1,8}t the same as everyone being out/.test(gaps));

  // Bars: consecutive days join, a repeat later is its own bar, overlaps take separate lanes.
  const ev = (id) => ({ id, title: id, allDay: true });
  const spans = allDaySpans([{ events: [ev('a'), ev('b')] }, { events: [ev('a')] }, { events: [] }, { events: [ev('a')] }]);
  assert.deepEqual(spans.map((s) => [s.title, s.from, s.to, s.lane]), [['a', 0, 1, 0], ['b', 0, 0, 1], ['a', 3, 3, 0]]);

  assert.equal(isNight(new Date(2026, 9, 19, 23, 0)), true);
  assert.equal(isNight(new Date(2026, 9, 19, 6, 29)), true);
  assert.equal(isNight(new Date(2026, 9, 19, 6, 30)), false);
});
