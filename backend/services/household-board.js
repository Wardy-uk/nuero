'use strict';

/**
 * The family wall's small household stores (25 Oct 2026).
 *
 * Nick's decisions for the cinema wall, asked one at a time:
 *   • TEA — tonight's meal, one line per day, today and the next six; old days
 *     are not shown. Recent meals offered as chips.
 *   • NOTES — a short-lived board: who left it, when, cleared by a tap or by
 *     itself after two days, at most ten kept. Nothing goes to the vault.
 *   • COUNTDOWNS — only events someone marked "Count down to this"; the wall
 *     shows the nearest two.
 *   • SHOPPING — a shared catalogue `shopping` (Catalogues/shopping.md, shared:
 *     true) with `To buy` and `Bought`. A tick moves an item to Bought (added =
 *     today); undo moves it back. Bought from before today is not shown and is
 *     pruned on the next shopping write.
 *   • CARE — Ember's (every companion's) care items due within 7 days or
 *     overdue, read-only.
 *   • OUTLOOK — today's and tomorrow's high/low and rain chance from the
 *     standing forecast, plus one rain line from the local nowcast.
 *
 * House rules this file keeps:
 *   • READS WRITE NOTHING. Expiry (notes after 2 days, past tea days, past
 *     countdowns, bought-before-today) is applied at READ by filtering, and the
 *     stored copy is only pruned by the next WRITE.
 *   • INVALID INPUT IS REFUSED (status 400), never clamped or trimmed to fit.
 *   • Missing is null, never 0; an unreadable store is a named failure, never
 *     an empty list.
 *
 * The stores are small agent_state KV keys: household_tea, household_notes,
 * wall_countdowns. The shopping list is a vault catalogue (services/catalogue.js).
 *
 * CommonJS — NEURO backend convention.
 */

const crypto = require('crypto');

const TEA_KEY = 'household_tea';
const NOTES_KEY = 'household_notes';
const COUNTDOWN_KEY = 'wall_countdowns';

const TEA_MAX = 80;
const TEA_DAYS_AHEAD = 6;
const TEA_RECENT_SHOWN = 6;
const TEA_RECENT_KEPT = 20;
const NOTE_MAX = 140;
const NOTE_KEPT = 10;
const NOTE_TTL_MS = 2 * 24 * 3600 * 1000;
const COUNTDOWN_TITLE_MAX = 80;
const COUNTDOWN_KEY_MAX = 300;
const COUNTDOWN_SHOWN = 2;
const CARE_AHEAD_DAYS = 7;

const SHOPPING_SLUG = 'shopping';
const SHOPPING_TITLE = 'Shopping';
const TO_BUY = 'To buy';
const BOUGHT = 'Bought';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function _db() { return require('../db/database'); }

// ── Dates (host-local, the same "today" the wall route uses) ────────────────

const _p2 = (n) => String(n).padStart(2, '0');
function localKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`;
}
/** A real calendar date in YYYY-MM-DD (2026-02-31 is refused). PURE. */
function isDateKey(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const _utc = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
/** Whole days from `a` to `b` (YYYY-MM-DD). PURE. */
function daysBetween(a, b) { return Math.round((_utc(b) - _utc(a)) / DAY_MS); }
/** `n` days after `k`. PURE. */
function addDays(k, n) { return new Date(_utc(k) + n * DAY_MS).toISOString().slice(0, 10); }
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekdayOf(k) { return WEEKDAY[new Date(_utc(k)).getUTCDay()]; }

function _readKV(key, fallback) {
  // ⚠ An unreadable or corrupt store THROWS, so the caller reports a gap rather
  // than rendering "no notes" over a store it could not read.
  const raw = _db().getState(key);
  if (raw === null || raw === undefined || raw === '') return fallback;
  return JSON.parse(raw);
}
function _writeKV(key, value) { _db().setState(key, JSON.stringify(value)); }

const bad = (error) => ({ ok: false, status: 400, error });

// ── Tea ──────────────────────────────────────────────────────────────────────

/** The tea block from a stored value. PURE. */
function teaView(stored, todayKey) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const days = s.days && typeof s.days === 'object' ? s.days : {};
  const last = addDays(todayKey, TEA_DAYS_AHEAD);
  const set = Object.keys(days)
    .filter((k) => isDateKey(k) && k >= todayKey && k <= last && days[k] && typeof days[k].text === 'string' && days[k].text)
    .sort()
    .map((date) => ({ date, text: days[date].text }));
  const recent = [];
  for (const t of Array.isArray(s.recent) ? s.recent : []) {
    if (typeof t !== 'string' || !t) continue;
    if (recent.some((r) => r.toLowerCase() === t.toLowerCase())) continue;
    recent.push(t);
    if (recent.length >= TEA_RECENT_SHOWN) break;
  }
  const today = set.find((d) => d.date === todayKey);
  return { today: today ? today.text : null, days: set, recent };
}

function readTea({ now = Date.now() } = {}) {
  return teaView(_readKV(TEA_KEY, {}), localKey(now));
}

/**
 * Set (or clear) one day's tea. `text` must be PRESENT: a string sets it, null
 * or '' clears it; omitted is refused (an omitted field is not a request to
 * clear). Over 80 characters is refused, never cut.
 */
function setTea({ date, text } = {}, { by = null, now = Date.now() } = {}) {
  const today = localKey(now);
  if (!isDateKey(date)) return bad('date must be a real date, YYYY-MM-DD');
  const ahead = daysBetween(today, date);
  if (ahead < 0 || ahead > TEA_DAYS_AHEAD) return bad(`tea can be set for today and the next ${TEA_DAYS_AHEAD} days only`);
  if (text === undefined) return bad('text is required — send null or an empty string to clear the day');
  if (text !== null && typeof text !== 'string') return bad('text must be a string or null');
  const clean = text === null ? '' : text.trim().replace(/\s+/g, ' ');
  if (clean.length > TEA_MAX) return bad(`keep it to ${TEA_MAX} characters`);

  const stored = _readKV(TEA_KEY, {});
  const days = {};
  // Past days are pruned on write (they are already hidden on read).
  for (const [k, v] of Object.entries(stored.days || {})) if (isDateKey(k) && k >= today) days[k] = v;
  let recent = Array.isArray(stored.recent) ? stored.recent.filter((t) => typeof t === 'string' && t) : [];
  if (clean) {
    days[date] = { text: clean, by: by || null, at: new Date(now).toISOString() };
    recent = [clean, ...recent.filter((t) => t.toLowerCase() !== clean.toLowerCase())].slice(0, TEA_RECENT_KEPT);
  } else {
    delete days[date];
  }
  _writeKV(TEA_KEY, { days, recent });
  return { ok: true, tea: teaView({ days, recent }, today) };
}

// ── Notes ────────────────────────────────────────────────────────────────────

function _liveNotes(list, nowMs) {
  return (Array.isArray(list) ? list : [])
    .filter((n) => n && n.id && typeof n.text === 'string' && Number.isFinite(Date.parse(n.at)) && nowMs - Date.parse(n.at) < NOTE_TTL_MS)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, NOTE_KEPT);
}
const _noteOut = (n) => ({ id: n.id, text: n.text, by: n.by || null, at: n.at });

/** Notes as the wall sees them: newest first, ≤10, expired filtered. Writes nothing. */
function readNotes({ now = Date.now() } = {}) {
  return _liveNotes(_readKV(NOTES_KEY, []), now).map(_noteOut);
}

function addNote({ text } = {}, { by = null, now = Date.now() } = {}) {
  if (typeof text !== 'string') return bad('text is required');
  const clean = text.trim();
  if (!clean) return bad('a note needs some words');
  if (clean.length > NOTE_MAX) return bad(`keep a note to ${NOTE_MAX} characters`);
  const live = _liveNotes(_readKV(NOTES_KEY, []), now);
  const note = { id: crypto.randomBytes(6).toString('hex'), text: clean, by: by || null, at: new Date(now).toISOString() };
  const kept = [note, ...live].slice(0, NOTE_KEPT);
  _writeKV(NOTES_KEY, kept);
  return { ok: true, note: _noteOut(note), notes: kept.map(_noteOut) };
}

function clearNote(id, { now = Date.now() } = {}) {
  const live = _liveNotes(_readKV(NOTES_KEY, []), now);
  if (!live.some((n) => n.id === String(id))) return { ok: false, status: 404, error: 'no such note' };
  const kept = live.filter((n) => n.id !== String(id));
  _writeKV(NOTES_KEY, kept);
  return { ok: true, notes: kept.map(_noteOut) };
}

// ── Countdowns ───────────────────────────────────────────────────────────────

function countdownSay(days) {
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** The nearest ≤2 marked events on or after today. PURE. */
function countdownView(stored, todayKey) {
  const all = stored && typeof stored === 'object' ? Object.values(stored) : [];
  return all
    .filter((c) => c && c.key && isDateKey(c.date) && c.date >= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.title).localeCompare(String(b.title)))
    .slice(0, COUNTDOWN_SHOWN)
    .map((c) => { const days = daysBetween(todayKey, c.date); return { key: c.key, title: c.title, date: c.date, days, say: countdownSay(days) }; });
}

function readCountdowns({ now = Date.now() } = {}) {
  return countdownView(_readKV(COUNTDOWN_KEY, {}), localKey(now));
}

/** Every key currently marked (for `week[].events[].countdown`), past ones excluded. */
function markedKeys({ now = Date.now() } = {}) {
  const today = localKey(now);
  const stored = _readKV(COUNTDOWN_KEY, {});
  return new Set(Object.values(stored || {}).filter((c) => c && c.key && isDateKey(c.date) && c.date >= today).map((c) => c.key));
}

function setCountdown({ key, title, date, on } = {}, { by = null, now = Date.now() } = {}) {
  const today = localKey(now);
  if (typeof key !== 'string' || !key.trim() || key.length > COUNTDOWN_KEY_MAX) return bad('key is required (the event’s countdownKey)');
  if (typeof on !== 'boolean') return bad('on must be true or false');
  const stored = _readKV(COUNTDOWN_KEY, {});
  const kept = {};
  for (const [k, v] of Object.entries(stored || {})) if (v && isDateKey(v.date) && v.date >= today) kept[k] = v;
  if (on) {
    if (!isDateKey(date)) return bad('date must be a real date, YYYY-MM-DD');
    if (date < today) return bad('that day has already passed');
    if (typeof title !== 'string' || !title.trim()) return bad('title is required');
    const t = title.trim();
    if (t.length > COUNTDOWN_TITLE_MAX) return bad(`keep the title to ${COUNTDOWN_TITLE_MAX} characters`);
    kept[key] = { key, title: t, date, by: by || null, at: new Date(now).toISOString() };
  } else {
    delete kept[key];
  }
  _writeKV(COUNTDOWN_KEY, kept);
  return { ok: true, countdowns: countdownView(kept, today) };
}

/**
 * Stamp `countdownKey` / `countdown` onto every event of a redacted week. The
 * key is the source event id + the event's START date, so a multi-day event has
 * one key on every day it shows. An event with no id carries no key. PURE.
 */
function stampWeek(week, marked) {
  if (!Array.isArray(week)) return week;
  return week.map((day) => ({
    ...day,
    events: (day.events || []).map((e) => {
      const start = String(e.start || '').slice(0, 10);
      const key = e.id && isDateKey(start) ? `${e.id}@${start}` : null;
      return { ...e, countdownKey: key, countdown: !!(key && marked && marked.has(key)) };
    }),
  }));
}

// ── Shopping (a shared catalogue) ────────────────────────────────────────────

const _k = (s) => String(s || '').trim().toLowerCase();

/** The shopping block from a parsed catalogue. PURE. */
function shoppingView(cat, todayKey) {
  const items = (cat && cat.items) || {};
  return {
    exists: true,
    toBuy: (items[_k(TO_BUY)] || []).map((i) => ({ name: i.name, added: i.added || null })),
    bought: (items[_k(BOUGHT)] || []).filter((i) => i.added === todayKey).map((i) => ({ name: i.name })),
  };
}

/**
 * The shopping list for the wall. `{ ok:true, shopping }` — `exists:false` when
 * there is no list yet; `{ ok:false, why }` when it exists but is private, or
 * cannot be read (never an empty list).
 */
function readShopping({ now = Date.now() } = {}) {
  const catalogue = require('./catalogue');
  const found = catalogue.read(SHOPPING_SLUG);
  if (!found.ok) {
    if (found.notFound) return { ok: true, shopping: { exists: false, toBuy: [], bought: [] } };
    return { ok: false, why: 'could not read the shopping list' };
  }
  if (found.cat.shared !== true) return { ok: false, notShared: true, why: 'the shopping list is not shared' };
  return { ok: true, shopping: shoppingView(found.cat, localKey(now)) };
}

function _ensureSections(cat) {
  for (const s of [TO_BUY, BOUGHT]) {
    if (!cat.items[_k(s)]) { cat.items[_k(s)] = []; cat.sections = [...(cat.sections || []), s]; }
  }
}
function _pruneBought(cat, todayKey) {
  const before = cat.items[_k(BOUGHT)].length;
  cat.items[_k(BOUGHT)] = cat.items[_k(BOUGHT)].filter((i) => i.added === todayKey);
  return cat.items[_k(BOUGHT)].length !== before;
}

/** Load the list for a write, creating it (shared) if missing. */
function _openForWrite() {
  const catalogue = require('./catalogue');
  let found = catalogue.read(SHOPPING_SLUG);
  if (!found.ok && found.notFound) {
    const made = catalogue.create({ title: SHOPPING_TITLE, sections: [TO_BUY, BOUGHT], shared: true });
    if (!made.ok) return { ok: false, status: 500, error: 'could not create the shopping list' };
    found = catalogue.read(SHOPPING_SLUG);
  }
  if (!found.ok) return { ok: false, status: 500, error: 'could not read the shopping list' };
  // ⚠ A private catalogue that happens to be called "shopping" is not taken
  // over: sharing is its own decision (POST /api/catalogues/:slug/shared).
  if (found.cat.shared !== true) return { ok: false, status: 409, error: 'there is a shopping list but it is not shared with the household' };
  _ensureSections(found.cat);
  return { ok: true, cat: found.cat };
}

function _cleanName(name) {
  const catalogue = require('./catalogue');
  if (typeof name !== 'string' || !name.trim()) return { error: 'name is required' };
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length > catalogue.MAX_NAME) return { error: `keep it to ${catalogue.MAX_NAME} characters` };
  return { clean };
}

function _save(cat) {
  const w = require('./catalogue').write(SHOPPING_SLUG, cat);
  return w.ok ? null : { ok: false, status: 500, error: 'could not save the shopping list' };
}

function shoppingAdd({ name } = {}, { now = Date.now() } = {}) {
  const n = _cleanName(name);
  if (n.error) return bad(n.error);
  const today = localKey(now);
  const open = _openForWrite();
  if (!open.ok) return open;
  const cat = open.cat;
  let changed = _pruneBought(cat, today);
  const toBuy = cat.items[_k(TO_BUY)];
  let already = false;
  if (toBuy.some((i) => _k(i.name) === _k(n.clean))) {
    already = true;
  } else {
    // Bought earlier today and wanted again: it moves back rather than doubling.
    const bought = cat.items[_k(BOUGHT)];
    const prior = bought.find((i) => _k(i.name) === _k(n.clean));
    if (prior) cat.items[_k(BOUGHT)] = bought.filter((i) => i !== prior);
    toBuy.push({ name: prior ? prior.name : n.clean, added: today });
    changed = true;
  }
  if (changed) { const err = _save(cat); if (err) return err; }
  return { ok: true, already, shopping: shoppingView(cat, today) };
}

function shoppingBought({ name, undo } = {}, { now = Date.now() } = {}) {
  const n = _cleanName(name);
  if (n.error) return bad(n.error);
  if (undo !== undefined && typeof undo !== 'boolean') return bad('undo must be true or false');
  const back = undo === true;
  const today = localKey(now);
  const open = _openForWrite();
  if (!open.ok) return open;
  const cat = open.cat;
  let changed = _pruneBought(cat, today);
  const from = back ? _k(BOUGHT) : _k(TO_BUY);
  const to = back ? _k(TO_BUY) : _k(BOUGHT);
  const item = cat.items[from].find((i) => _k(i.name) === _k(n.clean));
  if (item) {
    cat.items[from] = cat.items[from].filter((i) => i !== item);
    cat.items[to].push({ name: item.name, added: today });
    changed = true;
  } else if (!cat.items[to].some((i) => _k(i.name) === _k(n.clean))) {
    // Neither where it should come from nor already where it should go.
    if (changed) { const err = _save(cat); if (err) return err; }
    return { ok: false, status: 404, error: back ? 'that is not on today’s bought list' : 'that is not on the shopping list' };
  }
  if (changed) { const err = _save(cat); if (err) return err; }
  return { ok: true, shopping: shoppingView(cat, today) };
}

// ── Care (companions) ────────────────────────────────────────────────────────

const APPOINTMENT = new Set(['vet', 'grooming', 'walk']);

/** One care row as the wall says it. PURE. */
function careLine(row, companionName, todayKey) {
  const away = daysBetween(todayKey, row.due_date);
  const title = String(row.title || '').trim() || 'Care';
  let say;
  if (away < 0) {
    say = APPOINTMENT.has(row.kind)
      ? `${title} was ${weekdayOf(row.due_date)} ${row.due_date.slice(8, 10)}/${row.due_date.slice(5, 7)} — not marked done`
      : `${title} ${-away} day${away === -1 ? '' : 's'} overdue`;
  } else if (away === 0) say = `${title} due today`;
  else if (away === 1) say = `${title} due tomorrow`;
  else if (away < 7) say = `${title} due ${weekdayOf(row.due_date)}`;
  else say = `${title} due in ${away} days`;
  return { id: row.care_id, title, companion: companionName || null, dueDate: row.due_date, say, overdue: away < 0 };
}

/** Open companion care due within 7 days or overdue, overdue first. */
function readCare({ now = Date.now() } = {}) {
  const today = localKey(now);
  const last = addDays(today, CARE_AHEAD_DAYS);
  const out = [];
  for (const c of require('./personal-world').listCompanions()) {
    const rows = _db().all(
      "SELECT * FROM companion_care_items WHERE companion_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date <= ?",
      [c.id, last]);
    for (const r of rows) if (isDateKey(r.due_date)) out.push(careLine(r, c.name, today));
  }
  return out.sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || a.dueDate.localeCompare(b.dueDate));
}

// ── Outlook (forecast + nowcast) ─────────────────────────────────────────────

const HOUR = 3600 * 1000;
const NOWCAST_TTL_MS = 5 * 60 * 1000;
const LOCATION_TTL_MS = 6 * HOUR;
let _loc = { at: 0, value: null, pending: false };
let _nc = { at: 0, value: null };

function _londonHHMM(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/**
 * The cached nowcast, never blocking on the network: when home's location is
 * not cached yet a refresh is started and this answers null (no nowcast arm).
 */
function cachedNowcast(nowMs = Date.now()) {
  if (!_loc.value || nowMs - _loc.at > LOCATION_TTL_MS) {
    if (!_loc.pending) {
      _loc.pending = true;
      Promise.resolve()
        .then(() => require('./weather-forecast').location())
        .then((v) => { _loc = { at: Date.now(), value: v, pending: false }; })
        .catch(() => { _loc = { at: Date.now(), value: { known: false }, pending: false }; });
    }
    if (!_loc.value) return null;
  }
  if (!_loc.value.known) return null;
  if (_nc.value && nowMs - _nc.at <= NOWCAST_TTL_MS) return _nc.value;
  const value = require('./weather-nowcast').build({ home: { lat: _loc.value.latitude, lon: _loc.value.longitude }, nowMs });
  _nc = { at: nowMs, value };
  return value;
}

const _round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
function _maxOf(arr) { const v = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? Math.max(...v) : null; }
function _minOf(arr) { const v = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? Math.min(...v) : null; }

/**
 * The outlook block. PURE: `points` are standing forecast points, `nowcast`
 * the build() result or null, day bounds in ms (Europe/London days).
 * Never says "will".
 */
function composeOutlook({ points = [], nowcast = null, nowMs, todayStart, tomorrowStart, dayAfterStart }) {
  const inDay = (p, a, b) => p.validAt >= a && p.validAt < b;
  const todayPts = points.filter((p) => inDay(p, todayStart, tomorrowStart));
  const restPts = todayPts.filter((p) => p.validAt + HOUR > nowMs);
  const tomPts = points.filter((p) => inDay(p, tomorrowStart, dayAfterStart));
  const today = {
    highC: _round(_maxOf(todayPts.map((p) => p.temperatureC))),
    lowC: _round(_minOf(todayPts.map((p) => p.temperatureC))),
    rainChance: _round(_maxOf(restPts.map((p) => p.precipProb))),
  };
  const tomorrow = {
    highC: _round(_maxOf(tomPts.map((p) => p.temperatureC))),
    lowC: _round(_minOf(tomPts.map((p) => p.temperatureC))),
    rainChance: _round(_maxOf(tomPts.map((p) => p.precipProb))),
  };

  let rain = null;
  if (nowcast) {
    const raining = (nowcast.home && nowcast.home.raining === true) || (nowcast.arrival && nowcast.arrival.state === 'raining-here');
    if (raining) rain = { state: 'raining', say: 'Raining now' };
    else if (nowcast.arrival && nowcast.arrival.state === 'rain-likely' && Array.isArray(nowcast.arrival.etaMin)) {
      rain = { state: 'arriving', say: `Rain likely from about ${_londonHHMM(nowMs + nowcast.arrival.etaMin[0] * 60000)}` };
    }
  }
  if (!rain) {
    const probs = restPts.filter((p) => typeof p.precipProb === 'number');
    if (probs.length) {
      const wet = probs.find((p) => p.precipProb >= 50);
      if (wet) {
        rain = wet.validAt <= nowMs
          ? { state: 'arriving', say: 'Rain likely this hour' }
          : { state: 'arriving', say: `Rain likely from about ${_londonHHMM(wet.validAt)}` };
      } else {
        const max = Math.max(...probs.map((p) => p.precipProb));
        rain = max >= 30
          ? { state: 'dry', say: `Small chance of rain later (${Math.round(max)}%)` }
          : { state: 'dry', say: 'No rain expected today' };
      }
    } else {
      rain = { state: 'unknown', say: "Can't see the rain radar right now" };
    }
  }
  const known = todayPts.length > 0 || tomPts.length > 0 || rain.state !== 'unknown';
  return { known, today, tomorrow, rain };
}

function readOutlook({ now = Date.now() } = {}) {
  const ws = require('./weather-station');
  const todayStart = ws.londonDayStart(now);
  const tomorrowStart = ws.londonDayStart(todayStart + 36 * HOUR);
  const dayAfterStart = ws.londonDayStart(tomorrowStart + 36 * HOUR);
  let points = [];
  try { points = require('./weather-forecast').standingBetween(todayStart, dayAfterStart - 1, now).points || []; } catch (e) {
    console.warn('[HouseholdBoard] forecast not read:', e.message);
  }
  let nowcast = null;
  try { nowcast = cachedNowcast(now); } catch (e) { console.warn('[HouseholdBoard] nowcast not read:', e.message); }
  return composeOutlook({ points, nowcast, nowMs: now, todayStart, tomorrowStart, dayAfterStart });
}

/** Tests only. */
function _resetCaches({ location = null } = {}) {
  _loc = location ? { at: Date.now(), value: location, pending: false } : { at: 0, value: null, pending: false };
  _nc = { at: 0, value: null };
}

module.exports = {
  // pure
  teaView, countdownView, countdownSay, stampWeek, shoppingView, careLine, composeOutlook, isDateKey, daysBetween, addDays, localKey,
  // stores
  readTea, setTea, readNotes, addNote, clearNote, readCountdowns, setCountdown, markedKeys,
  readShopping, shoppingAdd, shoppingBought, readCare, readOutlook, cachedNowcast, _resetCaches,
  // constants
  TEA_KEY, NOTES_KEY, COUNTDOWN_KEY, TEA_MAX, NOTE_MAX, NOTE_KEPT, NOTE_TTL_MS, SHOPPING_SLUG, TO_BUY, BOUGHT,
};
