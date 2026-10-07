# Build 18 — Mac and iPhone runbook (native proof)

Written on Windows on 7 Oct 2026. Nothing below has run yet. Each step gives the
command, then the evidence that counts as **proven**. Anything proven by code
inspection, the Simulator or a Docker Swift build is **not** proven; record it as
pending.

Server views that answer each check (PIN from `backend/.env` on the Pi; never
paste it into a file):

```bash
PIN=...   # read it, do not write it down
B=https://pi5.tailecb90f.ts.net
curl -s -H "X-Neuro-Pin: $PIN" $B/api/setup/native | jq        # builds, capabilities, visits/geofence
curl -s -H "X-Neuro-Pin: $PIN" $B/api/apple/calendar/coverage | jq
curl -s -H "X-Neuro-Pin: $PIN" $B/api/setup | jq '.items[] | select(.surface|startswith("iphone"))'
curl -s -H "X-Neuro-Pin: $PIN" "$B/api/activity/timeline?hours=24" | jq '.entries[] | {occurredAt,headline}'
```

## 18A — exact source state (before building anything)

```bash
cd ~/nuero-ios && git fetch && git status --short && git log --oneline -5
for c in 9ac7f0f 8733c2c dbf53da; do git merge-base --is-ancestor $c HEAD && echo "$c in HEAD" || echo "$c MISSING"; done
git diff --stat origin/main
```

- Expect HEAD = the Build 18 commit, or later, on top of `dbf53da`.
- **Any uncommitted file:** classify it KEEP / COMMIT / DROP / MERGE in the vault note before building.
- The place-sensing files from 5 Oct were merged in `8733c2c`. A conflict marker anywhere is a stop: `git grep -n '^<<<<<<<'`.

## 18B — full Swift suite

```bash
xcodebuild -version; swift --version
cd NeuroKit && swift test 2>&1 | tail -30          # NeuroKit, incl. NeuroBuildTests, DurableQueueTests, OutboxDurability, PlacePayload, Build12x/123/124
cd .. && xcodebuild test -project Neuro.xcodeproj -scheme Neuro -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | grep -E "Test Suite|failed|passed" | tail
```

Record the Xcode version, the Swift version, the test count, the failures and the fixes.

- `NeuroBuildTests` covers the header shape, the dirty flag, a junk commit, per-app capabilities, the header sent with the client id, the 60-day window, calendar kinds and route permission.
- The backend also checks the capability names against the server (`build18-native-integrity.test.js`).

## 18C/D — build, install, and the build ID reaching NEURO

```bash
bash reinstall.sh          # now stamps NEURO_GIT_COMMIT / NEURO_GIT_DIRTY / CURRENT_PROJECT_VERSION
```

- Watch for `stamping <commit> (build <n>, dirty=0)`. **dirty=1 means build from a clean tree first.**
- Open NEURO, then SAiM. Each sends `X-Neuro-Build` on its first request.

**Proven when** `/api/setup/native` shows both apps with `reported: true` and the commit you just built, and Activity shows "NEURO iOS 0.1 (<n>) is running". If the commit is missing, the Info.plist expansion did not happen. Check the built `Info.plist` for `NeuroGitCommit`:

```bash
plutil -p /tmp/neuro-reinstall/Build/Products/Debug-iphoneos/Neuro.app/Info.plist | grep NeuroGit
```

Also confirm on the phone: both apps launch, Setup shows permissions honestly, and both reach pi5.

## 18E — offline replay, process death

1. Airplane mode on (Wi-Fi off too).
2. Make **test-safe** native events. Use a SAiM/NEURO capture with the text `B18 replay test <HH:MM>`, which goes to the capture outbox. If you can, walk or drive more than 500 m so a location fix is queued.
3. Swipe-kill the app. Reopen it while still offline. The capture must still be listed as queued.
4. Airplane mode off. Open the app.
5. **Proven when:**
   - The capture lands exactly once (one vault note or task with that text; `mobile_sync_operations` has one row).
   - The app's queue clears only after the ack.
   - If a fix was queued: `native.queue.replayed` appears in Activity, and `location.neuro-ios` returns to seeing or quiet.
6. Delete the test note or task afterwards.

## 18F — reboot / protected-data window

Same as 18E, but reboot the phone instead of killing the app. Unlock, open the app, then reconnect.

**Proven when** the queued item arrives exactly once and the queue file was never overwritten. This is the "woke before first unlock" guard in DurableQueue and OutboxQueue.

## 18G — corrupt item quarantine (synthetic only)

```bash
xcrun devicectl device copy from --device <PHONE> --domain-type appDataContainer --domain-identifier uk.co.nickward.neuro \
  --source "Library/Application Support/neuro-location-points.json" --destination /tmp/q.json
# add ONE entry whose payload cannot decode (e.g. a string where an object is expected) beside the real ones
xcrun devicectl device copy to   --device <PHONE> --domain-type appDataContainer --domain-identifier uk.co.nickward.neuro \
  --source /tmp/q.json --destination "Library/Application Support/neuro-location-points.json"
```

**Proven when:**
- The good entries still send.
- A `neuro-location-points.quarantine.json` file holds the bad one.
- Activity shows ONE `native.queue.degraded` line.
- The queue is not wiped.

Never edit a real user record.

## 18H — visit / geofence

- Real movement: leave home, arrive somewhere else for at least 10 minutes, come back.
- **Proven when** `/api/setup/native` → `places.visits.state` is `proven`, and `places.geofence.state` is `proven` (a region enter/exit for a saved place).
- `device_visits` / `place_region_events` rows must carry stable keys, and a re-send must not add rows.
- An Xcode GPX location simulation proves transport only. Record it as **OS simulation, not production proof**.

## 18I — SAiM device status

Open SAiM. **Proven when** Setup → "Phone self-report (SAiM app)" is done, and `/api/canonical/sources` shows `device.saim-ios` with `observedAt` and `receivedAt`. Then flip `device.saim-ios` to `expected` in `backend/services/native-sources.js` (one line).

## 18J/K/L — workout routes and a hike

1. Settings → Health → Data Access & Devices → NEURO and SAiM → turn on **Workout Routes**.
2. Open Setup in each app. Setup should now say "Asked — iOS hides whether reading was allowed". This is correct; it is not "done".
3. Record a real **Hiking** workout on the Watch, or a walk of at least 60 minutes. Do not fabricate one. If none happens, route transport stays pending and the real-hike acceptance stays open.
4. **Proven when:**
   - `health_workouts.payload` has `route.pointCount ≥ 10` and `route.receivedAt` within 24h.
   - There are no coordinates anywhere in `event_log`.
   - The Life hiking card shows **confirmed**.
   - Setup → "Workout routes" turns done.

## 18M — calendar coverage, measured

After both apps have pushed:

- Check `/api/apple/calendar/coverage`. Per app you should see `aheadDays ≈ 60`, every calendar with its `type`, and events, all-day and recurring counts.
- Compare one calendar by hand with the phone's Calendar app for the same 60 days. That comparison is the "expected vs observed" the audit needs.
- Personal dates on Life change heading to "Upcoming birthdays and anniversaries" only when coverage is complete.

## Then

Record everything in the vault note `Projects/NEURO/NEURO-SAIM — Build 18 Native Proof and Personal Data Integrity.md`, under § Mac day. Proven items get their evidence. Anything not done is marked pending, never inferred.
