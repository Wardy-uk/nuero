# WS3 Build Brief — Home Assistant Telemetry Bridge v0

## Work Package

`WS3-WP1`

## Objective

Connect a bounded set of Home Assistant telemetry signals into SARA's shared state model through the existing provider/State Engine seam.

## Required Behavioural Outcome

Deliver a runtime where:

1. SARA can read a bounded set of Home Assistant telemetry inputs
2. those inputs feed the shared state model
3. telemetry absence or failure is surfaced honestly
4. existing screens continue to function without becoming the integration surface

## Governed Baseline

Build against the converged `nuero` State Engine and WS2 architecture.

This is a telemetry and provider slice, not a screen slice.

## Scope

In scope:

- configuration and connection path to Home Assistant
- bounded telemetry ingestion
- provider/state-engine updates required to expose the new telemetry
- fallback behaviour when HA is unavailable
- factual build-status reporting

Out of scope:

- new screens
- automatic view selection
- voice
- distributed nodes
- broad inference logic

## Constraints

- Preserve Home Assistant as telemetry bus, not decision engine.
- Preserve one shared state model.
- Keep existing views working if HA is unavailable.
- Do not consume evaluator holdouts.

## Deliverables

1. Home Assistant telemetry bridge implemented in the governed workspace.
2. State Engine/provider seam updated to consume the new telemetry.
3. One factual build-status report in `sara/attractor/build_status/WS3-WP1.md`.
