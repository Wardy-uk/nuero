'use strict';

/**
 * UAT volunteers — the PURE half (26 Oct 2026).
 *
 * Dan Short emails Nick each week asking team leads to put someone forward for
 * the Wednesday UAT. Nick's design (asked one question at a time):
 *   - NEURO checks the email really asks for volunteers, never on keywords alone;
 *   - picks one from Tier 2 / Digital Design and one from Customer Care: off on
 *     the day = out, then least recently put forward, ties alphabetical;
 *   - the rota starts from zero, everyone on those teams is in (leads too), and
 *     being PUT FORWARD counts as a turn — a decline does not;
 *   - each person is asked to confirm or decline; no answer by the window's
 *     close counts as yes;
 *   - Dan's reply is ready once both have confirmed, or when the window closes;
 *   - every send waits for Nick's one press.
 *
 * Nothing here reads a database, the network or the clock. The store is
 * uat-volunteers.js.
 */

const { isWorkingDay, nextWorkingDay } = require('../../shared/working-days.cjs');
const score = require('./promise-score');

const POOLS = Object.freeze([
  Object.freeze({ id: 'tier2dd', label: 'Tier 2 / Digital Design', groups: Object.freeze(['2nd Line Technical Support', 'Digital Design']) }),
  Object.freeze({ id: 'cc', label: 'Customer Care', groups: Object.freeze(['1st Line Customer Care']) }),
]);

// The window closes at 17:30 London. Invites sent from 15:00 get until the next
// working day, so nobody is asked at 16:45 to answer by 17:30.
const CLOSE_HHMM = '17:30';
const LATE_SEND_HHMM = '15:00';

const SUBJECT_RE = /\bUAT\b/i;
const REQUEST_RE = /\bvolunteer|\bUAT\s+request\b|\baction\s+required\b/i;

/**
 * Is this triage entry worth a model call? Cheap and deliberately loose: the
 * model decides whether it actually asks for volunteers. Nick's own sent mail
 * is never looked at. ⚠ A DISMISSED email still counts: marking Dan's request
 * Done in the Inbox is not the same as having put people forward.
 */
function quickMatch(entry, selfAddress = null) {
  if (!entry) return false;
  const subject = String(entry.subject || '');
  if (!SUBJECT_RE.test(subject)) return false;
  const from = String(entry.fromEmail || '').toLowerCase();
  if (selfAddress && from === String(selfAddress).toLowerCase()) return false;
  return REQUEST_RE.test(`${subject}\n${entry.preview || ''}`);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function _validDate(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The model's answer, checked. Returns { ok:true, request } or { ok:false, why }.
 * A missing or impossible field REFUSES — the invite would carry it to two
 * people, so a guess is worse than asking Nick.
 */
function parseExtraction(text, { todayKey = null } = {}) {
  let raw = String(text || '').trim();
  const fence = raw.match(/\{[\s\S]*\}/);
  if (!fence) return { ok: false, why: 'the model gave no JSON' };
  let j;
  try { j = JSON.parse(fence[0]); } catch { return { ok: false, why: 'the model gave unreadable JSON' }; }
  if (typeof j.asksForVolunteers !== 'boolean') return { ok: false, why: 'the model did not say whether volunteers are asked for' };
  if (!j.asksForVolunteers) return { ok: true, request: { asksForVolunteers: false } };
  if (!_validDate(j.date)) return { ok: false, why: 'no readable session date' };
  if (todayKey && j.date < todayKey) return { ok: false, why: `the session date ${j.date} has already passed` };
  if (!TIME_RE.test(String(j.start || ''))) return { ok: false, why: 'no readable start time' };
  const end = TIME_RE.test(String(j.end || '')) ? j.end : null;
  if (end && end <= j.start) return { ok: false, why: 'the end time is before the start time' };
  const clip = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null);
  return {
    ok: true,
    request: {
      asksForVolunteers: true,
      feature: clip(j.feature, 160),
      date: j.date,
      start: j.start,
      end,
      location: clip(j.location, 160),
      online: clip(j.online, 160),
    },
  };
}

function extractionPrompt(email) {
  return [
    'Read this email and answer in JSON only. Do not guess: use null for anything the email does not state.',
    '{',
    '  "asksForVolunteers": true|false,   // does it ask the reader to put forward / volunteer people for a UAT session?',
    '  "feature": string|null,            // what is being tested, in a few words',
    '  "date": "YYYY-MM-DD"|null,         // the session date',
    '  "start": "HH:MM"|null,             // UK time, 24h',
    '  "end": "HH:MM"|null,',
    '  "location": string|null,           // the room / office',
    '  "online": string|null              // how remote people join, if stated (e.g. "Teams meeting")',
    '}',
    'A thank-you, a recap, or feedback on an earlier session is asksForVolunteers=false.',
    `Today is ${email.todayKey}. The email was received ${email.received || 'recently'}.`,
    '',
    `From: ${email.from || ''} <${email.fromEmail || ''}>`,
    `Subject: ${email.subject || ''}`,
    '',
    String(email.body || '').slice(0, 6000),
  ].join('\n');
}

/** People in a pool, from the roster rows (team-roster.readPeople shape). */
function poolMembers(poolId, people) {
  const pool = POOLS.find((p) => p.id === poolId);
  if (!pool) return [];
  return (people || [])
    .filter((p) => p && !p.archived && p.directReport && pool.groups.includes(p.group))
    .map((p) => ({ name: p.name, email: String(p.email || '').trim().toLowerCase() || null, group: p.group }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Who goes next from one pool.
 *   members   [{name, email}]
 *   history   Map name → last put-forward ISO (or null/absent = never)
 *   leave     (name) → { known, dates:Set }
 *   date      the UAT date
 *   exclude   names already asked in this round (picked, replaced or declined)
 * Returns { pick, why, skipped:[{name, why}] }. pick null = nobody eligible.
 */
function pickNext({ members, history = new Map(), leave = () => ({ known: false, dates: new Set() }), date, exclude = [] }) {
  const out = { pick: null, why: null, skipped: [] };
  const excluded = new Set(exclude.map((n) => String(n).toLowerCase()));
  const eligible = [];
  for (const m of members || []) {
    if (excluded.has(m.name.toLowerCase())) { out.skipped.push({ name: m.name, why: 'already asked for this session' }); continue; }
    if (!m.email) { out.skipped.push({ name: m.name, why: 'no email address in their People note' }); continue; }
    const l = leave(m.name) || { known: false };
    if (l.known && l.dates && l.dates.has(date)) { out.skipped.push({ name: m.name, why: 'off that day (People HR)' }); continue; }
    eligible.push({ ...m, last: history.get(m.name) || null, leaveKnown: !!l.known, leaveWhy: l.known ? null : (l.reason || 'leave not readable') });
  }
  eligible.sort((a, b) => {
    if (!a.last && b.last) return -1;
    if (a.last && !b.last) return 1;
    if (a.last && b.last && a.last !== b.last) return a.last < b.last ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const p = eligible[0];
  if (!p) return out;
  out.pick = { name: p.name, email: p.email, leaveKnown: p.leaveKnown, leaveWhy: p.leaveWhy };
  out.why = `${p.last ? `last put forward ${p.last.slice(0, 10)}` : 'never put forward'}${p.leaveKnown ? '' : ` — leave not checked (${p.leaveWhy})`}`;
  return out;
}

function _prevWorkingDay(dateKey, nonWorking) {
  let d = score.addDays(dateKey, -1);
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(new Date(`${d}T12:00:00`), nonWorking)) return d;
    d = score.addDays(d, -1);
  }
  return d;
}

const _key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * When does someone asked at `sentMs` have to answer by? An instant (ms).
 *   - 17:30 London on the day it was sent, if a working day and before 15:00;
 *   - otherwise 17:30 on the next working day;
 *   - never later than 17:30 on the working day before the session;
 *   - and if that has already gone, the session's own start.
 */
function deadlineFor(sentMs, session, nonWorking = new Set()) {
  const wall = score.londonWall(sentMs);
  const sentDay = new Date(`${wall.date}T12:00:00`);
  let day = wall.date;
  if (!isWorkingDay(sentDay, nonWorking) || wall.time >= LATE_SEND_HHMM) day = _key(nextWorkingDay(sentDay, nonWorking));
  const cap = _prevWorkingDay(session.date, nonWorking);
  if (day > cap) day = cap;
  const at = score.londonInstant(day, CLOSE_HHMM);
  if (at > sentMs) return at;
  return score.londonInstant(session.date, session.start);
}

/** "Wednesday 28 October" — from the date key, never parsed into a zone. */
function dayWords(dateKey) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function whenWords(ms) {
  const w = score.londonWall(ms);
  return `${w.time} on ${dayWords(w.date)}`;
}

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

function inviteEmail({ name, session, link, deadlineMs }) {
  const time = session.end ? `${session.start}–${session.end}` : session.start;
  const lines = [
    `Hi ${first(name)},`,
    '',
    `I'd like to put you forward for this week's UAT session${session.feature ? ` on ${session.feature}` : ''}.`,
    '',
    `When: ${dayWords(session.date)}, ${time} (UK time)`,
    session.location ? `Where: ${session.location}` : null,
    session.online ? `Remote: ${session.online}` : null,
    'There is a demo of the new software at the start, so please be there on time.',
    '',
    'Please confirm or decline here:',
    link,
    '',
    `If I haven't heard by ${whenWords(deadlineMs)}, I'll take it that you can make it.`,
    '',
    'Thanks,',
    'Nick',
  ];
  return {
    subject: `UAT ${dayWords(session.date)}${session.feature ? ` — ${session.feature}` : ''}: can you make it?`,
    body: lines.filter((l) => l !== null).join('\n'),
  };
}

function danReply({ toName, session, people }) {
  const names = people.map((p) => p.name);
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(', ');
  return [
    `Hi ${first(toName)},`,
    '',
    `For the UAT on ${dayWords(session.date)}${session.feature ? ` (${session.feature})` : ''}, I'm putting forward ${list}.`,
    '',
    'Thanks,',
    'Nick',
  ].join('\n');
}

const FINAL = new Set(['confirmed', 'accepted']);
const ACTIVE = new Set(['proposed', 'invited', 'sent', 'confirmed', 'accepted']);

/**
 * Where a round stands, from its selections. One active selection per pool.
 *   ready     every pool has a confirmed/accepted person
 *   waiting   someone still has time to answer
 *   toInvite  someone picked and not yet invited (needs Nick's press)
 *   unfilled  a pool with nobody eligible
 */
function roundState(selections, poolIds = POOLS.map((p) => p.id)) {
  const byPool = {};
  for (const id of poolIds) byPool[id] = (selections || []).find((s) => s.pool === id && ACTIVE.has(s.status)) || null;
  const vals = Object.values(byPool);
  return {
    byPool,
    unfilled: poolIds.filter((id) => !byPool[id]),
    toInvite: vals.filter((s) => s && (s.status === 'proposed' || s.status === 'invited')),
    waiting: vals.filter((s) => s && s.status === 'sent'),
    ready: vals.length > 0 && vals.every((s) => s && FINAL.has(s.status)),
  };
}

module.exports = {
  POOLS, CLOSE_HHMM, LATE_SEND_HHMM,
  quickMatch, parseExtraction, extractionPrompt, poolMembers, pickNext, deadlineFor,
  dayWords, whenWords, inviteEmail, danReply, roundState, FINAL, ACTIVE,
};
