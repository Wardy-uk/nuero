'use strict';

/**
 * Things to speak to Chris about the next time Nick sees him (30 Oct 2026).
 *
 * A running list, NOT a per-week field. That is the difference from the Weekly
 * Risk report's "To escalate" box, which starts empty every Monday on purpose:
 * an item noted on a Wednesday and not yet raised must still be there next
 * week. Open items go into the Monday report under "To discuss with Chris";
 * ticking one off removes it from the list and from every report built after.
 *
 * A tick is stamped (`doneAt`), never deleted, and has a way back (`restore`) —
 * a stray tap must not lose the thought. A sent report is frozen by
 * weekly-risk.build(), so ticking an item never rewrites what Chris received.
 *
 * ⚠ An unreadable store reads as `known: false` and REFUSES writes: writing an
 * empty list over a blob we could not parse would destroy every open item.
 */

const crypto = require('crypto');
const db = require('../db/database');

const KEY = 'chris_agenda';
const MAX_TEXT = 500;
const MAX_ITEMS = 200;

function _read() {
  const raw = db.getState(KEY);
  if (!raw) return { known: true, items: [] };
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return { known: false, items: [] };
    return { known: true, items };
  } catch {
    return { known: false, items: [] };
  }
}

function _write(items) {
  db.setState(KEY, JSON.stringify(items));
}

function _readForWrite() {
  const r = _read();
  if (!r.known) throw Object.assign(new Error('The list for Chris could not be read, so nothing was changed.'), { status: 503 });
  return r.items;
}

/** Open items oldest first; done ones only when asked (newest first). */
function list({ includeDone = false } = {}) {
  const r = _read();
  const open = r.items.filter(i => !i.doneAt);
  const done = r.items.filter(i => i.doneAt).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
  return { known: r.known, open, done: includeDone ? done.slice(0, 20) : undefined };
}

function add(text, { source = 'manual' } = {}) {
  const t = String(text ?? '').trim();
  if (!t) throw Object.assign(new Error('Nothing to add — the text is empty.'), { status: 400 });
  if (t.length > MAX_TEXT) throw Object.assign(new Error(`Keep it under ${MAX_TEXT} characters.`), { status: 400 });
  const items = _readForWrite();
  // The same open line twice is one thing to raise, not two.
  const same = items.find(i => !i.doneAt && i.text.toLowerCase() === t.toLowerCase());
  if (same) return { item: same, already: true };
  const item = { id: crypto.randomUUID(), text: t, addedAt: new Date().toISOString(), source: String(source).slice(0, 40), doneAt: null };
  items.push(item);
  // Bound the store by dropping the OLDEST DONE items, never an open one.
  while (items.length > MAX_ITEMS) {
    const idx = items.findIndex(i => i.doneAt);
    if (idx === -1) break;
    items.splice(idx, 1);
  }
  _write(items);
  return { item, already: false };
}

function _setDone(id, done) {
  const items = _readForWrite();
  const item = items.find(i => i.id === id);
  if (!item) throw Object.assign(new Error('That item is not on the list.'), { status: 404 });
  item.doneAt = done ? (item.doneAt || new Date().toISOString()) : null;
  _write(items);
  return item;
}

const tick = (id) => _setDone(id, true);
const restore = (id) => _setDone(id, false);

module.exports = { list, add, tick, restore, KEY };
