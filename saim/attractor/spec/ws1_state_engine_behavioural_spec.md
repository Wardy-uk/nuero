# WS1 Behavioural Specification — State Engine v1

## Objective

Replace the WS0 shared-state stub with a real State Engine v1 that exposes a single shared contract for state, location, and confidence through the existing governed runtime path.

## Required User-Visible Behaviour

1. The backend runtime response exposes a stable State Engine v1 contract instead of the WS0 stub-only shape.
2. The runtime model includes current state, current location, and confidence in a consistent shared structure.
3. The frontend runtime surface can read and display those values without requiring a dashboard redesign.
4. The system labels seeded or hardcoded inputs honestly so WS1 does not pretend to be live telemetry.
5. If the model is invalid or cannot be produced, the runtime reports that failure honestly rather than serving a misleading healthy state.

## Required Architectural Outcome

- There remains one shared SARA model, not separate per-surface copies.
- The State Engine becomes the producer of the runtime model currently exposed by the backend.
- WS1 may use hardcoded or seeded input providers, but the contract and derivation logic must be real and swappable.
- The governed baseline is the existing daypilot SARA runtime under `sara/`, not any other repository variant.

## Constraints

- Preserve the existing daypilot runtime path and overall WS0 launch shape unless change is strictly required for WS1.
- Do not absorb WS2 dashboard scope.
- Do not introduce Home Assistant integration.
- Do not introduce voice, multi-node sync, or broader context inference.
- Avoid schema or contract choices that imply multiple independent SARAs.

## Evidence Expectations

The Build Agent should be able to point to:

- the State Engine contract definition
- the seeded or hardcoded provider layer
- the derivation path from providers into the shared model
- the backend runtime response carrying the new contract
- tests or checks that validate the contract shape
