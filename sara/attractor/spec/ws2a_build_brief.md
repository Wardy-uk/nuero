# WS2A Build Brief — Executive Dashboard v0 And Presence Mode v0

## Work Package

`WS2A-WP1`

## Objective

Build the next two SARA views on top of the converged many-views architecture while keeping all data ownership in shared state.

## Required Behavioural Outcome

Deliver a runtime where:

1. Executive Dashboard v0 renders as a real selectable view
2. Presence Mode v0 renders as a real selectable view
3. both views read shared state and shared placeholder presentation
4. Mission Control still works
5. the app is still not locked to a single home screen

## Governed Baseline

Build against the converged `nuero` SARA runtime and the existing many-views architecture under `sara/frontend/src/`.

Use only the current shared state contract and shared placeholder presentation layer for this slice.

## Scope

In scope:

- Executive Dashboard v0
- Presence Mode v0
- any shared placeholder presentation additions those screens need
- view-router and switcher updates needed to make both views real

Out of scope:

- Home Assistant telemetry
- changes to the WS1 state contract for new live data
- auto view recommendation logic
- voice
- distributed nodes

## Constraints

- Do not let either screen own authoritative data.
- Do not silently add WS3 telemetry assumptions.
- Keep the slice view-focused and bounded.
- Do not consume evaluator criteria or holdouts.

## Deliverables

1. Executive Dashboard v0 implemented.
2. Presence Mode v0 implemented.
3. Shared-state/presentation updates if needed.
4. One factual build-status report in `sara/attractor/build_status/WS2A-WP1.md`.
