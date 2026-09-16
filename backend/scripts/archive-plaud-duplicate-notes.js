#!/usr/bin/env node
'use strict';

/**
 * Archive the duplicate notes a re-pull created when PLAUD's id format changed.
 *
 * ⚠ IDENTIFIED BY plaud_id, NOT BY THE FILENAME. A `" 2.md"` suffix is a symptom, not
 * evidence — Nick is free to name a note that way. A file is only a duplicate here when
 * a twin exists at the same path without the suffix AND both notes' `plaud_id` values
 * canonicalise to the SAME recording. Anything that fails either test is left alone and
 * reported, because the expensive mistake in this direction is archiving a real meeting.
 *
 * ⚠ MOVE TO Archive/, NEVER DELETE. Archive is excluded from the candidate scan and
 * from embeddings, so archiving is what stops the note being read as content — and a
 * link INTO Archive is not a broken link (16 Aug 2026). The duplicate is also the WORSE
 * copy: the re-pulled twin lost its `people:` list and `serial_number`.
 *
 * ⚠ RUN THIS ON THE WINDOWS VAULT, which is canonical. Syncthing carries it to the Pi.
 *
 * Dry run by default.
 */

const fs = require('fs');
const path = require('path');
const { canonicalPlaudId } = require(path.join(__dirname, '..', '..', 'shared', 'plaud-id.cjs'));

const VAULT = process.env.OBSIDIAN_VAULT_PATH || '';
const apply = process.argv.includes('--apply');
const ARCHIVE_DIR = 'Archive/Plaud duplicates (id format change 2026-09-15)';

if (!VAULT || !path.isAbsolute(VAULT)) {
  console.error('[archive-dupes] OBSIDIAN_VAULT_PATH must be set to an absolute path. REFUSING — a relative path writes into the repo.');
  process.exit(1);
}
if (!fs.existsSync(VAULT) || !fs.statSync(VAULT).isDirectory()) {
  console.error(`[archive-dupes] Vault not readable at ${VAULT}. REFUSING rather than reading an empty vault as "no duplicates".`);
  process.exit(1);
}

// No regex: this file is written through a shell heredoc, which eats backslashes.
function toPosix(p) { return p.split(path.sep).join('/'); }

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^(Archive|_toDelete|\.stversions)$/i.test(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// No regex for the lookup: this file reaches disk through a shell heredoc, which eats
// backslashes, and a half-eaten escape here parses ALMOST correctly - which is worse
// than failing. Plain string work cannot be mangled.
function frontmatterValue(content, key) {
  const NL = String.fromCharCode(10);
  if (!content.startsWith('---')) return null;
  const close = content.indexOf(NL + '---', 3);
  if (close === -1) return null;
  for (const line of content.slice(3, close).split(NL)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key + ':')) continue;
    let value = trimmed.slice(key.length + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
    return value;
  }
  return null;
}

const files = walk(VAULT);
const duplicates = [];
const rejected = [];

for (const file of files) {
  const base = path.basename(file, '.md');
  if (!/ 2$/.test(base)) continue;

  const twin = path.join(path.dirname(file), `${base.replace(/ 2$/, '')}.md`);
  if (!fs.existsSync(twin)) {
    rejected.push({ file: path.relative(VAULT, file), why: 'no twin without the suffix — this is a real note' });
    continue;
  }

  let dupId, twinId;
  try {
    dupId = canonicalPlaudId(frontmatterValue(fs.readFileSync(file, 'utf-8'), 'plaud_id'));
    twinId = canonicalPlaudId(frontmatterValue(fs.readFileSync(twin, 'utf-8'), 'plaud_id'));
  } catch (error) {
    rejected.push({ file: path.relative(VAULT, file), why: `unreadable (${error.message})` });
    continue;
  }

  if (!dupId || !twinId) {
    rejected.push({ file: path.relative(VAULT, file), why: 'one of the pair carries no plaud_id — cannot prove they are the same recording' });
    continue;
  }
  if (dupId !== twinId) {
    rejected.push({ file: path.relative(VAULT, file), why: `different recordings (${dupId} vs ${twinId})` });
    continue;
  }

  duplicates.push({ file, relative: toPosix(path.relative(VAULT, file)), twin: toPosix(path.relative(VAULT, twin)), id: dupId });
}

console.log(`Vault: ${VAULT}`);
console.log(`Scanned ${files.length} notes. Duplicates confirmed by plaud_id: ${duplicates.length}. Left alone: ${rejected.length}.`);
if (rejected.length) {
  console.log('\nNOT archived (each is a decision, not an oversight):');
  console.table(rejected.slice(0, 20));
}
console.log('\nFirst 10 to archive:');
console.table(duplicates.slice(0, 10).map((d) => ({ duplicate: d.relative.slice(-70), keeping: d.twin.slice(-70) })));

if (!apply) {
  console.log('\nDRY RUN — nothing moved. Re-run with --apply.');
  process.exit(0);
}

const target = path.join(VAULT, ARCHIVE_DIR);
fs.mkdirSync(target, { recursive: true });

let moved = 0;
const failures = [];
for (const dup of duplicates) {
  // Flatten into one archive folder, keeping the full original path in the name so the
  // move is reversible by reading the filename alone.
  const flat = dup.relative.split('/').join(' — ');
  const dest = path.join(target, flat);
  try {
    if (fs.existsSync(dest)) { failures.push({ file: dup.relative, why: 'already archived' }); continue; }
    fs.renameSync(dup.file, dest);
    moved += 1;
  } catch (error) {
    failures.push({ file: dup.relative, why: error.message });
  }
}

fs.writeFileSync(path.join(target, '_about.md'),
  `---\ntype: archive-note\n---\n\n# PLAUD duplicate notes — 15 Sep 2026\n\n` +
  `PLAUD changed its recording id format to an \`of_\` prefix. The sync ledger and the ` +
  `existing-note index are both keyed on that id, so every recording read as never ` +
  `synced and ${moved} notes were re-downloaded beside notes already in the vault.\n\n` +
  `These are the re-pulled COPIES. The originals are still in place and are the better ` +
  `copy — the twins lost their \`people:\` list and \`serial_number\`. Each filename here ` +
  `is the note's original path with \` — \` for each folder separator.\n\n` +
  `Archived ${new Date().toISOString().slice(0, 10)} by backend/scripts/archive-plaud-duplicate-notes.js\n`);

console.log(`\nArchived ${moved} notes to ${ARCHIVE_DIR}`);
if (failures.length) { console.log('Failures:'); console.table(failures); }
