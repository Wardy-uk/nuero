# Build 12.4 — the Mac runbook (watch proof + native makeover)

Written on Windows, 4 Oct 2026. Nothing in here has run on the Mac yet. Each step
says what counts as proof. **Don't tick a step off because it compiled.** The
acceptance test is a photo of the watch face picker showing SAiM.

Repos: `nuero-ios` (app) and `nuero` (backend, already carries the 12.4 `sentence`/`support`).

---

## 0. Pull and test (5 min)

```sh
cd ~/nuero-ios && git pull --ff-only && git log --oneline -1
cd NeuroKit && swift test 2>&1 | tail -30
```

Expected: everything green **except** Build122 test 17 ("the watch complication has a
real target"), which stays red until step 1. If `Build124SceneTests` fails, fix it
before anything else. It's the only thing pinning the makeover.

## 1. Add the complication target in Xcode (12.4A)

The project has four targets today: Neuro, Saim, SaimWatch, SaimWidgets. **There is no
complication target.** That's why SAiM has never appeared in the face picker. The source
(`SaimWatchComplication/SaimComplication.swift`) has never been compiled by anything.

The project uses Xcode 16 synchronized folders, and Xcode will want to create a folder
with the target's name, which already exists. So:

1. In Finder, rename `SaimWatchComplication/` → `SaimWatchComplication.keep/`.
2. Xcode → File → New → Target → **watchOS → Widget Extension**.
   - Product name: `SaimWatchComplication`
   - Team: C8UAGR7TW6 (personal team)
   - **Uncheck** "Include Configuration App Intent"
   - Embed in: **SaimWatch** (not Saim)
   - Activate the scheme when asked
3. Delete every Swift file Xcode generated in the new `SaimWatchComplication/` folder.
   Move `SaimComplication.swift` back in from `.keep`, then delete `.keep`.
4. Target settings for **SaimWatchComplication**:
   - Bundle identifier: `uk.co.nickward.sara.watchkitapp.SaimWatchComplication`
     (it MUST start with the watch app's id).
   - watchOS Deployment Target: **11.0** (same as SaimWatch).
   - Build Settings → Code Signing Entitlements: `Config/SaimWatchComplication.entitlements`
     (already in the repo, carries `group.uk.co.nickward.sara`).
   - General → Frameworks and Libraries → **+ NeuroKit** (the package product). The file
     imports NeuroKit, and without it nothing compiles.
5. **SaimWatch** target → Build Phases → "Embed Foundation Extensions" must list
   `SaimWatchComplication.appex`.

Proof: `swift test` now passes test 17 (it reads the pbxproj for `SaimWatchComplication.appex`).

⚠ A free team gets a limited number of new App IDs per week. This one is new. If signing
says the limit is reached, wait it out. Don't re-use another target's id.

## 2. App Group (12.4B)

This build already fixed one real bug: **the SaimWatch target never pointed at its
entitlements file**, so the watch app had no App Group, `WatchPresentationSnapshot.url()`
was nil, and the read stopped silently. The complication would have said "Open SAiM to
refresh" for ever, even with the target added. `CODE_SIGN_ENTITLEMENTS =
Config/SaimWatch.entitlements` is now set for Debug and Release. A missing group now
shows on the watch's Status page as a named error.

After building, check the SIGNED result (the only proof that counts):

```sh
B=/tmp/saim-reinstall/Build/Products/Debug-iphoneos/Saim.app/Watch/SaimWatch.app
codesign -d --entitlements - "$B" | grep -A2 application-groups
codesign -d --entitlements - "$B/PlugIns/SaimWatchComplication.appex" | grep -A2 application-groups
```

Both must print `group.uk.co.nickward.sara`. The iPhone app was proved on 7 Sep 2026 to
accept an App Group on the personal team (see the note in `Config/Saim.entitlements`).
**watchOS has not been proved.** If either line is missing, or signing refuses the
capability, stop. Record the exact Xcode message in the vault and don't fake it.
The fallback would be WatchConnectivity complication transfers straight into the
extension. That's not built, and it's a decision for Nick.

## 3. Build and install (12.4C/D)

```sh
./reinstall.sh saim     # builds Saim (+ embedded watch app) and installs both
```

It now prints two new lines before the watch install:

- `complication bundled: PlugIns/SaimWatchComplication.appex`, or a ⚠ saying it isn't
- `watch app signed with group.uk.co.nickward.sara`, or a ⚠

Record: Xcode version, watchOS SDK, watch OS version (24R363 at last check), team, any
errors. **Installed = the SAiM app icon is on the physical watch.** "Installation
succeeded" in the log doesn't count.

## 4. The picker proof (12.4E): the acceptance test

On the watch: long-press the face → Edit → swipe to complications → tap a slot → scroll
for **SAiM**. Select it, save, press the crown.

📸 Two photos: the picker list showing SAiM, and the face with it on.

If SAiM is missing, debug that and nothing else:
- `codesign -dv` on the .appex → does it exist in the installed bundle?
- Is the kind `uk.co.nickward.sara.watch.capture`? (pinned by Build124 test 12.4A)
- Open the SAiM watch app once. watchOS sometimes lists a widget only after its app has run.
- Restart the watch.

## 5. Families (12.4F)

Try one face per family where possible: **circular** (Infograph-style corner/circle),
**inline** (Modular top line), **rectangular** (Modular Compact/large). Check:
- a P0 count shows when > 0, and a zero never shows "0"
- with nothing urgent: current → next → headline ("Quiet Sunday")
- stale: "as of HH:MM" on rectangular after 30 min without a read
- never-read: "Open SAiM to refresh"
- no room temperature, no weather

## 6. Synthetic P0 through the real path (12.4G)

PIN from `backend/.env` on the Pi. Never paste it into a file.

```sh
curl -s -X POST -H "X-NEURO-PIN: $PIN" -H 'Content-Type: application/json' \
  -d '{"kind":"escalation"}' https://pi5.tailecb90f.ts.net/api/canonical/needs-you/synthetic
curl -s -H "X-NEURO-PIN: $PIN" https://pi5.tailecb90f.ts.net/api/canonical/needs-you | head -c 400
```

Fill this table honestly:

| Step | Observed / inferred / not observable |
|---|---|
| backend count = 1 | |
| phone shows Needs you | |
| phone → watch transfer ran | (not directly observable. Infer from the next row) |
| watch app has it (open its Needs You page) | |
| face changed to 1 | |
| tap complication → Needs You page | |
| resolve (`DELETE …/needs-you/synthetic`) → count clears on face | |

⚠ watchOS rations refreshes (about four an hour with the complication on the active face).
Write down how long each change took. Nothing here is real-time.

## 7. Notification (12.4H)

APNs isn't configured, so the only path is a LOCAL alert posted by the phone, which iOS
may mirror to the wrist. Lock the phone, wear the watch, inject the synthetic P0, then
**wake SAiM on the phone** (iOS decides when it runs in the background). Record whether
the watch buzzed, how long it took, and whether tapping it opened Needs You. Setup →
"Prove an urgent alert" turns done only on an **opened** event.

## 8. iPhone makeover (12.4I–X)

Install (step 3), then screenshot:
- **calm**: the live screen now (expect: "Quiet Sunday", a small calendar line, the
  recovery sentence with one accent line, "You’re home with Helen and Isaac.", the
  activity chip, the ask with no edge)
- **attention**: during step 6
- **upcoming**: when a real meeting is within half an hour, or the Xcode canvas

Compare with `Build 12 screens/12.4-layout-MOCK-not-device.png` (a Windows HTML mock of
the same scale and spacing, **not** the device) and IMG_0417. If it still reads as a
report, iterate on `Saim/SituationView.swift` (`scene`, `beatBody`) and re-run
`swift test`. The view-level rules are in `Build124SceneTests`.

Also check: Dynamic Type at the largest size (the chip must not wrap, the sentence
should), Reduce Motion (mode change is a cut), VoiceOver (one element per beat, sentence
first, in screen order).

## 9. Record

Append photos, the table from step 6 and the timings to the vault:
`Projects/NEURO/NEURO-SAIM — Build 12 Adaptive Ambient Surface.md` § Build 12.4.
