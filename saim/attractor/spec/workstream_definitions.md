# SAiM Workstream Definitions

## WS0 — Infrastructure & Runtime

- Goal: create a stable SAiM runtime on the Pi 5
- Success criteria:
  - device boots reliably
  - SAiM launches automatically
  - frontend and backend communicate
  - architecture scaffold is established

## WS1 — State Engine

- Goal: create SAiM State Engine v1
- Success criteria:
  - SAiM can represent current state
  - SAiM can represent location
  - SAiM can represent confidence
  - the contract is exposed consistently to consumers

## WS2 — Dashboard

- Goal: create a view-based always-on SAiM dashboard system
- Success criteria:
  - Mission Control v0 launches and renders
  - shared state placeholder feeds the screen
  - current view concept exists in architecture
  - future screen structure exists without owning data
  - launcher path exists for Pi desktop use

## WS3 — Home Assistant Integration

- Status: Converged

## WS4 — Voice Interface

- Status: Not started

## WS5 — Context Inference

- Goal: infer current context from shared state and telemetry
- Success criteria:
  - SAiM can infer a bounded current activity/context state
  - SAiM can expose inference confidence and reasons
  - SAiM can expose a recommended view without auto-switching to it
  - inference remains subordinate to the one shared state model

## WS6 — Distributed Nodes

- Status: Not started
