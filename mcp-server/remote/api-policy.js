// Explicit transport adaptations. These routes are represented in discovery but
// retain their original authentication boundary rather than exporting credentials.
export const interactive = {
  post_auth_login: 'NEURO browser login; MCP uses OAuth instead.',
  post_c_login: 'Sign into the capture application; configure NEURO_CAPTURE_SESSION in the gateway secret environment.',
  post_v_login: 'Sign into VESTA; configure NEURO_CAPTURE_SESSION in the gateway secret environment.',
  post_pin: 'NEURO deliberately rejects machine clients for PIN changes. Use the signed-in NEURO settings screen.',
  // Build 6: approving a prepared action can SEND EMAIL AS NICK. A4 approval is
  // his, in NEURO, against the exact words he reads — never an agent's. The
  // backend refuses the API token as well; this stops the gateway offering it.
  post_prepared_actions_by_id_approve: 'Approving a drafted action is Nick\'s decision and may send email as him. He approves it in NEURO → Actions, where the exact recipient and words are shown. An agent must never approve on his behalf.',
  post_prepared_actions_by_id_edit: 'Editing a drafted action creates a new version that Nick must approve in NEURO → Actions.',
  // Build 7: the rest of the human half of the action queue. The challenge is
  // useless without Nick's approval code, but offering it to an agent invites
  // the attempt; rejecting is recorded as Nick's decision, so an agent must not
  // make it either. Preparing a chase (post_waiting_on_by_key_chase) stays
  // available: it drafts and sends nothing.
  post_prepared_actions_by_id_approval_challenge: 'Approval challenges are for Nick approving in NEURO → Actions with his approval code. An agent cannot approve.',
  // 9 Oct 2026: Nick-direct confirm. A grant is minted when Nick presses the
  // final button in NEURO; an agent must never mint or spend one.
  post_prepared_actions_by_id_intent_grant: 'Confirming an action directly is Nick pressing the button in NEURO. An agent cannot do it on his behalf.',
  post_prepared_actions_by_id_execute_direct: 'Making a change Nick confirmed is done from the NEURO screen he pressed it on. An agent cannot do it.',
  post_prepared_actions_by_id_reject:'Rejecting a drafted action is recorded as Nick\'s decision. He rejects it in NEURO → Actions.',
  // The legacy approval queue. Since Build 8 it sends nothing outbound (those
  // types answer 410), but approving still runs internal executors and is
  // Nick's decision; the gateway does not offer it.
  post_actions_by_id_approve: 'Approving a queued action is Nick\'s decision. He approves it in NEURO → Actions. An agent must never approve on his behalf.',
  post_actions_batch: 'Batch approval is Nick\'s decision. He approves in NEURO → Actions.',
  // Build 8: these make Graph email calendar invites (or updates) to real
  // people as Nick. The backend refuses the API token; this stops the gateway
  // offering them. Proposing (post_1to1_propose, post_1to1_plan_all) stays
  // available — it reads the diary and books nothing.
  // Build 13L: escalating raises a real Jira ticket's priority and posts an
  // internal comment through NOVA. The backend refuses the API token; this
  // stops the gateway offering it. Resolving an unknown outcome is Nick saying
  // what is on the ticket, which an agent cannot know.
  post_escalation: 'Escalating a Jira ticket is Nick\'s decision. He escalates it in NEURO → Escalation, where the ticket is shown first.',
  post_escalation_ledger_resolve: 'Only Nick can say what is on the ticket after an unknown escalation outcome.',
  // Build 15S: a hike confirmed, planned or taken back is Nick's statement
  // about his own goal. An agent must not be able to write one into his record.
  post_loops_hiking_confirm: 'Confirming a hike is Nick\'s own statement. He confirms it in NEURO → Life.',
  post_loops_hiking_plan: 'Planning a hike is Nick\'s own statement. He plans it in NEURO → Life or his calendar.',
  post_loops_hiking_entries_by_id_withdraw: 'Taking back a hike confirmation or plan is Nick\'s statement. He does it in NEURO → Life.',
  post_loops_personal_dates_lead: 'How far ahead a personal date shows is Nick\'s own setting. He sets it in NEURO → Life.',
  post_loops_personal_dates_declared: 'A birthday or anniversary written into a People or Companions note is Nick\'s own statement. He sets it in NEURO → Life.',
  post_loops_hiking_deny:'Saying a day was not a hike is Nick\'s own statement. He does it in NEURO → Life.',
  post_loops_hiking_denials_by_id_withdraw: 'Taking back a "not a hike" is Nick\'s statement. He does it in NEURO → Life.',
  // Build 29: route plans and activity links (a route, Ember) are Nick's own.
  post_outdoor_routes: 'A route plan is Nick\'s own. He adds it in NEURO → Life → Outdoor.',
  post_outdoor_routes_by_routeId: 'Changing or cancelling a route plan is Nick\'s statement. He does it in NEURO → Life → Outdoor.',
  post_outdoor_activities_by_activityId_route: 'Which planned route a walk or hike followed is Nick\'s explicit link. He makes it in NEURO → Life → Outdoor.',
  post_outdoor_activities_by_activityId_route_remove: 'Unlinking a route is Nick\'s choice. He does it in NEURO → Life → Outdoor.',
  post_outdoor_activities_by_activityId_companion: 'Whether Ember came along is Nick\'s statement, never inferred. He marks it in NEURO → Life → Outdoor.',
  post_outdoor_activities_by_activityId_companion_remove: 'Removing Ember from an activity is Nick\'s statement. He does it in NEURO → Life → Outdoor.',
  // Hike safety: arming approves an unattended alert email; checking in silences it. Both Nick's, never an agent's.
  post_outdoor_safety_contacts: 'Who gets a hike safety alert is Nick\'s choice. He sets it in NEURO → Life → Outdoor → Hike safety.',
  post_outdoor_safety_trips: 'Arming a walk approves an alert email to the people on its card. Nick arms it in NEURO → Life → Outdoor.',
  post_outdoor_safety_trips_by_tripId_checkin: 'Checking in from a walk stops the safety alert — only Nick can say he is back. He checks in in NEURO.',
  post_outdoor_safety_trips_by_tripId_edit: 'Editing an armed walk changes the route card and alert the people on it would be sent. Nick does it in NEURO.',
  post_outdoor_safety_trips_by_tripId_extend: 'Extending a walk moves when the alert goes. Nick does it in NEURO.',
  post_outdoor_safety_trips_by_tripId_cancel: 'Cancelling an armed walk stops its alert. Nick does it in NEURO.',
  // Build 30: leisure items and corrections (liked, finished, not mine) are Nick's own.
  post_leisure_items: 'What Nick is watching, reading, playing or into is his own statement. He adds it in NEURO → Life → Leisure.',
  post_leisure_items_by_itemId: 'Editing a leisure item is Nick\'s statement. He does it in NEURO → Life → Leisure.',
  post_leisure_correct: 'Liked, disliked, finished, dropped, not mine — every leisure correction is Nick\'s own word. He makes it in NEURO → Life → Leisure.',
  // Build 31: who someone is to Nick is his statement, never an agent's guess.
  post_people: 'Creating a People note is Nick\'s statement about who exists in his life. He does it in NEURO → Life → People.',
  post_people_duplicates_decide: 'Whether two records are one person is Nick\'s call. He merges or keeps them separate in NEURO → Life → People.',
  post_people_links_reject: '"Not this person" is Nick\'s correction. He makes it in NEURO → Life → People.',
  post_people_by_personId_classify: 'A relationship, sphere or household membership is Nick\'s own word — never inferred, never set by an agent. He sets it in NEURO → Life → People.',
  // Build 19P: goals, what a goal is about, what prepares for what, and what a
  // calendar or list is for are Nick's own statements. An agent may read the
  // Future Radar and obligations; it must never make these links itself.
  post_canonical_goals: 'A goal is Nick\'s own statement. He writes it in NEURO → Life.',
  post_canonical_goals_by_id: 'Changing a goal (including its links) is Nick\'s statement. He does it in NEURO → Life.',
  post_canonical_goals_by_id_links: 'Linking something to a goal is Nick\'s explicit choice, never inferred. He links it in NEURO → Life → Future Radar.',
  post_canonical_goals_by_id_links_remove: 'Unlinking from a goal is Nick\'s choice. He does it in NEURO → Life.',
  post_canonical_prep_links: 'Marking a task as preparation for a date is Nick\'s explicit choice. He does it in NEURO → Life → Future Radar.',
  post_canonical_prep_links_remove: 'Removing a preparation link is Nick\'s choice. He does it in NEURO → Life.',
  post_canonical_classifications: 'What a calendar or reminder list is for, and whether NEURO reads it, are Nick\'s statements, never inferred from its name. He sets them in NEURO → Life.',
  // Build 20: Ember's care, her walks, what is linked to her, and which vehicle
  // an admin item concerns are Nick's own statements. An agent may read them.
  post_canonical_companions_by_id_care: 'A care item for Ember is Nick\'s own statement — nothing is scheduled for her by itself. He adds it in NEURO → Life → Companions.',
  post_canonical_care_by_id_done: 'Marking Ember\'s care done is Nick\'s statement. He does it in NEURO → Life → Companions.',
  post_canonical_care_by_id_cancel: 'Cancelling Ember\'s care item is Nick\'s statement. He does it in NEURO → Life → Companions.',
  post_canonical_companions_by_id_links: 'Linking something to Ember\'s care is Nick\'s explicit choice, never inferred from a mention. He links it in NEURO → Life → Companions.',
  post_canonical_companions_by_id_links_remove: 'Unlinking from Ember\'s care is Nick\'s choice. He does it in NEURO → Life → Companions.',
  post_canonical_companions_by_id_walks: 'Whether Ember was walked is Nick\'s own word — never inferred from his own walking. He says so in NEURO → Life → Companions.',
  post_canonical_companions_by_id_walks_remove: 'Taking back a walk mark is Nick\'s statement. He does it in NEURO → Life → Companions.',
  post_canonical_vehicle_links: 'Which vehicle an admin item concerns is Nick\'s explicit choice. He links it in NEURO → Life → Personal admin.',
  post_canonical_vehicle_links_remove: 'Removing a vehicle link is Nick\'s choice. He does it in NEURO → Life → Personal admin.',
  post_canonical_personal_admin_annotations: 'Whether a personal-admin item is waiting, blocked or routine, its kind, and its lead time are Nick\'s own word. He sets them in NEURO → Life → Personal admin.',
  // Build 21: the vehicle record, its dates, mileage, history, official
  // readings and every finance classification or rule are Nick's statements.
  // An agent may read them; it must never confirm a mapping or invent a fact.
  post_vehicle: 'A vehicle is Nick\'s own record. He adds it in NEURO → Life → Vehicle.',
  post_vehicle_by_id: 'What Nick knows about his vehicle (registration, engine) is his statement. He fills it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_mileage: 'An odometer reading is Nick\'s own — NEURO never invents mileage. He records it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_mileage_by_readingId_withdraw: 'Taking back an odometer reading is Nick\'s choice. He does it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_events: 'Service, repair and tyre history is Nick\'s own record — never created from a payment. He adds it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_events_by_eventId_withdraw: 'Taking back a history entry is Nick\'s choice. He does it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_obligations: 'An MOT, tax, insurance or service date is Nick\'s own record. He adds it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_official_check: 'Asking DVLA about the car is done by Nick. He does it in NEURO → Life → Vehicle.',
  post_vehicle_by_id_official_by_hand: 'What gov.uk showed is Nick\'s reading. He records it in NEURO → Life → Vehicle.',
  post_vehicle_obligations_by_obligationId: 'Changing a vehicle date is Nick\'s statement. He does it in NEURO → Life → Vehicle.',
  post_vehicle_obligations_by_obligationId_resolve: 'Saying an MOT, renewal or service is done needs Nick\'s evidence. He does it in NEURO → Life → Vehicle.',
  post_vehicle_finance_sync: 'Retired in Build 27 — NEURO no longer reads Tally\'s database. Vehicle spend is Tally\'s (Outlook → Motoring).',
  post_vehicle_finance_transactions_by_txnId_decide: 'Retired in Build 27 — whether a transaction is the car\'s is Nick\'s decision, made in Tally → Outlook → Motoring.',
  // Build 27: a fuel fill (litres, odometer) is Nick's own record.
  post_vehicle_by_id_fuel: 'A fuel fill is Nick\'s own record — NEURO never invents litres or mileage. He records it in NEURO → Life → Transport.',
  post_vehicle_by_id_fuel_by_fillId_withdraw: 'Taking back a fuel fill is Nick\'s choice. He does it in NEURO → Life → Transport.',
  // Build 23: how NEURO reads the household finances is Nick's statement. An
  // agent reads the finance view and never classifies, confirms or resolves.
  post_finance_sync: 'Reading Tally is NEURO\'s own scheduled job or Nick\'s press. It runs from NEURO → Life → Finance.',
  post_finance_transactions_by_txnId_decide: 'Which domain a household transaction belongs to is Nick\'s decision — an agent never classifies household spending. He decides in NEURO → Life → Finance.',
  post_finance_rules_by_ruleId_retire: 'Retiring a finance rule is Nick\'s choice. He does it in NEURO → Life → Finance.',
  post_finance_recurring_by_seriesKey_decide: 'Whether a payment is recurring is Nick\'s statement. He says so in NEURO → Life → Finance.',
  post_finance_review_by_itemKey_decide: 'Answering an unusual-spend or duplicate item is Nick\'s call. He does it in NEURO → Life → Finance.',
  post_finance_obligations: 'A renewal, bill or annual fee is Nick\'s own record. He adds it in NEURO → Life → Finance.',
  post_finance_obligations_by_id: 'Changing a finance date or linking its task is Nick\'s statement. He does it in NEURO → Life → Finance.',
  post_finance_obligations_by_id_resolve: 'Saying a bill or renewal is done needs Nick\'s evidence. He does it in NEURO → Life → Finance.',
  post_vehicle_finance_rules_by_ruleId_retire:'Retiring a vehicle-spend rule is Nick\'s choice. He does it in NEURO → Life → Vehicle.',
  // Build 24: whose a project is, its status, links and blockers are Nick's
  // statements; an agent reads projects and never classifies or links them.
  // The GitHub snapshot comes from the reporter on Nick's machine, not an agent.
  post_projects_github_snapshot: 'GitHub metadata reaches NEURO only from the reporter that holds Nick\'s own credential (backend/scripts/github-snapshot.js). An agent never supplies repo evidence.',
  post_projects_declare: 'Making a repo into a project is Nick\'s statement. He does it in NEURO → Life → Projects.',
  post_projects_repos_by_repoId_classify: 'Whose a repo is (personal or work) is Nick\'s statement — never inferred from its name or owner. He says so in NEURO → Life → Projects.',
  post_projects_owners_by_owner_classify: 'Whose a GitHub org\'s repos are is Nick\'s statement. He says so in NEURO → Life → Projects.',
  post_projects_by_projectId_classify: 'Whose a project is (personal or work) is Nick\'s statement. He says so in NEURO → Life → Projects.',
  post_projects_by_projectId_status: 'A project\'s status (parked, paused, completed…) is Nick\'s statement — quiet is never a status. He sets it in NEURO → Life → Projects.',
  post_projects_by_projectId_repos: 'Which repo belongs to a project is Nick\'s confirmation. He does it in NEURO → Life → Projects.',
  post_projects_by_projectId_tasks: 'Linking a task to a project is Nick\'s statement. He does it in NEURO → Life → Projects.',
  post_projects_by_projectId_next: 'A project\'s next action is Nick\'s choice. He pins it in NEURO → Life → Projects.',
  post_projects_by_projectId_blockers: 'What blocks a project is Nick\'s statement. He records it in NEURO → Life → Projects.',
  post_projects_by_projectId_blockers_by_blockerId_resolve: 'Saying a blocker is gone is Nick\'s statement. He does it in NEURO → Life → Projects.',
  post_canonical_lead_reminders:'When NEURO may remind Nick about a birthday or anniversary is his own setting. He sets it in NEURO → Life → Personal dates.',
  post_1to1_book:'Booking a 1-2-1 emails a real invite as Nick. He confirms it in NEURO → Team.',
  post_1to1_book_all: 'Booking 1-2-1s emails real invites as Nick. He confirms them in NEURO → Team.',
  post_1to1_reschedule: 'Moving a 1-2-1 emails the attendee an update as Nick. He confirms it in NEURO → Team.',
  post_1to1_cancel: 'Cancelling a 1-2-1 tells the attendee as Nick. He cancels it in NEURO → Team.',
  // Build 14C: everything backend/services/authority-matrix.js refuses to a
  // machine caller. The backend refuses these BEFORE any router runs; this stops
  // the gateway offering them. authority-matrix.test.js fails if the two lists
  // drift — a route the matrix refuses must be here.
  ...Object.fromEntries([
    'post_todos_wip_ms', 'patch_todos_ms_by_msId',
  ].map(id => [id, 'Changing progress or wording on a Microsoft task is visible to Nick\'s team on a shared board. He does it in NEURO → Tasks. (Completing one with the exact id is post_todos_complete_ms.)'])),
  delete_medical_records_by_id: 'Deleting a medical record is Nick\'s decision. He removes it in NEURO → Medical. (Saving records is open: post_medical_records.)',
  post_rooms_by_key_accept: 'Turning lights or heating on in the house is Nick accepting an offer in the room, in SAiM. An agent cannot do it.',
  post_catalogues_by_slug_shared: 'Sharing a catalogue publishes it on VESTA, read by the household on the public internet. Nick shares it in NEURO → Catalogues.',
  post_1to1_nova_sync: 'Reconciling 1-2-1 sessions writes to NOVA. It runs on its own timer; Nick can run it in NEURO.',
  post_1to1_nova_transcripts: 'Offering transcripts writes candidates into NOVA. It runs on its own timer.',
  post_notion_sync_run: 'Publishing to Notion puts vault notes in front of an external AI. Nick runs it in NEURO → Notion Sync.',
  post_notion_sync_auto: 'Turning the Notion publish timer on or off is Nick\'s decision, in NEURO → Notion Sync.',
  post_calendar_events_by_id_respond: 'Retired since Build 8: responding to an invite as Nick is not done from NEURO.',
  post_canonical_needs_you_synthetic: 'A synthetic P0 interrupts Nick\'s phone. He starts it himself in NEURO → Set up.',
  ...Object.fromEntries([
    'post_ai_settings', 'post_feature_flags_by_key', 'post_capture_links', 'delete_capture_links_by_username',
    'post_capture_links_by_username_pin', 'post_capture_links_by_username_scopes', 'post_microsoft_auth',
    'post_notion_sync_token', 'delete_notion_sync_token', 'put_notion_sync_mappings', 'post_notion_sync_unlock',
    'post_prepared_actions_approval_code', 'post_prepared_actions_trust_device', 'post_prepared_actions_devices_by_deviceId_revoke',
    'post_push_subscribe', 'post_push_unsubscribe', 'post_push_apns_register', 'delete_push_apns_register', 'delete_push_subscriptions',
    'post_rescuetime_key', 'delete_rescuetime_key', 'post_weather_wu_key', 'delete_weather_wu_key',
  ].map(id => [id, 'Credentials, switches, accounts, trusted devices and push endpoints are Nick\'s to change, in NEURO → Settings. An agent cannot.'])),
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
  post_medical_records: 'Prefer the typed medical_records_save tool: same route, but it reads every record back and only reports saved when the stored values match. GP comments ("No further action") go in followUp, not status.',
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
