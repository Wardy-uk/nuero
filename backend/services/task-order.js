'use strict';

/**
 * Nick's own order, by drag and drop (20 Oct 2026).
 *
 * ── The rule (Nick's call) ─────────────────────────────────────────────────
 *
 * His dragged order WINS INSIDE A MoSCoW BAND; the score still decides
 * everything else. So Focus, Now, the lane and the planner keep their
 * cross-band interleaving (an overdue Should can still sit above a quiet
 * Must), but among his Musts the order is the one he put them in, and a due
 * date coming up cannot push one task he placed above another.
 *
 * ── How: slot-preserving ───────────────────────────────────────────────────
 *
 * `applyOrder` takes the score-ranked list and, band by band, keeps the
 * POSITIONS that band occupies and re-deals the band's own rows into them in
 * his order. Nothing moves across bands, so nothing a drag cannot express
 * changes. Rows he has not placed (new since he last ordered that band, or a
 * daily-note line with no stable identity) keep score order and sit at the
 * TOP of the band — new work arrives where he will see it, rather than sinking
 * below a list he has already arranged.
 *
 * ── Storage ────────────────────────────────────────────────────────────────
 *
 * KV `agent_state.task_manual_order`: { "task:12": {rank, band}, "ms:AAMk…":
 * {rank, band} }. An annotation, not an entity — the `ms_task_local` idiom.
 * Ranks only compare within a band; a placement recorded in a different band
 * from the row's current one is treated as UNPLACED, so a task re-rated from
 * Should to Must lands at the top of Musts rather than at a position that
 * meant something among Shoulds.
 *
 * ⚠ `rankTasks` stays pure and never reads this — requiring the DB from a pure
 * module is how a pure test opens the live database. Callers that want his
 * order use `rankWithOrder`.
 */

const db = require('../db/database');
const { rankTasks } = require('./task-scoring');

const KEY = 'task_manual_order';
const MAX_KEYS_PER_REORDER = 500;

/** The stable identity of a row, or null when it has none worth storing. */
function keyFor(row) {
  if (!row) return null;
  if (row.task_id) return `task:${row.task_id}`;
  if (row.ms_id) return `ms:${row.ms_id}`;
  return null;
}

/** The band a row sits in — what the screen shows as its MoSCoW. */
function bandOf(row) {
  const m = row && (row.moscow || (row.meta && row.meta.moscow));
  return ['must', 'should', 'could', 'wont'].includes(m) ? m : 'none';
}

function readMap() {
  try {
    const raw = db.getState(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // Unreadable is not "no order" — but on a read path the honest fallback is
    // the score order everybody already trusts, said once in the log.
    console.warn('[TaskOrder] Could not read the manual order:', e.message);
    return {};
  }
}

function writeMap(map) {
  db.setState(KEY, JSON.stringify(map));
}

/**
 * PURE. Re-deal each band's rows into the slots that band already holds,
 * placed rows in rank order after the unplaced ones (which keep score order).
 */
function applyOrder(ranked, map) {
  if (!Array.isArray(ranked) || !ranked.length || !map || !Object.keys(map).length) return ranked;
  const slots = new Map(); // band -> indices
  ranked.forEach((row, i) => {
    const b = bandOf(row);
    if (!slots.has(b)) slots.set(b, []);
    slots.get(b).push(i);
  });
  const out = ranked.slice();
  for (const [band, idx] of slots) {
    const rows = idx.map((i) => ranked[i]);
    const unplaced = [];
    const placed = [];
    for (const row of rows) {
      const entry = map[keyFor(row)];
      if (entry && entry.band === band && Number.isFinite(entry.rank)) placed.push({ row, rank: entry.rank });
      else unplaced.push(row);
    }
    if (!placed.length) continue;
    placed.sort((a, b) => a.rank - b.rank);
    const dealt = [...unplaced, ...placed.map((p) => ({ ...p.row, manualRank: p.rank }))];
    idx.forEach((slot, n) => { out[slot] = dealt[n]; });
  }
  return out;
}

/** Score-rank, then honour his order. The one call every ranked surface makes. */
function rankWithOrder(tasks, todayStr) {
  return applyOrder(rankTasks(tasks, todayStr), readMap());
}

/**
 * Record a band's order exactly as he left it on screen — every key, top to
 * bottom. Saving the WHOLE band (not just the row that moved) is what makes the
 * result predictable: after a drop, that band reads back the way it looked.
 */
function reorder({ band, keys }) {
  if (!['must', 'should', 'could', 'wont', 'none'].includes(band)) {
    return { ok: false, error: "band must be one of must, should, could, wont, none" };
  }
  if (!Array.isArray(keys) || !keys.length) return { ok: false, error: 'keys must be a non-empty list' };
  if (keys.length > MAX_KEYS_PER_REORDER) return { ok: false, error: `at most ${MAX_KEYS_PER_REORDER} keys` };
  const clean = [];
  for (const k of keys) {
    const s = String(k || '');
    if (!/^(task:\d+|ms:[\w\-=+/.!]+)$/.test(s)) return { ok: false, error: `not a task key: ${s.slice(0, 60)}` };
    if (!clean.includes(s)) clean.push(s);
  }
  const map = readMap();
  clean.forEach((k, i) => { map[k] = { rank: (i + 1) * 1000, band }; });
  // Prune what is provably finished — only NEURO rows, whose status the DB is
  // the authority on. A Microsoft key is never pruned on absence: the mirror can
  // be briefly short, and losing his order to a sync hiccup looks like a bug.
  for (const k of Object.keys(map)) {
    const m = /^task:(\d+)$/.exec(k);
    if (!m) continue;
    try {
      const row = db.getTaskRow(Number(m[1]));
      if (!row || row.status === 'done' || row.status === 'dropped') delete map[k];
    } catch { /* unreadable: keep */ }
  }
  writeMap(map);
  return { ok: true, band, placed: clean.length };
}

/** A row's MoSCoW was changed by hand: its old position meant nothing new. */
function forget(key) {
  if (!key) return;
  try {
    const map = readMap();
    if (!(key in map)) return;
    delete map[key];
    writeMap(map);
  } catch (e) {
    console.warn('[TaskOrder] Could not clear a placement:', e.message);
  }
}

/** Remove placements for a whole band — the "Reset order" escape hatch. */
function resetBand(band) {
  const map = readMap();
  let removed = 0;
  for (const [k, v] of Object.entries(map)) {
    if (v && v.band === band) { delete map[k]; removed++; }
  }
  writeMap(map);
  return { ok: true, band, removed };
}

module.exports = { keyFor, bandOf, applyOrder, rankWithOrder, reorder, forget, resetBand, readMap, _KEY: KEY };
