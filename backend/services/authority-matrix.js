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
  'config.preference': { authority: 'A1', effect: 'preferences and setup state (quiet hours, weekly target, skip a setup step)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: true },

  'vault.write': { authority: 'A2', effect: 'Vault write (append/surgical, backed up)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: 'vault-hooks re-index', idempotent: 'per route' },
  'file.write': { authority: 'A2', effect: 'a file written into the vault (capture file/photo, docx export)', machine: 'execute', approval: 'none', registry: null, ledger: false, verification: null, idempotent: false },
  'calendar.solo': { authority: 'A2', effect: "events with NO attendees in Nick's own calendar (task blocks, day planner, Plaud admin blocks)", machine: 'execute', approval: 'none', registry: 'external-writes:microsoft.calendar.solo', ledger: false, verification: null, idempotent: 'UNIQUE(date,start) / ledgers' },
  'mail.read-state': { authority: 'A2', effect: 'mark an email read on dismiss', machine: 'execute', approval: 'none', registry: 'external-writes:microsoft.mail.read-state', ledger: false, verification: null, idempotent: true },
  'weather.wu-publish': { authority: 'A2', effect: "upload our own weather station's readings to Weather Underground (ICOALV59)", machine: 'execute', approval: 'none', registry: 'external-writes:wunderground.publish', ledger: false, verification: 'WU answers "success"', idempotent: 'WU folds a repeat dateutc' },
  'email.self': { authority: 'A2', effect: 'a [TEST] copy to Nick only (refuses any other recipient)', machine: 'execute', approval: 'none', registry: 'external-writes:email.self', ledger: false, verification: null, idempotent: false },
  'desktop.launch': { authority: 'A2', effect: "open an ALLOWLISTED app on Nick's laptop (no arguments)", machine: 'execute', approval: 'none', registry: null, ledger: true, verification: 'agent outcome', idempotent: 'queue de-dupes' },
  'plaud.pull': { authority: 'A2', effect: 'pull recordings from PLAUD into the vault', machine: 'execute', approval: 'none', registry: null, ledger: true, verification: 'sync ledger', idempotent: 'canonical plaud_id' },
  'push.synthetic-p0': { authority: 'A2', effect: 'a synthetic P0 interrupt on the phone', machine: 'refuse', approval: 'click', registry: null, ledger: true, verification: 'attention_notifications', idempotent: true },
  'homeassistant.room': { authority: 'A2', effect: 'lights / radiator in the house, from an accepted room offer', machine: 'refuse', approval: 'click', registry: 'external-writes:homeassistant.room', ledger: false, verification: 'next house read', idempotent: true },

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

  'email.send': { authority: 'A4', effect: 'email to another person as Nick', machine: 'prepare', approval: 'approval-code', registry: 'action-registry:chase_commitment,reply_email,chase_agenda,send_weekly_risk_report', ledger: true, verification: 'Sent Items match', idempotent: 'one attempt per approved version' },
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

  // Approval is Nick's.
  R('POST', '/api/prepared-actions/:id/approve', 'approval.decide'),
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
  R('POST', '/api/weekly-risk/test-send', 'email.self'),

  // Calendar.
  R('POST', '/api/calendar/events', 'calendar.attendee.create'), // attendees → prepares; solo → A2 direct (the route decides)
  R('POST', '/api/calendar/events/:id/respond', 'retired.legacy'), // 410 since Build 8
  // The 1-2-1 routes PREPARE since Build 11 but have refused the API token since
  // Build 8 (the route says so itself); the matrix states the stricter rule.
  R('POST', '/api/1to1/book', 'calendar.attendee.create', { machine: 'refuse' }),
  R('POST', '/api/1to1/book-all', 'calendar.attendee.create', { machine: 'refuse' }),
  R('POST', '/api/1to1/reschedule', 'calendar.attendee.reschedule', { machine: 'refuse' }),
  R('POST', '/api/c/login', 'config.security'),
  R('POST', '/api/v/login', 'config.security'),
  R('POST', '/api/task-blocks', 'calendar.solo'),
  R('*', '/api/task-blocks/:id/:verb', 'calendar.solo'),
  R('*', '/api/task-blocks/:id/tasks/:taskId', 'calendar.solo'),
  R('POST', '/api/task-blocks/sweep', 'calendar.solo'),
  R('POST', '/api/day-plan/apply', 'calendar.solo'),
  R('POST', '/api/plaud/admin-blocks/apply', 'calendar.solo'),

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
  // Build 15: Nick's own statements about his goal — never a machine's.
  R('POST', '/api/loops/hiking/confirm', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/plan', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/entries/:id/withdraw', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/deny', 'internal.state', { machine: 'refuse' }),
  R('POST', '/api/loops/personal-dates/lead', 'internal.state', { machine: 'refuse' }),
  // Build 18Q: a birthday written into Nick's own People/Companion note.
  R('POST', '/api/loops/personal-dates/declared', 'vault.write', { machine: 'refuse' }),
  R('POST', '/api/loops/hiking/denials/:id/withdraw', 'internal.state', { machine: 'refuse' }),
  R('*', '/api/capture/file', 'file.write'),
  R('*', '/api/capture/photo', 'file.write'),
  R('POST', '/api/vault/export-docx', 'file.write'),
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
  v1: 'ingest', mobile: 'ingest', performance: 'ingest', rescuetime: 'ingest', training: 'ingest', jira: 'ingest',
  // notifications to Nick
  nudges: 'push.self', briefing: 'push.self', push: 'push.self',
  // preferences
  setup: 'config.preference', 'weekly-target': 'config.preference', greeting: 'config.preference', tts: 'config.preference',
  // NEURO's own state
  actions: 'internal.state', attention: 'internal.state', activity: 'internal.state', adhd: 'internal.state', canonical: 'internal.state',
  chat: 'internal.state', 'day-plan': 'internal.state', email: 'internal.state', friction: 'internal.state', outcomes: 'internal.state',
  rooms: 'internal.state', session: 'internal.state', signals: 'internal.state', 'standup-session': 'internal.state', 'task-blocks': 'internal.state',
  'weekly-risk': 'internal.state', wins: 'internal.state', '1to1': 'internal.state', calendar: 'internal.state', microsoft: 'internal.state',
  'notion-sync': 'internal.state', 'prepared-actions': 'internal.state', escalation: 'internal.state',
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
