'use strict';

/**
 * Escalations — the desk surface for "this ticket needs to jump the queue".
 *
 * Nick gets asked for escalations verbally and in Teams, usually with a ticket
 * number and a reason that never makes it anywhere durable. This is the form:
 * type the key, see what the ticket actually is, say why, done.
 *
 * NOVA owns every rule (internal-only comment, tighten-only due date,
 * raise-only priority) and every write. This route is a thin, honest pipe —
 * it deliberately re-implements none of that logic, because two copies of a
 * safety rule is one copy too many.
 *
 * Unlike the chat tool, submitting here is NOT queued for approval. The chat
 * tool queues because SAiM is acting on an inferred intention; here Nick has
 * typed the ticket key, read the detail back and pressed the button. A second
 * approval step for a form he just filled in is friction, not safety — so the
 * UI confirms what will change before it posts, and that confirmation IS the gate.
 */

const express = require('express');
const router = express.Router();
const nova = require('../services/nova-client');
const jira = require('../services/jira');

/**
 * How far back the urgency arm asks NOVA's log — #104.
 *
 * This was 90 days, and a 90-day window is a SILENT cap: an urgency escalation
 * older than that on a still-open ticket simply stopped being badged, and
 * "still open 91 days after being escalated" is precisely the ticket Nick would
 * most want to see. That is the fifth instance of this species here (calendar
 * `$top=50`, the 1,958-key JQL, Planner `$top=200`, the escalation `isLast`).
 *
 * Measured before changing it: over the log's ENTIRE life it holds exactly TWO
 * manual escalations, both raised on 15 Aug 2026, so the incidence of the bug
 * today is zero — widening 90 → 3650 days moves 1,935 rows to 2,352 and finds
 * the same 2. So this is not a fix for a live symptom; it retires the cap
 * before the population is old enough to hit it, which costs ~400 extra rows on
 * a route that is not hot.
 *
 * Ten years is "the whole log" rather than a tuned number — a window nobody can
 * age out of is the only kind that never needs revisiting. And the response
 * NAMES it either way, because a number that cannot state its own edge is the
 * actual defect: honest beats wide.
 */
const URGENCY_WINDOW_DAYS = 3650;

function requireNova(req, res, next) {
  if (!nova.isConfigured()) {
    return res.status(503).json({
      error: 'NOVA is not configured — set NOVA_BRIDGE_URL and NOVA_BRIDGE_SECRET',
    });
  }
  next();
}

/** ADF or plain string → readable text. Jira descriptions arrive as a doc tree. */
function adfText(node, depth = 0) {
  if (!node || depth > 12) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(n => adfText(n, depth + 1)).join('');
  if (node.type === 'text') return node.text || '';
  const inner = adfText(node.content, depth + 1);
  // Block-level nodes need a break after them or the whole thing runs together.
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

/**
 * GET /api/escalation/active — what is escalated right now.
 *
 * Three populations, two systems. Jira answers the first two (Request Type =
 * Escalation, and Current Tier = Escalations) directly, because those are
 * facts on the ticket. The third — an urgency escalation raised here or in
 * NOVA — changes priority and the due date but deliberately leaves the tier
 * alone, so it writes NOTHING to Jira identifying the ticket as escalated:
 * NOVA's escalation_log is the only record it happened. That is why NT-28062
 * and NT-28075 were escalated and still invisible to a Jira-only query.
 *
 * NOVA supplies the keys, Jira says which are still open — neither source can
 * answer it alone.
 *
 * Deliberately NOT behind `requireNova`: the two Jira arms are the bulk of the
 * list and must still render on a day the bridge is down. When it is down the
 * response carries a `warning` rather than quietly returning a short list,
 * because a list that silently omits a population is worse than no list.
 */
router.get('/active', async (req, res) => {
  if (!jira.isConfigured()) {
    return res.status(503).json({ error: 'Jira is not configured' });
  }

  let escalations;
  try {
    escalations = await jira.fetchActiveEscalations();
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Jira: ${e.message}` });
  }

  let warning = null;
  // What the urgency arm actually did, so the caller never has to assume. All
  // three states are distinct: `off` (not configured), `error` (NOVA refused) and
  // `ok` — and only `ok` means the count below is the whole population.
  const urgency = {
    state: 'off',
    windowDays: URGENCY_WINDOW_DAYS,
    logRows: null,
    manual: null,
  };
  if (nova.isConfigured()) {
    try {
      // Manual only, and that is a semantic choice rather than a filter for
      // speed. The other types already show up in the Jira arms or are not
      // escalations in this sense: `jira_transition` IS a tier move, so the
      // tier arm has it; `ai_agent` is the AI raising one. Only a manual
      // urgency escalation leaves no trace in Jira, which is the entire reason
      // this arm exists — and badging 1,300 old tier moves "urgency" would be
      // untrue as well as unreadable.
      // Filtered again here rather than trusting the query param: an older NOVA
      // ignores `type` and answers with all ~1,950 rows, and this route should
      // be correct against whichever version is deployed rather than only the
      // one it shipped alongside.
      const raw = await nova.listEscalations({ days: URGENCY_WINDOW_DAYS, type: 'manual' }) || [];
      const logged = raw.filter(e => e.escalation_type === 'manual');
      urgency.state = 'ok';
      urgency.logRows = raw.length;
      urgency.manual = logged.length;
      const byKey = new Map(escalations.map(t => [t.key, t]));

      // Anything the log knows about that the tier/request-type arms missed
      // still has to be checked against Jira — the log has no idea whether the
      // ticket has since been closed.
      const unknown = logged.map(e => e.ticket_key).filter(k => !byKey.has(k));
      for (const t of await jira.fetchOpenIssuesByKey(unknown)) {
        byKey.set(t.key, t);
        escalations.push(t);
      }

      for (const e of logged) {
        const t = byKey.get(e.ticket_key);
        if (!t) continue;   // closed since, or not in this project
        t.viaUrgency = true;
        t.urgencyReason = e.reason_label || e.reason_code || null;
        t.escalatedBy = e.escalated_by || null;
        t.escalatedAt = e.created_at || null;
      }
    } catch (e) {
      urgency.state = 'error';
      warning = `Urgency escalations are missing from this list — NOVA said: ${e.message}`;
    }
  } else {
    warning = 'Urgency escalations are missing from this list — NOVA is not configured.';
  }

  escalations.sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));

  // #105 — which of these are actually waiting on Nick. Decided in the service so
  // this tab and the Focus card cannot disagree about what "needs a reply" means.
  const decorated = jira.decorateWithReplyState(escalations);
  const awaitingReply = decorated.filter(e => e.needsReply).length;

  // Tickets Tier 2 rejected, awaiting approval — their own section. Read live
  // and folded into the seen-store, so the tab and the sidebar count agree.
  // null (never []) when Jira could not answer: an unread section is not empty.
  let rejections = null;
  let rejectionsError = null;
  try {
    const list = await jira.fetchPendingRejections();
    jira.absorbRejections(list);
    rejections = jira.decorateRejections(list);
  } catch (e) {
    rejectionsError = `Could not read ${jira.PENDING_REJECTION_STATUS}: ${e.message}`;
  }

  res.json({
    escalations: decorated,
    awaitingReply,
    total: decorated.length,
    rejections,
    rejectionsError,
    // #104 — the list states the window it used. A count that cannot describe
    // its own edge is indistinguishable from a complete one, which is how a cap
    // stays invisible until the day it starts cutting.
    urgency,
    warning,
  });
});

/**
 * GET /api/escalation/counts — the sidebar badge for Escalations. Unseen =
 * escalations waiting on Nick (no reply from him, not acknowledged, not
 * delegated) + pending-rejection tickets he has not opened. Local reads only.
 */
router.get('/counts', (req, res) => {
  const escalations = jira.getUnseenEscalationCount();
  const rejections = jira.getUnseenRejectionCount();
  res.json({ unseen: escalations + rejections, escalations, rejections });
});

/** POST /api/escalation/rejections/seen {keys} — Nick opened these rows. */
router.post('/rejections/seen', (req, res) => {
  const { keys } = req.body || {};
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ ok: false, error: 'keys (array) is required' });
  res.json({ ok: true, marked: jira.markRejectionsSeen(keys.map(String)) });
});

// GET /api/escalation/reasons — the urgency vocabulary, for the picker.
router.get('/reasons', requireNova, async (req, res) => {
  try {
    res.json({ reasons: await nova.listUrgencyReasons() });
  } catch (e) {
    res.status(502).json({ error: `Could not reach NOVA: ${e.message}` });
  }
});

// GET /api/escalation/ticket/:key — enough detail to know it is the right ticket.
router.get('/ticket/:key', requireNova, async (req, res) => {
  const key = String(req.params.key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    return res.status(400).json({ error: `"${key}" is not a ticket key (expected e.g. NT-28061)` });
  }
  try {
    const t = await nova.getTicket(key);
    // NOVA returns every navigable field; the form needs a handful.
    res.json({
      ticket: {
        key: t.key,
        summary: t.summary || null,
        status: t.status?.name || null,
        statusCategory: t.status?.statusCategory?.key || null,
        priority: t.priority?.name || null,
        duedate: t.duedate || null,
        tier: t.customfield_12981?.value || null,
        assignee: t.assignee?.displayName || null,
        reporter: t.reporter?.displayName || null,
        created: t.created || null,
        updated: t.updated || null,
        description: adfText(t.description).trim().slice(0, 2000) || null,
        // Newest first, and flagged so an internal note isn't mistaken for
        // something the customer has already been told.
        comments: (t.comments || []).slice(-5).reverse().map(c => ({
          // The bridge flattens author to a string; Jira's own shape is an object.
          // Handle both, or every comment reads "Unknown".
          author: (typeof c.author === 'string' ? c.author : c.author?.displayName) || 'Unknown',
          created: c.created,
          internal: c.jsdPublic === false,
          text: adfText(c.body).trim().slice(0, 600),
        })),
      },
    });
  } catch (e) {
    const notFound = /not found|404/i.test(e.message);
    res.status(notFound ? 404 : 502).json({ error: notFound ? `${key} not found` : `Could not reach NOVA: ${e.message}` });
  }
});

// POST /api/escalation — do it. NOVA applies the rules and reports what changed.
//
// Build 13L: this writes to Jira (raise-only priority, tighten-only due date,
// one internal comment, through NOVA). It is registered as `nova.escalate` in
// services/external-writes.js — A3, human-only: Nick's submit of the exact
// ticket and reason IS the approval, so a machine client (API token) is
// refused; the ledger row is written BEFORE NOVA is called, the same ticket +
// reason on the same day is never escalated twice, an unknown outcome blocks
// a repeat until Nick resolves it, and the ticket is read back afterwards.
router.post('/', requireNova, async (req, res) => {
  if (req.apiClient) {
    return res.status(403).json({ error: 'Escalating a Jira ticket needs Nick, in NEURO — a machine client cannot do it on his behalf (Build 13L).' });
  }
  const { ticket_key, reason_code, needed_by, notes } = req.body || {};
  if (!ticket_key) return res.status(400).json({ error: 'ticket_key is required' });
  if (!reason_code) return res.status(400).json({ error: 'reason_code is required' });
  if (needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(needed_by)) {
    return res.status(400).json({ error: 'needed_by must be YYYY-MM-DD' });
  }
  const r = await require('../services/nova-escalation').escalate({
    ticketKey: ticket_key, reasonCode: reason_code, neededBy: needed_by || null, notes: notes || null,
  });
  if (r.ok) return res.json({ result: r.result, ledger: r.ledger, outcome: r.outcome, duplicate: !!r.duplicate, note: r.note || null });
  const code = r.outcome === 'blocked' ? 409 : r.outcome === 'refused' ? 400 : 502;
  return res.status(code).json({ error: r.error, outcome: r.outcome, ledger: r.ledger || null, note: r.note || null });
});

// GET /api/escalation/ledger — every escalation NEURO has made, newest first.
router.get('/ledger', (req, res) => {
  const ext = require('../services/external-writes');
  res.json({ escalations: ext.recent({ writer: 'nova.escalate', limit: Math.min(Number(req.query.limit) || 50, 200) }) });
});

// POST /api/escalation/ledger/resolve — Nick checked the ticket after an
// unknown outcome; body { key, applied: true|false, note? }. Human only.
router.post('/ledger/resolve', (req, res) => {
  if (req.apiClient) return res.status(403).json({ error: 'Only Nick can say what is on the ticket.' });
  const { key, applied, note } = req.body || {};
  if (typeof key !== 'string' || typeof applied !== 'boolean') return res.status(400).json({ error: 'key and applied (boolean) are required' });
  const r = require('../services/external-writes').resolveUnknown(key, { applied, note: note || null });
  res.status(r.ok ? 200 : 409).json(r);
});

// ── Replies (23 Oct 2026, services/ticket-replies.js) ─────────────────────────

// POST /api/escalation/reply/draft — draft a Jira reply or internal note to the golden rules (Ownership, What's happening, Timeframes); body { key, visibility: public|internal, guidance? }. Posts nothing.
router.post('/reply/draft', async (req, res) => {
  const { key, visibility, guidance } = req.body || {};
  const r = await require('../services/ticket-replies').draft({ key, visibility, guidance });
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// POST /api/escalation/reply/preview — what posting this reply would do: who sees it, any gap left to fill, any promised update it sets.
router.post('/reply/preview', (req, res) => {
  const { key, text, visibility } = req.body || {};
  const k = String(key || '').trim().toUpperCase();
  res.json(require('../services/ticket-replies').preview({ key: k, text, visibility, watched: require('../services/watched-tickets').isWatched(k) }));
});

// POST /api/escalation/reply/post — post the reply to the Jira ticket as Nick (public or internal), ledgered and read back. Human only.
router.post('/reply/post', async (req, res) => {
  if (req.apiClient) {
    return res.status(403).json({ error: 'Posting on a Jira ticket is Nick, writing as himself — a machine client cannot do it on his behalf.' });
  }
  const { key, text, visibility } = req.body || {};
  const r = await require('../services/ticket-replies').post({ key, text, visibility });
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// GET /api/escalation/people — the people "Escalate to…" can offer: every People note with an email: line, by name. Read only.
router.get('/people', (req, res) => {
  try {
    const people = require('../services/contact-directory').fromPeopleNotes()
      .map((p) => ({ name: p.name, email: p.email.toLowerCase() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, people });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/escalation/email — escalate a ticket to someone by email ("Escalate to…"): prepares a governed compose_email from Nick's work address; nothing is sent here, it goes on his press. Body: { key, to, subject, body }
router.post('/email', (req, res) => {
  if (req.apiClient) {
    return res.status(403).json({ ok: false, error: 'Escalating a ticket by email is Nick, writing as himself — a machine client cannot do it on his behalf.' });
  }
  const { key, to, subject, body } = req.body || {};
  const k = String(key || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(k)) return res.status(400).json({ ok: false, error: 'not a ticket key' });
  const r = require('../services/prepared-actions').prepareCompose({
    from: 'work', to, subject, body, origin: 'composer',
    generatedBy: 'typed by Nick in Escalations → Escalate to…', evidence: { ticket: k },
  });
  if (!r.ok) return res.status(r.code || 400).json({ ok: false, error: r.error });
  res.json({ ok: true, prepared: true, action: r.action });
});

// ── Watched tickets (23 Oct 2026, services/watched-tickets.js) ───────────────

// GET /api/escalation/watched — watched Jira tickets, unread customer replies, and resolved tickets still listened to for 10 working days.
router.get('/watched', (req, res) => {
  res.json(require('../services/watched-tickets').list());
});

// POST /api/escalation/watched — watch a Jira ticket; body { key }. A customer reply then sends a push. Watch, follow, track a ticket.
router.post('/watched', async (req, res) => {
  const { key } = req.body || {};
  const r = await require('../services/watched-tickets').watch(key);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// POST /api/escalation/watched/check — check every watched ticket for customer replies now, instead of waiting for the 5-minute poll.
router.post('/watched/check', async (req, res) => {
  res.json(await require('../services/watched-tickets').check());
});

// POST /api/escalation/watched/:key/read — mark a watched ticket's customer replies as read.
router.post('/watched/:key/read', (req, res) => {
  const r = require('../services/watched-tickets').markRead(req.params.key);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// POST /api/escalation/watched/:key/commitments — promise the customer an update by a time; body { due: "HH:MM" (today) or "YYYY-MM-DDTHH:MM", London }. Update commitment, deadline, reminder.
router.post('/watched/:key/commitments', (req, res) => {
  const { due } = req.body || {};
  const r = require('../services/watched-tickets').addCommitment(req.params.key, due);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// POST /api/escalation/watched/:key/commitments/:id/:action — confirm a spotted update commitment, dismiss it, or mark it done by hand (action = confirm | dismiss | done).
router.post('/watched/:key/commitments/:id/:action', (req, res) => {
  const r = require('../services/watched-tickets').actOnCommitment(req.params.key, req.params.id, req.params.action);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// POST /api/escalation/watched/:key/unwatch — stop watching a ticket (history kept).
router.post('/watched/:key/unwatch', (req, res) => {
  const r = require('../services/watched-tickets').unwatch(req.params.key);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

module.exports = router;
