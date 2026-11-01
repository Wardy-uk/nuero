'use strict';

/**
 * GP pack (1 Nov 2026).
 *
 * Two days before a GP / doctor / hospital / clinic / nurse appointment, NEURO
 * writes ONE page into the vault for Nick to take with him:
 *   Personal/Health/GP visits/<date> – <title>.md   (a NEW note, never an overwrite)
 * It carries what NEURO holds, TRANSCRIBED: HiLo blood-pressure averages over 30
 * and 90 days against the NICE home thresholds health-picture already uses, recent
 * test results, diagnoses and prescriptions from medical records, weight and
 * resting-heart-rate trends, what My Health flags, and "Questions to ask" with
 * blanks. It never diagnoses (pinned by health-picture's DIAGNOSIS_CLAIM rule).
 *
 * Which events count — title rules, and never a guess on work:
 *   • the title names a GP, doctor, hospital, clinic, nurse, surgery appointment,
 *     blood test, outpatient, consultant, physio, dentist… and NOT a demo,
 *     webinar, training, call with a customer…
 *   • a phone (apple / ics) entry counts; a work-calendar (graph) entry counts
 *     ONLY when it is positively a solo block (attendees_other = 0). A work
 *     meeting with other people — or one NEURO cannot tell — never does.
 * Offered on Now ("GP pack ready for Thursday") until the appointment has passed.
 */

const path = require('path');
const fs = require('fs');

const LEDGER_KEY = 'gp_pack_ledger';
const LEAD_DAYS = 2;
const FOLDER = 'Personal/Health/GP visits';

const MEDICAL = /\b(gp|g\.p\.|doctors?|doctor's|dr\.? [a-z]+|hospital|clinic|nurse|surgery appointment|medical appointment|blood tests?|outpatients?|consultant|physio(therapy)?|dentist|dental|optician|eye test|health ?check|vaccin\w*|jab|smear|ecg|x-?ray|scan appointment)\b/i;
const NOT_MEDICAL = /\b(demo|webinar|training|onboarding|customer|client|prospect|sales|pitch|presentation|practice management|software|crm|integration|stand-?up|sprint)\b/i;

function _db() { return require('../db/database'); }
function _json(key, d) { try { const v = JSON.parse(_db().getState(key) || 'null'); return v == null ? d : v; } catch { return d; } }
function _utc(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
function daysBetween(a, b) { return Math.round((_utc(b) - _utc(a)) / 86400000); }
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayName(d) { return DAY[new Date(_utc(d)).getUTCDay()]; }

// A title that STARTS with someone's name is their appointment on the family
// diary, not Nick's ("Helen hospital" was on the phone on 5 Sep 2026). A leading
// capitalised word is allowed only when it is one of these; anything else that
// looks like a name means "not his" — a missed pack is cheaper than Nick's
// records written up for someone else's appointment.
const OPENING_WORDS = new Set(['gp', 'doctor', 'doctors', "doctor's", 'dr', 'hospital', 'clinic', 'nurse', 'surgery', 'blood', 'outpatient', 'outpatients',
  'consultant', 'physio', 'physiotherapy', 'dentist', 'dental', 'optician', 'opticians', 'eye', 'health', 'vaccine', 'vaccination', 'flu', 'covid', 'jab',
  'smear', 'ecg', 'x-ray', 'xray', 'scan', 'annual', 'my', 'nick', "nick's", 'appointment', 'medical', 'follow-up', 'follow', 'check', 'review', 'bp', 'new',
  'the', 'a', 'telephone', 'phone', 'video', 'online', 'gp:', 'nhs', 'practice', 'routine']);

function namesSomeoneElse(title) {
  const first = String(title || '').trim().split(/\s+/)[0] || '';
  if (!/^[A-Z][a-z]+(?:'s)?:?$/.test(first)) return false;
  return !OPENING_WORDS.has(first.toLowerCase().replace(/:$/, ''));
}

/** PURE. Is this calendar row a medical appointment NEURO may prepare for? */
function isAppointment(ev) {
  const t = String((ev && ev.subject) || '').trim();
  if (!t || !MEDICAL.test(t) || NOT_MEDICAL.test(t)) return false;
  if (namesSomeoneElse(t)) return false;
  if (ev.show_as === 'cancelled') return false;
  const source = ev.source || 'graph';
  if (source === 'graph') return ev.attendees_other === 0; // a work-calendar entry only when positively solo
  return source === 'apple' || source === 'ics';
}

function round(n, dp = 0) { const f = 10 ** dp; return Math.round(n * f) / f; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/** PURE. Mean BP over the last `span` days (complete days with a reading). */
function bpWindow(days, today, span) {
  const rows = days.filter((d) => d.complete && Number.isFinite(d.bpSystolic) && Number.isFinite(d.bpDiastolic)
    && daysBetween(d.day, today) >= 0 && daysBetween(d.day, today) <= span);
  if (!rows.length) return { span, days: 0, sys: null, dia: null };
  return { span, days: rows.length, sys: round(mean(rows.map((d) => d.bpSystolic))), dia: round(mean(rows.map((d) => d.bpDiastolic))) };
}

function _bpLine(w, stage1, stage2) {
  if (!w.days) return `- Last ${w.span} days: no HiLo readings.`;
  const vs = (w.sys >= stage2.sys || w.dia >= stage2.dia) ? `at or above the ${stage2.sys}/${stage2.dia} home threshold NICE uses for stage 2`
    : (w.sys >= stage1.sys || w.dia >= stage1.dia) ? `at or above the ${stage1.sys}/${stage1.dia} home threshold NICE uses`
      : `under the ${stage1.sys}/${stage1.dia} home threshold NICE uses`;
  return `- Last ${w.span} days: average ${w.sys}/${w.dia} mmHg over ${w.days} day${w.days === 1 ? '' : 's'} with a reading — ${vs}.`;
}

function _rec(r) {
  const bits = [r.name];
  if (r.value) bits.push(`${r.value}${r.unit ? ` ${r.unit}` : ''}`);
  if (r.referenceRange) bits.push(`(range ${r.referenceRange})`);
  if (r.flag) bits.push(`— marked ${r.flag} on the record`);
  return `- ${r.date || 'undated'}: ${bits.join(' ')}`;
}

/**
 * PURE. The page. Inputs are already read; anything that could not be read is
 * named in `unread` and its section says so.
 */
function compose({ appointment, today, days = [], medical = null, picture = null, unread = [], thresholds }) {
  const { stage1, stage2 } = thresholds;
  const L = [];
  const when = `${dayName(appointment.date)} ${appointment.date}${appointment.time ? ` at ${appointment.time}` : ''}`;
  L.push('---', 'type: gp-pack', `appointment: "${appointment.title.replace(/"/g, "'")}"`, `appointment_date: ${appointment.date}`, 'created_by: neuro', `created: ${today}`, '---', '');
  L.push(`# ${appointment.title} — ${when}`, '');
  L.push('Prepared by NEURO from your own records two days before the appointment. It copies down what the records hold. It is not advice and it is not a diagnosis.', '');

  L.push('## Blood pressure (HiLo, home readings)', '');
  if (unread.includes('health')) L.push('- Could not read the health record, so no averages are shown.');
  else { L.push(_bpLine(bpWindow(days, today, 30), stage1, stage2)); L.push(_bpLine(bpWindow(days, today, 90), stage1, stage2)); }
  L.push('');

  L.push('## Weight and resting heart rate', '');
  if (unread.includes('health')) L.push('- Could not read the health record.');
  else {
    const w = days.filter((d) => Number.isFinite(d.weightKg)).sort((a, b) => a.day.localeCompare(b.day));
    const latestW = w[w.length - 1];
    const oldW = w.filter((d) => daysBetween(d.day, today) >= 80).pop();
    L.push(latestW ? `- Weight: ${round(latestW.weightKg, 1)} kg on ${latestW.day}${oldW ? ` (${round(oldW.weightKg, 1)} kg on ${oldW.day})` : ''}.` : '- Weight: no reading recorded.');
    const rhr30 = median(days.filter((d) => Number.isFinite(d.rhrMedian) && daysBetween(d.day, today) <= 30 && daysBetween(d.day, today) >= 0).map((d) => d.rhrMedian));
    const rhrPrior = median(days.filter((d) => Number.isFinite(d.rhrMedian) && daysBetween(d.day, today) > 30 && daysBetween(d.day, today) <= 120).map((d) => d.rhrMedian));
    L.push(rhr30 != null ? `- Resting heart rate: ${round(rhr30)} bpm (median, last 30 days)${rhrPrior != null ? `; ${round(rhrPrior)} bpm the 90 days before` : ''}.` : '- Resting heart rate: no readings.');
  }
  L.push('');

  const section = (title, list, empty) => {
    L.push(`## ${title}`, '');
    if (unread.includes('medical')) L.push('- Could not read medical records.');
    else if (!list.length) L.push(`- ${empty}`);
    else for (const r of list) L.push(r);
    L.push('');
  };
  const recs = medical || { tests: [], diagnoses: [], prescriptions: [] };
  section('Recent test results (from your records, last 12 months)', recs.tests.map(_rec), 'None recorded in NEURO for the last 12 months.');
  section('Conditions on your record', recs.diagnoses.map((r) => `- ${r.name}${r.date ? ` (recorded ${r.date})` : ''}${r.status ? ` — ${r.status}` : ''}`), 'None recorded in NEURO.');
  section('Prescriptions on your record', recs.prescriptions.map((r) => `- ${r.name}${r.dose ? ` ${r.dose}` : ''}${r.directions ? ` — ${r.directions}` : ''}${r.status ? ` (${r.status})` : ''}${r.date ? `, ${r.date}` : ''}`), 'None recorded in NEURO.');

  L.push('## What My Health flags', '');
  if (unread.includes('picture') || !picture) L.push('- My Health could not be read.');
  else {
    const flagged = (picture.insights || []).filter((i) => i.level === 'act' || i.level === 'watch');
    if (!flagged.length) L.push('- Nothing to act on or watch.');
    for (const i of flagged) L.push(`- ${i.title}. ${i.finding || ''}`.trim());
  }
  L.push('');

  L.push('## Questions to ask', '');
  L.push('- [question 1]', '- [question 2]', '- [question 3]', '');
  L.push('## What they said', '', '- [notes]', '');
  return L.join('\n');
}

function safeTitle(t) { return String(t || 'Appointment').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Appointment'; }

// ── impure ──────────────────────────────────────────────────────────────────

function _upcoming({ today, days = 7 }) {
  const rows = _db().all(`SELECT event_id, subject, start_time, end_time, is_all_day, show_as, source, attendees_other FROM calendar_cache
    WHERE substr(start_time, 1, 10) >= ? ORDER BY start_time`, [today]);
  return rows.filter((r) => isAppointment(r) && daysBetween(today, r.start_time.slice(0, 10)) <= days)
    .map((r) => ({ eventId: r.event_id, title: String(r.subject).trim(), date: r.start_time.slice(0, 10), time: r.is_all_day ? null : r.start_time.slice(11, 16) }));
}

function _key(a) { return `${a.date}|${String(a.title).toLowerCase()}`; }

function _gather({ now }) {
  const unread = [];
  let days = [];
  try { days = require('./health-daily').recentDays(130); } catch { unread.push('health'); }
  let medical = null;
  try {
    const mr = require('./medical-records');
    const from = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);
    medical = {
      tests: mr.list({ kind: 'test_result', from, limit: 30 }).records,
      diagnoses: mr.list({ kind: 'diagnosis', limit: 50 }).records,
      prescriptions: mr.list({ kind: 'prescription', limit: 50 }).records,
    };
  } catch { unread.push('medical'); }
  let picture = null;
  try { picture = require('./health-picture').read({ now }); } catch { unread.push('picture'); }
  return { days, medical, picture, unread };
}

/** One pass: write the pack for any appointment 0–2 days away that does not have one. */
function run({ now = Date.now(), root = process.env.OBSIDIAN_VAULT_PATH, gather = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const today = require('./world-model').localMinute(nowMs).slice(0, 10);
  if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) return { ok: false, error: 'the vault is not reachable — no pack written' };
  const ledger = _json(LEDGER_KEY, {});
  const written = [];
  let inputs = null;
  for (const a of _upcoming({ today, days: LEAD_DAYS })) {
    const key = _key(a);
    if (ledger[key]) continue;
    inputs = inputs || (gather || _gather)({ now: new Date(nowMs) });
    const hp = require('./health-picture');
    const md = compose({ appointment: a, today, ...inputs, thresholds: { stage1: hp.BP_HOME_STAGE1, stage2: hp.BP_HOME_STAGE2 } });
    const dir = path.join(root, ...FOLDER.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const base = `${a.date} – ${safeTitle(a.title)}`;
    let rel = null;
    for (let i = 1; i <= 9 && !rel; i += 1) {
      const name = i === 1 ? `${base}.md` : `${base} (${i}).md`;
      try { fs.writeFileSync(path.join(dir, name), md, { encoding: 'utf8', flag: 'wx' }); rel = `${FOLDER}/${name}`; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!rel) continue;
    ledger[key] = { path: rel, date: a.date, time: a.time, title: a.title, at: new Date(nowMs).toISOString() };
    _db().setState(LEDGER_KEY, JSON.stringify(ledger));
    try { require('./personal-obligations').logEvent('gp-pack-written', { subjectId: `appointment:${a.date}`, detail: { title: a.title, date: a.date, path: rel }, dedupeKey: `gp-pack-written:${key}`, now: nowMs }); } catch { /* record only */ }
    written.push(ledger[key]);
  }
  return { ok: true, written };
}

/** The packs for appointments still to come — what Now offers. Reads only the ledger. */
function ready({ now = Date.now() } = {}) {
  const today = require('./world-model').localMinute(now instanceof Date ? now.getTime() : now).slice(0, 10);
  return Object.values(_json(LEDGER_KEY, {})).filter((p) => p.date >= today).sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({ ...p, dayName: dayName(p.date), line: `GP pack ready for ${p.date === today ? 'today' : dayName(p.date)}` }));
}

module.exports = { run, ready, compose, isAppointment, namesSomeoneElse, bpWindow, safeTitle, LEDGER_KEY, FOLDER, LEAD_DAYS, MEDICAL, NOT_MEDICAL };
