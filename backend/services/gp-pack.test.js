'use strict';

// GP pack (1 Nov 2026). Real DB (calendar_cache, medical_records, health_daily
// via a gather stub for the slow picture), scratch vault.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'test.db');
const VAULT = path.join(tmp, 'vault');
fs.mkdirSync(VAULT, { recursive: true });

const db = require('../db/database');
const gp = require('./gp-pack');
const hp = require('./health-picture');

test.before(async () => { await db.init(); });

const NOW = Date.now();
const today = require('./world-model').localMinute(NOW).slice(0, 10);
const plus = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TH = { stage1: hp.BP_HOME_STAGE1, stage2: hp.BP_HOME_STAGE2 };

function event(id, subject, day, { source = 'apple', attendees = null, time = '10:20' } = {}) {
  db.run(`INSERT INTO calendar_cache (event_id, subject, start_time, end_time, is_all_day, show_as, source, attendees_other) VALUES (?, ?, ?, ?, 0, 'busy', ?, ?)`,
    [id, subject, `${day}T${time}:00`, `${day}T11:00:00`, source, attendees]);
}

test('detection: medical titles on the phone; a work-calendar entry only when positively solo; demos never', () => {
  assert.ok(gp.isAppointment({ subject: 'GP appointment', source: 'apple' }));
  assert.ok(gp.isAppointment({ subject: 'Nurse - blood test', source: 'apple' }));
  assert.ok(gp.isAppointment({ subject: 'Dr Patel', source: 'ics' }));
  assert.ok(gp.isAppointment({ subject: 'Hospital outpatients', source: 'graph', attendees_other: 0 }));
  assert.ok(!gp.isAppointment({ subject: 'GP practice demo', source: 'graph', attendees_other: 1 }), 'a work demo');
  assert.ok(!gp.isAppointment({ subject: 'GP practice demo', source: 'apple' }), 'a demo, whatever calendar');
  assert.ok(!gp.isAppointment({ subject: 'GP appointment', source: 'graph', attendees_other: 1 }), 'a work meeting with people in it');
  assert.ok(!gp.isAppointment({ subject: 'GP appointment', source: 'graph', attendees_other: null }), 'cannot tell = not guessed');
  assert.ok(!gp.isAppointment({ subject: 'Clinic software webinar', source: 'apple' }));
  assert.ok(!gp.isAppointment({ subject: 'Team standup', source: 'apple' }));
  assert.ok(!gp.isAppointment({ subject: 'GP appointment', source: 'apple', show_as: 'cancelled' }));
  // Someone else's appointment on the family diary (live, 5 Sep 2026).
  assert.ok(!gp.isAppointment({ subject: 'Helen hospital', source: 'apple' }));
  assert.ok(!gp.isAppointment({ subject: "Isaac's dentist", source: 'apple' }));
  assert.ok(gp.isAppointment({ subject: 'Nurse appointment', source: 'apple' }));
});

const days = Array.from({ length: 100 }, (_, i) => ({ day: plus(-i), complete: true, bpSystolic: i < 30 ? 142 : 128, bpDiastolic: i < 30 ? 90 : 80, weightKg: i === 1 ? 96 : i === 85 ? 92 : null, rhrMedian: i < 30 ? 76 : 72 }));
const medical = {
  tests: [{ name: 'HbA1c', date: plus(-40), value: '41', unit: 'mmol/mol', referenceRange: '20-41', flag: 'high' }],
  diagnoses: [{ name: 'Essential hypertension', date: '2026-07' }],
  prescriptions: [{ name: 'Amlodipine', dose: '5mg', directions: 'one a day', status: 'active' }],
};
const picture = { insights: [{ level: 'act', title: 'Blood pressure is averaging 142/90', finding: 'Your 14-day home average from HiLo is 142/90.' }, { level: 'good', title: 'Fine', finding: 'x' }] };

test('the page: averages against NICE, records transcribed, blanks to fill — and never a diagnosis', () => {
  const md = gp.compose({ appointment: { title: 'GP appointment', date: plus(2), time: '10:20' }, today, days, medical, picture, unread: [], thresholds: TH });
  assert.match(md, /Last 30 days: average 142\/90 mmHg over 31 days.*at or above the 135\/85 home threshold NICE uses/);
  assert.match(md, /Last 90 days: average 13\d\/8\d mmHg/);
  assert.match(md, /HbA1c 41 mmol\/mol \(range 20-41\) — marked high on the record/);
  assert.match(md, /Essential hypertension/);
  assert.match(md, /Amlodipine 5mg — one a day \(active\)/);
  assert.match(md, /Weight: 96 kg/);
  assert.match(md, /Blood pressure is averaging 142\/90/);
  assert.doesNotMatch(md, /- Fine\./, 'only act/watch flags');
  assert.match(md, /## Questions to ask\n\n- \[question 1\]/);
  assert.doesNotMatch(md, hp.DIAGNOSIS_CLAIM);
  // The worst case still says no condition is present.
  const all = gp.compose({ appointment: { title: 'GP', date: plus(1) }, today, days: days.map((d) => ({ ...d, bpSystolic: 180, bpDiastolic: 110 })), medical, picture, unread: [], thresholds: TH });
  assert.doesNotMatch(all, hp.DIAGNOSIS_CLAIM);
  assert.doesNotMatch(all, /\byou have\b|\bsuffer/i);
});

test('an unread source says so in its section', () => {
  const md = gp.compose({ appointment: { title: 'GP', date: plus(1) }, today, days: [], medical: null, picture: null, unread: ['health', 'medical', 'picture'], thresholds: TH });
  assert.match(md, /Could not read the health record/);
  assert.match(md, /Could not read medical records/);
  assert.match(md, /My Health could not be read/);
});

test('run: two days before writes ONE new note; a third day out and a work demo do not; never overwrites', () => {
  event('e1', 'GP appointment', plus(2));
  event('e2', 'GP appointment follow-up', plus(5));
  event('e3', 'GP practice demo', plus(1), { source: 'graph', attendees: 1 });
  const gather = () => ({ days, medical, picture, unread: [] });
  // A file already at the name: kept, and the pack goes beside it.
  const dir = path.join(VAULT, 'Personal', 'Health', 'GP visits');
  fs.mkdirSync(dir, { recursive: true });
  const taken = path.join(dir, `${plus(2)} – GP appointment.md`);
  fs.writeFileSync(taken, 'Nick wrote this');
  const r = gp.run({ now: NOW, root: VAULT, gather });
  assert.strictEqual(r.written.length, 1, JSON.stringify(r));
  assert.strictEqual(r.written[0].path, `Personal/Health/GP visits/${plus(2)} – GP appointment (2).md`);
  assert.strictEqual(fs.readFileSync(taken, 'utf8'), 'Nick wrote this');
  assert.strictEqual(gp.run({ now: NOW, root: VAULT, gather }).written.length, 0, 'once per appointment');
  const ready = gp.ready({ now: NOW });
  assert.strictEqual(ready.length, 1);
  assert.match(ready[0].line, /^GP pack ready for /);
  assert.ok(db.get("SELECT 1 FROM personal_ops_events WHERE kind = 'gp-pack-written'"));
});

test('an unreachable vault writes nothing', () => {
  const r = gp.run({ now: NOW, root: path.join(tmp, 'nope') });
  assert.strictEqual(r.ok, false);
});
