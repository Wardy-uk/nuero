# WS2 Build Brief — Mission Control v0

## Work Package

`WS2-WP1` — Mission Control v0 and view-system foundation

## Objective

Build the first SARA screen, Mission Control v0, while establishing a many-views UI architecture over the existing shared State Engine contract.

## Required Behavioural Outcome

Deliver a runtime where:

1. SARA can be launched from a Pi desktop icon or via documented desktop-launcher installation steps
2. Mission Control v0 renders as the first usable screen
3. Mission Control shows:
   - SARA header
   - current time
   - current state
   - current location
   - confidence
   - current goal
   - What Matters Now
   - Up Next
   - Quick Actions
4. the app has a current-view concept and future-view structure, even if only Mission Control renders now
5. shared state lives outside screens and no screen becomes a source of truth

## Governed Baseline

Build against the converged `nuero` SARA runtime already present under `sara/`.

Use the existing shared-state contract as the source of truth. Mission Control may use placeholder/static values for its new UI-only fields, but those values must be housed in shared state, not inside the screen component.

## Scope

In scope:

- Mission Control v0 screen
- shared UI state module or context for Mission Control placeholder data
- current-view architecture and view type definition
- placeholder folders or README placeholders for future views
- Pi desktop launcher path
- documentation for installing and using the launcher

Out of scope:

- building the other views
- Home Assistant integration
- voice
- automatic view recommendation logic
- swipe navigation implementation
- plugin runtime implementation
- broader design-system overhaul outside Mission Control needs

## Implementation Constraints

- Preserve one state, many views.
- Do not let the screen own data.
- Do not hardcode the app around a single final home screen.
- Prefer a light, calm, touchscreen-friendly Mission Control presentation for this slice, even if broader historical notes in the repo describe other UI directions.
- Do not consume evaluator criteria or holdouts.

## Suggested Structure

```text
frontend/
  src/
    screens/
      mission-control/
        MissionControl.tsx
      executive-dashboard/
      presence/
      focus/
      companion/
      stream-deck/
    state/
      saraState.ts
    components/
    App.tsx
```

Empty future screen folders may contain placeholder READMEs only.

## Deliverables

1. Mission Control v0 implemented in the governed `nuero` workspace.
2. Shared UI-state module feeding the Mission Control screen.
3. Current-view architecture supporting future interchangeable views.
4. Desktop-launcher files and instructions.
5. One factual build-status report in `sara/attractor/build_status/WS2-WP1.md`.

## Build Status Report Must Include

- what was added or changed
- where shared UI state lives
- how Mission Control consumes that shared state
- what future-view scaffolding exists
- how the Pi desktop launcher works
- what was verified
- explicit statement that `WS2-WP1` is ready for evaluation
