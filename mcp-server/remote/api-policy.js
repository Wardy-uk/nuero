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
// with Nick records the result with post_standup_record / post_standup_eod_record,
// which is what marks it done.
const SESSION_NOTE = 'Opens a standup conversation driven by NEURO\'s own AI (start → reply → finish; kind is "standup" or "eod"). If you have already run the standup with the user, do NOT use this — record it with post_standup_record (morning) or post_standup_eod_record (evening) instead.';
// The canonical ritual-persistence route, and the description has to say so in
// as many words. Sara ran a full standup on 17 Sep 2026 and saved it with the
// generic note capture, because nothing told her there was a ritual route — so
// the prose landed in Imports/ and NEURO went on reporting NO STANDUP. A route
// that exists and is not discoverable as the right one is a route nobody uses.
const RECORD_NOTE = 'THE canonical way to complete this ritual when you have already run it with the user in conversation. Do not use capture_note / post_capture_note for a standup or EOD: that files prose the ritual system cannot see. This writes NEURO\'s own daily-note format (the same one its native standup writes), preserves everything else already in the note, and is idempotent — calling it again replaces today\'s ritual rather than duplicating it.';
export const notes = {
  post_standup_session_by_kind_start: SESSION_NOTE,
  post_standup_session_by_kind_reply: SESSION_NOTE,
  post_standup_session_by_kind_finish: SESSION_NOTE,
  // (!) The keyword lists are not decoration, and they are LITERAL on purpose.
  // `neuro_capabilities` is a plain substring match over
  // `id + domain + description`, so the obvious search "standup record" found
  // NOTHING: the id spells it `standup_record`, the route spells it
  // `standup/record`, and nothing else carried the two words with a space
  // between them. Prose aliases did not fix it either — "record standup" matched
  // and "standup record" still did not. An operation nobody can find by the
  // words they would search for is the state this whole change is fixing, one
  // layer up. Pinned by ritual-record-routing.test.js.
  post_standup_record: `standup.record. Search keywords: standup record, record standup, save standup, complete standup, finish standup, morning ritual. ${RECORD_NOTE} body.focus is a REQUIRED array of strings — what the user committed to today, one per item; these become the "## Focus Today" checkboxes that mark the standup done and that tomorrow reads back as carry-overs. Optional: body.blockers (string), body.mood (string), body.date ("YYYY-MM-DD", defaults to today).`,
  post_standup_eod_record: `eod.record. Search keywords: eod record, record eod, save eod, complete eod, end of day reflection, evening ritual. ${RECORD_NOTE} Supply at least one of body.done (array of strings — what got finished), body.didntGo (string), body.tomorrowFirst (string), body.mood (string). Optional body.date ("YYYY-MM-DD") records an evening already past — use it the morning after. Writes the "## EOD" section the evening ritual owns.`,
  // Same trap as post_standup_record above: `neuro_capabilities` is a plain
  // substring match, so the obvious search "people gap" (with a space) matches
  // neither the id (`people_gap`) nor the domain (`people-gap`). Keywords are
  // literal on purpose.
  post_people_gap_apply: 'people-gap.apply. Search keywords: people gap, missing person note, create person note, suggested people, who has no People note. Creates stub People notes for names NEURO keeps seeing with no note. Pass body.names to pick a subset (a name from the seen-once list needs body.minSightings: 1). NEVER guesses cadence or whether someone is a direct report; body.role is the one field it will set.',
  post_people_gap_ignore: 'people-gap.ignore. Search keywords: people gap, ignore person, not a person, meeting room name, stop suggesting. Records that a suggested name is not someone to file — a room, a shared mailbox, a mis-transcription. Reversible via post_people_gap_unignore.',
  post_people_gap_alias: 'people-gap.alias. Search keywords: people gap, add alias, alias of, mis-transcription, same person, merge name. (!) EDITS A PEOPLE NOTE THE USER MAINTAINS BY HAND and there is no undo. Call with body.dryRun: true FIRST and show the returned `line` before writing. Refuses (HTTP 409) an alias already claimed by someone else.',
  post_standup_save_to_daily: 'SUPERSEDED by post_standup_record — prefer that. Appends free markdown under "## Standup — <date>". It marks the standup done but writes no "## Focus Today", so tomorrow\'s carry-over scan reads nothing.',
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
