import { useEffect, useState } from 'react';
import * as api from '../api';
import WalkMap from './WalkMap.jsx';

/**
 * Nick's last walk (2 Nov 2026) — the newest hike his watch tracked: the GPS
 * track, distance, time, ascent and his photos. Behind its OWN scope, `walks`
 * (never bundled with `hike`, which is the live tracker during an armed walk).
 *
 * The payload's `lastWalk`:
 *   • ABSENT  — no `walks` scope: nothing here is mounted (the callers check);
 *   • null    — no walk recorded yet, or (with a gap) it could not be read;
 *   • a walk  — already redacted by NEURO (services/vesta.householdWalk).
 *
 * ⚠ Times are wall-clock strings ("YYYY-MM-DDTHH:MM") and are SLICED, never
 *   parsed into a Date — re-parsing re-applies an offset (the BST bug).
 * ⚠ Photos are fetched as blobs: an <img> cannot send the bearer token.
 * ⚠ Deliberately imports nothing from views/ (Wall → WallCinema → here would
 *   be a cycle).
 */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** "Sun 2 Nov" from a "YYYY-MM-DD" key (built from its parts, never parsed). PURE. */
export function walkDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}

/** "9.5 km". PURE. */
export function walkDistance(m) { return isNum(m) ? `${(m / 1000).toFixed(1)} km` : null; }

/** "2 h 02", or "45 min" under an hour. PURE. */
export function walkDuration(s) {
  if (!isNum(s) || s <= 0) return null;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')}`;
}

/** "Sun 2 Nov · 9.5 km · 2 h 02 · 208 m up" — only the parts NEURO knows. PURE. */
export function walkSummary(walk) {
  if (!walk) return '';
  return [walkDay(walk.day), walkDistance(walk.distanceM), walkDuration(walk.durationSeconds), isNum(walk.ascentM) ? `${Math.round(walk.ascentM)} m up` : null]
    .filter(Boolean).join(' · ');
}

const hm = (local) => (local ? String(local).slice(11, 16) : null);

/** The track as a small SVG outline — no tiles, no network. For the wall's dock. */
export function TrackSketch({ line, size = 34 }) {
  const pts = Array.isArray(line) ? line.filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])) : [];
  if (pts.length < 2) {
    return <svg viewBox="0 0 24 24" width={size} height={size}><path d="M4 19c3-6 5-2 8-8s5-4 8-7" /></svg>;
  }
  const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * k); const ys = pts.map((p) => -p[0]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 2; const box = 24 - pad * 2;
  const ox = pad + (box - ((maxX - minX) / span) * box) / 2; const oy = pad + (box - ((maxY - minY) / span) * box) / 2;
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${(ox + ((x - minX) / span) * box).toFixed(2)} ${(oy + ((ys[i] - minY) / span) * box).toFixed(2)}`).join(' ');
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={d} /></svg>;
}

/** One photo of the walk, fetched with the token. Shows a quiet box until it arrives. */
export function WalkPhoto({ id, size = 'thumb', className = '', onClick = null, alt = 'A photo from the walk' }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let dead = false; let url = null;
    if (id && typeof window !== 'undefined') {
      api.walkPhotoUrl(api.getToken(), id, size).then((u) => {
        if (dead) { if (u) URL.revokeObjectURL(u); return; }
        url = u; setSrc(u);
      });
    }
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [id, size]);
  const img = src ? <img src={src} alt={alt} /> : <span className="lw__ph" aria-hidden="true" />;
  return onClick
    ? <button className={`lw__photo ${className}`} onClick={onClick} aria-label="Open the photo">{img}</button>
    : <span className={`lw__photo ${className}`}>{img}</span>;
}

const startPin = (walk) => (walk && walk.start ? [{ lat: walk.start.lat, lon: walk.start.lon, who: 'nick', label: 'Start', ago: hm(walk.startLocal) || '' }] : []);

/**
 * The phone's card (Home). The map is a picture here — pointer events off, so a
 * tap anywhere opens the sheet rather than panning a map in the middle of a page.
 */
export function LastWalkCard({ walk, gap = null, onOpen, MapView = WalkMap }) {
  if (walk === undefined) return null;
  if (walk === null) {
    return (
      <section className="lw lw--card" aria-label="Nick’s last walk">
        <h2 className="lw__h">Nick’s last walk</h2>
        <p className={gap ? 'section__gap' : 'lw__quiet'}>{gap ? 'I couldn’t read Nick’s last walk just now.' : 'No walk recorded yet.'}</p>
      </section>
    );
  }
  const thumbs = (walk.photos || []).slice(0, 6);
  return (
    <section className="lw lw--card" aria-label="Nick’s last walk">
      <button className="lw__open" onClick={onOpen} aria-label="Open Nick’s last walk">
        <span className="lw__h">Nick’s last walk</span>
        <span className="lw__title">{walk.title}</span>
        {MapView && walk.line && walk.line.length > 1 && (
          <span className="lw__map lw__map--still"><MapView trail={walk.line} positions={startPin(walk)} height={170} /></span>
        )}
        <span className="lw__line">{walkSummary(walk)}</span>
      </button>
      {thumbs.length > 0 && (
        <div className="lw__thumbs">
          {thumbs.map((p) => <WalkPhoto key={p.id} id={p.id} onClick={onOpen} />)}
          {walk.photos.length > thumbs.length && <span className="lw__more">{`+${walk.photos.length - thumbs.length}`}</span>}
        </div>
      )}
    </section>
  );
}

/** The sheet: the full map with photo pins, the figures, the weather, and the photos. */
export function LastWalkSheet({ walk, gap = null, MapView = WalkMap }) {
  const [big, setBig] = useState(null);
  if (walk === undefined || walk === null) {
    return <p className={gap ? 'cine__gap' : 'cine__sub'}>{gap ? 'I couldn’t read Nick’s last walk just now.' : 'No walk recorded yet.'}</p>;
  }
  if (big) {
    return (
      <div className="lw lw--big">
        <WalkPhoto id={big.id} size="full" className="lw__photo--big" alt={`A photo from the walk${big.takenLocal ? `, ${hm(big.takenLocal)}` : ''}`} />
        <button className="cine__sheetbtn" onClick={() => setBig(null)}>Back to the walk</button>
      </div>
    );
  }
  const pins = [...startPin(walk), ...(walk.photos || []).filter((p) => isNum(p.lat) && isNum(p.lon))
    .map((p) => ({ lat: p.lat, lon: p.lon, who: 'ember', label: 'Photo', ago: hm(p.takenLocal) || '' }))];
  const w = walk.weather;
  const facts = [
    ['Distance', walkDistance(walk.distanceM)],
    ['Time', walkDuration(walk.durationSeconds)],
    ['Climbed', isNum(walk.ascentM) ? `${Math.round(walk.ascentM)} m` : null],
    ['Highest', isNum(walk.highestM) ? `${walk.highestM} m` : null],
    ['Out', hm(walk.startLocal) && hm(walk.endLocal) ? `${hm(walk.startLocal)}–${hm(walk.endLocal)}` : null],
    ['Avg heart rate', isNum(walk.avgHr) ? `${walk.avgHr} bpm` : null],
  ].filter(([, v]) => v);
  return (
    <div className="lw lw--sheet">
      <p className="lw__title">{`${walk.title}${walkDay(walk.day) ? ` · ${walkDay(walk.day)}` : ''}${walk.companions && walk.companions.length ? ` · with ${walk.companions.join(' and ')}` : ''}`}</p>
      {MapView && walk.line && walk.line.length > 1 && (
        <div className="lw__map lw__map--full"><MapView trail={walk.line} positions={pins} height="100%" /></div>
      )}
      <dl className="lw__facts">
        {facts.map(([k, v]) => <div key={k} className="lw__fact"><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {w && (
        <p className="lw__weather">
          {[w.words, isNum(w.tempMinC) && isNum(w.tempMaxC) ? `${Math.round(w.tempMinC)}–${Math.round(w.tempMaxC)}°C` : null,
            isNum(w.rainMm) ? (w.rainMm > 0 ? `${w.rainMm} mm rain` : 'no rain') : null,
            isNum(w.windMaxMph) ? `wind to ${Math.round(w.windMaxMph)} mph` : null].filter(Boolean).join(' · ')}
        </p>
      )}
      {(walk.photos || []).length > 0 ? (
        <div className="lw__grid">
          {walk.photos.map((p) => <WalkPhoto key={p.id} id={p.id} onClick={() => setBig(p)} />)}
        </div>
      ) : <p className="cine__sub">No photos from this walk.</p>}
    </div>
  );
}
