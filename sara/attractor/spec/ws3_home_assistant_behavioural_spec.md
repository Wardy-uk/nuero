# WS3 Behavioural Specification — Home Assistant Integration v0

## Objective

Introduce Home Assistant as the telemetry ingestion layer for SARA without making it the decision engine and without coupling the work to screen delivery.

## Required User-Visible Behaviour

1. The SARA runtime can ingest a bounded set of Home Assistant telemetry signals.
2. Those signals flow into shared state through the State Engine/provider seam.
3. The runtime surfaces them honestly as live or unavailable.
4. Existing screens continue to function if telemetry is absent.

## Required Architectural Outcome

- Home Assistant acts as telemetry bus only.
- State Engine remains the producer of the shared model.
- WS3 changes provider/input layers, not view ownership.

## Initial Telemetry Scope

- current location or zone
- simple presence/activity signal
- one or more device/environment status signals if needed to prove the seam

## Constraints

- No new screens in this slice.
- No automatic view recommendation logic in this slice.
- No voice, distributed-node, or broad inference work.

## Evidence Expectations

The Build Agent should be able to point to:

- where Home Assistant configuration lives
- how telemetry is read
- how provider/state-engine seams were extended
- what fallback behaviour exists when telemetry is unavailable
