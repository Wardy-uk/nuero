'use strict';

const test = require('node:test');
const assert = require('node:assert');

const su = require('./screen-usage');

// A Thursday, so the Monday of its week is unambiguous.
const NOW = new Date(2026, 8, 17, 14, 0, 0); // 17 Sep 2026
const COLS = su.weekColumns(NOW, 4);          // 4 Mondays ending 14 Sep

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

test('opens fold into the right week and the right hour', () => {
  const { rows } = su.foldOpens([
    { surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 },
    { surface: 'neuro', screen: 'todos', dateKey: '2026-09-16', hour: 9 },
    { surface: 'neuro', screen: 'todos', dateKey: '2026-09-01', hour: 22 },
  ], COLS);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total, 3);
  assert.deepStrictEqual(rows[0].weeks, [0, 1, 0, 2]);
  assert.strictEqual(rows[0].hours[9], 2);
  assert.strictEqual(rows[0].hours[22], 1);
  assert.strictEqual(rows[0].lastOpened, '2026-09-16');
});

test('an untagged open is NEURO\'s — a fact, not a fallback for anything else', () => {
  const { rows } = su.foldOpens([{ screen: 'briefing', dateKey: '2026-09-15', hour: 8 }], COLS);
  assert.strictEqual(rows[0].surface, 'neuro');
});

test('lastOpened is NOT truncated to the window, or a dead screen claims it was opened recently', () => {
  const { rows, outsideWindow } = su.foldOpens([
    { surface: 'neuro', screen: 'strava', dateKey: '2026-06-30', hour: 12 },
  ], COLS);
  assert.strictEqual(rows[0].total, 0, 'outside the window, so it counts nothing');
  assert.strictEqual(rows[0].lastOpened, '2026-06-30', 'but it still says when it was last seen');
  assert.strictEqual(outsideWindow, 1);
});

test('an unreadable screen or date is dropped AND counted, never guessed into a bucket', () => {
  const { rows, dropped } = su.foldOpens([
    { surface: 'neuro', screen: '', dateKey: '2026-09-15', hour: 9 },
    { surface: 'neuro', screen: 'todos', dateKey: 'not-a-date', hour: 9 },
    { surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 },
  ], COLS);
  assert.strictEqual(dropped, 2);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].total, 1);
});

test('an hour outside 0-23 is not counted as an hour', () => {
  const { rows } = su.foldOpens([
    { surface: 'vantage', screen: 'radar', dateKey: '2026-09-15', hour: 99 },
    { surface: 'vantage', screen: 'radar', dateKey: '2026-09-15', hour: null },
  ], COLS);
  assert.strictEqual(rows[0].total, 2, 'the opens still count');
  assert.strictEqual(rows[0].hours.reduce((a, b) => a + b, 0), 0, 'but no hour is invented');
});

// ── The rule the whole feature turns on ─────────────────────────────────────

test('⚠ a week that ENDED before a surface first reported is null, NEVER zero', () => {
  const rows = su.foldOpens([
    { surface: 'saim', screen: 'surface', dateKey: '2026-09-15', hour: 20 },
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, { saim: '2026-09-15' });

  // 24 Aug, 31 Aug and 7 Sep all END before the 15th — nothing was watching.
  assert.deepStrictEqual(rows[0].weeks, [null, null, null, 1]);
});

test('⚠ the week CONTAINING the start date stays a number — part of it was measured', () => {
  const rows = su.foldOpens([
    { surface: 'saim', screen: 'surface', dateKey: '2026-09-17', hour: 20 },
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, { saim: '2026-09-17' });
  assert.strictEqual(rows[0].weeks[3], 1);
  assert.notStrictEqual(rows[0].weeks[3], null, 'zeroing it would hide the day instrumentation landed');
});

test('a surface with no since is not masked — nothing is known about when it began', () => {
  const rows = su.foldOpens([
    { surface: 'neuro', screen: 'todos', dateKey: '2026-09-15', hour: 9 },
  ], COLS).rows;
  su.maskUnknownWeeks(rows, COLS, {});
  assert.deepStrictEqual(rows[0].weeks, [0, 0, 0, 1]);
});

test('firstSeen takes the EARLIEST per surface, and gives none to a surface that never reported', () => {
  const seen = su.firstSeen([
    { surface: 'neuro', screen: 'a', dateKey: '2026-09-15' },
    { surface: 'neuro', screen: 'b', dateKey: '2026-06-22' },
    { surface: 'saim', screen: 'c', dateKey: '2026-09-17' },
  ]);
  assert.deepStrictEqual(seen, { neuro: '2026-06-22', saim: '2026-09-17' });
  assert.strictEqual(seen.vantage, undefined);
});

// ── Ranking and assessment ──────────────────────────────────────────────────

test('rows group by surface, then by opens — a SAiM screen never sits between two NEURO ones', () => {
  const rows = su.screenRows([
    { surface: 'saim', screen: 'surface', total: 99 },
    { surface: 'neuro', screen: 'todos', total: 5 },
    { surface: 'vantage', screen: 'radar', total: 50 },
    { surface: 'neuro', screen: 'today', total: 10 },
  ]);
  assert.deepStrictEqual(
    rows.map(r => `${r.surface}/${r.screen}`),
    ['neuro/today', 'neuro/todos', 'saim/surface', 'vantage/radar']
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

test('⚠ a freshly instrumented surface says so, and its screens are NOT called quiet', () => {
  const rows = [{ surface: 'saim', screen: 'chat', total: 0, weeks: [], hours: [] }];
  const findings = su.assess(rows, COLS, [
    { id: 'saim', label: 'SAiM', known: true, since: '2026-09-17' },
  ]);
  assert.ok(findings.some(f => /only been recorded since/.test(f.title)));
  assert.ok(
    !findings.some(f => /not opened/.test(f.title)),
    'a screen on a surface nothing was watching has not "gone quiet"'
  );
});

test('a screen on a fully covered surface with no opens IS reported quiet', () => {
  const rows = [{ surface: 'neuro', screen: 'strava', total: 0, weeks: [], hours: [] }];
  const findings = su.assess(rows, COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: '2026-06-22' },
  ]);
  const quiet = findings.find(f => /not opened/.test(f.title));
  assert.ok(quiet);
  assert.match(quiet.detail, /strava/);
});

test('⚠ it STATES and never advises — no score, no verdict, nothing told to go', () => {
  const rows = [{ surface: 'neuro', screen: 'strava', total: 0, weeks: [], hours: [] }];
  const findings = su.assess(rows, COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: '2026-06-22' },
  ]);
  const text = JSON.stringify(findings).toLowerCase();
  for (const word of ['retire', 'delete', 'remove it', 'unused', 'should', 'recommend', 'score']) {
    assert.ok(!text.includes(word), `assess() must not say "${word}" — whether a screen goes is Nick's call`);
  }
});

test('hourTotals sums across every row', () => {
  const totals = su.hourTotals([
    { hours: Object.assign(new Array(24).fill(0), { 9: 2 }) },
    { hours: Object.assign(new Array(24).fill(0), { 9: 1, 20: 5 }) },
  ]);
  assert.strictEqual(totals[9], 3);
  assert.strictEqual(totals[20], 5);
});

test('knownSurface names exactly the three surfaces, and a fourth is not one', () => {
  assert.ok(su.knownSurface('neuro') && su.knownSurface('saim') && su.knownSurface('vantage'));
  assert.ok(!su.knownSurface('nova'));
  assert.ok(!su.knownSurface(''));
});

// ── The readers, through build() ────────────────────────────────────────────

function fakeDb(rows, firstSeen) {
  return {
    getTabOpensSince: () => rows,
    getTabOpenFirstSeen: () => firstSeen || [],
  };
}

test('⚠ a checkin: event is not a screen — excluded by prefix and COUNTED', () => {
  const out = su.build({
    now: NOW,
    weeks: 4,
    db: fakeDb([
      { event_data: JSON.stringify({ tab: 'todos' }), hour: 9, date_key: '2026-09-15' },
      { event_data: JSON.stringify({ tab: 'checkin:Office' }), hour: 9, date_key: '2026-09-15' },
      { event_data: JSON.stringify({ tab: 'checkin:Home' }), hour: 18, date_key: '2026-09-15' },
    ]),
    readVantage: () => ({ known: true, opens: [], empty: true }),
  });

  assert.deepStrictEqual(out.rows.map(r => r.screen), ['todos']);
  assert.strictEqual(out.excluded.checkins, 2, 'a silent filter is a number nobody can check');
});

test('an unreadable VANTAGE is a named gap and an unknown surface — never zero screens', () => {
  const out = su.build({
    now: NOW,
    weeks: 4,
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
    now: NOW,
    weeks: 4,
    db: fakeDb([]),
    readVantage: () => ({ known: true, opens: [], empty: true }),
  });
  const v = out.surfaces.find(s => s.id === 'vantage');
  assert.strictEqual(v.known, true);
  assert.strictEqual(v.opens, 0);
  assert.strictEqual(v.since, null, 'nothing recorded yet, so nothing to date it from');
});

test('build never throws when NEURO\'s own log is unreadable — it says so instead', () => {
  const out = su.build({
    now: NOW,
    weeks: 4,
    db: { getTabOpensSince: () => { throw new Error('disk gone'); }, getTabOpenFirstSeen: () => [] },
    readVantage: () => ({ known: true, opens: [], empty: true }),
  });
  assert.ok(out.gaps.some(g => /disk gone/.test(g)));
  assert.deepStrictEqual(out.rows, []);
});

test('⚠ since comes from the WHOLE log, not the window — or every surface looks freshly instrumented', () => {
  const out = su.build({
    now: NOW,
    weeks: 4,
    // The window read only sees September; the aggregate knows about June.
    db: fakeDb(
      [{ event_data: JSON.stringify({ tab: 'todos', surface: 'neuro' }), hour: 9, date_key: '2026-09-15' }],
      [{ surface: 'neuro', first_seen: '2026-06-22' }]
    ),
    readVantage: () => ({ known: true, opens: [], empty: true }),
  });

  const n = out.surfaces.find(s => s.id === 'neuro');
  assert.strictEqual(n.since, '2026-06-22');
  const row = out.rows.find(r => r.screen === 'todos');
  assert.ok(!row.weeks.includes(null), 'NEURO covers the whole window, so no week is unknown');
});

test('the payload states what it measures, so no screen has to phrase it itself', () => {
  const out = su.build({ now: NOW, weeks: 4, db: fakeDb([]), readVantage: () => ({ known: true, opens: [] }) });
  assert.match(out.measures, /opens, not time/);
});

test('the window is bounded at 52 weeks and a nonsense value falls back to the default', () => {
  assert.strictEqual(su.build({ now: NOW, weeks: 500, db: fakeDb([]), readVantage: () => ({ known: true, opens: [] }) }).window.weeks, 52);
  assert.strictEqual(su.build({ now: NOW, weeks: -3, db: fakeDb([]), readVantage: () => ({ known: true, opens: [] }) }).window.weeks, su.DEFAULT_WEEKS);
});

test('⚠ a readable surface that has NEVER reported is a named gap, not a silent empty row', () => {
  // Caught on the FIRST LIVE RUN, not by a test: SAiM came back known:true,
  // screens:0, since:null and `assess()` said nothing at all — so the app Nick
  // uses most would have sat at the bottom of the grid with no rows and no
  // explanation, which is the "blank reads as unused" failure this whole
  // feature refuses, reproduced inside the thing refusing it.
  const findings = su.assess([], COLS, [
    { id: 'saim', label: 'SAiM', known: true, since: null, screens: 0, opens: 0 },
  ]);
  const gap = findings.find(f => f.surface === 'saim');
  assert.ok(gap, 'a surface with nothing recorded must say so');
  assert.strictEqual(gap.severity, 'gap');
  assert.match(gap.title, /never reported/);
  // ⚠ And it must say it is a gap in the MEASUREMENT, never a fact about use.
  assert.match(gap.detail, /not a sign the app goes unused/);
});

test('a surface that HAS reported does not get the never-reported gap', () => {
  const findings = su.assess([], COLS, [
    { id: 'neuro', label: 'NEURO', known: true, since: '2026-06-22' },
  ]);
  assert.ok(!findings.some(f => /never reported/.test(f.title)), 'positive control — the gap is not raised for everyone');
});
