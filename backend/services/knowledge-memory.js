'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const aiRouting = require('./ai-routing');
const legacy = require('./legacy-names');
const db = require('../db/database');
const obsidian = require('./obsidian');
const importsService = require('./imports');
const retrieval = require('./retrieval');
const weeklySummary = require('./weekly-summary');
const knowledgeGaps = require('./knowledge-gaps');
const vaultHooks = require('./vault-hooks');
const { canonicalPlaudId } = require('../../shared/plaud-id.cjs');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';
// ⚠ `Meetings/transcripts` is where transcripts were SUPPOSED to land and holds
// zero files — `backend/.env` sets `PLAUD_TRANSCRIPT_FOLDER=Plaud/Transcripts`,
// which is where all 311 of them actually are. Scanning an empty folder finds
// nothing and raises nothing, so the raw-intake pass had never read a transcript.
// Both are listed: the configured one because it is the truth, the old one
// because `imports.canonicalizePlaudTranscript` can still put a rescued stray
// there. Measured before changing: adding the folder moves consolidation items
// 2 -> 2, so this reads more and writes nothing new (see groupPlaudNotes).
const RAW_FOLDERS = [
  'Plaud/Summaries',
  'Plaud/Transcripts',
  'Meetings/transcripts',
  'Imports',
  'Meetings',
  'Daily',
];
const TRUSTED_ROOTS = ['Knowledge', 'Projects', 'Areas', 'People', 'Documents'];
const REFLECTION_DIR = 'Reflections/Knowledge';
const REPORT_DIR = 'Documents/System/SAiM Import Reports';
const VAULT_MODEL_DOC = 'Documents/System/Vault Operating Model.md';

function isoNow() {
  return new Date().toISOString();
}

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function toRel(fullPath) {
  return path.relative(VAULT_PATH(), fullPath).replace(/\\/g, '/');
}

function fileNameFromPath(relPath) {
  return path.basename(relPath, '.md');
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sanitizeSegment(value, fallback = 'General') {
  const clean = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || fallback;
}

function normalizePlaudId(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '');
}

function cleanQuoted(value) {
  return String(value || '').trim().replace(/^"+|"+$/g, '');
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^---[\s\S]*?---\s*/m, '');
}

function stripCodeFences(content) {
  return String(content || '')
    .replace(/^```(?:json|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function uniqueStrings(values, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function parseJsonObject(text) {
  const clean = stripCodeFences(text);
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function markdownLinkForPath(relPath, label = '') {
  if (!relPath) return '';
  return `[[${String(relPath).replace(/\.md$/i, '')}|${label || fileNameFromPath(relPath)}]]`;
}

function excerpt(content, maxLength = 260) {
  const clean = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

function extractMarkdownSection(content, heading) {
  const text = String(content || '');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = text.match(new RegExp(`^## ${escapedHeading}\\s*$`, 'm'));
  if (!startMatch || startMatch.index === undefined) return '';

  const sectionStart = startMatch.index + startMatch[0].length;
  const remainder = text.slice(sectionStart);
  const nextHeadingOffset = remainder.search(/\n##\s+/);
  const section = nextHeadingOffset === -1
    ? remainder
    : remainder.slice(0, nextHeadingOffset);
  return section.trim();
}

/**
 * A section at ANY heading level, for reading PLAUD summaries.
 *
 * ⚠ PLAUD WRITES TWO LAYOUTS AND `extractMarkdownSection` ONLY SEES ONE. Measured on
 * the live vault: `## Meeting Notes` on 157 notes and `### Meeting Notes` (nested under
 * `## Summary`) on 15. The strict extractor is anchored to `^## `, so those 15 returned
 * EMPTY — not an error, just a card with nothing on it.
 *
 * ⚠ It is a SEPARATE function rather than a loosened `extractMarkdownSection`: that one
 * is paired with `removeMarkdownSection`/`insertAiSections` and its result is ANDed with
 * the AI-enrichment skip check, so widening what it matches risks re-enriching notes
 * with PAID model calls. Reading is allowed to be lenient; rewriting is not.
 *
 * ⚠⚠ THE SECTION ENDS AT THE SAME OR A HIGHER LEVEL, NEVER AT ANY HEADING. The first
 * cut stopped at `#{1,4}`, so `## Meeting Notes` followed by a `### **Topic**` subhead
 * ended IMMEDIATELY and the section read as empty — 11 notes, every one of them a long
 * meeting, reporting zero topics while their follow-ups counted fine. An extractor that
 * returns '' is indistinguishable from a note that has nothing to say.
 */
function extractSectionFlexible(content, heading) {
  const text = String(content || '');
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = text.match(new RegExp(`^(#{2,4})\\s+${escaped}\\s*$`, 'm'));
  if (!startMatch || startMatch.index === undefined) return '';

  const level = startMatch[1].length;
  const rest = text.slice(startMatch.index + startMatch[0].length);
  const nextHeading = rest.search(new RegExp(`\\n#{1,${level}}\\s+`));
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

/**
 * The AI insight section under EITHER spelling of its heading.
 *
 * ⚠ Not cosmetic: this value is ANDed with the source-hash skip check. Looking
 * only for 'SAiM Insight' makes every note enriched before the rename read as
 * un-enriched, and each is then re-enriched with a paid model call.
 */
function extractAiInsightSection(content) {
  for (const heading of legacy.headingAliases('SAiM Insight')) {
    const found = extractMarkdownSection(content, heading);
    if (found) return found;
  }
  return '';
}

function removeMarkdownSection(content, heading) {
  const text = String(content || '');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\n## ${escapedHeading}\\s*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, 'm');
  return text.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n');
}

function shiftMarkdownHeadings(markdown, increaseBy = 1) {
  return String(markdown || '').replace(/^(#{1,6})\s+/gm, (match, hashes) => {
    const nextDepth = Math.min(6, hashes.length + increaseBy);
    return `${'#'.repeat(nextDepth)} `;
  });
}

function cleanPlaudSummaryMarkdown(markdown, titleToRemove = '') {
  let text = String(markdown || '').trim();
  if (!text) return '';

  text = text.replace(/^#\s+.+\n+/, '').trim();

  if (titleToRemove) {
    const escapedTitle = titleToRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^#\\s+${escapedTitle}\\s*`, 'i'), '').trim();
  }

  text = text
    .replace(/^\s*---\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return shiftMarkdownHeadings(text, 1);
}

function extractPlaudMeetingMarkdown(note, fallbackTitle = '') {
  if (!note?.content) return '';

  const summarySection = extractMarkdownSection(note.content, 'Summary');
  if (summarySection) {
    return cleanPlaudSummaryMarkdown(summarySection, fallbackTitle);
  }

  const stripped = stripFrontmatter(note.content).trim();
  if (!stripped) return '';

  const withoutRecording = stripped.replace(
    /^#\s+.+?\n+##\s+Recording[\s\S]*?(?=\n##\s+|\n#\s+|$)/,
    ''
  ).trim();

  return cleanPlaudSummaryMarkdown(withoutRecording || stripped, fallbackTitle);
}

function hasMarkdownHeading(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#{1,6}\\s+${escapedHeading}\\s*$`, 'im').test(String(markdown || ''));
}

function walkMarkdown(dir, depth = 0, maxDepth = 5, out = []) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, depth + 1, maxDepth, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readNoteMeta(fullPath) {
  const content = fs.readFileSync(fullPath, 'utf-8');
  const stat = fs.statSync(fullPath);
  const relPath = toRel(fullPath);
  const fm = obsidian.parseFrontmatter(content);
  const body = stripFrontmatter(content);
  const linkMatches = [...body.matchAll(/\[\[([^\]]+)\]\]/g)];
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const relLower = relPath.toLowerCase();
  const folder = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const knowledgeState = String(fm.knowledge_state || '').toLowerCase();
  const trusted = relLower.startsWith('knowledge/')
    || knowledgeState === 'trusted'
    || knowledgeState === 'distilled';

  return {
    path: relPath,
    name: fileNameFromPath(relPath),
    folder,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    frontmatter: fm,
    tags: obsidian.extractTags(content),
    links: linkMatches.length,
    wordCount,
    trusted,
    knowledgeState: knowledgeState || (trusted ? 'trusted' : 'raw'),
    promotedTo: fm.knowledge_promoted_to || '',
    consolidatedTo: legacy.fmValue(fm, 'saim_consolidated_to') || '',
    excerpt: excerpt(content),
    content
  };
}

function loadFolderNotes(folder) {
  const vault = VAULT_PATH();
  if (!vault) return [];
  const fullDir = path.join(vault, folder);
  return walkMarkdown(fullDir).map(readNoteMeta);
}

function loadTrustedNotes() {
  const vault = VAULT_PATH();
  if (!vault) return [];
  const notes = [];

  for (const folder of TRUSTED_ROOTS) {
    const fullDir = path.join(vault, folder);
    if (!fs.existsSync(fullDir)) continue;
    for (const fullPath of walkMarkdown(fullDir)) {
      const note = readNoteMeta(fullPath);
      if (note.trusted) notes.push(note);
    }
  }

  return notes.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function loadRawNotes() {
  return RAW_FOLDERS.flatMap(loadFolderNotes)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

function noteDateParts(note) {
  // ⚠ Same quote trap as the note_type comparisons: plaud-sync writes
  // `start_at: "2026-08-25T14:18:56"` QUOTED, and `new Date('"2026-..."')` is
  // Invalid Date, which falls through to `new Date()` below. So a consolidated
  // note for a July meeting was dated TODAY and filed in the current month —
  // silently, because a plausible date is indistinguishable from a correct one.
  const stamp = cleanQuoted(note.frontmatter.start_at)
    || cleanQuoted(note.frontmatter.created_at)
    || note.modified
    || isoNow();
  const date = new Date(stamp);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    iso: safe.toISOString().slice(0, 10),
    year: safe.toISOString().slice(0, 4),
    month: safe.toISOString().slice(5, 7)
  };
}

/**
 * Is this note the DISTILLED write-up, or the raw recording it came from?
 *
 * Read off what the note SAYS IT IS (`note_type`, written by plaud-sync) rather than
 * where it sits: `imports.js` routes a summary into `Meetings/YYYY/MM/`, so the folder
 * stopped being a statement about the note the day routing shipped.
 */
function isSummaryNote(note) {
  const fm = (note && note.frontmatter) || {};
  const noteType = cleanQuoted(fm.note_type || fm.type).toLowerCase();
  if (noteType === 'summary') return true;
  // ⚠ `plaud_summary_type`, NOT `summary_type` — see the scorer below.
  return Boolean(cleanQuoted(fm.plaud_summary_type));
}

function isTranscriptNote(note) {
  const fm = (note && note.frontmatter) || {};
  return cleanQuoted(fm.note_type || fm.type).toLowerCase() === 'transcript';
}

/**
 * canonical plaud_id -> the path of the SUMMARY for that recording.
 *
 * Built from the raw pool the candidates come from, so it costs no extra walk. The
 * join is the canonical id and never the `Summary: [[...]]` link in the transcript
 * body — those were left pointing at `… 2` twins by the 15 Sep duplicate incident
 * and a broken link would read as "no summary exists".
 */
function indexSummariesByRecording(notes) {
  const index = new Map();
  for (const note of notes || []) {
    if (!isSummaryNote(note)) continue;
    const id = canonicalPlaudId((note.frontmatter || {}).plaud_id);
    if (!id || index.has(id)) continue;
    index.set(id, note.path);
  }
  return index;
}

/** The summary that supersedes this note, or '' — never undefined. */
function supersedingSummary(note, summaryIndex) {
  if (!summaryIndex || isSummaryNote(note)) return '';
  const id = canonicalPlaudId(((note && note.frontmatter) || {}).plaud_id);
  if (!id) return '';
  return summaryIndex.get(id) || '';
}

/**
 * ⚠⚠ TWO ARMS OF THIS SCORED A VAULT LAYOUT THAT NO LONGER EXISTS (16 Sep 2026).
 *
 * `Plaud/Summaries/` scored **+5** and holds **ONE** file — `imports.js` routes every
 * Plaud summary into `Meetings/YYYY/MM/`, where **263** of them live and scored **+2**,
 * a point BELOW the raw transcript each was distilled from. And the tie-breaker that
 * would have flipped exactly that, `summary_type`, is a key on **ZERO** notes in this
 * vault; the real one is `plaud_summary_type`, on **2,326**. ⚠ A wrong frontmatter key
 * returns undefined rather than throwing, so that arm had never fired once in the
 * feature's life and `summaryType` on the payload was always null — the
 * `sleep_core_hours` / `meeting_alert` species, third instance.
 *
 * Measured on the live pair for 2026-09-14: transcript **8**, its own summary **7**. So
 * the queue offered 11,820 words of unattributed speech whose opening line is "Sorry, I
 * was going to say something you can crap on", and hid the 2,081-word note holding 15
 * topics, 14 conclusions and 26 follow-ups. Nothing errored; the ranking was simply
 * upside down, and the excerpt on the card was boilerplate every transcript shares, so
 * there was nothing on screen to say so.
 *
 * ⚠ A SUPERSEDED TRANSCRIPT IS PENALISED, NEVER FILTERED. If the id join is ever wrong
 * the note stays visible at the bottom of the queue rather than vanishing from it —
 * a demoted candidate is a cheap, visible mistake, a silently dropped one is not.
 * Same -10 idiom as `promotedTo`.
 */
function scorePromotionCandidate(note) {
  let score = 0;
  const fm = (note && note.frontmatter) || {};

  // What the note IS decides most of it. The recording is source material for the
  // write-up, so it must never outrank the write-up.
  if (isSummaryNote(note)) score += 6;
  else if (isTranscriptNote(note)) score += 1;
  else if (note.path.startsWith('Meetings/')) score += 2;

  // Kept, at a weight that matches its evidence: one file today, but still where
  // `imports.canonicalizePlaudTranscript` puts a rescued stray.
  if (note.path.startsWith('Plaud/Summaries/')) score += 2;

  if (note.wordCount > 350) score += 2;
  if (note.links > 0) score += 1;
  if (note.tags.length > 0) score += 1;
  if (String(fm.source || '').toLowerCase() === 'plaud') score += 2;
  if (note.supersededBy) score -= 10;
  if (note.promotedTo) score -= 10;
  return score;
}

/**
 * Why this note is worth distilling, in the note's own words.
 *
 * ⚠ THE CARD USED TO RENDER `excerpt(content, 260)`, WHICH FOR A PLAUD NOTE IS THE
 * TITLE, THE TITLE AGAIN AS A WIKILINK, AND THE SPEAKER WARNING — boilerplate all 347
 * transcripts share, so the queue answered "what is this" with something identifying
 * nothing and "why promote it" with nothing at all.
 *
 * ⚠ IT DELIBERATELY DOES NOT READ `## Summary`, which is the obvious section and is
 * EMPTY on the live 2026-09-14 note — a card built on it renders blank. The signal is
 * in `## Meeting Notes` (the `Topic Title:` / `Conclusion:` lines PLAUD writes) and the
 * unticked boxes under `## Next Arrangements`.
 *
 * ⚠ Returns null rather than an empty shape when there is nothing to say, so the caller
 * falls back to the excerpt: a note with no structure is not a note with no content.
 * PURE — no vault, no clock.
 */
function promotionSignal(note) {
  const content = (note && note.content) || '';
  const fm = (note && note.frontmatter) || {};

  const meetingNotes = extractSectionFlexible(content, 'Meeting Notes');
  const arrangements = extractSectionFlexible(content, 'Next Arrangements');

  // ⚠ THREE TOPIC CONVENTIONS, MEASURED ON THE LIVE VAULT, TRIED IN ORDER AND NEVER
  // SUMMED: `- Topic Title: X` (43 notes), a `### **X**` subheading (11) and a bare
  // `**X**` line (31). A note uses one of them, so adding the counts would double up
  // any note that happens to contain two — the first non-empty list wins.
  //
  // ⚠ Written against what PLAUD ACTUALLY EMITS rather than one observed file. The
  // first cut knew only the first convention, and the notes using the other two
  // reported zero topics — a plausible number, and wrong, which is why it survived a
  // read-through and was caught only by running it over the whole vault.
  const stripBold = (value) => String(value).replace(/\*\*/g, '').trim();
  const titled = [...meetingNotes.matchAll(/^\s*[-*]\s*Topic Title:\s*(.+)$/gm)].map(m => stripBold(m[1]));
  const subheads = [...meetingNotes.matchAll(/^#{3,5}\s+(.+)$/gm)].map(m => stripBold(m[1]));
  const bolded = [...meetingNotes.matchAll(/^\*\*([^*\n]+)\*\*\s*$/gm)].map(m => stripBold(m[1]));
  const topicNames = [titled, subheads, bolded].find(list => list.filter(Boolean).length) || [];
  const topics = topicNames.filter(Boolean).length;

  const openFollowUps = (arrangements.match(/^\s*[-*]\s*\[ \]/gm) || []).length;

  // ⚠ A FOURTH TEMPLATE: the Consultation layout (`## Overview` on 9 notes,
  // `## Next Steps` on 15) has neither Meeting Notes nor Next Arrangements, so it
  // reported a duration and nothing else. Its next steps are PLAIN BULLETS, not
  // checkboxes, so they are counted and named separately — calling them "open
  // follow-ups" would claim a tick state the note does not carry.
  const nextSteps = (extractSectionFlexible(content, 'Next Steps').match(/^\s*[-*]\s+(?!\[)/gm) || []).length;

  // Only the first template states conclusions; the others carry the point in their
  // topic names or in the Overview paragraph, which is why those travel too.
  const conclusionMatch = meetingNotes.match(/^\s*[-*]\s*Conclusion:\s*(.+)$/m);
  const overview = extractSectionFlexible(content, 'Overview');
  const overviewSentence = overview
    ? (overview.split(/(?<=\.)\s+/)[0] || '').trim()
    : '';
  const conclusion = conclusionMatch ? conclusionMatch[1].trim() : overviewSentence;

  // `duration_ms` is quoted on some notes and bare on others — cleanQuoted first, or
  // Number('"3062000"') is NaN and every meeting silently loses its length.
  const durationMs = Number(cleanQuoted(fm.duration_ms));
  const durationMinutes = Number.isFinite(durationMs) && durationMs > 0
    ? Math.round(durationMs / 60000)
    : null;

  if (!topics && !openFollowUps && !nextSteps && !conclusion && durationMinutes === null) return null;

  const parts = [];
  if (durationMinutes !== null) parts.push(`${durationMinutes} min`);
  if (topics) parts.push(`${topics} topic${topics === 1 ? '' : 's'}`);
  if (openFollowUps) parts.push(`${openFollowUps} open follow-up${openFollowUps === 1 ? '' : 's'}`);
  else if (nextSteps) parts.push(`${nextSteps} next step${nextSteps === 1 ? '' : 's'}`);

  return {
    headline: parts.join(' · '),
    conclusion,
    topics,
    topicNames: topicNames.slice(0, 3),
    openFollowUps,
    nextSteps,
    durationMinutes
  };
}

function toCandidatePayload(note) {
  return {
    path: note.path,
    name: note.name,
    folder: note.folder,
    modified: note.modified,
    occurredAt: note.occurredAt ? new Date(note.occurredAt.ms).toISOString() : note.modified,
    occurredAtSource: note.occurredAt ? note.occurredAt.when : 'file',
    excerpt: note.excerpt,
    wordCount: note.wordCount,
    tags: note.tags,
    knowledgeState: note.knowledgeState,
    // ⚠ `plaud_summary_type`. The old `summary_type` is on zero notes in this vault,
    // so this field had only ever been null. See scorePromotionCandidate.
    summaryType: cleanQuoted(note.frontmatter.plaud_summary_type) || null,
    noteType: cleanQuoted(note.frontmatter.note_type || note.frontmatter.type) || null,
    isSummary: isSummaryNote(note),
    supersededBy: note.supersededBy || null,
    signal: promotionSignal(note),
    promotionScore: note.promotionScore
  };
}

/**
 * Every candidate, ranked. Split out from `getPromotionCandidates` so `getOverview` can
 * report how many there ARE as well as show the top few — it used to render the length
 * of the CAPPED list, so the card read "6" whatever the real number was.
 */
/**
 * When did this note's CONTENT happen — not when the file was last touched.
 *
 * mtime is not a fact about the meeting. Syncthing rewrites it, NEURO's own hooks
 * rewrite it, and the AI-enrichment pass rewrites it, so the queue was ranking a
 * 26 Aug meeting above a 14 Sep one and calling both "recent". Measured on the live
 * vault: the whole top six were August notes inside a 21-day window on 16 September.
 *
 * "when: file" is reported rather than hidden, because a note whose own date cannot be
 * read is being ranked on a weaker signal and that should be visible.
 */
function candidateTimestamp(note) {
  const fm = (note && note.frontmatter) || {};
  for (const key of ['start_at', 'date', 'created_at']) {
    const parsed = new Date(cleanQuoted(fm[key]));
    if (!Number.isNaN(parsed.getTime())) return { ms: parsed.getTime(), when: 'note' };
  }
  const fallback = new Date(note && note.modified);
  return {
    ms: Number.isNaN(fallback.getTime()) ? 0 : fallback.getTime(),
    when: 'file'
  };
}

function rankPromotionCandidates({ topic, daysBack = 21 } = {}) {
  const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
  const term = String(topic || '').trim().toLowerCase();

  const raw = loadRawNotes();
  const summaryIndex = indexSummariesByRecording(raw);

  return raw
    .filter(note => !note.promotedTo)
    .map(note => ({ ...note, occurredAt: candidateTimestamp(note) }))
    .filter(note => note.occurredAt.ms >= cutoff)
    .filter(note => !term || `${note.name}\n${note.excerpt}\n${note.tags.join(' ')}`.toLowerCase().includes(term))
    .map(note => {
      const withSource = { ...note, supersededBy: supersedingSummary(note, summaryIndex) };
      return { ...withSource, promotionScore: scorePromotionCandidate(withSource) };
    })
    .sort((a, b) => {
      if (b.promotionScore !== a.promotionScore) return b.promotionScore - a.promotionScore;
      return b.occurredAt.ms - a.occurredAt.ms;
    });
}

function getPromotionCandidates({ topic, limit = 8, daysBack = 21 } = {}) {
  return rankPromotionCandidates({ topic, daysBack })
    .slice(0, limit)
    .map(toCandidatePayload);
}
async function getActiveContext({ topic, maxResults = 5 } = {}) {
  const trustedNotes = loadTrustedNotes();
  if (!topic || !topic.trim()) {
    return trustedNotes.slice(0, maxResults).map(note => ({
      path: note.path,
      name: note.name,
      modified: note.modified,
      knowledgeState: note.knowledgeState,
      excerpt: note.excerpt
    }));
  }

  const searchResults = await retrieval.search(topic, { maxResults: maxResults * 4 });
  const trustedSet = new Map(trustedNotes.map(note => [note.path, note]));
  const filtered = searchResults
    .filter(result => trustedSet.has(result.path))
    .slice(0, maxResults)
    .map(result => {
      const note = trustedSet.get(result.path);
      return {
        path: result.path,
        name: result.name,
        modified: note.modified,
        knowledgeState: note.knowledgeState,
        score: result.score,
        excerpt: result.excerpts?.[0] || note.excerpt
      };
    });

  if (filtered.length > 0) return filtered;

  return trustedNotes
    .filter(note => `${note.name}\n${note.excerpt}`.toLowerCase().includes(topic.toLowerCase()))
    .slice(0, maxResults)
    .map(note => ({
      path: note.path,
      name: note.name,
      modified: note.modified,
      knowledgeState: note.knowledgeState,
      excerpt: note.excerpt
    }));
}

/**
 * The NEWEST reflections, and how many there are.
 *
 * ⚠ `loadFolderNotes` does NOT sort — `walkMarkdown` returns readdir order — so
 * `.slice(0, limit)` was "the first four the directory listing yielded", which on this
 * vault is the four OLDEST (June/July) under a heading reading "recent". Same species
 * as the wins ledger reading `activity_log` in query order.
 *
 * ⚠ `total` is separate from the list because the Insights card rendered the LENGTH OF
 * THE CAPPED LIST as its count: it read "4" while 13 sat on disk, and would have read
 * "4" for ever. A cap is not a measurement.
 */
function recentReflections(limit = 4) {
  const all = loadFolderNotes(REFLECTION_DIR)
    .sort((a, b) => new Date(b.modified) - new Date(a.modified));

  return {
    total: all.length,
    items: all.slice(0, limit).map(note => ({
      path: note.path,
      name: note.name,
      modified: note.modified,
      excerpt: note.excerpt
    }))
  };
}
function getAiEnrichmentNotesForDate(dateKey = isoDate()) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) return [];

  const matches = [];
  for (const fullPath of walkMarkdown(vault)) {
    let note;
    try {
      note = readNoteMeta(fullPath);
    } catch {
      continue;
    }
    const enrichedAt = cleanQuoted(legacy.fmValue(note.frontmatter, 'saim_ai_enriched_at') || '');
    if (!enrichedAt.startsWith(dateKey)) continue;
    matches.push({
      path: note.path,
      provider: cleanQuoted(legacy.fmValue(note.frontmatter, 'saim_ai_provider') || 'unknown')
    });
  }
  return matches;
}

function parseCsvField(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

async function getOverview({ topic } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const raw = loadRawNotes();
  const trusted = loadTrustedNotes();
  const rankedCandidates = rankPromotionCandidates({ topic });
  const candidates = rankedCandidates.slice(0, 6).map(toCandidatePayload);
  const activeContext = await getActiveContext({ topic, maxResults: 5 });
  const weekly = weeklySummary.summarizeWeek({});
  const gaps = knowledgeGaps.findKnowledgeGaps({ topic, daysBack: 90 });
  const reflections = recentReflections(4);

  const domains = new Map();
  for (const note of trusted) {
    const domain = sanitizeSegment(note.frontmatter.knowledge_domain || note.folder.split('/')[0] || 'General');
    domains.set(domain, (domains.get(domain) || 0) + 1);
  }

  return {
    status: 'ok',
    counts: {
      rawNotes: raw.length,
      trustedNotes: trusted.length,
      // ⚠ TOTALS, not the length of the capped list beside them. Both of these used
      // to render the cap — "Promote Next 6" was `limit: 6` and "Reflection Notes 4"
      // was `recentReflections(4)`, against 13 on disk. A number that cannot move is
      // one nobody can act on.
      promotionCandidates: rankedCandidates.length,
      promotionCandidatesShown: candidates.length,
      reflectionNotes: reflections.total,
      knowledgeDomains: domains.size
    },
    weekly: weekly.status === 'ok' ? weekly.counts : null,
    topDomains: [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([domain, count]) => ({ domain, count })),
    activeContext,
    promotionCandidates: candidates,
    recentReflections: reflections.items,
    knowledgeGaps: gaps.status === 'ok' ? (gaps.suggestions || []).slice(0, 5) : []
  };
}

function renderFrontmatter(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: "${String(value).replace(/"/g, '\\"')}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function upsertFrontmatterValue(content, key, value) {
  const line = `${key}: "${String(value).replace(/"/g, '\\"')}"`;
  if (!content.startsWith('---')) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const fmBlock = content.slice(0, endIdx + 3);
  const body = content.slice(endIdx + 3).replace(/^\s*/, '');
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  const nextFm = pattern.test(fmBlock)
    ? fmBlock.replace(pattern, line)
    : fmBlock.replace(/---\s*$/, `${line}\n---`);
  return `${nextFm}\n\n${body}`;
}

function inferDomainFromSource(sourcePath) {
  if (sourcePath.startsWith('Plaud/')) return 'Meetings';
  if (sourcePath.startsWith('Projects/')) return 'Projects';
  if (sourcePath.startsWith('People/')) return 'People';
  if (sourcePath.startsWith('Areas/')) return 'Areas';
  return 'General';
}

function hashItemSources(item) {
  const sourceFingerprint = (item.notes || [])
    .map((note) => [
      note.path,
      note.modified,
      note.frontmatter?.title || '',
      note.frontmatter?.plaud_id || '',
      note.excerpt || ''
    ].join('|'))
    .join('\n');
  return crypto.createHash('sha1').update(sourceFingerprint).digest('hex');
}

function summarizeClassification(classification) {
  if (!classification) return '';
  return [
    classification.type ? `type=${classification.type}` : '',
    classification.destination ? `destination=${classification.destination}` : '',
    classification.reason ? `reason=${classification.reason}` : ''
  ].filter(Boolean).join('; ');
}

async function resolveSuggestedLinks(terms, excludePaths = []) {
  const links = [];
  const excluded = new Set((excludePaths || []).map((value) => String(value || '').toLowerCase()));

  for (const term of uniqueStrings(terms, 8)) {
    try {
      const results = await retrieval.search(term, { maxResults: 3 });
      const match = results.find((result) => {
        const rel = String(result.path || '');
        if (!rel || excluded.has(rel.toLowerCase())) return false;
        if (rel.startsWith('Archive/')) return false;
        return true;
      });
      if (!match) continue;
      links.push({
        term,
        path: match.path,
        label: match.name || fileNameFromPath(match.path),
        score: match.score || 0
      });
    } catch {}
  }

  const seen = new Set();
  return links.filter((link) => {
    const key = `${String(link.path).toLowerCase()}|${String(link.term).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function buildAiInsight(item, targetPath, existingContent = '') {
  if (aiRouting.getAIMode() === 'off') return null;

  const sourceHash = hashItemSources(item);
  const existingFrontmatter = obsidian.parseFrontmatter(existingContent || '');
  const existingInsight = extractAiInsightSection(existingContent);
  if (legacy.fmValue(existingFrontmatter, 'saim_ai_source_hash') === sourceHash && existingInsight) {
    return {
      skipped: true,
      sourceHash,
      provider: legacy.fmValue(existingFrontmatter, 'saim_ai_provider') || 'cached'
    };
  }

  const note = item.summary || item.note;
  const transcriptInsight = item.transcriptInsight || null;
  const prompt = [
    'You are SAiM, curating an Obsidian second brain for operational leadership work.',
    'Be concise. Return ONLY a JSON object with this shape:',
    '{',
    '  "summary": "1-2 sentence synthesis of the note",',
    '  "durableInsights": ["insight"],',
    '  "openLoops": ["risk, pending decision, or follow-up"],',
    '  "promotionCandidates": ["durable knowledge worth promoting"],',
    '  "suggestedLinks": ["project, person, area, or concept to link"],',
    '  "filingNote": "one short sentence on how this should live in the vault"',
    '}',
    'Rules:',
    '- Be conservative. Do not invent facts.',
    '- Keep each array to 0-2 items max.',
    '- If the note is sparse, link-heavy, or unclear, return short summary plus empty arrays.',
    '- suggestedLinks should be short names or concepts, not file paths.',
    '',
    `Target path: ${targetPath}`,
    `Item type: ${item.type}`,
    `Source title: ${baseTitleForItem(item)}`,
    summarizeClassification(item.classification) ? `Classification: ${summarizeClassification(item.classification)}` : '',
    transcriptInsight?.summary ? `Transcript insight summary: ${transcriptInsight.summary}` : '',
    transcriptInsight?.keyTopics?.length ? `Transcript key topics: ${transcriptInsight.keyTopics.join('; ')}` : '',
    transcriptInsight?.actionItems?.length ? `Transcript actions: ${transcriptInsight.actionItems.join('; ')}` : '',
    'Source excerpts:',
    ...(item.notes || []).map((source, index) => `Source ${index + 1} (${source.path}): ${source.excerpt}`),
    '',
    'Primary note content:',
    stripFrontmatter(note.content || '').slice(0, 3500)
  ].filter(Boolean).join('\n');

  try {
    const result = await aiRouting.runTask('knowledge_consolidation', {
      prompt,
      contextWindow: 1536,
      maxTokens: 220,
      temperature: 0.2
    }, { confidence: 0.4, timeout: 45000 });

    const parsed = parseJsonObject(result.text || '');
    if (!parsed) return null;

    const suggestedLinks = await resolveSuggestedLinks(
      parsed.suggestedLinks || [],
      item.notes.map((source) => source.path).concat([targetPath])
    );

    return {
      provider: result.provider || 'unknown',
      generatedAt: isoNow(),
      sourceHash,
      summary: String(parsed.summary || '').trim(),
      filingNote: String(parsed.filingNote || '').trim(),
      durableInsights: uniqueStrings(parsed.durableInsights || [], 6),
      openLoops: uniqueStrings(parsed.openLoops || [], 6),
      promotionCandidates: uniqueStrings(parsed.promotionCandidates || [], 6),
      suggestedLinks
    };
  } catch {
    return null;
  }
}

function sourceHashForContent(relPath, content) {
  return crypto.createHash('sha1')
    .update(`${relPath}\n${stripFrontmatter(content)}`)
    .digest('hex');
}

async function buildAiInsightForExistingNote(note) {
  if (aiRouting.getAIMode() === 'off') return null;

  const sourceHash = sourceHashForContent(note.path, note.content || '');
  const existingInsight = extractAiInsightSection(note.content || '');
  if (legacy.fmValue(note.frontmatter, 'saim_ai_source_hash') === sourceHash && existingInsight) {
    return {
      skipped: true,
      sourceHash,
      provider: legacy.fmValue(note.frontmatter, 'saim_ai_provider') || 'cached'
    };
  }

  const prompt = [
    'You are SAiM, curating a trusted Obsidian second brain.',
    'Be concise. Return ONLY a JSON object with this shape:',
    '{',
    '  "summary": "1-2 sentence synthesis",',
    '  "durableInsights": ["insight"],',
    '  "openLoops": ["follow-up, risk, or unresolved question"],',
    '  "promotionCandidates": ["durable knowledge worth promoting"],',
    '  "suggestedLinks": ["project, person, area, or concept to link"],',
    '  "filingNote": "one short sentence describing how this note should live in the vault"',
    '}',
    'Rules:',
    '- Be conservative and concrete.',
    '- Do not invent facts.',
    '- Prefer operationally useful insights over generic summaries.',
    '- Keep each array to 0-2 items max.',
    '- If the note is sparse, link-heavy, or unclear, return short summary plus empty arrays.',
    '',
    `Path: ${note.path}`,
    `Name: ${note.name}`,
    `Folder: ${note.folder}`,
    '',
    stripFrontmatter(note.content || '').slice(0, 3500)
  ].join('\n');

  try {
    const result = await aiRouting.runTask('knowledge_consolidation', {
      prompt,
      contextWindow: 1536,
      maxTokens: 220,
      temperature: 0.2
    }, { confidence: 0.4, timeout: 45000 });

    const parsed = parseJsonObject(result.text || '');
    if (!parsed) return null;

    return {
      provider: result.provider || 'unknown',
      generatedAt: isoNow(),
      sourceHash,
      summary: String(parsed.summary || '').trim(),
      filingNote: String(parsed.filingNote || '').trim(),
      durableInsights: uniqueStrings(parsed.durableInsights || [], 6),
      openLoops: uniqueStrings(parsed.openLoops || [], 6),
      promotionCandidates: uniqueStrings(parsed.promotionCandidates || [], 6),
      suggestedLinks: await resolveSuggestedLinks(parsed.suggestedLinks || [], [note.path])
    };
  } catch {
    return null;
  }
}

function renderAiInsightSections(aiInsight) {
  if (!aiInsight || aiInsight.skipped) return '';
  const lines = [];
  lines.push('## SAiM Insight');
  lines.push('');
  lines.push(aiInsight.summary || 'SAiM reviewed this note and found no stronger synthesis worth writing yet.');
  lines.push('');

  if (aiInsight.durableInsights?.length) {
    lines.push('## Durable Insights');
    lines.push('');
    for (const itemText of aiInsight.durableInsights) lines.push(`- ${itemText}`);
    lines.push('');
  }

  if (aiInsight.openLoops?.length) {
    lines.push('## Open Loops');
    lines.push('');
    for (const itemText of aiInsight.openLoops) lines.push(`- ${itemText}`);
    lines.push('');
  }

  if (aiInsight.promotionCandidates?.length) {
    lines.push('## Promote Next');
    lines.push('');
    for (const itemText of aiInsight.promotionCandidates) lines.push(`- ${itemText}`);
    lines.push('');
  }

  if (aiInsight.suggestedLinks?.length) {
    lines.push('## Suggested Links');
    lines.push('');
    for (const link of aiInsight.suggestedLinks) {
      lines.push(`- ${markdownLinkForPath(link.path, link.label)}${link.term ? ` — surfaced from "${link.term}"` : ''}`);
    }
    lines.push('');
  }

  if (aiInsight.filingNote) {
    lines.push('## Filing Note');
    lines.push('');
    lines.push(aiInsight.filingNote);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function stripExistingAiSections(content) {
  let next = String(content || '');
  // ⚠ 'SARA Insight' is the PRE-RENAME heading and must stay in this list.
  // Strip only the new spelling and a note enriched before 15 Sep 2026 keeps
  // its old section, gains a new one beside it, and the note then carries two
  // insights with nothing saying which is current.
  for (const heading of ['SAiM Insight', 'SARA Insight', 'Durable Insights', 'Open Loops', 'Promote Next', 'Suggested Links', 'Filing Note']) {
    next = removeMarkdownSection(next, heading);
  }
  return next.trimEnd();
}

function insertAiSections(content, aiInsight) {
  const cleaned = stripExistingAiSections(content);
  const aiBlock = renderAiInsightSections(aiInsight);
  if (!aiBlock) return cleaned;

  const marker = '\n## Manual Notes';
  const idx = cleaned.indexOf(marker);
  if (idx !== -1) {
    return `${cleaned.slice(0, idx).trimEnd()}\n\n${aiBlock}\n${cleaned.slice(idx + 1)}`.trimEnd() + '\n';
  }
  return `${cleaned.trimEnd()}\n\n${aiBlock}`.trimEnd() + '\n';
}

function operatingModelMarkdown() {
  return `# Vault Operating Model

_Managed by SAiM / NUERO._

## Core Principle

Raw capture is not the same thing as durable knowledge.

SAiM uses a two-stage flow:

1. Raw intake lands in staging locations such as \`Plaud/Summaries\`, \`Meetings/transcripts\`, and \`Imports/\`.
2. Consolidated notes are written into the working vault in the folder that best matches the note's real purpose.

## Folder Roles

- \`Plaud/Summaries\` and \`Meetings/transcripts\`: Plaud sync intake and transcripts.
- \`Imports/\`: raw external intake waiting for review, routing, or consolidation.
- \`Meetings/\`: working meeting notes, including consolidated Plaud meeting notes.
- \`Projects/\`, \`Areas/\`, \`People/\`, \`Ideas/\`, \`Reflections/\`: final working locations for consolidated notes.
- \`Knowledge/\`: distilled durable knowledge that SAiM should reuse as trusted context.
- \`Documents/System/\`: system notes describing how the vault is operated.

## What SAiM Writes

- Consolidated notes from imports into relevant working folders.
- Linking metadata back to raw source notes.
- AI insight sections showing what SAiM inferred, what to link, and what may be worth promoting.
- Knowledge reflections in \`Reflections/Knowledge/\`.
- Daily import activity reports in \`${REPORT_DIR}/\`.

## Consolidation Rules

- Raw source notes remain the system of record for imports unless you intentionally archive or delete them.
- Consolidated notes are the working notes you should read and use.
- Each consolidated note links back to the raw source material.
- Where possible, SAiM links people, projects, and source notes automatically.

## Reading Order

When a new import arrives:

1. Check the daily import activity report.
2. Open the consolidated note in its working folder.
3. Use the raw source note only when you need the original detail.

## Trusted Knowledge

When a consolidated note contains something durable, promote it into \`Knowledge/\` so SAiM can reuse it as trusted context rather than re-deriving it from raw imports.
`;
}

function ensureVaultOperatingModelDoc() {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const fullPath = path.join(vault, VAULT_MODEL_DOC);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, operatingModelMarkdown(), 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'vault-operating-model'); } catch {}
  return { status: 'ok', path: VAULT_MODEL_DOC };
}

function buildPromotedBody({ source, title, domain }) {
  const sourceFm = source.frontmatter || {};
  const sourceLinks = parseCsvField(sourceFm.knowledge_sources);
  if (!sourceLinks.includes(source.path)) sourceLinks.unshift(source.path);

  const frontmatter = renderFrontmatter({
    type: 'knowledge',
    knowledge_state: 'distilled',
    knowledge_domain: domain,
    source: 'nuero',
    source_notes: sourceLinks,
    promoted_from: source.path,
    promoted_at: isoNow()
  });

  const summaryType = sourceFm.summary_type ? `Summary type: ${sourceFm.summary_type}\n` : '';
  return `${frontmatter}

# ${title}

## Signal

${source.excerpt || 'Promoted from raw memory for curation.'}

## Why This Matters

- Add the durable point SAiM should remember.
- Capture the decision, pattern, or principle here.

## Actions / Decisions

- 

## Source Trace

- Origin: [[${source.path.replace(/\.md$/, '')}|${source.name}]]
${summaryType ? `- ${summaryType.trim()}\n` : ''}`;
}

function updateSourceFrontmatter(source, fields) {
  let content = source.content;
  for (const [key, value] of Object.entries(fields)) {
    content = upsertFrontmatterValue(content, key, value);
  }
  const fullPath = path.join(VAULT_PATH(), source.path);
  fs.writeFileSync(fullPath, content, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'knowledge-promotion'); } catch {}
}

function promoteCandidate({ sourcePath, domain, title }) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  if (!sourcePath) return { status: 'error', error: 'sourcePath required' };

  const sourceFull = path.join(vault, sourcePath);
  if (!fs.existsSync(sourceFull)) return { status: 'error', error: `Source note not found: ${sourcePath}` };

  const source = readNoteMeta(sourceFull);
  const finalDomain = sanitizeSegment(domain || inferDomainFromSource(source.path));
  const finalTitle = sanitizeSegment(title || source.name);
  const folder = path.join(vault, 'Knowledge', finalDomain);
  fs.mkdirSync(folder, { recursive: true });

  let fileBase = `${isoDate()} ${finalTitle}`;
  let filename = `${fileBase}.md`;
  let targetFull = path.join(folder, filename);
  let counter = 2;
  while (fs.existsSync(targetFull)) {
    filename = `${fileBase} ${counter}.md`;
    targetFull = path.join(folder, filename);
    counter += 1;
  }

  const content = buildPromotedBody({ source, title: finalTitle, domain: finalDomain });
  fs.writeFileSync(targetFull, content, 'utf-8');

  try { vaultHooks.onVaultWrite(targetFull, 'knowledge-promotion'); } catch {}
  updateSourceFrontmatter(source, {
    knowledge_promoted_to: toRel(targetFull),
    saim_consolidated_to: toRel(targetFull)
  });

  return {
    status: 'ok',
    sourcePath,
    promotedPath: toRel(targetFull),
    domain: finalDomain,
    title: finalTitle
  };
}

/**
 * One line saying why a candidate is worth distilling.
 *
 * Shared by the Monday reflection note so the note and the Insights card cannot come
 * to describe the same candidate differently — the `describeCandidateSource` rule.
 * Falls back to the excerpt only when the note has no structure to read.
 */
function candidateSummaryLine(candidate) {
  const signal = candidate.signal;
  if (!signal) return candidate.excerpt;
  const parts = [];
  if (signal.headline) parts.push(signal.headline);
  if (signal.conclusion) parts.push(signal.conclusion);
  return parts.length ? parts.join(' — ') : candidate.excerpt;
}

function generateReflection({ topic, write = false } = {}) {
  const overview = {
    weekly: weeklySummary.summarizeWeek({}),
    gaps: knowledgeGaps.findKnowledgeGaps({ topic, daysBack: 90 }),
    candidates: getPromotionCandidates({ topic, limit: 5, daysBack: 21 }),
    trusted: loadTrustedNotes().slice(0, 5)
  };

  const lines = [];
  lines.push(`# Knowledge Reflection — ${isoDate()}`);
  lines.push('');
  lines.push(`_Generated by NUERO on ${isoNow()}._`);
  lines.push('');

  if (overview.weekly.status === 'ok') {
    lines.push('## Weekly Signal');
    lines.push(`- Meetings: ${overview.weekly.counts.meetings}`);
    lines.push(`- Plan updates: ${overview.weekly.counts.planProgress}`);
    lines.push(`- Open actions in window: ${overview.weekly.counts.actionsOutstanding}`);
    lines.push('');
  }

  lines.push('## Promote Next');
  if (overview.candidates.length === 0) {
    lines.push('- No obvious promotion candidates right now.');
  } else {
    for (const candidate of overview.candidates) {
      lines.push(`- [[${candidate.path.replace(/\.md$/, '')}|${candidate.name}]] — ${candidateSummaryLine(candidate)}`);
    }
  }
  lines.push('');

  lines.push('## Trusted Context To Revisit');
  if (overview.trusted.length === 0) {
    lines.push('- No trusted knowledge notes yet.');
  } else {
    for (const note of overview.trusted) {
      lines.push(`- [[${note.path.replace(/\.md$/, '')}|${note.name}]] — ${note.excerpt}`);
    }
  }
  lines.push('');

  lines.push('## Knowledge Gaps');
  if (overview.gaps.status !== 'ok' || !(overview.gaps.suggestions || []).length) {
    lines.push('- No obvious gaps surfaced.');
  } else {
    for (const gap of overview.gaps.suggestions.slice(0, 5)) {
      lines.push(`- ${gap.topic} (${gap.count} mentions)`);
    }
  }

  const markdown = lines.join('\n');

  if (!write) {
    return { status: 'ok', markdown };
  }

  const vault = VAULT_PATH();
  const folder = path.join(vault, REFLECTION_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const filename = `${isoDate()} - Knowledge Reflection.md`;
  const fullPath = path.join(folder, filename);
  fs.writeFileSync(fullPath, markdown, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'knowledge-reflection'); } catch {}

  return { status: 'ok', markdown, path: toRel(fullPath) };
}

function getTranscriptInsight(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const transcriptProcessor = require('./transcript-processor');
    return transcriptProcessor.getLastResult(path.basename(transcriptPath));
  } catch {
    return null;
  }
}

// ⚠ This grouping is why Plaud consolidation runs on 2 recordings out of 222.
//
// It pairs a recording's summary with its transcript by `plaud_id`, and only
// considers notes under `Plaud/`. That was true when both halves lived there.
// Summaries are now ROUTED OUT to `Meetings/YYYY/MM/` — 222 notes there carry a
// `plaud_id` — so nearly every group ends up transcript-only and is dropped by
// the `some(note_type === 'summary')` filter below. Silent: a pipeline that
// processes 2 items looks identical to one with nothing to do.
//
// Widening it to key on `plaud_id` wherever the note lives is a DECISION, not a
// bug fix: the consolidated note lands in `Meetings/YYYY/MM/` — the same folder
// as the summary it was built from — so switching this on writes ~222 notes,
// each one sitting beside the note it consolidates, at 30 an hour. Hence a flag,
// default OFF, so the measurement and a sample can be taken without the
// scheduler acting on it.
const CONSOLIDATE_ALL_PLAUD = String(process.env.PLAUD_CONSOLIDATE_ALL || '').toLowerCase() === 'true';

function groupPlaudNotes(rawNotes, { includeRouted = CONSOLIDATE_ALL_PLAUD } = {}) {
  const groups = new Map();
  const inScope = (item) =>
    item.path.startsWith('Plaud/') || (includeRouted && Boolean(item.frontmatter.plaud_id));

  for (const note of rawNotes.filter(inScope)) {
    const plaudId = normalizePlaudId(note.frontmatter.plaud_id) || note.path;
    if (!groups.has(plaudId)) {
      groups.set(plaudId, {
        id: plaudId,
        type: 'plaud',
        notes: [],
        title: note.frontmatter.title || note.name
      });
    }
    groups.get(plaudId).notes.push(note);
  }
  return [...groups.values()].map((group) => {
    group.notes.sort((a, b) => a.path.localeCompare(b.path));
    // ⚠ `parseFrontmatter` does NOT strip surrounding quotes, and plaud-sync
    // writes `note_type: "summary"` quoted — so a bare `=== 'summary'` compares
    // against the string `"summary"` INCLUDING the quotes and is false for every
    // note the sync has ever written. `normalizePlaudId` in this same file already
    // strips them, which is why grouping by id worked while the summary/transcript
    // split silently did not. Same helper, applied to the same problem.
    group.summary = group.notes.find((note) => cleanQuoted(note.frontmatter.note_type) === 'summary') || group.notes[0];
    group.transcript = group.notes.find((note) => cleanQuoted(note.frontmatter.note_type) === 'transcript') || null;
    group.transcriptInsight = group.transcript ? getTranscriptInsight(group.transcript.path) : null;
    return group;
  }).filter((group) => group.notes.some((note) => cleanQuoted(note.frontmatter.note_type) === 'summary'));
}

async function resolveImportClassification(note) {
  const existing = db.getImportClassification(note.path);
  if (existing?.destination) return existing;

  const fullPath = path.join(VAULT_PATH(), note.path);
  if (!fs.existsSync(fullPath)) return null;

  try {
    return await importsService.classifyFile(fullPath);
  } catch {
    return null;
  }
}

async function collectImportItems() {
  return collectImportItemsWithOptions({});
}

async function collectImportItemsWithOptions({ includeConsolidatedPlaud = false } = {}) {
  const rawNotes = loadRawNotes();
  const items = [];

  for (const group of groupPlaudNotes(rawNotes)) {
    if (!includeConsolidatedPlaud && group.notes.every((note) => note.consolidatedTo)) continue;
    items.push(group);
  }

  for (const note of rawNotes.filter((item) => item.path.startsWith('Imports/'))) {
    if (note.consolidatedTo) continue;
    if (String(note.frontmatter.status || '').toLowerCase() === 'processed') continue;
    const classification = await resolveImportClassification(note);
    items.push({
      id: note.path,
      type: 'import',
      note,
      notes: [note],
      classification
    });
  }

  return items;
}

function destinationRootForItem(item) {
  if (item.type === 'plaud') return 'Meetings/';
  const destination = normalizePath(item.classification?.destination || '');
  return destination ? `${destination.replace(/\/?$/, '/')}` : 'Conflicts/';
}

function buildConsolidatedFolder(item) {
  const note = item.summary || item.note;
  const { year, month } = noteDateParts(note);
  const root = destinationRootForItem(item);
  const sourceChannel = item.type === 'plaud' ? 'Plaud' : 'Imports';

  if (item.type === 'plaud') return `Meetings/${year}/${month}`;

  if (root.startsWith('Meetings/')) return `Meetings/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Calls/')) return `Calls/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('People/')) return `People/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Projects/')) return `Projects/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Areas/')) return `Areas/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Ideas/')) return `Ideas/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Decision Log/')) return `Decision Log/Imported/${sourceChannel}/${year}/${month}`;
  if (root.startsWith('Reflections/')) return `Reflections/Imported/${sourceChannel}/${year}/${month}`;
  return `Conflicts/Imported/${sourceChannel}/${year}/${month}`;
}

function baseTitleForItem(item) {
  const note = item.summary || item.note;
  const title = item.type === 'plaud'
    ? item.transcript?.frontmatter.title
      || item.title
      || item.summary?.name
      || note.name
    : note.frontmatter.title || note.name;
  return sanitizeSegment(title, 'Imported Note');
}

function consolidatedFrontmatter(item, targetPath, aiInsight = null, sourceHash = '') {
  const note = item.summary || item.note;
  const sourceNotes = item.notes.map((source) => source.path);
  const frontmatter = {
    type: item.type === 'plaud' ? 'meeting' : 'import-consolidated',
    source: 'saim-import-consolidation',
    managed_by: 'saim-knowledge-memory',
    knowledge_state: 'distilled',
    knowledge_domain: inferDomainFromSource(targetPath),
    consolidated_at: isoNow(),
    source_notes: sourceNotes,
    import_origin: item.type === 'plaud' ? 'plaud' : 'imports',
    import_destination_root: destinationRootForItem(item)
  };

  if (item.type === 'plaud' && item.summary?.frontmatter.plaud_id) {
    frontmatter.plaud_id = normalizePlaudId(item.summary.frontmatter.plaud_id);
  }
  if (sourceHash) frontmatter.saim_ai_source_hash = sourceHash;
  if (aiInsight?.provider) frontmatter.saim_ai_provider = aiInsight.provider;
  if (aiInsight?.generatedAt) frontmatter.saim_ai_enriched_at = aiInsight.generatedAt;
  return renderFrontmatter(frontmatter);
}

function peopleLinksFromInsight(insight) {
  if (!insight?.people?.length) return [];
  return insight.people
    .map((person) => person.vaultMatch || person.mentioned)
    .filter(Boolean)
    .map((name) => `[[People/${sanitizeSegment(name)}|${name}]]`);
}

async function buildConsolidatedBody(item, targetPath, aiInsight = null) {
  const note = item.summary || item.note;
  const insight = item.transcriptInsight || null;
  const existingPath = path.join(VAULT_PATH(), targetPath);
  const existingContent = fs.existsSync(existingPath) ? fs.readFileSync(existingPath, 'utf-8') : '';
  const preservedManualNotes = extractMarkdownSection(existingContent, 'Manual Notes');
  const structuredSummary = item.type === 'plaud'
    ? extractPlaudMeetingMarkdown(item.summary, baseTitleForItem(item))
    : '';
  const sourceHash = aiInsight?.sourceHash || hashItemSources(item);
  const body = [];
  body.push(consolidatedFrontmatter(item, targetPath, aiInsight, sourceHash));
  body.push('');
  body.push(`# ${baseTitleForItem(item)}`);
  body.push('');
  if (structuredSummary) {
    body.push('## Meeting Brief');
    body.push('');
    body.push(structuredSummary);
    body.push('');
  } else {
    body.push('## Working Summary');
    body.push('');
    body.push(insight?.summary || note.excerpt || 'Imported note awaiting manual refinement.');
    body.push('');
  }

  if (insight?.keyTopics?.length && !hasMarkdownHeading(structuredSummary, 'Key Topics')) {
    body.push('## Key Topics');
    body.push('');
    for (const topic of insight.keyTopics) body.push(`- ${topic}`);
    body.push('');
  }

  if (insight?.actionItems?.length && !hasMarkdownHeading(structuredSummary, 'Action Items')) {
    body.push('## Action Items');
    body.push('');
    for (const action of insight.actionItems) body.push(`- [ ] ${action}`);
    body.push('');
  }

  const peopleLinks = peopleLinksFromInsight(insight);
  if (peopleLinks.length && !hasMarkdownHeading(structuredSummary, 'Attendees') && !hasMarkdownHeading(structuredSummary, 'People')) {
    body.push('## People');
    body.push('');
    for (const person of peopleLinks) body.push(`- ${person}`);
    body.push('');
  }

  if (item.classification?.reason) {
    body.push('## Routing Reason');
    body.push('');
    body.push(item.classification.reason);
    body.push('');
  }

  if (aiInsight && !aiInsight.skipped) {
    body.push('## SAiM Insight');
    body.push('');
    body.push(aiInsight.summary || 'SAiM reviewed the import and found no stronger synthesis worth writing yet.');
    body.push('');

    if (aiInsight.durableInsights?.length) {
      body.push('## Durable Insights');
      body.push('');
      for (const itemText of aiInsight.durableInsights) body.push(`- ${itemText}`);
      body.push('');
    }

    if (aiInsight.openLoops?.length) {
      body.push('## Open Loops');
      body.push('');
      for (const itemText of aiInsight.openLoops) body.push(`- ${itemText}`);
      body.push('');
    }

    if (aiInsight.promotionCandidates?.length) {
      body.push('## Promote Next');
      body.push('');
      for (const itemText of aiInsight.promotionCandidates) body.push(`- ${itemText}`);
      body.push('');
    }

    if (aiInsight.suggestedLinks?.length) {
      body.push('## Suggested Links');
      body.push('');
      for (const link of aiInsight.suggestedLinks) {
        body.push(`- ${markdownLinkForPath(link.path, link.label)}${link.term ? ` — surfaced from "${link.term}"` : ''}`);
      }
      body.push('');
    }

    if (aiInsight.filingNote) {
      body.push('## Filing Note');
      body.push('');
      body.push(aiInsight.filingNote);
      body.push('');
    }
  }

  body.push('## Source Material');
  body.push('');
  for (const source of item.notes) {
    body.push(`- [[${source.path.replace(/\.md$/, '')}|${source.name}]]`);
  }
  body.push('');
  body.push('## Source Snapshot');
  body.push('');
  body.push(note.excerpt);
  body.push('');
  body.push('## Manual Notes');
  body.push('');
  body.push(preservedManualNotes || '_Add your own interpretation, decisions, and follow-up here. SAiM will preserve this section on refresh._');

  return obsidian.autoLink(`${body.join('\n').trimEnd()}\n`);
}

function existingConsolidatedTarget(item) {
  const targetPath = item.notes.find((note) => note.consolidatedTo)?.consolidatedTo || null;
  if (!targetPath || item.type !== 'plaud') return targetPath;

  const fullPath = path.join(VAULT_PATH(), targetPath);
  if (!fs.existsSync(fullPath)) return null;

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const frontmatter = obsidian.parseFrontmatter(content);
    const targetPlaudId = normalizePlaudId(frontmatter.plaud_id);
    const currentPlaudId = normalizePlaudId(item.summary?.frontmatter.plaud_id || item.id);
    return targetPlaudId && targetPlaudId === currentPlaudId ? targetPath : null;
  } catch {
    return null;
  }
}

function makeConsolidatedFilename(item) {
  const note = item.summary || item.note;
  const { iso } = noteDateParts(note);
  return `${iso} - ${baseTitleForItem(item)}.md`;
}

function logConsolidationActivity({ dateKey, item, targetPath, mode }) {
  db.logActivity('import_consolidated', {
    targetPath,
    mode,
    kind: item.type,
    sourcePaths: item.notes.map((note) => note.path),
    destinationRoot: destinationRootForItem(item)
  }, dateKey);
}

function upsertSourceConsolidation(item, targetPath) {
  for (const source of item.notes) {
    updateSourceFrontmatter(source, {
      saim_consolidated_to: targetPath,
      knowledge_promoted_to: targetPath,
      import_status: 'consolidated'
    });
  }
}

async function writeConsolidatedNote(item) {
  const vault = VAULT_PATH();
  const existing = existingConsolidatedTarget(item);
  let targetPath = existing || `${buildConsolidatedFolder(item)}/${makeConsolidatedFilename(item)}`;
  let fullPath = path.join(vault, targetPath);

  if (!existing) {
    const parsed = path.parse(fullPath);
    let counter = 2;
    while (fs.existsSync(fullPath)) {
      try {
        const current = obsidian.parseFrontmatter(fs.readFileSync(fullPath, 'utf-8'));
        const currentPlaudId = normalizePlaudId(current.plaud_id);
        const wantedPlaudId = normalizePlaudId(item.summary?.frontmatter.plaud_id || item.id);
        if (!wantedPlaudId || currentPlaudId === wantedPlaudId) break;
      } catch {}

      targetPath = `${toRel(parsed.dir)}/${parsed.name} ${counter}${parsed.ext}`;
      fullPath = path.join(vault, targetPath);
      counter += 1;
    }
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const existingContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
  const aiInsight = await buildAiInsight(item, targetPath, existingContent);
  const content = await buildConsolidatedBody(item, targetPath, aiInsight);
  const mode = fs.existsSync(fullPath) ? 'updated' : 'created';
  fs.writeFileSync(fullPath, content, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'import-consolidation'); } catch {}
  try { require('./vault-logger').logCreate(targetPath, `import-consolidation:${item.type}`); } catch {}
  upsertSourceConsolidation(item, targetPath);
  logConsolidationActivity({ dateKey: isoDate(), item, targetPath, mode });
  if (aiInsight && !aiInsight.skipped) {
    db.logActivity('import_ai_enriched', {
      targetPath,
      kind: item.type,
      provider: aiInsight.provider || 'unknown',
      sourcePaths: item.notes.map((note) => note.path)
    }, isoDate());
  }
  return {
    targetPath,
    mode,
    ai: aiInsight
      ? {
          enriched: !aiInsight.skipped,
          cached: !!aiInsight.skipped,
          provider: aiInsight.provider || 'unknown'
        }
      : {
          enriched: false,
          cached: false,
          provider: 'none'
        }
  };
}

function buildDailyImportReport(dateKey = isoDate()) {
  const events = db.getActivityForDate(dateKey);
  const consolidations = events
    .filter((event) => event.event_type === 'import_consolidated')
    .map((event) => {
      let data = {};
      try { data = JSON.parse(event.event_data || '{}'); } catch {}
      return data;
    });
  const sweeps = events
    .filter((event) => event.event_type === 'imports_sweep')
    .map((event) => {
      let data = {};
      try { data = JSON.parse(event.event_data || '{}'); } catch {}
      return data;
    });
  const enrichments = events
    .filter((event) => event.event_type === 'import_ai_enriched')
    .map((event) => {
      let data = {};
      try { data = JSON.parse(event.event_data || '{}'); } catch {}
      return data;
    });
  const fileEnrichments = getAiEnrichmentNotesForDate(dateKey);
  const mergedEnrichments = enrichments.length > 0
    ? enrichments
    : fileEnrichments.map((item) => ({
        targetPath: item.path,
        provider: item.provider
      }));

  const lines = [];
  lines.push(`# SAiM Import Activity — ${dateKey}`);
  lines.push('');
  lines.push(`_Generated ${isoNow()}._`);
  lines.push('');

  const routed = sweeps.reduce((sum, sweep) => sum + (sweep.routed || 0), 0);
  const flagged = sweeps.reduce((sum, sweep) => sum + (sweep.flagged || 0), 0);
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Consolidated notes: ${consolidations.length}`);
  lines.push(`- AI enrichments: ${mergedEnrichments.length}`);
  lines.push(`- Import routes: ${routed}`);
  lines.push(`- Needs review: ${flagged}`);
  lines.push('');

  lines.push('## AI Enrichment');
  lines.push('');
  if (mergedEnrichments.length === 0) {
    lines.push('- No AI enrichment recorded today.');
  } else {
    for (const item of mergedEnrichments) {
      lines.push(`- Enriched [[${String(item.targetPath || '').replace(/\.md$/, '')}]] via ${item.provider || 'unknown'}`);
    }
  }
  lines.push('');

  lines.push('## Consolidated Notes');
  lines.push('');
  if (consolidations.length === 0) {
    lines.push('- No consolidated notes recorded today.');
  } else {
    for (const item of consolidations) {
      const sources = (item.sourcePaths || []).map((source) => `\`${source}\``).join(', ');
      lines.push(`- ${item.mode === 'updated' ? 'Updated' : 'Created'} [[${String(item.targetPath || '').replace(/\.md$/, '')}]] from ${sources}`);
    }
  }
  lines.push('');

  lines.push('## Review Queue');
  lines.push('');
  if (flagged === 0) {
    lines.push('- No imports flagged for review today.');
  } else {
    lines.push(`- ${flagged} import(s) still need review in \`Imports/\`.`);
  }

  return lines.join('\n');
}

function writeDailyImportReport(dateKey = isoDate()) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const folder = path.join(vault, REPORT_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const targetPath = `${REPORT_DIR}/${dateKey}.md`;
  const fullPath = path.join(vault, targetPath);
  fs.writeFileSync(fullPath, `${buildDailyImportReport(dateKey)}\n\n_Part of [[Logs]]_\n`, 'utf-8');
  try { vaultHooks.onVaultWrite(fullPath, 'import-daily-report'); } catch {}
  return { status: 'ok', path: targetPath, markdown: buildDailyImportReport(dateKey) };
}

async function consolidateAllImports({ limit = 25, includeConsolidatedPlaud = false } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  ensureVaultOperatingModelDoc();
  const items = await collectImportItemsWithOptions({ includeConsolidatedPlaud });
  const processed = [];

  for (const item of items.slice(0, limit)) {
    if (item.type === 'import' && item.classification?.type === 'needs-review') continue;
    const result = await writeConsolidatedNote(item);
    processed.push({
      kind: item.type,
      targetPath: result.targetPath,
      mode: result.mode,
      sourcePaths: item.notes.map((note) => note.path),
      ai: result.ai
    });
  }

  const report = writeDailyImportReport(isoDate());
  return {
    status: 'ok',
    processedCount: processed.length,
    processed,
    reportPath: report.path || null
  };
}

async function reconcilePlaudRecording({ plaudId } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const normalizedPlaudId = normalizePlaudId(plaudId);
  if (!normalizedPlaudId) {
    return { status: 'error', error: 'plaudId required' };
  }

  const item = groupPlaudNotes(loadRawNotes()).find((group) => group.id === normalizedPlaudId);
  if (!item) {
    return { status: 'error', error: `Plaud recording not found in vault: ${normalizedPlaudId}` };
  }

  const result = await writeConsolidatedNote(item);
  return {
    status: 'ok',
    plaudId: normalizedPlaudId,
    targetPath: result.targetPath,
    mode: result.mode,
    sourcePaths: item.notes.map((note) => note.path)
  };
}

async function refreshAllPlaudConsolidations({ limit = 500 } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  ensureVaultOperatingModelDoc();
  const items = await collectImportItemsWithOptions({ includeConsolidatedPlaud: true });
  const plaudItems = items.filter((item) => item.type === 'plaud').slice(0, limit);
  const processed = [];

  for (const item of plaudItems) {
    const result = await writeConsolidatedNote(item);
    processed.push({
      plaudId: item.id,
      targetPath: result.targetPath,
      mode: result.mode,
      sourcePaths: item.notes.map((note) => note.path),
      ai: result.ai
    });
  }

  const report = writeDailyImportReport(isoDate());
  return {
    status: 'ok',
    processedCount: processed.length,
    processed,
    reportPath: report.path || null
  };
}

async function enrichManagedNotes({ limit = 25 } = {}) {
  const vault = VAULT_PATH();
  if (!vault || !fs.existsSync(vault)) {
    return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };
  }

  const allNotes = [];
  for (const fullPath of walkMarkdown(vault)) {
    try {
      allNotes.push(readNoteMeta(fullPath));
    } catch {}
  }
  const candidates = allNotes
    .filter((note) => legacy.matchesValue(cleanQuoted(note.frontmatter.managed_by), 'saim-knowledge-memory')
      || legacy.matchesValue(cleanQuoted(note.frontmatter.source), 'saim-import-consolidation'))
    .filter((note) => !note.path.startsWith('Archive/'))
    .sort((a, b) => new Date(b.modified) - new Date(a.modified))
    .slice(0, limit);

  const processed = [];
  for (const note of candidates) {
    const aiInsight = await buildAiInsightForExistingNote(note);
    if (!aiInsight || aiInsight.skipped) {
      processed.push({
        path: note.path,
        ai: {
          enriched: false,
          cached: !!aiInsight?.skipped,
          provider: aiInsight?.provider || 'none'
        }
      });
      continue;
    }

    let content = note.content;
    content = upsertFrontmatterValue(content, 'saim_ai_source_hash', aiInsight.sourceHash);
    content = upsertFrontmatterValue(content, 'saim_ai_provider', aiInsight.provider || 'unknown');
    content = upsertFrontmatterValue(content, 'saim_ai_enriched_at', aiInsight.generatedAt || isoNow());
    content = insertAiSections(content, aiInsight);

    const fullPath = path.join(vault, note.path);
    fs.writeFileSync(fullPath, content, 'utf-8');
    try { vaultHooks.onVaultWrite(fullPath, 'knowledge-ai-enrichment'); } catch {}
    db.logActivity('import_ai_enriched', {
      targetPath: note.path,
      kind: 'managed-note',
      provider: aiInsight.provider || 'unknown',
      sourcePaths: [note.path]
    }, isoDate());

    processed.push({
      path: note.path,
      ai: {
        enriched: true,
        cached: false,
        provider: aiInsight.provider || 'unknown'
      }
    });
  }

  const report = writeDailyImportReport(isoDate());
  return {
    status: 'ok',
    processedCount: processed.filter((item) => item.ai.enriched).length,
    processed,
    reportPath: report.path || null
  };
}

module.exports = {
  RAW_FOLDERS,
  TRUSTED_ROOTS,
  getOverview,
  getPromotionCandidates,
  // Pure, exported so the judgements pin without a vault (the pi-health.assess split).
  scorePromotionCandidate,
  candidateTimestamp,
  extractSectionFlexible,
  recentReflections,
  promotionSignal,
  isSummaryNote,
  isTranscriptNote,
  indexSummariesByRecording,
  supersedingSummary,
  candidateSummaryLine,
  getActiveContext,
  promoteCandidate,
  generateReflection,
  consolidateAllImports,
  reconcilePlaudRecording,
  refreshAllPlaudConsolidations,
  enrichManagedNotes,
  buildDailyImportReport,
  writeDailyImportReport,
  ensureVaultOperatingModelDoc
};
