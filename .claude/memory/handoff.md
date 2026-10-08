# Session Handoff — 2026-10-08 (Build 23: Finance activation)

- DEPLOYED: origin/main + pi5 at cfde836 (gate 5782/0, gateway rebuilt). NatWest reconnect was already done (13:26) → live validation done: Nick/Joint/Bills relinked and healthy, backfill from 29 Jun, 0 double imports; Helen stale → household partial. Live fixes: relink = data older than the link (Tally deleted the dead connection), unpaired transfers to Helen kept as transfers (45 rows), live-accounts month comparison. Follow-up ledger applied (#380–#387 linked, 0 created). #380 can be ticked; #388 unblocked.
- Validated on the real Tally read: 4 complete months (Feb–May, ~£4.3–4.6k spending), 34 strong recurring, E.ON down / Virgin up, 53% of spending has a domain, 87/122 Tally auto-rules keyed on card+date, 0 Helen merchants leaked, feed reconnect_required on all 4 accounts.
- Follow-ups: all already real tasks (#380–#388 by Sara). Personal Admin list now on the phone (12:44), unclassified, untracked = #382.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 23 Finance Activation.md; gap analysis appended. Next domain: Personal projects.

---

# Session Handoff — 2026-10-08 (Build 22: Household/Home + Tally security)

- Deployed nuero dfbdef2 + 0fc5244 to pi5 (gate 5753 / 5736 pass / 0 fail, frontend built, neuro-backend restarted, MCP gateway rebuilt). Built in worktree `nuero-b22`. Record: vault Projects/NEURO/NEURO-SAIM — Build 22 Household Home and Tally Security.md.
- Tally (finance 66b0622 + fcf398a, on pi-dev by copy): JWT secret now real (settings.json, generated on pi-dev, never printed); production refuses to start without one; forged/old tokens 401, new + MCP login 200. finance commits NOT pushed to GitHub — Nick's call.
- TrueLayer: both NatWest connections dead since 27 Jun (invalid_grant). Reconnect code deployed (relink + immediate sync from newest txn). WAITING ON NICK: Settings → TrueLayer → Connect bank (his NatWest, then Helen's). Then verify relink/retire/newest dates/24 Jun–10 Jul backfill.
- Live home: occupied, 1 household task (test reminder), 5 offline devices, 0 low batteries, no hazard sensors, Needs You empty.
- For Nick: reclassify Bathroom + Ikea to Home (recommended, not done); Personal Admin list not on the phone yet.
- Next domain recommended: Finance (after the reconnect).
- Main tree still behind origin with another session's uncommitted training-sync removal — untouched.

---

# Session Handoff — 2026-10-08 (Build 21: vehicle intelligence + Tally finance ingestion)

- Deployed nuero 9a4ae3f + 133e6be to pi5 (gate 5736/0, frontend built, neuro-backend restarted, MCP gateway rebuilt). Built in worktree `nuero-b21` (own `npm ci --ignore-scripts`). Record: vault Projects/NEURO/NEURO-SAIM — Build 21 Vehicle Intelligence and Tally Finance Ingestion.md; gap analysis appended.
- Live: all 7 reminder lists tracked (21A done). Captur created (Renault, 65-plate, diesel; reg/mileage/dates unknown). First Tally read: 1,150 → 44 kept, 43 awaiting Nick, 0 confirmed. No Personal Admin list on the phone yet.
- ⚠ Tally JWT secret is the public fallback 'dev-insecure-secret' (finance repo auth.ts:16) and Tally is public — told Nick; NOT changed (Build 21 forbids Tally changes). Tally's TrueLayer sync dead since 26 Jun.
- ⚠ Main tree `node_modules` was broken at 11:15 (unmet deps everywhere, likely another session's install ~10:25). I restored only array-flatten@1.1.1 there. Whoever owns that tree: `npm ci --ignore-scripts` fixes it (better-sqlite3 13 ships prebuilds; a source build fails on Node 25 ARM64).
- Other session's training-sync removal still uncommitted in the main tree — untouched.
- Next: Nick's ten minutes (vault note §21), then Build 22 = Household/Home.

---

# Session Handoff — 2026-10-08 (Build 20: Ember care + personal-ops activation + anniversary lead reminders)

- Deployed nuero caf5ac9 then 4222399 to pi5 (gate 5678/0, gateway 49/0, frontend built, MCP gateway rebuilt). Record: vault Projects/NEURO/NEURO-SAIM — Build 20 Ember Care and Personal Operations Activation.md; gap analysis appended.
- Reminder lists: name rule GONE. Live: Alexa Shopping List, Family, Shopping tracked; both "Reminders" (List 1/2 of 2), Bathroom, Ikea UNDECIDED until Nick chooses — the one reminder NEURO used to read is hidden until he tracks List 1.
- Open Uni reclassified Home -> Learning (as Nick). Anniversary lead reminders [10,5,1] set live: Radar context from 9 Oct, prompt 14 Oct, one push 18 Oct 09:00 unless linked prep is done.
- Waiting on Nick's data: Personal Admin list + MOT/insurance dates, Ember care items, anniversary prep task. Next domain recommended: transport/vehicle.
- ⚠ The MAIN working tree (C:/Users/NickW/Claude/nuero) is behind origin and holds another session's uncommitted training-sync removal, which overlaps scheduler.js, authority-matrix.js, api-inventory.json and CLAUDE.md that Build 20 changed: stash, pull --ff-only, pop, then regenerate the inventory. Build 20 was built in worktree C:/Users/NickW/Claude/nuero-b20 (branch build20) — remove it once main is synced.
- nuero-63 (medical records session) was told to rebase onto 4222399 and regenerate the inventory.

---

# Session Handoff — 2026-10-08 (Build 18 follow-up: NEURO iOS launch crash)

- SAiM 0.1 (241) installed and reporting: build identity, device status, 60-day calendar coverage and personal-date coverage all PROVEN live. It was built from a DIRTY Mac tree (77f90fc + uncommitted changes) — check `git status` on the Mac first.
- NEURO iOS crashes on launch: CLMonitor.init NSAssertion from LocationTracker.startMonitor (geofencing, first real run, iOS 27.0). Fix nuero-ios a50b5fa = geofencing OFF by default (`neuro.geofence.enabled`), unbuilt. Server 16e75de (live) judges geofence only as a place capability.
- EVENING: on the Mac — sort the dirty tree, `git pull && bash reinstall.sh neuro`, open NEURO, confirm /api/setup/native shows its commit and location/health/calendar go fresh. Then run NEURO from Xcode with the switch on to read the CLMonitor assertion text, before re-enabling geofences. Rest of runbook: docs/build-18-mac-runbook.md.

---

# Session Handoff — 2026-10-08 (Build 19: personal operations + Future Radar)

- Deployed nuero a0af05c to pi5 (gate 5642/0, frontend built, neuro-backend restarted, MCP gateway container rebuilt). Live: /api/canonical/radar?days=7|14|30, /reminder-lists, /obligations, /personal-admin; Life page has Future Radar, Personal admin, Reminder lists cards; Now carries a 7-day `radar` block.
- Committed via a clean worktree (HEAD + Build 19 only) because ANOTHER SESSION's training-sync removal is still uncommitted in this tree (server.js, scheduler.js comment, authority-matrix line, mcp-server/index.js, api-inventory training entries, CLAUDE.md row, staged deletions). Left untouched; they must regenerate the inventory when they commit.
- Live facts: phone sends 2 reminders across 7 lists; 0 personal-admin data; Radar 30d = 5 hikes + anniversary 19 Oct + Julie 25 Oct, nothing needs action. Per-list reminder counts appear after the next push.
- For Nick: both "Reminders" lists ride the built-in-name rule; Bathroom/Ikea classified but not read; Open Uni classified Home. Next domain recommended: Ember/care (not built).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 19 Personal Operations and Future Radar.md; gap analysis appended.

---

# Session Handoff — 2026-10-07 (Build 18: native identity + personal-data integrity — SERVER HALF)

- Mac OFFLINE all session → NOTHING native proven. Build 18 is NOT complete. Do docs/build-18-mac-runbook.md on the Mac (18A–18M), record evidence in vault Build 18 note § Mac day.
- nuero 709b3a4 (Pi gate 5528/0, frontend built on Pi); weather session's f29e06a on top, THEY own the restart. nuero-ios 77f90fc pushed, UNBUILT (X-Neuro-Build, 60-day calendar window + kinds, route permission report, reinstall.sh stamps commit/dirty/commit-count).
- New: /api/setup/native (builds + capability states + visits/geofence), /api/apple/calendar/coverage, /api/loops/personal-dates/{entities,declared}. Setup: build items, SAiM device status, workout routes (done only when a route arrives).
- Live facts: 0 visits/region events ever, 0/53 workouts with a route, phone diary pushed only 15 days (4 events) — thin is explained, not proven broken.
- Degradation replay 17 Aug–7 Oct: threshold 3 → 0 investigations; left unchanged.
- After the Mac day: flip device.saim-ios to expected in native-sources.js.
- Shared working tree: cron-once.js + scheduler hunk (another session) still uncommitted; runtime-jobs "wraps every node-cron job" fails locally until they land it.

---

# Session Handoff — 2026-10-07 (Build 17: repeated degradation, personal dates, hiking rule, legacy prep retired)

- Deployed nuero 25f2f27 to pi5 (gate 5510/0; MCP gateway rebuilt). nuero-ios dbf53da (route summary) PUSHED, UNBUILT (Mac tonight: build + swift test + install; prove a Hiking workout route arrives with pointCount and confirms without Nick; Health permission prompt for routes; .r1 anchor re-read).
- Hiking: GPS track within 24h or Nick only. Live reclassification: 6/13/19/26 Sep + 3 Oct = not a hike; 6 Aug + 29 Aug = can't tell. No route reaches NEURO until the iOS build.
- Degradation investigation live (job :17/:47); replay on 5 days of spine: threshold 3 → 0 investigations. Re-replay in a fortnight (di.replay()).
- Personal dates live: wedding anniversary 19 Oct (nothing needed). Tracey Allen's 16th (Fri 9 Oct) was REMOVED from the phone's diary on 4 Oct — tell Nick; the phone's push is thin (4 events / 23 calendars).
- Legacy meeting-prep RETIRED (switch 'Legacy meeting-prep pushes' brings it back).
- ⚠ ANOTHER SESSION has uncommitted backend/services/cron-once.js (+test) and a scheduler.js top hunk (node-cron double-fire fix); runtime-jobs 'wraps every node-cron job' test fails until they update it. I committed ONLY my scheduler hunks. HANDOFF-neuro-mcp-claude-code.md is not mine either.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 17 Repeated Degradation and Personal Dates.md; gap analysis appended.

---

# Session Handoff — 2026-10-07 (Build 16: native reliability + convergence)

- Deployed nuero 2eddf98 + 1e241ce to pi5 (Pi gate 5458/0 on 2eddf98). nuero-ios 8733c2c PUSHED, UNBUILT (Mac: swift test, build both apps, install, then the real-device runbook in the vault Build 16 note section 5).
- Phone runs 58df50a (inferred; apps send Neuro/1 so the server can't name it). Place-sensing was never installed (0 visits, 0 region events).
- Durable location queue (NeuroKit DurableQueue) compiled + tested under swift:6.0 in docker on pi5 (27 pass, 2 mutations) — scratch package recipe: copy the Foundation-only files + a stub NeuroAPIClient.APIError, `docker run --rm -v /tmp/nk:/nk -w /nk swift:6.0 swift test`.
- Free standup is a meeting again (calendar_cache.is_organizer fills on next sync — verify Team Standup row shows 1). Legacy meeting-prep stays live, fixed (solo blocks, per-occurrence key). Hiking confirm window 120 days.
- For Nick: confirm/deny 19 Sep (likely) + planned Saturdays; product call on "role + last 1-2-1" pushes (that retires legacy prep); Build 17 = Mac day, then repeated-source-degradation investigation, then personal dates.
- Another session was editing standup-session.js / task-blocks.js / chat-tools.js concurrently — not touched, not committed by me.

---

# Session Handoff — 2026-10-06 (Build 15: Activity, safe self-heal, meeting age bound, hiking loop)

- Deployed nuero 5ba6338 → 2922a68 to pi5 (Pi gate 5361/0 before restart; local 5376/0). MCP gateway rebuilt (hike-write routes interactive). No iOS work.
- Live: SYSTEM → Activity (`/api/activity/timeline`); Life → hiking card (`/api/loops/hiking`, this week "Saturday hike planned", forecast rain 13.5°C); canary source `neuro.selftest`; self-heal switch "Let NEURO retry a stopped sync by itself" (default ON).
- Commitment-risk: the 22 findings from the 21 Sep standup resolved on the first pass (dry-run on a snapshot first: 28 → 6, nothing else moved). Standup write-ups can link again (free is a tie-breaker).
- Self-heal PROVEN live on the canary: first run MEDIUM and correctly refused (blind-state holds reason codes, so a failure class was one fact); fixed with ONE new probe (provider-check); second run 14:35 UTC High → A1 retry → 14:40 verified recovered. All in Activity.
- Not done / for Nick: old meeting-prep stays live (parity 2/5 days, 3 old-only — two are the old pipeline firing on solo blocks); confirm or plan hikes on Life; iOS homework untouched (nuero-ios 9ac7f0f + other session's uncommitted 5 Oct place-sensing files).
- Known: `one-to-one-cadence-routing.test.js` fails as a whole file intermittently in parallel runs (pre-existing, passes alone); `due-ahead-render.test.js` and `one-to-one-cadence-state.test.js` contain literal backspace bytes (pre-existing, untouched); mcp-server's VANTAGE inventory test is stale (known, out of deploy path).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 15 Safe Self-Healing and Activity.md; gap analysis appended.

---

# Session Handoff — 2026-10-06 (Build 14: authority matrix + bounded investigation)

- Deployed nuero f8dca93 to pi5 (Pi gate 5320/0; local 5335/0). SAiM backend restarted (now authenticates with NEURO_KIOSK_TOKEN, added to BOTH .env files). MCP gateway container rebuilt; live gateway shows post_rooms_by_key_accept interactive. Local MCP server change takes effect on next Claude Code restart.
- Live checks: passthrough 410 (token and PIN), machine approve/flag/escalation/room 403, declared machine + PIN 403, kiosk room accept reaches the route, machine reads 200, investigations route 200 (empty).
- Investigation: durable job source-blind-investigation live; historical replay 13 findings → 0; controlled run on a DB snapshot copy proved detect → high-confidence agent-not-running → open-app (not executed) → recovery resolves + cancels. Copy deleted.
- Not done / for Nick: merge duplicate tasks #283/#333 (Parsons breakdown); old meeting-prep stays live (parity evidence continues); commitment-risk latest-occurrence rule has no age bound (Build 15); iOS homework untouched (nuero-ios 9ac7f0f + other session's uncommitted 5 Oct place-sensing files).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 14 Bounded Autonomous Investigation.md; gap analysis appended.

---

# Session Handoff — 2026-10-06 (Build 13: activation + autonomous reliability)

- Deployed nuero 01398c7 + 0711948 to pi5 (full suite green locally 5289/0; Pi test gate passed before each restart). nuero-ios 9ac7f0f pushed, UNBUILT.
- Live now: HA presence on the spine (/api/events/world/presence: Nick work, household Helen+Isaac); source-blind LIVE behind 30h/failing threshold, kill switch Settings → "Tell me when a sense has really stopped" (ON); Jira escalation human-only + ledgered; Planner/To Do completion converged + read back.
- DONE: governed calendar proof pa_ea693960ea35d2ad approved 12:35 and VERIFIED by read-back (201, all checks true). Still for Nick: classify 7 reminder lists (Reminders x2), add relationship:/household: to family People notes.
- ⚠ nuero-ios has ANOTHER session's 5 Oct place-sensing changes UNCOMMITTED (LocationTracker, AppState, SaimState, APIClient, HealthSync, DeviceReporter, PlacePayload). Location durable queue + the two `transient: OutboxQueue.isTransient(error)` call sites (AppState ~230, SaimState ~1339) are blocked until that is committed or dropped.
- Not done: legacy meeting-prep parity (needs role + last-1-2-1 in meeting-intelligence); NOVA PATCH passthrough unwhitelisted; MCP gateway too broad on action routes; Confluence not published (record contains household/family details — Nick's call).
- client-routes.test.js flaked once in a full parallel run (subtests all passed; passes alone).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 13 Activation and Autonomous Reliability.md; gap analysis appended.

---

# Session Handoff — 2026-10-04 (Build 12.4: watch proof prep + native makeover)

- Windows only, no Mac route: NOTHING ran on a phone or watch. The acceptance test (SAiM in the real face picker) is NOT done. Mac steps: docs/build-12.4-mac-runbook.md.
- Deployed nuero 6e006e8 to pi5 (tests 5166/0 fail on the Pi): synthesis themes carry `sentence` + `support`; verified live.
- nuero-ios 10c8f42 PUSHED, UNBUILT: SituationScene beats, one hero per mode, chip correction, edgeless ask; SaimWatch now signed with its App Group (was missing, read returned silently); reinstall.sh warns when the complication appex/group is missing.
- Still to do on the Mac: add the SaimWatchComplication target in Xcode, prove the group in the signed .appex, picker photo, synthetic P0 table, device screenshots vs vault 12.4-layout-MOCK-not-device.png.

---

# Session Handoff — 2026-10-04 (Build 12.3: synthesis + watch attention)

- Deployed nuero a49a20a (+ wording fix) to pi5; tests green; live /api/canonical/presentation carries `synthesis` + `p0`. Live synthetic P0 inject → count 1 eligible → cleared → 0, verified.
- nuero-ios 8626397 COMMITTED, UNBUILT: Mac must `swift test` (Build123SynthesisTests), build SAiM, screenshot the Sunday (12.3S acceptance: does it read as interpreted?).
- Then E2E proof: POST /api/canonical/needs-you/synthetic {"kind":"escalation"} with PIN, lock phone, open/wait for SAiM, tap alert (watch or phone), DELETE the synthetic. Setup → "Prove an urgent alert" turns done only on opened.
- Watch app still cannot install (free profile; WATCH-WITHOUT-XCODE.md) → 12.3T blocked; decision for Nick: paid Apple Developer account vs Xcode 27 Mac.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 12 Adaptive Ambient Surface.md § Build 12.3.

---

# Session Handoff — 2026-10-04 (Build 12.2: native composition reset + watch complication)

- nuero-ios 0f43f2d PUSHED, UNBUILT. The Mac had Remote Login off, so nothing was compiled, installed or screenshotted. Steps are in `docs/build-12.2-mac-steps.md`.
- New: `NativeComposition` (three compositions chosen by mode: calm, upcoming, attention), rewritten `SituationView`, ask moved into the flow, content-safe mesh frame, quieter nav, evidence in a sheet, ⋯ menu, a way back from the classic surface.
- Watch: `ComplicationContent` + `WatchPresentationSnapshot` (App Group), complication rewritten to read presentation-v1, watch app writes on bootstrap/foreground, two new entitlements files. The TARGET still has to be added in Xcode. Test 17 stays red until it is.
- PWA untouched by design (native first). Vault Build 12 note has a Build 12.2 section.
- Next: on the Mac, swift test → build SAiM → iPhone screenshot vs IMG_0415 → iterate → add the watch target → install → put it on a face.

---

# Session Handoff — 2026-10-04 (Build 12.1: visual composition)

- Deployed nuero d9ced5d + 2068bb0 to pi5 (desktop + kiosk built, 5124 tests 0 fail before restart). PWA on Netlify confirmed by bundle content. Pi 4 wall panel reloaded and captured — unchanged.
- New: phone focal object, grouped context (`groupContext`), activity pill, "What this is based on" attached, "Show me everything" disclosure (was missing on the PWA situation layout), `AskDock`, reading scrim, field fills the screen, phone context cap 5. Household label now "X and Y are home".
- nuero-ios b11aa1b + ba79179 COMMITTED, UNBUILT: SituationView rewrite, dock, quieter nav, `ContextGroups`/`.focal`, Build121CompositionTests. On the Mac: swift test, build SAiM, install, screenshot the live Quiet Sunday state and compare with vault `Build 12 screens/12.1-after-live-sunday-phone-440.png`.
- Watch: `SaimWatchComplication/SaimComplication.swift` has NO target in Neuro.xcodeproj — never built, hence zero complications. Add a watchOS Widget Extension target on the Mac (Nick raised the watch being basic; not started).
- Not done: looking at the real iPhone PWA; bedtime room duplicate (composer); Confluence (Atlassian MCP not authorised).
- Harness for visual checks: render real Situation+Field+AskDock in headless Chrome (scratchpad, recipe in vault 12.1 section) — Chrome will not go below ~500px wide, so pin body width and crop.

---

# Session Handoff — 2026-10-04 (Set-up wizard)

- Deployed nuero 8aefb5d + fix to pi5 (tests green before restart). NEURO desktop → SYSTEM → Set up; GET /api/setup. Windows: `powershell -ExecutionPolicy Bypass -File desktop-agent\setup.ps1` (laptop reports clean). nuero-ios 9c43a1c: Set up in NEURO menu + SAiM Controls (sheet) — UNBUILT.
- Live open items: APNs key on the Pi (blocks push for both apps), approval code, reminders stale on both apps, 12 calendars unclassified, no goals, no Ember note.

---

# Session Handoff — 2026-10-04 (Build 12: adaptive ambient surface)

- Deployed nuero b3973c3 → 640da96 → 7ad193e to pi5 (desktop + kiosk built, tests green on the Pi before each restart, neuro-backend + saim-backend online). PWA on Netlify serving the new bundle (verified by content, not by eye).
- New: `presentation-v1` on /api/canonical/now (+ GET /api/canonical/presentation), shared `saim/shared-ui/presentation/` renderer + budgets, default `layout='situation'`, kiosk ambient chrome, desktop Now uses the desktop profile. Duplicate birthday folded live.
- Pi 4 desk panel restarted and photographed — matches the target. Study tablet unreachable over ADB (no route); when back, add `?mic=1` to its start URL.
- nuero-ios 9c49caf COMMITTED, UNBUILT: Presentation.swift, SituationView.swift, SurfaceView wiring, Build12PresentationTests. On the Mac: swift test, build, look at it.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 12 Adaptive Ambient Surface (screens in `Build 12 screens/`); Gap Analysis appended. Not on Confluence (Atlassian MCP not authorised).
- Untracked `HANDOFF-neuro-mcp-claude-code.md` in repo root is not mine — left alone.

---

# Session Handoff — 2026-10-03 (Build 11: personal world model + governed calendar)

- Deployed nuero 87af6d5/83944da to pi5 (frontend built, tests 5042/0 fail on Pi, neuro-backend restarted, gated on tests). Kiosk untouched.
- New: calendar/reminder-list classification (Life screen), reminders as canonical tasks (eventkit-reminders), stated relationships, Ember as a companion (type: pet), goals with importance/links on the spine, personal-deadline evaluator (SHADOW), off-duty later-unknown, governed create/reschedule/cancel_calendar_event behind NEW switch "Send approved calendar changes" (OFF). 1-2-1 Book/Move, composer with attendees and chat create_meeting now PREPARE.
- nuero-ios f16b795 COMMITTED, UNBUILT: calendar ids, reminders with ids from every list, canonical Now in both apps. On the Mac: swift test, build both, install; then flip `reminders.*` to expected in backend/services/native-sources.js.
- Live personal data is still empty: 0 goals, 0 companions, 0 classified calendars, 0 reminder tasks (old builds send no ids). Nick's to do: classify calendars/lists on Life, write goals, create Companions/Ember.md.
- One validation invite (to nickw@, 2026-12-31) was prepared as a machine client and REJECTED with a note — expect it in Actions history.
- Record: vault Projects/NEURO/NEURO-SAIM — Build 11 Personal World Model and Sensing (incl. restorative-drift readiness and updated domain matrix). Not published to Confluence (Atlassian MCP not authorised this session).
- Not done: logged-in visual check of Life/Actions; mcp-server VANTAGE inventory gate still fails (pre-existing).

---

# Session Handoff — 2026-10-03 (Build 10: canonical UI + Nick-first Now)

- Deployed nuero 4466f6c/9bb8da9 to pi5 (frontend + kiosk built, tests 5004/0 fail, neuro-backend + saim-backend restarted). Phone PWA live via Netlify.
- New: /api/canonical/* (now, commitments, sources, findings, life, goals, annotations); NEURO screens Commitments, Sources, Findings, Life; Now reads /api/canonical/now.
- Retired: Briefing/Focus (→ Now), SAiM Today/Focus, KPI Tracker (→ VANTAGE), QA, Strava, /api/focus (410), kiosk engine, sara/ + _incoming-daypilot-sara/ (docs archived into saim/attractor).
- nuero-ios e329cd4 COMMITTED, UNBUILT: run `cd NeuroKit && swift test` + build both apps on the Mac.
- ⚠ Obsidian Sync wedged both ways since ~14:28 3 Oct (Pi lacks Builds 6–10 notes; Pi had the newer Target Architecture, copied to Windows by hand). Restart Obsidian on Windows (see memory obsidian-sync-wedge).
- Record: vault Projects/NEURO/NEURO-SAIM — Build 10 Canonical UI and Nick-First Now (includes the life-domain maturity matrix and Build 11 plan).
- Not done: logged-in visual check of new screens (browser harness wouldn't start); mcp-server VANTAGE inventory gate fails (pre-existing, VANTAGE's to refresh).

---

# Session Handoff — 2026-10-03 (Build 9: surface convergence)

- Deployed nuero e0d1366 to pi5 (frontend + kiosk built, tests green, neuro-backend restarted). Phone PWA live via Netlify.
- nuero-ios a3c7928 COMMITTED, UNBUILT: iOS Actions decode fix (pending vs actions), governed queue read-only, phone never approves outbound older-queue kinds, SAiM iOS approvals line. Run NeuroKit tests + build on the Mac.
- First live sighting of the SAiM "Needs you" line will be Monday's weekly risk report once queued. Send switch is still OFF.
- Record + target surface map: vault Projects/NEURO/NEURO-SAIM — Build 9 Surface Architecture and Convergence. Build 10 = govern invites, first world-model screens (Commitments, Sources), retire kiosk stateEngine.
- For Nick: delete untracked sara/ and _incoming-daypilot-sara/; decide merges (Briefing/Focus/Today), KPI Tracker to VANTAGE, retire qa/strava.

---

# Session Handoff — 2026-10-02 16:00

## What was done (all deployed to pi5 and verified live unless marked)
- **Fire tablet layout** — headline clamp could shrink, shelf wrapped into the cards; fixed for short landscape (`Approach.css`).
- **Screens follow place + time** — display verdict carries `place`/`area` + `night{dim}` (21:00–07:00, setting); NightDim overlay, Fully brightness and Pi backlight agent obey one flag; household board on home screens (`/api/rooms/board`, VESTA redaction); work Fire keeps its clock.
- **Life-state** — `services/life-state.js`: what Nick is doing + evidence + `showWork`; asks "What are you up to?" when it's a guess; gate + surface hide work when he isn't working; off-duty view takes home/out/night shapes.
- **Working hours 08:00–18:00** (setting); past 18:00 only a real meeting or focus session keeps him on duty.
- **Voice** — useful or silent (greetings need a brief line; feed speech only critical/meeting/asked); living room greets nobody and replies in the natural voice via `saim-voice` Wyoming bridge (pi5 :10201); iOS + tablet play the natural clip.
- **HA router integration** had frozen 16 days (person.nick "home" in Derby) — reloaded; watchdog script on pi5 cron.
- **Senses watchdog** (`watchdog.checkSenses`, `sense_alert`); **rain-while-out** moment in ambient-push.
- **CI** — android-sensor build fixed (dropped setup-android); tests workflow fixed (install web apps' deps) — first green run in 40+.

## What's still pending
- **iOS build on the Mac** — natural voice + 90s unprompted gap (`nuero-ios` 79d78a6, c0687ae). Not built.
- **Study tablet APK** — built on release `android-sensor-latest`, NOT installed: needs USB once at home (wireless ADB off), uninstall + re-provision. Exact steps in memory `study-tablet-saim`.
- **Bedroom P30** — BLE deaf, not charging; needs hands.
- **Decisions for Nick:** Apple Developer account (NOT bought); `SAIM_SENSOR_KEYSTORE_*` GitHub secrets; Focus-name Shortcuts (parked — helper `input_select.nick_focus` + scripts `nick_focus_on/off` exist).
- **Not built:** "leave now" (no travel-time source), heading-home heat pre-warm, wind-down push, learned routines (spec Phase 5).

## Key decisions made
- Kept router tracker on `person.nick` (fixed the integration instead) — the router beats the ~90m GPS offset at home.
- Dead "held" UI branches left: `HoldNotice` is reused for MS failures and `held` is in API payloads iOS reads.
- TV: the "Living room extension" plug is switch-only (no power meter); life-state uses socket-on + watch in living room.

## Gotchas for next session
- Spec: vault `Projects/NEURO/SAiM — Situational Intelligence` (Phase 0 measurements + fixes recorded there).
- Deploy: gate the pm2 restart on `npm test` (see mistakes.md, 2 Oct).
- HomePod is NOT used; speakers are the living-room satellite + study tablet (memory `saim-voice-must-earn-it`).
- `office` room sensor = WORK Fire; study tablet IP is now 192.168.1.200.
