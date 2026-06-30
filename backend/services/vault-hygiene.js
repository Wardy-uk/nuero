/**
 * vault-hygiene.js — NEURO's ongoing vault-hygiene engine.
 *
 * Productionises the throwaway Scripts/_*.js prototypes (proven against the live
 * vault on 2026-06-29) into reusable, deterministic capabilities:
 *
 *   lint(root)                 — read-only health scan (broken links, orphans, …)
 *   contextualLinkPlan(root)   — propose [[wikilinks]] for genuine prose mentions
 *   contextualLinkApply(root)  — append idempotent "## Mentioned" blocks (backed up)
 *   aliasSuggest(root)         — propose People aliases for near-match name variants
 *
 * Design rules baked in (see the build handoff §2–§3):
 *  - Read-only by default; every mutating op backs up touched files and is idempotent.
 *  - Append-only — never overwrite or delete a note, never edit YAML frontmatter.
 *  - Match FULL NAMES only for contextual linking; bare first-names mislink.
 *  - Strip wikilinks / code / paths before matching prose.
 *  - Resolve path-form links ([[People/X|X]]) when deduping.
 *  - Skip names that map to >1 person.
 *  - Exclude generated output (Vault Audit, backups, Archive…) so scans don't self-pollute.
 *
 * Pure CommonJS, no server deps — every entry point takes the vault root, so it
 * runs both inside the NEURO backend and standalone via `node` for validation.
 */

const fs = require('fs');
const path = require('path');

// ── Constants ───────────────────────────────────────────────────────────────

// Directories never scanned (handoff §2.5). Excludes generated reports + backups
// so the engine is deterministic and never links to its own output.
const EXCLUDE_DIRS = new Set([
  '.git', '.obsidian', '.trash', '.stfolder', '.claude', '.lint-backups',
  'Archive', 'Templates', 'Scripts', 'Conflicts', 'node_modules', 'Vault Audit',
]);

const REPORT_REL = ['Documents', 'System', 'Vault Audit'];
const BACKUP_REL = ['Scripts', '.lint-backups'];

const STALE_DAYS = 120;

// Roots scanned for contextual linking (prose-heavy areas). Configurable.
const DEFAULT_CTX_ROOTS = ['Meetings', 'Reflections', 'Calls', 'Decision Log'];

// Project/MOC keyword → link. Proven defaults; override via lint-config.json.
const DEFAULT_PROJECT_LINKS = [
  { kw: '\\bNOVA\\b', flags: '', link: 'MOC - NOVA' },
  { kw: '\\bNEURO\\b', flags: 'i', link: 'NEURO' },
  { kw: '\\bAttractor\\b', flags: 'i', link: 'Attractor Programme Methodology' },
  { kw: '\\bQA System|AIQA\\b', flags: 'i', link: 'QA System V5' },
  { kw: '\\bSupport Hub\\b', flags: 'i', link: 'Support Hub' },
];

// Idempotency marker for the appended contextual-link block.
const CTX_MARKER = '<!-- ctx-links -->';

// ── Shared helpers ──────────────────────────────────────────────────────────

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function loadConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'Scripts', 'lint-config.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Recursively collect .md files, skipping EXCLUDE_DIRS and _about.md index notes.
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '_about.md') {
      acc.push(full);
    }
  }
  return acc;
}

// Loose YAML alias parse (inline [a, b] and list forms). No deps.
function parseAliases(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [];
  const block = fm[1];
  const out = [];
  const inline = block.match(/^\s*aliases?\s*:\s*\[(.*?)\]/m);
  if (inline) {
    inline[1].split(',').forEach((a) => {
      const v = a.trim().replace(/^["']|["']$/g, '');
      if (v) out.push(v);
    });
  }
  const listHeader = block.match(/^\s*aliases?\s*:\s*$/m);
  if (listHeader) {
    const lines = block.slice(block.indexOf(listHeader[0])).split(/\r?\n/).slice(1);
    for (const line of lines) {
      const m = line.match(/^\s*-\s*(.+)$/);
      if (!m) break;
      out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return out;
}

// Outgoing [[wikilink]] targets as basenames (ignores ![[embeds]]). For the link graph.
function extractLinks(text) {
  const links = [];
  const re = /(?<!!)\[\[([^\]]+?)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let target = m[1].split('|')[0].split('#')[0].trim();
    if (!target) continue; // pure heading/block ref
    if (target.includes('/')) target = target.split('/').pop();
    links.push(target.replace(/\.md$/i, ''));
  }
  return links;
}

// Set of everything already linked in a note (basename, path-form, and display
// alias), lowercased — so we never re-propose an existing link (handoff §3.3).
function linkedSet(raw) {
  const s = new Set();
  for (const m of raw.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const inner = m[1].split('|')[0].split('#')[0].trim();
    s.add(inner.toLowerCase());
    if (inner.includes('/')) s.add(inner.split('/').pop().toLowerCase());
    const disp = m[1].includes('|') ? m[1].split('|').pop().trim() : null;
    if (disp) s.add(disp.toLowerCase());
  }
  return s;
}

// Strip everything that isn't genuine prose before matching (handoff §3.2):
// fenced/inline code, wikilinks, _(path)_ refs, and bare path.md tokens.
function cleanProse(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/_\([^)]*\)_/g, ' ')
    .replace(/\([^)]*\.md[^)]*\)/g, ' ')
    .replace(/[\w./-]+\.md\b/g, ' ');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A short context snippet around a match index, for autonomy cards.
function snippet(text, idx, len) {
  return text.slice(Math.max(0, idx - 40), idx + len + 40).replace(/\s+/g, ' ').trim();
}

// Build the People roster: FULL NAMES only (handoff §3.1), with a name→count map
// so ambiguous names mapping to >1 person are skipped (handoff §3.4).
function buildPeopleIndex(root) {
  const peopleDir = path.join(root, 'People');
  const people = [];
  const nameCount = new Map();
  if (!fs.existsSync(peopleDir)) return { people, nameCount };
  for (const f of fs.readdirSync(peopleDir)) {
    if (!f.endsWith('.md') || f === '_about.md') continue;
    const base = f.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(peopleDir, f), 'utf8');
    const names = [base, ...parseAliases(text)].filter((n) => n.includes(' ')); // full names only
    if (!names.length) continue;
    people.push({ base, names });
    for (const n of names) nameCount.set(n.toLowerCase(), (nameCount.get(n.toLowerCase()) || 0) + 1);
  }
  return { people, nameCount };
}

function projectMatchers(config) {
  const src = Array.isArray(config.projectLinks) && config.projectLinks.length
    ? config.projectLinks
    : DEFAULT_PROJECT_LINKS;
  return src.map((p) => ({ re: new RegExp(p.kw, p.flags || ''), link: p.link }));
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

// Compute the contextual-link proposals for one note's raw content. Returns
// [{ link, via, why }]. Shared by plan (cards) and apply so they never diverge.
function proposeContextualLinks(raw, people, nameCount, projects) {
  const body = raw.replace(/^---[\s\S]*?---/, '');
  const linked = linkedSet(raw);
  const prose = cleanProse(body);
  const props = [];
  const seen = new Set();
  for (const p of people) {
    if (linked.has(p.base.toLowerCase()) || seen.has(p.base)) continue;
    for (const nm of p.names) {
      if (nameCount.get(nm.toLowerCase()) > 1) continue;      // ambiguous → skip
      if (linked.has(nm.toLowerCase())) continue;             // already linked via alias
      const m = new RegExp('\\b' + escapeRe(nm) + '\\b', 'i').exec(prose);
      if (m) {
        const isAlias = nm.toLowerCase() !== p.base.toLowerCase();
        seen.add(p.base);
        props.push({ link: p.base, via: isAlias ? ` (alias "${nm}")` : '', why: snippet(prose, m.index, nm.length) });
        break;
      }
    }
  }
  for (const pr of projects) {
    if (seen.has(pr.link) || linked.has(pr.link.toLowerCase())) continue;
    const m = pr.re.exec(prose);
    if (m) {
      seen.add(pr.link);
      props.push({ link: pr.link, via: '', why: snippet(prose, m.index, m[0].length) });
    }
  }
  return props;
}

// ── Capability: lint (read-only) ────────────────────────────────────────────

/**
 * Read-only vault health scan. Writes a single dated report; touches nothing else.
 * @returns {{ scanned, broken, orphans, underlinkedPeople, stale, reportPath }}
 */
function lint(root, { write = true } = {}) {
  const config = loadConfig(root);
  const expectedOrphanDirs = config.expectedOrphanDirs || [];
  const staleDays = config.staleDays || STALE_DAYS;

  const files = walk(root);
  const notes = new Map();        // path -> { base, aliases, outgoing, inCount, mtime }
  const resolveIndex = new Map(); // lowercased base/alias -> path

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const base = path.basename(file, '.md');
    const aliases = parseAliases(text);
    const stat = fs.statSync(file);
    notes.set(file, { base, aliases, outgoing: extractLinks(text), inCount: 0, mtime: stat.mtime });
    resolveIndex.set(base.toLowerCase(), file);
    for (const a of aliases) resolveIndex.set(a.toLowerCase(), file);
  }

  const broken = [];
  const brokenSeen = new Set(); // dedup distinct (from → target) pairs
  for (const [file, n] of notes) {
    const seen = new Set();
    for (const target of n.outgoing) {
      const hit = resolveIndex.get(target.toLowerCase());
      if (hit) {
        if (hit !== file && !seen.has(hit)) { notes.get(hit).inCount += 1; seen.add(hit); }
      } else {
        const fromRel = rel(root, file);
        const key = `${fromRel} ${target}`;
        if (!brokenSeen.has(key)) { brokenSeen.add(key); broken.push({ from: fromRel, target }); }
      }
    }
  }

  const orphans = [];
  const underlinkedPeople = [];
  const stale = [];
  const now = Date.now();
  for (const [file, n] of notes) {
    const r = rel(root, file);
    const hasOut = n.outgoing.length > 0;
    const hasIn = n.inCount > 0;
    if (!hasOut && !hasIn && !expectedOrphanDirs.some((d) => r.startsWith(d + '/'))) orphans.push(r);
    if (r.startsWith('People/') && !hasOut) underlinkedPeople.push(r);
    const ageDays = (now - n.mtime.getTime()) / 86400000;
    if (ageDays > staleDays) stale.push({ path: r, days: Math.round(ageDays) });
  }

  orphans.sort();
  underlinkedPeople.sort();
  stale.sort((a, b) => b.days - a.days);
  broken.sort((a, b) => a.from.localeCompare(b.from));

  let reportPath = null;
  if (write) reportPath = writeLintReport(root, { scanned: notes.size, broken, orphans, underlinkedPeople, stale, staleDays });

  return { scanned: notes.size, broken, orphans, underlinkedPeople, stale, reportPath };
}

function writeLintReport(root, { scanned, broken, orphans, underlinkedPeople, stale, staleDays }) {
  const today = todayStr();
  const L = [];
  L.push('---', 'type: reference', `created: ${today}`, 'tags: [vault, lint, audit]', 'author: NEURO vault-hygiene', '---');
  L.push(`# Vault Lint Report — ${today}`, '');
  L.push(`Scanned **${scanned}** notes (excluding ${[...EXCLUDE_DIRS].join(', ')}).`, '');
  L.push('| Check | Count |', '|---|---|');
  L.push(`| Broken links | ${broken.length} |`);
  L.push(`| Orphans (no links in or out) | ${orphans.length} |`);
  L.push(`| Under-linked People notes | ${underlinkedPeople.length} |`);
  L.push(`| Stale (> ${staleDays} days) | ${stale.length} |`, '');

  L.push('## Broken links');
  if (!broken.length) L.push('> [!success] None — every wikilink resolves.');
  else { L.push('> [!bug] These `[[targets]]` resolve to no note or alias. Fix the link or create the note.', ''); for (const b of broken) L.push(`- \`${b.from}\` → \`[[${b.target}]]\``); }
  L.push('');

  L.push('## Orphans');
  if (!orphans.length) L.push('> [!success] None.');
  else { L.push('> [!warning] Disconnected notes — no inbound or outbound links. Link them in or archive.', ''); for (const o of orphans) L.push(`- [[${path.basename(o, '.md')}]] — \`${o}\``); }
  L.push('');

  L.push('## Under-linked People');
  if (!underlinkedPeople.length) L.push('> [!success] Every People note links out.');
  else { L.push('> [!info] People notes with no outgoing links — add their team, manager, projects, meetings.', ''); for (const p of underlinkedPeople) L.push(`- [[${path.basename(p, '.md')}]] — \`${p}\``); }
  L.push('');

  L.push('## Stale');
  if (!stale.length) L.push('> [!success] Nothing past the staleness threshold.');
  else { L.push(`> [!note] Untouched > ${staleDays} days. Informational — review only if these should be live.`, ''); for (const s of stale.slice(0, 50)) L.push(`- \`${s.path}\` — ${s.days} days`); if (stale.length > 50) L.push(`- …and ${stale.length - 50} more`); }
  L.push('', '---', '_Generated by NEURO `vault-hygiene` (lint). Read-only scan; this report is the only file written._');

  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Lint Report ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  return rel(root, outPath);
}

// ── Capability: contextual link — plan (read-only) ──────────────────────────

/**
 * Propose contextual [[wikilinks]] for genuine prose mentions of roster People /
 * Projects. Read-only — writes a dated cards report (unless write:false).
 * @returns {{ scanned, notesTouched, total, byRoot, perNote, reportPath }}
 */
function contextualLinkPlan(root, { roots = DEFAULT_CTX_ROOTS, write = true } = {}) {
  const config = loadConfig(root);
  const { people, nameCount } = buildPeopleIndex(root);
  const projects = projectMatchers(config);

  let scanned = 0;
  let total = 0;
  const byRoot = {};
  const perNote = [];

  for (const r of roots) {
    for (const file of walk(path.join(root, r))) {
      scanned++;
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.includes(CTX_MARKER)) continue; // already processed
      const props = proposeContextualLinks(raw, people, nameCount, projects);
      if (props.length) {
        total += props.length;
        byRoot[r] = (byRoot[r] || 0) + props.length;
        perNote.push({ rel: rel(root, file), props });
      }
    }
  }

  perNote.sort((a, b) => a.rel.localeCompare(b.rel));

  let reportPath = null;
  if (write) reportPath = writeCtxPlanReport(root, { scanned, total, byRoot, perNote });

  return { scanned, notesTouched: perNote.length, total, byRoot, perNote, reportPath };
}

function writeCtxPlanReport(root, { scanned, total, byRoot, perNote }) {
  const today = todayStr();
  const L = [`# Contextual-Linking Plan — DRY RUN (${today})`, ''];
  L.push(`**${total} proposed links across ${perNote.length} notes** (scanned ${scanned}). By area: ${Object.entries(byRoot).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
  L.push('', 'Full names + genuine prose mentions only (wikilinks/paths/code stripped). Nothing written. Approve, then run apply.', '', '');
  for (const n of perNote) {
    L.push(`## ${n.rel}`);
    for (const x of n.props) L.push(`- **[[${x.link}]]**${x.via} — "…${x.why}…"`);
    L.push('');
  }
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Contextual Linking Plan ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  return rel(root, outPath);
}

// ── Capability: contextual link — apply (append-only, backed up) ────────────

/**
 * Append an idempotent "## Mentioned" block of contextual links to each note.
 * Backs up every touched file, writes a changelog, never overwrites/deletes.
 * @param {object} opts
 * @param {string[]} [opts.only]  Restrict to these note rel-paths (approved set).
 *                                Omit to apply every proposal.
 * @returns {{ notesDone, totalLinks, backupDir, changelogPath, applied }}
 */
function contextualLinkApply(root, { roots = DEFAULT_CTX_ROOTS, only = null } = {}) {
  const config = loadConfig(root);
  const { people, nameCount } = buildPeopleIndex(root);
  const projects = projectMatchers(config);
  const onlySet = only ? new Set(only) : null;

  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);

  const applied = [];
  let totalLinks = 0;

  for (const r of roots) {
    for (const file of walk(path.join(root, r))) {
      const relPath = rel(root, file);
      if (onlySet && !onlySet.has(relPath)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.includes(CTX_MARKER)) continue; // idempotent
      const props = proposeContextualLinks(raw, people, nameCount, projects);
      if (!props.length) continue;

      // Backup, then append-only.
      const bk = path.join(backupDir, relPath);
      ensureDir(path.dirname(bk));
      fs.copyFileSync(file, bk);

      const links = props.map((p) => p.link);
      let out = raw.endsWith('\n') ? raw : raw + '\n';
      out += `\n${CTX_MARKER}\n## Mentioned\n${links.map((l) => `- [[${l}]]`).join('\n')}\n`;
      fs.writeFileSync(file, out, 'utf8');

      applied.push({ rel: relPath, links });
      totalLinks += links.length;
    }
  }

  const changelogPath = writeCtxApplyChangelog(root, { applied, totalLinks, backupDir });
  return { notesDone: applied.length, totalLinks, backupDir: rel(root, backupDir), changelogPath, applied };
}

function writeCtxApplyChangelog(root, { applied, totalLinks, backupDir }) {
  const today = todayStr();
  const L = [`# Contextual Links Applied — ${today}`, ''];
  L.push(`Applied **${totalLinks} links across ${applied.length} notes**. Append-only (## Mentioned block). Backups: \`${rel(root, backupDir)}\`.`, '');
  for (const a of applied) L.push(`- \`${a.rel}\` (+${a.links.length}): ${a.links.map((l) => `[[${l}]]`).join(', ')}`);
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Contextual Links Applied ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  return rel(root, outPath);
}

// ── Capability: fix (plan + tiered apply) ───────────────────────────────────

// Aggressive normalisation for title matching (en/em dashes, quotes, punctuation).
const norm = (s) => s.toLowerCase()
  .replace(/[–—]/g, '-').replace(/[’‘'`]/g, "'")
  .replace(/[^a-z0-9]+/g, ' ').trim();

function bigrams(s) { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; }
function dice(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

const TIER_RANK = { skip: 0, conservative: 1, moderate: 2, aggressive: 3 };

// Build the link-resolution model: active notes + a separate Archive index so we
// can tell "target only exists in Archive" apart from "missing everywhere".
function buildFixModel(root) {
  const config = loadConfig(root);
  const cfg = {
    expectedOrphanDirs: config.expectedOrphanDirs || ['Daily', 'Documents/System/SARA Import Reports'],
    fuzzyModerate: config.fuzzyModerate || 0.85,
    fuzzyAggressive: config.fuzzyAggressive || 0.70,
  };
  const active = walk(root);                                   // EXCLUDE_DIRS skips Archive
  const archiveDir = path.join(root, 'Archive');
  const archive = fs.existsSync(archiveDir) ? walk(archiveDir) : [];

  const notes = new Map();
  const resolveIndex = new Map();    // normalized base/alias -> path (active)
  const normBaseToPaths = new Map(); // normalized base -> [active paths]
  const archiveIndex = new Map();    // normalized base -> archive path

  for (const f of active) {
    const text = fs.readFileSync(f, 'utf8');
    const base = path.basename(f, '.md');
    const aliases = parseAliases(text);
    notes.set(f, { base, aliases, outgoing: extractLinks(text), inCount: 0 });
    const nb = norm(base);
    resolveIndex.set(nb, f);
    if (!normBaseToPaths.has(nb)) normBaseToPaths.set(nb, []);
    normBaseToPaths.get(nb).push(f);
    for (const a of aliases) resolveIndex.set(norm(a), f);
  }
  for (const f of archive) { const nb = norm(path.basename(f, '.md')); if (!archiveIndex.has(nb)) archiveIndex.set(nb, f); }

  for (const [f, n] of notes) {
    const seen = new Set();
    for (const t of n.outgoing) {
      const hit = resolveIndex.get(norm(t));
      if (hit && hit !== f && !seen.has(hit)) { notes.get(hit).inCount++; seen.add(hit); }
    }
  }
  return { cfg, notes, resolveIndex, normBaseToPaths, archiveIndex };
}

/**
 * Classify every broken link / orphan into tiered, approvable fix actions.
 * Read-only. Writes a Fix Plan note + machine plan (Scripts/.lint-plan.json).
 */
function fixPlan(root, { write = true } = {}) {
  const { cfg, notes, resolveIndex, normBaseToPaths, archiveIndex } = buildFixModel(root);
  const activeBaseNorms = [...normBaseToPaths.keys()];

  const linkFixes = [];
  const archived = [];
  const missing = [];

  for (const [f, n] of notes) {
    const seenTargets = new Set();
    for (const t of n.outgoing) {
      const nt = norm(t);
      if (resolveIndex.has(nt)) continue;
      const dedupKey = `${rel(root, f)} ${nt}`;
      if (seenTargets.has(dedupKey)) continue;
      seenTargets.add(dedupKey);

      const exact = normBaseToPaths.get(nt);
      if (exact && exact.length === 1) {
        linkFixes.push({ from: rel(root, f), oldTarget: t, newBase: path.basename(exact[0], '.md'), sim: 1, tier: 'conservative' });
        continue;
      }
      let best = null, bestSim = 0, ties = 0;
      for (const nb of activeBaseNorms) {
        const s = dice(nt, nb);
        if (s > bestSim) { bestSim = s; best = nb; ties = 1; }
        else if (s === bestSim) ties++;
      }
      if (best && ties === 1 && bestSim >= cfg.fuzzyAggressive) {
        const cand = normBaseToPaths.get(best);
        if (cand && cand.length === 1) {
          const tier = bestSim >= cfg.fuzzyModerate ? 'moderate' : 'aggressive';
          linkFixes.push({ from: rel(root, f), oldTarget: t, newBase: path.basename(cand[0], '.md'), sim: +bestSim.toFixed(3), tier });
          continue;
        }
      }
      if (archiveIndex.has(nt)) { archived.push({ from: rel(root, f), oldTarget: t, archivePath: rel(root, archiveIndex.get(nt)) }); continue; }
      missing.push({ from: rel(root, f), oldTarget: t });
    }
  }

  const expected = [], people = [], content = [];
  for (const [f, n] of notes) {
    if (n.outgoing.length || n.inCount) continue;
    const r = rel(root, f);
    if (cfg.expectedOrphanDirs.some((d) => r.startsWith(d + '/'))) expected.push(r);
    else if (r.startsWith('People/')) people.push(r);
    else content.push(r);
  }

  const summary = {
    links: {
      conservative: linkFixes.filter((x) => x.tier === 'conservative').length,
      moderate: linkFixes.filter((x) => x.tier === 'moderate').length,
      aggressive: linkFixes.filter((x) => x.tier === 'aggressive').length,
    },
    archivedLinks: archived.length,
    archivedNotes: new Set(archived.map((a) => norm(a.oldTarget))).size,
    missing: missing.length,
    expectedOrphans: expected.length,
    peopleOrphans: people.length,
    contentOrphans: content.length,
  };

  const plan = { generated: new Date().toISOString(), cfg, summary, linkFixes, archived, missing, expected, people, content };

  let reportPath = null;
  if (write) {
    ensureDir(path.join(root, ...REPORT_REL));
    fs.writeFileSync(path.join(root, 'Scripts', '.lint-plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    reportPath = writeFixPlanReport(root, plan);
  }
  return { ...plan, reportPath };
}

function writeFixPlanReport(root, p) {
  const s = p.summary;
  const today = todayStr();
  const ex = (arr, n = 3) => arr.slice(0, n).map((x) => `\`${x.from ? x.from + ' → [[' + x.oldTarget + ']]' : x}\``).join('; ');
  const L = [];
  L.push('---', 'type: reference', `created: ${today}`, 'tags: [vault, lint, fix-plan]', 'author: NEURO vault-hygiene', '---');
  L.push(`# Vault Fix Plan — ${today}`, '');
  L.push('Each action offers autonomy tiers. Approve per action; apply runs only the chosen tier.', '');
  L.push('## Action 1 — Broken links: repoint to matching note');
  L.push(`- **Conservative** — repoint **${s.links.conservative}** links that exactly match one active note (zero ambiguity).`);
  L.push(`- **Moderate** — Conservative + **${s.links.moderate}** more via high-confidence fuzzy match (≥${p.cfg.fuzzyModerate}).`);
  L.push(`- **Aggressive** — Moderate + **${s.links.aggressive}** more via best-guess match (≥${p.cfg.fuzzyAggressive}); higher mislink risk — review-only by default.`);
  L.push(`  - e.g. ${ex(p.linkFixes)}`, '');
  L.push('## Action 2 — Broken links to archived notes');
  L.push('- **Conservative** — report only (leave links + Archive as-is).');
  L.push(`- **Moderate / Aggressive** — restore the **${s.archivedNotes}** archived notes behind **${s.archivedLinks}** links to their active folder.`);
  L.push(`  - e.g. ${ex(p.archived)}`, '');
  L.push('## Action 3 — Expected orphans (Daily, SARA reports)');
  L.push(`- **Moderate / Aggressive** — keep the **${s.expectedOrphans}** expected orphans suppressed from reports (config).`, '');
  L.push('## Action 4 — Orphan People notes');
  L.push(`- **${s.peopleOrphans}** People notes with no links — flagged for review (auto-link deferred).`, '');
  L.push('## Action 5 — Missing link targets (exist nowhere)');
  L.push(`- **Aggressive** — create **${s.missing}** stub notes in Imports/_NeedsReview/ so links resolve.`, '');
  L.push('## Content orphans (manual)');
  L.push(`- **${s.contentOrphans}** real notes with no links in/out — listed for you to link; not auto-actioned.`, '');
  if (p.content.length) for (const c of p.content.slice(0, 50)) L.push(`  - \`${c}\``);
  L.push('', '---', '_Generated by NEURO `vault-hygiene` (fix plan). Apply per-category with chosen tiers._');
  const outPath = path.join(root, ...REPORT_REL, `Fix Plan ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  return rel(root, outPath);
}

function repointInFile(root, absFile, edits, backupDir) {
  const bk = path.join(backupDir, rel(root, absFile));
  ensureDir(path.dirname(bk));
  fs.copyFileSync(absFile, bk);
  let text = fs.readFileSync(absFile, 'utf8');
  let changed = 0;
  for (const { oldTarget, newBase } of edits) {
    const re = new RegExp('\\[\\[' + escapeRe(oldTarget) + '(?=[\\]|#])', 'g');
    text = text.replace(re, () => { changed++; return '[[' + newBase; });
  }
  fs.writeFileSync(absFile, text, 'utf8');
  return changed;
}

/**
 * Apply fixes, gated per category by autonomy tier (skip|conservative|moderate|aggressive).
 * Surgical link edits / non-destructive restores only; backs up every touched file.
 * @param {object} flags  { links, archived, expected, missing }  (default each "skip")
 */
function fixApply(root, flags = {}) {
  const p = fixPlan(root, { write: false });
  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);
  const log = [`# Lint Fix Changelog — ${stamp}`, ''];
  const result = { repointed: 0, restored: 0, stubs: 0, expectedSuppressed: false };
  const touched = [];

  // Action 1 — link repoints (cumulative by tier)
  const lvl = TIER_RANK[flags.links || 'skip'] || 0;
  if (lvl >= 1) {
    const chosen = p.linkFixes.filter((x) => TIER_RANK[x.tier] <= lvl);
    const byFile = new Map();
    for (const x of chosen) {
      const abs = path.join(root, x.from);
      if (!byFile.has(abs)) byFile.set(abs, []);
      byFile.get(abs).push(x);
    }
    for (const [abs, edits] of byFile) { result.repointed += repointInFile(root, abs, edits, backupDir); touched.push(rel(root, abs)); }
    log.push(`## Repointed links (${flags.links}): ${result.repointed} across ${byFile.size} files`);
    for (const x of chosen) log.push(`- \`${x.from}\`: \`[[${x.oldTarget}]]\` → \`[[${x.newBase}]]\` (sim ${x.sim})`);
    log.push('');
  }

  // Action 3 — persist expected-orphan suppression (config already lists them; rewrite to canonicalise)
  if ((TIER_RANK[flags.expected || 'skip'] || 0) >= 2) {
    const cfgPath = path.join(root, 'Scripts', 'lint-config.json');
    const cfg = loadConfig(root);
    cfg.expectedOrphanDirs = p.cfg.expectedOrphanDirs;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    result.expectedSuppressed = true;
    log.push(`## Expected orphans suppressed via Scripts/lint-config.json (dirs: ${cfg.expectedOrphanDirs.join(', ')})`, '');
  }

  // Action 5 — stub missing targets (aggressive only)
  if ((TIER_RANK[flags.missing || 'skip'] || 0) >= 3) {
    const made = new Set();
    for (const m of p.missing) {
      const nb = norm(m.oldTarget);
      if (made.has(nb)) continue;
      made.add(nb);
      const dest = path.join(root, 'Imports', '_NeedsReview', m.oldTarget.replace(/[\\/:*?"<>|]/g, '-') + '.md');
      if (!fs.existsSync(dest)) {
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, `---\ntype: stub\ncreated: ${todayStr()}\nauthor: NEURO vault-hygiene\n---\n# ${m.oldTarget}\n\n> Stub created to resolve a dangling link. Fill in or merge.\n`, 'utf8');
      }
    }
    result.stubs = made.size;
    log.push(`## Created ${made.size} stub notes in Imports/_NeedsReview/`, '');
  }

  // Action 2 — restore archived target notes to active folders (non-destructive copy; never overwrite)
  if ((TIER_RANK[flags.archived || 'skip'] || 0) >= 2) {
    const ACTIVE_ROOTS = ['Meetings', 'People', 'Projects', 'Areas', 'Ideas', 'Reflections', 'Decision Log', 'Documents', 'Tasks', 'Team', 'Calls'];
    const destFor = new Map();
    for (const a of p.archived) {
      if (destFor.has(a.archivePath)) continue;
      const parts = a.archivePath.split('/');
      let idx = -1;
      for (let i = 0; i < parts.length; i++) if (ACTIVE_ROOTS.includes(parts[i])) { idx = i; break; }
      const destRel = idx >= 0 ? parts.slice(idx).join('/') : path.join('Meetings', '2026', path.basename(a.archivePath)).split(path.sep).join('/');
      destFor.set(a.archivePath, destRel);
    }
    let skipped = 0;
    for (const [archiveRel, destRel] of destFor) {
      const dest = path.join(root, destRel);
      if (fs.existsSync(dest)) { skipped++; continue; }
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, fs.readFileSync(path.join(root, archiveRel), 'utf8'), 'utf8');
      result.restored++;
      touched.push(destRel);
      log.push(`- restored \`${destRel}\``);
    }
    log.push(`## Restored ${result.restored} archived notes to active folders (${skipped} skipped: already present)`, '');
  }

  ensureDir(path.join(root, ...REPORT_REL));
  const changelogPath = path.join(root, ...REPORT_REL, `Lint Fix Changelog ${todayStr()}.md`);
  fs.writeFileSync(changelogPath, log.join('\n'), 'utf8');
  return { ...result, touched, backupDir: rel(root, backupDir), changelogPath: rel(root, changelogPath), people: p.people };
}

// ── Capability: alias suggest (read-only) ───────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiag = tmp;
    }
  }
  return prev[n];
}

function similarity(a, b) {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la === lb) return 1;
  const maxLen = Math.max(la.length, lb.length);
  return maxLen ? 1 - levenshtein(la, lb) / maxLen : 0;
}

/**
 * Scan the corpus for capitalised full-name pairs that closely match a roster
 * person but aren't an exact name/alias (e.g. "Abdi Mohammad" → Abdi Mohamed).
 * Read-only — proposes aliases for human approval; never edits frontmatter here.
 * @returns {{ suggestions, reportPath }}
 */
function aliasSuggest(root, { threshold = 0.82, write = true } = {}) {
  const { people } = buildPeopleIndex(root);
  const known = new Set();
  for (const p of people) for (const n of p.names) known.add(n.toLowerCase());

  const candidates = new Map(); // candidate -> { sample }
  const nameRe = /\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g;
  for (const file of walk(root)) {
    if (rel(root, file).startsWith('People/')) continue; // don't mine the roster itself
    const prose = cleanProse(fs.readFileSync(file, 'utf8').replace(/^---[\s\S]*?---/, ''));
    let m;
    while ((m = nameRe.exec(prose)) !== null) {
      const cand = m[1];
      if (known.has(cand.toLowerCase())) continue;
      if (!candidates.has(cand)) candidates.set(cand, { sample: snippet(prose, m.index, cand.length) });
    }
  }

  const suggestions = [];
  for (const [cand, meta] of candidates) {
    const matches = [];
    for (const p of people) {
      let best = 0;
      for (const n of p.names) best = Math.max(best, similarity(cand, n));
      if (best >= threshold && best < 1) matches.push({ person: p.base, score: best });
    }
    if (matches.length === 1) {
      suggestions.push({ candidate: cand, person: matches[0].person, score: Number(matches[0].score.toFixed(3)), sample: meta.sample });
    }
    // matches.length > 1 → ambiguous, skip (handoff §3.4)
  }
  suggestions.sort((a, b) => b.score - a.score);

  let reportPath = null;
  if (write) reportPath = writeAliasReport(root, suggestions);

  return { suggestions, reportPath };
}

function writeAliasReport(root, suggestions) {
  const today = todayStr();
  const L = [`# Alias Suggestions — DRY RUN (${today})`, ''];
  L.push(`${suggestions.length} candidate name variants closely matching a roster person (no exact match). Human-approve before adding to \`aliases:\`.`, '');
  if (!suggestions.length) L.push('> [!success] No near-match variants found.');
  for (const s of suggestions) {
    L.push(`- **${s.candidate}** → [[${s.person}]] _(score ${s.score})_  — "…${s.sample}…"`);
  }
  const dir = path.join(root, ...REPORT_REL);
  ensureDir(dir);
  const outPath = path.join(dir, `Alias Suggestions ${today}.md`);
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  return rel(root, outPath);
}

// ── Capability: connect orphans (append-only fallback) ──────────────────────

const HUB_MARKER = '<!-- hub-link -->';
const DAILY_NAV_MARKER = '<!-- daily-nav -->';

/**
 * Connect orphan content into the graph (a FALLBACK — prefer contextualLinkApply
 * for real density; this trades orphans for single-link leaves):
 *   A) NOVA orphans  → append "_Part of [[MOC - NOVA]]_"
 *   B) Daily notes   → append a prev/next nav chain
 * Append-only, backs up each touched file, idempotent (marker-guarded).
 */
function connectOrphans(root, { nova = true, daily = true } = {}) {
  const files = walk(root);
  const notes = new Map(), idx = new Map();
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    notes.set(f, { out: extractLinks(t), in: 0, text: t });
    idx.set(norm(path.basename(f, '.md')), f);
  }
  for (const [f, n] of notes) {
    const seen = new Set();
    for (const l of n.out) { const h = idx.get(norm(l)); if (h && h !== f && !seen.has(h)) { notes.get(h).in++; seen.add(h); } }
  }
  const isOrphan = (f) => { const n = notes.get(f); return n.out.length === 0 && n.in === 0; };

  const stamp = tsStamp();
  const backupDir = path.join(root, ...BACKUP_REL, stamp);
  const append = (f, block) => {
    const bk = path.join(backupDir, rel(root, f));
    ensureDir(path.dirname(bk));
    fs.copyFileSync(f, bk);
    let t = notes.get(f).text;
    if (!t.endsWith('\n')) t += '\n';
    fs.writeFileSync(f, t + block, 'utf8');
  };

  const log = [`# Connect Orphans Changelog — ${todayStr()}`, ''];
  let novaCount = 0, chainCount = 0;
  const touched = [];

  if (nova) {
    for (const f of files) {
      if (!rel(root, f).startsWith('Projects/NOVA/')) continue;
      if (!isOrphan(f)) continue;
      if (notes.get(f).text.includes('[[MOC - NOVA]]') || notes.get(f).text.includes(HUB_MARKER)) continue;
      append(f, `\n${HUB_MARKER}\n_Part of [[MOC - NOVA]]_\n`);
      novaCount++; touched.push(rel(root, f));
      log.push(`- NOVA link: \`${rel(root, f)}\``);
    }
  }

  if (daily) {
    const dre = /^(\d{4}-\d{2}-\d{2})\.md$/;
    const dailies = files
      .filter((f) => dre.test(path.basename(f)) && rel(root, f).startsWith('Daily/'))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    for (let i = 0; i < dailies.length; i++) {
      const f = dailies[i];
      if (notes.get(f).text.includes(DAILY_NAV_MARKER)) continue;
      const prev = i > 0 ? path.basename(dailies[i - 1], '.md') : null;
      const next = i < dailies.length - 1 ? path.basename(dailies[i + 1], '.md') : null;
      let nav;
      if (prev && next) nav = `_← [[${prev}]] | [[${next}]] →_`;
      else if (next) nav = `_[[${next}]] →_`;
      else if (prev) nav = `_← [[${prev}]]_`;
      else continue;
      append(f, `\n${DAILY_NAV_MARKER}\n${nav}\n`);
      chainCount++; touched.push(rel(root, f));
    }
  }

  log.push('', `## Linked ${novaCount} NOVA orphans to [[MOC - NOVA]]`, `## Chained ${chainCount} Daily notes (prev/next)`, '', `_Backups: \`${rel(root, backupDir)}\`. Appends only; no note overwritten or deleted._`);
  ensureDir(path.join(root, ...REPORT_REL));
  const changelogPath = path.join(root, ...REPORT_REL, `Connect Changelog ${todayStr()}.md`);
  fs.writeFileSync(changelogPath, log.join('\n'), 'utf8');
  return { nova: novaCount, daily: chainCount, touched, backupDir: rel(root, backupDir), changelogPath: rel(root, changelogPath) };
}

// ── Capability: graph config (.obsidian/graph.json) ─────────────────────────

// Canonical colour scheme by area (handoff §1.6). RGB ints are the proven 29 Jun values.
const CANONICAL_COLOR_GROUPS = [
  { query: 'path:"People/"', color: { a: 1, rgb: 3003583 } },   // teal
  { query: 'path:"Team/"', color: { a: 1, rgb: 3003583 } },     // teal
  { query: 'path:"Meetings/"', color: { a: 1, rgb: 3900150 } }, // blue
  { query: 'path:"Calls/"', color: { a: 1, rgb: 3900150 } },    // blue
  { query: 'path:"Daily/"', color: { a: 1, rgb: 2278750 } },    // green
  { query: 'path:"Ideas/"', color: { a: 1, rgb: 11032055 } },   // purple
  { query: 'path:"Reflections/"', color: { a: 1, rgb: 15485081 } }, // rose
  { query: 'path:"Decision Log/"', color: { a: 1, rgb: 15680580 } }, // red
  { query: 'path:"Projects/NOVA/"', color: { a: 1, rgb: 16347926 } }, // orange
  { query: 'path:"MOCs/"', color: { a: 1, rgb: 15119360 } },    // gold
];

/**
 * Manage .obsidian/graph.json. read returns the current config; apply backs up to
 * graph.json.bak-<date> then writes the canonical colour groups (preserving the
 * user's force/zoom settings unless overridden).
 * NOTE: Obsidian rewrites graph.json on close if the graph view is open — apply
 * while the graph is closed, or the change is lost.
 */
function graphConfig(root, { apply = false, display = {}, forces = {}, colorGroups = null } = {}) {
  const gpath = path.join(root, '.obsidian', 'graph.json');
  const current = fs.existsSync(gpath) ? JSON.parse(fs.readFileSync(gpath, 'utf8')) : {};
  if (!apply) {
    return { applied: false, colorGroups: current.colorGroups || [], config: current, warning: 'Obsidian overwrites graph.json on close if the graph view is open — close it before applying.' };
  }
  const backupPath = path.join(root, '.obsidian', `graph.json.bak-${todayStr()}`);
  if (fs.existsSync(gpath)) fs.copyFileSync(gpath, backupPath);
  const next = {
    ...current,
    colorGroups: colorGroups || CANONICAL_COLOR_GROUPS,
    ...display,
    ...forces,
  };
  fs.writeFileSync(gpath, JSON.stringify(next, null, 2), 'utf8');
  return { applied: true, backupPath: rel(root, backupPath), colorGroups: next.colorGroups, warning: 'Written. If the graph view was open in Obsidian, it may overwrite this on close — apply with the graph closed.' };
}

module.exports = {
  lint,
  contextualLinkPlan,
  contextualLinkApply,
  aliasSuggest,
  fixPlan,
  fixApply,
  connectOrphans,
  graphConfig,
  // exported for tests / reuse
  _internal: { walk, parseAliases, extractLinks, linkedSet, cleanProse, buildPeopleIndex, proposeContextualLinks, similarity, norm, dice, EXCLUDE_DIRS },
};
