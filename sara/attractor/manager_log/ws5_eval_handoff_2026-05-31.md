# WS5 Evaluation Handoff

## Date

2026-05-31

## Recipient

Evaluator Agent

## Evaluation Timing

Use this standard only after the Build Agent has written `sara/attractor/build_status/WS5-WP1.md`.

## Evaluation Standard

Judge only observable runtime behaviour in the governed `nuero` workspace.

Required checks:

1. determine whether inferred context/activity state is exposed
2. determine whether recommended view is exposed as advisory output
3. determine whether confidence and reasons are exposed
4. determine whether missing or contradictory input is surfaced honestly
5. determine whether existing screens remain functional and are not auto-switched

## Reporting Standard

Write results to `sara/attractor/eval_output/` and report:

- pass/fail status for each observable criterion
- runtime-only evidence
- any scoped regressions or blockers
- recommendation: converge, iterate, or block
