# WS2A Behavioural Specification — Additional Views v0

## Objective

Add the next real SARA views on top of the converged many-views architecture without mixing in live telemetry integration.

## Current Slice

Build only:

- Executive Dashboard v0
- Presence Mode v0

## Required User-Visible Behaviour

1. The current-view system can switch between Mission Control, Executive Dashboard, and Presence Mode.
2. Executive Dashboard renders a more operational summary of the same shared state.
3. Presence Mode renders a calmer ambient summary of the same shared state.
4. Both screens use shared state and shared placeholder presentation rather than owning their own data.
5. Future planned views remain structurally present.

## Required Architectural Outcome

- Additional screens remain interchangeable representations of one shared model.
- No screen becomes a second source of truth.
- WS2A must not depend on Home Assistant telemetry being live.

## Constraints

- No WS3 telemetry work in this slice.
- No voice, swipe navigation, or plugin runtime implementation.
- No dashboard-to-screen-specific state fork.

## Evidence Expectations

The Build Agent should be able to point to:

- the new screens
- the shared-state/presentation layer they consume
- the view-router/view-switcher path proving they are wired through the same architecture
