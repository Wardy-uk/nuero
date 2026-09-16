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
