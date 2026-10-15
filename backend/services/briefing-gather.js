'use strict';

/**
 * Candidate gatherers for the daily briefing (12 Oct 2026).
 *
 * Each source PROPOSES things Nick might need to know; briefing-select decides
 * which earn a place. Nothing here decides the shape of the briefing, and
 * nothing here invents: every candidate is read from a service that already
 * owns the fact (calendar cache, task store, Jira cache, email triage, the
 * Future Radar, health-signals, health-daily, People HR availability).
 *
 * Rules every gatherer keeps:
 *   - It NEVER throws. A failure is pushed to `gaps` in plain words, because
 *     "I couldn't read the diary" and "you have no meetings" are different facts.
 *   - It aggregates. Five overdue tasks are ONE candidate with five lines, not
 *     five candidates fighting for the push.
 *   - Its `sphere` is a fact about the item (work / personal / health / context),
 *     because the day-off rule and the email boundary are both decided on it.
 *   - Times are SLICED out of stored strings, never parsed into a Date — the
 *     calendar is already Europe/London wall-clock (the BST bug, every repo).
 */

const { withinLead, daysBetween } = require('./briefing-select');

function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function hhmm(s) {
  const m = /T(\d{2}:\d{2})/.exec(String(s || ''));
  return m ? m[1] : null;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Day type ─────────────────────────────────────────────────────────────────

/**
 * Is today a working day? PURE.
 *
 *   suppression  nudges.nudgeSuppression(now) — the manual 🌴 flag, People HR
 *                leave, weekend and bank holiday, in that order
 *   events       today's Graph diary rows, for Outlook out-of-office
 *   reasonOfLeave working-days.nonWorkingReason(today, events)
 *
 * Unknown resolves to WORK: off-day rendering drops work, so the safe error is
 * showing it (context-state.resolveDuty's rule).
 */
function dayTypeFor({ suppression = null, calendarReason = null } = {}) {
  if (suppression && suppression.suppressed) {
    return { dayType: 'off', reason: suppression.reason || 'not a working day', source: suppression.source || 'calendar' };
  }
  if (calendarReason) return { dayType: 'off', reason: calendarReason === 'leave' ? 'out of office in Outlook' : calendarReason, source: 'outlook' };
  return { dayType: 'work', reason: null, source: null };
}

// ── Individual sources ───────────────────────────────────────────────────────

function _calendarRows(today, gaps) {
  try {
    const db = require('../db/database');
    const total = db.get('SELECT COUNT(*) AS n FROM calendar_cache')?.n || 0;
    if (!total) { gaps.push({ source: 'your diary', why: 'the calendar cache is empty' }); return null; }
    return db.getCalendarEvents(`${today}T00:00`, `${today}T23:59`) || [];
  } catch (e) {
    gaps.push({ source: 'your diary', why: e.message });
    return null;
  }
}

/** Today's real work meetings, as ONE candidate. */
function diary(rows) {
  if (!rows) return [];
  const { isRealMeeting } = require('./context-state');
  const meetings = rows
    .filter((r) => (r.source || 'graph') === 'graph')
    .map((r) => ({
      start: r.start_time, end: r.end_time, subject: (r.subject || 'Meeting').trim(),
      showAs: r.show_as, isAllDay: r.is_all_day === 1, isCancelled: r.show_as === 'cancelled',
      isOrganizer: r.is_organizer === 1 ? true : r.is_organizer === 0 ? false : null,
      attendeesOther: r.attendees_other === 1 ? true : r.attendees_other === 0 ? false : null,
    }))
    .filter(isRealMeeting);
  if (!meetings.length) return [];
  const first = hhmm(meetings[0].start);
  return [{
    key: 'diary:today',
    kind: 'diary',
    sphere: 'work',
    title: `${plural(meetings.length, 'meeting')} today${first ? `, first at ${first}` : ''}`,
    when: first,
    priority: meetings.length >= 5 ? 60 : 50,
    why: 'Meetings with other people in them; solo blocks are left out.',
    items: meetings.map((m) => `${hhmm(m.start) || '—'}–${hhmm(m.end) || '—'} ${m.subject}`),
    source: 'calendar',
  }];
}

/** Overdue and due-today tasks, split work / personal. */
function tasks(today, gaps) {
  try {
    const open = require('./task-store').activeTodos() || [];
    const out = [];
    for (const sphere of ['work', 'personal']) {
      const mine = open.filter((t) => (t.domain === 'personal' ? 'personal' : 'work') === sphere && t.due_date);
      const overdue = mine.filter((t) => t.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date));
      const dueToday = mine.filter((t) => t.due_date === today);
      if (dueToday.length) {
        out.push({
          key: `tasks:due-today:${sphere}`, kind: 'tasks-due', sphere, needsYou: true, priority: 70,
          title: `${plural(dueToday.length, 'task')} due today`,
          items: dueToday.slice(0, 6).map((t) => t.text),
          why: 'Due date is today.', source: 'tasks',
        });
      }
      if (overdue.length) {
        out.push({
          key: `tasks:overdue:${sphere}`, kind: 'tasks-overdue', sphere, needsYou: true, priority: 65,
          title: `${plural(overdue.length, 'task')} overdue`,
          items: overdue.slice(0, 5).map((t) => `${t.text} — ${-daysBetween(today, t.due_date)}d`),
          detail: overdue.length > 5 ? `Showing the 5 oldest of ${overdue.length}.` : null,
          why: 'Past its due date.', source: 'tasks',
        });
      }
    }
    return out;
  } catch (e) {
    gaps.push({ source: 'your tasks', why: e.message });
    return [];
  }
}

function escalations(gaps) {
  try {
    const list = require('./jira').getUnseenEscalations() || [];
    if (!list.length) return [];
    return [{
      key: 'escalations:unseen', kind: 'escalations', sphere: 'work', needsYou: true, priority: 85,
      critical: list.some((e) => /critical|blocker/i.test(String(e.priority || ''))),
      title: `${plural(list.length, 'escalation')} you haven’t replied to`,
      items: list.slice(0, 6).map((e) => `${e.key} ${e.summary || ''}`.trim()),
      why: 'Open escalations with no comment from you.', source: 'jira',
    }];
  } catch (e) {
    gaps.push({ source: 'escalations', why: e.message });
    return [];
  }
}

function urgentEmail(gaps) {
  try {
    const db = require('../db/database');
    if (!db.getState('email_triage_time')) {
      gaps.push({ source: 'your inbox', why: 'email triage has not run' });
      return [];
    }
    const urgent = require('./email-triage').getUrgentEmails() || [];
    if (!urgent.length) return [];
    return [{
      key: 'email:urgent', kind: 'email', sphere: 'work', needsYou: true, priority: 65,
      title: `${plural(urgent.length, 'urgent email')}`,
      items: urgent.slice(0, 5).map((e) => `${e.from || e.fromEmail || 'Unknown sender'} — ${e.subject || '(no subject)'}`),
      why: 'Triaged urgent and not dealt with.', source: 'email',
    }];
  } catch (e) {
    gaps.push({ source: 'your inbox', why: e.message });
    return [];
  }
}

function oneToOnes(gaps) {
  try {
    const due = require('./obsidian').getUpcoming121s(1) || [];
    const overdue = due.filter((d) => d.state === 'overdue');
    const unwritten = due.filter((d) => d.state === 'unwritten');
    const out = [];
    if (overdue.length) {
      out.push({
        key: '121:overdue', kind: 'one-to-ones', sphere: 'work', priority: 45,
        title: `${plural(overdue.length, '1-2-1')} overdue and not booked`,
        items: overdue.map((d) => `${d.name}${d.daysUntil != null ? ` — ${Math.abs(d.daysUntil)}d over` : ''}`),
        why: 'Past the cadence date with nothing in the diary.', source: '1to1',
      });
    }
    if (unwritten.length) {
      out.push({
        key: '121:unwritten', kind: 'one-to-ones', sphere: 'work', priority: 40,
        title: `${plural(unwritten.length, '1-2-1')} scheduled but not written up`,
        items: unwritten.map((d) => d.name),
        why: 'The booked date has passed and no note exists — write it up, or rebook if it didn’t happen.',
        source: '1to1',
      });
    }
    return out;
  } catch (e) {
    gaps.push({ source: '1-2-1 cadence', why: e.message });
    return [];
  }
}

function teamOff(today, gaps) {
  try {
    const ta = require('./team-availability');
    const snap = ta.snapshot();
    if (!snap.known) { gaps.push({ source: 'team leave (People HR)', why: snap.reason || 'not read' }); return []; }
    const off = ta.othersOff(today, snap) || [];
    if (!off.length) return [];
    return [{
      key: 'team:off', kind: 'team-off', sphere: 'work', priority: 35,
      title: `Off today: ${off.map((o) => o.name).join(', ')}`,
      why: 'Approved leave in People HR.', source: 'peoplehr',
    }];
  } catch (e) {
    gaps.push({ source: 'team leave (People HR)', why: e.message });
    return [];
  }
}

function commitments(gaps) {
  try {
    const list = (require('./commitment-risk').findings({ status: 'active', limit: 200 }) || [])
      .filter((f) => f.level === 'high');
    if (!list.length) return [];
    return [{
      key: 'commitments:at-risk', kind: 'commitments', sphere: 'work', priority: 50,
      title: `${plural(list.length, 'commitment')} at risk`,
      items: list.slice(0, 5).map((f) => f.summary),
      why: 'A stated or set deadline today, passed, or the meeting it came from is close.',
      source: 'commitment-risk',
    }];
  } catch (e) {
    gaps.push({ source: 'commitments', why: e.message });
    return [];
  }
}

/**
 * The Future Radar already folds in personal dates, obligations, Ember's care,
 * the car, hikes and the personal calendar — with its own lead-time and
 * needs-you rules. Taken as given, never re-judged.
 */
function radar(now, today, gaps) {
  try {
    const r = require('./future-radar').read({ now: now.getTime(), horizonDays: 14 });
    for (const g of r.gaps || []) gaps.push({ source: g.source || g.input || 'the radar', why: g.why || g.reason || 'not read' });
    const out = [];
    for (const it of r.items || []) {
      if (!it || !it.id || !it.title) continue;
      // A NEURO task is the tasks gatherer's to report; the Radar carrying it
      // too put the same task on the briefing twice (found live, 12 Oct).
      if (/^(radar:)?task:neuro:/.test(String(it.id))) continue;
      const sphere = it.sphere === 'work' ? 'work' : 'personal';
      const isToday = it.date === today;
      const important = /critical|important/.test(String(it.importance || ''));
      let priority;
      let needsYou = false;
      if (it.actionState === 'needs_you') { priority = 75; needsYou = true; }
      else if (isToday) priority = 45;
      else if (it.actionState === 'preparation_open') priority = 45;
      else if (important) priority = 40;
      else priority = 25; // below the bar: known, planned, nothing to do
      out.push({
        key: `radar:${it.id}`, kind: `radar-${it.kind || 'item'}`, sphere, needsYou, priority,
        title: it.title,
        date: it.date || null,
        when: isToday && /^\d{2}:\d{2}$/.test(String(it.time || '')) ? it.time : null,
        detail: Array.isArray(it.whyVisible) && it.whyVisible[0] ? it.whyVisible[0] : null,
        source: 'radar',
      });
    }
    return out;
  } catch (e) {
    gaps.push({ source: 'the Future Radar', why: e.message });
    return [];
  }
}

// ── Health ───────────────────────────────────────────────────────────────────

// Senses whose silence makes the health read unreliable. A quiet glucose meter
// is a fact about a meter; a quiet heart rate is a fact about the whole read.
const CORE_HEALTH_METRICS = ['heart_rate', 'heart_rate_variability', 'resting_heart_rate'];

/**
 * Only what has CHANGED against his own baseline, and only if it persists —
 * health-signals already holds that bar. Stated as facts, never diagnosed.
 */
function health(now, today, gaps) {
  const out = [];
  try {
    const snap = require('./health-signals').snapshot({ now });
    for (const f of snap.findings || []) {
      if (!f || !f.id) continue;
      if (String(f.id).startsWith('quiet:')) {
        const metric = String(f.id).slice(6);
        if (!CORE_HEALTH_METRICS.includes(metric)) continue;
        out.push({
          key: `health:${f.id}`, kind: 'health-quiet', sphere: 'health', priority: 35,
          title: f.title, detail: f.detail || null,
          why: 'Without it the rest of the health read is less reliable.', source: 'health',
        });
        continue;
      }
      out.push({
        key: `health:${f.id}`, kind: `health-${f.id}`, sphere: 'health', priority: f.level === 'warn' ? 55 : 40,
        title: f.title,
        detail: [f.detail, f.caveat].filter(Boolean).join(' ') || null,
        why: 'Changed against your own baseline and has persisted.', source: 'health',
      });
    }
  } catch (e) {
    gaps.push({ source: 'health trends', why: e.message });
  }

  try {
    const { readiness, sentence } = require('./health-daily').today(now);
    if (readiness && readiness.known && readiness.state !== 'normal' && sentence) {
      out.push({
        key: 'health:readiness', kind: 'health-readiness', sphere: 'health',
        priority: readiness.state === 'low' ? 45 : 32,
        title: sentence,
        why: 'Today against your own fortnight. Context, not a prediction — it has not measurably predicted output.',
        source: 'health',
      });
    }
  } catch (e) {
    gaps.push({ source: 'recovery', why: e.message });
  }

  try {
    const rows = require('./health-daily').recentDays(3) || [];
    const night = rows.find((r) => r && r.day === today && Number.isFinite(r.asleepHours));
    if (night) {
      const usual = require('./rhythm-read').usualFor(today);
      if (usual && usual.known && Number.isFinite(usual.usual)) {
        const diff = night.asleepHours - usual.usual;
        if (Math.abs(diff) >= 1) {
          out.push({
            key: 'health:sleep', kind: 'health-sleep', sphere: 'health', priority: diff < 0 ? 40 : 31,
            title: `Slept ${fmtHours(night.asleepHours)} — usually ${fmtHours(usual.usual)} on a ${usual.weekday || 'day like this'}`,
            why: 'More than an hour off your usual for this day of the week.', source: 'health',
          });
        }
      }
    }
  } catch (e) {
    gaps.push({ source: 'last night’s sleep', why: e.message });
  }
  return out;
}

function fmtHours(h) {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return `${whole}h${String(mins).padStart(2, '0')}`;
}

// ── Context line ─────────────────────────────────────────────────────────────

async function weatherLine(today, gaps) {
  try {
    const fc = await require('./ha-rooms').readDailyForecast();
    if (!fc || !fc.known) { gaps.push({ source: 'the forecast', why: fc?.why || 'not read' }); return null; }
    const d = (fc.days || []).find((x) => x.date === today);
    if (!d) return null;
    const bits = [];
    if (d.condition) bits.push(String(d.condition).replace(/-/g, ' '));
    if (Number.isFinite(d.tempHighC)) bits.push(`high ${Math.round(d.tempHighC)}°C`);
    if (Number.isFinite(d.precipitationMm) && d.precipitationMm >= 0.5) bits.push(`${Math.round(d.precipitationMm * 10) / 10}mm rain`);
    if (Number.isFinite(d.windKmh) && d.windKmh >= 40) bits.push(`wind ${Math.round(d.windKmh)} km/h`);
    return bits.length ? bits.join(', ') : null;
  } catch (e) {
    gaps.push({ source: 'the forecast', why: e.message });
    return null;
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Everything for one morning. `overrides` replaces any source by name — tests
 * use it so no gatherer touches a real system.
 */
/**
 * One "I could do X for you, with Y" suggestion (capability-gaps.js), MONDAYS
 * only — a weekly thought, not a daily nag. Sphere `personal`, so it never rides
 * the work-only email. Priority sits just above the bar on purpose: two "not
 * useful" presses on this kind take it below, which is the briefing's own
 * learning doing the job. An unreadable store proposes nothing and is named.
 */
function capabilities(now, gaps) {
  if (now.getDay() !== 1) return [];
  try {
    const top = require('./capability-gaps').openSummary({ limit: 1 })[0];
    if (!top) return [];
    return [{
      key: `capability:${top.id}`, kind: 'capability', sphere: 'personal', priority: 32,
      title: `Something I could do for you: ${top.title}`,
      detail: `${top.unlocks} Needs: ${top.need}.`,
      why: top.changes || null,
      source: 'capability suggestions', link: 'pi-health',
    }];
  } catch (e) {
    gaps.push({ source: 'capability suggestions', why: e.message });
    return [];
  }
}

async function gatherDaily({ now = new Date(), overrides = {} } = {}) {
  const today = todayLocal(now);
  const gaps = [];
  const use = (name, fn) => (typeof overrides[name] === 'function' ? overrides[name] : fn);

  const rows = use('calendar', () => _calendarRows(today, gaps))();

  let day;
  try {
    const suppression = use('suppression', () => require('./nudges').nudgeSuppression(now))();
    const graphEvents = (rows || []).filter((r) => (r.source || 'graph') === 'graph')
      .map((r) => ({ showAs: r.show_as, start: r.start_time, end: r.end_time, isAllDay: r.is_all_day === 1 }));
    const calendarReason = use('calendarReason', () => {
      const r = require('./working-days').nonWorkingReason(today, graphEvents);
      return r === 'leave' ? 'leave' : null; // weekend/holiday already in suppression
    })();
    day = dayTypeFor({ suppression, calendarReason });
  } catch (e) {
    gaps.push({ source: 'whether today is a work day', why: e.message });
    day = { dayType: 'work', reason: null, source: null };
  }

  const candidates = [
    ...use('diary', () => diary(rows))(),
    ...use('tasks', () => tasks(today, gaps))(),
    ...use('escalations', () => escalations(gaps))(),
    ...use('email', () => urgentEmail(gaps))(),
    ...use('oneToOnes', () => oneToOnes(gaps))(),
    ...use('teamOff', () => teamOff(today, gaps))(),
    ...use('commitments', () => commitments(gaps))(),
    ...use('radar', () => radar(now, today, gaps))(),
    ...use('health', () => health(now, today, gaps))(),
    ...use('capabilities', () => capabilities(now, gaps))(),
  ];
  const weather = await use('weather', () => weatherLine(today, gaps))();

  return { today, ...day, candidates, gaps, context: { weather } };
}

module.exports = {
  gatherDaily, dayTypeFor, todayLocal, hhmm, fmtHours,
  diary, tasks, escalations, urgentEmail, oneToOnes, teamOff, commitments, radar, health, capabilities, weatherLine,
  CORE_HEALTH_METRICS, withinLead,
};
