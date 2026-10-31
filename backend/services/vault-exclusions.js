'use strict';

// One exclude list, because there were at least three and they disagreed.
//
// `embeddings.js` skipped Daily/Scripts/Templates/Imports and NOT Archive, so
// 24% of the retrieval index was bin: 709 Archive files, 43 _toDelete, and 128
// chunks of NEURO's own generated reports — the system indexing its own logs.
// `entities.js` skipped even less, which is why Hope's person page ranked
// `Master Todo`, `NEURO Tasks (export)` and a `.backup-` copy of a MoSCoW
// worksheet above the meetings that are the actual point.
//
// Two separate ideas, deliberately kept apart:
//   GENERATED  — output NEURO itself wrote. Always noise to read back; a system
//                that indexes its own reports starts citing them as sources.
//   RETIRED    — content deliberately put out of the way (Archive, _toDelete).
//                Excluded from indexing, but a linker resolving link TARGETS
//                still needs to see it (see #81) — hence the separate export.

// Directories that are never content, wherever they appear in the tree.
const INFRA_DIRS = [
  '.obsidian', '.git', '.trash', '.stfolder', '.stversions', '.sync', '.claude',
  'node_modules', '.lint-backups',
];

// NEURO's own output. Indexing this is the system talking to itself.
const GENERATED_DIRS = [
  'Vault Audit',
  'SAiM Import Reports',
  // ⚠ The pre-rename folder, and it is NOT dead weight. Reports written before
  // 15 Sep 2026 are still sitting in the vault under the old name; drop this
  // line and every one of them starts being indexed into embeddings and entity
  // extraction — the system reading its own output back as content, which is
  // exactly what this list exists to prevent. Remove only once the folder is.
  'SARA Import Reports',
  'Exports',
];

// Deliberately retired content.
const RETIRED_DIRS = [
  'Archive',
  '_toDelete',
  '_Staging',
];

// Working areas that are not notes of record.
const TRANSIENT_DIRS = [
  'Scripts',
  'Templates',
  'Imports',
];

// ── Security review: notes holding credentials ───────────────────────────────
//
// 22 Oct 2026: the vault triage found plain-text passwords, a PAT and API
// secrets in seven notes, and Nick moved them into `Security review/` pending
// rotation. NOTHING here may be read by NEURO at all: not
// embedded (chat RAG and search_vault would quote the secret), not entity-
// extracted, not readable through /api/vault or the chat `read_note` tool, never
// quoted by a vault-hygiene report (the contextual linking plan had copied the
// start of one secret into every weekly plan). Task-context, Notion sync and
// knowledge-trust refuse it too.
// ⚠ Fails CLOSED by name: rename the folder and the env var must follow.
const SECURITY_DIRS = (process.env.VAULT_SECURITY_DIRS || 'Security review')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ── Personal life ────────────────────────────────────────────────────────────
//
// Home life. DEFAULT EMPTY, on purpose: there is no folder in this vault that
// is unambiguously home life (`Personal/` holds work material). Guessing would
// silently change what the index holds and what the person graph learns, which
// is exactly the class of change that should be a decision.
//
// Set VAULT_PERSONAL_DIRS once such a folder exists. Excluded from entity
// extraction (family names must not enter a roster that feeds team-health, the
// 1-2-1 tracker and people-gap) and KEPT in embeddings, because "when is the
// car booked in" is precisely what a second brain is for.
const PERSONAL_DIRS = (process.env.VAULT_PERSONAL_DIRS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Generated FILES, matched on basename. The task export and the superseded
// MoSCoW worksheets name every person and every project, so they outrank real
// notes on any "who is mentioned where" query while saying nothing.
const GENERATED_FILE_PATTERNS = [
  /^NEURO Tasks \(export\)\.md$/i,
  /^Master Todo\.md$/i,
  /^MoSCoW - Open Actions.*\.md$/i,
  // The 1-2-1 tracker became generated in #31. Measured before adding it: it
  // was already holding 37 extracted_entities rows (16 person, 18 mention) and
  // 3 embedding chunks — a table naming all 13 reports outranks their actual
  // meetings on any "who is mentioned where" query while saying nothing, which
  // is exactly what #34 removed for the MoSCoW worksheets.
  /^1-2-1 Tracker\.md$/i,
  // The Knowledge Index is rendered by knowledge-trust.js and is links only.
  // Indexed, it would match every query about any of the notes it lists and
  // hand back a page of titles — the 1-2-1 tracker failure above, with a
  // bigger blast radius because these are the notes chat is told to PREFER.
  /^Knowledge Index\.md$/i,
  /\.backup-/i,
  /\.sync-conflict-/i,
];

// The shared base: never content, for any consumer.
const INDEX_EXCLUDED_DIRS = new Set([
  ...INFRA_DIRS, ...GENERATED_DIRS, ...RETIRED_DIRS, ...TRANSIENT_DIRS, ...SECURITY_DIRS,
]);

// Entity extraction: the base, plus home-life folders (none by default) — family
// names do not belong in the roster that feeds team-health and the 1-2-1 tracker.
// `Personal/` (work material) IS extracted (31 Oct 2026: no HR restrictions).
const ENTITY_EXCLUDED_DIRS = new Set([
  ...INDEX_EXCLUDED_DIRS, ...PERSONAL_DIRS,
]);

// Embeddings: the base, plus `Daily/` — a daily note is a scratchpad and there
// are hundreds of them.
const EMBEDDING_EXCLUDED_DIRS = new Set([...INDEX_EXCLUDED_DIRS, 'Daily']);

/** Should this directory NAME be walked into? */
function isExcludedDir(name, { forEmbeddings = false } = {}) {
  if (!name) return false;
  if (SECURITY_DIRS.some((d) => d.toLowerCase() === String(name).toLowerCase())) return true;
  const set = forEmbeddings ? EMBEDDING_EXCLUDED_DIRS : ENTITY_EXCLUDED_DIRS;
  return set.has(name);
}

/** Does any segment of this path name one of `dirs`? */
function _underAny(relativePath, dirs) {
  if (!relativePath || !dirs.length) return false;
  const parts = String(relativePath).replace(/\\/g, '/').split('/');
  return parts.slice(0, -1).some((seg) => dirs.includes(seg));
}

/**
 * A note under a security-review folder: never read, quoted or indexed by NEURO.
 * Case-insensitive, and a top-level FOLDER of that name counts even when the
 * path names the folder itself (listing it).
 */
function isSecurityPath(relativePath) {
  if (!relativePath) return false;
  const parts = String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean);
  const names = SECURITY_DIRS.map((d) => d.toLowerCase());
  return parts.some((seg) => names.includes(seg.toLowerCase()));
}

/** Home life, as opposed to work. Empty by default — see PERSONAL_DIRS. */
function isPersonalPath(relativePath) {
  return _underAny(relativePath, PERSONAL_DIRS);
}

/**
 * Which part of Nick's life a note belongs to.
 *
 * Frontmatter WINS over the path, because a single note can legitimately sit in
 * the wrong folder and it is the only way to mark one before a folder exists.
 * Anything unmarked is work — the same asymmetry `shared/task-domain.cjs`
 * argues: a personal note mis-read as work is visible, the reverse is silent.
 */
function noteDomain(relativePath, frontmatter) {
  const declared = frontmatter && String(frontmatter.domain || '').trim().toLowerCase();
  if (declared === 'personal' || declared === 'work') return declared;
  return isPersonalPath(relativePath) ? 'personal' : 'work';
}

/** Is this vault-relative path excluded — by any segment, or by filename? */
function isExcludedPath(relativePath, options = {}) {
  if (!relativePath) return true;
  if (isSecurityPath(relativePath)) return true;
  const parts = String(relativePath).replace(/\\/g, '/').split('/');
  const file = parts[parts.length - 1];
  for (const seg of parts.slice(0, -1)) {
    if (isExcludedDir(seg, options)) return true;
  }
  return GENERATED_FILE_PATTERNS.some(re => re.test(file));
}

module.exports = {
  INFRA_DIRS,
  GENERATED_DIRS,
  RETIRED_DIRS,
  TRANSIENT_DIRS,
  SECURITY_DIRS,
  PERSONAL_DIRS,
  GENERATED_FILE_PATTERNS,
  INDEX_EXCLUDED_DIRS,
  ENTITY_EXCLUDED_DIRS,
  EMBEDDING_EXCLUDED_DIRS,
  isExcludedDir,
  isExcludedPath,
  isSecurityPath,
  isPersonalPath,
  noteDomain,
};
