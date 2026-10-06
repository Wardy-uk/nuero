'use strict';

/**
 * Suggestion Engine — execution-first action suggestions from Focus items.
 *
 * Philosophy: "Do it" not "plan to do it".
 * Suggestions navigate the user to real actions, not task creation.
 *
 * Action types:
 *   - open_ticket       → navigate to Jira ticket
 *   - open_task         → navigate to top overdue task in TodoPanel
 *   - open_email        → navigate to inbox
 *   - open_standup      → navigate to standup
 *   - open_meeting_prep → navigate to meeting prep
 *   - draft_reply       → (future: open draft composer)
 *
 * A navigation action gets its OWN type per destination. The meeting-prep nudge
 * spent months reusing `open_task` with `navigate: 'meeting-prep'` in the
 * payload, and since the presenter keys on the type, every one of them rendered
 * as "Open tasks — jump to your task list": six cards on the approval screen,
 * identical above their reason line, all naming a destination they did not go
 * to. The destination is the entire content of a navigation card.
 *
 * Each suggestion returns a navigation target so the frontend
 * can immediately move the user to the right place.
 */

const db = require('../db/database');
// Only for its `kind` classification — the presenter does not require this file
// back (its test reads the source as text), so there is no cycle here.
const actionPresenter = require('./action-presenter');
const legacyNames = require('./legacy-names');

const SAIM_MODE = process.env.SAIM_MODE || 'suggest';
const JIRA_BASE = process.env.JIRA_BASE_URL || '';

// ── Signal type → execution action mapping ──

const SUGGESTION_RULES = [
  {
    // SLA risk tickets → open the top ticket directly
    match: (item) => item.type === 'jira_ticket' && item.urgency === 'critical',
    generate: (item) => {
      const key = item.meta?.keys?.[0] || item.meta?.key;
      return {
        type: 'open_ticket',
        confidence: 0.95,
        reason: key ? `Open ${key} — SLA is breaching` : 'Check the at-risk queue now',
        payload: {
          ticketKey: key,
          url: key && JIRA_BASE ? `${JIRA_BASE}/browse/${key}` : null,
          navigate: 'queue',
        },
      };
    },
  },
  {
    // SLA risk (non-critical) → open queue
    match: (item) => item.type === 'jira_ticket',
    generate: (item) => {
      const count = item.meta?.count || 1;
      return {
        type: 'open_ticket',
        confidence: 0.85,
        reason: `${count} ticket${count > 1 ? 's' : ''} at SLA risk — review queue`,
        payload: {
          navigate: 'queue',
          filter: 'at-risk',
        },
      };
    },
  },
  {
    // Escalation → open escalation queue
    match: (item) => item.type === 'escalation',
    generate: (item) => ({
      type: 'open_ticket',
      confidence: 0.92,
      reason: `${item.title} — respond now`,
      payload: {
        navigate: 'queue',
        filter: 'escalations',
      },
    }),
  },
  {
    // Overdue tasks → open the top overdue task
    match: (item) => item.type === 'todo' && item.id.includes('overdue'),
    generate: (item) => ({
      type: 'open_task',
      confidence: 0.8,
      reason: `Start with your top overdue task`,
      payload: {
        navigate: 'todos',
        filter: 'overdue',
      },
    }),
  },
  {
    // Due today → open today's tasks
    match: (item) => item.type === 'todo' && item.id.includes('today'),
    generate: (item) => ({
      type: 'open_task',
      confidence: 0.7,
      reason: `Tasks due today — start the first one`,
      payload: {
        navigate: 'todos',
        filter: 'today',
      },
    }),
  },
  {
    // A single urgent email we can name → offer to draft the reply rather than
    // just pointing at the inbox. Approving drafts; sending is a second approval.
    match: (item) => item.type === 'email' && !!item.meta?.emailId,
    generate: (item) => ({
      type: 'draft_reply',
      confidence: 0.82,
      reason: `Draft a reply to ${item.meta.from || 'sender'} — "${item.meta.subject || item.title}"`,
      payload: {
        emailId: item.meta.emailId,
        subject: item.meta.subject || null,
        from: item.meta.from || null,
        navigate: 'inbox',
      },
    }),
  },
  {
    // Urgent emails → open inbox
    match: (item) => item.type === 'email',
    generate: (item) => ({
      type: 'open_email',
      confidence: 0.75,
      reason: `${item.meta?.count || 1} urgent email${(item.meta?.count || 1) > 1 ? 's' : ''} — check inbox`,
      payload: {
        navigate: 'inbox',
        filter: 'urgent',
      },
    }),
  },
  {
    // Standup not done → open standup
    match: (item) => item.type === 'nudge' && item.meta?.type === 'standup',
    generate: (item) => ({
      type: 'open_standup',
      confidence: 0.7,
      reason: 'Do your standup — 2 minutes',
      payload: {
        navigate: 'standup',
      },
    }),
  },
  {
    // EOD not done → open standup (EOD tab)
    match: (item) => item.type === 'nudge' && item.meta?.type === 'eod',
    generate: (item) => ({
      type: 'open_standup',
      confidence: 0.65,
      reason: 'Wrap up — do your EOD',
      payload: {
        navigate: 'standup',
      },
    }),
  },
  {
    // Meeting imminent → open meeting prep
    match: (item) => item.type === 'meeting' && item.meta?.minutesAway != null && item.meta.minutesAway <= 15,
    generate: (item) => ({
      type: 'open_meeting_prep',
      confidence: 0.8,
      reason: `"${item.title}" starts in ${item.meta.minutesAway} min — prep now`,
      payload: {
        navigate: 'meeting-prep',
        title: item.title || null,
        // The START, not minutesAway. A stored relative time is wrong the minute
        // after it is written, and it is what tells the expiry sweep the moment
        // has passed — a prep card for a meeting that began two hours ago can
        // only ever be rejected.
        start: item.meta.start || null,
      },
    }),
  },
];


// ── A suggestion that DID something must not be offered again (7 Sep 2026) ──
//
// The dedupe below has only ever read PENDING actions, on the stated grounds
// that "navigation actions are repeatable — the user should always have a
// 'Do it' option available". That is true of a shortcut and false of an
// actuator, and `draft_reply` is an actuator: approving it spends a model call,
// writes the words, and queues a `reply_email` for the second gate.
//
// So the moment Nick approved one it left the pending set, the email was still
// urgent, and the very next `/api/focus` call — every Focus load, every agent
// loop, every briefing — generated the identical card again. Measured on the
// live DB: ONE email (Simon Greenhalgh, "Udemny") accounts for 1,168
// superseded, 6 executed and 2 rejected `draft_reply` rows since 14 August. Six
// separate approvals, six paid drafts, and two `reply_email` actions still
// sitting pending for the same message. The card reappearing was the visible
// half of a loop that was also quietly duplicating an outbound send path.
//
// ⚠ WHAT IS REPEATABLE IS `action-presenter`'s CALL, never a list of type names
// here — the same rule that already keeps `navigationExpiry`, the Actions
// queue, `bulk-reject` and `state-of-play` agreeing on what "leaves the
// building" means. NAVIGATE stays repeatable; everything else is offered once
// per decision.
const REPEATABLE_KIND = actionPresenter.NAVIGATE;

// ⚠ `focus_item_id` DOES NOT IDENTIFY THE THING. Every urgent email arrives as
// the literal focus item `email-urgent`, so `draft_reply:email-urgent` is the
// key for ANY urgent email — dedupe against history on that alone would mean
// one drafted reply silently suppressing the offer for every future email. So a
// type that is offered once names the payload field that identifies its
// subject.
const IDENTITY_FIELD = {
  draft_reply: 'emailId',
};

/**
 * PURE. The identity two rows must share to be "the same suggestion".
 *
 * Returns null when the type is offered-once but nothing in the payload
 * identifies WHICH thing it is about. ⚠ Null means DO NOT SUPPRESS: falling
 * back to the focus item id would hide real work on a coarse key, and between
 * a duplicate card and a silently withheld one, the duplicate is the failure
 * that can be seen.
 */
function suggestionIdentity(type, payload, focusItemId) {
  const field = IDENTITY_FIELD[type];
  if (!field) return null;
  const value = payload?.[field];
  return value ? `${type}:${value}` : null;
}

/**
 * The identities of everything of ONE type that Nick has already decided on.
 */
function decidedIdentities(type) {
  const keys = new Set();
  let rows;
  try {
    rows = db.getDecidedSaimActionsByType(type);
  } catch (e) {
    // Not knowing must never cost the suggestion — a failed read falls back to
    // the old pending-only behaviour, which is a duplicate card rather than a
    // missing one.
    console.warn(`[SAiM] Could not read decided ${type} actions:`, e.message);
    return keys;
  }
  for (const row of rows) {
    const key = suggestionIdentity(type, row.payload, row.focus_item_id);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Generate suggestions from Focus shortlist items.
 * Returns 1 primary + optional 1 secondary (max 2).
 * Deduplicates against today's actions.
 */
function generateSuggestions(focusItems) {
  if (SAIM_MODE === 'off') return [];

  // Before the dedupe read, not after: a spent shortcut left pending would also
  // block today's fresh one for the same focus item.
  expireStaleNavigation();

  if (!focusItems || focusItems.length === 0) return [];

  const suggestions = [];
  // Only deduplicate against PENDING actions (not executed/rejected).
  // Navigation actions (open_ticket, open_task, etc.) are repeatable —
  // the user should always have a "Do it" option available.
  //
  // The limit is explicit and large because getPendingSaimActions defaults to
  // TEN. Once more than ten actions were pending, the ones being generated fell
  // outside the dedupe window and were re-queued on every /api/focus call —
  // which is hit by every Focus load, every agent loop and every briefing. That
  // compounded to 15,605 pending rows, most of them the same handful repeated.
  const pendingActions = db.getPendingSaimActions(1000);
  const pendingKeys = new Set(
    pendingActions.map(a => `${a.type}:${a.focus_item_id}`)
  );
  // Read lazily and once per type: on the overwhelmingly common pass every
  // suggestion is navigation, and this query is never made at all.
  const decided = new Map();

  for (const item of focusItems) {
    for (const rule of SUGGESTION_RULES) {
      if (!rule.match(item)) continue;

      const suggestion = rule.generate(item);
      if (!suggestion) continue;

      const dedupeKey = `${suggestion.type}:${item.id}`;
      if (pendingKeys.has(dedupeKey)) continue;

      // An actuator is offered once per decision. A shortcut stays repeatable.
      if (actionPresenter.describe({ type: suggestion.type, payload: suggestion.payload })
        .kind !== REPEATABLE_KIND) {
        const identity = suggestionIdentity(suggestion.type, suggestion.payload, item.id);
        if (identity) {
          if (!decided.has(suggestion.type)) decided.set(suggestion.type, decidedIdentities(suggestion.type));
          if (decided.get(suggestion.type).has(identity)) continue;
        }
      }

      suggestions.push({
        ...suggestion,
        focusItemId: item.id,
        focusItemTitle: item.title,
        autoExecutable: false,
      });

      break;
    }
  }

  // Primary = highest confidence, secondary = next best
  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions.slice(0, 2);
}

/**
 * Queue a single action for approval and return its id.
 *
 * This is the front door for anything that wants SAiM to *do* something without
 * doing it itself — chat tools especially. Nothing here executes; the action sits
 * pending until it is approved through /api/actions/:id/approve.
 */
function queueAction(type, payload, reason, confidence = 0.9, focusItemId = null) {
  return db.createSaimAction(type, payload || {}, confidence, reason || type, focusItemId);
}

/**
 * Persist suggestions to the database.
 */
function persistSuggestions(suggestions) {
  const created = [];
  // Second guard, at the write rather than the decision. The caller's dedupe
  // depends on reading a complete pending set; this one cannot be defeated by a
  // limit, a race between two /api/focus calls, or a future caller that forgets.
  const existing = new Set(
    db.getPendingSaimActions(1000).map(a => `${a.type}:${a.focus_item_id}`)
  );
  for (const s of suggestions) {
    const key = `${s.type}:${s.focusItemId}`;
    if (existing.has(key)) continue;
    existing.add(key);
    const id = db.createSaimAction(s.type, s.payload, s.confidence, s.reason, s.focusItemId);
    created.push({ ...s, id, status: 'pending' });
  }
  return created;
}

// ── Navigation shortcuts go out of date; nothing was retiring them ───────────
//
// A navigate action is a shortcut to somewhere useful RIGHT NOW. Nothing ever
// aged one out, so the approval screen accumulated them: a meeting-prep card for
// a 09:45 meeting was still asking to be approved at 11:40, and an "open the
// standup" card outlives the day it was raised for. Neither can be acted on any
// more — the only honest thing left to do with either is reject it, which is
// work the screen was creating for itself.
//
// Two rules, and the SECOND is the general one:
//   1. The payload names a moment (a meeting start) and it has passed.
//   2. It was raised on an earlier day. "Now" is the entire premise of a
//      shortcut, so a shortcut does not survive the day it was raised on.
//
// What counts as navigation is `action-presenter`'s call, never a list of type
// names kept here — the same rule that keeps three places agreeing on what
// "leaves the building" means. Writes and outbound are untouched: a drafted
// reply or a queued chase is still worth approving next week.

const NAV_READ_ALL = 100000;

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function parseSqlTimestamp(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar day — never toISOString(); the Pi may run in UTC. */
function localDay(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Why this navigation shortcut is spent, or null if it still stands.
 *
 * Pure: takes the action and "now", touches no DB and no clock, so the rule can
 * be pinned without a database or a particular time of day.
 */
function navigationExpiry(action, now = new Date()) {
  if (!action) return null;
  if (actionPresenter.describe(action).kind !== actionPresenter.NAVIGATE) return null;

  const start = parseSqlTimestamp(action.payload?.start) || null;
  if (start && start <= now) return 'the meeting it was prepping for has already started';

  const created = parseSqlTimestamp(action.created_at);
  if (created && localDay(created) !== localDay(now)) return 'a shortcut to "now", raised on an earlier day';

  return null;
}

/**
 * WHEN this action dies of its own accord, or null if nothing retires it. PURE.
 *
 * The twin of `navigationExpiry`, which answers "is it spent yet". Snoozing
 * needs the moment rather than the verdict, and the two are deliberately in one
 * file: a snooze that outlives its action is a card swept to `expired` while it
 * sleeps and never seen again, so the sleep must be measured against the same
 * rule that does the sweeping.
 *
 * Only navigation actions expire. Everything else stands until Nick decides.
 */
function expiryMomentFor(action, now = new Date()) {
  if (!action) return null;
  if (actionPresenter.describe(action).kind !== actionPresenter.NAVIGATE) return null;

  const start = parseSqlTimestamp(action.payload?.start) || null;

  // End of the LOCAL day it was raised — "a shortcut to now, raised on an
  // earlier day" is what the sweep retires, so midnight is the deadline.
  const created = parseSqlTimestamp(action.created_at) || now;
  const midnight = new Date(created.getFullYear(), created.getMonth(), created.getDate() + 1, 0, 0, 0, 0);

  // Whichever comes first: a prep card for an 09:45 meeting is spent at 09:45,
  // not at midnight.
  if (start && start.getTime() < midnight.getTime()) return start;
  return midnight;
}

/**
 * Retire every pending navigation action whose moment has passed.
 *
 * `expired` rather than `rejected`: Nick did not decide anything about these, and
 * the rejection history is a record of what he turned down. Follows the
 * `superseded` status action-candidates already uses for the same reason.
 */
function expireStaleNavigation(now = new Date()) {
  const expired = [];
  try {
    for (const action of db.getPendingSaimActions(NAV_READ_ALL)) {
      const reason = navigationExpiry(action, now);
      if (!reason) continue;
      db.updateSaimActionStatus(action.id, 'expired');
      expired.push({ id: action.id, type: action.type, reason });
    }
  } catch (e) {
    console.warn('[Suggestion] Navigation expiry failed:', e.message);
  }
  if (expired.length) {
    console.log(`[Suggestion] Expired ${expired.length} navigation action(s): ${expired.map(e => `#${e.id} ${e.type}`).join(', ')}`);
  }
  return expired;
}

// Build 8: what this queue says about an outbound type it no longer sends —
// one pure module shared with the approve route (410) and the presenter.
const { RETIRED: LEGACY_OUTBOUND_RETIRED, legacyRetired } = require('./legacy-outbound');

/**
 * Execute an approved action.
 *
 * Three kinds live here now:
 *   - navigation (open_*)     — the frontend moves; nothing is written
 *   - vault writes            — capture_todo
 *   - real actuators          — draft_reply (prepares, sends nothing), complete_task,
 *                               schedule_focus_block. These change the outside
 *                               world via Graph, which is why they are async.
 *
 * Since Build 8 NOTHING here sends email or invites. Approving `draft_reply`
 * writes the words and PREPARES a governed reply (prepared-actions), which is
 * approved with Nick's approval code and sent by action-executor — the one
 * outbound path. The old send cases below refuse (LEGACY_OUTBOUND_RETIRED).
 */
async function executeAction(action) {
  const payload = action.payload;

  switch (action.type) {
    case 'open_ticket':
    case 'open_task':
    case 'open_email':
    case 'open_standup':
    case 'open_meeting_prep': {
      // Navigation actions — the frontend handles the actual navigation.
      // We just log and return the target.
      return {
        ok: true,
        detail: `Navigate to ${payload.navigate || action.type}`,
        navigate: payload.navigate || null,
        navigateContext: payload.filter ? { fromFocus: true, filter: payload.filter } : { fromFocus: true },
        url: payload.url || null,
      };
    }

    // Gate 1 of 2 for outbound email: draft the words, show them, send nothing.
    // Approving this queues a reply_email action holding the draft.
    case 'draft_reply': {
      const emailId = payload.emailId;
      if (!emailId) return { ok: false, detail: 'draft_reply needs an emailId' };

      let draft = payload.body || '';
      if (!draft) {
        try {
          const microsoft = require('./microsoft');
          const message = await microsoft.fetchEmailById(emailId);
          const prompt = `Draft a reply to this email as Nick Ward, Head of Technical Support at Nurtur. Direct, warm, concise — British English, no corporate padding. Sign off "Nick". Output only the reply body, no subject line and no commentary.

From: ${message?.from || payload.from || 'Unknown'}
Subject: ${message?.subject || payload.subject || '(no subject)'}

${String(message?.body || message?.preview || '').slice(0, 4000)}`;
          const result = await require('./ai-routing').runTask('email_draft', { prompt, maxTokens: 500 });
          draft = (result?.text || '').trim();
        } catch (e) {
          console.warn('[Suggestion] Draft generation failed:', e.message);
        }
      }
      if (!draft) return { ok: false, detail: 'Could not draft a reply — open the composer instead' };

      // ⚠ Build 8: gate 2 is no longer a PIN-approvable `reply_email` in this
      // queue. The words become a GOVERNED prepared action with its exact
      // recipients bound — approved with Nick's code, sent once, verified in
      // Sent Items. Preparing it sends nothing.
      const prep = await require('./prepared-actions').prepareReply({
        emailId, body: draft, mode: payload.replyAll ? 'replyAll' : 'reply', origin: 'drafted',
      });
      if (!prep.ok) return { ok: false, detail: `Drafted the words, but could not prepare the reply: ${prep.error}`, draft };

      return {
        ok: true,
        detail: 'Drafted a reply — approve it in Actions → Drafted by NEURO, with your approval code, to send it',
        draft,
        preparedActionId: prep.action.actionId,
        navigate: 'actions',
      };
    }

    // ⚠ RETIRED IN BUILD 8 (3 Oct 2026) — the rest of this queue's OUTBOUND
    // SENDER. These sent email (or a meeting response the organiser receives)
    // as Nick on a PIN-only approve, with no attempt ledger, no provider id, no
    // Sent Items check and no duplicate key. Every email NEURO can send now
    // goes through ONE path — prepared-actions → human-proof approval →
    // action-executor — and these cases REFUSE, loudly, reaching no sender.
    // There is deliberately no flag that turns any of them back on. The labels
    // stay only so the presenter-parity test keeps a card for an old row.
    //   reply_email             → the Inbox composer / draft_reply prepare a governed reply
    //   send_weekly_risk_report → the Weekly Risk panel prepares a governed send
    //   chase_agenda            → meeting triage prepares a governed request
    //   respond_meeting         → never used live (0 rows); retired, not migrated
    case 'reply_email':
    case 'send_weekly_risk_report':
    case 'chase_agenda':
    case 'respond_meeting': {
      console.error(`[SAiM] REFUSED legacy ${action.type} #${action.id}: the legacy outbound sender was retired in Build 8`);
      return { ok: false, code: 'LEGACY_OUTBOUND_RETIRED', detail: LEGACY_OUTBOUND_RETIRED[action.type] };
    }

    // Ticking a task off. NEURO-owned tasks go to the task store; Microsoft-owned
    // ones push over Graph. A Graph refusal is reported, not swallowed — the
    // local state still changes so the task stops nagging either way.
    case 'complete_task': {
      const detail = [];

      if (payload.taskId) {
        const taskStore = require('./task-store');
        const task = taskStore.setStatus(payload.taskId, 'done');
        if (!task) return { ok: false, detail: `Task #${payload.taskId} not found` };
        detail.push(`Completed: ${task.text}`);
      }

      // ⚠ Build 14D: NOT when an msId is present. ms-complete flips the mirror
      // line BY ID; flipping it here as well by a stored offset toggled it
      // twice — the completion un-ticked its own line (or ticked a different
      // task, the offset being hours old).
      if (!payload.msId && payload.filePath && payload.lineNumber != null) {
        try { require('./obsidian').toggleTask(payload.filePath, payload.lineNumber); } catch (e) {
          detail.push(`(vault line not toggled: ${e.message})`);
        }
      }

      if (payload.msId) {
        // Build 13M: the one Microsoft completion path (ledger, readback, retry queue).
        const result = await require('./ms-complete').completeMicrosoftTask({ msId: payload.msId, source: payload.source || null, listId: payload.listId || null });
        detail.push(result.pushed !== 'none'
          ? `pushed to Microsoft (${result.pushed})`
          : (result.warning || 'Microsoft push failed'));
      }

      if (!detail.length) return { ok: false, detail: 'complete_task needs a taskId or msId' };
      return { ok: true, detail: detail.join(' · '), navigate: 'todos' };
    }

    // Ask someone where a commitment got to. Goes to a direct report, so it is
    // approval-only by design: an automated chase to someone who works for you
    // reads as surveillance, however politely it is worded.
    // Escalate a support ticket in NOVA. NOVA owns every rule here — the comment
    // is internal-only, the due date only tightens, the priority only rises — so
    // this executor deliberately does no judging of its own. It reports back what
    // NOVA actually changed rather than what was asked for, because a due date
    // that was left alone (already tighter) still reads as a success otherwise.
    case 'escalate_ticket': {
      const nova = require('./nova-client');
      if (!nova.isConfigured()) return { ok: false, detail: 'NOVA is not configured — cannot escalate' };
      if (!payload.ticketKey) return { ok: false, detail: 'escalate_ticket needs a ticketKey' };

      // Build 13L: the same ledgered, read-back write the Escalation form uses.
      const r = await require('./nova-escalation').escalate({
        ticketKey: payload.ticketKey,
        reasonCode: payload.reasonCode,
        neededBy: payload.neededBy,
        notes: payload.notes,
      });
      if (r.outcome === 'duplicate') return { ok: true, detail: r.note, navigate: 'queue' };
      if (!r.ok) return { ok: false, detail: `NOVA did not escalate it (${r.outcome}): ${r.error}${r.note ? ` — ${r.note}` : ''}` };
      const result = r.result;

      const changed = [];
      if (result.priority?.changed) changed.push(`priority ${result.priority.from || 'unset'} → ${result.priority.to}`);
      if (result.duedate?.changed) changed.push(`due ${result.duedate.to}`);
      if (result.comment_posted) changed.push('internal comment posted');

      // A partial escalation must not read as a clean one.
      const warned = (result.warnings || []).length
        ? ` — but ${result.warnings.join(' ')}`
        : '';

      return {
        ok: true,
        detail: `Escalated ${result.ticket_key} (${result.reason_label})`
          + (changed.length ? `: ${changed.join(', ')}` : ': logged, nothing on the ticket needed changing')
          + warned,
        navigate: 'queue',
      };
    }

    // ⚠ RETIRED IN BUILD 7 (3 Oct 2026). This was the legacy chase SENDER: no
    // attempt ledger, no idempotency key, no Sent Items check, and a timeout read
    // as "not sent". It sent 2 chases (Aug 2026), recorded in
    // action_legacy_history as legacy_unverified. Every chase now goes through ONE
    // path — prepared-actions → human-proof approval → action-executor — so this
    // case REFUSES, loudly, and reaches no sender. There is deliberately no flag
    // that turns it back on. The case label stays only so the presenter-parity
    // test keeps a card for any old row; the body must never send.
    case 'chase_commitment': {
      console.error(`[Chase] REFUSED legacy chase_commitment #${action.id}: the legacy sender was retired in Build 7`);
      return {
        ok: false,
        code: 'LEGACY_CHASE_RETIRED',
        detail: 'The old chase sender was retired in Build 7 and sent nothing. Press Chase on the People board again: it drafts the chase in Actions → Drafted by NEURO, where you approve the exact email.',
      };
    }

    // Put the work in the diary. Defaults to a 60-minute block starting at the
    // next half hour, because "schedule it" with no time is the common case.
    //
    // ⚠ Build 8: a block WITH attendees is an invite Graph emails to real
    // people — outbound, and this queue no longer sends anything outbound. It
    // is refused; a block with nobody else in it is a write to Nick's own
    // diary and still runs. (0 attendee-bearing rows ever existed live.)
    case 'schedule_focus_block': {
      if (Array.isArray(payload.attendees) && payload.attendees.length) {
        console.error(`[SAiM] REFUSED legacy schedule_focus_block #${action.id} with attendees: invites from this queue were retired in Build 8`);
        return { ok: false, code: 'LEGACY_OUTBOUND_RETIRED', detail: LEGACY_OUTBOUND_RETIRED.schedule_focus_block_invite };
      }
      const microsoft = require('./microsoft');
      const start = payload.start ? new Date(payload.start) : _nextHalfHour();
      if (Number.isNaN(start.getTime())) return { ok: false, detail: `Unparseable start time: ${payload.start}` };
      const minutes = Number(payload.minutes) > 0 ? Number(payload.minutes) : 60;
      const end = payload.end ? new Date(payload.end) : new Date(start.getTime() + minutes * 60000);

      const result = await microsoft.createCalendarEvent({
        subject: payload.subject || 'Focus block',
        start: _graphLocalTime(start),
        end: _graphLocalTime(end),
        body: payload.body || null,
        location: payload.location || null,
        attendees: [], // never: an invite from this queue is refused above
        isOnline: Boolean(payload.isOnline),
      });

      if (!result.created) {
        const reasons = {
          auth: 'Not signed in to Microsoft — reconnect 365.',
          scope: 'Calendars.ReadWrite not granted — re-consent to Microsoft.',
        };
        return { ok: false, detail: reasons[result.reason] || `Calendar write failed (${result.reason})` };
      }

      const when = start.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      // Say when invites actually went out — approving this emails real people.
      const invited = (payload.attendees || []).length;
      return {
        ok: true,
        detail: `Booked "${result.event.subject}" ${when} (${minutes} min)`
          + (invited ? ` — invited ${invited} ${invited === 1 ? 'person' : 'people'}` : ''),
        url: result.event.webLink || null,
        navigate: 'calendar',
      };
    }

    // Route 4 — promotion from meetings. Approving a suggestion creates the task in
    // NEURO (the source of truth) with a backlink to the note it came from.
    case 'capture_todo': {
      const taskStore = require('./task-store');
      const { id, created } = taskStore.createTask({
        text: payload.text,
        moscow: payload.metadata?.moscow || null,
        priority: payload.metadata?.priority || null,
        // ⚠ A commitment out of a meeting note or an email arrived with NO DUE
        // DATE AT ALL — `action-candidates` hard-codes `dueDate: null` on every
        // candidate it raises, so however plainly the sentence named a deadline,
        // the promoted task carried none. Nick's rule (14 Sep 2026): read the
        // date the sentence states, and where it states none, give it ten days.
        //
        // ⚠ Resolved HERE, at approval, and deliberately not stored on the
        // candidate when it is raised. These sit pending for weeks — 926 of them
        // at one point — and a default baked in at extraction time would have a
        // task arrive ALREADY OVERDUE, which is the one thing this must not
        // manufacture: overdue commitments are what the weekly risk report
        // counts. The default is ten days from the moment it becomes work.
        //
        // An explicit date on the payload still wins over both; nothing sets one
        // today, but a future extractor that does must not be second-guessed.
        due_date: payload.metadata?.dueDate
          || payload.dueDate
          || require('./commitment-due').resolveDueDate(payload.text).date,
        // ⚠ The payload's own source wins. This was a hardcoded
        // 'meeting-promotion' from when a note was the only thing that could
        // raise one of these; an email-sourced candidate promoted under that
        // word is a task claiming a provenance it does not have, and
        // `inferOrigin` reads exactly this field to decide whether somebody is
        // waiting on it. The default is unchanged for every existing row.
        source: payload.source || 'meeting-promotion',
        origin_path: payload.sourcePath || null,
        origin_line: payload.sourceLine == null ? null : payload.sourceLine,
        // ⚠ Carried across, because the ONLY human-readable thing about an
        // email-sourced task is here and it was being dropped. `sourcePath` for
        // one of these is `email:<Graph id>` — which names the message to
        // Microsoft and to nobody else — so a task promoted from an email
        // arrived in the store with no way to say whose email it was. That is
        // #251: a MUST, high priority, due today, and unidentifiable. The
        // sender, subject and received date have been on this payload since the
        // extractor shipped; nothing was missing but the copy.
        //
        // Stored rather than looked up later on purpose: this action is
        // prunable, and the Graph id resolves to nothing without Microsoft.
        // Note-sourced candidates pass nothing — their path already reads as a
        // sentence, and an empty object stores as NULL.
        origin_detail: payload.email ? { email: payload.email } : null,
      });
      return {
        ok: true,
        detail: `${created ? 'Added task' : 'Folded into existing task'} #${id}: ${payload.text}`,
        navigate: 'todos',
      };
    }

    // Route 5 — a suggestion from VANTAGE that was not urgent enough to be
    // written straight in. Approving it is Nick agreeing it is work; the task
    // carries what VANTAGE claimed, verbatim, so it can still answer why it is
    // here in three weeks' time.
    case 'vantage_suggestion': {
      const taskStore = require('./task-store');
      const { id, created } = taskStore.createTask({
        text: payload.text,
        source: payload.source || 'vantage',
        // Somebody else's system is waiting on it. That is the commitment test,
        // and it is the same answer VANTAGE gives on its direct path — one
        // question, one answer, whichever route it took.
        origin: 'commitment',
        criticality: payload.criticality || null,
        notes: payload.basis ? `${payload.source || 'VANTAGE'}: ${payload.basis}` : null,
        due_date: payload.dueDate || null,
      });
      return {
        ok: true,
        detail: `${created ? 'Added task' : 'Folded into existing task'} #${id}: ${payload.text}`,
        navigate: 'todos',
      };
    }

    default:
      return { ok: false, detail: `Unknown action type: ${action.type}` };
  }
}

function _nextHalfHour() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

/**
 * Graph wants a naive local datetime — the timezone travels separately in the
 * payload (EVENT_TIMEZONE), so appending a Z or an offset here would shift the
 * booking. Format the local wall-clock components by hand.
 */
function _graphLocalTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:00`;
}

/**
 * Log an executed action to activity log and daily note.
 */
function logActionExecution(action, result) {
  try {
    db.logActivity('saim_action', {
      actionId: action.id,
      type: action.type,
      status: result.ok ? 'executed' : 'failed',
      detail: result.detail,
    });
  } catch {}

  if (result.ok) {
    try {
      const obsidian = require('./obsidian');
      const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const line = `- ${time} — ${action.reason || action.type}`;

      const daily = obsidian.readTodayDailyNote() || '';
      // Either spelling — see `_appendToDailySection`. A note written this
      // morning still says `## SARA Actions`.
      if (legacyNames.headingAliases('## SAiM Actions').some((h) => daily.includes(h))) {
        obsidian.appendToDailyNote(line + '\n');
      } else {
        obsidian.appendToDailyNote(`\n\n## SAiM Actions\n${line}\n`);
      }
    } catch {}
  }
}

module.exports = {
  generateSuggestions,
  persistSuggestions,
  executeAction,
  logActionExecution,
  queueAction,
  navigationExpiry,
  expiryMomentFor,
  expireStaleNavigation,
  // Pure, so the "offered once" rule pins without a database.
  suggestionIdentity,
  IDENTITY_FIELD,
  LEGACY_OUTBOUND_RETIRED,
  legacyRetired,
};
