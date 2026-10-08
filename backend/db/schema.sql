CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_conv_id
  ON conversations(conversation_id, created_at DESC);

-- ⚠ DEAD as of 27 Aug 2026. The Jira queue feature was removed on 3 July 2026
-- (48e6481, "too much noise") and the readers that had been reintroduced against
-- the rows it left behind were removed on 27 Aug — see the note in
-- db/database.js. Nothing reads or writes this table.
--
-- @inert - nothing may read or write this table. Enforced by db/inert-tables.test.js.
-- Left defined and empty deliberately, following `inbox_items`: dropping it is a
-- destructive migration that buys nothing, and the twelve rows still in it are
-- the only surviving evidence of what the queue looked like on 3 July.
-- Escalations never used this table and are unaffected.
CREATE TABLE IF NOT EXISTS jira_tickets_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL UNIQUE,
  summary TEXT,
  status TEXT,
  priority TEXT,
  assignee TEXT,
  sla_remaining_minutes REAL,
  sla_name TEXT,
  at_risk INTEGER DEFAULT 0,
  raw_json TEXT,
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jira_at_risk
  ON jira_tickets_cache(at_risk);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  decision_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nudges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  nag_count INTEGER DEFAULT 0,
  date_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'normal',
  due_date TEXT,
  source TEXT,
  ms_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS calendar_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  subject TEXT,
  start_time TEXT,
  end_time TEXT,
  is_all_day INTEGER DEFAULT 0,
  location TEXT,
  organizer TEXT,
  show_as TEXT,
  -- 1 = has attendees other than Nick, 0 = solo block, NULL = we could not tell.
  -- NULL is a real answer and must never be read as 0: the NOVA bridge supplies
  -- no attendee list, and with no signed-in address Nick's own entry cannot be
  -- told from anyone else's. See calendar-sync + plaud-admin-blocks.attendeesOther.
  attendees_other INTEGER,
  -- Build 16I: Graph's isOrganizer. 1 / 0 / NULL (could not tell). See
  -- context-state.heldDespiteFree — a `free` entry Nick organises with other
  -- people in it is still a meeting.
  is_organizer INTEGER,
  -- Which calendar this row came from: 'graph' (work, via MSAL or the NOVA
  -- bridge), 'apple' (pushed from the phone by Scriptable), 'ics'.
  --
  -- ⚠ Load-bearing for DELETES, not just for display. calendar-sync is
  -- replace-by-window and runs every few minutes; before this column it emptied
  -- the WHOLE table, so a second calendar's events would be silently wiped
  -- within minutes of arriving. clearCalendarCache now requires a source.
  source TEXT NOT NULL DEFAULT 'graph',
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- ⚠ The index on `source` is NOT here. This whole file is executed by an
-- unguarded db.exec() BEFORE any migration runs, and `CREATE TABLE IF NOT
-- EXISTS` is a no-op against the live table — so on an existing database the
-- column does not exist yet at this point, and an index naming it throws and
-- takes db.init() down with it. The backend then does not start at all.
-- It is created in the migration block instead, after the ALTER. See database.js.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- APNs device tokens, for the native apps.
--
-- Web Push cannot reach a native iOS app, so SAiM has no way to COME TO NICK —
-- which is her entire premise. This is the registry half; the sender needs an
-- APNs key, which needs a paid Apple Developer account.
--
-- ⚠ REGISTERED BUT NOT YET SENT TO. That is deliberate rather than half-built:
-- the app can register from day one, so the moment the account exists the only
-- missing piece is the signing key. Nothing here pretends a token is reachable.
--
-- ⚠ A DEVICE TOKEN IS NOT STABLE. iOS reissues it on reinstall, restore, and
-- occasionally on update, so the same phone appears as a new row and the old
-- token starts failing. The token is therefore the identity (UNIQUE), and
-- `device_id` groups a phone's successive tokens so a stale one can be retired
-- without guessing. APNs reports dead tokens on send; `last_failed_at` is where
-- that gets recorded rather than being discovered again every hour.
--
-- ⚠ `environment` matters. A token minted against the sandbox APNs gateway is
-- INVALID against production and vice versa, and the failure is a generic
-- BadDeviceToken that reads like a bad token rather than a wrong gateway. A
-- development build and a TestFlight build of the same app produce different
-- ones, so it is stored rather than assumed.
CREATE TABLE IF NOT EXISTS apns_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  device_id TEXT,
  app TEXT NOT NULL DEFAULT 'neuro',
  environment TEXT NOT NULL DEFAULT 'development',
  bundle_id TEXT,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_failed_at DATETIME,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_apns_tokens_device ON apns_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_apns_tokens_app ON apns_tokens(app);

-- Every notification NEURO decided to send, and what became of it.
--
-- Until this existed the only record was console.log, so "why didn't I get the
-- 5pm nudge?" was unanswerable once the pm2 log rolled — and two paths in
-- sendToAll returned SILENTLY (no subscriptions, VAPID not configured), which
-- is indistinguishable from a quiet day. Same species as the frozen Jira cache:
-- a system that has stopped delivering looks exactly like one with nothing to say.
--
-- `outcome` is one of: sent | suppressed | failed | undeliverable.
-- `reason` carries the governor's verdict or the transport error.
CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  type TEXT,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nudges_active ON nudges(active, date_key);
CREATE INDEX IF NOT EXISTS idx_todos_done ON todos(done);
CREATE INDEX IF NOT EXISTS idx_todos_ms_id ON todos(ms_id);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_cache(start_time);

CREATE TABLE IF NOT EXISTS import_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL UNIQUE,
  type TEXT,
  destination TEXT,
  confidence TEXT,
  reason TEXT,
  backend TEXT,
  classified_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_import_cls_path ON import_classifications(relative_path);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  event_data TEXT,
  hour INTEGER,
  day_of_week INTEGER,
  date_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_log(date_key, event_type);

-- @inert - nothing may read or write this table. Enforced by db/inert-tables.test.js.
-- RETIRED 26 Aug 2026. Written by nothing since `inbox-scanner.js` was removed:
-- it was a second inbox triage nothing reconciled with the one the panel shows,
-- and with no dismiss path reaching it, it only grew. Inbox state now lives in
-- `agent_state.email_triage`. Kept (empty) rather than dropped — the definition
-- is harmless and the history is not worth a destructive migration.
CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL UNIQUE,
  subject TEXT,
  from_name TEXT,
  from_email TEXT,
  urgency TEXT,
  category TEXT,
  summary TEXT,
  reason TEXT,
  received TEXT,
  is_read INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  dismissed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbox_dismissed ON inbox_items(dismissed);
CREATE INDEX IF NOT EXISTS idx_inbox_email_id ON inbox_items(email_id);

-- One row per cloud AI call (26 Aug 2026). Before this the only record was a
-- single "tokens today" counter that reset at midnight, so "what did last week
-- cost" and "which task is spending it" were unanswerable. Rows, not daily
-- rollups: a few hundred a day is nothing, and the rollups are queries.
-- cost_usd is NULL when the model is unpriced or the tokens were never
-- reported -- never 0, which would read as free.
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  task_type TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  cost_source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_date ON ai_calls(date_key);
CREATE INDEX IF NOT EXISTS idx_ai_calls_task ON ai_calls(date_key, task_type);

CREATE TABLE IF NOT EXISTS vault_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relative_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  chunk_text TEXT,
  file_modified TEXT,
  embedded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(relative_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_path ON vault_embeddings(relative_path);
CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON vault_embeddings(content_hash);

-- Entity extraction — people, tasks, decisions extracted from notes
CREATE TABLE IF NOT EXISTS extracted_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_value TEXT NOT NULL,
  context TEXT,
  extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_path ON extracted_entities(source_path);
CREATE INDEX IF NOT EXISTS idx_entities_type ON extracted_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_value ON extracted_entities(entity_value);

-- Backlinks — tracks which notes mention which entities/notes
CREATE TABLE IF NOT EXISTS note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  target_path TEXT,
  target_entity TEXT,
  link_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_links_source ON note_links(source_path);
CREATE INDEX IF NOT EXISTS idx_links_target ON note_links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_entity ON note_links(target_entity);

-- Do Next — high-signal tasks identified in standups, chat sessions, or manually
CREATE TABLE IF NOT EXISTS do_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_do_next_done ON do_next(done, due_date);

-- NOVA flagged tickets ("Nick, look at this") — mirror of NOVA's risk scorer,
-- pushed in via POST /api/nova-signals. NOVA is source of truth; each push
-- replaces the whole active set, so resolved/reviewed tickets drop off.
CREATE TABLE IF NOT EXISTS nova_flags (
  ticket_key TEXT PRIMARY KEY,
  risk_score INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  why TEXT,
  summary TEXT,
  assignee TEXT,
  ticket_status TEXT,
  reasons TEXT,
  flagged_at DATETIME,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_summary (
  date_key TEXT PRIMARY KEY,
  standup_done INTEGER DEFAULT 0,
  standup_hour INTEGER,
  standup_snooze_count INTEGER DEFAULT 0,
  todo_snooze_count INTEGER DEFAULT 0,
  eod_done INTEGER DEFAULT 0,
  captures_count INTEGER DEFAULT 0,
  chat_count INTEGER DEFAULT 0,
  chat_topics TEXT,
  tabs_opened TEXT,
  summary_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- SAiM Action Suggestions (Phase 5A)
CREATE TABLE IF NOT EXISTS saim_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  focus_item_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  -- "Not now." The status stays pending while asleep, because the dedupe and
  -- fold passes read the pending pool to decide whether to create another.
  snoozed_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_saim_actions_status ON saim_actions(status);
-- #107(b) — the scoped dedupe reads filter on type and on the payload's
-- sourcePath, and both were falling back to a full scan of 16k rows.
CREATE INDEX IF NOT EXISTS idx_saim_actions_type ON saim_actions(type);
CREATE INDEX IF NOT EXISTS idx_saim_actions_source_path
  ON saim_actions(json_extract(payload, '$.sourcePath'));

-- Location visit history (Phase 5)
CREATE TABLE IF NOT EXISTS location_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_key TEXT NOT NULL,
  place_name TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  arrival TEXT NOT NULL,
  departure TEXT,
  duration_minutes INTEGER DEFAULT 0,
  source TEXT DEFAULT 'owntracks',
  place_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_location_visits_date ON location_visits(date_key);
CREATE INDEX IF NOT EXISTS idx_location_visits_place ON location_visits(place_name);

-- Raw position points pushed BY a device, rather than polled FROM a recorder.
--
-- The OwnTracks path reads points out of the Recorder's HTTP API, so NEURO never
-- owned a point. A native iOS app has nowhere to put one, which is why this
-- table exists: it is the store `location.getTodayPoints()` range-queries when
-- the phone is the source. Shape deliberately MATCHES the OwnTracks point
-- (`lat`, `lon`, `tst`) so the clustering in `services/location.js` needs no
-- second code path — see the mapping in `services/location-points.js`.
--
-- ⚠ `tst` is unix SECONDS, not milliseconds, because that is what OwnTracks
-- emits and what `clusterPoints()` subtracts to get a duration. A device sending
-- milliseconds makes every dwell ~1000x too long, which passes the 20-minute
-- floor trivially and turns a drive-past into a working day.
--
-- UNIQUE(device_id, tst) is what makes the ingest idempotent: the phone keeps an
-- offline queue and WILL re-send a batch it never saw acknowledged, so a replay
-- has to fold rather than double-count.
CREATE TABLE IF NOT EXISTS location_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tst INTEGER NOT NULL,
  accuracy REAL,
  source TEXT NOT NULL DEFAULT 'ios',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, tst)
);

-- Range queries by time are the only read pattern (`getTodayPoints`), and the
-- staleness check reads the newest row regardless of device.
CREATE INDEX IF NOT EXISTS idx_location_points_tst ON location_points(tst);
CREATE INDEX IF NOT EXISTS idx_location_points_device ON location_points(device_id, tst);

-- CLVisit records from the phone, kept AS visits (5 Oct 2026).
--
-- ⚠ NOT `location_visits`, which is the DERIVED dwell history (place names,
-- durations) written by location-history. This table is the phone's own
-- arrival/departure record, before NEURO has interpreted it.
--
-- iOS delivers a visit TWICE: once on arrival (departure unknown — Apple's
-- `distantFuture`, sent here as null) and again on departure with the same
-- arrival. `visit_key` is `a:<arrival>` so the second delivery UPDATES the
-- first rather than adding a row. A visit whose arrival iOS missed
-- (`distantPast`) is keyed `d:<departure>` instead.
CREATE TABLE IF NOT EXISTS device_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  visit_key TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy REAL,
  arrival_tst INTEGER,
  departure_tst INTEGER,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, visit_key)
);
CREATE INDEX IF NOT EXISTS idx_device_visits_arrival ON device_visits(arrival_tst);
CREATE INDEX IF NOT EXISTS idx_device_visits_departure ON device_visits(departure_tst);

-- Geofence crossings for Nick's saved places (5 Oct 2026). `kind` is enter /
-- exit (a crossing) or inside / outside (the phone asking "where am I relative
-- to this place" on registration and on each wake — iOS raises no enter event
-- for a region you are already in). The place is stored by NAME because that
-- is what `saved_places` is keyed on.
CREATE TABLE IF NOT EXISTS place_region_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  place TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enter', 'exit', 'inside', 'outside')),
  tst INTEGER NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(device_id, place, kind, tst)
);
CREATE INDEX IF NOT EXISTS idx_place_region_events_place ON place_region_events(place, tst);

-- Everything Apple Health sends that is a DOCUMENT rather than a number.
--
-- ECG traces, audiograms, activity summaries, medications, vision
-- prescriptions, state-of-mind entries, and every non-sleep category sample
-- (mindful sessions, handwashing, and the whole symptom vocabulary). All of it
-- used to be counted and thrown away, because `health_samples(metric, value,
-- recorded_at)` is a numeric time series and none of these are one.
--
-- ⚠ ONE GENERIC TABLE, NOT SIX MODELLED ONES, and that is a deliberate choice
-- rather than laziness. The workouts parser had to be written blind because no
-- captured HAE payload for that section exists anywhere in this repo — and the
-- same is true of all six of these. Inventing six schemas against guessed field
-- names would bake those guesses into columns, where being wrong is expensive
-- and silent. Storing the document losslessly means a wrong guess costs a query
-- rather than a migration, and NOTHING is lost in the meantime. Promote a
-- section to its own table once a real payload has been read.
--
-- `document` is the whole record verbatim. The columns beside it are an INDEX
-- into it, not a replacement for it.
--
-- ⚠ `dedupe_key` is the source uuid when there is one and a content hash when
-- there is not. HAE does not give every section an id, and without a stable key
-- a re-sent backfill silently doubles the table — the failure `location_points`
-- avoids with UNIQUE(device_id, tst) and `health_workouts` with UNIQUE(uuid).
-- A content hash is the only key available for a record that carries no id, and
-- it is exactly right for this: the same document IS the same observation.
CREATE TABLE IF NOT EXISTS health_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  record_type TEXT,
  label TEXT,
  started_at TEXT,
  ended_at TEXT,
  numeric_value REAL,
  document TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'apple-health',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_health_records_kind ON health_records(kind, started_at);
CREATE INDEX IF NOT EXISTS idx_health_records_type ON health_records(record_type, started_at);

-- Workouts, which are RECORDS rather than scalars.
--
-- `health_samples(metric, value, recorded_at)` is a numeric time series, and a
-- workout is not one: it has a type, a span, and half a dozen measurements that
-- only mean anything together. Flattening a run into six unrelated rows loses
-- the fact that they were the same run, which is the only thing that makes it a
-- workout rather than a coincidence.
--
-- This is what retires Strava. Every field Strava's `formatActivity()` reads —
-- type, distance, duration, elevation, average heart rate — comes off a
-- HealthKit workout too, and has been arriving in the FreeReps payload all
-- along, counted and thrown away as an `UNSTORED_SECTION`.
--
-- ⚠ UNITS ARE FIXED HERE, not carried. Distance is METRES, energy is KCAL,
-- duration is SECONDS, elevation is METRES. The wire format uses whatever the
-- phone felt like (km, miles, kJ), and storing the number without the unit is
-- how a 5km run becomes a 5-metre one. Conversion happens on the way in and an
-- unrecognised unit is REFUSED rather than stored at unknown scale — the rule
-- `UNIT_RULES` already applies to hrv and heart rate.
--
-- UNIQUE(source_uuid) folds a re-sent batch. HealthKit gives every workout a
-- stable UUID, so a backfill that overlaps a daily sync is idempotent.
CREATE TABLE IF NOT EXISTS health_workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_uuid TEXT UNIQUE,
  activity_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  distance_m REAL,
  active_energy_kcal REAL,
  elevation_m REAL,
  avg_heart_rate REAL,
  max_heart_rate REAL,
  source TEXT NOT NULL DEFAULT 'apple-health',
  -- Anything the phone sent that NEURO does not model, kept rather than
  -- dropped: this parser was written without a real HAE workout payload to
  -- read, so the first live one has to be able to tell us what we missed.
  payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_health_workouts_started ON health_workouts(started_at);

-- Environmental readings from a carried logger (Blue Maestro Disc Maxi) —
-- temperature, humidity and pressure, matched to hikes by TIME at read time.
--
-- ⚠ `t` IS RECONSTRUCTED, NOT MEASURED. The logger keeps no clock: the phone
-- times each record backwards from the moment it downloaded, so every reading
-- is right to within `timing_error_s` (half the logging interval) and no
-- better. That bound is stored per row because the interval can change.
--
-- ⚠ KEYED ON THE LOGGER, NOT THE PHONE. `sensor_id` is the device MAC suffix,
-- so two phones syncing one logger fold instead of doubling. UNIQUE(sensor_id,
-- t) makes a re-sent queue idempotent; the phone downloads only records it has
-- not timed before, so the same reading never arrives under two times.
--
-- ⚠ NO HIKE ID. Matching is a window join against `health_workouts` (or any
-- other source of a walk's start and end — the website's Intervals.icu
-- activities), so a reading is never tied to one system's notion of a hike.
CREATE TABLE IF NOT EXISTS environment_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_id TEXT NOT NULL,
  model TEXT,
  t INTEGER NOT NULL,
  temperature_c REAL NOT NULL,
  humidity_pct REAL,
  pressure_hpa REAL,
  timing_error_s INTEGER NOT NULL DEFAULT 0,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sensor_id, t)
);

CREATE INDEX IF NOT EXISTS idx_environment_readings_t ON environment_readings(t);

-- How far through each logger's history NEURO has got. ⚠ THE CURSOR LIVES HERE,
-- NOT ON A DOWNLOADER: the Pi syncs the logger when it is home and the phone can
-- sync it on the road, and two private cursors would each download — and time —
-- the same records. `log_count` is the logger's record count at the download that
-- moved it; `synced_at` is unix seconds.
CREATE TABLE IF NOT EXISTS environment_sensors (
  sensor_id TEXT PRIMARY KEY,
  model TEXT,
  interval_s INTEGER,
  log_count INTEGER,
  synced_at INTEGER,
  last_t INTEGER,
  source TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Air pressure from a PHONE's barometer (5 Oct 2026). Its own table because a
-- phone has no thermometer, and environment_readings requires a temperature.
-- `place` is where NEURO believed Nick was when it arrived (home|work|out|…),
-- null when unknown — never guessed afterwards.
CREATE TABLE IF NOT EXISTS environment_pressure (
  source TEXT NOT NULL,
  t INTEGER NOT NULL,
  pressure_hpa REAL NOT NULL,
  place TEXT,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, t)
);
CREATE INDEX IF NOT EXISTS idx_environment_pressure_t ON environment_pressure(t);

-- The outdoor weather station (6 Oct 2026): ESP32-C3/BME280 → ESP-NOW → the
-- receiver on pi5's USB → `saim-weather-ingest`, which forwards each accepted
-- `saim.weather.v1` record here. One row per minute, kept INDEFINITELY.
--
-- ⚠ THE KEY IS (node_id, sequence, observed_at), NOT (node_id, sequence). The
-- transmitter restarts its sequence at 1 on every reboot — on the first evening
-- it rebooted every 10-30 s during bring-up — so the raw pair repeats within
-- seconds. What does NOT repeat is the receipt time the Pi stamps once and a
-- retry resends verbatim, so a forwarder retry is an exact duplicate and two
-- genuine readings never are. `boot` is ADVISORY: NEURO's best guess at which
-- run of the node a reading came from, never part of identity.
-- `observed_at` is the Pi's receipt time in epoch MILLISECONDS (UTC); the node
-- has no clock, so receipt IS the observation time, to within the radio hop.
CREATE TABLE IF NOT EXISTS weather_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  boot INTEGER NOT NULL DEFAULT 1,
  sequence INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  temperature_c REAL NOT NULL,
  humidity_pct REAL NOT NULL,
  pressure_hpa REAL NOT NULL,
  battery_mv INTEGER,
  rssi INTEGER,
  schema_version TEXT NOT NULL,
  source TEXT,
  ingested_at INTEGER NOT NULL,
  UNIQUE(node_id, sequence, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_weather_obs_node_t ON weather_observations(node_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_weather_obs_node_seq ON weather_observations(node_id, sequence);

-- Where each node's sequence has got to, so a reboot can be told from a retry.
CREATE TABLE IF NOT EXISTS weather_nodes (
  node_id TEXT PRIMARY KEY,
  boot INTEGER NOT NULL DEFAULT 1,
  last_sequence INTEGER,
  last_observed_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Forecast SNAPSHOTS. Each fetch is stored as issued, never overwritten, so a
-- past hour can be compared against the forecast that was STANDING at the time
-- rather than against whatever the provider says about it now (which, for a
-- past hour, is an analysis, not a forecast). Times in epoch ms (UTC).
CREATE TABLE IF NOT EXISTS weather_forecast_points (
  provider TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  valid_at INTEGER NOT NULL,
  temperature_c REAL,
  humidity_pct REAL,
  pressure_hpa REAL,
  precip_mm REAL,
  precip_prob REAL,
  PRIMARY KEY (provider, issued_at, valid_at)
);
CREATE INDEX IF NOT EXISTS idx_weather_fc_valid ON weather_forecast_points(valid_at);

-- EXTERNAL weather sources (7 Oct 2026) — services/weather-external.js.
-- Everything NEURO reads about local weather that it did not measure itself:
-- the Environment Agency's Mount St Bernards rain gauge (live + qualified) and
-- Weather Underground PWS stations. NEURO is the store; these are inputs.
-- SI units throughout, epoch ms UTC, every measure nullable (sources differ).
--   feed      which API answered — the same instant from two feeds is TWO rows
--             (live telemetry vs the qualified record), and a read chooses.
--   period_s  the accumulation period of rain_mm (900 = 15 min, 86400 = a
--             water day); 0 = an instantaneous observation. NOT NULL, because
--             SQLite treats NULLs as distinct and the UNIQUE would not hold.
--   raw_payload  the source's own item, verbatim minus fields constant per
--             feed. provenance is a short code the adapter resolves
--             (weather-ea.PROVENANCE). A revised value keeps the one
--             it replaced in previous_payload and bumps revision.
CREATE TABLE IF NOT EXISTS external_weather_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  feed TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  period_s INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  temperature_c REAL,
  humidity_pct REAL,
  dewpoint_c REAL,
  pressure_hpa REAL,
  wind_ms REAL,
  gust_ms REAL,
  wind_direction_deg REAL,
  rain_mm REAL,
  rain_rate_mm_h REAL,
  rain_accum_mm REAL,
  lat REAL,
  lon REAL,
  elevation_m REAL,
  qc_status TEXT,
  qc_detail TEXT,
  raw_payload TEXT NOT NULL,
  provenance TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  previous_payload TEXT,
  updated_at INTEGER NOT NULL,
  -- Column order serves the reads too (source + period + time range), so no
  -- second index is needed.
  UNIQUE (source_id, period_s, observed_at, feed)
);

-- One row per (source, feed): when it last worked, why it last failed, how
-- long it is backing off, and how far a backfill has walked.
CREATE TABLE IF NOT EXISTS external_weather_sync (
  source_id TEXT NOT NULL,
  feed TEXT NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER,
  last_observed_at INTEGER,
  last_stats TEXT,
  backfill_state TEXT,
  PRIMARY KEY (source_id, feed)
);

-- Daily summaries of each neighbouring WU station (services/weather-nowcast.js).
-- Raw WU readings are kept 30 days; these are kept for good, so a station's
-- long-run behaviour (its offsets, its rain) outlives the raw rows. Days are
-- Europe/London dates. rain_mm is the station's own since-midnight total at its
-- last reading of the day.
CREATE TABLE IF NOT EXISTS weather_station_daily (
  source_id TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  t_min REAL, t_max REAL, t_mean REAL,
  rh_mean REAL, p_mean REAL,
  wind_mean_ms REAL, gust_max_ms REAL,
  rain_mm REAL,
  PRIMARY KEY (source_id, day)
);

-- Every local nowcast NEURO makes is RECORDED and later SCORED against what the
-- EA gauge and the near stations measured — the only way to know whether it is
-- any good. Kept for good. status: open | hit | miss | unknown (could not tell).
CREATE TABLE IF NOT EXISTS weather_nowcast_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  made_at INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER NOT NULL,
  claim TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_wx_nowcast_status ON weather_nowcast_predictions(status, kind);

-- Rain STARTING at home, whether or not it was predicted. Without these the
-- record could only ever count hits and false alarms, never the rain it missed.
CREATE TABLE IF NOT EXISTS weather_nowcast_onsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  predicted_by INTEGER,
  evidence TEXT
);

-- What a device says about ITSELF — battery, motion, connectivity, focus.
--
-- Everything here is currently read out of Home Assistant's iOS Companion app
-- (`services/ha.js getPhoneStatus`), which means NEURO's picture of what Nick is
-- physically doing depends on a third-party app relaying sensors the phone
-- already owns. A native app reports them directly; HA is then kept for
-- smart-home ACTUATION, which is the only thing it is uniquely able to do.
--
-- ⚠ ONE ROW PER DEVICE, not a history. This is current state — "what is the
-- phone doing now" — and the questions asked of it (is he moving, is he
-- driving, is the phone dead) are all about the present. Motion HISTORY, if it
-- is ever wanted, is a different table with a different shape; overloading this
-- one would make every read a "latest per device" subquery.
--
-- ⚠ `reported_at` is when the DEVICE observed the state, `received_at` when the
-- Pi was told. They differ by however long the phone was off the tailnet, and
-- conflating them makes a queued report look current. The write is guarded on
-- `reported_at` moving FORWARD — an offline queue can deliver an old report
-- after a new one, and last-write-wins would then rewind the phone's state.
CREATE TABLE IF NOT EXISTS device_status (
  device_id TEXT PRIMARY KEY,
  reported_at TEXT NOT NULL,
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  battery_level REAL,
  battery_state TEXT,
  connection_type TEXT,
  ssid TEXT,
  geocoded_location TEXT,
  activity TEXT,
  activity_since TEXT,
  steps INTEGER,
  distance_m REAL,
  floors_ascended INTEGER,
  focus_mode INTEGER,
  -- The raw report, so a sensor the app learns to send before NEURO learns to
  -- model it is kept rather than dropped on the floor.
  payload TEXT
);

-- MoSCoW task prioritisation (Phase 6A)
CREATE TABLE IF NOT EXISTS task_moscow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT UNIQUE NOT NULL,
  moscow TEXT NOT NULL CHECK(moscow IN ('must', 'should', 'could', 'wont')),
  task_text TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_moscow_key ON task_moscow(task_key);
CREATE INDEX IF NOT EXISTS idx_task_moscow_priority ON task_moscow(moscow);

-- Tasks — NEURO is the source of truth (13 Aug 2026 migration).
-- Before this, task metadata lived in three places at once: a triage worksheet,
-- task_moscow, and vault markdown. This table is the one store; the vault gets a
-- regenerated read-only export note instead (see services/task-export.js).
-- priority is 1-3 as Nick uses it: 3 = most pressing, 1 = least. Not the
-- high/normal/low string the vault parser produces — that is derived on read.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in-progress', 'done', 'dropped')),
  moscow TEXT CHECK(moscow IS NULL OR moscow IN ('must', 'should', 'could', 'wont')),
  -- 1 = the bucket is a proposal, not a decision. The 12 Aug triage worksheet marked
  -- inferred buckets with a trailing `?`; importing those as decided would invent
  -- calls Nick never made, so they carry the flag and stay in the review queue.
  moscow_proposed INTEGER NOT NULL DEFAULT 0,
  priority INTEGER CHECK(priority IS NULL OR priority BETWEEN 1 AND 3),
  due_date TEXT,
  -- Where it came from: master-todo-import | capture | watch | obsidian-capture |
  -- meeting-promotion | chat | mcp | manual
  source TEXT NOT NULL DEFAULT 'manual',
  -- Provenance backlink into the vault (relative path), so a task can always be
  -- traced to the note that produced it.
  origin_path TEXT,
  origin_line INTEGER,
  -- What the writer knew about where this came from, in words, as JSON. Written
  -- ONCE at creation, never re-derived, display only — nothing routes off it.
  --
  -- ⚠ It exists because origin_path is not always readable by a human: an
  -- email-promoted task carries `email:AAMkAGI1MjNl…`, a Graph id that names the
  -- message to Microsoft and to nobody else. Task #251 was a MUST, high
  -- priority, due today, and unidentifiable — while the sender and subject were
  -- sitting on the suggestion it was promoted from and were dropped on the way
  -- in. NULL is the normal case and a real answer: a vault path reads fine on
  -- its own. See shared/task-provenance.cjs for how it is rendered.
  origin_detail TEXT,
  context TEXT,
  -- Which part of Nick's life this belongs to: 'work' or 'personal'.
  -- NOT the same axis as `context` above, which is derived by todo-intelligence
  -- and holds a KIND OF WORK (queue, customer, admin). A task can be personal
  -- admin; the two are orthogonal and conflating them would make the domain
  -- unreadable the moment the classifier changed its mind.
  -- Defaults to 'work' because that is true of every row that existed when the
  -- column was added, and because the two mistakes are asymmetric — see
  -- shared/task-domain.cjs for why unknown fails towards the visible one.
  domain TEXT NOT NULL DEFAULT 'work' CHECK(domain IN ('work', 'personal')),
  notes TEXT,
  -- Whose idea was this: 'commitment' (somebody else asked, or is waiting on it)
  -- or 'improvement' (Nick's own). NULL means NOT YET CLASSIFIED and is a real,
  -- reported state — deliberately NOT defaulted, unlike `domain` above. The two
  -- mistakes point in opposite directions and both are expensive in a report
  -- read by the person assessing a PIP: guessing 'commitment' manufactures
  -- broken promises out of Nick's own stretch goals, guessing 'improvement'
  -- hides a real one. See shared/task-origin.cjs.
  origin TEXT CHECK(origin IS NULL OR origin IN ('commitment', 'improvement')),
  -- 1 = inferred from provenance, not a call Nick has made. Same contract as
  -- moscow_proposed: a proposal is shown with a '?' and never counted as a
  -- decision he made.
  origin_proposed INTEGER NOT NULL DEFAULT 0,
  ms_id TEXT,
  -- Roughly how long this takes, in minutes. NULL means NOT ESTIMATED, and is
  -- deliberately distinguishable from a small number: "what fits before my next
  -- meeting" has to be able to say which answers it is assuming rather than
  -- quietly treating an unknown as thirty minutes.
  estimate_minutes INTEGER,
  -- Normalised text. UNIQUE so re-running the importer or draining the same
  -- capture line twice cannot create a duplicate.
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_moscow ON tasks(moscow);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);

-- Apple Health time series. One row per (metric, sample time), because a stress
-- score is only meaningful against a rolling PERSONAL baseline — an absolute HRV
-- of 45ms is good for one person and poor for another.
--
-- ⚠ This is now the ONLY store. It used to sit beside a daily KV blob in
-- agent_state (health_data_<date>) written by POST /api/health/ingest, and that
-- pairing failed in the way this codebase keeps finding: the phone moved to the
-- FreeReps app, which posts to /api/v1/ingest/ and writes samples ONLY, so the
-- blob stopped being written and every reader of it (chat context, journal
-- context, /today, /history, /status) silently returned null for months. A null
-- reads as "no data yet", not as "the writer is gone". One writer now.
-- UNIQUE(metric, recorded_at) makes ingest idempotent: a 30-minute poll that
-- re-sends the same watch sample folds instead of duplicating and skewing the
-- baseline.
CREATE TABLE IF NOT EXISTS health_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  -- When the WATCH took the reading, not when we received it. At a 30-minute
  -- poll these differ by up to half an hour, which matters for ordering.
  recorded_at DATETIME NOT NULL,
  source TEXT NOT NULL DEFAULT 'ingest',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(metric, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_health_samples_metric_time ON health_samples(metric, recorded_at DESC);

-- One row per day, derived from health_samples.
--
-- health_samples holds ~1.1M rows across 66 metrics and two years, which is the
-- right shape for a rolling HRV baseline and the wrong shape for every other
-- question: "how does a normal Tuesday look", "was last night short", "has
-- resting heart rate been climbing" all mean scanning hundreds of thousands of
-- rows per read. Nothing outside the desktop HealthCard ever asked, and this is
-- why.
--
-- MATERIALISED rather than derived on read, following `wins`: several consumers
-- want to JOIN against a day (blocks, wins, focus sessions), and a join against
-- a subquery over a million rows is not a thing to put on the planner's path at
-- 07:15.
--
-- ⚠ `complete` is the load-bearing column. A day is recomputed for as long as it
-- is still in the trailing window, because today's row is a PARTIAL day — half
-- its steps have not happened yet. A consumer averaging today's row in with
-- finished days silently drags every average down; `complete = 0` is how it
-- knows not to.
CREATE TABLE IF NOT EXISTS health_daily (
  day TEXT PRIMARY KEY,              -- YYYY-MM-DD, local-ish (see health-daily.js)
  -- Sleep, keyed on the night you WOKE on — apple-health.rollupSleepNights owns
  -- that rule and this table stores its answer rather than re-deriving it.
  asleep_hours REAL,
  sleep_source TEXT,                 -- staged | unspecified | none
  deep_hours REAL,
  rem_hours REAL,
  core_hours REAL,
  awake_hours REAL,
  sleep_efficiency REAL,
  -- Medians, not means: HRV is noisy and log-normal, and one 12ms reading during
  -- a difficult call should not move the day. Same call stress-score makes.
  hrv_median REAL,
  hrv_samples INTEGER,
  rhr_median REAL,
  -- Sums for the counters, averages for the rates.
  steps REAL,
  active_energy REAL,
  exercise_minutes REAL,
  stand_minutes REAL,
  daylight_minutes REAL,
  respiratory_rate REAL,
  wrist_temp REAL,
  spo2 REAL,                         -- PERCENT. Apple stores oxygen saturation as a
                                     -- fraction (0.85..1.0); health-daily scales it once,
                                     -- so this column is 85..100 and means one thing.
  weight_kg REAL,
  -- Blood pressure and heart rate: daily MEDIANS, like hrv/rhr above. BP is a
  -- pair and the two halves are stored separately because they are two
  -- measurements, not one number with a slash in it.
  bp_systolic REAL,
  bp_diastolic REAL,
  heart_rate_median REAL,
  complete INTEGER NOT NULL DEFAULT 0,
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Exertion per LOCAL day, from continuous heart rate (services/exertion.js).
-- Banister TRIMP above resting + 10 bpm. z1..z5 are DISPLAY-band MINUTES (20/30/
-- 40/50/60% of reserve), not inputs to load. `partial` = under 16h of heart rate, so `load` is a floor, not the day.
-- rest_hr / max_hr are the scale the day was judged on, stored beside it because
-- a later re-estimate of max HR changes every zone and the row must say which.
CREATE TABLE IF NOT EXISTS health_exertion_daily (
  day TEXT PRIMARY KEY,
  load REAL,
  score REAL,
  z1 REAL, z2 REAL, z3 REAL, z4 REAL, z5 REAL,
  covered_minutes INTEGER,
  elevated_minutes INTEGER,
  partial INTEGER NOT NULL DEFAULT 0,
  rest_hr REAL,
  max_hr REAL,
  max_source TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A room's temperature, hour by hour, copied from Home Assistant's LONG-TERM
-- statistics (services/bedroom-climate.js). HA purges ordinary history after ~10
-- days but keeps these hourly means indefinitely; the copy makes NEURO's sleep
-- analysis independent of HA being up. The bedroom sensor sits ON the radiator.
CREATE TABLE IF NOT EXISTS room_climate_hourly (
  entity_id TEXT NOT NULL,
  hour_start INTEGER NOT NULL,       -- unix seconds, UTC
  mean_c REAL,
  min_c REAL,
  max_c REAL,
  PRIMARY KEY (entity_id, hour_start)
);

-- Host/infrastructure metrics: Pi 5, Pi 4, router, broadband.
--
-- Deliberately NOT health_samples: that table is Apple Health data, and its
-- UNIQUE(metric, recorded_at) has no source column — pi5's temp_c and pi4's
-- temp_c at the same second would collide and silently drop one.
--
-- Collection stays in cron-written CSVs so it survives the backend being down
-- (which is exactly when a wedged router needs recording). This table is the
-- queryable, retained, backed-up copy the panel reads.
CREATE TABLE IF NOT EXISTS host_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,        -- pi5 | pi4 | router | broadband
  metric TEXT NOT NULL,        -- load_pct | temp_c | down_mbps | ...
  value REAL,
  recorded_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Makes imports idempotent: re-running the importer over the same CSV rows
  -- cannot duplicate them, which is what allows a safe watermark trim.
  UNIQUE(source, metric, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_host_metrics_lookup ON host_metrics(source, metric, recorded_at DESC);

-- Commitments other people owe Nick, lifted out of meeting notes.
--
-- Was the agent_state KV blob until 15 Aug. Moved because the chasing UI needs
-- to filter, sort and — the deciding one — SNOOZE, which is a per-item date the
-- blob had nowhere to put. The key stays the dedupe key (person::normalised
-- text) so a second sighting folds instead of duplicating, exactly as before.
CREATE TABLE IF NOT EXISTS waiting_on (
  key           TEXT PRIMARY KEY,
  person        TEXT NOT NULL,
  person_full   TEXT,
  text          TEXT NOT NULL,
  source_path   TEXT,
  source_date   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | done | dropped
  asked_at      TEXT,
  chase_count   INTEGER NOT NULL DEFAULT 0,
  -- Dated from the MEETING, not from when the row was written, or a backfill
  -- over four months reports a June commitment as nought days old.
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  sightings     INTEGER NOT NULL DEFAULT 1,
  reopened_at   TEXT,
  resolved_at   TEXT,
  snoozed_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_waiting_on_status ON waiting_on(status, first_seen);
CREATE INDEX IF NOT EXISTS idx_waiting_on_person ON waiting_on(person, status);

-- Replies Nick has sent from triage (#69).
--
-- Before this the send path called dismissEmail(id,'replied') and that was the
-- ENTIRE record — the only evidence a reply happened lived in Outlook's Sent
-- Items. So "I answered that on Tuesday" was not answerable from NEURO, and it
-- was the newest write path in the system and the least observable.
--
-- Denormalised on purpose: subject/from are copied in rather than joined back
-- to the triage blob, because that blob is a rolling cache (~290 entries) and a
-- reply must stay answerable long after the email it answered has rolled out.
CREATE TABLE IF NOT EXISTS sent_replies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id      TEXT NOT NULL,
  subject       TEXT,
  from_name     TEXT,
  from_email    TEXT,
  -- JSON array of {name,email}. On a plain reply/replyAll GRAPH picks the
  -- recipients, not NEURO — so recipients_source records whether this is what
  -- was actually addressed ('explicit') or NEURO's best reading of the thread
  -- ('inferred'). Storing an inferred list as fact is how a record stops being
  -- worth having.
  recipients        TEXT,
  recipients_source TEXT NOT NULL DEFAULT 'unknown',  -- explicit | inferred | unknown
  reply_all     INTEGER NOT NULL DEFAULT 0,
  body          TEXT NOT NULL,
  sent_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sent_replies_sent ON sent_replies(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_replies_email ON sent_replies(email_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Management Actions & Conversations Log — PIP competencies 3 and 4.
--
-- Competency 3: every management conversation, concern or action logged within
-- TWO WORKING DAYS, each with an owner and a due date, followed to resolution.
-- Competency 4: the count of OVERDUE management actions, baselined at
-- 27 Jul 2026, to reach zero by the 60-day review (11 Sep 2026) and thereafter
-- nothing overdue by more than five working days.
--
-- The baseline is deliberately NOT a stored number. A hand-agreed integer is
-- unfalsifiable a month later and cannot be recomputed when a row turns out to
-- have been miscounted; derived from due_date and resolved_date it can be
-- re-run against any date and always agrees with the rows underneath it.
--
-- `logged_at` is separate from `entry_date` because the two-working-day rule is
-- a fact about the GAP between them. Collapsing them into one column would make
-- the one thing competency 3 is measured on impossible to evidence.
CREATE TABLE IF NOT EXISTS management_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date    TEXT NOT NULL,              -- when the conversation/concern happened
  logged_at     TEXT NOT NULL,              -- when it was written down (the compliance clock)
  type          TEXT NOT NULL,              -- conversation | concern | action
  person        TEXT,                       -- canonical first name, matching waiting_on
  summary       TEXT NOT NULL,
  action        TEXT,
  owner         TEXT,
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | in-progress | blocked | done
  resolved_date TEXT,
  -- Chris spot-checks People HR, so whether an item also reached People HR is a
  -- distinct fact from whether NEURO knows about it. Never inferred.
  --
  -- THREE states, and the third is the point: NULL = not asked, 0 = confirmed
  -- NOT in People HR, 1 = confirmed in. The first cut was a NOT NULL boolean
  -- defaulting to 0, which made "we never asked" indistinguishable from "it is
  -- missing" — so the seeded batch reported three People HR gaps that had never
  -- been measured, in a report going to the manager who spot-checks People HR.
  -- Same lesson as state-of-play's `never` vs `stale`: unknown is not broken.
  hr_logged     INTEGER,
  source        TEXT,                       -- vault path, plaud id, '1-2-1', 'manual'
  -- The task this action is mirrored into, when it is something Nick has to DO.
  -- The log is the compliance record; the task store is where work is looked
  -- for. A management action that lives only here is one nobody sees, which is
  -- exactly how the first seeded batch produced three overdue items that could
  -- not be found in Tasks, Focus or on the phone.
  task_id       INTEGER,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mgmt_log_due ON management_log(due_date);
CREATE INDEX IF NOT EXISTS idx_mgmt_log_status ON management_log(status);
CREATE INDEX IF NOT EXISTS idx_mgmt_log_entry ON management_log(entry_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Overtime approvals — PIP competency 1.
--
-- The finding was that overtime was approved on headline indicators (ticket
-- counts, activity status) without cross-checking logged work, and that Working
-- Time Regulation limits were not considered at the point of approval. The plan
-- requires that from 27 Jul 2026 EVERY approval follows the five-step checklist
-- in Section 8 of the WTR briefing, each check recorded, with the line manager
-- auditing a sample at the 30/60/90-day checkpoints.
--
-- So this table is the checklist, one column per step, not a notes field. A free
-- text box would let an approval be recorded without the checks being done,
-- which is precisely the behaviour being corrected. `approved_at` cannot be set
-- while any step is unanswered — enforced in the service, because the point is
-- to make the evidence a by-product of approving rather than a thing to remember
-- afterwards.
--
-- THREE states per check, as with management_log.hr_logged: NULL = not done,
-- 0 = done and FAILED, 1 = done and passed. A boolean defaulting to 0 would make
-- "not yet checked" indistinguishable from "checked and found in breach", and
-- this record is the one Chris audits.
CREATE TABLE IF NOT EXISTS overtime_approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  person          TEXT NOT NULL,             -- who worked it
  work_date       TEXT NOT NULL,             -- the date worked (not the claim date)
  hours           REAL NOT NULL,
  reason          TEXT,                      -- why it was needed
  requested_at    TEXT NOT NULL,             -- when the claim reached Nick
  logged_at       TEXT NOT NULL,             -- when it was written down here

  -- Step 1: verified against Jira/NOVA systems activity.
  chk_activity        INTEGER,
  chk_activity_note   TEXT,                  -- the evidence: tickets touched, solved, comments
  -- Step 2: cumulative hours checked against the 48-hour rolling 17-week average.
  chk_48h             INTEGER,
  rolling_avg_hours   REAL,                  -- computed at approval time and KEPT
  -- Step 3: valid signed opt-out confirmed, where the average would be exceeded.
  chk_optout          INTEGER,
  -- Step 4: rest entitlements checked (11h daily, 24h weekly).
  chk_rest            INTEGER,
  -- Step 5: the check recorded. Set when the other four are answered.
  chk_recorded        INTEGER,

  outcome         TEXT,                      -- approved | declined | pending
  approved_by     TEXT,
  approved_at     TEXT,                      -- NULL until all five steps answered
  declined_reason TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_overtime_person_date ON overtime_approvals(person, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_overtime_outcome ON overtime_approvals(outcome);
CREATE INDEX IF NOT EXISTS idx_overtime_work_date ON overtime_approvals(work_date DESC);

-- Contracted weekly hours, needed to turn recorded overtime into a 48-hour
-- rolling average. Without it the average is computable only if you assume a
-- standard week, and assuming is the habit this whole table exists to replace.
CREATE TABLE IF NOT EXISTS working_time_profile (
  person            TEXT PRIMARY KEY,
  contracted_hours  REAL NOT NULL,
  -- NULL = never asked. A missing opt-out is not the same as a refused one, and
  -- step 3 has to be able to say which.
  optout_signed     INTEGER,
  optout_date       TEXT,
  notes             TEXT,
  updated_at        TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Wins — the derived ledger of finished work.
--
-- Measured before building: over 30 days NEURO recorded FOUR completions,
-- against 271 commits, 57 executed SAiM actions and a full diary. The Momentum
-- card on the Today tab read 0 with no streak on every one of the nine visits
-- it got. The reward surface existed and was starved, because the only thing
-- feeding it was self-report — a tickbox — and self-report is the first thing
-- avoidance eats.
--
-- So a win is DETECTED, not declared. Same rule the rest of the system already
-- follows: who reports to Nick is READ not typed, 1-2-1s are detected not
-- declared, the tracker is generated. This was the last hand-typed ledger.
--
-- Rows are materialised rather than derived on read, following sent_replies:
-- several sources are ROLLING caches (calendar_cache, the triage blob) that
-- lose their own history, and a counter that shrinks when a cache rolls is
-- worse than no counter. Materialising also makes the feed scrollable, which
-- is half of why `git log` feels good.
--
-- dedupe_key is UNIQUE so sync() is idempotent: it runs hourly, on startup and
-- over a backfill range, and a second sighting of the same commit or action
-- folds rather than inflating the count. Getting that wrong would make the
-- number climb on its own, which destroys the only property that matters here
-- — that the number is TRUE.
CREATE TABLE IF NOT EXISTS wins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Local date the work happened, never toISOString() (the Pi may run UTC).
  date_key     TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  source       TEXT NOT NULL,   -- git | action | reply | task | ritual | decision | one-to-one | manual
  kind         TEXT NOT NULL,   -- finer label within a source, e.g. 'reply_email'
  text         TEXT NOT NULL,
  -- What proves it: a commit sha, a saim_action id, a task id, a note path.
  -- A win with no evidence is an assertion, and an assertion is what the old
  -- tickbox already was. 'manual' is the one source allowed a null here.
  evidence     TEXT,
  -- Commits fold to one row per repo per day and carry the count, so git can
  -- never dominate the feed the way one long transcript once dominated search.
  count        INTEGER NOT NULL DEFAULT 1,
  dedupe_key   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wins_date ON wins(date_key DESC);
CREATE INDEX IF NOT EXISTS idx_wins_occurred ON wins(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_wins_source ON wins(source);

-- ── Task blocks — tasks pushed into the O365 calendar (18 Aug 2026) ──────────
--
-- Nick's rule, carried over from meetings: a block in the diary is a PLAN, not
-- finished work. `meeting-notes-source` will not count a meeting until the Plaud
-- note lands, because the note is what proves both that he was there and that
-- the meeting was processed. A time block has exactly the same hole and no Plaud
-- recording to close it — nobody records a solo work block — so the evidence is
-- an outcome note Nick writes.
--
-- **A block holds MANY tasks.** The first cut keyed the block on a single
-- task_id, and that is wrong for the way the work actually arrives: several
-- five-minute jobs belong in one thirty-minute window, and the whole point of
-- batching them is that they produce ONE write-up between them. Four separate
-- notes for one sitting is friction that would kill the feature. So the block is
-- the unit and `task_block_items` is the membership.
--
-- The window is chosen independently of what is in it — a 30-minute block may
-- hold 20 minutes of work, deliberately. Nothing here forces them to agree.
--
-- status:
--   scheduled        the block exists; nothing has been claimed about it yet
--   awaiting-writeup at least one member task has been ticked — HELD
--   complete         a real outcome note landed
--   released         closed with no note, by an explicit decision + a reason
--   dropped          the block was abandoned
CREATE TABLE IF NOT EXISTS task_blocks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL only when the Graph create failed; the row is still written so the
  -- stub note and the failure are both traceable rather than silently lost.
  event_id        TEXT,
  event_web_link  TEXT,
  -- Local date/time, never toISOString() — the Pi may run UTC.
  date_key        TEXT NOT NULL,
  start_time      TEXT NOT NULL,   -- HH:MM
  end_time        TEXT NOT NULL,   -- HH:MM
  -- Length of the WINDOW, which is a decision about the diary, not a sum of the
  -- estimates inside it.
  minutes         INTEGER NOT NULL,
  -- 1 when the length came from time-fit's ASSUMED_MINUTES rather than from an
  -- estimate or an explicit choice. Carried to the screen, same rule as #87: a
  -- guess presented as a measurement is the answer you stop trusting.
  minutes_assumed INTEGER NOT NULL DEFAULT 0,
  -- Vault-relative path of the outcome stub. One per BLOCK, not per task.
  note_path       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK(status IN ('scheduled','awaiting-writeup','complete','released','dropped')),
  release_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT
);

-- Which tasks are in the block.
--
-- `allotted_minutes` is what the task was given INSIDE the window — the number
-- Nick judged when he packed it. It is written back to `tasks.estimate_minutes`
-- (snapped to the coarse buckets) because that judgement is exactly the estimate
-- the task never had: 0 of 154 open tasks carried one, and asking for estimates
-- up front is how the priority field ended up 18% populated. Asking at the
-- moment he is already thinking about duration is the only version that gets
-- answered.
--
-- `awaiting` records that THIS task's completion was held — the tick happened.
-- It is per item, not per block, because a batch of four routinely finishes
-- three: the write-up releases the hold on all of them, but only the ones
-- actually ticked are completed. Auto-completing the rest would mark work done
-- that nobody did, which is the exact thing "a win is detected, not declared"
-- exists to stop.
CREATE TABLE IF NOT EXISTS task_block_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id         INTEGER NOT NULL,
  task_id          INTEGER NOT NULL,
  allotted_minutes INTEGER,
  awaiting         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  UNIQUE(block_id, task_id)
);

-- The idempotency guard, checked BEFORE the Graph create — by the time Graph has
-- answered, a double-click has already made the duplicate. Keyed on the slot
-- rather than the event id, which does not exist yet at that point. Deleting the
-- block in Outlook is a DECISION: nothing rescans the calendar to recreate it,
-- the same call plaud-admin-blocks made and for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_blocks_slot ON task_blocks(date_key, start_time);
CREATE INDEX IF NOT EXISTS idx_task_blocks_status ON task_blocks(status);
CREATE INDEX IF NOT EXISTS idx_task_block_items_task ON task_block_items(task_id);
CREATE INDEX IF NOT EXISTS idx_task_block_items_block ON task_block_items(block_id);

-- ── Mobile outbox ledger (Phase 2) ───────────────────────────────────────────
--
-- Every operation the phone sends, recorded ONCE, keyed on the id the DEVICE
-- generated. This is the whole idempotency story: NEURO owns the canonical
-- record, and the device owns the identity of the intent that created it.
--
-- ⚠ `status` has four values and keeping them apart is the point:
--   applied         — the canonical record exists; `canonical_id` names it.
--   failed          — nothing was written; a replay is SAFE and expected.
--   rejected        — the operation was refused (unknown kind, bad payload).
--                     A replay changes nothing; the device must stop retrying.
--   pending         — a row written immediately before the work started, which
--                     can only survive a crash MID-APPLY. It is never replayed:
--                     a note may or may not have landed and re-applying would
--                     duplicate it, so it is reported as needing attention and
--                     the device keeps its copy. Local intent is preserved and
--                     nothing is silently overwritten or discarded.
--
-- The applier is fully SYNCHRONOUS between the ledger read and the write, so in
-- a single Node process better-sqlite3 makes this a real mutex — two concurrent
-- replays of one operationId cannot both see "not there yet". That is only true
-- in-process (`plaud-admin-blocks`' rule), which is where it runs.
--
-- Deliberately NO capture text is stored here: the payload lives in the vault or
-- the tasks table, which are the canonical homes for it. A second copy in a
-- ledger is a second store, and SAiM/mobile stores nothing.
CREATE TABLE IF NOT EXISTS mobile_sync_operations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL,
  operation_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  client_schema TEXT,
  created_at    TEXT,            -- when the DEVICE made it (may be offline-old)
  received_at   TEXT NOT NULL,   -- when NEURO first saw it
  settled_at    TEXT,
  status        TEXT NOT NULL,
  canonical_id  TEXT,
  detail        TEXT,
  UNIQUE(device_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_mobile_sync_status ON mobile_sync_operations(status);
CREATE INDEX IF NOT EXISTS idx_mobile_sync_device ON mobile_sync_operations(device_id, received_at);

-- ── Attention records (Phase 3, Gate 1 — 30 Aug 2026) ───────────────────────
--
-- The durable identity of a surfaced thing. Full contract in
-- `docs/attention-contract.md`.
--
-- Before this, an attention item lived for exactly one HTTP request:
-- decision-engine recomputed the pool on every call and the answer was rendered
-- and thrown away. So nothing could be ACKNOWLEDGED (the only durable state was
-- a suppression timer, which cannot tell "I have seen this" from "hide it for
-- 30 minutes" from "this is finished"), and a notification had no idea what it
-- was about — the governor deduped on a fingerprint of the TEXT, so a meeting
-- alert counting down produced a new fingerprint each time and passed cleanly.
--
-- ⚠ `dedupe_key` is the identity of the THING, not the engine's item id. Engine
-- ids are unstable by construction: `collectOverdueTodos` emits
-- `todo-overdue-top` for one overdue task and `todo-overdue-summary` for two, so
-- a dismissal recorded against one silently stopped applying the moment a second
-- task went overdue.
--
-- ⚠ Terminal states (resolved / expired / suppressed) NEVER re-match. If the
-- same dedupe_key appears again a NEW record is opened — which is what makes a
-- daily recurrence work without the key carrying a date, and what stops
-- yesterday's dismissal silencing today's standup.
--
-- `evidence` is never invented: an item with nothing citable stores `[]`, and
-- the notification gate refuses to interrupt on it. Surfacing without evidence
-- is fine (hiding real work on a bookkeeping failure is the worse error);
-- interrupting without it is not.
CREATE TABLE IF NOT EXISTS attention_records (
  id                TEXT PRIMARY KEY,
  dedupe_key        TEXT NOT NULL,
  type              TEXT NOT NULL,
  state             TEXT NOT NULL,   -- active|acknowledged|deferred|suppressed|resolved|expired
  title             TEXT,
  say               TEXT,
  reason            TEXT,
  tab               TEXT,
  urgency           TEXT,
  tier              INTEGER,
  score             INTEGER,
  domain            TEXT,            -- work|personal|null, from the item's meta
  operational       INTEGER NOT NULL DEFAULT 0,  -- opened by a raw push, not the pool
  confidence        TEXT,            -- JSON {level, why}
  evidence          TEXT,            -- JSON [{source, ref, observedAt, detail}]
  actions           TEXT,            -- JSON [action ids]
  meta              TEXT,            -- JSON, the engine's own meta
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  surfaced_at       TEXT,
  notified_at       TEXT,
  notify_signature  TEXT,            -- urgency|tier when it last interrupted
  state_changed_at  TEXT NOT NULL,
  defer_until       TEXT,
  defer_reason      TEXT,
  resolution        TEXT             -- why it left: acted|gone|aged-out|dismissed
);
CREATE INDEX IF NOT EXISTS idx_attention_open ON attention_records(state, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_attention_seen ON attention_records(last_seen_at DESC);

-- The audit trail. "Recent notifications/attention history with the reason each
-- was surfaced" is a required control surface, and a state column alone cannot
-- answer it — it holds only the latest value, so a card deferred three times
-- looks identical to one deferred once.
CREATE TABLE IF NOT EXISTS attention_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL,
  at         TEXT NOT NULL,
  event      TEXT NOT NULL,   -- opened|surfaced|notified|acknowledged|deferred|dismissed|resolved|expired|notify-refused
  detail     TEXT,
  FOREIGN KEY (record_id) REFERENCES attention_records(id)
);
CREATE INDEX IF NOT EXISTS idx_attention_events_record ON attention_events(record_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_attention_events_at ON attention_events(at DESC);

-- What the desktop agent saw, rolled up per day per machine.
--
-- The live samples are a ~13-hour ring buffer in agent_state by design: "what is
-- he doing lately" is disposable state. That leaves no history at all, which is
-- the whole reason RescueTime looked like the better option until its coverage
-- was measured (9 blind weekdays in three months, 0.16h logged against 8.21h
-- actually worked). This is the durable half. Same shape as health_daily:
-- materialised rather than derived on read, because the samples it is built from
-- age out of the ring within the day.
--
-- ONE ROW PER (day, host). Deliberately not merged across machines: summing two
-- hosts double-counts an hour spent switching between them, and the raw samples
-- needed to take a union are gone by the time anyone asks.
CREATE TABLE IF NOT EXISTS desktop_daily (
  day             TEXT NOT NULL,     -- YYYY-MM-DD, LOCAL (never toISOString)
  host            TEXT NOT NULL,
  -- present = active + idle + locked, by construction. Intervals longer than the
  -- agent's reporting gap are NOT counted: a machine asleep for an hour was not
  -- an hour at the desk.
  present_minutes REAL,
  active_minutes  REAL,
  idle_minutes    REAL,
  locked_minutes  REAL,
  apps            TEXT,              -- JSON { app: minutes }, active time only
  top_app         TEXT,
  top_app_minutes REAL,
  longest_run_minutes REAL,          -- longest unbroken stretch in ONE app
  first_at        TEXT,
  last_at         TEXT,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  -- The DAY is over. Says nothing about whether the agent was running for all of
  -- it — that is what sample_count and first/last_at are for.
  complete        INTEGER NOT NULL DEFAULT 0,
  computed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, host)
);
CREATE INDEX IF NOT EXISTS idx_desktop_daily_day ON desktop_daily(day DESC);

-- RescueTime, kept as a second opinion that desktop_daily audits.
--
-- ⚠ NO PRODUCTIVITY PULSE, by design. Measured r = -0.96 against meeting count:
-- it is a coding-vs-meetings ratio, and NEURO already derives both halves from
-- git and the calendar. Storing it would add a number that looks like insight
-- and carries none.
--
-- ⚠ `domains` holds BARE HOSTNAMES only. RescueTime's activity rows carry query
-- strings and OAuth parameters verbatim, and its account holds full window
-- titles; services/rescuetime.js cuts every value to a hostname before it gets
-- here, and restrict_kind=document is never requested.
--
-- The day key is RescueTime's OWN, in the account's timezone, used verbatim.
CREATE TABLE IF NOT EXISTS rescuetime_daily (
  day           TEXT PRIMARY KEY,
  total_minutes REAL,
  categories    TEXT,            -- JSON { category: minutes }
  domains       TEXT,            -- JSON { hostname: minutes }
  top_category  TEXT,
  complete      INTEGER NOT NULL DEFAULT 0,
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Calendar HISTORY, as opposed to the cache above (13 Sep 2026).
--
-- calendar_cache is a ROLLING WINDOW: calendar-sync replaces it per source
-- per window, so an event drops out a few weeks after it happens and is gone.
-- Measured on the day this was added: 105 events spanning 29 Aug -> 25 Sep,
-- and nothing older anywhere.
--
-- That made every question about the SHAPE of his weeks unanswerable: when
-- his day really starts, which meetings actually happen, how often the 10am
-- slips. `rhythm` needs exactly that, and none of it is recoverable
-- retrospectively - which is the whole argument for starting to keep it.
--
-- Append-only and idempotent: every sync offers what it can see and the
-- UNIQUE key folds a repeat. Nothing here is ever deleted by a sync.
CREATE TABLE IF NOT EXISTS calendar_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The occurrence, not the series: a recurring meeting is one row per
  -- instance, because 'does the Tuesday standup actually happen' is a
  -- question about instances.
  event_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  subject TEXT,
  is_all_day INTEGER DEFAULT 0,
  show_as TEXT,
  -- Three-valued, exactly as in the cache. NULL is 'we could not tell' and
  -- must never be read as 'solo block'.
  attendees_other INTEGER,
  organizer TEXT,
  source TEXT,
  first_seen TEXT NOT NULL,
  UNIQUE(event_id, start_time)
);
CREATE INDEX IF NOT EXISTS idx_calhist_start ON calendar_history(start_time);

-- ── The nervous system (Build 1, 2 Oct 2026) ─────────────────────────────────
-- A durable, typed, append-only event log beneath the existing runtime. NOT an
-- event-sourced rewrite: every existing table stays the authority for what it
-- holds. This is the integration spine that sources publish into and that
-- projectors and (later) evaluators consume from.
--
-- ⚠ Named `event_log`, not `events`: "event" already means a CALENDAR event in
-- forty places in this codebase (`getCalendarEvents`, `calendar_cache`), and a
-- bare `events` table would be read as one of those by the next person.
--
-- Only `services/event-bus.js` writes these four tables. Application code
-- publishes through `publishEvent()`; it never inserts here directly.
--
-- `seq` IS the offset. A consumer's position is the last seq it has finished,
-- so "resume after a restart" is a single integer read back from disk.
CREATE TABLE IF NOT EXISTS event_log (
  seq                   INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id              TEXT NOT NULL UNIQUE,
  schema_version        INTEGER NOT NULL,
  type                  TEXT NOT NULL,
  occurred_at           TEXT NOT NULL,   -- when it happened at the source (ISO, UTC)
  received_at           TEXT NOT NULL,   -- when NEURO recorded it (ISO, UTC)
  source_system         TEXT NOT NULL,
  source_json           TEXT NOT NULL,   -- { system, deviceId?, recordId? }
  subject_type          TEXT,
  subject_id            TEXT,
  correlation_id        TEXT NOT NULL,
  causation_id          TEXT,
  -- ⚠ UNIQUE, and THIS is the idempotency: the same source item delivered twice
  -- with the same key folds into the first event rather than becoming a second.
  idempotency_key       TEXT NOT NULL UNIQUE,
  payload               TEXT NOT NULL,   -- JSON object, immutable
  payload_hash          TEXT NOT NULL,   -- sha256 of payload: a re-delivery that DIFFERS is reported, never silently folded
  provenance_kind       TEXT NOT NULL CHECK (provenance_kind IN ('fact', 'observation', 'inference')),
  provenance_confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_correlation ON event_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source_system, seq);
-- Build 5B: producers read "what was last said about this record" to build a
-- change key (services/change-key.js). An index, not a change to any row.
CREATE INDEX IF NOT EXISTS idx_event_log_subject ON event_log(subject_id, seq);

-- ⚠ Append-only is ENFORCED, not requested. A projection rebuilt from a log that
-- something quietly edited is a projection of a history that never happened.
-- A future retention policy must drop these triggers deliberately, in a
-- migration that says so — not work round them.
CREATE TRIGGER IF NOT EXISTS event_log_no_update BEFORE UPDATE ON event_log
BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_log_no_delete BEFORE DELETE ON event_log
BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;

-- One row per named consumer: where it has got to. Written in the SAME
-- transaction as a transactional consumer's effects, so a crash between
-- "applied the event" and "recorded that I did" cannot happen.
CREATE TABLE IF NOT EXISTS event_consumers (
  name              TEXT PRIMARY KEY,
  position          INTEGER NOT NULL DEFAULT 0,   -- last seq fully handled (processed or dead-lettered)
  last_processed_at TEXT,
  last_error        TEXT,
  last_error_at     TEXT,
  replayed_at       TEXT,
  updated_at        TEXT NOT NULL
);

-- A consumer that could not handle an event. `retrying` holds the consumer at
-- that event (ordering is preserved — a projection must not skip ahead);
-- `dead` is terminal: retries exhausted, the consumer moved past it, and the
-- row is KEPT as the record that it did. `resolved` = a later attempt or a
-- replay handled it. Nothing here is ever deleted.
CREATE TABLE IF NOT EXISTS event_failures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer         TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('retrying', 'dead', 'resolved')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  first_failed_at  TEXT NOT NULL,
  last_failed_at   TEXT NOT NULL,
  next_attempt_at  TEXT,
  resolved_at      TEXT,
  resolution       TEXT,             -- 'processed' | 'replay'
  UNIQUE(consumer, seq)
);
CREATE INDEX IF NOT EXISTS idx_event_failures_status ON event_failures(status, consumer);

-- The first materialised world-state projection: is each source actually
-- working? Owned by the `source-health` projector and REBUILDABLE ENTIRELY
-- FROM event_log — nothing here may be set by anything else, or a replay
-- would erase it. The expected interval and stale threshold travel ON the
-- events for exactly that reason.
--
-- ⚠ Two separate questions, deliberately two columns: `state` is the outcome
-- of the last attempt (unknown | healthy | failing), `freshness` is whether
-- the last SUCCESS is recent enough to believe (unknown | fresh | stale). A
-- source can be failing-but-fresh (one hiccup) or healthy-but-stale (it
-- succeeded, long ago), and folding them into one word loses which.
CREATE TABLE IF NOT EXISTS source_health (
  source_id            TEXT PRIMARY KEY,
  state                TEXT NOT NULL DEFAULT 'unknown',
  freshness            TEXT NOT NULL DEFAULT 'unknown',
  last_attempt_at      TEXT,
  last_success_at      TEXT,
  last_failure_at      TEXT,
  failure_detail       TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  expected_interval_ms INTEGER,
  stale_after_ms       INTEGER,
  stale_since          TEXT,
  last_detail          TEXT,           -- JSON: the last success's summary (counts, window)
  last_event_seq       INTEGER,
  updated_at           TEXT NOT NULL,
  -- Build 2: for a PUSH source, the newest OBSERVATION it has delivered. When
  -- set, freshness is judged on this rather than on when a delivery arrived,
  -- so a phone draining a six-hour-old queue does not read as fresh. NULL for
  -- pull sources, which keep Build 1's behaviour exactly. (Existing databases
  -- gain it through the migration in database.js.)
  last_observed_at     TEXT,
  -- Build 3B. lifecycle: expected | optional | retired, from
  -- source.lifecycle.changed (NULL = none recorded). quiet: the newest
  -- observation is old but the app that sends it is alive on another channel
  -- (freshness = 'quiet') — when, and which channel proved it.
  lifecycle            TEXT,
  quiet_since          TEXT,
  transport_alive_at   TEXT,
  transport_source_id  TEXT
);

-- Build 2: the latest native observation per thing observed, materialised from
-- observation.* events by the `observation-state` projector. REBUILDABLE FROM
-- event_log. One row per assertion key (`health:<metric>`,
-- `device:<deviceId>`, `location:<deviceId>`); the row is whichever event has
-- the newest OBSERVED time, never whichever arrived last.
-- ⚠ No coordinates, SSIDs or place names: the log they come from is immutable.
CREATE TABLE IF NOT EXISTS observation_latest (
  assertion_key        TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,         -- health | device | location
  subject_type         TEXT,
  subject_id           TEXT,
  value_json           TEXT NOT NULL,
  source_id            TEXT NOT NULL,         -- which producer: healthkit.neuro-ios, …
  observed_at          TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  event_seq            INTEGER NOT NULL,
  provenance_kind      TEXT NOT NULL,
  confidence           REAL,
  superseded_event_id  TEXT,                  -- the event this one replaced
  superseded_count     INTEGER NOT NULL DEFAULT 0,
  older_ignored_count  INTEGER NOT NULL DEFAULT 0, -- arrived late, observed earlier: kept out
  updated_at           TEXT NOT NULL
);

-- Build 2B: the source-blindness evaluator's own memory, folded from source.*
-- events (so it is REBUILDABLE FROM event_log and never reads another
-- consumer's table mid-replay).
CREATE TABLE IF NOT EXISTS source_blind_state (
  source_id            TEXT PRIMARY KEY,
  basis_at             TEXT,                  -- newest observation (push) or success (pull)
  last_success_at      TEXT,
  last_outcome_at      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure         TEXT,
  active_finding_id    TEXT,
  updated_at           TEXT NOT NULL,
  lifecycle            TEXT                   -- Build 3B: a retired source never opens a finding
);

-- One row per EPISODE of blindness: opened on the transition into stale /
-- failing / never-seen, refreshed (never re-opened) while it lasts, resolved
-- when the source recovers. A finding is EVIDENCE for the attention engine,
-- never a notification in itself.
CREATE TABLE IF NOT EXISTS source_blind_findings (
  finding_id           TEXT PRIMARY KEY,      -- source-blind:<sourceId>:<opening seq>
  source_id            TEXT NOT NULL,
  status               TEXT NOT NULL,         -- active | resolved
  condition            TEXT NOT NULL,         -- stale | failing | never-seen
  first_detected_at    TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  resolved_at          TEXT,
  basis_at             TEXT,
  last_success_at      TEXT,
  failure_count        INTEGER NOT NULL DEFAULT 0,
  stale_after_ms       INTEGER,
  confidence           REAL,
  change               TEXT NOT NULL,         -- new | change | repeat | resolved
  repeats              INTEGER NOT NULL DEFAULT 0,
  evidence_json        TEXT NOT NULL,         -- event ids, capped
  updated_at           TEXT NOT NULL,
  resolution           TEXT                   -- Build 3B: recovered | transport-alive | retired
);
CREATE INDEX IF NOT EXISTS idx_source_blind_findings_status ON source_blind_findings(status, source_id);

-- What the EXISTING attention policy said about each finding, recorded by
-- ambient-push on its normal pass. NOT derivable from the log (it depends on
-- the moment: meeting, focus, quiet hours), so it lives OUTSIDE the evaluator's
-- tables and survives a replay; finding ids are deterministic, so it reattaches.
CREATE TABLE IF NOT EXISTS source_blind_attention (
  finding_id           TEXT PRIMARY KEY,
  mode                 TEXT NOT NULL,         -- shadow | live
  first_decided_at     TEXT NOT NULL,
  last_decided_at      TEXT NOT NULL,
  decisions            INTEGER NOT NULL DEFAULT 0,
  would_push           INTEGER NOT NULL DEFAULT 0, -- 1 if any pass said yes
  pushed_at            TEXT,                  -- live mode only: actually sent
  last_decision_json   TEXT NOT NULL
);

-- ── Durable scheduled runs (Build 3A, 3 Oct 2026) ───────────────────────────
-- node-cron 3.0.3 only fires a task if its one-second timer lands INSIDE the
-- matching second; a busy event loop on a shared minute silently eats the tick
-- (measured: 9 of 50 calendar syncs missed in one night, nothing logged).
-- Correctness-critical jobs therefore run from THIS table, written by
-- services/runtime-jobs.js only: every due slot becomes a row before it runs,
-- so a run that did not happen is still a row that says so.
--
-- `run_id` is `<job>@<scheduled_for>` — deterministic, so materialising the
-- same slot twice (a second tick, a restart) folds into one row and a slot can
-- never execute twice. `scheduled_for` and `started_at` are different facts;
-- their difference is the lag.
CREATE TABLE IF NOT EXISTS runtime_job_runs (
  run_id           TEXT PRIMARY KEY,
  job              TEXT NOT NULL,
  scheduled_for    TEXT NOT NULL,                -- the slot (ISO, UTC)
  status           TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,                -- not before this (retry back-off)
  claim_token      TEXT,                         -- this attempt; a late finish from a timed-out attempt cannot overwrite
  owner            TEXT,                         -- boot id of the process that claimed it
  first_started_at TEXT,
  started_at       TEXT,                         -- latest attempt
  finished_at      TEXT,
  duration_ms      INTEGER,
  lag_ms           INTEGER,                      -- first start minus scheduled_for
  skip_reason      TEXT,                         -- superseded | stale | gap
  error            TEXT,
  result_json      TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_job_runs_job ON runtime_job_runs(job, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_runtime_job_runs_status ON runtime_job_runs(status, job);

-- ── The world model: Person and Meeting (Build 3C, 3 Oct 2026) ──────────────
-- Owned by the `world-model` projector and REBUILDABLE ENTIRELY FROM event_log
-- (observation.person.declared, observation.calendar.event_observed / _removed).
-- Nothing else may write these tables, or a replay would erase it.
--
-- Facts, observations and inferences are kept apart per row: provenance_kind
-- says which, confidence says how sure, evidence_json names the event ids.

-- A person NEURO knows across domains. Only DECLARED people (a People note)
-- are entities; an attendee address nobody has declared stays a participant
-- with person_id NULL — "unknown" is a real answer, not a person to invent.
CREATE TABLE IF NOT EXISTS wm_people (
  person_id         TEXT PRIMARY KEY,          -- person:<slug of the note name>
  display_name      TEXT NOT NULL,
  note_path         TEXT,
  role              TEXT,                      -- only if the note states it
  team              TEXT,
  direct_report     INTEGER,                   -- 1 / 0 / NULL (not stated)
  manager           TEXT,
  status            TEXT,                      -- the note's own status, verbatim
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  provenance_kind   TEXT NOT NULL,
  confidence        REAL,
  first_observed_at TEXT NOT NULL,
  last_observed_at  TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  fingerprint       TEXT,
  updated_at        TEXT NOT NULL
);

-- How an identity (an email address) is known to belong to a person. One
-- owner per identity: two notes claiming one address is a CONFLICT, recorded,
-- and the address is bound to NEITHER — never a coin toss.
CREATE TABLE IF NOT EXISTS wm_person_identities (
  kind              TEXT NOT NULL,             -- email
  value             TEXT NOT NULL,             -- lower-cased
  person_id         TEXT,                      -- NULL while conflicted
  method            TEXT NOT NULL,             -- vault-declared
  conflict_json     TEXT,                      -- the claimants, when > 1
  evidence_event_id TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  PRIMARY KEY (kind, value)
);

-- Every binding change, kept: the audit trail for identity resolution.
CREATE TABLE IF NOT EXISTS wm_identity_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL,
  value             TEXT NOT NULL,
  person_id         TEXT,
  action            TEXT NOT NULL,             -- bound | unbound | conflict | participants-linked
  rule              TEXT NOT NULL,
  evidence_event_id TEXT NOT NULL,
  detail_json       TEXT,
  at                TEXT NOT NULL
);

-- One row per meeting. `meeting_id` is the AUTHORITATIVE provider's id
-- (graph:<id>, else apple:<id>). Times are the wall-clock strings the sources
-- deliver (Europe/London) and are compared as wall-clock, never re-parsed.
CREATE TABLE IF NOT EXISTS wm_meetings (
  meeting_id        TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,             -- graph | apple
  provider_event_id TEXT NOT NULL,
  series_id         TEXT,
  title             TEXT NOT NULL,
  start_local       TEXT NOT NULL,             -- YYYY-MM-DDTHH:MM, wall clock
  end_local         TEXT NOT NULL,
  is_all_day        INTEGER NOT NULL DEFAULT 0,
  show_as           TEXT,
  status            TEXT NOT NULL,             -- scheduled | cancelled | removed | merged
  merged_into       TEXT,
  response_status   TEXT,
  is_organizer      INTEGER,
  kind              TEXT NOT NULL,             -- meeting | block | unknown (from attendeesOther — an inference)
  organizer_email   TEXT,
  location_label    TEXT,
  is_online         INTEGER,
  provenance_kind   TEXT NOT NULL,
  confidence        REAL,
  observed_at       TEXT NOT NULL,             -- when a source last showed a CHANGE
  received_at       TEXT NOT NULL,
  evidence_json     TEXT NOT NULL,
  fingerprint       TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_meetings_start ON wm_meetings(start_local, status);

-- Which sources describe a meeting. Graph is authoritative; a phone copy of
-- the same meeting is a SUPPORTING source of the Graph meeting, not a second
-- meeting.
CREATE TABLE IF NOT EXISTS wm_meeting_sources (
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  meeting_id        TEXT NOT NULL,
  role              TEXT NOT NULL,             -- authoritative | supporting
  match_rule        TEXT,                      -- provider-id | start+title
  observed_at       TEXT NOT NULL,
  evidence_event_id TEXT NOT NULL,
  PRIMARY KEY (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_wm_meeting_sources_meeting ON wm_meeting_sources(meeting_id);

CREATE TABLE IF NOT EXISTS wm_meeting_participants (
  meeting_id        TEXT NOT NULL,
  email             TEXT NOT NULL,             -- lower-cased
  name              TEXT,
  response          TEXT,
  is_organizer      INTEGER NOT NULL DEFAULT 0,
  person_id         TEXT,                      -- NULL = no declared person owns this address
  link_method       TEXT,                      -- exact-email | NULL
  PRIMARY KEY (meeting_id, email)
);
CREATE INDEX IF NOT EXISTS idx_wm_participants_person ON wm_meeting_participants(person_id);

-- ── The world model: Tasks and Commitments (Build 4B, 3 Oct 2026) ───────────
-- Owned by the `world-model` projector (the SAME consumer as people and
-- meetings, so identity resolution sees exactly the people that existed at
-- that point in the log) and rebuildable entirely from event_log:
-- observation.task.observed / .removed, observation.commitment.observed.
--
-- TASK = something to be done (any store). COMMITMENT = an obligation one
-- person made to another or to a group. A WAITING-FOR is a commitment whose
-- promisor is not Nick — a direction, not a third table. A task that a
-- commitment is realised by is LINKED to it, never merged into it: "buy dog
-- food" is a task and nobody is waiting on it.

-- One row per real-world task. `task_id` is the canonical id of the record
-- that LEADS (NEURO's own row when a Microsoft task is linked to one by ms_id;
-- otherwise the source's own id). Every source record lives in wm_task_sources.
CREATE TABLE IF NOT EXISTS wm_tasks (
  task_id             TEXT PRIMARY KEY,      -- task:neuro:<id> | task:ms-planner:<id> | task:ms-todo:<id>
  title               TEXT NOT NULL,
  title_key           TEXT,                  -- normalised title: the possible-same rule (never a merge)
  status              TEXT NOT NULL,         -- open | completed | cancelled | unknown
  raw_status          TEXT,                  -- the leading source's own word (in-progress, notStarted…)
  completion_authority TEXT,                 -- which source closed it (neuro | microsoft-planner | …)
  moscow              TEXT,
  priority            TEXT,
  due_date            TEXT,                  -- YYYY-MM-DD, as the source holds it
  due_basis           TEXT,                  -- stated | default | set | none (INFERENCE, see world-obligations)
  owner_person_id     TEXT,
  owner_raw           TEXT,
  owner_method        TEXT,                  -- store-owner | source-query-scope | assignee | NULL
  origin_kind         TEXT,                  -- meeting | email | jira | vantage | management-log | capture | microsoft | other
  origin_path         TEXT,
  origin_line         INTEGER,
  meeting_json        TEXT,                  -- the write-up → calendar occurrence link, as the producer judged it
  meeting_id          TEXT,                  -- graph:<occurrence id> when the link held
  meeting_series_key  TEXT,                  -- normalised subject, for "the next one"
  household           INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT,
  updated_at          TEXT,
  completed_at        TEXT,
  possible_completion_json TEXT,             -- an INFERRED completion elsewhere; never changes status
  provenance_kind     TEXT NOT NULL,
  confidence          REAL,
  observed_at         TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  evidence_json       TEXT NOT NULL,
  fingerprint         TEXT
);
CREATE INDEX IF NOT EXISTS idx_wm_tasks_status ON wm_tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_wm_tasks_meeting ON wm_tasks(meeting_series_key);
CREATE INDEX IF NOT EXISTS idx_wm_tasks_title_key ON wm_tasks(title_key);

-- Every source record of a task, with that source's own latest statement.
-- Completion holds while ANY authoritative source still says complete.
CREATE TABLE IF NOT EXISTS wm_task_sources (
  system            TEXT NOT NULL,           -- neuro | ms-planner | ms-todo
  record_id         TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  role              TEXT NOT NULL,           -- leading | synced
  match_rule        TEXT NOT NULL,           -- own-id | explicit-external-id
  status            TEXT NOT NULL,           -- open | completed | cancelled | unknown
  raw_status        TEXT,
  completed_at      TEXT,
  fingerprint       TEXT,
  removed           INTEGER NOT NULL DEFAULT 0,
  payload_json      TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  evidence_event_id TEXT NOT NULL,
  PRIMARY KEY (system, record_id)
);
CREATE INDEX IF NOT EXISTS idx_wm_task_sources_task ON wm_task_sources(task_id);

CREATE TABLE IF NOT EXISTS wm_commitments (
  commitment_id        TEXT PRIMARY KEY,     -- commitment:task:<neuro id> | commitment:waiting:<hash>
  description          TEXT NOT NULL,
  direction            TEXT NOT NULL,        -- by-nick | to-nick | unknown
  promisor_person_id   TEXT,
  promisor_raw         TEXT,
  promisor_method      TEXT,                 -- named-in-text | accepted-into-task-list | exact-name | exact-alias | unique-first-name | NULL
  promisor_confidence  REAL,
  promisor_why         TEXT,                 -- why it is unresolved, when it is
  beneficiary_kind     TEXT NOT NULL,        -- person | meeting | unknown
  beneficiary_person_id TEXT,
  beneficiary_raw      TEXT,
  beneficiary_method   TEXT,
  waiting_party        TEXT,                 -- person:nick-ward for a waiting-for, as the source classified it
  status               TEXT NOT NULL,        -- open | completed | cancelled | superseded | unknown
  raw_status           TEXT,
  completion_authority TEXT,
  due_date             TEXT,
  due_basis            TEXT,
  source_kind          TEXT NOT NULL,        -- meeting-task | meeting-waiting-on
  source_ref           TEXT NOT NULL,        -- the record it was read from
  source_path          TEXT,
  source_line          INTEGER,
  source_date          TEXT,
  meeting_json         TEXT,
  meeting_id           TEXT,
  meeting_series_key   TEXT,
  related_task_id      TEXT,
  created_at           TEXT,
  updated_at           TEXT,
  completed_at         TEXT,
  last_progress_at     TEXT,                 -- the newest evidence the record moved (store update / re-sighting)
  provenance_kind      TEXT NOT NULL,
  confidence           REAL,
  observed_at          TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  evidence_json        TEXT NOT NULL,
  fingerprint          TEXT,
  payload_json         TEXT                  -- the observation the fold last applied (waiting-on); re-resolved on a person change
);
CREATE INDEX IF NOT EXISTS idx_wm_commitments_status ON wm_commitments(status, due_date);
CREATE INDEX IF NOT EXISTS idx_wm_commitments_series ON wm_commitments(meeting_series_key, status);
CREATE INDEX IF NOT EXISTS idx_wm_commitments_promisor ON wm_commitments(promisor_person_id, status);

-- Relationships between obligation records that are NOT merges: a commitment
-- realised by a task, or two records that look like the same thing by a rule
-- too weak to merge on (possible-same). Every one names its rule.
CREATE TABLE IF NOT EXISTS wm_obligation_links (
  a_id              TEXT NOT NULL,
  b_id              TEXT NOT NULL,
  relation          TEXT NOT NULL,           -- realised-by | possible-same
  rule              TEXT NOT NULL,
  confidence        REAL,
  evidence_event_id TEXT NOT NULL,
  at                TEXT NOT NULL,
  PRIMARY KEY (a_id, b_id, relation)
);

-- Every state transition, with what said so: the audit trail behind "why is
-- this closed?".
CREATE TABLE IF NOT EXISTS wm_obligation_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id         TEXT NOT NULL,
  change            TEXT NOT NULL,           -- created | completed | cancelled | reopened | unknown | owner-linked | owner-unlinked | due-changed
  from_value        TEXT,
  to_value          TEXT,
  authority         TEXT,
  evidence_event_id TEXT NOT NULL,
  at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_obligation_history_entity ON wm_obligation_history(entity_id, id);

-- Build 5A: ONE semantic finding per upcoming meeting, replacing the separate
-- meeting-context finding and the meeting-only half of commitment-risk. It
-- LINKS commitment-risk findings (linked_json) rather than restating them, and
-- it is the only thing that asks the attention policy about a meeting.
-- SHADOW only: verdicts recorded, nothing sent.
CREATE TABLE IF NOT EXISTS meeting_intelligence_findings (
  finding_id            TEXT PRIMARY KEY,      -- meeting-intelligence:<meeting id>:<start>
  meeting_id            TEXT NOT NULL,
  title                 TEXT,
  start_local           TEXT NOT NULL,
  status                TEXT NOT NULL,         -- active | withdrawn | expired
  triggers_json         TEXT NOT NULL,
  sections_json         TEXT NOT NULL,         -- yourActions / owedToYou / emails / supporting
  linked_json           TEXT NOT NULL,         -- commitment-risk findings: on this meeting, and surfaced elsewhere
  missing_json          TEXT NOT NULL,
  confidence            REAL,
  recommended_at_local  TEXT,
  summary               TEXT,
  evidence_fingerprint  TEXT,
  attention_decided_at  TEXT,
  attention_json        TEXT,
  decisions             INTEGER NOT NULL DEFAULT 0,
  first_created_at      TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_intel_meeting ON meeting_intelligence_findings(meeting_id, start_local);

-- Build 5A: what the LIVE meeting-prep push did beside what the unified
-- pipeline would have, per meeting occurrence — the parity record that decides
-- whether meeting-prep can be retired. Written by both sides, read by parity().
CREATE TABLE IF NOT EXISTS meeting_prep_comparisons (
  meeting_key  TEXT PRIMARY KEY,               -- graph:<event id>@<start minute>
  title        TEXT,
  start_local  TEXT,
  old_json     TEXT,                           -- meeting-prep: matched, would notify, sent, body
  new_json     TEXT,                           -- meeting-intelligence: finding or not, why, summary
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Build 5E: actions NEURO has PREPARED and Nick may approve. Authority A4
-- (consequential: it would leave the building as Nick), so approval is always
-- required, and in Build 5 an approval RECORDS a decision and executes nothing.
-- Deliberately not saim_actions: approving a saim_actions row runs its
-- executor, and "prepared, approved, not sent" cannot be expressed there
-- without changing approve for every other action type.
-- Outside the event log (like the findings it answers): a clock-driven
-- judgement plus a human decision, auditable through history_json.
--
-- ⚠ Build 6 (3 Oct 2026) REPLACED the Build 5 shape. One type — chase_commitment
-- — may now execute after an explicit approval of its exact payload. The Build 5
-- triggers that refused `executed` outright were DROPPED by
-- db/migrate-build6-actions.js, which rebuilds an existing table into this shape
-- (SQLite cannot widen a CHECK) and installs the Build 6 triggers in their
-- place: payload immutable, approval immutable, only an approved and
-- hash-matching row of an EXECUTABLE type can enter `executing`, terminal
-- states stay terminal, nothing is ever deleted. The triggers live in the
-- migration, not here, because they name columns an un-migrated table lacks.
CREATE TABLE IF NOT EXISTS prepared_actions (
  action_id             TEXT PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,  -- commitment + episode + type (+ #vN for an edit)
  finding_id            TEXT NOT NULL,
  commitment_id         TEXT NOT NULL,
  subject_ref           TEXT,                  -- the commitment's source ref, e.g. waiting-on:<key>
  action_type           TEXT NOT NULL,         -- registered in services/action-registry.js
  version               INTEGER NOT NULL DEFAULT 1,
  parent_action_id      TEXT,                  -- the version this one was edited from
  target_json           TEXT NOT NULL,         -- { personId, displayName, email, method }
  reason                TEXT NOT NULL,
  evidence_json         TEXT NOT NULL,
  evidence_hash         TEXT,
  draft_json            TEXT NOT NULL,         -- the exact words Nick approves
  payload_hash          TEXT NOT NULL,         -- what an approval binds to
  authority_class       TEXT NOT NULL CHECK (authority_class = 'A4'),
  approval_required     INTEGER NOT NULL DEFAULT 1 CHECK (approval_required = 1),
  status                TEXT NOT NULL CHECK (status IN ('prepared', 'approved', 'executing', 'execution_uncertain',
                          'executed', 'verified', 'failed', 'rejected', 'expired', 'cancelled', 'superseded')),
  created_at            TEXT NOT NULL,
  expires_at            TEXT,
  decided_at            TEXT,
  decision_note         TEXT,
  approved_by           TEXT,
  approved_at           TEXT,
  approved_payload_hash TEXT,
  approved_evidence_hash TEXT,
  approval_expires_at   TEXT,
  executed_at           TEXT,
  verified_at           TEXT,
  chase_recorded_at     TEXT,                  -- when waiting_on was told it was chased (once)
  last_check_at         TEXT,                  -- last verification check (operational)
  last_block            TEXT,                  -- last transient reason execution waited (operational)
  outcome_detail        TEXT,                  -- why it failed / is uncertain / was cancelled
  retry_safe            INTEGER,               -- 1 = proven not sent; 0 = may have been sent
  history_json          TEXT NOT NULL,         -- every transition, appended
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prepared_actions_status ON prepared_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_prepared_actions_finding ON prepared_actions(finding_id);

-- Build 6D: the execution ledger. ONE row per attempt, and `execution_key` is
-- UNIQUE — `exec:<action_id>:<approved payload hash>` — so a given approved
-- version can be attempted ONCE, ever. There is no automatic retry path: a
-- resend needs a new version, which needs a new approval. The draft's
-- internetMessageId is written BEFORE the send is requested, so every attempt
-- that could have sent anything carries the handle that verifies it.
CREATE TABLE IF NOT EXISTS action_attempts (
  attempt_id            TEXT PRIMARY KEY,      -- <action_id>#<attempt>
  action_id             TEXT NOT NULL,
  attempt               INTEGER NOT NULL,
  execution_key         TEXT NOT NULL UNIQUE,
  boot_id               TEXT NOT NULL,         -- which process claimed it
  started_at            TEXT NOT NULL,
  draft_id              TEXT,                  -- provider id of the draft created for this attempt
  internet_message_id   TEXT,                  -- the provider message id; the verification handle
  draft_created_at      TEXT,
  send_requested_at     TEXT,
  send_http_status      INTEGER,
  send_outcome          TEXT CHECK (send_outcome IN ('accepted', 'rejected', 'uncertain')),
  error_category        TEXT,                  -- auth | scope | http_4xx | http_5xx | timeout | network | no-handle | abandoned
  error_detail          TEXT,                  -- short, never message content
  retry_safe            INTEGER,               -- 1 = proven not sent
  finished_at           TEXT,
  final_state           TEXT,                  -- executed | execution_uncertain | failed
  UNIQUE (action_id, attempt)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_attempts_one_open ON action_attempts(action_id) WHERE finished_at IS NULL;
CREATE TRIGGER IF NOT EXISTS action_attempts_no_delete BEFORE DELETE ON action_attempts
BEGIN SELECT RAISE(ABORT, 'the execution ledger is append/audit only'); END;
-- A finished attempt is a record: nothing about it changes afterwards.
CREATE TRIGGER IF NOT EXISTS action_attempts_frozen BEFORE UPDATE ON action_attempts WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a finished attempt is immutable'); END;
-- The verification handle, once written, cannot be swapped for another.
CREATE TRIGGER IF NOT EXISTS action_attempts_handle_once BEFORE UPDATE ON action_attempts
  WHEN OLD.internet_message_id IS NOT NULL AND NEW.internet_message_id IS NOT OLD.internet_message_id
BEGIN SELECT RAISE(ABORT, 'an attempt''s message id is written once'); END;

-- Build 6F: every verification check whose OUTCOME changed (a repeated
-- identical answer only touches prepared_actions.last_check_at). Append-only.
CREATE TABLE IF NOT EXISTS action_verifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id             TEXT NOT NULL,
  attempt_id            TEXT NOT NULL,
  checked_at            TEXT NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('verified', 'not_found', 'ambiguous', 'provider_unavailable')),
  proof_json            TEXT NOT NULL          -- ids, recipient/subject/time/body match; never the body itself
);
CREATE INDEX IF NOT EXISTS idx_action_verifications_action ON action_verifications(action_id, id);
CREATE TRIGGER IF NOT EXISTS action_verifications_append_only_u BEFORE UPDATE ON action_verifications
BEGIN SELECT RAISE(ABORT, 'verification records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS action_verifications_append_only_d BEFORE DELETE ON action_verifications
BEGIN SELECT RAISE(ABORT, 'verification records are append-only'); END;

-- Build 5D: progress evidence about a commitment, folded by the world-model
-- consumer from observation.progress.evidence (rebuildable from event_log).
-- OBSERVATIONS only. The derived state (likely_fulfilled, contradicted, ...) is
-- computed at read time by progress-evidence.deriveProgress and NEVER written
-- back to wm_commitments.status: an inference is not a completion.
CREATE TABLE IF NOT EXISTS wm_progress_evidence (
  commitment_id     TEXT NOT NULL,
  kind              TEXT NOT NULL,           -- sent-email | later-note
  ref               TEXT NOT NULL,           -- message id | note path#Lline
  evidence_event_id TEXT NOT NULL,
  at                TEXT NOT NULL,           -- when the thing seen happened (sent / note date)
  polarity          TEXT NOT NULL,           -- done | progress | not-done
  strength          TEXT NOT NULL,           -- strong | partial
  provenance_kind   TEXT NOT NULL DEFAULT 'observation',
  reason            TEXT,                    -- the rule that matched, in words
  detail_json       TEXT,
  received_at       TEXT NOT NULL,
  PRIMARY KEY (commitment_id, kind, ref)
);

-- Build 4D: the commitment-at-risk evaluator's findings. Outside the event log
-- like meeting_context_findings: a clock-driven judgement over the projection.
-- One row per (commitment, episode). SHADOW only — the attention verdict is
-- recorded, never sent.
CREATE TABLE IF NOT EXISTS commitment_risk_findings (
  finding_id            TEXT PRIMARY KEY,    -- commitment-risk:<commitment id>:<episode>
  commitment_id         TEXT NOT NULL,
  episode               INTEGER NOT NULL,
  status                TEXT NOT NULL,       -- active | resolved
  level                 TEXT NOT NULL,       -- elevated | high
  triggers_json         TEXT NOT NULL,
  summary               TEXT NOT NULL,
  why                   TEXT NOT NULL,
  evidence_json         TEXT NOT NULL,
  unavailable_json      TEXT NOT NULL,
  checked_json          TEXT NOT NULL,
  confidence            REAL,
  due_context           TEXT,
  related_meeting_json  TEXT,
  recommended_at        TEXT,
  evidence_fingerprint  TEXT,
  novelty               TEXT NOT NULL,       -- new | repeated | escalated
  first_created_at      TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  resolved_at           TEXT,
  resolution            TEXT,
  attention_mode        TEXT,
  attention_decided_at  TEXT,
  attention_level       TEXT,                -- the level the recorded verdict was asked at
  attention_json        TEXT,
  decisions             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_commitment_risk_status ON commitment_risk_findings(status, commitment_id);

-- Build 3D: the meeting-context evaluator's findings. Outside the event log on
-- purpose (like source_blind_attention): it is a clock-driven judgement over
-- several stores. Each row names its evidence (task ids, waiting-on keys,
-- email ids, the world model's evidence event ids) and what it could NOT read,
-- plus what the attention policy would have done — SHADOW only, never sent.
CREATE TABLE IF NOT EXISTS meeting_context_findings (
  finding_id            TEXT PRIMARY KEY,        -- meeting-context:<meetingId>:<start>
  meeting_id            TEXT NOT NULL,
  title                 TEXT NOT NULL,
  start_local           TEXT NOT NULL,
  status                TEXT NOT NULL,           -- active | withdrawn | expired
  trigger_json          TEXT NOT NULL,
  evidence_json         TEXT NOT NULL,
  missing_json          TEXT NOT NULL,
  confidence            REAL,
  recommended_at_local  TEXT,
  summary               TEXT,
  evidence_fingerprint  TEXT,
  first_created_at      TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  attention_mode        TEXT,
  attention_decided_at  TEXT,
  attention_json        TEXT,
  decisions             INTEGER NOT NULL DEFAULT 0
);

-- Build 10C/10F: what Nick has DECLARED about a thing's place in his life.
-- Not a projection (never reset by a replay) and never inferred: a row exists
-- only because Nick set it. `entity_id` is a canonical id from the world model
-- (commitment:…, task:…, meeting:…, source:…, goal:…). `domains_json` is a
-- list of life-domain ids (shared/life-domains.cjs); `importance` is one of
-- work-critical | personally-important | restorative | optional, or NULL for
-- "not said" — which is NOT the same as optional.
CREATE TABLE IF NOT EXISTS life_annotations (
  entity_id     TEXT PRIMARY KEY,
  domains_json  TEXT,
  importance    TEXT,
  set_at        TEXT NOT NULL,
  set_via       TEXT NOT NULL DEFAULT 'neuro'
);

-- Build 10G: goals and intentions — a PLACEHOLDER contract. Only what Nick
-- has explicitly stored is ever shown; nothing creates a goal for him and
-- nothing turns one into a task or a nudge.
CREATE TABLE IF NOT EXISTS goals (
  goal_id      TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  domains_json TEXT,
  status       TEXT NOT NULL DEFAULT 'active',   -- active | paused | done | dropped
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ── Build 11: the personal world model ─────────────────────────────────────

-- 11B. What each CONTAINER a source delivers through is for, as Nick said.
-- A container is a calendar or a reminder list. NOT a projection (never reset
-- by a replay) and never inferred: a row exists only because Nick set it.
-- Applied at READ time, so reclassifying a calendar needs no replay.
--   kind        calendar | reminder-list
--   source_key  eventkit-cal:id:<calendarIdentifier>     (iOS builds after Build 11)
--               eventkit-cal:title:<lower-cased title>   (older builds: titles only,
--                                                        refused when two share one)
--               graph-cal:primary                        (the Outlook calendar)
--               reminders:id:<calendarIdentifier> / reminders:title:<title>
--   domains_json  [] or NULL = unknown — never a default
--   tracked     reminder lists only: 0 = not part of the world model at all
CREATE TABLE IF NOT EXISTS source_classifications (
  kind          TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  label         TEXT,
  domains_json  TEXT,
  tracked       INTEGER,
  set_at        TEXT NOT NULL,
  set_via       TEXT NOT NULL DEFAULT 'neuro',
  PRIMARY KEY (kind, source_key)
);

-- 11B. Which containers the sources have SHOWN — bookkeeping of the ingest,
-- so the classification screen can list every calendar and list by name even
-- when it has never had an event. Observed, never classified.
CREATE TABLE IF NOT EXISTS source_containers (
  kind           TEXT NOT NULL,
  source_key     TEXT NOT NULL,
  label          TEXT NOT NULL,
  container_id   TEXT,                -- the provider's identifier, when the client sent one
  provider       TEXT NOT NULL,       -- eventkit | graph
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  last_client    TEXT,
  PRIMARY KEY (kind, source_key)
);

-- 11F. Which world-model things a goal is about. Explicit only — Nick links
-- them; nothing links a task to a goal on wording.
CREATE TABLE IF NOT EXISTS goal_links (
  goal_id     TEXT NOT NULL,
  entity_id   TEXT NOT NULL,          -- task:… commitment:… person:… companion:… meeting:…
  relation    TEXT NOT NULL DEFAULT 'serves',
  set_at      TEXT NOT NULL,
  PRIMARY KEY (goal_id, entity_id)
);

-- 11F. Goals as the world model holds them — folded from intent.goal.declared,
-- so a replay rebuilds them from the log.
CREATE TABLE IF NOT EXISTS wm_goals (
  goal_id          TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  domains_json     TEXT,
  status           TEXT NOT NULL,        -- active | paused | achieved | dropped
  importance       TEXT,                 -- PersonalImportance, explicit, or NULL (not said)
  start_date       TEXT,
  review_date      TEXT,
  last_reviewed_at TEXT,
  links_json       TEXT NOT NULL DEFAULT '[]',
  provenance_kind  TEXT NOT NULL,        -- fact: Nick declared it
  observed_at      TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  fingerprint      TEXT,
  updated_at       TEXT NOT NULL
);

-- 11E. Non-human members of the household — Ember. Declared by a vault note
-- (frontmatter `type: pet`), never inferred. Deliberately NOT wm_people: a dog
-- has no email, no team and no 1-2-1, and forcing her into Person would let
-- every person rule (resolution, chase, work evidence) reach her.
CREATE TABLE IF NOT EXISTS wm_companions (
  companion_id     TEXT PRIMARY KEY,     -- companion:<slug>
  name             TEXT NOT NULL,
  species          TEXT,
  breed            TEXT,
  note_path        TEXT,
  household        INTEGER,              -- 1 / 0 / NULL (not stated)
  aliases_json     TEXT NOT NULL DEFAULT '[]',
  provenance_kind  TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  evidence_json    TEXT NOT NULL,
  fingerprint      TEXT,
  updated_at       TEXT NOT NULL
);

-- 11H. The first non-work evaluator: a personal deadline at risk. SHADOW —
-- the attention verdict is recorded, never sent. One row per (subject, episode).
CREATE TABLE IF NOT EXISTS personal_deadline_findings (
  finding_id            TEXT PRIMARY KEY,    -- personal-deadline:<subject id>:<episode>
  subject_id            TEXT NOT NULL,       -- task:… or commitment:…
  episode               INTEGER NOT NULL,
  status                TEXT NOT NULL,       -- active | resolved
  level                 TEXT NOT NULL,       -- elevated | high
  trigger_kind          TEXT NOT NULL,       -- due-today | due-tomorrow | overdue
  summary               TEXT NOT NULL,
  why                   TEXT NOT NULL,
  domains_json          TEXT NOT NULL,       -- the resolved domains AND their bases
  deadline_json         TEXT NOT NULL,       -- { date, basis, source }
  importance            TEXT,
  importance_basis      TEXT,                -- declared | goal | NULL
  evidence_json         TEXT NOT NULL,
  unavailable_json      TEXT NOT NULL,
  confidence            REAL,
  evidence_fingerprint  TEXT,
  novelty               TEXT NOT NULL,       -- new | repeated | escalated
  evaluator_version     TEXT NOT NULL,       -- stamped (Build 10 found nothing recorded it)
  first_created_at      TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  resolved_at           TEXT,
  resolution            TEXT,
  attention_mode        TEXT,
  attention_decided_at  TEXT,
  attention_level       TEXT,
  attention_json        TEXT,
  decisions             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_personal_deadline_status ON personal_deadline_findings(status, subject_id);

-- Build 12.3N — the P0 notification ledger: one semantic urgent item, one
-- notification, per device. `accepted` means iOS took the post, NEVER that it
-- reached the wrist; only `opened_at` proves a human saw it.
CREATE TABLE IF NOT EXISTS attention_notifications (
  dedupe_key   TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  channel      TEXT NOT NULL,
  item_id      TEXT,
  synthetic    INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT NOT NULL,
  claimed_at   TEXT NOT NULL,
  accepted_at  TEXT,
  failed_at    TEXT,
  opened_at    TEXT,
  dismissed_at TEXT,
  detail       TEXT,
  UNIQUE(dedupe_key, device_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_attention_notifications_claimed ON attention_notifications(claimed_at);

-- Build 13K — the ledger for DIRECT external writes (A2/A3: no approval, but
-- they still leave the building). One row per idempotency key: written BEFORE
-- the call, settled after it. `uncertain` blocks a repeat until verified —
-- an unknown outcome is never retried by the same request.
CREATE TABLE IF NOT EXISTS external_write_ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  writer           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  target           TEXT NOT NULL,
  authority        TEXT NOT NULL,
  initiated_by     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('requested','confirmed','applied-unverified','failed','uncertain')),
  attempts         INTEGER NOT NULL DEFAULT 1,
  request_json     TEXT NOT NULL,
  result_json      TEXT,
  readback         TEXT,
  requested_at     TEXT NOT NULL,
  settled_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_external_write_ledger_writer ON external_write_ledger(writer, requested_at);

-- Build 13H — who is home, projected from observation.presence.changed by the
-- world-model consumer (replayable). One row per configured HA entity; `state`
-- is a class, never a place name or a coordinate.
CREATE TABLE IF NOT EXISTS wm_presence (
  entity_id        TEXT PRIMARY KEY,
  subject_kind     TEXT NOT NULL,
  state            TEXT NOT NULL,
  who_json         TEXT NOT NULL DEFAULT '[]',
  unreadable_json  TEXT NOT NULL DEFAULT '[]',
  members_json     TEXT NOT NULL DEFAULT '[]',
  observed_at      TEXT,
  received_at      TEXT NOT NULL,
  event_id         TEXT,
  why              TEXT
);

-- ── Bounded autonomous investigations (Build 14G, 6 Oct 2026) ──────────────
-- One row per investigation. The first and only supported type is
-- source_blindness: one per source outage EPISODE (dedupe_key = type + source
-- + the finding id, which is source + the seq that opened it). Evidence and
-- hypotheses are STRUCTURED JSON (probe, signal, refs) — never free reasoning.
CREATE TABLE IF NOT EXISTS investigations (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  subject_ref          TEXT NOT NULL,
  trigger_ref          TEXT NOT NULL,
  trigger_signature    TEXT,
  dedupe_key           TEXT NOT NULL UNIQUE,
  started_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  completed_at         TEXT,
  evidence_json        TEXT NOT NULL DEFAULT '[]',
  hypotheses_json      TEXT NOT NULL DEFAULT '[]',
  confidence           REAL,
  decision             TEXT,
  recommended_action   TEXT,
  prepared_action_json TEXT,
  stop_reason          TEXT,
  budget_json          TEXT,
  expires_at           TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_investigations_open ON investigations(state);

-- Append-only audit of every transition. Refs, not copies of sensitive data.
CREATE TABLE IF NOT EXISTS investigation_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL,
  at               TEXT NOT NULL,
  transition       TEXT NOT NULL,
  from_state       TEXT,
  to_state         TEXT,
  detail_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_investigation_events_inv ON investigation_events(investigation_id, id);
CREATE TRIGGER IF NOT EXISTS investigation_events_no_update BEFORE UPDATE ON investigation_events
BEGIN SELECT RAISE(ABORT, 'investigation_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS investigation_events_no_delete BEFORE DELETE ON investigation_events
BEGIN SELECT RAISE(ABORT, 'investigation_events is append-only'); END;

-- Build 15H–N — safe self-healing. One row per (outage, fix kind): the UNIQUE
-- index IS the no-loop guarantee. Written BEFORE the op runs; verified from
-- SourceHealth + the blindness fold, never from the op's own return value.
CREATE TABLE IF NOT EXISTS self_heal_attempts (
  attempt_id        TEXT PRIMARY KEY,          -- heal:<findingId>:<fixKind>
  outage_key        TEXT NOT NULL,             -- the source-blind finding id (one episode)
  fix_kind          TEXT NOT NULL,             -- self-heal ALLOWLIST kind
  op                TEXT NOT NULL,             -- the named, typed operation
  investigation_id  TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  authority         TEXT NOT NULL,             -- read from the authority matrix
  capability        TEXT NOT NULL,
  hypothesis        TEXT,
  confidence        REAL,
  status            TEXT NOT NULL CHECK (status IN ('requested','executing','verifying','recovered','failed','uncertain','cancelled')),
  boot_id           TEXT,
  requested_at      TEXT NOT NULL,
  started_at        TEXT,
  executed_at       TEXT,
  op_outcome        TEXT,                      -- ok | error | unknown
  op_detail         TEXT,
  verify_by         TEXT,
  verified_at       TEXT,
  verification_json TEXT,
  reason            TEXT,
  UNIQUE (outage_key, fix_kind)
);
CREATE TRIGGER IF NOT EXISTS self_heal_attempts_no_delete BEFORE DELETE ON self_heal_attempts
BEGIN SELECT RAISE(ABORT, 'self_heal_attempts is an audit ledger'); END;
CREATE TRIGGER IF NOT EXISTS self_heal_attempts_terminal BEFORE UPDATE ON self_heal_attempts
  WHEN OLD.status IN ('recovered','failed','uncertain','cancelled')
BEGIN SELECT RAISE(ABORT, 'a settled self-heal attempt is immutable'); END;

-- Build 15S–X — the "hike weekly" loop. Nick's own statements (a hike he
-- confirms, one he plans) and the loop's meaningful transitions. Never sensor
-- samples, never every recompute: dedupe_key makes each transition once.
CREATE TABLE IF NOT EXISTS goal_loop_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('confirm','plan')),
  day           TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  withdrawn_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_loop_entries_goal ON goal_loop_entries(goal_id, day);
-- Build 17A: Nick saying a day was NOT a hike — his word beats a GPS track.
-- Its own table because goal_loop_entries.kind carries a CHECK that SQLite
-- cannot widen without a rebuild.
CREATE TABLE IF NOT EXISTS goal_loop_denials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       TEXT NOT NULL,
  day           TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  withdrawn_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_loop_denials_goal ON goal_loop_denials(goal_id, day);

-- Build 17L: personal dates with lead time. The dates themselves are computed
-- at read time from the calendar and Nick's notes (no second calendar); this
-- holds only what CHANGED (prep linked / completed, the action window) and
-- what the attention policy said, once each. Append-only.
CREATE TABLE IF NOT EXISTS personal_date_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- prep-linked | prep-completed | action-window | attention | lead-set
  dedupe_key  TEXT NOT NULL UNIQUE,
  actor       TEXT NOT NULL,          -- neuro | nick
  at          TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_date_events_at ON personal_date_events(at);
CREATE TRIGGER IF NOT EXISTS personal_date_events_no_update BEFORE UPDATE ON personal_date_events
BEGIN SELECT RAISE(ABORT, 'personal_date_events is append-only'); END;
CREATE TABLE IF NOT EXISTS goal_loop_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     TEXT NOT NULL,
  week_start  TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- planned | achieved | likely | recording-uncertain | reminder-prepared
  dedupe_key  TEXT NOT NULL UNIQUE,
  actor       TEXT NOT NULL,          -- neuro | nick
  at          TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_loop_events_at ON goal_loop_events(at);
CREATE TRIGGER IF NOT EXISTS goal_loop_events_no_update BEFORE UPDATE ON goal_loop_events
BEGIN SELECT RAISE(ABORT, 'goal_loop_events is append-only'); END;

-- ── Build 18D: which native build is talking ──────────────────────────────
-- One row per distinct (client, version, build, commit) a native app has
-- reported in its X-Neuro-Build header. first_seen_at is "this build was
-- installed and ran"; last_seen_at is touched at most every 10 minutes.
-- Nothing about the device is stored — a build describes a binary.
CREATE TABLE IF NOT EXISTS native_builds (
  build_key         TEXT PRIMARY KEY,
  client            TEXT NOT NULL,
  version           TEXT,
  build             TEXT,
  git_commit        TEXT,
  dirty             INTEGER NOT NULL DEFAULT 0,
  protocol          INTEGER,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_builds_client ON native_builds(client, last_seen_at);

-- ── Build 19: personal operations and the Future Radar ───────────────────
-- 19T/19P. EXPLICIT links Nick makes between a personal subject (a personal
-- date occurrence `pd:…`, a calendar entry `meeting:…`, a person or companion)
-- and the task/commitment that prepares for it. Nothing writes this table
-- except the route he calls; nothing links on wording.
CREATE TABLE IF NOT EXISTS personal_links (
  subject_id  TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  relation    TEXT NOT NULL DEFAULT 'prepares',
  set_at      TEXT NOT NULL,
  PRIMARY KEY (subject_id, entity_id)
);

-- 19W. What CHANGED in Nick's personal operations, for Activity. One row per
-- transition (a list classified, a goal link added, an obligation opened or
-- completed, a Radar item that started needing him) — never per read.
CREATE TABLE IF NOT EXISTS personal_ops_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  subject_id  TEXT,
  actor       TEXT NOT NULL,          -- neuro | nick
  dedupe_key  TEXT NOT NULL UNIQUE,
  at          TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_ops_events_at ON personal_ops_events(at);
CREATE TRIGGER IF NOT EXISTS personal_ops_events_no_update BEFORE UPDATE ON personal_ops_events
BEGIN SELECT RAISE(ABORT, 'personal_ops_events is append-only'); END;

-- ── Build 20: Ember care + personal-operations activation ─────────────────
-- 20F. Care items Nick EXPLICITLY creates for a companion (Ember). Nothing
-- generates a row: no vet interval, flea cycle or worming schedule is assumed.
-- A next date is calculated ONLY from a recurrence Nick entered, and from the
-- day he marked the item done.
CREATE TABLE IF NOT EXISTS companion_care_items (
  care_id         TEXT PRIMARY KEY,           -- care:<uuid>
  companion_id    TEXT NOT NULL,              -- companion:<slug>
  kind            TEXT NOT NULL CHECK (kind IN ('walk','vet','vaccination','flea','worm','medication','grooming','insurance','other')),
  title           TEXT NOT NULL,
  due_date        TEXT,                       -- YYYY-MM-DD as Nick gave it; NULL = no date
  due_time        TEXT,                       -- HH:MM wall clock, optional
  recurrence_json TEXT,                       -- {"every":N,"unit":"day|week|month|year"} only as Nick entered it
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companion_care_items_companion ON companion_care_items(companion_id, status);

-- 20F. Every time Nick marks a care item done. Append-only: the history of
-- care is never rewritten.
CREATE TABLE IF NOT EXISTS companion_care_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  care_id       TEXT NOT NULL,
  companion_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  done_on       TEXT NOT NULL,                -- YYYY-MM-DD local
  due_was       TEXT,
  next_due      TEXT,                         -- only when Nick gave a recurrence
  at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companion_care_log_companion ON companion_care_log(companion_id, done_on);
CREATE TRIGGER IF NOT EXISTS companion_care_log_no_update BEFORE UPDATE ON companion_care_log
BEGIN SELECT RAISE(ABORT, 'companion_care_log is append-only'); END;

-- 20G. EXPLICIT links from a task / reminder / calendar entry / commitment /
-- personal date to a companion's care. A title that says "Ember" is a
-- MENTION and never creates a row here.
CREATE TABLE IF NOT EXISTS companion_links (
  companion_id  TEXT NOT NULL,
  entity_id     TEXT NOT NULL,                -- task:… commitment:… meeting:… pd:…
  care_kind     TEXT NOT NULL,
  set_at        TEXT NOT NULL,
  PRIMARY KEY (companion_id, entity_id)
);

-- 20H. Nick's own word about a day's walk: walked, or not applicable (she was
-- away, kennels, poorly). Never written from a sensor, a workout or a place.
CREATE TABLE IF NOT EXISTS companion_walk_marks (
  companion_id  TEXT NOT NULL,
  day           TEXT NOT NULL,                -- YYYY-MM-DD local
  mark          TEXT NOT NULL CHECK (mark IN ('walked','not-applicable')),
  set_at        TEXT NOT NULL,
  PRIMARY KEY (companion_id, day)
);

-- Lead reminders (8 Oct 2026): the cadence Nick SETS per kind of personal
-- date (anniversary: [10,5,1]). First step = Radar context, last = Needs You
-- and the one push. Nothing sets a row except his route (date-nags.js).
CREATE TABLE IF NOT EXISTS personal_date_nags (
  nag_key       TEXT PRIMARY KEY,             -- kind:<birthday|anniversary|other>
  title         TEXT NOT NULL,
  offsets_json  TEXT NOT NULL,                -- [10,5,1] days before
  set_at        TEXT NOT NULL
);
-- One row per nag SENT: claimed before the push, released only if it throws.
CREATE TABLE IF NOT EXISTS personal_date_nag_sends (
  send_key     TEXT PRIMARY KEY,              -- <date id incl. year>@needs_you
  nag_key      TEXT NOT NULL,
  date         TEXT NOT NULL,
  offset_days  INTEGER NOT NULL,
  at           TEXT NOT NULL
);
-- Medical records (8 Oct 2026) — test results, diagnoses and prescriptions as
-- the NHS app shows them, from a confirmed screenshot read or a structured post
-- (ChatGPT over MCP). services/medical-records.js is the only writer. Values are
-- TRANSCRIBED (value_text as shown; value_num only for a plain number) and flag
-- is what the record states, never derived. NOT in the vault, NOT embedded.
-- dedupe_key = kind|name_key|record_date; a changed resend keeps the replaced
-- content in previous_json.
CREATE TABLE IF NOT EXISTS medical_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('test_result', 'diagnosis', 'prescription')),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  record_date TEXT,
  date_precision TEXT,
  value_text TEXT,
  value_num REAL,
  unit TEXT,
  reference_range TEXT,
  flag TEXT,
  status TEXT,
  panel TEXT,
  code TEXT,
  dose TEXT,
  directions TEXT,
  quantity TEXT,
  notes TEXT,
  follow_up TEXT,
  source TEXT,
  content_json TEXT NOT NULL,
  previous_json TEXT,
  entered_via TEXT NOT NULL,
  entered_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_medical_records_kind ON medical_records(kind, record_date);
CREATE INDEX IF NOT EXISTS idx_medical_records_name ON medical_records(name_key, record_date);

-- ── Build 21: vehicle intelligence + Tally finance (read-only) ────────────────
-- services/vehicle.js is the only writer of the vehicle tables. Every fact
-- carries its source and provenance; nothing here is inferred from a model
-- name, a price average or a merchant alone.
CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id        TEXT PRIMARY KEY,           -- vehicle:<slug>
  make              TEXT,
  model             TEXT,
  plate_descriptor  TEXT,                       -- e.g. "65-plate", as Nick said it
  registration      TEXT,                       -- NULL until Nick gives it
  variant           TEXT,                       -- engine/trim; NULL = not known
  fuel_type         TEXT,
  ownership_state   TEXT NOT NULL DEFAULT 'current' CHECK (ownership_state IN ('current','sold','scrapped','unknown')),
  source            TEXT NOT NULL,
  provenance_json   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
-- Odometer readings. Current mileage = the latest TRUSTWORTHY reading, never
-- the largest; an implausible one is kept and flagged, never corrected.
CREATE TABLE IF NOT EXISTS vehicle_mileage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id      TEXT NOT NULL,
  value           REAL NOT NULL,
  unit            TEXT NOT NULL CHECK (unit IN ('mi','km')),
  observed_on     TEXT NOT NULL,                -- YYYY-MM-DD
  source          TEXT NOT NULL CHECK (source IN ('manual','mot','service','tally','telemetry')),
  provenance_json TEXT,
  confidence      TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  correction      INTEGER NOT NULL DEFAULT 0,   -- Nick says the odometer was corrected/replaced
  note            TEXT,
  recorded_at     TEXT NOT NULL,
  withdrawn_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicle_mileage_vehicle ON vehicle_mileage(vehicle_id, observed_on);
-- History: service, repairs, tyres… Explicit only — a garage payment never
-- creates one by itself.
CREATE TABLE IF NOT EXISTS vehicle_events (
  event_id        TEXT PRIMARY KEY,             -- vev:<uuid>
  vehicle_id      TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('scheduled_service','repair','tyres','battery','brakes','exhaust','suspension','mot_work','other')),
  event_date      TEXT NOT NULL,
  mileage         REAL,
  description     TEXT NOT NULL,
  cost_pence      INTEGER,
  cost_ref        TEXT,                         -- tally:<id> when the cost is a Tally transaction
  detail_json     TEXT,                         -- tyres: axle/position/brand/model as stated
  source          TEXT NOT NULL,
  provenance_json TEXT,
  recorded_at     TEXT NOT NULL,
  withdrawn_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_vehicle_events_vehicle ON vehicle_events(vehicle_id, event_date);
-- Typed vehicle FACTS (MOT expiry, renewal dates). The action (book it, pay
-- it) stays a task or reminder, linked here; completing the task never
-- completes the fact.
CREATE TABLE IF NOT EXISTS vehicle_obligations (
  obligation_id       TEXT PRIMARY KEY,         -- vob:<uuid>
  vehicle_id          TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('mot','insurance','service','warranty','breakdown_cover','tax')),
  due_date            TEXT,
  due_mileage         REAL,
  interval_months     INTEGER,
  interval_miles      REAL,
  interval_basis      TEXT,                     -- what Nick said the interval came from; NULL = no interval
  linked_task_ref     TEXT,
  linked_reminder_ref TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','cancelled')),
  completed_on        TEXT,
  completion_evidence TEXT,
  source              TEXT NOT NULL,
  provenance_json     TEXT,
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_obligations_open ON vehicle_obligations(vehicle_id, type) WHERE status = 'open';
-- What an official source said, when. Never copied over a NEURO value.
CREATE TABLE IF NOT EXISTS vehicle_official_checks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id       TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('dvla-ves','dvsa-mot','gov-uk-by-hand')),
  checked_at       TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('ok','not-found','error','unavailable')),
  tax_status       TEXT,
  tax_due_date     TEXT,
  mot_status       TEXT,
  mot_expiry_date  TEXT,
  reason           TEXT,
  raw_json         TEXT,
  entered_by       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicle_official_checks ON vehicle_official_checks(vehicle_id, checked_at);
-- Tally read model: ONLY transactions that look like motoring (or that a rule
-- Nick confirmed matches). Household spending is never copied here. Tally is
-- the source of truth; source_txn_id is Tally's own transactions.id.
CREATE TABLE IF NOT EXISTS tally_vehicle_txns (
  source_txn_id  INTEGER PRIMARY KEY,
  txn_date       TEXT NOT NULL,
  amount_pence   INTEGER NOT NULL,              -- Tally's sign: negative = spend
  description    TEXT NOT NULL,
  merchant_key   TEXT,
  channel        TEXT,                          -- e.g. 'zilch' (pay-later) when the description says so
  category_name  TEXT,
  account_name   TEXT,
  account_owner  TEXT,
  candidate_json TEXT,                          -- why it might be motoring, proposed type, confidence
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  in_source      INTEGER NOT NULL DEFAULT 1     -- 0 = Tally no longer lists it
);
CREATE INDEX IF NOT EXISTS idx_tally_vehicle_txns_date ON tally_vehicle_txns(txn_date);
CREATE TABLE IF NOT EXISTS vehicle_spend_decisions (
  source_txn_id  INTEGER PRIMARY KEY,
  decision       TEXT NOT NULL CHECK (decision IN ('vehicle','not-vehicle','unknown')),
  spend_type     TEXT,
  vehicle_id     TEXT,
  basis          TEXT NOT NULL CHECK (basis IN ('confirmed-once','rule')),
  rule_id        TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicle_spend_rules (
  rule_id        TEXT PRIMARY KEY,              -- vsr:<uuid>
  match_kind     TEXT NOT NULL CHECK (match_kind IN ('merchant','category','merchant+category')),
  merchant_key   TEXT,
  category_name  TEXT,
  spend_type     TEXT NOT NULL,
  vehicle_id     TEXT NOT NULL,
  scope          TEXT,
  examples_json  TEXT,
  confirmed_by   TEXT NOT NULL,
  confirmed_at   TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS vehicle_monthly_summaries (
  month        TEXT PRIMARY KEY,                -- YYYY-MM
  vehicle_id   TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  produced_at  TEXT NOT NULL
);

-- ── Build 23: Finance activation ──────────────────────────────────────────────
-- Tally is the source of truth and NEURO keeps no copy of its ledger. These
-- tables hold only Nick's own statements and what NEURO derived per month.
CREATE TABLE IF NOT EXISTS finance_rules (
  rule_id                 TEXT PRIMARY KEY,
  match_kind              TEXT NOT NULL CHECK (match_kind IN ('merchant', 'merchant+category', 'tag')),
  merchant_key            TEXT,
  category_name           TEXT,
  tag                     TEXT,
  domain                  TEXT NOT NULL,
  example_txn_id          INTEGER,
  matched_at_confirmation INTEGER,
  confirmed_by            TEXT NOT NULL,
  confirmed_at            TEXT NOT NULL,
  active                  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS finance_txn_decisions (
  source_txn_id  INTEGER PRIMARY KEY,                -- Tally transactions.id; nothing else about the row is copied
  decision       TEXT NOT NULL CHECK (decision IN ('confirm', 'reject', 'unknown')),
  domain         TEXT,
  rule_id        TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_recurring_decisions (
  series_key  TEXT PRIMARY KEY,
  decision    TEXT NOT NULL CHECK (decision IN ('recurring', 'not-recurring')),
  decided_by  TEXT NOT NULL,
  decided_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_review_decisions (
  item_key    TEXT PRIMARY KEY,
  decision    TEXT NOT NULL CHECK (decision IN ('expected', 'not-duplicate', 'leave', 'look-into-it')),
  decided_by  TEXT NOT NULL,
  decided_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_obligations (
  obligation_id          TEXT PRIMARY KEY,
  kind                   TEXT NOT NULL CHECK (kind IN ('renewal', 'bill', 'annual_fee', 'subscription_renewal', 'household_charge', 'other')),
  title                  TEXT NOT NULL,
  due_date               TEXT,
  expected_amount_pence  INTEGER,
  series_key             TEXT,
  requires_decision      INTEGER NOT NULL DEFAULT 0,
  scope                  TEXT NOT NULL DEFAULT 'household',
  linked_task_ref        TEXT,
  linked_reminder_ref    TEXT,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  resolved_evidence      TEXT,
  resolved_note          TEXT,
  resolved_at            TEXT,
  provenance             TEXT NOT NULL,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_monthly_summaries (
  month         TEXT PRIMARY KEY,                    -- YYYY-MM
  complete      INTEGER NOT NULL,
  summary_json  TEXT NOT NULL,                       -- aggregates only; Helen's account as a total
  computed_at   TEXT NOT NULL,
  revisions     INTEGER NOT NULL DEFAULT 0
);

-- ── Build 24: personal projects ─────────────────────────────────────────────
-- A project is not a repo: repos, vault notes and tasks are EVIDENCE about a
-- project. These tables hold identity, bounded GitHub metadata, Nick's explicit
-- statements and links. There is no project-task store: tasks stay in `tasks`
-- and are only LINKED. No source code, diff, file path or secret is stored.
CREATE TABLE IF NOT EXISTS projects (
  project_id    TEXT PRIMARY KEY,                    -- p:<slug of vault folder> | p:repo-<github id>
  name          TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('vault', 'declared')),
  vault_path    TEXT,                                -- Projects/<Folder>
  repo_origin   INTEGER,                             -- github repo id when declared from a repo
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  removed_at    TEXT,                                -- vault folder gone: kept, never deleted
  derived_json  TEXT                                 -- last derived state, for change detection only
);
CREATE TABLE IF NOT EXISTS project_repos (
  repo_id        INTEGER PRIMARY KEY,                -- GitHub's stable numeric id
  full_name      TEXT NOT NULL,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  private        INTEGER NOT NULL DEFAULT 1,
  archived       INTEGER NOT NULL DEFAULT 0,
  fork           INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  pushed_at      TEXT,
  open_issues    INTEGER,
  open_prs       INTEGER,
  description    TEXT,
  html_url       TEXT,
  local_paths    TEXT,                               -- JSON: checkouts on the reporting machine whose origin is this repo
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_repo_evidence (
  repo_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('commit', 'pr-merged', 'issue-closed', 'release', 'deployment')),
  ref         TEXT NOT NULL,                         -- short sha | #number | tag | deployment id
  at          TEXT NOT NULL,
  title       TEXT,                                  -- commit subject / PR / issue / release title, bounded
  meaningful  INTEGER NOT NULL DEFAULT 0,
  why         TEXT,                                  -- why it is or is not meaningful progress
  detail_json TEXT,                                  -- file CLASS counts only, never paths
  UNIQUE (repo_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_project_repo_evidence_repo_at ON project_repo_evidence (repo_id, at);
-- Nick's explicit statements: sphere / status / importance / pinned next task,
-- about a project ('project:<id>'), a repo ('repo:<id>') or an org ('owner:<login>').
CREATE TABLE IF NOT EXISTS project_statements (
  subject     TEXT PRIMARY KEY,
  sphere      TEXT CHECK (sphere IS NULL OR sphere IN ('personal', 'work', 'other', 'unknown')),
  status      TEXT CHECK (status IS NULL OR status IN ('active', 'paused', 'parked', 'blocked', 'completed', 'abandoned', 'unknown')),
  importance  TEXT CHECK (importance IS NULL OR importance IN ('high', 'normal', 'low')),
  next_task_id INTEGER,
  set_at      TEXT NOT NULL
);
-- Nick's explicit repo links and rejections. Derived links are computed live.
CREATE TABLE IF NOT EXISTS project_repo_links (
  project_id  TEXT NOT NULL,
  repo_id     INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('confirmed', 'rejected')),
  role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'secondary')),
  set_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, repo_id)
);
-- Explicit task links (Nick). Path- and name-based links are computed live.
CREATE TABLE IF NOT EXISTS project_task_links (
  project_id  TEXT NOT NULL,
  task_id     INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'linked' CHECK (state IN ('linked', 'unlinked')),
  set_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, task_id)
);
CREATE TABLE IF NOT EXISTS project_blockers (
  blocker_id    TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  what          TEXT NOT NULL,
  unblock       TEXT,                                -- what would unblock it
  owner         TEXT NOT NULL DEFAULT 'nick' CHECK (owner IN ('nick', 'other')),
  task_id       INTEGER,                             -- the task that resolves it, if one exists
  source        TEXT NOT NULL,                       -- 'you' | a vault path
  since         TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  resolved_at   TEXT,
  resolution    TEXT
);
