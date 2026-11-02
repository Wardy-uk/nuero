// Formatting for the workout page (2 Nov 2026). Pure: no React, no fetch.
// Times arrive as London wall-clock strings ("2026-11-02T09:42") and are
// SLICED, never parsed — re-parsing re-applies an offset (the BST bug).

export const km = (m, dp = 2) => (m == null ? '—' : `${(m / 1000).toFixed(dp)} km`);
export const metres = (m) => (m == null ? '—' : `${Math.round(m)} m`);

export function hm(sec) {
  if (sec == null) return '—';
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

export function mmss(sec) {
  if (sec == null) return '—';
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

export const pace = (sec) => (sec == null ? '—' : `${mmss(sec)} /km`);
export const clock = (local) => (local ? String(local).slice(11, 16) : '—');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Monday 2 November 2026" from "2026-11-02" — by the calendar, not a timezone. */
export function longDay(day) {
  if (!day) return '';
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function shortDay(day) {
  if (!day) return '';
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}

/** London wall-clock "HH:MM" for a unix second, via Intl (never the host clock). */
export function londonTime(t) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t * 1000));
  } catch { return ''; }
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => (deg == null ? '' : COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);

/** "from home and back", "from Curbar Edge car park to near Baslow". */
export function whereWords(places) {
  const s = places && places.start; const e = places && places.end;
  const word = (p) => (p.home ? 'home' : p.name);
  if (!s || !s.name) return e && e.name ? `to ${word(e)}` : '';
  const from = s.home ? 'from home' : `from ${s.name}`;
  if (!e || !e.name) return from;
  return word(e) === word(s) ? `${from} and back` : `${from} to ${word(e)}`;
}

/** The profile point nearest a unix second — what a chart hover puts on the map. */
export function pointAt(profile, t) {
  if (!profile || !profile.length || t == null) return null;
  let best = profile[0];
  for (const p of profile) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best;
}
