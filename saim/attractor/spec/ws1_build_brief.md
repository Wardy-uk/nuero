# WS1 Build Brief — State Engine v1

## Work Package

`WS1-WP1` — Replace the WS0 runtime stub with State Engine v1

## Objective

Implement State Engine v1 in the governed daypilot workspace by replacing the WS0 shared-state stub with a real validated contract for state, location, and confidence, while keeping the existing runtime path intact.

## Required Behavioural Outcome

Deliver a runtime where:

1. the existing backend runtime endpoint returns a real State Engine v1 model instead of the WS0 stub-only shape
2. the model consistently exposes current state, current location, and confidence
3. seeded or hardcoded inputs are used honestly and are clearly labelled as such
4. the frontend runtime surface can display the new values without requiring WS2 dashboard scope
5. invalid model generation fails honestly rather than silently pretending the runtime is healthy

## Governed Baseline

Build against the SARA runtime that exists in this governed workspace under `sara/`.

This is the authoritative WS0 seam for WS1:

- existing daypilot SARA runtime
- existing backend runtime path in this workspace
- existing frontend runtime health surface in this workspace

Do not target the nuero repository variant or transplant its contract assumptions.

## Scope

In scope:

- State Engine v1 contract
- seeded or hardcoded providers for state, location, and confidence
- derivation logic from providers into one shared model
- backend runtime response changes required to expose the new model
- minimal frontend surface updates needed to reflect the new contract
- tests or validation proving the contract shape
- factual build-status reporting

Out of scope:

- WS2 dashboard feature work
- Home Assistant integration
- voice
- distributed nodes
- advanced context inference
- repo-wide architecture changes outside the bounded SARA runtime

## Implementation Constraints

- Preserve one SARA / one shared model.
- Prefer replacing the WS0 stub at the current seam rather than introducing parallel runtime paths.
- Keep hardcoded inputs obviously temporary and swappable.
- Do not consume evaluator criteria or holdouts.
- If route naming or contract shape differs from another repo version, follow the governed daypilot baseline here.

## Deliverables

1. State Engine v1 implemented in the governed workspace under `sara/`.
2. Existing runtime endpoint updated to expose the new shared model.
3. Minimal frontend/runtime-surface update if needed to show the contract.
4. One factual build-status report in `sara/attractor/build_status/WS1-WP1.md`.

## Build Status Report Must Include

- what was added or changed
- what WS0 stub behaviour was replaced
- how state, location, and confidence are sourced and labelled
- what validation or tests were run
- what limitations remain because inputs are still seeded/hardcoded
- explicit statement that `WS1-WP1` is ready for evaluation
