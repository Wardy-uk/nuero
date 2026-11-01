'use strict';

// Team cover (1 Nov 2026). The roster/absence fixtures are copied from the live
// `agent_state.team_availability` blob (NOVA /api/neuro-bridge/availability,
// read 1 Nov 2026) — same keys, same pool ids, same status words. Pure rules
// are pinned with fixed dates; the push memory runs against a REAL scratch DB
// and a temp vault, with dates derived from the clock.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cover-'));
process.env.NEURO_DB_PATH = path.join(root, 'test.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
process.env.NOVA_AGENT_ID = '24';

const db = require('../db/database');
const tc = require('./team-cover');

test.before(async () => { await db.init(); });

// ── live-shaped fixture ─────────────────────────────────────────────────────
const ROSTER = [
  { rosterId: 6, name: 'Abdi Mohamed', pool: 'support', syncable: true },
  { rosterId: 8, name: 'Heidi Power', pool: 'customercare', syncable: true },
  { rosterId: 27, name: 'Hope Goodall', pool: 'customercare', syncable: true },
  { rosterId: 9, name: 'Isabel Busk', pool: 'digitaldesign', syncable: true },
  { rosterId: 18, name: 'Jerson Arokianathan', pool: 'tpj', syncable: true },
  { rosterId: 10, name: 'Kayleigh Russell', pool: 'digitaldesign', syncable: true },
  { rosterId: 20, name: 'Kieran Eccles', pool: 'tpj', syncable: true },
  { rosterId: 23, name: 'Lucy Read', pool: 'tpj', syncable: false },
  { rosterId: 11, name: 'Luke Scaife', pool: 'support', syncable: true },
  { rosterId: 31, name: 'Maria Pappa', pool: 'customercare', syncable: true },
  { rosterId: 12, name: 'Naomi Wentworth', pool: 'customercare', syncable: true },
  { rosterId: 13, name: 'Nathan Rutland', pool: 'customercare', syncable: true },
  { rosterId: 24, name: 'Nick Ward', pool: 'support', syncable: true },
  { rosterId: 21, name: 'Nicki Wilson', pool: 'tpj', syncable: true },
  { rosterId: 14, name: 'Sebastian Broome', pool: 'support', syncable: true },
  { rosterId: 15, name: 'Stephen Mitchell', pool: 'support', syncable: true },
  { rosterId: 25, name: 'Zoe Rees', pool: 'customercare', syncable: true },
];
const REPORTS = ['Abdi Mohamed', 'Heidi Power', 'Hope Goodall', 'Isabel Busk', 'Kayleigh Russell', 'Luke Scaife',
  'Maria Pappa', 'Naomi Wentworth', 'Nathan Rutland', 'Sebastian Broome', 'Stephen Mitchell', 'Zoe Rees',
  'Adele Norman-Swift'].map(name => ({ name }));
const byName = Object.fromEntries(ROSTER.map(r => [r.name, r]));
const off = (name, date, status = 'annual_leave') => ({ rosterId: byName[name].rosterId, name, date, status, reason: 'Annual Leave', setBy: 'peoplehr' });
const snapOf = (absences, extra = {}) => ({ known: true, stale: false, ageHours: 0.2, fetchedAt: '2026-11-01T17:00:06.360Z',
  from: '2026-11-01', to: '2027-01-30', rosterCount: ROSTER.length, roster: ROSTER, absences, ...extra });
const isSelf = (r) => r.rosterId === 24;
const NOW = new Date(2026, 10, 1, 18, 0); // Sun 1 Nov 2026
const run = (absences, opts = {}) => tc.assess({ snap: snapOf(absences, opts.snap), reports: opts.reports ?? REPORTS, holidays: opts.holidays ?? new Set(), now: opts.now ?? NOW, isSelf });

// ── pure rules ──────────────────────────────────────────────────────────────

test('threshold: 2 off flags; 40% flags; 1 of 6 does not', () => {
  assert.equal(tc.isThin(1, 6), false);           // 17%
  assert.equal(tc.isThin(2, 6), true);            // count rule, 33%
  assert.equal(tc.isThin(2, 10), true);           // count rule, 20%
  assert.equal(tc.isThin(1, 2), true);            // share rule, 50%
  assert.equal(tc.isThin(2, 5), true);            // both
  assert.equal(tc.isThin(1, 3), false);           // 33% < 40
  assert.equal(tc.isThin(0, 2), false);
  assert.equal(tc.isThin(1, 0), false);
});

test('the live 1 Nov shape: Naomi and Zoe off 3–6 Nov is ONE Customer Care clash; Zoe alone on the 2nd is not', () => {
  const absences = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(d => off('Zoe Rees', d))
    .concat(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map(d => off('Naomi Wentworth', d)));
  const r = run(absences);
  assert.equal(r.known, true);
  const cc = r.clashes.filter(c => c.pool === 'customercare');
  assert.equal(cc.length, 1);
  assert.equal(cc[0].from, '2026-11-03');
  assert.equal(cc[0].to, '2026-11-06');
  assert.equal(cc[0].title, 'Cover is thin: Customer Care — Naomi and Zoe off 3–6 Nov');
  assert.match(cc[0].say, /2 of 6 off \(33%\) on Tue 3 Nov/);
  assert.equal(cc[0].action, 'Check cover for Customer Care on 3–6 Nov');
  assert.deepEqual(cc[0].people.sort(), ['Naomi Wentworth', 'Zoe Rees']);
});

test('Digital Design is ignored (Nick, 1 Nov 2026): both of them off is no clash', () => {
  const r = run(['2026-11-10', '2026-11-11'].flatMap(d => [off('Isabel Busk', d), off('Kayleigh Russell', d)]));
  assert.equal(r.clashes.filter(c => c.pool === 'digitaldesign').length, 0);
  assert.ok(!(r.teams || []).some(t => t.pool === 'digitaldesign'));
});

test('merge: a weekend between flagged days does not split; a working-day gap does', () => {
  // Fri 6 + Mon 9 Nov flagged → one clash; Wed 11 flagged after a clear Tue 10 → second clash.
  const days = ['2026-11-06', '2026-11-09', '2026-11-11'];
  const absences = days.flatMap(d => [off('Abdi Mohamed', d), off('Luke Scaife', d)]);
  const t2 = run(absences).clashes.filter(c => c.pool === 'support');
  assert.equal(t2.length, 2);
  assert.equal(t2[0].from, '2026-11-06');
  assert.equal(t2[0].to, '2026-11-09');
  assert.equal(t2[1].from, '2026-11-11');
  assert.equal(t2[1].to, '2026-11-11');
});

test('merge: a bank holiday between flagged days does not split the clash', () => {
  const absences = ['2026-12-24', '2026-12-29'].flatMap(d => [off('Heidi Power', d), off('Hope Goodall', d)]);
  const holidays = new Set(['2026-12-25', '2026-12-28']);
  const cc = run(absences, { holidays }).clashes.filter(c => c.pool === 'customercare');
  // Window from 1 Nov reaches 27 Dec, so only the 24th is inside it…
  assert.equal(cc.length, 1);
  assert.equal(cc[0].from, '2026-12-24');
  // …and from 20 Dec both are, joined across Fri 25 / Mon 28.
  const later = run(absences, { holidays, now: new Date(2026, 11, 20, 9) }).clashes.filter(c => c.pool === 'customercare');
  assert.equal(later.length, 1);
  assert.equal(later[0].to, '2026-12-29');
});

test('Nick counts in Tier 2 (his own pool) and nowhere else', () => {
  const r = run([off('Nick Ward', '2026-11-03'), off('Luke Scaife', '2026-11-03')]);
  const t2 = r.clashes.find(c => c.pool === 'support');
  assert.ok(t2, 'Nick + Luke off is 2 of 5 in Tier 2');
  assert.equal(t2.includesYou, true);
  assert.equal(r.teams.find(t => t.pool === 'support').size, 5);
  assert.equal(r.teams.find(t => t.pool === 'customercare').members.includes('Nick Ward'), false);
});

test('TPJ (no direct reports) is not judged; a direct report missing from NOVA is a named gap', () => {
  const r = run(['2026-11-03'].flatMap(d => [off('Jerson Arokianathan', d), off('Kieran Eccles', d)]));
  assert.equal(r.clashes.length, 0);
  assert.equal(r.teams.some(t => t.pool === 'tpj'), false);
  assert.ok(r.gaps.some(g => /Adele Norman-Swift is not in NOVA's roster/.test(g)));
});

test('an unsynced member in a judged pool is a named gap and marks the team incomplete', () => {
  const roster = ROSTER.map(r => r.name === 'Maria Pappa' ? { ...r, syncable: false } : r);
  const r = tc.assess({ snap: snapOf([], { roster }), reports: REPORTS, now: NOW, isSelf });
  assert.ok(r.gaps.some(g => /Maria Pappa \(Customer Care\) has no People HR id/.test(g)));
  assert.equal(r.teams.find(t => t.pool === 'customercare').incomplete, true);
});

test('unread leave is known:false with a reason, never "no clashes"', () => {
  const r = tc.assess({ snap: { known: false, reason: 'never fetched' }, reports: REPORTS, now: NOW, isSelf });
  assert.equal(r.known, false);
  assert.equal(r.clashes.length, 0);
  assert.ok(r.gaps.some(g => /not "no clashes"/.test(g)));
  const empty = tc.assess({ snap: snapOf([], { rosterCount: 0, roster: [] }), reports: REPORTS, now: NOW, isSelf });
  assert.equal(empty.known, false);
});

test('unreadable People notes: every pool is checked and that is said', () => {
  const r = run([], { reports: [] });
  assert.ok(r.gaps.some(g => /cannot tell which queues are yours/.test(g)));
  assert.ok(r.teams.some(t => t.pool === 'tpj'));
});

test('a feed that stops before the 8-week window ends is a named gap', () => {
  const r = run([], { snap: { to: '2026-11-20' } });
  assert.ok(r.gaps.some(g => /stops at 2026-11-20/.test(g)));
  assert.equal(r.to, '2026-11-20');
});

test('range labels', () => {
  assert.equal(tc.rangeLabel('2026-11-12', '2026-11-13'), '12–13 Nov');
  assert.equal(tc.rangeLabel('2026-11-12', '2026-11-12'), '12 Nov');
  assert.equal(tc.rangeLabel('2026-11-30', '2026-12-02'), '30 Nov – 2 Dec');
});

test('resolves itself: when the overlap disappears so does the clash', () => {
  const both = [off('Naomi Wentworth', '2026-11-12'), off('Zoe Rees', '2026-11-12')];
  assert.equal(run(both).clashes.length, 1);
  assert.equal(run(both.slice(0, 1)).clashes.length, 0);
});

// ── push memory, real DB ────────────────────────────────────────────────────

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// Working days, bank holidays included, so the fixture cannot land on Christmas.
function nextWeekday(from, n) { const hol = require('./working-days').holidaySet(); const d = new Date(from); let k = 0; while (k < n) { d.setDate(d.getDate() + 1); if (d.getDay() > 0 && d.getDay() < 6 && !hol.has(ymd(d))) k++; } return ymd(d); }

test('push: first run is a silent baseline; a NEW near clash pushes once; a grown clash does not re-push', async () => {
  fs.mkdirSync(path.join(root, 'vault', 'People'), { recursive: true });
  for (const n of ['Naomi Wentworth', 'Zoe Rees', 'Heidi Power', 'Abdi Mohamed', 'Luke Scaife']) {
    const line = ['Abdi Mohamed', 'Luke Scaife'].includes(n) ? '2nd Line' : '1st Line';
    fs.writeFileSync(path.join(root, 'vault', 'People', `${n}.md`), `---\nteam: Support\nline: ${line}\ndirect-report: true\n---\n`);
  }
  const now = new Date();
  const d1 = nextWeekday(now, 3);
  const d2 = nextWeekday(now, 4);
  const d3 = nextWeekday(now, 5);
  const set = (abs) => db.setState('team_availability', JSON.stringify({ ...snapOf(abs), fetchedAt: new Date().toISOString(), from: ymd(now), to: nextWeekday(now, 80) }));
  const pushes = [];
  const deps = { push: async (t, b, d) => { pushes.push({ t, b, d }); } };

  set([off('Naomi Wentworth', d1), off('Zoe Rees', d1)]);
  const first = await tc.check({ now, deps });
  assert.equal(first.ok, true);
  assert.equal(first.clashes, 1);
  assert.equal(pushes.length, 0, 'baseline: an existing clash is remembered, not announced');

  set([off('Naomi Wentworth', d1), off('Zoe Rees', d1), off('Abdi Mohamed', d2), off('Luke Scaife', d2)]);
  await tc.check({ now, deps });
  assert.equal(pushes.length, 1, 'the new Tier 2 clash pushes');
  assert.equal(pushes[0].d.type, 'team_cover');
  assert.match(pushes[0].t, /^Cover is thin: Tier 2 — Abdi and Luke off/);

  await tc.check({ now, deps });
  assert.equal(pushes.length, 1, 'once per clash');

  set([off('Naomi Wentworth', d1), off('Zoe Rees', d1), off('Abdi Mohamed', d2), off('Luke Scaife', d2), off('Abdi Mohamed', d3), off('Luke Scaife', d3)]);
  await tc.check({ now, deps });
  assert.equal(pushes.length, 1, 'a clash that grows by a day is the same clash');

  // …and then loses its FIRST day: still the same clash, no second push.
  set([off('Naomi Wentworth', d1), off('Zoe Rees', d1), off('Abdi Mohamed', d3), off('Luke Scaife', d3)]);
  await tc.check({ now, deps });
  assert.equal(pushes.length, 1, 'a clash whose start moves is the same clash');
});

test('push: a clash beyond 14 days is not pushed', () => {
  const clashes = [{ pool: 'support', startsInDays: 20, days: [{ date: '2026-11-21' }] }];
  const p = tc.planPush(clashes, { baselined: true, seen: [] }, '2026-11-01');
  assert.equal(p.push.length, 0);
});

test('push: unknown leave pushes nothing and changes no memory', async () => {
  db.setState('team_cover_pushed', JSON.stringify({ baselined: true, seen: [] }));
  db.setState('team_availability', '');
  const pushes = [];
  const r = await tc.check({ deps: { push: async () => pushes.push(1) } });
  assert.equal(r.ok, false);
  assert.equal(pushes.length, 0);
  assert.equal(db.getState('team_cover_pushed'), JSON.stringify({ baselined: true, seen: [] }));
});
