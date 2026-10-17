import { useEffect, useRef, useState } from 'react';
import { Face, Calendar, dayOfKey, time, DAYS, DAYS_LONG, MONTHS_LONG, dueLabel, gbp, splitDay } from './Wall';
import { backgroundFor, cachedUrl, warmCache } from '../backgrounds';
import './WallCinema.css';

/**
 * The family wall, "cinema" look (17 Oct 2026) — the approved mockup: a large
 * clock over a landscape, who is home, the outside reading, then Today /
 * Tomorrow / Household jobs / Energy, and the next seven days along the bottom.
 *
 * ⚠ A VISUAL REDESIGN ONLY. Every value comes from the same /api/v/wall payload
 * the classic wall reads, redacted on the server exactly as before; nothing here
 * is invented. Where the mockup showed something NEURO does not hold (a weather
 * icon, "feels like", wind, daily forecasts) it is simply not drawn.
 * ⚠ Opt-in per device with ?look=cinema; ?look=classic goes back.
 */

/* ── The sky: a drawn landscape tinted by where the sun is ─────────────────── */

// A generic mid-England latitude/longitude, NOT the house: only used to place
// sunrise and sunset to within a few minutes. No home coordinates reach the client.
const LAT = 53.0;
const LON = -1.5;

/** Sunrise/sunset in local minutes-after-midnight for a date. PURE (NOAA approximation). */
export function sunTimes(date) {
  const rad = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const doy = Math.floor((date - start) / 86400000);
  const g = (2 * Math.PI / 365) * (doy - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * rad) / (Math.cos(LAT * rad) * Math.cos(decl))) - Math.tan(LAT * rad) * Math.tan(decl);
  const ha = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;
  const offset = -date.getTimezoneOffset();             // local offset in minutes (BST-aware)
  const noon = 720 - 4 * LON - eqt + offset;
  return { rise: noon - 4 * ha, set: noon + 4 * ha };
}

/** night | dawn | day | golden | dusk — from the clock and the sun. PURE. */
export function skyPhase(now) {
  const m = now.getHours() * 60 + now.getMinutes();
  const { rise, set } = sunTimes(now);
  if (m < rise - 45 || m > set + 50) return 'night';
  if (m < rise + 40) return 'dawn';
  if (m > set - 15) return 'dusk';
  if (m > set - 110) return 'golden';
  return 'day';
}

/** Which photograph: morning | day | evening | night. PURE. */
export function photoSlot(now) {
  const phase = skyPhase(now);
  if (phase === 'night') return 'night';
  if (phase === 'golden' || phase === 'dusk') return 'evening';
  if (phase === 'dawn' || now.getHours() < 11) return 'morning';
  return 'day';
}

/** The photograph for this time of day, over the drawn sky (which stays as the fallback). */
function Photo({ slot }) {
  const bg = backgroundFor(slot);
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let dead = false; let made = null;
    setUrl(null);
    if (bg && typeof window !== 'undefined') {
      cachedUrl(bg.src).then((u) => {
        if (dead) { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); return; }
        if (u && u.startsWith('blob:')) made = u;
        setUrl(u);
      });
    }
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [bg && bg.src]);
  useEffect(() => { if (typeof window !== 'undefined') warmCache(); }, []);
  if (!bg) return null;
  return (
    <>
      <div className={`cine__photo${bg.night ? ' cine__photo--night' : ''}${url ? ' cine__photo--in' : ''}`}
           style={url ? { backgroundImage: `url("${url}")` } : undefined} aria-hidden="true" />
      <div className="cine__scrim" aria-hidden="true" />
      <p className="cine__credit">{`${bg.place} · ${bg.credit} · ${bg.licence}`}</p>
    </>
  );
}

const SKIES = {
  night:  { top: '#05070d', mid: '#0b1220', low: '#141a28', sun: null, hills: ['#0b0f18', '#080b12', '#05070c', '#030407'], mist: 0.06 },
  dawn:   { top: '#1b2238', mid: '#6b4a5c', low: '#e2956a', sun: '#ffd2a0', hills: ['#3a2c33', '#2a1f26', '#1a1418', '#0e0b0d'], mist: 0.35 },
  day:    { top: '#3b5f85', mid: '#7f9fb8', low: '#c9d3d6', sun: '#fff6df', hills: ['#4d5a4c', '#3a4639', '#2a3329', '#1a2019'], mist: 0.25 },
  golden: { top: '#2a2a44', mid: '#a4573a', low: '#f0a050', sun: '#ffd79a', hills: ['#5a3524', '#3d2519', '#271811', '#140c08'], mist: 0.4 },
  dusk:   { top: '#120f22', mid: '#5b2c3a', low: '#d06a3c', sun: '#ffb070', hills: ['#2e1c1e', '#211415', '#150d0e', '#0a0607'], mist: 0.3 },
};

function Sky({ phase }) {
  const s = SKIES[phase] || SKIES.day;
  // Static SVG — nothing animates, so it costs nothing while the wall is on.
  return (
    <svg className="cine__sky" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="cineSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={s.top} />
          <stop offset="0.45" stopColor={s.mid} />
          <stop offset="0.72" stopColor={s.low} />
        </linearGradient>
        <radialGradient id="cineSun" cx="0.72" cy="0.52" r="0.35">
          <stop offset="0" stopColor={s.sun || 'transparent'} stopOpacity={s.sun ? 0.9 : 0} />
          <stop offset="1" stopColor={s.sun || 'transparent'} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cineMist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity={s.mist} />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="cineShade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.15" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.75" />
        </linearGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#cineSky)" />
      {phase === 'night' && [[180, 90], [420, 160], [700, 70], [980, 140], [1260, 60], [1450, 180], [560, 240], [1120, 260], [300, 300]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="#dfe6ff" opacity="0.7" />
      ))}
      <rect width="1600" height="1000" fill="url(#cineSun)" />
      <path d="M0 560 C 180 500, 320 520, 480 470 S 820 430, 980 470 S 1300 520, 1600 480 L1600 1000 L0 1000Z" fill={s.hills[0]} />
      <rect x="0" y="470" width="1600" height="160" fill="url(#cineMist)" />
      <path d="M0 640 C 220 590, 380 620, 560 580 S 900 560, 1100 600 S 1420 640, 1600 600 L1600 1000 L0 1000Z" fill={s.hills[1]} />
      <rect x="0" y="590" width="1600" height="120" fill="url(#cineMist)" opacity="0.7" />
      <path d="M0 730 C 200 690, 420 720, 620 690 S 1000 660, 1220 700 S 1480 730, 1600 700 L1600 1000 L0 1000Z" fill={s.hills[2]} />
      <path d="M0 820 C 260 780, 520 810, 780 790 S 1260 770, 1600 800 L1600 1000 L0 1000Z" fill={s.hills[3]} />
      <rect width="1600" height="1000" fill="url(#cineShade)" />
    </svg>
  );
}

/* ── Small line icons (stroke only, so they tint with the text) ──────────── */
const I = {
  cal: <svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>,
  tools: <svg viewBox="0 0 24 24"><path d="M14.5 4.5a4 4 0 0 0 4.9 5.2l-8.6 8.6a2 2 0 1 1-2.8-2.8l8.6-8.6" /><path d="M4 5l3 3M7 4l-3 3" /></svg>,
  bolt: <svg viewBox="0 0 24 24"><path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z" /></svg>,
  plug: <svg viewBox="0 0 24 24"><path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" /></svg>,
  flame: <svg viewBox="0 0 24 24"><path d="M12 21a6 6 0 0 1-6-6c0-4 4-6 4-10 3 2 4 4 4 6 1-1 1.5-2 1.5-3 2 2 2.5 4 2.5 7a6 6 0 0 1-6 6z" /></svg>,
  drop: <svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /></svg>,
  gauge: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 12l4-3" /></svg>,
  chevron: <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>,
};
const Icon = ({ name, className = '' }) => <span className={`cine__icon ${className}`} aria-hidden="true">{I[name]}</span>;

/* ── Words derived from the payload (never invented) ───────────────────────── */
const PART_OF_DAY = (h) => (h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night');

/** "Everyone's home" etc. PURE. Exported for tests. */
export function presenceLine(who) {
  if (!who || !who.known) return "Can't see who's home";
  const people = (who.people || []).filter((p) => p.role !== 'companion');
  const home = people.filter((p) => p.state === 'home');
  if (!people.length) return '';
  if (home.length === people.length) return 'Everyone’s home';
  if (!home.length) return 'Nobody’s home';
  const names = home.map((p) => p.name);
  return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are` : `${names[0]} is`} home`;
}

/** The line under it: the next thing today, or that the rest of the day is clear. PURE. */
export function nextLine(day, now) {
  const part = PART_OF_DAY(now.getHours());
  if (!day) return '';
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const { rows } = splitDay(day, hm);
  const live = rows.find((r) => r.now);
  if (live) return `Now: ${live.e.title}`;
  const next = rows.find((r) => !r.past);
  if (next) return `Next: ${next.e.title} at ${time(next.e.start)}`;
  return `A quiet ${part}`;
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function Presence({ who }) {
  if (!who) return null;
  if (!who.known) return <p className="cine__gap">{who.why || "I can't see the house"} — that isn’t the same as everyone being out.</p>;
  return (
    <ul className="cine__people">
      {(who.people || []).map((p) => (
        <li key={p.id || p.name} className={`cine__person cine__person--${p.state}`}>
          <span className="cine__avatar"><Face person={p} /><span className="cine__dot" /></span>
          <span className="cine__pname">{p.name}</span>
          <span className="cine__pstate">{p.state === 'home' ? 'Home' : p.state === 'out' ? 'Out' : 'Not sure'}</span>
        </li>
      ))}
    </ul>
  );
}

const trendWord = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : null);

function Outside({ station }) {
  if (!station) return null;
  if (!station.known) {
    return <div className="cine__outside"><p className="cine__gap">{station.why || 'the weather station could not be read'}.</p></div>;
  }
  return (
    <div className="cine__outside" aria-label="Outside">
      <div className="cine__temp">{station.tempC != null ? `${station.tempC.toFixed(1)}°` : '—'}</div>
      <div className="cine__odetail">
        <p className="cine__otrend">{station.tendency ? `Pressure ${station.tendency}` : 'Outside'}</p>
        <ul className="cine__orows">
          {station.humidityPct != null && <li><Icon name="drop" /> {`${station.humidityPct}% humidity`}</li>}
          {station.pressureHpa != null && <li><Icon name="gauge" /> {`${station.pressureHpa} hPa`}</li>}
        </ul>
        {station.indoorLikely && <p className="cine__note">The sensor reads like it’s indoors.</p>}
      </div>
    </div>
  );
}

function DayCard({ day, title, now, onOpen, emptyLine }) {
  const head = (
    <button className="cine__phead" onClick={onOpen} aria-label={`Open the calendar from ${title}`}>
      <Icon name="cal" className={title === 'Today' ? 'cine__icon--amber' : 'cine__icon--rose'} />
      <span className="cine__ptitle">{title}</span>
      <Icon name="chevron" className="cine__chev" />
    </button>
  );
  if (!day) return <section className="cine__panel">{head}<p className="cine__gap">I couldn’t read the diary.</p></section>;
  const { allDay, rows, nextId } = splitDay(day, now ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` : null);
  const empty = !allDay.length && !rows.length && !day.work && !day.off;
  return (
    <section className="cine__panel" aria-label={title}>
      {head}
      <div className="cine__pbody cine__scroll">
        {empty ? (
          <>
            <p className="cine__big">{emptyLine}</p>
            <p className="cine__sub">No plans in the diary</p>
          </>
        ) : (
          <>
            {allDay.map((e, i) => <p key={`${e.id || i}-a`} className="cine__chip">{e.title}</p>)}
            {day.off && <p className="cine__work cine__work--off">Nick off</p>}
            {day.work && <p className="cine__work">{day.work.allDay ? 'Nick at work' : `Nick at work · ${time(day.work.start)}–${time(day.work.end)}`}</p>}
            <ul className="cine__events">
              {rows.map(({ e, past, now: on }, i) => (
                <li key={`${e.id || i}-t`} className={`cine__event${past ? ' cine__event--past' : ''}${on || (e.id || e.start) === nextId ? ' cine__event--next' : ''}`}>
                  <span className="cine__etime">{time(e.start)}</span>
                  <span className="cine__ewhat">{e.title}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/** One job as a card. The wording is the task's own, shown on two lines at most — never rewritten. */
function JobItem({ t, today }) {
  const due = dueLabel(t, today);
  return (
    <li className={`cine__job${t.overdue ? ' cine__job--late' : ''}`}>
      <span className="cine__jtext">{t.text}</span>
      <span className="cine__jmeta">
        {due && <span className={t.overdue ? 'cine__late' : t.dueToday ? 'cine__soon' : ''}>{t.overdue ? 'Overdue' : t.dueToday ? 'Due today' : `Due ${due}`}</span>}
        {t.who.length > 0 && <span className="cine__jwho">{t.who.join(' & ')}</span>}
      </span>
    </li>
  );
}

// Every tile scrolls (Nick, 17 Oct 2026): the jobs list shows them all and
// scrolls inside the tile; the header opens the full-screen list.
function Jobs({ tasks, gap, today, onOpen }) {
  const list = tasks ? tasks.tasks : [];
  const clickable = list.length > 0;
  return (
    <section className="cine__panel cine__panel--jobs" aria-label="Household jobs">
      <button className="cine__phead" onClick={clickable ? onOpen : undefined} aria-label="Open all household jobs">
        <Icon name="tools" className="cine__icon--amber" />
        <span className="cine__ptitle">Household jobs</span>
        {clickable && <Icon name="chevron" className="cine__chev" />}
      </button>
      {gap || !tasks ? <p className="cine__gap">I couldn’t read the jobs list.</p>
        : list.length === 0 ? <div className="cine__pbody"><p className="cine__big">Nothing to do</p></div>
        : (
          <ul className="cine__jobs cine__scroll">
            {list.map((t) => <JobItem key={t.id} t={t} today={today} />)}
          </ul>
        )}
    </section>
  );
}

const FUEL = { electricity: { name: 'Electricity', icon: 'plug' }, gas: { name: 'Gas', icon: 'flame' } };

function Energy({ energy, gap }) {
  const fuels = energy ? Object.entries(energy.fuels || {}) : [];
  return (
    <section className="cine__panel" aria-label="Energy">
      <div className="cine__phead cine__phead--static">
        <Icon name="bolt" className="cine__icon--amber" />
        <span className="cine__ptitle">Energy</span>
      </div>
      {gap || !energy ? <p className="cine__gap">I couldn’t read the meters.</p>
        : !fuels.length ? <div className="cine__pbody"><p className="cine__sub">{energy.connected ? 'Waiting for the first readings.' : 'Meters not connected yet.'}</p></div>
        : (
          <div className="cine__fuels cine__scroll">
            {fuels.map(([fuel, f]) => {
              const y = f.yesterday;
              const late = f.freshness && f.freshness.state !== 'usual' && f.freshness.state !== 'none';
              return (
                <div key={fuel} className="cine__fuel">
                  <Icon name={(FUEL[fuel] || {}).icon || 'bolt'} className="cine__ficon" />
                  <div className="cine__fbody">
                    <span className="cine__fline">
                      <span className="cine__fname">{(FUEL[fuel] || {}).name || fuel}</span>
                      <span className="cine__fval">{y && y.kwh != null ? `${y.kwh.toFixed(1)} kWh` : '—'}</span>
                    </span>
                    <span className="cine__fmonth">
                      {`${y && y.kwh != null && !y.complete ? 'Yesterday so far' : 'Yesterday'}${y && y.costP != null ? ` ~${gbp(y.costP)}` : ''} · this month ${f.month && f.month.kwh != null ? `${Math.round(f.month.kwh)} kWh` : '—'}${f.month && f.month.costP != null ? ` ~${gbp(f.month.costP)}` : ''}`}
                      {late && <span className="cine__late"> · meter running late</span>}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

/** Labels for a strip day: two short ones, or one on up to two lines and a count. PURE. */
export function stripItems(events) {
  // Every label is shown (the day scrolls); each may take two lines.
  const labels = (events || []).map((e) => (e.allDay ? e.title : `${time(e.start)} ${e.title}`));
  return { shown: labels, twoLine: true, more: 0 };
}

/**
 * The days ahead: eight showing, swipe sideways for the rest of the six weeks.
 * Left alone for three minutes it scrolls back to today.
 */
const STRIP_IDLE_MS = 3 * 60 * 1000;
function NextDays({ week, today, onOpen, onDay }) {
  const box = useRef(null);
  const idle = useRef(null);
  const onScroll = () => {
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { if (box.current) box.current.scrollTo({ left: 0, behavior: 'smooth' }); }, STRIP_IDLE_MS);
  };
  useEffect(() => () => clearTimeout(idle.current), []);
  if (!Array.isArray(week)) return <section className="cine__strip"><p className="cine__gap">I couldn’t read the diary.</p></section>;
  return (
    <section className="cine__strip" aria-label="Days ahead">
      <div className="cine__striphead"><Icon name="cal" /><span>Coming up</span></div>
      <div className="cine__sdays" ref={box} onScroll={onScroll}>
        {week.map((d) => {
          const { dow, day } = dayOfKey(d.date);
          const items = (d.events || []);
          return (
            <div key={d.date} className={`cine__sday${d.date === today ? ' cine__sday--today' : ''}`}>
              <button className="cine__sdaybtn" onClick={() => (onDay ? onDay(d) : onOpen && onOpen())} aria-label={`Open ${DAYS_LONG[dow]}`}>
                <span className="cine__sdow">{`${DAYS[dow]} ${day}`}</span>
                <span className={`cine__smark${d.off ? ' cine__smark--off' : ''}`}>{d.off ? 'Nick off' : d.work ? 'Nick at work' : ' '}</span>
              </button>
              <div className="cine__sitems cine__scroll">
                {stripItems(items).shown.map((l, i) => <span key={i} className="cine__sitem cine__sitem--two">{l}</span>)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A sheet over the wall: every job, or one day in full. Tap outside or Done to close. */
function Sheet({ sheet, data, onClose, onOpenWeek }) {
  if (!sheet) return null;
  let title = ''; let body = null;
  if (sheet.kind === 'jobs') {
    const list = (data && data.tasks && data.tasks.tasks) || [];
    title = `Household jobs · ${list.length}`;
    body = <ul className="cine__jobs cine__jobs--all">{list.map((t) => <JobItem key={t.id} t={t} today={data.today} />)}</ul>;
  } else if (sheet.kind === 'day') {
    const d = sheet.day; const { dow, day, month } = dayOfKey(d.date);
    title = `${DAYS_LONG[dow]} ${day} ${MONTHS_LONG[month]}`;
    const events = d.events || [];
    body = (
      <div className="cine__daysheet">
        {d.off && <p className="cine__work cine__work--off">Nick off</p>}
        {d.work && <p className="cine__work">{d.work.allDay ? 'Nick at work' : `Nick at work · ${time(d.work.start)}–${time(d.work.end)}`}</p>}
        {events.length === 0 && !d.off && !d.work && <p className="cine__sub">Nothing in the diary</p>}
        <ul className="cine__events cine__events--full">
          {events.map((e, i) => (
            <li key={`${e.id || i}`} className="cine__event cine__event--full">
              <span className="cine__etime">{e.allDay ? 'All day' : `${time(e.start)}${e.end ? `–${time(e.end)}` : ''}`}</span>
              <span className="cine__ewhat cine__ewhat--full">{e.title}</span>
            </li>
          ))}
        </ul>
        <button className="cine__sheetbtn" onClick={onOpenWeek}>Open the week</button>
      </div>
    );
  }
  return (
    <div className="cine__sheetwrap" onClick={onClose}>
      <section className="cine__sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="cine__sheethead">
          <span className="cine__ptitle">{title}</span>
          <button className="cine__sheetbtn" onClick={onClose}>Done</button>
        </header>
        {body}
      </section>
    </div>
  );
}

/** PURE view. Exported for the render test. */
export function CinemaView({ data, now, error = null, onExit = null, cal = null }) {
  const gapFor = (b) => ((data && data.gaps) || []).find((g) => g.block === b)?.why || null;
  const can = (s) => ((data && data.scopes) || []).includes(s);
  const phase = skyPhase(now);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const [sheet, setSheet] = useState(null);
  // A sheet left open closes itself after two minutes, like the rest of the wall.
  useEffect(() => { if (!sheet) return undefined; const t = setTimeout(() => setSheet(null), 2 * 60 * 1000); return () => clearTimeout(t); }, [sheet]);
  const overlay = cal && cal.view !== 'today';
  const open = () => cal && cal.onView && cal.onView('week');
  // The panels read the seven days from today; while another range is loading
  // (or the calendar overlay holds a month) they are not drawn from it.
  const fresh = data && (!cal || (data.from === cal.range.from && data.days === cal.range.days));
  const week = fresh && can('calendar') ? data.week : null;
  return (
    <div className={`cine cine--${phase}`}>
      <Sky phase={phase} />
      <Photo slot={photoSlot(now)} />
      {overlay ? (
        <div className="cine__overlay">
          <Calendar data={data} gap={gapFor('week')} cal={cal} now={now} />
        </div>
      ) : (
        <div className="cine__layout">
          <header className="cine__top">
            <div className="cine__left">
              <div className="cine__clock">{`${hh}:${mm}`}</div>
              <div className="cine__date">{`${DAYS_LONG[now.getDay()]} ${now.getDate()} ${MONTHS_LONG[now.getMonth()]}`}</div>
              <span className="cine__rule" />
              {data && can('house') && <h1 className="cine__headline">{presenceLine(data.who)}</h1>}
              {week && <p className="cine__subline">{nextLine(week[0], now)}</p>}
              {data && can('house') && <Presence who={data.who} />}
            </div>
            {data && can('house') && <Outside station={data.station} />}
          </header>
          {error && <p className="cine__stale" role="status">Can’t reach home — showing what I last had.</p>}
          {!data ? <p className="cine__loading">Getting things…</p> : (
            <>
              <div className={`cine__panels${can('energy') ? '' : ' cine__panels--three'}`}>
                {can('calendar') && <DayCard day={week && week[0]} title="Today" now={now} onOpen={open} emptyLine="Nothing planned today" />}
                {can('calendar') && <DayCard day={week && week[1]} title="Tomorrow" onOpen={open} emptyLine="A quiet day" />}
                <Jobs tasks={data.tasks} gap={gapFor('tasks')} today={data.today} onOpen={() => setSheet({ kind: 'jobs' })} />
                {can('energy') && <Energy energy={data.energy} gap={gapFor('energy')} />}
              </div>
              {can('calendar') && <NextDays week={week} today={data.today} onOpen={open} onDay={(d) => setSheet({ kind: 'day', day: d })} />}
            </>
          )}
        </div>
      )}
      {!overlay && <Sheet sheet={sheet} data={data} onClose={() => setSheet(null)} onOpenWeek={() => { setSheet(null); open(); }} />}
      {onExit && <button className="cine__exit" onClick={onExit} aria-label="Leave wall view">⋯</button>}
    </div>
  );
}
