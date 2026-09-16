// VANTAGE classification. EXPLICIT per operation, deliberately with no heuristic
// fallback: NEURO's `classify()` infers a tier from the route shape because it has
// 500+ routes, and VANTAGE has 41 — few enough that every one can be decided by
// reading its handler. A route added to VANTAGE and not listed here fails
// `vantage.test.js` rather than inheriting a guessed tier.
//
// The tiers reuse NEURO's OAuth scopes (neuro:read / write / action / admin), so
// adding VANTAGE needs no change at the authorization server. The rule for the
// line between write and action is the same one NEURO's policy uses: `write` stays
// inside VANTAGE's own SQLite; `action` reaches NEURO, Microsoft, NOVA or spends a
// model call.
export const classification = {
  // ── read: local, no side effects ──
  vantage_get_health: 'read',
  vantage_get_signals: 'read',           // ?refresh=1 forces a NOVA pull — see actionQuery
  vantage_get_radar: 'read',             // ?refresh=1 rebuilds (NOVA + model) — see actionQuery
  vantage_get_findings: 'read',
  vantage_get_findings_markdown: 'read',
  vantage_get_findings_auto_push: 'read', // run({apply:false}) — the dry run
  vantage_get_plan: 'read',
  vantage_get_plan_tasks: 'read',        // ?rematch=1 forces a model call — see actionQuery
  vantage_get_friction: 'read',          // NEURO's friction read, a GET
  vantage_get_coach_modes: 'read',
  vantage_get_coach_sessions: 'read',
  vantage_get_coach_sessions_by_id: 'read',
  vantage_get_coach_brief: 'read',       // ?refresh=1 regenerates with a model — see actionQuery
  vantage_get_self: 'read',
  vantage_get_self_quick: 'read',
  vantage_get_self_moved: 'read',
  vantage_get_observations: 'read',

  // ── write: VANTAGE's own store only ──
  vantage_post_findings: 'write',
  vantage_put_findings_by_id: 'write',
  vantage_delete_findings_by_id: 'write',
  vantage_post_findings_by_id_resolve: 'write',
  vantage_post_findings_by_id_reopen: 'write',
  vantage_put_plan_by_id: 'write',
  vantage_post_plan_by_id_link: 'write',     // records a link to an EXISTING NEURO task; writes nothing to NEURO
  vantage_delete_plan_by_id_link: 'write',
  vantage_post_coach_sessions: 'write',
  vantage_delete_coach_sessions_by_id: 'write',
  vantage_post_coach_brief_start: 'write',   // opens a session seeded from a theme; no model call
  vantage_post_observations: 'write',
  vantage_delete_observations_by_id: 'write',

  // ── action: crosses out of VANTAGE ──
  vantage_post_findings_by_id_draft: 'action',       // OpenRouter call
  vantage_post_findings_by_id_neuro: 'action',       // escalates a finding into NEURO
  vantage_post_findings_sync: 'action',              // reads/reconciles against NEURO
  vantage_post_findings_auto_push: 'action',         // run({apply:true}) — writes NEURO tasks/actions
  vantage_post_plan_by_id_task: 'action',            // creates a NEURO task
  vantage_post_plan_by_id_planner: 'action',         // adopts a Microsoft Planner card into NEURO
  vantage_post_coach_sessions_by_id_messages: 'action', // model call

  // ── admin: VANTAGE's own configuration ──
  vantage_get_settings: 'admin',          // masked, but it describes every credential VANTAGE holds
  vantage_put_settings: 'admin',
  vantage_post_settings_pin: 'admin',
  vantage_post_settings_test_by_what: 'admin', // spends a model call / probes NOVA to test config
};

// A GET that does real work when asked to. The read tool refuses the switch
// outright rather than silently dropping it, because a refresh the caller asked for
// and did not get looks exactly like stale data; the action tool accepts it.
export const actionQuery = {
  vantage_get_signals: ['refresh'],
  vantage_get_radar: ['refresh'],
  vantage_get_plan_tasks: ['rematch'],
  vantage_get_coach_brief: ['refresh'],
};

// VANTAGE's own CLAUDE.md: coach, brief, self and the observations are PRIVATE —
// "nothing from them is quoted, summarised or exported into anything outward-facing
// unless Nick moves it himself". This gateway serves external assistants, so the
// private half is WITHHELD unless VANTAGE_MCP_PRIVATE=true. It stays listed in
// discovery, marked withheld: an operation that silently does not exist is
// indistinguishable from VANTAGE not having it, and that is a false answer.
// `/api/friction` is NEURO's own friction read, not VANTAGE's private half.
export const privateOperations = new Set([
  'vantage_get_coach_modes', 'vantage_get_coach_sessions', 'vantage_get_coach_sessions_by_id',
  'vantage_post_coach_sessions', 'vantage_delete_coach_sessions_by_id', 'vantage_post_coach_sessions_by_id_messages',
  'vantage_get_coach_brief', 'vantage_post_coach_brief_start',
  'vantage_get_self', 'vantage_get_self_quick', 'vantage_get_self_moved',
  'vantage_get_observations', 'vantage_post_observations', 'vantage_delete_observations_by_id',
]);

export const paramEnums = {
  vantage_post_settings_test_by_what: { what: ['openrouter', 'nova'] },
};

// Guidance a route string cannot carry.
export const notes = {
  vantage_get_findings_auto_push: 'Dry run: shows which findings WOULD be pushed to NEURO. Changes nothing.',
  vantage_post_findings_auto_push: 'Applies the auto-push: writes NEURO tasks or pending actions for qualifying findings. Run the GET dry run first and confirm with the user.',
  vantage_post_findings_by_id_neuro: 'Escalates one finding into NEURO (a task or an approval-queue action). Confirm with the user first.',
  vantage_post_plan_by_id_link: 'body.taskId is an EXISTING NEURO task id. To create a new task use vantage_post_plan_by_id_task.',
  vantage_post_coach_sessions_by_id_messages: 'body.content is the user message; VANTAGE\'s coach answers with a model call.',
};

// ── Request bodies ───────────────────────────────────────────────────────────
// The inventory reads route STRINGS, so a handler taking `req.body || {}` is
// recorded as `bodyOpen` — arbitrary JSON, no contract. A client then has nothing
// to construct from and guesses: ChatGPT sent {kind, title, content} to
// POST /api/observations on 16 Sep 2026 and got a bare `backend_http_400`, because
// the field is `note` and `title`/`content` do not exist. The gateway never returns
// upstream error text, so the reason was unreadable from outside.
//
// These schemas are TRANSCRIBED FROM THE HANDLERS, one per operation, and exist to
// DESCRIBE the backend rather than to police it — VANTAGE's own validation is
// unchanged and still runs. They are strict: an unknown key is a named schema error
// here instead of a 400 with no reason, which is the whole failure being fixed.
//
// ⚠ `PUT /api/findings/:id` takes snake_case (`raised_with`, `found_on`,
// `raised_on`) while POST takes camelCase (`raisedWith`, `foundOn`). That is the
// live contract — `update()` filters against a snake_case allow-list and SILENTLY
// DROPS anything else, so a camelCase patch returns 200 having written nothing.
// Advertising it wrongly would be worse than advertising nothing.
import { z } from 'zod';
const text = z.string().min(1).max(4000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const SEVERITIES = ['high', 'medium', 'low'];
const TENSES = ['happened', 'happening', 'could'];
const FINDING_STATUSES = ['open', 'raised', 'resolved_pending', 'resolved', 'accepted'];
const PLAN_STATUSES = ['not-started', 'in-progress', 'blocked', 'escalated', 'done'];
const COACH_MODES = ['coach', 'prep', 'reflect'];
export const OBSERVATION_KINDS = ['pattern', 'win', 'blocker', 'avoidance'];
const SETTING_KEYS = ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'NOVA_BRIDGE_URL', 'NOVA_BRIDGE_SECRET', 'NEURO_URL', 'NEURO_API_TOKEN', 'NEURO_VAULT_API_KEY', 'ONE_TO_ONE_GRACE_DAYS', 'ONE_TO_ONE_BOOK_AHEAD_DAYS', 'QA_SCORE_FLOOR', 'GOLDEN_RULES_FLOOR', 'STANDUP_FLOOR_PCT'];

export const bodySchemas = {
  // coach.addObservation({ kind, note, sessionId })
  vantage_post_observations: z.strictObject({
    kind: z.enum(OBSERVATION_KINDS),
    note: text,
    sessionId: z.number().int().nullable().optional(),
  }),
  // findings.add({ title, detail, source, severity, foundOn, action, raisedWith, raisedOn, tense })
  vantage_post_findings: z.strictObject({
    title: text,
    detail: z.string().max(8000).optional(),
    source: z.string().max(200).optional(),
    severity: z.enum(SEVERITIES).optional(),
    foundOn: date.optional(),
    action: z.string().max(4000).optional(),
    raisedWith: z.string().max(200).optional(),
    raisedOn: date.optional(),
    tense: z.enum(TENSES).optional(),
  }),
  // findings.update(id, patch) — snake_case allow-list; anything else is dropped.
  vantage_put_findings_by_id: z.strictObject({
    title: text.optional(),
    detail: z.string().max(8000).optional(),
    severity: z.enum(SEVERITIES).optional(),
    status: z.enum(FINDING_STATUSES).optional(),
    action: z.string().max(4000).optional(),
    raised_with: z.string().max(200).optional(),
    raised_on: date.optional(),
    found_on: date.optional(),
    tense: z.enum(TENSES).optional(),
  }),
  // findings.resolve(id, { how, on }) — `how` is required: "resolved" alone records nothing.
  vantage_post_findings_by_id_resolve: z.strictObject({ how: text, on: date.optional() }),
  // findings.escalate(id, { week }) — null/absent means the current week.
  vantage_post_findings_by_id_neuro: z.strictObject({ week: z.string().max(20).nullable().optional() }),
  // findings.draftRaise(id, { to }) — defaults to Chris.
  vantage_post_findings_by_id_draft: z.strictObject({ to: z.string().max(80).optional() }),
  // plan.setStatus(id, { status, note })
  vantage_put_plan_by_id: z.strictObject({ status: z.enum(PLAN_STATUSES).optional(), note: z.string().max(4000).nullable().optional() }),
  // planTasks.createFor(planId, { dueDate, moscow })
  vantage_post_plan_by_id_task: z.strictObject({ dueDate: date.optional(), moscow: z.enum(['must', 'should', 'could', 'wont']).optional() }),
  // planTasks.link(planId, taskId) — the route reads body.taskId only.
  vantage_post_plan_by_id_link: z.strictObject({ taskId: z.union([z.number().int(), z.string().min(1).max(80)]) }),
  // planTasks.adoptMicrosoft(planId, { msId, msSource, text })
  vantage_post_plan_by_id_planner: z.strictObject({ msId: z.string().min(1).max(400), text: text, msSource: z.string().max(80).optional() }),
  // coach.createSession({ title, mode })
  vantage_post_coach_sessions: z.strictObject({ title: z.string().max(200).optional(), mode: z.enum(COACH_MODES).optional() }),
  // coach.send({ content, model }) — sessionId comes from the path.
  vantage_post_coach_sessions_by_id_messages: z.strictObject({ content: text, model: z.string().max(120).optional() }),
  // brief.startFrom(theme) — the whole theme object IS the body.
  vantage_post_coach_brief_start: z.strictObject({
    title: text,
    evidence: z.string().max(8000).optional(),
    why: z.string().max(8000).optional(),
    nextStep: z.string().max(4000).optional(),
    question: z.string().max(4000).optional(),
  }),
  // settings.save(patch) — known keys only; null clears one. THROWS on an unknown key.
  vantage_put_settings: z.strictObject(Object.fromEntries(SETTING_KEYS.map(k => [k, z.string().max(4000).nullable().optional()]))),
  // settings.changePin({ current, next }) — next must be >= 6 characters.
  vantage_post_settings_pin: z.strictObject({ current: z.string().min(1).max(200), next: z.string().min(6).max(200) }),
};

// Routes whose handler reads no body at all. Advertising "arbitrary JSON" here
// invites a client to send something meaningful that is then silently ignored.
export const noBody = new Set([
  'vantage_post_findings_by_id_reopen', 'vantage_post_findings_sync', 'vantage_post_findings_auto_push',
  'vantage_post_settings_test_by_what', 'vantage_delete_findings_by_id', 'vantage_delete_observations_by_id',
  'vantage_delete_coach_sessions_by_id', 'vantage_delete_plan_by_id_link',
]);
