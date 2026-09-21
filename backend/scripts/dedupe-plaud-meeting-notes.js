#!/usr/bin/env node
'use strict';

/**
 * Archive the redundant PLAUD summary copies, keeping the best one per recording.
 *
 * RUN THIS ONLY AFTER the two guards of 21 Sep 2026 are deployed
 * (`readMarkdownFiles` skipping RETIRED_DIRS, and `routePlaudSummary` refusing an
 * archived note). Before them, archiving a duplicate is what CREATED the next
 * one: the archived copy stayed a write target, got rewritten, and was routed
 * straight back into Meetings/ as "<title> 2.md". Cleaning up first would simply
 * have refilled.
 *
 * NOTHING IS DELETED. Copies are MOVED to Archive/, which is reversible.
 *
 * IT MUST NOT EAT NICK'S LAYERED SUMMARIES. His workflow is to transcribe, then
 * add a 1-2-1 or Return-to-Work AI summary, and sometimes a concise todo summary
 * days later. Those are genuinely different documents and are KEPT. Measured over
 * the live vault the two populations separate cleanly: real layers sit at
 * 0.49-0.62 similarity, redundant copies at 0.98-1.00, and the band 0.70-0.90 is
 * EMPTY. Anything in between is REPORTED and never touched.
 *
 * Dry run by default. Pass --apply.
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
};
const VAULT = argOf('--vault') || process.env.OBSIDIAN_VAULT_PATH || '';

// Above this, two notes are the same summary written twice.
const DUPLICATE_AT = 0.95;
// Below this, they are different documents - Nick's layered summaries.
const VARIANT_BELOW = 0.70;

// Sections the enrichment pipeline APPENDS. Not part of what PLAUD wrote, and
// counting them is what made an earlier pass mistake enrichment for a variant.
const ENRICHMENT_HEADINGS = [
  '## SAiM Insight', '## SARA Insight', '## SAiM Actions', '## SARA Actions',
  '## Related', '## Action Items', '## Backlinks', '## Links',
  '<!-- ctx-links -->', '<!-- hub-link -->',
];

const RETIRED_DIRS = ['Archive', '_toDelete', '_Staging'];

function fail(message) {
  console.error('REFUSED: ' + message);
  process.exit(1);
}

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (RETIRED_DIRS.includes(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function frontmatterValue(content, key) {
  const line = content.split('\n').find((l) => l.startsWith(key + ':'));
  if (!line) return null;
  const value = line.slice(key.length + 1).trim().replace(/^"/, '').replace(/"$/, '');
  return value || null;
}

function canonicalId(raw) {
  if (!raw) return null;
  const id = String(raw).trim();
  return id.startsWith('of_') ? id.slice(3) : id;
}

/** The PLAUD summary text alone, with enrichment and per-copy noise removed. */
function summaryText(content) {
  const at = content.indexOf('\n## Summary');
  if (at === -1) return null;
  let body = content.slice(at);
  for (const heading of ENRICHMENT_HEADINGS) {
    const cut = body.indexOf(heading);
    if (cut !== -1) body = body.slice(0, cut);
  }
  return body
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('- Device:') || t.startsWith('- Plaud ID:') || t.startsWith('- Transcript:'));
    })
    .join(' ')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase();
}

function shingles(text) {
  const words = text.split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 2 < words.length; i++) {
    set.add(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
  }
  return set;
}

function similarity(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const s of a) if (b.has(s)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Which copy to KEEP.
 *
 * The re-pulled twin is reliably the WORSE one - it loses the `people:` links,
 * the `serial_number` and the device id, because those are added by enrichment
 * after the original was written. Referenced-by-NEURO wins first though: a task
 * or an embedding pointing at a path is a link that breaks if that copy moves.
 */
function richness(note, referenced) {
  let score = 0;
  if (referenced.has(note.relative)) score += 100;
  score += note.peopleCount * 10;
  if (note.serial) score += 5;
  if (note.hasEnrichment) score += 5;
  // A plain name beats "<title> 2.md" when nothing else separates them.
  if (!/ \d+\.md$/.test(note.relative)) score += 3;
  score += Math.min(2, note.bytes / 100000);
  return score;
}

function main() {
  if (!VAULT) fail('no vault path. Set OBSIDIAN_VAULT_PATH or pass --vault.');
  if (!fs.existsSync(VAULT)) fail('vault path does not exist: ' + VAULT);
  const meetings = path.join(VAULT, 'Meetings');
  if (!fs.existsSync(meetings)) fail('no Meetings/ folder under ' + VAULT);

  const referenced = new Set();
  const refFile = argOf('--referenced');
  if (refFile && fs.existsSync(refFile)) {
    for (const line of fs.readFileSync(refFile, 'utf-8').split('\n')) {
      const t = line.trim();
      if (t) referenced.add(t);
    }
  }
  console.log('vault      : ' + VAULT);
  console.log('referenced : ' + referenced.size + ' paths NEURO points at');

  const files = walk(meetings, []);
  if (!files.length) fail('Meetings/ is empty - refusing rather than reporting a clean vault.');

  const byRecording = new Map();
  for (const full of files) {
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      // An unreadable note is NOT evidence of anything. Refuse the whole run
      // rather than silently treating it as absent and archiving its twin.
      fail('could not read ' + full);
    }
    const id = canonicalId(frontmatterValue(content, 'plaud_id'));
    if (!id) continue;
    const relative = path.relative(VAULT, full).split(path.sep).join('/');
    const text = summaryText(content);
    if (!byRecording.has(id)) byRecording.set(id, []);
    byRecording.get(id).push({
      full,
      relative,
      text,
      sh: text ? shingles(text) : null,
      peopleCount: (content.match(/\[\[People\//g) || []).length,
      serial: Boolean(frontmatterValue(content, 'serial_number')),
      hasEnrichment: ENRICHMENT_HEADINGS.some((h) => content.includes(h)),
      bytes: content.length,
    });
  }

  const duplicates = [];
  const variants = [];
  const borderline = [];
  const uncomparable = [];

  for (const [id, notes] of byRecording) {
    if (notes.length < 2) continue;
    const usable = notes.filter((n) => n.text && n.text.length > 40);
    if (usable.length < 2) {
      uncomparable.push([id, notes]);
      continue;
    }
    const keeper = usable.slice().sort((a, b) => richness(b, referenced) - richness(a, referenced))[0];
    for (const other of usable) {
      if (other === keeper) continue;
      const score = similarity(keeper.sh, other.sh);
      const row = { id, score, keep: keeper, drop: other };
      if (score >= DUPLICATE_AT) duplicates.push(row);
      else if (score < VARIANT_BELOW) variants.push(row);
      else borderline.push(row);
    }
  }

  const multi = [...byRecording.values()].filter((v) => v.length > 1).length;
  console.log('');
  console.log('recordings with more than one note : ' + multi);
  console.log('  redundant copies to archive      : ' + duplicates.length);
  console.log('  YOUR layered summaries (kept)    : ' + variants.length);
  console.log('  borderline - NOT touched         : ' + borderline.length);
  console.log('  could not compare (no summary)   : ' + uncomparable.length);

  if (variants.length) {
    console.log('');
    console.log('--- KEPT: genuinely different summaries ---');
    for (const v of variants.sort((a, b) => a.score - b.score)) {
      console.log('  sim=' + v.score.toFixed(3) + '  ' + path.basename(v.drop.relative));
    }
  }
  if (borderline.length) {
    console.log('');
    console.log('--- NOT TOUCHED: needs your eye ---');
    for (const b of borderline.sort((a, c) => a.score - c.score)) {
      console.log('  sim=' + b.score.toFixed(3) + '  ' + path.basename(b.drop.relative));
      console.log('        keeper: ' + path.basename(b.keep.relative));
    }
  }
  if (uncomparable.length) {
    console.log('');
    console.log('--- could not compare, left alone ---');
    for (const [id, notes] of uncomparable) {
      console.log('  ' + id + ' (' + notes.length + ' notes)');
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const archiveDir = 'Archive/Plaud duplicate summaries ' + stamp;
  console.log('');
  console.log('--- WOULD ARCHIVE to ' + archiveDir + '/ ---');
  let refMoves = 0;
  for (const d of duplicates.sort((a, b) => a.drop.relative.localeCompare(b.drop.relative))) {
    const flag = referenced.has(d.drop.relative) ? '  [REFERENCED]' : '';
    if (flag) refMoves++;
    console.log('  ' + d.score.toFixed(3) + '  ' + path.basename(d.drop.relative) + flag);
  }
  console.log('');
  console.log('  keepers that NEURO references : ' +
    duplicates.filter((d) => referenced.has(d.keep.relative)).length + ' of ' + duplicates.length);
  console.log('  copies being moved that are referenced : ' + refMoves);

  if (!APPLY) {
    console.log('');
    console.log('DRY RUN - nothing moved. Re-run with --apply.');
    return;
  }

  const destRoot = path.join(VAULT, archiveDir);
  fs.mkdirSync(destRoot, { recursive: true });
  let moved = 0;
  const log = [];
  for (const d of duplicates) {
    // Flatten the path into the name so two notes from different months cannot
    // collide inside one archive folder.
    const flat = d.drop.relative.split('/').join(' - ');
    const dest = path.join(destRoot, flat);
    if (fs.existsSync(dest)) {
      console.warn('  skipped, already archived: ' + flat);
      continue;
    }
    fs.renameSync(d.drop.full, dest);
    log.push('- `' + d.drop.relative + '` -> `' + flat + '` (sim ' + d.score.toFixed(3) +
      ', kept `' + d.keep.relative + '`)');
    moved++;
  }
  fs.writeFileSync(path.join(destRoot, '_about.md'), [
    '---',
    'type: note',
    'status: archived',
    '---',
    '',
    '# Archived PLAUD duplicate summaries (' + stamp + ')',
    '',
    'Redundant copies of a PLAUD summary already present in `Meetings/`.',
    'Nothing here was deleted - move a file back if this got one wrong.',
    '',
    'Safe to archive only because plaud-sync no longer treats an archived note as a',
    'write target, and `routePlaudSummary` refuses to move one back out (21 Sep 2026).',
    'Before those guards, archiving a duplicate is what created the next one.',
    '',
    ...log,
  ].join('\n'), 'utf-8');
  console.log('');
  console.log('  archived: ' + moved);
  console.log('  log     : ' + archiveDir + '/_about.md');
}

main();
