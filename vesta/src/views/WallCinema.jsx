import { useEffect, useRef, useState } from 'react';
import { Face, Calendar, dayOfKey, time, DAYS, DAYS_LONG, MONTHS_LONG, dueLabel, gbp, splitDay } from './Wall';
import { backgroundFor, cachedUrl, warmCache, weatherCategory, steadyChoice, nextSlot, decodeImage, FALLBACK_SRC, backgroundReport, logBackground, imageBySrc } from '../backgrounds';
import { JobSheet, AddJobSheet, AllJobsSheet, MemberSheet, WeatherSheet, EnergySheet, SheetBoundary, EventSheet } from './WallSheets';
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

/**
 * night | dawn | day | golden | dusk. PURE. With `sun` ({elevation, rising})
 * from Home Assistant at the house, the real sun decides; without it, a
 * generic mid-England sunrise/sunset calculation.
 */
export function skyPhase(now, sun = null) {
  if (sun && typeof sun.elevation === 'number') {
    const e = sun.elevation;
    if (e < -4) return 'night';
    if (sun.rising && e < 6) return 'dawn';
    if (!sun.rising && e < 2) return 'dusk';
    if (!sun.rising && e < 10) return 'golden';
    return 'day';
  }
  const m = now.getHours() * 60 + now.getMinutes();
  const { rise, set } = sunTimes(now);
  if (m < rise - 45 || m > set + 50) return 'night';
  if (m < rise + 40) return 'dawn';
  if (m > set - 15) return 'dusk';
  if (m > set - 110) return 'golden';
  return 'day';
}

/** Which photograph: morning | day | evening | night. PURE. */
export function photoSlot(now, sun = null) {
  const phase = skyPhase(now, sun);
  if (phase === 'night') return 'night';
  if (phase === 'golden' || phase === 'dusk') return 'evening';
  if (phase === 'dawn' || now.getHours() < 11) return 'morning';
  return 'day';
}

/**
 * The photograph for this time of day and weather, over the drawn sky (which
 * stays as the fallback). The weather is Home Assistant's observed condition;
 * a weather-only change is held 30 minutes (`steadyChoice`) so it never flickers.
 */
function Photo({ slot, condition }) {
  const weather = weatherCategory(condition);
  const wanted = backgroundFor(slot, weather);
  const provisional = !weather;
  const [shown, setShown] = useState(() => (wanted ? { bg: { ...wanted, slot, provisional }, slot, at: Date.now() } : null));
  useEffect(() => {
    if (!wanted) return;
    setShown((cur) => steadyChoice(cur, { ...wanted, slot, provisional }, Date.now()));
  }, [slot, wanted && wanted.src, wanted && wanted.night, provisional]);
  // Re-check once a minute so a held weather change lands after its 30 minutes.
  useEffect(() => {
    const t = setInterval(() => { const wc = weatherCategory(condition); const w = backgroundFor(slot, wc); if (w) setShown((cur) => steadyChoice(cur, { ...w, slot, provisional: !wc }, Date.now())); }, 60 * 1000);
    return () => clearInterval(t);
  }, [slot, condition]);
  const bg = shown ? shown.bg : wanted;
  // Two layers: the new photo loads underneath and fades in over the old, so a
  // change never flashes back to the drawn sky.
  const [layers, setLayers] = useState([]);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  // ⚠ A photo is added ONLY once it has loaded and decoded. A failure keeps the
  // last good photo on screen; with none yet, the known-working sunset is used.
  // So a failed request can never leave the wall dark (17 Oct 2026 regression).
  useEffect(() => {
    if (!bg || typeof window === 'undefined') return undefined;
    let dead = false;
    // Each layer carries its OWN credit, so the attribution always names the
    // photograph actually on screen (the fallback included).
    const add = (src, url, night, id, state, meta) => {
      if (dead) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
      backgroundReport.id = id; backgroundReport.state = state;
      setLayers((cur) => {
        if (cur.length && cur[cur.length - 1].src === src && cur[cur.length - 1].night === night) return cur;
        return [...cur.slice(-1), { src, url, night, nightPhoto: Boolean(meta && meta.nightPhoto), place: meta && meta.place, credit: meta && meta.credit, licence: meta && meta.licence, key: `${src}|${night}|${Date.now()}` }];
      });
    };
    (async () => {
      try {
        const u = await cachedUrl(bg.src);
        await decodeImage(u);
        add(bg.src, u, bg.night, bg.id, 'ok', bg);
      } catch (e) {
        logBackground('load', bg.src, e, layersRef.current.length ? 'kept the last photo' : FALLBACK_SRC);
        if (dead) return;
        if (layersRef.current.length) { backgroundReport.state = `kept-last-after-${bg.id}-failed`; return; }
        try {
          const u = await cachedUrl(FALLBACK_SRC);
          await decodeImage(u);
          // Darkened whenever it stands in at night (the failed photo may have been a true night photo).
          add(FALLBACK_SRC, u, slot === 'night', 'fallback-sunset', `fallback-after-${bg.id}-failed`, imageBySrc(FALLBACK_SRC));
        } catch (e2) {
          logBackground('fallback', FALLBACK_SRC, e2, 'drawn sky');
          backgroundReport.state = 'no-photo-drawn-sky';
        }
      }
    })();
    return () => { dead = true; };
  }, [bg && bg.src, bg && bg.night]);
  // Drop the layer underneath once the new one has faded in.
  useEffect(() => {
    if (layers.length < 2) return undefined;
    const t = setTimeout(() => setLayers((cur) => {
      const gone = cur.slice(0, -1);
      for (const g of gone) if (g.url && g.url.startsWith('blob:')) URL.revokeObjectURL(g.url);
      return cur.slice(-1);
    }), 1600);
    return () => clearTimeout(t);
  }, [layers]);
  // Preload the next time of day's photo for this weather (only that one).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = backgroundFor(nextSlot(slot), weather);
    warmCache([bg && bg.src, next && next.src]);
  }, [slot, weather, bg && bg.src]);
  if (!bg) return null;
  return (
    <>
      {layers.map((l, i) => (
        <PhotoLayer key={l.key} layer={l} top={i === layers.length - 1} />
      ))}
      <div className="cine__scrim" aria-hidden="true" />
      {layers.length > 0 && layers[layers.length - 1].credit && (
        <p className="cine__credit">{`${layers[layers.length - 1].place} · ${layers[layers.length - 1].credit} · ${layers[layers.length - 1].licence}`}</p>
      )}
    </>
  );
}

/** One photograph layer: mounts transparent, fades in on the next frame. */
function PhotoLayer({ layer, top }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setOn(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <div className={`cine__photo${layer.night ? ' cine__photo--night' : ''}${layer.nightPhoto ? ' cine__photo--nightphoto' : ''}${on ? ' cine__photo--in' : ''}${top ? ' cine__photo--top' : ''}`}
         style={{ backgroundImage: `url("${layer.url}")` }} aria-hidden="true" />
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
  dew: <svg viewBox="0 0 24 24"><path d="M9 4s4 4.3 4 7.3a4 4 0 0 1-8 0C5 8.3 9 4 9 4z" /><path d="M16.5 11s2.5 2.7 2.5 4.6a2.5 2.5 0 0 1-5 0c0-1.9 2.5-4.6 2.5-4.6z" /></svg>,
  chevron: <svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" /></svg>,
  sun: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>,
  moon: <svg viewBox="0 0 24 24"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" /></svg>,
  cloud: <svg viewBox="0 0 24 24"><path d="M7 18.5h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6.9 9.6 4.5 4.5 0 0 0 7 18.5z" /></svg>,
  partly: <svg viewBox="0 0 24 24"><path d="M8.5 7.5a3.5 3.5 0 0 1 6.3-1.4M10.5 2.5v1.4M4.6 5l1 1M3 9.5h1.4" /><path d="M8 19.5h9a3.5 3.5 0 0 0 .5-6.97A4.8 4.8 0 0 0 8.2 12 3.8 3.8 0 0 0 8 19.5z" /></svg>,
  rain: <svg viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6.9 6.1 4.5 4.5 0 0 0 7 15z" /><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5" /></svg>,
  snow: <svg viewBox="0 0 24 24"><path d="M7 15h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6.9 6.1 4.5 4.5 0 0 0 7 15z" /><path d="M9 18.5h.01M12 20.5h.01M15 18.5h.01" /></svg>,
  storm: <svg viewBox="0 0 24 24"><path d="M7 14h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6.9 5.1 4.5 4.5 0 0 0 7 14z" /><path d="M12.5 15.5l-2 3.5h3l-2 3.5" /></svg>,
  fog: <svg viewBox="0 0 24 24"><path d="M4 9.5h16M3 13h18M5 16.5h14M7 20h10" /></svg>,
  wind: <svg viewBox="0 0 24 24"><path d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a2.5 2.5 0 1 1-2.5 2.5M3 17h8" /></svg>,
};

/** Home Assistant's condition id → one of the icons above. Unknown → none. PURE. */
export function weatherIcon(condition) {
  const c = String(condition || '').toLowerCase();
  if (!c) return null;
  if (c === 'sunny') return 'sun';
  if (c === 'clear-night') return 'moon';
  if (c === 'partlycloudy') return 'partly';
  if (c === 'cloudy') return 'cloud';
  if (c === 'rainy' || c === 'pouring') return 'rain';
  if (c === 'snowy' || c === 'snowy-rainy' || c === 'hail') return 'snow';
  if (c === 'lightning' || c === 'lightning-rainy') return 'storm';
  if (c === 'fog') return 'fog';
  if (c === 'windy' || c === 'windy-variant') return 'wind';
  return null;
}
const Icon = ({ name, className = '' }) => <span className={`cine__icon ${className}`} aria-hidden="true">{I[name]}</span>;

/**
 * Dew point from the station's own temperature and relative humidity (Magnus
 * formula, Alduchov & Eskridge constants). PURE; null without both readings.
 */
export function dewPoint(tempC, humidityPct) {
  if (typeof tempC !== 'number' || typeof humidityPct !== 'number' || humidityPct <= 0 || humidityPct > 100) return null;
  const a = 17.625; const b = 243.04;
  const g = Math.log(humidityPct / 100) + (a * tempC) / (b + tempC);
  return (b * g) / (a - g);
}

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

function Presence({ who, onPerson }) {
  if (!who) return null;
  if (!who.known) return <p className="cine__gap">{who.why || "I can't see the house"} — that isn’t the same as everyone being out.</p>;
  return (
    <ul className="cine__people">
      {(who.people || []).map((p) => (
        <li key={p.id || p.name} className={`cine__person cine__person--${p.state}`}>
          <button className="cine__personbtn" onClick={() => onPerson && onPerson(p)} aria-label={`${p.name}: ${p.state === 'home' ? 'home' : p.state === 'out' ? 'out' : 'not sure'}`}>
            <span className="cine__avatar"><Face person={p} /><span className="cine__dot" /></span>
            <span className="cine__pname">{p.name}</span>
            <span className="cine__pstate">{p.state === 'home' ? 'Home' : p.state === 'out' ? 'Out' : 'Not sure'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const trendWord = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : null);

function Outside({ station, onOpen }) {
  if (!station) return null;
  if (!station.known) {
    return <div className="cine__outside"><p className="cine__gap">{station.why || 'the weather station could not be read'}.</p></div>;
  }
  return (
    <div className="cine__outside cine__tap" aria-label="Outside — tap for details" role="button" tabIndex={0} onClick={onOpen}>
      {weatherIcon(station.condition) && (
        <span className="cine__wicon" role="img" aria-label={station.conditionLabel || station.condition} title={station.conditionLabel || ''}>
          {I[weatherIcon(station.condition)]}
        </span>
      )}
      <div className="cine__temp">{station.tempC != null ? `${station.tempC.toFixed(1)}°` : '—'}</div>
      <div className="cine__odetail">
        <p className="cine__otrend">{station.tendency ? `Pressure ${station.tendency}` : 'Outside'}</p>
        <ul className="cine__orows">
          {station.humidityPct != null && <li><Icon name="drop" /> {`${station.humidityPct}% humidity`}</li>}
          {dewPoint(station.tempC, station.humidityPct) != null && <li><Icon name="dew" /> {`Dew point ${dewPoint(station.tempC, station.humidityPct).toFixed(1)}°`}</li>}
          {station.pressureHpa != null && <li><Icon name="gauge" /> {`${station.pressureHpa} hPa`}</li>}
        </ul>
        {station.indoorLikely && <p className="cine__note">The sensor reads like it’s indoors.</p>}
      </div>
    </div>
  );
}

function DayCard({ day, title, now, onOpen, emptyLine, onEvent }) {
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
            {allDay.map((e, i) => <p key={`${e.id || i}-a`} className={`cine__chip${onEvent ? ' cine__evtap' : ''}`} onClick={onEvent ? () => onEvent(e, day.date) : undefined}>{e.title}</p>)}
            {day.off && <p className="cine__work cine__work--off">Nick off</p>}
            {day.work && <p className="cine__work">{day.work.allDay ? 'Nick at work' : `Nick at work · ${time(day.work.start)}–${time(day.work.end)}`}</p>}
            <ul className="cine__events">
              {rows.map(({ e, past, now: on }, i) => (
                <li key={`${e.id || i}-t`} className={`cine__event${past ? ' cine__event--past' : ''}${on || (e.id || e.start) === nextId ? ' cine__event--next' : ''}${onEvent ? ' cine__evtap' : ''}`}
                    onClick={onEvent ? () => onEvent(e, day.date) : undefined}>
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

/**
 * One job as a card. On the tile it shows the short label (`t.short`, made for
 * display by the server — the task itself is untouched); `full` shows the task's
 * own wording, as in the sheet.
 */
function JobItem({ t, today, full = false, onTap = null }) {
  const due = dueLabel(t, today);
  const Tag = onTap ? 'button' : 'li';
  const inner = (
    <>
      <span className={`cine__jtext${full ? ' cine__jtext--full' : ''}`}>{full ? t.text : (t.short || t.text)}</span>
      <span className="cine__jmeta">
        {due && <span className={t.overdue ? 'cine__late' : t.dueToday ? 'cine__soon' : ''}>{t.overdue ? 'Overdue' : t.dueToday ? 'Due today' : `Due ${due}`}</span>}
        {full && t.who.length > 0 && <span className="cine__jwho">{t.who.join(' & ')}</span>}
      </span>
    </>
  );
  if (onTap) return <li className="cine__jobwrap"><button className={`cine__job cine__jobbtn${t.overdue ? ' cine__job--late' : ''}`} onClick={onTap}>{inner}</button></li>;
  return <Tag className={`cine__job${t.overdue ? ' cine__job--late' : ''}`}>{inner}</Tag>;
}

// Two jobs and a count (Nick, iteration 3); a job opens its full wording, the
// header and the count open them all.
const JOBS_SHOWN = 2;
function Jobs({ tasks, gap, today, onOpen, onJob }) {
  const list = tasks ? tasks.tasks : [];
  const clickable = list.length > 0;
  const total = tasks ? Math.max(tasks.total || 0, list.length) : 0;
  const more = total - Math.min(list.length, JOBS_SHOWN);
  return (
    <section className="cine__panel cine__panel--jobs" aria-label="Household jobs">
      <button className="cine__phead" onClick={onOpen} aria-label="Open all household jobs">
        <Icon name="tools" className="cine__icon--amber" />
        <span className="cine__ptitle">Household jobs</span>
        {more > 0 && <span className="cine__headmore">{`+${more} more`}</span>}
        {clickable && more <= 0 && <Icon name="chevron" className="cine__chev" />}
      </button>
      {gap || !tasks ? <p className="cine__gap">I couldn’t read the jobs list.</p>
        : list.length === 0 ? <div className="cine__pbody"><p className="cine__big">Nothing to do</p></div>
        : (
          <>
            <ul className="cine__jobs">
              {list.slice(0, JOBS_SHOWN).map((t) => <JobItem key={t.id} t={t} today={today} onTap={() => onJob && onJob(t)} />)}
            </ul>

          </>
        )}
    </section>
  );
}

const FUEL = { electricity: { name: 'Electricity', icon: 'plug' }, gas: { name: 'Gas', icon: 'flame' } };

function Energy({ energy, gap, onOpen }) {
  const fuels = energy ? Object.entries(energy.fuels || {}) : [];
  return (
    <section className="cine__panel" aria-label="Energy">
      <button className="cine__phead" onClick={onOpen} aria-label="Open energy details">
        <Icon name="bolt" className="cine__icon--amber" />
        <span className="cine__ptitle">Energy yesterday</span>
        <Icon name="chevron" className="cine__chev" />
      </button>
      {gap || !energy ? <p className="cine__gap">I couldn’t read the meters.</p>
        : !fuels.length ? <div className="cine__pbody"><p className="cine__sub">{energy.connected ? 'Awaiting meter data' : 'Meters not connected yet'}</p></div>
        : !fuels.some(([, f]) => (f.yesterday && f.yesterday.kwh != null) || (f.month && f.month.kwh != null))
          ? <div className="cine__pbody"><p className="cine__sub">Awaiting meter data</p></div>
        : (
          <div className="cine__fuels cine__scroll">
            {fuels.filter(([, f]) => (f.yesterday && f.yesterday.kwh != null) || (f.month && f.month.kwh != null)).map(([fuel, f]) => {
              const y = f.yesterday;
              const late = f.freshness && f.freshness.state !== 'usual' && f.freshness.state !== 'none';
              return (
                <div key={fuel} className="cine__fuel">
                  <Icon name={(FUEL[fuel] || {}).icon || 'bolt'} className="cine__ficon" />
                  <div className="cine__fbody">
                    <span className="cine__fline">
                      <span className="cine__fname">{(FUEL[fuel] || {}).name || fuel}</span>
                      <span className="cine__fval">{y && y.kwh != null ? `${y.kwh.toFixed(1)} kWh` : '—'}{y && y.costP != null && <small>{` ~${gbp(y.costP)}`}</small>}</span>
                    </span>
                    <span className="cine__fmonth">
                      {`This month ${f.month && f.month.kwh != null ? `${Math.round(f.month.kwh)} kWh` : '—'}${f.month && f.month.costP != null ? ` · ~${gbp(f.month.costP)}` : ''}`}
                      {y && y.kwh != null && !y.complete && <span> · yesterday so far</span>}
                      {late && <span className="cine__late"> · running late</span>}
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
    idle.current = setTimeout(() => { if (box.current) box.current.scrollLeft = 0; }, STRIP_IDLE_MS);
  };
  const [away, setAway] = useState(false);
  useEffect(() => () => clearTimeout(idle.current), []);
  // A new day starts the strip on today again.
  useEffect(() => { if (box.current) box.current.scrollLeft = 0; setAway(false); }, [today]);
  // An instant jump: a smooth scroll fights the day-snapping and stops short.
  const back = () => { if (box.current) { box.current.scrollLeft = 0; setAway(false); } };
  if (!Array.isArray(week)) return <section className="cine__strip"><p className="cine__gap">I couldn’t read the diary.</p></section>;
  return (
    <section className="cine__strip" aria-label="Days ahead">
      <div className="cine__striphead">
        <Icon name="cal" />
        {away ? <button className="cine__backtoday" onClick={back}>‹ Back to today</button> : <span>Coming up</span>}
      </div>
      <div className="cine__sdays" ref={box} onScroll={(e) => { setAway(e.currentTarget.scrollLeft > 8); onScroll(); }}>
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
function Sheet({ sheet, data, onClose, onOpenWeek, act, setSheet, dirty, setDirty }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setConfirm(false); }, [sheet]);
  // The last version of the open job NEURO returned, so a job that has just been
  // completed (and has left the list) still shows its latest details.
  const lastJob = useRef(null);
  if (!sheet) return null;
  const close = () => { if (dirty) { setConfirm(true); return; } onClose(); };
  const list = (data && data.tasks && data.tasks.tasks) || [];
  const people = (data && data.people) || [];
  const fam = (data && data.familyCalendar) || { canEdit: false, why: null };
  let title = ''; let body = null; let top = false;
  if (sheet.kind === 'jobs') {
    title = `Household jobs \u00b7 ${list.length}`;
    body = act
      ? <AllJobsSheet tasks={data.tasks} done={data.doneTasks || []} today={data.today} act={act} onOpenJob={(t) => setSheet({ kind: 'job', task: t })} onAdd={() => setSheet({ kind: 'add' })} />
      : <ul className="cine__jobs cine__jobs--all">{list.map((t) => <JobItem key={t.id} t={t} today={data.today} full />)}</ul>;
  } else if (sheet.kind === 'job') {
    title = 'Household job';
    // The LIVE task after each re-read; the snapshot only once it has gone (done).
    const found = list.find((t) => t.id === sheet.task.id);
    if (found) lastJob.current = found;
    const live = found || (lastJob.current && lastJob.current.id === sheet.task.id ? lastJob.current : sheet.task);
    body = act
      ? <JobSheet task={live} people={people} today={data.today} act={act} onDone={onClose} setDirty={setDirty} />
      : <ul className="cine__jobs cine__jobs--all"><JobItem t={live} today={data.today} full /></ul>;
  } else if (sheet.kind === 'add' && act) {
    title = 'New household job'; top = true;
    body = <AddJobSheet people={people} today={data.today} act={act} prefill={sheet.prefill || ''} setDirty={setDirty}
                        onSaved={() => setSheet({ kind: 'jobs' })} onCancel={() => { setDirty(false); onClose(); }} />;
  } else if (sheet.kind === 'member') {
    title = sheet.person.name;
    body = <MemberSheet person={sheet.person} tasks={data.tasks} today={data.today} onOpenJob={(t) => setSheet({ kind: 'job', task: t })}
                        onAddFor={(p) => setSheet({ kind: 'add', prefill: p.role === 'companion' ? `${p.name}: ` : '' })} />;
  } else if (sheet.kind === 'weather') {
    title = 'Outside';
    body = <WeatherSheet station={data.station} dew={data.station ? dewPoint(data.station.tempC, data.station.humidityPct) : null} />;
  } else if (sheet.kind === 'energy') {
    title = 'Energy';
    body = <EnergySheet energy={data.energy} />;
  } else if ((sheet.kind === 'event' || sheet.kind === 'addEvent') && act && act.event) {
    title = sheet.kind === 'addEvent' ? 'New family event' : 'Event';
    top = true;
    body = <EventSheet event={sheet.kind === 'event' ? sheet.event : null} date={sheet.date} today={data.today} act={act}
                       canEdit={fam.canEdit} why={fam.why} setDirty={setDirty} onDone={() => { setDirty(false); onClose(); }} />;
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
            <li key={`${e.id || i}`} className="cine__event cine__event--full cine__evtap" onClick={() => setSheet({ kind: 'event', event: e, date: d.date })}>
              <span className="cine__etime">{e.allDay ? 'All day' : `${time(e.start)}${e.end ? `–${time(e.end)}` : ''}`}</span>
              <span className="cine__ewhat cine__ewhat--full">{e.title}</span>
            </li>
          ))}
        </ul>
        <div className="cine__dayfoot">
          <button className="cine__sheetbtn" onClick={onOpenWeek}>Open the week</button>
          {fam.canEdit && <button className="cine__sheetbtn cine__sheetbtn--primary" onClick={() => setSheet({ kind: 'addEvent', date: d.date })}>+ Add event</button>}
        </div>
      </div>
    );
  }
  return (
    <div className={`cine__sheetwrap${top ? ' cine__sheetwrap--top' : ''}`} onClick={close}>
      <section className="cine__sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="cine__sheethead">
          <span className="cine__ptitle">{title}</span>
          <button className="cine__sheetbtn" onClick={close} aria-label="Close">Close</button>
        </header>
        {confirm && (
          <div className="cine__confirm" role="alertdialog" aria-label="Discard changes?">
            <span>{sheet.kind === 'add' ? 'Discard this new job?' : 'Discard your changes?'}</span>
            <button className="cine__sheetbtn" onClick={() => setConfirm(false)}>Keep editing</button>
            <button className="cine__sheetbtn cine__sheetbtn--danger" onClick={() => { setDirty(false); onClose(); }}>Discard</button>
          </div>
        )}
        {body}
      </section>
    </div>
  );
}

/** PURE view. Exported for the render test. */
// `fusion` (22 Oct 2026, SAiM's room screens): `field` is her presence, drawn
// between the photograph and the panels; `line` is the one thing she says,
// under the date; `card` is what she offers (a room to warm, a light). VESTA's
// own wall passes none of them and is unchanged.
export function CinemaView({ data, now, error = null, onExit = null, cal = null, act = null, fusion = null }) {
  const gapFor = (b) => ((data && data.gaps) || []).find((g) => g.block === b)?.why || null;
  const can = (s) => ((data && data.scopes) || []).includes(s);
  const phase = skyPhase(now, data && data.sun);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const [sheet, setSheet] = useState(null);
  const [dirty, setDirty] = useState(false);
  // A sheet left open closes itself after two minutes, like the rest of the wall —
  // never while it holds unsaved work.
  useEffect(() => { if (!sheet || dirty) return undefined; const t = setTimeout(() => setSheet(null), 2 * 60 * 1000); return () => clearTimeout(t); }, [sheet, dirty]);
  const overlay = cal && cal.view !== 'today';
  const open = () => cal && cal.onView && cal.onView('week');
  // The panels read the seven days from today; while another range is loading
  // (or the calendar overlay holds a month) they are not drawn from it.
  const fresh = data && (!cal || (data.from === cal.range.from && data.days === cal.range.days));
  const week = fresh && can('calendar') ? data.week : null;
  return (
    <div className={`cine cine--${phase}`}>
      <Sky phase={phase} />
      <Photo slot={photoSlot(now, data && data.sun)} condition={data && data.station ? data.station.condition : null} />
      {fusion && fusion.field ? <div className="cine__saimfield" aria-hidden="true">{fusion.field}</div> : null}
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
              {fusion && fusion.line ? <p className="cine__saimline">{fusion.line}</p> : null}
              {data && can('house') && <h1 className="cine__headline">{presenceLine(data.who)}</h1>}
              {week && <p className="cine__subline">{nextLine(week[0], now)}</p>}
              {data && can('house') && <Presence who={data.who} onPerson={(p) => setSheet({ kind: 'member', person: p })} />}
            </div>
            {data && can('house') && <Outside station={data.station} onOpen={() => setSheet({ kind: 'weather' })} />}
          </header>
          {fusion && fusion.card ? <div className="cine__saimcard">{fusion.card}</div> : null}
          {error && <p className="cine__stale" role="status">Can’t reach home — showing what I last had.</p>}
          {!data ? <p className="cine__loading">Getting things…</p> : (
            <>
              <div className={`cine__panels${can('energy') ? '' : ' cine__panels--three'}`}>
                {can('calendar') && <DayCard day={week && week[0]} title="Today" now={now} onOpen={open} emptyLine="Nothing planned today" onEvent={(e, date) => setSheet({ kind: 'event', event: e, date })} />}
                {can('calendar') && <DayCard day={week && week[1]} title="Tomorrow" onOpen={open} emptyLine="A quiet day" onEvent={(e, date) => setSheet({ kind: 'event', event: e, date })} />}
                <Jobs tasks={data.tasks} gap={gapFor('tasks')} today={data.today} onOpen={() => setSheet({ kind: 'jobs' })} onJob={(t) => setSheet({ kind: 'job', task: t })} />
                {can('energy') && <Energy energy={data.energy} gap={gapFor('energy')} onOpen={() => setSheet({ kind: 'energy' })} />}
              </div>
              {can('calendar') && <NextDays week={week} today={data.today} onOpen={open} onDay={(d) => setSheet({ kind: 'day', day: d })} />}
            </>
          )}
        </div>
      )}
      {!overlay && sheet && (
        <SheetBoundary key={sheet.kind} onFail={() => { setDirty(false); setSheet(null); }}>
          <Sheet sheet={sheet} data={data} act={act} setSheet={setSheet} dirty={dirty} setDirty={setDirty}
                 onClose={() => { setDirty(false); setSheet(null); }} onOpenWeek={() => { setSheet(null); open(); }} />
        </SheetBoundary>
      )}
      {onExit && <button className="cine__exit" onClick={onExit} aria-label="Leave wall view">⋯</button>}
    </div>
  );
}
