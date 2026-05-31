# Workstream Tracker — SARA

## WS0 — Infrastructure & Runtime

- Status: Converged
- Goal: Create a stable SARA runtime on the Pi 5

## WS1 — State Engine

- Status: Converged
- Goal: Create State Engine v1
- Outcome achieved: one shared contract with state, location, and confidence

## WS2 — Dashboard

- Status: Converged
- Goal: Create an always-on SARA dashboard system with interchangeable views
- Converged slice: Mission Control v0
- Entry condition: WS1 converged shared-state contract exists
- Outcome achieved:
  - Mission Control renders from shared state
  - current view concept exists
  - future screen architecture exists
  - Pi desktop launcher path exists
- Explicitly out of scope:
  - Home Assistant integration
  - voice
  - automatic view recommendation logic
  - swipe navigation implementation
  - plugin runtime implementation
  - broader multi-screen delivery beyond Mission Control v0

## WS2A — Additional Views

- Status: Ready for build
- Goal: Add the next real SARA views on top of the converged many-views architecture
- Current slice: Executive Dashboard v0 and Presence Mode v0
- Entry condition: WS2 Mission Control architecture is converged
- Required outcome now:
  - at least two additional views render through the current-view system
  - screens read shared state and shared placeholder presentation only
  - view switching remains intact
- Explicitly out of scope:
  - live Home Assistant telemetry
  - changes to the State Engine contract beyond what already exists
  - auto view recommendation logic
  - voice and distributed-node work

## WS3 — Home Assistant Integration

- Status: Converged
- Goal: Feed Home Assistant telemetry into SARA's shared state model without changing view ownership
- Converged slice: Telemetry bridge and provider ingestion only
- Entry condition: WS1 state engine and WS2 many-views architecture are converged
- Explicitly out of scope:
  - new screen design
  - automatic view switching
  - voice
  - distributed-node work

## WS4 — Voice Interface

- Status: Not started

## WS5 — Context Inference

- Status: Ready for build
- Goal: Infer what Nick is doing now and what view SARA would recommend, using the converged state + telemetry seam
- Current slice: bounded inference layer only
- Entry condition: WS1, WS2/WS2A, and WS3 are converged
- Required outcome now:
  - derive an inferred activity/context state
  - derive a recommended view
  - expose inference confidence and reasons honestly
  - avoid automatic screen switching
- Explicitly out of scope:
  - voice behaviour
  - distributed-node orchestration
  - automatic view switching
  - broad autonomous task execution

## WS6 — Distributed Nodes

- Status: Not started
