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
export const aliases = { post_chat: '/api/chat/sync', get_nudges_stream: '/api/nudges' };
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
