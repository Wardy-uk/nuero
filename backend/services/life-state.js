'use strict';

/**
 * What is Nick doing, where, with whom — and how sure are we?
 *
 * Nick, 2 Oct 2026: "it should be able to infer what I'm doing by now — am I
 * watching TV? relaxing? out hiking? sleeping? I don't care about work tasks at
 * 4pm on a Saturday… my laptop itself isn't enough to prove I'm working — I
 * could be hobby coding or studying… NEURO/SAiM needs to be JARVIS/FRIDAY
 * smart." Spec: vault `Projects/NEURO/SAiM — Situational Intelligence`.
 *
 * ⚠ ONE ANSWER, MANY RENDERERS. Every surface (phone, iOS, kiosks, voice,
 * greetings) reads this rather than deciding for itself. `context-state` stays
 * the WORK-shaped read that ranks the attention pool; this is the LIFE-shaped
 * read that decides what kind of thing a surface should be showing at all.
 *
 * ⚠ EVIDENCE OR SILENCE. Every answer carries the reasons it was reached, and
 * `confidence` says how many independent signals agreed. Thin evidence is
 * `unknown`, said out loud — a confident "relaxing" that hides a breaching
 * escalation is worse than no inference.
 *
 * ⚠ THE LAPTOP IS NOT PROOF OF WORK. A foreground editor proves he is at a
 * keyboard; it says nothing about whose project. Work needs a WORK signal —
 * Outlook or Teams in front of him, the office Wi-Fi, the office zone, a real
 * meeting — or the working day and hours together with the desk.
 *
 * `infer()` is PURE (signals + now in, answer out). `read()` gathers the live
 * signals and never throws: a source that fails is a named unknown.
 *
 * CommonJS — NEURO backend convention.
 */

const DOING = {
  IN_MEETING: 'in-meeting',
  WORKING: 'working',
  HOBBY: 'hobby',            // coding or studying out of hours, on his own time
  DRIVING: 'driving',
  WALKING: 'walking',        // out on foot — a walk or a hike
  EXERCISING: 'exercising',  // running / cycling
  WATCHING_TV: 'watching-tv',
  SLEEPING: 'sleeping',
  WINDING_DOWN: 'winding-down',
  RELAXING: 'relaxing',
  OUT: 'out',                // away from home and work, not otherwise placed
  UNKNOWN: 'unknown',
};

const LABEL = {
  'in-meeting': 'In a meeting',
  working: 'Working',
  hobby: 'On a project of your own',
  driving: 'Driving',
  walking: 'Out walking',
  exercising: 'Exercising',
  'watching-tv': 'Watching TV',
  sleeping: 'Asleep',
  'winding-down': 'Winding down',
  relaxing: 'Relaxing',
  out: 'Out',
  unknown: "Can't tell",
};

// Foreground apps, matched on the sanitised process name the desk agent sends.
// Work apps are the ones that are only ever work on this machine; an editor or a
// terminal is deliberately NOT here — that is the whole point of Nick's warning.
const WORK_APPS = ['outlook', 'olk', 'teams', 'ms-teams', 'msteams'];
const MAKER_APPS = ['code', 'cursor', 'windowsterminal', 'terminal', 'powershell', 'pwsh', 'idea64', 'pycharm64', 'iterm2', 'obsidian'];
const WORK_SSIDS = (process.env.LIFE_WORK_SSIDS || 'Nurtur-Corp').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const WORK_ZONES = (process.env.LIFE_WORK_ZONES || 'Office,Work').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SLEEP_ROOM = process.env.LIFE_SLEEP_ROOM || 'bedroom';
// ⚠ A ROOM SENSOR IS NOT ALWAYS AT HOME. `office` is the WORK Fire's sensor (it
// was renamed from `work-office` on 14 Sep), so the watch heard at that desk
// means he is at WORK — counting it as a room of the house put him "home, in the
// office" while he sat in Derby, on the first live read (2 Oct 2026).
const OFFSITE_ROOMS = (process.env.LIFE_OFFSITE_ROOMS || 'office,work-office').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const TV_ROOM = process.env.LIFE_TV_ROOM || 'living-room';

// TVs are per ROOM: a plug per room, read as on/off. `s.tv.rooms` maps room →
// boolean; the older single-plug shape `{known, on}` means the TV_ROOM set.
// An unavailable plug is simply absent — unknown, never off.
function tvOnIn(tv, roomName) {
  if (!tv || !tv.known || !roomName) return false;
  if (tv.rooms && typeof tv.rooms === 'object') return tv.rooms[roomName] === true;
  return roomName === TV_ROOM && tv.on === true;
}
function parseTvEntities(raw) {
  const out = {};
  for (const part of String(raw || '').split(',')) {
    const [r, e] = part.split('=').map((x) => (x || '').trim());
    if (r && e) out[r.toLowerCase()] = e;
  }
  return out;
}

function lower(v) { return String(v == null ? '' : v).toLowerCase(); }
function matchesApp(app, list) {
  const a = lower(app).replace(/\.exe$/, '');
  return !!a && list.some((x) => a === x || a.startsWith(x));
}

function parseWindow(raw) {
  const m = String(raw || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}
function inWindow(raw, now) {
  const w = parseWindow(raw);
  if (!w || w.start === w.end) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return w.start > w.end ? (mins >= w.start || mins < w.end) : (mins >= w.start && mins < w.end);
}

/** early · working · evening · night. PURE. */
function bandFor(now, { hours = '08:00-18:00', night = '21:00-07:00' } = {}) {
  if (inWindow(night, now)) return 'night';
  if (inWindow(hours, now)) return 'working';
  const h = parseWindow(hours);
  const mins = now.getHours() * 60 + now.getMinutes();
  return h && mins < h.start ? 'early' : 'evening';
}

/**
 * Where he is. PURE. Room beats saved-place geofence beats zone beats Wi-Fi
 * beats town.
 *
 * The geofence (5 Oct 2026, the NEURO iOS app's region monitoring of
 * `saved_places`) sits under the room sensor — which is finer and measures the
 * watch on his wrist — and above Home Assistant's zone, because it is the phone
 * itself answering for a place Nick named. A place is WORK if he marked it
 * `kind: work` or its name is one of the work zone names; HOME if `kind: home`.
 * Only a believable "inside" counts (place-sensing goes `stale` rather than
 * holding an old answer), so a dead app falls through to the zone as before.
 */
function placeFor({ room, phone, region }) {
  const zone = lower(phone && phone.zone);
  const ssid = lower(phone && phone.ssid);
  if (room && room.known && room.room && OFFSITE_ROOMS.includes(lower(room.room))) {
    return { kind: 'work', label: 'your desk', basis: 'watch at the work desk sensor' };
  }
  if (room && room.known && room.room) return { kind: 'home', label: room.room, basis: 'watch room sensor' };
  if (region && region.known && region.place && region.place.name) {
    const { name, kind } = region.place;
    if (kind === 'work' || (!kind && WORK_ZONES.includes(lower(name)))) return { kind: 'work', label: name, basis: 'phone geofence' };
    if (kind === 'home') return { kind: 'home', label: null, basis: 'phone geofence' };
    return { kind: 'elsewhere', label: name, basis: 'phone geofence' };
  }
  if (WORK_ZONES.includes(zone)) return { kind: 'work', label: phone.zone, basis: 'phone zone' };
  if (ssid && WORK_SSIDS.includes(ssid)) return { kind: 'work', label: 'Office', basis: 'office Wi-Fi' };
  if (zone === 'home') return { kind: 'home', label: null, basis: 'phone zone' };
  if (zone && zone !== 'not_home' && zone !== 'unknown') return { kind: 'elsewhere', label: phone.zone, basis: 'phone zone' };
  if (phone && phone.locality) return { kind: 'out', label: phone.locality, basis: "phone's location" };
  if (zone === 'not_home') return { kind: 'out', label: null, basis: 'phone zone' };
  return { kind: 'unknown', label: null, basis: null };
}

const CONF_RANK = { unknown: 0, guess: 1, likely: 2, sure: 3 };

/**
 * The answer. PURE.
 *
 * @param {object} s
 *   workingDay {known,isWorkingDay,reason} · hours · night
 *   meeting {known, now:boolean, subject} · focusSession {running}
 *   desk {known, app, label, minutes} — app null = not at a machine
 *   phone {zone, ssid, activity, audioOutput, locality, focusMode}
 *   room {known, room} · tv {known, on} · household {known, othersHome, who}
 *   region {known, place:{name,kind}} — the phone's saved-place geofence
 */
function infer(s = {}, now = new Date()) {
  const evidence = [];
  const unknowns = [];
  const phone = s.phone || null;
  const desk = s.desk || null;
  const room = s.room || null;

  if (!phone) unknowns.push('phone');
  if (!room || !room.known) unknowns.push('room');
  if (!desk || !desk.known) unknowns.push('laptop');
  if (!s.meeting || !s.meeting.known) unknowns.push('calendar');

  const band = bandFor(now, { hours: s.hours, night: s.night });
  const workingDay = s.workingDay && s.workingDay.known ? s.workingDay.isWorkingDay : null;
  const place = placeFor({ room, phone, region: s.region || null });
  const activity = lower(phone && phone.activity);
  const audio = lower(phone && phone.audioOutput);
  const atDesk = !!(desk && desk.known && desk.app);
  const workApp = atDesk && matchesApp(desk.app, WORK_APPS);
  const makerApp = atDesk && matchesApp(desk.app, MAKER_APPS);
  const atWorkPlace = place.kind === 'work';
  const inHours = band === 'working' && workingDay !== false;

  let doing = DOING.UNKNOWN;
  let confidence = 'unknown';
  const say = (why) => evidence.push(why);
  const declared = activeDeclaration(s.declared, place, now);
  const tvHere = !!(room && room.known && room.room && tvOnIn(s.tv, room.room));

  if (declared) {
    // ⚠ HIS WORD BEATS EVERY INFERENCE — he is the one signal that is never
    // wrong about what he is doing. It lapses when he changes place or when its
    // time is up, so "relaxing" said on the sofa does not follow him to work.
    doing = declared.doing; confidence = 'sure';
    say(`you told me at ${hhmm(new Date(declared.at))}`);
  } else if (s.meeting && s.meeting.now) {
    doing = DOING.IN_MEETING; confidence = 'sure';
    say(`your calendar has ${s.meeting.subject ? `"${s.meeting.subject}"` : 'a meeting'} with other people in it now`);
  } else if (activity === 'automotive' || audio.includes('carplay')) {
    doing = DOING.DRIVING;
    confidence = activity === 'automotive' && audio.includes('carplay') ? 'sure' : 'likely';
    if (activity === 'automotive') say('the phone says you are in a vehicle');
    if (audio.includes('carplay')) say('the phone is on CarPlay');
  } else if ((activity === 'running' || activity === 'cycling') && place.kind !== 'home') {
    doing = DOING.EXERCISING; confidence = 'likely';
    say(`the phone says ${activity}`);
  } else if (activity === 'walking' && (place.kind === 'out' || place.kind === 'elsewhere')) {
    doing = DOING.WALKING; confidence = 'likely';
    say('the phone says you are walking');
    say(place.label ? `and you are out, near ${place.label}` : 'and you are away from home and work');
  } else if (tvHere && place.kind === 'home' && !atDesk) {
    // ⚠ A TV ON IN THE ROOM HIS WATCH IS IN IS HIS EVENING — and it is checked
    // BEFORE the bedroom-at-night rule, because that rule alone called him
    // asleep at 21:18 while he watched the bedroom TV (5 Oct 2026).
    doing = DOING.WATCHING_TV; confidence = 'sure';
    say(`the ${room.room.replace(/-/g, ' ')} TV is on`);
    say('and your watch is in there with it');
  } else if (band === 'night' && room && room.known && room.room === SLEEP_ROOM) {
    // ⚠ A GUESS, ALWAYS. The night band is when the screens dim (21:00), not
    // evidence of sleep, and the bedroom is where he also reads and watches TV.
    // Nothing here can see sleep in real time (Watch stages arrive on the next
    // phone sync), so it asks rather than asserting "asleep".
    doing = DOING.SLEEPING; confidence = 'guess';
    say('it is night and your watch is in the bedroom');
    say('nothing confirms you are asleep, so this is a guess');
  } else if (workApp && (inHours || atWorkPlace || band === 'evening' || band === 'early')) {
    doing = DOING.WORKING; confidence = inHours || atWorkPlace ? 'sure' : 'likely';
    say(`${desk.label || desk.app} is in front of you`);
    if (atWorkPlace) say(`you are at work (${place.basis})`);
    else if (!inHours) say('outside working hours, but that is a work app');
  } else if (atWorkPlace && workingDay !== false) {
    doing = DOING.WORKING; confidence = inHours ? 'likely' : 'guess';
    say(`you are at work (${place.basis})`);
  } else if (s.focusSession && s.focusSession.running) {
    doing = inHours ? DOING.WORKING : DOING.HOBBY; confidence = 'likely';
    say('you started a focus session');
  } else if (atDesk && makerApp && !inHours) {
    doing = DOING.HOBBY; confidence = 'likely';
    say(`${desk.label || desk.app} is in front of you outside working hours, with no work app`);
  } else if (atDesk && inHours) {
    doing = DOING.WORKING; confidence = 'guess';
    say(`a laptop is active during working hours (${desk.label || desk.app})`);
    say('nothing proves it is work — it could be your own project');
  } else if (tvOnIn(s.tv, TV_ROOM) && place.kind === 'home' && !atDesk
      && !(room && room.known && room.room && room.room !== TV_ROOM)) {
    // ⚠ Nick, 2 Oct 2026: "you only need to know if it's on or off — if it's on,
    // the TV is on." The plug is the TV. What it cannot say is who is watching,
    // so he counts as watching unless his watch puts him in ANOTHER room — then
    // someone else is, and that is not his evening.
    doing = DOING.WATCHING_TV;
    confidence = room && room.known && room.room === TV_ROOM ? 'sure' : 'likely';
    say('the TV is on');
    if (room && room.known && room.room === TV_ROOM) say('and your watch is in the living room');
  } else if (band === 'night' && place.kind === 'home') {
    doing = DOING.WINDING_DOWN; confidence = 'guess';
    say('it is late and you are home');
  } else if (place.kind === 'home' && !atDesk && (!inHours || workingDay === false)) {
    doing = DOING.RELAXING; confidence = room && room.known ? 'likely' : 'guess';
    say(workingDay === false ? `it is ${(s.workingDay && s.workingDay.reason) || 'not a working day'} and you are home` : 'it is after hours and you are home');
    say('no laptop is active');
  } else if (place.kind === 'out' || place.kind === 'elsewhere') {
    doing = DOING.OUT; confidence = 'likely';
    say(place.label ? `you are out, near ${place.label}` : 'you are away from home and work');
  }

  const company = s.meeting && s.meeting.now ? 'colleagues'
    : place.kind === 'home' && s.household && s.household.known
      ? (s.household.othersHome ? 'family' : 'alone')
      : 'unknown';

  // Work content is shown ONLY while he is working — or when we genuinely cannot
  // tell and it is his working day, which keeps today's behaviour rather than
  // hiding work on a bad guess.
  const showWork = doing === DOING.WORKING || doing === DOING.IN_MEETING
    || (doing === DOING.UNKNOWN && inHours);

  // ⚠ WHEN IT IS A GUESS, ASK. Nick, 2 Oct 2026: "something should probably ask
  // me what I'm doing if there's ambiguity." A question on the screen is a PULL —
  // it is never pushed, it is offered where he is already looking, and "not now"
  // quietens it for an hour. The options fit where he is, so the tap is one he
  // would plausibly make.
  const ask = !declared && (confidence === 'guess' || confidence === 'unknown')
    && !s.askSnoozed && (phone || (room && room.known))
    ? { question: 'What are you up to?', options: optionsFor(place.kind).map((d) => ({ doing: d, label: ANSWER_LABEL[d] || LABEL[d] })) }
    : null;

  return {
    doing,
    label: LABEL[doing],
    declared: declared ? { doing: declared.doing, at: declared.at, until: declared.until } : null,
    ask,
    confidence,
    sure: CONF_RANK[confidence] >= CONF_RANK.likely,
    place,
    company,
    household: s.household && s.household.known ? { othersHome: s.household.othersHome, who: s.household.who || [] } : null,
    band,
    workingDay,
    showWork,
    evidence,
    unknowns,
    at: now.toISOString(),
  };
}

// ── Asking, and being told ───────────────────────────────────────────────────

const ANSWER_LABEL = {
  working: 'Working', hobby: 'My own project', relaxing: 'Relaxing', 'watching-tv': 'Watching TV',
  'winding-down': 'Off to bed', walking: 'Out walking', driving: 'Driving', exercising: 'Exercising',
  out: 'Out and about', 'in-meeting': 'In a meeting', sleeping: 'Asleep',
};
const DECLARABLE = Object.values(DOING).filter((d) => d !== DOING.UNKNOWN);
const DECLARE_KEY = 'life_declared';
const HISTORY_KEY = 'life_declarations';
const SNOOZE_KEY = 'life_ask_snoozed_until';
const DECLARE_DEFAULT_MIN = 120;
const HISTORY_MAX = 500;

function hhmm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/** The options that fit where he is. PURE. */
function optionsFor(kind) {
  if (kind === 'home') return ['working', 'hobby', 'relaxing', 'watching-tv', 'winding-down'];
  if (kind === 'work') return ['working', 'in-meeting', 'out'];
  return ['walking', 'driving', 'exercising', 'out', 'working'];
}

/** A declaration still in force: in time, and in the same KIND of place. PURE. */
function activeDeclaration(d, place, now) {
  if (!d || !DECLARABLE.includes(d.doing)) return null;
  const until = Date.parse(d.until);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  // Changing place ends it — but an unreadable place is not a change.
  if (d.placeKind && place && place.kind !== 'unknown' && place.kind !== d.placeKind) return null;
  return d;
}

function _db() { return require('../db/database'); }
function _get(key) { try { const v = _db().getState(key); return v ? JSON.parse(v) : null; } catch { return null; } }
function _set(key, v) { _db().setState(key, JSON.stringify(v)); }

/**
 * He told us. Stored with an expiry and the place it was said in, and appended
 * to a bounded history WITH what the inference had said — every answer is a
 * labelled example of where the read was wrong, which is the training set.
 */
async function declare(doing, { minutes = DECLARE_DEFAULT_MIN, now = new Date() } = {}) {
  if (!DECLARABLE.includes(doing)) {
    const err = new Error(`unknown activity "${doing}"`); err.status = 400; throw err;
  }
  const mins = Math.min(Math.max(Number(minutes) || DECLARE_DEFAULT_MIN, 5), 12 * 60);
  const before = await read(now, { ignoreDeclared: true });
  const entry = {
    doing,
    at: now.toISOString(),
    until: new Date(now.getTime() + mins * 60000).toISOString(),
    placeKind: before.place ? before.place.kind : null,
  };
  _set(DECLARE_KEY, entry);
  const hist = Array.isArray(_get(HISTORY_KEY)) ? _get(HISTORY_KEY) : [];
  hist.push({ ...entry, inferred: before.doing, confidence: before.confidence, evidence: before.evidence, place: before.place });
  _set(HISTORY_KEY, hist.slice(-HISTORY_MAX));
  return read(now);
}

function clearDeclared() { _set(DECLARE_KEY, null); }

/** "Not now" — quietens the question for an hour. */
function snoozeAsk(minutes = 60, now = new Date()) {
  _set(SNOOZE_KEY, new Date(now.getTime() + Math.min(Number(minutes) || 60, 12 * 60) * 60000).toISOString());
}

// ── Gathering ────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function wallKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Is a real meeting (other people in it) running now? Wall-clock strings, never parsed. */
function meetingNow(rows, now) {
  const k = wallKey(now);
  const hit = (rows || []).find((r) => r
    && r.attendees_other === 1
    && r.is_all_day !== 1
    && !/free|cancelled/i.test(String(r.show_as || ''))
    && String(r.start_time || '') <= k && String(r.end_time || '') > k);
  return hit ? { known: true, now: true, subject: hit.subject || null } : { known: true, now: false, subject: null };
}

const TV_ENTITY = process.env.LIFE_TV_ENTITY || 'switch.living_room_extension_socket_1';
// Room → plug. `switch.bedroom_socket_1` is the bedroom TV's plug (friendly name
// "Bedroom TV"); `switch.bedroom_tv_socket` has been unavailable since 27 Sep and
// `media_player.main_bedroom` reads `on` permanently, so neither is used.
const TV_ENTITIES = parseTvEntities(process.env.LIFE_TV_ENTITIES
  || `${TV_ROOM}=${TV_ENTITY},bedroom=switch.bedroom_socket_1`);
const HOUSEHOLD_ENTITY = process.env.HA_HOUSEHOLD_SENSOR || 'binary_sensor.household_others_home';

async function read(now = new Date(), { ignoreDeclared = false } = {}) {
  const s = {};
  if (!ignoreDeclared) s.declared = _get(DECLARE_KEY);
  const snooze = Date.parse(_get(SNOOZE_KEY) || '');
  s.askSnoozed = Number.isFinite(snooze) && snooze > now.getTime();
  try {
    const settings = require('./attention-settings').read();
    s.hours = settings.workingHours;
    s.night = settings.displayNight;
  } catch { /* defaults */ }

  try {
    const wd = require('./working-days');
    const ok = wd.isWorkingDay(now);
    s.workingDay = { known: true, isWorkingDay: !!ok, reason: ok ? null : (wd.nonWorkingReason ? wd.nonWorkingReason(now) : null) };
  } catch { s.workingDay = { known: false }; }

  try {
    const db = require('../db/database');
    const d = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const total = db.get('SELECT COUNT(*) AS n FROM calendar_cache')?.n || 0;
    s.meeting = total ? meetingNow(db.getCalendarEvents(`${d}T00:00:00`, `${d}T23:59:59`), now) : { known: false };
  } catch { s.meeting = { known: false }; }

  try {
    const fs = require('./focus-session').current(now.getTime());
    s.focusSession = { running: !!(fs && fs.status === 'active' && !fs.stale) };
  } catch { s.focusSession = { running: false }; }

  try {
    const r = require('./desktop-activity').run(now);
    s.desk = { known: !!r.known, app: r.app || null, label: r.label || null, minutes: r.minutes || 0 };
  } catch { s.desk = { known: false }; }

  try {
    const ha = require('./ha');
    const p = await ha.getPhoneStatus();
    if (p) {
      s.phone = {
        zone: p.presence || null, ssid: p.ssid || null, activity: p.activity || null,
        audioOutput: p.audioOutput || null, locality: p.geocodedLocality || null, focusMode: p.focusMode,
      };
    }
    const states = (ha.cachedStates && ha.cachedStates()) || [];
    const rooms = {};
    for (const [roomName, entity] of Object.entries(TV_ENTITIES)) {
      const row = states.find((x) => x && x.entity_id === entity);
      if (row && (row.state === 'on' || row.state === 'off')) rooms[roomName] = row.state === 'on';
    }
    s.tv = Object.keys(rooms).length
      ? { known: true, on: Object.values(rooms).some(Boolean), rooms }
      : { known: false };
    const hh = (states || []).find((x) => x && x.entity_id === HOUSEHOLD_ENTITY);
    s.household = hh && (hh.state === 'on' || hh.state === 'off')
      ? { known: true, othersHome: hh.state === 'on', who: (hh.attributes && hh.attributes.who_is_home) || [] }
      : { known: false };
  } catch { /* phone, tv and household stay unknown */ }

  try {
    const r = await require('./room-presence').read(now);
    s.room = r && r.known ? { known: true, room: r.room } : { known: false };
  } catch { s.room = { known: false }; }

  try {
    const g = require('./place-sensing').readCurrentPlace(now);
    s.region = g && g.known && g.place ? { known: true, place: g.place } : { known: false };
  } catch { s.region = { known: false }; }

  return infer(s, now);
}

module.exports = { OFFSITE_ROOMS, tvOnIn, parseTvEntities, infer, read, declare, clearDeclared, snoozeAsk, bandFor, placeFor, meetingNow, optionsFor, activeDeclaration, DOING, LABEL, ANSWER_LABEL, WORK_APPS, MAKER_APPS, DECLARE_KEY, HISTORY_KEY };
