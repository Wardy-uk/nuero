'use strict';

/**
 * Life loops (3 Nov 2026) — the small things Nick asked for after the Obsidian
 * dashboard post, each feeding Next steps:
 *
 *   decisions  — a look-back date on a logged decision, and "how did it go?"
 *   rhythm     — "see / call this person every N days", with Caught up
 *   letters    — a letter to future me, sealed until a date he picks
 *   garden     — three old notes brought back each week so they don't rot
 *   logbook    — quick log of restaurants, films, books, coffee… with a rating,
 *                and "Choose for me" from his own ratings (rules, no model)
 *
 * Each decides nothing on its own beyond its stated rule; dates are London
 * wall-clock YYYY-MM-DD; bad input is refused (400), never repaired.
 *
 * CommonJS — NEURO backend convention.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function _db() { return require('../db/database'); }
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function today(now = Date.now()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}
function addDays(date, n) {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}
function _validDate(s) {
  if (!DATE.test(String(s || ''))) return false;
  const t = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s;
}

// ── Decisions: look back ─────────────────────────────────────────────────────

const LOOK_BACK_DEFAULT_DAYS = 30;
const OUTCOMES = new Set(['right', 'wrong', 'mixed', 'too-early']);
let _decReady = false;
function _ensureDecisions() {
  if (_decReady) return;
  const cols = new Set(_db().all('PRAGMA table_info(decisions)').map((c) => c.name));
  for (const [c, t] of [['look_back_on', 'TEXT'], ['outcome', 'TEXT'], ['lesson', 'TEXT'], ['reviewed_at', 'TEXT']]) {
    if (!cols.has(c)) _db().run(`ALTER TABLE decisions ADD COLUMN ${c} ${t}`);
  }
  _decReady = true;
}

function _decision(r) {
  const made = String(r.created_at || '').slice(0, 10) || null;
  return {
    id: r.id, text: r.decision_text, madeOn: made,
    // A decision with no look-back set is looked back on 30 days after it was made.
    lookBackOn: r.look_back_on || (made ? addDays(made, LOOK_BACK_DEFAULT_DAYS) : null),
    lookBackSet: !!r.look_back_on,
    outcome: r.outcome || null, lesson: r.lesson || null, reviewedAt: r.reviewed_at || null,
  };
}

function listDecisions() {
  _ensureDecisions();
  return _db().all('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 200').map(_decision);
}

function addDecision(text, { lookBackOn = null } = {}) {
  _ensureDecisions();
  const t = String(text || '').trim();
  if (!t) return { ok: false, status: 400, error: 'Say what you decided.' };
  if (lookBackOn != null && !_validDate(lookBackOn)) return { ok: false, status: 400, error: 'Pick a real day to look back on.' };
  _db().run('INSERT INTO decisions (conversation_id, decision_text, look_back_on) VALUES (?, ?, ?)', [null, t.slice(0, 1000), lookBackOn]);
  const row = _db().get('SELECT * FROM decisions ORDER BY id DESC LIMIT 1');
  return { ok: true, decision: _decision(row) };
}

function setLookBack(id, date) {
  _ensureDecisions();
  if (!_validDate(date)) return { ok: false, status: 400, error: 'Pick a real day to look back on.' };
  const r = _db().get('SELECT * FROM decisions WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'No such decision.' };
  _db().run('UPDATE decisions SET look_back_on = ? WHERE id = ?', [date, id]);
  return { ok: true, decision: _decision(_db().get('SELECT * FROM decisions WHERE id = ?', [id])) };
}

function reviewDecision(id, { outcome, lesson = null, now = Date.now() } = {}) {
  _ensureDecisions();
  if (!OUTCOMES.has(outcome)) return { ok: false, status: 400, error: `outcome must be one of ${[...OUTCOMES].join(', ')}` };
  const r = _db().get('SELECT * FROM decisions WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'No such decision.' };
  if (outcome === 'too-early') {
    // Not a verdict: look again in 30 days.
    _db().run('UPDATE decisions SET look_back_on = ? WHERE id = ?', [addDays(today(now), LOOK_BACK_DEFAULT_DAYS), id]);
  } else {
    _db().run('UPDATE decisions SET outcome = ?, lesson = ?, reviewed_at = ? WHERE id = ?',
      [outcome, lesson ? String(lesson).trim().slice(0, 1000) : null, new Date(now).toISOString(), id]);
  }
  return { ok: true, decision: _decision(_db().get('SELECT * FROM decisions WHERE id = ?', [id])) };
}

/** Decisions whose look-back day has come and that have no verdict yet. */
function decisionsDue(now = Date.now()) {
  const d = today(now);
  return listDecisions().filter((x) => !x.outcome && x.lookBackOn && x.lookBackOn <= d);
}

// ── People rhythm ────────────────────────────────────────────────────────────

let _rhyReady = false;
function _ensureRhythm() {
  if (_rhyReady) return;
  _db().run(`CREATE TABLE IF NOT EXISTS people_rhythm (
    name TEXT PRIMARY KEY, every_days INTEGER NOT NULL, last_at TEXT, ask_about TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  _rhyReady = true;
}

function _rhythm(r, now) {
  const d = today(now);
  const due = r.last_at ? addDays(r.last_at, r.every_days) : d;
  return {
    name: r.name, everyDays: r.every_days, lastAt: r.last_at || null, askAbout: r.ask_about || null,
    dueOn: due, daysOverdue: Math.max(0, daysBetween(due, d)), due: due <= d,
  };
}

function listRhythm(now = Date.now()) {
  _ensureRhythm();
  return _db().all('SELECT * FROM people_rhythm ORDER BY name').map((r) => _rhythm(r, now));
}

function setRhythm(name, { everyDays, askAbout, lastAt, now = Date.now() } = {}) {
  _ensureRhythm();
  const n = String(name || '').trim();
  if (!n || n.length > 120) return { ok: false, status: 400, error: 'Give the person’s name.' };
  const every = Number(everyDays);
  if (!Number.isInteger(every) || every < 1 || every > 730) return { ok: false, status: 400, error: 'How often: 1 to 730 days.' };
  if (lastAt != null && lastAt !== '' && (!_validDate(lastAt) || lastAt > today(now))) return { ok: false, status: 400, error: 'Last caught up must be a real day, not in the future.' };
  const at = new Date(now).toISOString();
  const held = _db().get('SELECT * FROM people_rhythm WHERE name = ?', [n]);
  if (held) {
    _db().run('UPDATE people_rhythm SET every_days = ?, ask_about = ?, last_at = COALESCE(?, last_at), updated_at = ? WHERE name = ?',
      [every, askAbout ? String(askAbout).slice(0, 200) : null, lastAt || null, at, n]);
  } else {
    _db().run('INSERT INTO people_rhythm (name, every_days, last_at, ask_about, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [n, every, lastAt || null, askAbout ? String(askAbout).slice(0, 200) : null, at, at]);
  }
  return { ok: true, rhythm: _rhythm(_db().get('SELECT * FROM people_rhythm WHERE name = ?', [n]), now) };
}

function caughtUp(name, { now = Date.now() } = {}) {
  _ensureRhythm();
  const r = _db().get('SELECT * FROM people_rhythm WHERE name = ?', [name]);
  if (!r) return { ok: false, status: 404, error: 'No rhythm for that person.' };
  _db().run('UPDATE people_rhythm SET last_at = ?, updated_at = ? WHERE name = ?', [today(now), new Date(now).toISOString(), name]);
  return { ok: true, rhythm: _rhythm(_db().get('SELECT * FROM people_rhythm WHERE name = ?', [name]), now) };
}

function removeRhythm(name) {
  _ensureRhythm();
  _db().run('DELETE FROM people_rhythm WHERE name = ?', [name]);
  return { ok: true };
}

// ── Letters to future me ─────────────────────────────────────────────────────

let _letReady = false;
function _ensureLetters() {
  if (_letReady) return;
  _db().run(`CREATE TABLE IF NOT EXISTS future_letters (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, written_on TEXT NOT NULL, open_on TEXT NOT NULL,
    opened_at TEXT, kept INTEGER NOT NULL DEFAULT 0, reply_to TEXT)`);
  _letReady = true;
}

function _letter(r, now, { reveal = false } = {}) {
  const arrived = r.open_on <= today(now);
  return {
    id: r.id, writtenOn: r.written_on, openOn: r.open_on, arrived, opened: !!r.opened_at,
    kept: !!r.kept, replyTo: r.reply_to || null,
    // Sealed means sealed: the words are not sent until the day arrives.
    body: arrived || reveal ? r.body : null,
  };
}

function listLetters(now = Date.now()) {
  _ensureLetters();
  return _db().all('SELECT * FROM future_letters ORDER BY open_on').map((r) => _letter(r, now));
}

function writeLetter(body, { openOn, replyTo = null, now = Date.now() } = {}) {
  _ensureLetters();
  const b = String(body || '').trim();
  if (!b) return { ok: false, status: 400, error: 'Write something first.' };
  if (b.length > 10000) return { ok: false, status: 400, error: 'That letter is too long (10,000 characters).' };
  if (!_validDate(openOn) || openOn <= today(now)) return { ok: false, status: 400, error: 'Pick a day after today for it to come back.' };
  const id = `letter:${crypto.randomUUID()}`;
  _db().run('INSERT INTO future_letters (id, body, written_on, open_on, reply_to) VALUES (?, ?, ?, ?, ?)', [id, b, today(now), openOn, replyTo]);
  return { ok: true, letter: _letter(_db().get('SELECT * FROM future_letters WHERE id = ?', [id]), now) };
}

function openLetter(id, { now = Date.now() } = {}) {
  _ensureLetters();
  const r = _db().get('SELECT * FROM future_letters WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'No such letter.' };
  if (r.open_on > today(now)) return { ok: false, status: 409, error: `Sealed until ${r.open_on}.` };
  if (!r.opened_at) _db().run('UPDATE future_letters SET opened_at = ? WHERE id = ?', [new Date(now).toISOString(), id]);
  return { ok: true, letter: _letter(_db().get('SELECT * FROM future_letters WHERE id = ?', [id]), now) };
}

function keepLetter(id, kept = true) {
  _ensureLetters();
  const r = _db().get('SELECT * FROM future_letters WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'No such letter.' };
  _db().run('UPDATE future_letters SET kept = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?', [kept ? 1 : 0, new Date().toISOString(), id]);
  return { ok: true };
}

function removeLetter(id) {
  _ensureLetters();
  const r = _db().get('SELECT * FROM future_letters WHERE id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'No such letter.' };
  if (r.open_on <= today()) return { ok: false, status: 409, error: 'It has arrived — keep it or leave it, but it isn’t removed.' };
  _db().run('DELETE FROM future_letters WHERE id = ?', [id]);
  return { ok: true };
}

function lettersArrived(now = Date.now()) {
  return listLetters(now).filter((l) => l.arrived && !l.opened);
}

// ── Garden: old notes, three a week ──────────────────────────────────────────

const GARDEN_FOLDERS = ['Projects', 'Ideas', 'Decision Log', 'Areas', 'Knowledge'];
const GARDEN_MIN_AGE_DAYS = 90;
const GARDEN_PER_WEEK = 3;
const GARDEN_KEY = 'garden_week';

function _isoWeek(now) {
  const d = new Date(`${today(now)}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const wk = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

/** PURE: a stable pick of `n` from candidates for a week (same week, same picks). */
function pickForWeek(candidates, week, n = GARDEN_PER_WEEK) {
  const score = (p) => crypto.createHash('sha256').update(`${week}|${p}`).digest('hex');
  return candidates.slice().sort((a, b) => score(a).localeCompare(score(b))).slice(0, n);
}

function _gardenCandidates(root, now) {
  const out = [];
  const cutoff = now - GARDEN_MIN_AGE_DAYS * 86400000;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'Archive' || e.name === '_toDelete') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.md') || e.name === '_about.md' || / 2\.md$/.test(e.name)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs > cutoff || st.size < 400) continue;
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  for (const f of GARDEN_FOLDERS) walk(path.join(root, f), 0);
  return out;
}

function garden({ now = Date.now(), root = process.env.OBSIDIAN_VAULT_PATH } = {}) {
  const week = _isoWeek(now);
  let held = null;
  try { held = JSON.parse(_db().getState(GARDEN_KEY) || 'null'); } catch { held = null; }
  if (!held || held.week !== week) {
    if (!root || !fs.existsSync(root)) return { ok: false, week, picks: [], why: 'The vault could not be read.' };
    const picks = pickForWeek(_gardenCandidates(root, now), week);
    held = { week, picks, done: [] };
    _db().setState(GARDEN_KEY, JSON.stringify(held));
  }
  const done = new Set(held.done || []);
  return {
    ok: true, week,
    picks: held.picks.map((p) => ({ path: p, title: path.basename(p, '.md'), folder: p.split('/')[0], done: done.has(p) })),
  };
}

function gardenDone(p) {
  let held = null;
  try { held = JSON.parse(_db().getState(GARDEN_KEY) || 'null'); } catch { held = null; }
  if (!held || !held.picks.includes(p)) return { ok: false, status: 404, error: 'Not one of this week’s notes.' };
  held.done = [...new Set([...(held.done || []), p])];
  _db().setState(GARDEN_KEY, JSON.stringify(held));
  return { ok: true };
}

// ── Logbook + Choose for me ──────────────────────────────────────────────────

let _logReady = false;
function _ensureLog() {
  if (_logReady) return;
  _db().run(`CREATE TABLE IF NOT EXISTS logbook_entries (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, rating INTEGER,
    logged_on TEXT NOT NULL, place TEXT, notes TEXT, created_at TEXT NOT NULL)`);
  _db().run('CREATE INDEX IF NOT EXISTS idx_logbook_kind ON logbook_entries(kind, title)');
  _logReady = true;
}

const KIND_RE = /^[a-z][a-z -]{1,29}$/;

function logEntry({ kind, title, rating = null, loggedOn = null, place = null, notes = null, now = Date.now() } = {}) {
  _ensureLog();
  const k = String(kind || '').trim().toLowerCase();
  if (!KIND_RE.test(k)) return { ok: false, status: 400, error: 'Say what kind of thing it is (restaurant, film, book, coffee…).' };
  const t = String(title || '').trim();
  if (!t || t.length > 200) return { ok: false, status: 400, error: 'Give it a name.' };
  if (rating != null && rating !== '' && !(Number.isInteger(Number(rating)) && Number(rating) >= 1 && Number(rating) <= 10)) {
    return { ok: false, status: 400, error: 'Rating is 1 to 10.' };
  }
  const on = loggedOn || today(now);
  if (!_validDate(on) || on > today(now)) return { ok: false, status: 400, error: 'Pick a real day, not in the future.' };
  const id = `log:${crypto.randomUUID()}`;
  _db().run('INSERT INTO logbook_entries (id, kind, title, rating, logged_on, place, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, k, t, rating === '' || rating == null ? null : Number(rating), on, place ? String(place).slice(0, 200) : null, notes ? String(notes).slice(0, 2000) : null, new Date(now).toISOString()]);
  return { ok: true, id };
}

function removeEntry(id) {
  _ensureLog();
  _db().run('DELETE FROM logbook_entries WHERE id = ?', [id]);
  return { ok: true };
}

function listLog({ kind = null, limit = 100 } = {}) {
  _ensureLog();
  const rows = kind
    ? _db().all('SELECT * FROM logbook_entries WHERE kind = ? ORDER BY logged_on DESC, created_at DESC LIMIT ?', [kind, limit])
    : _db().all('SELECT * FROM logbook_entries ORDER BY logged_on DESC, created_at DESC LIMIT ?', [limit]);
  const kinds = _db().all('SELECT kind, COUNT(*) n FROM logbook_entries GROUP BY kind ORDER BY n DESC');
  return { entries: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, rating: r.rating, loggedOn: r.logged_on, place: r.place, notes: r.notes })), kinds };
}

/**
 * PURE. Choose from Nick's own logs: one row per title (its latest rating, its
 * latest date). Qualifies if rated ≥ minRating and not logged in the last
 * skipDays. Score = weight·rating + (1−weight)·time-since, both 0–100.
 */
function choose(entries, { minRating = 7, skipDays = 14, weight = 0.6, today: d }) {
  const byTitle = new Map();
  for (const e of entries) {
    const k = e.title.trim().toLowerCase();
    const h = byTitle.get(k);
    if (!h || e.loggedOn > h.last) byTitle.set(k, { title: e.title, kind: e.kind, place: e.place, rating: e.rating, last: e.loggedOn, count: (h ? h.count : 0) + 1 });
    else h.count++;
  }
  const pool = [...byTitle.values()].map((x) => {
    const since = daysBetween(x.last, d);
    const why = [];
    if (x.rating == null) why.push('not rated');
    else if (x.rating < minRating) why.push(`rated ${x.rating}, below ${minRating}`);
    if (since < skipDays) why.push(`logged ${since} day${since === 1 ? '' : 's'} ago`);
    return { ...x, since, qualifies: why.length === 0, why: why.join(' · ') || null };
  });
  const maxSince = Math.max(1, ...pool.filter((p) => p.qualifies).map((p) => p.since));
  for (const p of pool) {
    p.score = p.qualifies ? Math.round(100 * (weight * (p.rating / 10) + (1 - weight) * (p.since / maxSince))) : null;
  }
  const ranked = pool.filter((p) => p.qualifies).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { pool, top: ranked.slice(0, 3), qualifying: ranked.length };
}

function chooseFor(kind, opts = {}, { now = Date.now() } = {}) {
  _ensureLog();
  const k = String(kind || '').trim().toLowerCase();
  if (!KIND_RE.test(k)) return { ok: false, status: 400, error: 'Pick a kind.' };
  const minRating = Number.isInteger(Number(opts.minRating)) ? Math.min(10, Math.max(1, Number(opts.minRating))) : 7;
  const skipDays = Number.isInteger(Number(opts.skipDays)) ? Math.min(365, Math.max(0, Number(opts.skipDays))) : 14;
  const weight = Number.isFinite(Number(opts.weight)) ? Math.min(1, Math.max(0, Number(opts.weight))) : 0.6;
  const entries = listLog({ kind: k, limit: 1000 }).entries;
  const r = choose(entries, { minRating, skipDays, weight, today: today(now) });
  // "Another idea" walks the top three in turn.
  const turn = Number.isInteger(Number(opts.turn)) ? Number(opts.turn) : 0;
  const pick = r.top.length ? r.top[((turn % r.top.length) + r.top.length) % r.top.length] : null;
  return { ok: true, kind: k, rules: { minRating, skipDays, weight }, pick, top: r.top, pool: r.pool, qualifying: r.qualifying };
}

module.exports = {
  today, addDays, daysBetween,
  listDecisions, addDecision, setLookBack, reviewDecision, decisionsDue, OUTCOMES, LOOK_BACK_DEFAULT_DAYS,
  listRhythm, setRhythm, caughtUp, removeRhythm,
  listLetters, writeLetter, openLetter, keepLetter, removeLetter, lettersArrived,
  garden, gardenDone, pickForWeek, _isoWeek,
  logEntry, removeEntry, listLog, choose, chooseFor,
};
