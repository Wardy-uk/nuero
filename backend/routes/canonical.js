'use strict';

/**
 * /api/canonical — the UI read contract (Build 10A). What NEURO currently
 * BELIEVES, read from its projections: Now, commitments, sources, findings,
 * goals, and Nick's declared life domains. See services/canonical-read.js.
 *
 * Literal paths are registered before parameterised ones (Express matches in
 * order, and this codebase has shipped a literal swallowed as a param).
 */

const express = require('express');
const canonical = require('../services/canonical-read');
const domains = require('../../shared/life-domains.cjs');

const router = express.Router();

function fail(res, e) {
  res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
}

// GET /api/canonical/now — Nick-first Now: the attention decision verbatim plus world-model situation (next meaningful event, needs you, commitments becoming relevant, source blindness that matters, crowded-out, goals). Cross-domain; calm when nothing matters.
router.get('/now', async (req, res) => {
  try {
    const view = typeof req.query.view === 'string' ? req.query.view : null;
    // `ask` moves the dashboard to what was asked about (bounded as /api/attention bounds it).
    const ask = typeof req.query.ask === 'string' && req.query.ask.trim() ? req.query.ask.trim().slice(0, 200) : null;
    const decision = view || ask ? await require('../services/attention').build({ view, ask }) : null;
    res.json({ ok: true, ...(await canonical.now({ decision })) });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/presentation — Build 12 presentation intent only: situation headline/summary, mode, P0-P4 needsYou/next/context/details, inferred activity + correction options. No layout; each renderer composes it.
router.get('/presentation', async (req, res) => {
  try {
    const out = await canonical.now({});
    res.json({ ok: true, contract: out.contract, presentation: out.presentation || null });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/needs-you — Build 12.3 P0 digest: count and items that need Nick (approvals, escalations, critical items), each with its notification policy (eligible, channels, dedupeKey, reason). What the watch complication counts and the phone may notify about.
router.get('/needs-you', async (req, res) => {
  try {
    const out = await canonical.now({});
    const p = out.presentation;
    res.json({ ok: true, contract: p ? p.contract : null, mode: p ? p.mode : null,
      p0: p && p.p0 ? p.p0 : { known: false, complete: false, count: 0, items: [], why: 'presentation unavailable' } });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/needs-you/notifications — recent P0 notification ledger rows: claimed, accepted by iOS, failed, opened (tapped), dismissed, per device. Accepted is never delivered-to-wrist.
router.get('/needs-you/notifications', (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10);
    res.json({ ok: true, notifications: require('../services/attention-notifications').recent({ limit: Number.isFinite(limit) ? limit : 20 }) });
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/needs-you/notifications/claim — a device claims the right to post one P0 notification: dedupeKey, deviceId, channel, itemId, synthetic. First claim wins; repeats answer claim:false.
router.post('/needs-you/notifications/claim', (req, res) => {
  try {
    const { dedupeKey, deviceId, channel, itemId, synthetic } = req.body || {};
    res.json({ ok: true, ...require('../services/attention-notifications').claim({ dedupeKey, deviceId, channel, itemId, synthetic }) });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

// POST /api/canonical/needs-you/notifications/event — what happened to a claimed P0 notification: event accepted|failed|opened|dismissed, dedupeKey, deviceId, channel, detail. Failed releases the claim.
router.post('/needs-you/notifications/event', (req, res) => {
  try {
    const { dedupeKey, deviceId, channel, event, detail } = req.body || {};
    res.json({ ok: true, notification: require('../services/attention-notifications').record({ dedupeKey, deviceId, channel, event, detail }) });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

// POST /api/canonical/needs-you/synthetic — start a safe synthetic P0 test (kind escalation|email, ttlMinutes <= 60) through the real attention path; contacts no external system. PIN only.
router.post('/needs-you/synthetic', (req, res) => {
  if (req.apiClient) return res.status(403).json({ ok: false, error: 'A synthetic P0 interrupts Nick — start it with the PIN, not the API token.' });
  try {
    const { kind, ttlMinutes } = req.body || {};
    res.json({ ok: true, synthetic: require('../services/synthetic-attention').inject({ kind, ttlMinutes }) });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});

// DELETE /api/canonical/needs-you/synthetic — clear every live synthetic P0 test item (or one, with ?id=).
router.delete('/needs-you/synthetic', (req, res) => {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id.slice(0, 40) : null;
    res.json({ ok: true, ...require('../services/synthetic-attention').clear(id) });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/domains — the life-domain and personal-importance vocabulary every surface renders from.
router.get('/domains', (req, res) => {
  res.json({ ok: true, contract: canonical.CONTRACT, domains: domains.DOMAINS.map((d) => ({ id: d, label: domains.LABELS[d], sensitive: domains.SENSITIVE.has(d) })),
    importance: domains.IMPORTANCE.map((i) => ({ id: i, label: domains.IMPORTANCE_LABELS[i] })) });
});

// GET /api/canonical/commitments — commitments from the world model (what I owe / what is owed to me), with counterpart, due context, meeting/task links, progress state and life domains. Query: direction=i-owe|owed-to-me, status, domain.
router.get('/commitments', (req, res) => {
  try {
    const direction = ['i-owe', 'owed-to-me'].includes(req.query.direction) ? req.query.direction : null;
    const status = ['open', 'completed', 'cancelled', 'superseded', 'unknown', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const domain = typeof req.query.domain === 'string' && (req.query.domain === 'unknown' || domains.normaliseDomain(req.query.domain))
      ? (req.query.domain === 'unknown' ? 'unknown' : domains.normaliseDomain(req.query.domain)) : null;
    res.json({ ok: true, ...canonical.commitments({ direction, status, domain }) });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/commitments/:id — one commitment with its evidence trail: provenance, progress evidence, linked task, identity resolution.
router.get('/commitments/:id', (req, res) => {
  try {
    const out = canonical.commitmentDetail(req.params.id);
    if (!out) return res.status(404).json({ ok: false, error: 'no such commitment' });
    res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/sources — what NEURO can see, from SourceHealth only: each source's transport, freshness, lifecycle (expected/optional/retired), blindness finding, and one verdict (seeing/quiet/stale/failing/unknown/retired); plus runtime jobs.
router.get('/sources', (req, res) => {
  try { res.json({ ok: true, ...canonical.sources() }); } catch (e) { fail(res, e); }
});

// GET /api/canonical/findings — what NEURO is noticing and what attention decided: every evaluator's findings (source blindness, commitment risk, meeting intelligence) with status, shadow/live, verdict and suppression reason. Query: status=active|resolved|all.
router.get('/findings', (req, res) => {
  try {
    const status = ['active', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'active';
    res.json({ ok: true, ...canonical.findings({ status }) });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/life — Nick's whole life as the world model sees it: stored goals, and per life domain how many commitments, sources, goals and upcoming events carry evidence of belonging to it (zeros kept; unknown counted).
router.get('/life', async (req, res) => {
  try { res.json({ ok: true, ...(await canonical.life()) }); } catch (e) { fail(res, e); }
});

// GET /api/canonical/tasks — tasks from the world model (NEURO, Microsoft, Apple Reminders) with due context, life domains (a reminder takes its list's classification) and personal importance. Query: system, domain, status.
router.get('/tasks', (req, res) => {
  try {
    const status = ['open', 'completed', 'cancelled', 'unknown', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const system = ['neuro', 'ms-planner', 'ms-todo', 'eventkit-reminders'].includes(req.query.system) ? req.query.system : null;
    const domain = typeof req.query.domain === 'string' && (req.query.domain === 'unknown' || domains.normaliseDomain(req.query.domain))
      ? (req.query.domain === 'unknown' ? 'unknown' : domains.normaliseDomain(req.query.domain)) : null;
    res.json({ ok: true, ...canonical.tasks({ status, system, domain }) });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/classifications — every calendar and reminder list the sources have shown, with what Nick classified each as (life domains, tracked), how it is keyed (id or title) and whether its title is ambiguous.
router.get('/classifications', (req, res) => {
  try {
    const sc = require('../services/source-classification');
    res.json({ ok: true, contract: canonical.CONTRACT, containers: sc.listContainers() });
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/classifications/entries — what one calendar or reminder list holds: upcoming/open entries and past/completed ones, titles and dates only. Keywords: calendar entries, reminder list items, view calendar. Query: kind (calendar|reminder-list), sourceKey, limit.
router.get('/classifications/entries', (req, res) => {
  try {
    const sc = require('../services/source-classification');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const out = sc.containerEntries(String(req.query.kind || ''), String(req.query.sourceKey || ''), { limit });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json({ ...out, contract: canonical.CONTRACT });
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/classifications — Nick classifies a calendar or reminder list (life domains, and for a list whether it is tracked). Keywords: classify calendar, reminder list domain. Body: kind, sourceKey, domains, tracked, label.
router.post('/classifications', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { kind, sourceKey, domains: classDomains, tracked, label } = req.body;
    const out = require('../services/source-classification').classify({ kind, sourceKey, domains: classDomains, tracked, label });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/goals — Nick's explicitly stored goals and intentions, with importance, dates and explicit links. Never inferred. Query: status=active|paused|achieved|dropped|all.
router.get('/goals', (req, res) => {
  try {
    const raw = req.query.status === 'done' ? 'achieved' : req.query.status;
    const status = [...canonical.GOAL_STATUSES, 'all'].includes(raw) ? raw : 'active';
    res.json({ ok: true, contract: canonical.CONTRACT, goals: canonical.listGoals({ status }) });
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/goals — store a goal or intention Nick states (hike more, finish the degree). Body: title, description, domains, importance, startDate, reviewDate, links. Creates nothing else: no task, no nudge.
router.post('/goals', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { title, description, domains: goalDomains, note, importance, startDate, reviewDate, links } = req.body;
    const out = canonical.saveGoal({ title, description, domains: goalDomains, note, importance, startDate, reviewDate, links });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/goals/:id — update a stored goal: title, description, domains, importance, status (active|paused|achieved|dropped), startDate, reviewDate, links (replaces), reviewed (stamps last reviewed).
router.post('/goals/:id', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { title, description, domains: goalDomains, note, status, importance, startDate, reviewDate, links, reviewed } = req.body;
    const out = canonical.saveGoal({ id: req.params.id, title, description, domains: goalDomains, note, status, importance, startDate, reviewDate, links, reviewed });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/companions — create a companion (pet) by writing Companions/<name>.md with type: pet. Keywords: add pet, create companion, Ember. Body: name, species, breed, household. Never overwrites an existing note.
router.post('/companions', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { name, species, breed, household } = req.body;
    const out = require('../services/personal-world').createCompanion({ name, species, breed, household });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/annotations — Nick declares which life domains a thing belongs to and/or its personal importance. Body: entityId, domains (list, null clears), importance (critical-to-me|important-to-me|normal|restorative|optional|work-critical, null clears). Omitted fields are left alone.
router.post('/annotations', (req, res) => {
  try {
    const { entityId, domains: tagDomains, importance } = req.body || {};
    const out = canonical.setAnnotation(entityId, { domains: tagDomains, importance });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

module.exports = router;
