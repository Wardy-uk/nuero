'use strict';

/**
 * "In a focus block until T" — the ONE explicit state the push governor asks
 * before holding a notification (1 Nov 2026, Nick: quiet during the block).
 *
 * ⚠ NEVER INFERRED. A block in the diary, a session running, a calendar entry
 * called "Focus" — none of them is this. The state is set only when Nick picks
 * a task in a focus block (focus-blocks.choose) and cleared when the block ends,
 * he stops after two minutes, or he says Done. A push is held only while
 * `until` is in the future; an expired state holds nothing, so a crash between
 * the block ending and the drain can never leave his phone silent.
 *
 * ⚠ HELD, NEVER DROPPED. Each held push is kept (title, body, type) and handed
 * back by `drain()` so the block's end can deliver ONE summary. ALWAYS_DELIVER
 * types (escalations, meeting alerts…) are never offered to this module — the
 * caller checks that first.
 *
 * Stored in agent_state (KV, the focus_session idiom): the backend restarts
 * several times a day and a hold that evaporated on a deploy would let the next
 * nudge straight through the middle of the block.
 */

const db = require('../db/database');

const KEY = 'focus_block_hold';
const MAX_HELD = 30;

function read() {
  try {
    const raw = db.getState(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.until ? s : null;
  } catch {
    return null;
  }
}

function _write(state) {
  db.setState(KEY, state ? JSON.stringify(state) : '');
}

/** Start (or move) the hold. Keeps anything already held for the same block. */
function set({ blockId, until, taskText = null }) {
  const prev = read();
  const held = prev && Number(prev.blockId) === Number(blockId) ? (prev.held || []) : [];
  const state = { blockId: Number(blockId), until: new Date(until).toISOString(), taskText, held };
  _write(state);
  return state;
}

/** Is a hold in force at `now`? PURE over the stored state. */
function activeAt(state, now = new Date()) {
  if (!state || !state.until) return false;
  const t = Date.parse(state.until);
  return Number.isFinite(t) && now.getTime() < t;
}

/**
 * Hold this push if a block hold is in force. Returns the state when held,
 * null when the push should carry on. Never throws: a hold that cannot be read
 * must not cost a notification.
 */
function holdIfInBlock({ title, body, type }, now = new Date()) {
  try {
    const state = read();
    if (!activeAt(state, now)) return null;
    state.held = state.held || [];
    if (state.held.length < MAX_HELD) {
      state.held.push({ title: String(title || '').slice(0, 160), body: String(body || '').slice(0, 200), type: type || null, at: now.toISOString() });
    } else {
      state.overflow = (state.overflow || 0) + 1;
    }
    _write(state);
    return state;
  } catch {
    return null;
  }
}

/** End the hold and hand back what it held. Idempotent: a second drain is empty. */
function drain() {
  const state = read();
  _write(null);
  if (!state) return { blockId: null, held: [], overflow: 0 };
  return { blockId: state.blockId, held: state.held || [], overflow: state.overflow || 0 };
}

/** One line for the summary push. PURE. Null when nothing was held. */
function summaryOf(held = [], overflow = 0) {
  const n = held.length + (overflow || 0);
  if (!n) return null;
  const titles = held.slice(0, 4).map((h) => h.title).filter(Boolean);
  const more = n - titles.length;
  return {
    title: n === 1 ? 'While you were in your focus block' : `While you were in your focus block — ${n} notifications`,
    body: titles.join(' · ') + (more > 0 ? ` · and ${more} more` : ''),
  };
}

module.exports = { KEY, read, set, activeAt, holdIfInBlock, drain, summaryOf, MAX_HELD };
