'use strict';

/**
 * Add to calendar, from an email (3 Nov 2026).
 *
 * Nick: "emails with dates / times - suggest adding to calendar", and the rule
 * for WHERE: work mail goes in his Outlook work calendar, everything else goes
 * in the family Google calendar.
 *
 * Two steps, like the event composer: `draft()` reads the email and proposes an
 * event — it creates NOTHING; `add()` creates exactly the draft Nick saw (and
 * may have edited), on his press.
 *
 * ⚠ The target is decided by WHICH INBOX the email is in, never by the model:
 *   source 'work' (the Outlook triage) → Outlook, a solo event (nobody invited,
 *   so nobody is told anything); source 'personal' (nick@, contact@, Gmail) →
 *   the family Google calendar through google-calendar.createEvent, which is
 *   ledgered and read back.
 * ⚠ One event per email per target: a second press answers "already added" and
 *   names it, so a double tap or a retry never makes a second event. Kept in
 *   agent_state.email_calendar_added (email id → what was created).
 * ⚠ The model only READS. Its answer is validated and refused, never repaired:
 *   no date means no draft ("I couldn't find a date in this email"), and an end
 *   before the start is dropped rather than guessed.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADDED_KEY = 'email_calendar_added';
const BODY_MAX = 6000;

function _added() {
  try { return JSON.parse(db.getState(ADDED_KEY) || '{}') || {}; } catch { return {}; }
}
function _remember(key, value) {
  const all = _added();
  all[key] = value;
  // Bounded: the newest 300 are plenty to stop a double press.
  const keys = Object.keys(all);
  if (keys.length > 300) {
    keys.sort((a, b) => String(all[a].at || '').localeCompare(String(all[b].at || '')));
    for (const k of keys.slice(0, keys.length - 300)) delete all[k];
  }
  db.setState(ADDED_KEY, JSON.stringify(all));
}

function targetFor(source) {
  return source === 'work' ? 'outlook' : 'family';
}

function targetLabel(target) {
  return target === 'outlook' ? 'your Outlook work calendar' : 'the family calendar';
}

/** PURE. The model's answer → a draft, or null with a reason. */
function parseAnswer(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { draft: null, why: 'unreadable' };
  let j;
  try { j = JSON.parse(m[0]); } catch { return { draft: null, why: 'unreadable' }; }
  if (!j || j.found === false) return { draft: null, why: 'no-event' };
  if (!DATE.test(String(j.date || ''))) return { draft: null, why: 'no-date' };
  const allDay = j.allDay === true || !HM.test(String(j.start || ''));
  const start = allDay ? null : j.start;
  let end = !allDay && HM.test(String(j.end || '')) && j.end > j.start ? j.end : null;
  if (!allDay && !end) {
    const [h, mm] = start.split(':').map(Number);
    const mins = Math.min(h * 60 + mm + 60, 23 * 60 + 59);
    end = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  const clean = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const link = clean(j.link, 500);
  return {
    draft: {
      title: clean(j.title, 200) || 'Event',
      date: j.date,
      allDay,
      start,
      end,
      location: clean(j.location, 200),
      link: link && /^https?:\/\//i.test(link) ? link : null,
    },
    why: null,
  };
}

async function _readEmail(source, emailId) {
  if (source === 'work') {
    const m = await require('./microsoft').fetchEmailById(emailId);
    if (!m) return null;
    return { subject: m.subject, from: m.from, received: m.received, body: m.body || m.preview || '' };
  }
  const m = await require('./personal-inbox').readMessage(emailId);
  if (!m || !m.ok || m.exists === false) return null;
  return { subject: m.subject, from: m.fromName || m.from, received: m.received, body: m.body || '' };
}

function _prompt(email, now) {
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  return `Find the ONE event (appointment, course, meeting, booking, delivery slot) this email tells Nick about. Today is ${today}. Times are UK local.

Subject: ${email.subject || ''}
From: ${email.from || ''}
Received: ${email.received || ''}

${String(email.body || '').slice(0, BODY_MAX)}

Reply with ONLY JSON, no fence:
{"found":true|false,"title":"short name Nick would recognise","date":"YYYY-MM-DD or null","start":"HH:MM 24h or null","end":"HH:MM 24h or null","allDay":true|false,"location":"place or null","link":"joining URL (Zoom/Teams/Meet) or null"}
Use only what the email states. If it names no date, found is false.`;
}

/** Read the email and propose an event. Creates nothing. */
async function draft({ source, emailId, now = Date.now() } = {}) {
  if (source !== 'work' && source !== 'personal') return { ok: false, status: 400, error: 'source must be work or personal' };
  if (!emailId) return { ok: false, status: 400, error: 'emailId required' };
  const target = targetFor(source);
  const done = _added()[`${target}:${emailId}`];
  const email = await _readEmail(source, emailId);
  if (!email) return { ok: false, status: 502, error: 'I couldn’t open that email to read it.' };
  let r;
  try {
    r = await require('./ai-routing').runTask('email_event_extract', { prompt: _prompt(email, now), maxTokens: 300, forceCloud: true });
  } catch (e) {
    return { ok: false, status: 503, error: `I couldn’t read the email for a date just now (${e.message}).` };
  }
  const p = parseAnswer(r && r.text);
  if (!p.draft) {
    const say = p.why === 'unreadable' ? 'I couldn’t make sense of the answer — try again.'
      : 'I couldn’t find a date in this email. You can still fill one in.';
    return { ok: true, draft: null, why: p.why, say, target, targetLabel: targetLabel(target), already: done || null, subject: email.subject };
  }
  return { ok: true, draft: p.draft, target, targetLabel: targetLabel(target), already: done || null, subject: email.subject };
}

function _validate(d = {}) {
  const title = String(d.title || '').trim();
  if (!title) return { ok: false, error: 'Give the event a name.' };
  if (!DATE.test(String(d.date || ''))) return { ok: false, error: 'Pick a day.' };
  const allDay = d.allDay === true;
  if (!allDay) {
    if (!HM.test(String(d.start || ''))) return { ok: false, error: 'Pick a start time.' };
    if (!HM.test(String(d.end || ''))) return { ok: false, error: 'Pick an end time.' };
    if (d.end <= d.start) return { ok: false, error: 'It has to end after it starts.' };
  }
  const link = d.link ? String(d.link).trim() : null;
  if (link && !/^https?:\/\//i.test(link)) return { ok: false, error: 'The joining link must start with https://' };
  return {
    ok: true,
    draft: {
      title: title.slice(0, 200), date: d.date, allDay,
      start: allDay ? null : d.start, end: allDay ? null : d.end,
      location: d.location ? String(d.location).trim().slice(0, 200) : null,
      link,
    },
  };
}

function _nextDay(date) {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** Create exactly the draft Nick saw. Refused (400), never repaired. */
async function add({ source, emailId, draft: input, subject = null, now = Date.now() } = {}) {
  if (source !== 'work' && source !== 'personal') return { ok: false, status: 400, error: 'source must be work or personal' };
  if (!emailId) return { ok: false, status: 400, error: 'emailId required' };
  const v = _validate(input);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const target = targetFor(source);
  const key = `${target}:${emailId}`;
  const held = _added()[key];
  if (held) return { ok: true, already: true, target, targetLabel: targetLabel(target), event: held };

  const d = v.draft;
  const note = `Added from the email${subject ? ` “${String(subject).slice(0, 150)}”` : ''}.${d.link ? `\nJoin: ${d.link}` : ''}`;

  if (target === 'outlook') {
    const start = d.allDay ? `${d.date}T00:00:00` : `${d.date}T${d.start}:00`;
    const end = d.allDay ? `${_nextDay(d.date)}T00:00:00` : `${d.date}T${d.end}:00`;
    const r = await require('./microsoft').createCalendarEvent({
      subject: d.title, start, end, attendees: [], location: d.location || (d.link ? d.link : null),
      body: note, isAllDay: d.allDay, isOnline: false,
    });
    if (!r || !r.created) return { ok: false, status: 502, error: `Outlook didn’t take it (${(r && r.reason) || 'no answer'}).` };
    const ev = { id: r.event && r.event.id, title: d.title, date: d.date, start: d.start, end: d.end, at: new Date(now).toISOString() };
    _remember(key, ev);
    return { ok: true, target, targetLabel: targetLabel(target), event: ev };
  }

  const g = await require('./google-calendar').createEvent({
    title: d.title, date: d.date, allDay: d.allDay, start: d.start, end: d.end,
    location: d.location || (d.link ? d.link.slice(0, 200) : ''),
  }, { by: 'nick', description: note });
  if (!g.ok) return { ok: false, status: g.status || 502, error: g.error };
  const ev = { id: g.event && (g.event.google_id || g.event.id), title: d.title, date: d.date, start: d.start, end: d.end, at: new Date(now).toISOString() };
  _remember(key, ev);
  return { ok: true, already: !!g.already, target, targetLabel: targetLabel(target), event: ev };
}

module.exports = { draft, add, parseAnswer, targetFor, _validate };
