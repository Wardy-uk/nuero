'use strict';

/**
 * Task context — PURE (22 Oct 2026).
 *
 * Decides which vault material is genuinely related to an open task, and says
 * WHY in words a person can check. No DB, no filesystem, no clock: the service
 * (task-context.js) reads the vault and the tasks, this file judges.
 *
 * The rules, and the reason each exists:
 *
 *  - EXPLICIT evidence pins on its own: the note the task was raised in, a note
 *    that names the task (`<!--task:N-->`, `task #N`), a note the task's own
 *    wording links to (`[[Note]]`). Each is a fact somebody wrote down.
 *  - A TITLE match pins only with independent support (the same project
 *    folder, a shared tag, or the body agreeing). A title alone is a
 *    suggestion — "Weekly Report" is a title many notes could carry.
 *  - BODY overlap alone is NEVER enough, at any score. Nick's notes share his
 *    vocabulary almost completely (support, ticket, team, customer…), which is
 *    why `task-dedupe`'s thresholds could not be inherited; here a token that
 *    appears in more than COMMON_DF_SHARE of notes carries no evidence at all.
 *  - A note that is restricted, employment-sensitive, personal (to a work
 *    task), machine-generated, a duplicate, ambiguous or unreadable is SKIPPED
 *    by the scan with a reason; it is never pinned or suggested. The only
 *    exception is the note a task was RAISED in — it is that task's own
 *    source, not an unrelated one — and even then a sensitive one is pinned
 *    `restricted`: title only, no preview.
 */

const path = require('path');

const CONTRACT = 'task-context-v1';
const SOURCE_TYPES = ['note', 'project', 'area'];
const ORIGINS = ['nightly-scan', 'manual', 'mcp'];
const STATES = ['pinned', 'suggested', 'stale', 'removed'];

const MAX_AUTO_PINS = 4;          // per task, notes found by the scan
const MAX_SUGGESTIONS = 5;        // per task
const MAX_SCOPE_ITEMS = 3;        // "most relevant within this project/area"
const COMMON_DF_SHARE = 0.15;     // a token in >15% of notes is not evidence
const BODY_BYTES = 16000;         // how much of a note is read for terms
const TITLE_CONTAINMENT = 0.75;   // share of the note title's distinctive tokens the task carries
const BODY_COVERAGE = 0.6;        // share of the task's distinctive weight the body carries
const MIN_TITLE_SHARED = 2;
const MIN_BODY_SHARED = 3;
const RECENT_DAYS = 30;

// Folders whose notes are never context by the SCAN, and why. Manual links may
// still reach most of them (Nick chose it); `refuseManual` marks the ones that
// are machine output with nothing worth pointing at.
const SCAN_SKIP_PREFIXES = [
  { prefix: 'Documents/System/', reason: 'generated', refuseManual: true },
  { prefix: 'Scripts/', reason: 'generated', refuseManual: true },
  // Weekly reviews (generated) beside hand-written journals, a carer's statement and an
  // HR review — personal by nature, so never pulled in automatically. Nick may link one.
  { prefix: 'Reflections/', reason: 'reflection' },
  { prefix: 'Tasks/', reason: 'generated' },          // the export, the capture log, the drop-box
  { prefix: 'Notion/', reason: 'generated' },         // a pulled mirror; the vault copy elsewhere is the source
  { prefix: 'Plaud/Transcripts/', reason: 'raw-transcript' }, // the summary in Meetings/ is the note of record
  { prefix: 'Daily/', reason: 'daily-note' },         // scratch + SAiM's own action log
  { prefix: 'People/', reason: 'person-note' },       // who someone is belongs to the People surface
  { prefix: 'MOCs/', reason: 'index-note' },          // a page of links, not context
  { prefix: 'Templates/', reason: 'generated', refuseManual: true },
  { prefix: 'Imports/', reason: 'unprocessed-import' },
];

const SKIP_SAY = {
  generated: 'machine-produced (reports, logs, exports, mirrors)',
  'raw-transcript': 'a raw transcript — its summary note is the one linked',
  'daily-note': 'a daily note',
  reflection: 'a reflection or journal entry',
  'person-note': 'a People note',
  'index-note': 'an index of links',
  'unprocessed-import': 'an unprocessed import',
  excluded: 'excluded from NEURO’s index (retired, infrastructure or generated)',
  security: 'in Security review/ (never used, never linked)',
  'opted-out': 'marked never-for-context in its own frontmatter',
  restricted: 'restricted (the Personal/ folder or marked private)',
  'employment-sensitive': 'about a named colleague’s employment',
  'other-domain': 'from the other half of life (work vs personal)',
  duplicate: 'a duplicate or sync-conflict copy',
  ambiguous: 'an untitled or generic note',
  unreadable: 'could not be read',
  empty: 'empty',
};

const GENERIC_TITLES = new Set(['untitled', 'summary', 'notes', 'note', 'new note', 'scratch', 'todo', 'tasks', 'draft', 'index', '_about', 'readme', 'meeting', 'meeting notes']);

const relNorm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
const titleOf = (rel) => path.posix.basename(relNorm(rel)).replace(/\.md$/i, '');

/** The project folder a vault path sits in, or null. */
function projectOf(rel) {
  const m = /^Projects\/([^/]+)\//.exec(relNorm(rel));
  if (!m || /^(archive|_archive)$/i.test(m[1]) || m[1].startsWith('_') || m[1].startsWith('.')) return null;
  return `Projects/${m[1]}`;
}
/** The area a vault path sits in (`Areas/X.md` or `Areas/X/…`), or null. */
function areaOf(rel) {
  const r = relNorm(rel);
  const m = /^Areas\/([^/]+)(\/|$)/.exec(r);
  if (!m) return null;
  const name = m[1].replace(/\.md$/i, '');
  if (!name || name.startsWith('_') || /^1-2-1 Tracker$/i.test(name)) return null;
  return `Areas/${name}`;
}

/** PURE. Frontmatter as flat strings, and the body after it. CRLF-safe. */
function splitNote(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { fm: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { fm: {}, body: src };
  const fm = {};
  let lastKey = null;
  for (const line of src.slice(4, end).split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) { lastKey = kv[1]; fm[kv[1]] = kv[2].trim(); continue; }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && lastKey) fm[lastKey] = fm[lastKey] ? `${fm[lastKey]}, ${item[1]}` : item[1];
  }
  return { fm, body: src.slice(end + 4).replace(/^\n/, '') };
}

/** PURE. Tags from frontmatter (`tags: [a, b]` or a block list) and #body tags. */
function tagsOf(fm, body) {
  const out = new Set();
  const raw = String((fm && (fm.tags || fm.tag)) || '').replace(/[[\]"']/g, '');
  for (const t of raw.split(/[,\s]+/)) if (t) out.add(t.replace(/^#/, '').toLowerCase());
  const re = /(^|\s)#([A-Za-z][A-Za-z0-9_/-]{2,})/g;
  let m;
  while ((m = re.exec(String(body || '')))) out.add(m[2].toLowerCase());
  return out;
}

/** PURE. `[[Target]]`, `[[Target|alias]]`, `[[Folder/Target#h]]` → lowercased basenames. */
function wikilinksOf(text) {
  const out = new Set();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(titleOf(m[1].trim()).toLowerCase());
  return out;
}

/** PURE. Task ids a note names explicitly. */
function taskRefsOf(text) {
  const out = new Set();
  const s = String(text || '');
  const res = [/<!--\s*(?:neuro-)?task:(\d+)\s*-->/g, /\btask\s*#(\d+)\b/gi, /\[task #(\d+)\]/gi];
  for (const re of res) { let m; while ((m = re.exec(s))) out.add(Number(m[1])); }
  return out;
}

/**
 * PURE. One short, safe line from a note: the first sentence of prose — not a
 * heading, a list of links, a checkbox, a table or a code fence.
 */
function previewOf(body) {
  let inFence = false;
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence || !line || line.startsWith('#') || line.startsWith('|') || line.startsWith('>') || line.startsWith('<!--')) continue;
    if (/^[-*]\s*\[[ xX]\]/.test(line)) continue;
    const text = line.replace(/^[-*]\s+/, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (text.length < 12 || /^(created|updated|tags?|date|owner|status)\s*:/i.test(text) || /^_?part of /i.test(text)) continue;
    return text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, '')}…` : text;
  }
  return null;
}

/** PURE. The note's own frontmatter says never use it as context. */
function optedOut(fm = {}) {
  return /^(exclude|never|off)$/i.test(String(fm.neuro_context || fm['neuro-context'] || '').trim());
}

const EXCERPT_MAX = 240;

function _cleanLine(raw) {
  return String(raw)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function _clip(text, max = EXCERPT_MAX) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * PURE. The ONE line of a note that ties it to this task — never a summary and never
 * surrounding text. It is taken from the note (markdown stripped, at most
 * EXCERPT_MAX characters, cut at a word) or it is null:
 *   1. a line carrying the task's own marker (`<!--task:N-->`, `task #N`);
 *   2. otherwise the line that carries most of the task's distinctive wording —
 *      at least MIN_EXCERPT_SHARED words and half of them, or nothing.
 * `tokenize` is the scan's own (task-dedupe's). Returns
 * { text, heading, line, basis: 'task-marker'|'task-wording', say } or null.
 */
const MIN_EXCERPT_SHARED = 2;
function taskExcerpt(body, task = {}, tokenize = null) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const id = Number(task.id);
  const marker = Number.isInteger(id) && id > 0 ? new RegExp(`<!--\\s*task:${id}\\s*-->|\\btask\\s*#${id}\\b`, 'i') : null;
  const want = tokenize && task.text ? new Set(tokenize(task.text)) : new Set();
  let heading = null; let inFence = false; let best = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence || !t || t.startsWith('|')) continue;
    const h = t.match(/^#{1,6}\s+(.+)$/);
    if (h) { heading = _cleanLine(h[1]).slice(0, 80) || null; continue; }
    const text = _cleanLine(raw);
    if (text.length < 8) continue;
    if (marker && marker.test(raw)) return { text: _clip(text), heading, line: i + 1, basis: 'task-marker', say: 'The line in this note that names this task.' };
    if (!want.size) continue;
    const got = new Set(tokenize(text));
    let shared = 0;
    for (const w of want) if (got.has(w)) shared += 1;
    const coverage = shared / want.size;
    if (shared >= MIN_EXCERPT_SHARED && coverage >= 0.5 && (!best || coverage > best.coverage)) {
      best = { coverage, out: { text: _clip(text), heading, line: i + 1, basis: 'task-wording', say: 'The line in this note this task’s wording comes from.' } };
    }
  }
  return best ? best.out : null;
}

const RESTRICTION_SAY = {
  security: 'It is in Security review/, which NEURO never shows.',
  excluded: 'It is in a folder NEURO never uses (archived, generated or excluded).',
  'opted-out': 'The note is marked never-for-context in its own frontmatter.',
  'personal-folder': 'It is in your Personal folder.',
  private: 'The note is marked private.',
  'employee-cases-note': 'Contains personnel-sensitive material — colleagues are named alongside absence, health, conduct or performance.',
  'hr-wording': 'Its title or wording is about an HR matter.',
  'pip-deliverable': 'It is part of a performance-plan deliverable.',
  'no-longer': 'It was restricted when it was linked; no restriction rule fires on it now, so it stays restricted until it is linked again.',
};

/**
 * PURE. Why a note is restricted, in words. `hard` = it must never be shown or linked
 * on ANY screen (Security review/, excluded folders, an opt-out). The screens are
 * injected (vault-exclusions and prepared-move's employment screen). An employment
 * screen that could not run counts as sensitive — never less restricted.
 */
/**
 * PURE. A HARD exclusion: never shown, never linked, on any screen. Security review/
 * always; an excluded folder (Archive, generated, infrastructure) — but NOT the
 * sensitive Personal/Private folders, which vault-exclusions also keeps out of
 * entity extraction: those are restricted, not hard (a task may still be raised in one).
 */
function isHardExcluded(rel, deps = {}) {
  const r = relNorm(rel);
  if (deps.isSecurityPath && deps.isSecurityPath(r)) return true;
  if (deps.isSensitivePath && deps.isSensitivePath(r)) return false;
  return Boolean(deps.isExcludedPath && deps.isExcludedPath(r));
}

function restrictionOf({ rel, fm = {}, body = '' }, deps = {}) {
  const r = relNorm(rel);
  if (deps.isSecurityPath && deps.isSecurityPath(r)) return { hard: true, codes: ['security'], say: RESTRICTION_SAY.security };
  if (isHardExcluded(r, deps)) return { hard: true, codes: ['excluded'], say: RESTRICTION_SAY.excluded };
  if (optedOut(fm)) return { hard: true, codes: ['opted-out'], say: RESTRICTION_SAY['opted-out'] };
  const codes = [];
  if (deps.isSensitivePath && deps.isSensitivePath(r)) codes.push('personal-folder');
  if (String(fm.private || '').toLowerCase() === 'true') codes.push('private');
  if (deps.employmentScreen) {
    let cats = null;
    try { const s = deps.employmentScreen({ sourceTitle: titleOf(r), sourceText: body }); cats = s && s.sensitive ? s.categories || [] : []; } catch { cats = ['employee-cases-note']; }
    for (const c of ['employee-cases-note', 'hr-wording', 'pip-deliverable']) if (cats.includes(c)) codes.push(c);
  }
  if (!codes.length) codes.push('no-longer');
  return { hard: false, codes, say: codes.map((c) => RESTRICTION_SAY[c]).join(' ') };
}

/** PURE. "Found automatically — this task was raised in this note." */
function provenanceLine(link) {
  const label = ORIGIN_LABEL[link.origin] || 'Linked';
  const rs = Array.isArray(link.reasons) ? link.reasons : [];
  const first = rs.find((r) => r.code !== 'recent') || rs[0];
  if (!first || !first.say) return `${label}.`;
  return `${label} — ${first.say.charAt(0).toLowerCase()}${first.say.slice(1)}`;
}

/**
 * PURE. May the SCAN use this note at all? Returns { ok, reason, restricted }.
 * `deps.isExcludedPath` / `isSensitivePath` / `noteDomain` / `employmentScreen`
 * are injected so this stays pure (the service passes vault-exclusions and
 * prepared-move's screen).
 */
function screenNote({ rel, fm = {}, body = '', readable = true }, deps = {}) {
  const r = relNorm(rel);
  if (!readable) return { ok: false, reason: 'unreadable' };
  // HARD exclusions first, and deliberately NOT `restricted`: a restricted note can
  // still be pinned as a task's own source (title only), and these must never be
  // linked at all (23 Oct 2026). Security review/ sits inside isSensitivePath, so
  // it has to be decided before that check, not by it.
  if (deps.isSecurityPath && deps.isSecurityPath(r)) return { ok: false, reason: 'security' };
  if (optedOut(fm)) return { ok: false, reason: 'opted-out' };
  if (deps.isSensitivePath && deps.isSensitivePath(r)) return { ok: false, reason: 'restricted', restricted: true };
  if (String(fm.private || '').toLowerCase() === 'true') return { ok: false, reason: 'restricted', restricted: true };
  for (const s of SCAN_SKIP_PREFIXES) if (r.startsWith(s.prefix)) return { ok: false, reason: s.reason };
  if (deps.isExcludedPath && deps.isExcludedPath(r)) return { ok: false, reason: 'excluded' };
  // "X 2.md" is a duplicate only when "X.md" sits beside it — "Session 2.md" is a real note.
  if (/ 2\.md$/i.test(r) && deps.exists && deps.exists(r.replace(/ 2\.md$/i, '.md'))) return { ok: false, reason: 'duplicate' };
  if (r.includes('.sync-conflict-')) return { ok: false, reason: 'duplicate' };
  const t = titleOf(r).toLowerCase().replace(/[-_]+/g, ' ').trim();
  if (GENERIC_TITLES.has(t) || /^untitled( \d+)?$/.test(t) || /^\d{4}-\d{2}-\d{2}( \d{6})?$/.test(t) || /^neuro-\d+$/.test(t)) return { ok: false, reason: 'ambiguous' };
  if (!String(body || '').trim()) return { ok: false, reason: 'empty' };
  if (deps.employmentScreen) {
    const s = deps.employmentScreen({ sourceTitle: titleOf(r), sourceText: body });
    if (s && s.sensitive) return { ok: false, reason: 'employment-sensitive', restricted: true };
  }
  return { ok: true, reason: null };
}

/**
 * PURE. A note as the matcher sees it. `tokenize` is injected (task-dedupe's,
 * so "plan"/"planning" fold the same way here as in de-duplication).
 */
function indexNote({ rel, text, mtimeMs = null, hash = null }, tokenize) {
  const { fm, body } = splitNote(text);
  const r = relNorm(rel);
  const head = body.slice(0, BODY_BYTES);
  const headings = (head.match(/^#{1,4}\s+.+$/gm) || []).join(' ');
  return {
    rel: r,
    title: titleOf(r),
    fm,
    body,
    titleTokens: tokenize(titleOf(r)),
    bodyTokens: tokenize(`${headings}\n${head}`),
    tags: tagsOf(fm, head),
    wikilinks: wikilinksOf(head),
    taskRefs: taskRefsOf(body),
    project: projectOf(r),
    area: areaOf(r),
    domain: String(fm.domain || '').toLowerCase() === 'personal' ? 'personal' : null,
    mtimeMs,
    hash,
    preview: previewOf(body),
  };
}

/** PURE. Document frequency over the eligible notes; the common set carries no evidence. */
function corpusStats(notes, tokenize = null) {
  const df = new Map();
  for (const n of notes) {
    const seen = new Set([...n.titleTokens, ...n.bodyTokens]);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = Math.max(1, notes.length);
  const common = new Set();
  for (const [t, c] of df) if (notes.length >= 20 && c / N > COMMON_DF_SHARE) common.add(t);
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
  return { df, N, common, idf, tokenize };
}

/** PURE. A task as the matcher sees it. */
function indexTask(task, tokenize, { projectLinks = [] } = {}) {
  const text = String(task.text || '');
  return {
    id: Number(task.id),
    text,
    tokens: tokenize(text.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')),
    originPath: task.origin_path ? relNorm(task.origin_path) : null,
    project: (task.origin_path && projectOf(task.origin_path)) || null,
    linkedProjects: new Set(projectLinks),
    area: (task.origin_path && areaOf(task.origin_path)) || null,
    wikilinks: wikilinksOf(text),
    tags: new Set((text.match(/(^|\s)#([A-Za-z][A-Za-z0-9_-]{2,})/g) || []).map((s) => s.trim().slice(1).toLowerCase())),
    domain: task.domain === 'personal' ? 'personal' : 'work',
  };
}

const distinct = (set, stats) => [...set].filter((t) => !stats.common.has(t));

// Words that say what KIND of document a note is, not what it is about. A title
// "Triage Checklist Draft" is about triage checklists; "draft" must not count
// against the match. Stemmed with the same tokenizer as everything else.
const DOC_WORDS = ['draft', 'drafts', 'notes', 'note', 'summary', 'overview', 'document', 'doc', 'wip', 'final', 'copy', 'minutes', 'agenda', 'v1', 'v2', 'version'];
function docWords(stats) {
  if (!stats._docWords) stats._docWords = new Set(stats.tokenize ? DOC_WORDS.flatMap((w) => [...stats.tokenize(w)]) : DOC_WORDS);
  return stats._docWords;
}

/**
 * PURE. Does this note belong with this task? Returns null (nothing), or
 * { level: 'pin'|'suggest', confidence, reasons: [{code, say}] }.
 */
function scoreNote(task, note, stats, nowMs = Date.now()) {
  const reasons = [];
  let strong = false;
  if (task.originPath && note.rel === task.originPath) { strong = true; reasons.push({ code: 'origin', say: 'This task was raised in this note.' }); }
  if (note.taskRefs.has(task.id)) { strong = true; reasons.push({ code: 'task-ref', say: `This note refers to task #${task.id}.` }); }
  if (task.wikilinks.has(note.title.toLowerCase())) { strong = true; reasons.push({ code: 'wikilink', say: 'The task links to this note.' }); }

  const titleDistinct = distinct(note.titleTokens, stats).filter((t) => !docWords(stats).has(t));
  const taskDistinct = distinct(task.tokens, stats);
  const titleShared = titleDistinct.filter((t) => task.tokens.has(t));
  // A one-word distinctive title must be a RARE word (in at most two notes), or
  // "Roadmap" matches every roadmap task; otherwise two shared and 75% of it.
  const titleHit = titleDistinct.length === 1
    ? titleShared.length === 1 && (stats.df.get(titleDistinct[0]) || 0) <= 2
    : titleShared.length >= MIN_TITLE_SHARED && titleShared.length / Math.max(1, titleDistinct.length) >= TITLE_CONTAINMENT;
  if (titleHit) reasons.push({ code: 'title', say: `Its title matches the task (${titleShared.slice(0, 4).join(', ')}).` });

  let bodyHit = false;
  if (taskDistinct.length >= MIN_BODY_SHARED) {
    const shared = taskDistinct.filter((t) => note.bodyTokens.has(t));
    const total = taskDistinct.reduce((s, t) => s + stats.idf(t), 0);
    const got = shared.reduce((s, t) => s + stats.idf(t), 0);
    if (shared.length >= MIN_BODY_SHARED && total > 0 && got / total >= BODY_COVERAGE) {
      bodyHit = true;
      reasons.push({ code: 'body', say: `It discusses the same things (${shared.slice(0, 4).join(', ')}).` });
    }
  }
  const sameProject = Boolean(note.project && (note.project === task.project || task.linkedProjects.has(note.project)));
  if (sameProject) reasons.push({ code: 'project', say: `Same project: ${note.project.slice('Projects/'.length)}.` });
  const tagHit = [...note.tags].some((t) => t.length >= 4 && (task.tags.has(t) || task.tokens.has(t)) && !stats.common.has(t));
  if (tagHit) reasons.push({ code: 'tag', say: 'It carries a tag the task names.' });
  const recent = note.mtimeMs != null && nowMs - note.mtimeMs <= RECENT_DAYS * 86400000;

  let level = null;
  let confidence = 0;
  if (strong) { level = 'pin'; confidence = 0.95; }
  else if (titleHit && (sameProject || tagHit || bodyHit)) { level = 'pin'; confidence = 0.8 + (sameProject ? 0.05 : 0) + (bodyHit ? 0.03 : 0); }
  else if (titleHit) { level = 'suggest'; confidence = 0.6; }
  else if (bodyHit && (sameProject || tagHit)) { level = 'suggest'; confidence = 0.5 + (sameProject ? 0.05 : 0); }
  if (!level) return null;
  if (recent) { confidence += 0.01; reasons.push({ code: 'recent', say: 'Updated in the last month.' }); }
  return { level, confidence: Math.min(0.99, Math.round(confidence * 100) / 100), reasons };
}

/**
 * PURE. Names of projects/areas the task's WORDING names, whole-word. A name
 * must be at least two words, or one word of 4+ letters; both kept so a scan
 * can ask rather than guess when more than one fits.
 */
function namedScopes(taskText, scopes) {
  const raw = String(taskText || '');
  const text = ` ${raw.toLowerCase().replace(/[^a-z0-9&]+/g, ' ')} `;
  const out = [];
  for (const s of scopes) {
    const name = String(s.name || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
    if (!name) continue;
    if (name.split(' ').length < 2 && name.length < 4) continue;
    if (!text.includes(` ${name} `)) continue;
    // ⚠ One word: only an acronym the vault writes in capitals (NOVA, NEURO) or a word
    // the task itself Capitalises ("in Nova"). Measured on the live vault: "a flexible
    // working request" otherwise named the Projects/Working drafts folder.
    if (name.split(' ').length === 1) {
      const acronym = /^[A-Z0-9]+$/.test(String(s.name));
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const capitalised = [...raw.matchAll(new RegExp(`(?:^|[^A-Za-z0-9])(${esc})(?=[^A-Za-z0-9]|$)`, 'gi'))]
        .some((m) => /[A-Z]/.test(m[1][0]));
      if (!acronym && !capitalised) continue;
    }
    out.push(s);
  }
  return out;
}

/** PURE. Rank the notes inside one project/area for this task (title/body only). */
function scopeItems(task, notes, scopeRef, stats) {
  const inScope = notes.filter((n) => n.project === scopeRef || n.area === scopeRef || n.rel === `${scopeRef}.md`);
  const scored = inScope.map((n) => {
    const shared = distinct(task.tokens, stats).filter((t) => n.titleTokens.has(t) || n.bodyTokens.has(t));
    const s = shared.reduce((a, t) => a + stats.idf(t), 0);
    return { n, s, shared };
  }).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.n.mtimeMs || 0) - (a.n.mtimeMs || 0) || a.n.rel.localeCompare(b.n.rel));
  const pick = scored.length ? scored : inScope.map((n) => ({ n, s: 0, shared: [] })).sort((a, b) => (b.n.mtimeMs || 0) - (a.n.mtimeMs || 0));
  return pick.slice(0, MAX_SCOPE_ITEMS).map(({ n, shared }) => ({
    ref: n.rel, title: n.title,
    reason: shared.length ? `Mentions ${shared.slice(0, 3).join(', ')}.` : 'Most recently updated here.',
  }));
}

/**
 * PURE. Which open tasks a meeting touches: raised in a note the prep already shows,
 * or naming an attendee by FULL name (a first name alone is never evidence — two
 * Nathans). Origin matches first, then name matches; ids, deduplicated.
 */
function tasksForMeeting(tasks, { people = [], notePaths = new Set() } = {}) {
  const byOrigin = []; const byName = [];
  const names = people.filter((p) => String(p).trim().split(/\s+/).length >= 2).map((p) => new RegExp(`(^|[^A-Za-z])${String(p).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}([^A-Za-z]|$)`, 'i'));
  for (const t of tasks || []) {
    if (t.origin_path && notePaths.has(relNorm(t.origin_path))) byOrigin.push(t.id);
    else if (names.some((re) => re.test(String(t.text || '')))) byName.push(t.id);
  }
  return [...new Set([...byOrigin, ...byName])];
}

/** PURE. The one-line reason shown under a pinned item. */
function reasonLine(link) {
  const rs = Array.isArray(link.reasons) ? link.reasons : [];
  const first = rs.find((r) => r.code !== 'recent') || rs[0];
  if (link.origin === 'manual') return first ? `Linked by you. ${first.say}` : 'Linked by you.';
  if (link.origin === 'mcp') return first ? `Linked from a chat. ${first.say}` : 'Linked from a chat at your request.';
  return first ? first.say : 'Found by the nightly scan.';
}

const ORIGIN_LABEL = { 'nightly-scan': 'Found automatically', manual: 'Linked by you', mcp: 'Linked from a chat' };
const STALE_SAY = {
  gone: 'The note is no longer in the vault (moved or deleted).',
  'no-longer-matches': 'The note changed and no longer looks related.',
  excluded: 'The note is now somewhere NEURO doesn’t use for context.',
};

module.exports = {
  isHardExcluded,
  CONTRACT, SOURCE_TYPES, ORIGINS, STATES, MAX_AUTO_PINS, MAX_SUGGESTIONS, MAX_SCOPE_ITEMS,
  COMMON_DF_SHARE, SCAN_SKIP_PREFIXES, SKIP_SAY, ORIGIN_LABEL, STALE_SAY,
  relNorm, titleOf, projectOf, areaOf, splitNote, tagsOf, wikilinksOf, taskRefsOf, previewOf,
  screenNote, indexNote, corpusStats, indexTask, scoreNote, namedScopes, scopeItems, tasksForMeeting, reasonLine,
  optedOut, taskExcerpt, restrictionOf, provenanceLine, RESTRICTION_SAY, EXCERPT_MAX,
};
