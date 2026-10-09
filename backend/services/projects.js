'use strict';

/**
 * Build 24 — personal projects: store, read model, refresh, Nick's statements.
 *
 * Sources, all bounded:
 *   • the vault's Projects/ folders — one canonical project per folder (the
 *     vault's own documented convention), hub note = <Folder>/<Folder>.md or a
 *     note with `type: project`;
 *   • a GitHub METADATA snapshot pushed by a reporter that holds Nick's own
 *     credential (backend/scripts/github-snapshot.js). NEURO holds no GitHub
 *     credential at all, so it cannot write to GitHub by construction;
 *   • NEURO tasks, LINKED — never copied into another store;
 *   • Nick's explicit statements (sphere, status, importance, links, blockers).
 *
 * What it refuses: inferring work/personal from a name or an owner; inferring
 * parked/paused/abandoned from quiet; counting a commit as progress when it
 * cannot see what changed; storing code, file paths, diffs or credentials.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./projects-model');

const META_KEY = 'projects_github_meta';
const BASELINE_KEY = 'projects_baseline_at';
const SNAPSHOT_FRESH_HOURS = 36;
const RETIRED = new Set(['archive', '_archive']);
const MAX_FILES_PER_PROJECT = 2000;
const EVIDENCE_KEEP_PER_REPO = 300;

function _db() { return require('../db/database'); }
const _iso = (ms) => new Date(ms).toISOString();
/** SQLite DATETIME ('YYYY-MM-DD HH:MM:SS', UTC) or ISO → ISO, or null. Never throws. */
function sqlIso(v) {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
function _json(key) { try { return JSON.parse(_db().getState(key) || 'null'); } catch { return null; } }
function _setJson(key, v) { _db().setState(key, JSON.stringify(v)); }
function _log(kind, detail, { subjectId = null, actor = 'neuro', now = Date.now(), dedupeKey } = {}) {
  return require('./personal-obligations').logEvent(kind, { subjectId, actor, detail, dedupeKey, now });
}

// ── vault ────────────────────────────────────────────────────────────────────

let _vaultCache = null;
function _walk(dir, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES_PER_PROJECT) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) _walk(p, out, depth + 1);
    else if (e.name.endsWith('.md')) out.push(p);
    if (out.length >= MAX_FILES_PER_PROJECT) return;
  }
}

/** Every project folder under Projects/, with its hub parsed. Archive is retired and skipped. */
function readVault({ vaultRoot = process.env.OBSIDIAN_VAULT_PATH, now = Date.now(), fresh = false } = {}) {
  if (!fresh && _vaultCache && _vaultCache.root === vaultRoot && now - _vaultCache.at < 120000) return _vaultCache.value;
  const value = (() => {
    if (!vaultRoot || !path.isAbsolute(vaultRoot)) return { ok: false, error: 'OBSIDIAN_VAULT_PATH is not set', projects: [] };
    const root = path.join(vaultRoot, 'Projects');
    let folders;
    try { folders = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_') && !RETIRED.has(d.name.toLowerCase())); } catch (e) {
      return { ok: false, error: `Projects/ could not be read: ${e.code || e.message}`, projects: [] };
    }
    const projects = [];
    for (const d of folders) {
      const dir = path.join(root, d.name);
      const files = []; _walk(dir, files);
      const rel = (f) => path.relative(vaultRoot, f).split(path.sep).join('/');
      let hubFile = files.find((f) => path.basename(f, '.md').toLowerCase() === d.name.toLowerCase() && path.dirname(f) === dir) || null;
      let lastNoteAt = null; const otherUrls = new Set(); const milestones = [];
      const texts = new Map();
      for (const f of files) {
        let st; try { st = fs.statSync(f); } catch { continue; }
        const at = st.mtime.toISOString();
        if (!lastNoteAt || at > lastNoteAt) lastNoteAt = at;
        let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        texts.set(f, text);
        const ms = M.milestoneFrom(text.slice(0, 6000), { relPath: rel(f), mtime: at });
        if (ms) milestones.push(ms);
        // Only a note at the folder's top level can be its hub: a nested spec that happens to say
        // `type: project` (live: NEURO/Origins/…Plaud Render Fix (Spec).md) is not the project.
        if (!hubFile && path.dirname(f) === dir && /^---[\s\S]*?\ntype:\s*project\s*\n/.test(text.slice(0, 600).replace(/\r/g, ''))) hubFile = f;
      }
      if (!hubFile) hubFile = files.find((f) => / - index\.md$/i.test(f) && path.dirname(f) === dir) || null;
      const hub = hubFile ? M.parseHub(texts.get(hubFile) || '', { relPath: rel(hubFile) }) : null;
      for (const [f, text] of texts) {
        if (f === hubFile) continue;
        for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/)\]"'`#?]|$)/g)) otherUrls.add(`${m[1]}/${m[2]}`.toLowerCase());
      }
      projects.push({
        projectId: `p:${M.slug(d.name)}`, name: d.name, folder: d.name, origin: 'vault',
        vaultPath: `Projects/${d.name}`, hubPath: hubFile ? rel(hubFile) : null, hub,
        noteCount: files.length, lastNoteAt, milestones: milestones.sort((a, b) => b.date.localeCompare(a.date)),
        otherRepoUrls: [...otherUrls], walkCapped: files.length >= MAX_FILES_PER_PROJECT,
      });
    }
    return { ok: true, projects, readAt: _iso(now) };
  })();
  _vaultCache = { root: vaultRoot, at: now, value };
  return value;
}

// ── GitHub snapshot ──────────────────────────────────────────────────────────

/** Ingest a bounded metadata snapshot. Idempotent: evidence is keyed on (repo, kind, ref). */
function ingestSnapshot(body, { now = Date.now() } = {}) {
  const s = M.sanitiseSnapshot(body);
  if (!s.ok) return { ok: false, status: 400, error: s.error };
  const snap = s.snapshot;
  const db = _db();
  const nowIso = _iso(now);
  const pathsByRepo = new Map();
  for (const c of snap.checkouts) { if (!pathsByRepo.has(c.fullName)) pathsByRepo.set(c.fullName, []); pathsByRepo.get(c.fullName).push(c.path); }
  let added = 0;
  for (const r of snap.repos) {
    const prev = db.get('SELECT first_seen_at FROM project_repos WHERE repo_id = ?', [r.id]);
    db.run(`INSERT OR REPLACE INTO project_repos (repo_id, full_name, owner, name, private, archived, fork, default_branch, pushed_at, open_issues, open_prs, description, html_url, local_paths, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.id, r.fullName, r.owner, r.name, r.private ? 1 : 0, r.archived ? 1 : 0, r.fork ? 1 : 0, r.defaultBranch, r.pushedAt, r.openIssues, r.openPrs, r.description, r.htmlUrl,
      JSON.stringify(pathsByRepo.get(r.fullName.toLowerCase()) || []), prev ? prev.first_seen_at : nowIso, nowIso]);
    for (const e of M.repoEvidence(r)) {
      const res = db.run(`INSERT OR IGNORE INTO project_repo_evidence (repo_id, kind, ref, at, title, meaningful, why, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, e.kind, e.ref, e.at, e.title, e.meaningful ? 1 : 0, e.why, e.detail ? JSON.stringify(e.detail) : null]);
      if (res && res.changes) added += 1;
    }
    db.run(`DELETE FROM project_repo_evidence WHERE repo_id = ? AND rowid NOT IN (SELECT rowid FROM project_repo_evidence WHERE repo_id = ? ORDER BY at DESC LIMIT ?)`, [r.id, r.id, EVIDENCE_KEEP_PER_REPO]);
  }
  const prevMeta = _json(META_KEY);
  _setJson(META_KEY, {
    fetchedAt: snap.fetchedAt, receivedAt: nowIso, reporter: snap.reporter, account: snap.account, scope: snap.scope,
    totalVisible: snap.totalVisible, inScope: snap.repos.length, orgCounts: snap.orgCounts, checkouts: snap.checkouts.length,
    redacted: s.counters.redacted, dropped: s.counters.dropped,
  });
  if (!prevMeta) _log('projects-github-connected', { inScope: snap.repos.length, totalVisible: snap.totalVisible, account: snap.account, reporter: snap.reporter }, { now, dedupeKey: 'projects-github-connected' });
  const r = refresh({ now });
  return { ok: true, repos: snap.repos.length, evidenceAdded: added, redacted: s.counters.redacted, dropped: s.counters.dropped, refresh: r };
}

function _repos() {
  const db = _db();
  const rows = db.all('SELECT * FROM project_repos ORDER BY full_name');
  const ev = db.all('SELECT * FROM project_repo_evidence ORDER BY at DESC');
  const byRepo = new Map();
  for (const e of ev) { if (!byRepo.has(e.repo_id)) byRepo.set(e.repo_id, []); byRepo.get(e.repo_id).push(e); }
  return rows.map((r) => ({
    id: r.repo_id, fullName: r.full_name, owner: r.owner, name: r.name, private: !!r.private, archived: !!r.archived, fork: !!r.fork,
    defaultBranch: r.default_branch, pushedAt: r.pushed_at, openIssues: r.open_issues, openPrs: r.open_prs, description: r.description,
    htmlUrl: r.html_url, localPaths: JSON.parse(r.local_paths || '[]'), firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    evidence: byRepo.get(r.repo_id) || [],
  }));
}

function _statements() {
  const m = new Map();
  for (const r of _db().all('SELECT * FROM project_statements')) m.set(r.subject, r);
  return m;
}

function _declared() {
  return _db().all("SELECT * FROM projects WHERE origin = 'declared' AND removed_at IS NULL").map((r) => ({
    projectId: r.project_id, name: r.name, folder: null, origin: 'declared', vaultPath: null, hubPath: null, hub: null,
    noteCount: 0, lastNoteAt: null, milestones: [], otherRepoUrls: [], repoOrigin: r.repo_origin,
  }));
}

function sourceState(meta, now) {
  if (!meta) return { state: 'never', why: 'no GitHub snapshot has reached NEURO yet — repos are unknown, not absent' };
  const age = (now - Date.parse(meta.fetchedAt)) / 3600000;
  return { state: age <= SNAPSHOT_FRESH_HOURS ? 'fresh' : 'stale', ageHours: Math.round(age * 10) / 10, why: age <= SNAPSHOT_FRESH_HOURS ? null : `the last GitHub snapshot is ${Math.round(age)} hours old — repo activity after it is not seen` };
}

// ── the read model ───────────────────────────────────────────────────────────

function compose({ vault, repos, statements, declared = [], repoLinks = [], taskLinks = [], tasks = [], blockers = [], meta = null, now = Date.now() } = {}) {
  const projects = [...(vault.projects || []), ...declared];
  const checkouts = repos.flatMap((r) => (r.localPaths || []).map((p) => ({ path: p, fullName: r.fullName.toLowerCase() })));
  const links = M.linkRepos({ projects, repos, checkouts, explicit: repoLinks.map((l) => ({ projectId: l.project_id, repoId: l.repo_id, state: l.state, role: l.role })) });
  const byTask = M.linkTasks({ projects, tasks, explicit: taskLinks.map((l) => ({ projectId: l.project_id, taskId: l.task_id, state: l.state })) });
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const yearAgo = now - 365 * 86400000;

  const out = projects.map((p) => {
    const st = statements.get(`project:${p.projectId}`) || null;
    const myLinks = links.filter((l) => l.projectId === p.projectId);
    const confirmed = myLinks.filter((l) => l.state === 'confirmed').map((l) => repoById.get(l.repoId)).filter(Boolean);
    const sphere = M.deriveSphere(p, { statement: st, confirmedRepos: confirmed, statements });
    const myTasks = byTask.get(p.projectId) || [];
    const openB = [
      ...blockers.filter((b) => b.project_id === p.projectId && b.state === 'open').map((b) => ({ id: b.blocker_id, what: b.what, unblock: b.unblock, owner: b.owner, task_id: b.task_id, source: 'you', since: b.since, state: 'open' })),
      ...((p.hub && p.hub.blockers) || []).map((w) => ({ id: `vault:${crypto.createHash('sha1').update(`${p.projectId}|${w}`).digest('hex').slice(0, 10)}`, what: w, unblock: null, owner: 'unknown', task_id: null, source: p.hubPath, since: null, state: 'open' })),
    ];

    // Evidence: activity vs meaningful progress, never conflated.
    const activity = []; const progress = [];
    for (const r of confirmed) {
      if (r.pushedAt) activity.push({ at: r.pushedAt, what: `push to ${r.fullName}`, kind: 'push', repo: r.fullName });
      for (const e of r.evidence) {
        const item = { at: e.at, what: e.title || e.kind, kind: e.kind, repo: r.fullName, ref: e.ref, why: e.why };
        activity.push(item);
        if (e.meaningful) progress.push(item);
      }
    }
    if (p.lastNoteAt) activity.push({ at: p.lastNoteAt, what: 'a project note changed', kind: 'note' });
    for (const o of (p.hub && p.hub.datedOutcomes) || []) progress.push({ at: `${o.date}T00:00:00.000Z`, what: o.text, kind: 'vault-outcome', why: 'a dated outcome in the hub note' });
    for (const m of p.milestones || []) progress.push({ at: `${m.date}T00:00:00.000Z`, what: m.title, kind: 'milestone', why: `recorded as ${m.status}`, path: m.path });
    for (const t of myTasks) {
      const upd = sqlIso(t.updated_at);
      if (upd) activity.push({ at: upd, what: `task #${t.id} changed`, kind: 'task' });
      const at = t.status === 'done' ? sqlIso(t.completed_at) : null;
      if (at) {
        if (Date.parse(at) >= yearAgo) progress.push({ at, what: `completed task #${t.id}: ${t.text}`, kind: 'task-done', why: `a linked task (${t._linkBasis})` });
      }
    }
    // A dated line in the future is a plan, not an outcome. An hour of tolerance for clocks.
    const horizon = _iso(now + 3600000);
    const sortDesc = (xs) => xs.filter((x) => x.at && x.at <= horizon).sort((a, b) => b.at.localeCompare(a.at));
    const prog = sortDesc(progress);
    const act = sortDesc([...activity, ...progress]); // progress is also activity; activity is not progress

    const status = M.deriveStatus({ statement: st, hub: p.hub, openBlockers: openB, lastProgressAt: prog[0] ? prog[0].at : null, sphere: sphere.sphere, now });
    const parked = (p.hub && p.hub.parkedComponents) || [];
    const nextAction = M.deriveNextAction({ status: status.status, statement: st, hub: p.hub, tasks: myTasks, blockers: openB, parked });
    const focus = M.focusFor({ status: status.status, nextAction, openBlockers: openB });
    const importance = (st && st.importance) || null;
    const openTasks = myTasks.filter((t) => t.status === 'open' || t.status === 'in-progress');

    const why = [];
    if (sphere.sphere !== 'unknown') why.push(`${sphere.sphere}: ${sphere.why}`);
    why.push(`status ${status.status}: ${status.why}`);
    if (confirmed.length) why.push(`${confirmed.length} confirmed repo${confirmed.length === 1 ? '' : 's'}`);
    if (openTasks.length) why.push(`${openTasks.length} open linked task${openTasks.length === 1 ? '' : 's'}`);

    return {
      projectId: p.projectId, name: p.name, displayTitle: (p.hub && p.hub.title) || null,
      origin: p.origin, vaultPath: p.vaultPath, hubPath: p.hubPath, noteCount: p.noteCount,
      description: (p.hub && p.hub.description) || (confirmed[0] && confirmed[0].description) || null,
      goal: (p.hub && p.hub.goal) || null, rawStatus: (p.hub && p.hub.rawStatus) || null,
      status, sphere, suggestion: sphere.sphere === 'unknown' ? M.sphereSuggestion(p, { confirmedRepos: confirmed }) : null,
      importance, deadline: (p.hub && p.hub.deadline) || null,
      repos: myLinks.map((l) => {
        const r = repoById.get(l.repoId);
        return { ...l, archived: r && r.archived, private: r && r.private, pushedAt: r && r.pushedAt, htmlUrl: r && r.htmlUrl, openIssues: r && r.openIssues, openPrs: r && r.openPrs };
      }),
      lastActivity: act[0] || null,
      lastProgress: prog[0] || null,
      recentProgress: prog.slice(0, 6),
      milestones: (p.milestones || []).slice(0, 5),
      blockers: openB,
      nextAction, focus,
      parkedComponents: parked,
      tasks: { open: openTasks.map((t) => ({ id: t.id, text: t.text, status: t.status, due: t.due_date || null, domain: t.domain, basis: t._linkBasis })), linked: myTasks.length },
      whyShown: why,
      hardWork: M.isHardWorkProject(p) || confirmed.some(M.isHardWorkRepo),
    };
  });

  const linkedRepoIds = new Set(links.filter((l) => l.state === 'confirmed').map((l) => l.repoId));
  const sphereOfRepo = (r) => {
    const l = links.find((x) => x.repoId === r.id && x.state === 'confirmed' && x.role === 'primary');
    const proj = l && out.find((x) => x.projectId === l.projectId);
    return M.repoSphere(r, { statements, projectSphere: proj ? proj.sphere : null });
  };
  const repoView = repos.map((r) => {
    const sp = sphereOfRepo(r);
    const ev = r.evidence;
    const lastMeaningful = ev.find((e) => e.meaningful);
    return {
      repoId: r.id, fullName: r.fullName, owner: r.owner, private: r.private, archived: r.archived, fork: r.fork, pushedAt: r.pushedAt,
      defaultBranch: r.defaultBranch, openIssues: r.openIssues, openPrs: r.openPrs, description: r.description, htmlUrl: r.htmlUrl,
      localPaths: r.localPaths, sphere: sp, linked: linkedRepoIds.has(r.id),
      links: links.filter((l) => l.repoId === r.id).map((l) => ({ projectId: l.projectId, state: l.state, basis: l.basis, role: l.role })),
      recentCommits: ev.filter((e) => e.kind === 'commit').length,
      lastActivityAt: [r.pushedAt, ev[0] && ev[0].at].filter(Boolean).sort().slice(-1)[0] || null,
      lastMeaningfulAt: lastMeaningful ? lastMeaningful.at : null,
    };
  });

  const live = out.filter((p) => !p.removedAt);
  const personal = M.rankFocus(live.filter((p) => p.sphere.sphere === 'personal' && !p.hardWork));
  const owners = Object.entries((meta && meta.orgCounts) || {}).map(([owner, count]) => {
    const s = statements.get(`owner:${owner}`);
    return { owner, count, sphere: s && s.sphere ? s.sphere : 'unknown' };
  });
  return {
    contract: 'projects-v1',
    generatedAt: _iso(now),
    sources: {
      github: { ...sourceState(meta, now), fetchedAt: meta ? meta.fetchedAt : null, reporter: meta ? meta.reporter : null, account: meta ? meta.account : null,
        inScope: repos.length, totalVisible: meta ? meta.totalVisible : null, owners, redacted: meta ? meta.redacted : 0,
        scope: meta ? meta.scope : null },
      vault: { state: vault.ok ? 'read' : 'unreadable', error: vault.ok ? null : vault.error, projects: (vault.projects || []).length },
    },
    projects: live,
    personal: personal.map((p) => p.projectId),
    needsClassifying: live.filter((p) => p.sphere.sphere === 'unknown').map((p) => ({ projectId: p.projectId, name: p.name, suggestion: p.suggestion, conflicts: p.sphere.conflicts })),
    repos: repoView,
    counts: {
      projects: live.length,
      bySphere: countBy(live, (p) => p.sphere.sphere),
      byStatus: countBy(live, (p) => p.status.status),
      personalByStatus: countBy(personal, (p) => p.status.status),
      reposBySphere: countBy(repoView, (r) => r.sphere.sphere),
      repoLinks: countBy(links, (l) => l.state),
    },
    rule: 'A project is something you are trying to move forward, not a repo that exists. NOVA is work by rule; nothing else is work or personal until you say so or a note states it. Quiet is never parked or abandoned. A commit counts as progress only when NEURO can see it changed source; merges, docs, lock files and generated files are activity. NEURO holds no GitHub credential and never writes to GitHub.',
  };
}
const countBy = (xs, f) => xs.reduce((m, x) => { const k = f(x) || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});

function read({ now = Date.now(), freshVault = false } = {}) {
  const db = _db();
  const vault = readVault({ now, fresh: freshVault });
  const tasks = db.listTaskRows({ status: 'all' });
  return compose({
    vault, repos: _repos(), statements: _statements(), declared: _declared(),
    repoLinks: db.all('SELECT * FROM project_repo_links'), taskLinks: db.all('SELECT * FROM project_task_links'),
    tasks, blockers: db.all('SELECT * FROM project_blockers'), meta: _json(META_KEY), now,
  });
}

function detail(projectId, opts = {}) {
  const m = read(opts);
  const p = m.projects.find((x) => x.projectId === projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  return { ok: true, project: p, source: m.sources };
}

/** The Life view: personal projects only, ranked by focus. NOVA and every work project are absent. */
function personalView(opts = {}) {
  const m = read(opts);
  const byId = new Map(m.projects.map((p) => [p.projectId, p]));
  const projects = m.personal.map((id) => byId.get(id)).filter((p) => p && !p.hardWork && p.sphere.sphere === 'personal');
  const group = (f) => projects.filter((p) => p.focus.focus === f).map((p) => p.projectId);
  return {
    contract: 'projects-personal-v1', generatedAt: m.generatedAt, sources: m.sources,
    projects,
    focus: { ready: group('ready'), blocked: group('blocked'), waiting: group('waiting'), noNextAction: group('no-next-action'), parked: group('parked'), closed: group('closed') },
    needsClassifying: m.needsClassifying,
    unlinkedRepos: m.repos.filter((r) => !r.linked && !r.archived && r.sphere.sphere !== 'work').map((r) => ({ repoId: r.repoId, fullName: r.fullName, pushedAt: r.pushedAt, lastMeaningfulAt: r.lastMeaningfulAt, likely: r.links.filter((l) => l.state === 'likely') })),
    likelyLinks: m.projects.filter((p) => p.sphere.sphere !== 'work' && !p.hardWork).flatMap((p) => p.repos.filter((l) => l.state === 'likely').map((l) => ({ projectId: p.projectId, project: p.name, repoId: l.repoId, fullName: l.fullName, why: l.why }))),
    counts: m.counts,
    rule: m.rule,
  };
}

// ── refresh + semantic Activity ──────────────────────────────────────────────

function refresh({ now = Date.now() } = {}) {
  const db = _db();
  _vaultCache = null;
  const m = read({ now, freshVault: true });
  const firstRun = !db.getState(BASELINE_KEY);
  const nowIso = _iso(now);
  let logged = 0;
  for (const p of m.projects) {
    const prev = db.get('SELECT * FROM projects WHERE project_id = ?', [p.projectId]);
    const prior = prev && prev.derived_json ? JSON.parse(prev.derived_json) : null;
    const milestoneKeys = [
      ...p.recentProgress.filter((x) => x.kind === 'release' || x.kind === 'milestone' || (x.kind === 'deployment')).map((x) => `${x.kind}:${x.repo || ''}:${x.ref || x.path || x.what}`),
    ];
    const derived = { status: p.status.status, statusBasis: p.status.basis, sphere: p.sphere.sphere, milestones: [...new Set([...(prior ? prior.milestones || [] : []), ...milestoneKeys])].slice(-200) };
    if (prev) db.run('UPDATE projects SET name = ?, vault_path = ?, updated_at = ?, removed_at = NULL, derived_json = ? WHERE project_id = ?', [p.name, p.vaultPath, nowIso, JSON.stringify(derived), p.projectId]);
    else db.run('INSERT INTO projects (project_id, name, origin, vault_path, repo_origin, created_at, updated_at, derived_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [p.projectId, p.name, p.origin, p.vaultPath, null, nowIso, nowIso, JSON.stringify(derived)]);
    if (firstRun) continue;
    if (!prev) { if (_log('project-discovered', { name: p.name, path: p.vaultPath }, { subjectId: p.projectId, now, dedupeKey: `project-discovered:${p.projectId}` })) logged += 1; continue; }
    if (prior && prior.status !== derived.status && derived.statusBasis !== 'you') {
      if (_log('project-status-changed', { name: p.name, from: prior.status, to: derived.status, why: p.status.why }, { subjectId: p.projectId, now, dedupeKey: `project-status-changed:${p.projectId}:${prior.status}>${derived.status}:${nowIso.slice(0, 13)}` })) logged += 1;
    }
    const before = new Set(prior ? prior.milestones || [] : []);
    for (const x of p.recentProgress) {
      if (!(x.kind === 'release' || x.kind === 'milestone' || x.kind === 'deployment')) continue;
      const k = `${x.kind}:${x.repo || ''}:${x.ref || x.path || x.what}`;
      if (before.has(k)) continue;
      if (_log('project-milestone', { name: p.name, kind: x.kind, what: x.what, repo: x.repo || null }, { subjectId: p.projectId, now, dedupeKey: `project-milestone:${p.projectId}:${k}` })) logged += 1;
    }
  }
  // A vault folder that disappeared is marked, never deleted.
  const liveIds = new Set(m.projects.map((p) => p.projectId));
  if ((m.sources.vault.state === 'read')) {
    for (const r of db.all("SELECT project_id, name FROM projects WHERE origin = 'vault' AND removed_at IS NULL")) {
      if (!liveIds.has(r.project_id)) db.run('UPDATE projects SET removed_at = ? WHERE project_id = ?', [nowIso, r.project_id]);
    }
  }
  if (firstRun) {
    db.setState(BASELINE_KEY, nowIso);
    _log('projects-discovered', { count: m.projects.length, personal: m.counts.bySphere.personal || 0, work: m.counts.bySphere.work || 0, unknown: m.counts.bySphere.unknown || 0, repos: m.repos.length }, { now, dedupeKey: 'projects-discovered' });
    logged += 1;
  }
  return { ok: true, projects: m.projects.length, repos: m.repos.length, logged, baseline: firstRun };
}

// ── Nick's statements ────────────────────────────────────────────────────────

function _project(projectId) {
  const m = read();
  return m.projects.find((p) => p.projectId === projectId) || null;
}
function _setStatement(subject, fields, now) {
  const db = _db();
  const cur = db.get('SELECT * FROM project_statements WHERE subject = ?', [subject]) || {};
  const next = { sphere: cur.sphere || null, status: cur.status || null, importance: cur.importance || null, next_task_id: cur.next_task_id || null, ...fields };
  db.run('INSERT OR REPLACE INTO project_statements (subject, sphere, status, importance, next_task_id, set_at) VALUES (?, ?, ?, ?, ?, ?)',
    [subject, next.sphere, next.status, next.importance, next.next_task_id, _iso(now)]);
}

/**
 * 9 Oct 2026 — the vault is the source of truth for projects (Nick). A statement
 * about a project that HAS a hub note is written into the hub's frontmatter
 * (`status:` / `sphere:`), surgically, through the one frontmatter writer; NEURO
 * keeps no copy. Only a project with no hub (a repo Nick declared, a folder with
 * no hub note) falls back to project_statements. Returns true when written.
 */
function _writeHub(p, key, value, { vaultRoot = process.env.OBSIDIAN_VAULT_PATH } = {}) {
  if (!p || !p.hubPath || !vaultRoot) return false;
  const file = path.join(vaultRoot, ...p.hubPath.split('/'));
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const fe = require('./frontmatter-edit');
  const next = value == null ? fe.removeFrontmatterKey(text, key) : fe.upsertFrontmatterValue(text, key, value);
  if (next !== text) fs.writeFileSync(file, next);
  _vaultCache = null;
  return true;
}

function classifyProject(projectId, { sphere } = {}, { now = Date.now() } = {}) {
  if (!M.SPHERES.includes(sphere)) return { ok: false, status: 400, error: `sphere must be one of ${M.SPHERES.join(', ')}` };
  const p = _project(projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  if (p.hardWork && sphere !== 'work') return { ok: false, status: 409, error: 'NOVA is work by rule and cannot be reclassified here' };
  if (_writeHub(p, 'sphere', sphere === 'unknown' ? null : sphere)) _setStatement(`project:${projectId}`, { sphere: null }, now);
  else _setStatement(`project:${projectId}`, { sphere: sphere === 'unknown' ? null : sphere }, now);
  _log('project-classified', { name: p.name, sphere }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-classified:${projectId}:${now}` });
  return { ok: true, project: _project(projectId) };
}

function setProjectStatus(projectId, { status, importance } = {}, { now = Date.now() } = {}) {
  if (status !== undefined && status !== null && !M.STATUSES.includes(status)) return { ok: false, status: 400, error: `status must be one of ${M.STATUSES.join(', ')} or null` };
  if (importance !== undefined && importance !== null && !M.IMPORTANCE.includes(importance)) return { ok: false, status: 400, error: `importance must be one of ${M.IMPORTANCE.join(', ')} or null` };
  if (status === undefined && importance === undefined) return { ok: false, status: 400, error: 'send status and/or importance (null clears)' };
  const p = _project(projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  const f = {};
  if (status !== undefined) {
    // Into the hub note when there is one; NEURO's own record only when there is not.
    if (_writeHub(p, 'status', status === 'unknown' ? null : status)) f.status = null;
    else f.status = status === 'unknown' ? null : status;
  }
  if (importance !== undefined) f.importance = importance;
  _setStatement(`project:${projectId}`, f, now);
  if (status !== undefined) _log('project-status-set', { name: p.name, status: status || 'cleared', was: p.status.status }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-status-set:${projectId}:${now}` });
  return { ok: true, project: _project(projectId) };
}

function linkRepo(projectId, { repoId, state, role = 'primary' } = {}, { now = Date.now() } = {}) {
  const id = Number(repoId);
  if (!Number.isInteger(id)) return { ok: false, status: 400, error: 'repoId (GitHub numeric id) is required' };
  if (state !== null && !['confirmed', 'rejected'].includes(state)) return { ok: false, status: 400, error: "state must be 'confirmed', 'rejected' or null" };
  if (!['primary', 'secondary'].includes(role)) return { ok: false, status: 400, error: "role must be 'primary' or 'secondary'" };
  const p = _project(projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  const repo = _db().get('SELECT full_name FROM project_repos WHERE repo_id = ?', [id]);
  if (!repo) return { ok: false, status: 404, error: 'NEURO has not seen that repo in a GitHub snapshot' };
  if (state === null) _db().run('DELETE FROM project_repo_links WHERE project_id = ? AND repo_id = ?', [projectId, id]);
  else _db().run('INSERT OR REPLACE INTO project_repo_links (project_id, repo_id, state, role, set_at) VALUES (?, ?, ?, ?, ?)', [projectId, id, state, role, _iso(now)]);
  _log(state === 'rejected' ? 'project-repo-rejected' : state === null ? 'project-repo-cleared' : 'project-repo-linked', { name: p.name, repo: repo.full_name, role }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-repo:${projectId}:${id}:${now}` });
  return { ok: true, project: _project(projectId) };
}

function linkTask(projectId, { taskId, state } = {}, { now = Date.now() } = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id)) return { ok: false, status: 400, error: 'taskId is required' };
  if (state !== null && !['linked', 'unlinked'].includes(state)) return { ok: false, status: 400, error: "state must be 'linked', 'unlinked' or null" };
  const t = _db().getTaskRow ? _db().getTaskRow(id) : _db().get('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!t) return { ok: false, status: 404, error: 'no such task' };
  const p = _project(projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  if (state === null) _db().run('DELETE FROM project_task_links WHERE project_id = ? AND task_id = ?', [projectId, id]);
  else _db().run('INSERT OR REPLACE INTO project_task_links (project_id, task_id, state, set_at) VALUES (?, ?, ?, ?)', [projectId, id, state, _iso(now)]);
  _log(state === 'linked' ? 'project-task-linked' : 'project-task-unlinked', { name: p.name, task: t.text }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-task:${projectId}:${id}:${now}` });
  return { ok: true, project: _project(projectId) };
}

function pinNext(projectId, { taskId } = {}, { now = Date.now() } = {}) {
  const p = _project(projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  if (taskId !== null) {
    const id = Number(taskId);
    if (!p.tasks.open.some((t) => t.id === id)) return { ok: false, status: 409, error: 'only an open task linked to this project can be its next action' };
    _setStatement(`project:${projectId}`, { next_task_id: id }, now);
  } else _setStatement(`project:${projectId}`, { next_task_id: null }, now);
  return { ok: true, project: _project(projectId) };
}

function addBlocker(projectId, { what, unblock = null, owner = 'nick', taskId = null } = {}, { now = Date.now() } = {}) {
  if (!(typeof what === 'string' && what.trim().length >= 3)) return { ok: false, status: 400, error: 'what blocks it is required' };
  if (!['nick', 'other'].includes(owner)) return { ok: false, status: 400, error: "owner must be 'nick' or 'other'" };
  const p = _project(projectId);
  if (!p) return { ok: false, status: 404, error: 'no such project' };
  const id = `b:${crypto.randomUUID()}`;
  _db().run('INSERT INTO project_blockers (blocker_id, project_id, what, unblock, owner, task_id, source, since, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, projectId, what.trim().slice(0, 200), unblock ? String(unblock).slice(0, 200) : null, owner, taskId != null ? Number(taskId) : null, 'you', _iso(now), 'open']);
  _log('project-blocker-opened', { name: p.name, what: what.trim().slice(0, 200), owner }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-blocker-opened:${id}` });
  return { ok: true, blockerId: id, project: _project(projectId) };
}

function resolveBlocker(projectId, blockerId, { resolution = null } = {}, { now = Date.now() } = {}) {
  const b = _db().get('SELECT * FROM project_blockers WHERE blocker_id = ? AND project_id = ?', [blockerId, projectId]);
  if (!b) return { ok: false, status: 404, error: 'no such blocker (a blocker written in the hub note is resolved by ticking or removing it there)' };
  if (b.state === 'resolved') return { ok: true, already: true, project: _project(projectId) };
  _db().run("UPDATE project_blockers SET state = 'resolved', resolved_at = ?, resolution = ? WHERE blocker_id = ?", [_iso(now), resolution ? String(resolution).slice(0, 200) : null, blockerId]);
  const p = _project(projectId);
  _log('project-blocker-resolved', { name: p ? p.name : projectId, what: b.what }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-blocker-resolved:${blockerId}` });
  return { ok: true, project: p };
}

function classifyRepo(repoId, { sphere } = {}, { now = Date.now() } = {}) {
  const id = Number(repoId);
  if (!M.SPHERES.includes(sphere)) return { ok: false, status: 400, error: `sphere must be one of ${M.SPHERES.join(', ')}` };
  const r = _db().get('SELECT * FROM project_repos WHERE repo_id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'NEURO has not seen that repo' };
  if (M.isHardWorkRepo({ id, fullName: r.full_name }) && sphere !== 'work') return { ok: false, status: 409, error: 'NOVA is work by rule' };
  _setStatement(`repo:${id}`, { sphere: sphere === 'unknown' ? null : sphere }, now);
  _log('project-repo-classified', { repo: r.full_name, sphere }, { subjectId: `repo:${id}`, actor: 'nick', now, dedupeKey: `project-repo-classified:${id}:${now}` });
  return { ok: true };
}

function classifyOwner(owner, { sphere } = {}, { now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(String(owner || ''))) return { ok: false, status: 400, error: 'owner must be a GitHub login' };
  if (!M.SPHERES.includes(sphere)) return { ok: false, status: 400, error: `sphere must be one of ${M.SPHERES.join(', ')}` };
  _setStatement(`owner:${owner}`, { sphere: sphere === 'unknown' ? null : sphere }, now);
  _log('project-owner-classified', { owner, sphere }, { subjectId: `owner:${owner}`, actor: 'nick', now, dedupeKey: `project-owner-classified:${owner}:${now}` });
  return { ok: true };
}

/** Nick makes a project out of a repo that has no vault project. A project is his statement, never inferred from a repo existing. */
function declareFromRepo({ repoId, name = null } = {}, { now = Date.now() } = {}) {
  const id = Number(repoId);
  const r = _db().get('SELECT * FROM project_repos WHERE repo_id = ?', [id]);
  if (!r) return { ok: false, status: 404, error: 'NEURO has not seen that repo' };
  const projectId = `p:repo-${id}`;
  const exists = _db().get('SELECT project_id FROM projects WHERE project_id = ?', [projectId]);
  if (exists) return { ok: true, already: true, projectId };
  const nm = String(name || r.name).trim().slice(0, 80);
  _db().run("INSERT INTO projects (project_id, name, origin, vault_path, repo_origin, created_at, updated_at) VALUES (?, ?, 'declared', NULL, ?, ?, ?)", [projectId, nm, id, _iso(now), _iso(now)]);
  _log('project-declared', { name: nm, repo: r.full_name }, { subjectId: projectId, actor: 'nick', now, dedupeKey: `project-declared:${projectId}` });
  return { ok: true, projectId, project: _project(projectId) };
}

// ── Future Radar: real dated things only ────────────────────────────────────

/**
 * Personal projects only. A stated deadline in the window, or an open task
 * linked explicitly (by Nick or by its own source path) with a date. Never
 * inactivity, never "no commits", never an undated project.
 */
function radar({ today, last, now = Date.now() } = {}) {
  const items = [];
  try {
    const v = personalView({ now });
    const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    const days = (d) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
    for (const p of v.projects) {
      if (p.status.status === 'parked' || p.status.status === 'paused' || p.status.status === 'completed' || p.status.status === 'abandoned') continue;
      if (p.deadline && p.deadline >= today && p.deadline <= last) {
        const d = days(p.deadline);
        items.push({ id: `project:${p.projectId}:deadline`, title: `${p.name} — deadline`, date: p.deadline, kind: 'project', projectId: p.projectId,
          actionState: d <= 1 ? 'needs_you' : p.nextAction ? 'preparation_open' : 'none', linkedTaskRefs: [],
          whyVisible: [`the ${p.name} hub note states a deadline`, p.nextAction ? `next: ${p.nextAction.text}` : 'no next action is stated'] });
      }
      for (const t of p.tasks.open) {
        if (!t.due || !(t.basis === 'you' || t.basis === 'source-path')) continue;
        const d = days(t.due);
        const inWin = t.due >= today && t.due <= last;
        const overdue = d < 0 && d >= -14;
        if (!inWin && !overdue) continue;
        items.push({ id: `task:neuro:${t.id}`, title: t.text, date: t.due, kind: 'project-task', projectId: p.projectId,
          actionState: d <= 1 ? 'needs_you' : 'preparation_open', linkedTaskRefs: [`task:neuro:${t.id}`],
          whyVisible: [`an open task in your personal project ${p.name} (${t.basis === 'you' ? 'you linked it' : 'it came from the project\'s notes'})`, d < 0 ? `${-d} day${d === -1 ? '' : 's'} past its date` : d === 0 ? 'due today' : d === 1 ? 'due tomorrow' : `due ${t.due}`] });
      }
    }
    void addDays;
  } catch (e) { return { items, error: e.message }; }
  return { items };
}

const TABLES = ['projects', 'project_repos', 'project_repo_evidence', 'project_statements', 'project_repo_links', 'project_task_links', 'project_blockers'];

module.exports = {
  META_KEY, TABLES, SNAPSHOT_FRESH_HOURS,
  readVault, ingestSnapshot, compose, read, detail, personalView, refresh, radar, sourceState,
  classifyProject, setProjectStatus, linkRepo, linkTask, pinNext, addBlocker, resolveBlocker, classifyRepo, classifyOwner, declareFromRepo,
  _resetCache() { _vaultCache = null; },
};
