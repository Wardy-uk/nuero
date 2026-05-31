# WS2A Evaluation Handoff

## Date

2026-05-31

## Recipient

Evaluator Agent

## Evaluation Timing

Use this standard only after the Build Agent has written `sara/attractor/build_status/WS2A-WP1.md`.

## Evaluation Standard

Judge only observable runtime behaviour in the governed `nuero` workspace.

Required checks:

1. determine whether Executive Dashboard renders
2. determine whether Presence Mode renders
3. determine whether both are selectable through the current-view system
4. determine whether both read shared state rather than own authoritative state
5. determine whether Mission Control still works

## Reporting Standard

Write results to `sara/attractor/eval_output/` and report:

- pass/fail status for each observable criterion
- runtime-only evidence
- any scoped regressions or blockers
- recommendation: converge, iterate, or block
