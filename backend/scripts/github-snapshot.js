#!/usr/bin/env node
'use strict';

/**
 * Build 24 — GitHub METADATA reporter. Runs on a machine that already holds
 * Nick's GitHub credential (Git Credential Manager), reads repo metadata with
 * GET requests only, and posts a bounded snapshot to NEURO.
 *
 * Why here and not on the Pi: NEURO then holds NO GitHub credential at all, so
 * it cannot write to GitHub by construction — not merely by policy.
 *
 * What is sent: repo identity and metadata; up to 60 commits per repo from the
 * last 90 days with subject + per-commit COUNTS of file classes (never a path,
 * a diff or any code); merged PRs, closed issues, releases and deployments
 * (titles bounded); and which local checkouts point at which repo.
 *
 * Scope (never "everything visible"): repos the signed-in account owns, repos
 * with a local checkout here, and any --include owner/name. Every other visible
 * repo is COUNTED by owner, not ingested — 1,700+ client repos are not
 * evidence about Nick's projects.
 *
 *   node backend/scripts/github-snapshot.js --dry-run     # print, send nothing
 *   node backend/scripts/github-snapshot.js               # send
 *   node backend/scripts/github-snapshot.js --register    # copy beside the agent config + daily scheduled task
 *
 * NEURO's address and machine token come from %LOCALAPPDATA%\neuro\desktop-agent.json
 * (the desktop agent's own config), or NEURO_URL / NEURO_API_TOKEN.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const MODEL = fs.existsSync(path.join(HERE, 'projects-model.js')) ? path.join(HERE, 'projects-model.js') : path.join(HERE, '..', 'services', 'projects-model.js');
const { fileClass, FILE_CLASSES } = require(MODEL);

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const REGISTER = args.includes('--register');
const includes = args.filter((a, i) => args[i - 1] === '--include').map((s) => s.toLowerCase());
const SINCE_DAYS = 90;
const MAX_DETAIL_FETCHES = 400;
const AGENT_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'neuro');
const CACHE = path.join(AGENT_DIR, 'github-snapshot-cache.json');
const SCAN_ROOTS = [path.join(os.homedir(), 'Claude'), path.join(os.homedir(), 'Claude', 'nurtur-labs'), path.join(os.homedir(), 'Claude', 'Git'), path.join(os.homedir(), 'Claude', 'windows automation'), path.join(os.homedir(), 'Documents')];

function credential() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('no GitHub credential in Git Credential Manager');
  return m[1].trim();
}

function neuroConfig() {
  if (process.env.NEURO_URL && process.env.NEURO_API_TOKEN) return { baseUrl: process.env.NEURO_URL, token: process.env.NEURO_API_TOKEN };
  const raw = fs.readFileSync(path.join(AGENT_DIR, 'desktop-agent.json'), 'utf8').replace(/^﻿/, '');
  const c = JSON.parse(raw);
  return { baseUrl: c.baseUrl, token: c.token };
}

let calls = 0;
async function gh(token, url) {
  calls += 1;
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'neuro-github-snapshot', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status === 404 || res.status === 409) return { data: null, next: null }; // 409 = empty repo
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  const link = res.headers.get('link') || '';
  const next = (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null;
  return { data: await res.json(), next };
}
async function ghAll(token, url, max = 3000) {
  const out = []; let u = url;
  while (u && out.length < max) { const { data, next } = await gh(token, u); if (!Array.isArray(data)) break; out.push(...data); u = next; }
  return out;
}

/** Local checkouts whose origin is on GitHub. Depth 1 under each scan root. */
function checkouts() {
  const out = [];
  for (const root of SCAN_ROOTS) {
    let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      let url = ''; try { url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { continue; }
      const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
      if (m) out.push({ path: dir, fullName: `${m[1]}/${m[2]}`.toLowerCase() });
    }
  }
  return out;
}

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return { files: {} }; } }
function saveCache(c) { try { fs.mkdirSync(AGENT_DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); } catch { /* cache is an optimisation */ } }

async function main() {
  if (REGISTER) return register();
  const token = credential();
  const me = (await gh(token, '/user')).data;
  const login = me.login;
  const all = await ghAll(token, '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member');
  const locals = checkouts();
  const localNames = new Set(locals.map((c) => c.fullName));
  const inScope = all.filter((r) => r.owner.login.toLowerCase() === login.toLowerCase() || localNames.has(r.full_name.toLowerCase()) || includes.includes(r.full_name.toLowerCase()));
  const scopeIds = new Set(inScope.map((r) => r.id));
  const orgCounts = {};
  for (const r of all) if (!scopeIds.has(r.id)) orgCounts[r.owner.login] = (orgCounts[r.owner.login] || 0) + 1;

  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();
  const cache = loadCache();
  let detailFetches = 0;
  const repos = [];
  for (const r of inScope) {
    const fn = r.full_name;
    const recent = r.pushed_at && Date.parse(r.pushed_at) >= Date.parse(since);
    const repo = {
      id: r.id, fullName: fn, private: r.private, archived: r.archived, fork: r.fork, defaultBranch: r.default_branch,
      pushedAt: r.pushed_at, description: r.description, openIssues: null, openPrs: null,
      commits: [], prsMerged: [], issuesClosed: [], releases: [], deployments: [],
    };
    if (!r.archived && recent) {
      const commits = (await gh(token, `/repos/${fn}/commits?since=${since}&per_page=60`)).data || [];
      for (const c of commits.slice(0, 60)) {
        const sha = c.sha.slice(0, 12);
        let files = cache.files[`${r.id}:${sha}`] || null;
        if (!files && detailFetches < MAX_DETAIL_FETCHES) {
          const d = (await gh(token, `/repos/${fn}/commits/${c.sha}`)).data;
          detailFetches += 1;
          if (d && Array.isArray(d.files)) {
            files = Object.fromEntries(FILE_CLASSES.map((k) => [k, 0]));
            for (const f of d.files) files[fileClass(f.filename)] += 1;
            cache.files[`${r.id}:${sha}`] = files;
          }
        }
        repo.commits.push({ sha, at: c.commit.author && c.commit.author.date, subject: String(c.commit.message || '').split('\n')[0], merge: (c.parents || []).length > 1, files,
          byAccount: c.author ? c.author.login === login : null });
      }
      const openPrs = await ghAll(token, `/repos/${fn}/pulls?state=open&per_page=100`, 300);
      repo.openPrs = openPrs.length;
      repo.openIssues = Math.max(0, (r.open_issues_count || 0) - openPrs.length);
      const closedPrs = (await gh(token, `/repos/${fn}/pulls?state=closed&sort=updated&direction=desc&per_page=30`)).data || [];
      repo.prsMerged = closedPrs.filter((p) => p.merged_at && p.merged_at >= since).map((p) => ({ number: p.number, at: p.merged_at, title: p.title }));
      const issues = (await gh(token, `/repos/${fn}/issues?state=closed&since=${since}&per_page=30`)).data || [];
      repo.issuesClosed = issues.filter((i) => !i.pull_request && i.closed_at && i.closed_at >= since).map((i) => ({ number: i.number, at: i.closed_at, title: i.title }));
      const rel = (await gh(token, `/repos/${fn}/releases?per_page=10`)).data || [];
      repo.releases = rel.filter((x) => !x.draft && x.published_at).map((x) => ({ tag: x.tag_name, at: x.published_at, name: x.name }));
      const deps = (await gh(token, `/repos/${fn}/deployments?per_page=10`)).data || [];
      for (const d of deps.slice(0, 5)) {
        const st = (await gh(token, `/repos/${fn}/deployments/${d.id}/statuses?per_page=1`)).data || [];
        repo.deployments.push({ id: d.id, at: (st[0] && st[0].created_at) || d.created_at, environment: d.environment, state: st[0] ? st[0].state : 'unknown' });
      }
    } else {
      repo.openIssues = r.open_issues_count;
    }
    repos.push(repo);
  }
  saveCache(cache);
  const snapshot = {
    fetchedAt: new Date().toISOString(), account: login, reporter: `github-snapshot on ${os.hostname()}`,
    scope: `owned by ${login}, or checked out on ${os.hostname()}${includes.length ? `, or included: ${includes.join(', ')}` : ''}`,
    totalVisible: all.length, repos, checkouts: locals, orgCounts,
  };
  const summary = { visible: all.length, inScope: repos.length, withActivity: repos.filter((r) => r.commits.length).length, commits: repos.reduce((n, r) => n + r.commits.length, 0), detailFetches, githubCalls: calls, orgCounts };
  if (DRY) { console.log(JSON.stringify(summary, null, 2)); console.log(repos.map((r) => `${r.fullName}  pushed ${String(r.pushedAt).slice(0, 10)}  commits ${r.commits.length}`).join('\n')); return; }
  const cfg = neuroConfig();
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/api/projects/github/snapshot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NEURO-API-TOKEN': cfg.token, 'X-Neuro-Machine-Client': 'github-snapshot' }, body: JSON.stringify(snapshot),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(`NEURO refused the snapshot (${res.status}): ${body.error || 'no reason given'}`);
  console.log(JSON.stringify({ ...summary, neuro: { repos: body.repos, evidenceAdded: body.evidenceAdded, redacted: body.redacted, dropped: body.dropped } }));
}

/** Copy this script and the model beside the agent config, and run it daily. Re-run after changing either file. */
function register() {
  const dir = path.join(AGENT_DIR, 'github-snapshot');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(__filename, path.join(dir, 'github-snapshot.js'));
  fs.copyFileSync(MODEL, path.join(dir, 'projects-model.js'));
  const tr = `"${process.execPath}" "${path.join(dir, 'github-snapshot.js')}"`;
  execFileSync('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/ST', '07:40', '/TN', 'NEURO GitHub snapshot', '/TR', tr], { stdio: 'inherit' });
  console.log(`Registered: daily 07:40 → ${tr}`);
}

main().catch((e) => { console.error(`[github-snapshot] ${e.message}`); process.exit(1); });
