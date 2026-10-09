'use strict';

/**
 * Build 24 — personal projects, the PURE half.
 *
 * A project is something Nick is intentionally trying to move forward. A repo
 * is evidence about a project, a vault note is evidence, a task is an action in
 * or around one, and a commit is evidence of progress — never proof of intent.
 * Nothing here touches the DB, the vault, the network or the clock: every
 * input is passed in, so each rule pins without a fixture world.
 *
 * Rules that decide the shape:
 *   • NOVA is WORK, by a hard rule (repo Wardy-uk/NOVA, vault Projects/NOVA).
 *     No other repo or project is work, or personal, because of its name, its
 *     owner or because it contains code. Unknown stays unknown.
 *   • Status comes from explicit statements (Nick, then the vault). The only
 *     derived status is `active`, and it needs recent MEANINGFUL progress plus
 *     a known sphere. Inactivity never yields parked, paused or abandoned, and
 *     completed always needs a statement.
 *   • Activity and meaningful progress are different facts and both are kept.
 *   • A repo links to a project only on explicit evidence (a URL or a local
 *     path in the project's notes, the NOVA rule, or Nick). A name that merely
 *     looks the same is `likely` and never drives anything.
 */

const STATUSES = Object.freeze(['active', 'paused', 'parked', 'blocked', 'completed', 'abandoned', 'unknown']);
const SPHERES = Object.freeze(['personal', 'work', 'other', 'unknown']);
const IMPORTANCE = Object.freeze(['high', 'normal', 'low']);

/** The one hard rule. Ids are GitHub's numeric id AND the full name, so a rename cannot slip it. */
const HARD_WORK = Object.freeze({
  repoFullNames: ['wardy-uk/nova'],
  repoIds: [1164021904],
  vaultFolders: ['nova'],
  why: 'NOVA is a work project (Nick, Build 24 brief, 8 Oct 2026)',
});

const ACTIVE_WINDOW_DAYS = 30;
const MAX_COMMITS = 60;
const MAX_ITEMS = 30;
const MAX_RELEASES = 10;
const MAX_DEPLOYMENTS = 10;
const SUBJECT_MAX = 140;

const DAY = 86400000;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s.slice(0, 10)));
const iso = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null);
const maxIso = (...xs) => xs.filter(Boolean).sort().slice(-1)[0] || null;

function slug(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}
/** Letters and digits only, lowercased — the one comparison used for `likely` name links. */
const compact = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// ── frontmatter + hub note ───────────────────────────────────────────────────

function parseFrontmatter(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { fm: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end < 0) return { fm: {}, body: src };
  const fm = {};
  let listKey = null;
  for (const line of src.slice(4, end).split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { fm[listKey].push(unquote(item[1])); continue; }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) { listKey = null; continue; }
    const key = kv[1].toLowerCase();
    const v = kv[2].trim();
    if (v === '') { fm[key] = []; listKey = key; continue; }
    listKey = null;
    if (v.startsWith('[') && v.endsWith(']')) fm[key] = v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
    else fm[key] = unquote(v);
  }
  return { fm, body: src.slice(end + 4).replace(/^\n/, '') };
}
function unquote(v) {
  const s = String(v).trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1).replace(/\\\\/g, '\\') : s;
}
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const stripMd = (s) => String(s || '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();

/** Sections by heading: [{ level, title, lines }]. */
function sections(body) {
  const out = [{ level: 0, title: '', lines: [] }];
  for (const line of String(body || '').split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push({ level: h[1].length, title: h[2].trim(), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

/** Map a raw vault status word onto the vocabulary. Anything else is NOT a status statement. */
function mapStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  if (/^(active|in[- ]progress|ongoing|live)\b/.test(s)) return 'active';
  if (/^(paused|on[- ]hold)\b/.test(s)) return 'paused';
  if (/^(parked|deferred)\b/.test(s)) return 'parked';
  if (/^blocked\b/.test(s)) return 'blocked';
  if (/^(complete|completed|done|finished|shipped)\b/.test(s)) return 'completed';
  if (/^(abandoned|dropped|cancell?ed|retired)\b/.test(s)) return 'abandoned';
  return null;
}

const SPHERE_WORDS = { personal: 'personal', private: 'personal', work: 'work', other: 'other', shared: 'other' };
const PERSONAL_TAGS = new Set(['side-project', 'personal-project', 'personal']);
const WORK_TAGS = new Set(['work-project']);
const GH_URL = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/)\]"'`#?]|$)/g;
const LOCAL_PATH = /^([A-Za-z]:[\\/]|\/|~\/)/;
const SECTION_NEXT = /^next(\s+(action|actions|step|steps))?\b/i;
const SECTION_BLOCK = /^blockers?\b|^blocked\b/i;
const SECTION_PARK = /^parked\b/i;
const SECTION_LOG = /status|log|progress|update|history|implementation|changelog/i;

/**
 * Read one hub note. Only explicit statements count: frontmatter keys, tags,
 * headed sections and URLs/paths written in the note. Nothing is inferred from
 * the prose.
 */
function parseHub(text, { relPath = null } = {}) {
  const { fm, body } = parseFrontmatter(text);
  const secs = sections(body);
  const h1 = secs.find((s) => s.level === 1);
  const tags = asList(fm.tags).map((t) => t.toLowerCase().replace(/^#/, ''));

  const sphereEvidence = [];
  for (const k of ['sphere', 'domain']) {
    const w = SPHERE_WORDS[String(fm[k] || '').toLowerCase().trim()];
    if (w) sphereEvidence.push({ sphere: w, basis: 'vault', why: `${relPath || 'the hub note'} says ${k}: ${fm[k]}` });
  }
  // An explicit sphere:/domain: key is the statement; tags are only read when there is none.
  for (const t of (sphereEvidence.length ? [] : tags)) {
    if (PERSONAL_TAGS.has(t)) sphereEvidence.push({ sphere: 'personal', basis: 'vault', why: `${relPath || 'the hub note'} is tagged ${t}` });
    if (WORK_TAGS.has(t)) sphereEvidence.push({ sphere: 'work', basis: 'vault', why: `${relPath || 'the hub note'} is tagged ${t}` });
  }

  const repoUrls = new Set();
  const repoPaths = [];
  for (const v of [...asList(fm.repo), ...asList(fm.repos), ...asList(fm.github)]) {
    if (LOCAL_PATH.test(v)) repoPaths.push(v);
    else for (const m of v.matchAll(GH_URL)) repoUrls.add(`${m[1]}/${m[2]}`.toLowerCase());
  }
  for (const m of body.matchAll(GH_URL)) repoUrls.add(`${m[1]}/${m[2]}`.toLowerCase());

  const bullets = (lines) => lines
    .map((l) => l.match(/^\s*[-*]\s+(\[( |x|X)\]\s+)?(.*)$/))
    .filter(Boolean)
    .map((m) => ({ done: !!m[2] && m[2].toLowerCase() === 'x', text: stripMd(m[3]) }))
    .filter((b) => b.text && !/^(none|n\/a|nothing)\.?$/i.test(b.text));

  const nextActions = [];
  for (const v of [...asList(fm.next), ...asList(fm['next-action']), ...asList(fm.next_action)]) nextActions.push(clip(stripMd(v), 200));
  for (const s of secs) if (s.level >= 2 && SECTION_NEXT.test(s.title)) for (const b of bullets(s.lines)) if (!b.done) nextActions.push(clip(b.text, 200));

  const blockers = [];
  for (const v of [...asList(fm.blocker), ...asList(fm.blockers), ...asList(fm['blocked-by'])]) blockers.push(clip(stripMd(v), 200));
  for (const s of secs) if (s.level >= 2 && SECTION_BLOCK.test(s.title)) for (const b of bullets(s.lines)) if (!b.done) blockers.push(clip(b.text, 200));

  const parked = asList(fm.parked).map((p) => clip(stripMd(p), 80));
  for (const s of secs) if (s.level >= 2 && SECTION_PARK.test(s.title)) for (const b of bullets(s.lines)) parked.push(clip(b.text.split(/\s+[—–-]\s+/)[0], 80));

  // Dated outcomes: "- 2026-10-08: …" under a status/log heading, or a "### 2026-10-05 — …" heading.
  const datedOutcomes = [];
  for (const s of secs) {
    const hd = s.title.match(/^(\d{4}-\d{2}-\d{2})\b\s*[—–:-]?\s*(.*)$/);
    if (hd && isDate(hd[1]) && s.level >= 2) datedOutcomes.push({ date: hd[1], text: clip(stripMd(hd[2] || s.title), SUBJECT_MAX) });
    if (s.level >= 2 && SECTION_LOG.test(s.title)) {
      for (const l of s.lines) {
        const m = l.match(/^\s*[-*]\s+(?:\*\*)?(\d{4}-\d{2}-\d{2})(?:\/\d{2})?(?:\*\*)?\s*[:—–-]\s*(.+)$/);
        if (m && isDate(m[1])) datedOutcomes.push({ date: m[1], text: clip(stripMd(m[2]), SUBJECT_MAX) });
      }
    }
  }

  // What it is: the hub's own blockquote, else the first line under a Goal/summary/outcome heading.
  let description = null;
  const quote = body.split('\n').find((l) => /^>\s*\S/.test(l));
  if (quote) description = clip(stripMd(quote.replace(/^>\s*/, '')), 240);
  if (!description) {
    const g = secs.find((s) => s.level >= 2 && /goal|summary|outcome|purpose/i.test(s.title));
    const first = g && g.lines.find((l) => l.trim() && !/^\s*[-*|]/.test(l));
    if (first) description = clip(stripMd(first), 240);
  }
  const goalSec = secs.find((s) => s.level >= 2 && /^goal\b/i.test(s.title));
  const goalLine = goalSec && goalSec.lines.find((l) => l.trim());

  const deadline = ['deadline', 'due', 'target-date', 'launch'].map((k) => fm[k]).find(isDate) || null;

  return {
    title: h1 ? stripMd(h1.title) : null,
    type: fm.type || null,
    rawStatus: fm.status != null && fm.status !== '' ? String(fm.status) : null,
    explicitStatus: mapStatus(fm.status),
    owner: fm.owner || null,
    aliases: asList(fm.aliases),
    tags,
    sphereEvidence,
    repoUrls: [...repoUrls],
    repoPaths,
    nextActions: [...new Set(nextActions)].slice(0, 5),
    blockers: [...new Set(blockers)].slice(0, 5),
    parkedComponents: [...new Set(parked.filter(Boolean))].slice(0, 10),
    datedOutcomes: datedOutcomes.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20),
    description,
    goal: goalLine ? clip(stripMd(goalLine), 240) : null,
    deadline: deadline ? String(deadline).slice(0, 10) : null,
    created: isDate(fm.created) ? String(fm.created).slice(0, 10) : isDate(fm.started) ? String(fm.started).slice(0, 10) : null,
    completed: isDate(fm.completed) ? String(fm.completed).slice(0, 10) : null,
  };
}

/** A note in a project folder that RECORDS a shipped milestone (a build record marked deployed, say). */
function milestoneFrom(text, { relPath, mtime = null } = {}) {
  const { fm } = parseFrontmatter(text);
  const st = String(fm.status || '').toLowerCase();
  if (!/^(deployed|released|shipped|complete|completed|done|live)\b/.test(st)) return null;
  const date = [fm.date, fm.deployed, fm.released, fm.created].find(isDate);
  if (!date) return null;
  const { body } = parseFrontmatter(text);
  const h1 = sections(body).find((s) => s.level === 1);
  return { date: String(date).slice(0, 10), title: clip(stripMd(h1 ? h1.title : relPath), SUBJECT_MAX), status: clip(fm.status, 80), path: relPath, mtime };
}

// ── GitHub snapshot: bounded, sanitised ─────────────────────────────────────

const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;
const FILE_CLASSES = ['source', 'test', 'config', 'docs', 'generated', 'lock', 'other'];

function cleanText(v, n, counters) {
  if (v == null) return null;
  const s = clip(v, n);
  if (SECRET.test(s)) { counters.redacted += 1; return '[redacted: looked like a credential]'; }
  return s;
}

/**
 * The snapshot a reporter sends. Everything not on this list is dropped, every
 * string is bounded, and anything that looks like a credential is replaced.
 * File PATHS are never accepted — only per-commit counts by file class.
 */
function sanitiseSnapshot(body) {
  const counters = { redacted: 0, dropped: 0 };
  if (!body || typeof body !== 'object') return { ok: false, error: 'a snapshot object is required' };
  const fetchedAt = iso(body.fetchedAt);
  if (!fetchedAt) return { ok: false, error: 'fetchedAt (ISO time) is required' };
  if (!Array.isArray(body.repos)) return { ok: false, error: 'repos[] is required' };
  if (body.repos.length > 400) return { ok: false, error: 'too many repos in one snapshot (400 max) — the snapshot is bounded to repos in scope' };
  const repos = [];
  for (const r of body.repos) {
    const id = Number(r && r.id);
    const fullName = String((r && r.fullName) || '');
    if (!Number.isInteger(id) || id <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) { counters.dropped += 1; continue; }
    const [owner, name] = fullName.split('/');
    const list = (xs, max) => (Array.isArray(xs) ? xs.slice(0, max) : []);
    const commits = list(r.commits, MAX_COMMITS).map((c) => {
      const at = iso(c && c.at); const sha = String((c && c.sha) || '').toLowerCase().slice(0, 12);
      if (!at || !/^[0-9a-f]{7,12}$/.test(sha)) { counters.dropped += 1; return null; }
      let files = null;
      if (c.files && typeof c.files === 'object') { files = {}; for (const k of FILE_CLASSES) files[k] = Math.max(0, Math.min(10000, Number(c.files[k]) || 0)); }
      return { sha, at, subject: cleanText(c.subject, SUBJECT_MAX, counters) || '', merge: !!c.merge, files, byAccount: c.byAccount === false ? false : c.byAccount === true ? true : null };
    }).filter(Boolean);
    const numbered = (xs, max) => list(xs, max).map((x) => {
      const at = iso(x && x.at); const n = Number(x && x.number);
      if (!at || !Number.isInteger(n)) { counters.dropped += 1; return null; }
      return { number: n, at, title: cleanText(x.title, SUBJECT_MAX, counters) };
    }).filter(Boolean);
    repos.push({
      id, fullName, owner, name,
      private: r.private !== false, archived: !!r.archived, fork: !!r.fork,
      defaultBranch: r.defaultBranch ? clip(r.defaultBranch, 80) : null,
      pushedAt: iso(r.pushedAt),
      openIssues: Number.isInteger(r.openIssues) ? r.openIssues : null,
      openPrs: Number.isInteger(r.openPrs) ? r.openPrs : null,
      description: cleanText(r.description, 200, counters),
      htmlUrl: `https://github.com/${fullName}`,
      commits,
      prsMerged: numbered(r.prsMerged, MAX_ITEMS),
      issuesClosed: numbered(r.issuesClosed, MAX_ITEMS),
      releases: list(r.releases, MAX_RELEASES).map((x) => {
        const at = iso(x && x.at); if (!at || !x.tag) { counters.dropped += 1; return null; }
        return { tag: clip(x.tag, 60), at, name: cleanText(x.name, 100, counters) };
      }).filter(Boolean),
      deployments: list(r.deployments, MAX_DEPLOYMENTS).map((x) => {
        const at = iso(x && x.at); const id2 = Number(x && x.id);
        if (!at || !Number.isInteger(id2)) { counters.dropped += 1; return null; }
        return { id: id2, at, environment: clip(x.environment || 'unknown', 40), state: clip(x.state || 'unknown', 20) };
      }).filter(Boolean),
    });
  }
  const checkouts = (Array.isArray(body.checkouts) ? body.checkouts.slice(0, 200) : []).map((c) => {
    const p = String((c && c.path) || ''); const fn = String((c && c.fullName) || '').toLowerCase();
    if (!LOCAL_PATH.test(p) || p.length > 300 || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(fn)) return null;
    return { path: p, fullName: fn };
  }).filter(Boolean);
  const orgCounts = {};
  if (body.orgCounts && typeof body.orgCounts === 'object') for (const [k, v] of Object.entries(body.orgCounts).slice(0, 50)) if (/^[A-Za-z0-9_.-]+$/.test(k) && Number.isInteger(v)) orgCounts[k] = v;
  return {
    ok: true,
    snapshot: {
      fetchedAt, account: /^[A-Za-z0-9_-]+$/.test(String(body.account || '')) ? body.account : null,
      reporter: clip(body.reporter || 'unknown', 60), scope: clip(body.scope || '', 200),
      totalVisible: Number.isInteger(body.totalVisible) ? body.totalVisible : null,
      repos, checkouts, orgCounts,
    },
    counters,
  };
}

// ── progress vs activity ─────────────────────────────────────────────────────

const HOUSEKEEPING = /^(chore|style|format|lint|bump|deps?|build\(deps\)|wip|merge (branch|pull|remote))\b|\b(typo|formatting|prettier|lockfile|package-lock|whitespace|regenerat\w*)\b/i;

/**
 * Is this commit meaningful progress, or only activity? Uncertain → activity.
 * Merges are activity (the merged PR is the milestone). Housekeeping subjects,
 * docs-only, generated-only and lock-only commits are activity.
 */
function classifyCommit(c) {
  if (!c) return { meaningful: false, why: 'no commit' };
  if (c.merge) return { meaningful: false, why: 'merge commit — the merged pull request is the milestone' };
  if (HOUSEKEEPING.test(c.subject || '')) return { meaningful: false, why: 'housekeeping (formatting, typo, dependency or generated churn)' };
  const f = c.files;
  if (!f) return { meaningful: false, why: 'files not read — counted as activity, not progress' };
  const code = (f.source || 0) + (f.test || 0) + (f.config || 0);
  if (!code) {
    if ((f.docs || 0) && !(f.generated || 0) && !(f.lock || 0)) return { meaningful: false, why: 'documentation only' };
    if ((f.lock || 0) && !(f.generated || 0) && !(f.docs || 0)) return { meaningful: false, why: 'dependency lock churn only' };
    if ((f.generated || 0) || (f.lock || 0)) return { meaningful: false, why: 'generated files only' };
    return { meaningful: false, why: 'no source change' };
  }
  return { meaningful: true, why: 'source change' };
}

/** File → class. Used by the reporter; exported so the reporter and the tests share one rule. */
function fileClass(p) {
  const s = String(p || '').toLowerCase();
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|gemfile\.lock|composer\.lock|podfile\.lock|package\.resolved)$/.test(s)) return 'lock';
  if (/(^|\/)(dist|build|out|\.next|coverage|vendor|node_modules)\//.test(s) || /\.(min\.(js|css)|map|snap)$/.test(s) || /(^|\/)[^/]*(inventory|generated)[^/]*\.json$/.test(s)) return 'generated';
  if (/\.(md|mdx|txt|rst)$/.test(s) || /(^|\/)(docs?|\.claude)\//.test(s)) return 'docs';
  if (/(^|\/)(tests?|__tests__|spec)\//.test(s) || /\.(test|spec)\.[a-z]+$/.test(s) || /tests?\.swift$/.test(s)) return 'test';
  if (/\.(json|ya?ml|toml|ini|env\.example|plist|xcconfig|cfg)$/.test(s) || /(^|\/)(dockerfile|makefile|\.github\/)/.test(s)) return 'config';
  if (/\.(js|jsx|ts|tsx|cjs|mjs|py|swift|kt|java|go|rs|rb|php|cs|c|cc|cpp|h|hpp|svelte|vue|css|scss|html|sql|sh|ps1|ino)$/.test(s)) return 'source';
  return 'other';
}

/** Evidence rows from one repo snapshot. Releases, successful deployments, merged PRs and closed issues are milestones. */
function repoEvidence(repo) {
  const rows = [];
  for (const c of repo.commits || []) {
    const k = classifyCommit(c);
    rows.push({ kind: 'commit', ref: c.sha, at: c.at, title: c.subject, meaningful: k.meaningful, why: k.why, detail: c.files ? { files: c.files } : null });
  }
  for (const p of repo.prsMerged || []) rows.push({ kind: 'pr-merged', ref: `#${p.number}`, at: p.at, title: p.title, meaningful: true, why: 'pull request merged' });
  for (const i of repo.issuesClosed || []) rows.push({ kind: 'issue-closed', ref: `#${i.number}`, at: i.at, title: i.title, meaningful: true, why: 'issue closed' });
  for (const r of repo.releases || []) rows.push({ kind: 'release', ref: r.tag, at: r.at, title: r.name || r.tag, meaningful: true, why: 'release published' });
  for (const d of repo.deployments || []) {
    const ok = /^(success|active)$/i.test(d.state);
    rows.push({ kind: 'deployment', ref: String(d.id), at: d.at, title: `deployed to ${d.environment}`, meaningful: ok, why: ok ? 'deployment succeeded' : `deployment ${d.state} — not counted` });
  }
  return rows;
}

// ── linking ──────────────────────────────────────────────────────────────────

function isHardWorkRepo(repo) {
  return !!repo && (HARD_WORK.repoIds.includes(Number(repo.id)) || HARD_WORK.repoFullNames.includes(String(repo.fullName || '').toLowerCase()));
}
function isHardWorkProject(p) {
  return !!p && !!p.folder && HARD_WORK.vaultFolders.includes(String(p.folder).toLowerCase());
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Repo ↔ project links. States: confirmed (drives state), likely (shown, never
 * drives), rejected (Nick said no). A repo has ONE primary project; a second
 * project needs Nick's explicit secondary link.
 */
function linkRepos({ projects = [], repos = [], checkouts = [], explicit = [] } = {}) {
  const byFull = new Map(repos.map((r) => [String(r.fullName).toLowerCase(), r]));
  const byPath = new Map(checkouts.map((c) => [normPath(c.path), c.fullName]));
  const ex = new Map(explicit.map((e) => [`${e.projectId}|${e.repoId}`, e]));
  const links = [];
  const seen = new Set();
  const hardProjects = new Set(projects.filter(isHardWorkProject).map((p) => p.projectId));
  const add = (projectId, repo, state, basis, why, role = 'primary') => {
    const k = `${projectId}|${repo.id}`;
    if (seen.has(k)) return;
    // The NOVA repo belongs to NOVA. Only Nick may link it anywhere else — a note that merely
    // mentions it (live: a Discovery phase note) must not pull NOVA into another project's view.
    if (isHardWorkRepo(repo) && !hardProjects.has(projectId) && basis !== 'you') return;
    const e = ex.get(k);
    if (e && e.state === 'rejected') { links.push({ projectId, repoId: repo.id, fullName: repo.fullName, state: 'rejected', basis: 'you', why: 'you said this repo is not part of this project', role }); seen.add(k); return; }
    seen.add(k);
    links.push({ projectId, repoId: repo.id, fullName: repo.fullName, state, basis, why, role });
  };
  // Nick's explicit links win and are processed first.
  for (const e of explicit) {
    if (e.state !== 'confirmed') continue;
    const repo = repos.find((r) => Number(r.id) === Number(e.repoId));
    if (repo) add(e.projectId, repo, 'confirmed', 'you', 'you linked it', e.role || 'primary');
  }
  for (const p of projects) {
    if (isHardWorkProject(p)) for (const r of repos) if (isHardWorkRepo(r)) add(p.projectId, r, 'confirmed', 'hard-rule', HARD_WORK.why);
    const hub = p.hub || {};
    for (const u of hub.repoUrls || []) { const r = byFull.get(u); if (r) add(p.projectId, r, 'confirmed', 'vault-url', `${p.hubPath || 'the hub note'} links github.com/${r.fullName}`); }
    for (const lp of hub.repoPaths || []) {
      const fn = byPath.get(normPath(lp)); const r = fn && byFull.get(fn);
      if (r) add(p.projectId, r, 'confirmed', 'vault-path', `${p.hubPath || 'the hub note'} names ${lp}, a checkout of ${r.fullName}`);
    }
    for (const u of p.otherRepoUrls || []) { const r = byFull.get(u); if (r) add(p.projectId, r, 'likely', 'vault-mention', `a note in ${p.vaultPath} mentions github.com/${r.fullName}`); }
    if (p.origin === 'declared' && p.repoOrigin) { const r = repos.find((x) => Number(x.id) === Number(p.repoOrigin)); if (r) add(p.projectId, r, 'confirmed', 'you', 'you made this project from the repo'); }
    // Name match: the project's name, its hub title or an alias equals the repo name exactly once letters only are kept.
    const names = [p.name, hub.title, ...(hub.aliases || [])].map(compact).filter((n) => n.length >= 4);
    for (const r of repos) if (names.includes(compact(r.name))) add(p.projectId, r, 'likely', 'name', `the repo name "${r.name}" matches the project's name exactly — needs your confirmation`);
  }
  // One primary per repo: a later confirmed primary for an already-claimed repo is demoted to likely.
  const primary = new Map();
  for (const l of links.filter((x) => x.state === 'confirmed').sort((a, b) => (a.basis === 'you' ? -1 : 0) - (b.basis === 'you' ? -1 : 0))) {
    if (l.role === 'secondary') continue;
    if (!primary.has(l.repoId)) primary.set(l.repoId, l.projectId);
    else if (primary.get(l.repoId) !== l.projectId) { l.state = 'likely'; l.why += ` — but ${l.fullName} already belongs to another project; a second project needs your explicit secondary link`; }
  }
  return links;
}

// ── sphere, status, next action, focus ──────────────────────────────────────

/** Repo sphere: Nick > NOVA rule > owner Nick classified > its confirmed project's sphere. Never its name or owner alone. */
function repoSphere(repo, { statements = new Map(), projectSphere = null } = {}) {
  const st = statements.get(`repo:${repo.id}`);
  if (st && st.sphere && st.sphere !== 'unknown') return { sphere: st.sphere, basis: 'you', why: 'you classified this repo' };
  if (isHardWorkRepo(repo)) return { sphere: 'work', basis: 'hard-rule', why: HARD_WORK.why };
  const org = statements.get(`owner:${repo.owner}`);
  if (org && org.sphere && org.sphere !== 'unknown') return { sphere: org.sphere, basis: 'you', why: `you classified everything owned by ${repo.owner}` };
  if (projectSphere && projectSphere.sphere !== 'unknown') return { sphere: projectSphere.sphere, basis: 'project', why: `its confirmed project is ${projectSphere.sphere} (${projectSphere.basis})` };
  return { sphere: 'unknown', basis: null, why: 'nothing states whose this repo is' };
}

function deriveSphere(p, { statement = null, confirmedRepos = [], statements = new Map() } = {}) {
  if (isHardWorkProject(p) || confirmedRepos.some(isHardWorkRepo)) return { sphere: 'work', basis: 'hard-rule', why: HARD_WORK.why, conflicts: [] };
  if (statement && statement.sphere && statement.sphere !== 'unknown') return { sphere: statement.sphere, basis: 'you', why: 'you classified this project', conflicts: [] };
  const ev = [...((p.hub && p.hub.sphereEvidence) || [])];
  for (const r of confirmedRepos) {
    const st = statements.get(`repo:${r.id}`);
    if (st && st.sphere && st.sphere !== 'unknown') ev.push({ sphere: st.sphere, basis: 'repo', why: `you classified ${r.fullName} as ${st.sphere}` });
  }
  const kinds = [...new Set(ev.map((e) => e.sphere))];
  if (kinds.length === 1) return { sphere: kinds[0], basis: ev[0].basis, why: ev[0].why, conflicts: [] };
  if (kinds.length > 1) return { sphere: 'unknown', basis: 'conflict', why: 'the evidence disagrees — yours to decide', conflicts: ev };
  return { sphere: 'unknown', basis: null, why: 'nothing states whose this project is', conflicts: [] };
}

/** A suggestion is SHOWN to Nick to make classifying one tap. It never decides anything. */
function sphereSuggestion(p, { confirmedRepos = [] } = {}) {
  const t = `${(p.hub && p.hub.description) || ''} ${(p.hub && p.hub.goal) || ''}`;
  if (/\bNurtur\b/.test(t) || confirmedRepos.some((r) => /^nurtur/i.test(r.owner))) return { sphere: 'work', why: 'the hub note talks about Nurtur' };
  if ((p.hub && p.hub.tags || []).includes('portfolio')) return { sphere: 'personal', why: 'tagged portfolio' };
  return null;
}

/**
 * Status. Precedence: Nick → explicit vault status → open blocker → derived
 * active (meaningful progress in the window AND a known sphere) → unknown.
 * Parked, paused, completed and abandoned are NEVER derived.
 */
function deriveStatus({ statement = null, hub = null, openBlockers = [], lastProgressAt = null, sphere = 'unknown', now = Date.now() } = {}) {
  if (statement && statement.status && statement.status !== 'unknown') {
    return { status: statement.status, basis: 'you', why: 'you set it' };
  }
  const v = hub && hub.explicitStatus;
  if (v && v !== 'active' && v !== 'blocked') return { status: v, basis: 'vault', why: `the hub note says status: ${hub.rawStatus}` };
  if (openBlockers.length) return { status: 'blocked', basis: 'blocker', why: `blocked: ${openBlockers[0].what}` };
  if (v === 'active') return { status: 'active', basis: 'vault', why: `the hub note says status: ${hub.rawStatus}` };
  if (v === 'blocked') return { status: 'blocked', basis: 'vault', why: `the hub note says status: ${hub.rawStatus}` };
  const recent = lastProgressAt && (now - Date.parse(lastProgressAt)) <= ACTIVE_WINDOW_DAYS * DAY;
  if (recent && sphere !== 'unknown') return { status: 'active', basis: 'evidence', why: `meaningful progress in the last ${ACTIVE_WINDOW_DAYS} days, and you have said whose it is` };
  return { status: 'unknown', basis: null, why: hub && hub.rawStatus ? `the hub says "${hub.rawStatus}", which is not a status NEURO uses` : 'nothing states it, and quiet is not a status' };
}

const PARKED_LIKE = new Set(['parked', 'paused', 'completed', 'abandoned']);
const mentionsParked = (text, parked) => parked.some((c) => c && new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text || ''));

/** One next action, evidence-based, or null. Never from repo activity. */
function deriveNextAction({ status, statement = null, hub = null, tasks = [], blockers = [], parked = [] } = {}) {
  if (PARKED_LIKE.has(status)) return null;
  const open = tasks.filter((t) => t.status === 'open' || t.status === 'in-progress');
  if (statement && statement.next_task_id) {
    const t = open.find((x) => x.id === statement.next_task_id);
    if (t) return { kind: 'task', taskId: t.id, text: t.text, due: t.due_date || null, basis: 'you', why: 'you pinned it as the next action' };
  }
  const vaultNext = ((hub && hub.nextActions) || []).find((a) => !mentionsParked(a, parked));
  if (vaultNext) return { kind: 'vault', taskId: null, text: vaultNext, due: null, basis: 'vault', why: 'the hub note lists it under Next' };
  const rank = (t) => [t.status === 'in-progress' ? 0 : 1, t.moscow === 'must' ? 0 : 1, t.due_date || '9999', t.priority || 9, t.id];
  const cand = open.filter((t) => !mentionsParked(t.text, parked)).sort((a, b) => {
    const x = rank(a); const y = rank(b);
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  })[0];
  if (cand) return { kind: 'task', taskId: cand.id, text: cand.text, due: cand.due_date || null, basis: cand._linkBasis || 'linked', why: cand.status === 'in-progress' ? 'a linked task you have started' : 'the strongest open task linked to it' };
  const b = blockers.find((x) => x.state === 'open' && x.task_id);
  const bt = b && open.find((t) => t.id === b.task_id);
  if (bt) return { kind: 'task', taskId: bt.id, text: bt.text, due: bt.due_date || null, basis: 'blocker', why: `it resolves the blocker: ${b.what}` };
  return null;
}

/** What to pick up. A read-only synthesis — no ranking by commits, issues, hours or recency. */
function focusFor({ status, nextAction, openBlockers = [] } = {}) {
  if (status === 'completed' || status === 'abandoned') return { focus: 'closed', why: status };
  if (status === 'parked' || status === 'paused') return { focus: 'parked', why: `${status} — kept that way until you resume it` };
  if (openBlockers.length) {
    const mine = openBlockers.find((b) => b.owner === 'nick');
    return mine ? { focus: 'blocked', why: `needs you: ${mine.unblock || mine.what}` } : { focus: 'waiting', why: `waiting: ${openBlockers[0].what}` };
  }
  if (nextAction) return { focus: 'ready', why: nextAction.why };
  return { focus: 'no-next-action', why: 'nothing states what comes next' };
}

const IMP_RANK = { high: 0, normal: 1, low: 2 };
/** Ready first, then Nick's stated importance, then a dated next action, then name. */
function rankFocus(projects) {
  const order = { ready: 0, blocked: 1, waiting: 2, 'no-next-action': 3, parked: 4, closed: 5 };
  return [...projects].sort((a, b) =>
    (order[a.focus.focus] - order[b.focus.focus])
    || ((IMP_RANK[a.importance] ?? 1) - (IMP_RANK[b.importance] ?? 1))
    || String((a.nextAction && a.nextAction.due) || '9999').localeCompare(String((b.nextAction && b.nextAction.due) || '9999'))
    || a.name.localeCompare(b.name));
}

// ── task linking ─────────────────────────────────────────────────────────────

/**
 * Which project, if any, a task belongs to. Explicit link first; then the
 * task's own source path inside a project folder; then the project's exact
 * MULTI-WORD name where it is unambiguous. A single-word name is never matched
 * by text: live on 8 Oct 2026 "NEURO" matched "Fill in the Captur basics in
 * NEURO" — NEURO as the place the work is done, not the project — and made a
 * car task NEURO's next action. "TOM" is also a person; "Discovery" is a word.
 */
function nameMatcher(name) {
  const n = String(name || '').trim();
  if (!n || n.split(/\s+/).length < 2) return null;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i');
}

function linkTasks({ projects = [], tasks = [], explicit = [] } = {}) {
  const out = new Map(projects.map((p) => [p.projectId, []]));
  const unlinked = new Set(explicit.filter((e) => e.state === 'unlinked').map((e) => `${e.projectId}|${e.taskId}`));
  const linkedExplicit = new Map();
  for (const e of explicit) if (e.state === 'linked') { if (!linkedExplicit.has(e.taskId)) linkedExplicit.set(e.taskId, []); linkedExplicit.get(e.taskId).push(e.projectId); }
  const matchers = projects.map((p) => ({ p, re: nameMatcher(p.name), prefix: p.vaultPath ? `${normPath(p.vaultPath)}/` : null }));
  for (const t of tasks) {
    const ex = linkedExplicit.get(t.id);
    if (ex) { for (const pid of ex) if (out.has(pid)) out.get(pid).push({ ...t, _linkBasis: 'you' }); continue; }
    const op = normPath(t.origin_path);
    const byPath = op ? matchers.filter((m) => m.prefix && op.startsWith(m.prefix)) : [];
    if (byPath.length === 1) { if (!unlinked.has(`${byPath[0].p.projectId}|${t.id}`)) out.get(byPath[0].p.projectId).push({ ...t, _linkBasis: 'source-path' }); continue; }
    const byName = matchers.filter((m) => m.re && m.re.test(t.text || ''));
    if (byName.length === 1 && !unlinked.has(`${byName[0].p.projectId}|${t.id}`)) out.get(byName[0].p.projectId).push({ ...t, _linkBasis: 'name' });
  }
  return out;
}

module.exports = {
  STATUSES, SPHERES, IMPORTANCE, HARD_WORK, ACTIVE_WINDOW_DAYS, FILE_CLASSES,
  slug, compact, parseFrontmatter, parseHub, mapStatus, milestoneFrom,
  sanitiseSnapshot, classifyCommit, fileClass, repoEvidence,
  isHardWorkRepo, isHardWorkProject, linkRepos, repoSphere, deriveSphere, sphereSuggestion,
  deriveStatus, deriveNextAction, focusFor, rankFocus, nameMatcher, linkTasks, maxIso,
};
