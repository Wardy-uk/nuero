# attractor/

Meta layer for the SAiM build. Holds artifacts *about* the build rather than
runtime code.

- `build_status/` — one factual build-status report per work package, written
  when that package is ready for evaluation.

WS0 keeps this minimal on purpose. Later work packages may add more under here.

## Archived from daypilot (Build 10N, 3 Oct 2026)

Eighteen WS0/WS1 documents existed only in an untracked staging folder
(`_incoming-daypilot-sara/daypilot-sara-working.tar.gz`, taken from the stale
`sara/` fork in the daypilot repo before it was removed there). They were
copied here into their matching subfolders so the programme's early record is
complete:

- `manager_log/`: programme_setup_log, ws0_build_claim_verification_decision,
  ws0_build_handoff, ws0_build_verification_and_eval_routing,
  ws0_convergence_decision, ws0_eval_handoff, ws1_activation, ws1_build_handoff,
  ws1_build_verification_and_eval_routing, ws1_eval_decision
- `plan/`: ws0_implementation_plan, ws1_implementation_plan
- `spec/`: ws0_build_brief, ws0_convergence_definition,
  ws0_runtime_behavioural_spec, ws1_build_brief, ws1_convergence_definition,
  ws1_state_engine_behavioural_spec

Twelve further documents in that archive also exist here; the copies here are
the later, fuller rewrites and were kept. The archive's CODE (a WS1 "State
Engine v1" for the original SARA backend, plus a patch against daypilot HEAD)
was NOT kept: it was superseded by `saim/backend/src/state/stateEngine.js`,
which was itself retired in Build 10I when the kiosk stopped running a second
decision engine. Nothing in the code was referenced by the tracked repo.
