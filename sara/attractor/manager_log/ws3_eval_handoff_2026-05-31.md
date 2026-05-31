# WS3 Evaluation Handoff

## Date

2026-05-31

## Recipient

Evaluator Agent

## Evaluation Timing

Use this standard only after the Build Agent has written `sara/attractor/build_status/WS3-WP1.md`.

## Evaluation Standard

Judge only observable runtime behaviour in the governed `nuero` workspace.

Required checks:

1. determine whether Home Assistant telemetry is ingested
2. determine whether the shared state model reflects that telemetry
3. determine whether telemetry absence or failure is surfaced honestly
4. determine whether existing screens remain functional

## Reporting Standard

Write results to `sara/attractor/eval_output/` and report:

- pass/fail status for each observable criterion
- runtime-only evidence
- any scoped regressions or blockers
- recommendation: converge, iterate, or block
