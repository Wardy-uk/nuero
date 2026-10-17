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
            {energy.monthCostP != null && <p className="wall__etotal">Both this month ~{gbp(energy.monthCostP)} <span className="wall__note">estimated</span></p>}
          </>
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
            {can('energy') && <WallEnergy energy={data.energy} gap={gapFor('energy')} />}
            <Tasks tasks={data.tasks} gap={gapFor('tasks')} today={data.today} />
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

  const requestLock = useCallback(async () => {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible' && !lock.current) {
        lock.current = await navigator.wakeLock.request('screen');
        setLocked(true);
        lock.current.addEventListener('release', () => { lock.current = null; setLocked(false); });
      }
    } catch { /* refused — the video still covers it */ }
  }, []);

  const arm = useCallback(async () => {
    requestLock();
    try {
      if (!video.current) {
        const { webm, mp4 } = await import('nosleep.js/src/media.js');
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
      await video.current.play();
      setAwake(true);
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

export default function Wall({ onExit, onSignedOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [wakeUntil, setWakeUntil] = useState(0);
  const bootDay = useRef(new Date().getDate());
  const { awake, arm, how } = useKeepAwake();
  const updateReady = useNewVersion();

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
           // Every tap re-arms the keep-awake video (it can only start from one).
           if (!awake) arm();
         }}>
      <WallView data={data} now={now} error={error} onExit={onExit} />
      <footer className="wall__foot">
        <span className="wall__awakeinfo">{how ? `Screen kept on: ${how}` : 'Screen not held on'}</span>
        {updateReady && (
          <button className="wall__update" onClick={() => window.location.reload()}>New version — tap to update</button>
        )}
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
