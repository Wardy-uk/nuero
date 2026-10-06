'use strict';

// Night, and where a screen is — the two facts the display verdict was missing.
//
// Nick, 2 Oct 2026: "the display really should be based on where the device is
// and what time of day it is", then "overnight (times should be a setting) the
// screens should dim — 9pm to 7am for now — unless I'm interacting", and "the
// @home screens should display room info as well, so never nothing".
//
// ⚠ ONE DECISION, THREE OBEYERS. `dim` is composed here and only here. The page
// draws its overlay from it, Fully turns its brightness down from it, and the
// Pi's backlight agent lowers the panel from it. Three of them deciding "is it
// night, and has he touched it" for themselves is three answers about one room.
//
// ⚠ A TOUCH IS RECORDED HERE, NOT IN THE BROWSER, for the same reason: the
// backlight agent is a separate process that cannot see a tap, and a screen that
// woke on the page while its panel stayed dark would look broken.
//
// The window is NEURO's setting (`attention_settings.displayNight`), edited from
// SAiM's Controls. It is fetched in the background and cached, never on the
// display poll — four screens poll every few seconds. Until it has been read the
// default stands, and `source` says so; dimming a little early on a cold start is
// the cheap failure, and nothing here ever goes DARK on a missing read.

const neuroConfig = require('../integrations/neuroConfig');

const DEFAULT_WINDOW = '21:00-07:00';
const SETTINGS_TTL_MS = 60_000;
// How long a touch keeps a dimmed screen awake. Long enough to read what he woke
// it for, short enough that a screen he walked away from goes back down.
const WAKE_MS = Number(process.env.SAIM_DISPLAY_WAKE_MS) || 3 * 60_000;

const settings = { window: DEFAULT_WINDOW, source: 'default', at: 0, inFlight: false };
const wakes = new Map(); // room -> epoch ms the wake lasts until

function parseWindow(raw) {
  const m = String(raw || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}

/** Is `now` inside the window? Wraps midnight. `off` or junk is never night. PURE. */
function inNight(raw, now = new Date()) {
  if (!raw || raw === 'off') return false;
  const w = parseWindow(raw);
  if (!w || w.start === w.end) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return w.start > w.end ? (mins >= w.start || mins < w.end) : (mins >= w.start && mins < w.end);
}

/** The night block for one room. PURE given the window, the wake and the clock. */
function nightFor({ window, source, wokenUntil, now }) {
  const active = inNight(window, now);
  const woken = active && Number.isFinite(wokenUntil) && wokenUntil > now.getTime();
  return {
    active,
    dim: active && !woken,
    window: window || null,
    source,
    wokenUntil: woken ? new Date(wokenUntil).toISOString() : null,
  };
}

function refreshSettings(now = Date.now()) {
  if (settings.inFlight || now - settings.at < SETTINGS_TTL_MS) return;
  const env = process.env;
  if (!neuroConfig.readiness(env).ready) { settings.at = now; return; }
  settings.inFlight = true;
  fetch(`${neuroConfig.getBaseUrl(env)}/api/attention/settings`, {
    headers: { accept: 'application/json', ...neuroConfig.authHeaders(env) },
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const w = d && d.settings && d.settings.displayNight;
      if (w === 'off' || parseWindow(w)) {
        settings.window = w;
        settings.source = d.settings.displayNightSource === 'setting' ? 'setting' : 'default';
      }
    })
    .catch(() => { /* keep the last good window */ })
    .finally(() => { settings.at = Date.now(); settings.inFlight = false; });
}

function night(room, now = new Date()) {
  refreshSettings(now.getTime());
  return nightFor({ window: settings.window, source: settings.source, wokenUntil: wakes.get(room), now });
}

/** A touch on this room's screen. Only matters at night; harmless otherwise. */
function wake(room, now = new Date()) {
  wakes.set(room, now.getTime() + WAKE_MS);
  return night(room, now);
}

// Which Home Assistant area each HOME screen stands in. The screen ids are
// SAiM's (`?room=`), the area names are HA's, and they differ: the study is HA's
// "Office" and the bedroom is "Mum's Room". `SAIM_SCREEN_AREAS=study=Office;...`
// overrides. An offsite screen has no area — it is not in this house.
const DEFAULT_AREAS = { study: 'Office', 'living-room': 'Living Room', bedroom: "Mum's Room", kitchen: 'Kitchen' };

function screenAreas(env = process.env) {
  const out = { ...DEFAULT_AREAS };
  for (const pair of String(env.SAIM_SCREEN_AREAS || '').split(';')) {
    const [k, v] = pair.split('=').map(s => (s || '').trim());
    if (k && v) out[k] = v;
  }
  return out;
}

// ⚠ SHARED SCREENS SHOW NO WORK (Nick, 6 Oct 2026). The living room and the
// bedroom are rooms other people are in, so their screens open on the household
// board (work is "Busy", no subjects — `home-board.js`) even when he is there,
// and work is shown only when he asks for it on the screen. The study, the work
// office, the laptop and the phone are his alone and are unaffected.
// `SAIM_SHARED_SCREENS=living-room,bedroom` overrides.
const DEFAULT_SHARED = ['living-room', 'bedroom'];

function sharedScreens(env = process.env) {
  const raw = env.SAIM_SHARED_SCREENS;
  if (raw == null || !String(raw).trim()) return DEFAULT_SHARED.slice();
  return String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Where a screen is. PURE given the offsite test and the env. */
function placeFor(room, { offsite, env = process.env } = {}) {
  if (offsite) return { place: 'work', area: null, shared: false };
  return {
    place: 'home',
    area: screenAreas(env)[room] || null,
    shared: sharedScreens(env).includes(String(room || '').toLowerCase()),
  };
}

module.exports = { inNight, nightFor, night, wake, placeFor, screenAreas, sharedScreens, DEFAULT_WINDOW, WAKE_MS, _settings: settings };
