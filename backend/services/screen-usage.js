'use strict';

/**
 * Which screens Nick actually opens — NEURO, SAiM and VANTAGE on one grid.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * `tab_open` has been logged since 22 June 2026 and NOTHING has ever rendered
 * it. Its only readers are `nudges.js` (which asks whether a tab was opened
 * today, to pick a nudge target) and `outcomes.js` (which counts them into the
 * Friday reflection). So the estate has 33 NEURO screens, 12 SAiM screens and
 * 8 VANTAGE screens, a three-month record of which ones get opened, and no way
 * to look at it — which is the "reader with no writer" shape this codebase
 * names everywhere else, running backwards: a writer with no reader.
 *
 * It matters because of the PARKED DIRECTION (27 Aug 2026): "maybe the longer
 * term plan should be that there is only one interface — the chat". That is a
 * decision about which screens earn their place, and it cannot be taken from a
 * memory of which ones feel busy. It is also the only honest way to retire a
 * screen: `tab_open` falling 266 → 89 → 17 across three weeks was measured, and
 * it is the kind of thing nobody notices by looking at the sidebar.
 *
 * ── THE RULE THIS TURNS ON ──────────────────────────────────────────────────
 *
 * ⚠⚠ A SURFACE THAT WAS NOT INSTRUMENTED DID NOT GO UNUSED. NEURO's desktop has
 * reported since 22 June; SAiM and VANTAGE report from the day their hook
 * shipped and not one second earlier. Rendering the weeks before that as ZERO
 * would draw SAiM — the app on Nick's phone, the one he opens most — as three
 * blank months, and the heatmap would be most wrong about the single most-used
 * surface in the estate. So every surface carries `since`, a week that ended
 * before it is `null` and NEVER 0, and the panel says which is which. This is
 * the same refusal as "an unread domain is structurally empty and null, never
 * 0" and as `recentWeeks` marking a week before the wins ledger began.
 *
 * ⚠ IT COUNTS OPENS, NOT TIME. A screen opened once and sat on for an hour
 * reads quieter than one bounced through six times. That is a real limitation
 * and it is stated on the panel rather than implied away — nothing here has a
 * dwell signal, and inventing one from the gap between consecutive opens would
 * be a measurement of tab-switching dressed up as attention.
 *
 * ⚠ A `checkin:` EVENT IS NOT A SCREEN. `routes/location.js` calls
 * `trackTabOpen('checkin:<place>')` to record an OwnTracks arrival — a
 * deliberate reuse of the event type, and a place name is not a view. They are
 * excluded BY PREFIX and the count of what was excluded is reported, because a
 * silent filter is how a number comes to mean something nobody can check.
 *
 * ⚠ AN UNTAGGED ROW IS NEURO'S, AND THAT IS A FACT RATHER THAN A DEFAULT. Every
 * row logged before `surface` existed came from `frontend/src/App.jsx`, which
 * was the only caller of `POST /api/activity/tab` in the estate (the other is
 * the checkin above, excluded). So untagged reads as `neuro` because that is
 * where it came from, not because neuro is the safe guess.
 *
 * ⚠ VANTAGE IS READ OFF ITS OWN SQLITE, not over the bridge. NEURO→VANTAGE is
 * already one direct read (`estate-cost.js`), both processes run as the same
 * user on the same Pi, and the alternative was a SIXTH write on a bridge whose
 * closed set of five is load-bearing and whose count is the register. The cost
 * is a dependency on VANTAGE's `docs` shape, which is VANTAGE's to change — so
 * an unreadable store is a NAMED GAP and never an empty surface.
 *
 * ⚠ A KNOWN WART, INHERITED: `db.logActivity` stamps `date_key` from
 * `toISOString()` (UTC) while `hour` and `day_of_week` come from local getters.
 * Under BST an event at 00:30 local is logged with hour 0 and YESTERDAY's date.
 * It is not fixed here — that key is read by the daily rollup, the ritual
 * streaks and the wins ledger, and moving it is a change to all of them — but
 * it means a midnight-hour open can land in the previous week's column. Stated
 * rather than silently carried.
 *
 * `foldWeeks`, `foldHours`, `weekKeyOf`, `screenRows` and `assess` are PURE
 * (the `pi-health.assess()` split), so the whole shape pins without a database,
 * a Pi or a clock.
 */

const path = require('path');
const { weekStart } = require('./weekly-target');

// How far back the week grid reaches. Twelve weeks is a quarter — long enough
// to show a screen going quiet, short enough that a row is readable on a laptop.
const DEFAULT_WEEKS = 12;

// Not a screen. See the header.
const CHECKIN_PREFIX = 'checkin:';

// VANTAGE's own default, kept in step with `estate-cost.js` rather than a
// second opinion about where that file lives.
const DEFAULT_VANTAGE_DB = '/mnt/data/vantage-data/vantage.db';

// The collection VANTAGE writes its own view opens into.
const VANTAGE_COLLECTION = 'screen_opens';

const SURFACES = {
  neuro: 'NEURO',
  saim: 'SAiM',
  vantage: 'VANTAGE',
};

/** Is this a surface this panel knows about? Unknown ones are kept and named. */
function knownSurface(id) {
  return Object.prototype.hasOwnProperty.call(SURFACES, id);
}

// ── Pure date helpers ───────────────────────────────────────────────────────

/**
 * Local date key. NEVER `toISOString()` — the rest of this codebase learned
 * that the hard way, and a day boundary an hour out makes two grids disagree
 * about which week an evening belongs to.
 */
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The Monday this date key falls in, as a key. PURE.
 *
 * ⚠ `weekStart` is BORROWED from `weekly-target`, never re-derived — the ring,
 * the wins count and now this grid must not disagree about which week it is,
 * and the Sunday case (`getDay()` calls it 0, so a naive `dow - 1` moves a day
 * FORWARD into a week that has not begun) is only worth getting right once.
 */
function weekKeyOf(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return null;
  return dateKey(weekStart(new Date(y, m - 1, d)));
}

/** The `count` Monday keys ending with the week `anchor` falls in, oldest first. */
function weekColumns(anchor, count = DEFAULT_WEEKS) {
  const end = weekStart(anchor);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i * 7);
    out.push(dateKey(d));
  }
  return out;
}

/** The Sunday that closes the week starting at `mondayKey`. PURE. */
function weekEndKey(mondayKey) {
  const [y, m, d] = mondayKey.split('-').map(Number);
  const end = new Date(y, m - 1, d + 6);
  return dateKey(end);
}

// ── Pure folding ────────────────────────────────────────────────────────────

/**
 * Fold raw opens into `{ surface, screen } -> { weeks, hours, total, last }`.
 *
 * An open is `{ surface, screen, dateKey, hour }`. Anything without a screen or
 * a parseable date is DROPPED AND COUNTED, never guessed into a bucket.
 */
function foldOpens(opens, columns) {
  const index = new Map(columns.map((k, i) => [k, i]));
  const rows = new Map();
  let dropped = 0;
  let outsideWindow = 0;

  for (const o of opens || []) {
    const screen = o && typeof o.screen === 'string' ? o.screen.trim() : '';
    if (!screen) { dropped++; continue; }

    const wk = weekKeyOf(o.dateKey);
    if (!wk) { dropped++; continue; }

    const surface = knownSurface(o.surface) ? o.surface : 'neuro';
    const id = `${surface}::${screen}`;
    let row = rows.get(id);
    if (!row) {
      row = {
        surface,
        screen,
        total: 0,
        weeks: columns.map(() => 0),
        hours: new Array(24).fill(0),
        lastOpened: null,
      };
      rows.set(id, row);
    }

    // The window bounds the GRID, not the totals a row reports about itself —
    // `lastOpened` is what says a screen has gone quiet, and truncating it to
    // the window would make every long-dead screen claim it was last opened
    // twelve weeks ago.
    if (!row.lastOpened || o.dateKey > row.lastOpened) row.lastOpened = o.dateKey;

    const col = index.get(wk);
    if (col === undefined) { outsideWindow++; continue; }

    row.total++;
    row.weeks[col]++;

    // An hour outside 0–23 is not an hour. It cannot come from `logActivity`,
    // but it can come from VANTAGE's own store, which is not ours to trust.
    //
    // ⚠ TESTED FOR NUMBER FIRST, never coerced. `Number(null)` and `Number('')`
    // are both 0 and `Number.isInteger(0)` is true, so a MISSING hour silently
    // became MIDNIGHT — an absence rendered as a real reading, in the one bucket
    // where "he was on this screen at 3am" looks odd enough to be believed. The
    // same species as a sample count read as a blood pressure. Caught by the
    // test, not by reading.
    const h = o.hour;
    if (typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23) row.hours[h]++;
  }

  return { rows: [...rows.values()], dropped, outsideWindow };
}

/**
 * Blank out the weeks a surface could not have reported in.
 *
 * ⚠ THIS IS THE HONEST HALF OF THE WHOLE FEATURE. A week that ENDED before the
 * surface first reported is `null` — "I could not see it" — and a week that
 * merely contains the start date stays a number, because part of it WAS
 * measured and zeroing it would hide the day instrumentation landed.
 */
function maskUnknownWeeks(rows, columns, sinceBySurface) {
  for (const row of rows) {
    const since = sinceBySurface[row.surface];
    if (!since) continue;
    for (let i = 0; i < columns.length; i++) {
      if (weekEndKey(columns[i]) < since) row.weeks[i] = null;
    }
  }
  return rows;
}

/** Column totals across every row, for the hour-of-day grid's own scale. */
function hourTotals(rows) {
  const out = new Array(24).fill(0);
  for (const row of rows) {
    for (let h = 0; h < 24; h++) out[h] += row.hours[h] || 0;
  }
  return out;
}

/**
 * Rank rows for display: most-opened first, within surface order.
 *
 * Grouping by surface rather than interleaving is deliberate — the question
 * "which of NEURO's screens have gone quiet" is not answered by a list where a
 * SAiM screen sits between two of them.
 */
function screenRows(rows) {
  const order = Object.keys(SURFACES);
  return [...rows].sort((a, b) => {
    const s = order.indexOf(a.surface) - order.indexOf(b.surface);
    if (s !== 0) return s;
    if (b.total !== a.total) return b.total - a.total;
    return a.screen.localeCompare(b.screen);
  });
}

/**
 * What the grid SAYS, as opposed to what it contains. PURE.
 *
 * ⚠ It states and never advises. A screen with no opens in the window is
 * reported as such; whether that means it should go is Nick's call and the
 * PARKED DIRECTION says so explicitly. No score, no "unused" verdict, no
 * suggestion to delete anything — this is the same refusal `pip-deliverables`
 * makes about a burn-down.
 */
function assess(rows, columns, surfaces) {
  const findings = [];

  for (const s of surfaces) {
    if (s.known === false) {
      findings.push({
        severity: 'gap',
        surface: s.id,
        title: `${s.label} could not be read`,
        detail: s.reason || 'no reason recorded',
      });
      continue;
    }
    // ⚠ A READABLE SURFACE THAT HAS NEVER REPORTED, which is the case the first
    // live run caught: SAiM came back `known:true, screens:0, since:null` and
    // `assess()` said NOTHING, because the freshly-instrumented arm below keys
    // on a `since` it does not have. So the most-used app in the estate would
    // have sat silently at the bottom of the grid with no rows and no
    // explanation — which is precisely the "blank reads as unused" failure this
    // whole feature is built to refuse, reproduced inside the thing refusing it.
    //
    // It is stated as an ABSENCE OF MEASUREMENT, never as an absence of use.
    if (!s.since) {
      findings.push({
        severity: 'gap',
        surface: s.id,
        title: `${s.label} has never reported a screen open`,
        detail: 'Nothing is recording it yet, so it has no rows here. That is a gap in the measurement, not a sign the app goes unused.',
      });
      continue;
    }
    // A surface instrumented inside the window cannot be compared against the
    // ones that were not, and saying so is the point.
    if (s.since > columns[0]) {
      findings.push({
        severity: 'note',
        surface: s.id,
        title: `${s.label} has only been recorded since ${s.since}`,
        detail: 'Earlier weeks are blank because nothing was watching, not because nothing was opened.',
      });
    }
  }

  // Quiet screens, per surface, and only for surfaces that could have seen the
  // whole window — a screen on a freshly instrumented surface has not "gone
  // quiet", it has never been watched.
  for (const s of surfaces) {
    if (s.known === false) continue;
    if (s.since && s.since > columns[0]) continue;
    const quiet = rows
      .filter(r => r.surface === s.id && r.total === 0)
      .map(r => r.screen);
    if (quiet.length) {
      findings.push({
        severity: 'note',
        surface: s.id,
        title: `${quiet.length} ${s.label} screen${quiet.length === 1 ? '' : 's'} not opened in this window`,
        detail: quiet.join(', '),
      });
    }
  }

  return findings;
}

// ── The readers ─────────────────────────────────────────────────────────────

/**
 * NEURO's own log. Returns opens in the window, plus what it refused to count.
 *
 * ⚠ The OPENS are bounded to the window and `since` is asked for SEPARATELY,
 * over the whole log. That split is not an optimisation, it is the honesty:
 * "when did this surface first report" is a fact about the log, so deriving it
 * from a twelve-week read would make every surface look freshly instrumented
 * and blank out the grid this exists to fill.
 */
function readNeuroLog(db, fromDateKey) {
  const rows = db.getTabOpensSince(fromDateKey);
  const opens = [];
  let checkins = 0;

  for (const r of rows) {
    let data = null;
    try { data = r.event_data ? JSON.parse(r.event_data) : null; } catch { data = null; }
    const screen = data && typeof data.tab === 'string' ? data.tab : '';
    if (!screen) continue;
    if (screen.startsWith(CHECKIN_PREFIX)) { checkins++; continue; }
    opens.push({
      // Untagged is NEURO's, and it is a fact — see the header.
      surface: knownSurface(data.surface) ? data.surface : 'neuro',
      screen,
      dateKey: r.date_key,
      hour: r.hour,
    });
  }

  return { opens, checkins };
}

function vantageDbPath() {
  return process.env.VANTAGE_DB_PATH || DEFAULT_VANTAGE_DB;
}

/**
 * VANTAGE's own view opens, out of its document store.
 *
 * ⚠ ABSENCE IS UNKNOWN, NEVER ZERO — every refusal returns `known: false` WITH
 * A REASON, and it must never throw: a usage grid is not worth taking a panel
 * down for. `estate-cost.js`'s rule verbatim, because it is the same file.
 *
 * ⚠ The column is `json`, not `data` — read from VANTAGE's own
 * `CREATE TABLE docs (id, collection, json)`, never hand-written from memory.
 */
function readVantage() {
  const file = vantageDbPath();

  let Database;
  try { Database = require('better-sqlite3'); }
  catch { return { known: false, reason: 'sqlite driver unavailable' }; }

  const fs = require('fs');
  if (!fs.existsSync(file)) {
    return { known: false, reason: `VANTAGE database not found at ${file}` };
  }

  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { return { known: false, reason: `could not open VANTAGE database (${e.message})` }; }

  try {
    const hasDocs = db
      .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='docs'")
      .get().n > 0;
    if (!hasDocs) return { known: false, reason: 'VANTAGE has no document store yet' };

    const rows = db
      .prepare('SELECT json FROM docs WHERE collection = ?')
      .all(VANTAGE_COLLECTION)
      .map(r => { try { return JSON.parse(r.json); } catch { return null; } })
      .filter(Boolean);

    // A store that exists and holds nothing is a DIFFERENT fact from one that
    // cannot be read: the hook ships and records nothing until the first view
    // is opened, so this is "nothing recorded yet", not "VANTAGE is unused".
    const opens = rows
      .filter(r => r && typeof r.screen === 'string' && r.screen.trim())
      .map(r => ({
        surface: 'vantage',
        screen: r.screen.trim(),
        dateKey: r.date_key,
        hour: r.hour,
      }));

    return { known: true, opens, empty: opens.length === 0 };
  } catch (e) {
    return { known: false, reason: `could not read VANTAGE screen opens (${e.message})` };
  } finally {
    try { db.close(); } catch { /* the read stands */ }
  }
}

/**
 * The first date each surface ever reported. PURE over the opens it is given.
 *
 * A surface that has reported NOTHING gets no `since` at all, which is not the
 * same as one whose first day is today — the first is "never instrumented, or
 * instrumented and never used", and the grid says which by whether the surface
 * was readable.
 */
function firstSeen(opens) {
  const out = {};
  for (const o of opens) {
    if (!o.dateKey) continue;
    if (!out[o.surface] || o.dateKey < out[o.surface]) out[o.surface] = o.dateKey;
  }
  return out;
}

// ── Composition ─────────────────────────────────────────────────────────────

/**
 * The whole grid. Never throws.
 *
 * `deps` exists so the routing test can drive real HTTP against a scratch DB
 * and the pure suite can drive the fold without one.
 */
function build(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const weeks = Number.isInteger(opts.weeks) && opts.weeks > 0
    ? Math.min(opts.weeks, 52)
    : DEFAULT_WEEKS;
  const db = opts.db || require('../db/database');
  const vantage = opts.readVantage ? opts.readVantage() : readVantage();

  const columns = weekColumns(now, weeks);
  const gaps = [];

  let neuro = { opens: [], checkins: 0 };
  let logged = {};
  try {
    neuro = readNeuroLog(db, columns[0]);
    // Asked over the WHOLE log, not the window — see `readNeuroLog`.
    for (const r of db.getTabOpenFirstSeen()) {
      if (knownSurface(r.surface) && r.first_seen) logged[r.surface] = r.first_seen;
    }
  } catch (e) {
    // NEURO's own log failing is not an empty estate — it is the grid being
    // unreadable, and the two must never render the same.
    gaps.push(`NEURO activity log could not be read (${e.message})`);
  }

  const allOpens = [...neuro.opens];
  if (vantage.known) allOpens.push(...vantage.opens);
  else gaps.push(vantage.reason);

  // VANTAGE's store is read whole, so its own opens carry its first sighting;
  // NEURO's comes from the aggregate above because its window read cannot.
  const since = { ...firstSeen(allOpens), ...logged };
  const folded = foldOpens(allOpens, columns);
  maskUnknownWeeks(folded.rows, columns, since);
  const rows = screenRows(folded.rows);

  const surfaces = Object.entries(SURFACES).map(([id, label]) => {
    if (id === 'vantage' && !vantage.known) {
      return { id, label, known: false, reason: vantage.reason, screens: 0, opens: 0, since: null };
    }
    const mine = rows.filter(r => r.surface === id);
    return {
      id,
      label,
      known: true,
      since: since[id] || null,
      screens: mine.length,
      opens: mine.reduce((n, r) => n + r.total, 0),
    };
  });

  if (folded.dropped) gaps.push(`${folded.dropped} event${folded.dropped === 1 ? '' : 's'} had no readable screen or date`);

  return {
    generatedAt: new Date().toISOString(),
    window: { weeks, from: columns[0], to: weekEndKey(columns[columns.length - 1]) },
    weeks: columns,
    surfaces,
    rows,
    hourTotals: hourTotals(rows),
    // Named, never silently filtered — see the header.
    excluded: { checkins: neuro.checkins, outsideWindow: folded.outsideWindow },
    findings: assess(rows, columns, surfaces),
    gaps,
    // Carried so no screen has to restate it and risk saying it differently.
    measures: 'opens, not time spent on a screen',
  };
}

module.exports = {
  build,
  // Pure, exported for the tests and for anything that wants the fold without
  // the readers.
  weekKeyOf,
  weekColumns,
  weekEndKey,
  foldOpens,
  maskUnknownWeeks,
  hourTotals,
  screenRows,
  firstSeen,
  assess,
  knownSurface,
  readVantage,
  SURFACES,
  CHECKIN_PREFIX,
  DEFAULT_WEEKS,
  VANTAGE_COLLECTION,
};
