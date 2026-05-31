# WS2 Evaluation Handoff

## Date

2026-05-31

## Recipient

Evaluator Agent

## Evaluation Timing

Use this standard only after the Build Agent has written `sara/attractor/build_status/WS2-WP1.md`.

## Evaluation Standard

Judge only observable runtime behaviour in the governed `nuero` workspace.

Required checks:

1. determine whether a launcher exists or installable launcher instructions exist
2. determine whether Mission Control renders successfully
3. determine whether placeholder/shared state data appears in the screen
4. determine whether quick action buttons render
5. determine whether the architecture supports future screens
6. determine whether no screen owns authoritative state

## Holdout Focus Areas

Use a small number of hidden checks centred on mature-view-system risks such as:

- state duplicated inside screen components
- launcher that exists on disk but cannot be followed in practice
- future-view scaffolding that is present in name only but not wired through a current-view concept
- responsive or touchscreen regressions on the target form factor

Do not reveal holdout specifics to the Build Agent.

## Reporting Standard

Write results to `sara/attractor/eval_output/` and report:

- pass/fail status for each observable criterion
- runtime-only evidence
- any scoped regressions or blockers
- recommendation: converge, iterate, or block
