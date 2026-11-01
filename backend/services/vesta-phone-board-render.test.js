'use strict';
/**
 * The family wall's features on the VESTA phone app (1 Nov 2026), rendered for
 * real (esbuild + React server render): each block is drawn only with its scope,
 * a block that could not be read says so, and the phone opens THE WALL'S OWN
 * sheet (one editor for both) — proven by rendering the exported `Sheet` with
 * the phone's `onOpenWeek={null}`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'vesta', 'src');

async function load(rel) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(SRC, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react-dom', 'nosleep.js/*'], loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const React = require('react');
const { renderToString } = require('react-dom/server');
const h = React.createElement;
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<!-- -->/g, '');

const TODAY = '2026-11-01';
function week() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(2026, 10, 1 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: key, events: [], work: null, off: false });
  }
  days[1].events.push({ id: 'g1', title: 'Isaac swimming', start: '2026-11-02T17:00:00', end: '2026-11-02T18:00:00', allDay: false });
  return days;
}
function board(over = {}) {
  return {
    scopes: ['tasks', 'calendar', 'house', 'kitchen', 'home-control'],
    today: TODAY, gaps: [], week: week(), people: [], doneTasks: [{ id: 9, text: 'Bins' }],
    familyCalendar: { canEdit: true, why: null },
    tasks: { total: 1, tasks: [{ id: 1, text: 'Clean the gutters', dueDate: null, who: [] }] },
    who: { known: true, people: [{ name: 'Helen', role: 'person', state: 'home' }] },
    station: { known: true, tempC: 9.4, humidityPct: 80, conditionLabel: 'Cloudy' },
    outlook: { known: true, today: { highC: 12, lowC: 5 }, rain: { state: 'arriving', say: 'Rain likely from about 15:20' } },
    tea: { today: 'Lasagne', days: [{ date: TODAY, text: 'Lasagne' }], recent: ['Lasagne'] },
    notes: [{ id: 'n1', text: 'Parcel is in the shed', by: 'Helen', at: '2026-11-01T09:30:00' }],
    countdowns: [{ key: 'b', title: 'Isaac’s birthday', date: '2026-11-03', days: 2, say: 'in 2 days' }],
    care: [{ id: 'c1', title: 'Worming', say: 'Worming 1 day overdue', overdue: true }],
    shopping: { exists: true, toBuy: [{ name: 'Milk' }, { name: 'Eggs' }], bought: [] },
    ...over,
  };
}

test('every block draws from the wall payload, behind its scope', async () => {
  const { default: HouseBoard } = await load('components/HouseBoard.jsx');
  const html = text(renderToString(h(HouseBoard, { board: board(), open() {} })));
  const B = await load('components/HouseBoard.jsx');
  const hero = text(renderToString(h(B.HouseHero, { board: board({ weekAhead: { known: false, why: 'x' } }), label: 'Helen', now: new Date(2026, 10, 1, 9, 50), open() {} })));
  for (const s of ['Sunday 1 November', 'Everyone’s home', '9.4°', 'Rain likely from about 15:20', 'Week ahead', 'Helen']) assert.ok(hero.includes(s), `hero missing: ${s}`);
  const more = text(renderToString(h(B.JobsMore, { board: board(), open() {} })))
    + text(renderToString(h(B.Week, { board: board(), open() {} })));
  for (const s of ['All jobs (1) · 1 done recently', 'Worming 1 day overdue', 'Isaac swimming', '+ Event']) assert.ok(more.includes(s), `missing: ${s}`);
  for (const s of ['Tea tonight', 'Lasagne', '2 to buy', 'Parcel is in the shed', 'Lights & heating', 'Isaac’s birthday', 'in 2 days']) {
    assert.ok(html.includes(s), `missing: ${s}`);
  }
});

test('no scope = not drawn; null = says it could not read', async () => {
  const { default: HouseBoard } = await load('components/HouseBoard.jsx');
  const B = await load('components/HouseBoard.jsx');
  const b = board({ scopes: ['tasks'], tea: null, shopping: undefined, week: undefined, station: undefined, outlook: undefined, who: undefined, care: undefined });
  const html = text(renderToString(h(HouseBoard, { board: b, open() {} })))
    + text(renderToString(h(B.HouseHero, { board: b, label: 'Helen', now: new Date(2026, 10, 1, 9, 50), open() {} })))
    + text(renderToString(h(B.Week, { board: b, open() {} })));
  assert.ok(html.includes('Can’t read'), 'tea null is a gap');
  for (const s of ['Shopping', 'Lights & heating', 'Week ahead', 'Everyone', 'This week', 'Worming']) assert.ok(!html.includes(s), `drawn without scope: ${s}`);
  // Positive controls on the same render: notes (scope tasks) and the greeting.
  assert.ok(html.includes('Parcel is in the shed'));
  assert.ok(html.includes('Good morning, Helen'));
});

test('a failed board read is a named gap; not yet read draws nothing', async () => {
  const { default: HouseBoard } = await load('components/HouseBoard.jsx');
  const failed = text(renderToString(h(HouseBoard, { board: null, boardErr: 'Network down', open() {} })));
  assert.ok(failed.includes('Network down'), 'names why');
  assert.ok(failed.includes('I couldn’t read this.'), 'a gap, never an empty board');
  assert.equal(renderToString(h(HouseBoard, { board: undefined, open() {} })), '');
});

test('the phone opens the wall’s own sheets, without the wall-only "Open the week"', async () => {
  const C = await load('views/WallCinema.jsx');
  const ACT = { shopping: { add: async () => ({ ok: true }), bought: async () => ({ ok: true }) } };
  const b = board();
  const shop = text(renderToString(h(C.Sheet, { sheet: { kind: 'shop' }, data: b, act: ACT, setSheet() {}, dirty: false, setDirty() {}, onClose() {}, onOpenWeek: null })));
  assert.ok(shop.includes('Shopping') && shop.includes('Milk'));
  const day = text(renderToString(h(C.Sheet, { sheet: { kind: 'day', day: b.week[1] }, data: b, act: ACT, setSheet() {}, dirty: false, setDirty() {}, onClose() {}, onOpenWeek: null })));
  assert.ok(day.includes('Isaac swimming'));
  assert.ok(!day.includes('Open the week'), 'phone has no week overlay to open');
  const wallDay = text(renderToString(h(C.Sheet, { sheet: { kind: 'day', day: b.week[1] }, data: b, act: ACT, setSheet() {}, dirty: false, setDirty() {}, onClose() {}, onOpenWeek() {} })));
  assert.ok(wallDay.includes('Open the week'), 'the wall still has it');
});

test('the week ahead: from the cached daily forecast, today first, never an empty week', () => {
  const board = require('./household-board');
  const cache = { known: true, fetchedAt: '2026-11-01T09:00:00Z', days: [
    { date: '2026-10-31', condition: 'rainy', tempHighC: 10, tempLowC: 3 },
    { date: '2026-11-01', condition: 'partlycloudy', tempHighC: 11.7, tempLowC: 6.8, precipitationMm: 0.01, windKmh: 11.6 },
    { date: '2026-11-02', condition: 'rainy', tempHighC: 11.4, tempLowC: 6.4, precipitationMm: 3.2 } ] };
  const v = board.weekAheadView(cache, '2026-11-01');
  assert.equal(v.known, true);
  assert.deepEqual(v.days.map((d) => d.date), ['2026-11-01', '2026-11-02'], 'yesterday dropped');
  assert.equal(v.days[0].highC, 12);
  assert.equal(v.days[0].label, 'Partly cloudy');
  assert.equal(board.weekAheadView({ known: false, why: 'stale' }, '2026-11-01').known, false);
  assert.equal(board.weekAheadView({ known: true, days: [] }, '2026-11-01').known, false, 'no days is not a dry week');
});

test('the week-ahead sheet renders each day; unreadable says so', async () => {
  const C = await load('views/WallCinema.jsx');
  const week = { known: true, days: [
    { date: '2026-11-01', condition: 'sunny', label: 'Sunny', highC: 12, lowC: 5, rainMm: 0, rainChance: null, windKmh: 10 },
    { date: '2026-11-02', condition: 'rainy', label: 'Rain', highC: 11, lowC: 6, rainMm: 3.2, rainChance: null, windKmh: 14 } ] };
  const html = text(renderToString(h(C.WeekAheadSheet, { week, today: '2026-11-01' })));
  for (const s of ['Today', 'Tomorrow', 'Sunny', 'Rain', '12°', '3.2 mm', 'Dry']) assert.ok(html.includes(s), `missing ${s}`);
  const gap = text(renderToString(h(C.WeekAheadSheet, { week: { known: false, why: 'the daily forecast is more than 12 hours old' }, today: '2026-11-01' })));
  assert.ok(gap.includes('more than 12 hours old'));
  assert.equal(renderToString(h(C.WeekAheadSheet, { week: undefined, today: '2026-11-01' })), '');
});
