'use strict';

/**
 * People gap pass — find colleagues NEURO deals with who have no People note.
 *
 * Nothing in NEURO ever created a People note: person-profile.js is only
 * reachable from its route and the MCP tool, both manual. So People/ only ever
 * held whoever Nick typed in by hand, and every consumer that keys off the
 * roster (entity extraction, contact resolution, person pages) was capped at
 * that list.
 *
 * Follows the vault-hygiene convention: the scheduled pass is READ-ONLY and
 * writes a report; creating the stubs is an explicit call.
 *
 * Sources, all things that already exist — no new tables, no Graph calls:
 *   - meeting notes' Attendees/Mentioned sections
 *   - triaged inbox senders on an internal domain
 *   - calendar_cache organizers
 *
 * A name needs MIN_SIGHTINGS appearances before it counts. One stray mention in
 * one transcript is noise; the same person turning up twice is a colleague.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const { getRoster, readAliases } = require('./entities');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
const REPORT_FOLDER = 'Documents/System/Vault Audit';
// ⚠ ONE ROLLING FILE, overwritten, never a dated one per night. A dated report
// for a list that barely changes is three near-identical files a week piling up
// in a folder Nick has to read — and the point of the card is that he does not.
// Kept rather than dropped so there is still a vault-readable record when the
// backend is down, which is exactly when a UI-only surface says nothing at all.
const REPORT_FILE = 'People gaps.md';
const MIN_SIGHTINGS = 2;

// Ignore list and push memory live in the KV store, following `ms_todo_list_by_task`
// and `push_governor`: disposable state nothing queries by anything but its key,
// and a schema migration on the live DB is a bigger risk than the convenience.
// ⚠ PERSISTED, not in memory — the backend restarts several times a day on
// deploys, and an ignore that evaporates is the nightly reappearance this exists
// to stop, with extra steps.
const IGNORE_KEY = 'people_gap_ignored';
const NOTIFIED_KEY = 'people_gap_notified';

// Only colleagues belong in People/. Customers and vendors would flood it.
const INTERNAL_DOMAINS = (process.env.PEOPLE_GAP_DOMAINS || 'nurtur.tech')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

// ⚠ The SENSITIVE and PERSONAL directories are pulled from vault-exclusions
// rather than typed out again. This file's own list is deliberately separate
// (it is scoped to its own job and the other copies are left alone), but these
// two are not a scoping decision — they are a rule about what must never enter
// the person graph, and this module is the one that ACTS on it: it does not
// merely rank a name, it CREATES a People note.
//
// Without this it would walk `Personal/` — Nick's disciplinary prep, the fraud
// investigation, his GP notes and three Occupational Health documents — and
// propose People notes for the HR officer who handled his disciplinary, the
// external OH assessor and his GP, filing them alongside his direct reports.
const { SENSITIVE_DIRS, PERSONAL_DIRS } = require('./vault-exclusions');

const SKIP_DIRS = new Set([
  'transcripts', '_transcripts', 'Archive', 'Vault Audit', '.lint-backups',
  '.git', '.obsidian', 'Templates', 'Scripts',
  ...SENSITIVE_DIRS, ...PERSONAL_DIRS,
]);

function existingPeople() {
  try {
    return fs.readdirSync(path.join(VAULT_PATH(), 'People'))
      .filter(f => f.endsWith('.md') && !f.startsWith('_'))
      .map(f => f.slice(0, -3));
  } catch { return []; }
}

// A display name from Graph often arrives as "Ward, Nick" — People notes are
// "Nick Ward", so compare on a normalised, order-insensitive key or the same
// person gets a second note.
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function tidyName(name) {
  const raw = String(name || '').trim().replace(/\s+/g, ' ');
  const flipped = raw.match(/^([^,]+),\s*(.+)$/); // "Ward, Nick" → "Nick Ward"
  return flipped ? `${flipped[2].trim()} ${flipped[1].trim()}` : raw;
}

function looksLikePerson(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 60) return false;
  if (/no.?reply|notification|alert|support|admin|team|service|automated|do.?not.?reply/i.test(n)) return false;
  if (n.includes('@') || n.includes('/')) return false;
  const words = n.split(/\s+/);
  // Two words minimum: a bare first name can't be filed as a person note.
  return words.length >= 2 && words.length <= 4 && words.every(w => /^[\p{L}][\p{L}'’.-]*$/u.test(w));
}

// ── What is not a person ──────────────────────────────────────────────────
//
// `looksLikePerson` already refuses the shapes an ADDRESS takes (no-reply,
// notification, a bare first name). These are the shapes a ROOM takes, and they
// are a different rule: "The Scrum Room" is two-to-four capitalised words and
// passes every test above it, so it came back every night and could only ever
// be ignored by hand.
//
// ⚠ A SUFFIX, never a substring. `team` is already matched anywhere by the rule
// above — which is why a real colleague surnamed Teamer would be refused — and
// widening that habit is how a person called "Mark Roomes" stops existing.
// Anchored to the last word, so only the naming convention is caught.
const NON_PERSON_PREFIXES = (process.env.PEOPLE_GAP_NOT_PEOPLE_PREFIXES || 'The')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const NON_PERSON_SUFFIXES = (process.env.PEOPLE_GAP_NOT_PEOPLE_SUFFIXES ||
  'Room,Rooms,Suite,Office,Desk,Board,Squad,Tribe,Hub,Lab,Studio')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/**
 * PURE. Why this name is not a person, in words, or null if it might be.
 * The reason is returned rather than a boolean so the card can SAY why a name
 * was withheld — a silent filter is one nobody can check.
 */
function nonPersonReason(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const first = words[0].toLowerCase();
  const last = words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '');
  if (words.length > 1 && NON_PERSON_PREFIXES.includes(first)) return `starts with "${words[0]}"`;
  if (words.length > 1 && NON_PERSON_SUFFIXES.includes(last)) return `ends in "${words[words.length - 1]}"`;
  return null;
}

// ── Near misses ───────────────────────────────────────────────────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n];
}

/**
 * PURE. The one existing person this name is probably a mis-transcription of,
 * or null.
 *
 * ⚠ THE FIRST NAME MUST MATCH EXACTLY, and that is what makes this safe rather
 * than lucky. The live case is "Naomi Winkworth" for Naomi Wentworth — Plaud
 * hears the surname wrong and the given name right, every time. A rule that
 * allowed both halves to drift would match "Chris Smith" to "Chris Middleton"
 * at distance 8 on nothing but a shared first name, and offering to fold one
 * real colleague into another is a mistake with no undo from a card.
 *
 * ⚠ AMBIGUITY IS REFUSED, NEVER RANKED. Two candidates within the threshold
 * means the evidence does not identify one person, and picking the closer is a
 * coin toss dressed as a fact — the same refusal `matchSaid` makes.
 *
 * ⚠ It SUGGESTS. Nothing here writes; `addAlias` is a separate, confirmed act.
 */
function nearestPerson(name, knownNames, { maxDistance = 3 } = {}) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0].toLowerCase();
  const surname = parts.slice(1).join(' ').toLowerCase();
  if (!surname) return null;

  const hits = [];
  for (const known of knownNames || []) {
    const kp = String(known).trim().split(/\s+/).filter(Boolean);
    if (kp.length < 2) continue;
    if (kp[0].toLowerCase() !== first) continue;
    const kSurname = kp.slice(1).join(' ').toLowerCase();
    if (kSurname === surname) continue; // the same person, not a near miss
    const d = levenshtein(surname, kSurname);
    // Scaled to the shorter surname: 3 edits in "Li" is a different name, 3 in
    // "Wentworth" is one syllable misheard.
    if (d <= Math.min(maxDistance, Math.floor(Math.min(surname.length, kSurname.length) / 3))) {
      hits.push({ name: known, distance: d });
    }
  }
  if (hits.length !== 1) return null; // 0 = no near miss, 2+ = refuse
  return hits[0];
}

// ── Writing an alias ──────────────────────────────────────────────────────

/**
 * PURE. Insert `alias` into a People note's `aliases:` frontmatter block.
 *
 * ⚠ A HAND-WRITTEN SINGLE-LINE EDIT, and it must stay one. `updateFrontmatter`
 * reserialises line by line and SILENTLY DROPS LIST VALUES — it is what made
 * `fm.aliases` read as "" for all 31 notes that carry one — so putting this
 * through it would delete every other alias on the note it was asked to add to.
 * The same reason `contact-directory` writes `email:` by hand.
 *
 * Returns `{ ok:false, reason }` rather than throwing, and `{ ok:true, already:true }`
 * when the alias is already there — a no-op is not a failure.
 */
function insertAlias(src, alias) {
  const value = String(alias || '').trim();
  if (!value) return { ok: false, reason: 'no alias given' };

  const crlf = /\r\n/.test(String(src || ''));
  const text = String(src || '').replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { ok: false, reason: 'note has no frontmatter' };

  const existing = readAliases(text);
  if (existing.some(a => a.toLowerCase() === value.toLowerCase())) {
    return { ok: true, already: true, text: String(src || ''), line: null };
  }

  const block = fm[1].split('\n');
  const idx = block.findIndex(l => /^aliases:/.test(l));
  const restore = out => (crlf ? out.replace(/\n/g, '\r\n') : out);

  if (idx < 0) {
    // No aliases key at all — open a block list directly under `type:` if there
    // is one, else at the top of the frontmatter. Never appended to the end,
    // where a trailing multi-line value would swallow it.
    const anchor = block.findIndex(l => /^type:/.test(l));
    const at = anchor >= 0 ? anchor + 1 : 0;
    const line = `  - ${value}`;
    block.splice(at, 0, 'aliases:', line);
    return { ok: true, already: false, line, text: restore(text.replace(fm[1], block.join('\n'))) };
  }

  const inline = block[idx].slice(block[idx].indexOf(':') + 1).trim();
  if (inline && inline !== '[]') {
    // Inline `[a, b]` — extend it in place rather than converting the form.
    const line = `${block[idx].replace(/\]\s*$/, '')}, ${value}]`;
    block[idx] = line;
    return { ok: true, already: false, line, text: restore(text.replace(fm[1], block.join('\n'))) };
  }

  // Block list — append after the last `- ` line belonging to this key.
  let end = idx;
  while (end + 1 < block.length && /^\s*-\s+/.test(block[end + 1])) end += 1;
  const indent = end > idx ? (block[end].match(/^\s*/) || ['  '])[0] : '  ';
  const line = `${indent}- ${value}`;
  block.splice(end + 1, 0, line);
  return { ok: true, already: false, line, text: restore(text.replace(fm[1], block.join('\n'))) };
}

// ── Sightings ─────────────────────────────────────────────────────────────

function addSighting(map, name, source) {
  const tidied = tidyName(name);
  if (!looksLikePerson(tidied)) return;
  const key = nameKey(tidied);
  if (!key) return;
  const entry = map.get(key) || { name: tidied, count: 0, sources: new Set() };
  entry.count += 1;
  entry.sources.add(source);
  map.set(key, entry);
}

// ── Sources ───────────────────────────────────────────────────────────────

function fromMeetingNotes(map, days) {
  const dir = path.join(VAULT_PATH(), 'Meetings');
  if (!fs.existsSync(dir)) return;
  const { extractAttendeesForFrontmatter } = require('./imports');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  (function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) continue;
        for (const attendee of extractAttendeesForFrontmatter(fs.readFileSync(full, 'utf-8'))) {
          // Already-linked attendees come back as `[[People/X|Y]]` — they have a
          // note by definition, so only the bare names are candidates.
          if (attendee.startsWith('[[')) continue;
          addSighting(map, attendee, 'meetings');
        }
      } catch { /* unreadable note — never fail the whole scan */ }
    }
  })(dir);
}

function fromTriagedInbox(map) {
  let stored = [];
  try { stored = JSON.parse(db.getState('email_triage') || '[]'); } catch { return; }
  for (const item of stored) {
    const email = String(item?.fromEmail || '').trim().toLowerCase();
    const name = String(item?.from || '').trim();
    if (!email.includes('@') || !name || name === email) continue;
    if (!INTERNAL_DOMAINS.some(d => email.endsWith(`@${d}`))) continue;
    addSighting(map, name, 'inbox');
  }
}

// calendar_cache holds no attendee list, only the organizer — so this is a
// thin source, but it's the one that catches people Nick meets and never emails.
function fromCalendarOrganizers(map, days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  let rows = [];
  try {
    rows = db.getCalendarEvents(start.toISOString(), end.toISOString()) || [];
  } catch { return; }
  for (const row of rows) {
    if (row?.organizer) addSighting(map, row.organizer, 'calendar');
  }
}

// ── Ignore list ───────────────────────────────────────────────────────────

/**
 * Names Nick has said are not people he wants a note for — a room, a shared
 * mailbox, a customer who slipped the domain filter, a name he simply does not
 * want in the graph.
 *
 * ⚠ Keyed on `nameKey`, never the raw string, so "Thorpe, Catherine" and
 * "Catherine Thorpe" are one decision. Stored with the display name beside it
 * so the Ignored list can show what he actually pressed.
 * ⚠ An unreadable store IGNORES NOTHING and says so — it must never fail the
 * scan, and the safe direction here is showing a name again rather than hiding
 * one on the strength of not having looked.
 */
function listIgnored() {
  try {
    const raw = JSON.parse(db.getState(IGNORE_KEY) || '[]');
    if (!Array.isArray(raw)) return { known: true, entries: [] };
    return {
      known: true,
      entries: raw
        .filter(e => e && e.name)
        .map(e => ({ name: String(e.name), at: e.at || null, reason: e.reason || null })),
    };
  } catch {
    return { known: false, entries: [] };
  }
}

function ignoreName(name, reason = null) {
  const tidied = tidyName(name);
  if (!tidied) return { status: 'error', error: 'name is required' };
  const { entries } = listIgnored();
  const key = nameKey(tidied);
  if (entries.some(e => nameKey(e.name) === key)) {
    return { status: 'ok', already: true, name: tidied, ignored: entries.length };
  }
  const next = [...entries, { name: tidied, at: new Date().toISOString(), reason }];
  db.setState(IGNORE_KEY, JSON.stringify(next));
  return { status: 'ok', already: false, name: tidied, ignored: next.length };
}

/** The way back. Every other decision in this codebase has one. */
function unignoreName(name) {
  const key = nameKey(tidyName(name));
  if (!key) return { status: 'error', error: 'name is required' };
  const { entries } = listIgnored();
  const next = entries.filter(e => nameKey(e.name) !== key);
  if (next.length === entries.length) return { status: 'ok', removed: false, ignored: entries.length };
  db.setState(IGNORE_KEY, JSON.stringify(next));
  return { status: 'ok', removed: true, ignored: next.length };
}

// ── Aliases ───────────────────────────────────────────────────────────────

/**
 * Every name the roster already resolves — full names AND the unambiguous
 * aliases.
 *
 * ⚠ THE ALIAS MAP IS WHY "Naomi Winkworth" CAME BACK EVERY NIGHT. It has been
 * mapped to Naomi Wentworth in her frontmatter since 16 Aug and
 * `entities.getRoster()` resolves it correctly everywhere else in NEURO — but
 * `findGaps` only ever compared against People FILENAMES, so the one place that
 * proposes a new person was the one place blind to the mapping that says she
 * already has a note. A resolved alias is not a gap.
 *
 * Falls back to filenames alone when the roster cannot be read: fewer names
 * suppressed, never more, and the fallback is reported.
 */
function resolvedNames() {
  // ⚠ THE FILENAMES ARE UNIONED IN, NOT REPLACED BY THE ROSTER. `getRoster`
  // caches for five minutes, so a note Nick created ten seconds ago from the
  // card is not in it — and taking the roster alone would leave the name he
  // just filed sitting in the suggestions, which reads as a button that did
  // nothing. `existingPeople()` is a live readdir and always current.
  //
  // The ALIAS half stays cached and is deliberately not forced: a freshly added
  // alias reappearing once costs a duplicate suggestion, which is visible and
  // cheap, where re-walking 43 notes on a polled read is not.
  const files = existingPeople();
  try {
    const roster = getRoster();
    const full = [...new Set([...files, ...roster.full])];
    return {
      known: true,
      full,
      keys: new Set([...full.map(nameKey), ...[...roster.aliases.keys()].map(nameKey)]),
    };
  } catch {
    // Filenames alone: fewer names suppressed, never more, and it is reported.
    return { known: false, full: files, keys: new Set(files.map(nameKey)) };
  }
}

/**
 * Add `alias` to an existing person's note. Explicit and confirmed — the card
 * quotes the exact line before this is ever called.
 *
 * ⚠ THREE REFUSALS, and they are #38's rules rather than new ones: an alias
 * must not be claimed by two people, must not be a first name the roster finds
 * ambiguous, and must not be somebody else's full name. An alias that fails any
 * of them is DROPPED by `getRoster` anyway, so writing it would put a line in
 * Nick's vault that looks like it did something and resolves nothing.
 * ⚠ `dryRun` returns the literal line and writes nothing — that is what the
 * confirm renders.
 */
function addAlias({ person, alias, dryRun = false }) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  const target = tidyName(person);
  const value = tidyName(alias);
  if (!target || !value) return { status: 'error', error: 'person and alias are required' };

  const file = path.join(vault, 'People', `${target}.md`);
  if (!fs.existsSync(file)) return { status: 'error', error: `Person note not found: People/${target}.md` };

  let roster;
  try { roster = getRoster(); }
  catch (e) { return { status: 'error', error: `roster unreadable: ${e.message}` }; }

  const key = value.toLowerCase();
  // ⚠ The full-name check reads the LIVE filenames (unioned in by
  // `resolvedNames`), not the five-minute roster cache: a person note created
  // moments ago from the same card must already count as somebody's name here,
  // or the one guard that stops an alias naming a real colleague has a window.
  if (resolvedNames().full.some(n => n.toLowerCase() === key && n.toLowerCase() !== target.toLowerCase())) {
    return { status: 'refused', reason: `"${value}" is already someone else's full name` };
  }
  if (roster.firstNames.has(key) && roster.firstNames.get(key) !== target) {
    return { status: 'refused', reason: `"${value}" already resolves to ${roster.firstNames.get(key)}` };
  }
  const owner = roster.aliases.get(key);
  if (owner && owner !== target) {
    return { status: 'refused', reason: `"${value}" is already an alias of ${owner}` };
  }

  let src;
  try { src = fs.readFileSync(file, 'utf-8'); }
  catch (e) { return { status: 'error', error: e.message }; }

  const edit = insertAlias(src, value);
  if (!edit.ok) return { status: 'error', error: edit.reason };
  if (edit.already) return { status: 'ok', already: true, person: target, alias: value, line: null };
  if (dryRun) return { status: 'dry-run', person: target, alias: value, line: edit.line, path: `People/${target}.md` };

  try { fs.writeFileSync(file, edit.text, 'utf-8'); }
  catch (e) { return { status: 'error', error: e.message }; }
  return { status: 'ok', already: false, person: target, alias: value, line: edit.line, path: `People/${target}.md` };
}

// ── Scan ──────────────────────────────────────────────────────────────────

/**
 * Read-only. Returns the names seen at least minSightings times that have no
 * People note.
 */
function findGaps({ days = 90, minSightings = MIN_SIGHTINGS } = {}) {
  if (!VAULT_PATH()) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured', candidates: [] };

  const sightings = new Map();
  fromMeetingNotes(sightings, days);
  fromTriagedInbox(sightings);
  fromCalendarOrganizers(sightings, days);

  const resolved = resolvedNames();
  const ignored = listIgnored();
  const ignoredKeys = new Set(ignored.entries.map(e => nameKey(e.name)));

  // Every name withheld is COUNTED AND REASONED, never silently dropped. A card
  // showing three candidates out of eleven sightings with no account of the
  // other eight is one nobody can check — and "the filter ate a real colleague"
  // is otherwise indistinguishable from "nobody new turned up".
  const withheld = { resolved: [], ignored: [], notPeople: [] };
  const open = [];

  for (const entry of sightings.values()) {
    const row = { name: entry.name, count: entry.count, sources: [...entry.sources].sort() };
    if (resolved.keys.has(nameKey(row.name))) { withheld.resolved.push(row.name); continue; }
    if (ignoredKeys.has(nameKey(row.name))) { withheld.ignored.push(row.name); continue; }
    const notPerson = nonPersonReason(row.name);
    if (notPerson) { withheld.notPeople.push({ name: row.name, reason: notPerson }); continue; }
    // A near miss is offered as a QUESTION about an existing person, never acted
    // on: the write is a separate, confirmed call.
    const near = nearestPerson(row.name, resolved.full);
    if (near) row.maybeAliasOf = near.name;
    open.push(row);
  }

  open.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    status: 'ok',
    scannedDays: days,
    minSightings,
    existing: resolved.keys.size,
    // ⚠ `rosterKnown:false` means the alias map could not be read, so a name
    // already mapped to somebody may be proposed as new. Reported rather than
    // hidden: the failure is a duplicate suggestion, which is visible and cheap.
    rosterKnown: resolved.known,
    ignoreKnown: ignored.known,
    candidates: open.filter(c => c.count >= minSightings),
    belowThreshold: open.filter(c => c.count < minSightings),
    withheld,
    ignored: ignored.entries,
  };
}

// ── Apply ─────────────────────────────────────────────────────────────────

/**
 * Create stub People notes. Explicit — the scheduled pass never calls this.
 * Stubs are marked `status: auto-stub` so a hand-written note is never mistaken
 * for one, and carry no 1-2-1 cadence: NEURO doesn't know if this is a report.
 */
function createStubs({ names = null, role = null, days = 90, minSightings = MIN_SIGHTINGS, dryRun = false } = {}) {
  const scan = findGaps({ days, minSightings });
  if (scan.status !== 'ok') return scan;

  const wanted = names && names.length ? new Set(names.map(nameKey)) : null;
  // ⚠ An EXPLICIT name may come from the seen-once pool. Nick pressing Create on
  // a name he can see is a stronger signal than the sighting threshold, which
  // exists only to decide what to OFFER unprompted; refusing it would make the
  // button on those rows silently do nothing. A bare call (no names) still only
  // ever creates what met the threshold.
  const pool = wanted ? [...scan.candidates, ...scan.belowThreshold] : scan.candidates;
  const targets = pool.filter(c => !wanted || wanted.has(nameKey(c.name)));

  if (dryRun) return { status: 'dry-run', wouldCreate: targets };

  const { managePersonProfile } = require('./person-profile');
  const created = [];
  const failed = [];

  for (const candidate of targets) {
    const result = managePersonProfile({
      action: 'create',
      person: candidate.name,
      frontmatter: {
        // NEURO still does not guess whether this is a report or how often Nick
        // should see them — a cadence it invented would start a 1-2-1 clock
        // nobody set. `role` is the one field the card offers, because it is the
        // one Nick knows at the moment he presses the button.
        ...(role ? { role: String(role).trim() } : {}),
        'direct-report': false,
        manager: '',
        cadence: '',
        status: 'auto-stub',
        'first-seen': new Date().toISOString().slice(0, 10),
        'seen-in': candidate.sources.join(', '),
      },
    });
    if (result.status === 'created') created.push(candidate.name);
    else failed.push({ name: candidate.name, error: result.error });
  }

  return { status: 'ok', created, failed, skipped: pool.length - targets.length };
}

// ── Report ────────────────────────────────────────────────────────────────

function writeReport(scan) {
  const dir = path.join(VAULT_PATH(), REPORT_FOLDER);
  const file = path.join(dir, REPORT_FILE);
  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    '---',
    'type: report',
    `updated: ${date}`,
    'source: NEURO people-gap',
    '---',
    '',
    '# People gaps',
    '',
    'Rewritten by the nightly scan. Act on these in **NEURO → People**, not here —',
    'this file is the record for when the backend is down.',
    '',
    `Names seen ${scan.minSightings}+ times in the last ${scan.scannedDays} days that the roster does not resolve.`,
    `${scan.existing} names resolve today (People notes plus their aliases).`,
    '',
  ];

  // A degraded read must never render as a clean one.
  if (scan.rosterKnown === false) lines.push('> ⚠ The alias map could not be read, so a name already mapped to somebody may be listed below as new.', '');
  if (scan.ignoreKnown === false) lines.push('> ⚠ The ignore list could not be read, so names you have already dismissed may be listed below.', '');

  if (!scan.candidates.length) {
    lines.push('Nothing to add — every name seen resolves to someone.', '');
  } else {
    lines.push('| Name | Sightings | Seen in | Maybe |', '|------|-----------|---------|-------|');
    for (const c of scan.candidates) {
      lines.push(`| ${c.name} | ${c.count} | ${c.sources.join(', ')} | ${c.maybeAliasOf ? `alias of ${c.maybeAliasOf}?` : ''} |`);
    }
    lines.push('');
  }

  if (scan.belowThreshold.length) {
    lines.push(`## Seen only once (${scan.belowThreshold.length})`, '');
    for (const c of scan.belowThreshold) lines.push(`- ${c.name} (${c.sources.join(', ')})${c.maybeAliasOf ? ` — maybe an alias of ${c.maybeAliasOf}` : ''}`);
    lines.push('');
  }

  // What was withheld, and why. Same rule as the card.
  const w = scan.withheld || { resolved: [], ignored: [], notPeople: [] };
  if (w.ignored.length || w.notPeople.length) {
    lines.push('## Not shown', '');
    if (w.ignored.length) lines.push(`- Ignored (${w.ignored.length}): ${w.ignored.join(', ')}`);
    for (const n of w.notPeople) lines.push(`- Not a person — ${n.reason}: ${n.name}`);
    lines.push('');
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
  } catch (e) {
    return { status: 'error', error: e.message };
  }
  return { status: 'ok', path: `${REPORT_FOLDER}/${REPORT_FILE}` };
}

/**
 * PURE. The candidates Nick has not already been pushed about.
 *
 * ⚠ THE SAME FOUR NAMES ARE NOT NEWS THREE NIGHTS RUNNING. The push fired on
 * `candidates.length > 0`, so a list Nick had deliberately left alone
 * interrupted him every night for ever — and a notification that is always
 * there is one nobody reads, which costs the night a genuinely new colleague
 * turns up. Keyed on `nameKey`, so a name arriving in a different word order is
 * not new.
 *
 * ⚠ A name is forgotten once it stops being a candidate, so somebody who
 * reappears months later IS news again — this is a "have I already said this"
 * memory, never a permanent suppression. That is `ignoreName`'s job, and it is
 * a decision Nick makes rather than one the push gate takes for him.
 */
function newCandidates(candidates, notified) {
  const seen = new Set((notified || []).map(nameKey));
  return (candidates || []).filter(c => !seen.has(nameKey(c.name)));
}

/** What the scheduler runs: scan, rewrite the report, never mutate People/. */
function runNightlyScan({ days = 90 } = {}) {
  const scan = findGaps({ days });
  if (scan.status !== 'ok') return scan;
  const report = writeReport(scan);

  let notified = [];
  try { notified = JSON.parse(db.getState(NOTIFIED_KEY) || '[]'); } catch { notified = []; }
  if (!Array.isArray(notified)) notified = [];
  const fresh = newCandidates(scan.candidates, notified);
  // Written whether or not a push is sent — the memory is of what is CURRENT,
  // so a name dropping off the list is forgotten and counts as new if it
  // returns. Writing only on a send would make one failed push repeat for ever.
  try { db.setState(NOTIFIED_KEY, JSON.stringify(scan.candidates.map(c => c.name))); } catch { /* a push gate must never fail the scan */ }

  return { ...scan, report, newCandidates: fresh };
}

module.exports = {
  findGaps, createStubs, writeReport, runNightlyScan,
  listIgnored, ignoreName, unignoreName, addAlias,
  // Pure — exported so the rules pin without a vault, a DB or a clock.
  nonPersonReason, nearestPerson, insertAlias, newCandidates,
};
