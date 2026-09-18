'use strict';

const test = require('node:test');
const assert = require('node:assert');

const su = require('./screen-usage');

// A Thursday, so the Monday of its week is unambiguous.
const NOW = new Date(2026, 8, 17, 14, 0, 0); // 17 Sep 2026
const COLS = su.weekColumns(NOW, 4);          // 4 Mondays ending 14 Sep

const opened = (o) => ({ kind: 'opened', ...o });
const touched = (o) => ({ kind: 'interacted', ...o });

test('weekColumns ends on the Monday of the anchor week, oldest first', () => {
  assert.deepStrictEqual(COLS, ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14']);
});

test('weekKeyOf borrows weekly-target.weekStart — Sunday belongs to the week it ends', () => {
  // 20 Sep 2026 is a Sunday. getDay() calls it 0, so a naive `dow - 1` moves it
  // FORWARD into a week that has not begun. It belongs to the 14th.
  assert.strictEqual(su.weekKeyOf('2026-09-20'), '2026-09-14');
  assert.strictEqual(su.weekKeyOf('2026-09-14'), '2026-09-14');
  assert.strictEqual(su.weekKeyOf('2026-09-13'), '2026-09-07');
});

test('weekEndKey closes the week on the Sunday', () => {
  assert.strictEqual(su.weekEndKey('2026-09-14'), '2026-09-20');
});

// ── The fold ────────────────────────────────────────────────────────────────

test('events fold into the right week, the right hour and the right KIND', () => {
  const { rows } = su.foldEvents([
    opened({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 }),
    opened({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-16', hour: 9 }),
    touched({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-16', hour: 9, count: 12 }),
  ], COLS);

  assert.strictEqual(rows.length, 1, 'both kinds land on ONE row for the screen');
  assert.strictEqual(rows[0].opened.total, 2);
  assert.strictEqual(rows[0].interacted.total, 12);
  assert.deepStrictEqual(rows[0].opened.weeks, [0, 0, 0, 2]);
  assert.deepStrictEqual(rows[0].interacted.weeks, [0, 0, 0, 12]);
  assert.strictEqual(rows[0].opened.hours[9], 2);
  assert.strictEqual(rows[0].interacted.hours[9], 12);
});

test('⚠ every row carries BOTH kinds, even one that was only ever opened', () => {
  // Without this the row would have no interacted half at all, and the absence
  // would render as the screen not existing rather than as work not happening.
  const { rows } = su.foldEvents([
    opened({ surface: 'neuro', screen: 'briefing', dateKey: '2026-09-15', hour: 8 }),
  ], COLS);
  assert.strictEqual(rows[0].interacted.total, 0);
  assert.strictEqual(rows[0].interacted.weeks.length, COLS.length);
  assert.strictEqual(rows[0].interacted.hours.length, 24);
});

test('⚠ a COUNT is honoured, and a missing one is 1 rather than 0', () => {
  const { rows } = su.foldEvents([
    touched({ surface: 'neuro', screen: 'a', dateKey: '2026-09-15', hour: 9, count: 7 }),
    touched({ surface: 'neuro', screen: 'a', dateKey: '2026-09-15', hour: 9 }),
    touched({ surface: 'neuro', screen: 'a', dateKey: '2026-09-15', hour: 9, count: null }),
    touched({ surface: 'neuro', screen: 'a', dateKey: '2026-09-15', hour: 9, count: 0 }),
  ], COLS);
  // 7 + 1 + 1 + 1 — a null or zero count is a batch reported badly, not a batch
  // of nothing, and dropping it would lose a real click.
  assert.strictEqual(rows[0].interacted.total, 10);
});

test('an untagged event is NEURO\'s — a fact, not a fallback for anything else', () => {
  const { rows } = su.foldEvents([opened({ screen: 'briefing', dateKey: '2026-09-15', hour: 8 })], COLS);
  assert.strictEqual(rows[0].surface, 'neuro');
});

test('an unrecognised kind folds as opened, never into a third bucket', () => {
  const { rows } = su.foldEvents([
    { kind: 'scrolled', surface: 'neuro', screen: 'a', dateKey: '2026-09-15', hour: 9 },
  ], COLS);
  assert.strictEqual(rows[0].opened.total, 1);
});

test('last is NOT truncated to the window, or a dead screen claims it was opened recently', () => {
  const { rows, outsideWindow } = su.foldEvents([
    opened({ surface: 'neuro', screen: 'strava', dateKey: '2026-06-30', hour: 12 }),
  ], COLS);
  assert.strictEqual(rows[0].opened.total, 0, 'outside the window, so it counts nothing');
  assert.strictEqual(rows[0].opened.last, '2026-06-30', 'but it still says when it was last seen');
  assert.strictEqual(outsideWindow, 1);
});

test('an unreadable screen or date is dropped AND counted, never guessed into a bucket', () => {
  const { rows, dropped } = su.foldEvents([
    opened({ surface: 'neuro', screen: '', dateKey: '2026-09-15', hour: 9 }),
    opened({ surface: 'neuro', screen: 'todos', dateKey: 'not-a-date', hour: 9 }),
    opened({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 }),
  ], COLS);
  assert.strictEqual(dropped, 2);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].opened.total, 1);
});

test('⚠ a missing hour is NOT coerced to midnight', () => {
  const { rows } = su.foldEvents([
    opened({ surface: 'vantage', screen: 'radar', dateKey: '2026-09-15', hour: 99 }),
    opened({ surface: 'vantage', screen: 'radar', dateKey: '2026-09-15', hour: null }),
    opened({ surface: 'vantage', screen: 'radar', dateKey: '2026-09-15', hour: '' }),
  ], COLS);
  assert.strictEqual(rows[0].opened.total, 3, 'the opens still count');
  assert.strictEqual(rows[0].opened.hours.reduce((a, b) => a + b, 0), 0, 'but no hour is invented');
});

// ── The rule the whole feature turns on ─────────────────────────────────────

test('⚠ a week that ENDED before a surface reported that KIND is null, NEVER zero', () => {
  const rows = su.foldEvents([
    touched({ surface: 'saim', screen: 'surface', dateKey: '2026-09-15', hour: 20 }),
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, { 'saim::interacted': '2026-09-15' });
  assert.deepStrictEqual(rows[0].interacted.weeks, [null, null, null, 1]);
});

test('⚠⚠ MASKING IS PER KIND — one surface legitimately has two start dates', () => {
  // NEURO has opens back to June and interactions only from September. A
  // `since` keyed on the surface alone would fill the interacted grid with
  // eleven weeks of ZEROS, which beside a full accessed grid reads as "he
  // opens NEURO constantly and never touches anything".
  const rows = su.foldEvents([
    opened({ surface: 'neuro', screen: 'todos', dateKey: '2026-08-25', hour: 9 }),
    opened({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 }),
    touched({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9, count: 4 }),
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, {
    'neuro::opened': '2026-06-22',
    'neuro::interacted': '2026-09-15',
  });

  assert.deepStrictEqual(rows[0].opened.weeks, [1, 0, 0, 1], 'opens cover the whole window');
  assert.deepStrictEqual(
    rows[0].interacted.weeks, [null, null, null, 4],
    'and the interacted half is blank where nothing was watching — never 0'
  );
});

test('⚠ the week CONTAINING the start date stays a number — part of it was measured', () => {
  const rows = su.foldEvents([
    touched({ surface: 'saim', screen: 'surface', dateKey: '2026-09-17', hour: 20 }),
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, { 'saim::interacted': '2026-09-17' });
  assert.strictEqual(rows[0].interacted.weeks[3], 1);
  assert.notStrictEqual(rows[0].interacted.weeks[3], null, 'zeroing it would hide the day instrumentation landed');
});

test('a surface+kind with no since is not masked', () => {
  const rows = su.foldEvents([
    opened({ surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 }),
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, {});
  assert.deepStrictEqual(rows[0].opened.weeks, [0, 0, 0, 1]);
});

test('firstSeen keys on surface AND kind, and gives none to one that never reported', () => {
  const seen = su.firstSeen([
    opened({ surface: 'neuro', screen: 'a', dateKey: '2026-09-15' }),
    opened({ surface: 'neuro', screen: 'b', dateKey: '2026-06-22' }),
    touched({ surface: 'neuro', screen: 'a', dateKey: '2026-09-18' }),
  ]);
  assert.deepStrictEqual(seen, {
    'neuro::opened': '2026-06-22',
    'neuro::interacted': '2026-09-18',
  });
  assert.strictEqual(seen['saim::opened'], undefined);
});

// ── Ranking and assessment ──────────────────────────────────────────────────

test('⚠ rows rank by OPENS, never by interactions', () => {
  // Ranking by interactions would reshuffle the screen as that data accrued,
  // and would assert that a clicked screen outranks a read one.
  const rows = su.screenRows([
    { surface: 'neuro', screen: 'briefing', opened: { total: 140 }, interacted: { total: 2 } },
    { surface: 'neuro', screen: 'todos', opened: { total: 130 }, interacted: { total: 900 } },
    { surface: 'saim', screen: 'surface', opened: { total: 999 }, interacted: { total: 0 } },
  ]);
  assert.deepStrictEqual(
    rows.map(r => r.screen),
    ['briefing', 'todos', 'surface'],
    'briefing outranks todos on opens despite 450x fewer interactions'
  );
});

test('an unreadable surface is a named gap finding, never an empty surface', () => {
  const findings = su.assess([], COLS, [
    { id: 'vantage', label: 'VANTAGE', known: false, reason: 'database not found at /x' },
  ]);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].severity, 'gap');
  assert.match(findings[0].detail, /database not found/);
});

test('⚠ a surface that has never reported a KIND says so, per kind', () => {
  const findings = su.assess([], COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: { opened: '2026-06-22', interacted: null } },
  ]);
  const gap = findings.find(f => f.kind === 'interacted' && f.severity === 'gap');
  assert.ok(gap, 'the un-instrumented half must be named');
  assert.match(gap.title, /never reported an interaction/);
  assert.match(gap.detail, /not a sign the app goes unused/);
  assert.ok(!findings.some(f => f.kind === 'opened' && f.severity === 'gap'), 'the instrumented half is not flagged');
});

test('⚠ a freshly instrumented surface says so, and its screens are NOT called quiet', () => {
  const rows = [{ surface: 'saim', screen: 'chat', opened: { total: 0 }, interacted: { total: 0 } }];
  const findings = su.assess(rows, COLS, [
    { id: 'saim', label: 'SAiM', known: true, since: { opened: '2026-09-17', interacted: '2026-09-17' } },
  ]);
  assert.ok(findings.some(f => /only recorded since/.test(f.title)));
  assert.ok(
    !findings.some(f => /not opened/.test(f.title)),
    'a screen on a surface nothing was watching has not "gone quiet"'
  );
});

test('a screen on a fully covered surface with no opens IS reported quiet', () => {
  const rows = [{ surface: 'neuro', screen: 'strava', opened: { total: 0 }, interacted: { total: 0 } }];
  const findings = su.assess(rows, COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: { opened: '2026-06-22', interacted: '2026-06-22' } },
  ]);
  const quiet = findings.find(f => /not opened/.test(f.title));
  assert.ok(quiet);
  assert.match(quiet.detail, /strava/);
});

test('⚠⚠ a screen opened and never clicked is named as READ, not as failing', () => {
  // Measured: BriefingPanel has 4 interactive elements, TodoPanel has 99. The
  // interacted grid will ALWAYS show the reading screens near-empty, and beside
  // a full accessed grid that reads as an indictment of the screens that work
  // best. This finding is about how to READ the grid, not about the screens.
  const rows = [
    { surface: 'neuro', screen: 'briefing', opened: { total: 140 }, interacted: { total: 0 } },
    { surface: 'neuro', screen: 'todos', opened: { total: 130 }, interacted: { total: 900 } },
  ];
  const findings = su.assess(rows, COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: { opened: '2026-06-22', interacted: '2026-06-22' } },
  ]);
  const read = findings.find(f => /never clicked/.test(f.title));
  assert.ok(read, 'the read-not-worked screens must be named');
  assert.match(read.detail, /briefing/);
  assert.match(read.detail, /doing its job, not failing at it/);
  assert.ok(!read.detail.includes('todos'), 'a worked screen is not in that list');
});

test('a screen with NO opens is not called read-but-never-clicked', () => {
  // It was not read either — it is quiet, which is a different finding.
  const rows = [{ surface: 'neuro', screen: 'strava', opened: { total: 0 }, interacted: { total: 0 } }];
  const findings = su.assess(rows, COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: { opened: '2026-06-22', interacted: '2026-06-22' } },
  ]);
  assert.ok(!findings.some(f => /never clicked/.test(f.title)));
});

test('⚠ it STATES and never advises — no score, no verdict, nothing told to go', () => {
  const rows = [
    { surface: 'neuro', screen: 'strava', opened: { total: 0 }, interacted: { total: 0 } },
    { surface: 'neuro', screen: 'briefing', opened: { total: 9 }, interacted: { total: 0 } },
  ];
  const findings = su.assess(rows, COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: { opened: '2026-06-22', interacted: '2026-06-22' } },
  ]);
  const text = JSON.stringify(findings).toLowerCase();
  for (const word of ['retire', 'delete', 'remove it', 'unused', 'should', 'recommend', 'score', 'engagement']) {
    assert.ok(!text.includes(word), `assess() must not say "${word}" — whether a screen goes is Nick's call`);
  }
});

test('hourTotals sums per kind, so each grid is scaled by its own busiest hour', () => {
  const totals = su.hourTotals([
    {
      opened: { hours: Object.assign(new Array(24).fill(0), { 9: 2 }) },
      interacted: { hours: Object.assign(new Array(24).fill(0), { 9: 40 }) },
    },
    {
      opened: { hours: Object.assign(new Array(24).fill(0), { 9: 1 }) },
      interacted: { hours: new Array(24).fill(0) },
    },
  ]);
  assert.strictEqual(totals.opened[9], 3);
  assert.strictEqual(totals.interacted[9], 40);
});

test('knownSurface names exactly the three surfaces, and a fourth is not one', () => {
  assert.ok(su.knownSurface('neuro') && su.knownSurface('saim') && su.knownSurface('vantage'));
  assert.ok(!su.knownSurface('nova'));
  assert.ok(!su.knownSurface(''));
});

test('⚠ interactions are their OWN event type, never tab_open with a flag', () => {
  // `nudges.js` and `outcomes.js` filter strictly on `tab_open` — one to pick a
  // nudge target, the other for the Friday reflection count — so folding these
  // in would silently change what both of them mean, at ~10x the volume.
  assert.strictEqual(su.OPEN_EVENT, 'tab_open');
  assert.strictEqual(su.INTERACT_EVENT, 'screen_interact');
  assert.notStrictEqual(su.INTERACT_EVENT, su.OPEN_EVENT);
});

// ── The readers, through build() ────────────────────────────────────────────

function fakeDb(rows, firstSeen) {
  return {
    getScreenEventsSince: () => rows,
    getScreenEventFirstSeen: () => firstSeen || [],
  };
}

const ev = (type, data, hour, date) => ({
  event_type: type, event_data: JSON.stringify(data), hour, date_key: date,
});

test('⚠ a checkin: event is not a screen — excluded by prefix and COUNTED', () => {
  const out = su.build({
    now: NOW, weeks: 4,
    db: fakeDb([
      ev('tab_open', { tab: 'todos' }, 9, '2026-09-15'),
      ev('tab_open', { tab: 'checkin:Office' }, 9, '2026-09-15'),
      ev('tab_open', { tab: 'checkin:Home' }, 18, '2026-09-15'),
    ]),
    readVantage: () => ({ known: true, events: [], empty: true }),
  });

  assert.deepStrictEqual(out.rows.map(r => r.screen), ['todos']);
  assert.strictEqual(out.excluded.checkins, 2, 'a silent filter is a number nobody can check');
});

test('the reader tells the two event types apart and carries the batch count', () => {
  const out = su.build({
    now: NOW, weeks: 4,
    db: fakeDb([
      ev('tab_open', { tab: 'todos', surface: 'neuro' }, 9, '2026-09-15'),
      ev('screen_interact', { tab: 'todos', surface: 'neuro', count: 15 }, 9, '2026-09-15'),
    ]),
    readVantage: () => ({ known: true, events: [] }),
  });
  const row = out.rows.find(r => r.screen === 'todos');
  assert.strictEqual(row.opened.total, 1);
  assert.strictEqual(row.interacted.total, 15);
});

test('an unreadable VANTAGE is a named gap and an unknown surface — never zero screens', () => {
  const out = su.build({
    now: NOW, weeks: 4,
    db: fakeDb([]),
    readVantage: () => ({ known: false, reason: 'VANTAGE database not found at /nope' }),
  });
  const v = out.surfaces.find(s => s.id === 'vantage');
  assert.strictEqual(v.known, false);
  assert.match(v.reason, /not found/);
  assert.ok(out.gaps.some(g => /not found/.test(g)));
  assert.ok(out.findings.some(f => f.severity === 'gap' && f.surface === 'vantage'));
});

test('a VANTAGE store that is readable and empty is KNOWN — a different fact from unreadable', () => {
  const out = su.build({
    now: NOW, weeks: 4, db: fakeDb([]),
    readVantage: () => ({ known: true, events: [], empty: true }),
  });
  const v = out.surfaces.find(s => s.id === 'vantage');
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.opens, 0);
  assert.deepStrictEqual(v.since, { opened: null, interacted: null });
});

test('⚠ a VANTAGE row with no kind is an OPEN — history is not reclassified', () => {
  const out = su.build({
    now: NOW, weeks: 4, db: fakeDb([]),
    readVantage: () => ({
      known: true,
      events: [{ surface: 'vantage', screen: 'radar', dateKey: '2026-09-15', hour: 9 }],
    }),
  });
  const row = out.rows.find(r => r.screen === 'radar');
  assert.strictEqual(row.opened.total, 1);
  assert.strictEqual(row.interacted.total, 0);
});

test('build never throws when NEURO\'s own log is unreadable — it says so instead', () => {
  const out = su.build({
    now: NOW, weeks: 4,
    db: { getScreenEventsSince: () => { throw new Error('disk gone'); }, getScreenEventFirstSeen: () => [] },
    readVantage: () => ({ known: true, events: [] }),
  });
  assert.ok(out.gaps.some(g => /disk gone/.test(g)));
  assert.deepStrictEqual(out.rows, []);
});

test('⚠ since comes from the WHOLE log, per kind — not from the window', () => {
  const out = su.build({
    now: NOW, weeks: 4,
    // The window read only sees September; the aggregate knows about June.
    db: fakeDb(
      [ev('tab_open', { tab: 'todos', surface: 'neuro' }, 9, '2026-09-15')],
      [
        { event_type: 'tab_open', surface: 'neuro', first_seen: '2026-06-22' },
        { event_type: 'screen_interact', surface: 'neuro', first_seen: '2026-09-18' },
      ]
    ),
    readVantage: () => ({ known: true, events: [] }),
  });

  const n = out.surfaces.find(s => s.id === 'neuro');
  assert.strictEqual(n.since.opened, '2026-06-22');
  assert.strictEqual(n.since.interacted, '2026-09-18');

  const row = out.rows.find(r => r.screen === 'todos');
  assert.ok(!row.opened.weeks.includes(null), 'opens cover the whole window');
  assert.ok(row.interacted.weeks.includes(null), 'and the interacted half is masked where it was not watching');
});

test('⚠ the payload states what BOTH halves measure, and the second defends the reading screens', () => {
  const out = su.build({ now: NOW, weeks: 4, db: fakeDb([]), readVantage: () => ({ known: true, events: [] }) });
  assert.match(out.measures.opened, /not time spent/);
  assert.match(out.measures.interacted, /not a screen that failed/);
  assert.deepStrictEqual(out.kinds, ['opened', 'interacted']);
});

test('the window is bounded at 52 weeks and a nonsense value falls back to the default', () => {
  const mk = (w) => su.build({ now: NOW, weeks: w, db: fakeDb([]), readVantage: () => ({ known: true, events: [] }) });
  assert.strictEqual(mk(500).window.weeks, 52);
  assert.strictEqual(mk(-3).window.weeks, su.DEFAULT_WEEKS);
});
