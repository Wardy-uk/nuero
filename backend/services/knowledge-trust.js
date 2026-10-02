'use strict';

/**
 * WHAT NICK HAS MARKED AS KNOWLEDGE — recorded IN the note, never as a copy.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `knowledge-memory.js` answers a narrower question than its name suggests: it
 * distils RECORDINGS. `RAW_FOLDERS` is Plaud, Meetings, Imports and Daily, so
 * the 332 notes under `Projects/`, the 26 under `Decision Log/`, the 17 under
 * `Ideas/`, `Areas/` and `MOCs/` have never once been offered as knowledge —
 * not because they were judged and rejected, but because nothing looked.
 *
 * Measured 26 Sep 2026: four notes had ever been promoted, and all four were
 * PLAUD consultations. That is the mechanism working exactly as built, and it
 * is also the whole of what NEURO called "curated context SAiM can lean on".
 *
 * ⚠⚠ PROMOTING AND TRUSTING ARE DIFFERENT ACTS AND MUST NOT SHARE A MECHANISM.
 * `promoteCandidate` WRITES A NEW FILE into `Knowledge/<domain>/`, which is
 * right for a recording — turning 12,000 words of speech into 300 is
 * extraction, not duplication. Applied to a note Nick wrote himself it is a
 * straight COPY: two files, free to drift, with no answer to which one is real.
 * A note he already wrote IS the distillate. So this marks it where it lies and
 * creates nothing.
 *
 * ── Three layers, ONE truth ─────────────────────────────────────────────────
 *   1. TRUTH     `knowledge_state: trusted` in the note's own frontmatter.
 *                Lives in the vault, syncs with it, readable in Obsidian,
 *                survives the database being rebuilt, and Nick can type it by
 *                hand. Everything below is derived from this and regenerable.
 *   2. LOOKUP    the path set in `agent_state`, so a search costs one KV read.
 *   3. VIEW      `Knowledge/Knowledge Index.md`, GENERATED, for Nick to read.
 *
 * ⚠ NOTHING IN CODE MAY EVER READ LAYER 3. `Areas/1-2-1 Tracker.md` called
 * itself "single source of truth" in its own header and nothing had ever parsed
 * it — it sat frozen from April with two departed staff still listed. An index
 * is a rendering. The flag is the fact.
 *
 * ⚠ THE INDEX IS EXCLUDED FROM THE VAULT INDEXES, AND THAT IS NOT TIDINESS.
 * The same tracker was measured holding 37 `extracted_entities` rows and 3
 * embedding chunks, where a note listing 13 names outranked those people's
 * actual meetings on any "who is mentioned where" query while saying nothing.
 * A page listing fifty knowledge notes would do it worse — it would match every
 * query about any of the fifty and hand back a list of titles. Guarded twice:
 * `vault-exclusions.GENERATED_FILE_PATTERNS` keeps it out of embeddings and
 * entity extraction, and the scan refuses to put it in the trusted set, so it
 * cannot be returned as curated knowledge about itself.
 *
 * ⚠ UNKNOWN IS NOT EMPTY. `trustedPaths()` is three-valued: a set, or
 * `known:false` because nobody has scanned yet. Both yield zero results and
 * only one of them is a fact about the vault — reporting "Nick has curated
 * nothing" over a lookup that never ran is the false all-clear this codebase
 * refuses everywhere else.
 *
 * CommonJS. The predicates are PURE and take plain values, so the rules pin
 * without a vault (the `pi-health.assess()` split).
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const obsidian = require('./obsidian');
const vaultWalk = require('./vault-walk');
const vaultExclusions = require('./vault-exclusions');
// ⚠ The ONE surgical frontmatter writer. Never obsidian.updateFrontmatter —
// that reserialises the block and silently drops YAML list values.
const frontmatterEdit = require('./frontmatter-edit');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

const TRUST_KEY = 'knowledge_trusted_paths';

/** The folder whose contents are trusted by location — promotion's output. */
const KNOWLEDGE_ROOT = 'Knowledge';

/** Generated, and therefore never itself knowledge. See the header. */
const INDEX_PATH = 'Knowledge/Knowledge Index.md';

const INDEX_OPEN = '<!-- neuro:knowledge-index -->';
const INDEX_CLOSE = '<!-- /neuro:knowledge-index -->';

/**
 * ⚠ `distilled` counts because `promoteCandidate` and the consolidation pass
 * both write it. A promoted note that did not read as trusted would make the
 * promote button do nothing observable — the state this replaces.
 */
const TRUST_STATES = new Set(['trusted', 'distilled']);

// ── Pure predicates ──────────────────────────────────────────────────────────

/** Strip the quotes plaud-sync writes around frontmatter values. PURE. */
function cleanQuoted(value) {
  return String(value == null ? '' : value).trim().replace(/^"(.*)"$/s, '$1').trim();
}

/** PURE. */
function normalisePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Is this the generated index? PURE. */
function isIndexPath(relativePath) {
  return normalisePath(relativePath).toLowerCase() === INDEX_PATH.toLowerCase();
}

/** Trusted because of WHERE it sits — the output of a promotion. PURE. */
function trustedByLocation(relativePath) {
  return normalisePath(relativePath).toLowerCase().startsWith(`${KNOWLEDGE_ROOT.toLowerCase()}/`);
}

/** Trusted because the note SAYS SO. PURE. */
function trustedByFlag(frontmatter) {
  return TRUST_STATES.has(cleanQuoted((frontmatter || {}).knowledge_state).toLowerCase());
}

/**
 * Is this note curated knowledge? PURE.
 *
 * ⚠ The generated index is refused FIRST, before either test, because it lives
 * inside `Knowledge/` and would otherwise qualify by location — a rendering of
 * the set must never be a member of it.
 */
function isTrustedNote(relativePath, frontmatter) {
  if (!relativePath) return false;
  if (isIndexPath(relativePath)) return false;
  return trustedByLocation(relativePath) || trustedByFlag(frontmatter);
}

/**
 * Which domain a trusted note belongs to, for grouping the index. PURE.
 *
 * Frontmatter WINS over the path — `vault-exclusions.noteDomain`'s rule, and
 * the only way to group a note before a folder exists for it. A note under
 * `Knowledge/Nurtur/` carries its domain in the path; one marked in place under
 * `Projects/NEURO/` uses its top folder, which is a fact about where Nick filed
 * it rather than a guess about what it means.
 */
function domainOf(relativePath, frontmatter) {
  const declared = cleanQuoted((frontmatter || {}).knowledge_domain);
  if (declared) return declared;

  const parts = normalisePath(relativePath).split('/');
  if (trustedByLocation(relativePath) && parts.length > 2) return parts[1];
  return parts.length > 1 ? parts[0] : 'General';
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Read just enough of a file to parse its frontmatter.
 *
 * ⚠ The trusted set is rebuilt over ~1,500 files on a schedule, and reading
 * every byte to answer a question the first twenty lines settle is how a
 * refresh becomes the reason the Pi is busy. Bounded: a note whose opening
 * `---` is never closed inside the budget is treated as having none rather than
 * being read whole.
 */
const FRONTMATTER_BUDGET = 8192;

function readFrontmatterBlock(fullPath) {
  let fd;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buffer = Buffer.alloc(FRONTMATTER_BUDGET);
    const read = fs.readSync(fd, buffer, 0, FRONTMATTER_BUDGET, 0);
    const text = buffer.subarray(0, read).toString('utf-8');
    if (!text.startsWith('---')) return '';
    const end = text.indexOf('\n---', 3);
    if (end === -1) return '';
    return text.slice(0, end + 4);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

function describeTrusted(rel, full, parsedFm) {
  let fm = parsedFm;
  if (!fm) {
    try { fm = obsidian.parseFrontmatter(readFrontmatterBlock(full)); }
    catch { fm = {}; }
  }

  let modified = null;
  try { modified = fs.statSync(full).mtime.toISOString(); } catch { /* reported as null */ }

  return {
    path: normalisePath(rel),
    name: path.basename(rel, '.md'),
    title: cleanQuoted(fm.title) || path.basename(rel, '.md'),
    folder: normalisePath(rel).includes('/')
      ? normalisePath(rel).slice(0, normalisePath(rel).lastIndexOf('/'))
      : '',
    domain: domainOf(rel, fm),
    by: trustedByLocation(rel) ? 'location' : 'flag',
    markedAt: cleanQuoted(fm.knowledge_trusted_at) || cleanQuoted(fm.promoted_at) || null,
    modified,
  };
}

// ── The scan ─────────────────────────────────────────────────────────────────

/**
 * Walk the vault for everything currently trusted.
 *
 * ⚠ A truncated or partly unreadable walk is REPORTED and its result is NOT
 * stored. A half-read vault written over a good set silently un-trusts whatever
 * it failed to reach, and an un-trusted note is indistinguishable from one Nick
 * never marked.
 */
function scanTrusted() {
  const vault = VAULT_PATH();
  const found = [];

  const traversal = vaultWalk.walk(vault, {
    skipDir: (name) => vaultExclusions.isExcludedDir(name),
    skipFile: (rel) => !rel.toLowerCase().endsWith('.md'),
    visit: (rel, full) => {
      if (isIndexPath(rel)) return;

      // Anything under Knowledge/ qualifies on its path alone and needs no read.
      if (trustedByLocation(rel)) {
        found.push(describeTrusted(rel, full));
        return;
      }

      let head;
      try { head = readFrontmatterBlock(full); }
      catch { return; }
      if (!head) return;

      const fm = obsidian.parseFrontmatter(head);
      if (trustedByFlag(fm)) found.push(describeTrusted(rel, full, fm));
    },
  });

  found.sort((a, b) => a.path.localeCompare(b.path));

  return {
    paths: found.map((n) => n.path),
    notes: found,
    known: !traversal.truncated,
    truncated: traversal.truncated,
    reasons: traversal.reasons,
    scanned: traversal.scanned,
  };
}

// ── The stored lookup ────────────────────────────────────────────────────────

/**
 * The trusted set, as a cheap synchronous KV read.
 *
 * ⚠ `known:false` means NOBODY HAS SCANNED, which is not the same fact as an
 * empty vault and must never be rendered as one. A caller filtering on the set
 * gets nothing either way; only this flag says whether that is an answer.
 */
function trustedPaths() {
  // ⚠ `db.setState`/`getState` are a RAW STRING store — they bind straight to
  // SQLite and do not serialise. Every caller keeping an object here does its
  // own JSON, and handing one an object throws "can only bind numbers, strings,
  // bigints, buffers, and null".
  let stored;
  try {
    const raw = db.getState(TRUST_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    // Unparseable is UNKNOWN, never an empty set: a corrupted row must not read
    // as "Nick has curated nothing".
    return { paths: new Set(), known: false, at: null, count: 0, why: 'trust set could not be read' };
  }

  if (!stored || !Array.isArray(stored.paths)) {
    return { paths: new Set(), known: false, at: null, count: 0, why: 'trust set has never been built' };
  }

  return {
    paths: new Set(stored.paths),
    known: true,
    at: stored.at || null,
    count: stored.paths.length,
    why: null,
  };
}

/** Rebuild the stored set from the vault. */
function refreshTrust() {
  const scan = scanTrusted();

  // ⚠ A partial walk is never stored. See scanTrusted.
  if (!scan.known) {
    return { stored: false, known: false, count: scan.paths.length, reasons: scan.reasons, notes: scan.notes };
  }

  const previous = trustedPaths();
  const changed = !previous.known
    || previous.count !== scan.paths.length
    || scan.paths.some((p) => !previous.paths.has(p));

  if (changed) {
    db.setState(TRUST_KEY, JSON.stringify({ paths: scan.paths, at: new Date().toISOString() }));
  }

  return { stored: true, known: true, changed, count: scan.paths.length, notes: scan.notes };
}

/**
 * One note changed — patch the set rather than re-walking the vault.
 *
 * The vault write hook fires per note, and a full walk there would read ~1,500
 * files every time Nick saves. A miss is corrected by the scheduled refresh, so
 * this is an optimisation and never the guarantee.
 *
 * ⚠ It refuses to patch a set that has never been built: one path added to an
 * absent set would present as a complete answer of size one.
 */
function noteChanged(relativePath) {
  const rel = normalisePath(relativePath);
  if (!rel.toLowerCase().endsWith('.md') || isIndexPath(rel)) return { changed: false };

  const current = trustedPaths();
  if (!current.known) return { changed: false, why: current.why };

  const full = path.join(VAULT_PATH(), rel);
  let trusted = false;
  if (fs.existsSync(full)) {
    if (trustedByLocation(rel)) {
      trusted = true;
    } else {
      try { trusted = trustedByFlag(obsidian.parseFrontmatter(readFrontmatterBlock(full))); }
      catch { return { changed: false, why: 'note could not be read' }; }
    }
  }

  const had = current.paths.has(rel);
  if (trusted === had) return { changed: false };

  if (trusted) current.paths.add(rel);
  else current.paths.delete(rel);

  db.setState(TRUST_KEY, JSON.stringify({ paths: [...current.paths].sort(), at: new Date().toISOString() }));
  return { changed: true, trusted };
}

// ── Marking, and the way back ────────────────────────────────────────────────

/**
 * Why a note cannot be marked. PURE apart from the existence check.
 *
 * ⚠ It refuses exactly what the knowledge index COULD NOT RETRIEVE ANYWAY —
 * `vault-exclusions`' embedding set, which is the generated output, the retired
 * folders, the templates and `Daily/`. The point is not tidiness: marking one of
 * those would write a flag into a note that no search can ever return, i.e. a
 * button that reports success and changes nothing.
 *
 * ⚠ `Personal/` is DELIBERATELY NOT refused. It is sensitive WORK material —
 * OH, disciplinary, GP — and `vault-exclusions` has already decided that it
 * stays in embeddings because "this is Nick's own brain and he must be able to
 * ask it about his own OH report". Refusing to trust it here would quietly
 * overrule that decision from a second place. It is REPORTED as sensitive on
 * the listing instead, which is a fact rather than a veto.
 */
function refusalFor(relativePath) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) return 'OBSIDIAN_VAULT_PATH is not configured';

  const rel = normalisePath(relativePath);
  if (!rel) return 'path required';
  if (!rel.toLowerCase().endsWith('.md')) return 'only markdown notes can be marked as knowledge';
  if (isIndexPath(rel)) return 'the Knowledge Index is generated by NEURO — it is a view of the set, not a member of it';
  if (!fs.existsSync(path.join(vault, rel))) return `note not found: ${rel}`;
  if (vaultExclusions.isExcludedPath(rel, { forEmbeddings: true })) {
    return `notes under ${rel.split('/')[0]}/ are not in the knowledge index, so marking this would have no effect`;
  }
  return null;
}

/**
 * Mark a note as curated knowledge, IN PLACE.
 *
 * ⚠ NOTHING IS COPIED, MOVED OR CREATED. The note stays exactly where Nick put
 * it; the only change is three frontmatter lines. That is the whole difference
 * from `knowledge-memory.promoteCandidate`, which writes a new file because a
 * recording genuinely needs distilling. See this module's header.
 *
 * ⚠ Already-trusted answers `already: true` and is a SUCCESS, not an error —
 * the same shape `rooms.accept` and the capture bridge use, because a repeated
 * press that reports failure reads as a broken control.
 *
 * ⚠ A note trusted BY LOCATION (under `Knowledge/`) is still stamped, so the
 * flag and the folder agree and a later move out of `Knowledge/` does not
 * silently un-trust it.
 */
function markTrusted({ path: relativePath, domain } = {}) {
  const refusal = refusalFor(relativePath);
  if (refusal) return { status: 'error', error: refusal };

  const rel = normalisePath(relativePath);
  const full = path.join(VAULT_PATH(), rel);
  const content = fs.readFileSync(full, 'utf-8');
  const fm = obsidian.parseFrontmatter(content);

  if (trustedByFlag(fm)) {
    return {
      status: 'ok', already: true, path: rel,
      domain: domainOf(rel, fm),
      markedAt: cleanQuoted(fm.knowledge_trusted_at) || null,
    };
  }

  const markedAt = new Date().toISOString();
  const finalDomain = String(domain || '').trim() || domainOf(rel, fm);

  let next = frontmatterEdit.upsertFrontmatterValue(content, 'knowledge_state', 'trusted');
  next = frontmatterEdit.upsertFrontmatterValue(next, 'knowledge_trusted_at', markedAt);
  next = frontmatterEdit.upsertFrontmatterValue(next, 'knowledge_domain', finalDomain);

  fs.writeFileSync(full, next, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(full, 'knowledge-trust'); } catch { /* never fails the mark */ }

  noteChanged(rel);
  return { status: 'ok', already: false, path: rel, domain: finalDomain, markedAt };
}

/**
 * Take it back.
 *
 * ⚠ NOT OPTIONAL. This is a judgement call about Nick's own note, and every
 * other decision in this codebase has an undo — `unmerge`, `restore`, `unlink`,
 * `forget`, `undismiss`. One without is a decision he cannot disagree with.
 *
 * ⚠⚠ A NOTE UNDER `Knowledge/` CANNOT BE UN-TRUSTED BY REMOVING THE FLAG, and
 * it says so rather than reporting success. It is trusted by LOCATION, so
 * stripping the frontmatter would leave it trusted, the button would appear to
 * work, and the note would go on being preferred in chat — the silent
 * half-success this codebase keeps removing. Moving it out of `Knowledge/` is
 * the way, and that is a decision about a file, not a toggle.
 */
function unmarkTrusted({ path: relativePath } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH is not configured' };

  const rel = normalisePath(relativePath);
  if (!rel) return { status: 'error', error: 'path required' };

  const full = path.join(vault, rel);
  if (!fs.existsSync(full)) return { status: 'error', error: `note not found: ${rel}` };

  if (trustedByLocation(rel)) {
    return {
      status: 'error',
      error: `${rel} is trusted because it sits under ${KNOWLEDGE_ROOT}/. Move it out of that folder to un-trust it — removing the flag alone would leave it trusted.`,
      trustedBy: 'location',
    };
  }

  const content = fs.readFileSync(full, 'utf-8');
  if (!trustedByFlag(obsidian.parseFrontmatter(content))) {
    return { status: 'ok', already: true, path: rel };
  }

  // ⚠ Removing the LINES, never blanking them — `knowledge_state: ""` reads as
  // present to anything testing presence.
  let next = frontmatterEdit.removeFrontmatterKey(content, 'knowledge_state');
  next = frontmatterEdit.removeFrontmatterKey(next, 'knowledge_trusted_at');

  fs.writeFileSync(full, next, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(full, 'knowledge-trust'); } catch { /* never fails the unmark */ }

  noteChanged(rel);
  return { status: 'ok', already: false, path: rel };
}

// ── The generated index ──────────────────────────────────────────────────────

/**
 * Render the index body. PURE — takes notes, returns markdown.
 *
 * Links only. ⚠ It must never carry the notes' CONTENT: a page reproducing
 * fifty notes is the duplication this whole module exists to avoid, and it
 * would be the copy that goes stale.
 */
function renderIndexBody(notes, now) {
  const stamp = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  const lines = [
    INDEX_OPEN,
    '',
    `*Generated by NEURO on ${stamp}. Anything between the markers is overwritten —*`,
    '*edit the notes themselves, not this page. Marking a note is a frontmatter*',
    '*line (`knowledge_state: trusted`), so this page holds links and nothing else.*',
    '',
  ];

  if (!notes.length) {
    lines.push('Nothing is marked as knowledge yet.', '');
  } else {
    const byDomain = new Map();
    for (const note of notes) {
      const key = note.domain || 'General';
      if (!byDomain.has(key)) byDomain.set(key, []);
      byDomain.get(key).push(note);
    }

    lines.push(`**${notes.length}** note${notes.length === 1 ? '' : 's'} across **${byDomain.size}** domain${byDomain.size === 1 ? '' : 's'}.`, '');

    for (const domain of [...byDomain.keys()].sort((a, b) => a.localeCompare(b))) {
      lines.push(`## ${domain}`, '');
      const group = byDomain.get(domain).sort((a, b) => a.title.localeCompare(b.title));
      for (const note of group) {
        // ⚠ The link carries the note's FULL PATH so it resolves wherever the
        // note lives — these titles are not unique and several are dated
        // meeting names. The suffix is the FOLDER, never the path again: with
        // the path on both sides a single entry ran to 300 characters and the
        // page became unreadable, which for a page whose only job is being read
        // is the whole of it failing.
        const where = note.by === 'location'
          ? 'distilled from a recording'
          : (note.folder || 'the vault root');
        lines.push(`- [[${note.path.replace(/\.md$/i, '')}|${note.title}]] — ${where}`);
      }
      lines.push('');
    }
  }

  lines.push(INDEX_CLOSE);
  return lines.join('\n');
}

const INDEX_SCAFFOLD = [
  '---',
  'title: Knowledge Index',
  'type: index',
  'generated_by: neuro-knowledge-trust',
  '---',
  '',
  '# Knowledge Index',
  '',
  '__BODY__',
  '',
  '## Notes',
  '',
  '*This section is yours — NEURO never touches anything outside the markers above.*',
  '',
].join('\n');

/**
 * Write the index, surgically between its markers.
 *
 * ⚠ SURGICAL, like `vault-hygiene` and the 1-2-1 tracker: everything outside
 * the markers is Nick's and survives. A whole-file rewrite would eat anything
 * he added to the page, which is the fastest way to make a generated note into
 * something he stops trusting.
 *
 * ⚠ AN UNCHANGED RENDER WRITES NOTHING and returns `changed:false`. Touching
 * the file every pass moves its mtime into every recent-notes scan — the #78
 * lesson, where one automation's bulk restamp triggered another's flood.
 */
function renderIndex({ apply = true, notes = null, now = new Date() } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH is not configured' };
  }

  let list = notes;
  if (!list) {
    const scan = scanTrusted();
    // ⚠ A partial walk never renders. An index missing whatever the walk could
    // not reach is indistinguishable from one where Nick un-marked those notes.
    if (!scan.known) {
      return { status: 'error', error: 'the vault could not be read in full', reasons: scan.reasons };
    }
    list = scan.notes;
  }

  const body = renderIndexBody(list, now);
  const full = path.join(vault, INDEX_PATH);

  let next;
  if (fs.existsSync(full)) {
    const current = fs.readFileSync(full, 'utf-8');
    const openIdx = current.indexOf(INDEX_OPEN);
    const closeIdx = current.indexOf(INDEX_CLOSE);
    if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
      // The markers are gone. Append rather than overwrite — the page has
      // content we did not write and cannot safely replace.
      next = `${current.replace(/\s*$/, '')}\n\n${body}\n`;
    } else {
      next = current.slice(0, openIdx) + body + current.slice(closeIdx + INDEX_CLOSE.length);
    }
    if (next === current) {
      return { status: 'ok', changed: false, path: INDEX_PATH, count: list.length };
    }
  } else {
    next = INDEX_SCAFFOLD.replace('__BODY__', body);
  }

  if (!apply) {
    return { status: 'ok', changed: true, dryRun: true, path: INDEX_PATH, count: list.length, preview: body };
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, next, 'utf-8');
  return { status: 'ok', changed: true, path: INDEX_PATH, count: list.length };
}

/**
 * Everything trusted, for a screen.
 *
 * ⚠ Reads the VAULT rather than the stored set, because this is the surface
 * where Nick checks what he has marked and a stale cache rendered there is a
 * wrong answer to the one question being asked. The set is for the search path,
 * where cheapness is the point.
 */
function listTrusted() {
  const scan = scanTrusted();
  return {
    known: scan.known,
    reasons: scan.reasons,
    count: scan.notes.length,
    notes: scan.notes.map((n) => ({
      ...n,
      sensitive: vaultExclusions.isSensitivePath(n.path),
    })),
  };
}

module.exports = {
  TRUST_KEY,
  KNOWLEDGE_ROOT,
  INDEX_PATH,
  INDEX_OPEN,
  INDEX_CLOSE,
  TRUST_STATES,
  FRONTMATTER_BUDGET,
  cleanQuoted,
  normalisePath,
  isIndexPath,
  trustedByLocation,
  trustedByFlag,
  isTrustedNote,
  domainOf,
  readFrontmatterBlock,
  describeTrusted,
  scanTrusted,
  trustedPaths,
  refreshTrust,
  noteChanged,
  refusalFor,
  markTrusted,
  unmarkTrusted,
  renderIndexBody,
  renderIndex,
  listTrusted,
};
