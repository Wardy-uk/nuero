'use strict';

/**
 * Hike safety — the pure half (10 Oct 2026). No DB, no network, no clock: every
 * function takes what it needs, so the rules pin without a phone or a hill.
 *
 *   gridRef(lat, lon)     WGS84 → Ordnance Survey grid reference (8 figures,
 *                         ~10 m). Mountain rescue in Britain works in grid refs.
 *   localToMs / msToLocal  Europe/London wall clock ↔ epoch ms.
 *   validateTrip           what arming a walk needs, refused (never clamped).
 *   plan(trip, now)        which steps are due: remind / warn / alert / track.
 *   modeOf(fix)            still / walking / fast / driving / unknown from speed.
 *   routeCard / alertEmail / allClearEmail   the words, composed once.
 *
 * ⚠ The alert states FACTS. It never says Nick is hurt or lost; it says he set a
 *   time, the time has passed, and here is where he was last seen and when.
 * ⚠ A fix is shown with its AGE and its source. Nothing is merged into one
 *   confident dot: three trackers that disagree are three facts.
 */

const TIMEZONE = process.env.NEURO_TIMEZONE || 'Europe/London';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const DEFAULT_GRACE_MIN = 60;
const GRACE_RANGE = [15, 240];
const WARN_BEFORE_MIN = 30;
const TRACK_LEAD_MIN = 15;          // start tracking a little before the planned start
const TRACK_AFTER_DEADLINE_H = 12;  // keep the trail going after an alert — that is when it matters
const DRIVING_AFTER_START_MIN = 30; // driving to the start is not "back at the car"
const MAX_TRIP_HOURS = 36;
const MAX_ARM_AHEAD_DAYS = 14;
const EXTEND_RANGE = [15, 240];

// ── time ───────────────────────────────────────────────────────────────────

function msToLocal(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "2026-10-11T09:30" (Europe/London wall clock) → epoch ms, or null if not a real minute. */
function localToMs(s) {
  const m = LOCAL_RE.exec(String(s || ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const candidate = guess - (Date.parse(`${msToLocal(guess)}:00Z`) - guess);
  for (const ms of [candidate, candidate - HOUR, candidate + HOUR]) if (msToLocal(ms) === s) return ms;
  return null; // a minute the clock skips (the spring-forward hour), or 31 Feb
}

const hhmm = (ms) => msToLocal(ms).slice(11, 16);
function dayWords(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
}
function ago(ms, nowMs) {
  const m = Math.max(0, Math.round((nowMs - ms) / MIN));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}

// ── Ordnance Survey grid reference ─────────────────────────────────────────
// The standard conversion: WGS84 → cartesian → Helmert to OSGB36 (Airy 1830)
// → Transverse Mercator on the National Grid. Accurate to a few metres, which
// is well inside an 8-figure (10 m) reference.

const D2R = Math.PI / 180;

function _toCartesian(lat, lon, a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const p = lat * D2R; const l = lon * D2R;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  return [nu * Math.cos(p) * Math.cos(l), nu * Math.cos(p) * Math.sin(l), (1 - e2) * nu * Math.sin(p)];
}

function _fromCartesian([x, y, z], a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i += 1) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const next = Math.atan2(z + e2 * nu * Math.sin(phi), p);
    if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
    phi = next;
  }
  return { lat: phi / D2R, lon: Math.atan2(y, x) / D2R };
}

function _wgs84ToOsgb36(lat, lon) {
  const [x1, y1, z1] = _toCartesian(lat, lon, 6378137, 6356752.314245);
  const s = 20.4894e-6;
  const sec = D2R / 3600;
  const rx = -0.1502 * sec; const ry = -0.2470 * sec; const rz = -0.8421 * sec;
  const x2 = -446.448 + x1 * (1 + s) - y1 * rz + z1 * ry;
  const y2 = 125.157 + x1 * rz + y1 * (1 + s) - z1 * rx;
  const z2 = -542.060 - x1 * ry + y1 * rx + z1 * (1 + s);
  return _fromCartesian([x2, y2, z2], 6377563.396, 6356256.909);
}

/** Easting/northing on the National Grid, or null outside Great Britain. */
function osgbEN(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 49.8 || lat > 61 || lon < -8.7 || lon > 2.1) return null;
  const { lat: la, lon: lo } = _wgs84ToOsgb36(lat, lon);
  const a = 6377563.396; const b = 6356256.909; const F0 = 0.9996012717;
  const phi0 = 49 * D2R; const lam0 = -2 * D2R; const N0 = -100000; const E0 = 400000;
  const e2 = 1 - (b * b) / (a * a); const n = (a - b) / (a + b);
  const phi = la * D2R; const lam = lo * D2R;
  const sin = Math.sin(phi); const cos = Math.cos(phi); const tan = Math.tan(phi);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const eta2 = nu / rho - 1;
  const dp = phi - phi0; const sp = phi + phi0;
  const Ma = (1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * dp;
  const Mb = (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(dp) * Math.cos(sp);
  const Mc = ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) * Math.sin(2 * dp) * Math.cos(2 * sp);
  const Md = (35 / 24) * n ** 3 * Math.sin(3 * dp) * Math.cos(3 * sp);
  const M = b * F0 * (Ma - Mb + Mc - Md);
  const I = M + N0;
  const II = (nu / 2) * sin * cos;
  const III = (nu / 24) * sin * cos ** 3 * (5 - tan ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sin * cos ** 5 * (61 - 58 * tan ** 2 + tan ** 4);
  const IV = nu * cos;
  const V = (nu / 6) * cos ** 3 * (nu / rho - tan ** 2);
  const VI = (nu / 120) * cos ** 5 * (5 - 18 * tan ** 2 + tan ** 4 + 14 * eta2 - 58 * tan ** 2 * eta2);
  const dl = lam - lam0;
  const N = I + II * dl ** 2 + III * dl ** 4 + IIIA * dl ** 6;
  const E = E0 + IV * dl + V * dl ** 3 + VI * dl ** 5;
  if (!(E >= 0 && E < 700000 && N >= 0 && N < 1300000)) return null;
  return { e: E, n: N };
}

/** "NY 2155 0723" — 8 figures, a 10 m square. null outside Great Britain. */
function gridRef(lat, lon) {
  const en = osgbEN(lat, lon);
  if (!en) return null;
  const e100k = Math.floor(en.e / 100000); const n100k = Math.floor(en.n / 100000);
  let l1 = (19 - n100k) - ((19 - n100k) % 5) + Math.floor((e100k + 10) / 5);
  let l2 = (((19 - n100k) * 5) % 25) + (e100k % 5);
  if (l1 > 7) l1 += 1; // the grid has no I
  if (l2 > 7) l2 += 1;
  const letters = String.fromCharCode(65 + l1) + String.fromCharCode(65 + l2);
  const pad = (v) => String(Math.floor((v % 100000) / 10)).padStart(4, '0');
  return `${letters} ${pad(en.e)} ${pad(en.n)}`;
}

const mapsLink = (lat, lon) => `https://www.google.com/maps?q=${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;

/** Where a point is, in the forms a person on the phone to rescue can use. */
function placeLine(lat, lon) {
  const g = gridRef(lat, lon);
  return `${g ? `grid ref ${g} · ` : ''}${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)} · ${mapsLink(lat, lon)}`;
}

// ── validation ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

/** Contacts as stored: [{ name, email }]. Refused, never cleaned up silently. */
function validateContacts(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 5) return { error: 'between one and five people to alert' };
  const out = [];
  for (const c of list) {
    const name = c && typeof c.name === 'string' ? c.name.trim() : '';
    const email = c && typeof c.email === 'string' ? c.email.trim().toLowerCase() : '';
    if (!name || name.length > 60) return { error: 'each person needs a name (up to 60 characters)' };
    if (!EMAIL_RE.test(email) || email.length > 200) return { error: `"${c && c.email}" is not an email address` };
    if (out.some((x) => x.email === email)) return { error: `${email} is listed twice` };
    out.push({ name, email });
  }
  return { contacts: out };
}

const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,19}$/;

/** Who else is walking: [{ name, phone? }], up to 8. Refused, never cleaned up silently. */
function validateParty(list) {
  if (list === undefined || list === null) return { party: [] };
  if (!Array.isArray(list) || list.length > 8) return { error: 'up to eight people walking with you' };
  const out = [];
  for (const p of list) {
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    const phone = p && typeof p.phone === 'string' ? p.phone.trim() : '';
    if (!name && !phone) continue; // an empty row on the form, not a person
    if (!name || name.length > 60) return { error: 'each person walking needs a name (up to 60 characters)' };
    if (phone && !PHONE_RE.test(phone)) return { error: `"${phone}" is not a phone number` };
    out.push(phone ? { name, phone } : { name });
  }
  return { party: out };
}

/** "Nick Ward with Dave Smith (07700 900123), Sam and Ember (dog)" */
function walkersLine({ walker = 'Nick Ward', party = [], ember = false, companion = null }) {
  const others = party.map((p) => (p.phone ? `${p.name} (${p.phone})` : p.name));
  if (ember) others.push(`${companion || 'Ember'} (dog)`);
  if (!others.length) return walker;
  return `${walker} with ${others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}`}`;
}

/**
 * What arming a walk needs. Times are local wall clock ("YYYY-MM-DDTHH:MM").
 * Returns { fields } or { error }.
 */
function validateTrip(b, { nowMs }) {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 120)) return { error: 'name must be up to 120 characters' };
  const startMs = localToMs(b.plannedStart);
  const finishMs = localToMs(b.plannedFinish);
  if (startMs == null) return { error: 'plannedStart must be a local time like 2026-10-11T09:30' };
  if (finishMs == null) return { error: 'plannedFinish must be a local time like 2026-10-11T15:00' };
  if (finishMs <= startMs) return { error: 'the planned finish must be after the planned start' };
  if (finishMs - startMs > MAX_TRIP_HOURS * HOUR) return { error: `a walk can be armed for up to ${MAX_TRIP_HOURS} hours` };
  if (finishMs <= nowMs) return { error: 'the planned finish has already passed' };
  if (startMs > nowMs + MAX_ARM_AHEAD_DAYS * 24 * HOUR) return { error: `a walk can be armed up to ${MAX_ARM_AHEAD_DAYS} days ahead` };
  let grace = DEFAULT_GRACE_MIN;
  if (b.graceMinutes !== undefined && b.graceMinutes !== null) {
    grace = Number(b.graceMinutes);
    if (!Number.isInteger(grace) || grace < GRACE_RANGE[0] || grace > GRACE_RANGE[1]) return { error: `graceMinutes must be a whole number from ${GRACE_RANGE[0]} to ${GRACE_RANGE[1]}` };
  }
  if (b.notes !== undefined && b.notes !== null && (typeof b.notes !== 'string' || b.notes.length > 1000)) return { error: 'notes must be text up to 1000 characters' };
  if (b.emberPlanned !== undefined && typeof b.emberPlanned !== 'boolean') return { error: 'emberPlanned must be true or false' };
  const pv = validateParty(b.party);
  if (pv.error) return { error: pv.error };
  return { fields: { name, startMs, finishMs, grace, notes: b.notes ? b.notes.trim() : null, ember: b.emberPlanned === true, party: pv.party } };
}

// ── what is due ────────────────────────────────────────────────────────────

/** The time he said he would be back, and the time the alert goes. */
function times(trip) {
  const dueMs = trip.extendedUntilMs || trip.finishMs;
  return { dueMs, deadlineMs: dueMs + trip.graceMin * MIN };
}

/**
 * Pure. Which steps are due now for one trip. Each fires once (its own stamp),
 * except `alert`, which repeats until an email is CONFIRMED sent — a duplicate
 * alert costs far less than none.
 */
function plan(trip, nowMs) {
  const out = { remind: false, warn: false, alert: false, track: false };
  if (!['armed', 'alerted'].includes(trip.status)) return out;
  const { dueMs, deadlineMs } = times(trip);
  out.track = nowMs >= trip.startMs - TRACK_LEAD_MIN * MIN && nowMs <= deadlineMs + TRACK_AFTER_DEADLINE_H * HOUR;
  if (trip.status !== 'armed') { out.alert = !['sent', 'confirmed'].includes(trip.alertStatus); return out; }
  out.remind = nowMs >= dueMs && !trip.remindedAt;
  const warnAt = Math.max(dueMs, deadlineMs - WARN_BEFORE_MIN * MIN);
  out.warn = nowMs >= warnAt && nowMs < deadlineMs && !trip.warnedAt && warnAt > dueMs;
  out.alert = nowMs >= deadlineMs;
  return out;
}

// ── movement ───────────────────────────────────────────────────────────────

/**
 * How he was moving. Life360's own `driving` flag wins; otherwise speed (km/h):
 * under 0.8 still, to 7 walking, to 20 "fast" (running, cycling or slow traffic
 * — NEURO cannot tell which and says so), above that driving.
 */
function modeOf({ speedKmh = null, driving = null } = {}) {
  if (driving === true) return 'driving';
  if (!Number.isFinite(speedKmh)) return 'unknown';
  if (speedKmh < 0.8) return 'still';
  if (speedKmh <= 7) return 'walking';
  if (speedKmh < 20) return 'fast';
  return 'driving';
}

const MODE_WORDS = { still: 'not moving', walking: 'walking pace', fast: 'faster than walking (running, cycling or slow traffic)', driving: 'driving speed', unknown: 'speed not known' };

function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * D2R; const dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Speed between two fixes from one source, or null when the pair cannot support one. */
function speedBetween(prev, cur) {
  if (!prev || !cur) return null;
  const dt = (cur.observedMs - prev.observedMs) / 1000;
  if (!(dt >= 30 && dt <= 30 * 60)) return null;
  const d = haversineM(prev, cur);
  const noise = (prev.accuracyM || 0) + (cur.accuracyM || 0);
  if (d <= noise) return 0;
  return Math.round(((d - noise) / dt) * 3.6 * 10) / 10;
}

/**
 * Pure. One Home Assistant tracker state → a fix, or null when it has no
 * position. The observation time is the tracker's own (Life360's last_seen),
 * never when NEURO happened to read it.
 */
function fixFromState(s, { role }) {
  if (!s || !s.attributes) return null;
  const a = s.attributes;
  const lat = Number(a.latitude); const lon = Number(a.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const observedMs = Date.parse(a.last_seen || s.last_updated || '');
  if (!Number.isFinite(observedMs)) return null;
  const speed = Number(a.speed);
  return {
    source: s.entity_id, role, lat, lon, observedMs,
    accuracyM: Number.isFinite(Number(a.gps_accuracy)) ? Math.round(Number(a.gps_accuracy)) : null,
    speedKmh: Number.isFinite(speed) && speed >= 0 ? speed : null,
    driving: typeof a.driving === 'boolean' ? a.driving : null,
    battery: Number.isFinite(Number(a.battery_level)) ? Number(a.battery_level) : null,
  };
}

/** Has he been driving lately? Two of his own fixes at driving pace in 15 min, after the walk started. */
function drivingLately(fixes, { trip, nowMs }) {
  const since = Math.max(trip.startMs + DRIVING_AFTER_START_MIN * MIN, nowMs - 15 * MIN);
  return fixes.filter((f) => f.role === 'nick' && f.observedMs >= since && f.mode === 'driving').length >= 2;
}

// ── the words ──────────────────────────────────────────────────────────────

const LABELS = { nick: 'Nick’s phone', ember: 'Ember’s collar tracker' };
function sourceLabel(entityId, role) {
  if (role === 'ember') return LABELS.ember;
  if (/life360/.test(entityId)) return 'Nick’s phone (Life360)';
  return 'Nick’s phone (Home Assistant app)';
}

/** The route card, frozen when the walk is armed. Plain text — it has to survive any mail client. */
function routeCard({ name, walker = 'Nick Ward', startMs, finishMs, graceMin, route = null, ember = false, companion = null, party = [], vehicle = null, notes = null, gpxName = null }) {
  const deadlineMs = finishMs + graceMin * MIN;
  const lines = [
    `ROUTE CARD — ${name}`,
    '',
    `${party.length ? 'Walkers' : 'Walker'}: ${walkersLine({ walker, party, ember, companion })}`,
    ...(party.length ? [`Party: ${party.length + 1} people${ember ? ' and a dog' : ''}`] : []),
    `Date: ${dayWords(startMs)}`,
    `Planned start: ${hhmm(startMs)} · planned finish: about ${hhmm(finishMs)}${dayWords(finishMs) !== dayWords(startMs) ? ` on ${dayWords(finishMs)}` : ''}`,
    `Alert sent if he has not checked in by: ${hhmm(deadlineMs)}`,
  ];
  if (route) {
    const facts = [route.distanceKm != null ? `${route.distanceKm} km` : null, route.elevationGainM != null ? `${route.elevationGainM} m of ascent` : null].filter(Boolean);
    if (facts.length) lines.push(`Route: ${facts.join(', ')}`);
    const g = route.geometry || [];
    if (g.length) {
      const [sLat, sLon] = g[0]; const [fLat, fLon] = g[g.length - 1];
      const loop = haversineM({ lat: sLat, lon: sLon }, { lat: fLat, lon: fLon }) < 300;
      lines.push('', `Start${vehicle ? ' (where the car is parked)' : ''}: ${placeLine(sLat, sLon)}`);
      lines.push(loop ? 'Finish: back at the start (a loop)' : `Finish: ${placeLine(fLat, fLon)}`);
      if (route.highest) lines.push(`Highest point: ${route.highest.ele} m — ${placeLine(route.highest.lat, route.highest.lon)}`);
      if (g.length >= 8) {
        lines.push('Along the route:');
        for (const [label, f] of [['a quarter of the way', 0.25], ['halfway', 0.5], ['three quarters', 0.75]]) {
          const [la, lo] = g[Math.round((g.length - 1) * f)];
          lines.push(`  ${label}: ${placeLine(la, lo)}`);
        }
      }
    }
  }
  if (vehicle) lines.push('', `Car: ${vehicle}`);
  if (notes) lines.push('', `Notes: ${notes}`);
  if (gpxName) lines.push('', `The route file (${gpxName}) is attached — it opens in OS Maps, AllTrails, Google Earth and most walking apps.`);
  return lines.join('\n');
}

function _positions(fixes, { nowMs }) {
  const latest = new Map();
  for (const f of fixes) { const cur = latest.get(f.source); if (!cur || f.observedMs > cur.observedMs) latest.set(f.source, f); }
  return [...latest.values()].sort((a, b) => (a.role === b.role ? b.observedMs - a.observedMs : a.role === 'nick' ? -1 : 1)).map((f) => {
    const bits = [`${sourceLabel(f.source, f.role)}, ${hhmm(f.observedMs)} (${ago(f.observedMs, nowMs)})`];
    bits.push(`  ${placeLine(f.lat, f.lon)}`);
    const extra = [f.accuracyM != null ? `accurate to about ${f.accuracyM} m` : null, f.mode && f.mode !== 'unknown' ? MODE_WORDS[f.mode] : null, f.battery != null ? `battery ${f.battery}%` : null].filter(Boolean);
    if (extra.length) bits.push(`  ${extra.join(' · ')}`);
    return bits.join('\n');
  });
}

/** The overdue alert. Facts, times and positions — no conclusion about what has happened. */
function alertEmail({ trip, card, fixes, nowMs, recipients }) {
  const { dueMs, deadlineMs } = times(trip);
  const late = Math.max(0, Math.round((nowMs - dueMs) / MIN));
  const first = recipients.length === 1 ? recipients[0].name : 'Hello';
  const pos = _positions(fixes, { nowMs });
  const nick = fixes.filter((f) => f.role === 'nick').sort((a, b) => a.observedMs - b.observedMs);
  const trail = nick.slice(-8).map((f) => `  ${hhmm(f.observedMs)}  ${gridRef(f.lat, f.lon) || `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`}${f.mode && f.mode !== 'unknown' ? `  (${MODE_WORDS[f.mode]})` : ''}`);
  const subject = `Nick hasn't checked in from his walk — ${trip.name}`;
  const body = [
    `${first},`,
    '',
    `This is an automatic message from NEURO, Nick's own system. Before going walking Nick set a time to check in, and asked that you be told if he didn't.`,
    '',
    ...((trip.party || []).length ? [`He is walking with ${walkersLine({ walker: '', party: trip.party }).replace(/^ with /, '')}.`, ''] : []),
    `He planned to be back by ${hhmm(dueMs)}${trip.extendedUntilMs ? ' (he extended it during the walk)' : ''}. It is now ${hhmm(nowMs)} — ${late} minutes later — and he has not checked in. The alert was set for ${hhmm(deadlineMs)}.`,
    '',
    `This does not mean something has happened. Nick's phone may be out of signal or flat. But he asked for you to know.`,
    '',
    'What to do: try calling him. If you can\'t reach him and you are worried, call 999, ask for the Police and say he is a walker overdue on the hills — they call Mountain Rescue. Read them the route card below.',
    '',
    'LAST KNOWN POSITION',
    ...(pos.length ? pos : [`No position has reached NEURO since the walk was armed${nick.length ? '' : ' — nothing to go on but the route card'}.`]),
    ...(trail.length > 1 ? ['', 'His recent trail (oldest first):', ...trail] : []),
    '',
    '------------------------------------------------------------',
    card,
    '------------------------------------------------------------',
    '',
    'NEURO will email you again the moment he checks in.',
  ].join('\n');
  return { subject, body };
}

function allClearEmail({ trip, nowMs, recipients, via }) {
  const first = recipients.length === 1 ? recipients[0].name : 'Hello';
  return {
    subject: `Nick has checked in — ${trip.name}`,
    body: [`${first},`, '', `Nick checked in at ${hhmm(nowMs)}${via ? ` (from ${via})` : ''}. He is back from ${trip.name} — you can ignore the earlier alert.`, '', '— NEURO'].join('\n'),
  };
}

module.exports = {
  DEFAULT_GRACE_MIN, GRACE_RANGE, WARN_BEFORE_MIN, EXTEND_RANGE, TRACK_AFTER_DEADLINE_H, MODE_WORDS,
  msToLocal, localToMs, hhmm, dayWords, ago,
  osgbEN, gridRef, mapsLink, placeLine,
  validateContacts, validateTrip, times, plan,
  modeOf, speedBetween, fixFromState, drivingLately, haversineM, sourceLabel,
  routeCard, alertEmail, allClearEmail, validateParty, walkersLine,
};
