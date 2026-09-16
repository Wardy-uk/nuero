// Explicit transport adaptations. These routes are represented in discovery but
// retain their original authentication boundary rather than exporting credentials.
export const interactive = {
  post_auth_login: 'NEURO browser login; MCP uses OAuth instead.',
  post_c_login: 'Sign into the capture application; configure NEURO_CAPTURE_SESSION in the gateway secret environment.',
  post_v_login: 'Sign into VESTA; configure NEURO_CAPTURE_SESSION in the gateway secret environment.',
  get_strava_auth: 'Connect Strava in NEURO; the browser must follow the authorization redirect.',
  get_strava_callback: 'OAuth callback consumed by the browser, not an independent user action.',
  post_pin: 'NEURO deliberately rejects machine clients for PIN changes. Use the signed-in NEURO settings screen.',
};
// Path params the backend accepts only from a closed set. The inventory is
// generated from route strings and cannot see a handler's own validation, so a
// model was left to guess — ChatGPT guessed a standup `kind`, NEURO answered 400,
// and the gateway (which never returns upstream error text) could only say
// `backend_http_400`. Declaring the set makes the wrong value a schema error the
// model can read and correct before anything reaches NEURO.
const STANDUP_KINDS = ['standup', 'eod'];
export const paramEnums = Object.fromEntries(
  ['get_standup_session_by_kind', 'post_standup_session_by_kind_start', 'post_standup_session_by_kind_reply',
    'post_standup_session_by_kind_finish', 'post_standup_session_by_kind_abandon']
    .map(id => [id, { kind: STANDUP_KINDS }]),
);
// Guidance a route string cannot carry. The session routes start a conversation
// with NEURO's OWN model; an external assistant that has already run the standup
// with Nick records the result with save_to_daily, which is what marks it done.
const SESSION_NOTE = 'Opens a standup conversation driven by NEURO\'s own AI (start → reply → finish; kind is "standup" or "eod"). If you have already run the standup with the user, do NOT use this — record it with post_standup_save_to_daily instead.';
export const notes = {
  post_standup_session_by_kind_start: SESSION_NOTE,
  post_standup_session_by_kind_reply: SESSION_NOTE,
  post_standup_session_by_kind_finish: SESSION_NOTE,
  post_standup_save_to_daily: 'Record a morning standup the user has done with you. body.content is markdown appended under "## Standup — <date>" in today\'s daily note, and marks the standup done. Include a "## Focus Today" section of "- [ ] item" lines: tomorrow\'s standup reads that heading back to check what was carried over.',
};
export const aliases ={ post_chat: '/api/chat/sync', get_nudges_stream: '/api/nudges' };
const adminDomains = new Set(['auth', 'pin', 'capture-links', 'ai', 'feature-flags']);
const localWriteDomains = new Set(['vault', 'vault-dnd', 'vault-hygiene', 'obsidian', 'capture', 'journal', 'profile', 'evidence', 'development-plan', 'kb-article', 'person-profile', 'catalogues', 'friction', 'weekly-target', 'wins', 'do-next', 'knowledge-memory']);
export function classify(op) {
  if (interactive[op.id] || adminDomains.has(op.domain) || op.route.split('/').some(part => /^(auth|token|key|mappings|unlock|disconnect|register|subscribe|unsubscribe)$/.test(part))) return 'admin';
  // Some GET handlers persist notes or deliver notifications on request. Do not
  // permit a read token to invoke their optional mutation switches.
  if (op.method === 'GET') return op.query.some(k => /^(write|notify|apply|trigger|sync|force)$/i.test(k)) ? 'action' : 'read';
  if (localWriteDomains.has(op.domain)) return 'write';
  // Conservative: task completion, approvals, scheduling, sync and ingest may
  // cascade into external services or notifications even if they return JSON.
  return 'action';
}
export const scopesFor = kind => kind === 'read' ? ['neuro:read'] : kind === 'write' ? ['neuro:read', 'neuro:write'] : ['neuro:read', 'neuro:write', `neuro:${kind}`];
