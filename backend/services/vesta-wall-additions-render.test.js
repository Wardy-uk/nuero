'use strict';
/**
 * The family wall additions (25 Oct 2026), rendered for real (esbuild + React
 * server render) from the contract's shapes: the dock (gated by scope, with its
 * badges), the house controls in every state, shopping, notes, tea, the walk
 * (overdue), the event sheet's countdown toggle, the outlook in the Outside tile
 * and on the Tomorrow card, Ember's care in the jobs tile — and that a block the
 * account has no scope for (absent) draws nothing, while one that could not be
 * read (null) says so.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const VIEWS = path.join(__dirname, '..', '..', 'vesta', 'src', 'views');

async function load(file) {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    entryPoints: [path.join(VIEWS, file)],
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
const count = (html, re) => (html.match(re) || []).length;
// React escapes apostrophes; compare on the decoded text.
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const TODAY = '2026-10-25';
const NOW = new Date(2026, 9, 25, 14, 5);
const RANGE = { from: TODAY, days: 42 };
const CAL = { view: 'today', offset: 0, range: RANGE, onStep() {}, onToday() {}, onView() {} };
const ACT = {
  task: async () => ({ ok: true }), addTask: async () => ({ ok: true }),
  event: { add: async () => ({ ok: true }), update: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  tea: async () => ({ ok: true }), note: { add: async () => ({ ok: true }), clear: async () => ({ ok: true }) },
  countdown: async () => ({ ok: true }), shopping: { add: async () => ({ ok: true }), bought: async () => ({ ok: true }) },
  home: { get: async () => ({ ok: true, known: true, rooms: [], lightsOn: 0 }), control: async () => ({ ok: true }) },
};

function week() {
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(2026, 9, 25 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date: key, events: [], work: null, off: false });
  }
  days[1].events.push({ id: 'g1', title: 'Isaac swimming', start: '2026-10-26T17:00:00', end: '2026-10-26T18:00:00', allDay: false, countdownKey: 'g1@2026-10-26', countdown: false });
  return days;
}

function full(overrides = {}) {
  return {
    scopes: ['tasks', 'calendar', 'house', 'kitchen', 'hike', 'home-control'],
    today: TODAY, from: TODAY, days: 42, gaps: [], week: week(),
    tasks: { total: 1, tasks: [{ id: 1, text: 'Clean the gutters', dueDate: null, overdue: false, dueToday: false, who: [] }] },
    who: { known: true, people: [{ name: 'Helen', role: 'person', state: 'home' }] },
    station: { known: true, tempC: 11.4, humidityPct: 82, pressureHpa: 1009, tendency: 'falling slowly' },
    outlook: { known: true, today: { highC: 14, lowC: 7, rainChance: 60 }, tomorrow: { highC: 13, lowC: 6, rainChance: 40 }, rain: { state: 'arriving', say: 'Rain likely from about 15:20' } },
    tea: { today: 'Lasagne', days: [{ date: TODAY, text: 'Lasagne' }, { date: '2026-10-27', text: 'Fish pie' }], recent: ['Lasagne', 'Fish pie', 'Chilli'] },
    notes: [{ id: 'n1', text: 'Parcel is in the shed', by: 'Helen', at: '2026-10-25T09:30:00' }, { id: 'n2', text: 'Ring Grandma', by: 'Family', at: '2026-10-24T18:20:00' }],
    countdowns: [{ key: 'h@2026-10-30', title: 'Half term', date: '2026-10-30', days: 5, say: 'in 5 days' }, { key: 'b@2026-11-02', title: 'Isaac’s birthday', date: '2026-11-02', days: 8, say: 'in 8 days' }],
    walk: { active: false },
    care: [{ id: 'c1', title: 'Worming', companion: 'Ember', dueDate: '2026-10-22', say: 'Worming 3 days overdue', overdue: true },
           { id: 'c2', title: 'Flea treatment', companion: 'Ember', dueDate: '2026-10-28', say: 'Flea treatment due Wed', overdue: false }],
    shopping: { exists: true, toBuy: [{ name: 'Milk', added: TODAY }, { name: 'Bread', added: TODAY }, { name: 'Eggs', added: TODAY }], bought: [{ name: 'Butter' }] },
    ...overrides,
  };
}

const cinema = (C, data, extra = {}) => text(renderToString(h(C.CinemaView, { data, now: NOW, cal: CAL, act: ACT, ...extra })));

test('the dock: buttons gated by scope, badges from the payload, gaps marked', async () => {
  const C = await load('WallCinema.jsx');
  assert.equal(typeof C.CinemaView, 'function', 'positive control: the export exists');
  const html = cinema(C, full());
  assert.ok(html.includes('cine__dock'), 'the dock is drawn');
  assert.ok(html.includes('aria-label="Home"'), 'Home with home-control');
  assert.ok(html.includes('aria-label="Shopping (3)"') && html.includes('>3</span>'), 'Shopping badge = to-buy count');
  assert.ok(html.includes('aria-label="Notes (2)"'), 'Notes badge = note count');

  const noHome = cinema(C, full({ scopes: ['tasks', 'calendar', 'house', 'kitchen'] }));
  assert.ok(!noHome.includes('aria-label="Home"'), 'no home-control scope: no Home button');
  assert.ok(noHome.includes('aria-label="Shopping (3)"'), 'positive control: Shopping still there');

  const noKitchen = full({ scopes: ['tasks'] }); delete noKitchen.shopping;
  const nk = cinema(C, noKitchen);
  assert.ok(!nk.includes('Shopping'), 'no kitchen scope: no Shopping');

  const gapShop = cinema(C, full({ shopping: null }));
  assert.ok(gapShop.includes('aria-label="Shopping (!)"'), 'an unreadable list is marked, never shown as empty');

  const emptyNotes = cinema(C, full({ notes: [] }));
  assert.ok(emptyNotes.includes('aria-label="Notes"') && !emptyNotes.includes('Notes ('), 'no notes: no badge');

  // dockItems is the rule the render uses.
  const can = (s) => ['tasks', 'kitchen'].includes(s);
  assert.deepEqual(C.dockItems(full(), can).map((d) => d.id), ['shop', 'notes']);
});

test('blocks the account cannot see are absent; unreadable ones say so', async () => {
  const C = await load('WallCinema.jsx');
  const bare = { scopes: ['tasks'], today: TODAY, from: TODAY, days: 42, gaps: [], tasks: { total: 0, tasks: [] } };
  const html = cinema(C, bare);
  assert.ok(html.includes('Household jobs') && html.includes('Nothing to do'), 'positive control: the wall drew');
  for (const absent of ['cine__bits', 'cine__chipsr', 'cine__dock', 'Tea', 'Half term', 'walk', 'cine__olook', 'Worming', 'Shopping', 'Notes']) {
    assert.ok(!html.includes(absent), `absent block draws nothing: ${absent}`);
  }
  const gaps = cinema(C, full({ tea: null, countdowns: null, walk: null, outlook: null, care: null }));
  assert.ok(gaps.includes('Tea: can’t read'));
  assert.ok(gaps.includes('Countdowns: can’t read'));
  assert.ok(gaps.includes('Can’t see Nick’s walk'));
  assert.ok(gaps.includes('Can’t read the forecast just now'));
  assert.ok(gaps.includes('I couldn’t read Ember’s care'));
  const nk = cinema(C, full({ outlook: { known: false, why: 'Forecast not configured' } }));
  assert.ok(nk.includes('Forecast not configured'), 'known:false says why');
});

test('under the clock: tea, the nearest two countdowns, and the walk banner (amber when overdue)', async () => {
  const C = await load('WallCinema.jsx');
  const html = cinema(C, full());
  assert.ok(html.includes('aria-label="Tea tonight — tap to set"') && html.includes('Lasagne'));
  assert.ok(html.includes('Half term') && html.includes('in 5 days') && html.includes('in 8 days'));
  assert.ok(!html.includes('cine__walkbanner'), 'no walk: no banner');
  const unset = cinema(C, full({ tea: { today: null, days: [], recent: [] } }));
  assert.ok(unset.includes('<span class="cine__bitlabel">Tea</span> —'), 'tea not set: "Tea —"');

  const out = cinema(C, full({ walk: { active: true, state: 'out', name: 'Kinder Scout', start: '2026-10-25T10:00:00', due: '2026-10-25T15:30:00', alertAt: '2026-10-25T16:30:00' } }));
  assert.ok(out.includes('Nick’s on a walk · back by ~15:30') && out.includes('cine__walkbanner"'));
  const late = cinema(C, full({ walk: { active: true, state: 'overdue', name: 'Kinder Scout', start: '2026-10-25T10:00:00', due: '2026-10-25T13:30:00', alertAt: '2026-10-25T14:30:00', minutesLate: 35 } }));
  assert.ok(late.includes('cine__walkbanner cine__walkbanner--late') && late.includes('Nick’s walk · overdue since 13:30'), 'overdue: amber banner');
  const back = cinema(C, full({ walk: { active: false, back: { name: 'Kinder Scout', checkedInAt: '2026-10-25T13:10:00' } } }));
  assert.ok(back.includes('Nick’s back from the walk · 13:10') && !back.includes('cine__walkbanner'));
  // Without the hike scope the walk is not drawn even if present.
  const noHike = cinema(C, full({ scopes: ['tasks', 'calendar', 'house'], walk: { active: true, state: 'out', due: '2026-10-25T15:30:00' } }));
  assert.ok(!noHike.includes('on a walk'));
});

test('the outlook: rain line and high/low in the Outside tile, tomorrow on the Tomorrow card', async () => {
  const C = await load('WallCinema.jsx');
  const html = cinema(C, full());
  assert.ok(html.includes('Rain likely from about 15:20') && html.includes('cine__orain--wet'));
  assert.ok(html.includes('High 14° · Low 7°'));
  assert.ok(html.includes('<p class="cine__pextra">13°/6° · 40% rain</p>'), 'tomorrow’s high/low and rain chance at the head of its card');
  assert.equal(C.tomorrowLine({ known: true, tomorrow: { highC: null, lowC: null, rainChance: null } }), null, 'nothing known: nothing said');
  assert.equal(C.tomorrowLine({ known: true, tomorrow: { highC: 12, lowC: null, rainChance: 0 } }), 'High 12° · 0% rain', 'a 0% chance is a fact, not nothing');
  assert.equal(C.outlookLines(undefined), null);
  // The outlook still shows when the station itself cannot be read.
  const noStation = cinema(C, full({ station: { known: false, why: 'the station has not reported' } }));
  assert.ok(noStation.includes('the station has not reported') && noStation.includes('High 14° · Low 7°'));
});

test('Ember’s care in the jobs tile: overdue above the jobs, due-this-week after, read-only', async () => {
  const C = await load('WallCinema.jsx');
  const html = cinema(C, full());
  assert.ok(html.includes('Worming 3 days overdue'));
  assert.ok(html.indexOf('Worming 3 days overdue') < html.indexOf('Clean the gutters'), 'overdue care first');
  assert.ok(!html.includes('Flea treatment due Wed'), 'two slots: due-this-week care waits behind the count');
  assert.ok(html.includes('+1 more'), 'and is counted');
  assert.ok(!/<button[^>]*>[^<]*<span class="cine__jtext"><span class="cine__paw"/.test(html), 'care is not a button');
  const t = C.jobsTile({ total: 1, tasks: [{ id: 1 }] }, [{ id: 'a', overdue: false }, { id: 'b', overdue: true }]);
  assert.deepEqual(t.shown.map((x) => `${x.kind}:${x.item.id}`), ['care:b', 'job:1']);
  assert.equal(t.more, 1);
  const noHouse = cinema(C, full({ scopes: ['tasks', 'calendar'] }));
  assert.ok(!noHouse.includes('Worming'), 'care needs the house scope');

  const S = await load('WallSheets.jsx');
  const all = text(renderToString(h(S.AllJobsSheet, { tasks: full().tasks, care: full().care, today: TODAY, act: ACT, onOpenJob() {}, onAdd() {} })));
  assert.ok(all.includes('Worming 3 days overdue') && all.includes('Flea treatment due Wed'), 'every care item in the jobs sheet');
});

test('the house: on/off/off-at-the-wall, boost and cancel boost, all lights off, and a refused write', async () => {
  const S = await load('WallSheets.jsx');
  const home = {
    ok: true, known: true, lightsOn: 2, why: null,
    rooms: [
      { id: 'living', name: 'Living room', tempC: 19.5, targetC: 18, boost: { on: false, untilHHMM: null }, climate: 'climate.living_room_rad',
        lights: [{ entity: 'light.a', name: 'Living room 1', state: 'on' }, { entity: 'light.b', name: 'Living room 2', state: 'unavailable' }],
        sockets: [{ entity: 'switch.tv', name: 'TV & lamp sockets', state: 'off' }] },
      { id: 'bath', name: 'Bathroom', tempC: 17.2, targetC: 21, boost: { on: true, untilHHMM: '15:30' }, climate: 'climate.bathroom_rad', lights: [{ entity: 'light.bathroom', name: 'Bathroom', state: 'on' }], sockets: [] },
      { id: 'pantry', name: 'Pantry', tempC: null, targetC: null, boost: { on: false, untilHHMM: null }, climate: null, lights: [{ entity: 'light.pantry', name: 'Pantry', state: 'unavailable' }], sockets: [] },
    ],
  };
  const html = text(renderToString(h(S.HomeView, { home })));
  assert.ok(html.includes('aria-label="Living room 1 is on — turn it off"'), 'a light that is on');
  assert.ok(html.includes('aria-label="TV & lamp sockets is off — turn it on"'), 'a socket that is off');
  assert.ok(html.includes('Living room 2: off at the wall') && !html.includes('Living room 2 is'), 'unavailable: greyed, no button');
  assert.ok(html.includes('Boost 1 hr'), 'no boost running: offer it');
  assert.ok(html.includes('Cancel boost (until 15:30)'), 'a boost running: cancel it');
  assert.ok(html.includes('Turn all lights off (2 on)'));
  assert.ok(!html.includes('aria-label="Pantry"'), 'a room with nothing controllable is not shown');
  assert.ok(html.includes('19.5°') && html.includes('set to 18°'));

  const none = text(renderToString(h(S.HomeView, { home: { ...home, lightsOn: 0 } })));
  assert.ok(!none.includes('Turn all lights off'), 'no lights on: no all-off button');

  const saving = text(renderToString(h(S.HomeView, { home, busy: 'light.a' })));
  assert.ok(saving.includes('Saving…') && saving.includes('disabled=""'), 'one press at a time, saying so');

  const refused = S.homeAnswer({ ok: false, verified: false, say: 'That light didn’t answer' });
  assert.deepEqual(refused, { ok: false, text: 'Not saved — That light didn’t answer' });
  const shown = text(renderToString(h(S.HomeView, { home, msg: refused })));
  assert.ok(shown.includes('Not saved — That light didn’t answer') && shown.includes('role="alert"'));
  assert.equal(S.homeAnswer({ ok: true, verified: true, say: 'Living room 1 is off' }).text, 'Living room 1 is off');
  assert.equal(S.homeAnswer({ ok: true, verified: false }).ok, false, 'not read back is never "done"');
  assert.match(S.homeAnswer(null, new Error("I can't reach home right now.")).text, /^Not saved — I can't reach home/);

  assert.ok(text(renderToString(h(S.HomeView, { home: undefined }))).includes('Reading the house'));
  assert.ok(text(renderToString(h(S.HomeView, { home: null, readErr: 'no answer from home' }))).includes('I couldn’t read the house — no answer from home'));
  assert.ok(text(renderToString(h(S.HomeView, { home: { ok: true, known: false, why: 'Home Assistant is not answering' } }))).includes('Home Assistant is not answering'));
  // The sheet itself mounts (reads on open, in an effect).
  assert.ok(text(renderToString(h(S.HomeSheet, { act: ACT }))).includes('Reading the house'));
});

test('shopping: tick to buy, bought today greyed with Undo, gaps and a list not started', async () => {
  const S = await load('WallSheets.jsx');
  const sh = full().shopping;
  const html = text(renderToString(h(S.ShoppingSheet, { shopping: sh, act: ACT, setDirty() {} })));
  assert.equal(count(html, /class="cine__tick" [^>]*aria-label="Got /g), 3, 'a big tick per thing to buy');
  assert.ok(html.includes('Bought today') && html.includes('cine__bought">Butter') && html.includes('aria-label="Undo — Butter not bought"'));
  assert.ok(text(renderToString(h(S.ShoppingSheet, { shopping: null, act: ACT }))).includes('I couldn’t read the shopping list'));
  assert.ok(text(renderToString(h(S.ShoppingSheet, { shopping: { exists: false, toBuy: [], bought: [] }, act: ACT }))).includes('No shopping list yet'));
});

test('notes: who left it and when, a clear button each, a named gap', async () => {
  const S = await load('WallSheets.jsx');
  const html = text(renderToString(h(S.NotesSheet, { notes: full().notes, act: ACT, now: NOW })));
  assert.ok(html.includes('Parcel is in the shed') && html.includes('Helen · 09:30'));
  assert.ok(html.includes('Family · yesterday 18:20'));
  assert.equal(count(html, />Clear<\/button>/g), 2);
  assert.ok(text(renderToString(h(S.NotesSheet, { notes: null, act: ACT }))).includes('I couldn’t read the notes'));
  assert.equal(S.noteWhen('not a date', NOW), '');
  assert.equal(S.noteWhen('2026-10-21T08:05:00', NOW), 'Wed 08:05');
});

test('tea: tonight and the next six days, recent meals as chips', async () => {
  const S = await load('WallSheets.jsx');
  const days = S.teaDays(full().tea, TODAY);
  assert.deepEqual(days.map((d) => d.label), ['Tonight', 'Tomorrow', 'Tue 27', 'Wed 28', 'Thu 29', 'Fri 30', 'Sat 31']);
  assert.equal(days[0].text, 'Lasagne'); assert.equal(days[2].text, 'Fish pie'); assert.equal(days[1].text, '');
  const html = text(renderToString(h(S.TeaSheet, { tea: full().tea, today: TODAY, act: ACT, setDirty() {} })));
  assert.equal(count(html, /class="cine__teaday"/g), 7);
  assert.ok(html.includes('value="Lasagne"') && html.includes('value="Fish pie"'));
  assert.ok(html.includes('>Chilli</button>'), 'recent chips');
  assert.ok(text(renderToString(h(S.TeaSheet, { tea: null, today: TODAY, act: ACT }))).includes('I couldn’t read the tea plan'));
});

test('the walk sheet: an overdue walk says so, with the map and who to call', async () => {
  const S = await load('WallSheets.jsx');
  const MapView = (p) => h('div', { 'data-map': `${p.route.length}/${p.positions.length}` });
  const walk = { active: true, state: 'overdue', name: 'Kinder Scout', start: '2026-10-25T10:00:00', due: '2026-10-25T13:30:00', alertAt: '2026-10-25T14:30:00', minutesLate: 35,
    alerted: { at: '2026-10-25T14:30:00', sent: true }, route: [[53.4, -1.8], [53.41, -1.81]], trail: [], emberTrail: [],
    positions: [{ label: 'Nick’s phone', at: '2026-10-25T13:02:00', ago: '1 h ago', minutesAgo: 63, lat: 53.4, lon: -1.8 }] };
  const html = text(renderToString(h(S.WalkSheet, { walk, MapView })));
  assert.ok(html.includes('role="alert"') && html.includes('back by 13:30') && html.includes('35 min late') && html.includes('call 999'));
  assert.ok(html.includes('NEURO has emailed the route card'));
  assert.ok(html.includes('data-map="2/1"'), 'the map gets the walk’s own data');
  assert.ok(html.includes('class="cine__late">(1 h ago)'), 'an old position is said to be old');
  assert.ok(text(renderToString(h(S.WalkSheet, { walk: null }))).includes('I couldn’t see Nick’s walk'));
  assert.ok(text(renderToString(h(S.WalkSheet, { walk: { active: false } }))).includes('isn’t out on a walk'));
});

test('the event sheet: "Count down to this" from the event’s own key and flag', async () => {
  const S = await load('WallSheets.jsx');
  const ev = { id: 'g1', calendarId: 'g1', title: 'Isaac swimming', start: '2026-10-26T17:00:00', end: '2026-10-26T18:00:00', editable: true, countdownKey: 'g1@2026-10-26', countdown: false };
  const off = text(renderToString(h(S.EventSheet, { event: ev, today: TODAY, act: ACT, canEdit: true })));
  assert.ok(off.includes('>Count down to this</button>') && off.includes('aria-pressed="false"'));
  const on = text(renderToString(h(S.EventSheet, { event: { ...ev, countdown: true }, today: TODAY, act: ACT, canEdit: true })));
  assert.ok(on.includes('Counting down to this') && on.includes('aria-pressed="true"'));
  const live = text(renderToString(h(S.EventSheet, { event: ev, live: { ...ev, countdown: true }, today: TODAY, act: ACT, canEdit: true })));
  assert.ok(live.includes('Counting down to this'), 'the latest read wins over the snapshot');
  const phone = text(renderToString(h(S.EventSheet, { event: { ...ev, editable: false }, today: TODAY, act: ACT, canEdit: true })));
  assert.ok(phone.includes('Count down to this') && phone.includes('phone calendar'), 'a phone event can be counted down too');
  const nokey = text(renderToString(h(S.EventSheet, { event: { ...ev, countdownKey: undefined }, today: TODAY, act: ACT, canEdit: true })));
  assert.ok(!nokey.includes('Count down'), 'no key from the server: no toggle');
});

test('the room screens keep their fusion slots with the new pieces in place', async () => {
  const C = await load('WallCinema.jsx');
  const html = cinema(C, full(), { fusion: { field: h('i', { id: 'field' }), line: 'It’s 17 in here', card: h('b', { id: 'offer' }) } });
  assert.ok(html.includes('cine__saimfield') && html.includes('id="field"'));
  assert.ok(html.includes('cine__saimline">It’s 17 in here'));
  assert.ok(html.includes('cine__saimcard') && html.includes('id="offer"'));
  assert.ok(html.includes('cine__dock'), 'and the dock is there too');
});
