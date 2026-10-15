import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import './Wall.css';

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

function Week({ week, today, gap }) {
  if (gap || !Array.isArray(week)) {
    return <section className="wall__week wall__week--gap"><Gap>I couldn&rsquo;t read the diary. That isn&rsquo;t an empty week &mdash; I couldn&rsquo;t look.</Gap></section>;
  }
  return (
    <section className="wall__week" aria-label="This week">
      {week.map((d) => {
        const { dow, day, month } = dayOfKey(d.date);
        return (
          <div key={d.date} className={`wall__day${d.date === today ? ' wall__day--today' : ''}${dow === 0 || dow === 6 ? ' wall__day--weekend' : ''}`}>
            <header className="wall__dayhead">
              <span className="wall__dow">{d.date === today ? 'Today' : DAYS[dow]}</span>
              <span className="wall__date">{`${day} ${MONTHS[month]}`}</span>
            </header>
            {d.events.length === 0
              ? <p className="wall__nothing">Nothing in</p>
              : (
                <ul className="wall__events">
                  {d.events.map((e, i) => (
                    <li key={`${e.id || i}-${d.date}`} className={`wall__event ${e.personal ? 'wall__event--personal' : 'wall__event--busy'}${e.allDay ? ' wall__event--allday' : ''}`}>
                      {!e.allDay && <span className="wall__time">{time(e.start)}</span>}
                      <span className="wall__title">{e.title}</span>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        );
      })}
    </section>
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
    <section className="wall__card" aria-label="Family tasks">
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
function Who({ who }) {
  if (!who) return null;
  return (
    <section className="wall__topcard" aria-label="Who's in">
      <h2 className="wall__h">Who&rsquo;s in</h2>
      {!who.known && <Gap>{who.why || "I can't see the house"} &mdash; that isn&rsquo;t the same as everyone being out.</Gap>}
      {Array.isArray(who.people) && who.people.length > 0 && (
        <ul className="wall__who">
          {who.people.map((p) => (
            <li key={p.name} className={`wall__person wall__person--${who.known ? p.state : 'unknown'}`}>
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

/** PURE view. Exported for the render test. */
export function WallView({ data, now, error = null, onExit = null }) {
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
          {can('calendar') && <Week week={data.week} today={data.today} gap={gapFor('week')} />}
          <aside className="wall__side">
            <Tasks tasks={data.tasks} gap={gapFor('tasks')} today={data.today} />
          </aside>
        </main>
      )}
    </div>
  );
}

/** Ask the browser to keep the screen on; re-asked whenever the page returns. */
function useWakeLock() {
  useEffect(() => {
    let lock = null;
    let dead = false;
    const ask = async () => {
      try {
        if (!dead && document.visibilityState === 'visible' && navigator.wakeLock) {
          lock = await navigator.wakeLock.request('screen');
        }
      } catch { /* not granted — Auto-Lock "Never" still covers it */ }
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => { dead = true; document.removeEventListener('visibilitychange', ask); try { lock && lock.release(); } catch { /* gone */ } };
  }, []);
}

export default function Wall({ onExit, onSignedOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [wakeUntil, setWakeUntil] = useState(0);
  const bootDay = useRef(new Date().getDate());
  useWakeLock();

  const refresh = useCallback(async () => {
    try {
      setData(await api.wall(api.getToken()));
      setError(null);
    } catch (err) {
      if (err.expired) return onSignedOut();
      setError(err.message);
    }
  }, [onSignedOut]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    const tick = setInterval(() => {
      const t = new Date();
      setNow(t);
      // A screen that is never closed never picks up a deploy. Reload once a
      // day in the small hours, while nobody is looking.
      if (t.getDate() !== bootDay.current && t.getHours() === 3) window.location.reload();
    }, 15 * 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [refresh]);

  const dim = isNight(now) && Date.now() > wakeUntil;
  return (
    <div className={`wall-shell${dim ? ' wall-shell--dim' : ''}`}
         onClickCapture={(e) => {
           // The first tap on a dimmed wall only wakes it — it must not also press
           // whatever was under the finger in the dark.
           if (dim) { e.stopPropagation(); e.preventDefault(); }
           setWakeUntil(Date.now() + WAKE_MS);
         }}>
      <WallView data={data} now={now} error={error} onExit={onExit} />
    </div>
  );
}
