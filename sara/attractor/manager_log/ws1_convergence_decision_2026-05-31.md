# WS1 Convergence Decision

## Date

2026-05-31

## Decision

`WS1-WP1` is converged via `WS1-WP1-ITER1`.

## Basis

The governed `nuero` workspace contains:

- the WS1 build report at `sara/attractor/build_status/WS1-WP1.md`
- the WS1 iteration build report at `sara/attractor/build_status/WS1-WP1-ITER1.md`
- the WS1 evaluation report at `sara/attractor/eval_output/ws1_wp1_eval_2026-05-31.md`
- the WS1 iteration evaluation report at `sara/attractor/eval_output/ws1_wp1_iter1_eval_2026-05-31.md`

The iteration evaluation recommends `converge`.

Manager accepts that recommendation because the evaluator reported:

- location is now exposed consistently
- confidence is now exposed consistently
- the frontend displays both values
- both values are honestly labelled
- previously passing WS1 behaviour remains passing

## Governance Outcome

- WS1 is closed as converged
- WS2 may now be activated for planning
- the `nuero` workspace is the authoritative SARA programme workspace

## Non-Blocking Residuals

- degraded-state UI prominence can be improved later
- richer domain detail remains a later-view concern, not a WS1 blocker
- the provenance nit around `briefing.derivedFrom` remains non-blocking
