# WS2 Behavioural Specification — Mission Control v0

## Objective

Build the first usable SARA screen on the Pi 5 touchscreen while establishing a reusable many-views architecture over one shared state model.

## Required User-Visible Behaviour

1. SARA can be launched from a Pi desktop icon or through clearly documented Pi-desktop installation instructions.
2. Mission Control v0 renders as the first SARA view and feels usable on a 7-inch touchscreen.
3. Mission Control displays:
   - SARA header
   - current time
   - current state
   - current location
   - confidence
   - current goal
   - What Matters Now
   - Up Next
   - Quick Actions
4. Placeholder/static values are allowed, but they must be sourced through shared state rather than hardcoded inside the screen.
5. The app architecture contains a current-view concept and future view structure even if only Mission Control renders initially.

## Required Architectural Outcome

- Views are interchangeable representations of shared state.
- Mission Control must not become a separate source of truth.
- Shared state/context must live outside individual screens.
- The architecture must make room for these future views:
  - Mission Control
  - Executive Dashboard
  - Presence Mode
  - Focus Mode
  - Companion Mode
  - Stream Deck Mode

## UI Requirements

- clean
- touchscreen friendly
- readable from desk distance
- light and calm by default
- low clutter
- suitable for a 7-inch display
- usable with mouse and touch
- responsive to screen size

## Branding Direction

- calm light UI
- teal accent may use `#5ec1ca`
- dark neutral may use `#272c33`

## Constraints

- Do not collapse the project into a single home-screen architecture.
- Do not let any screen own authoritative state.
- Do not absorb WS3 or later workstreams.
- Do not require live Home Assistant data.

## Evidence Expectations

The Build Agent should be able to point to:

- the shared state file or module feeding the screen
- the view/screen system structure
- the Mission Control implementation
- the launcher file and installation instructions
