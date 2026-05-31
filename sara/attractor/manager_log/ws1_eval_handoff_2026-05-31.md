# WS1 Evaluation Handoff

## Date

2026-05-31

## Recipient

Evaluator Agent

## Evaluation Standard

Judge only observable runtime behaviour in the governed `nuero` workspace.

Required checks:

1. determine whether the WS0 stub has been replaced by a real runtime model
2. determine whether current state, current location, and confidence are all exposed consistently
3. determine whether the frontend runtime surface can consume and display those values
4. determine whether seeded or hardcoded inputs are labelled honestly
5. determine whether invalid or failed model generation is surfaced honestly

## Runtime Surface

Evaluate against the runtime actually present in this repo:

- `/api/state`
- `/api/health`
- the frontend served by the SARA backend

## Holdout Focus Areas

Use a small number of hidden checks centred on mature-state-engine risks such as:

- inconsistent field presence between backend and frontend views
- partially missing domain data
- stale or contradictory confidence/state values
- invalid model handling and honest health surfacing

Do not reveal holdout specifics to the Build Agent.

## Reporting Standard

Write results to `sara/attractor/eval_output/` and report:

- pass/fail status for each observable criterion
- runtime-only evidence
- any scoped regressions or blockers
- recommendation: converge, iterate, or block
