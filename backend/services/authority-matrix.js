'use strict';

/**
 * The authority matrix — what each kind of write MAY do, and who may ask for it
 * (Build 14F, 6 Oct 2026).
 *
 * ── Why this is configuration, not a document ──────────────────────────────
 * Builds 6–13 governed outbound email, attendee calendar changes, Jira
 * escalation and Microsoft completion one by one. Each fix was right and each
 * lived in its own file, so "can a machine client do X?" had no single answer:
 * the Build 13 audit found the MCP gateway classing every non-GET as `action`,
 * the local MCP server authenticating with the PIN (so the backend could not
 * tell it from Nick), and a NOVA bridge PATCH that forwarded any JSON body.
 *
 * This file is the answer, and it is ENFORCED:
 *   • `services/authority-guard.js` refuses a machine caller on any route whose
 *     capability says `machine: 'refuse'`, before any router runs;
 *   • `authority-matrix.test.js` fails when an inventoried route resolves to no
 *     capability, when the MCP gateway offers a route this file refuses, and
 *     when action-registry / external-writes disagree with it.
 *
 * ── Vocabulary (action-registry's, reused — not a second scale) ────────────
 *   A0 read · A1 NEURO's own state · A2 reversible, local or Nick-only ·
 *   A3 external, low-risk, standing consent · A4 consequential, explicit approval.
 *
 * `machine` says what a MACHINE caller (the API token, or anything declaring
 * itself a machine — see authority-guard) may do:
 *   execute          — call it; the effect is A0–A2 and needs no human.
 *   execute-bounded  — call it; the service applies the stated bounds (below).
 *   prepare          — call it; it only PREPARES something Nick approves.
 *   refuse           — 403 before any handler. A human must do it, in NEURO.
 *   retired          — 410 for everyone.
 *
 * ⚠ The API token alone never implies human authority. Nothing here grants a
 * machine more than its row; a missing row is a test failure, and at runtime an
 * unresolvable non-GET from a machine is REFUSED (fail closed).
 */

const CAPABILITIES = Object.freeze({
  read: { authority: 'A0', effect: 'none', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: true },

  'internal.state': { authority: 'A1', effect: "NEURO's own state (attention, sessions, nudges, triage flags, dedupe decisions, setup)", machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: 'per route' },
  'task.status': { authority: 'A1', effect: 'NEURO task create / edit / complete / reopen (a linked Microsoft task follows via microsoft.task.complete)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: 'dedupe_key folds a repeat create' },
  ingest: { authority: 'A1', effect: 'sensor and device ingest (location, health, device, desktop, environment, apple)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: 'content-keyed' },
  'push.self': { authority: 'A1', effect: "a notification to Nick's own devices", machine: 'execute', approval: 'none', registry: null, ledger: true, verification: 'push_log', idempotent: 'governor dedupe' },
  // Build 15: the ONE self-heal operation. No route reaches it; self-heal.js
  // runs it, once per outage, only at high confidence, and verifies recovery.
  'source.retry-sync': { authority: 'A1', effect: "re-run one source's own read-only sync, once, for a self-heal", machine: 'execute', approval: 'none', registry: 'self-heal:retry-sync', ledger: true, verification: 'SourceHealth success after the attempt + the blind finding closed', idempotent: 'one attempt per outage (UNIQUE)' },
  // 8 Oct 2026: NHS test results, diagnoses and prescriptions. Stored in NEURO
  // only (no vault, no index); every row records who entered it; folds by key.
  'medical.record': { authority: 'A2', effect: "Nick's medical record (test results, diagnoses, prescriptions) in NEURO's own table", machine: 'execute', approval: 'none', registry: null, ledger: false, verification: 'entered_by + previous_json on every row', idempotent: 'dedupe_key folds a resend; a changed resend is a kept revision' },
  // Reads screenshots with a cloud vision model and PROPOSES records; writes nothing.
  'medical.scan': { authority: 'A1', effect: 'a paid vision call that proposes medical records and stores nothing', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: true },
  'config.preference': { authority: 'A1', effect: 'preferences and setup state (quiet hours, weekly target, skip a setup step)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: true },

  'vault.write': { authority: 'A2', effect: 'Vault write (append/surgical, backed up)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: 'vault-hooks re-index', idempotent: 'per route' },
  'file.write': { authority: 'A2', effect: 'a file written into the vault (capture file/photo, docx export)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: false },
  'calendar.solo': { authority: 'A2', effect: "events with NO attendees in Nick's own calendar (task blocks, day planner, Plaud admin blocks)", machine: 'execute', approval: 'none', registry: 'external-writes:microsoft.calendar.solo', ledger: false, verification: null, idempotent: 'UNIQUE(date,start) / ledgers' },
  'mail.read-state': { authority: 'A2', effect: 'mark an email read on dismiss', machine: 'execute', approval: 'none', registry: 'external-writes:microsoft.mail.read-state', ledger: false, verification: null, idempotent: true },
  'weather.wu-publish': { authority: 'A2', effect: "upload our own weather station's readings to Weather Underground (ICOALV59)", machine: 'execute', approval: 'none', registry: 'external-writes:wunderground.publish', ledger: false, verification: 'WU answers "success"', idempotent: 'WU folds a repeat dateutc' },
  'calendar.leave-decline': { authority: 'A3', effect: "decline an invite Nick did not organise, on a day People HR says he is on leave", machine: 'refuse', approval: 'the leave_auto_decline switch, or a tap on the Leave clashes card', registry: 'external-writes:microsoft.calendar.leave-decline', ledger: true, verification: 'Graph read-back', idempotent: true },
  'hike.safety-alert': { authority: 'A3', effect: 'the overdue alert (and all-clear) for a walk Nick armed, emailed to his listed contacts', machine: 'refuse', approval: 'arming the walk', registry: 'external-writes:hike.safety-alert', ledger: true, verification: 'sent-items', idempotent: true },
  'gmail.unsubscribe': { authority: 'A3', effect: "POST a mailing list's own one-click unsubscribe, on Nick's press", machine: 'refuse', approval: 'click', registry: 'external-writes:gmail.unsubscribe', ledger: true, verification: 'http status', idempotent: true },
  'saim.prepared-move': { authority: 'A2', effect: "confirm ONE prepared move: exactly the writes it lists (one solo block, one new note) and nothing else", machine: 'refuse', approval: 'click (intent grant)', registry: null, ledger: true, verification: 'per-step read-back', idempotent: 'per step' },
  // 21 Oct 2026: preparing a PROPOSAL (make ready, defer, decline, answer SAiM's
  // question). Writes only NEURO's own prepared_moves rows — nothing is saved,
  // booked, sent or created outside NEURO until Nick confirms on his screen
  // (saim.prepared-move, machine: refuse). Desktop chats may do this over MCP.
  'saim.prepared-move.propose': { authority: 'A1', effect: "a prepared-move PROPOSAL in NEURO's own store, or Nick's defer / decline / answer on one — no external write", machine: 'execute', approval: 'none', registry: null, ledger: false, verification: 'prepared_moves rows (immutable, versioned)', idempotent: 'unchanged evidence folds into the stored version' },
  // 23 Oct 2026: "Do this" - the task agent. Reads Nick's permitted context and writes only its own
  // run (agent_state) and private outputs; any email it prepares is a governed A4 draft that waits on
  // the existing approval screen. Every route, reads included, is Nick's alone (output can quote a
  // restricted excerpt), so machine: refuse and the gateway marks them interactive.
  'task-agent.run': { authority: 'A1', effect: "run NEURO's task agent on one task: read permitted context, save private working outputs, prepare (never send) a governed email draft", machine: 'refuse', approval: 'click (owner session)', registry: null, ledger: false, verification: 'agent_state task_agent_run:<id> + activity_log task_agent', idempotent: 'one attempt per task; a repeat press resumes it' },
  'saim.authority': { authority: 'A4', effect: "change what SAiM is allowed to do: grant or revoke today's allowance, stop or resume all SAiM actions", machine: 'refuse', approval: 'click + one-use confirmation (grant, resume)', registry: null, ledger: true, verification: 'saim_authority_events', idempotent: 'one grant per day; tokens one-use' },
  'saim.move.calendar-block': { authority: 'A2', effect: "one solo block in Nick's calendar for a prepared move he confirmed", machine: 'refuse', approval: 'click (intent grant)', registry: 'external-writes:saim.move.calendar-block', ledger: true, verification: 'event read-back', idempotent: 'one per move (ledger key + marker)' },
  'saim.move.vault-note': { authority: 'A2', effect: 'one new named vault note for a prepared move he confirmed (never an overwrite)', machine: 'refuse', approval: 'click (intent grant)', registry: 'external-writes:saim.move.vault-note', ledger: true, verification: 'content hash read-back', idempotent: 'one per move (ledger key + exact path)' },
  'email.self': { authority: 'A2', effect: 'a [TEST] copy to Nick only (refuses any other recipient)', machine: 'execute', approval: 'none', registry: 'external-writes:email.self', ledger: false, verification: null, idempotent: false },
  'desktop.launch': { authority: 'A2', effect: "open an ALLOWLISTED app on Nick's laptop (no arguments)", machine: 'execute', approval: 'none', registry: null, ledger: true, verification: 'agent outcome', idempotent: 'queue de-dupes' },
  'plaud.pull': { authority: 'A2', effect: 'pull recordings from PLAUD into the vault', machine: 'execute', approval: 'none', registry: null, ledger: true, verification: 'sync ledger', idempotent: 'canonical plaud_id' },
  'push.synthetic-p0': { authority: 'A2', effect: 'a synthetic P0 interrupt on the phone', machine: 'refuse', approval: 'click', registry: null, ledger: true, verification: 'attention_notifications', idempotent: true },
  'homeassistant.room': { authority: 'A2', effect: 'lights / radiator in the house, from an accepted room offer', machine: 'refuse', approval: 'click', registry: 'external-writes:homeassistant.room', ledger: false, verification: 'next house read', idempotent: true },
  'calendar.family': { authority: 'A2', effect: 'add / edit / delete an event in the shared family Google calendar, from the family wall', machine: 'refuse', approval: 'click', registry: 'external-writes:google.calendar.family', ledger: true, verification: 'Google read-back', idempotent: 'event id chosen before the call' },
  'tally.categorise': { authority: 'A2', effect: "a transaction's category in Tally (and Tally's merchant rule on 'Always')", machine: 'refuse', approval: 'click', registry: 'external-writes:tally.transaction.categorise', ledger: true, verification: 'Tally read-back', idempotent: true },

  'microsoft.task.complete': {
    authority: 'A3', effect: 'Planner percentComplete 100 (team-visible) / To Do completed', machine: 'execute-bounded', approval: 'none',
    registry: 'external-writes:microsoft.task.complete', ledger: true, verification: 'Graph read-back', idempotent: 'one per task per day',
    bounds: [
      'the exact Graph task id — never a fuzzy match, never a file offset',
      'completion only — never an un-completion, never a toggle',
      'through ms-complete (ledger before the call, read back after)',
      'an unknown outcome from a machine-initiated attempt is HELD, never re-attempted',
    ],
    preauthorisation: 'An agent holding the MCP action scope, executing an instruction Nick gave in conversation. A3 not A4: reversible from Planner, tells nobody anything the board does not already show, and read back.',
  },
  'microsoft.task.progress': { authority: 'A3', effect: 'Planner 50%/0% (team-visible) or To Do inProgress', machine: 'refuse', approval: 'click', registry: 'external-writes:microsoft.task.progress', ledger: false, verification: null, idempotent: true },
  'microsoft.task.fields': { authority: 'A3', effect: 'rename / re-date / re-describe a card on a shared board', machine: 'refuse', approval: 'click', registry: 'external-writes:microsoft.task.fields', ledger: false, verification: null, idempotent: false },
  'jira.escalate': { authority: 'A3', effect: 'raise Jira priority, tighten due date, one internal comment (via NOVA)', machine: 'refuse', approval: 'click', registry: 'external-writes:nova.escalate', ledger: true, verification: 'ticket re-read', idempotent: 'one per ticket+reason per day; unknown outcome blocks' },
  'jira.escalation.resolve': { authority: 'A3', effect: 'record what is on a ticket after an unknown escalation outcome', machine: 'refuse', approval: 'click', registry: 'external-writes:nova.escalate', ledger: true, verification: null, idempotent: true },
  'notion.publish': { authority: 'A3', effect: 'publish mapped vault notes to Notion (read by an external AI)', machine: 'refuse', approval: 'click', registry: 'external-writes:notion.sync', ledger: false, verification: 'next reconcile', idempotent: 'per-note state' },
  'nova.121': { authority: 'A3', effect: 'NOVA 1-2-1 sessions / cadence / transcript candidates', machine: 'refuse', approval: 'click', registry: 'external-writes:nova.121', ledger: false, verification: 'morning reconcile', idempotent: true },
  'vesta.share': { authority: 'A3', effect: 'share a catalogue on VESTA (public internet, read by the household)', machine: 'refuse', approval: 'click', registry: null, ledger: false, verification: null, idempotent: true },

  'email.send': { authority: 'A4', effect: 'email to another person as Nick', machine: 'prepare', approval: 'approval-code', registry: 'action-registry:chase_commitment,reply_email,compose_email,chase_agenda,send_weekly_risk_report,send_soap_report', ledger: true, verification: 'Sent Items match', idempotent: 'one attempt per approved version' },
  'calendar.attendee.create': { authority: 'A4', effect: 'invite other people as Nick', machine: 'prepare', approval: 'approval-code', registry: 'action-registry:create_calendar_event', ledger: true, verification: 'read-back', idempotent: 'one attempt per approved version' },
  'calendar.attendee.reschedule': { authority: 'A4', effect: 'move a meeting other people are in', machine: 'prepare', approval: 'approval-code', registry: 'action-registry:reschedule_calendar_event', ledger: true, verification: 'read-back', idempotent: 'one attempt per approved version' },
  'calendar.attendee.cancel': { authority: 'A4', effect: 'cancel a meeting other people are in', machine: 'prepare', approval: 'approval-code', registry: 'action-registry:cancel_calendar_event', ledger: true, verification: 'read-back', idempotent: 'one attempt per approved version' },
  'approval.decide': { authority: 'A4', effect: "approve / reject / challenge / edit an action — Nick's decision", machine: 'refuse', approval: 'approval-code', registry: 'action-registry', ledger: true, verification: null, idempotent: true },
  'approval.internal': { authority: 'A1', effect: 'approve a queued INTERNAL suggestion (add a captured task, open a screen)', machine: 'execute-bounded', approval: 'none', registry: null, ledger: true, verification: null, idempotent: 'pending → executed once',
    bounds: ['the route refuses anything action-presenter calls outbound (403)', 'the route refuses a complete_task that reaches Microsoft (403) — that is complete-ms', 'retired outbound types answer 410'],
    preauthorisation: 'Build 7: the local MCP approve_action tool, internal kinds only. The remote gateway still does not offer it.' },
  'config.security': { authority: 'A4', effect: 'credentials, approval code, trusted devices, accounts, feature switches, push endpoints, integration tokens', machine: 'refuse', approval: 'click', registry: null, ledger: false, verification: null, idempotent: true },

  'microsoft.bridge.passthrough': { authority: 'A3', effect: 'RETIRED (Build 14B): forwarded an arbitrary JSON body to NOVA', retiredReason: 'Retired: NEURO no longer forwards arbitrary task updates to NOVA. Edit a Microsoft task through PATCH /api/todos/ms/:msId in NEURO.', machine: 'retired', approval: 'none', registry: null, ledger: false, verification: null, idempotent: false },
  'retired.legacy': { authority: 'A4', effect: 'RETIRED: a legacy direct-send route', retiredReason: 'Retired: this route no longer acts. Governed changes are prepared and approved in NEURO → Actions.', machine: 'retired', approval: 'none', registry: null, ledger: false, verification: null, idempotent: false },
});

// ── routes → capability ─────────────────────────────────────────────────────
// First match wins. `M` is a method or '*'. Explicit rules cover everything
// with an external effect or a human-only decision; the domain defaults below
// cover NEURO-internal writes. ⚠ Order matters inside a domain: put the narrow
// rule before the broad one.
const R = (M, path, cap, opts = {}) => ({ method: M, path, cap, ...opts });
const ROUTE_RULES = Object.freeze([
  // Retired passthrough (14B) — every non-GET method, for everyone.
  R('POST', '/api/microsoft/todo/tasks', 'microsoft.bridge.passthrough'),
  R('*', '/api/microsoft/todo/tasks/:taskId', 'microsoft.bridge.passthrough'),
  R('*', '/api/microsoft/planner/tasks/:taskId', 'microsoft.bridge.passthrough'),
  R('*', '/api/microsoft/auth', 'config.security'),

  // 19 Oct 2026: SAiM's prepared move — asking to confirm and confirming are
  // both Nick's. Machine clients are refused; the gateway marks both interactive.
  R('GET', '/api/prepared-moves/current', 'read'),
  R('GET', '/api/prepared-moves/eligible', 'read'),
  R('GET', '/api/prepared-moves/drafts', 'read'),
  // 22 Oct 2026: abandoning (or restoring) a saved draft is Nick's call about his own work.
  R('POST', '/api/prepared-moves/drafts/outcome', 'saim.prepared-move.propose', { machine: 'refuse' }),
  R('GET', '/api/prepared-moves/promises', 'read'),
  R('POST', '/api/prepared-moves/prepare', 'saim.prepared-move.propose'),
  R('POST', '/api/prepared-moves/respond', 'saim.prepared-move.propose'),
  R('POST', '/api/prepared-moves/answer', 'saim.prepared-move.propose'),
  R('POST', '/api/prepared-moves/request', 'saim.prepared-move'),
  R('POST', '/api/prepared-moves/confirm', 'saim.prepared-move'),
  // 22 Oct 2026: task context. Linking/unlinking ONE item is NEURO's own state and
  // open to a chat on Nick's explicit word (domain default); running the whole-vault
  // scan is his alone — the gateway marks it interactive.
  R('POST', '/api/task-context/scan', 'internal.state', { machine: 'refuse' }),
  R('GET', '/api/task-agent/tasks/:taskId', 'task-agent.run'),
  R('GET', '/api/task-agent/tasks/:taskId/handoff/preview', 'task-agent.run'),
  R('POST', '/api/task-agent/tasks/:taskId/handoff', 'task-agent.run'),
  R('POST', '/api/task-agent/tasks/:taskId/outputs/:outputId/save', 'task-agent.run'),
  // Do this's key, on/off and daily limits are Nick's, in Settings — never a machine's.
  R('GET', '/api/task-agent/settings', 'task-agent.run'),
  R('POST', '/api/task-agent/settings', 'config.security', { machine: 'refuse' }),
  R('POST', '/api/task-agent/settings/test', 'task-agent.run'),
  R('GET', '/api/task-agent/active', 'task-agent.run'),
  R('POST', '/api/task-agent/tasks/:taskId/start', 'task-agent.run'),
  R('POST', '/api/task-agent/tasks/:taskId/answer', 'task-agent.run'),
  R('POST', '/api/task-agent/tasks/:taskId/stop', 'task-agent.run'),
  // Turning automatic linking on runs the backfill; on or off, it is Nick's decision alone.
  R('POST', '/api/task-context/activate', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/task-context/deactivate', 'internal.state', { machine: 'refuse' }),
  // 20 Oct 2026: what SAiM may do — every route, reads included, is Nick's.
  R('GET', '/api/saim-authority/status', 'saim.authority'),
  R('POST', '/api/saim-authority/grant/preview', 'saim.authority'),
  R('POST', '/api/saim-authority/grant', 'saim.authority'),
  R('POST', '/api/saim-authority/revoke', 'saim.authority'),
  R('POST', '/api/saim-authority/stop', 'saim.authority'),
  R('POST', '/api/saim-authority/resume/preview', 'saim.authority'),
  R('POST', '/api/saim-authority/resume', 'saim.authority'),

  // Approval is Nick's.
  R('POST', '/api/prepared-actions/:id/approve', 'approval.decide'),
  // 9 Oct 2026: Nick-direct confirm (intent grant). Human-only, like approve.
  R('POST', '/api/prepared-actions/:id/intent-grant', 'approval.decide'),
  R('POST', '/api/prepared-actions/:id/execute-direct', 'approval.decide'),
  R('POST', '/api/prepared-actions/:id/reject', 'approval.decide'),
  R('POST', '/api/prepared-actions/:id/edit', 'approval.decide'),
  R('POST', '/api/prepared-actions/:id/approval-challenge', 'approval.decide'),
  R('POST', '/api/prepared-actions/approval-code', 'config.security'),
  R('POST', '/api/prepared-actions/trust-device', 'config.security'),
  R('POST', '/api/prepared-actions/devices/:deviceId/revoke', 'config.security'),
  R('POST', '/api/actions/:id/approve', 'approval.internal'),
  R('POST', '/api/actions/batch', 'approval.decide'),

  // Email: preparing is allowed, sending is not reachable from a route.
  R('POST', '/api/email/triage/:emailId/reply', 'email.send'),
  R('POST', '/api/email/triage/dismiss/:emailId', 'mail.read-state'),
  R('POST', '/api/waiting-on/:key/chase', 'email.send'),
  R('POST', '/api/weekly-risk/queue-send', 'email.send'),
  R('POST', '/api/soap/:weekFrom/queue-send', 'email.send'),
  // Meeting promises (21 Oct 2026): drafting the email that delivers a promise is Nick's press; sending still needs his approval code.
  R('POST', '/api/promises/:key/prepare', 'email.send', { machine: 'refuse' }),
  R('POST', '/api/soap/:weekFrom/test-send', 'email.self'),
  R('POST', '/api/soap/recipients', 'config.security'),
  // 23 Oct 2026: a session PROPOSES a fix for the reports (domain default,
  // internal.state); what reaches Chris is Nick's — include/dismiss/edit and his
  // own manual entry (which is included at once) are refused to machines.
  R('POST', '/api/report-fixes/manual', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/report-fixes/:id/decide', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/report-fixes/:id/edit', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/weekly-risk/test-send', 'email.self'),

  // Calendar.
  R('POST', '/api/calendar/events', 'calendar.attendee.create'), // attendees → prepares; solo → A2 direct (the route decides)
  R('POST', '/api/calendar/events/:id/respond', 'retired.legacy'), // 410 since Build 8
  // The 1-2-1 routes PREPARE since Build 11 but have refused the API token since
  // Build 8 (the route says so itself); the matrix states the stricter rule.
  R('POST', '/api/1to1/book', 'calendar.attendee.create', { machine: 'refuse' }),
  R('POST', '/api/1to1/book-all', 'calendar.attendee.create', { machine: 'refuse' }),
  R('POST', '/api/1to1/apply-window', 'calendar.attendee.create', { machine: 'refuse' }),
  R('POST', '/api/leave/clashes/apply', 'calendar.leave-decline', { machine: 'refuse' }),
  R('POST', '/api/leave/auto-decline/run', 'calendar.leave-decline', { machine: 'refuse' }),
  R('POST', '/api/1to1/reschedule', 'calendar.attendee.reschedule', { machine: 'refuse' }),
  R('POST', '/api/1to1/cancel', 'calendar.attendee.cancel', { machine: 'refuse' }),
  R('POST', '/api/c/login', 'config.security'),
  R('POST', '/api/v/login', 'config.security'),
  R('POST', '/api/task-blocks', 'calendar.solo'),
  R('*', '/api/task-blocks/:id/:verb', 'calendar.solo'),
  R('*', '/api/task-blocks/:id/tasks/:taskId', 'calendar.solo'),
  R('POST', '/api/task-blocks/sweep', 'calendar.solo'),
  R('POST', '/api/day-plan/apply', 'calendar.solo'),
  R('POST', '/api/plaud/admin-blocks/apply', 'calendar.solo'),
  // Archiving a transcript moves Nick's notes out of the way — his decision, never a machine's.
  R('POST', '/api/plaud/transcripts/archive', 'vault.write', { machine: 'refuse' }),

  // Jira.
  R('POST', '/api/escalation', 'jira.escalate'),
  R('POST', '/api/escalation/ledger/resolve', 'jira.escalation.resolve'),

  // Microsoft tasks.
  R('POST', '/api/todos/complete-ms', 'microsoft.task.complete'),
  R('POST', '/api/todos/wip-ms', 'microsoft.task.progress'),
  R('PATCH', '/api/todos/ms/:msId/local', 'internal.state'),
  R('PATCH', '/api/todos/ms/:msId', 'microsoft.task.fields'),

  // The house, the laptop, the household surface, NOVA, Notion.
  R('POST', '/api/rooms/:key/accept', 'homeassistant.room'),
  R('POST', '/api/desktop/intents', 'desktop.launch'),
  R('POST', '/api/catalogues/:slug/shared', 'vesta.share'),
  R('POST', '/api/1to1/nova-sync', 'nova.121'),
  // NOVA asking for a booking only PREPARES the invite (machine: prepare); sending it
  // needs Nick's tap. Deliberately not 'nova.121', which refuses machines — NOVA is one.
  R('POST', '/api/1to1/booking-request', 'calendar.attendee.create'),
  R('POST', '/api/1to1/booking-sweep', 'calendar.attendee.create'),
  R('POST', '/api/1to1/nova-transcripts', 'nova.121'),
  R('POST', '/api/notion-sync/run', 'notion.publish'),
  R('POST', '/api/notion-sync/auto', 'notion.publish'),
  R('*', '/api/notion-sync/token', 'config.security'),
  R('PUT', '/api/notion-sync/mappings', 'config.security'),
  R('POST', '/api/notion-sync/unlock', 'config.security'),
  R('POST', '/api/canonical/needs-you/synthetic', 'push.synthetic-p0'),
  R('POST', '/api/push/test', 'push.self'),
  R('*', '/api/push/subscribe', 'config.security'),
  R('*', '/api/push/unsubscribe', 'config.security'),
  R('*', '/api/push/apns/register', 'config.security'),
  R('DELETE', '/api/push/subscriptions', 'config.security'),
  R('*', '/api/rescuetime/key', 'config.security'),
  R('*', '/api/weather/wu/key', 'config.security'),
  // The family Google calendar (18 Oct 2026): the OAuth client and the sign-in
  // are credentials; a sync only reads.
  R('*', '/api/google-calendar/client', 'config.security'),
  R('*', '/api/google-calendar/connect', 'config.security'),
  R('*', '/api/google-calendar/finish', 'config.security'),
  R('*', '/api/google-calendar/disconnect', 'config.security'),
  R('*', '/api/google-calendar/target', 'config.security'),
  R('POST', '/api/google-calendar/sync', 'ingest'),
  // The wall's own writes to it (account session, never a machine).
  R('*', '/api/v/family-calendar/events', 'calendar.family'),
  R('*', '/api/v/family-calendar/events/:id', 'calendar.family'),
  // Home energy: the Bright login is a credential; tariffs and the gas
  // calorific value decide what every cost says, so they are Nick's too.
  R('*', '/api/energy/credentials', 'config.security'),
  R('*', '/api/energy/tariffs', 'config.preference', { machine: 'refuse' }),
  R('*', '/api/energy/tariffs/:id/remove', 'config.preference', { machine: 'refuse' }),
  R('*', '/api/energy/gas-calorific-value', 'config.preference', { machine: 'refuse' }),
  // Personal mailboxes (12 Oct 2026): passwords, connection checks and the
  // self-only test send are Nick's, in Settings — never a machine's.
  R('*', '/api/mail/accounts/:key/credential', 'config.security'),
  R('POST', '/api/mail/accounts/:key/check', 'config.security'),
  R('POST', '/api/mail/accounts/:key/test-send', 'config.security'),
  // The personal inbox (12 Oct 2026): a reply is a governed email; reading and
  // marking read are the same as the work inbox's.
  R('POST', '/api/personal-inbox/refresh', 'internal.state'),
  R('POST', '/api/personal-inbox/message/:id/read', 'mail.read-state'),
  R('POST', '/api/personal-inbox/message/:id/reply', 'email.send'),
  R('POST', '/api/personal-inbox/compose', 'email.send'),
  // Delete moves a message to that mailbox's Bin/Trash — Nick's, never a machine's.
  R('POST', '/api/personal-inbox/message/:id/delete', 'mail.read-state', { machine: 'refuse' }),
  // Which Gmail mail shows, and the one-off backfill of it — Nick's choices, never a machine's.
  R('POST', '/api/personal-inbox/gmail/rules', 'internal.state', { machine: 'refuse' }),
  // Bulk mark-read / delete (to the Bin) — Nick's, never a machine's.
  R('POST', '/api/personal-inbox/bulk', 'mail.read-state', { machine: 'refuse' }),
  // Gmail clean-up: a rescan is a read; a decision (archive rule / keep / unsubscribe) is Nick's.
  R('POST', '/api/personal-inbox/gmail/cleanup/scan', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/gmail/cleanup', 'gmail.unsubscribe'),
  R('POST', '/api/personal-inbox/gmail/cleanup/bulk', 'gmail.unsubscribe'),
  R('POST', '/api/personal-inbox/gmail/backfill', 'internal.state', { machine: 'refuse' }),
  // Personal triage (13 Oct 2026): the work Inbox's verdicts for personal mail.
  // Every one is Nick's — a machine may read the sorted list, never sort it,
  // dismiss, mute, draft or reply from here.
  R('POST', '/api/personal-inbox/triage/muted/unmute', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/triage/clear-fyi', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/triage/dismiss/:id', 'mail.read-state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/triage/promote/:id', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/triage/:id/summary', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/triage/:id/draft', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/personal-inbox/triage/:id/reply', 'email.send', { machine: 'refuse' }),
  // Build 15: Nick's own statements about his goal — never a machine's.
  R('POST', '/api/loops/hiking/confirm', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/plan', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/entries/:id/withdraw', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/deny', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/personal-dates/lead', 'internal.state', { machine: 'refuse' }),
  // Build 19P: what a goal is about, what prepares for what, and what a list is
  // for are Nick's statements. A machine may read them and never make them.
  R('POST', '/api/canonical/goals', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/goals/:id', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/goals/:id/links', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/goals/:id/links/remove', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/prep-links', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/prep-links/remove', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/classifications', 'internal.state', { machine: 'refuse' }),
  // Build 20: Ember's care, her walks and what links to them, and which
  // vehicle an admin item concerns, are Nick's statements. Machines read only.
  R('POST', '/api/canonical/companions/:id/care', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/care/:id/done', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/care/:id/cancel', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/companions/:id/links', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/companions/:id/links/remove', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/companions/:id/walks', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/companions/:id/walks/remove', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/vehicle-links', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/vehicle-links/remove', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/canonical/personal-admin/annotations', 'internal.state', { machine: 'refuse' }),
  // Build 21AM/AN: the vehicle record, its dates, mileage, history, official
  // readings and every finance classification or rule are Nick's statements.
  // A machine may read them; it may not confirm a mapping, invent mileage,
  // alter an obligation or a conflict, or trigger a Tally read.
  R('POST', '/api/vehicle', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/mileage', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/mileage/:readingId/withdraw', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/events', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/events/:eventId/withdraw', 'internal.state', { machine: 'refuse' }),
  // Build 27: fuel fills (litres and the odometer — never an amount) are Nick's record.
  R('POST', '/api/vehicle/:id/fuel', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/fuel/:fillId/withdraw', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/obligations', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/official-check', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/:id/official-by-hand', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/obligations/:obligationId', 'internal.state', { machine: 'refuse' }),
  // 12 Oct 2026: car journeys. Approving one is Nick saying it was the car — a
  // machine that could approve would be writing his mileage estimate for him.
  R('POST', '/api/vehicle/journeys/sync', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/journeys/:journeyId/approve', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/journeys/:journeyId/reject', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/journeys/:journeyId/reopen', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/journeys/:journeyId/name-place', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/journeys/:journeyId/merge-next', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/obligations/:obligationId/resolve', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/finance/sync', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/finance/transactions/:txnId/decide', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/vehicle/finance/rules/:ruleId/retire', 'internal.state', { machine: 'refuse' }),
  // Build 23: how NEURO reads Nick's household finances is his statement.
  // Read-only towards Tally and money; machines read and never decide.
  R('POST', '/api/finance/sync', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/finance/transactions/:txnId/decide', 'tally.categorise'),
  R('POST', '/api/finance/rules/:ruleId/retire', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/finance/recurring/:seriesKey/decide', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/finance/review/:itemKey/decide', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/finance/obligations', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/finance/obligations/:id', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/finance/obligations/:id/resolve', 'internal.state', { machine: 'refuse' }),
  // Build 24: whose a project or repo is, its status, its links and blockers
  // are Nick's statements. The GitHub metadata snapshot is ingest from the
  // reporter that holds Nick's credential; NEURO itself never writes to GitHub.
  R('POST', '/api/projects/github/snapshot', 'ingest'),
  R('POST', '/api/projects/refresh', 'internal.state'),
  R('POST', '/api/projects/declare', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/repos/:repoId/classify', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/owners/:owner/classify', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/classify', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/status', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/repos', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/tasks', 'internal.state', { machine: 'refuse' }),
  // Task activity (15 Oct 2026): Nick's choice is authoritative, and accepting an
  // observation IS his choice — no machine states either for him.
  R('POST', '/api/task-activity/observations/:observationId/review', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/task-activity/:taskId', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/next', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/blockers', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/projects/:projectId/blockers/:blockerId/resolve', 'internal.state', { machine: 'refuse' }),
  // A lead-reminder cadence decides when NEURO may push to Nick about a date.
  R('POST', '/api/canonical/lead-reminders', 'internal.state', { machine: 'refuse' }),
  // Build 18Q: a birthday written into Nick's own People/Companion note.
  R('POST', '/api/loops/personal-dates/declared', 'vault.write', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/denials/:id/withdraw', 'internal.state', { machine: 'refuse' }),
  // Build 29: route plans and what Nick links to an activity (a route, Ember)
  // are his own statements. Machines read Outdoor; they never write it.
  R('POST', '/api/outdoor/routes', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/routes/:routeId', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/activities/:activityId/route', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/activities/:activityId/route/remove', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/activities/:activityId/companion', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/activities/:activityId/companion/remove', 'internal.state', { machine: 'refuse' }),
  // Hike safety: arming is the approval of an unattended email, and a machine
  // that could check Nick in could silence the alert. All of it is his.
  R('POST', '/api/outdoor/safety/contacts', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/safety/trips', 'hike.safety-alert'),
  R('POST', '/api/outdoor/safety/trips/:tripId/edit', 'hike.safety-alert'),
  R('POST', '/api/outdoor/safety/trips/:tripId/checkin', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/safety/trips/:tripId/extend', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/outdoor/safety/trips/:tripId/cancel', 'internal.state', { machine: 'refuse' }),
  // Build 30: what Nick is into, liked, finished or dropped is his own word.
  // Machines read Leisure; they never write it.
  R('POST', '/api/leisure/items', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/leisure/items/:itemId', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/leisure/correct', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/leisure/discovery/refresh', 'internal.state', { machine: 'refuse' }),
  // Build 31: who someone is to Nick — relationship, sphere, household, a
  // merge, "not this person", a new People note — is his word, written into
  // his People notes. Machines read People; they never write it.
  R('POST', '/api/people', 'vault.write', { machine: 'refuse' }),
  R('POST', '/api/people/duplicates/decide', 'vault.write', { machine: 'refuse' }),
  R('POST', '/api/people/links/reject', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/people/:personId/classify', 'vault.write', { machine: 'refuse' }),
  R('*', '/api/capture/file', 'file.write'),
  R('*', '/api/capture/photo', 'file.write'),
  R('POST', '/api/vault/export-docx', 'file.write'),
  // Medical records (8 Oct 2026). Proposing and adding are open to an agent
  // (ChatGPT parses the NHS app and posts here); deleting one is Nick's.
  R('POST', '/api/medical/scan', 'medical.scan'),
  R('POST', '/api/medical/records', 'medical.record'),
  R('DELETE', '/api/medical/records/:id', 'medical.record', { machine: 'refuse' }),
]);

const DOMAIN_DEFAULTS = Object.freeze({
  // credentials, accounts, switches
  pin: 'config.security', auth: 'config.security', 'capture-links': 'config.security', ai: 'config.security', 'feature-flags': 'config.security',
  // local vault
  vault: 'vault.write', 'vault-dnd': 'vault.write', 'vault-hygiene': 'vault.write', obsidian: 'vault.write', capture: 'vault.write', journal: 'vault.write',
  profile: 'vault.write', evidence: 'vault.write', 'development-plan': 'vault.write', 'kb-article': 'vault.write', 'person-profile': 'vault.write',
  catalogues: 'vault.write', 'knowledge-memory': 'vault.write', imports: 'vault.write', 'people-gap': 'vault.write', standup: 'vault.write',
  plaud: 'plaud.pull',
  // NEURO tasks
  tasks: 'task.status', todos: 'task.status', 'task-dedupe': 'task.status', 'do-next': 'task.status', c: 'task.status', v: 'task.status', 'waiting-on': 'task.status',
  // sensors and devices
  location: 'ingest', health: 'ingest', device: 'ingest', apple: 'ingest', environment: 'ingest', weather: 'ingest', desktop: 'ingest', router: 'ingest', 'nova-signals': 'ingest',
  v1: 'ingest', mobile: 'ingest', performance: 'ingest', rescuetime: 'ingest', jira: 'ingest', energy: 'ingest',
  // notifications to Nick
  nudges: 'push.self', briefing: 'push.self', briefings: 'push.self', push: 'push.self',
  // preferences
  setup: 'config.preference', 'weekly-target': 'config.preference', greeting: 'config.preference', tts: 'config.preference',
  // NEURO's own state
  actions: 'internal.state', attention: 'internal.state', activity: 'internal.state', adhd: 'internal.state', canonical: 'internal.state',
  chat: 'internal.state', 'day-plan': 'internal.state', email: 'internal.state', friction: 'internal.state', outcomes: 'internal.state',
  rooms: 'internal.state', session: 'internal.state', signals: 'internal.state', 'standup-session': 'internal.state', 'task-blocks': 'internal.state',
  'weekly-risk': 'internal.state', soap: 'internal.state', 'report-fixes': 'internal.state', wins: 'internal.state', '1to1': 'internal.state', leave: 'internal.state', calendar: 'internal.state', microsoft: 'internal.state',
  'notion-sync': 'internal.state', 'prepared-actions': 'internal.state', escalation: 'internal.state',
  vehicle: 'internal.state', transport: 'internal.state', finance: 'internal.state', projects: 'internal.state',
  outdoor: 'internal.state', leisure: 'internal.state', people: 'vault.write', 'task-context': 'internal.state',
});

function _segments(p) { return String(p || '').split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean); }

function _matches(pattern, path) {
  const a = _segments(pattern);
  const b = _segments(path);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') ? b[i].length > 0 : seg === b[i]);
}

/**
 * Which capability does this request exercise? Pure.
 * @returns {{ capability: string|null, via: 'rule'|'domain'|'get'|null, rule?: string }}
 */
function resolve(method, path) {
  const m = String(method || 'GET').toUpperCase();
  for (const r of ROUTE_RULES) {
    if ((r.method === '*' ? m !== 'GET' : r.method === m) && _matches(r.path, path)) {
      return { capability: r.cap, via: 'rule', rule: `${r.method} ${r.path}`, machine: r.machine || null };
    }
  }
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { capability: 'read', via: 'get' };
  const segs = _segments(path);
  const domain = segs[0] === 'api' ? segs[1] : null;
  if (domain && DOMAIN_DEFAULTS[domain]) return { capability: DOMAIN_DEFAULTS[domain], via: 'domain' };
  return { capability: null, via: null };
}

/** Pure. May a machine caller make this request? */
function machineDecision(method, path) {
  const r = resolve(method, path);
  if (!r.capability) return { allow: false, status: 403, capability: null, reason: 'This route has no entry in the authority matrix, so a machine client may not call it.' };
  const c = CAPABILITIES[r.capability];
  const machine = r.machine || c.machine;
  if (machine === 'retired') return { allow: false, status: 410, capability: r.capability, reason: c.retiredReason };
  if (machine === 'refuse') return { allow: false, status: 403, capability: r.capability, reason: `${c.effect} — ${c.authority}, needs Nick in NEURO. A machine client cannot do this on his behalf.` };
  return { allow: true, capability: r.capability, mode: machine };
}

/** Pure. Every capability as rows (for the matrix table and the route). */
function table() {
  return Object.entries(CAPABILITIES).map(([id, c]) => ({ id, ...c }));
}

module.exports = { CAPABILITIES, ROUTE_RULES, DOMAIN_DEFAULTS, resolve, machineDecision, table, _matches };
