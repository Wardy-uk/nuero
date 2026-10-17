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
  assert.equal(week[2].work, null, 'an all-day Outlook entry alone does not make him at work (17 Oct 2026)');
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
  assert.ok(!/At work|Garden/.test(JSON.stringify(w)), 'no detail reaches the wall');
  assert.equal(w.people.find((p) => p.name === 'Nick').photo, 1, 'a photo is a VERSION number, never the picture');
  assert.equal(w.people.find((p) => p.name === 'Helen').photo, null);
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
  // With other people in it, so it counts as being at work on ANY day (the test runs at weekends too).
  db.upsertCalendarEvent({ id: 'g1', subject: 'Chancellors renewal', location: 'Coalville', start: `${today}T10:00:00`, end: `${today}T11:00:00`, showAs: 'busy', source: 'graph', attendeesOther: true });
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
    // The month view asks for six weeks; any other span is refused, never clamped.
    const month = (await call('/wall?from=2026-09-28&days=42', { token: all })).json;
    assert.equal(month.week.length, 42);
    assert.equal(month.from, '2026-09-28');
    assert.equal(month.days, 42);
    assert.equal((await call('/wall?days=30', { token: all })).status, 400);
    assert.equal((await call('/wall?days=8', { token: all })).json.week.length, 8, 'the eight-day strip');
    // Each task carries a short label for the wall beside its own wording.
    const wt = (await call('/wall', { token: all })).json.tasks.tasks;
    assert.ok(wt.length > 0 && wt.every((t) => typeof t.short === 'string' && t.short.length > 0 && typeof t.text === 'string'), 'short label + the original text');
    // The keep-awake report is recorded, filtered to a safe character set.
    await call(`/wall?held=${encodeURIComponent('video + wake lock;home-screen;wakelock-api=yes;os=18.6<script>')}`, { token: all });
    const seen = JSON.parse(db.getState('vesta_wall_seen') || '{}');
    assert.equal(seen['wall-all'].held, 'video + wake lock;home-screen;wakelock-api=yes;os=18.6script');

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
  const { WallView, isNight, allDaySpans, bundleIn, calRange } = mod.exports;

  // Ranges: a week moves seven days a step; a month is six weeks from the Monday on or before the 1st.
  assert.deepEqual([calRange('week', 0, '2026-10-17').from, calRange('week', 1, '2026-10-17').from, calRange('week', -1, '2026-10-17').from],
    ['2026-10-17', '2026-10-24', '2026-10-10']);
  const oct = calRange('month', 0, '2026-10-17');
  assert.deepEqual([oct.from, oct.days, oct.month, oct.label], ['2026-09-28', 42, 9, 'October 2026']);
  assert.equal(calRange('month', 3, '2026-10-17').label, 'January 2027', 'months cross the year');
  assert.equal(calRange('month', 0, '2026-02-10').from, '2026-01-26');
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

  // The update check compares bundle names; a dev page (no hashed bundle) claims nothing.
  assert.equal(bundleIn('<script type="module" crossorigin src="/assets/index-_kKaW-4d.js"></script>'), '/assets/index-_kKaW-4d.js');
  assert.equal(bundleIn('<script type="module" src="/src/main.jsx"></script>'), null);

  // The month view renders a six-week grid with its controls, and a busy day says "+N more".
  const busy = ['a', 'b', 'c', 'd'].map((x, i) => ({ event_id: x, subject: `Thing ${x}`, start_time: `2026-10-21T1${i}:00:00`, end_time: `2026-10-21T1${i}:30:00`, source: 'apple' }));
  const monthDays = vesta.redactWeek([...busy, { event_id: 'h', subject: 'Half term', start_time: '2026-10-26T00:00:00', end_time: '2026-10-31T00:00:00', is_all_day: 1, source: 'apple' }], '2026-09-28', 42);
  const range = calRange('month', 0, '2026-10-19');
  const mhtml = renderToString(React.createElement(WallView, {
    data: { ...data, week: monthDays, from: range.from, days: 42 }, now,
    cal: { view: 'month', offset: 0, range, onStep() {}, onToday() {}, onView() {} },
  }));
  assert.equal((mhtml.match(/class="wall__mday[ "]/g) || []).length, 42);
  assert.ok(mhtml.includes('October 2026') && mhtml.includes('Half term') && mhtml.includes('+2 more'));
  assert.ok(mhtml.includes('aria-pressed="true"') && mhtml.includes('>Month<'));
  // An answer for a different range is never drawn under this one's label.
  const stale = renderToString(React.createElement(WallView, {
    data: { ...data, from: '2026-10-19', days: 7 }, now,
    cal: { view: 'month', offset: 0, range, onStep() {}, onToday() {}, onView() {} },
  }));
  assert.ok(stale.includes('Getting the diary') && !stale.includes('wall__mday'));

  // Today-first: today and tomorrow as panels, the week as a strip; past items dim, the next is marked.
  const { splitDay } = mod.exports;
  const d0 = { date: '2026-10-19', events: [
    { id: 'a', title: 'School run', start: '2026-10-19T08:30:00', end: '2026-10-19T09:00:00', allDay: false },
    { id: 'b', title: 'Isaac swimming', start: '2026-10-19T17:00:00', end: '2026-10-19T18:00:00', allDay: false },
  ] };
  const split = splitDay(d0, '14:05');
  assert.deepEqual(split.rows.map((x) => x.past), [true, false]);
  assert.equal(split.nextId, 'b');
  assert.equal(splitDay(d0, null).nextId, null, 'tomorrow has no "next"');
  const todayRange = calRange('today', 0, '2026-10-19');
  assert.deepEqual([todayRange.from, todayRange.days], ['2026-10-19', 42]);
  const thtml = renderToString(React.createElement(WallView, {
    data: { ...data, from: '2026-10-19', days: 42, week: [d0, ...week.slice(1)] }, now,
    cal: { view: 'today', offset: 0, range: todayRange, onStep() {}, onToday() {}, onView() {} },
  }));
  assert.ok(thtml.includes('>Today<') && thtml.includes('Tomorrow') && thtml.includes('Isaac swimming'));
  assert.ok(thtml.includes('wall__dpitem--past') && thtml.includes('>Next<'));
  assert.equal((thtml.match(/class="wall__sday[ "]/g) || []).length, 7, 'the week strip');
  assert.ok(!thtml.includes('Previous week'), 'no arrows on Today');

  // The cinema look (17 Oct 2026): same payload, new presentation, nothing invented.
  const { CinemaView, presenceLine, nextLine, sunTimes, skyPhase } = mod.exports;
  const cdata = {
    ...data, from: '2026-10-19', days: 42, week: [d0, ...week.slice(1)],
    energy: { connected: true, monthCostP: 7500, fuels: {
      electricity: { yesterday: { kwh: 9.4, costP: 260, complete: true }, month: { kwh: 150, costP: 4160 }, freshness: { state: 'usual' }, days: [] },
      gas: { yesterday: { kwh: 31.2, costP: null, complete: false }, month: { kwh: 499, costP: null }, freshness: { state: 'late' }, days: [] } } },
    scopes: ['tasks', 'calendar', 'house', 'energy'],
  };
  const chtml = renderToString(React.createElement(CinemaView, {
    data: cdata, now, cal: { view: 'today', offset: 0, range: todayRange, onStep() {}, onToday() {}, onView() {} },
  }));
  assert.ok(chtml.includes('14:05') && chtml.includes('Monday 19 October'));
  assert.ok(chtml.includes('Household jobs') && chtml.includes('Car tax') && chtml.includes('Overdue'));
  assert.ok(chtml.includes('9.4 kWh') && chtml.includes('This month 150 kWh') && chtml.includes('yesterday so far') && chtml.includes('running late') && chtml.includes('Energy yesterday'));
  assert.ok(chtml.includes('Coming up') && (chtml.match(/class="cine__sday[ "]/g) || []).length === 7, 'draws the days it was given');
  const six = renderToString(React.createElement(CinemaView, { data: { ...cdata, days: 42, week: vesta.redactWeek([], '2026-10-19', 42) }, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.equal((six.match(/class="cine__sday[ "]/g) || []).length, 42, 'six weeks in the strip, eight on screen, the rest a swipe away');
  assert.ok(chtml.includes('Isaac swimming') && chtml.includes('Next: Isaac swimming at 17:00'));
  assert.ok(chtml.includes('11.4°') && chtml.includes('82% humidity'));
  assert.ok(chtml.includes('Dew point 8.4°'), 'dew point from the station’s own temperature and humidity');
  for (const invented of ['Feels like', 'breeze', 'vs yesterday']) assert.ok(!chtml.includes(invented), `nothing NEURO does not hold: ${invented}`);
  const cbare = renderToString(React.createElement(CinemaView, { data: { ...cdata, scopes: ['tasks'] }, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.ok(!cbare.includes('cine__people') && !cbare.includes('Energy') && !cbare.includes('Coming up'), 'scopes still decide what is drawn');

  assert.equal(presenceLine({ known: true, people: [{ name: 'Helen', role: 'person', state: 'home' }, { name: 'Nick', role: 'person', state: 'home' }, { name: 'Ember', role: 'companion', state: 'out' }] }), 'Everyone’s home');
  assert.equal(presenceLine({ known: true, people: [{ name: 'Helen', role: 'person', state: 'home' }, { name: 'Isaac', role: 'person', state: 'home' }, { name: 'Nick', role: 'person', state: 'out' }] }), 'Helen and Isaac are home');
  assert.equal(presenceLine({ known: true, people: [{ name: 'Nick', role: 'person', state: 'out' }] }), 'Nobody’s home');
  assert.equal(presenceLine({ known: false }), "Can't see who's home", 'unknown is never "nobody"');
  assert.equal(nextLine({ date: '2026-10-19', events: [] }, now), 'A quiet afternoon');
  const octSun = sunTimes(new Date(2026, 9, 17)); const junSun = sunTimes(new Date(2026, 5, 21));
  assert.ok(Math.abs((octSun.set - octSun.rise) / 60 - 10.5) < 0.5, 'about 10½ hours of daylight in mid-October');
  assert.ok(junSun.set - junSun.rise > octSun.set - octSun.rise + 300, 'midsummer days are much longer');
  assert.equal(skyPhase(new Date(2026, 9, 17, 2, 0)), 'night');

  // Iteration 2: photographs by time of day, two jobs and a count, two-line strip labels.
  const { photoSlot, stripItems } = mod.exports;
  assert.deepEqual([photoSlot(new Date(2026, 9, 17, 2, 0)), photoSlot(new Date(2026, 9, 17, 8, 30)), photoSlot(new Date(2026, 9, 17, 13, 0)), photoSlot(new Date(2026, 9, 17, 17, 30))],
    ['night', 'morning', 'day', 'evening']);
  // The credit names the photo ON SCREEN, so nothing is credited before a photo has loaded (17 Oct 2026 fix).
  assert.ok(!chtml.includes('cine__credit'), 'no credit until a photograph is actually showing');
  const mot = 'Book car in for MOT (due 12/03/2025)';
  const four = { ...cdata, tasks: { total: 4, tasks: [
    { id: 1, text: mot, dueDate: '2026-10-10', overdue: true, dueToday: false, who: ['Nick'] },
    { id: 2, text: 'Order school shoes', dueDate: null, overdue: false, dueToday: false, who: [] },
    { id: 3, text: 'Fix the extractor fan', dueDate: null, overdue: false, dueToday: false, who: [] },
    { id: 4, text: 'Take bins out', dueDate: null, overdue: false, dueToday: false, who: [] },
  ] } };
  const jhtml = renderToString(React.createElement(CinemaView, { data: four, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  // Two jobs on the tile; the "+N more" count sits in the tile header (iteration 4).
  assert.equal((jhtml.match(/class="cine__job cine__jobbtn/g) || []).length, 2, 'two jobs on the tile');
  assert.ok(jhtml.includes('cine__headmore">+2 more'));
  // A long short-title wraps (two lines) rather than being cut, and the due state sits beneath it.
  const longJob = { ...four, tasks: { total: 1, tasks: [{ id: 9, text: 'x', short: 'Arrange the boiler service with British Gas', dueDate: '2026-10-10', overdue: true, dueToday: false, who: [] }] } };
  const lhtml = renderToString(React.createElement(CinemaView, { data: longJob, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.ok(lhtml.includes('Arrange the boiler service with British Gas') && lhtml.indexOf('Arrange the boiler') < lhtml.indexOf('Overdue'), 'full short title, Overdue after it');
  assert.ok(jhtml.includes(mot), 'the task wording is shown as it is — its old date is neither removed nor read as the due date');
  assert.deepEqual(stripItems([{ title: 'Bins', allDay: true }, { title: 'Swim', start: '2026-10-19T17:00:00' }]).shown, ['Bins', '17:00 Swim']);
  assert.deepEqual(stripItems([{ title: 'A', allDay: true }, { title: 'B', allDay: true }, { title: 'C', allDay: true }]).shown, ['A', 'B', 'C'], 'every label, the day scrolls');
  assert.ok((jhtml.match(/cine__sitems cine__scroll/g) || []).length === 7, 'each strip day scrolls');

  // Iteration 3 — short labels on the tile, the full wording only on tap.
  const { weatherIcon } = mod.exports;
  const withShort = { ...four, tasks: { total: 4, tasks: four.tasks.tasks.map((t, i) => (i === 0 ? { ...t, short: 'Book Captur MOT' } : t)) } };
  const shtml = renderToString(React.createElement(CinemaView, { data: withShort, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.ok(shtml.includes('Book Captur MOT') && !shtml.includes(mot), 'the tile shows the short label, not the long wording');
  assert.ok(shtml.includes('Overdue'), 'overdue survives the short label');
  for (const [n, expectMore] of [[0, null], [1, null], [2, null], [5, '+3 more']]) {
    const list = Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `Job number ${i + 1}`, dueDate: null, overdue: false, dueToday: false, who: [] }));
    const h = renderToString(React.createElement(CinemaView, { data: { ...cdata, tasks: { total: n, tasks: list } }, now, cal: { view: 'today', offset: 0, range: todayRange } }));
    assert.equal((h.match(/class="cine__job cine__jobbtn/g) || []).length, Math.min(n, 2), `${n} jobs`);
    if (expectMore) assert.ok(h.includes(expectMore)); else assert.ok(!/\+\d+ more/.test(h), `${n} jobs: no count`);
    if (n === 0) assert.ok(h.includes('Nothing to do'));
  }
  // Energy: one quiet line until a meter reports; never a row of dashes.
  const noMeters = { ...cdata, energy: { connected: true, monthCostP: null, fuels: {
    electricity: { yesterday: { kwh: null, costP: null, complete: false }, month: { kwh: null, costP: null }, freshness: { state: 'none' }, days: [] },
    gas: { yesterday: { kwh: null, costP: null, complete: false }, month: { kwh: null, costP: null }, freshness: { state: 'none' }, days: [] } } } };
  const ehtml = renderToString(React.createElement(CinemaView, { data: noMeters, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.equal((ehtml.match(/Awaiting meter data/g) || []).length, 1);
  assert.ok(!ehtml.includes('—kWh') && !ehtml.includes('>— kWh') && !ehtml.includes('cine__fuel"'));
  // Weather: the real condition id picks one icon; an unknown one draws nothing.
  assert.equal(weatherIcon('partlycloudy'), 'partly');
  assert.equal(weatherIcon('clear-night'), 'moon');
  assert.equal(weatherIcon('rainy'), 'rain');
  assert.equal(weatherIcon('something-new'), null);
  assert.equal(weatherIcon(null), null);
  const whtml = renderToString(React.createElement(CinemaView, { data: { ...cdata, station: { ...cdata.station, condition: 'cloudy', conditionLabel: 'Cloudy' } }, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.ok(whtml.includes('aria-label="Cloudy"') && whtml.includes('82% humidity'));
  const nohtml = renderToString(React.createElement(CinemaView, { data: cdata, now, cal: { view: 'today', offset: 0, range: todayRange } }));
  assert.ok(!nohtml.includes('cine__wicon'), 'no condition read yet: no icon, nothing guessed');
  // The calendar across month and year ends: today first, every day kept, empty or not.
  const nye = calRange('today', 0, '2026-12-29');
  assert.equal(nye.from, '2026-12-29');
  const yearEnd = vesta.redactWeek([], nye.from, 42);
  assert.deepEqual(yearEnd.slice(0, 8).map((d) => d.date), ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05']);
  const yhtml = renderToString(React.createElement(CinemaView, { data: { ...cdata, today: '2026-12-29', from: nye.from, days: 42, week: yearEnd }, now: new Date(2026, 11, 29, 9, 0), cal: { view: 'today', offset: 0, range: nye } }));
  assert.equal((yhtml.match(/class="cine__sday[ "]/g) || []).length, 42, 'empty days are kept');
  assert.ok(yhtml.indexOf('Tue 29') < yhtml.indexOf('Fri 1'), 'today first, then into January');
  assert.deepEqual(vesta.redactWeek([], '2026-10-30', 4).map((d) => d.date), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'], 'month end');
  // A long event title is not cut in the day sheet's data or the strip's label.
  assert.equal(stripItems([{ title: 'Wedding anniversary celebration dinner at the Wheatsheaf', allDay: true }]).shown[0], 'Wedding anniversary celebration dinner at the Wheatsheaf');
});

// ── 17 Oct 2026: at work only on evidence; off from People HR; dates are dates ──

test('9. at work: weekend solo holds do not count, a weekend meeting with people does, People HR off wins, an all-day entry alone never counts', () => {
  const rows = [
    // Sat 17 / Sun 18: the 12:00 lunch hold that runs every day.
    { event_id: 'lunch-sat', subject: 'Lunch', start_time: '2026-10-17T12:00:00', end_time: '2026-10-17T13:00:00', source: 'graph', attendees_other: 0 },
    { event_id: 'meet-sun', subject: 'Release', start_time: '2026-10-18T10:00:00', end_time: '2026-10-18T11:00:00', source: 'graph', attendees_other: 1 },
    // Mon 19: booked off in People HR, with an all-day Outlook marker and meetings.
    { event_id: 'leave-mon', subject: 'Annual leave', start_time: '2026-10-19T00:00:00', end_time: '2026-10-20T00:00:00', is_all_day: 1, source: 'graph' },
    { event_id: 'meet-mon', subject: 'Standup', start_time: '2026-10-19T10:00:00', end_time: '2026-10-19T11:00:00', source: 'graph', attendees_other: 1 },
    // Tue 20: only an all-day Outlook entry.
    { event_id: 'wfh-tue', subject: 'WFH', start_time: '2026-10-20T00:00:00', end_time: '2026-10-21T00:00:00', is_all_day: 1, source: 'graph' },
    // Wed 21: an ordinary working day.
    { event_id: 'meet-wed', subject: 'Review', start_time: '2026-10-21T09:00:00', end_time: '2026-10-21T16:00:00', source: 'graph' },
    // The phone held the anniversary at 13:00.
    { event_id: 'anniv', subject: 'Wedding anniversary', start_time: '2026-10-19T13:00:00', end_time: '2026-10-19T14:00:00', source: 'apple' },
  ];
  const weekend = new Set(['2026-10-17', '2026-10-18']);
  const week = vesta.redactWeek(rows, '2026-10-17', 7, {
    isWorkingDay: (d) => !weekend.has(d),
    offOn: (d) => (d === '2026-10-19' ? { off: true, known: true } : { off: false, known: true }),
  });
  const by = Object.fromEntries(week.map((d) => [d.date, d]));
  assert.equal(by['2026-10-17'].work, null, 'a solo Saturday hold is not being at work');
  assert.deepEqual(by['2026-10-18'].work, { allDay: false, start: '2026-10-18T10:00:00', end: '2026-10-18T11:00:00' }, 'a Sunday meeting with people is');
  assert.equal(by['2026-10-19'].work, null, 'booked off beats every diary entry');
  assert.equal(by['2026-10-19'].off, true);
  assert.equal(by['2026-10-20'].work, null, 'an all-day Outlook entry alone is not at work');
  assert.equal(by['2026-10-20'].off, false, 'not off either — nobody said so');
  assert.deepEqual(by['2026-10-21'].work, { allDay: false, start: '2026-10-21T09:00:00', end: '2026-10-21T16:00:00' }, 'positive control: a working day still shows');
  const anniv = by['2026-10-19'].events.find((e) => e.title === 'Wedding anniversary');
  assert.equal(anniv.allDay, true, 'an anniversary is a date, not a 1pm appointment');
  assert.equal(by['2026-10-20'].events.some((e) => e.title === 'Wedding anniversary'), false, 'on its own day only');
  // "Could not ask People HR" is not a day off.
  const unknown = vesta.redactWeek(rows, '2026-10-19', 1, { isWorkingDay: () => true, offOn: () => ({ off: false, known: false }) });
  assert.equal(unknown[0].off, false);
  assert.ok(unknown[0].work, 'unknown leave falls back to the diary');
});

test('10. /api/v/photo: behind the house scope, and only for someone the wall shows', async () => {
  capture.create({ label: 'Photo No', username: 'ph-no', pin: '371593', scopes: ['tasks', 'calendar'] });
  capture.create({ label: 'Photo Yes', username: 'ph-yes', pin: '371593', scopes: ['tasks', 'house'] });
  const express = require('express');
  const app = express(); app.use(express.json()); app.use('/api/v', require('../routes/vesta'));
  const server = app.listen(0); const port = server.address().port;
  const login = async (u) => (await (await fetch(`http://127.0.0.1:${port}/api/v/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, pin: '371593' }) })).json()).token;
  try {
    const no = await login('ph-no'); const yes = await login('ph-yes');
    assert.ok(no && yes, 'positive control: signed in');
    const get = (t, id) => fetch(`http://127.0.0.1:${port}/api/v/photo/${id}`, { headers: { Authorization: `Bearer ${t}` } });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v/photo/nick`)).status, 401);
    assert.equal((await get(no, 'nick')).status, 403, 'no house scope, no photo');
    assert.equal((await get(yes, 'nobody')).status, 404, 'someone not on the wall');
    assert.equal((await get(yes, '..%2F..%2Fetc')).status, 404, 'a path is not an id');
  } finally { server.closeAllConnections(); server.close(); }
});
