'use strict';

/**
 * Build 24 — /api/projects: personal projects, read-only towards GitHub.
 *
 * NEURO holds no GitHub credential and nothing here writes to GitHub. The only
 * machine write is the metadata snapshot a reporter pushes (ingest). Every
 * other write is Nick's statement — whose a project is, its status, a repo or
 * task link, a blocker — and the authority matrix refuses machines on all of
 * them. Literal paths are registered before `/:projectId`.
 */

const express = require('express');
const router = express.Router();

const pj = () => require('../services/projects');
const send = (res, out) => (out && out.ok === false ? res.status(out.status || 400).json(out) : res.json(out));
const fail = (res, e) => { console.error('[Projects]', e.message); res.status(500).json({ ok: false, error: e.message }); };

// GET /api/projects — every project NEURO knows: vault project folders and repos you made projects, each with whose it is, status, last activity, last meaningful progress, blockers, next action and linked repos/tasks. Keywords: projects, side projects, repos, GitHub, what am I working on.
router.get('/', (req, res) => {
  try {
    const m = pj().read();
    const sphere = req.query.sphere;
    if (sphere && !['personal', 'work', 'other', 'unknown'].includes(sphere)) return res.status(400).json({ ok: false, error: 'sphere must be personal, work, other or unknown' });
    res.json(sphere ? { ...m, projects: m.projects.filter((p) => p.sphere.sphere === sphere) } : m);
  } catch (e) { fail(res, e); }
});

// GET /api/projects/personal — personal projects only (never NOVA or any work project), grouped by what to pick up: ready, blocked, waiting, no next action, parked. Keywords: personal projects, what to pick up next, hobby projects.
router.get('/personal', (req, res) => {
  try { res.json(pj().personalView()); } catch (e) { fail(res, e); }
});

// GET /api/projects/repos — the GitHub repos NEURO has metadata for, whose each is (unknown unless stated), links to projects, last activity vs last meaningful progress, and the org counts that were not ingested. Keywords: GitHub repos, repositories.
router.get('/repos', (req, res) => {
  try { const m = pj().read(); res.json({ ok: true, source: m.sources.github, repos: m.repos, counts: m.counts }); } catch (e) { fail(res, e); }
});

// POST /api/projects/github/snapshot — a GitHub METADATA snapshot from the reporter that holds Nick's credential: repo identity, bounded commit subjects with file-class counts (never paths or code), merged PRs, closed issues, releases, deployments, local checkouts. Idempotent.
router.post('/github/snapshot', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON snapshot is required' });
    send(res, pj().ingestSnapshot(req.body));
  } catch (e) { fail(res, e); }
});

// POST /api/projects/refresh — re-read the vault's Projects folder and recompute every project now. Normally a scheduled job.
router.post('/refresh', (req, res) => {
  try { send(res, pj().refresh()); } catch (e) { fail(res, e); }
});

// POST /api/projects/declare — make a project out of a repo that has no vault project (Nick's statement). Body: repoId, name.
router.post('/declare', (req, res) => {
  try { const { repoId, name } = req.body || {}; send(res, pj().declareFromRepo({ repoId, name })); } catch (e) { fail(res, e); }
});

// POST /api/projects/repos/:repoId/classify — say whose a repo is: personal, work, other or unknown. NOVA is work by rule.
router.post('/repos/:repoId/classify', (req, res) => {
  try { const { sphere } = req.body || {}; send(res, pj().classifyRepo(req.params.repoId, { sphere })); } catch (e) { fail(res, e); }
});

// POST /api/projects/owners/:owner/classify — say whose everything owned by a GitHub org/account is (org repos are counted, not ingested). Body: sphere.
router.post('/owners/:owner/classify', (req, res) => {
  try { const { sphere } = req.body || {}; send(res, pj().classifyOwner(req.params.owner, { sphere })); } catch (e) { fail(res, e); }
});

// GET /api/projects/:projectId — one project in full: evidence, repo links with their basis, linked tasks, blockers, recent meaningful progress.
router.get('/:projectId', (req, res) => {
  try { send(res, pj().detail(req.params.projectId)); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/classify — say whose a project is: personal, work, other or unknown. Body: sphere.
router.post('/:projectId/classify', (req, res) => {
  try { const { sphere } = req.body || {}; send(res, pj().classifyProject(req.params.projectId, { sphere })); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/status — set a project's status (active, paused, parked, blocked, completed, abandoned, unknown; null clears) and/or importance (high, normal, low). Body: status, importance.
router.post('/:projectId/status', (req, res) => {
  try { const { status, importance } = req.body || {}; send(res, pj().setProjectStatus(req.params.projectId, { status, importance })); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/repos — confirm or reject a repo link (null clears). Body: repoId, state ('confirmed'|'rejected'|null), role ('primary'|'secondary').
router.post('/:projectId/repos', (req, res) => {
  try { const { repoId, state, role } = req.body || {}; send(res, pj().linkRepo(req.params.projectId, { repoId, state: state === undefined ? 'confirmed' : state, role: role || 'primary' })); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/tasks — link or unlink an existing NEURO task to the project (null clears). The task keeps its own domain. Body: taskId, state ('linked'|'unlinked'|null).
router.post('/:projectId/tasks', (req, res) => {
  try { const { taskId, state } = req.body || {}; send(res, pj().linkTask(req.params.projectId, { taskId, state: state === undefined ? 'linked' : state })); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/next — pin one open linked task as the project's next action (null clears). Body: taskId.
router.post('/:projectId/next', (req, res) => {
  try { const { taskId } = req.body || {}; send(res, pj().pinNext(req.params.projectId, { taskId: taskId === undefined ? null : taskId })); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/blockers — record what blocks a project. Body: what, unblock (what would unblock it), owner ('nick'|'other'), taskId.
router.post('/:projectId/blockers', (req, res) => {
  try { const { what, unblock, owner, taskId } = req.body || {}; send(res, pj().addBlocker(req.params.projectId, { what, unblock, owner: owner || 'nick', taskId })); } catch (e) { fail(res, e); }
});

// POST /api/projects/:projectId/blockers/:blockerId/resolve — the blocker is gone. Body: resolution.
router.post('/:projectId/blockers/:blockerId/resolve', (req, res) => {
  try { const { resolution } = req.body || {}; send(res, pj().resolveBlocker(req.params.projectId, req.params.blockerId, { resolution })); } catch (e) { fail(res, e); }
});

module.exports = router;
