# WS2 Build Handoff

## Date

2026-05-31

## Recipient

Build Agent

## Active Artefacts

- Charter: `../spec/programme_charter.md`
- Build brief: `../spec/ws2_build_brief.md`
- Behavioural spec: `../spec/ws2_mission_control_behavioural_spec.md`
- Convergence definition: `../spec/ws2_convergence_definition.md`
- Implementation plan: `../plan/ws2_mission_control_implementation_plan.md`

## Instructions

Implement only `WS2-WP1`.

- Build against the governed `nuero` SARA runtime under `sara/`.
- Create a view system from the start.
- Keep all screen data in shared state/context, never inside the screen as a source of truth.
- Build Mission Control only; leave future views as placeholders if needed.
- Create the Pi desktop launcher path and installation instructions.
- Do not expand into WS3 or later workstreams.
- Do not request or inspect evaluator criteria or holdouts.
- Write factual readiness updates to `sara/attractor/build_status/WS2-WP1.md`.

## Manager Note

This slice intentionally tweaks WS2 architecture before UI implementation so the first screen does not trap the programme in a single-screen design.
