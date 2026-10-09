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
// POST /api/canonical/commitments/:id/resolve — close a commitment at its owner: done, or not-owed (dropped). Keywords: mark commitment done, not owed, close commitment. Body: outcome (done|not-owed).
router.post('/commitments/:id/resolve', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { outcome } = req.body;
    const out = require('../services/commitment-actions').resolve(req.params.id, outcome);
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/commitments/:id/who — say who owes a commitment owed to you, by the full name of a People note. Keywords: resolve who, set promisor, unresolved person. Body: name.
router.post('/commitments/:id/who', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { name } = req.body;
    const out = require('../services/commitment-actions').setPromisor(req.params.id, name);
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

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
    // Build 19W: one Activity line per classification Nick makes. Build 20B:
    // tracking and classification are separate decisions, so a list's
    // tracking change is its own line ("tracked" / "ignored" / undecided).
    const c = out.classification;
    const po = require('../services/personal-obligations');
    const name = (c && c.label) || label || sourceKey;
    const at = Date.now();
    if (kind === 'reminder-list' && tracked !== undefined) {
      po.logEvent('list-tracking', { subjectId: sourceKey, actor: 'nick', dedupeKey: `list-tracking:${sourceKey}:${at}`, detail: { label: name, tracked: tracked === null ? null : !!tracked } });
    }
    if (kind !== 'reminder-list' || classDomains !== undefined) {
      po.logEvent(kind === 'reminder-list' ? 'list-classified' : 'calendar-classified', {
        subjectId: sourceKey, actor: 'nick', dedupeKey: `classified:${sourceKey}:${at}`,
        detail: { kind, label: name, domains: c ? c.domains : [], tracked: kind === 'calendar' && c ? c.tracked : null, cleared: !c },
      });
    }
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

// POST /api/canonical/goals/:id/links — link ONE item to an active goal (explicit only; gives context, never urgency). Keywords: link task to goal, goal link. Body: entityId (task:/commitment:/meeting:/pd:/person:/companion:), relation, label.
router.post('/goals/:id/links', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { entityId, relation, label } = req.body;
    const out = canonical.addGoalLink(req.params.id, { entityId, relation, label });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/goals/:id/links/remove — take one explicit link off a goal. Keywords: unlink goal. Body: entityId, label.
router.post('/goals/:id/links/remove', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { entityId, label } = req.body;
    const out = canonical.removeGoalLink(req.params.id, { entityId, label });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/radar — Future Radar: what is coming up in Nick's life over 7, 14 or 30 days and whether anything needs doing first; every item says why it is there. Keywords: coming up, upcoming, future radar, next two weeks. Query: days (7|14|30).
router.get('/radar', (req, res) => {
  try {
    const radar = require('../services/future-radar');
    const h = radar.parseHorizon(req.query.days);
    if (!h.ok) return res.status(400).json({ ok: false, error: h.error });
    res.json(radar.read({ horizonDays: h.days }));
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/obligations — open personal obligations: tasks and commitments with an explicit non-work domain or an explicit link to a personal goal or date, with due, source, status and whether each needs Nick now. Keywords: personal tasks, life admin. Query: admin=1.
router.get('/obligations', (req, res) => {
  try {
    res.json(require('../services/personal-obligations').read({ adminOnly: req.query.admin === '1' || req.query.admin === 'true' }));
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/personal-admin — personal admin (MOT, renewals, bills, forms): the obligations whose explicit domain is admin, finance or transport, and an audit of which sources hold any. Keywords: personal admin, renewals.
router.get('/personal-admin', (req, res) => {
  try {
    const po = require('../services/personal-obligations');
    res.json({ ...po.read({ adminOnly: true }), audit: po.adminAudit(), view: require('../services/personal-admin').read() });
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/personal-admin/annotations — Nick marks a personal-admin item waiting, blocked (with a reason) or routine, corrects its kind, or sets a lead time. Body: entityId, kind, state, note, leadDays. Keywords: admin waiting, blocked, lead time.
router.post('/personal-admin/annotations', (req, res) => {
  try {
    const { entityId, kind, state, note, leadDays } = req.body || {};
    const r = require('../services/personal-admin').annotate(entityId, { kind, state, note, leadDays });
    res.status(r.ok ? 200 : r.status || 400).json(r);
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/reminder-lists — audit of every Apple Reminders list by stable id: name, app, classification, tracked and why, open/completed counts from the last push, duplicate names, source health. Keywords: reminder lists audit.
router.get('/reminder-lists', (req, res) => {
  try { res.json(require('../services/reminder-audit').read()); } catch (e) { fail(res, e); }
});

// POST /api/canonical/prep-links — Nick links a task or commitment as PREPARATION for a personal date (pd:…), calendar entry (meeting:…), person or companion. Explicit only. Keywords: link prep, preparation. Body: subjectId, entityId, label.
router.post('/prep-links', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { subjectId, entityId, label } = req.body;
    const out = require('../services/personal-obligations').linkPrep({ subjectId, entityId, label });
    if (!out.ok) return res.status(out.status || 400).json(out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/prep-links/remove — take an explicit preparation link away. Keywords: unlink prep. Body: subjectId, entityId, label.
router.post('/prep-links/remove', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { subjectId, entityId, label } = req.body;
    const out = require('../services/personal-obligations').unlinkPrep({ subjectId, entityId, label });
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

// ── Build 20: Ember care, vehicle links ─────────────────────────────────────

const care = () => require('../services/companion-care');
const failWith = (res, out) => res.status(out.status || 400).json(out);

// GET /api/canonical/companions/:id/care — a companion's care (Ember): next explicit care item, open items, recent completions, linked tasks/reminders/calendar entries, mentions (inference), walk state today and the last week. Keywords: Ember care, dog walk, vet, flea.
router.get('/companions/:id/care', (req, res) => {
  try {
    const out = care().read(req.params.id);
    if (!out.ok) return failWith(res, out);
    res.json({ ...out, contract: canonical.CONTRACT });
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/companions/:id/care — Nick adds a care item for a companion: kind (walk|vet|vaccination|flea|worm|medication|grooming|insurance|other), title, dueDate, dueTime, recurrence {every, unit day|week|month|year} only as he states it, note. Keywords: add Ember care, vet appointment.
router.post('/companions/:id/care', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { kind, title, dueDate, dueTime, recurrence, note } = req.body;
    const out = care().createItem(req.params.id, { kind, title, dueDate, dueTime, recurrence, note });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/care/:id/done — Nick marks a companion care item done (doneOn, default today). A repeat he set moves it to its next date counted from that day; otherwise it closes. Keywords: Ember care done.
router.post('/care/:id/done', (req, res) => {
  try {
    const { doneOn } = req.body || {};
    const out = care().completeItem(req.params.id, { doneOn });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/care/:id/cancel — Nick cancels a companion care item (it is no longer needed). Keywords: cancel Ember care.
router.post('/care/:id/cancel', (req, res) => {
  try {
    const out = care().cancelItem(req.params.id);
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/companions/:id/links — Nick links an existing task, reminder, calendar entry (meeting:…), commitment or personal date (pd:…) to a companion's care. Explicit only; a title mentioning Ember is not a link. Body: entityId, careKind, label. Keywords: link to Ember.
router.post('/companions/:id/links', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { entityId, careKind, label } = req.body;
    const out = care().link(req.params.id, { entityId, careKind, label });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/companions/:id/links/remove — take an explicit care link off a companion. Body: entityId, label. Keywords: unlink Ember.
router.post('/companions/:id/links/remove', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { entityId, label } = req.body;
    const out = care().unlink(req.params.id, { entityId, label });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/companions/:id/walks — Nick's own word about a day's walk for a companion: mark walked|not-applicable, day (default today; never a future day). Nick's own walking is never read as the dog's. Keywords: Ember walked, dog walk.
router.post('/companions/:id/walks', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { day, mark } = req.body;
    const out = care().markWalk(req.params.id, { day, mark });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/companions/:id/walks/remove — take back a walk mark for a day. Body: day.
router.post('/companions/:id/walks/remove', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { day } = req.body;
    const out = care().unmarkWalk(req.params.id, { day });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/vehicle-links — Nick links a personal-admin task or commitment to a vehicle he names (e.g. MOT → car): transport context only. Body: vehicle, entityId, label. Keywords: car, MOT, vehicle admin.
router.post('/vehicle-links', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { vehicle, entityId, label } = req.body;
    const out = require('../services/personal-obligations').linkVehicle({ vehicle, entityId, label });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// POST /api/canonical/vehicle-links/remove — take a vehicle link off a task or commitment. Body: vehicle, entityId, label.
router.post('/vehicle-links/remove', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { vehicle, entityId, label } = req.body;
    const out = require('../services/personal-obligations').unlinkVehicle({ vehicle, entityId, label });
    if (!out.ok) return failWith(res, out);
    res.json(out);
  } catch (e) { fail(res, e); }
});

// GET /api/canonical/lead-reminders — the lead-reminder cadence Nick set per kind of personal date (e.g. anniversary: 10, 5, 1 days before). Keywords: anniversary reminder, birthday nag.
router.get('/lead-reminders', (req, res) => {
  try { res.json({ ok: true, cadences: require('../services/date-nags').cadences(), kinds: require('../services/date-nags').KINDS }); } catch (e) { fail(res, e); }
});

// POST /api/canonical/lead-reminders — Nick sets the lead reminders for a kind of personal date: first step is Radar context, middle steps a stronger prompt, the last step Needs You and the only push (skipped when linked prep is done). Body: kind (birthday|anniversary|other), offsets (days before, e.g. [10,5,1]; null clears). Keywords: anniversary nag.
router.post('/lead-reminders', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'a JSON body is required' });
    const { kind, offsets } = req.body;
    const out = require('../services/date-nags').setCadence({ kind, offsets });
    if (!out.ok) return failWith(res, out);
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
