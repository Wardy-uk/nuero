# Build 12.2 — what the Mac session must do

Written 4 Oct 2026 on Windows. The code is in `nuero-ios` and **has not been compiled**.
The MacBook Air was on the tailnet, but Remote Login (SSH) was off, so nothing was built,
installed or captured. Nothing in this build sends anything or changes NEURO's behaviour.

## 1. Tests first

```
cd nuero-ios/NeuroKit && swift test
```

- `Build122CompositionTests` (20+ tests) and the updated `Build121CompositionTests`.
- **Test 17 (`complicationTarget`) is meant to fail until step 3 is done.** It checks that
  `SaimWatchComplication.appex` exists in the project. Run the tests again after step 3.
- Before committing anything fixed on the Mac, grep for `/usr/bin/bash` in Swift files:
  this repo has been damaged that way by Windows shells before.

## 2. Build SAiM and look at it on the real iPhone

1. Build the `Saim` scheme and install it on the iPhone (not the Simulator).
2. Open SAiM on the live state and take a screenshot. Compare it with `IMG_0415.PNG` and
   with vault `Projects/NEURO/Build 12 screens/12.1-after-live-sunday-phone-440.png`.
3. The question to answer: does it look like a finished personal assistant, or like a
   set of SwiftUI controls? If it's the second, change it and check again. **The
   Simulator doesn't count.**
4. Also capture: needs-attention, upcoming (meeting soon) and degraded. If the live day
   doesn't show those states, the fixtures in `Build122CompositionTests` describe them.

What to look for:
- The calm Sunday fits in the top ~50–65% of the screen. The ask follows the content,
  with no pinned bar under a gap.
- The next item is a line with a short accent rule. It is not a card.
- Context is 2–3 short sentences. There is no HOME heading.
- The ⓘ beside the summary opens "What this is based on" as a sheet.
- "Looks like you're …" is followed by a small accent "Not quite?" menu, or the line just
  asks "What are you up to?".
- ⋯ at the top right holds "Show me everything", and the classic surface has an ✕ to
  come back.
- The headline is about 30pt serif, not 40.
- The nav's selected tab is brighter ink, not the accent colour.

## 3. Add the watch complication target (do this in Xcode; don't hand-edit the pbxproj)

1. File → New → Target → watchOS → **Widget Extension**.
   - Product name: `SaimWatchComplication`.
   - Embed in: the **SaimWatch** watch app.
   - Untick "Include Configuration App Intent" (the complication uses a StaticConfiguration).
2. Bundle id: `uk.co.nickward.sara.watchkitapp.complication`. It must start with the
   watch app's id. Use the same team as the other targets.
3. Delete the template Swift files Xcode generates. The folder `SaimWatchComplication/`
   already holds `SaimComplication.swift` with `@main`, and two `@main`s won't build.
   If Xcode made a new folder, point the target at the existing one (synchronized folder).
4. Add **NeuroKit** to the new target's Frameworks and Libraries.
5. Entitlements (App Group `group.uk.co.nickward.sara` on both):
   - SaimWatch target: `CODE_SIGN_ENTITLEMENTS = Config/SaimWatch.entitlements`
   - SaimWatchComplication target: `CODE_SIGN_ENTITLEMENTS = Config/SaimWatchComplication.entitlements`
   The phone already signs this group on the personal team. If watchOS signing refuses
   it, the complication will show "Open SAiM to refresh". That's honest, but it means
   the group needs fixing.
6. Deployment target watchOS 11 (to match SaimWatch).
7. Build SaimWatch, install it on the paired watch, open the app once (this writes the
   read), then long-press the face → Edit → Complications → **SAiM**. Add it to a circular
   slot and a rectangular slot, and check that it renders.
8. Re-run `swift test`. Test 17 should now pass.

## 4. Commit and record

- Commit the project change and any compile fixes in `nuero-ios`.
- Put the screenshots in vault `Projects/NEURO/Build 12 screens/` as `12.2-*.png`. Update
  the Build 12.2 section of `NEURO-SAIM — Build 12 Adaptive Ambient Surface.md` with what
  you saw.
- Only after Nick approves the native screen, mirror the principles to the PWA
  (`saim/shared-ui/presentation/Situation.jsx`).
