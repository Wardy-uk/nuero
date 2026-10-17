import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import './Wall.css';
import { CinemaView, presenceLine, nextLine, sunTimes, skyPhase, photoSlot, stripItems } from './WallCinema';

/**
 * The family wall — VESTA on an always-on iPad in the house (15 Oct 2026).
 *
 * The week's diary, the top family tasks, who is in, and the weather station,
 * on one landscape screen that refreshes itself. It is a MODE of VESTA chosen on
 * this device (localStorage), so the iPad signs in with its own household
 * account and never holds Nick's.
 *
 * ⚠ NOTHING IS REDACTED HERE. Work events arrive as "Busy" with no subject and
 * no location on the object — `services/vesta.js` did that on the server.
 * ⚠ Times are SLICED out of the string, never parsed (the BST bug).
 * ⚠ The three silences stay distinct, as everywhere in VESTA: a block that could
 * not be read says so; one that read fine and is empty says that; one the
 * account has no scope for is not drawn.
 */

const POLL_MS = 60 * 1000;
const NIGHT_FROM = 22 * 60;       // 22:00
const NIGHT_TO = 6 * 60 + 30;     // 06:30
const WAKE_MS = 3 * 60 * 1000;    // a tap lights it for three minutes
const IDLE_RETURN_MS = 3 * 60 * 1000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const time = (iso) => String(iso || '').slice(11, 16);
/** A YYYY-MM-DD key's weekday, from its parts — no time, so no offset. */
function dayOfKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return { dow: new Date(y, m - 1, d).getDay(), day: d, month: m - 1 };
}

export function isNight(now) {
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= NIGHT_FROM || m < NIGHT_TO;
}

function Gap({ children }) {
  return <p className="wall__gap" role="status">{children}</p>;
}

/**
 * All-day events as BARS across the days they cover, one lane each, so half
 * term is one bar rather than the same chip in five columns. PURE: the week's
 * days → [{key, title, from, to, lane}] (column indexes). Exported for tests.
 */
export function allDaySpans(week) {
  const open = new Map();   // event key → its bar still running
  const all = [];
  week.forEach((d, col) => {
    for (const e of d.events || []) {
      if (!e.allDay) continue;
      const key = e.id || `${e.title}|${e.start}`;
      const s = open.get(key);
      // Only CONSECUTIVE columns join one bar; a repeat later in the week is its own bar.
      if (s && s.to === col - 1) { s.to = col; continue; }
      const bar = { key: `${key}@${col}`, title: e.title, from: col, to: col };
      open.set(key, bar);
      all.push(bar);
    }
  });
  const spans = all.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
  const laneEnds = [];
  for (const s of spans) {
    let lane = laneEnds.findIndex((end) => end < s.from);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(s.to); } else laneEnds[lane] = s.to;
    s.lane = lane;
  }
  return spans;
}

function Week({ week, today, gap }) {
  if (gap || !Array.isArray(week)) {
    return <section className="wall__week wall__week--gap"><Gap>I couldn&rsquo;t read the diary. That isn&rsquo;t an empty week &mdash; I couldn&rsquo;t look.</Gap></section>;
  }
  const spans = allDaySpans(week);
  const lanes = spans.reduce((n, s) => Math.max(n, s.lane + 1), 0);
  const bodyRow = lanes + 2;
  return (
    <section className="wall__week" aria-label="This week" style={{ gridTemplateRows: `auto ${'auto '.repeat(lanes)}1fr` }}>
      {week.map((d, col) => {
        const { dow } = dayOfKey(d.date);
        return (
          <div key={`bg-${d.date}`} aria-hidden="true"
               className={`wall__day${d.date === today ? ' wall__day--today' : ''}${dow === 0 || dow === 6 ? ' wall__day--weekend' : ''}`}
               style={{ gridColumn: col + 1, gridRow: `1 / span ${bodyRow}` }} />
        );
      })}
      {week.map((d, col) => {
        const { dow, day, month } = dayOfKey(d.date);
        return (
          <header key={`h-${d.date}`} className={`wall__dayhead${d.date === today ? ' wall__dayhead--today' : ''}`} style={{ gridColumn: col + 1, gridRow: 1 }}>
            <span className="wall__dow">{d.date === today ? 'Today' : DAYS[dow]}</span>
            <span className="wall__date">{`${day} ${MONTHS[month]}`}</span>
          </header>
        );
      })}
      {spans.map((s) => (
        <div key={s.key} className="wall__span" style={{ gridColumn: `${s.from + 1} / ${s.to + 2}`, gridRow: s.lane + 2 }}>
          {s.title}
        </div>
      ))}
      {week.map((d, col) => {
        const timed = (d.events || []).filter((e) => !e.allDay);
        const coveredBySpan = spans.some((s) => s.from <= col && s.to >= col);
        return (
          <div key={`b-${d.date}`} className="wall__daybody" style={{ gridColumn: col + 1, gridRow: bodyRow }}>
            {d.off && <p className="wall__atwork wall__atwork--off"><span className="wall__atwork-label">Nick off</span></p>}
            {d.work && (
              <p className="wall__atwork">
                <span className="wall__atwork-label">Nick at work</span>
                {!d.work.allDay && <span className="wall__time">{`${time(d.work.start)}–${time(d.work.end)}`}</span>}
              </p>
            )}
            {timed.length > 0 ? (
              <ul className="wall__events">
                {timed.map((e, i) => (
                  <li key={`${e.id || i}-${d.date}`} className="wall__event">
                    <span className="wall__time">{time(e.start)}</span>
                    <span className="wall__title">{e.title}</span>
                  </li>
                ))}
              </ul>
            ) : (!d.work && !d.off && !coveredBySpan && <p className="wall__nothing">Nothing in</p>)}
          </div>
        );
      })}
    </section>
  );
}

/* ── Which days the calendar shows (PURE, local dates, no offsets) ─────────── */
const pad2 = (n) => String(n).padStart(2, '0');
export function keyOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function dateOf(key) { const [y, m, d] = String(key).split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(key, n) { const d = dateOf(key); d.setDate(d.getDate() + n); return keyOf(d); }

/**
 * The range for a view. Week: seven days from today, moved a week per step.
 * Month: six whole weeks from the Monday on or before the 1st, so every month
 * fits the same grid. Returns {from, days, month, year, label}.
 */
export function calRange(view, offset, todayKey) {
  if (view === 'today') {
    // Today plus the next seven: the eight-day strip (Nick, 17 Oct 2026).
    return { from: todayKey, days: 8, month: null, year: null, label: 'Today' };
  }
  if (view === 'month') {
    const t = dateOf(todayKey);
    const first = new Date(t.getFullYear(), t.getMonth() + offset, 1);
    const back = (first.getDay() + 6) % 7;            // days since Monday
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - back);
    return { from: keyOf(start), days: 42, month: first.getMonth(), year: first.getFullYear(),
      label: `${MONTHS_LONG[first.getMonth()]} ${first.getFullYear()}` };
  }
  const from = addDays(todayKey, 7 * offset);
  const to = addDays(from, 6);
  const a = dayOfKey(from), b = dayOfKey(to);
  const span = a.month === b.month ? `${a.day}–${b.day} ${MONTHS[b.month]}` : `${a.day} ${MONTHS[a.month]} – ${b.day} ${MONTHS[b.month]}`;
  const label = offset === 0 ? `This week · ${span}` : offset === 1 ? `Next week · ${span}` : offset === -1 ? `Last week · ${span}` : span;
  return { from, days: 7, month: null, year: null, label };
}

const MONTH_LINES = 3;
function Month({ days, today, month, gap }) {
  if (gap || !Array.isArray(days)) {
    return <section className="wall__month wall__week--gap"><Gap>I couldn&rsquo;t read the diary. That isn&rsquo;t an empty month &mdash; I couldn&rsquo;t look.</Gap></section>;
  }
  return (
    <section className="wall__month" aria-label="This month">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="wall__mhead">{d}</div>)}
      {days.map((d) => {
        const { dow, day, month: m } = dayOfKey(d.date);
        const lines = [];
        if (d.off) lines.push(<li key="off" className="wall__mline wall__mline--off">Nick off</li>);
        else if (d.work) lines.push(<li key="work" className="wall__mline wall__mline--work">{d.work.allDay ? 'Nick at work' : `Work ${time(d.work.start)}–${time(d.work.end)}`}</li>);
        (d.events || []).forEach((e, i) => {
          lines.push(e.allDay
            ? <li key={`${e.id || i}-a`} className="wall__mline wall__mline--allday">{e.title}</li>
            : <li key={`${e.id || i}-t`} className="wall__mline"><span className="wall__time">{time(e.start)}</span>{` ${e.title}`}</li>);
        });
        const shown = lines.length > MONTH_LINES ? lines.slice(0, MONTH_LINES - 1) : lines;
        const more = lines.length - shown.length;
        return (
          <div key={d.date}
               className={`wall__mday${d.date === today ? ' wall__mday--today' : ''}${m !== month ? ' wall__mday--other' : ''}${dow === 0 || dow === 6 ? ' wall__mday--weekend' : ''}`}>
            <span className="wall__mnum">{day === 1 ? `${day} ${MONTHS[m]}` : String(day)}</span>
            <ul className="wall__mlines">
              {shown}
              {more > 0 && <li className="wall__mline wall__mline--more">{`+${more} more`}</li>}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/* ── Today-first (17 Oct 2026, Nick picked it) ─────────────────────────────── */

/** HH:MM now, for comparing against sliced event times on TODAY only. */
const hhmm = (now) => `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

/**
 * Today's items split for display. PURE. Past = ended before now; the first
 * not-yet-ended timed event is `next`. Exported for tests.
 */
export function splitDay(day, nowHHMM) {
  const allDay = (day.events || []).filter((e) => e.allDay);
  const timed = (day.events || []).filter((e) => !e.allDay);
  let nextId = null;
  const rows = timed.map((e) => {
    const end = time(e.end) || time(e.start);
    const past = nowHHMM != null && end && end <= nowHHMM;
    const now = nowHHMM != null && !past && time(e.start) <= nowHHMM;
    return { e, past, now };
  });
  const first = rows.find((x) => !x.past);
  if (first && nowHHMM != null) nextId = first.e.id || first.e.start;
  return { allDay, rows, nextId };
}

function DayPanel({ day, title, now, big }) {
  if (!day) return null;
  const { allDay, rows, nextId } = splitDay(day, now ? hhmm(now) : null);
  const { dow, day: n, month } = dayOfKey(day.date);
  const empty = !allDay.length && !rows.length && !day.work && !day.off;
  return (
    <section className={`wall__dpanel${big ? ' wall__dpanel--big' : ''}`} aria-label={title}>
      <header className="wall__dphead">
        <span className="wall__dptitle">{title}</span>
        <span className="wall__dpdate">{`${DAYS_LONG[dow]} ${n} ${MONTHS_LONG[month]}`}</span>
      </header>
      {allDay.map((e, i) => <div key={`${e.id || i}-ad`} className="wall__dpallday">{e.title}</div>)}
      {day.off && <p className="wall__dpwork wall__dpwork--off">Nick off</p>}
      {day.work && <p className="wall__dpwork">{day.work.allDay ? 'Nick at work' : `Nick at work · ${time(day.work.start)}–${time(day.work.end)}`}</p>}
      {rows.length > 0 && (
        <ul className="wall__dplist">
          {rows.map(({ e, past, now: on }, i) => (
            <li key={`${e.id || i}-t`} className={`wall__dpitem${past ? ' wall__dpitem--past' : ''}${on ? ' wall__dpitem--now' : (e.id || e.start) === nextId ? ' wall__dpitem--next' : ''}`}>
              <span className="wall__dptime">{time(e.start)}</span>
              <span className="wall__dpwhat">{e.title}</span>
              {on ? <span className="wall__dpbadge">Now</span> : (e.id || e.start) === nextId && now ? <span className="wall__dpbadge">Next</span> : null}
            </li>
          ))}
        </ul>
      )}
      {empty && <p className="wall__nothing">Nothing in</p>}
    </section>
  );
}

/** The rest of the week as a thin strip; a tap opens the full week. */
function WeekStrip({ week, today, onOpen }) {
  return (
    <button className="wall__strip" onClick={onOpen} aria-label="Open the week">
      {week.slice(0, 7).map((d) => {
        const { dow, day } = dayOfKey(d.date);
        const titles = (d.events || []).map((e) => e.title);
        return (
          <span key={d.date} className={`wall__sday${d.date === today ? ' wall__sday--today' : ''}`}>
            <span className="wall__sdow">{d.date === today ? 'Today' : DAYS[dow]} <b>{day}</b></span>
            <span className={`wall__smark${d.off ? ' wall__smark--off' : ''}`}>{d.off ? 'Nick off' : d.work ? 'Nick at work' : '\u00a0'}</span>
            <span className="wall__stitles">{titles.length ? titles.slice(0, 2).join(' · ') + (titles.length > 2 ? ` +${titles.length - 2}` : '') : '\u00a0'}</span>
          </span>
        );
      })}
    </button>
  );
}

function TodayView({ week, today, now, gap, onOpenWeek }) {
  if (gap || !Array.isArray(week)) {
    return <section className="wall__week--gap"><Gap>I couldn&rsquo;t read the diary. That isn&rsquo;t an empty day &mdash; I couldn&rsquo;t look.</Gap></section>;
  }
  return (
    <div className="wall__todayview">
      <div className="wall__hero">
        <DayPanel day={week[0]} title="Today" now={now} big />
        <DayPanel day={week[1]} title="Tomorrow" />
      </div>
      <WeekStrip week={week} today={today} onOpen={onOpenWeek} />
    </div>
  );
}

/**
 * The calendar with its controls. A horizontal swipe moves a week or a month;
 * a vertical one is left alone.
 */
function Calendar({ data, gap, cal, now }) {
  const start = useRef(null);
  const ready = data && data.from === cal.range.from && data.days === cal.range.days;
  const step = (n) => cal.view !== 'today' && cal.onStep && cal.onStep(n);
  return (
    <div className="wall__cal"
         onPointerDown={(e) => { start.current = { x: e.clientX, y: e.clientY }; }}
         onPointerUp={(e) => {
           const s = start.current; start.current = null;
           if (!s) return;
           const dx = e.clientX - s.x, dy = e.clientY - s.y;
           if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
         }}>
      <div className="wall__caltools">
        {cal.view !== 'today' && <>
          <button className="wall__calbtn" onClick={() => step(-1)} aria-label={cal.view === 'month' ? 'Previous month' : 'Previous week'}>‹</button>
          <span className="wall__callabel">{cal.range.label}</span>
          <button className="wall__calbtn" onClick={() => step(1)} aria-label={cal.view === 'month' ? 'Next month' : 'Next week'}>›</button>
          {cal.offset !== 0 && <button className="wall__calbtn wall__calbtn--today" onClick={() => cal.onToday && cal.onToday()}>This {cal.view}</button>}
        </>}
        <span className="wall__calspacer" />
        <div className="wall__calview" role="group" aria-label="Calendar view">
          {['today', 'week', 'month'].map((v) => (
            <button key={v} className={`wall__calbtn${cal.view === v ? ' wall__calbtn--on' : ''}`} aria-pressed={cal.view === v}
                    onClick={() => cal.onView && cal.onView(v)}>{v === 'today' ? 'Today' : v === 'week' ? 'Week' : 'Month'}</button>
          ))}
        </div>
      </div>
      {!ready && !gap ? <p className="wall__loading">Getting the diary…</p>
        : cal.view === 'today'
          ? <TodayView week={data.week} today={data.today} now={now} gap={gap} onOpenWeek={() => cal.onView && cal.onView('week')} />
        : cal.view === 'month'
          ? <Month days={data.week} today={data.today} month={cal.range.month} gap={gap} />
          : <Week week={data.week} today={data.today} gap={gap} />}
    </div>
  );
}

function dueLabel(t, today) {
  if (!t.dueDate) return null;
  if (t.overdue) return 'Overdue';
  if (t.dueToday) return 'Today';
  const { dow, day, month } = dayOfKey(t.dueDate);
  return `${DAYS[dow]} ${day} ${MONTHS[month]}`;
}

function Tasks({ tasks, gap, today }) {
  return (
    <section className="wall__card wall__card--jobs" aria-label="Family tasks">
      <h2 className="wall__h">Jobs</h2>
      {gap || !tasks ? <Gap>I couldn&rsquo;t read the jobs list.</Gap>
        : tasks.tasks.length === 0 ? <p className="wall__nothing">Nothing to do.</p>
        : (
          <ul className="wall__tasks">
            {tasks.tasks.map((t) => {
              const due = dueLabel(t, today);
              return (
                <li key={t.id} className="wall__task">
                  <span className="wall__tasktext">{t.text}</span>
                  <span className="wall__taskmeta">
                    {due && <span className={`wall__due${t.overdue ? ' wall__due--late' : t.dueToday ? ' wall__due--today' : ''}`}>{due}</span>}
                    {t.who.length > 0 && <span className="wall__taskwho">{t.who.join(' & ')}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      {tasks && tasks.total > tasks.tasks.length && (
        <p className="wall__more">{`+${tasks.total - tasks.tasks.length} more in Vesta`}</p>
      )}
    </section>
  );
}

const STATE_WORD = { home: 'In', out: 'Out', unknown: '?' };

// Who's in and the outside reading live in the TOP BAR, which is otherwise
// just a clock: the jobs list gets the whole side column instead of being
// squeezed under two cards (Nick, 15 Oct 2026: use the width).
/** The household photo the Pi holds, or the person's initial while it loads / if none. */
function Face({ person }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url = null;
    let dead = false;
    if (person.id && person.photo && typeof window !== 'undefined') {
      api.photoUrl(api.getToken(), person.id, person.photo).then((u) => {
        if (dead) { if (u) URL.revokeObjectURL(u); return; }
        url = u; setSrc(u);
      });
    }
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [person.id, person.photo]);
  return src
    ? <img className="wall__face" src={src} alt="" />
    : <span className="wall__face wall__face--initial" aria-hidden="true">{String(person.name || '?').slice(0, 1)}</span>;
}

function Who({ who }) {
  if (!who) return null;
  return (
    <section className="wall__topcard" aria-label="Who's in">
      <h2 className="wall__h">Who&rsquo;s in</h2>
      {!who.known && <Gap>{who.why || "I can't see the house"} &mdash; that isn&rsquo;t the same as everyone being out.</Gap>}
      {Array.isArray(who.people) && who.people.length > 0 && (
        <ul className="wall__who">
          {who.people.map((p) => (
            <li key={p.id || p.name} className={`wall__person wall__person--${who.known ? p.state : 'unknown'}`}>
              <Face person={p} />
              <span className="wall__pname">{p.name}</span>
              <span className="wall__pstate">{who.known ? STATE_WORD[p.state] : '?'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// The trend's own words ("falling slowly"), with an arrow a glance can read.
const tendency = (w) => (/^rising/.test(w) ? `↑ ${w}` : /^falling/.test(w) ? `↓ ${w}` : `→ ${w}`);

function Station({ station }) {
  if (!station) return null;
  return (
    <section className="wall__topcard wall__topcard--station" aria-label="Weather station">
      <h2 className="wall__h">Outside</h2>
      {!station.known ? <Gap>{station.why || 'the weather station could not be read'}.</Gap> : (
        <div className="wall__station">
          <p className="wall__temp">{station.tempC != null ? `${station.tempC.toFixed(1)}°` : '—'}</p>
          <div className="wall__readings">
            <p className="wall__reading">
              {[station.humidityPct != null ? `${station.humidityPct}% humidity` : null,
                station.pressureHpa != null ? `${station.pressureHpa} hPa${station.tendency ? ` ${tendency(station.tendency)}` : ''}` : null]
                .filter(Boolean).join(' · ')}
            </p>
            {station.verdict && <p className="wall__verdict">{station.verdict}</p>}
            {station.indoorLikely && <p className="wall__note">The sensor reads like it&rsquo;s indoors.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Household energy on the wall (the `energy` scope): yesterday and this month
 * per fuel, the last fortnight as bars. A day with no reading is a GAP in the
 * bars, never a zero; a partial day is faint; every £ is an estimate.
 */
const FUEL_NAME = { electricity: 'Electricity', gas: 'Gas' };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;

function EnergyBars({ days }) {
  const vals = days.map((d) => d.kwh).filter((v) => v != null);
  const max = vals.length ? Math.max(...vals) : 0;
  return (
    <div className="wall__ebars" role="img" aria-label="Last 14 days">
      {days.map((d) => (
        <span key={d.day} className={`wall__ebar${d.kwh == null ? ' wall__ebar--none' : d.complete ? '' : ' wall__ebar--part'}`}
          style={{ height: d.kwh == null || !max ? '0' : `${Math.max(6, (d.kwh / max) * 100)}%` }} />
      ))}
    </div>
  );
}

export function WallEnergy({ energy, gap }) {
  const fuels = energy ? Object.entries(energy.fuels || {}) : [];
  return (
    <section className="wall__card wall__card--energy" aria-label="Energy">
      <h2 className="wall__h">Energy</h2>
      {gap || !energy ? <Gap>I couldn&rsquo;t read the meters.</Gap>
        : !fuels.length ? <p className="wall__nothing">{energy.connected ? 'Waiting for the first readings.' : 'Meters not connected yet.'}</p>
        : (
          <>
            <div className="wall__efuels">
            {fuels.map(([fuel, f]) => {
              const y = f.yesterday;
              return (
                <div key={fuel} className="wall__efuel">
                  <div className="wall__ehead">
                    <span className="wall__ename">{FUEL_NAME[fuel]}</span>
                    <span className="wall__eval">{y && y.kwh != null ? `${y.kwh.toFixed(1)} kWh` : '—'}</span>
                    <span className="wall__emeta">
                      {y && y.kwh != null && !y.complete ? 'yesterday so far' : 'yesterday'}
                      {y && y.costP != null ? ` · ~${gbp(y.costP)}` : ''}
                    </span>
                  </div>
                  <EnergyBars days={(f.days || []).slice(-14)} />
                  <p className="wall__emonth">
                    This month {f.month.kwh != null ? `${Math.round(f.month.kwh)} kWh` : '—'}{f.month.costP != null ? ` · ~${gbp(f.month.costP)}` : ''}
                    {f.freshness && f.freshness.state !== 'usual' && f.freshness.state !== 'none' ? ' · meter data running late' : ''}
                  </p>
                </div>
              );
            })}
            </div>
            {energy.monthCostP != null && <p className="wall__etotal">Both this month ~{gbp(energy.monthCostP)} <span className="wall__note">estimated</span></p>}
          </>
        )}
    </section>
  );
}

/** PURE view. Exported for the render test. */
export function WallView({ data, now, error = null, onExit = null, cal = null }) {
  const gapFor = (b) => ((data && data.gaps) || []).find((g) => g.block === b)?.why || null;
  const can = (s) => ((data && data.scopes) || []).includes(s);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return (
    <div className="wall">
      <header className="wall__top">
        <div className="wall__when">
          <div className="wall__clock">{`${hh}:${mm}`}</div>
          <div className="wall__today">{`${DAYS_LONG[now.getDay()]} ${now.getDate()} ${MONTHS_LONG[now.getMonth()]}`}</div>
        </div>
        {data && can('house') && <Who who={data.who} />}
        {data && can('house') && <Station station={data.station} />}
        {error && <div className="wall__stale" role="status">Can&rsquo;t reach home &mdash; showing what I last had.</div>}
        {onExit && <button className="wall__exit" onClick={onExit} aria-label="Leave wall view">⋯</button>}
      </header>
      {!data ? <p className="wall__loading">Getting things…</p> : (
        <main className={`wall__body${can('calendar') ? '' : ' wall__body--nocal'}`}>
          {can('calendar') && (cal
            ? <Calendar data={data} gap={gapFor('week')} cal={cal} now={now} />
            : <Week week={data.week} today={data.today} gap={gapFor('week')} />)}
          <aside className="wall__side">
            <Tasks tasks={data.tasks} gap={gapFor('tasks')} today={data.today} />
            {can('energy') && <WallEnergy energy={data.energy} gap={gapFor('energy')} />}
          </aside>
        </main>
      )}
    </div>
  );
}

/**
 * Keep the screen on — two ways at once, because neither is reliable alone on
 * an iPad (Nick, 17 Oct 2026: "screen doesn't stay awake"):
 *   • the Screen Wake Lock API, where Safari honours it;
 *   • a tiny silent looping video (NoSleep.js's own clip) — iOS keeps the
 *     display on while a video plays. A video may only START from a tap, so
 *     the wall asks for one tap and says so until it has it.
 * Re-armed whenever the page comes back; a video iOS paused needs the tap again.
 */
function useKeepAwake() {
  const [awake, setAwake] = useState(false);
  const [locked, setLocked] = useState(false);
  const lock = useRef(null);
  const video = useRef(null);
  // ⚠ The silent video's source is loaded UP FRONT. iOS only lets a video start
  // inside the tap itself; awaiting a module import first broke that link, so
  // the video never actually played (17 Oct 2026).
  const media = useRef(null);
  useEffect(() => {
    let dead = false;
    import('nosleep.js/src/media.js').then((m) => { if (!dead) media.current = m; }).catch(() => {});
    return () => { dead = true; };
  }, []);

  const requestLock = useCallback(async () => {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible' && !lock.current) {
        lock.current = await navigator.wakeLock.request('screen');
        setLocked(true);
        lock.current.addEventListener('release', () => { lock.current = null; setLocked(false); });
      }
    } catch { /* refused — the video still covers it */ }
  }, []);

  const arm = useCallback(() => {
    requestLock();
    try {
      if (!video.current) {
        if (!media.current) return;      // not loaded yet: the next tap will do it
        const { webm, mp4 } = media.current;
        const v = document.createElement('video');
        v.setAttribute('playsinline', '');
        v.setAttribute('muted', '');
        v.muted = true;
        v.setAttribute('title', 'Keeping the screen on');
        v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;bottom:0';
        for (const [type, src] of [['webm', webm], ['mp4', mp4]]) {
          const s = document.createElement('source'); s.src = src; s.type = `video/${type}`; v.appendChild(s);
        }
        v.addEventListener('loadedmetadata', () => {
          if (v.duration <= 1) v.setAttribute('loop', '');
          else v.addEventListener('timeupdate', () => { if (v.currentTime > 0.5) v.currentTime = Math.random(); });
        });
        v.addEventListener('pause', () => setAwake(false));
        v.addEventListener('playing', () => setAwake(true));
        document.body.appendChild(v);
        video.current = v;
      }
      // play() is called synchronously inside the tap, which is what iOS requires.
      const p = video.current.play();
      if (p && p.then) p.then(() => setAwake(true)).catch(() => setAwake(false));
    } catch { setAwake(false); }
  }, [requestLock]);

  useEffect(() => {
    requestLock();
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      requestLock();
      if (video.current) video.current.play().then(() => setAwake(true)).catch(() => setAwake(false));
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      try { lock.current && lock.current.release(); } catch { /* gone */ }
      if (video.current) { video.current.pause(); video.current.remove(); video.current = null; }
    };
  }, [requestLock]);

  // `how` is shown on the wall, so what the iPad actually allows is visible.
  return { awake, arm, how: awake && locked ? 'video + wake lock' : awake ? 'video' : locked ? 'wake lock' : null };
}

/**
 * Has a newer build been deployed? The page names its own bundle
 * (`/assets/index-<hash>.js`); the live index.html is asked every five minutes
 * and a different hash means a deploy has landed. Dev builds have no hashed
 * bundle, so nothing is ever claimed there.
 */
const BUNDLE_RE = /\/assets\/index-[\w-]+\.js/;
export function bundleIn(html) { const m = BUNDLE_RE.exec(String(html || '')); return m ? m[0] : null; }
function useNewVersion() {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const el = document.querySelector('script[src*="/assets/index-"]');
    const mine = el ? bundleIn(el.getAttribute('src')) : null;
    if (!mine) return undefined;
    let dead = false;
    const check = async () => {
      try {
        const res = await fetch(`/?v=${Date.now()}`, { cache: 'no-store' });
        const live = bundleIn(await res.text());
        if (!dead && live && live !== mine) setFresh(true);
      } catch { /* offline: say nothing */ }
    };
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return fresh;
}

/** A short, device-free line describing what holds the screen on. */
function keepAwakeReport(how) {
  try {
    const ios = (/OS (\d+)_(\d+)/.exec(navigator.userAgent || '') || []).slice(1, 3).join('.') || 'other';
    const where = navigator.standalone ? 'home-screen' : 'browser';
    return `${how || 'none'};${where};wakelock-api=${navigator.wakeLock ? 'yes' : 'no'};os=${ios};vw=${window.innerWidth}x${window.innerHeight}`;
  } catch { return how || 'none'; }
}

export default function Wall({ onExit, onSignedOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [wakeUntil, setWakeUntil] = useState(0);
  const bootDay = useRef(new Date().getDate());
  const { awake, arm, how } = useKeepAwake();
  const updateReady = useNewVersion();
  // What is keeping the screen on, sent with each poll (see /api/v/wall `held`).
  const heldRef = useRef('');
  heldRef.current = keepAwakeReport(how);
  // Today-first: the wall always starts on Today and returns there when left alone.
  const [view, setView] = useState('today');
  const [offset, setOffset] = useState(0);
  const lastTouch = useRef(Date.now());
  const range = calRange(view, offset, keyOf(now));
  const want = useRef(range);
  want.current = range;

  const refresh = useCallback(async () => {
    const r = want.current;
    try {
      const next = await api.wall(api.getToken(), { from: r.from, days: r.days, held: heldRef.current });
      // A slow answer for a range that has since been swiped away from is dropped.
      if (want.current.from !== r.from || want.current.days !== r.days) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (err.expired) return onSignedOut();
      setError(err.message);
    }
  }, [onSignedOut]);

  // A new range is fetched at once, not at the next minute's poll.
  useEffect(() => { refresh(); }, [range.from, range.days, refresh]);

  useEffect(() => {
    const poll = setInterval(refresh, POLL_MS);
    const tick = setInterval(() => {
      const t = new Date();
      setNow(t);
      // Left on another week or month, the wall comes back to now after three minutes untouched.
      if (Date.now() - lastTouch.current > IDLE_RETURN_MS) { setOffset((o) => (o === 0 ? o : 0)); setView((v) => (v === 'today' ? v : 'today')); }
      // A screen that is never closed never picks up a deploy. Reload once a
      // day in the small hours, while nobody is looking.
      if (t.getDate() !== bootDay.current && t.getHours() === 3) window.location.reload();
    }, 15 * 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  const look = api.getWallLook();
  // The cinema look also dims when nobody (no person) is positively home.
  const people = data && data.who && data.who.known ? (data.who.people || []).filter((p) => p.role !== 'companion') : [];
  const empty = look === 'cinema' && people.length > 0 && !people.some((p) => p.state === 'home');
  const dim = (isNight(now) || empty) && Date.now() > wakeUntil;
  const View = look === 'cinema' ? CinemaView : WallView;
  return (
    <div className={`wall-shell${dim ? ' wall-shell--dim' : ''}`}
         onClickCapture={(e) => {
           // The first tap on a dimmed wall only wakes it — it must not also press
           // whatever was under the finger in the dark.
           if (dim) { e.stopPropagation(); e.preventDefault(); }
           setWakeUntil(Date.now() + WAKE_MS);
           lastTouch.current = Date.now();
           // Every tap re-arms the keep-awake video (it can only start from one).
           if (!awake) arm();
         }}>
      <View data={data} now={now} error={error} onExit={onExit}
        cal={{
          view, offset, range,
          onStep: (n) => { lastTouch.current = Date.now(); setOffset((o) => o + n); },
          onToday: () => setOffset(0),
          onView: (v) => { lastTouch.current = Date.now(); setView(v); setOffset(0); },
        }} />
      <footer className="wall__foot">
        <span className="wall__awakeinfo">{how ? `Screen kept on: ${how}` : 'Screen not held on'}</span>
        {updateReady && (
          <button className="wall__update" onClick={() => window.location.reload()}>New version — tap to update</button>
        )}
        <button className="wall__refresh" onClick={() => { api.setWallLook(look === 'cinema' ? 'classic' : 'cinema'); window.location.reload(); }}>
          {look === 'cinema' ? 'Classic look' : 'Try new look'}
        </button>
        <button className="wall__refresh" onClick={() => window.location.reload()} aria-label="Refresh">↻ Refresh</button>
        <span className="wall__version">{`v ${api.BUILD_LABEL}`}</span>
      </footer>
      {!awake && (
        <button className="wall__awake" onClick={arm}>
          Tap once to keep this screen on
        </button>
      )}
    </div>
  );
}

// Shared with the cinema look (WallCinema.jsx), which reuses these unchanged.
export { Face, Calendar, dayOfKey, time, DAYS, MONTHS, DAYS_LONG, MONTHS_LONG, dueLabel, gbp };
export { CinemaView, presenceLine, nextLine, sunTimes, skyPhase, photoSlot, stripItems };
