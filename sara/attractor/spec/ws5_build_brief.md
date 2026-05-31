# WS5 Build Brief — Context Inference v0

## Work Package

`WS5-WP1`

## Objective

Implement the first bounded context-inference slice over the converged SARA state and telemetry seam.

## Required Behavioural Outcome

Deliver a runtime where:

1. SARA exposes an inferred current context/activity state
2. SARA exposes a recommended view
3. both outputs carry confidence and reasons
4. uncertainty, contradiction, or missing input is surfaced honestly
5. the recommendation does not auto-switch the UI

## Governed Baseline

Build against the converged `nuero` State Engine, many-views architecture, and Home Assistant telemetry seam.

This is a state-layer slice, not a voice or screen-redesign slice.

## Scope

In scope:

- bounded inference logic inside the state/model layer
- recommended-view derivation as advisory output
- confidence/reasons surfacing
- factual build-status reporting

Out of scope:

- automatic view switching
- voice interaction
- distributed-node orchestration
- broad agentic action-taking
- redesign of existing screens beyond minimal surfacing if strictly required

## Constraints

- Preserve one shared state model.
- Keep Home Assistant as telemetry bus only.
- Keep recommended view advisory only.
- Do not consume evaluator holdouts.

## Deliverables

1. Context inference implemented in the governed workspace.
2. Shared state model extended to expose inferred context, recommended view, confidence, and reasons.
3. One factual build-status report in `sara/attractor/build_status/WS5-WP1.md`.
