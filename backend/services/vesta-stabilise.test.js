'use strict';
/**
 * VESTA stabilisation (18 Oct 2026).
 *  • All-day FAMILY events reach the wall (they are stored 'free'; only WORK
 *    'free' placeholders are hidden). Measured live: the Wednesday all-day
 *    event, hiking, a birthday and a cinema trip were all missing.
 *  • A health delivery is written in ONE transaction — per-row writes held the
 *    single-threaded backend 16–39 s per 5,000 readings on the Pi's disk.
 *  • The browser may keep the CORS preflight answer (Access-Control-Max-Age).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vesta = require('./vesta');

test('all-day family events are kept; work "free" placeholders are not', () => {
  const rows = [
    { event_id: 'apple:a:1', source: 'apple', subject: 'hiking', start_time: '2026-10-24T00:00:00', end_time: '2026-10-24T23:59:59', is_all_day: 1, show_as: 'free' },
    { event_id: 'google:x', source: 'google', subject: 'Test', start_time: '2026-10-21T00:00:00', end_time: '2026-10-22T00:00:00', is_all_day: 1, show_as: 'free', google_id: 'x' },
    { event_id: 'g1', source: 'graph', subject: 'Take a break', start_time: '2026-10-21T11:00:00', end_time: '2026-10-21T11:05:00', is_all_day: 0, show_as: 'free' },
    { event_id: 'g2', source: 'graph', subject: 'OOO marker', start_time: '2026-10-21T00:00:00', end_time: '2026-10-22T00:00:00', is_all_day: 1, show_as: 'free' },
    { event_id: 'g3', source: 'graph', subject: 'UAT Testing', start_time: '2026-10-21T09:00:00', end_time: '2026-10-21T10:00:00', is_all_day: 0, show_as: 'busy' },
  ];
  const day = vesta.redactDay(rows);
  const titles = day.map((e) => e.title);
  assert.ok(titles.includes('hiking'), 'a phone all-day event shows');
  assert.ok(titles.includes('Test'), 'a family-calendar all-day event shows');
  assert.equal(titles.filter((t) => t === 'Busy').length, 1, 'only the busy work event, as "Busy"');
  assert.ok(!titles.includes('Take a break') && !titles.includes('OOO marker'), 'work free entries stay hidden');
  // Through the week builder too: the all-day event lands on its day only (end exclusive).
  const week = vesta.redactWeek(rows, '2026-10-20', 7);
  const wed = week.find((d) => d.date === '2026-10-21');
  assert.ok(wed.events.some((e) => e.title === 'Test' && e.allDay), 'Wednesday has the all-day event');
  assert.ok(!week.find((d) => d.date === '2026-10-22').events.some((e) => e.title === 'Test'), 'not on Thursday');
  // A birthday in two phone calendars shows once.
  const twice = [1, 2].map((n) => ({ event_id: `apple:b${n}`, source: 'apple', subject: "Julie's birthday", start_time: '2026-10-25T00:00:00', end_time: '2026-10-25T23:59:59', is_all_day: 1, show_as: 'free' }));
  assert.equal(vesta.redactWeek(twice, '2026-10-20', 7).find((d) => d.date === '2026-10-25').events.length, 1);
});

test('a health delivery is one transaction (pinned) and the per-row guard stays inside it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'apple-health.js'), 'utf8');
  assert.match(src, /db\.batchSaves\(\(\) => \{ ingestRows\(\); ingestFood\(\); \}\)/, 'samples and food are written inside one batchSaves');
  const rows = src.slice(src.indexOf('const ingestRows'), src.indexOf('db.batchSaves(() => { ingestRows'));
  assert.match(rows, /catch \(e\)/, 'one bad row is still caught and cannot lose the batch');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /cors\(\{ maxAge: 600[,}]/, 'preflights may be cached');
});

test('the wall read does not re-run on every render (22 Oct 2026 storm)', () => {
  const wall = fs.readFileSync(path.join(__dirname, '..', '..', 'vesta', 'src', 'views', 'Wall.jsx'), 'utf8');
  const body = wall.slice(wall.indexOf('const refresh = useCallback'), wall.indexOf('// Coming back to the screen'));
  assert.match(body, /\}, \[screen\]\);/, 'the read depends only on screen mode');
  assert.doesNotMatch(body, /\[onSignedOut\]/, 'never on the caller\'s callback identity');
  const kiosk = fs.readFileSync(path.join(__dirname, '..', '..', 'saim', 'frontend', 'src', 'components', 'ScreenWall.jsx'), 'utf8');
  assert.match(kiosk, /onSignedOut=\{NOOP\}/, 'the kiosk hands a stable callback');
});
