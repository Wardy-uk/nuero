'use strict';

/**
 * VESTA — the shared home surface, mounted at /api/v and EXEMPT from the PIN
 * middleware. Served at its own address (vesta.nickward.co.uk).
 *
 *   POST /api/v/login    { username, pin } → a signed session token
 *   GET  /api/v/home     → everything this account may see, in one call
 *   GET  /api/v/wall     → the family wall: week, top tasks, who's in, station
 *   POST /api/v/tasks    { text, for } → add a task
 *   POST /api/v/kitchen  { place, name } → something went in
 *   POST /api/v/kitchen/used { place, name } → something got eaten
 *
 * ⚠ THIS IS PUBLIC. pi5 runs Tailscale Funnel, so an auth exemption publishes
 * these routes to the internet, not merely to the tailnet. That is the point —
 * Nick's partner has no NEURO PIN and must never have one.
 *
 * Three rules hold the boundary, and all three are enforced HERE rather than in
 * the page:
 *
 *  • EVERY read is gated on a SCOPE the account actually holds, and scopes
 *    default closed. An account created before VESTA sees exactly what it saw
 *    yesterday: its own submissions and nothing else.
 *  • THE CALENDAR IS REDACTED IN THE SERVICE. A work subject never enters this
 *    file, so no handler can leak one by forgetting to.
 *  • THE ADMIN HALF IS NOT HERE. Creating accounts and granting scopes lives on
 *    /api/capture-links behind the PIN. An account that could widen its own
 *    scope would make the whole model decorative.
 *
 * ⚠ The mount is `/v/` and the exemption tests `startsWith('/v/')`, one letter
 * from `/v1/` (the FreeReps health wire) and deliberately not `/v`. Same care as
 * `/c/` versus `/capture-links`.
 */

const express = require('express');
const router = express.Router();
const capture = require('../services/capture-links');
const vesta = require('../services/vesta');
const catalogue = require('../services/catalogue');
const vestaVision = require('../services/vesta-vision');
const db = require('../db/database');

/**
 * Resolve the bearer session, or 401.
 *
 * ⚠ Re-reads the account every request rather than trusting the token's claim,
 * so revoking someone — or narrowing their scopes — takes effect immediately
 * rather than in twelve hours.
 */
function requireAccount(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const account = capture.resolveSession(token);
  if (!account) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
  req.account = account;
  next();
}

router.post('/login', (req, res) => {
  try {
    const result = capture.login(req.body && req.body.username, req.body && req.body.pin);
    if (!result.ok) return res.status(result.status || 401).json({ ok: false, error: result.error });
    const account = capture.resolveSession(result.token);
    res.json({
      ok: true,
      token: result.token,
      label: result.label,
      // The page renders only what it is allowed to ask for. This is a
      // CONVENIENCE for the UI, never the enforcement — every route below
      // re-checks, because a client is free to ask for anything.
      scopes: capture.scopesOf(account),
    });
  } catch (e) {
    console.error('[Vesta] Login failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

/**
 * Everything at once. One call because this is a fridge-door screen on a phone
 * over mobile data, and four round trips to render one page is three too many.
 *
 * Each block is independently guarded and reports its own failure: a kitchen
 * file that will not parse must not blank the calendar, and vice versa.
 */
router.get('/home', requireAccount, async (req, res) => {
  const out = { ok: true, label: req.account.label, scopes: capture.scopesOf(req.account), gaps: [] };

  // ── Tasks ────────────────────────────────────────────────────────────────
  try {
    out.tasks = capture.submissions(req.account);
    // Who a task can be assigned to. From the service so the page never keeps
    // its own list of the household — that is how a picker comes to offer
    // somebody who has been revoked.
    out.people = capture.people();
  } catch (e) {
    out.tasks = null;
    out.gaps.push({ block: 'tasks', why: e.message });
  }

  // ── Nick's walk (hike safety) ────────────────────────────────────────────
  // ⚠ ABSENT without the `hike` scope. With it, positions only while a walk is
  // armed or overdue — services/hike-safety.householdView decides, not here.
  if (capture.hasScope(req.account, 'hike')) {
    try {
      out.hike = require('../services/hike-safety').householdView();
    } catch (e) {
      out.hike = null;
      out.gaps.push({ block: 'hike', why: 'could not read the walk' });
      console.error('[Vesta] Hike block failed:', e.message);
    }
  }

  // ── Household energy ─────────────────────────────────────────────────────
  // ⚠ ABSENT without the `energy` scope. services/energy.householdView decides
  // what leaves NEURO: daily kWh, estimated £, freshness — never half-hours,
  // tariffs or anything about the Bright login.
  if (capture.hasScope(req.account, 'energy')) {
    try {
      out.energy = require('../services/energy').householdView();
    } catch (e) {
      out.energy = null;
      out.gaps.push({ block: 'energy', why: 'could not read the energy meters' });
      console.error('[Vesta] Energy block failed:', e.message);
    }
  }

  // ── Where Nick is in the house ───────────────────────────────────────────
  //
  // ⚠ ABSENT unless the account holds `presence`, not hidden. The section is
  // not mounted at all, exactly as a private catalogue answers the same 404 a
  // missing one does — the client enforces nothing and must never start.
  //
  // ⚠ COARSE ON PURPOSE: the room NAME and nothing else. No RSSI, no scores, no
  // history, no timestamps of movement. A stream of those is a record of what
  // somebody did all day, which is a different thing from "he's in the kitchen"
  // and is not what was asked for.
  //
  // ⚠ Three renderings stay distinct, the `Section.jsx` rule: `known:false` with
  // a reason (could not tell), a room (he is there), and `home:false` (out of
  // the house). "I couldn't read it" and "he's out" send her to different
  // rooms, and merging them is how this surface starts lying.
  if (capture.hasScope(req.account, 'presence')) {
    try {
      const roomPresence = require('../services/room-presence');
      const whereabouts = require('../services/whereabouts');
      const r = await roomPresence.read();
      // Town scale, for when the house sensors cannot see him. ⚠ Only a NAMED
      // zone — `home`/`not_home` are refused upstream because that geofence is
      // 90m off centre and would tell her he had gone out while he sat here.
      let zone = null;
      try {
        const ha = require('../services/ha');
        if (ha.isConfigured()) {
          const phone = await ha.getPhoneStatus();
          zone = phone && phone.presence ? phone.presence : null;
        }
      } catch { /* coarser answer, never an error */ }
      const w = whereabouts.describe(r, zone);
      out.presence = w.known
        ? { known: true, label: w.label, kind: w.kind, room: w.room, subject: w.subject }
        // The classifier's own reason, generalised — it can name sensors and
        // calibration state, which is Nick's business and not hers.
        : { known: false, why: "can't tell which room" };
    } catch (e) {
      out.presence = { known: false, why: "can't tell which room" };
      out.gaps.push({ block: 'presence', why: e.message });
    }
  }

  // ── Calendar ─────────────────────────────────────────────────────────────
  if (capture.hasScope(req.account, 'calendar')) {
    try {
      // TODAY only. The home screen answers "what is happening now"; any other
      // day is a deliberate ask and goes through /calendar below. A rolling
      // three-day list was neither one thing nor the other — too long to scan
      // at a glance and too short to plan against.
      out.calendar = vesta.redactDay(db.getCalendarEvents(dayBounds(_today()).from, dayBounds(_today()).to) || []);
      out.calendarDate = _today();
    } catch (e) {
      out.calendar = null;
      out.gaps.push({ block: 'calendar', why: e.message });
    }
  }

  // ── Catalogues ───────────────────────────────────────────────────────────
  //
  // The kitchen is one of these, not a special case. Only catalogues whose OWN
  // frontmatter says `shared: true` are reachable — his vinyl does not go on the
  // public internet because he made a list.
  if (capture.hasScope(req.account, 'kitchen')) {
    const shared = vesta.sharedCatalogues();
    if (!shared.ok) {
      out.catalogues = null;
      // ⚠ Unreadable is NOT empty. An empty freezer and an unmounted disk must
      // never render alike, or she shops for food that is already in.
      out.gaps.push({ block: 'catalogues', why: shared.why });
    } else {
      out.catalogues = shared.catalogues;
      const kitchen = vesta.readKitchen();
      if (kitchen.ok) {
        out.kitchen = kitchen.cat.items;
        out.kitchenSections = kitchen.cat.sections;
        out.meals = vesta.suggestMeals(kitchen.cat);
        // Whether the camera button is worth showing at all. The same principle
        // as `scopes`: the page renders what it is allowed to, rather than
        // offering a control that answers 503 when tapped. Still not the
        // enforcement — the route re-checks the flag on every call.
        out.photo = vestaVision.isEnabled();
      } else if (!kitchen.notFound && !kitchen.notShared) {
        out.gaps.push({ block: 'kitchen', why: kitchen.why });
      }
    }
  }

  res.json(out);
});


// ⚠ Local getters, never toISOString() — that shifts to UTC and lands the whole
// query on the wrong day west of here, which is the calendar bug NEURO has
// already had once.
function _pad(n) { return String(n).padStart(2, '0'); }
function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}
function dayBounds(dateKey) {
  return { from: `${dateKey}T00:00:00`, to: `${dateKey}T23:59:59` };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One day of his diary, redacted, for the date picker.
 *
 * Gated on the SAME `calendar` scope as the home block — a second door to the
 * same data with a weaker lock is how a scope becomes decorative.
 *
 * ⚠ The date is validated against a strict pattern rather than fed to `new
 * Date()`, which happily accepts nonsense and answers for some other day.
 */
router.get('/calendar', requireAccount, (req, res) => {
  if (!capture.hasScope(req.account, 'calendar')) {
    return res.status(403).json({ ok: false, error: 'Not enabled for this account.' });
  }
  const date = String((req.query && req.query.date) || '') || _today();
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ ok: false, error: 'that is not a date I understand' });
  }
  try {
    const { from, to } = dayBounds(date);
    res.json({ ok: true, date, events: vesta.redactDay(db.getCalendarEvents(from, to) || []) });
  } catch (e) {
    console.error('[Vesta] Calendar day failed:', e.message);
    // ⚠ `events: null` with a reason, never an empty array — "I could not read
    // your diary" and "nothing on that day" must not render alike.
    res.status(500).json({ ok: false, error: 'I could not read the diary just now.' });
  }
});

/**
 * The family wall — the always-on screen in the house, polled every minute.
 * One call, every block guarded on its own scope and reporting its own failure:
 *   tasks    — always (what an account IS); the top OPEN ones, soonest first
 *   week     — `calendar`: seven days from `from` (default today), REDACTED by
 *              the same `redactDay` as /home, so "Busy" stays "Busy"
 *   who, station — `house`: names + home/out/unknown, and the weather station
 * A block the account cannot see is ABSENT, never empty.
 */
router.get('/wall', requireAccount, (req, res) => {
  const today = _today();
  const from = String((req.query && req.query.from) || '') || today;
  if (!DATE_RE.test(from)) {
    return res.status(400).json({ ok: false, error: 'that is not a date I understand' });
  }
  // A week (7), the wall's eight-day strip (8) or a month grid (42 = six weeks).
  // Anything else is refused, never clamped.
  const span = req.query && req.query.days != null ? Number(req.query.days) : 7;
  if (span !== 7 && span !== 8 && span !== 42) {
    return res.status(400).json({ ok: false, error: 'days must be 7, 8 or 42' });
  }
  const out = { ok: true, label: req.account.label, scopes: capture.scopesOf(req.account), today, from, days: span, gaps: [], at: new Date().toISOString() };

  // The wall reports what is keeping its screen on (keep-awake method, home
  // screen or browser, whether the Wake Lock API exists, the iOS version) so a
  // screen that keeps sleeping can be diagnosed from the Pi. Bounded and
  // filtered to a fixed character set; nothing about the device beyond that.
  const held = String((req.query && req.query.held) || '').replace(/[^\w .;=+-]/g, '').slice(0, 100);
  if (held) {
    try {
      const seen = JSON.parse(db.getState('vesta_wall_seen') || '{}') || {};
      seen[req.account.username] = { at: out.at, held };
      db.setState('vesta_wall_seen', JSON.stringify(seen));
    } catch (e) { console.warn('[Vesta] Could not record the wall keep-awake report:', e.message); }
  }

  try {
    // The jobs card scrolls (Nick, 17 Oct 2026), so it carries the whole open list up to 50.
    out.tasks = vesta.topTasks(capture.submissions(req.account), today, 50);
    // A short label for the wall beside each task's own wording (display only;
    // the record is untouched — see services/task-titles.js).
    try {
      const short = require('../services/task-titles').titlesFor(out.tasks.tasks);
      out.tasks.tasks = out.tasks.tasks.map((t) => ({ ...t, short: short[t.id] || null }));
    } catch (e) { console.warn('[Vesta] Wall short titles failed:', e.message); }
  } catch (e) {
    out.tasks = null;
    out.gaps.push({ block: 'tasks', why: 'could not read the tasks' });
    console.error('[Vesta] Wall tasks failed:', e.message);
  }

  if (capture.hasScope(req.account, 'calendar')) {
    try {
      const keys = vesta.dayKeys(from, span);
      // Read from a week EARLIER: the cache is keyed on start time, and a
      // holiday that began last Saturday is still on this week's wall.
      const [y, m, d] = from.split('-').map(Number);
      const back = new Date(y, m - 1, d - 7);
      const lookback = `${back.getFullYear()}-${_pad(back.getMonth() + 1)}-${_pad(back.getDate())}`;
      const rows = db.getCalendarEvents(`${lookback}T00:00:00`, `${keys[keys.length - 1]}T23:59:59`) || [];
      // Whether he is at work comes from the WORKING-DAY rule and People HR
      // (via NOVA) — never from the diary alone (17 Oct 2026).
      const workingDays = require('../services/working-days');
      const availability = require('../services/team-availability');
      let snap = null;
      try { snap = availability.snapshot(); } catch { snap = null; }
      out.week = vesta.redactWeek(rows, from, span, {
        isWorkingDay: (d) => { try { return workingDays.isWorkingDay(d); } catch { return true; } },
        offOn: (d) => { try { return availability.selfAbsenceOn(d, snap); } catch { return null; } },
      });
    } catch (e) {
      // ⚠ `null` with a reason — an unreadable diary is not an empty week.
      out.week = null;
      out.gaps.push({ block: 'week', why: 'could not read the diary' });
      console.error('[Vesta] Wall week failed:', e.message);
    }
  }

  if (capture.hasScope(req.account, 'energy')) {
    try {
      out.energy = require('../services/energy').householdView();
    } catch (e) {
      out.energy = null;
      out.gaps.push({ block: 'energy', why: 'could not read the energy meters' });
      console.error('[Vesta] Wall energy failed:', e.message);
    }
  }

  if (capture.hasScope(req.account, 'house')) {
    try {
      out.who = vesta.whoIsIn(require('../services/household').read());
    } catch (e) {
      out.who = { known: false, why: "can't see the house" };
      out.gaps.push({ block: 'who', why: "can't see the house" });
      console.error('[Vesta] Wall household failed:', e.message);
    }
    try {
      out.station = require('../services/home-board').readStation(Date.now());
      // The current condition from Home Assistant's weather entity, for one
      // icon beside the temperature. Cached; absent until first read.
      try {
        const c = require('../services/ha-rooms').cachedCondition();
        out.station.condition = c && c.known ? c.condition : null;
        out.station.conditionLabel = c && c.known ? require('../services/home-board').conditionLabel(c.condition) : null;
      } catch { out.station.condition = null; }
      // The sun's height at the house, for the background's time of day. Absent
      // until first read; the wall then falls back to its own calculation.
      try {
        const sun = require('../services/ha-rooms').cachedSun();
        out.sun = sun && sun.known ? { elevation: sun.elevation, rising: sun.rising } : null;
      } catch { out.sun = null; }
    } catch (e) {
      out.station = { known: false, why: 'the weather station could not be read' };
      console.error('[Vesta] Wall station failed:', e.message);
    }
  }

  res.json(out);
});

/**
 * A household member's photo for the wall's "Who's in" card. Behind the
 * `house` scope, and ONLY for someone the wall is showing right now — a
 * visitor who is out is not on the wall, so neither is their photo.
 */
router.get('/photo/:id', requireAccount, (req, res) => {
  if (!capture.hasScope(req.account, 'house')) {
    return res.status(403).json({ ok: false, error: 'Not enabled for this account.' });
  }
  try {
    const household = require('../services/household');
    const shown = vesta.whoIsIn(household.read()).people || [];
    const id = String(req.params.id || '');
    if (!shown.some((p) => p.id === id && p.photo)) return res.status(404).json({ ok: false, error: 'no photo' });
    const f = household.photoFile(id);
    if (!f) return res.status(404).json({ ok: false, error: 'no photo' });
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(f.ext === 'jpg' ? 'jpeg' : f.ext);
    res.sendFile(f.path);
  } catch (e) {
    console.error('[Vesta] Photo failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

// GET /api/v/hike — Nick's armed walk for the household tracker, polled while he is out. Same `hike` scope as the home block.
router.get('/hike', requireAccount, (req, res) => {
  if (!capture.hasScope(req.account, 'hike')) {
    return res.status(403).json({ ok: false, error: 'Not enabled for this account.' });
  }
  try {
    res.json({ ok: true, hike: require('../services/hike-safety').householdView() });
  } catch (e) {
    console.error('[Vesta] Hike read failed:', e.message);
    res.status(500).json({ ok: false, error: 'I could not read the walk just now.' });
  }
});

// POST /api/v/tasks — reuses the existing submission path, so the throttle, the
// length cap and the personal-domain rule all still apply unchanged.
router.post('/tasks', requireAccount, (req, res) => {
  try {
    const result = capture.submit(req.account, req.body && req.body.text, {
      // Who it is FOR. Resolved against the real household in the service; an
      // unrecognised name lands as unassigned rather than being stored as given.
      assignees: (req.body || {}).assignees,
      assignee: (req.body || {}).assignee,
      dueDate: (req.body || {}).dueDate,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[Vesta] Task submit failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

/**
 * Change a household task — its due date, who it is for, or whether it is done.
 *
 * ⚠ Ownership is re-checked in the SERVICE against the database on every call,
 * never taken from the id the client sends. A task this account cannot see
 * comes back as MISSING rather than forbidden, so this cannot be walked to find
 * out which ids are Nick's.
 */
router.patch('/tasks/:id', requireAccount, (req, res) => {
  try {
    const result = capture.updateTask(req.account, req.params.id, req.body || {});
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
    res.json(result);
  } catch (e) {
    console.error('[Vesta] Task update failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

function kitchenGate(req, res, next) {
  if (!capture.hasScope(req.account, 'kitchen')) {
    return res.status(403).json({ ok: false, error: 'Not enabled for this account.' });
  }
  next();
}

/**
 * ⚠ The scope grants the SHARED catalogues, never a slug of the caller's
 * choosing. Without this, a granted account could name any catalogue in the
 * vault and read it — the private ones are the entire reason `shared` exists.
 * Re-read every request rather than trusted from a list sent earlier.
 */
function sharedCatalogueOr404(slug, res) {
  const found = catalogue.read(slug);
  if (!found.ok) {
    res.status(found.notFound ? 404 : 400).json({ ok: false, error: found.why });
    return null;
  }
  if (found.cat.shared !== true) {
    // Deliberately the SAME answer a missing catalogue gives, so this cannot be
    // used to enumerate what he owns.
    res.status(404).json({ ok: false, error: 'no such catalogue' });
    return null;
  }
  return found;
}

router.post('/catalogue/:slug/add', requireAccount, kitchenGate, (req, res) => {
  if (!sharedCatalogueOr404(req.params.slug, res)) return;
  const { section, name } = req.body || {};
  const result = catalogue.addItem(req.params.slug, section, name);
  if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.why });
  res.json({ ok: true, already: !!result.already, items: result.cat.items, sections: result.cat.sections });
});

// `used` rather than DELETE: a POST works from a form on a phone with no fetch
// shenanigans, and the word says what actually happened.
router.post('/catalogue/:slug/used', requireAccount, kitchenGate, (req, res) => {
  if (!sharedCatalogueOr404(req.params.slug, res)) return;
  const { section, name } = req.body || {};
  const result = catalogue.removeItem(req.params.slug, section, name);
  if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.why });
  res.json({ ok: true, items: result.cat.items, sections: result.cat.sections });
});

/**
 * A photograph of the shelf, turned into a list she confirms.
 *
 * ⚠ IT CREATES NOTHING. The response is a PROPOSAL; each item she keeps is then
 * added through `/catalogue/:slug/add` above, exactly as a typed one is. That is
 * Nick's own condition on this feature and it is also the safe shape — a vision
 * model is right most of the time, and "most of the time" is not good enough to
 * write a fact about the freezer that somebody will shop against.
 *
 * ⚠ The photo is never stored, never logged and never echoed back. It lives in
 * memory for this request only. See `services/vesta-vision.js`.
 *
 * Gated three deep, because this is the one route on the public mount that
 * spends money: the `kitchen` scope, `VESTA_PHOTO_ENABLED` (default FALSE), and
 * a per-account daily cap.
 */
router.post('/catalogue/:slug/scan', requireAccount, kitchenGate, async (req, res) => {
  const found = sharedCatalogueOr404(req.params.slug, res);
  if (!found) return;

  const { image, mediaType } = req.body || {};
  try {
    const result = await vestaVision.proposeFromPhoto({
      username: req.account.username,
      imageBase64: image,
      mediaType,
      // The catalogue's REAL sections, read fresh — never a list the client
      // sent, which would let a caller name a section it invented.
      sections: found.cat.sections,
    });
    if (!result.ok) {
      // 503 when the feature is off or unreachable, 429 when she has used the
      // day's allowance, 400 when the photo itself is the problem. Distinct
      // because the thing to do about each is different.
      const status = result.disabled ? 503 : (result.cap && result.used >= result.cap) ? 429 : 400;
      return res.status(status).json({ ok: false, error: result.why });
    }
    res.json({ ok: true, proposed: result.proposed, used: result.used, cap: result.cap });
  } catch (e) {
    // ⚠ Never the raw message — this mount is public and the message can carry
    // model, key and account detail.
    console.error('[Vesta] Photo scan failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

module.exports = router;
