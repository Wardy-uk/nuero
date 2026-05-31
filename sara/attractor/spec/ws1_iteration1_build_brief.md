# WS1 Iteration 1 Build Brief — Location And Confidence Completion

## Work Package

`WS1-WP1-ITER1`

## Objective

Close the single failed WS1 criterion by exposing current location and confidence consistently through the governed `nuero` runtime and the existing frontend surface.

## Source Of Iteration

This iteration is triggered by `sara/attractor/eval_output/ws1_wp1_eval_2026-05-31.md`.

The evaluation found that:

- the WS1 engine and contract are real
- seeded inputs are labelled honestly
- invalid-model handling is honest
- frontend consumption works
- but current location and confidence were absent, even though criterion 2 requires them

## Governed Baseline

Build against the SARA runtime that exists in this repository under `sara/`.

For this repo, the authoritative seam is:

- `/api/state`
- `/api/health`
- the existing `createStateEngine` path
- the existing single-process runtime shape where the backend serves the built frontend

## Required Behavioural Outcome

Deliver a runtime where:

1. current location is present in the backend runtime model
2. current confidence is present in the backend runtime model
3. both values are displayed by the existing frontend runtime surface
4. both values remain honestly labelled if still seeded or derived from seeded inputs
5. the existing valid/invalid model behaviour remains intact

## Scope

In scope:

- add location and confidence to the State Engine v1 contract if absent
- add seeded or derived logic for those values if absent
- expose both values through `/api/state` and `/api/health`
- update the existing frontend runtime surface to display them
- fix any directly related consistency gaps

Out of scope:

- dashboard redesign
- Home Assistant integration
- voice
- distributed nodes
- broader context inference
- unrelated UI polish
- new runtime paths or architectural changes

## Constraints

- Preserve the governed `nuero` runtime seam.
- Preserve one SARA / one shared model.
- Do not regress the already validated honest invalid-model behaviour.
- Do not broaden into WS2.
- Do not consume evaluator holdouts.

## Deliverable

Write one factual iteration report to `sara/attractor/build_status/WS1-WP1-ITER1.md` that states:

- what changed to add location and confidence
- how both are labelled
- what was verified
- whether any residual gap remains
- explicit statement that the iteration is ready for evaluation
