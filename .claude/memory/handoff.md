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
