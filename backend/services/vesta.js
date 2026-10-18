'use strict';

/**
 * VESTA — the shared home surface.
 *
 * Nick, 31 Aug 2026: evolve the standalone task page for his partner into a
 * generalised capture/display surface she can actually use. First iteration:
 * shared tasks and their state, his calendar with work redacted to "Busy", what
 * is in the fridge and freezer, and something to eat out of it.
 *
 * Named for the goddess of hearth and home, and it sits beside SAiM rather than
 * inside her: SAiM is Nick's, VESTA is the household's.
 *
 * ── The one rule everything here follows ────────────────────────────────────
 * ⚠ **REDACTION HAPPENS HERE, ON THE SERVER, NEVER IN THE PAGE.** If a work
 * subject line reaches the browser it has leaked, whatever the component chooses
 * to render — a devtools tab, a cached response, a screenshot of a network
 * panel. `redactEvent()` is where a title becomes "Busy", and the full subject
 * is not in the object it returns.
 *
 * ⚠ **This is served to the PUBLIC INTERNET.** pi5 runs Tailscale Funnel, so the
 * auth exemption that lets his partner in without a NEURO PIN publishes these
 * routes to anyone who finds them. Everything below follows from that sentence,
 * and it is the same reasoning `capture-links.js` already carries — VESTA
 * reuses that file's accounts, PINs, brute-force throttle and sessions rather
 * than inventing a second credential system.
 *
 * ⚠ **It widens what an account can see, so it is gated per account and DEFAULTS
 * CLOSED** (`capture-links` SCOPES). The old rule was "an account sees only its
 * own submissions"; calendar and kitchen are a real step past that, and an
 * account created before this gets exactly what it had yesterday.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Nick's work tasks, his queue, his inbox, his health, his people notes, his
 * meeting notes, anything from the vault other than the kitchen file, and any
 * ability to change an account. A compromised VESTA login must be worth almost
 * nothing.
 *
 * ── What is NOT here any more ───────────────────────────────────────────────
 * The kitchen's file format and CRUD moved to `services/catalogue.js` while this
 * was being written — the fridge is one CATALOGUE among many (vinyl, hiking
 * equipment), and it never earned a bespoke store. VESTA keeps the two things
 * that are genuinely its own: redacting the diary, and knowing what can be
 * cooked out of a list.
 *
 * PURE where it judges: `redactEvent`, `domainOf` and `suggestMeals` take plain
 * data and return plain data, so the redaction rules pin without a database, a
 * vault or a clock.
 *
 * CommonJS — NEURO backend convention.
 */

// ── Calendar ─────────────────────────────────────────────────────────────────

/**
 * One calendar row as VESTA is allowed to see it. PURE.
 *
 * Nick's call (31 Aug): work shows as time + "Busy"; personal shows its real
 * title. The split is `domain`, which NEURO already carries — it is not guessed
 * from the wording here, because a classifier having an off day would be the
 * thing that leaks a client name.
 *
 * ⚠ The returned object CONTAINS NO SUBJECT for a work event. Not a truncated
 * one, not one on a field the page happens not to render. It is not there.
 */
function redactEvent(event = {}, { domain = 'work' } = {}) {
  const isPersonal = domain === 'personal';
  const allDay = !!(event.is_all_day || event.isAllDay);

  const out = {
    id: event.event_id || event.id || null,
    start: event.start_time || event.start || null,
    end: event.end_time || event.end || null,
    allDay,
    // "Busy" and nothing else. The word is deliberately dull: "Meeting" or
    // "Work" would still say something about the shape of his day that he did
    // not agree to share.
    title: isPersonal ? (event.subject || event.title || 'Something') : 'Busy',
    personal: isPersonal,
  };

  // Location is a leak too — "Chancellors' Offices, Coalville" names a customer
  // as plainly as a subject line does. Personal only.
  if (isPersonal && event.location) out.location = String(event.location).slice(0, 80);
  // The shared family calendar's events can be changed from the wall: say so,
  // with the id Google knows it by. Never on anything else.
  if (isPersonal && String(event.source || '') === 'google' && event.google_id) {
    out.editable = true;
    out.calendarId = String(event.google_id);
    if (event.recurring) out.recurring = true;
  }

  return out;
}

/**
 * Which calendar an event came from, as a domain. PURE.
 *
 * ⚠ Measured, not assumed: `calendar_cache.source` is `graph` (Microsoft 365 —
 * work) or `apple` (his own iCloud calendar — personal). Checked against the
 * live table rather than guessed, because guessing the wrong way round here
 * publishes a client meeting.
 *
 * ⚠ FAILS CLOSED. ONLY `apple` is personal. A new calendar source added later
 * is work until somebody decides otherwise, and an event with no source at all
 * is work — the unclassified event is exactly the one most likely to be a client
 * meeting, and guessing "personal" once is a leak that cannot be taken back.
 */
function domainOf(event = {}) {
  if (event.domain === 'personal' || event.domain === 'work') return event.domain;
  // `google` is the shared FAMILY Google calendar (18 Oct 2026) — family by
  // definition; it is the only Google calendar NEURO reads.
  const src = String(event.source || '').toLowerCase();
  return src === 'apple' || src === 'google' ? 'personal' : 'work';
}

/** A whole day, redacted. PURE. Cancelled and free-marked events are dropped:
 *  they are not commitments and padding her view with them helps nobody. */
function redactDay(events = []) {
  return events
    // ⚠ 'free' hides WORK placeholders only (18 Oct 2026). Every all-day phone
    // and family-calendar entry is stored as 'free' (so a birthday does not
    // block an afternoon), and filtering them all meant no all-day family event
    // — hiking, a birthday, a day trip — had ever reached the wall.
    .filter(e => e && (String(e.show_as || '').toLowerCase() !== 'free' || (domainOf(e) === 'personal' && !!(e.is_all_day || e.isAllDay))))
    .filter(e => !/cancelled/i.test(String(e.show_as || '')))
    .map(e => redactEvent(e, { domain: domainOf(e) }))
    .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
}

// ── The family wall (15 Oct 2026) ────────────────────────────────────────────
//
// Nick: an always-on iPad in the house showing the week's calendar, the top
// family tasks, who is in, and the weather station. It is VESTA, not SAiM — a
// shared screen must hold a household login, never his.

const _p2 = (n) => String(n).padStart(2, '0');

/** `n` consecutive YYYY-MM-DD keys from `startKey`. PURE. Built from LOCAL date
 *  parts only — no time of day, so no offset can move a key. */
function dayKeys(startKey, n = 7) {
  const [y, m, d] = String(startKey).split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(y, m - 1, d + i);
    out.push(`${t.getFullYear()}-${_p2(t.getMonth() + 1)}-${_p2(t.getDate())}`);
  }
  return out;
}

/**
 * Which of `keys` a redacted event falls on. PURE, string comparisons only.
 * An all-day event's end date is EXCLUSIVE (Graph and EventKit both); a timed
 * event ending at exactly midnight does not reach into the next day.
 */
function daysOf(e, keys) {
  const s = String(e.start || '').slice(0, 10);
  if (!s) return [];
  let last = String(e.end || '').slice(0, 10) || s;
  const endsAtMidnight = String(e.end || '').slice(11, 16) === '00:00';
  if ((e.allDay || endsAtMidnight) && last > s) {
    const i = keys.indexOf(last);
    last = i > 0 ? keys[i - 1] : (last > keys[keys.length - 1] ? keys[keys.length - 1] : s);
  }
  if (last < s) last = s;
  return keys.filter((k) => k >= s && k <= last);
}

/**
 * A week of the diary, one entry per day, REDACTED by `redactDay` — the same
 * rule as today's list, so a work subject cannot reach the wall by a second
 * door. PURE.
 */
// A phone entry whose title SAYS it is a birthday or anniversary is a DATE,
// not an appointment — the phone held "Wedding anniversary" at 13:00–14:00
// (17 Oct 2026). Same title rule `personal-dates` uses.
const DATE_TITLE = /\b(birthday|anniversary)\b/i;

/**
 * A week of the diary, one entry per day, REDACTED by `redactDay` — the same
 * rule as today's list, so a work subject cannot reach the wall by a second
 * door. PURE: `isWorkingDay(date)` and `offOn(date)` are passed in.
 *
 * Nick, 17 Oct 2026: "just show that I'm AT work — not what I'm doing". A
 * day's work events become ONE span (no events, no count, no titles), and
 * only on evidence he is actually at work:
 *   • booked off (People HR via NOVA) → `off: true`, never at work;
 *   • a weekend / bank holiday → only a timed work event WITH OTHER PEOPLE
 *     counts (his 12:00 lunch hold runs every day, Saturdays included);
 *   • an all-day Outlook entry never makes him "at work" on its own — those
 *     are leave and location markers far more often than work.
 */
function redactWeek(rows = [], startKey, n = 7, { isWorkingDay = null, offOn = null } = {}) {
  const keys = dayKeys(startKey, n);
  const withOthers = new Set((rows || []).filter((r) => r && Number(r.attendees_other) === 1).map((r) => r.event_id || r.id));
  const byDay = Object.fromEntries(keys.map((k) => [k, []]));
  for (const raw of redactDay(rows)) {
    const e = raw.personal && !raw.allDay && DATE_TITLE.test(String(raw.title || ''))
      ? { ...raw, allDay: true, start: `${String(raw.start || '').slice(0, 10)}T00:00:00`, end: null }
      : raw;
    for (const k of daysOf(e, keys)) {
      // The same all-day entry held by two phone calendars (a birthday in both
      // Birthdays and a shared calendar) is shown once — same day, same words.
      if (e.allDay && byDay[k].some((x) => x.allDay && String(x.title || '').trim().toLowerCase() === String(e.title || '').trim().toLowerCase())) continue;
      byDay[k].push(e);
    }
  }
  return keys.map((date) => {
    const family = byDay[date].filter((e) => e.personal);
    const off = typeof offOn === 'function' ? offOn(date) : null;
    const working = typeof isWorkingDay === 'function' ? isWorkingDay(date) : true;
    let atWork = null;
    if (!(off && off.off)) {
      const work = byDay[date]
        .filter((e) => !e.personal && !e.allDay)
        .filter((e) => working || withOthers.has(e.id));
      if (work.length) {
        // Clipped to this day: a span that runs past midnight ends at 23:59.
        const starts = work.map((e) => (String(e.start || '').slice(0, 10) < date ? `${date}T00:00:00` : String(e.start || '')));
        const ends = work.map((e) => (String(e.end || '').slice(0, 10) > date ? `${date}T23:59:00` : String(e.end || '')));
        atWork = { allDay: false, start: starts.sort()[0], end: ends.sort().slice(-1)[0] };
      }
    }
    return {
      date,
      work: atWork,
      // Off is said only when People HR KNOWS he is off; "could not ask" is not a day off.
      off: !!(off && off.off),
      events: family.sort((a, b) => (Number(b.allDay) - Number(a.allDay)) || String(a.start || '').localeCompare(String(b.start || ''))),
    };
  });
}

/**
 * The family tasks worth a wall, from `capture-links.submissions()`. PURE.
 * Open only; dated before undated, soonest first; then newest. A task due
 * before today is `overdue`, never silently re-dated.
 */
function topTasks(tasks = [], todayKey, limit = 8) {
  const open = (tasks || []).filter((t) => t && (t.status === 'to do' || t.status === 'in progress'));
  open.sort((a, b) => {
    const ad = a.dueDate || '9999-99-99';
    const bd = b.dueDate || '9999-99-99';
    return ad.localeCompare(bd) || String(b.addedAt || '').localeCompare(String(a.addedAt || ''));
  });
  return {
    total: open.length,
    tasks: open.slice(0, limit).map((t) => ({
      id: t.id,
      text: t.text,
      status: t.status,
      dueDate: t.dueDate || null,
      overdue: !!(t.dueDate && t.dueDate < todayKey),
      dueToday: t.dueDate === todayKey,
      who: Array.isArray(t.assigneeLabels) ? t.assigneeLabels : [],
      // The ids behind `who`, so the wall can show and change who a job is for.
      assignees: Array.isArray(t.assignees) ? t.assignees : [],
      notes: t.notes || null,
      priority: t.priority || null,
    })),
  };
}

/** Household jobs finished in the last `days` days, newest first — so the wall can reopen one. PURE. */
function recentlyDone(tasks = [], todayKey, days = 14, limit = 20) {
  const [y, m, d] = String(todayKey).split('-').map(Number);
  const from = new Date(y, m - 1, d - days);
  const fromKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  return (tasks || [])
    .filter((t) => t && t.status === 'done' && t.doneAt && String(t.doneAt).slice(0, 10) >= fromKey)
    .sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)))
    .slice(0, limit)
    .map((t) => ({ id: t.id, text: t.text, notes: t.notes || null, doneAt: t.doneAt, who: Array.isArray(t.assigneeLabels) ? t.assigneeLabels : [], assignees: t.assignees || [] }));
}

/**
 * Who is in, from `household.read()`. PURE.
 *
 * ⚠ NAMES AND A STATE ONLY — no rooms, no "at work" detail, no photos, no
 * timestamps. Visitors appear only while positively home (an "Out" for someone
 * who is always out is noise, and `unknown` hides them too). A failed source
 * is `known: false`, never everybody out.
 */
function whoIsIn(hh) {
  if (!hh || !Array.isArray(hh.members)) return { known: false, why: "can't see the house" };
  const people = hh.members
    .filter((m) => m && m.name && (m.role !== 'visitor' || m.state === 'home'))
    .filter((m) => m.role !== 'companion' || m.state !== 'untracked')
    .map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role === 'companion' ? 'companion' : 'person',
      state: m.state === 'home' ? 'home' : m.state === 'away' ? 'out' : 'unknown',
      // Only WHETHER a photo exists (a cache-busting version). The picture is
      // fetched through /api/v/photo/:id, which serves only people on this list.
      photo: m.photo && m.photo.version ? m.photo.version : null,
    }));
  return {
    known: !!hh.known,
    why: hh.known ? null : "can't see the house just now",
    homeCount: people.filter((p) => p.role === 'person' && p.state === 'home').length,
    people,
  };
}

// ── The kitchen is a CATALOGUE ───────────────────────────────────────────────
//
// Nick, 31 Aug 2026, while this was being built: *"this should be a more
// generalised cataloguing tool — I might want to catalogue my vinyl collection,
// or my hiking equipment."* Right, and caught early enough that the fridge never
// got its own bespoke store.
//
// So the parsing, the file format and the CRUD all live in `services/catalogue.js`
// and the kitchen is simply the catalogue slugged `kitchen`. VESTA adds exactly
// one kitchen-specific thing on top: knowing what you can cook out of it.
//
// ⚠ A catalogue is only reachable from VESTA when its own frontmatter says
// `shared: true`, which DEFAULTS FALSE. His vinyl is not on the public internet
// because he made a list.

const catalogue = require('./catalogue');

const KITCHEN_SLUG = 'kitchen';

/** Every catalogue VESTA may see. Filtered by the CATALOGUE's own `shared`
 *  flag, not by a list kept here — a second place deciding what is shared is a
 *  second place to get it wrong. */
function sharedCatalogues() {
  const listed = catalogue.list();
  if (!listed.ok) return { ok: false, why: listed.why, catalogues: [] };
  return { ok: true, catalogues: listed.catalogues.filter(c => c.shared === true) };
}

/** The kitchen, if it exists and is shared. */
function readKitchen() {
  const found = catalogue.read(KITCHEN_SLUG);
  if (!found.ok) return { ok: false, why: found.why, notFound: found.notFound };
  if (found.cat.shared !== true) {
    // Refused rather than served: the flag is the whole permission, and honouring
    // it only in the list would make it decorative.
    return { ok: false, why: 'the kitchen catalogue is not shared', notShared: true };
  }
  return { ok: true, cat: found.cat };
}

// ── Meals ────────────────────────────────────────────────────────────────────

// Rough pantry staples that are almost always in and should not stop a
// suggestion from being made. Deliberately short: assuming too much is how a
// suggestion turns into a shopping list nobody asked for.
const ASSUMED = ['salt', 'pepper', 'oil', 'butter', 'flour'];

/**
 * What could be made from what is in. PURE, deterministic, no model call.
 *
 * ⚠ Rules rather than AI, first iteration, and the reason is honesty rather
 * than cost: a model asked "what can I make from milk and half a cabbage" will
 * cheerfully invent a recipe that needs four things that are not there, and it
 * will do it convincingly. A rule that only fires when its ingredients are
 * ACTUALLY on the list can be wrong about whether you fancy it, but not about
 * whether you can make it.
 *
 * Every suggestion names which of its ingredients it FOUND, so the reason it is
 * being offered is on the card and can be disagreed with.
 */
const MEALS = [
  { name: 'Omelette', needs: ['egg'], nice: ['cheese', 'mushroom', 'ham', 'onion'] },
  { name: 'Scrambled eggs on toast', needs: ['egg', 'bread'], nice: [] },
  { name: 'Pasta with whatever is in', needs: ['pasta'], nice: ['tomato', 'cheese', 'bacon', 'onion', 'garlic'] },
  { name: 'Stir fry', needs: ['rice'], nice: ['chicken', 'pepper', 'onion', 'cabbage', 'carrot', 'broccoli'] },
  { name: 'Jacket potato', needs: ['potato'], nice: ['cheese', 'beans', 'tuna', 'butter'] },
  { name: 'Soup', needs: ['stock'], nice: ['carrot', 'onion', 'potato', 'leek', 'cabbage'] },
  { name: 'Roast chicken', needs: ['chicken'], nice: ['potato', 'carrot', 'onion'] },
  { name: 'Chilli', needs: ['mince'], nice: ['beans', 'tomato', 'onion', 'rice', 'pepper'] },
  { name: 'Curry', needs: ['curry'], nice: ['chicken', 'rice', 'onion', 'tomato'] },
  { name: 'Cheese toastie', needs: ['bread', 'cheese'], nice: ['ham', 'onion'] },
  { name: 'Fish and veg', needs: ['fish'], nice: ['potato', 'peas', 'broccoli', 'carrot'] },
  { name: 'Beans on toast', needs: ['beans', 'bread'], nice: ['cheese'] },
];

/** Does the stock list contain something matching this ingredient word? */
function _have(stock, word) {
  if (ASSUMED.includes(word)) return true;
  return stock.some(item => item.includes(word));
}

function suggestMeals(cat = {}, { limit = 4 } = {}) {
  // Everything in every section — a tin in the cupboard counts as much as
  // something in the fridge.
  const stock = Object.values(cat.items || {})
    .flat()
    .map(i => String((i && i.name) || '').toLowerCase());

  if (!stock.length) {
    // ⚠ "Nothing in" and "we have not been told what is in" are different facts.
    // Suggesting meals from an empty list would be inventing a fridge.
    return { known: false, why: 'nothing recorded in the kitchen yet', meals: [] };
  }

  const scored = [];
  for (const meal of MEALS) {
    const missing = meal.needs.filter(n => !_have(stock, n));
    if (missing.length) continue;
    const extras = meal.nice.filter(n => _have(stock, n));
    scored.push({
      name: meal.name,
      // The evidence, on the card. A suggestion whose reason is invisible is
      // just a guess with a nice font.
      using: [...meal.needs.filter(n => !ASSUMED.includes(n)), ...extras],
      score: meal.needs.length * 2 + extras.length,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    known: true,
    meals: scored.slice(0, limit),
    // Said out loud rather than rendered as an empty list: a stocked kitchen
    // that matches no rule is a gap in the RULES, not an empty fridge.
    why: scored.length ? null : 'nothing here matches what I know how to suggest yet',
  };
}

module.exports = {
  // pure
  redactEvent,
  redactDay,
  redactWeek,
  dayKeys,
  daysOf,
  topTasks,
  recentlyDone,
  whoIsIn,
  domainOf,
  suggestMeals,
  // stateful
  readKitchen,
  sharedCatalogues,
  // constants
  KITCHEN_SLUG,
  MEALS,
};
