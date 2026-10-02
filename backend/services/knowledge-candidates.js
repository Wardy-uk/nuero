'use strict';

/**
 * NOTES NICK WROTE THAT LOOK LIKE KNOWLEDGE — the other half of the queue.
 *
 * ── Why this is separate from knowledge-memory's promotion queue ────────────
 * That queue reads `RAW_FOLDERS` — Plaud, Meetings, Imports, Daily — and asks
 * "is there something durable buried in this recording?". Its scorer is built
 * for PLAUD shape: `note_type: summary` (+6), a `plaud` source (+2), and
 * `promotionSignal` parsing `## Meeting Notes` and `Topic Title:` lines. Hand a
 * Projects note to it and `promotionSignal` returns null, so it scores ~4
 * against a summary's 11–19 and sits at the bottom for ever.
 *
 * This asks a different question of different folders: "Nick already wrote this
 * up — is it worth trusting?". There is nothing to distil, so the answer is a
 * flag rather than a new file (see `knowledge-trust.js`).
 *
 * ── The pattern is deliberately `action-candidates`', with one change ───────
 * Nick's point, and it is the right one: NEURO already finds possible TASKS in
 * notes and offers them for review. That machinery is proven and is reused in
 * spirit — a scan, a review, a remembered decision.
 *
 * ⚠⚠ BUT NOTHING HERE CREATES A ROW. `action-candidates` writes pending actions
 * and needed `maxCreate` after **911 candidates landed in one night** on 14 Aug
 * when a bulk restamp moved every mtime into its window. These candidates are
 * COMPUTED ON READ from the vault, exactly as `rankPromotionCandidates` is, so
 * there is no queue to flood: nothing is persisted, and turning the feature off
 * leaves nothing behind. That dissolves the failure mode rather than bounding
 * it.
 *
 * ⚠ AND IT LOOKS WHERE THE TASK SCANNER DELIBERATELY DOES NOT. `Projects/` is
 * on `action-candidates.shouldSkipPath` with a measurement beside it: *1,038
 * checkboxes under Projects/ produced ZERO attributable to Nick*. That is
 * evidence about TASKS and does not transfer — a Projects note is where he
 * records what he worked out, not what he owes. A folder full of thinking with
 * no commitments in it is precisely what this wants and that one does not.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 * ⚠ NO MODEL CALL. Deterministic, free, identical every run, works with the Pi
 * offline — `event-parser`'s regex-first rule. Everything it scores was already
 * in the note.
 * ⚠ IT PROPOSES AND NEVER MARKS. `knowledge-trust.markTrusted` has one caller
 * and it is an explicit press.
 * ⚠ A DISMISSAL IS THE EXISTING ONE. `knowledge_dismissed` in the note's own
 * frontmatter, the key `knowledge-memory.dismissCandidate` already writes, for
 * the reason that file gives: the vault outlives any NEURO database and a
 * dismissal kept in `agent_state` comes back after a restore. "This is not
 * knowledge" means one thing, so it is one key — a second would let a note be
 * dismissed on one screen and offered on the other.
 *
 * CommonJS. `scoreNote` and `assess` are PURE.
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');
const vaultWalk = require('./vault-walk');
const vaultExclusions = require('./vault-exclusions');
const knowledgeTrust = require('./knowledge-trust');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

/**
 * Where Nick's own written-up thinking lives.
 *
 * ⚠ These are the folders `knowledge-memory.RAW_FOLDERS` does not read and
 * `action-candidates.shouldSkipPath` refuses. The overlap is empty by design:
 * a note is raw material, or a commitment source, or already written up.
 */
const CANDIDATE_FOLDERS = ['Projects', 'Areas', 'Decision Log', 'Ideas', 'MOCs', 'Documents'];

/** Below this a note is a stub or a link dump, not a write-up. */
const MIN_WORDS = 120;

/**
 * Folder descriptions, not knowledge.
 *
 * ⚠ Caught by the measurement, not by reading: `Projects/_about.md` is 177
 * words and scored 7 on FIFTEEN inbound links — a structural file ranking
 * above real write-ups purely because everything in the folder points at it.
 * `vault-hygiene` already treats `[[_about]]` as broken by construction; the
 * same file must not be offered as something to trust.
 */
const STRUCTURAL_FILES = new Set(['_about.md', 'index.md', 'readme.md']);

/**
 * The bar. ⚠⚠ MEASURED ON THE LIVE VAULT, AND MEASURED TWICE.
 *
 * 451 notes in the candidate folders, 49 of them stubs:
 *
 *     score  2:  3     6: 114
 *     score  3:  8     7:  59
 *     score  4: 46     8:  38
 *     score  5:101     9:  24
 *                     10:   9
 *
 * ⚠ The first cut was 6 and is WRONG: 5 and 6 hold 215 of the 402 real notes —
 * the same undifferentiated middle the promotion scorer had when 189 of 243
 * summaries tied on 11 — so a bar of 6 offers 244 notes, i.e. over half the
 * folder, ordered by nothing much. A queue that size is the pile it replaces.
 *
 * ⚠⚠ AND THE FIRST MEASUREMENT WAS TAKEN WITH THE TAG ARM DEAD. See
 * `readTags` — 164 notes tag in frontmatter against 16 in the body, and the
 * original read only the body, so 90% of tagged notes scored untagged. Fixing
 * it moved 71 notes up a band and pulled real knowledge notes over the line
 * (`Documents/Reference/Where Everything Lives.md` among them). A threshold set
 * on a broken arm is a threshold set on noise, so it was re-measured after.
 *
 * ⚠ The bar was then set by READING THE OUTPUT, not by picking a percentile.
 * At 8 (71 notes) the list is the Support Improvement Plan, the VANTAGE
 * findings and tracker, the service-desk specs, the TOM work, the queue
 * analysis, the SOPs. At 7 it takes in 59 more and the signal weakens —
 * one-off ticket investigations and a dated session summary with nothing
 * linking to it. At 6 it reaches operational ephemera ("Bank Holiday Weekend
 * Plan"), which is a note, not knowledge.
 *
 * The product test is `while-here`'s: can Nick clear it in a sitting? 12 shown
 * at a time, and he can stop whenever — the ranking is what makes that safe.
 */
const MIN_SCORE = 8;

/** How many are offered at once. The rest are counted, never silently dropped. */
const MAX_CANDIDATES = 12;

/**
 * A note revisited over time has settled. Under this the gap is authoring, not
 * revisiting.
 */
const REVISIT_DAYS = 7;

/** Re-walking ~1,500 files per request is how a panel becomes the load. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache = null;

// ── Reading ──────────────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[^\]]*)?\]\]/g;

/** The link target as a bare note name, lowercased. PURE. */
function linkTarget(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  const base = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return base.replace(/\.md$/i, '').trim().toLowerCase();
}

function stripFrontmatter(text) {
  return String(text || '').replace(/^---[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * Every tag on a note, from the frontmatter AND the body.
 *
 * ⚠⚠ MEASURED, AND THE MEASUREMENT SAVED THE ARM. `obsidian.extractTags` reads
 * `#hashtags` out of the BODY and nothing else — and across the candidate
 * folders of the live vault **164 notes tag in frontmatter against 16 in the
 * body**, so the "tagged" arm was reading the wrong 10% and scoring 90% of
 * tagged notes as untagged. No error, no empty screen, just a plausible number
 * that was wrong — the `sleep_core_hours` / `summary_type` species, where a
 * field read by the wrong accessor returns nothing and the feature quietly
 * stops working.
 *
 * ⚠ BOTH YAML SHAPES ARE LIVE and only one survives `parseFrontmatter`, which
 * returns the raw string for `tags: [a, b]` and an EMPTY STRING for a block
 * list. So the block is read directly. Measured on the vault: 150-odd inline,
 * 11 block.
 *
 * PURE.
 */
function readTags(content) {
  const text = String(content || '');
  const out = new Set();

  for (const tag of obsidian.extractTags(text)) out.add(String(tag).toLowerCase());

  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    const block = end === -1 ? '' : text.slice(0, end);
    const lines = block.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^tags:/i.test(l));
    if (idx !== -1) {
      const inline = lines[idx].slice(lines[idx].indexOf(':') + 1).trim();
      if (inline) {
        inline.replace(/^\[|\]$/g, '')
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
          .forEach((v) => out.add(v.toLowerCase()));
      } else {
        // A block list: the indented "- value" lines that follow.
        for (let i = idx + 1; i < lines.length; i += 1) {
          const m = lines[i].match(/^\s+-\s*(.+?)\s*$/);
          if (!m) break;
          out.add(m[1].replace(/^["']|["']$/g, '').toLowerCase());
        }
      }
    }
  }

  return [...out];
}

/** Everything the score needs, read once. PURE given content. */
function measureNote(rel, content, stat) {
  const fm = obsidian.parseFrontmatter(content);
  const body = stripFrontmatter(content);

  const outbound = [...body.matchAll(WIKILINK_RE)].map((m) => linkTarget(m[1]));
  const headings = (body.match(/^#{1,6}\s+\S/gm) || []).length;
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  const created = stat && stat.birthtime ? stat.birthtime.getTime() : null;
  const modified = stat && stat.mtime ? stat.mtime.getTime() : null;

  return {
    path: knowledgeTrust.normalisePath(rel),
    name: path.basename(rel, '.md'),
    title: knowledgeTrust.cleanQuoted(fm.title) || path.basename(rel, '.md'),
    folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    frontmatter: fm,
    wordCount,
    headings,
    outbound,
    outboundCount: outbound.length,
    tags: readTags(content),
    created: created ? new Date(created).toISOString() : null,
    modified: modified ? new Date(modified).toISOString() : null,
    revisitedDays: created && modified ? Math.max(0, Math.round((modified - created) / 86400000)) : null,
    excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

// ── The score ────────────────────────────────────────────────────────────────

/**
 * How much this note looks like something worth trusting. PURE.
 *
 * ⚠ INBOUND LINKS ARE THE STRONGEST ARM AND THAT IS THE POINT. A note several
 * others point at is one Nick keeps coming back to — a hub — and that is a fact
 * about how he actually uses the vault rather than a guess about the prose. It
 * is the one signal here that no amount of writing can fake from inside a note.
 *
 * ⚠ Every arm is BANDED, never linear: the longest note in `Projects/` would
 * otherwise run away with the queue on length alone, which is how the promotion
 * scorer came to rank a 26-topic meeting above everything by volume.
 *
 * ⚠ NOTHING SCORES NEGATIVE except the stub test. "I cannot see structure in
 * this" is not evidence the note is worthless — most of these folders predate
 * any convention — and a penalty for an unrecognised shape is the promotion
 * queue's `JUDGED_EMPTY_PENALTY` applied where nothing has actually judged.
 */
function scoreNote(note, inboundCount = 0) {
  let score = 0;
  const reasons = [];

  if (note.wordCount < MIN_WORDS) return { score: 0, reasons: ['too short to be a write-up'], stub: true };

  if (note.wordCount >= 600) { score += 3; reasons.push('substantial'); }
  else if (note.wordCount >= 250) { score += 2; reasons.push('a real write-up'); }
  else { score += 1; }

  if (inboundCount >= 6) { score += 3; reasons.push(`${inboundCount} notes link to it`); }
  else if (inboundCount >= 3) { score += 2; reasons.push(`${inboundCount} notes link to it`); }
  else if (inboundCount >= 1) { score += 1; reasons.push(`${inboundCount} note${inboundCount === 1 ? '' : 's'} link${inboundCount === 1 ? 's' : ''} to it`); }

  if (note.headings >= 3) { score += 1; reasons.push('structured'); }
  if (note.outboundCount >= 3) { score += 1; reasons.push('well connected'); }
  if (note.tags.length > 0) { score += 1; reasons.push('tagged'); }

  if (note.revisitedDays !== null && note.revisitedDays >= REVISIT_DAYS) {
    score += 1;
    reasons.push(`revisited over ${note.revisitedDays} days`);
  }

  return { score, reasons, stub: false };
}

// ── The scan ─────────────────────────────────────────────────────────────────

/**
 * Walk the vault once: measure the candidate folders, and count inbound links
 * from EVERYWHERE.
 *
 * ⚠ The link map is built from the WHOLE vault, not just the candidate folders.
 * A Projects note linked from thirty meeting notes is the clearest hub in the
 * vault, and a map scoped to the candidates alone cannot see one of those
 * links — it would score a hub as an orphan, silently.
 */
function scan() {
  const vault = VAULT_PATH();
  const measured = [];
  const inbound = new Map();

  const bump = (key) => inbound.set(key, (inbound.get(key) || 0) + 1);

  const traversal = vaultWalk.walk(vault, {
    skipDir: (name) => vaultExclusions.isExcludedDir(name, { forEmbeddings: true }),
    skipFile: (rel) => !rel.toLowerCase().endsWith('.md')
      || vaultExclusions.isExcludedPath(rel, { forEmbeddings: true }),
    visit: (rel, full) => {
      let content;
      let stat;
      try {
        content = fs.readFileSync(full, 'utf-8');
        stat = fs.statSync(full);
      } catch {
        return;
      }

      const body = stripFrontmatter(content);
      const seen = new Set();
      for (const match of body.matchAll(WIKILINK_RE)) {
        const target = linkTarget(match[1]);
        // ⚠ Counted once per SOURCE note. A note linking the same target six
        // times is one note pointing at it, and letting repeats accumulate
        // would make a single heavily cross-referenced page look like a hub.
        if (target && !seen.has(target)) { seen.add(target); bump(target); }
      }

      const top = rel.split('/')[0];
      const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
      if (CANDIDATE_FOLDERS.includes(top) && !STRUCTURAL_FILES.has(base)) {
        measured.push(measureNote(rel, content, stat));
      }
    },
  });

  return {
    measured,
    inbound,
    known: !traversal.truncated,
    reasons: traversal.reasons,
    scanned: traversal.scanned,
  };
}

function cachedScan({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cache.at < CACHE_TTL_MS) return _cache.value;
  const value = scan();
  _cache = { at: now, value };
  return value;
}

/** Drop the cache — called after a mark, so the note leaves the queue at once. */
function invalidate() { _cache = null; }

// ── The offer ────────────────────────────────────────────────────────────────

/**
 * Rank what is worth offering, and account for everything that is not.
 *
 * ⚠ EVERY WITHHELD NOTE IS COUNTED AND REASONED. `people-gap`'s rule: three
 * candidates out of four hundred notes with no account of the other 397 is a
 * list nobody can check, and "the filter ate a good note" would be
 * indistinguishable from "nothing new turned up".
 *
 * ⚠ `known:false` is a NAMED GAP, never an empty list. A partly-read vault that
 * offered nothing would read exactly like a vault with nothing in it.
 */
function candidates({ limit = MAX_CANDIDATES, minScore = MIN_SCORE, force = false } = {}) {
  const result = cachedScan({ force });
  const trusted = knowledgeTrust.trustedPaths();

  const withheld = { trusted: 0, dismissed: 0, stub: 0, belowBar: 0 };
  const ranked = [];

  for (const note of result.measured) {
    if (trusted.known && trusted.paths.has(note.path)) { withheld.trusted += 1; continue; }
    if (!trusted.known && knowledgeTrust.isTrustedNote(note.path, note.frontmatter)) {
      withheld.trusted += 1; continue;
    }
    if (knowledgeTrust.cleanQuoted(note.frontmatter.knowledge_dismissed)) { withheld.dismissed += 1; continue; }

    const inboundCount = result.inbound.get(note.name.toLowerCase()) || 0;
    const scored = scoreNote(note, inboundCount);

    if (scored.stub) { withheld.stub += 1; continue; }
    if (scored.score < minScore) { withheld.belowBar += 1; continue; }

    ranked.push({
      path: note.path,
      title: note.title,
      folder: note.folder,
      score: scored.score,
      why: scored.reasons,
      wordCount: note.wordCount,
      inbound: inboundCount,
      outbound: note.outboundCount,
      headings: note.headings,
      tags: note.tags,
      modified: note.modified,
      excerpt: note.excerpt,
      suggestedDomain: knowledgeTrust.domainOf(note.path, note.frontmatter),
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  return {
    known: result.known,
    // ⚠ The trust set being unreadable does not stop the scan, but it does mean
    // an already-trusted note could be offered again. Said, not hidden.
    trustKnown: trusted.known,
    reasons: [
      ...result.reasons,
      ...(trusted.known ? [] : [`already-trusted notes could not be excluded — ${trusted.why}`]),
    ],
    scanned: result.scanned,
    considered: result.measured.length,
    matched: ranked.length,
    shown: Math.min(ranked.length, limit),
    withheld,
    folders: CANDIDATE_FOLDERS,
    minScore,
    candidates: ranked.slice(0, limit),
  };
}

module.exports = {
  CANDIDATE_FOLDERS,
  MIN_WORDS,
  STRUCTURAL_FILES,
  MIN_SCORE,
  MAX_CANDIDATES,
  REVISIT_DAYS,
  CACHE_TTL_MS,
  linkTarget,
  readTags,
  stripFrontmatter,
  measureNote,
  scoreNote,
  scan,
  invalidate,
  candidates,
};
